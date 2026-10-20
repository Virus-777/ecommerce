// Types and helpers for the admin order 360 (design: pages/admin/admin-order.html and admin-order--issue-refund.html).
// Data: GraphQL AdminOrder (orderAdmin(ref), partial data allowed; `history` is the order timeline, `auditTrail`
// only audited staff actions), GET access/me (my refund approval limits; access/approval-actions only for holders of
// access.roles.view), POST returns/refunds (one request per seller group), POST orders/orders/{id}/cancel-items,
// POST orders/orders/{id}/notes, POST messaging/conversations (Contact seller).
import { actorLabel } from '@/app/parts';
import { parseCents } from '@marketly/web-shared/lib/format';
import ADMIN_ORDER from '@marketly/web-shared/api/graphql/admin/AdminOrder.graphql?raw';
import type { TimelineEvent } from '@marketly/web-shared/ui';

export { ADMIN_ORDER };

export interface Amt {
  amount: number;
  currency: string;
  formatted?: string | null;
}
interface Due {
  dueAt: string;
  state: string;
}
interface Who {
  kind: string;
  id: string | null;
  name: string | null;
}
export interface SellerLabel {
  id: string | null;
  name: string;
  /** The seller's store slug (admin seller detail accepts it); "official-store" for the Official Store. */
  slug: string | null;
  official: boolean;
  verified: boolean;
  logo: { url: string; alt: string | null } | null;
}

export interface OrderItem {
  id: string;
  productId: string;
  title: string;
  variantLabel: string;
  image: { url: string; alt: string | null } | null;
  quantity: number;
  unitPrice: Amt;
  lineSubtotal: Amt;
  paidAmount: Amt;
  state: string;
  stateLabel: string;
  stateNote: string | null;
  offerTerms: { sellerSku: string | null; conditionLabel: string | null } | null;
  afterSales: { returnRef: string | null; refundStatus: string | null; refundedAmount: Amt | null; caseRef: string | null } | null;
}

export interface OrderGroup {
  id: string;
  packageLabel: string;
  seller: SellerLabel;
  shipsFrom: string;
  fulfilledBy: string;
  status: string;
  statusLabel: string;
  deadlineLabel: string | null;
  dispatchResult: string | null;
  dispatchDeadline: Due | null;
  estimateLabel: string | null;
  alert: { tone: string; title: string; message: string } | null;
  totals: { items: Amt } | null;
  items: OrderItem[];
  shipments: Array<{ id: string; packageLabel: string; carrierName: string | null; serviceName: string | null; trackingNumber: string | null; trackingUrl: string | null; statusLabel: string; estimateLabel: string | null; deliveredAt: string | null }>;
}

export interface RefundRequestRow {
  id: string;
  ref: string;
  source: string;
  returnRef: string | null;
  orderItemIds: string[];
  sellerName: string;
  status: string;
  reason: string | null;
  breakdown: { total: Amt } | null;
  approval: { required: boolean; reason: string | null; approvers: string[] | string | null } | null;
  approvalRequest: { id: string; ref: string; status: string; approvalsRemaining: number | null; canDecide: boolean; cannotDecideReason: string | null } | null;
}

export interface OrderAdmin {
  id: string;
  ref: string;
  placedAt: string;
  status: string;
  statusLabel: string;
  itemCount: number;
  sellerCount: number;
  packageCount: number;
  allowedActions: string[];
  alerts: Array<{ tone: string; title: string; message: string; caseRef: string | null }>;
  customer: { customerId: string | null; guest: boolean; name: string; email: string | null; phone: string | null; customerSince: string | null; orderCount: number | null } | null;
  deliveryAddress: { line1: string; line2: string | null; city: string; region: string; postalCode: string } | null;
  groups: OrderGroup[];
  afterSales: Array<{ itemId: string; title: string; sellerName: string; request: string; amount: Amt | null; status: string; owner: string | null }>;
  moneyBySeller: Array<{ groupId: string; seller: SellerLabel; items: Amt; platformFunded: Amt; sellerFunded: Amt; customerPaid: Amt; marketplaceFee: Amt | null; sellerEarnings: Amt | null; companySale: boolean }>;
  couponFundingNote: string | null;
  totals: { items: Amt; discounts: Array<{ code: string | null; label: string; fundedBy: string; amount: Amt }>; discountTotal: Amt; shippingTotal: Amt; shippingLabel: string | null; tax: Amt; taxLabel: string | null; total: Amt; refundedSoFar: Amt } | null;
  payment: { state: string; stateLabel: string; methodLabel: string | null; providerRef: string | null; authorizedAt: string | null; capturedAt: string | null; capturedAmount: Amt | null; refundedAmount: Amt | null; refundsInFlight: Amt | null } | null;
  refundable: {
    captured: Amt;
    refunded: Amt;
    inFlight: Amt;
    remaining: Amt;
    items: Array<{ orderItemId: string; title: string; groupId: string; sellerName: string; paid: Amt; refunded: Amt; inFlight: Amt; remaining: Amt; blockedReason: string | null }>;
  } | null;
  refundRequests: RefundRequestRow[];
  returns: Array<{ id: string; ref: string; items: Array<{ orderItemId: string }>; owner: Who | null; nextDeadline: Due | null }>;
  cases: Array<{ id: string; ref: string; subject: string; status: string; statusLabel: string }>;
  notes: Array<{ id: string; text: string; author: Who | null; at: string }>;
  /** The order timeline, newest first. */
  history: HistoryRow[] | null;
}

