// Orders, tracking, cancellations and returns for My account: GraphQL screen queries (OrderList,
// OrderDetail, ReturnDetail, AccountOverview), their result types, and the date, money and status
// helpers the account order screens share. See web-shared/docs/API.md.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useSession } from '@/app/session';
import { call, useApi } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import type { Tone } from '@marketly/web-shared/ui';
// The screen queries are copied from the backend docs into web-shared (no package export for them yet).
import ACCOUNT_OVERVIEW from '../../../../../web-shared/src/api/graphql/store/AccountOverview.graphql?raw';
import ORDER_DETAIL from '../../../../../web-shared/src/api/graphql/store/OrderDetail.graphql?raw';
import ORDER_LIST from '../../../../../web-shared/src/api/graphql/store/OrderList.graphql?raw';
import RETURN_DETAIL from '../../../../../web-shared/src/api/graphql/store/ReturnDetail.graphql?raw';

export { ACCOUNT_OVERVIEW, ORDER_DETAIL, ORDER_LIST, RETURN_DETAIL };

/* ---------------- Shared GraphQL shapes ---------------- */

export interface GMoney {
  amount: number;
  currency: string;
  formatted: string;
}

export interface GImage {
  id: string;
  url: string;
  alt?: string | null;
}

export interface Deadline {
  dueAt: string;
  state: string;
}

/* ---------------- OrderList ---------------- */

export type OrderRange = 'LAST_30_DAYS' | 'LAST_3_MONTHS' | 'LAST_6_MONTHS' | 'THIS_YEAR' | 'ALL';
export type OrderTab = 'ALL' | 'IN_PROGRESS' | 'DELIVERED' | 'RETURNS' | 'CANCELLED';
export type OrderAction = 'VIEW' | 'TRACK' | 'RETURN' | 'CANCEL' | 'REVIEW' | 'BUY_AGAIN';

export interface OrderListItem {
  id: string;
  ref: string;
  placedAt: string;
  status: string;
  statusLabel: string;
  itemCount: number;
  sellerCount: number;
  packageCount: number;
  note: string | null;
  actions: OrderAction[];
  thumbnails: GImage[];
  totals: { total: GMoney };
  groups: Array<{
    id: string;
    packageLabel: string;
    status: string;
    statusLabel: string;
    estimateLabel: string | null;
    seller: { id: string | null; name: string; slug: string; official: boolean };
  }>;
}

export interface OrderListResult {
  orders: { total: number | null; page: number | null; totalPages: number | null; nextCursor: string | null; items: OrderListItem[] };
  me: { id: string; orderCounts: { all: number; inProgress: number; delivered: number; returns: number; cancelled: number } } | null;
}

/* ---------------- OrderDetail ---------------- */

export type ItemAction = 'CANCEL' | 'RETURN' | 'TRACK' | 'VIEW_RETURN' | 'REVIEW' | 'REPORT_PROBLEM' | 'CONTACT_SELLER' | 'BUY_AGAIN';

export interface OrderItem {
  id: string;
  productId: string;
  /** Selected once the OrderDetail screen query asks for it (the schema has it). */
  productSlug?: string | null;
  variantId: string;
  offerId: string;
  title: string;
  variantLabel: string;
  quantity: number;
  state: string;
  stateLabel: string;
  stateNote: string | null;
  shipmentId: string | null;
  deliveredAt: string | null;
  returnWindowEndsAt: string | null;
  actions: ItemAction[];
  image: GImage | null;
  unitPrice: GMoney;
  lineSubtotal: GMoney;
  paidAmount: GMoney;
  afterSales: { cancellationId: string | null; returnId: string | null; returnRef: string | null; refundStatus: string | null; caseRef: string | null; refundedAmount: GMoney | null } | null;
  returnEligibility: {
    eligible: boolean;
    ineligibleReason: string | null;
    message: string | null;
    quantityReturnable: number;
    returnBy: string | null;
    latestReturn: { returnId: string; ref: string; status: string; statusLabel: string; refundStatus: string | null } | null;
  } | null;
  reviewStatus: { canReview: boolean } | null;
}

export type DeliveryChoice = 'REDELIVER' | 'PICKUP' | 'RETURN_TO_SELLER';

