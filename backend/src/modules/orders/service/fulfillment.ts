/**
 * Seller fulfillment tasks (one per seller group): preparing, delays, dispatch deadlines, and the shipping and
 * warehouse events that move items to Shipped and Delivered (splitting lines for partial quantities).
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import type * as common from '../../../spec/common.js';
import type { BulkResult, FulfillmentTask } from '../../../spec/orders.js';
import { CANCELLABLE, DAY, dateTime, is, isMarketlyService, marketlyFulfils, shortDate, UNSHIPPED, WAREHOUSE_STAGE_ENTRY, WAREHOUSE_STAGE_LABEL } from '../domain/rules.js';
import type { DispatchChange, GroupRec, ItemRec, ShipmentRec } from '../ports.js';
import { invalid, notFound, SYSTEM, type Agg, type By, type Core } from './core.js';
import type { Cancellations } from './cancellations.js';
import type { Views } from './views.js';

const PREPARING_WAREHOUSE = ['picking', 'picked', 'packing', 'packed'];
const SHIPPABLE = ['confirmed', 'preparing', 'delayed', 'cancellation_requested'];

/**
 * The group's shippable lines a shipment line naming itemId stands for: the item, and the lines split off it since.
 * Two packages of one line recorded before the first reached orders both name it; the first one's split leaves the
 * units the second carries on a new line.
 */
function openParts(items: readonly ItemRec[], groupId: string, itemId: string): ItemRec[] {
  const out: ItemRec[] = [];
  const queue = [itemId];
  for (let id = queue.shift(); id; id = queue.shift()) {
    const item = items.find((i) => i.id === id && i.group_id === groupId);
    if (!item) continue;
    if (SHIPPABLE.includes(item.state)) out.push(item);
    queue.push(...items.filter((i) => i.split_from_item_id === id).map((i) => i.id));
  }
  return out;
}

