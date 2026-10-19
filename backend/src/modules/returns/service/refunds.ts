/**
 * Refund requests: itemised, capped by what payments says is still refundable, approved by the seller
 * (its own returns) or by Finance (returns.refunds.approve, limits through access), then handed to
 * payments (or to wallet for store credit). Their payment progress mirrors payments' events.
 * Approved never means money arrived; only sent does.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { format, money } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { ExceptionRefundInput, RefundBreakdown, RefundDeduction, RefundRequest, RemedyInput } from '../../../spec/returns.js';
import { refundRequestMachine, returnMachine } from '../domain/state-machines.js';
import { actorFrom, actorText, is, LIVE_REFUND, type BreakdownResult, type RefundStatus, type ReturnStatus } from '../domain/rules.js';
import type { RefundItem, RefundRec, ReturnRec } from '../ports.js';
import type { ReturnsRepository } from '../repository.js';
import { Batch, invalid, invalidField, notFound, SYSTEM, type Agg, type By, type Core } from './core.js';
import type { Views } from './views.js';

export const APPROVE_ACTION = 'returns.refunds.approve';
/** Where staff open a refund waiting for approval: Admin › Finance › Refunds to approve (the view refunds-to-approve picks the refund_request target) */
const REFUND_SCREEN = 'admin/finance';
const OUTCOME: Record<string, 'refunded' | 'partly_refunded' | 'credited'> = { partial_refund: 'partly_refunded', store_credit: 'credited' };

export interface RefundPlan {
  b: BreakdownResult;
  deductions: RefundDeduction[];
  destination: 'original_method' | 'store_credit';
  destinationLabel: string;
  kind: string;
  currency: string;
}

/** What the caller's refund authority allows (Refunds.authorize); claimed: the re-auth token used up for it */
export interface RefundDecision {
  decision: 'allowed' | 'approval_required' | 'denied' | 'unavailable';
  reason: string | null;
  claimed: string | null;
}

export class Refunds {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  /* ---------------------------------------------------------------- planning (no writes) */

  /** Live refund requests covering any of these order items, other than `except` */
  async liveFor(orderId: string, orderItemIds: string[], except?: string): Promise<RefundRec | null> {
    const rows = await this.repo.find('refund_requests', { order_id: orderId, status: LIVE_REFUND });
    return rows.find((r) => r.id !== except && r.order_item_ids.some((id) => orderItemIds.includes(id))) ?? null;
  }

  duplicate(rr: RefundRec) {
    return this.core.error('DUPLICATE_REFUND', `Refund ${rr.ref} already covers these items`, { refundRequestId: rr.id });
  }

  /** The refund for a return's remedy: validated, capped and checked for duplicates */
  async plan(agg: Agg, remedy: RemedyInput, o: { except?: string } = {}): Promise<RefundPlan> {
    const ret = agg.ret;
    const deductions = (remedy.deductions ?? []).map((d) => ({ ...d, label: d.label.trim(), reason: d.reason.trim() }));
    const issues: { path: string; message: string }[] = [];
    deductions.forEach((d, n) => {
      if (!d.label) issues.push({ path: `deductions.${n}.label`, message: 'Name the deduction' });
      if (!d.reason) issues.push({ path: `deductions.${n}.reason`, message: 'Explain the deduction to the customer' });
      if (!Number.isInteger(d.amount.amount) || d.amount.amount <= 0) issues.push({ path: `deductions.${n}.amount`, message: 'Enter an amount above zero' });
    });
    if (remedy.kind === 'partial_refund' && !deductions.length && !remedy.amount) issues.push({ path: 'deductions', message: 'A partial refund needs deductions with reasons' });
    if (remedy.kind === 'partial_refund' && remedy.amount && !deductions.length) issues.push({ path: 'deductions', message: 'Explain why the refund is partial' });
    if (remedy.amount && (!Number.isInteger(remedy.amount.amount) || remedy.amount.amount <= 0)) issues.push({ path: 'amount', message: 'Enter an amount above zero' });
    if (issues.length) throw invalid(issues);
    const destination = remedy.kind === 'store_credit' || ret.remedy === 'store_credit' ? 'store_credit' : 'original_method';
    if (destination === 'store_credit' && (!this.core.walletOn() || !ret.customer_id)) throw this.core.error('REMEDY_NOT_AVAILABLE', 'Store credit is not available', { remedy: 'store_credit' });
    const live = await this.liveFor(ret.order_id, agg.items.map((i) => i.order_item_id), o.except);
    if (live) throw this.duplicate(live);
    const shipment = this.core.shipmentOf(agg);
    const b = await this.views.amounts.forReturn(ret, agg.items, {
      deductions,
      amount: remedy.kind === 'partial_refund' ? (remedy.amount?.amount ?? null) : null,
      strict: true,
      withReturnShipping: !!shipment && shipment.method !== 'customer_arranged' && ret.shipping_paid_by === 'customer',
    });
    const currency = agg.items[0]?.currency ?? this.core.currency;
    if (remedy.kind === 'partial_refund' && remedy.amount && remedy.amount.amount > b.maxRefundable) throw this.core.error('REFUND_EXCEEDS_REFUNDABLE', 'The amount is above what can still be refunded for these items', { maxRefundable: money(b.maxRefundable, currency) });
    if (b.total <= 0) throw this.core.error('REFUND_EXCEEDS_REFUNDABLE', 'Nothing is left to refund for these items', { maxRefundable: money(b.maxRefundable, currency) });
    return { b, deductions, destination, destinationLabel: destination === 'store_credit' ? 'Marketly store credit' : await this.views.amounts.methodLabel(ret), kind: remedy.kind, currency };
  }

  /* ---------------------------------------------------------------- creating */

  /** The columns a plan sets on a refund request */
  private planColumns(p: RefundPlan) {
    return { deductions: p.deductions, destination: p.destination, destination_label: p.destinationLabel, max_refundable: p.b.maxRefundable, remedy_kind: p.kind, tax_refund: p.b.taxRefund || null };
  }

  /**
   * The items of a request, in order: the amount per item (the split handed to payments; without a split the
   * whole total on the first item) and the refunded quantity (null: the returned units).
   */
  static items(ids: string[], perItem: { orderItemId: string; amount: number }[], quantities: { orderItemId: string; quantity: number }[], total: number): RefundItem[] {
    return ids.map((orderItemId, n) => ({
      orderItemId,
      quantity: quantities.find((q) => q.orderItemId === orderItemId)?.quantity ?? null,
      amount: perItem.length ? (perItem.find((x) => x.orderItemId === orderItemId)?.amount ?? 0) : n === 0 ? total : 0,
    }));
  }

  /** One history line of a refund request */
  private ev(label: string, detail: string | null, actor: common.Actor | null, at: Date | string = this.core.now()): common.TimelineEvent {
    return { at: typeof at === 'string' ? at : at.toISOString(), label, detail, actor };
  }

