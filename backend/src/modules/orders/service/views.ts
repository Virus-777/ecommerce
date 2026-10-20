/**
 * Builds the API shapes from the stored order (frozen snapshots, item states, projections). Documents and
 * order pages read only these copies. One place per type; every area picks what it may show.
 */
import { durationText } from '../../../kernel/lib/dates.js';
import { allocate, money } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type {
  AdminItemAfterSales,
  AdminOrderDetail,
  AdminOrderRow,
  CancellationRequest,
  CaseRef,
  DeliveryPromise,
  DiscountAllocation,
  GroupAlert,
  GroupMoney,
  InternalNote,
  ItemAfterSales,
  OfferTermsSnapshot,
  OrderDetail,
  OrderDocument,
  OrderFlag,
  OrderItem,
  OrderProgress,
  OrderSummary,
  OrderTotals,
  SellerGroup,
  SellerLabel,
  SellerOrderDetail,
  SellerOrderItem,
  SellerOrderRow,
  ShipmentRef,
} from '../../../spec/orders.js';
import {
  CANCELLABLE,
  CONDITION_LABEL,
  DAY,
  DELIVERED_LIKE,
  DISPLAY_LABEL,
  GROUP_LABEL,
  ITEM_STATE_LABEL,
  OPEN_GROUP,
  SELLER_STATUS_LABEL,
  SHIPMENT_STATUS_LABEL,
  SHIPPED_OR_LATER,
  UNSHIPPED,
  buyerName,
  dayLabel,
  deadline,
  deadlineLabel,
  discountSum,
  dispatchResult,
  displayStatus,
  fmt,
  is,
  isMarketlyService,
  maskEmail,
  maskPhone,
  monthDay,
  plural,
  shortDate,
  variantLabelOf,
  WAREHOUSE_STAGE_ENTRY,
  WAREHOUSE_STAGE_LABEL,
  type DisplayFlag,
  type GroupStatus,
  type ItemState,
  type Lifecycle,
  type SellerRowStatus,
} from '../domain/rules.js';
import type { CancellationRec, GroupRec, ItemRec, NoteRec, ShipmentRec, TimelineRec } from '../ports.js';
import type { Agg, Cfg, Core } from './core.js';

const OFFICIAL_NAME = OFFICIAL_STORE_NAME;
const ADDRESS_NOTE = "To change where a package goes, contact the seller before it ships. Address book changes don't affect this order.";
const TIMING_NOTE = 'Refunds are sent within 1 business day of confirmation; banks usually show them 3–5 business days after they are sent.';
const STATUS_NOTE = 'Requested means no money has moved yet.';
const EARNINGS_NOTE = 'Earnings stay pending until delivery and the hold period end.';
const CONDITIONS = ['new', 'used_like_new', 'used_good', 'used_acceptable', 'refurbished'] as const;
const ITEM_REFUND = ['none', 'requested', 'under_review', 'approved', 'processing', 'sent', 'failed'] as const;
const CANCEL_REFUND = ['none', 'requested', 'processing', 'sent', 'failed'] as const;

export type Viewer = 'store' | 'internal' | 'seller' | 'admin';

/** Fee and earnings estimate per group (finance, when on) */
export type Fees = Map<string, { fee: common.Money; earnings: common.Money } | null>;

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const isoReq = (d: Date) => new Date(d).toISOString();
const ymd = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : s);

export class Views {
  constructor(private readonly core: Core) {}

  private get tz() {
    return this.core.tz;
  }

  m = (amount: number, agg: Agg) => money(amount, agg.order.currency);

  sellerLabel(g: GroupRec): SellerLabel {
    const s = g.delivery?.seller;
    if (g.owner_type === 'official') return { ownerType: 'official', id: null, name: s?.name ?? g.seller_name ?? OFFICIAL_NAME, slug: s?.slug ?? 'official-store', verified: true, logo: s?.logo ?? null };
    return { ownerType: 'seller', id: g.seller_id, name: g.seller_name, slug: s?.slug ?? '', verified: s?.verified ?? false, logo: s?.logo ?? null };
  }

  promise(g: GroupRec): DeliveryPromise {
    const d = g.delivery;
    return {
      methodName: d.methodName,
      carrier: d.carrier ?? null,
      service: d.service ?? null,
      price: d.price,
      free: d.free,
      fundedBy: d.fundedBy,
      platformFunded: d.platformFunded ?? null,
      arrival: { from: ymd(d.arrival?.from) ?? this.core.today(), to: ymd(d.arrival?.to) ?? this.core.today() },
      dispatchBy: d.dispatchBy ? new Date(d.dispatchBy).toISOString() : isoReq(g.dispatch_by),
    };
  }

  /* ---------------------------------------------------------------- items */

  offerTerms(i: ItemRec, withSku: boolean): OfferTermsSnapshot {
    const o = i.offer_snapshot;
    const condition = (CONDITIONS as readonly string[]).includes(o.condition) ? (o.condition as OfferTermsSnapshot['condition']) : 'new';
    return {
      offerId: o.offerId ?? i.offer_id,
      termsVersion: o.termsVersion ?? 1,
      condition,
      conditionLabel: o.conditionLabel ?? CONDITION_LABEL[condition] ?? 'New',
      conditionNotes: o.conditionNotes ?? null,
      missingItems: o.missingItems ?? [],
      sellerSku: withSku ? (o.sellerSku ?? null) : null,
      compareAtPrice: o.compareAt ?? null,
      dispatchLabel: o.dispatch?.label ?? '',
      warranty: o.warranty?.summary ?? null,
    };
  }

  image(i: ItemRec): common.MediaRef | null {
    const url = i.product_snapshot.imageUrl;
    return url ? { id: i.variant_id, url, alt: i.product_snapshot.title } : null;
  }

  title = (i: ItemRec) => i.product_snapshot.title;
  variantLabel = (i: ItemRec) => variantLabelOf(i.product_snapshot.options);

  afterSales(agg: Agg, i: ItemRec): ItemAfterSales {
    const cancellation = [...agg.cancellations].reverse().find((c) => c.items.some((l) => l.itemId === i.id) && c.status !== 'withdrawn');
    const caseRef = (agg.facts.cases ?? []).find((c) => c.itemIds.includes(i.id))?.ref ?? null;
    const status = (ITEM_REFUND as readonly string[]).includes(i.refund_status) ? (i.refund_status as ItemAfterSales['refundStatus']) : 'none';
    return { cancellationId: cancellation?.id ?? null, returnId: i.return_id, returnRef: i.return_ref, refundStatus: status, refundedAmount: this.m(i.refunded_amount, agg), caseRef };
  }

  stateNote(agg: Agg, i: ItemRec, g: GroupRec): string | null {
    const seller = this.shipper(g);
    switch (i.state as ItemState) {
      case 'pending_payment':
        return 'Your payment is still being checked. Nothing ships until it is accepted.';
      case 'confirmed':
      case 'preparing':
      case 'delayed':
        return `Not shipped yet. You can cancel it until ${seller} ships it.`;
      case 'cancellation_requested': {
        const c = agg.cancellations.find((x) => x.status === 'requested' && x.items.some((l) => l.itemId === i.id));
        if (c?.respond_by && isMarketlyService(g)) return `Cancellation requested. Marketly will confirm by ${shortDate(c.respond_by, this.tz)}.`;
        return c?.respond_by ? `Cancellation requested. ${seller} has until ${shortDate(c.respond_by, this.tz)} to confirm.` : 'Cancellation requested.';
      }
      case 'shipped':
        return 'Shipped. You can return it after it arrives.';
      case 'delivered':
        return i.return_window_ends_at && i.return_window_ends_at.getTime() > this.core.now().getTime() ? `Returnable until ${shortDate(i.return_window_ends_at, this.tz)}.` : null;
      case 'cancelled':
        return i.refund_status === 'sent' ? 'Cancelled. Refund sent.' : 'Cancelled. Refund requested; no money has moved yet.';
      case 'return_requested':
        return i.return_ref ? `Return ${i.return_ref} in progress.` : 'Return in progress.';
      default:
        return null;
    }
  }

