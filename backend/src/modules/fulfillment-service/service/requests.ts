/**
 * Fulfillment requests: orders of service offers our warehouse ships while the seller stays the seller of record.
 * Created from orders.order.accepted for groups with fulfilledBy marketly_service (warehouse creates the pick work
 * from the same event), they reserve seller-owned units in the ownership ledger; cancellations, split items and the
 * warehouse's progress follow; each dispatched package ships its lines and accrues pick-and-pack, and the request
 * accrues order handling once.
 */
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { FulfillmentRequest } from '../../../spec/fulfillment-service.js';
import { plural, SYSTEM } from '../domain/rules.js';
import type { RequestItem, RequestRec, SkuRec } from '../ports.js';
import { invalid, Part } from './core.js';

/** Warehouse fulfilment status → request state (dispatch comes from shipping.shipment.dispatched) */
const WAREHOUSE_STATE: Record<string, FulfillmentRequest['state']> = { awaiting_pick: 'open', picking: 'picking', picked: 'picking', packing: 'picking', packed: 'packed', on_hold: 'short' };
const RANK: Record<string, number> = { open: 0, short: 0, picking: 1, packed: 2 };
const DONE = ['shipped', 'cancelled'];

/** Units of an item still to ship */
const openOf = (i: RequestItem) => Math.max(0, i.quantity - i.cancelled - (i.shipped ?? 0));
const shortOf = (items: readonly RequestItem[]) => items.some((i) => openOf(i) > i.reserved);

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
    return { ...res, items: res.items.map((r) => this.parts.views.request(r)) };
  }

  /* ---------------------------------------------------------------- creation */

  /**
   * One request per seller group: seller-owned units reserved out of Available (short when there are not enough).
   * Same group again → the existing request.
   */
  async create(orderId: string, sellerGroupId: string, items: { orderItemId: string; offerId: string; quantity: number }[], meta?: { orderRef: string; dispatchBy: Date }): Promise<{ request: FulfillmentRequest; created: boolean }> {
    const existing = await this.repo.findOne('fulfillment_requests', { seller_group_id: sellerGroupId });
    if (existing) return { request: this.parts.views.request(existing), created: false };
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
    let orderRef = meta?.orderRef ?? '';
    let dispatchBy = meta?.dispatchBy;
    if (!meta) {
      const t = await this.core.soft('orders', 'fulfillment task', (o) => o.getFulfillmentTask(sellerGroupId));
      orderRef = t?.orderRef ?? '';
      dispatchBy = t?.dispatchDeadline?.dueAt ? new Date(t.dispatchDeadline.dueAt) : undefined;
    }
    const due = dispatchBy && !Number.isNaN(dispatchBy.getTime()) ? dispatchBy : new Date(this.now().getTime() + 48 * 3_600_000);
    const info = await this.core.stockItems(service.map((i) => i.offerId));
    const id = newId();
    const result = await this.repo.transaction(async (tx) => {
      await tx.lockSkus([...new Set(service.map((i) => skus.get(i.offerId)!.id))]);
      const again = await tx.findOne('fulfillment_requests', { seller_group_id: sellerGroupId });
      if (again) return { row: again, created: false };
      const balances = await tx.balances([...skus.values()].map((s) => s.id));
      const lines: RequestItem[] = [];
      for (const i of service) {
        const s = skus.get(i.offerId)!;
        const bal = balances.get(s.id) ?? {};
        const take = Math.min(i.quantity, Math.max(0, bal.available ?? 0));
        bal.available = (bal.available ?? 0) - take;
        balances.set(s.id, bal);
        await this.core.move(tx, { sellerId, skuEnrollmentId: s.id, movement: 'reserved', quantity: take, from: 'available', to: 'reserved', reference: orderRef || orderId, actor: SYSTEM });
        lines.push(itemOf(i, s, info.get(i.offerId)?.label ?? s.sku, take, orderRef));
      }
      const row = await tx.insert('fulfillment_requests', {
        id,
        order_id: orderId,
        order_ref: orderRef,
        seller_group_id: sellerGroupId,
        seller_id: sellerId,
        state: shortOf(lines) ? 'short' : 'open',
        items: lines,
        warehouse_task_id: null,
        shipment_id: null,
        dispatch_by: due,
        short_reported_at: null,
        created_at: this.now(),
      });
      return { row, created: true };
    });
    if (result.created && result.row.state === 'short') await this.raiseShort(result.row, 'Not enough seller-owned stock at our warehouse for this order');
    return { request: this.parts.views.request(result.row), created: result.created };
  }

  /** orders.order.accepted: a request for each group Marketly fulfils; the seller hears about it */
  async onOrderAccepted(e: EventPayload<'orders.order.accepted'>): Promise<void> {
    for (const g of e.groups) {
      if (g.fulfilledBy !== 'marketly_service') continue;
      const ids = new Set(g.itemIds);
      const items = e.items.filter((i) => ids.has(i.orderItemId)).map((i) => ({ orderItemId: i.orderItemId, offerId: i.offerId, quantity: i.quantity }));
      if (!items.length) continue;
      try {
        const { request, created } = await this.create(e.orderId, g.groupId, items, { orderRef: e.ref, dispatchBy: new Date(g.dispatchBy) });
        if (!created) continue;
        const units = items.reduce((n, i) => n + i.quantity, 0);
        await this.core.notifySeller(request.sellerId, 'seller.fulfillment.order_received', { order: { ref: e.ref }, items: plural(units, 'unit') }, { kind: 'seller_order', id: g.groupId, ref: e.ref, label: 'View order', screen: 'seller/order' }, `fs:order:${g.groupId}`);
      } catch (err) {
        this.ctx.log.warn({ err, orderId: e.orderId, groupId: g.groupId }, 'fulfillment-service: fulfillment request not created');
      }
    }
  }

  /** orders.order.cancelled (safety net): open requests of the order are cancelled and their reservations released */
  async onOrderCancelled(e: EventPayload<'orders.order.cancelled'>): Promise<void> {
    if (!isUuid(e.orderId)) return;
    const rows = await this.repo.find('fulfillment_requests', { order_id: e.orderId, state: { op: 'not in', value: DONE } });
    for (const r of rows) {
      await this.repo.transaction(async (tx) => {
        if (!(await tx.claim(`order-cancelled:${r.id}`))) return;
        const locked = (await tx.get('fulfillment_requests', r.id, { forUpdate: true }))!;
        if (DONE.includes(locked.state)) return;
        const items = locked.items.map((i) => ({ ...i, shipped: i.shipped ?? 0 }));
        for (const i of items) {
          await this.core.move(tx, { sellerId: locked.seller_id, skuEnrollmentId: i.skuEnrollmentId, movement: 'released', quantity: i.reserved, from: 'reserved', to: 'available', reference: locked.order_ref || e.ref, reason: `Order cancelled (${e.reason === 'payment_declined' ? 'payment declined' : 'all items cancelled'})`, actor: SYSTEM });
          i.cancelled += openOf(i);
          i.reserved = 0;
        }
        const anyShipped = items.some((i) => i.shipped > 0);
        await tx.update('fulfillment_requests', r.id, { items, state: anyShipped ? 'shipped' : 'cancelled' });
      });
      await this.core.resolveWork(`fs_request_short:${r.id}`, 'Order cancelled');
    }
  }

  /** orders.item.cancelled: shorten or cancel the request and release its seller-owned reservation (once per cancellation) */
  async onItemCancelled(e: EventPayload<'orders.item.cancelled'>): Promise<void> {
    const r = await this.repo.findOne('fulfillment_requests', { seller_group_id: e.groupId });
    if (!r || DONE.includes(r.state)) return;
    if (!r.items.some((i) => i.orderItemId === e.itemId)) return;
    const after = await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`item-cancelled:${e.cancellationId}:${e.itemId}`))) return null;
      const locked = (await tx.get('fulfillment_requests', r.id, { forUpdate: true }))!;
      if (DONE.includes(locked.state)) return null;
      const items = locked.items.map((i) => ({ ...i, shipped: i.shipped ?? 0 }));
      const item = items.find((i) => i.orderItemId === e.itemId)!;
      const n = Math.min(openOf(item), Math.max(0, e.quantity));
      if (!n) return null;
      // a short item keeps its reservation for the units still to ship
      const release = Math.max(0, Math.min(item.reserved, item.reserved - (openOf(item) - n)));
      item.cancelled += n;
      item.reserved -= release;
      await this.core.move(tx, { sellerId: locked.seller_id, skuEnrollmentId: item.skuEnrollmentId, movement: 'released', quantity: release, from: 'reserved', to: 'available', reference: `cancel:${e.cancellationId}`, reason: `Order item cancelled (${item.orderRef || e.ref})`, actor: SYSTEM });
      return tx.update('fulfillment_requests', r.id, { items, state: this.stateAfter(locked.state, items) });
    });
    if (after && after.state !== 'short') await this.core.resolveWork(`fs_request_short:${r.id}`, after.state === 'cancelled' ? 'Order items cancelled' : 'No longer short');
  }

  /** orders.item.split: the request item is split so later events naming newItemId match it */
  async onItemSplit(e: EventPayload<'orders.item.split'>): Promise<void> {
    const r = await this.repo.findOne('fulfillment_requests', { seller_group_id: e.groupId });
    if (!r || !r.items.some((i) => i.orderItemId === e.itemId) || r.items.some((i) => i.orderItemId === e.newItemId)) return;
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`item-split:${e.newItemId}`))) return;
      const locked = (await tx.get('fulfillment_requests', r.id, { forUpdate: true }))!;
      const items = locked.items.map((i) => ({ ...i, shipped: i.shipped ?? 0 }));
      const idx = items.findIndex((i) => i.orderItemId === e.itemId);
      if (idx < 0 || items.some((i) => i.orderItemId === e.newItemId)) return;
      const orig = items[idx]!;
      const moving = Math.min(Math.max(0, e.quantity), orig.quantity);
      if (!moving) return;
      // the split-off units: shipped ones first for a return, otherwise units still to ship first
      const parts = { open: openOf(orig), shipped: orig.shipped, cancelled: orig.cancelled };
      const order: (keyof typeof parts)[] = e.reason === 'return' ? ['shipped', 'open', 'cancelled'] : e.reason === 'cancellation' ? ['open', 'cancelled', 'shipped'] : ['open', 'shipped', 'cancelled'];
      const taken = { open: 0, shipped: 0, cancelled: 0 };
      let left = moving;
      for (const k of order) {
        const t = Math.min(left, parts[k]);
        taken[k] = t;
        left -= t;
      }
      const origOpen = parts.open - taken.open;
      const keepReserved = Math.min(orig.reserved, origOpen);
      const next: RequestItem = { ...orig, orderItemId: e.newItemId, quantity: moving, cancelled: taken.cancelled, shipped: taken.shipped, picked: Math.min(orig.picked, taken.shipped), reserved: Math.min(orig.reserved - keepReserved, taken.open) };
      orig.quantity -= moving;
      orig.cancelled -= taken.cancelled;
      orig.shipped -= taken.shipped;
      orig.picked = Math.max(0, orig.picked - next.picked);
      orig.reserved = orig.reserved - next.reserved;
      items.splice(idx + 1, 0, next);
      await tx.update('fulfillment_requests', r.id, { items });
    });
  }

  /**
   * shipping.shipment.dispatched for a Marketly-fulfilled group: this package's lines leave Reserved (claimed per
   * shipment); pick-and-pack per package and size tier, order handling once per request; the request is shipped when
   * every uncancelled unit has shipped.
   */
  async onShipmentDispatched(e: EventPayload<'shipping.shipment.dispatched'>): Promise<void> {
    if (e.kind === 'return' || (e.fulfilledBy && e.fulfilledBy !== 'marketly_service')) return;
    const r = await this.repo.findOne('fulfillment_requests', { seller_group_id: e.groupId });
    if (!r || DONE.includes(r.state)) return;
    const skus = new Map((await this.repo.find('sku_enrollments', { id: [...new Set(r.items.map((i) => i.skuEnrollmentId))] })).map((s) => [s.id, s]));
    const schedule = await this.core.currentSchedule();
    const shipmentKey = isUuid(e.shipmentId) ? e.shipmentId : `${e.groupId}:${e.shippedAt}`;
    const after = await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`shipment-dispatched:${shipmentKey}`))) return null;
      const locked = (await tx.get('fulfillment_requests', r.id, { forUpdate: true }))!;
      if (DONE.includes(locked.state)) return null;
      const items = locked.items.map((i) => ({ ...i, shipped: i.shipped ?? 0 }));
      const shippedQty = new Map<string, number>();
      for (const l of e.lines ?? []) shippedQty.set(l.orderItemId, (shippedQty.get(l.orderItemId) ?? 0) + l.quantity);
      const byTier = new Map<string, number>();
      const ref = locked.order_ref || items[0]?.orderRef || e.orderId;
      for (const i of items) {
        const n = shippedQty.size ? Math.min(openOf(i), shippedQty.get(i.orderItemId) ?? 0) : openOf(i);
        if (!n) continue;
        const fromReserved = Math.min(n, i.reserved);
        await this.core.move(tx, { sellerId: locked.seller_id, skuEnrollmentId: i.skuEnrollmentId, movement: 'shipped', quantity: fromReserved, from: 'reserved', to: null, reference: ref, actor: SYSTEM });
        // picked although the ledger had not reserved them (a short request the warehouse could fill)
        await this.core.move(tx, { sellerId: locked.seller_id, skuEnrollmentId: i.skuEnrollmentId, movement: 'shipped', quantity: n - fromReserved, from: 'available', to: null, reference: ref, reason: 'Shipped beyond the reservation', actor: SYSTEM });
        i.reserved -= fromReserved;
        i.shipped += n;
        i.picked = Math.max(i.picked, i.shipped);
        const tier = skus.get(i.skuEnrollmentId)?.size_tier ?? 'standard';
        byTier.set(tier, (byTier.get(tier) ?? 0) + n);
      }
      if (!byTier.size) return null;
      for (const [tier, units] of byTier) {
        await this.core.accrue(tx, { sellerId: locked.seller_id, rateType: 'pick_pack_per_unit', sizeTier: tier, units, reference: ref, key: `pick_pack:${locked.id}:${shipmentKey}:${tier}` }, schedule.rates);
      }
      await this.core.accrue(tx, { sellerId: locked.seller_id, rateType: 'order_handling', sizeTier: 'any', units: 1, reference: ref, key: `order_handling:${locked.id}` }, schedule.rates);
      const allShipped = items.every((i) => openOf(i) === 0);
      return tx.update('fulfillment_requests', locked.id, { state: allShipped ? 'shipped' : locked.state === 'short' && !shortOf(items) ? 'packed' : locked.state, shipment_id: isUuid(e.shipmentId) ? e.shipmentId : locked.shipment_id, items });
    });
    if (after?.state === 'shipped') await this.core.resolveWork(`fs_request_short:${r.id}`, 'Shipped');
  }

  /** warehouse.fulfillment.status_changed: the request follows the warehouse task (never backwards, never after dispatch) */
  async onWarehouseStatus(e: EventPayload<'warehouse.fulfillment.status_changed'>): Promise<void> {
    if (e.fulfilledBy !== 'marketly_service') return;
    const target = WAREHOUSE_STATE[e.to];
    if (!target) return;
    const r = await this.repo.findOne('fulfillment_requests', { seller_group_id: e.sellerGroupId });
    if (!r || DONE.includes(r.state)) return;
    const after = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('fulfillment_requests', r.id, { forUpdate: true }))!;
      if (DONE.includes(locked.state)) return null;
      const patch: Partial<RequestRec> = { warehouse_task_id: isUuid(e.fulfillmentId) ? e.fulfillmentId : locked.warehouse_task_id };
      if (target === 'short') {
        if (locked.state !== 'short') patch.state = 'short';
        patch.short_reported_at = this.now();
      } else if (locked.state === 'short' ? target !== 'open' : (RANK[target] ?? 0) > (RANK[locked.state] ?? 0)) {
        patch.state = target;
      }
      return tx.update('fulfillment_requests', locked.id, patch);
    });
    if (!after) return;
    if (target === 'short') await this.raiseShort(after, e.reason ? `The warehouse could not pick everything: ${e.reason}` : 'The warehouse could not pick everything');
    else if (after.state !== 'short') await this.core.resolveWork(`fs_request_short:${after.id}`, `Warehouse: ${e.to}`);
  }

  private stateAfter(state: string, items: readonly RequestItem[]): string {
    if (items.every((i) => i.cancelled >= i.quantity)) return 'cancelled';
    if (items.every((i) => openOf(i) === 0)) return 'shipped';
    if (state === 'short' && !shortOf(items)) return 'open';
    return state;
  }

  private async raiseShort(r: RequestRec, summary: string) {
    const names = await this.core.sellerNames([r.seller_id]);
    await this.core.raise({
      queueKey: 'fulfillment.requests',
      kind: 'pick_pack',
      title: `Fulfilled by Marketly order ${r.order_ref || r.order_id} is short`,
      summary: `${names.get(r.seller_id) ?? 'Seller'} · ${summary}`,
      subject: { type: 'order', id: r.order_id, ref: r.order_ref || null, label: 'Fulfilled by Marketly order' },
      sellerId: r.seller_id,
      dueAt: r.dispatch_by.toISOString(),
      priority: 'high',
      dedupeKey: `fs_request_short:${r.id}`,
    });
  }
}

function itemOf(i: { orderItemId: string; offerId: string; quantity: number }, s: SkuRec, title: string, reserved: number, orderRef: string): RequestItem {
  return { orderItemId: i.orderItemId, offerId: i.offerId, skuEnrollmentId: s.id, stockItemId: s.inventory_item_id, sku: s.sku, title, sizeTier: s.size_tier, quantity: i.quantity, cancelled: 0, picked: 0, shipped: 0, reserved, orderRef };
}