  /** Inserts the refund request of a return (inside the caller's transaction) */
  async insertForReturn(tx: ReturnsRepository, agg: Agg, p: RefundPlan, o: { source: 'return' | 'seller'; status: RefundStatus; by: By; reasonCode?: string | null; reason?: string | null; ref: string }): Promise<RefundRec> {
    const ret = agg.ret;
    const now = this.core.now();
    const seller = ret.owner_type === 'seller';
    const rr = await tx.insert('refund_requests', {
      id: newId(),
      ref: o.ref,
      source: o.source,
      return_id: ret.id,
      case_id: ret.case_id,
      order_id: ret.order_id,
      order_item_ids: agg.items.map((i) => i.order_item_id),
      items: Refunds.items(
        agg.items.map((i) => i.order_item_id),
        p.b.perItem,
        agg.items.map((i) => ({ orderItemId: i.order_item_id, quantity: i.quantity })),
        p.b.total,
      ),
      history: [],
      owner_type: ret.owner_type,
      seller_id: ret.seller_id,
      customer_id: ret.customer_id,
      contact_email: ret.terms_snapshot.meta.contactEmail ?? null,
      customer_name: ret.terms_snapshot.meta.customerName ?? null,
      seller_name: ret.terms_snapshot.meta.sellerName ?? null,
      order_ref: ret.order_ref,
      note: null,
      approved_at: null,
      sent_at: null,
      status: o.status,
      item_amount: p.b.itemAmount,
      discount_share: p.b.discountShare,
      shipping_refund: p.b.shippingRefund,
      return_shipping_deduction: p.b.returnShippingDeduction,
      ...this.planColumns(p),
      total: p.b.total,
      currency: p.currency,
      funded_by: seller ? 'seller' : 'official_store',
      seller_share: seller ? p.b.total : null,
      platform_share: seller ? null : p.b.total,
      reason_code: o.reasonCode ?? null,
      reason: o.reason ?? null,
      trust_report_id: null,
      approval_request_id: null,
      proposed_by: actorText(o.by.actor),
      approved_by: null,
      decline_reason: null,
      payment_refund_id: null,
      failed_reason: null,
      idempotency_key: null,
      created_at: now,
      updated_at: now,
    });
    await this.core.timeline(tx, ret.id, [
      {
        kind: 'refund_requested',
        label: o.status === 'under_review' ? 'Refund sent for review' : 'Refund decided',
        detail: `${rr.ref}: ${format(money(rr.total, rr.currency))} to ${p.destinationLabel}`,
        visibility: 'customer',
        actor: o.by.actor,
      },
    ]);
    return rr;
  }