  itemActions(agg: Agg, i: ItemRec, g: GroupRec): OrderItem['actions'] {
    const out: OrderItem['actions'] = [];
    const s = i.state as ItemState;
    const now = this.core.now().getTime();
    if (agg.order.lifecycle === 'open' && is(CANCELLABLE, s)) out.push('cancel');
    if (s === 'shipped' && i.shipment_id) out.push('track');
    if (s === 'delivered' && i.return_window_ends_at && i.return_window_ends_at.getTime() > now && i.paid_amount > 0) out.push('return');
    if (i.return_id) out.push('view_return');
    if (is(DELIVERED_LIKE, s)) out.push('review');
    if (is(SHIPPED_OR_LATER, s)) out.push('report_problem');
    if (g.owner_type === 'seller') out.push('contact_seller');
    if (s !== 'pending_payment') out.push('buy_again');
    return out;
  }

  item(agg: Agg, i: ItemRec, viewer: Viewer): OrderItem {
    const g = agg.groups.find((x) => x.id === i.group_id)!;
    const p = i.product_snapshot;
    return {
      id: i.id,
      groupId: i.group_id,
      product: {
        productId: p.productId,
        variantId: p.variantId,
        productVersion: p.productVersion,
        title: p.title,
        brandName: p.brandName ?? null,
        options: p.options ?? {},
        modelNumber: p.modelNumber ?? null,
        imageUrl: p.imageUrl ?? null,
        takenAt: new Date(p.takenAt).toISOString(),
      },
      offer: this.offerTerms(i, viewer !== 'store'),
      returnTerms: i.return_terms,
      stockItemId: i.stock_item_id,
      categoryId: i.category_id ?? p.categoryId ?? null,
      title: this.title(i),
      variantLabel: this.variantLabel(i),
      image: this.image(i),
      quantity: i.quantity,
      unitPrice: this.m(i.unit_price, agg),
      lineSubtotal: this.m(i.unit_price * i.quantity, agg),
      discounts: i.discounts,
      shippingShare: this.m(i.shipping_share, agg),
      taxShare: this.m(i.tax_share, agg),
      paidAmount: this.m(i.paid_amount, agg),
      state: i.state as OrderItem['state'],
      stateLabel: ITEM_STATE_LABEL[i.state as ItemState] ?? i.state,
      stateNote: viewer === 'seller' ? null : this.stateNote(agg, i, g),
      shipmentId: i.shipment_id,
      deliveredAt: iso(i.delivered_at),
      returnWindowEndsAt: iso(i.return_window_ends_at),
      onLabelQuantity: this.onLabelQuantity(agg, i),
      splitFromItemId: i.split_from_item_id,
      replacementOfItemId: i.replacement_of_item_id,
      checkoutLineId: i.replacement_of_item_id ? null : i.checkout_line_id,
      afterSales: this.afterSales(agg, i),
      actions: viewer === 'store' ? this.itemActions(agg, i, g) : [],
    };
  }

  /* ---------------------------------------------------------------- groups */

  shipment(s: ShipmentRec): ShipmentRef {
    return {
      shipmentId: s.shipment_id,
      packageLabel: s.package_label,
      carrier: s.carrier,
      service: s.service,
      trackingNumber: s.tracking_number,
      trackingUrl: s.tracking_url && /^https?:\/\//.test(s.tracking_url) ? s.tracking_url : null,
      status: s.status as ShipmentRef['status'],
      statusLabel: s.status === 'shipped' && s.tracking_number ? 'Shipped' : (SHIPMENT_STATUS_LABEL[s.status] ?? s.status),
      estimatedArrival: s.estimated_arrival ? { from: ymd(s.estimated_arrival.from)!, to: ymd(s.estimated_arrival.to)! } : null,
      shippedAt: iso(s.shipped_at),
      deliveredAt: iso(s.delivered_at),
      itemIds: s.item_ids,
    };
  }

  groupOpen = (agg: Agg, g: GroupRec) => agg.order.lifecycle === 'open' && is(OPEN_GROUP, g.status);

  dispatchDeadline(agg: Agg, g: GroupRec, cfg: Pick<Cfg, 'dueSoonMinutes'>) {
    return deadline(g.dispatch_by, this.core.now(), this.groupOpen(agg, g), cfg.dueSoonMinutes);
  }

  estimateLabel(agg: Agg, g: GroupRec): string {
    if (g.status === 'cancelled') return 'Cancelled';
    if ((g.status === 'delivered' || g.status === 'partly_cancelled') && g.delivered_at) return `Delivered ${shortDate(g.delivered_at, this.tz)}`;
    const est = agg.shipments.filter((s) => s.group_id === g.id && s.estimated_arrival).at(-1)?.estimated_arrival ?? g.delivery.arrival;
    if (!est) return 'Arrival date to be confirmed';
    const from = ymd(est.from)!;
    const to = ymd(est.to)!;
    return from === to ? `Arrives ${dayLabel(to)}` : `Arrives ${dayLabel(from)} – ${dayLabel(to)}`;
  }

  handlingNote(g: GroupRec) {
    if (g.owner_type === 'official') return 'Official Store item. Marketly handles returns.';
    if (isMarketlyService(g)) return 'Marketly ships this package and handles its returns';
    return `${g.seller_name} handles this package. Marketly support can step in.`;
  }

  /** 'Sold by Casa Verde Home', or 'Sold by Casa Verde Home · Shipped by Marketly' for Fulfilled by Marketly */
  soldBy(g: GroupRec) {
    const name = this.sellerLabel(g).name;
    return isMarketlyService(g) ? `Sold by ${name} · Shipped by Marketly` : `Sold by ${name}`;
  }

  /** Who ships the package, as the customer reads it */
  private shipper(g: GroupRec) {
    return isMarketlyService(g) ? 'Marketly' : this.sellerLabel(g).name;
  }

  latestEstimate(g: GroupRec) {
    return [...(g.dispatch_by_history ?? [])].reverse().find((h) => h.kind === 'seller_estimate' || h.kind === 'extension');
  }

