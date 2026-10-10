/**
 * Maps the return aggregate to the API shapes: the customer's ReturnDetail, the seller's and staff's
 * ReturnCase, list rows, refund requests and the inspection queue. Return status and refund status
 * are always separate fields.
 */
import { money } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type {
  AdminReturnRow,
  EarningsImpact,
  Inspection,
  InspectionChecklist,
  InspectionQueueRow,
  RefundBreakdown,
  RefundRequest,
  RefundView,
  Replacement,
  ReturnCase,
  ReturnDetail,
  ReturnEvidence,
  ReturnFlag,
  ReturnItemView,
  ReturnShipment,
  ReturnSummary,
  SellerReturnRow,
} from '../../../spec/returns.js';
import {
  ACTIVE_STATUSES,
  actorFrom,
  addBusinessDays,
  addDays,
  customerStatusLabel,
  deadline,
  is,
  iso,
  LIVE_REFUND,
  OPEN_STATUSES,
  PENDING_REFUND,
  reasonLabel,
  REFUND_LABEL,
  refundExplanation,
  refundTrack,
  relative,
  returnTrack,
  sellerStatusLabel,
  shortDate,
  type LabelFacts,
  type RefundStatus,
  type ReturnStatus,
} from '../domain/rules.js';
import type { EventRec, ItemRec, RefundRec, ReplacementRec, ReturnRec, ShipmentRec } from '../ports.js';
import { Amounts } from './amounts.js';
import type { Agg, Core } from './core.js';

export type Area = 'store' | 'seller' | 'admin';
type Refs = Map<string, common.MediaRef>;

const VISIBLE: Record<Area, EventRec['visibility'][]> = { store: ['customer'], seller: ['customer', 'seller'], admin: ['customer', 'seller', 'staff'] };

export class Views {
  readonly amounts: Amounts;

  constructor(private readonly core: Core) {
    this.amounts = new Amounts(core);
  }

  private get now() {
    return this.core.now();
  }
  private m(amount: number, currency?: string) {
    return money(amount, currency ?? this.core.currency);
  }

  /* ---------------------------------------------------------------- media */

  mediaIdsOf(agg: Agg): string[] {
    return [...agg.ret.media_ids, ...(agg.ret.info_request?.replyMediaIds ?? []), ...agg.inspections.flatMap((i) => i.media_ids), ...agg.evidence.flatMap((e) => e.media_ids)];
  }

  async refs(ids: string[]): Promise<Refs> {
    const unique = [...new Set(ids)];
    const out: Refs = new Map();
    if (!unique.length) return out;
    const list = await this.core.soft('media', 'media refs', (m) => m.refs(unique, 'small'));
    for (const r of list ?? []) out.set(r.id, r);
    return out;
  }

  private pick(ids: string[], refs: Refs): common.MediaRef[] {
    return ids.map((id) => refs.get(id)).filter((r): r is common.MediaRef => !!r);
  }

  /* ---------------------------------------------------------------- small pieces */

  withoutReturn(agg: Agg): boolean {
    // the exception record is the refund-without-return decision (seller, staff, overturn or case)
    return agg.ret.decision?.kind === 'approved_without_return' || !!agg.ret.exception;
  }

  facts(agg: Agg): LabelFacts {
    return {
      status: agg.ret.status as ReturnStatus,
      withoutReturn: this.withoutReturn(agg),
      outcome: agg.ret.terms_snapshot.meta.outcome ?? null,
      platformHandling: agg.ret.platform_handling,
      inspecting: !!agg.ret.inspector,
    };
  }

  item(i: ItemRec, ret: ReturnRec): ReturnItemView {
    return {
      orderItemId: i.order_item_id,
      productId: i.product_id,
      variantId: i.variant_id,
      title: i.title,
      options: i.options ?? {},
      sku: i.sku,
      imageUrl: ret.terms_snapshot.meta.images?.[i.order_item_id] ?? null,
      quantity: i.quantity,
      unitPrice: this.m(i.unit_price, i.currency),
    };
  }

  amountOf(agg: Agg): common.Money {
    const rr = this.core.refundOf(agg);
    if (rr) return this.m(rr.total, rr.currency);
    return this.m(
      agg.items.reduce((s, i) => s + i.unit_price * i.quantity, 0),
      agg.items[0]?.currency,
    );
  }

  timeline(agg: Agg, area: Area): common.TimelineEvent[] {
    return agg.events.filter((e) => VISIBLE[area].includes(e.visibility)).map((e) => this.event(e));
  }

  event(e: EventRec): common.TimelineEvent {
    return { at: e.at.toISOString(), label: e.label, detail: e.detail, actor: { kind: e.actor_kind as common.Actor['kind'], id: e.actor_id } };
  }

  /* ---------------------------------------------------------------- deadlines */

