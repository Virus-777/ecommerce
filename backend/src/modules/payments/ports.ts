/**
 * What the payments service needs from the outside world, database-agnostic.
 * The MongoDB adapter is repository.ts.
 * The payment processor is behind PaymentProvider; the deterministic dev adapter is providers/card-processor.ts.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type { Decline, MethodSnapshot, NextAction, PaymentsDb, Tender } from '../../spec/payments.js';

type Db = PaymentsDb;

/* ---------------------------------------------------------------- stored rows (jsonb columns typed) */

/** intents.method: the MethodSnapshot (the bank challenge waiting for the customer is intents.next_action) */
export type StoredMethod = MethodSnapshot;

/**
 * A store-credit share given back through wallet, keyed by what returned it (a refund id, or the intent id when a
 * cancelled order's credit came back). Reserved under the intent lock before wallet is called, so concurrent
 * refunds never return the same credit twice; `sent` once wallet confirmed it.
 */
export interface CreditReturn {
  amount: number;
  sent: boolean;
}

/** The store-credit share of one capture (reported as creditAmount on payments.payment.captured) */
export interface CaptureCredit {
  amount: number;
  groupId: string | null;
}

/**
 * intents.tenders: the Tender of the API; the store-credit tender also keeps what went back to credit and the credit
 * share of each capture (no columns for them in the spec). creditReturns is keyed by refund (refund:<id>), cancelled
 * item (item:<orderItemId>), order cancellation or excess; captureCredits by capture id.
 */
export type StoredTender = Tender & { creditReturns?: Record<string, CreditReturn>; captureCredits?: Record<string, CaptureCredit> };

export interface IntentRec extends Omit<Db['intents'], 'tenders' | 'method' | 'decline' | 'next_action'> {
  tenders: StoredTender[];
  method: StoredMethod;
  decline: Decline | null;
  next_action: NextAction | null;
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
 * disputes.evidence: the DisputeEvidence of the API with the file ids (the history is payments.dispute_log, a
 * concession waiting for approval disputes.approval_request_id and concession_reason).
 */
export interface StoredEvidence {
  text?: string | null;
  fileIds: string[];
  files: common.MediaRef[];
  submittedAt?: string | null;
  submittedBy?: common.Actor | null;
}
export interface DisputeRec extends Omit<Db['disputes'], 'evidence'> {
  evidence: StoredEvidence;
}
export interface DisputeLogRec extends Omit<Db['dispute_log'], 'actor'> {
  actor: common.Actor;
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
  dispute_log: DisputeLogRec;
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
  /** inclusive market days, YYYY-MM-DD */
  from?: string;
  to?: string;
  /** the market time zone the days are in (default UTC) */
  timeZone?: string;
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

/** Persistence for this module's own tables: payments.intents, payments.allocations, payments.captures, payments.provider_calls, payments.refunds, payments.refund_items, payments.refund_log, payments.disputes, payments.dispute_log, payments.saved_methods, payments.webhook_events, payments.ref_sequences. */
export interface PaymentsRepository {
  /** Runs fn in a transaction with a repository bound to it (nested calls join the outer one) */
  transaction<T>(fn: (tx: PaymentsRepository) => Promise<T>): Promise<T>;

  get<T extends Table>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined>;
  find<T extends Table>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]>;
  insert<T extends Table>(table: T, row: Recs[T]): Promise<Recs[T]>;
  insertMany<T extends Table>(table: T, rows: Recs[T][]): Promise<void>;
  /**
   * Live authorizations (authorized, partially_captured) last changed at or before `upTo`, in keyset order
   * (updated_at, id) after the given position: the expiry sweep walks them page by page until none are left.
   */
  liveAuthorizations(after: { updatedAt: Date; id: string } | null, upTo: Date, limit: number): Promise<IntentRec[]>;
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
  /** Provider events applied to the payment or to one of its refunds, oldest first */
  webhooksFor(intentId: string): Promise<WebhookRec[]>;
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
  /**
   * Optional capability (decision D-P1): lowers an authorization by `amount` (partial reversal) and answers the
   * amount still authorized. Adapters without it leave the amount authorized; payments then only takes the
   * cancelled card share off the allocations and releases the remainder at the final capture.
   */
  partialVoid?(o: { providerRef: string; amount: common.Money; idempotencyKey: string }): Promise<{ authorizedAmount: number }>;
  refund(o: { providerRef: string; amount: common.Money; idempotencyKey: string; destination?: RefundDestination | null; refundId: string }): Promise<ProviderRefund>;
  retrieveRefund(o: { idempotencyKey: string }): Promise<ProviderRefund>;

  submitDisputeEvidence(o: { caseId: string; text: string; fileUrls: string[] }): Promise<void>;
  acceptDispute(o: { caseId: string }): Promise<void>;
}