export interface FailedDelivery {
  reason: string;
  heldAt: string | null;
  chooseBy: string;
  defaultIfNoChoice: string;
  chosen: { choice: DeliveryChoice; redeliveryDate: string | null; chosenAt: string } | null;
  options: Array<{ choice: DeliveryChoice; title: string; description: string; dates: string[]; pickupLocation: string | null; cost: GMoney; costIfNoChoice: GMoney | null }>;
}

export interface Shipment {
  id: string;
  kind: string;
  packageLabel: string;
  sellerName: string;
  shipFrom: string | null;
  carrierName: string | null;
  serviceName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: string;
  statusLabel: string;
  steps: string[];
  currentStep: number;
  shippedAt: string | null;
  estimateLabel: string | null;
  deliveredAt: string | null;
  headline: string | null;
  estimateNote: string | null;
  helpNote: string | null;
  contents: Array<{ orderItemId: string; title: string; variantLabel: string; quantity: number }>;
  events: Array<{ at: string; code: string; label: string; detail: string | null; location: string | null }>;
  failedDelivery: FailedDelivery | null;
  notices: Array<{ id: string; title: string; message: string }>;
}

export interface RefundPreviewG {
  destination: string;
  timingNote: string;
  statusNote: string;
  itemAmount: GMoney;
  discountShare: GMoney;
  shippingRefund: GMoney;
  taxRefund: GMoney;
  total: GMoney;
  lines: Array<{ itemId: string; title: string; quantity: number; refund: GMoney }>;
}

export interface Cancellation {
  id: string;
  initiatedBy: string;
  reasonCode: string;
  reason: string | null;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  declineReason: string | null;
  refundStatus: string;
  respondBy: Deadline | null;
  items: Array<{ itemId: string; title: string; variantLabel: string; quantity: number; shipped: boolean }>;
  refundPreview: RefundPreviewG;
  timeline: Array<{ at: string; label: string; detail: string | null }>;
}

export interface OrderGroup {
  id: string;
  packageLabel: string;
  shipsFrom: string | null;
  fulfilledBy: string;
  status: string;
  statusLabel: string;
  estimateLabel: string | null;
  returnTermsSummary: string | null;
  handlingNote: string | null;
  seller: { id: string | null; name: string; slug: string; official: boolean; verified: boolean; logo: GImage | null };
  delivery: { methodName: string; carrier: string | null; service: string | null; free: boolean; arrivalFrom: string | null; arrivalTo: string | null; dispatchBy: string | null } | null;
  alert: { tone: string; title: string; message: string; caseRef: string | null } | null;
  items: OrderItem[];
  shipments: Shipment[];
  cancellations: Cancellation[];
}

export interface OrderDetail {
  id: string;
  ref: string;
  placedAt: string;
  status: string;
  statusFlags: string[];
  statusLabel: string;
  summaryLine: string;
  itemCount: number;
  sellerCount: number;
  packageCount: number;
  canCancelSomething: boolean;
  addressNote: string | null;
  deliveryAddress: { name: string; line1: string; line2: string | null; city: string; region: string; postalCode: string; country: string; phone: string | null } | null;
  progress: {
    payment: { state: string; label: string; chargedAt: string | null; methodLabel: string | null; note: string | null; amountCharged: GMoney | null };
    delivery: { state: string; label: string; packagesTotal: number; packagesDelivered: number; packageStates: string[] };
    returns: { state: string; label: string; openReturns: number; note: string | null };
  };
  totals: {
    itemCount: number;
    shippingLabel: string;
    taxLabel: string;
    paidWith: string | null;
    items: GMoney;
    discounts: Array<{ code: string | null; label: string; fundedBy: string; amount: GMoney }>;
    discountTotal: GMoney;
    shippingTotal: GMoney;
    tax: GMoney;
    total: GMoney;
    refundedSoFar: GMoney;
    expectedRefunds: Array<{ label: string; ref: string | null; status: string; amount: GMoney }>;
  };
  groups: OrderGroup[];
  payment: { id: string; state: string; stateLabel: string; methodLabel: string | null; chargedAt: string | null; amount: GMoney; refundedAmount: GMoney; refundsInFlight: GMoney } | null;
  refunds: Array<{ id: string; ref: string; origin: string; originRef: string | null; destinationLabel: string; status: string; statusLabel: string; sentAt: string | null; amount: GMoney }>;
  returns: Array<{ id: string; ref: string; status: string; statusLabel: string; nextStep: string | null; nextDeadline: Deadline | null; items: Array<{ orderItemId: string }>; refund: { status: string; statusLabel: string } | null }>;
  cases: Array<{ id: string; ref: string; subject: string; status: string; statusLabel: string; open: boolean; expectedReply: string; items: Array<{ orderItemId: string }> }>;
  documents: Array<{ id: string; kind: string; label: string; groupId: string | null; number: string; format: string; issuedAt: string }>;
}