  alert(agg: Agg, g: GroupRec): GroupAlert | null {
    const issue = (agg.facts.deliveryIssues ?? []).filter((d) => d.groupId === g.id).at(-1);
    const caseRef = (agg.facts.cases ?? []).find((c) => c.itemIds.some((id) => agg.items.some((i) => i.id === id && i.group_id === g.id)))?.ref ?? null;
    if (issue && !['delivered', 'cancelled', 'partly_cancelled'].includes(g.status)) {
      const msg: Record<string, string> = {
        failed_delivery: 'The carrier could not deliver this package. Choose a new delivery attempt or contact support.',
        lost_or_damaged: 'This package may be lost or damaged. We are checking with the carrier and will make it right.',
        missing_tracking: 'Tracking for this package is not working yet. We have asked the seller for a valid tracking number.',
        late_dispatch: 'This package is late. We are following up with the seller.',
        seller_cannot_fulfill: 'The seller cannot fulfill this package. We will cancel and refund it if it cannot ship.',
      };
      return { tone: 'danger', title: 'Delivery problem', message: issue.customerAction ?? msg[issue.kind] ?? 'There is a problem with this package. Contact support if you need help.', caseRef };
    }
    if (!this.groupOpen(agg, g)) return caseRef ? { tone: 'info', title: 'Support case open', message: 'We are looking into this package.', caseRef } : null;
    const est = this.latestEstimate(g);
    if (g.status === 'delayed') {
      return {
        tone: 'warning',
        title: 'Package delayed',
        message: est ? `New dispatch date: ${shortDate(est.to, this.tz)}. You can wait, cancel the items that have not shipped, or contact support.` : 'This package is late. You can wait, cancel the items that have not shipped, or contact support.',
        caseRef,
      };
    }
    if (this.core.now().getTime() > g.dispatch_by.getTime()) {
      return { tone: 'warning', title: 'Running late', message: `This package has not shipped by its dispatch date. We are following up with ${isMarketlyService(g) ? 'our warehouse' : 'the seller'}.`, caseRef };
    }
    return caseRef ? { tone: 'info', title: 'Support case open', message: 'We are looking into this package.', caseRef } : null;
  }

  group(agg: Agg, g: GroupRec, viewer: Viewer, cfg: Pick<Cfg, 'dueSoonMinutes'>): SellerGroup {
    const items = agg.items.filter((i) => i.group_id === g.id);
    return {
      id: g.id,
      packageLabel: `Package ${g.position} of ${agg.groups.length}`,
      seller: this.sellerLabel(g),
      shipsFrom: g.ships_from,
      fulfilledBy: g.fulfilled_by as SellerGroup['fulfilledBy'],
      delivery: this.promise(g),
      dispatchDeadline: this.dispatchDeadline(agg, g, cfg),
      status: g.status as SellerGroup['status'],
      statusLabel: GROUP_LABEL[g.status as GroupStatus] ?? g.status,
      estimateLabel: this.estimateLabel(agg, g),
      items: items.map((i) => this.item(agg, i, viewer)),
      shipments: agg.shipments.filter((s) => s.group_id === g.id).map((s) => this.shipment(s)),
      totals: { items: this.m(g.items_total, agg), discounts: this.m(g.discount_total, agg), shipping: this.m(g.shipping_total, agg), tax: this.m(g.tax_total, agg), total: this.m(g.total, agg) },
      returnTermsSummary: g.return_terms_summary,
      handlingNote: this.handlingNote(g),
      alert: this.alert(agg, g),
    };
  }

  /* ---------------------------------------------------------------- order */

  displayFlags(agg: Agg): DisplayFlag[] {
    const flags: DisplayFlag[] = [];
    const kinds = new Set(this.core.flagKinds(agg, this.core.now(), 0));
    if (agg.cancellations.some((c) => c.status === 'requested')) flags.push('cancellation_requested');
    if (agg.items.some((i) => i.state === 'return_requested')) flags.push('return_open');
    if (kinds.has('delivery_issue')) flags.push('delivery_issue');
    if (kinds.has('case_open')) flags.push('case_open');
    if (agg.order.lifecycle === 'payment_pending') flags.push('payment_checking');
    return flags;
  }

  status(agg: Agg) {
    const value = displayStatus(agg.order.lifecycle as Lifecycle, agg.items);
    return { value, flags: this.displayFlags(agg) };
  }

  /** Purchase units (replacement lines are not purchases) */
  units = (agg: Agg) => agg.items.filter((i) => !i.replacement_of_item_id).reduce((s, i) => s + i.quantity, 0);

  /** Units per item state, counted like units() (replacement items left out) */
  itemStates(agg: Agg): Record<string, number> {
    const out: Record<string, number> = {};
    for (const i of agg.items) if (!i.replacement_of_item_id) out[i.state] = (out[i.state] ?? 0) + i.quantity;
    return out;
  }

  summaryLine(agg: Agg) {
    return `${plural(this.units(agg), 'item')} from ${plural(agg.groups.length, 'seller')} · ${fmt(agg.order.total, agg.order.currency)}`;
  }

  discounts(agg: Agg): DiscountAllocation[] {
    const byKey = new Map<string, DiscountAllocation>();
    for (const i of agg.items) {
      for (const d of i.discounts) {
        const key = `${d.code ?? ''}|${d.label}|${d.fundedBy}|${d.campaignId ?? ''}`;
        const cur = byKey.get(key);
        byKey.set(key, cur ? { ...cur, amount: money(cur.amount.amount + d.amount.amount, d.amount.currency) } : { ...d });
      }
    }
    return [...byKey.values()];
  }

  totals(agg: Agg): OrderTotals {
    const o = agg.order;
    const expected: OrderTotals['expectedRefunds'] = [];
    for (const c of agg.cancellations) {
      if (c.status === 'accepted' && ['requested', 'processing', 'failed'].includes(c.refund_status) && c.refund_preview.total.amount > 0) {
        expected.push({ label: 'Cancellation refund', ref: null, amount: c.refund_preview.total, status: c.refund_status });
      }
    }
    for (const a of agg.facts.refundApprovals ?? []) expected.push({ label: 'Return refund', ref: a.returnRef ?? null, amount: this.m(a.amount, agg), status: 'approved' });
    return {
      itemCount: this.units(agg),
      items: this.m(o.items_total, agg),
      discounts: this.discounts(agg),
      discountTotal: this.m(o.discount_total, agg),
      shippingTotal: this.m(o.shipping_total, agg),
      shippingLabel: `Shipping (${plural(agg.groups.length, 'package')})`,
      tax: this.m(o.tax_total, agg),
      taxLabel: o.delivery_address?.region ? `Sales tax (${o.delivery_address.region})` : 'Sales tax',
      total: this.m(o.total, agg),
      paidWith: o.payment_method_label,
      refundedSoFar: this.m(o.refunded_total, agg),
      expectedRefunds: expected,
    };
  }

  paymentState(agg: Agg): OrderProgress['payment']['state'] {
    const o = agg.order;
    if (o.payment_state === 'failed') return 'failed';
    if (o.lifecycle === 'payment_pending' || o.payment_state === 'pending_check') return 'pending';
    if (o.refunded_total > 0 && o.refunded_total >= o.total) return 'refunded';
    if (o.refunded_total > 0) return 'partly_refunded';
    return 'accepted';
  }