  inspectBy(agg: Agg): Date | null {
    const received = this.core.receivedAt(agg);
    if (!received || !is(['received', 'awaiting_remedy', 'completed'], agg.ret.status)) return null;
    return addBusinessDays(received, agg.ret.terms_snapshot.meta.targets.inspectionBusinessDays, this.core.tz);
  }

  refundBy(agg: Agg): Date | null {
    if (!is(['awaiting_remedy', 'completed'], agg.ret.status)) return null;
    const inspected = this.core.inspectionOf(agg)?.inspected_at;
    const decided = agg.ret.decision?.decidedAt ? new Date(agg.ret.decision.decidedAt) : null;
    const from = inspected ?? decided;
    if (!from) return null;
    return addBusinessDays(from, agg.ret.terms_snapshot.meta.targets.refundBusinessDays, this.core.tz);
  }

  deadlines(agg: Agg): ReturnCase['deadlines'] {
    const s = agg.ret.status;
    const shipment = this.core.shipmentOf(agg);
    const now = this.now;
    return {
      respondBy: s === 'requested' ? deadline(agg.ret.response_due_at, now) : null,
      inspectBy: s === 'received' ? deadline(this.inspectBy(agg), now) : null,
      refundBy: s === 'awaiting_remedy' ? deadline(this.refundBy(agg), now) : null,
      dropOffBy: s === 'approved' && shipment?.status === 'label_issued' ? deadline(shipment.drop_off_by, now) : null,
    };
  }

  nextDeadline(agg: Agg): common.Deadline | null {
    if (agg.ret.status === 'info_requested' && agg.ret.info_request) return deadline(agg.ret.info_request.replyDueAt, this.now);
    const d = this.deadlines(agg);
    return d.respondBy ?? d.dropOffBy ?? d.inspectBy ?? d.refundBy ?? null;
  }

  handlerName(ret: ReturnRec): string {
    if (ret.owner_type === 'official') return OFFICIAL_STORE_NAME;
    if (ret.platform_handling) return 'Marketly support';
    return ret.terms_snapshot.meta.sellerName;
  }

  nextStep(agg: Agg): string {
    const r = agg.ret;
    const tz = this.core.tz;
    const shipment = this.core.shipmentOf(agg);
    const rr = this.core.refundOf(agg);
    switch (r.status as ReturnStatus) {
      case 'requested':
        return r.response_due_at ? `${this.handlerName(r)} will respond by ${shortDate(r.response_due_at, tz)}` : `${this.handlerName(r)} will respond soon`;
      case 'info_requested':
        return r.info_request ? `Reply to the question by ${shortDate(r.info_request.replyDueAt, tz)}` : 'Reply to the question';
      case 'approved':
        if (shipment?.method === 'customer_arranged') return shipment.drop_off_by ? `Send it back and add tracking by ${shortDate(shipment.drop_off_by, tz)}` : 'Send it back and add tracking';
        return shipment?.drop_off_by ? `Drop off by ${shortDate(shipment.drop_off_by, tz)}` : 'Drop the package off with the carrier';
      case 'in_transit':
        return `On its way back to ${r.terms_snapshot.meta.destination.name}`;
      case 'received':
        return 'Being inspected';
      case 'awaiting_remedy': {
        const rep = this.core.replacementOf(agg);
        if (rep && rep.status !== 'cancelled') return rep.kind === 'exchange' ? 'Your exchange is being prepared' : 'Your replacement is being prepared';
        if (rr) return `Refund ${REFUND_LABEL[rr.status as RefundStatus].toLowerCase()}: ${refundExplanation(rr.status as RefundStatus)}`;
        return 'Refund being prepared';
      }
      case 'completed':
        return customerStatusLabel(this.facts(agg));
      case 'rejected':
        return r.escalation ? 'Marketly is reviewing the decision' : 'You can ask Marketly to review this decision';
      case 'cancelled':
        return 'This return was cancelled';
    }
  }

  /** Whether the customer may ask Marketly to step in now; availableFrom when not yet */
  escalation(agg: Agg): { ok: boolean; availableFrom: string | null } {
    const r = agg.ret;
    const now = this.now.getTime();
    if (!is(OPEN_STATUSES, r.status) || r.escalation) return { ok: false, availableFrom: null };
    if (r.status === 'rejected') return { ok: true, availableFrom: null };
    if (r.status === 'requested' && r.response_due_at && r.response_due_at.getTime() < now) return { ok: true, availableFrom: null };
    const rr = this.core.refundOf(agg);
    if (rr?.status === 'failed') return { ok: true, availableFrom: null };
    const due = r.status === 'requested' ? r.response_due_at : r.status === 'received' ? this.inspectBy(agg) : r.status === 'awaiting_remedy' ? this.refundBy(agg) : null;
    if (due && due.getTime() < now) return { ok: true, availableFrom: null };
    return { ok: false, availableFrom: iso(due) };
  }