/* ---------------- ReturnDetail ---------------- */

export interface TrackStep {
  key: string;
  label: string;
  state: 'DONE' | 'CURRENT' | 'UPCOMING';
}

export interface ReturnDetail {
  id: string;
  ref: string;
  orderRef: string;
  ownerType: string;
  sellerName: string;
  status: string;
  statusLabel: string;
  reason: string;
  details: string;
  remedy: string;
  handledBy: string;
  nextStep: string | null;
  open: boolean;
  requestedAt: string;
  /** What the customer can do now (ReturnCustomerAction): WITHDRAW, REPLY_INFO, GET_LABEL, ADD_TRACKING, ESCALATE, REPORT_PROBLEM. */
  actions: string[];
  media: GImage[];
  track: TrackStep[];
  items: Array<{ orderItemId: string; title: string; imageUrl: string | null; quantity: number; options: Array<{ name: string; value: string }>; unitPrice: GMoney }>;
  /** When the seller (or Marketly) must answer the request. */
  responseDue?: Deadline | null;
  nextDeadline?: Deadline | null;
  /** A question to the customer; returns.info-expiry cancels the return when replyDueAt passes without a reply. */
  infoRequest?: { question: string; askedAt: string; replyDueAt: string; reply: string | null; repliedAt: string | null; askedBy: { kind: string; name: string } } | null;
  /** Set once the customer (or a deadline job) asked Marketly to step in. */
  escalation?: { at: string; reason: string; caseRef: string | null } | null;
  decision: { kind: string; explanation: string | null; decidedAt: string } | null;
  shipment: {
    id: string;
    status: string;
    method: string;
    carrier: string | null;
    service: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    labelUrl: string | null;
    qrCodeUrl: string | null;
    dropOffBy: string | null;
    instructions: string[];
    paidBy: string;
    cost: GMoney | null;
    dropOffPoints: Array<{ name: string; address: string; distanceMiles: number | null; hours: string | null }>;
    from: { city: string; region: string; postalCode: string } | null;
    to: { name: string; line1: string; line2: string | null; city: string; region: string; postalCode: string; country: string } | null;
    events: Array<{ at: string; label: string; detail: string | null }>;
  } | null;
  refund: {
    id: string;
    ref: string;
    status: string;
    statusLabel: string;
    approvedAt: string | null;
    sentAt: string | null;
    failedReason: string | null;
    expectedBy: string | null;
    bankReference: string | null;
    explanation: string | null;
    track: TrackStep[];
    breakdown: {
      destination: string;
      isEstimate: boolean;
      itemAmount: GMoney;
      discountShare: GMoney;
      shippingRefund: GMoney;
      returnShippingDeduction: GMoney;
      deductions: Array<{ label: string; reason: string; amount: GMoney }>;
      total: GMoney;
    } | null;
  } | null;
  replacement: {
    id: string;
    kind: string;
    status: string;
    title: string;
    quantity: number;
    chargeNote: string | null;
    newReturnWindowEnds: string | null;
    options: Array<{ name: string; value: string }>;
    shipment: {
      id: string;
      status: string;
      statusLabel: string;
      carrierName: string | null;
      serviceName: string | null;
      trackingNumber: string | null;
      trackingUrl: string | null;
      steps: string[];
      currentStep: number;
      estimateLabel: string | null;
      deliveredAt: string | null;
      events: Array<{ at: string; label: string; detail: string | null; location: string | null }>;
    } | null;
  } | null;
  terms: { summary: string; windowDays: number } | null;
  case: { id: string; ref: string; status: string; statusLabel: string; expectedReply: string } | null;
  timeline: Array<{ at: string; label: string; detail: string | null }>;
  order: { id: string; ref: string; placedAt: string; status: string; statusLabel: string; totals: { total: GMoney } } | null;
  conversation: { id: string; unreadCount: number; counterparty: { kind: string; name: string } } | null;
}

