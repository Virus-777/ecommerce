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
import type { RefundExtras, RefundRec, ReturnRec, ReturnsRepository } from '../ports.js';
import { Batch, invalid, invalidField, notFound, SYSTEM, type Agg, type By, type Core } from './core.js';
import type { Views } from './views.js';

export const APPROVE_ACTION = 'returns.refunds.approve';
const OUTCOME: Record<string, 'refunded' | 'partly_refunded' | 'credited'> = { partial_refund: 'partly_refunded', store_credit: 'credited' };

export interface RefundPlan {
  b: BreakdownResult;
  deductions: RefundDeduction[];
  destination: 'original_method' | 'store_credit';
  destinationLabel: string;
  kind: string;
  currency: string;
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

  private extras(p: RefundPlan, x: Partial<RefundExtras> = {}): RefundExtras {
    return { list: p.deductions, destination: p.destination, destinationLabel: p.destinationLabel, maxRefundable: p.b.maxRefundable, kind: p.kind, perItem: p.b.perItem, history: [], ...x };
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
      owner_type: ret.owner_type,
      seller_id: ret.seller_id,
      status: o.status,
      item_amount: p.b.itemAmount,
      discount_share: p.b.discountShare,
      shipping_refund: p.b.shippingRefund,
      return_shipping_deduction: p.b.returnShippingDeduction,
      deductions: this.extras(p, { customerId: ret.customer_id, customerName: ret.terms_snapshot.meta.customerName, sellerName: ret.terms_snapshot.meta.sellerName, orderRef: ret.order_ref }),
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
    const perItem = input.items.map((l, n) => ({ orderItemId: l.orderItemId, amount: l.amount.amount + (n === 0 ? shipping : 0) }));
    const sellerShare = input.fundedBy === 'seller' ? total : input.fundedBy === 'shared' ? Math.floor(total / 2) : null;
    const platformShare = input.fundedBy === 'platform' || input.fundedBy === 'official_store' ? total : input.fundedBy === 'shared' ? total - Math.floor(total / 2) : null;
    const now = this.core.now();
    const ref = await this.core.refundRef();
    const methodLabel = destination === 'store_credit' ? 'Marketly store credit' : order.progress.payment.methodLabel || 'Original payment method';
    const rr = await this.repo.insert('refund_requests', {
      id: newId(),
      ref,
      source: 'exception',
      return_id: null,
      case_id: null,
      order_id: order.id,
      order_item_ids: ids,
      owner_type: group.seller.ownerType,
      seller_id: group.seller.ownerType === 'seller' ? (group.seller.id ?? null) : null,
      status: refundRequestMachine.next('requested', 'submitForReview'),
      item_amount: itemsTotal,
      discount_share: 0,
      shipping_refund: shipping,
      return_shipping_deduction: 0,
      deductions: {
        list: [],
        destination,
        destinationLabel: methodLabel,
        maxRefundable: cap,
        kind: 'exception',
        perItem,
        customerId: order.contact.customerId ?? null,
        customerName: order.contact.name,
        sellerName: group.seller.name,
        orderRef: order.ref,
        note: input.note ?? null,
        history: [{ at: now.toISOString(), label: 'Refund proposed', detail: input.reason, actor: by.actor }],
      },
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
    });
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
    return this.decideOrQueue(rr, by, null);
  }