  customerActions(agg: Agg): ReturnDetail['actions'] {
    const r = agg.ret;
    const s = r.status as ReturnStatus;
    const shipment = this.core.shipmentOf(agg);
    const out: ReturnDetail['actions'] = [];
    if (s === 'requested' || s === 'info_requested' || (s === 'approved' && shipment?.status !== 'in_transit')) out.push('withdraw');
    if (s === 'info_requested') out.push('reply_info');
    if ((s === 'approved' || s === 'in_transit') && shipment && shipment.method !== 'customer_arranged') out.push('get_label');
    if (s === 'approved' && shipment?.method === 'customer_arranged' && shipment.status === 'label_issued') out.push('add_tracking');
    if (this.escalation(agg).ok) out.push('escalate');
    if (is(OPEN_STATUSES, s)) out.push('report_problem');
    return out;
  }

  /* ---------------------------------------------------------------- shipments, refunds, replacements */

  instructions(s: ShipmentRec): string[] {
    if (s.method === 'customer_arranged') return ['Pack the item securely with all accessories.', `Ship it to ${s.to_address.name} with a tracked service.`, 'Add the carrier and tracking number to your return.'];
    if (s.method === 'prepaid_qr') return ['Pack the item securely with all accessories.', 'Show the QR code at a drop-off point; no printer needed.', 'Keep your drop-off receipt until the return is received.'];
    return ['Pack the item securely with all accessories.', 'Print the label and attach it to the package.', 'Drop the package off at a carrier location and keep the receipt.'];
  }

  shipment(s: ShipmentRec, agg: Agg, dropOffPoints: ReturnShipment['dropOffPoints'] = []): ReturnShipment {
    return {
      id: s.id,
      status: s.status as ReturnShipment['status'],
      method: s.method as ReturnShipment['method'],
      carrier: s.carrier,
      service: s.service,
      trackingNumber: s.tracking_number,
      trackingUrl: null,
      labelUrl: s.label_url,
      qrCodeUrl: s.qr_code_url,
      dropOffBy: iso(s.drop_off_by),
      dropOffPoints,
      instructions: this.instructions(s),
      from: s.from_address,
      to: s.to_address,
      cost: s.cost === null ? null : this.m(s.cost),
      paidBy: s.paid_by as ReturnShipment['paidBy'],
      shippingShipmentId: s.shipping_shipment_id,
      events: agg.events.filter((e) => e.kind.startsWith('shipment')).map((e) => this.event(e)),
    };
  }

  breakdown(rr: RefundRec, isEstimate = false): RefundBreakdown {
    const m = (n: number) => money(n, rr.currency);
    return {
      itemAmount: m(rr.item_amount),
      discountShare: m(rr.discount_share),
      shippingRefund: m(rr.shipping_refund),
      returnShippingDeduction: m(rr.return_shipping_deduction),
      deductions: rr.deductions,
      taxRefund: rr.tax_refund ? m(rr.tax_refund) : null,
      total: m(rr.total),
      maxRefundable: m(rr.max_refundable),
      destination: rr.destination_label,
      isEstimate,
    };
  }

  refundView(rr: RefundRec, agg: Agg): RefundView {
    const status = rr.status as RefundStatus;
    const approvedAt = rr.approved_at?.toISOString() ?? null;
    return {
      id: rr.id,
      ref: rr.ref,
      // a declined request is being reworked: the customer still sees Under review
      status: status === 'declined' ? 'under_review' : status,
      statusLabel: REFUND_LABEL[status === 'declined' ? 'under_review' : status],
      track: refundTrack(status),
      breakdown: this.breakdown(rr, is(['requested', 'under_review', 'declined'], status)),
      approvedAt,
      sentAt: rr.sent_at?.toISOString() ?? null,
      failedReason: rr.failed_reason,
      expectedBy: approvedAt && status !== 'sent' ? addBusinessDays(new Date(approvedAt), agg.ret.terms_snapshot.meta.targets.refundBusinessDays + 3, this.core.tz).toISOString() : null,
      bankReference: null,
      explanation: refundExplanation(status),
    };
  }

  replacement(rep: ReplacementRec, agg: Agg): Replacement {
    const item = agg.items.find((i) => i.order_item_id === rep.order_item_id) ?? agg.items[0];
    return this.replacementOf(rep, item ? { title: item.title, options: item.options ?? {}, variantId: item.variant_id } : undefined);
  }

