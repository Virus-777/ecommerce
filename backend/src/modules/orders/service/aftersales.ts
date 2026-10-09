/**
 * After-sales mirrors: refunds (payments), chargebacks, returns, replacements, support cases, seller
 * restrictions, guest orders attached to new accounts, and the jobs that refresh flags and complete orders.
 * Payment, delivery and returns progress stay separate: none of these changes another.
 */
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { orderLifecycleMachine } from '../domain/state-machines.js';
import { FINAL, is } from '../domain/rules.js';
import type { ItemRec } from '../ports.js';
import { SYSTEM, type Core } from './core.js';

const REFUND_STATUS: Record<string, string> = { requested: 'requested', processing: 'processing', sent: 'sent', failed: 'failed', cancelled: 'none' };
const IN_FLIGHT = ['requested', 'under_review', 'approved', 'processing'];

export class AfterSales {
  constructor(private readonly core: Core) {}

  private async exists(orderId: string | null | undefined) {
    if (!orderId) return false;
    return Boolean(await this.core.repo.get('orders', orderId));
  }

  /* ---------------------------------------------------------------- payments */

  async onRefundStatusChanged(e: EventPayload<'payments.refund.status_changed'>) {
    if (!(await this.exists(e.orderId))) return;
    const status = REFUND_STATUS[e.to];
    if (!status) return;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg) => {
      for (const ri of e.items) {
        const item = agg.items.find((i) => i.id === ri.orderItemId);
        if (!item || item.refund_status === 'sent') continue;
        if (status === 'none' && item.state !== 'cancelled') await tx.update('order_items', item.id, { refund_status: 'none' });
        else if (status !== 'none') await tx.update('order_items', item.id, { refund_status: status });
      }
      if (e.origin === 'cancellation' || e.originId) {
        const c = agg.cancellations.find((x) => x.id === e.originId);
        if (c && c.refund_status !== 'sent') await tx.update('cancellations', c.id, { refund_status: status === 'none' ? 'none' : status, payment_refund_id: e.refundId });
      }
    });
  }

  /** Adds to refundedAmount; a line becomes Refunded only when its whole refundable amount is sent */
  async onRefundSent(e: EventPayload<'payments.refund.sent'>) {
    const o = await this.core.repo.get('orders', e.orderId);
    if (!o || (o.flags?.refundsSent ?? []).includes(e.refundId)) return;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg, batch) => {
      if ((agg.order.flags?.refundsSent ?? []).includes(e.refundId)) return;
      for (const ri of e.items) {
        const item = agg.items.find((i) => i.id === ri.orderItemId);
        if (!item) continue;
        const refunded = Math.min(item.paid_amount, item.refunded_amount + ri.amount.amount);
        const updated = await tx.update('order_items', item.id, { refunded_amount: refunded, refund_status: 'sent' });
        if (refunded >= item.paid_amount && ['shipped', 'delivered', 'returned'].includes(item.state)) await this.core.move(tx, batch, updated, 'refund_in_full', { reason: `Refund ${e.ref} sent` });
      }
      const c = e.originId ? agg.cancellations.find((x) => x.id === e.originId) : undefined;
      if (c) await tx.update('cancellations', c.id, { refund_status: 'sent', payment_refund_id: e.refundId });
      const order = await this.core.setFlags(tx, agg.order, (f) => ({
        ...f,
        refundsSent: [...(f.refundsSent ?? []), e.refundId],
        refundApprovals: (f.refundApprovals ?? []).filter((a) => a.id !== e.originId && !a.itemIds.every((id) => e.items.some((x) => x.orderItemId === id))),
      }));
      await tx.update('orders', order.id, { refunded_total: Math.min(order.total, order.refunded_total + e.amount.amount) });
      await this.core.timeline(tx, e.orderId, [{ visibility: 'customer', label: 'Refund sent', detail: `${e.ref}: refund sent to ${e.destination}. Banks usually show it in 3–5 business days.` }]);
    });
  }

  async onChargebackOpened(e: EventPayload<'payments.chargeback.opened'>) {
    if (!(await this.exists(e.orderId))) return;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg) => {
      if ((agg.order.flags?.chargebacks ?? []).some((c) => c.disputeId === e.disputeId)) return;
      await this.core.setFlags(tx, agg.order, (f) => ({ ...f, chargebacks: [...(f.chargebacks ?? []), { disputeId: e.disputeId, kind: e.kind, groupId: e.groupId ?? null, at: this.core.now().toISOString() }] }));
      await this.core.timeline(tx, e.orderId, [{ group_id: e.groupId ?? null, visibility: 'staff', label: 'Chargeback opened', detail: `${e.ref} (${e.kind})` }]);
    });
  }

  /* ---------------------------------------------------------------- returns */

  private async itemsOfReturn(returnId: string): Promise<ItemRec[]> {
    return this.core.repo.find('order_items', { return_id: returnId });
  }

  async onReturnRequested(e: EventPayload<'returns.return.requested'>) {
    if (!(await this.exists(e.orderId))) return;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg, batch) => {
      const items = agg.items.filter((i) => e.orderItemIds.includes(i.id));
      for (const i of items) {
        if (i.state === 'delivered') await this.core.move(tx, batch, i, 'request_return', { reason: e.reason, patch: { return_id: e.returnId, return_ref: e.ref } });
        else if (i.return_id !== e.returnId) await tx.update('order_items', i.id, { return_id: e.returnId, return_ref: e.ref });
      }
      if (items.length) await this.core.timeline(tx, e.orderId, [{ group_id: items[0]!.group_id, visibility: 'customer', label: 'Return requested', detail: `Return ${e.ref}` }]);
    });
  }

  async onReturnReceived(e: EventPayload<'returns.return.received'>) {
    const items = await this.itemsOfReturn(e.returnId);
    if (!items.length) return;
    await this.core.write(items[0]!.order_id, { actor: SYSTEM }, async (tx, agg, batch) => {
      for (const i of agg.items.filter((x) => x.return_id === e.returnId && x.state === 'return_requested')) await this.core.move(tx, batch, i, 'receive_return', { reason: 'Return received' });
      await this.core.timeline(tx, agg.order.id, [{ group_id: items[0]!.group_id, visibility: 'customer', label: 'Return received', detail: `Return ${items[0]!.return_ref ?? ''} arrived. The refund follows the inspection.`.replace('  ', ' ') }]);
    });
  }

  private async closeReturn(returnId: string, label: string) {
    const items = await this.itemsOfReturn(returnId);
    if (!items.length) return;
    await this.core.write(items[0]!.order_id, { actor: SYSTEM }, async (tx, agg, batch) => {
      const open = agg.items.filter((x) => x.return_id === returnId && x.state === 'return_requested');
      for (const i of open) await this.core.move(tx, batch, i, 'close_return', { reason: label });
      if (open.length) await this.core.timeline(tx, agg.order.id, [{ group_id: open[0]!.group_id, visibility: 'customer', label }]);
    });
  }

  onReturnCancelled(e: EventPayload<'returns.return.cancelled'>) {
    return this.closeReturn(e.returnId, 'Return cancelled');
  }

  onReturnRejected(e: EventPayload<'returns.return.rejected'>) {
    return this.closeReturn(e.returnId, 'Return rejected');
  }

  async onRefundApproved(e: EventPayload<'returns.refund.approved'>) {
    if (!(await this.exists(e.orderId))) return;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg) => {
      if ((agg.order.flags?.refundApprovals ?? []).some((a) => a.id === e.refundRequestId)) return;
      for (const i of agg.items.filter((x) => e.orderItemIds.includes(x.id) && x.refund_status !== 'sent')) await tx.update('order_items', i.id, { refund_status: 'approved' });
      const returnRef = agg.items.find((x) => e.returnId && x.return_id === e.returnId)?.return_ref ?? null;
      await this.core.setFlags(tx, agg.order, (f) => ({ ...f, refundApprovals: [...(f.refundApprovals ?? []), { id: e.refundRequestId, returnRef, amount: e.total.amount, itemIds: e.orderItemIds }] }));
      await this.core.timeline(tx, e.orderId, [{ visibility: 'customer', label: 'Refund approved', detail: 'Approved, not sent yet. We will tell you when the money is on its way.' }]);
    });
  }

  /** A replacement adds a new confirmed line linked to the original item (no extra charge) */
  async onReplacementCreated(e: EventPayload<'returns.replacement.created'>) {
    if (!(await this.exists(e.orderId))) return;
    const marker = `replacement:${e.replacementId}`;
    if ((await this.core.repo.find('order_items', { order_id: e.orderId, checkout_line_id: marker })).length) return;
    const original = await this.core.repo.get('order_items', e.orderItemId);
    if (!original || original.order_id !== e.orderId) return;
    let product = original.product_snapshot;
    let offer = original.offer_snapshot;
    if (e.variantId !== original.variant_id) {
      const snap = await this.core.ctx
        .use('catalog')
        .snapshotForOrder(e.variantId)
        .catch(() => null);
      if (snap) product = { ...snap, categoryId: original.product_snapshot.categoryId ?? null };
    }
    if (e.offerId !== original.offer_id) offer = await this.core.ctx.use('offers').snapshotForOrder(e.offerId).then((o) => ({ ...o, sellerSku: null }), () => original.offer_snapshot);
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg) => {
      const now = this.core.now();
      const id = newId();
      await tx.insert('order_items', {
        ...original,
        id,
        offer_id: e.offerId,
        variant_id: e.variantId,
        product_id: product.productId,
        product_snapshot: product,
        offer_snapshot: offer,
        quantity: e.quantity,
        discounts: [],
        shipping_share: 0,
        tax_share: 0,
        paid_amount: 0,
        refunded_amount: 0,
        refund_status: 'none',
        state: 'confirmed',
        state_before_request: null,
        shipment_id: null,
        return_id: null,
        return_ref: null,
        delivered_at: null,
        return_window_ends_at: null,
        split_from_item_id: null,
        replacement_of_item_id: original.id,
        checkout_line_id: marker,
      });
      await tx.insert('item_state_log', { id: newId(), item_id: id, from_state: 'pending_payment', to_state: 'confirmed', event: 'replacement', reason: `Replacement for return`, actor_kind: 'system', actor_id: null, at: now });
      await this.core.timeline(tx, agg.order.id, [
        { group_id: original.group_id, visibility: 'customer', label: 'Replacement on the way', detail: `${product.title} × ${e.quantity} will ship as a replacement.` },
        { group_id: original.group_id, visibility: 'seller', label: 'Replacement to ship', detail: `${product.title} × ${e.quantity}` },
      ]);
    });
  }

  /* ---------------------------------------------------------------- cases, sellers, identity */

  async onCaseOpened(e: EventPayload<'support.case.opened'>) {
    if (!(await this.exists(e.orderId))) return;
    await this.core.write(e.orderId!, { actor: SYSTEM }, async (tx, agg) => {
      if ((agg.order.flags?.cases ?? []).some((c) => c.caseId === e.caseId)) return;
      await this.core.setFlags(tx, agg.order, (f) => ({ ...f, cases: [...(f.cases ?? []), { caseId: e.caseId, ref: e.ref, itemIds: e.orderItemIds ?? [], status: 'open', nextUpdateBy: e.nextResponseDueAt ?? null }] }));
      await this.core.timeline(tx, agg.order.id, [{ visibility: 'customer', label: 'Support case opened', detail: `Case ${e.ref}` }]);
    });
  }

  /** Open groups of the seller are flagged; orders stay accessible and fulfillable */
  async onSellerRestricted(e: EventPayload<'sellers.seller.restricted'>) {
    const groups = await this.core.repo.ordersWithOpenGroupsOfSeller(e.sellerId);
    const byOrder = new Map<string, string[]>();
    for (const g of groups) byOrder.set(g.order_id, [...(byOrder.get(g.order_id) ?? []), g.id]);
    for (const [orderId, ids] of byOrder) {
      await this.core.write(orderId, { actor: SYSTEM }, async (tx, agg) => {
        const known = new Set(agg.order.flags?.restrictedGroups ?? []);
        if (ids.every((id) => known.has(id))) return;
        await this.core.setFlags(tx, agg.order, (f) => ({ ...f, restrictedGroups: [...new Set([...(f.restrictedGroups ?? []), ...ids])] }));
        await this.core.timeline(tx, orderId, ids.map((id) => ({ group_id: id, visibility: 'staff' as const, label: 'Seller restricted', detail: e.reason, reason: e.reasonCode })));
      });
    }
  }

  /** Guest orders placed with the verified email join the new customer account */
  async onUserVerified(e: EventPayload<'identity.user.verified'>) {
    if (e.channel !== 'email' || !e.email) return;
    const customer = await this.core.soft('customers', 'customer of account', (c) => c.getCustomerByUserId(e.accountId));
    if (!customer) return this.core.ctx.log.info({ accountId: e.accountId }, 'orders: no customer record to attach guest orders to');
    const orders = await this.core.repo.guestOrdersByEmail(e.email);
    for (const o of orders) {
      await this.core.repo.transaction(async (tx) => {
        const fresh = await tx.get('orders', o.id, { forUpdate: true });
        if (!fresh || fresh.customer_id) return;
        await tx.update('orders', o.id, { customer_id: customer.id });
        await this.core.timeline(tx, o.id, [{ visibility: 'staff', label: 'Guest order attached to the new account', detail: customer.ref }]);
      });
    }
  }

  /* ---------------------------------------------------------------- jobs */

  /** orders.refresh-flags: due soon, overdue and payment checking, plus saved filter counts */
  async refreshFlags(countSavedFilters: () => Promise<void>): Promise<{ orders: number }> {
    const cfg = await this.core.cfg();
    let after: string | null = null;
    let n = 0;
    for (let round = 0; round < 200; round++) {
      const batch = await this.core.repo.ordersInLifecycle(['payment_pending', 'open'], after, 200);
      if (!batch.length) break;
      for (const o of batch) {
        await this.core.repo.transaction((tx) => this.core.refreshDerived(tx, o.id, null, cfg));
        n++;
      }
      after = batch.at(-1)!.id;
      if (batch.length < 200) break;
    }
    await countSavedFilters();
    return { orders: n };
  }

  /** orders.complete-orders: every item final, return windows closed, no return, case or refund open */
  async completeOrders(): Promise<{ completed: number }> {
    const now = this.core.now();
    let after: string | null = null;
    let completed = 0;
    for (let round = 0; round < 200; round++) {
      const orders = await this.core.repo.ordersInLifecycle(['open'], after, 200);
      if (!orders.length) break;
      after = orders.at(-1)!.id;
      const aggs = await this.core.loadMany(orders.map((o) => o.id));
      for (const agg of aggs.values()) {
        const items = agg.items;
        if (!items.length || !items.every((i) => is(FINAL, i.state))) continue;
        if (items.some((i) => i.state === 'delivered' && (!i.return_window_ends_at || i.return_window_ends_at.getTime() > now.getTime()))) continue;
        if (items.some((i) => IN_FLIGHT.includes(i.refund_status))) continue;
        if (agg.cancellations.some((c) => c.status === 'requested' || (c.status === 'accepted' && ['requested', 'processing', 'failed'].includes(c.refund_status) && c.refund_preview.total.amount > 0))) continue;
        const cases = await this.core.soft('support', 'cases of order', (s) => s.casesForOrder(agg.order.id));
        if (cases ? cases.some((c) => !/resolved|closed/i.test(c.status)) : false) continue;
        if (items.every((i) => i.state === 'cancelled')) continue; // handled as cancelled
        const done = await this.core.write(agg.order.id, { actor: SYSTEM }, async (tx, fresh, b) => {
          if (fresh.order.lifecycle !== 'open') return false;
          const lifecycle = orderLifecycleMachine.next('open', 'complete');
          await tx.update('orders', fresh.order.id, { lifecycle, completed_at: now, ...(cases ? { flags: { ...fresh.order.flags, cases: (fresh.order.flags.cases ?? []).map((c) => ({ ...c, status: cases.find((x) => x.caseId === c.caseId)?.status ?? c.status })) } } : {}) });
          b.push('orders.order.completed', { orderId: fresh.order.id, ref: fresh.order.ref, completedAt: now.toISOString() });
          return true;
        });
        if (done) completed++;
      }
      if (orders.length < 200) break;
    }
    return { completed };
  }
}