/* ---------------- Queries ---------------- */

/** GraphQL order(ref): the order, or null when there is no such order for this shopper (not-found state). */
export function useOrderDetail(ref: string) {
  const { gql } = useApi();
  return useQuery({
    queryKey: ['orders', 'detail', ref],
    queryFn: async () => (await gql<{ order: OrderDetail | null }>(ORDER_DETAIL, { ref }, 'OrderDetail')).data?.order ?? null,
  });
}

/** GraphQL return(ref): the return, or null when it isn't this shopper's. */
export function useReturnDetail(ref: string) {
  const { gql } = useApi();
  return useQuery({
    queryKey: ['returns', 'detail', ref],
    queryFn: async () => (await gql<{ return: ReturnDetail | null }>(RETURN_DETAIL, { ref }, 'ReturnDetail')).data?.return ?? null,
  });
}

/**
 * Buy again: adds every item of the order that can be bought again (OrderDetail items carry the
 * offer and whether it can be bought again) to the cart, then opens the cart. The OrderList screen query
 * selects no items, so it reads the order first.
 */
export function useBuyAgain() {
  const { api, gql } = useApi();
  const { refreshCart } = useSession();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (ref: string) => {
      const order = (await gql<{ order: OrderDetail | null }>(ORDER_DETAIL, { ref }, 'OrderDetail')).data?.order;
      const items = (order?.groups ?? []).flatMap((g) => g.items).filter((i) => i.actions.includes('BUY_AGAIN'));
      let added = 0;
      let lastError: unknown = null;
      for (const i of items) {
        try {
          await call(api.POST('/api/store/cart/cart/items', { body: { offerId: i.offerId, quantity: i.quantity, source: 'buy_again' } }));
          added++;
        } catch (e) {
          lastError = e;
        }
      }
      if (!added && lastError) throw lastError;
      return added;
    },
    onSuccess: () => {
      refreshCart();
      navigate(href('store/cart'));
    },
  });
}

/** Opens an order document (receipt, invoice): the API returns a short-lived PDF link. */
export function useOpenDocument(orderId: string | undefined) {
  const { api } = useApi();
  return useMutation({
    mutationFn: async (documentId: string) => {
      const doc = await call(api.GET('/api/store/orders/orders/{id}/documents/{documentId}', { params: { path: { id: orderId!, documentId } } }));
      // The PDF link is an attachment download, so opening it keeps the shopper on this page (and a
      // window.open after an await would be blocked as a popup).
      window.location.assign(doc.url);
      return doc;
    },
  });
}

/**
 * Uploads one file through the media upload flow (brief §4.7): ticket → bytes → complete → wait until
 * the asset is ready. Returns the asset id to send as a media id. Development storage takes the bytes
 * through the API itself (sent with the session token); real storage takes them at its own URL.
 */
/* ---------------- Dates (market time zone: Pacific) ---------------- */

const TZ = 'America/Los_Angeles';
const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(isDateOnly(iso) ? `${iso}T12:00:00Z` : iso).toLocaleString('en-US', { timeZone: isDateOnly(iso) ? 'UTC' : TZ, ...opts });