  /** A replacement with the original item's title and options (from its return, or the order for case replacements) */
  replacementOf(rep: ReplacementRec, item?: { title: string; options: Record<string, string>; variantId: string }): Replacement {
    return {
      id: rep.id,
      returnId: rep.return_id,
      caseId: rep.case_id,
      orderId: rep.order_id,
      orderItemId: rep.order_item_id,
      kind: rep.kind as Replacement['kind'],
      status: rep.status as Replacement['status'],
      variantId: rep.variant_id,
      title: item?.title ?? 'Replacement',
      options: rep.variant_id === item?.variantId ? (item?.options ?? {}) : {},
      quantity: rep.quantity,
      chargeNote: rep.kind === 'exchange' ? 'Exchange at the same price, no charge' : 'Same item, no charge',
      carrier: null,
      trackingNumber: null,
      estimatedDelivery: null,
      shippingShipmentId: rep.shipping_shipment_id,
      newReturnWindowEnds: rep.delivered_at ? addDays(rep.delivered_at, 30).toISOString().slice(0, 10) : null,
      cancelReason: rep.cancel_reason,
      createdAt: rep.created_at.toISOString(),
    };
  }

  /* ---------------------------------------------------------------- the customer's detail */

  async details(aggs: Agg[], area: Area): Promise<ReturnDetail[]> {
    const refs = await this.refs(aggs.flatMap((a) => [...a.ret.media_ids, ...(a.ret.info_request?.replyMediaIds ?? [])]));
    return aggs.map((a) => this.detail(a, area, refs));
  }

  detail(agg: Agg, area: Area, refs: Refs): ReturnDetail {
    const r = agg.ret;
    const shipment = this.core.shipmentOf(agg);
    const rr = this.core.refundOf(agg);
    const rep = this.core.replacementOf(agg);
    const facts = this.facts(agg);
    const info = r.info_request;
    return {
      id: r.id,
      ref: r.ref,
      orderId: r.order_id,
      orderRef: r.order_ref,
      seller: { ownerType: r.owner_type, id: r.seller_id, name: r.owner_type === 'official' ? OFFICIAL_STORE_NAME : r.terms_snapshot.meta.sellerName },
      status: r.status as ReturnStatus,
      statusLabel: customerStatusLabel(facts),
      track: returnTrack({ ...facts, remedyKind: rep && rep.status !== 'cancelled' ? rep.kind : r.remedy }),
      items: agg.items.map((i) => this.item(i, r)),
      reason: reasonLabel(r.reason),
      details: r.details,
      media: this.pick(r.media_ids, refs),
      remedy: r.remedy as ReturnDetail['remedy'],
      handledBy: r.handled_by as ReturnDetail['handledBy'],
      responseDue: r.status === 'requested' ? deadline(r.response_due_at, this.now) : null,
      infoRequest: info ? { question: info.question, askedBy: info.askedBy, askedAt: info.askedAt, replyDueAt: info.replyDueAt, reply: info.reply ?? null, replyMedia: this.pick(info.replyMediaIds ?? [], refs), repliedAt: info.repliedAt ?? null } : null,
      decision: r.decision,
      shipment: shipment ? this.shipment(shipment, agg) : null,
      refund: rr ? this.refundView(rr, agg) : null,
      replacement: rep ? this.replacement(rep, agg) : null,
      terms: r.terms_snapshot.terms,
      escalation: r.escalation,
      conversationId: r.conversation_id,
      timeline: this.timeline(agg, area === 'store' ? 'store' : area),
      nextStep: this.nextStep(agg),
      actions: area === 'store' ? this.customerActions(agg) : [],
      requestedAt: r.requested_at.toISOString(),
    };
  }

  /* ---------------------------------------------------------------- seller and staff case */

  flags(agg: Agg, afterPayout = false): ReturnFlag[] {
    const r = agg.ret;
    const out: ReturnFlag[] = [];
    if (r.exception && !r.exception.approvedBy) out.push({ kind: 'refund_without_return_proposed', label: 'Refund without return proposed' });
    if (r.exception?.approvedBy) out.push({ kind: 'refund_without_return_approved', label: 'Refund without return' });
    if (r.escalation && ['seller_no_response', 'seller_missed_inspection'].includes(r.escalation.reason)) out.push({ kind: 'seller_missed_deadline', label: 'Seller missed a deadline' });
    if (r.platform_handling && r.owner_type === 'seller') out.push({ kind: 'platform_took_over', label: 'Marketly is handling' });
    if (agg.refunds.some((x) => x.status === 'failed')) out.push({ kind: 'refund_failed', label: 'Refund failed' });
    if (r.escalation && (r.escalation.by.kind === 'customer' || r.escalation.by.kind === 'visitor')) out.push({ kind: 'customer_escalated', label: 'Customer asked Marketly to step in' });
    if (r.case_id && is(OPEN_STATUSES, r.status)) out.push({ kind: 'dispute_open', label: 'Dispute open' });
    if (afterPayout) out.push({ kind: 'refund_after_payout', label: 'Refund after payout' });
    return out;
  }

