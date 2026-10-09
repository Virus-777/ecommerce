/**
 * Fulfillment requests: orders of service offers routed to our warehouse while the seller stays the seller of
 * record. Created from orders.order.placed (or by orders directly), they reserve seller-owned units; item
 * cancellations release them; the dispatch ships them and accrues pick-and-pack and order handling fees.
 * Warehouse progress comes from the warehouse's task for the seller group when there is one.
 */
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { FulfillmentRequest } from '../../../spec/fulfillment-service.js';
import type { FulfillmentTask } from '../../../spec/orders.js';
import { SYSTEM } from '../domain/rules.js';
import type { RequestItem, RequestRec, SkuRec } from '../ports.js';
import { invalid, Part } from './core.js';

/** Warehouse task status → request state (shipping is recorded from shipping.shipment.dispatched) */
const WAREHOUSE_STATE: Record<string, FulfillmentRequest['state']> = { picking: 'picking', picked: 'picking', packing: 'picking', packed: 'packed' };

export class RequestsPart extends Part {
  async list(q: { state?: string; sellerId?: string; overdue?: boolean }, page: PageRequest) {
    const where: Record<string, unknown> = {};
    if (q.state) where.state = q.state;
    if (q.sellerId) where.seller_id = q.sellerId;
    if (q.overdue) {
      where.dispatch_by = { op: '<', value: this.now() };
      if (!q.state) where.state = ['open', 'picking', 'packed', 'short'];
    }
    const res = await this.repo.page('fulfillment_requests', where, page, { order: { column: 'created_at', direction: 'desc' } });
    const rows = await this.withWarehouseProgress(res.items);
    return { ...res, items: rows.map((r) => this.parts.views.request(r)) };
  }

  /** The warehouse's task for each seller group, when it works one (state and task id) */
  private async withWarehouseProgress(rows: readonly RequestRec[]): Promise<RequestRec[]> {
    const open = rows.filter((r) => r.state !== 'shipped' && r.state !== 'cancelled');
    if (!open.length) return [...rows];
    let tasks: Record<string, { id: string; status: string } | null> = {};
    try {
      tasks = (await this.ctx.use('warehouse').getTasksForOrderGroups(open.map((r) => r.seller_group_id))) as never;
    } catch (err) {
      this.ctx.log.warn({ err }, 'fulfillment-service: warehouse progress unavailable');
    }
    const out: RequestRec[] = [];
    for (const r of rows) {
      const t = tasks[r.seller_group_id];
      if (!t || r.state === 'shipped' || r.state === 'cancelled') {
        out.push(r);
        continue;
      }
      const state = WAREHOUSE_STATE[t.status] ?? r.state;
      if (t.id !== r.warehouse_task_id || (state !== r.state && r.state !== 'short')) {
        out.push(await this.repo.update('fulfillment_requests', r.id, { warehouse_task_id: t.id, ...(r.state !== 'short' ? { state } : {}) }));
      } else out.push(r);
    }
    return out;
  }

  /* ---------------------------------------------------------------- creation */

