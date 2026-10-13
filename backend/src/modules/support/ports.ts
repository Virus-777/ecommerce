/**
 * What the support service needs from the outside world, database-agnostic.
 * The MongoDB adapter is repository.ts.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type { Principal } from '../../kernel/auth/index.js';
import type { DecisionInput, RemedyInput, SupportDb } from '../../spec/support.js';

type Db = SupportDb;

/**
 * Facts about a case, each kept in its own column of cases (order_ref, customer_name, problem_type, desired_remedy,
 * info_request_*, escalated_*, seller_replied_at, dispatch_overdue_*, overdue_notified_for, appeal_window_closed…).
 * The repository maps the columns to this object so the rules read one shape: names and references for search and
 * lists, what the customer asked for, the open information request, the last escalation and the dispatch warning.
 */
export interface CaseFacts {
  orderRef?: string | null;
  placedAt?: string | null;
  returnRef?: string | null;
  customerName?: string | null;
  contactEmail?: string | null;
  city?: string | null;
  sellerName?: string | null;
  ownerType?: 'official' | 'seller' | null;
  problemType?: string | null;
  desiredRemedy?: string | null;
  callbackPhone?: string | null;
  reference?: string | null;
  infoRequest?: { from: 'customer' | 'seller'; question: string; dueAt: string; askedAt: string; askedBy: common.Actor } | null;
  escalation?: { at: string; by: common.Actor; reason: string; to: string; note?: string | null } | null;
  sellerRepliedAt?: string | null;
  dispatchOverdue?: { dueAt: string; at: string } | null;
  /** The overdue deadline already announced (support.case.overdue once per deadline) */
  overdueNotified?: string | null;
  /** Appeal and reopen windows already closed by the auto-close job */
  appealWindowClosed?: boolean;
  /** Trust and Risk report the case acts on (inform_customers outreach; support.case.opened carries it) */
  trustReportId?: string | null;
}

/** cases.next_action: the stored next action (recomputed on every save) */
export interface StoredNext {
  label: string;
  whoMustAct: 'customer' | 'seller' | 'marketplace' | 'none';
  note?: string | null;
}

export interface StoredDecision {
  outcome: DecisionInput['outcome'];
  reason: string;
  decidedBy: common.Actor;
  decidedAt: string;
  publishedAt: string | null;
  appealDeadline: string | null;
  final: boolean;
  notifyParties: boolean;
  /** Earlier decisions replaced by an appeal decision */
  previous?: { outcome: string; reason: string; decidedBy: common.Actor; decidedAt: string }[];
}

/** A decision (or appeal decision) waiting for support.remedies.approve: cases.approval_request_id + cases.pending_decision */
export interface PendingApproval {
  kind: 'decision' | 'appeal';
  requestId: string;
  ref?: string | null;
  decision?: DecisionInput;
  appeal?: { overturn: boolean; reason: string; remedies: RemedyInput[] };
  requestedBy: common.Actor;
  principal: Principal;
  requestedAt: string;
}

/** cases.pending_decision: the pending approval without its request id (cases.approval_request_id) */
export type StoredPending = Omit<PendingApproval, 'requestId'>;

export interface StoredDraft {
  draft: DecisionInput;
  savedAt: string;
  savedBy: common.Actor;
}

/** The columns of cases that hold CaseFacts (mapped to and from CaseRec.facts by the repository) */
export const FACT_COLUMNS = [
  'order_ref',
  'placed_at',
  'return_ref',
  'customer_name',
  'contact_email',
  'city',
  'seller_name',
  'owner_type',
  'reference',
  'trust_report_id',
  'problem_type',
  'desired_remedy',
  'callback_phone',
  'info_request_from',
  'info_request_question',
  'info_request_due_at',
  'info_requested_at',
  'info_requested_by',
  'escalated_at',
  'escalated_by',
  'escalation_reason',
  'escalated_to',
  'escalation_note',
  'seller_replied_at',
  'dispatch_overdue_due_at',
  'dispatch_overdue_noted_at',
  'overdue_notified_for',
  'appeal_window_closed',
] as const;
export type FactColumn = (typeof FACT_COLUMNS)[number];

/**
 * A case row: jsonb columns typed, the fact columns gathered in facts and the pending approval
 * (approval_request_id + pending_decision) in pending.
 */
export interface CaseRec extends Omit<Db['cases'], 'next_action' | 'decision' | 'decision_draft' | 'approval_request_id' | 'pending_decision' | FactColumn> {
  next_action: StoredNext;
  decision: StoredDecision | null;
  decision_draft: StoredDraft | null;
  facts: CaseFacts;
  pending: PendingApproval | null;
}