  allowedActions(agg: Agg, area: 'seller' | 'admin'): string[] {
    const r = agg.ret;
    const s = r.status as ReturnStatus;
    const out: string[] = [];
    const liveRefund = agg.refunds.some((x) => is(LIVE_REFUND, x.status));
    const liveReplacement = agg.replacements.some((x) => x.status !== 'cancelled');
    if (area === 'seller') {
      const own = !r.platform_handling;
      if (own && s === 'requested') out.push('approve', 'request-info', 'reject', 'approve-without-return');
      if (own && (s === 'approved' || s === 'in_transit')) out.push('approve-without-return');
      if (s === 'approved' || s === 'in_transit') out.push('receive');
      if (s === 'received') out.push('inspection', 'inspection-draft');
      if (own && s === 'awaiting_remedy' && !liveRefund && !liveReplacement) out.push('remedy', 'inspection-draft');
      if (is(OPEN_STATUSES, s)) out.push('evidence');
      return out;
    }
    if (s === 'requested') out.push('approve', 'request-info', 'reject');
    if (is(['requested', 'approved', 'in_transit'], s)) out.push('approve-without-return');
    if (r.owner_type === 'seller' && !r.platform_handling && is(ACTIVE_STATUSES, s)) out.push('take-over');
    if (s === 'rejected') out.push('overturn');
    if (r.owner_type === 'seller' && r.platform_handling && (s === 'approved' || s === 'in_transit')) out.push('receive');
    if (s === 'received') out.push('start-inspection', 'inspection-draft', 'inspection');
    if (s === 'awaiting_remedy' && (r.owner_type === 'official' || r.platform_handling) && !liveRefund && !liveReplacement) out.push('remedy');
    out.push('assign');
    return out;
  }

  checklist(agg: Agg, checksByCategory: Record<string, unknown>, categories: Record<string, string | null> = agg.ret.terms_snapshot.meta.categories ?? {}): InspectionChecklist | null {
    if (!is(['received', 'awaiting_remedy', 'completed'], agg.ret.status)) return null;
    const items: InspectionChecklist['items'] = agg.items.map((i, n) => ({ key: `contents.${n + 1}`, kind: 'contents', label: `${i.title}${Object.keys(i.options ?? {}).length ? ` (${Object.values(i.options).join(', ')})` : ''} × ${i.quantity}`, expected: i.sku, required: true }));
    items.push({ key: 'condition.packaging', kind: 'condition', label: 'Original packaging and accessories', expected: null, required: false });
    items.push({ key: 'condition.match', kind: 'condition', label: 'Item matches the order (model and variant)', expected: null, required: true });
    // category checks are keyed by the order items' category at purchase; "*" applies to every return
    const labels = new Set<string>();
    for (const key of ['*', ...agg.items.map((i) => categories[i.order_item_id]).filter((c): c is string => !!c)]) {
      const extra = checksByCategory[key];
      if (Array.isArray(extra)) for (const label of extra) if (typeof label === 'string') labels.add(label);
    }
    [...labels].forEach((label, n) => items.push({ key: `functional.${n + 1}`, kind: /clean|hygien/i.test(label) ? 'hygiene' : 'functional', label, expected: null, required: false }));
    return { expectedContents: agg.items.map((i) => i.title), serialShipped: null, items };
  }

  async inspection(agg: Agg, refs: Refs): Promise<Inspection | null> {
    const i = this.core.inspectionOf(agg);
    if (!i) return null;
    return {
      id: i.id,
      inspectedBy: actorFrom(i.inspected_by) ?? { kind: 'system', id: null },
      inspectedAt: i.inspected_at.toISOString(),
      conditionOutcome: i.condition_outcome as Inspection['conditionOutcome'],
      grade: i.grade as Inspection['grade'],
      checks: i.checks,
      missingParts: i.missing_parts,
      notes: i.notes,
      media: this.pick(i.media_ids, refs),
      proposedStockOutcome: i.proposed_stock_outcome as Inspection['proposedStockOutcome'],
      regradeCondition: i.regrade_condition,
      stockOutcomeRecordedBy: actorFrom(i.stock_outcome_recorded_by),
      stockOutcomeRecordedAt: iso(i.stock_outcome_recorded_at),
    };
  }

  evidenceView(e: Agg['evidence'][number], refs: Refs): ReturnEvidence {
    return { id: e.id, kind: e.kind as ReturnEvidence['kind'], media: this.pick(e.media_ids, refs), note: e.note, party: e.party as ReturnEvidence['party'], addedBy: e.added_by, addedAt: e.added_at.toISOString(), caseId: e.case_id };
  }

