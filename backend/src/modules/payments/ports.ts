/**
 * What the payments service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 * The payment processor is behind PaymentProvider; the deterministic dev adapter is infra/card-processor/dev.ts.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type { Decline, MethodSnapshot, NextAction, PaymentsDb, Tender } from '../../spec/payments.js';

type Db = PaymentsDb;

/* ---------------------------------------------------------------- stored rows (jsonb columns typed) */

/** intents.method: the MethodSnapshot plus the bank challenge waiting for the customer (no column for it in the spec) */
export type StoredMethod = MethodSnapshot & { pendingAction?: NextAction | null };

export interface IntentRec extends Omit<Db['intents'], 'tenders' | 'method' | 'decline'> {
  tenders: Tender[];
  method: StoredMethod;
  decline: Decline | null;
}
export type AllocationRec = Db['allocations'];
export type CaptureRec = Db['captures'];
export type CallRec = Db['provider_calls'];
export interface RefundRec extends Omit<Db['refunds'], 'requested_by'> {
  requested_by: common.Actor;
}
export type RefundItemRec = Db['refund_items'];
export interface RefundLogRec extends Omit<Db['refund_log'], 'actor'> {
  actor: common.Actor;
}

/**
 * disputes.evidence: the DisputeEvidence of the API plus the case history and a concession waiting for
 * approval (the spec has no dispute log table and no approval column, so they live with the evidence).
 */
export interface StoredEvidence {
  text?: string | null;
  fileIds: string[];
  files: common.MediaRef[];
  submittedAt?: string | null;
  submittedBy?: common.Actor | null;
  history: common.TimelineEvent[];
  pendingConcession?: { approvalRequestId: string; reason: string; requestedBy: common.Actor; at: string } | null;
  /** dispute-deadlines already flagged the 48 h warning */
  dueSoonFlagged?: boolean;
}
export interface DisputeRec extends Omit<Db['disputes'], 'evidence'> {
  evidence: StoredEvidence;
}
export interface SavedMethodRec extends Omit<Db['saved_methods'], 'billing_address'> {
  /** A copy of the address (never a reference to the address book); {} when none was given */
  billing_address: Partial<common.Address> & { label?: string | null };
}
export interface WebhookRec extends Omit<Db['webhook_events'], 'payload'> {
  payload: unknown;
}

export interface Recs {
  intents: IntentRec;
  allocations: AllocationRec;
  captures: CaptureRec;
  provider_calls: CallRec;
  refunds: RefundRec;
  refund_items: RefundItemRec;
  refund_log: RefundLogRec;
  disputes: DisputeRec;
  saved_methods: SavedMethodRec;
  webhook_events: WebhookRec;
}
export type Table = keyof Recs;

/** Column filter: a value, a list (in), null (is null) or an operator */
export type Where<R> = { [K in keyof R]?: R[K] | readonly R[K][] | null | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not'; value: unknown } };

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

export interface PaymentListFilter {
  q?: string;
  orderIds?: string[];
  status?: string;
  flag?: string;
  from?: string;
  to?: string;
}
export interface RefundListFilter {
  status?: string;
  failing?: boolean;
  origin?: string;
  orderId?: string;
  q?: string;
  customerId?: string;
}
export interface DisputeListFilter {
  status?: string;
  kind?: string;
  sellerId?: string;
}

/** Per order item: money sent and money reserved by requested, processing or failed refunds */
export interface RefundTotals {
  orderItemId: string;
  sent: number;
  inFlight: number;
}

/** Persistence for this module's own tables: payments.intents, payments.allocations, payments.captures, payments.provider_calls, payments.refunds, payments.refund_items, payments.refund_log, payments.disputes, payments.saved_methods, payments.webhook_events, payments.ref_sequences. */
export interface PaymentsRepository {
  /** Runs fn in a transaction with a repository bound to it (nested calls join the outer one) */
  transaction<T>(fn: (tx: PaymentsRepository) => Promise<T>): Promise<T>;

  get<T extends Table>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined>;
  find<T extends Table>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]>;
  insert<T extends Table>(table: T, row: Recs[T]): Promise<Recs[T]>;
  insertMany<T extends Table>(table: T, rows: Recs[T][]): Promise<void>;
  update<T extends Table>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]>;
  /** Conditional update: only rows matching `where` change (money-safe compare-and-set); returns the changed rows */
  updateWhere<T extends Table>(table: T, where: Where<Recs[T]>, patch: Partial<Recs[T]>): Promise<Recs[T][]>;
  deleteWhere<T extends Table>(table: T, where: Where<Recs[T]>): Promise<void>;

  /** Next value of a daily counter (RF-, CB-, DP- references) */
  nextSequence(kind: string, day: string): Promise<number>;
  /** Stores a provider event unless (provider, external_id) is known; null for a replay */
  insertWebhookIfNew(row: WebhookRec): Promise<WebhookRec | null>;
  /** Insert that yields null instead of failing on a unique conflict (refund per origin, capture per key) */
  insertIfNew<T extends 'refunds' | 'captures' | 'intents'>(table: T, row: Recs[T]): Promise<Recs[T] | null>;

  /** Sent and in-flight refund money per order item of an order */
  refundTotals(orderId: string): Promise<RefundTotals[]>;
  /** Sent and in-flight refund money of a payment intent (all its refunds) */
  intentRefundTotals(intentId: string): Promise<{ sent: number; inFlight: number }>;

  listIntents(f: PaymentListFilter, page: PageRequest): Promise<common.Page<IntentRec>>;
  listRefunds(f: RefundListFilter, page: PageRequest): Promise<common.Page<RefundRec>>;
  listDisputes(f: DisputeListFilter, page: PageRequest): Promise<common.Page<DisputeRec>>;
  webhooksFor(provider: string, refs: string[]): Promise<WebhookRec[]>;
}

