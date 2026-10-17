/**
 * Row types of the returns collections (typed json fields) and the list filters the repository
 * (repository.ts) takes.
 */
import type * as common from '../../spec/common.js';
import type {
  EffectiveTerms,
  Escalation,
  ExceptionRecord,
  InspectionCheck,
  RefundDeduction,
  ReturnDecision,
  ReturnDestination,
  ReturnsDb,
  ShippingResponsibility,
} from '../../spec/returns.js';

type Db = ReturnsDb;

export interface PolicyRec extends Omit<Db['policy_versions'], 'responsibilities'> {
  responsibilities: ShippingResponsibility[];
}
export interface CategoryExceptionRec extends Omit<Db['category_exceptions'], 'shown_on'> {
  shown_on: string[];
}
export interface TermsRec extends Omit<Db['seller_terms'], 'remedies' | 'return_address'> {
  remedies: string[];
  return_address: common.Address;
}

/** Targets of the baseline in force when the return was requested (deadlines are computed from them) */
export interface StoredTargets {
  responseBusinessDays: number;
  infoReplyDays: number;
  dropOffDays: number;
  inspectionBusinessDays: number;
  refundBusinessDays: number;
}

/** Facts copied from the order when the return is created (returns never read them back from orders for history) */
export interface ReturnMeta {
  groupId: string;
  sellerName: string;
  customerName: string;
  contactEmail: string | null;
  city: string | null;
  deliveryAddress: common.Address | null;
  paymentIntentId: string | null;
  paymentMethodLabel: string | null;
  placedAt: string;
  /** Latest return-by of the items (fault window) */
  returnBy: string | null;
  destination: ReturnDestination;
  reasonGroup: string;
  customerFee: number;
  targets: StoredTargets;
  carrierServiceId?: string | null;
  /** Item images from the order snapshot, by order item id */
  images?: Record<string, string | null>;
  /** Stock item of each returned order item (replacements reserve the same stock) */
  stockItems?: Record<string, string>;
  /** Offer of each returned order item */
  offers?: Record<string, string>;
  /** Product category of each returned order item at purchase (inspection checks by category) */
  categories?: Record<string, string | null>;
  /** Set when the return completes: refunded | partly_refunded | replaced | exchanged | credited */
  outcome?: string | null;
  /** Latest shipment estimate from shipping.shipment.status_changed */
  estimatedArrival?: common.DateRange | null;
}

/** returns.terms_snapshot: the terms accepted at purchase plus the order facts above */
export interface StoredTerms {
  terms: EffectiveTerms;
  meta: ReturnMeta;
}

export interface StoredInfoRequest {
  question: string;
  askedBy: common.Actor;
  askedAt: string;
  replyDueAt: string;
  reply?: string | null;
  replyMediaIds: string[];
  repliedAt?: string | null;
  /** Respond-by time left when the clock was paused (ms) */
  remainingMs: number;
}

export interface ReturnRec extends Omit<Db['returns'], 'media_ids' | 'terms_snapshot' | 'info_request' | 'decision' | 'escalation' | 'exception' | 'inspector'> {
  media_ids: string[];
  terms_snapshot: StoredTerms;
  info_request: StoredInfoRequest | null;
  decision: ReturnDecision | null;
  escalation: Escalation | null;
  exception: ExceptionRecord | null;
  inspector: common.Actor | null;
}
export interface ItemRec extends Omit<Db['return_items'], 'options'> {
  options: Record<string, string>;
}
export interface ShipmentRec extends Omit<Db['return_shipments'], 'from_address' | 'to_address'> {
  from_address: common.Address | null;
  to_address: common.Address;
}
export interface DraftRec extends Omit<Db['inspection_drafts'], 'inspection' | 'remedy' | 'saved_by'> {
  inspection: unknown;
  remedy: unknown;
  saved_by: common.Actor;
}
export interface EvidenceRec extends Omit<Db['return_evidence'], 'media_ids' | 'added_by'> {
  media_ids: string[];
  added_by: common.Actor;
}
export interface InspectionRec extends Omit<Db['inspections'], 'checks' | 'missing_parts' | 'media_ids'> {
  checks: InspectionCheck[];
  missing_parts: string[];
  media_ids: string[];
}

/** One order item of a refund request (refund_request_items) */
export interface RefundItem {
  orderItemId: string;
  /** Refunded quantity (returns.refund.approved items); null: the returned units */
  quantity: number | null;
  /** Amount refunded on the item (the split handed to payments) */
  amount: number;
}
/**
 * A refund request with its items (refund_request_items, in order) and history (refund_request_events, oldest
 * first), loaded by the repository. Items are written with the request (or replaced with setRefundItems); the
 * history is appended with addRefundEvents (an update ignores items, order_item_ids and history).
 */
export interface RefundRec extends Omit<Db['refund_requests'], 'deductions'> {
  /** The itemised deductions with reasons */
  deductions: RefundDeduction[];
  items: RefundItem[];
  /** The order items covered (from items; read-only) */
  order_item_ids: string[];
  history: common.TimelineEvent[];
}
export type ReplacementRec = Db['replacements'];
export type EventRec = Db['return_events'];

export interface Recs {
  policy_versions: PolicyRec;
  category_exceptions: CategoryExceptionRec;
  seller_terms: TermsRec;
  returns: ReturnRec;
  return_items: ItemRec;
  return_shipments: ShipmentRec;
  inspection_drafts: DraftRec;
  return_evidence: EvidenceRec;
  inspections: InspectionRec;
  refund_requests: RefundRec;
  replacements: ReplacementRec;
  return_events: EventRec;
}
/** The returns collections (spec tables) */
export type TableName = keyof Recs;

/** Filters of the return lists (store, seller, admin, exports) */
export interface ReturnFilter {
  customerId?: string | null;
  guestSessionId?: string | null;
  sellerId?: string;
  ownerType?: 'official' | 'seller';
  /** Returns that come to the Marketly returns dock: Official Store and Fulfilled by Marketly returns */
  marketlyDock?: boolean;
  orderId?: string;
  statuses?: string[];
  notStatuses?: string[];
  platformHandling?: boolean;
  /** Escalated, platform-handled or linked to a case */
  disputed?: boolean;
  hasException?: boolean;
  q?: string;
  reason?: string;
  ownerStaffId?: string;
  refundStatuses?: string[];
  /** Has a refund request that is not sent, declined or cancelled */
  refundPending?: boolean;
  requestedFrom?: Date | null;
  requestedTo?: Date | null;
  dueBefore?: Date | null;
  dueFrom?: Date | null;
  completedFrom?: Date | null;
  productIds?: string[];
  /** Only these returns (export of selected rows) */
  ids?: string[];
}

export interface RefundFilter {
  status?: string;
  statuses?: string[];
  source?: string;
  sources?: string[];
  sellerId?: string;
  orderId?: string;
  caseId?: string;
  returnIds?: string[];
  /** The order customer (customer data export) */
  customerIds?: string[];
}