  async earningsImpact(agg: Agg, rr: RefundRec | null): Promise<EarningsImpact | null> {
    const r = agg.ret;
    if (r.owner_type !== 'seller') return null;
    const refund = rr ? this.m(rr.total, rr.currency) : this.amountOf(agg);
    const shipment = this.core.shipmentOf(agg);
    const labelCharge = shipment?.paid_by === 'seller' && shipment.cost ? this.m(shipment.cost) : null;
    const preview = await this.core.soft('finance', 'refund impact', (f) => f.previewRefundImpact(agg.items.map((i) => i.order_item_id), refund, rr?.funded_by ?? 'seller'));
    if (!preview) return null;
    return {
      refundToCustomer: refund,
      sellerEarningsChange: preview.sellerEarningsChange,
      feeReturned: preview.feeReturned,
      labelCharge,
      totalBalanceChange: this.m(preview.sellerEarningsChange.amount + preview.feeReturned.amount - (labelCharge?.amount ?? 0), refund.currency),
      afterPayout: preview.afterPayout,
      note: preview.note,
    };
  }

  /** Category of each returned order item at purchase: copied at request time, else read from orders (older returns) */
  async categoriesOf(agg: Agg): Promise<Record<string, string | null>> {
    const stored = agg.ret.terms_snapshot.meta.categories;
    if (stored) return stored;
    if (!is(['received', 'awaiting_remedy', 'completed'], agg.ret.status)) return {};
    const orders = this.core.ctx.use('orders');
    const items = await Promise.all(agg.items.map((i) => this.core.quiet('order item category', () => orders.getOrderItem(i.order_item_id))));
    return Object.fromEntries(agg.items.map((i, n) => [i.order_item_id, items[n]?.categoryId ?? null]));
  }

  async returnCase(agg: Agg, area: 'seller' | 'admin'): Promise<ReturnCase> {
    const r = agg.ret;
    const refs = await this.refs(this.mediaIdsOf(agg));
    const rr = this.core.refundOf(agg);
    const ids = agg.items.map((i) => i.order_item_id);
    const currency = agg.items[0]?.currency ?? this.core.currency;
    const [paid, remaining, methodLabel, impact, orders, ownerRef, checks, categories] = await Promise.all([
      this.core.quiet('paid amounts', () => this.amounts.paidLines(r.order_id)),
      this.amounts.remaining(r.order_id, ids, false),
      this.amounts.methodLabel(r),
      this.earningsImpact(agg, rr),
      r.customer_id && r.seller_id
        ? this.core.quiet('orders with seller', () => this.core.ctx.use('orders').listOrdersAdmin({ customerId: r.customer_id!, sellerId: r.seller_id! }, { limit: 1, page: 1 }))
        : Promise.resolve(undefined),
      r.owner_staff_id ? this.core.soft('access', 'staff ref', (a) => a.getStaffRef(r.owner_staff_id!)) : Promise.resolve(undefined),
      this.core.ctx.settings.get('inspectionChecksByCategory'),
      this.categoriesOf(agg),
    ]);
    let itemPaid = 0;
    let shippingPaid = 0;
    let discount = 0;
    let cap = 0;
    let refunded = 0;
    for (const i of agg.items) {
      const p = paid?.get(i.order_item_id);
      const part = (n: number) => (p && p.quantity > 0 && i.quantity < p.quantity ? Math.floor((n * i.quantity) / p.quantity) : n);
      itemPaid += p ? part(p.itemAmount + p.taxShare) : i.unit_price * i.quantity;
      shippingPaid += p ? part(p.shippingShare) : 0;
      discount += p ? part(p.discountShare) : 0;
      const rem = remaining?.items.get(i.order_item_id);
      const paidShare = p ? part(p.paid) : i.unit_price * i.quantity;
      cap += rem ? Math.min(rem.remaining, paidShare) : paidShare;
      refunded += rem ? rem.refunded : 0;
    }
    const detail = this.detail(agg, area, refs);
    const ownerName = ownerRef ? (ownerRef as { name?: string }).name : null;
    return {
      detail,
      customer: { displayName: r.terms_snapshot.meta.customerName, city: r.terms_snapshot.meta.city, ordersWithSeller: Math.max(1, orders?.total ?? 1) },
      payment: { itemPaid: this.m(itemPaid, currency), shippingPaid: this.m(shippingPaid, currency), discountShare: this.m(discount, currency), maxRefundable: this.m(cap, currency), refundedSoFar: this.m(refunded, currency), methodLabel },
      policyApplied: r.terms_snapshot.terms,
      shippingPaidBy: r.shipping_paid_by as ReturnCase['shippingPaidBy'],
      deadlines: this.deadlines(agg),
      inspection: await this.inspection(agg, refs),
      refundRequest: rr ? await this.refundRequest(rr, area, agg) : null,
      earningsImpact: impact,
      exception: area === 'admin' ? r.exception : r.exception ? { ...r.exception } : null,
      owner: r.owner_staff_id ? { kind: 'staff', id: r.owner_staff_id, name: ownerName ?? null } : null,
      flags: this.flags(agg, impact?.afterPayout ?? false),
      caseId: r.case_id,
      caseRef: r.escalation?.caseRef ?? null,
      activity: agg.events
        .filter((e) => VISIBLE[area].includes(e.visibility))
        .map((e) => this.event(e))
        .reverse(),
      inspectionChecklist: this.checklist(agg, (checks ?? {}) as Record<string, unknown>, categories),
      inspectionDraft: agg.draft ? { inspection: agg.draft.inspection, remedy: agg.draft.remedy, savedBy: agg.draft.saved_by, savedAt: agg.draft.saved_at.toISOString() } : null,
      inspector: r.inspector,
      evidence: agg.evidence.map((e) => this.evidenceView(e, refs)),
      allowedActions: this.allowedActions(agg, area),
    };
  }