  progress(agg: Agg): OrderProgress {
    const o = agg.order;
    const pay = this.paymentState(agg);
    const captures = agg.facts.captures ?? [];
    const chargedAt = captures.at(-1)?.at ?? null;
    const refunds = o.refunded_total > 0 ? ` ${fmt(o.refunded_total, o.currency)} refunded so far.` : ' No refunds sent yet.';
    const payNote =
      pay === 'pending'
        ? "Your bank is still confirming the payment. You won't be charged twice."
        : pay === 'failed'
          ? 'The payment was declined. Nothing was charged.'
          : (o.captured_total > 0 && chargedAt ? `${o.payment_method_label} charged ${monthDay(chargedAt, this.tz)}.` : `${o.payment_method_label} authorized; you are charged as items ship.`) + refunds;
    const PAY_LABEL = { pending: 'Payment being checked', accepted: 'Payment accepted', failed: 'Payment failed', partly_refunded: 'Partly refunded', refunded: 'Refunded' } as const;

    const live = agg.groups.filter((g) => g.status !== 'cancelled');
    const delivered = live.filter((g) => g.status === 'delivered' || g.status === 'partly_cancelled').length;
    const shippedAny = live.filter((g) => !['new', 'preparing', 'delayed'].includes(g.status)).length;
    const shippedAll = live.filter((g) => ['shipped', 'partly_delivered', 'delivered', 'partly_cancelled'].includes(g.status)).length;
    const issue = this.core.flagKinds(agg, this.core.now(), 0).includes('delivery_issue');
    let state: OrderProgress['delivery']['state'];
    if (!live.length) state = 'cancelled';
    else if (issue) state = 'delivery_issue';
    else if (delivered === live.length) state = 'delivered';
    else if (delivered > 0 || live.some((g) => g.status === 'partly_delivered')) state = 'partly_delivered';
    else if (shippedAll === live.length) state = 'shipped';
    else if (shippedAny > 0) state = 'partly_shipped';
    else state = 'not_shipped';
    const DELIVERY_LABEL = {
      not_shipped: 'Not shipped yet',
      partly_shipped: 'Partly shipped',
      shipped: 'Shipped',
      partly_delivered: `${delivered} of ${live.length} packages delivered`,
      delivered: 'Delivered',
      delivery_issue: 'Delivery problem',
      cancelled: 'Cancelled',
    } as const;

    const openReturns = new Set(agg.items.filter((i) => i.state === 'return_requested' && i.return_id).map((i) => i.return_id!)).size;
    const doneReturns = agg.items.some((i) => i.return_id && ['returned', 'refunded'].includes(i.state));
    const inProgress = agg.items.some((i) => i.state === 'return_requested' && ['approved', 'processing', 'under_review'].includes(i.refund_status));
    const rState: OrderProgress['returns']['state'] = openReturns ? (inProgress ? 'in_progress' : 'requested') : doneReturns ? 'completed' : 'none';
    const R_LABEL = { none: 'No returns', requested: 'Return requested', in_progress: 'Return in progress', completed: 'Return completed' } as const;
    return {
      payment: { state: pay, label: PAY_LABEL[pay], amountCharged: this.m(o.captured_total, agg), chargedAt, methodLabel: o.payment_method_label, note: payNote },
      delivery: {
        state,
        label: DELIVERY_LABEL[state],
        packagesTotal: live.length,
        packagesDelivered: delivered,
        packageStates: agg.groups.map((g) => {
          const s = agg.shipments.filter((x) => x.group_id === g.id).at(-1);
          return s && !['delivered'].includes(g.status) && is(['shipped', 'partly_delivered'], g.status) ? (SHIPMENT_STATUS_LABEL[s.status] ?? GROUP_LABEL[g.status as GroupStatus]) : (GROUP_LABEL[g.status as GroupStatus] ?? g.status);
        }),
      },
      returns: { state: rState, label: R_LABEL[rState], openReturns, note: openReturns ? `${plural(openReturns, 'return')} open. Refunds follow the return inspection.` : null },
    };
  }

  documents(agg: Agg): OrderDocument[] {
    return agg.documents.map((d) => {
      const g = d.group_id ? agg.groups.find((x) => x.id === d.group_id) : undefined;
      const name = g ? this.sellerLabel(g).name : '';
      const label = d.kind === 'receipt' ? 'Order receipt' : d.kind === 'invoice' ? `Invoice, ${name}` : `Credit note, ${name}`;
      return { id: d.id, kind: d.kind as OrderDocument['kind'], label, groupId: d.group_id, number: d.number, format: 'pdf', issuedAt: isoReq(d.issued_at) };
    });
  }

  cases(agg: Agg): CaseRef[] {
    return (agg.facts.cases ?? []).map((c) => ({ caseId: c.caseId, ref: c.ref, status: c.status, itemIds: c.itemIds, nextUpdateBy: c.nextUpdateBy ?? null }));
  }

  timeline(rows: readonly TimelineRec[], viewer: Viewer): common.TimelineEvent[] {
    return rows.map((r) => ({
      at: isoReq(r.at),
      label: r.label,
      detail: viewer === 'admin' && r.reason ? [r.detail, `Reason: ${r.reason}`].filter(Boolean).join(' · ') : r.detail,
      actor: {
        kind: r.actor_kind as common.Actor['kind'],
        id: viewer === 'admin' ? r.actor_id : null,
        name: viewer === 'admin' || r.actor_kind === 'seller' || r.actor_kind === 'system' ? r.actor_name : r.actor_kind === 'staff' ? 'Marketly support' : r.actor_name,
      },
    }));
  }

  canCancelSomething = (agg: Agg) => agg.order.lifecycle === 'open' && agg.items.some((i) => is(CANCELLABLE, i.state));

  detail(agg: Agg, timeline: readonly TimelineRec[], viewer: Viewer, cfg: Pick<Cfg, 'dueSoonMinutes'>): OrderDetail {
    const o = agg.order;
    const status = this.status(agg);
    return {
      id: o.id,
      ref: o.ref,
      placedAt: isoReq(o.placed_at),
      acceptedAt: iso(o.accepted_at),
      channel: o.channel as OrderDetail['channel'],
      contact: { kind: o.customer_id ? 'customer' : 'guest', customerId: o.customer_id, name: o.contact_name, email: o.contact_email, phone: o.contact_phone },
      lifecycle: o.lifecycle,
      status,
      statusLabel: DISPLAY_LABEL[status.value],
      summaryLine: this.summaryLine(agg),
      progress: this.progress(agg),
      groups: agg.groups.map((g) => this.group(agg, g, viewer, cfg)),
      totals: this.totals(agg),
      deliveryAddress: o.delivery_address,
      addressNote: ADDRESS_NOTE,
      policyVersions: o.policy_versions ?? [],
      documents: this.documents(agg),
      cases: this.cases(agg),
      timeline: this.timeline(timeline, viewer),
      canCancelSomething: this.canCancelSomething(agg),
      paymentIntentId: o.payment_intent_id,
    };
  }

  /** slugs: product id → current slug (core.productSlugs); missing ones give a null productSlug */
  summary(agg: Agg, slugs: ReadonlyMap<string, string> = new Map()): OrderSummary {
    const status = this.status(agg);
    const delayed = agg.groups.filter((g) => g.status === 'delayed' || (this.groupOpen(agg, g) && this.core.now().getTime() > g.dispatch_by.getTime())).length;
    const actions: OrderSummary['actions'] = ['view'];
    if (agg.items.some((i) => i.state === 'shipped')) actions.push('track');
    if (agg.items.some((i) => i.state === 'delivered' && i.return_window_ends_at && i.return_window_ends_at.getTime() > this.core.now().getTime())) actions.push('return');
    if (this.canCancelSomething(agg)) actions.push('cancel');
    if (agg.items.some((i) => is(DELIVERED_LIKE, i.state))) actions.push('review');
    if (agg.order.lifecycle !== 'payment_pending') actions.push('buy_again');
    return {
      id: agg.order.id,
      ref: agg.order.ref,
      placedAt: isoReq(agg.order.placed_at),
      status,
      statusLabel: DISPLAY_LABEL[status.value],
      total: this.m(agg.order.total, agg),
      itemCount: this.units(agg),
      itemStates: this.itemStates(agg),
      sellerCount: new Set(agg.groups.map((g) => g.seller_id ?? 'official')).size,
      packageCount: agg.groups.length,
      packages: agg.groups.map((g) => ({ label: `Package ${g.position} of ${agg.groups.length}`, sellerName: this.sellerLabel(g).name, status: GROUP_LABEL[g.status as GroupStatus] ?? g.status, note: this.estimateLabel(agg, g) })),
      thumbnails: agg.items
        .map((i) => this.image(i))
        .filter((x): x is common.MediaRef => Boolean(x))
        .slice(0, 4),
      items: agg.items.map((i) => ({
        itemId: i.id,
        productId: i.product_id,
        productSlug: slugs.get(i.product_id) ?? null,
        variantId: i.variant_id,
        offerId: i.offer_id,
        title: this.title(i),
        variantLabel: this.variantLabel(i),
        image: this.image(i),
        quantity: i.quantity,
      })),
      note: delayed ? `${plural(delayed, 'package')} delayed` : status.flags.includes('cancellation_requested') ? 'Cancellation requested' : null,
      actions,
    };
  }