  /** Called when a seller group contains service offers (orders), or from orders.order.placed */
  async create(orderId: string, sellerGroupId: string, items: { orderItemId: string; offerId: string; quantity: number }[], task?: FulfillmentTask | null): Promise<FulfillmentRequest> {
    const existing = await this.repo.findOne('fulfillment_requests', { seller_group_id: sellerGroupId });
    if (existing) return this.parts.views.request(existing);
    if (!isUuid(orderId) || !isUuid(sellerGroupId)) throw invalid([{ path: 'orderId', message: 'Order and seller group ids are required' }]);
    const issues: { path: string; message: string }[] = [];
    items.forEach((i, n) => {
      if (!Number.isInteger(i.quantity) || i.quantity < 1) issues.push({ path: `items[${n}].quantity`, message: 'Quantity must be at least 1' });
    });
    if (issues.length) throw invalid(issues);
    const offerIds = [...new Set(items.map((i) => i.offerId).filter(isUuid))];
    const skus = new Map((await this.repo.find('sku_enrollments', { offer_id: offerIds, state: ['active', 'inactive'] })).map((s) => [s.offer_id, s]));
    const service = items.filter((i) => skus.has(i.offerId));
    if (!service.length) throw invalid([{ path: 'items', message: 'None of these items is fulfilled by Marketly' }]);
    const sellerIds = new Set(service.map((i) => skus.get(i.offerId)!.seller_id));
    if (sellerIds.size > 1) throw invalid([{ path: 'items', message: 'A seller group belongs to one seller' }]);
    const sellerId = [...sellerIds][0]!;
    const t = task === undefined ? await this.core.soft('orders', 'fulfillment task', (o) => o.getFulfillmentTask(sellerGroupId)) : task;
    const orderRef = t?.orderRef ?? '';
    const dispatchBy = t?.dispatchDeadline?.dueAt ? new Date(t.dispatchDeadline.dueAt) : new Date(this.now().getTime() + 48 * 3_600_000);
    const info = await this.core.stockItems(service.map((i) => i.offerId));
    const id = newId();
    const row = await this.repo.transaction(async (tx) => {
      await tx.lockSkus([...new Set(service.map((i) => skus.get(i.offerId)!.id))]);
      const again = await tx.findOne('fulfillment_requests', { seller_group_id: sellerGroupId });
      if (again) return again;
      const balances = await tx.balances([...skus.values()].map((s) => s.id));
      let short = false;
      const lines: RequestItem[] = [];
      for (const i of service) {
        const s = skus.get(i.offerId)!;
        const bal = balances.get(s.id) ?? {};
        const take = Math.min(i.quantity, Math.max(0, bal.available ?? 0));
        if (take < i.quantity) short = true;
        bal.available = (bal.available ?? 0) - take;
        balances.set(s.id, bal);
        await this.core.move(tx, { sellerId, skuEnrollmentId: s.id, movement: 'reserved', quantity: take, from: 'available', to: 'reserved', reference: orderRef || orderId, actor: SYSTEM });
        lines.push(itemOf(i, s, info.get(i.offerId)?.label ?? s.sku, take, orderRef));
      }
      return tx.insert('fulfillment_requests', {
        id,
        order_id: orderId,
        seller_group_id: sellerGroupId,
        seller_id: sellerId,
        state: short ? 'short' : 'open',
        items: lines,
        warehouse_task_id: null,
        shipment_id: null,
        dispatch_by: dispatchBy,
        created_at: this.now(),
      });
    });
    if (row.state === 'short') this.ctx.log.warn({ requestId: row.id, orderRef }, 'fulfillment-service: not enough seller-owned stock for a fulfillment request');
    return this.parts.views.request(row);
  }

  /** orders.order.placed: a fulfillment request for each seller group with service offers */
  async onOrderPlaced(e: EventPayload<'orders.order.placed'>): Promise<void> {
    for (const g of e.groups) {
      if (g.ownerType !== 'seller' || !g.sellerId) continue;
      // cheap check first: does this seller use the service at all
      if (!(await this.repo.count('sku_enrollments', { seller_id: g.sellerId, state: ['active', 'inactive'] }))) continue;
      if (await this.repo.count('fulfillment_requests', { seller_group_id: g.groupId })) continue;
      const task = await this.core.soft('orders', 'fulfillment task', (o) => o.getFulfillmentTask(g.groupId));
      if (!task) continue;
      const lines = task.openLines.map((l) => ({ orderItemId: l.orderItemId, offerId: l.offerId, quantity: l.quantityToShip }));
      const service = await this.repo.find('sku_enrollments', { offer_id: [...new Set(lines.map((l) => l.offerId))], state: ['active', 'inactive'] });
      if (!service.length) continue;
      try {
        await this.create(e.orderId, g.groupId, lines, task);
      } catch (err) {
        this.ctx.log.warn({ err, orderId: e.orderId, groupId: g.groupId }, 'fulfillment-service: fulfillment request not created');
      }
    }
  }