  /* ---------------------------------------------------------------- refund requests */

  async refundRequest(rr: RefundRec, area: 'seller' | 'admin' = 'admin', agg?: Agg): Promise<RefundRequest> {
    const x = rr.deductions;
    const approval = rr.approval_request_id ? ((await this.core.soft('access', 'approval info', (a) => a.approvalInfo(rr.approval_request_id!))) ?? { required: true, reason: 'Above the approver limit', approvalRequestId: rr.approval_request_id, approvers: ['Finance'] }) : null;
    let impact: EarningsImpact | null = null;
    if (rr.owner_type === 'seller' && agg) impact = await this.earningsImpact(agg, rr);
    const ret = agg?.ret;
    const history = ret ? agg!.events.filter((e) => e.kind.startsWith('refund') && VISIBLE[area].includes(e.visibility)).map((e) => this.event(e)) : rr.history;
    return {
      id: rr.id,
      ref: rr.ref,
      source: rr.source as RefundRequest['source'],
      returnId: rr.return_id,
      returnRef: ret?.ref ?? null,
      caseId: rr.case_id,
      orderId: rr.order_id,
      orderRef: ret?.order_ref ?? rr.order_ref ?? '',
      orderItemIds: rr.order_item_ids,
      ownerType: rr.owner_type,
      sellerId: rr.seller_id,
      sellerName: rr.owner_type === 'official' ? OFFICIAL_STORE_NAME : (ret?.terms_snapshot.meta.sellerName ?? rr.seller_name ?? 'Seller'),
      customerName: ret?.terms_snapshot.meta.customerName ?? rr.customer_name ?? 'Customer',
      status: rr.status as RefundRequest['status'],
      breakdown: this.breakdown(rr, is(['requested', 'under_review', 'declined'], rr.status)),
      fundedBy: rr.funded_by as RefundRequest['fundedBy'],
      sellerShare: rr.seller_share === null ? null : this.m(rr.seller_share, rr.currency),
      platformShare: rr.platform_share === null ? null : this.m(rr.platform_share, rr.currency),
      reasonCode: rr.reason_code,
      reason: rr.reason,
      trustReportId: area === 'admin' ? rr.trust_report_id : null,
      earningsImpact: impact,
      approval: area === 'admin' ? approval : null,
      proposedBy: actorFrom(rr.proposed_by) ?? { kind: 'system', id: null },
      approvedBy: actorFrom(rr.approved_by),
      declineReason: rr.decline_reason,
      paymentRefundId: rr.payment_refund_id,
      failedReason: rr.failed_reason,
      createdAt: rr.created_at.toISOString(),
      updatedAt: rr.updated_at.toISOString(),
      history,
    };
  }

  async refundRequests(list: RefundRec[], area: 'seller' | 'admin' = 'admin'): Promise<RefundRequest[]> {
    const aggs = await this.core.loadMany(list.map((r) => r.return_id).filter((x): x is string => !!x));
    return Promise.all(list.map((r) => this.refundRequest(r, area, r.return_id ? aggs.get(r.return_id) : undefined)));
  }

  /* ---------------------------------------------------------------- list rows */

  summary(agg: Agg): ReturnSummary {
    const r = agg.ret;
    const rr = this.core.refundOf(agg);
    return {
      id: r.id,
      ref: r.ref,
      orderId: r.order_id,
      orderRef: r.order_ref,
      ownerType: r.owner_type,
      sellerId: r.seller_id,
      sellerName: r.owner_type === 'official' ? OFFICIAL_STORE_NAME : r.terms_snapshot.meta.sellerName,
      item: this.item(agg.items[0]!, r),
      itemCount: agg.items.reduce((n, i) => n + i.quantity, 0),
      status: r.status,
      statusLabel: customerStatusLabel(this.facts(agg)),
      refundStatus: rr ? (rr.status === 'declined' ? 'under_review' : rr.status) : null,
      refundAmount: rr ? this.m(rr.total, rr.currency) : null,
      openedAt: r.requested_at.toISOString(),
      nextStep: this.nextStep(agg),
      nextDeadline: this.nextDeadline(agg),
      open: !is(['completed', 'cancelled'], r.status),
    };
  }