  /**
   * Refund requests from case decisions (support): Finance approval queue. Not tied to a return; when a
   * return carries the same case, the return completes once the refund is sent.
   */
  async requestRefund(input: { source: 'case' | 'exception'; caseId?: string; orderId: string; orderItemIds: string[]; breakdown: RefundBreakdown; fundedBy: string; reason: string; proposedBy: common.Actor }): Promise<RefundRequest> {
    if (!input.orderItemIds.length) throw invalidField('orderItemIds', 'Choose the items to refund');
    if (input.caseId) {
      const same = (await this.repo.find('refund_requests', { case_id: input.caseId, status: LIVE_REFUND })).find((r) => r.order_item_ids.length === input.orderItemIds.length && r.order_item_ids.every((id) => input.orderItemIds.includes(id)));
      if (same) return this.views.refundRequest(same);
    }
    const live = await this.liveFor(input.orderId, input.orderItemIds);
    if (live) throw this.duplicate(live);
    const order = await this.core.ctx.use('orders').getOrder(input.orderId);
    if (!order) throw notFound('Order');
    const group = order.groups.find((g) => g.items.some((i) => input.orderItemIds.includes(i.id))) ?? order.groups[0];
    if (!group) throw notFound('Order items');
    const b = input.breakdown;
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
      owner_type: group.seller.ownerType,
      seller_id: group.seller.ownerType === 'seller' ? (group.seller.id ?? null) : null,
      status: refundRequestMachine.next('requested', 'submitForReview'),
      item_amount: b.itemAmount.amount,
      discount_share: b.discountShare.amount,
      shipping_refund: b.shippingRefund.amount,
      return_shipping_deduction: b.returnShippingDeduction.amount,
      deductions: {
        list: b.deductions,
        destination: 'original_method',
        destinationLabel: b.destination || order.progress.payment.methodLabel || 'Original payment method',
        maxRefundable: cap,
        kind: input.source,
        perItem,
        customerId: order.contact.customerId ?? null,
        customerName: order.contact.name,
        sellerName: group.seller.name,
        orderRef: order.ref,
        history: [{ at: now.toISOString(), label: 'Refund proposed', detail: input.reason, actor: input.proposedBy }],
      },
      total: b.total.amount,
      currency: b.total.currency,
      funded_by: fundedBy,
      seller_share: fundedBy === 'seller' ? b.total.amount : fundedBy === 'shared' ? Math.floor(b.total.amount / 2) : null,
      platform_share: fundedBy === 'platform' || fundedBy === 'official_store' ? b.total.amount : fundedBy === 'shared' ? b.total.amount - Math.floor(b.total.amount / 2) : null,
      reason_code: null,
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
    return this.views.refundRequest(rr);
  }

  /* ---------------------------------------------------------------- approving and handing over */

  /** Within the caller's limit: approve now; above it: an access approval request (the request stays under review) */
  private async decideOrQueue(rr: RefundRec, by: By, note: string | null): Promise<RefundRequest> {
    const access = this.core.ctx.tryUse('access');
    if (access && by.principal) {
      const check = await access.check(by.principal, APPROVE_ACTION, { money: money(rr.total, rr.currency) });
      if (check.decision === 'allowed') {
        await this.approveAndHandOver(rr.id, by.actor, by, { note: note ?? check.reason });
        return this.viewOf(rr.id);
      }
      if (check.decision === 'approval_required') {
        const req = await access.requestApproval({
          action: APPROVE_ACTION,
          target: { type: 'refund_request', id: rr.id, ref: rr.ref, label: `Refund ${rr.ref}`, sellerId: rr.seller_id, screen: 'admin/refunds' },
          amount: money(rr.total, rr.currency),
          summary: `Refund ${rr.ref} of ${(rr.total / 100).toFixed(2)} ${rr.currency}`,
          details: { orderId: rr.order_id, orderItemIds: rr.order_item_ids, fundedBy: rr.funded_by },
          reason: rr.reason ?? 'Refund approval',
          requestedBy: by.principal,
        });
        await this.repo.update('refund_requests', rr.id, { approval_request_id: req.id, updated_at: this.core.now() });
      }
    }
    return this.viewOf(rr.id);
  }

  private async viewOf(id: string): Promise<RefundRequest> {
    const rr = (await this.repo.get('refund_requests', id))!;
    const agg = rr.return_id ? await this.core.load(rr.return_id) : undefined;
    return this.views.refundRequest(rr, 'admin', agg);
  }

