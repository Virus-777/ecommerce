// Seller orders and shipping (design: pages/seller/seller-orders*.html, seller-order*.html, seller-shipping.html).
// API types, the SellerOrderDetail screen query, Pacific-time formatting and the small helpers the Orders,
// Order and Shipping screens share. Data: docs/api/modules/orders.md (seller fulfilment), shipping.md, messaging.md.
import { fromZonedInput } from '@marketly/web-shared/lib/dates';
import { useEffect, useRef, useState } from 'react';
import type { components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import SELLER_ORDER_DETAIL_TEXT from '@marketly/web-shared/api/graphql/seller/SellerOrderDetail.graphql?raw';

type S = components['schemas'];
export type OrderRow = S['orders.SellerOrderRow'];
export type OrderDetailRest = S['orders.SellerOrderDetail'];
export type CancellationRequest = S['orders.CancellationRequest'];
export type ExportJob = S['reports.ExportJob'];
export type LabelQuote = S['shipping.LabelQuote'];
export type LabelResult = S['shipping.LabelResult'];
export type ShippingSettings = S['shipping.SellerShippingSettings'];
export type ProfileMethod = S['shipping.ProfileMethod'];
export type PlatformMethod = S['shipping.ShippingMethod'];
export type Carrier = S['shipping.Carrier'];
export type ReturnTerms = S['returns.SellerReturnTerms'];
export type Address = S['Address'];

/**
 * The SellerOrderDetail screen query plus two fields the persisted operation doesn't select yet (reported to the
 * backend): `onLabelQuantity` on items (units on a bought label that isn't handed over, G41) and the shipment's
 * label link (`label { id labelUrl }`, G54c). Once the operation selects them, the text is used as it is.
 * Development sends the query text; with persisted queries only, the extra fields need the operation updated.
 */
export const SELLER_ORDER_DETAIL = SELLER_ORDER_DETAIL_TEXT.includes('onLabelQuantity')
  ? SELLER_ORDER_DETAIL_TEXT
  : SELLER_ORDER_DETAIL_TEXT.replace(/\n([ \t]+)cancelledQuantity\r?\n/, (m, ind: string) => `${m}${ind}onLabelQuantity\n`).replace(/\n([ \t]+)recordedBy \{/, (m, ind: string) => `\n${ind}label {\n${ind}  id\n${ind}  labelUrl\n${ind}}${m}`);

/* ------------------------------------------------------------------ Pacific time */

const TZ = 'America/Los_Angeles';
const fmt = (d: string | Date, o: Intl.DateTimeFormatOptions) => new Date(d).toLocaleString('en-US', { timeZone: TZ, ...o });

/** YYYY-MM-DD of the market day. */
export const dayKey = (d: string | Date = new Date()) => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
/** "9:14 AM" */
export const ptTime = (d: string | Date) => fmt(d, { hour: 'numeric', minute: '2-digit' });
/** "Oct 8" */
export const ptDate = (d: string | Date) => fmt(d, { month: 'short', day: 'numeric' });
/** "Oct 8, 9:14 AM" */
export const ptDateTime = (d: string | Date) => `${ptDate(d)}, ${ptTime(d)}`;
/** "Oct 8, 2026, 9:14 AM PT" */
export const ptLong = (d: string | Date) => `${fmt(d, { month: 'short', day: 'numeric', year: 'numeric' })}, ${ptTime(d)} PT`;

/** "Mon, Oct 12" for a date-only value (YYYY-MM-DD). */
export const weekdayDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
/** "Mon, Oct 12 – Wed, Oct 14" */
export const dayRange = (from?: string | null, to?: string | null) => (from ? (to && to !== from ? `${weekdayDay(from)} – ${weekdayDay(to)}` : weekdayDay(from)) : '');

/** YYYY-MM-DD plus n days. */
export function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Minutes PT is behind UTC at an instant (420 in summer, 480 in winter). */
/** The instant of a PT wall-clock time on a market day, as ISO. */
export function ptInstant(key: string, hh = 0, mm = 0): string {
  return fromZonedInput(`${key}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, TZ) ?? '';
}

/** "today, Oct 8, 5:00 PM PT" / "tomorrow, Oct 9, …" / "Wed, Oct 14, 5:00 PM PT" */
export function dueText(iso: string): string {
  const k = dayKey(iso);
  const today = dayKey();
  const when = k === today ? `today, ${ptDate(iso)}` : k === addDays(today, 1) ? `tomorrow, ${ptDate(iso)}` : weekdayDay(k);
  return `${when}, ${ptTime(iso)} PT`;
}

/** "(208) 555-0117" from "+12085550117"; anything else as given. */
export const phoneText = (p?: string | null) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p ?? '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (p ?? '');
};

/** Re-renders every `ms` and returns the current time (live countdowns). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** The value, settled for `ms` before it changes (search boxes). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Calls `onVisible` when the element scrolls into view (phone "load more"). */
export function useInView<T extends HTMLElement>(onVisible: () => void, active: boolean) {
  const ref = useRef<T>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && cb.current());
    io.observe(el);
    return () => io.disconnect();
  }, [active]);
  return ref;
}

/* ------------------------------------------------------------------ orders */

export type DueTone = 'ok' | 'warning' | 'danger';

/** Edge and deadline tone of a fulfilment task from its deadline state and label. */
export function deadlineTone(d: { state: string } | null | undefined, label?: string | null): DueTone {
  const s = (d?.state ?? '').toLowerCase();
  if (s === 'overdue' || /\blate\b|overdue/i.test(label ?? '')) return 'danger';
  if (s === 'due_soon' || /^due today/i.test(label ?? '')) return 'warning';
  return 'ok';
}

export const orderLink = (ref: string, view = '') => href('seller/order', view, { ref });

/** The row's next-action button. */
export function nextAction(r: OrderRow): { label: string; primary: boolean; to: string } {
  const tone = deadlineTone(r.dispatchDeadline, r.deadlineLabel);
  switch (r.nextAction) {
    case 'prepare':
      return { label: 'Prepare', primary: true, to: orderLink(r.ref) };
    case 'record_shipment':
      return { label: 'Record shipment', primary: tone === 'danger', to: orderLink(r.ref) };
    case 'ship_remaining':
      return { label: 'Ship remaining items', primary: tone === 'danger', to: orderLink(r.ref) };
    case 'view_tracking':
      return { label: 'View tracking', primary: false, to: orderLink(r.ref, 'shipped') };
    case 'respond_cancellation':
      return { label: 'Respond', primary: true, to: href('seller/orders', 'cancellation-requests') };
    default:
      return { label: 'View', primary: false, to: orderLink(r.ref) };
  }
}

export const SELLER_CANCEL_REASONS = [
  { value: 'out_of_stock', label: 'Out of stock' },
  { value: 'damaged_in_storage', label: 'Damaged in storage' },
  { value: 'pricing_error', label: 'Pricing error' },
  { value: 'cannot_ship_to_address', label: "Can't ship to this address" },
  { value: 'other', label: 'Other' },
] as const;
export type SellerCancelReason = (typeof SELLER_CANCEL_REASONS)[number]['value'];

export const BUYER_CANCEL_REASON: Record<string, string> = {
  changed_mind: 'Changed their mind.',
  ordered_by_mistake: 'Ordered by mistake.',
  found_better_price: 'Found a better price.',
  delivery_too_slow: 'Delivery is too slow.',
  other: 'Other reason.',
};

export const EDIT_REASONS = ['Typo in the number', 'Carrier relabelled the package', 'Wrong carrier selected', 'Other'];

/* ------------------------------------------------------------------ tracking numbers */

export const normTracking = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();

const TRACKING_COPY: Record<string, string> = {
  ups: 'UPS tracking numbers start with 1Z and have 18 characters.',
  usps: 'USPS tracking numbers have 22 or 26 digits starting with 91–95, or 2 letters, 9 digits and US.',
  fedex: 'FedEx tracking numbers have 12, 15 or 20 digits.',
};

export interface TrackingCarrier {
  code: string;
  name: string;
  services: Array<{ trackingPattern?: string | null }>;
}

/** '' when the number fits the carrier's format (its services' patterns), else the error copy. */
export function trackingProblem(carrier: TrackingCarrier | undefined, raw: string): string {
  const t = normTracking(raw);
  if (!t) return carrier?.code === 'other' ? '' : 'Enter the tracking number from your carrier label.';
  const patterns = (carrier?.services ?? []).map((s) => s.trackingPattern).filter((p): p is string => !!p);
  if (!carrier || !patterns.length) return /^[0-9A-Z]{6,}$/.test(t) ? '' : 'Enter at least 6 letters or digits.';
  return patterns.some((p) => new RegExp(p).test(t)) ? '' : (TRACKING_COPY[carrier.code] ?? `This doesn't look like a ${carrier.name} tracking number.`);
}

/* ------------------------------------------------------------------ files */

/** Opens a signed download link (packing slips, labels, exports: the API serves them as attachments). */
export function openDownload(url: string, fileName?: string | null) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  if (fileName) a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls an export job until its file is ready (exports run as background jobs; up to ~3 minutes). */
export async function waitForExport(read: () => Promise<ExportJob>, first: ExportJob): Promise<ExportJob> {
  let job = first;
  for (let i = 0; i < 60 && (job.state === 'queued' || job.state === 'running'); i++) {
    await sleep(3000);
    job = await read();
  }
  return job;
}

/* ------------------------------------------------------------------ SellerOrderDetail screen query */

export interface GqlMoney {
  amount: number;
  currency: string;
  formatted?: string | null;
}
interface GqlDeadline {
  dueAt: string;
  state: string;
}
interface Who {
  kind: string;
  name?: string | null;
}

export interface OrderItemG {
  id: string;
  title: string;
  variantLabel?: string | null;
  image?: { url: string; alt?: string | null } | null;
  quantity: number;
  shippedQuantity: number;
  cancelledQuantity: number;
  /** Units on a bought label the carrier doesn't have yet: neither shippable nor cancellable until handed over or voided. */
  onLabelQuantity?: number | null;
  unitPrice: GqlMoney;
  lineSubtotal: GqlMoney;
  state: string;
  stateLabel: string;
  offerTerms?: { conditionLabel?: string | null; sellerSku?: string | null } | null;
}

export interface ShipmentG {
  id: string;
  packageLabel: string;
  carrierName?: string | null;
  serviceName?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  trackingState?: string | null;
  status: string;
  statusLabel: string;
  steps?: string[] | null;
  currentStep?: number | null;
  shippedAt?: string | null;
  estimateLabel?: string | null;
  dispatchedOnTime?: boolean | null;
  contents: Array<{ orderItemId: string; title: string; variantLabel?: string | null; quantity: number }>;
  corrections: Array<{ at: string; from: string; to: string; reason: string; customerNotified: boolean; by?: Who | null }>;
  /** The bought label, with its signed file link. */
  label?: { id: string; labelUrl?: string | null } | null;
  recordedBy?: Who | null;
}

export interface GroupG {
  id: string;
  packageLabel: string;
  shipsFrom?: string | null;
  status: string;
  statusLabel: string;
  nextAction?: string | null;
  allowedActions: string[];
  deadlineLabel?: string | null;
  dispatchResult?: string | null;
  dispatchDeadline?: GqlDeadline | null;
  itemsSummary?: string | null;
  units: number;
  delivery?: { methodName?: string | null; carrier?: string | null; service?: string | null; arrivalFrom?: string | null; arrivalTo?: string | null; dispatchBy?: string | null } | null;
  shipTo?: Partial<Address> | null;
  giftNote?: string | null;
  hidePricesOnSlip?: boolean | null;
  items: OrderItemG[];
  money?: {
    itemSubtotal: GqlMoney;
    sellerDiscounts?: GqlMoney | null;
    shippingCharged?: GqlMoney | null;
    shippingLabel?: string | null;
    platformFeeEstimate?: GqlMoney | null;
    earningsEstimate?: GqlMoney | null;
    earningsNote?: string | null;
  } | null;
  cancellations: Array<{ id: string; initiatedBy: string; reason?: string | null; status: string; respondBy?: GqlDeadline | null; items: Array<{ itemId: string; title: string; variantLabel?: string | null; quantity: number }> }>;
  shipments: ShipmentG[];
  deliveryExceptions: Array<{ id: string; kind: string; situation: string; requiredResponse: string; nextStep: string; deadlineLabel: string; status: string; deadline?: GqlDeadline | null }>;
  timeline: Array<{ at: string; label: string; detail?: string | null; actor?: Who | null }>;
}

export interface MessageG {
  id: string;
  kind: string;
  authorLabel: string;
  fromMe: boolean;
  body: string;
  hidden: boolean;
  at: string;
}

export interface ConversationG {
  id: string;
  counterparty?: { name: string } | null;
  privacyNote?: string | null;
  rulesNote?: string | null;
  replyState?: string | null;
  replyLabel?: string | null;
  dispatchWarning?: string | null;
  canSend: boolean;
  replyDue?: GqlDeadline | null;
  messages: { nextCursor?: string | null; items: MessageG[] };
}

export interface SetupCarrierG {
  code: string;
  name: string;
  trackingConnected?: boolean | null;
  services: Array<{ id: string; code: string; name: string; transitMinDays?: number | null; transitMaxDays?: number | null; labelSupported: boolean; trackingPattern?: string | null }>;
}

export interface SellerOrderDetailResult {
  sellerOrder: {
    id: string;
    ref: string;
    placedAt: string;
    acceptedAt?: string | null;
    paymentAccepted: boolean;
    buyerName: string;
    mixedOrderNote?: string | null;
    groups: GroupG[];
    conversations: ConversationG[];
  } | null;
  myShippingSetup: {
    labelPurchaseAvailable: boolean;
    labelUnavailableReason?: string | null;
    dispatchLabel?: string | null;
    defaultPackage?: { weightGrams: number; lengthCm?: number | null; widthCm?: number | null; heightCm?: number | null; label?: string | null } | null;
    carriers: SetupCarrierG[];
  } | null;
}

/** GraphQL enums arrive upper-case (PREPARING); REST sends lower-case. */
export const lc = (s?: string | null) => (s ?? '').toLowerCase();

/** Units not shipped and not cancelled (including units on a bought label not handed over yet). */
export const openQty = (i: OrderItemG) => (lc(i.state) === 'cancelled' ? 0 : Math.max(0, i.quantity - i.shippedQuantity - i.cancelledQuantity));
/** Units that can still go in a package or be cancelled: open units not on a bought label. */
export const toShipQty = (i: OrderItemG) => Math.max(0, openQty(i) - (i.onLabelQuantity ?? 0));