  deadlineLabel(agg: Agg): string {
    const r = agg.ret;
    const tz = this.core.tz;
    const d = this.nextDeadline(agg);
    if (r.status === 'info_requested' && r.info_request) return `Customer replies by ${shortDate(r.info_request.replyDueAt, tz)}`;
    if (r.status === 'rejected') return r.escalation ? 'Marketly is reviewing' : 'Customer can ask Marketly to review';
    if (!d) return is(['completed', 'cancelled'], r.status) ? 'Closed' : '—';
    if (d.state === 'overdue') return relative(d.dueAt, this.now);
    return `${r.status === 'requested' ? 'Respond' : r.status === 'approved' ? 'Drop-off' : r.status === 'received' ? 'Inspect' : 'Refund'} by ${shortDate(d.dueAt, tz)}`;
  }

  sellerRow(agg: Agg): SellerReturnRow {
    const r = agg.ret;
    const rr = this.core.refundOf(agg);
    return {
      id: r.id,
      ref: r.ref,
      orderId: r.order_id,
      orderRef: r.order_ref,
      item: this.item(agg.items[0]!, r),
      itemCount: agg.items.reduce((n, i) => n + i.quantity, 0),
      reason: reasonLabel(r.reason),
      detailNote: r.details ? r.details.slice(0, 140) : null,
      amount: this.amountOf(agg),
      requestedAt: r.requested_at.toISOString(),
      status: r.status,
      statusLabel: sellerStatusLabel(this.facts(agg)),
      deadline: this.nextDeadline(agg),
      deadlineLabel: this.deadlineLabel(agg),
      platformInvolved: r.platform_handling || !!r.escalation || !!r.case_id,
      caseId: r.case_id,
      refundedAmount: rr?.status === 'sent' ? this.m(rr.total, rr.currency) : null,
    };
  }

  adminRow(agg: Agg): AdminReturnRow {
    const r = agg.ret;
    const rr = this.core.refundOf(agg);
    return {
      id: r.id,
      ref: r.ref,
      orderId: r.order_id,
      orderRef: r.order_ref,
      seller: { ownerType: r.owner_type, id: r.seller_id, name: r.owner_type === 'official' ? OFFICIAL_STORE_NAME : r.terms_snapshot.meta.sellerName },
      item: this.item(agg.items[0]!, r),
      reason: reasonLabel(r.reason),
      amount: this.amountOf(agg),
      owner: r.owner_staff_id ? { kind: 'staff', id: r.owner_staff_id } : null,
      deadline: this.nextDeadline(agg),
      deadlineLabel: this.deadlineLabel(agg),
      status: sellerStatusLabel(this.facts(agg)),
      refundStatus: rr?.status ?? null,
      flags: this.flags(agg),
      exceptionNote: r.exception ? `${r.exception.reasonCode.replace(/_/g, ' ')}: ${r.exception.details}` : null,
    };
  }

  inspectionRow(agg: Agg): InspectionQueueRow {
    const r = agg.ret;
    const shipment = this.core.shipmentOf(agg);
    const received = this.core.receivedAt(agg);
    const status =
      r.status === 'received' ? (r.inspector ? 'Inspecting' : 'Received') : r.status === 'approved' || r.status === 'in_transit' ? 'Arriving' : r.status === 'awaiting_remedy' || r.status === 'completed' ? 'Decided' : sellerStatusLabel(this.facts(agg));
    return {
      returnId: r.id,
      ref: r.ref,
      orderRef: r.order_ref,
      item: this.item(agg.items[0]!, r),
      reason: reasonLabel(r.reason),
      receivedAt: is(['received', 'awaiting_remedy', 'completed'], r.status) ? iso(received) : null,
      expectedAt: r.terms_snapshot.meta.estimatedArrival?.to ? new Date(`${r.terms_snapshot.meta.estimatedArrival.to}T17:00:00Z`).toISOString() : (iso(shipment?.drop_off_by) ?? null),
      inspector: r.inspector,
      status,
      target: r.status === 'received' ? deadline(this.inspectBy(agg), this.now) : null,
    };
  }

  /** Refund status of a return for lists (separate from the return status) */
  refundStatusOf(agg: Agg): string | null {
    return this.core.refundOf(agg)?.status ?? null;
  }

  pendingRefund(rr: RefundRec): boolean {
    return is(PENDING_REFUND, rr.status);
  }
}