  /* ---------------------------------------------------------------- cancellations */

  cancellation(agg: Agg, c: CancellationRec): CancellationRequest {
    const g = agg.groups.find((x) => x.id === c.group_id)!;
    const timeline: common.TimelineEvent[] = [{ at: isoReq(c.created_at), label: c.initiated_by === 'customer' && c.respond_by ? 'Cancellation requested' : 'Items cancelled', detail: c.reason ?? null, actor: { kind: c.initiated_by === 'customer' ? 'customer' : c.initiated_by === 'seller' ? 'seller' : c.initiated_by === 'staff' ? 'staff' : 'system' } }];
    if (c.decided_at && c.status !== 'requested') {
      const label = { accepted: 'Cancellation accepted', declined: 'Cancellation declined', withdrawn: 'Request withdrawn', requested: '' }[c.status as 'accepted'] ?? c.status;
      if (!(c.status === 'accepted' && !c.respond_by && c.initiated_by !== 'customer')) timeline.push({ at: isoReq(c.decided_at), label, detail: c.decline_reason ?? null, actor: c.decided_by ? { kind: c.decided_by.kind, name: c.decided_by.kind === 'staff' ? 'Marketly support' : (c.decided_by.name ?? null) } : null });
    }
    if (c.refund_status === 'sent') timeline.push({ at: isoReq(c.decided_at ?? c.created_at), label: 'Refund sent', detail: `${fmt(c.refund_preview.total.amount, agg.order.currency)} to ${c.refund_preview.destination}` });
    return {
      id: c.id,
      orderId: c.order_id,
      orderRef: agg.order.ref,
      groupId: c.group_id,
      seller: this.sellerLabel(g),
      initiatedBy: c.initiated_by as CancellationRequest['initiatedBy'],
      reasonCode: c.reason_code,
      reason: c.reason,
      items: c.items.map((l) => {
        const item = agg.items.find((i) => i.id === l.itemId);
        return { itemId: l.itemId, title: l.title, variantLabel: l.variantLabel, quantity: l.quantity, shipped: item ? is(SHIPPED_OR_LATER, item.state) : l.shipped };
      }),
      status: c.status as CancellationRequest['status'],
      respondBy: c.respond_by ? deadline(c.respond_by, this.core.now(), c.status === 'requested', 120) : null,
      decidedBy: c.decided_by,
      decidedAt: iso(c.decided_at),
      declineReason: c.decline_reason,
      refundPreview: c.refund_preview,
      refundStatus: (CANCEL_REFUND as readonly string[]).includes(c.refund_status) ? (c.refund_status as CancellationRequest['refundStatus']) : 'none',
      paymentRefundId: c.payment_refund_id,
      createdAt: isoReq(c.created_at),
      timeline,
    };
  }

  /* ---------------------------------------------------------------- seller area */

  sellerStatus(agg: Agg, g: GroupRec): SellerRowStatus {
    if (agg.cancellations.some((c) => c.group_id === g.id && c.status === 'requested')) return 'cancellation_requested';
    const items = agg.items.filter((i) => i.group_id === g.id);
    switch (g.status as GroupStatus) {
      case 'cancelled':
        return 'cancelled';
      case 'delivered':
      case 'partly_cancelled':
        if (agg.order.lifecycle === 'completed') return 'completed';
        return items.some((i) => i.refunded_amount > 0) ? 'partly_refunded' : 'delivered';
      case 'shipped':
      case 'partly_delivered': {
        const states = agg.shipments.filter((s) => s.group_id === g.id).map((s) => s.status);
        if (states.length && states.every((s) => s === 'out_for_delivery' || s === 'delivered') && states.includes('out_for_delivery')) return 'out_for_delivery';
        if (states.includes('in_transit')) return 'in_transit';
        return 'shipped';
      }
      default:
        return g.status as SellerRowStatus;
    }
  }

  /**
   * The seller's status label: for Fulfilled by Marketly groups 'Fulfilled by Marketly · <warehouse stage>' while
   * the warehouse works on it (the latest stage from `stages`), then the shipping status.
   */
  sellerStatusLabel(agg: Agg, g: GroupRec, status: SellerRowStatus, stages?: ReadonlyMap<string, string>): string {
    if (!isMarketlyService(g)) return SELLER_STATUS_LABEL[status];
    let stage: string = SELLER_STATUS_LABEL[status];
    if (agg.order.lifecycle === 'payment_pending') stage = 'Payment being checked';
    else if (status === 'new' || status === 'preparing' || status === 'delayed') stage = stages?.get(g.id) ?? (status === 'new' ? WAREHOUSE_STAGE_LABEL.awaiting_pick! : SELLER_STATUS_LABEL[status]);
    return `Fulfilled by Marketly · ${stage}`;
  }

  nextAction(agg: Agg, g: GroupRec): SellerOrderRow['nextAction'] {
    if (isMarketlyService(g)) return 'marketly_fulfils';
    const s = this.sellerStatus(agg, g);
    if (s === 'cancellation_requested') return 'respond_cancellation';
    if (agg.order.lifecycle === 'payment_pending') return 'view';
    if (s === 'new') return 'prepare';
    if (s === 'preparing' || s === 'delayed') return 'record_shipment';
    if (s === 'partly_shipped') return 'ship_remaining';
    if (s === 'shipped' || s === 'in_transit' || s === 'out_for_delivery') return 'view_tracking';
    return 'view';
  }

  itemsSummary(items: readonly ItemRec[]): string {
    const live = items.filter((i) => i.state !== 'cancelled');
    const list = live.length ? live : items;
    const first = list[0];
    if (!first) return '';
    const label = [this.title(first), this.variantLabel(first)].filter(Boolean).join(', ');
    return `${label} × ${first.quantity}${list.length > 1 ? ` + ${plural(list.length - 1, 'more item')}` : ''}`;
  }

  sellerNote(items: readonly ItemRec[]): string | null {
    const live = items.filter((i) => i.state !== 'cancelled');
    const shipped = live.filter((i) => is(SHIPPED_OR_LATER, i.state)).reduce((s, i) => s + i.quantity, 0);
    const total = live.reduce((s, i) => s + i.quantity, 0);
    if (shipped && shipped < total) return `${shipped} of ${plural(total, 'item')} shipped`;
    const cancelled = items.filter((i) => i.state === 'cancelled').reduce((s, i) => s + i.quantity, 0);
    return cancelled && live.length ? `${plural(cancelled, 'item')} cancelled` : null;
  }