  /** Finance approves (POST /refunds/{id}/approve) */
  async approve(id: string, body: { note?: string | null; stepUpCode?: string | null }, by: By): Promise<RefundRequest> {
    const rr = await this.repo.get('refund_requests', id);
    if (!rr) throw notFound('Refund request');
    if (is(['processing', 'sent'], rr.status)) return this.viewOf(id);
    if (rr.status === 'approved') {
      if (!rr.payment_refund_id) await this.handOver(rr.id, actorFrom(rr.approved_by) ?? by.actor, by);
      return this.viewOf(id);
    }
    refundRequestMachine.next(rr.status as RefundStatus, 'approve');
    if (rr.source === 'seller') throw new AppError('ILLEGAL_TRANSITION', 'The seller approves refunds for its own returns', { from: rr.status });
    if (body.stepUpCode && by.principal?.accountId) {
      const ok = await this.core.soft('identity', 'step-up', (i) => i.verifyStepUp(by.principal!.accountId!, { code: body.stepUpCode! }));
      if (ok === false) throw new AppError('STEP_UP_REQUIRED', 'The 2-step code is not valid', { kind: 'code', purpose: APPROVE_ACTION });
    }
    const access = this.core.ctx.tryUse('access');
    if (!access || !by.principal) throw new AppError('APPROVAL_REQUIRED', 'Refund approvals are unavailable right now', { action: APPROVE_ACTION, refundRequestId: rr.id });
    if (rr.approval_request_id) {
      const pending = await access.getApproval(rr.approval_request_id).catch(() => null);
      if (pending && ['pending', 'partially_approved'].includes(pending.status)) {
        const decided = await access.decide(rr.approval_request_id, by.principal, { kind: 'approve', ...(body.note ? { note: body.note } : {}), ...(body.stepUpCode ? { stepUpCode: body.stepUpCode } : {}) });
        if (decided.status === 'approved') {
          await this.approveAndHandOver(rr.id, by.actor, by, { note: body.note ?? null });
          await this.auditApproval(rr, by, rr.approval_request_id, body.note ?? null);
          return this.viewOf(id);
        }
        throw new AppError('APPROVAL_REQUIRED', 'Your approval is recorded; another approver must also approve this refund', { approvalRequestId: rr.approval_request_id, refundRequestId: rr.id });
      }
    }
    const check = await access.check(by.principal, APPROVE_ACTION, { money: money(rr.total, rr.currency) });
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'You cannot approve refunds');
    if (check.decision === 'approval_required') {
      const req = await access.requestApproval({
        action: APPROVE_ACTION,
        target: { type: 'refund_request', id: rr.id, ref: rr.ref, label: `Refund ${rr.ref}`, sellerId: rr.seller_id, screen: 'admin/refunds' },
        amount: money(rr.total, rr.currency),
        summary: `Refund ${rr.ref} of ${(rr.total / 100).toFixed(2)} ${rr.currency}`,
        details: { orderId: rr.order_id, orderItemIds: rr.order_item_ids, fundedBy: rr.funded_by },
        reason: body.note ?? rr.reason ?? 'Refund approval',
        requestedBy: by.principal,
      });
      await this.repo.update('refund_requests', rr.id, { approval_request_id: req.id, updated_at: this.core.now() });
      throw new AppError('APPROVAL_REQUIRED', check.reason || 'Above your refund limit: another approver must approve it', { approvalRequestId: req.id, refundRequestId: rr.id });
    }
    await this.approveAndHandOver(rr.id, by.actor, by, { note: body.note ?? check.reason });
    await this.auditApproval(rr, by, null, check.reason);
    return this.viewOf(id);
  }

  private async auditApproval(rr: RefundRec, by: By, approvalRequestId: string | null, note: string | null) {
    await this.core.audit(
      {
        action: 'returns.refund.approve',
        actionLabel: `Approved refund ${rr.ref} of ${(rr.total / 100).toFixed(2)} ${rr.currency}`,
        category: 'financial',
        target: { type: 'refund_request', id: rr.id, ref: rr.ref, label: `Refund ${rr.ref}`, screen: 'admin/refunds' },
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
      const approved = await tx.update('refund_requests', id, {
        status,
        approved_by: actorText(approver),
        updated_at: now,
        deductions: { ...rr.deductions, approvedAt: now.toISOString(), history: [...rr.deductions.history, { at: now.toISOString(), label: 'Refund approved', detail: o.note ?? null, actor: approver }] },
      });
      if (approved.return_id) await this.core.timeline(tx, approved.return_id, [{ kind: 'refund_approved', label: 'Refund approved', detail: "Approved, not sent yet. We'll tell you when the money is on its way.", visibility: 'customer', actor: approver }]);
    });
    await this.handOver(id, approver, by);
  }

  /** approved → processing through payments (or sent through wallet); idempotent per refund request */
  async handOver(id: string, approver: common.Actor, by: By): Promise<void> {
    const rr = (await this.repo.get('refund_requests', id))!;
    if (rr.status !== 'approved' || rr.payment_refund_id) return;
    const x = rr.deductions;
    const items = (x.perItem.length ? x.perItem : rr.order_item_ids.map((orderItemId, n) => ({ orderItemId, amount: n === 0 ? rr.total : 0 }))).filter((i) => i.amount > 0).map((i) => ({ orderItemId: i.orderItemId, amount: money(i.amount, rr.currency) }));
    let paymentRefundId: string;
    let credited = false;
    if (x.destination === 'store_credit') {
      const wallet = this.core.ctx.tryUse('wallet');
      if (!wallet || !x.customerId) throw this.core.error('REMEDY_NOT_AVAILABLE', 'Store credit is not available', { remedy: 'store_credit' });
      const entry = await wallet.creditRefund({ customerId: x.customerId, refundId: rr.id, orderId: rr.order_id, amount: money(rr.total, rr.currency), reason: rr.reason ?? `Refund ${rr.ref}` }, `refund-request:${rr.id}`);
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
      const history = [...locked.deductions.history, { at: now.toISOString(), label: credited ? 'Store credit issued' : 'Handed to payments', detail: null, actor: SYSTEM }];
      let sentAt: string | null = null;
      if (credited) {
        status = refundRequestMachine.next(status, 'confirmSent');
        sentAt = now.toISOString();
      }
      const updated = await tx.update('refund_requests', id, { status, payment_refund_id: paymentRefundId, updated_at: now, deductions: { ...locked.deductions, sentAt, history } });
      if (updated.return_id) {
        await this.core.timeline(tx, updated.return_id, [{ kind: credited ? 'refund_sent' : 'refund_processing', label: credited ? 'Store credit issued' : 'Refund processing', detail: credited ? `${(updated.total / 100).toFixed(2)} ${updated.currency} added to your store credit` : 'Your refund is on its way to your payment provider.', visibility: 'customer' }]);
        if (credited) await this.completeLinked(tx, updated, batch);
      }
      return updated;
    });
    if (!after) return;
    this.core.publish(
      'returns.refund.approved',
      {
        refundRequestId: after.id,
        returnId: after.return_id,
        caseId: after.case_id,
        orderId: after.order_id,
        orderItemIds: after.order_item_ids,
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
    const outcome = OUTCOME[rr.deductions.kind] ?? (rr.deductions.destination === 'store_credit' ? 'credited' : 'refunded');
    const now = this.core.now();
    await tx.update('returns', ret.id, { status: returnMachine.next(ret.status as ReturnStatus, 'complete'), completed_at: now, updated_at: now, terms_snapshot: { ...ret.terms_snapshot, meta: { ...ret.terms_snapshot.meta, outcome } } });
    await this.core.timeline(tx, ret.id, [{ kind: 'completed', label: outcome === 'partly_refunded' ? 'Partly refunded' : outcome === 'credited' ? 'Refunded as store credit' : 'Refunded', visibility: 'customer' }]);
    batch.push('returns.return.completed', { returnId: ret.id, outcome });
  }

  /* ---------------------------------------------------------------- decline and revise */

  async decline(id: string, reason: string, by: By): Promise<RefundRequest> {
    if (!reason?.trim()) throw invalidField('reason', 'Say why the refund is sent back');
    const now = this.core.now();
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.get('refund_requests', id, { forUpdate: true });
      if (!before) throw notFound('Refund request');
      const status = refundRequestMachine.next(before.status as RefundStatus, 'decline');
      const after = await tx.update('refund_requests', id, {
        status,
        decline_reason: reason.trim(),
        approval_request_id: null,
        updated_at: now,
        deductions: { ...before.deductions, history: [...before.deductions.history, { at: now.toISOString(), label: 'Refund sent back', detail: reason.trim(), actor: by.actor }] },
      });
      if (after.return_id) await this.core.timeline(tx, after.return_id, [{ kind: 'refund_declined', label: 'Refund sent back by Finance', detail: reason.trim(), visibility: 'staff', actor: by.actor }]);
      return { before, after };
    });
    if (before.approval_request_id) await this.core.soft('access', 'cancel approval', (a) => a.cancelApproval(before.approval_request_id!, by.actor, 'Refund sent back'));
    this.core.publish('returns.refund.declined', { refundRequestId: id, reason: reason.trim() }, by);
    await this.core.audit({ action: 'returns.refund.decline', actionLabel: `Sent back refund ${after.ref}`, category: 'financial', target: { type: 'refund_request', id, ref: after.ref, label: `Refund ${after.ref}` }, before: { status: before.status }, after: { status: after.status }, reason }, by);
    return this.viewOf(id);
  }

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
    const now = this.core.now();
    const after = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('refund_requests', id, { forUpdate: true }))!;
      const status = refundRequestMachine.next(locked.status as RefundStatus, 'revise');
      let patch: Partial<RefundRec>;
      if (p) {
        patch = {
          item_amount: p.b.itemAmount,
          discount_share: p.b.discountShare,
          shipping_refund: p.b.shippingRefund,
          return_shipping_deduction: p.b.returnShippingDeduction,
          total: p.b.total,
          seller_share: locked.seller_share === null ? null : p.b.total,
          platform_share: locked.platform_share === null ? null : p.b.total,
          deductions: { ...locked.deductions, ...this.extras(p, { history: locked.deductions.history }) },
        };
      } else {
        // case and exception refunds: the amount is the asked partial amount within the stored cap
        const deductions = remedy.deductions ?? [];
        const full = locked.item_amount - locked.discount_share + locked.shipping_refund - locked.return_shipping_deduction;
        const total = remedy.amount?.amount ?? Math.max(0, full - deductions.reduce((s, d) => s + d.amount.amount, 0));
        if (total > locked.deductions.maxRefundable) throw this.core.error('REFUND_EXCEEDS_REFUNDABLE', 'The amount is above what can still be refunded for these items', { maxRefundable: money(locked.deductions.maxRefundable, locked.currency) });
        const ratio = locked.total > 0 ? total / locked.total : 0;
        patch = { total, deductions: { ...locked.deductions, list: deductions, perItem: locked.deductions.perItem.map((x) => ({ ...x, amount: Math.floor(x.amount * ratio) })) } };
        const sum = patch.deductions!.perItem.reduce((s, x) => s + x.amount, 0);
        if (patch.deductions!.perItem.length) patch.deductions!.perItem[0]!.amount += total - sum;
      }
      patch.deductions = { ...patch.deductions!, history: [...locked.deductions.history, { at: now.toISOString(), label: 'Refund revised and resubmitted', detail: remedy.explanation ?? null, actor: by.actor }] };
      const updated = await tx.update('refund_requests', id, { ...patch, status, decline_reason: null, updated_at: now });
      if (updated.return_id) await this.core.timeline(tx, updated.return_id, [{ kind: 'refund_revised', label: 'Refund revised', detail: remedy.explanation ?? null, visibility: 'staff', actor: by.actor }]);
      return updated;
    });
    this.core.publish('returns.refund.requested', { refundRequestId: id, orderId: after.order_id, total: money(after.total, after.currency), source: after.source }, by);
    await this.core.audit({ action: 'returns.refund.revise', actionLabel: `Revised refund ${after.ref}`, category: 'financial', target: { type: 'refund_request', id, ref: after.ref, label: `Refund ${after.ref}` }, before: { total: rr.total, status: rr.status }, after: { total: after.total, status: after.status } }, by);
    return this.viewOf(id);
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
      const updated = await tx.update('refund_requests', rr.id, {
        status,
        payment_refund_id: locked.payment_refund_id ?? e.refundId,
        failed_reason: null,
        updated_at: this.core.now(),
        deductions: { ...locked.deductions, sentAt: e.sentAt, history: [...locked.deductions.history, { at: e.sentAt, label: 'Refund sent', detail: `To ${e.destination}`, actor: SYSTEM }] },
      });
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
      const updated = await tx.update('refund_requests', rr.id, {
        status,
        failed_reason: e.reason,
        payment_refund_id: locked.payment_refund_id ?? e.refundId,
        updated_at: now,
        deductions: { ...locked.deductions, history: [...locked.deductions.history, { at: now.toISOString(), label: 'Refund failed', detail: e.reason, actor: SYSTEM }] },
      });
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