/** "Oct 13, 2026" */
export const fmtDay = (iso: string) => fmt(iso, { month: 'short', day: 'numeric', year: 'numeric' });
/** "Oct 13" */
export const fmtMonthDay = (iso: string) => fmt(iso, { month: 'short', day: 'numeric' });
/** "Tue, Oct 20" */
export const fmtWeekday = (iso: string) => fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' });
/** "Tue, Oct 13, 11:21 AM" */
export const fmtDateTime = (iso: string) => fmt(iso, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** "Oct 13, 2026, 4:20 AM" */
export const fmtPlaced = (iso: string) => fmt(iso, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
/** "Aug 2026" */
export const fmtMonthYear = (iso: string) => fmt(iso, { month: 'short', year: 'numeric' });
/** The current year in the market time zone ("2026"). */
export const thisYear = () => new Date().toLocaleString('en-US', { timeZone: TZ, year: 'numeric' });

/* ---------------- Labels, tones, links ---------------- */

/** "PARTLY_DELIVERED" -> "Partly delivered" */
export const humanize = (v: string) => {
  const s = v.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** "+15035550148" -> "(503) 555-0148" */
export const fmtPhone = (p: string) => {
  const m = p.replace(/\D/g, '').match(/^1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
};

const STATE_TONE: Record<string, Tone> = {
  PAYMENT_PENDING: 'warning', CONFIRMED: 'info', PREPARING: 'info', DELAYED: 'warning', PARTLY_SHIPPED: 'info', SHIPPED: 'info', IN_TRANSIT: 'info',
  OUT_FOR_DELIVERY: 'info', PARTLY_DELIVERED: 'warning', DELIVERED: 'success', PARTLY_CANCELLED: '', CANCELLED: '', PARTLY_REFUNDED: '', REFUNDED: '',
  COMPLETED: 'success', DELIVERY_FAILED: 'danger', ATTEMPT_FAILED: 'danger', EXCEPTION: 'danger', LOST: 'danger',
  RETURN_REQUESTED: 'warning', RETURN_APPROVED: 'info', RETURN_IN_TRANSIT: 'info', RETURNED: '', CANCELLATION_REQUESTED: 'warning',
};
/** Tone of an order, package, shipment or item state (enum value, any case). */
export const stateTone = (state: string | null | undefined): Tone => STATE_TONE[(state ?? '').toUpperCase()] ?? '';

const RETURN_TONE: Record<string, Tone> = {
  REQUESTED: 'info', INFO_REQUESTED: 'warning', APPROVED: 'success', REJECTED: 'danger', IN_TRANSIT: 'info', RECEIVED: 'info',
  AWAITING_REMEDY: 'info', COMPLETED: 'success', CANCELLED: '',
};
export const returnTone = (status: string | null | undefined): Tone => RETURN_TONE[(status ?? '').toUpperCase()] ?? '';

const REFUND_TONE: Record<string, Tone> = { REQUESTED: 'info', PROCESSING: 'info', SENT: 'success', FAILED: 'danger', CANCELLED: '', NONE: '' };
export const refundTone = (status: string | null | undefined): Tone => REFUND_TONE[(status ?? '').toUpperCase()] ?? '';

/** Package-card tone: delivered green, late amber, failed red, cancelled neutral, otherwise blue. */
export function groupTone(status: string): 'success' | 'info' | 'warning' | 'danger' | '' {
  const s = status.toUpperCase();
  if (s === 'DELIVERED' || s === 'COMPLETED') return 'success';
  if (s === 'DELAYED' || s === 'PAYMENT_PENDING') return 'warning';
  if (s.includes('FAILED') || s === 'EXCEPTION') return 'danger';
  if (s.includes('CANCELLED') || s.includes('REFUNDED')) return '';
  return 'info';
}

/** "Halden Aurora ANC Wireless Headphones" -> "halden-aurora-anc-wireless-headphones": the stand-in slug where a screen has no product slug (product routes resolve by id). */
export const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 80) || 'product';

/** Product page link: the API's product slug, else one made from the title (OrderDetail doesn't select OrderItem.productSlug yet). */
export const productHref = (productId: string, title: string, slug?: string | null) => href('store/product', '', { slug: slug || slugify(title), id: productId });
export const orderHref = (ref: string) => href('account/order', '', { ref });
export const returnHref = (ref: string) => href('account/return', '', { ref });
export const caseHref = (ref: string) => href('help/case', '', { ref });

/** "Package 2 of 3" -> "Package 2"; "Package 1 of 1" -> "Package" (the design's short labels). */
export const shortPackageLabel = (label: string) => label.replace(/^Package 1 of 1$/, 'Package').replace(/ of \d+$/, '');

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** First letters of a seller name for its logo tile ("Casa Verde Home" -> "CV"). */
export const sellerInitials = (name: string) =>
  name
    .replace(/&/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .slice(0, 2)
    .join('');