/* ---------------------------------------------------------------- payment provider port */

export interface CardDetails {
  kind: 'card' | 'digital_wallet';
  /** visa, mastercard, amex, discover … (lower case) */
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  wallet?: 'apple_pay' | 'google_pay' | null;
}

export type DeclineCategory = Decline['category'];

/** The provider's record of a payment */
export interface ProviderPayment {
  status: 'authorized' | 'captured' | 'declined' | 'requires_action' | 'voided' | 'not_found';
  providerRef?: string | null;
  decline?: { code: string; category: DeclineCategory } | null;
  nextAction?: NextAction | null;
  authorizedAmount?: number;
  capturedAmount?: number;
  card?: CardDetails | null;
}

export interface ProviderCapture {
  status: 'succeeded' | 'failed' | 'not_found';
  providerRef?: string | null;
  message?: string | null;
}

export interface ProviderRefund {
  /** pending: accepted by the provider, the bank has not confirmed yet */
  status: 'succeeded' | 'pending' | 'failed' | 'not_found';
  providerRef?: string | null;
  failure?: { code: string; reason: string; retryable: boolean } | null;
}

/** Refund destination other than the original payment */
export interface RefundDestination {
  methodId?: string | null;
  token?: string | null;
}

/**
 * The provider did not answer. `uncertain`: the request may have been processed (timeout, 5xx after sending):
 * the next step is retrieving, never sending again. Otherwise nothing was processed and a retry is safe.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface PaymentProvider {
  /** Adapter code in webhook URLs and on records, e.g. card-processor */
  readonly code: string;
  readonly publishableKey: string;

  /** Card behind a single-use token from the provider's card fields or wallet sheet; null when unusable */
  describeToken(token: string): Promise<CardDetails | null>;
  createSetup(o: { customerId: string | null; idempotencyKey: string }): Promise<{ clientSecret: string; expiresAt: Date }>;
  /** Saved method created by a completed setup; null when the setup token is unknown or failed */
  confirmSetup(setupToken: string): Promise<{ methodId: string; card: CardDetails } | null>;
  /** Keep a single-use token as a saved method (save for later at checkout) */
  attachToken(token: string, customerId: string): Promise<{ methodId: string; card: CardDetails } | null>;
  detach(methodId: string): Promise<void>;
  /** Provider card updater: new expiry (or number) for saved methods */
  cardUpdates(methodIds: string[]): Promise<{ methodId: string; expMonth: number; expYear: number; last4?: string | null }[]>;

  authorize(o: {
    amount: common.Money;
    source: { token?: string | null; methodId?: string | null };
    idempotencyKey: string;
    description: string;
    statementDescriptor: string;
    returnUrl: string;
    intentId: string;
  }): Promise<ProviderPayment>;
  completeAction(o: { providerRef: string; resultToken: string; idempotencyKey: string }): Promise<ProviderPayment>;
  retrievePayment(o: { providerRef?: string | null; idempotencyKey: string }): Promise<ProviderPayment>;
  capture(o: { providerRef: string; amount: common.Money; idempotencyKey: string }): Promise<ProviderCapture>;
  retrieveCapture(o: { idempotencyKey: string }): Promise<ProviderCapture>;
  void(o: { providerRef: string; idempotencyKey: string }): Promise<void>;
  refund(o: { providerRef: string; amount: common.Money; idempotencyKey: string; destination?: RefundDestination | null; refundId: string }): Promise<ProviderRefund>;
  retrieveRefund(o: { idempotencyKey: string }): Promise<ProviderRefund>;

  submitDisputeEvidence(o: { caseId: string; text: string; fileUrls: string[] }): Promise<void>;
  acceptDispute(o: { caseId: string }): Promise<void>;
}