export const sum = (xs: Amt[], currency = 'USD'): Amt => ({ amount: xs.reduce((a, x) => a + (x?.amount ?? 0), 0), currency: xs[0]?.currency ?? currency });
export const usd = (minor: number, currency = 'USD'): Amt => ({ amount: Math.round(minor), currency });

/** "34.65" → 3465 minor units; NaN when it isn't a money amount. */
export const parseMinor = (s: string | undefined) => parseCents(s) ?? NaN;
export const toInput = (minor: number) => (minor / 100).toFixed(2);

/** Items still waiting for dispatch can be cancelled by staff. */
export const CANCELLABLE = new Set(['CONFIRMED', 'PREPARING', 'DELAYED', 'CANCELLATION_REQUESTED']);

export const REFUND_REASONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Choose a reason' },
  { value: 'damaged_not_returned', label: 'Damaged on arrival, refund without return' },
  { value: 'service_failure', label: 'Seller cannot fulfil' },
  { value: 'late_delivery', label: 'Late delivery' },
  { value: 'customer_goodwill', label: 'Goodwill' },
  { value: 'price_error', label: 'Price error' },
  { value: 'risk_review', label: 'Risk review' },
  { value: 'other', label: 'Other' },
];

export const FUNDED_BY: Array<{ value: 'seller' | 'platform' | 'shared' | 'official_store'; label: string }> = [
  { value: 'seller', label: 'Seller' },
  { value: 'platform', label: 'Marketly' },
  { value: 'shared', label: 'Shared' },
  { value: 'official_store', label: 'Official Store' },
];

export const CANCEL_REASONS: Array<{ value: string; label: string }> = [
  { value: 'overdue_dispatch', label: 'Overdue dispatch' },
  { value: 'seller_cannot_fulfill', label: 'Seller cannot fulfil' },
  { value: 'customer_request', label: 'Customer asked to cancel' },
  { value: 'address_problem', label: 'Address problem' },
  { value: 'risk_review', label: 'Risk review' },
  { value: 'other', label: 'Other' },
];

/** Who pays by default: the Official Store for its own items; Marketly for goodwill and risk; else the seller. */
export const defaultFunding = (official: boolean, reason: string) => (official ? 'official_store' : reason === 'customer_goodwill' || reason === 'risk_review' ? 'platform' : 'seller');

export interface HistoryRow {
  at: string;
  label: string;
  detail: string | null;
  actor: { kind: string; id: string | null; name: string | null } | null;
}

const WARN = /overdue|escalat|exception|failed|declined|late/i;

/** Order history (newest first) as the design's timeline. */
export function toTimeline(rows: HistoryRow[], fmt: (iso: string) => string): TimelineEvent[] {
  return rows.map((r, i) => {
    // GraphQL actor kinds are upper case (SYSTEM, CUSTOMER …); older records have no name.
    const who = actorLabel(r.actor);
    return { t: r.label, d: `${fmt(r.at)}${who ? ` · ${who}` : ''}`, state: WARN.test(r.label) ? 'warn' : i === 0 ? 'current' : 'done', body: r.detail ?? undefined };
  });
}

/** My limit for an approval action, from access/me. */
export interface MyLimit {
  role: { key: string; name: string };
  action: { key: string; approvers: string };
  value: { authority: string; limitMoney: Amt | null; secondReviewerAboveMoney: Amt | null };
  summary: string;
}

/** True when my own limit lets the refund be approved in the same call (the API decides; this only labels the route). */
export function withinLimit(limits: MyLimit[], total: number): boolean {
  return limits.some((l) => l.value.authority === 'permitted' && (!l.value.limitMoney || total <= l.value.limitMoney.amount));
}