/** Order item facts copied when the case is opened (current state is read from orders at view time) */
export interface ItemSnapshot {
  title: string;
  options: Record<string, string>;
  quantity: number;
  price: common.Money;
  paid?: common.Money | null;
  imageUrl?: string | null;
  ownerType: 'official' | 'seller';
  sellerId?: string | null;
  sellerName: string;
  packageLabel?: string | null;
  groupId?: string | null;
  productId?: string | null;
  variantId?: string | null;
  itemStatus?: string | null;
}

export interface ItemRec extends Omit<Db['case_items'], 'snapshot'> {
  snapshot: ItemSnapshot;
}
export interface MessageRec extends Omit<Db['case_messages'], 'media_ids'> {
  media_ids: string[];
}
export interface EvidenceRec extends Omit<Db['case_evidence'], 'media_ids'> {
  media_ids: string[];
}
export type OfferRec = Db['case_offers'];
export interface RemedyRec extends Omit<Db['case_remedies'], 'order_item_ids'> {
  order_item_ids: string[];
}
export interface AppealRec extends Omit<Db['case_appeals'], 'media_ids'> {
  media_ids: string[];
}
export type EventRec = Db['case_events'];
export type CategoryRec = Db['case_categories'];

export interface Recs {
  case_categories: CategoryRec;
  cases: CaseRec;
  case_items: ItemRec;
  case_messages: MessageRec;
  case_evidence: EvidenceRec;
  case_offers: OfferRec;
  case_remedies: RemedyRec;
  case_appeals: AppealRec;
  case_events: EventRec;
}
export type Table = keyof Recs;

/** A column condition: a value (=), a list (in), null (is null) or an operator */
export type Cond<V> = V | readonly V[] | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not' | 'not in'; value: V | null | readonly V[] };
export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

/** Filters of the case lists (store, seller, admin, exports, jobs) */
export interface CaseFilter {
  ids?: string[];
  /** Customer or guest session (either matches) */
  customerId?: string | null;
  guestSessionId?: string | null;
  sellerId?: string;
  orderId?: string;
  returnIds?: string[];
  kinds?: string[];
  statuses?: string[];
  ownerId?: string;
  unassigned?: boolean;
  /** next_response_due_at before this time */
  dueBefore?: Date;
  category?: string;
  priority?: string;
  q?: string;
  /** Appeal windows whose end the auto-close job has not recorded yet (appeal_window_closed = false) */
  appealWindowOpen?: boolean;
  /** Cases whose current response deadline was not announced yet (overdue_notified_for differs from next_response_due_at) */
  overdueUnannounced?: boolean;
  /** appeal_deadline before this time */
  appealDeadlineBefore?: Date;
  openedFrom?: Date;
  openedTo?: Date;
  handler?: string;
}

export type CaseSort = 'next_deadline' | 'newest' | 'priority' | 'updated';

/** Persistence for this module's own tables: support.case_categories, support.cases, support.case_items, support.case_messages, support.case_evidence, support.case_offers, support.case_remedies, support.case_appeals, support.case_events. */
export interface SupportRepository {
  /** Runs fn in one transaction (nested calls join the outer one) */
  transaction<T>(fn: (tx: SupportRepository) => Promise<T>): Promise<T>;
  /** Claims an event key in the module inbox (inside a transaction: commits with its effects); false once claimed */
  claim(key: string): Promise<boolean>;

  /* generic table access (jsonb is mapped at this boundary); case_categories is keyed by key */
  get<T extends Exclude<Table, 'case_items'>>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined>;
  find<T extends Table>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]>;
  count<T extends Table>(table: T, where: Where<Recs[T]>): Promise<number>;
  insert<T extends Table>(table: T, row: Recs[T]): Promise<Recs[T]>;
  insertMany<T extends Table>(table: T, rows: Recs[T][]): Promise<void>;
  update<T extends Exclude<Table, 'case_items'>>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]>;

  /** Inserts categories that do not exist yet (staff changes are kept) */
  seedCategories(rows: CategoryRec[]): Promise<void>;
  upsertCategory(row: CategoryRec): Promise<CategoryRec>;

  /** Cases matching a filter in the given order; offset paging in both modes */
  listCases(f: CaseFilter, sort: CaseSort, page: PageRequest): Promise<common.Page<CaseRec>>;
  countCases(f: CaseFilter): Promise<number>;
  /** Cases (any state unless openOnly) linked to any of these order items */
  casesForItems(orderItemIds: string[], openOnly: boolean): Promise<{ caseId: string; orderItemId: string }[]>;
  /** Open customer cases per product (case items of the product) */
  openCasesPerProduct(productIds: string[]): Promise<Map<string, number>>;
  /** Open cases per owner and how many are past their response deadline */
  openPerOwner(ownerIds: string[], now: Date): Promise<Map<string, { open: number; overdue: number }>>;
}