  /** orders.item.cancelled: shorten or cancel the request and release its seller-owned reservation */
  async onItemCancelled(e: EventPayload<'orders.item.cancelled'>): Promise<void> {
    const r = await this.repo.findOne('fulfillment_requests', { seller_group_id: e.groupId });
    if (!r || r.state === 'shipped' || r.state === 'cancelled') return;
    if (!r.items.some((i) => i.orderItemId === e.itemId)) return;
    await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('fulfillment_requests', r.id, { forUpdate: true }))!;
      if (locked.state === 'shipped' || locked.state === 'cancelled') return;
      const items = locked.items.map((i) => ({ ...i }));
      const item = items.find((i) => i.orderItemId === e.itemId)!;
      const open = item.quantity - item.cancelled;
      const n = Math.min(open, Math.max(0, e.quantity));
      if (!n) return;
      // the cancellation id makes a redelivered event a no-op
      const marker = `cancel:${e.cancellationId}`;
      if (await tx.findOne('ownership_ledger', { sku_enrollment_id: item.skuEnrollmentId, reference: marker })) return;
      const release = Math.min(n, item.reserved);
      item.cancelled += n;
      item.reserved -= release;
      await this.core.move(tx, { sellerId: locked.seller_id, skuEnrollmentId: item.skuEnrollmentId, movement: 'released', quantity: release, from: 'reserved', to: 'available', reference: marker, reason: `Order item cancelled (${item.orderRef || e.ref})`, actor: SYSTEM });
      const allCancelled = items.every((i) => i.cancelled >= i.quantity);
      const short = items.some((i) => i.quantity - i.cancelled > i.reserved);
      await tx.update('fulfillment_requests', r.id, { items, state: allCancelled ? 'cancelled' : locked.state === 'short' && !short ? 'open' : locked.state });
    });
  }

  /** shipping.shipment.dispatched: shipped, reserved units leave, pick-and-pack and order handling fees */
  async onShipmentDispatched(e: EventPayload<'shipping.shipment.dispatched'>): Promise<void> {
    if (e.kind === 'return') return;
    const r = await this.repo.findOne('fulfillment_requests', { seller_group_id: e.groupId });
    if (!r || r.state === 'shipped' || r.state === 'cancelled') return;
    const skus = new Map((await this.repo.find('sku_enrollments', { id: [...new Set(r.items.map((i) => i.skuEnrollmentId))] })).map((s) => [s.id, s]));
    const schedule = await this.core.currentSchedule();
    await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('fulfillment_requests', r.id, { forUpdate: true }))!;
      if (locked.state === 'shipped' || locked.state === 'cancelled') return;
      const items = locked.items.map((i) => ({ ...i }));
      const shippedQty = new Map(e.lines.map((l) => [l.orderItemId, l.quantity]));
      const byTier = new Map<string, number>();
      for (const i of items) {
        const open = i.quantity - i.cancelled;
        const n = shippedQty.size ? Math.min(open, shippedQty.get(i.orderItemId) ?? 0) : open;
        if (!n) continue;
        const fromReserved = Math.min(n, i.reserved);
        await this.core.move(tx, { sellerId: locked.seller_id, skuEnrollmentId: i.skuEnrollmentId, movement: 'shipped', quantity: fromReserved, from: 'reserved', to: null, reference: i.orderRef || e.orderId, actor: SYSTEM });
        i.reserved -= fromReserved;
        i.picked = n;
        const tier = skus.get(i.skuEnrollmentId)?.size_tier ?? 'standard';
        byTier.set(tier, (byTier.get(tier) ?? 0) + n);
      }
      const ref = items[0]?.orderRef || null;
      for (const [tier, units] of byTier) {
        await this.core.accrue(tx, { sellerId: locked.seller_id, rateType: 'pick_pack_per_unit', sizeTier: tier, units, reference: ref, key: `pick_pack:${locked.id}:${tier}` }, schedule.rates);
      }
      if (byTier.size) await this.core.accrue(tx, { sellerId: locked.seller_id, rateType: 'order_handling', sizeTier: 'any', units: 1, reference: ref, key: `order_handling:${locked.id}` }, schedule.rates);
      await tx.update('fulfillment_requests', locked.id, { state: 'shipped', shipment_id: isUuid(e.shipmentId) ? e.shipmentId : null, items });
    });
  }

  /** Shipped request items of a seller (returns matching) */
  async shippedItems(sellerId: string, limit = 2000): Promise<{ request: RequestRec; item: RequestItem }[]> {
    const rows = await this.repo.find('fulfillment_requests', { seller_id: sellerId, state: 'shipped' }, { orderBy: [['created_at', 'desc']], limit });
    return rows.flatMap((request) => request.items.map((item) => ({ request, item })));
  }
}

function itemOf(i: { orderItemId: string; offerId: string; quantity: number }, s: SkuRec, title: string, reserved: number, orderRef: string): RequestItem {
  return { orderItemId: i.orderItemId, offerId: i.offerId, skuEnrollmentId: s.id, stockItemId: s.inventory_item_id, sku: s.sku, title, sizeTier: s.size_tier, quantity: i.quantity, cancelled: 0, picked: 0, reserved, orderRef };
}