  /** Exception refund from the order page (admin "Issue refund") */
  async createException(input: ExceptionRefundInput, by: By, idempotencyKey: string): Promise<RefundRequest> {
    const existing = (await this.repo.find('refund_requests', { idempotency_key: idempotencyKey }))[0];
    if (existing) return this.views.refundRequest(existing);
    const issues: { path: string; message: string }[] = [];
    if (!input.items.length) issues.push({ path: 'items', message: 'Choose the items to refund' });
    input.items.forEach((l, n) => {
      if (!Number.isInteger(l.amount.amount) || l.amount.amount <= 0) issues.push({ path: `items.${n}.amount`, message: 'Enter an amount above zero' });
      if (!Number.isInteger(l.quantity) || l.quantity < 1) issues.push({ path: `items.${n}.quantity`, message: 'At least one unit' });
    });
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'Say why the refund is issued' });
    if (issues.length) throw invalid(issues);
    const destination = input.destination ?? 'original_method';
    const order = await this.core.ctx.use('orders').getOrder(input.orderId);
    if (!order) throw notFound('Order');
    const groups = order.groups.filter((g) => g.items.some((i) => input.items.some((l) => l.orderItemId === i.id)));
    if (input.items.some((l) => !order.groups.some((g) => g.items.some((i) => i.id === l.orderItemId)))) throw invalidField('items', 'These items are not part of the order');
    if (groups.length !== 1) throw invalidField('items', 'Refund the items of one seller at a time');
    const group = groups[0]!;
    if (destination === 'store_credit' && (!this.core.walletOn() || !order.contact.customerId)) throw this.core.error('REMEDY_NOT_AVAILABLE', 'Store credit is not available', { remedy: 'store_credit' });
    const ids = input.items.map((l) => l.orderItemId);
    const live = await this.liveFor(order.id, ids);
    if (live) throw this.duplicate(live);
    const remaining = await this.views.amounts.remaining(order.id, ids, true);
    const over: { orderItemId: string; maxRefundable: common.Money }[] = [];
    let cap = 0;
    for (const l of input.items) {
      const rem = remaining?.items.get(l.orderItemId)?.remaining ?? 0;
      cap += rem;
      if (l.amount.amount > rem) over.push({ orderItemId: l.orderItemId, maxRefundable: money(rem, l.amount.currency) });
    }
    const shipping = input.shippingRefund?.amount ?? 0;
    const itemsTotal = input.items.reduce((s, l) => s + l.amount.amount, 0);
    const currency = input.items[0]!.amount.currency;
    if (over.length || itemsTotal + shipping > cap) throw this.core.error('REFUND_EXCEEDS_REFUNDABLE', 'The amount is above what can still be refunded for these items', { maxRefundable: money(cap, currency), items: over });
    const total = itemsTotal + shipping;
    // decided before anything is saved: a missing password (STEP_UP_REQUIRED) leaves no request behind
    const decision = await this.authorize(by, money(total, currency), input.reauthToken);
    const perItem = input.items.map((l, n) => ({ orderItemId: l.orderItemId, amount: l.amount.amount + (n === 0 ? shipping : 0) }));
    const sellerShare = input.fundedBy === 'seller' ? total : input.fundedBy === 'shared' ? Math.floor(total / 2) : null;
    const platformShare = input.fundedBy === 'platform' || input.fundedBy === 'official_store' ? total : input.fundedBy === 'shared' ? total - Math.floor(total / 2) : null;
    const now = this.core.now();
    const ref = await this.core.refundRef();
    const methodLabel = destination === 'store_credit' ? 'Marketly store credit' : order.progress.payment.methodLabel || 'Original payment method';
    const rr = await this.unlessSaved(decision, () => this.repo.insert('refund_requests', {
      id: newId(),
      ref,
      source: 'exception',
      return_id: null,
      case_id: null,
      order_id: order.id,
      order_item_ids: ids,
      items: Refunds.items(
        ids,
        perItem,
        input.items.map((l) => ({ orderItemId: l.orderItemId, quantity: l.quantity })),
        total,
      ),
      history: [this.ev('Refund proposed', input.reason, by.actor, now)],
      owner_type: group.seller.ownerType,
      seller_id: group.seller.ownerType === 'seller' ? (group.seller.id ?? null) : null,
      customer_id: order.contact.customerId ?? null,
      contact_email: order.contact.email ?? null,
      customer_name: order.contact.name ?? null,
      seller_name: group.seller.name ?? null,
      order_ref: order.ref,
      note: input.note ?? null,
      approved_at: null,
      sent_at: null,
      status: refundRequestMachine.next('requested', 'submitForReview'),
      item_amount: itemsTotal,
      discount_share: 0,
      shipping_refund: shipping,
      return_shipping_deduction: 0,
      deductions: [],
      destination,
      destination_label: methodLabel,
      max_refundable: cap,
      remedy_kind: 'exception',
      tax_refund: null,
      total,
      currency,
      funded_by: input.fundedBy,
      seller_share: sellerShare,
      platform_share: platformShare,
      reason_code: input.reasonCode,
      reason: input.reason.trim(),
      trust_report_id: input.trustReportId ?? null,
      approval_request_id: null,
      proposed_by: actorText(by.actor),
      approved_by: null,
      decline_reason: null,
      payment_refund_id: null,
      failed_reason: null,
      idempotency_key: idempotencyKey,
      created_at: now,
      updated_at: now,
    }));
    this.core.publish('returns.refund.requested', { refundRequestId: rr.id, orderId: rr.order_id, total: money(total, currency), source: 'exception' }, by);
    await this.core.audit(
      {
        action: 'returns.refund.issue',
        actionLabel: `Proposed refund ${rr.ref} of ${(total / 100).toFixed(2)} ${currency} on ${order.ref}`,
        category: 'financial',
        target: { type: 'refund_request', id: rr.id, ref: rr.ref, label: `Refund ${rr.ref}`, screen: 'admin/order' },
        relatedTargets: [{ type: 'order', id: order.id, ref: order.ref }],
        after: { ...input },
        reason: input.reason,
      },
      by,
    );
    await this.settle(rr.id, by, decision);
    return this.viewOf(rr.id);
  }

  /**
   * Refund requests from case decisions (support): Finance approval queue. Not tied to a return; when a
   * return carries the same case, the return completes once the refund is sent.
   */
  async requestRefund(input: {
    source: 'case' | 'exception';
    caseId?: string;
    orderId: string;
    orderItemIds: string[];
    items?: { orderItemId: string; quantity: number }[];
    breakdown: RefundBreakdown;
    fundedBy: string;
    reasonCode?: string;
    reason: string;
    proposedBy: common.Actor;
  }): Promise<RefundRequest> {
    // goodwill is store credit through wallet (decision D-RT3): never a card refund
    if (input.reasonCode === 'customer_goodwill') throw this.core.error('REMEDY_NOT_AVAILABLE', 'Goodwill is given as store credit, not as a refund', { remedy: 'goodwill_credit', reasonCode: input.reasonCode });
    const ids = [...new Set([...input.orderItemIds, ...(input.items ?? []).map((i) => i.orderItemId)])];
    if (!ids.length) throw invalidField('orderItemIds', 'Choose the items to refund');
    const b = input.breakdown;
    if (input.caseId) {
      // the same case decision asked again (retry): the request it already made
      const same = (await this.repo.find('refund_requests', { case_id: input.caseId, status: { op: 'not in', value: ['cancelled', 'declined'] } })).find(
        (r) => r.total === b.total.amount && r.order_item_ids.length === ids.length && r.order_item_ids.every((id) => ids.includes(id)),
      );
      if (same) return this.views.refundRequest(same);
    }
    const live = await this.liveFor(input.orderId, ids);
    if (live) throw this.duplicate(live);
    const order = await this.core.ctx.use('orders').getOrder(input.orderId);
    if (!order) throw notFound('Order');
    const all = order.groups.flatMap((g) => g.items.map((i) => ({ i, g })));
    const missing = ids.filter((id) => !all.some((x) => x.i.id === id));
    if (missing.length) throw invalid(missing.map((id) => ({ path: 'orderItemIds', message: `Item ${id} is not part of the order` })), 'These items are not part of the order');
    const groups = order.groups.filter((g) => g.items.some((i) => ids.includes(i.id)));
    if (groups.length !== 1) {
      throw new AppError('VALIDATION_FAILED', 'Refund the items of one seller at a time: make one request per seller group', {
        issues: [{ path: 'orderItemIds', message: 'The items belong to more than one seller group' }],
        groups: groups.map((g) => ({ groupId: g.id, ownerType: g.seller.ownerType, sellerId: g.seller.ownerType === 'seller' ? (g.seller.id ?? null) : null, orderItemIds: g.items.filter((i) => ids.includes(i.id)).map((i) => i.id) })),
      });
    }
    const group = groups[0]!;
    const quantities = ids.map((id) => {
      const item = all.find((x) => x.i.id === id)!.i;
      const asked = input.items?.find((x) => x.orderItemId === id)?.quantity;
      const quantity = asked ?? item.quantity;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > item.quantity) throw invalidField('items', `Refund 1 to ${item.quantity} units of ${item.title}`);
      return { orderItemId: id, quantity };
    });
    input = { ...input, orderItemIds: ids };
    const remaining = await this.views.amounts.remaining(order.id, input.orderItemIds, true);
    const cap = input.orderItemIds.reduce((s, id) => s + (remaining?.items.get(id)?.remaining ?? 0), 0);
    if (b.total.amount > cap) throw this.core.error('REFUND_EXCEEDS_REFUNDABLE', 'The amount is above what can still be refunded for these items', { maxRefundable: money(cap, b.total.currency) });
    const linked = input.caseId ? (await this.repo.find('returns', { case_id: input.caseId }))[0] : undefined;
    const weights = input.orderItemIds.map((id) => remaining?.items.get(id)?.remaining ?? 1);
    const totalW = weights.reduce((s, w) => s + w, 0) || 1;
    let left = b.total.amount;
    const perItem = input.orderItemIds.map((id, n) => {
      const amount = n === input.orderItemIds.length - 1 ? left : Math.floor((b.total.amount * weights[n]!) / totalW);
      left -= amount;
      return { orderItemId: id, amount };
    });
    const now = this.core.now();
    const ref = await this.core.refundRef();
    const fundedBy = ['seller', 'platform', 'shared', 'official_store'].includes(input.fundedBy) ? input.fundedBy : group.seller.ownerType === 'official' ? 'official_store' : 'seller';
    const rr = await this.repo.insert('refund_requests', {
      id: newId(),
      ref,
      source: input.source,
      return_id: linked?.id ?? null,
      case_id: input.caseId ?? null,
      order_id: order.id,
      order_item_ids: input.orderItemIds,
      items: Refunds.items(input.orderItemIds, perItem, quantities, b.total.amount),
      history: [this.ev('Refund proposed', input.reason, input.proposedBy, now)],
      owner_type: group.seller.ownerType,
      seller_id: group.seller.ownerType === 'seller' ? (group.seller.id ?? null) : null,
      customer_id: order.contact.customerId ?? null,
      contact_email: order.contact.email ?? null,
      customer_name: order.contact.name ?? null,
      seller_name: group.seller.name ?? null,
      order_ref: order.ref,
      note: null,
      approved_at: null,
      sent_at: null,
      status: refundRequestMachine.next('requested', 'submitForReview'),
      item_amount: b.itemAmount.amount,
      discount_share: b.discountShare.amount,
      shipping_refund: b.shippingRefund.amount,
      return_shipping_deduction: b.returnShippingDeduction.amount,
      deductions: b.deductions,
      destination: 'original_method',
      destination_label: b.destination || order.progress.payment.methodLabel || 'Original payment method',
      max_refundable: cap,
      remedy_kind: input.source,
      tax_refund: b.taxRefund?.amount ?? null,
      total: b.total.amount,
      currency: b.total.currency,
      funded_by: fundedBy,
      seller_share: fundedBy === 'seller' ? b.total.amount : fundedBy === 'shared' ? Math.floor(b.total.amount / 2) : null,
      platform_share: fundedBy === 'platform' || fundedBy === 'official_store' ? b.total.amount : fundedBy === 'shared' ? b.total.amount - Math.floor(b.total.amount / 2) : null,
      reason_code: input.reasonCode ?? null,
      reason: input.reason,
      trust_report_id: null,
      approval_request_id: null,
      proposed_by: actorText(input.proposedBy),
      approved_by: null,
      decline_reason: null,
      payment_refund_id: null,
      failed_reason: null,
      idempotency_key: null,
      created_at: now,
      updated_at: now,
    });
    if (linked) await this.core.timeline(this.repo, linked.id, [{ kind: 'refund_requested', label: 'Refund sent for review', detail: `${rr.ref} from case decision`, visibility: 'customer', actor: input.proposedBy }]);
    this.core.publish('returns.refund.requested', { refundRequestId: rr.id, orderId: rr.order_id, total: b.total, source: input.source }, { actor: input.proposedBy });
    // A case decision arrives in-process without the staff member's session, so neither their refund limit nor their
    // password can be confirmed here: it always waits for a refund approver (Finance) through an access approval request.
    await this.queue(rr, { actor: input.proposedBy }, null);
    return this.views.refundRequest((await this.repo.get('refund_requests', rr.id))!);
  }

  /* ---------------------------------------------------------------- approving and handing over */

  /*
   * The one decision path of every refund staff start (order-page exception, refund without return, the remedy after
   * inspection, a revised refund, and Finance's approve):
   *   1. authorize(), before anything is saved: what the caller's refund authority (access returns.refunds.approve)
   *      allows for the amount. Allowed above access stepUpAbove needs the caller's password again (reauthToken,
   *      purpose approval), else STEP_UP_REQUIRED, and since nothing is saved yet the same call can simply be repeated.
   *   2. settle(), once the request is saved: allowed → approved and handed to payments now; approval_required or
   *      denied → it stays under review with an access approval request routed to the refund approvers (Finance), so
   *      it shows in their Inbox. Denied (e.g. warehouse staff recording an inspection) never blocks the proposal:
   *      it only means the proposer cannot approve it themselves.
   * The approval request finishes in onApprovalDecided: approved → approved and handed over.
   */

  /** What the caller may do with a refund of this amount; claims the re-auth token when the amount needs it */
  async authorize(by: By, amount: common.Money, reauthToken?: string | null): Promise<RefundDecision> {
    const access = this.core.ctx.tryUse('access');
    if (!access || !by.principal) return { decision: 'unavailable', reason: null, claimed: null };
    const check = await access.check(by.principal, APPROVE_ACTION, { money: amount });
    if (check.decision !== 'allowed') return { decision: check.decision, reason: check.reason, claimed: null };
    const claimed = check.stepUpRequired ? await this.claimApprovalReauth(reauthToken, by) : null;
    return { decision: 'allowed', reason: check.reason, claimed };
  }

  /** Runs the save that follows authorize(); when it fails the claimed re-auth token works again for the retry */
  async unlessSaved<T>(d: RefundDecision, save: () => Promise<T>): Promise<T> {
    try {
      return await save();
    } catch (err) {
      await this.release(d);
      throw err;
    }
  }

  async release(d: RefundDecision | null): Promise<void> {
    if (d?.claimed) await this.core.soft('identity', 'release re-auth token', (i) => i.releaseReauthToken(d.claimed!));
  }

  /** Carries out authorize()'s answer on the saved request: approve and hand over now, or ask for approval */
  async settle(id: string, by: By, d: RefundDecision, note: string | null = null): Promise<void> {
    const rr = (await this.repo.get('refund_requests', id))!;
    if (d.decision !== 'allowed') return this.queue(rr, by, note);
    await this.unlessSaved(d, () => this.approveAndHandOver(id, by.actor, by, { note: note ?? d.reason }));
    await this.auditApproval(rr, by, null, note ?? d.reason);
  }

  /**
   * The request waits under review with an access approval request (access gives back the open one for the same
   * refund). Access routes it to the roles whose refund limit covers the amount, also when the requester has no
   * refund authority at all.
   */
  private async queue(rr: RefundRec, by: By, note: string | null): Promise<void> {
    const access = this.core.ctx.tryUse('access');
    if (!access) {
      // access is a core module; without it Finance still finds the request in GET /refunds?awaitingApproval=true
      this.core.ctx.log.warn({ refundRequestId: rr.id }, 'returns: no access module, refund waits without an approval request');
      return;
    }
    const req = await access.requestApproval({
      action: APPROVE_ACTION,
      target: { type: 'refund_request', id: rr.id, ref: rr.ref, label: `Refund ${rr.ref}`, sellerId: rr.seller_id, screen: REFUND_SCREEN },
      amount: money(rr.total, rr.currency),
      summary: `Refund ${rr.ref} of ${(rr.total / 100).toFixed(2)} ${rr.currency}`,
      details: { orderId: rr.order_id, orderRef: rr.order_ref, returnId: rr.return_id, caseId: rr.case_id, orderItemIds: rr.order_item_ids, fundedBy: rr.funded_by, source: rr.source },
      reason: note ?? rr.reason ?? 'Refund approval',
      // case decisions come in-process with only the staff member: the request is filed under their account
      requestedBy: by.principal ?? { kind: 'staff', accountId: by.actor.kind === 'staff' ? (by.actor.id ?? null) : null, sessionId: `returns:${by.actor.kind}` },
    });
    await this.repo.update('refund_requests', rr.id, { approval_request_id: req.id, updated_at: this.core.now() });
  }

  private async viewOf(id: string): Promise<RefundRequest> {
    const rr = (await this.repo.get('refund_requests', id))!;
    const agg = rr.return_id ? await this.core.load(rr.return_id) : undefined;
    return this.views.refundRequest(rr, 'admin', agg);
  }

  /** Finance approves (POST /refunds/{id}/approve) */
  async approve(id: string, body: { note?: string | null; reauthToken?: string | null }, by: By): Promise<RefundRequest> {
    const rr = await this.repo.get('refund_requests', id);
    if (!rr) throw notFound('Refund request');
    if (is(['processing', 'sent'], rr.status)) return this.viewOf(id);
    if (rr.status === 'approved') {
      if (!rr.payment_refund_id) await this.handOver(rr.id, actorFrom(rr.approved_by) ?? by.actor, by);
      return this.viewOf(id);
    }
    refundRequestMachine.next(rr.status as RefundStatus, 'approve');
    if (rr.source === 'seller') throw new AppError('ILLEGAL_TRANSITION', 'The seller approves refunds for its own returns', { from: rr.status });
    const access = this.core.ctx.tryUse('access');
    if (!access || !by.principal) throw new AppError('APPROVAL_REQUIRED', 'Refund approvals are unavailable right now', { action: APPROVE_ACTION, refundRequestId: rr.id });
    if (rr.approval_request_id) {
      const pending = await access.getApproval(rr.approval_request_id).catch(() => null);
      if (pending && ['pending', 'partially_approved'].includes(pending.status)) {
        const decided = await access.decide(rr.approval_request_id, by.principal, { kind: 'approve', ...(body.note ? { note: body.note } : {}), ...(body.reauthToken ? { reauthToken: body.reauthToken } : {}) });
        if (decided.status === 'approved') {
          await this.approveAndHandOver(rr.id, by.actor, by, { note: body.note ?? null });
          await this.auditApproval(rr, by, rr.approval_request_id, body.note ?? null);
          return this.viewOf(id);
        }
        // the approval is recorded on the pending request: answer with the request and its approval (FORMAT.md, Approval responses)
        return this.viewOf(id);
      }
    }
    // under review it waits for someone other than its proposer; with its approval request lapsed (expired or
    // cancelled) the proposer still cannot approve it alone, as access would refuse on the request
    const proposer = actorFrom(rr.proposed_by);
    if (rr.status === 'under_review' && proposer?.kind === by.actor.kind && proposer.id && proposer.id === by.actor.id) {
      throw new AppError('SELF_APPROVAL_NOT_ALLOWED', 'Someone else approves the refunds you propose', { refundRequestId: rr.id }, 403);
    }
    // the same path as a refund staff start: within the limit approved now (password again above stepUpAbove),
    // above it an approval request; saved pending approval it answers 200 with approval in the body (FORMAT.md)
    const d = await this.authorize(by, money(rr.total, rr.currency), body.reauthToken);
    // here the caller asks to approve: with no refund authority at all that is refused, not forwarded
    if (d.decision === 'denied') throw new AppError('FORBIDDEN', d.reason || 'You cannot approve refunds');
    await this.settle(rr.id, by, d, body.note ?? null);
    return this.viewOf(id);
  }

  /**
   * Whether the caller could approve each waiting request with POST /refunds/{id}/approve now (Finance list): the
   * approve permission and a refund limit covering the amount (access), and not the person who asked for its approval.
   * Above stepUpAbove the approve call still asks for the password.
   */
  async withCanApprove(items: RefundRequest[], by: By): Promise<RefundRequest[]> {
    const access = this.core.ctx.tryUse('access');
    const allowedToApprove = !!access && !!by.principal && (!by.can || (await by.can(APPROVE_ACTION)));
    const out: RefundRequest[] = [];
    for (const r of items) {
      let ok = allowedToApprove && is(['requested', 'under_review'], r.status) && r.source !== 'seller';
      if (ok) {
        const check = await this.core.soft('access', 'refund authority', (a) => a.check(by.principal!, APPROVE_ACTION, { money: r.breakdown.total }));
        ok = check?.decision === 'allowed';
      }
      const requestId = r.approval?.approvalRequestId;
      if (ok) {
        // the person who asked for the approval cannot decide it (access refuses SELF_APPROVAL_NOT_ALLOWED), nor can the
        // proposer once that request lapsed (approve refuses the same way)
        const req = requestId ? await this.core.soft('access', 'approval request', (a) => a.getApproval(requestId)) : null;
        if (req && ['pending', 'partially_approved'].includes(req.status)) ok = req.requestedBy?.id !== by.actor.id;
        else if (r.status === 'under_review') ok = r.proposedBy?.id !== by.actor.id;
      }
      out.push({ ...r, canApprove: ok });
    }
    return out;
  }

  /** Claims the approver's re-auth token (single use, issued for purpose approval to this session); STEP_UP_REQUIRED otherwise */
  private async claimApprovalReauth(token: string | null | undefined, by: By): Promise<string> {
    const refuse = () => new AppError('STEP_UP_REQUIRED', 'Enter your password again to approve this refund', { kind: 'reauth', purpose: 'approval' });
    const identity = this.core.ctx.tryUse('identity');
    if (!token || !identity || !by.principal) throw refuse();
    if (!(await identity.verifyReauthToken(by.principal, token, 'approval'))) throw refuse();
    if (!(await identity.consumeReauthToken(token))) throw refuse();
    return token;
  }

  private async auditApproval(rr: RefundRec, by: By, approvalRequestId: string | null, note: string | null) {
    await this.core.audit(
      {
        action: 'returns.refund.approve',
        actionLabel: `Approved refund ${rr.ref} of ${(rr.total / 100).toFixed(2)} ${rr.currency}`,
        category: 'financial',
        target: { type: 'refund_request', id: rr.id, ref: rr.ref, label: `Refund ${rr.ref}`, screen: REFUND_SCREEN },
        before: { status: rr.status },
        after: { status: 'approved' },
        approvalRequestId,
        approvalNote: approvalRequestId ? null : note,
      },
      by,
    );
  }

  /**
   * requested | under_review → approved, then hand over: payments.startRefund (or wallet.creditRefund for
   * store credit) and → processing (store credit: → sent). Publishes returns.refund.approved once handed over.
   */
  async approveAndHandOver(id: string, approver: common.Actor, by: By, o: { note?: string | null } = {}): Promise<void> {
    const now = this.core.now();
    await this.repo.transaction(async (tx) => {
      const rr = await tx.get('refund_requests', id, { forUpdate: true });
      if (!rr) throw notFound('Refund request');
      if (rr.status === 'approved') return; // a hand-over that did not go through is retried below
      const status = refundRequestMachine.next(rr.status as RefundStatus, 'approve');
      const approved = await tx.update('refund_requests', id, { status, approved_by: actorText(approver), approved_at: now, updated_at: now });
      await tx.addRefundEvents(id, [this.ev('Refund approved', o.note ?? null, approver, now)]);
      if (approved.return_id) await this.core.timeline(tx, approved.return_id, [{ kind: 'refund_approved', label: 'Refund approved', detail: "Approved, not sent yet. We'll tell you when the money is on its way.", visibility: 'customer', actor: approver }]);
    });
    await this.handOver(id, approver, by);
  }

  /** approved → processing through payments (or sent through wallet); idempotent per refund request */
  async handOver(id: string, approver: common.Actor, by: By): Promise<void> {
    const rr = (await this.repo.get('refund_requests', id))!;
    if (rr.status !== 'approved' || rr.payment_refund_id) return;
    const items = rr.items.filter((i) => i.amount > 0).map((i) => ({ orderItemId: i.orderItemId, amount: money(i.amount, rr.currency) }));
    let paymentRefundId: string;
    let credited = false;
    if (rr.destination === 'store_credit') {
      const wallet = this.core.ctx.tryUse('wallet');
      if (!wallet || !rr.customer_id) throw this.core.error('REMEDY_NOT_AVAILABLE', 'Store credit is not available', { remedy: 'store_credit' });
      const entry = await wallet.creditRefund({ customerId: rr.customer_id, refundId: rr.id, orderId: rr.order_id, amount: money(rr.total, rr.currency), reason: rr.reason ?? `Refund ${rr.ref}` }, `refund-request:${rr.id}`);
      paymentRefundId = (entry as { id: string }).id;
      credited = true;
    } else {
      const origin = rr.source === 'case' ? 'case' : rr.source === 'exception' ? 'exception' : 'return';
      const ret = rr.return_id ? await this.repo.get('returns', rr.return_id) : undefined;
      const refund = await this.core.ctx.use('payments').startRefund(
        { orderId: rr.order_id, origin, originId: rr.id, originRef: ret?.ref ?? rr.ref, requestRef: rr.ref, items, destination: 'original_method', reason: rr.reason ?? (ret ? `Return ${ret.ref}` : `Refund ${rr.ref}`), requestedBy: approver },
        `refund-request:${rr.id}`,
      );
      paymentRefundId = refund.id;
    }
    const now = this.core.now();
    const batch = new Batch(by);
    const after = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('refund_requests', id, { forUpdate: true }))!;
      if (locked.status !== 'approved') return null;
      let status = refundRequestMachine.next('approved', 'handOver');
      // store credit is added by wallet at once: approved → processing → sent in this call
      if (credited) status = refundRequestMachine.next(status, 'confirmSent');
      const updated = await tx.update('refund_requests', id, { status, payment_refund_id: paymentRefundId, updated_at: now, sent_at: credited ? now : null });
      await tx.addRefundEvents(id, [this.ev(credited ? 'Store credit issued' : 'Handed to payments', null, SYSTEM, now)]);
      if (updated.return_id) {
        await this.core.timeline(tx, updated.return_id, [{ kind: credited ? 'refund_sent' : 'refund_processing', label: credited ? 'Store credit issued' : 'Refund processing', detail: credited ? `${(updated.total / 100).toFixed(2)} ${updated.currency} added to your store credit` : 'Your refund is on its way to your payment provider.', visibility: 'customer' }]);
        if (credited) await this.completeLinked(tx, updated, batch);
      }
      return updated;
    });
    if (!after) return;
    const ret = after.return_id ? await this.repo.get('returns', after.return_id) : null;
    const recipient = await this.core.refundRecipient(after, ret);
    this.core.publish(
      'returns.refund.approved',
      {
        refundRequestId: after.id,
        returnId: after.return_id,
        caseId: after.case_id,
        orderId: after.order_id,
        // the refund notice opens the return, the case or the order: it carries that record's reference
        orderRef: ret?.order_ref ?? after.order_ref ?? null,
        returnRef: ret?.ref ?? null,
        caseRef: after.case_id ? await this.caseRef(after.order_id, after.case_id) : null,
        ...recipient,
        orderItemIds: after.order_item_ids,
        items: await this.itemsOf(after),
        ownerType: after.owner_type,
        sellerId: after.seller_id,
        source: after.source as RefundRequest['source'],
        trustReportId: after.trust_report_id,
        total: money(after.total, after.currency),
        breakdown: this.views.breakdown(after),
        fundedBy: after.funded_by,
        sellerShare: after.seller_share === null ? null : money(after.seller_share, after.currency),
        platformShare: after.platform_share === null ? null : money(after.platform_share, after.currency),
        approvedBy: approver,
      },
      by,
    );
    if (after.return_id) await this.approveException(after.return_id, approver, by);
    this.core.flush(batch);
  }

  /** CS- reference of a support case of the order (null when support is off or does not answer) */
  private async caseRef(orderId: string, caseId: string): Promise<string | null> {
    const support = this.core.ctx.tryUse('support');
    if (!support) return null;
    const cases = await this.core.quiet('case reference', () => support.casesForOrder(orderId));
    return cases?.find((c) => c.caseId === caseId)?.ref ?? null;
  }

  /** Refunded quantity per item: stored on the request, else the return's units, else one unit per item */
  async itemsOf(rr: RefundRec): Promise<{ orderItemId: string; quantity: number }[]> {
    const returned = rr.items.some((i) => i.quantity === null) && rr.return_id ? await this.repo.find('return_items', { return_id: rr.return_id }) : [];
    return rr.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity ?? returned.find((x) => x.order_item_id === i.orderItemId)?.quantity ?? 1 }));
  }

  /** A proposed refund-without-return is approved together with its refund */
  private async approveException(returnId: string, approver: common.Actor, by: By) {
    const ret = await this.repo.get('returns', returnId);
    if (!ret?.exception || ret.exception.approvedBy) return;
    const now = this.core.now();
    await this.repo.update('returns', returnId, { exception: { ...ret.exception, approvedBy: approver, approvedAt: now.toISOString() }, updated_at: now });
    await this.core.timeline(this.repo, returnId, [{ kind: 'exception_approved', label: 'Refund without return approved', detail: ret.exception.details, visibility: 'staff', actor: approver }]);
    this.core.publish('returns.exception.approved', { returnId, reasonCode: ret.exception.reasonCode, approvedBy: approver }, by);
  }

  /** Completes the return a sent refund belongs to (the return's own, or the return linked to the case) */
  async completeLinked(tx: ReturnsRepository, rr: RefundRec, batch: Batch): Promise<void> {
    let ret: ReturnRec | undefined = rr.return_id ? await tx.get('returns', rr.return_id, { forUpdate: true }) : undefined;
    if (!ret && rr.case_id) ret = (await tx.find('returns', { case_id: rr.case_id, status: 'awaiting_remedy' }, { forUpdate: true }))[0];
    if (!ret || ret.status !== 'awaiting_remedy') return;
    const outcome = OUTCOME[rr.remedy_kind] ?? (rr.destination === 'store_credit' ? 'credited' : 'refunded');
    const now = this.core.now();
    await tx.update('returns', ret.id, { status: returnMachine.next(ret.status as ReturnStatus, 'complete'), completed_at: now, updated_at: now, terms_snapshot: { ...ret.terms_snapshot, meta: { ...ret.terms_snapshot.meta, outcome } } });
    await this.core.timeline(tx, ret.id, [{ kind: 'completed', label: outcome === 'partly_refunded' ? 'Partly refunded' : outcome === 'credited' ? 'Refunded as store credit' : 'Refunded', visibility: 'customer' }]);
    batch.push('returns.return.completed', { returnId: ret.id, ...this.core.refs(ret), outcome });
  }

  /* ---------------------------------------------------------------- cancelling (appeal overturned the case decision) */

  /**
   * Cancels the case's refund requests that have not been approved (requested, under review, declined).
   * Approved, processing, sent and failed ones are money already moving: they come back in notCancellable.
   * Already cancelled ones are left out, so a second call changes nothing.
   */
  async cancelForCase(caseId: string, reason: string, actor: common.Actor = SYSTEM): Promise<{ cancelled: RefundRequest[]; notCancellable: RefundRequest[] }> {
    if (!isUuid(caseId)) return { cancelled: [], notCancellable: [] };
    const why = reason?.trim() || 'The case decision was overturned on appeal';
    const by: By = { actor: actor ?? SYSTEM };
    const now = this.core.now();
    const { cancelled, kept } = await this.repo.transaction(async (tx) => {
      const rows = await tx.find('refund_requests', { case_id: caseId }, { orderBy: [['created_at', 'asc']], forUpdate: true });
      const cancelled: { before: RefundRec; after: RefundRec }[] = [];
      const kept: RefundRec[] = [];
      for (const rr of rows) {
        if (rr.status === 'cancelled') continue;
        if (!refundRequestMachine.can(rr.status as RefundStatus, 'cancel')) {
          kept.push(rr);
          continue;
        }
        await tx.addRefundEvents(rr.id, [this.ev('Refund cancelled', why, by.actor, now)]);
        const after = await tx.update('refund_requests', rr.id, { status: refundRequestMachine.next(rr.status as RefundStatus, 'cancel'), approval_request_id: null, updated_at: now });
        if (after.return_id) await this.core.timeline(tx, after.return_id, [{ kind: 'refund_cancelled', label: `Refund ${after.ref} cancelled`, detail: why, visibility: 'staff', actor: by.actor }]);
        cancelled.push({ before: rr, after });
      }
      return { cancelled, kept };
    });
    for (const { before, after } of cancelled) {
      if (before.approval_request_id) await this.core.soft('access', 'cancel approval', (a) => a.cancelApproval(before.approval_request_id!, by.actor, 'Refund cancelled: case decision overturned'));
      this.core.publish(
        'returns.refund.cancelled',
        { refundRequestId: after.id, ref: after.ref, orderId: after.order_id, caseId: after.case_id, returnId: after.return_id, total: money(after.total, after.currency), reason: why, by: by.actor },
        by,
      );
      await this.core.audit(
        { action: 'returns.refund.cancel', actionLabel: `Cancelled refund ${after.ref}`, category: 'financial', target: { type: 'refund_request', id: after.id, ref: after.ref, label: `Refund ${after.ref}` }, before: { status: before.status }, after: { status: after.status }, reason: why },
        by,
      );
    }
    const views = await this.views.refundRequests([...cancelled.map((c) => c.after), ...kept]);
    return { cancelled: views.slice(0, cancelled.length), notCancellable: views.slice(cancelled.length) };
  }

  /* ---------------------------------------------------------------- decline and revise */

  async decline(id: string, reason: string, by: By): Promise<RefundRequest> {
    if (!reason?.trim()) throw invalidField('reason', 'Say why the refund is sent back');
    const now = this.core.now();
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.get('refund_requests', id, { forUpdate: true });
      if (!before) throw notFound('Refund request');
      const status = refundRequestMachine.next(before.status as RefundStatus, 'decline');
      await tx.addRefundEvents(id, [this.ev('Refund sent back', reason.trim(), by.actor, now)]);
      const after = await tx.update('refund_requests', id, { status, decline_reason: reason.trim(), approval_request_id: null, updated_at: now });
      if (after.return_id) await this.core.timeline(tx, after.return_id, [{ kind: 'refund_declined', label: 'Refund sent back by Finance', detail: reason.trim(), visibility: 'staff', actor: by.actor }]);
      return { before, after };
    });
    if (before.approval_request_id) await this.core.soft('access', 'cancel approval', (a) => a.cancelApproval(before.approval_request_id!, by.actor, 'Refund sent back'));
    this.core.publish('returns.refund.declined', { refundRequestId: id, reason: reason.trim() }, by);
    await this.core.audit({ action: 'returns.refund.decline', actionLabel: `Sent back refund ${after.ref}`, category: 'financial', target: { type: 'refund_request', id, ref: after.ref, label: `Refund ${after.ref}` }, before: { status: before.status }, after: { status: after.status }, reason }, by);
    return this.viewOf(id);
  }

  /**
   * Change a declined request and resubmit it. A declined request had been waiting for someone else's approval, so
   * the resubmission always goes back to the approvers (an access approval request in the reviser's name, who then
   * cannot approve it): approving it within the reviser's own limit would let whoever proposed a refund that waits
   * for Finance send it back and push it through alone, or overrule the person who sent it back.
   */
  async revise(id: string, remedy: RemedyInput, by: By): Promise<RefundRequest> {
    const rr = await this.repo.get('refund_requests', id);
    if (!rr) throw notFound('Refund request');
    refundRequestMachine.next(rr.status as RefundStatus, 'revise');
    if (!['full_refund', 'partial_refund', 'store_credit'].includes(remedy.kind)) throw invalidField('kind', 'A refund request can only be revised into a refund');
    let p: RefundPlan | null = null;
    if (rr.return_id) {
      const agg = await this.core.load(rr.return_id);
      if (agg) p = await this.plan(agg, remedy, { except: rr.id });
    }
    this.revised(rr, remedy, p); // the new amount is checked before anything is saved
    const decision: RefundDecision = { decision: 'approval_required', reason: 'A refund that was sent back needs another approver', claimed: null };
    const now = this.core.now();
    const after = await this.unlessSaved(decision, () =>
      this.repo.transaction(async (tx) => {
        const locked = (await tx.get('refund_requests', id, { forUpdate: true }))!;
        const status = refundRequestMachine.next(locked.status as RefundStatus, 'revise');
        const { patch, items } = this.revised(locked, remedy, p);
        await tx.setRefundItems(id, items);
        await tx.addRefundEvents(id, [this.ev('Refund revised and resubmitted', remedy.explanation ?? null, by.actor, now)]);
        // the reviser proposes the resubmitted refund (the first proposal stays in its history)
        const updated = await tx.update('refund_requests', id, { ...patch, status, decline_reason: null, proposed_by: actorText(by.actor), updated_at: now });
        if (updated.return_id) await this.core.timeline(tx, updated.return_id, [{ kind: 'refund_revised', label: 'Refund revised', detail: remedy.explanation ?? null, visibility: 'staff', actor: by.actor }]);
        return updated;
      }),
    );
    this.core.publish('returns.refund.requested', { refundRequestId: id, orderId: after.order_id, total: money(after.total, after.currency), source: after.source }, by);
    await this.core.audit({ action: 'returns.refund.revise', actionLabel: `Revised refund ${after.ref}`, category: 'financial', target: { type: 'refund_request', id, ref: after.ref, label: `Refund ${after.ref}` }, before: { total: rr.total, status: rr.status }, after: { total: after.total, status: after.status } }, by);
    await this.settle(id, by, decision, remedy.explanation ?? null);
    return this.viewOf(id);
  }

  /** The amounts of a revised request: a return's refund from its new plan; case and exception refunds from the asked amount */
  private revised(row: RefundRec, remedy: RemedyInput, p: RefundPlan | null): { patch: Partial<RefundRec>; items: RefundItem[] } {
    if (p) {
      return {
        patch: {
          item_amount: p.b.itemAmount,
          discount_share: p.b.discountShare,
          shipping_refund: p.b.shippingRefund,
          return_shipping_deduction: p.b.returnShippingDeduction,
          total: p.b.total,
          seller_share: row.seller_share === null ? null : p.b.total,
          platform_share: row.platform_share === null ? null : p.b.total,
          ...this.planColumns(p),
        },
        items: Refunds.items(row.order_item_ids, p.b.perItem, row.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity ?? 0 })).filter((q) => q.quantity > 0), p.b.total),
      };
    }
    // case and exception refunds: the amount is the asked partial amount within the stored cap
    const deductions = remedy.deductions ?? [];
    const full = row.item_amount - row.discount_share + row.shipping_refund - row.return_shipping_deduction;
    const total = remedy.amount?.amount ?? Math.max(0, full - deductions.reduce((s, d) => s + d.amount.amount, 0));
    if (total > row.max_refundable) throw this.core.error('REFUND_EXCEEDS_REFUNDABLE', 'The amount is above what can still be refunded for these items', { maxRefundable: money(row.max_refundable, row.currency) });
    const ratio = row.total > 0 ? total / row.total : 0;
    const items = row.items.map((x) => ({ ...x, amount: Math.floor(x.amount * ratio) }));
    const sum = items.reduce((s, x) => s + x.amount, 0);
    if (items.length) items[0]!.amount += total - sum;
    return { patch: { total, deductions }, items };
  }

  /* ---------------------------------------------------------------- payments mirrors */

  private async byPayment(refundId: string, originId: string | null | undefined): Promise<RefundRec | undefined> {
    if (isUuid(originId)) {
      const byOrigin = await this.repo.get('refund_requests', originId);
      if (byOrigin) return byOrigin;
    }
    return (await this.repo.find('refund_requests', { payment_refund_id: refundId }))[0];
  }

  async onSent(e: EventPayload<'payments.refund.sent'>): Promise<void> {
    const rr = await this.byPayment(e.refundId, e.originId);
    if (!rr) return;
    const batch = new Batch({ actor: SYSTEM });
    await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('refund_requests', rr.id, { forUpdate: true }))!;
      if (locked.status === 'sent') return;
      let status = locked.status as RefundStatus;
      if (status === 'approved') status = refundRequestMachine.next(status, 'handOver');
      if (status === 'failed') status = refundRequestMachine.next(status, 'retry');
      if (status !== 'processing') {
        this.core.ctx.log.warn({ refundRequestId: rr.id, status: locked.status }, 'returns: refund sent for a request that is not processing');
        return;
      }
      status = refundRequestMachine.next(status, 'confirmSent');
      await tx.addRefundEvents(rr.id, [this.ev('Refund sent', `To ${e.destination}`, SYSTEM, e.sentAt)]);
      const updated = await tx.update('refund_requests', rr.id, { status, payment_refund_id: locked.payment_refund_id ?? e.refundId, failed_reason: null, updated_at: this.core.now(), sent_at: new Date(e.sentAt) });
      if (updated.return_id) await this.core.timeline(tx, updated.return_id, [{ kind: 'refund_sent', label: 'Refund sent', detail: `Sent to ${e.destination}. Banks usually show it in 3–5 business days.`, visibility: 'customer' }]);
      await this.completeLinked(tx, updated, batch);
    });
    this.core.flush(batch);
  }

  async onFailed(e: EventPayload<'payments.refund.failed'>): Promise<void> {
    const rr = await this.byPayment(e.refundId, e.originId);
    if (!rr) return;
    await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('refund_requests', rr.id, { forUpdate: true }))!;
      if (locked.status === 'failed' && locked.failed_reason === e.reason) return;
      let status = locked.status as RefundStatus;
      if (status === 'approved') status = refundRequestMachine.next(status, 'handOver');
      if (status !== 'processing' && status !== 'failed') return;
      if (status === 'processing') status = refundRequestMachine.next(status, 'fail');
      const now = this.core.now();
      await tx.addRefundEvents(rr.id, [this.ev('Refund failed', e.reason, SYSTEM, now)]);
      const updated = await tx.update('refund_requests', rr.id, { status, failed_reason: e.reason, payment_refund_id: locked.payment_refund_id ?? e.refundId, updated_at: now });
      if (updated.return_id) {
        await this.core.timeline(tx, updated.return_id, [
          { kind: 'refund_failed', label: 'Refund could not be sent yet', detail: e.finalAttempt ? 'Marketly support will contact you.' : 'We are retrying.', visibility: 'customer' },
          { kind: 'refund_failed', label: 'Refund failed', detail: `${e.reason} (attempt ${e.attempts})`, visibility: 'staff' },
        ]);
      }
    });
  }

  /** access.approval.decided for a refund approval */
  async onApprovalDecided(e: EventPayload<'access.approval.decided'>): Promise<void> {
    const rr = isUuid(e.target.id) ? await this.repo.get('refund_requests', e.target.id) : undefined;
    if (!rr || (rr.approval_request_id && rr.approval_request_id !== e.requestId)) return;
    const by: By = { actor: e.decidedBy ?? SYSTEM };
    if (e.outcome === 'approved') {
      if (rr.status === 'approved' && !rr.payment_refund_id) return this.handOver(rr.id, e.decidedBy ?? SYSTEM, by);
      if (!refundRequestMachine.can(rr.status as RefundStatus, 'approve')) return;
      await this.approveAndHandOver(rr.id, e.decidedBy ?? SYSTEM, by, { note: e.reason ?? 'Approved through access' });
      return;
    }
    if (e.outcome === 'rejected' && rr.status === 'under_review') {
      await this.decline(rr.id, e.reason?.trim() || 'Not approved', by).catch((err) => {
        if (!isAppError(err)) throw err;
      });
      return;
    }
    if (rr.approval_request_id === e.requestId) await this.repo.update('refund_requests', rr.id, { approval_request_id: null, updated_at: this.core.now() });
  }

  /** Job helper: approved requests whose hand-over did not go through */
  async retryHandOvers(): Promise<void> {
    const cutoff = new Date(this.core.now().getTime() - 5 * 60_000);
    const stuck = await this.repo.find('refund_requests', { status: 'approved', payment_refund_id: null, updated_at: { op: '<', value: cutoff } }, { limit: 50 });
    for (const rr of stuck) {
      try {
        await this.handOver(rr.id, actorFrom(rr.approved_by) ?? SYSTEM, { actor: SYSTEM });
      } catch (err) {
        this.core.ctx.log.warn({ err, refundRequestId: rr.id }, 'returns: refund hand-over retry failed');
      }
    }
  }
}