export class Fulfillment {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly cancellations: Cancellations,
  ) {}

  /** The seller's own group (another seller's → NOT_FOUND) */
  async sellerGroup(sellerId: string, groupId: string): Promise<GroupRec> {
    const g = await this.core.repo.get('seller_groups', groupId);
    if (!g || g.seller_id !== sellerId) throw notFound();
    return g;
  }

  /** Task ids from the seller area: seller group ids (an order id stands for the seller's groups in it) */
  async resolveTasks(sellerId: string, ids: readonly string[]): Promise<Map<string, GroupRec[]>> {
    const out = new Map<string, GroupRec[]>();
    for (const id of ids) {
      const g = await this.core.repo.get('seller_groups', id);
      if (g && g.seller_id === sellerId) {
        out.set(id, [g]);
        continue;
      }
      out.set(
        id,
        (await this.core.repo.find('seller_groups', { order_id: id })).filter((x) => x.seller_id === sellerId),
      );
    }
    return out;
  }

  async startPreparing(groupId: string, by: By): Promise<void> {
    const g = await this.core.repo.get('seller_groups', groupId);
    if (!g) throw notFound();
    this.core.refuseMarketly(g, 'prepare it');
    await this.core.write(g.order_id, by, async (tx, agg, batch) => {
      const items = agg.items.filter((i) => i.group_id === groupId);
      const movable = items.filter((i) => i.state === 'confirmed' || i.state === 'delayed');
      if (!movable.length) {
        if (items.some((i) => i.state === 'preparing') && agg.order.lifecycle === 'open') return; // already preparing
        throw new AppError('ILLEGAL_TRANSITION', agg.order.lifecycle === 'payment_pending' ? 'The payment is still being checked; wait before preparing.' : 'Nothing in this order can move to preparing.', {
          machine: 'Order item',
          event: 'start_preparing',
          from: items.map((i) => i.state),
        });
      }
      for (const i of movable) await this.core.move(tx, batch, i, 'start_preparing');
      await this.core.timeline(tx, agg.order.id, [
        { group_id: groupId, visibility: 'customer', label: 'Preparing your package', detail: `${g.seller_name} is packing your items.`, actor: by.actor },
        { group_id: groupId, visibility: 'seller', label: 'Marked as preparing', actor: by.actor },
      ]);
    });
  }

  async bulkStartPreparing(sellerId: string, ids: readonly string[], by: By): Promise<BulkResult> {
    if (!ids.length) throw invalid([{ path: 'orderIds', message: 'Choose at least one order' }]);
    const tasks = await this.resolveTasks(sellerId, ids);
    const failed: BulkResult['failed'] = [];
    let updated = 0;
    for (const id of ids) {
      const groups = tasks.get(id) ?? [];
      if (!groups.length) {
        failed.push({ id, code: 'NOT_FOUND', message: 'Order not found' });
        continue;
      }
      for (const g of groups) {
        try {
          await this.startPreparing(g.id, by);
          updated++;
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          failed.push({ id, code: err.code, message: err.message });
        }
      }
    }
    return { updated, failed };
  }

  async reportDelay(groupId: string, body: { itemIds?: string[] | null; reason: string; expectedDispatchBy: string; note?: string | null }, by: By): Promise<void> {
    const g = await this.core.repo.get('seller_groups', groupId);
    if (!g) throw notFound();
    this.core.refuseMarketly(g, 'report a delay for it');
    const expected = new Date(body.expectedDispatchBy);
    if (expected.getTime() <= this.core.now().getTime()) throw invalid([{ path: 'expectedDispatchBy', message: 'Choose a date in the future' }]);
    await this.core.write(g.order_id, by, async (tx, agg, batch) => {
      const own = agg.items.filter((i) => i.group_id === groupId);
      const chosen = body.itemIds?.length ? body.itemIds.map((id) => own.find((i) => i.id === id)) : own.filter((i) => is(CANCELLABLE, i.state));
      if (chosen.some((i) => !i)) throw invalid([{ path: 'itemIds', message: 'Not an item of this order' }]);
      const items = chosen as ItemRec[];
      if (!items.length || agg.order.lifecycle !== 'open') throw new AppError('ILLEGAL_TRANSITION', 'Nothing in this order can be delayed.', { machine: 'Order item', event: 'mark_delayed' });
      for (const i of items) {
        if (i.state === 'delayed') continue;
        await this.core.move(tx, batch, i, 'mark_delayed', { reason: body.reason }); // ILLEGAL_TRANSITION for shipped or cancelled items
      }
      const change: DispatchChange = { kind: 'seller_estimate', from: g.dispatch_by.toISOString(), to: expected.toISOString(), reason: body.reason, by: by.actor, at: this.core.now().toISOString() };
      await tx.update('seller_groups', groupId, { dispatch_by_history: [...(agg.groups.find((x) => x.id === groupId)?.dispatch_by_history ?? []), change] });
      await this.core.timeline(tx, agg.order.id, [
        {
          group_id: groupId,
          visibility: 'customer',
          label: 'Package delayed',
          detail: `${g.seller_name} now expects to ship it by ${shortDate(expected, this.core.tz)}. You can wait, cancel the items that have not shipped, or contact support.`,
          actor: by.actor,
        },
        { group_id: groupId, visibility: 'seller', label: 'Delay reported', detail: `New dispatch estimate ${dateTime(expected, this.core.tz)}`, reason: body.note ?? body.reason, actor: by.actor },
      ]);
      batch.push('orders.item.delayed', { orderId: agg.order.id, ...this.core.recipient(agg.order), groupId, itemIds: items.map((i) => i.id), source: 'seller', expectedDispatchBy: expected.toISOString(), reason: body.reason });
    });
  }

  /** Recalculated deadline or a staff extension; the original stays on record for seller performance */
  async setDispatchDeadline(groupId: string, dueAt: string, reason: string, actor: common.Actor, o: { notifyCustomer?: boolean; orderId?: string } = {}): Promise<void> {
    const g = await this.core.repo.get('seller_groups', groupId);
    if (!g || (o.orderId && g.order_id !== o.orderId)) throw notFound('Package');
    const due = new Date(dueAt);
    if (Number.isNaN(due.getTime())) throw invalid([{ path: 'dueAt', message: 'Not a date' }]);
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    await this.core.write(g.order_id, { actor }, async (tx, agg, batch) => {
      const group = agg.groups.find((x) => x.id === groupId)!;
      if (actor.kind === 'staff' && !['new', 'preparing', 'delayed', 'partly_shipped'].includes(group.status)) throw invalid([{ path: 'groupId', message: 'This package has nothing left to ship' }]);
      const previous = group.dispatch_by;
      const change: DispatchChange = { kind: actor.kind === 'staff' ? 'extension' : 'recalculated', from: previous.toISOString(), to: due.toISOString(), reason, by: actor, at: this.core.now().toISOString() };
      await tx.update('seller_groups', groupId, { dispatch_by: due, dispatch_by_history: [...group.dispatch_by_history, change] });
      const entries: Parameters<Core['timeline']>[2] = [
        { group_id: groupId, visibility: 'seller', label: 'Dispatch deadline changed', detail: `New deadline ${dateTime(due, this.core.tz)}`, reason, actor },
        { group_id: groupId, visibility: 'staff', label: 'Dispatch deadline changed', detail: `${dateTime(previous, this.core.tz)} → ${dateTime(due, this.core.tz)}`, reason, actor },
      ];
      if (o.notifyCustomer) entries.push({ group_id: groupId, visibility: 'customer', label: 'New dispatch date', detail: `Package ${group.position} should now ship by ${shortDate(due, this.core.tz)}. Contact support if this no longer works for you.`, actor });
      await this.core.timeline(tx, agg.order.id, entries);
      batch.push('orders.dispatch_deadline.changed', { orderId: agg.order.id, groupId, dueAt: due.toISOString(), previousDueAt: previous.toISOString(), reason, by: actor });
    });
  }

  /* ---------------------------------------------------------------- public API for shipping and warehouse */

  async getFulfillmentTask(groupId: string): Promise<FulfillmentTask> {
    const g = await this.core.repo.get('seller_groups', groupId);
    if (!g) throw notFound('Fulfillment task');
    const agg = (await this.core.load(g.order_id))!;
    const cfg = await this.core.cfg();
    const group = agg.groups.find((x) => x.id === groupId)!;
    return {
      groupId,
      orderId: agg.order.id,
      orderRef: agg.order.ref,
      seller: this.views.sellerLabel(group),
      fulfilledBy: group.fulfilled_by as FulfillmentTask['fulfilledBy'],
      shipTo: agg.order.delivery_address,
      delivery: this.views.promise(group),
      dispatchDeadline: this.views.dispatchDeadline(agg, group, cfg),
      giftNote: agg.order.gift_note,
      hidePricesOnSlip: agg.order.hide_prices,
      openLines: agg.items
        .filter((i) => i.group_id === groupId && SHIPPABLE.includes(i.state))
        .map((i) => ({ orderItemId: i.id, stockItemId: i.stock_item_id, offerId: i.offer_id, title: this.views.title(i), variantLabel: this.views.variantLabel(i), sellerSku: i.offer_snapshot.sellerSku ?? null, quantityToShip: i.quantity })),
    };
  }

  async canShipItems(groupId: string, lines: { orderItemId: string; quantity: number }[]): Promise<{ ok: boolean; problems: string[] }> {
    const g = await this.core.repo.get('seller_groups', groupId);
    if (!g) return { ok: false, problems: ['The package does not exist'] };
    const order = await this.core.repo.get('orders', g.order_id);
    const items = await this.core.repo.find('order_items', { group_id: groupId });
    const problems: string[] = [];
    if (order?.lifecycle !== 'open') problems.push(order?.lifecycle === 'payment_pending' ? 'The payment is still being checked' : 'The order is not open');
    if (!lines.length) problems.push('No items to ship');
    const wanted = new Map<string, number>();
    for (const l of lines) wanted.set(l.orderItemId, (wanted.get(l.orderItemId) ?? 0) + l.quantity);
    for (const [id, qty] of wanted) {
      const i = items.find((x) => x.id === id);
      if (!i) problems.push(`Item ${id} is not part of this package`);
      else if (i.state === 'cancelled') problems.push(`${this.views.title(i)} was cancelled`);
      else if (!SHIPPABLE.includes(i.state)) problems.push(`${this.views.title(i)} has already shipped`);
      else if (!(qty >= 1) || qty > i.quantity) problems.push(`${this.views.title(i)}: at most ${i.quantity} left to ship`);
    }
    return { ok: !problems.length, problems };
  }

  /* ---------------------------------------------------------------- shipping events */

  private shipmentRow(e: { shipmentId: string; orderId: string; groupId: string }, prev: ShipmentRec | undefined, patch: Partial<ShipmentRec>): ShipmentRec {
    return {
      shipment_id: e.shipmentId,
      order_id: e.orderId,
      group_id: e.groupId,
      package_label: prev?.package_label ?? 'Package',
      carrier: prev?.carrier ?? null,
      service: prev?.service ?? null,
      tracking_number: prev?.tracking_number ?? null,
      tracking_url: prev?.tracking_url ?? null,
      status: prev?.status ?? 'label_created',
      estimated_arrival: prev?.estimated_arrival ?? null,
      shipped_at: prev?.shipped_at ?? null,
      delivered_at: prev?.delivered_at ?? null,
      item_ids: prev?.item_ids ?? [],
      lines: prev?.lines ?? null,
      ...patch,
    };
  }

  private async known(orderId: string, groupId: string) {
    const g = await this.core.repo.get('seller_groups', groupId);
    if (!g || g.order_id !== orderId) {
      this.core.ctx.log.info({ orderId, groupId }, 'orders: shipping event for an unknown package');
      return null;
    }
    return g;
  }

  async onShipmentCreated(e: EventPayload<'shipping.shipment.created'>) {
    if (e.kind === 'return' || !(await this.known(e.orderId, e.groupId))) return;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg) => {
      const prev = agg.shipments.find((s) => s.shipment_id === e.shipmentId);
      await tx.upsertShipment(
        this.shipmentRow(e, prev, {
          package_label: e.packageLabel,
          carrier: e.carrierName ?? e.carrierCode ?? null,
          service: e.serviceName ?? null,
          tracking_number: e.trackingNumber ?? null,
          tracking_url: e.trackingUrl ?? null,
          status: prev && prev.status !== 'label_created' ? prev.status : e.status || 'label_created',
          item_ids: prev?.item_ids.length ? prev.item_ids : [...new Set(e.lines.map((l) => l.orderItemId))],
          // the units the label carries (onLabelQuantity while it is not handed over)
          lines: prev?.lines ?? (e.lines.map((l) => ({ orderItemId: l.orderItemId, quantity: l.quantity })) as never),
        }),
      );
    });
  }

  /** shipping.exception.resolved: the delivery issue leaves the flag and the admin row's open exceptions */
  async onExceptionResolved(e: EventPayload<'shipping.exception.resolved'>) {
    if (!(await this.known(e.orderId, e.groupId))) return;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg) => {
      const fact = agg.factRows.find((f) => f.kind === 'delivery_issue' && f.source_id === e.exceptionId);
      if (!fact || fact.status === 'resolved') return;
      await this.core.updateFact(tx, agg, 'delivery_issue', e.exceptionId, { status: 'resolved' });
      await this.core.timeline(tx, agg.order.id, [{ group_id: e.groupId, visibility: 'staff', label: 'Delivery exception resolved', detail: e.resolution || e.kind }]);
    });
  }

  async onShipmentDispatched(e: EventPayload<'shipping.shipment.dispatched'>) {
    if (e.kind === 'return' || !(await this.known(e.orderId, e.groupId))) return;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg, batch) => {
      if (agg.items.some((i) => i.shipment_id === e.shipmentId)) return; // already applied
      const shippedIds: string[] = [];
      const wanted = new Map<string, number>();
      for (const l of e.lines) wanted.set(l.orderItemId, (wanted.get(l.orderItemId) ?? 0) + l.quantity);
      for (const [itemId, qty] of wanted) {
        let left = qty;
        for (const item of openParts(agg.items, e.groupId, itemId)) {
          if (!left) break;
          const { part } = await this.core.split(tx, batch, item, Math.min(left, item.quantity), agg.order.currency, 'shipment');
          await this.core.move(tx, batch, part, 'ship', { patch: { shipment_id: e.shipmentId, state_before_request: null } });
          shippedIds.push(part.id);
          left -= part.quantity;
        }
        if (left === qty) this.core.ctx.log.warn({ itemId, shipmentId: e.shipmentId }, 'orders: shipment line for an item that cannot ship');
      }
      const prev = agg.shipments.find((s) => s.shipment_id === e.shipmentId);
      await tx.upsertShipment(
        this.shipmentRow(e, prev, {
          status: prev && !['label_created'].includes(prev.status) ? prev.status : 'shipped',
          shipped_at: new Date(e.shippedAt),
          estimated_arrival: e.estimatedArrival ?? prev?.estimated_arrival ?? null,
          item_ids: shippedIds.length ? shippedIds : (prev?.item_ids ?? []),
          package_label: prev?.package_label ?? `Package ${agg.groups.find((g) => g.id === e.groupId)?.position ?? ''}`.trim(),
        }),
      );
      const g = agg.groups.find((x) => x.id === e.groupId)!;
      await this.core.timeline(tx, agg.order.id, [
        { group_id: e.groupId, visibility: 'customer', label: 'Shipped', detail: `Package ${g.position} is on its way${e.trackingValid ? '' : '; tracking will show once the carrier scans it'}.` },
        { group_id: e.groupId, visibility: 'seller', label: 'Shipment dispatched', detail: e.onTime === false ? 'Shipped after the dispatch deadline' : 'Shipped on time' },
      ]);
    });
  }

  async onShipmentStatusChanged(e: EventPayload<'shipping.shipment.status_changed'>) {
    if (e.kind === 'return' || !(await this.known(e.orderId, e.groupId))) return;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg, batch) => {
      const prev = agg.shipments.find((s) => s.shipment_id === e.shipmentId);
      await tx.upsertShipment(this.shipmentRow(e, prev, { status: e.to, estimated_arrival: e.estimatedArrival ?? prev?.estimated_arrival ?? null }));
      if (e.to === 'returned_to_sender') {
        const back: ItemRec[] = [];
        for (const i of agg.items.filter((x) => x.shipment_id === e.shipmentId && x.state === 'shipped')) back.push(await this.core.move(tx, batch, i, 'return_to_sender', { reason: 'Returned to sender' }));
        // the package is back with the seller: refunded like a cancellation (once; a replayed event finds nothing shipped)
        await this.cancellations.returnedToSender(tx, batch, agg, agg.groups.find((g) => g.id === e.groupId)!, back, e.shipmentId);
      }
    });
  }

  async onShipmentDelivered(e: EventPayload<'shipping.shipment.delivered'>) {
    if (e.kind === 'return') return;
    const g = await this.known(e.orderId, e.groupId);
    if (!g) return;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg, batch) => {
      const at = new Date(e.deliveredAt);
      let items = agg.items.filter((i) => i.shipment_id === e.shipmentId && i.state === 'shipped');
      if (!items.length) {
        const ids = new Set(e.lines.map((l) => l.orderItemId));
        items = agg.items.filter((i) => ids.has(i.id) && i.state === 'shipped');
      }
      for (const i of items) {
        const windowEnd = new Date(at.getTime() + (i.return_terms?.windowDays ?? 30) * DAY);
        await this.core.move(tx, batch, i, 'deliver', { patch: { delivered_at: at, return_window_ends_at: windowEnd } });
        batch.push('orders.item.delivered', {
          orderId: e.orderId,
          groupId: e.groupId,
          ownerType: g.owner_type as 'official' | 'seller',
          sellerId: g.seller_id,
          itemId: i.id,
          quantity: i.quantity,
          deliveredAt: at.toISOString(),
          returnWindowEndsAt: windowEnd.toISOString(),
          ...this.core.recipient(agg.order),
        });
      }
      const prev = agg.shipments.find((s) => s.shipment_id === e.shipmentId);
      await tx.upsertShipment(this.shipmentRow(e, prev, { status: 'delivered', delivered_at: at }));
      if (items.length) await this.core.timeline(tx, agg.order.id, [{ group_id: e.groupId, visibility: 'customer', label: 'Delivered', detail: `Package ${g.position} was delivered.` }, { group_id: e.groupId, visibility: 'seller', label: 'Delivered' }]);
    });
  }

  async onShipmentException(e: EventPayload<'shipping.shipment.exception'>) {
    if (!(await this.known(e.orderId, e.groupId))) return;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg) => {
      const added = await this.core.addFact(tx, agg.order.id, {
        kind: 'delivery_issue',
        source_id: e.exceptionId,
        subkind: e.kind,
        group_id: e.groupId,
        shipment_id: e.shipmentId ?? null,
        due_at: new Date(e.dueAt),
        customer_action: e.customerAction ?? null,
      });
      if (!added) return;
      await this.core.timeline(tx, agg.order.id, [{ group_id: e.groupId, visibility: 'staff', label: 'Delivery exception opened', detail: e.kind }]);
    });
  }

  /** Unshipped items of the group become Delayed; the customer is told and offered support */
  async onDispatchOverdue(e: EventPayload<'shipping.dispatch.overdue'>) {
    if (!(await this.known(e.orderId, e.groupId))) return;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg, batch) => {
      if (agg.order.lifecycle !== 'open') return;
      const items = agg.items.filter((i) => i.group_id === e.groupId && (i.state === 'confirmed' || i.state === 'preparing'));
      if (!items.length) return;
      for (const i of items) await this.core.move(tx, batch, i, 'mark_delayed', { reason: 'Dispatch deadline passed' });
      const g = agg.groups.find((x) => x.id === e.groupId)!;
      await this.core.timeline(
        tx,
        agg.order.id,
        marketlyFulfils(g)
          ? [
              { group_id: e.groupId, visibility: 'customer', label: 'Package delayed', detail: `Package ${g.position} has not shipped on time. Our warehouse is on it; you can cancel the items or contact support.` },
              { group_id: e.groupId, visibility: 'seller', label: 'Dispatch overdue', detail: "Marketly's warehouse is late with this package. Nothing to do on your side." },
            ]
          : [
              { group_id: e.groupId, visibility: 'customer', label: 'Package delayed', detail: `Package ${g.position} has not shipped on time. We have asked ${g.seller_name} to ship it; you can cancel the items or contact support.` },
              { group_id: e.groupId, visibility: 'seller', label: 'Dispatch overdue', detail: 'Ship now or cancel what you cannot fulfill.' },
            ],
      );
      batch.push('orders.item.delayed', { orderId: e.orderId, ...this.core.recipient(agg.order), groupId: e.groupId, itemIds: items.map((i) => i.id), source: 'overdue', expectedDispatchBy: null, reason: 'Dispatch deadline passed' });
    });
  }

  async onTrackingCorrected(e: EventPayload<'shipping.tracking.corrected'>) {
    const s = await this.core.repo.get('shipment_refs', e.shipmentId);
    if (!s || s.order_id !== e.orderId) return;
    await this.core.write(e.orderId, e.by ? { actor: e.by } : { actor: SYSTEM }, async (tx) => {
      const looksLikeCarrier = !/\d{6,}/.test(e.to);
      await tx.update('shipment_refs', e.shipmentId, looksLikeCarrier && s.carrier === e.from ? { carrier: e.to } : { tracking_number: e.to });
      await this.core.timeline(tx, e.orderId, [
        { group_id: s.group_id, visibility: 'customer', label: 'Tracking updated', detail: `Tracking for ${s.package_label} was corrected.` },
        { group_id: s.group_id, visibility: 'staff', label: 'Tracking corrected', detail: `${e.from} → ${e.to}`, reason: e.reason, actor: e.by },
      ]);
    });
  }

  /**
   * Official Store and Fulfilled by Marketly items become Preparing when picking starts (closing instant
   * cancellation). For Fulfilled by Marketly groups every warehouse stage is also written to the seller's timeline:
   * the latest one is the stage in the seller's status label.
   */
  async onWarehouseStatusChanged(e: EventPayload<'warehouse.fulfillment.status_changed'>) {
    const stage = WAREHOUSE_STAGE_LABEL[e.to];
    if (!PREPARING_WAREHOUSE.includes(e.to) && !stage) return;
    const g = await this.known(e.orderId, e.sellerGroupId);
    if (!g || (!PREPARING_WAREHOUSE.includes(e.to) && !isMarketlyService(g))) return;
    const latest = isMarketlyService(g) && stage ? await this.core.warehouseStages([e.orderId]) : null;
    await this.core.write(e.orderId, { actor: SYSTEM }, async (tx, agg, batch) => {
      if (stage && latest && latest.get(e.sellerGroupId) !== stage) {
        await this.core.timeline(tx, agg.order.id, [{ group_id: e.sellerGroupId, visibility: 'seller', label: WAREHOUSE_STAGE_ENTRY, detail: stage }]);
      }
      if (!PREPARING_WAREHOUSE.includes(e.to)) return;
      const items = agg.items.filter((i) => i.group_id === e.sellerGroupId && (i.state === 'confirmed' || i.state === 'delayed'));
      for (const i of items) await this.core.move(tx, batch, i, 'start_preparing', { reason: `Warehouse ${e.to}` });
      if (items.length) await this.core.timeline(tx, agg.order.id, [{ group_id: e.sellerGroupId, visibility: 'customer', label: 'Preparing your package', detail: 'Our warehouse is picking your items.' }]);
    });
  }

  /** Groups whose unshipped items are still to ship (for record scope helpers) */
  static openItems(agg: Agg, groupId: string) {
    return agg.items.filter((i) => i.group_id === groupId && is(UNSHIPPED, i.state));
  }
}