  /** `stages`: the latest Marketly warehouse stage per Fulfilled by Marketly group (Core.warehouseStages) */
  sellerRow(agg: Agg, g: GroupRec, cfg: Pick<Cfg, 'dueSoonMinutes'>, stages?: ReadonlyMap<string, string>): SellerOrderRow {
    const items = agg.items.filter((i) => i.group_id === g.id);
    const status = this.sellerStatus(agg, g);
    return {
      id: g.id,
      fulfilledBy: g.fulfilled_by as SellerOrderRow['fulfilledBy'],
      orderId: agg.order.id,
      ref: agg.order.ref,
      placedAt: isoReq(agg.order.placed_at),
      buyerName: buyerName(agg.order.contact_name),
      itemsSummary: this.itemsSummary(items),
      units: items.filter((i) => i.state !== 'cancelled').reduce((s, i) => s + i.quantity, 0),
      total: this.m(g.total, agg),
      status,
      statusLabel: this.sellerStatusLabel(agg, g, status, stages),
      dispatchDeadline: this.dispatchDeadline(agg, g, cfg),
      deadlineLabel: deadlineLabel(g.dispatch_by, this.core.now(), g.shipped_at, this.groupOpen(agg, g), this.tz),
      nextAction: this.nextAction(agg, g),
      note: this.sellerNote(items),
    };
  }

  sellerItem(agg: Agg, i: ItemRec): SellerOrderItem {
    const shipped = is(SHIPPED_OR_LATER, i.state);
    return {
      itemId: i.id,
      title: this.title(i),
      variantLabel: this.variantLabel(i),
      condition: this.offerTerms(i, true).conditionLabel,
      sellerSku: i.offer_snapshot.sellerSku ?? null,
      image: this.image(i),
      quantity: i.quantity,
      unitPrice: this.m(i.unit_price, agg),
      lineTotal: this.m(i.unit_price * i.quantity, agg),
      state: i.state,
      shippedQuantity: shipped ? i.quantity : 0,
      cancelledQuantity: i.state === 'cancelled' ? i.quantity : 0,
      onLabelQuantity: this.onLabelQuantity(agg, i),
    };
  }

  /** Seller-funded part of a group's discounts (shared funding counts half) */
  funding(items: readonly ItemRec[], currency: string) {
    let platform = 0;
    let seller = 0;
    for (const i of items) {
      for (const d of i.discounts) {
        if (d.fundedBy === 'platform') platform += d.amount.amount;
        else if (d.fundedBy === 'seller') seller += d.amount.amount;
        else {
          const [a, b] = allocate(money(d.amount.amount, currency), [1, 1]);
          platform += a!.amount;
          seller += b!.amount;
        }
      }
    }
    return { platform, seller };
  }

  /** City and region only (decision D10: the seller of a Fulfilled by Marketly group does not ship it) */
  cityAndRegion(a: common.Address): common.Address {
    return { name: buyerName(a.name), line1: 'Marketly ships this package', line2: null, city: a.city, region: a.region, postalCode: '', country: a.country, phone: null };
  }

  /** Full ship-to only while the task is open plus the return window (sellerAddressVisibleDays after delivery) */
  shipTo(agg: Agg, g: GroupRec, cfg: Pick<Cfg, 'sellerAddressVisibleDays'>): common.Address {
    const a = agg.order.delivery_address;
    if (isMarketlyService(g)) return this.cityAndRegion(a);
    const until = g.delivered_at ? g.delivered_at.getTime() + cfg.sellerAddressVisibleDays * DAY : null;
    const visible = g.status !== 'cancelled' && (until === null || this.core.now().getTime() <= until);
    if (visible) return a;
    return { name: buyerName(a.name), line1: 'Address hidden after the return window', line2: null, city: a.city, region: a.region, postalCode: a.postalCode, country: a.country, phone: null };
  }

  /** The item is on a bought label the carrier has not scanned yet (shipment still label_created) */
  onUnusedLabel(agg: Agg, itemId: string): boolean {
    return agg.shipments.some((s) => s.status === 'label_created' && s.item_ids.includes(itemId));
  }

  /**
   * Units of the item on bought labels the carrier does not have yet (G41a): the label's own quantities
   * (shipment_refs.lines), or the whole item for shipments projected before those were kept. Shipped and
   * cancelled items have none.
   */
  onLabelQuantity(agg: Agg, i: ItemRec): number {
    if (i.state === 'cancelled' || is(SHIPPED_OR_LATER, i.state)) return 0;
    let units = 0;
    for (const s of agg.shipments) {
      if (s.status !== 'label_created' || !s.item_ids.includes(i.id)) continue;
      const lines = Array.isArray(s.lines) ? (s.lines as { orderItemId: string; quantity: number }[]) : null;
      units += lines ? lines.filter((l) => l.orderItemId === i.id).reduce((n, l) => n + l.quantity, 0) : i.quantity;
    }
    return Math.min(units, i.quantity);
  }

  /**
   * Open shipping delivery exceptions of the order (G73: the Admin Center reminds the seller with them): shipping's
   * answer (core.openExceptionIds) when given, else orders' own exception facts (resolved ones left out)
   */
  openExceptionIds(agg: Agg, fromShipping?: Record<string, string[]>): string[] {
    return fromShipping?.[agg.order.id] ?? (agg.facts.deliveryIssues ?? []).map((d) => d.exceptionId);
  }

  sellerActions(agg: Agg, g: GroupRec): SellerOrderDetail['allowedActions'] {
    if (isMarketlyService(g)) return []; // Marketly picks, packs and ships; the seller only views (decision D6)
    const items = agg.items.filter((i) => i.group_id === g.id);
    const paid = agg.order.lifecycle === 'open';
    const out: SellerOrderDetail['allowedActions'] = [];
    if (paid && items.some((i) => i.state === 'confirmed' || i.state === 'delayed')) out.push('start_preparing');
    if (paid && items.some((i) => is(CANCELLABLE, i.state))) out.push('report_delay', 'record_shipment');
    // items on a bought label the carrier does not have yet are cancelled only after the label is voided
    if (paid && items.some((i) => is(CANCELLABLE, i.state) && !this.onUnusedLabel(agg, i.id))) out.push('cancel_items');
    if (agg.cancellations.some((c) => c.group_id === g.id && c.status === 'requested')) out.push('respond_cancellation');
    if (paid && items.some((i) => is(UNSHIPPED, i.state))) out.push('print_packing_slip');
    return out;
  }

  sellerDetail(agg: Agg, g: GroupRec, timeline: readonly TimelineRec[], cfg: Pick<Cfg, 'dueSoonMinutes' | 'sellerAddressVisibleDays'>, fees?: Fees): SellerOrderDetail {
    const items = agg.items.filter((i) => i.group_id === g.id);
    const status = this.sellerStatus(agg, g);
    const open = this.groupOpen(agg, g);
    const fee = fees?.get(g.id) ?? null;
    const d = this.promise(g);
    const stages = new Map<string, string>();
    for (const t of timeline) if (t.group_id === g.id && t.visibility === 'seller' && t.label === WAREHOUSE_STAGE_ENTRY && t.detail) stages.set(g.id, t.detail);
    return {
      id: g.id,
      orderId: agg.order.id,
      ref: agg.order.ref,
      placedAt: isoReq(agg.order.placed_at),
      buyerName: buyerName(agg.order.contact_name),
      paymentAccepted: agg.order.lifecycle !== 'payment_pending' && agg.order.payment_state !== 'failed',
      status,
      statusLabel: this.sellerStatusLabel(agg, g, status, stages),
      fulfilledBy: g.fulfilled_by as SellerOrderDetail['fulfilledBy'],
      dispatchDeadline: this.dispatchDeadline(agg, g, cfg),
      timeLeftMinutes: open ? Math.round((g.dispatch_by.getTime() - this.core.now().getTime()) / 60_000) : null,
      dispatchResult: dispatchResult(g.dispatch_by, g.shipped_at),
      items: items.map((i) => this.sellerItem(agg, i)),
      mixedOrderNote: agg.groups.length > 1 ? "The customer's order also has items from other sellers. You only see and handle your own items." : null,
      money: {
        itemSubtotal: this.m(g.items_total, agg),
        sellerDiscounts: this.m(this.funding(items, agg.order.currency).seller, agg),
        shippingCharged: this.m(g.shipping_total, agg),
        shippingLabel: `Shipping charged (${d.methodName}${d.free ? ', free to the buyer' : ''})`,
        platformFeeEstimate: fee?.fee ?? null,
        earningsEstimate: fee?.earnings ?? null,
        earningsNote: EARNINGS_NOTE,
      },
      shipTo: this.shipTo(agg, g, cfg),
      delivery: d,
      giftNote: agg.order.gift_note,
      hidePricesOnSlip: agg.order.hide_prices,
      shipments: agg.shipments.filter((s) => s.group_id === g.id).map((s) => this.shipment(s)),
      cancellationRequests: agg.cancellations.filter((c) => c.group_id === g.id).map((c) => this.cancellation(agg, c)),
      timeline: this.timeline(
        timeline.filter((t) => t.group_id === g.id && t.visibility === 'seller'),
        'seller',
      ),
      allowedActions: this.sellerActions(agg, g),
    };
  }

  /** The order as one seller sees it: own groups only and seller-safe fields */
  sellerOrder(agg: Agg, sellerId: string, timeline: readonly TimelineRec[], cfg: Pick<Cfg, 'dueSoonMinutes' | 'sellerAddressVisibleDays'>, fees?: Fees): { order: OrderDetail; groups: SellerOrderDetail[] } | null {
    const own = agg.groups.filter((g) => g.seller_id === sellerId);
    if (!own.length) return null;
    const ownIds = new Set(own.map((g) => g.id));
    const scoped: Agg = {
      order: { ...agg.order, flag_kinds: [] },
      factRows: [],
      facts: {},
      groups: own,
      items: agg.items.filter((i) => ownIds.has(i.group_id)),
      cancellations: agg.cancellations.filter((c) => ownIds.has(c.group_id)),
      shipments: agg.shipments.filter((s) => ownIds.has(s.group_id)),
      documents: [],
    };
    const totals = own.reduce((t, g) => ({ items: t.items + g.items_total, discounts: t.discounts + g.discount_total, shipping: t.shipping + g.shipping_total, tax: t.tax + g.tax_total, total: t.total + g.total }), { items: 0, discounts: 0, shipping: 0, tax: 0, total: 0 });
    scoped.order = { ...scoped.order, items_total: totals.items, discount_total: totals.discounts, shipping_total: totals.shipping, tax_total: totals.tax, total: totals.total, captured_total: 0, refunded_total: 0, contact_email: '', contact_phone: null, customer_id: null, contact_name: buyerName(agg.order.contact_name), coupon_codes: [] };
    const detail = this.detail(scoped, timeline.filter((t) => t.group_id && ownIds.has(t.group_id) && t.visibility === 'seller'), 'seller', cfg);
    detail.contact = { kind: agg.order.customer_id ? 'customer' : 'guest', customerId: null, name: buyerName(agg.order.contact_name), email: 'hidden@marketly.invalid', phone: null };
    // decision D10: a seller whose groups Marketly all ships sees the city and region only
    if (own.every(isMarketlyService)) detail.deliveryAddress = this.cityAndRegion(agg.order.delivery_address);
    detail.documents = [];
    detail.cases = [];
    detail.paymentIntentId = null;
    return { order: detail, groups: own.map((g) => this.sellerDetail(agg, g, timeline, cfg, fees)) };
  }

  /* ---------------------------------------------------------------- admin area */

  adminPaymentState(agg: Agg): AdminOrderRow['paymentState'] {
    const o = agg.order;
    if (o.payment_state === 'failed') return 'failed';
    if (o.lifecycle === 'payment_pending' || o.payment_state === 'pending_check') return 'pending_check';
    if (o.refunded_total > 0 && o.refunded_total >= o.total) return 'refunded';
    if (o.refunded_total > 0) return 'partly_refunded';
    if (o.captured_total > 0) return 'captured';
    return 'authorized';
  }

  flags(agg: Agg): OrderFlag[] {
    const kinds = agg.order.flag_kinds ?? [];
    const now = this.core.now();
    const TONE: Record<string, OrderFlag['tone']> = {
      payment_failed: 'danger',
      payment_checking: 'info',
      overdue_dispatch: 'danger',
      due_soon: 'warning',
      cancellation_requested: 'warning',
      return_requested: 'info',
      case_open: 'warning',
      seller_restricted: 'warning',
      chargeback: 'danger',
      delivery_issue: 'danger',
    };
    const overdue = agg.groups.filter((g) => this.groupOpen(agg, g) && g.dispatch_by.getTime() < now.getTime());
    const LABEL: Record<string, string> = {
      payment_failed: 'Payment failed',
      payment_checking: 'Payment being checked',
      overdue_dispatch: overdue.length ? `Overdue ${durationText(now.getTime() - Math.min(...overdue.map((g) => g.dispatch_by.getTime())))}` : 'Overdue dispatch',
      due_soon: 'Dispatch due soon',
      cancellation_requested: 'Cancellation requested',
      return_requested: 'Return requested',
      case_open: 'Case open',
      seller_restricted: 'Seller restricted',
      chargeback: 'Chargeback',
      delivery_issue: 'Delivery issue',
    };
    return kinds.filter((k) => TONE[k]).map((k) => ({ kind: k as OrderFlag['kind'], tone: TONE[k]!, label: LABEL[k] ?? k }));
  }

  adminAlerts(agg: Agg): GroupAlert[] {
    const now = this.core.now().getTime();
    const out: GroupAlert[] = [];
    for (const g of agg.groups) {
      if (this.groupOpen(agg, g) && g.dispatch_by.getTime() < now) {
        out.push({ tone: 'danger', title: 'Overdue dispatch', message: `Package ${g.position} is ${durationText(now - g.dispatch_by.getTime())} past its dispatch deadline (${g.seller_name}).` });
      }
      const a = this.alert(agg, g);
      if (a && a.tone === 'danger') out.push({ ...a, message: `Package ${g.position}: ${a.message}` });
    }
    for (const c of agg.facts.chargebacks ?? []) out.push({ tone: 'danger', title: 'Chargeback opened', message: `A ${c.kind} dispute was opened on this order.` });
    if (agg.order.flag_kinds.includes('seller_restricted')) out.push({ tone: 'warning', title: 'Seller restricted', message: 'A seller on this order is restricted. The order stays fulfillable.' });
    return out;
  }

  afterSalesAdmin(agg: Agg): AdminItemAfterSales[] {
    const out: AdminItemAfterSales[] = [];
    for (const i of agg.items) {
      const g = agg.groups.find((x) => x.id === i.group_id)!;
      const owner = g.owner_type === 'official' ? 'Marketly' : g.seller_name;
      const c = [...agg.cancellations].reverse().find((x) => x.items.some((l) => l.itemId === i.id) && x.status !== 'withdrawn');
      if (c) {
        const line = c.refund_preview.lines.find((l) => l.itemId === i.id);
        out.push({ itemId: i.id, title: this.title(i), sellerName: g.seller_name, request: `Cancellation by ${c.initiated_by} · ${c.reason_code}`, amount: line?.refund ?? null, status: c.status === 'accepted' ? `Accepted · refund ${c.refund_status}` : c.status, owner });
      }
      if (i.return_id) out.push({ itemId: i.id, title: this.title(i), sellerName: g.seller_name, request: `Return ${i.return_ref ?? ''}`.trim(), amount: i.refunded_amount ? this.m(i.refunded_amount, agg) : null, status: `${ITEM_STATE_LABEL[i.state as ItemState] ?? i.state} · refund ${i.refund_status}`, owner });
      else if (!c && i.refund_status !== 'none') out.push({ itemId: i.id, title: this.title(i), sellerName: g.seller_name, request: 'Refund', amount: this.m(i.refunded_amount, agg), status: i.refund_status, owner });
    }
    return out;
  }

  moneyBySeller(agg: Agg, fees?: Fees): GroupMoney[] {
    return agg.groups.map((g) => {
      const items = agg.items.filter((i) => i.group_id === g.id);
      const f = this.funding(items, agg.order.currency);
      const fee = g.owner_type === 'official' ? null : (fees?.get(g.id) ?? null);
      return {
        groupId: g.id,
        seller: this.sellerLabel(g),
        items: this.m(g.items_total, agg),
        platformFunded: this.m(f.platform, agg),
        sellerFunded: this.m(f.seller, agg),
        customerPaid: this.m(g.total, agg),
        marketplaceFee: fee?.fee ?? null,
        sellerEarnings: fee?.earnings ?? null,
        companySale: g.owner_type === 'official',
      };
    });
  }

  couponFundingNote(agg: Agg): string | null {
    const coded = this.discounts(agg).filter((d) => d.code);
    if (!coded.length) return null;
    return coded
      .map((d) => (d.fundedBy === 'platform' ? `${d.code} is platform-funded; sellers receive their full price.` : d.fundedBy === 'seller' ? `${d.code} is seller-funded.` : `${d.code} is shared between Marketly and the seller.`))
      .join(' ');
  }

  adminActions(agg: Agg): AdminOrderDetail['allowedActions'] {
    const out: AdminOrderDetail['allowedActions'] = [];
    // items on a bought label the carrier does not have yet are cancelled only after the label is voided
    if (agg.order.lifecycle === 'open' && agg.items.some((i) => is(CANCELLABLE, i.state) && !this.onUnusedLabel(agg, i.id))) out.push('cancel_items');
    if (agg.items.some((i) => is(DELIVERED_LIKE, i.state) || i.state === 'shipped')) out.push('issue_refund');
    if (agg.groups.some((g) => g.owner_type === 'seller')) out.push('contact_seller');
    out.push('open_case', 'add_note');
    if (agg.groups.some((g) => this.groupOpen(agg, g))) out.push('extend_deadline');
    if (agg.order.lifecycle === 'open' || agg.order.lifecycle === 'completed') out.push('resend_confirmation');
    return out;
  }

  adminDetail(
    agg: Agg,
    timeline: readonly TimelineRec[],
    notes: readonly NoteRec[],
    cfg: Pick<Cfg, 'dueSoonMinutes'>,
    o: { canViewContact: boolean; fees?: Fees; orderCount?: number | null },
  ): AdminOrderDetail {
    const order = this.detail(
      agg,
      timeline.filter((t) => t.visibility === 'customer'),
      'admin',
      cfg,
    );
    const email = o.canViewContact ? agg.order.contact_email : maskEmail(agg.order.contact_email);
    const phone = o.canViewContact ? agg.order.contact_phone : maskPhone(agg.order.contact_phone);
    order.contact = { ...order.contact, email, phone };
    if (!o.canViewContact) order.deliveryAddress = { ...order.deliveryAddress, phone: maskPhone(order.deliveryAddress.phone) };
    const captures = agg.facts.captures ?? [];
    return {
      order,
      customer: { customerId: agg.order.customer_id, guest: !agg.order.customer_id, name: agg.order.contact_name, email, phone, customerSince: null, orderCount: o.orderCount ?? null },
      flags: this.flags(agg),
      alerts: this.adminAlerts(agg),
      afterSales: this.afterSalesAdmin(agg),
      moneyBySeller: this.moneyBySeller(agg, o.fees),
      couponFundingNote: this.couponFundingNote(agg),
      payment: {
        state: this.adminPaymentState(agg),
        methodLabel: agg.order.payment_method_label,
        authorizedAt: iso(agg.order.accepted_at),
        capturedAt: captures.at(-1)?.at ?? null,
        processorRef: null,
        captured: this.m(agg.order.captured_total, agg),
        refunded: this.m(agg.order.refunded_total, agg),
      },
      notes: notes.map((n) => this.note(n)),
      history: this.timeline([...timeline].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 20), 'admin'),
      allowedActions: this.adminActions(agg),
    };
  }

  note(n: NoteRec): InternalNote {
    return { id: n.id, text: n.text, author: { kind: 'staff', id: n.author_id, name: n.author_name }, at: isoReq(n.at) };
  }

  /** exceptions: shipping's open exception ids per order (core.openExceptionIds); without it orders' own facts */
  adminRow(agg: Agg, exceptions?: Record<string, string[]>): AdminOrderRow {
    const now = this.core.now().getTime();
    const overdue = agg.groups.filter((g) => this.groupOpen(agg, g) && g.dispatch_by.getTime() < now).sort((a, b) => a.dispatch_by.getTime() - b.dispatch_by.getTime())[0];
    const status = this.status(agg);
    const live = agg.groups.filter((g) => g.status !== 'cancelled');
    const delivered = live.filter((g) => g.status === 'delivered' || g.status === 'partly_cancelled').length;
    return {
      id: agg.order.id,
      ref: agg.order.ref,
      placedAt: isoReq(agg.order.placed_at),
      customerName: agg.order.contact_name,
      customerCity: agg.order.delivery_address?.city ?? '',
      guest: !agg.order.customer_id,
      sellers: agg.groups.map((g) => this.sellerLabel(g)),
      itemCount: this.units(agg),
      total: this.m(agg.order.total, agg),
      paymentState: this.adminPaymentState(agg),
      fulfillmentStatus: DISPLAY_LABEL[status.value],
      fulfillmentNote: live.length ? `${delivered} of ${plural(live.length, 'package')} delivered` : 'All items cancelled',
      lateBy: overdue ? `Overdue ${durationText(now - overdue.dispatch_by.getTime())}` : null,
      owner: overdue ? (overdue.owner_type === 'official' ? 'Official Store warehouse' : isMarketlyService(overdue) ? `Marketly warehouse (Fulfilled by Marketly for ${overdue.seller_name})` : overdue.seller_name) : null,
      flags: this.flags(agg),
      openExceptionIds: this.openExceptionIds(agg, exceptions),
    };
  }

  /** Paid amounts (refund caps) for one item */
  paid(agg: Agg, i: ItemRec) {
    const g = agg.groups.find((x) => x.id === i.group_id)!;
    return {
      orderItemId: i.id,
      groupId: i.group_id,
      ownerType: g.owner_type as 'official' | 'seller',
      sellerId: g.seller_id,
      quantity: i.quantity,
      itemAmount: this.m(i.unit_price * i.quantity, agg),
      discountShare: this.m(discountSum(i.discounts), agg),
      shippingShare: this.m(i.shipping_share, agg),
      taxShare: this.m(i.tax_share, agg),
      paid: this.m(i.paid_amount, agg),
    };
  }

  static readonly TIMING_NOTE = TIMING_NOTE;
  static readonly STATUS_NOTE = STATUS_NOTE;
}
