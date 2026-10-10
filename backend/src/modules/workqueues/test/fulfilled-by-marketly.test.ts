/**
 * Fulfilled by Marketly: the four fulfillment.* queues (seeded on a fresh install and added to old installs by
 * migration 0004), fulfillment-service raises landing in them by dedupe prefix, and the Marketly warehouse's
 * overdue dispatches and delivery exceptions kept away from the seller.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allSpecs } from '../../../kernel/module-system/loader.js';
import { validSample } from '../../../testing/samples.js';
import { QUEUE_SEEDS } from '../domain/catalog.js';
import { escalationLabel } from '../domain/rules.js';
import { m0004FulfillmentService } from '../infra/postgres/migrations/0004_fulfillment_service.js';
import { as, boot, newId, publish } from './harness.js';

type Booted = Awaited<ReturnType<typeof boot>>;
let t: Booted;

beforeAll(async () => {
  t = await boot();
});
afterAll(async () => {
  await t?.app.close();
});

const FS_QUEUES = {
  'fulfillment.receiving': { ownerRole: 'warehouse_manager', screen: 'ops/receiving' },
  'fulfillment.reconciliation': { ownerRole: 'inventory_manager', screen: 'ops/inventory' },
  'fulfillment.requests': { ownerRole: 'warehouse_manager', screen: 'ops/pick-pack' },
  'fulfillment.enrollments': { ownerRole: 'seller_manager', screen: 'admin/sellers' },
} as const;

function ev(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const def = allSpecs[name.split('.')[0]!]!.events.publishes[name]!;
  return { ...(validSample(def.payload()).value as Record<string, unknown>), ...over };
}

const active = async (dedupeKey: string) => (await t.service.core.repo.activeByDedupe(dedupeKey)) ?? null;

describe('fulfillment.* queues', () => {
  it('are seeded on a fresh install: owner role, screen, never seller-visible', async () => {
    const seeded = (allSpecs.workqueues!.settings as Record<string, { default: unknown }>).seedQueues!.default as string[];
    for (const [key, def] of Object.entries(FS_QUEUES)) {
      expect(seeded).toContain(key);
      const q = await t.service.core.repo.getQueue(key);
      expect(q, key).toMatchObject({ owner_role: def.ownerRole, screen: def.screen, visible_to_seller: false, active: true });
    }
    const admin = t.world.person('Admin');
    const res = await t.app.inject({ method: 'GET', url: '/api/admin/workqueues/queues/fulfillment.receiving', headers: as.staff(admin) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().queue).toMatchObject({ key: 'fulfillment.receiving', name: 'Fulfilled by Marketly receiving', area: 'inventory_warehouse', ownerRole: 'warehouse_manager', visibleToSeller: false });
  });

  it('migration 0004 adds them to an install seeded before them, with the catalogue definitions; idempotent, staff edits kept', async () => {
    const db = t.app.kernel.database.kysely;
    // an install from before Fulfilled by Marketly
    await sql`delete from workqueues.queues where key like 'fulfillment.%'`.execute(db);
    expect(await t.service.core.repo.getQueue('fulfillment.receiving')).toBeFalsy();

    await t.app.kernel.database.exec(m0004FulfillmentService.sql!);
    for (const key of Object.keys(FS_QUEUES)) {
      const q = (await t.service.core.repo.getQueue(key))!;
      const s = QUEUE_SEEDS[key]!;
      expect(q, key).toMatchObject({
        name: s.name,
        area: s.area,
        owner_role: s.ownerRole,
        escalation_label: escalationLabel(s.escalationRoute),
        default_deadline_minutes: s.defaultDeadlineMinutes,
        business_hours_only: s.businessHoursOnly,
        pause_while_waiting: s.pauseWhileWaiting,
        screen: s.screen,
        screen_filter: s.screenFilter,
        visible_to_seller: false,
        active: true,
        updated_by: 'system',
      });
      expect(q.escalation_route, key).toEqual(s.escalationRoute);
    }

    await sql`update workqueues.queues set name = 'FBM inbound' where key = 'fulfillment.receiving'`.execute(db);
    await t.app.kernel.database.exec(m0004FulfillmentService.sql!);
    expect((await t.service.core.repo.getQueue('fulfillment.receiving'))!.name).toBe('FBM inbound');
    expect((await sql<{ n: number }>`select count(*)::int as n from workqueues.queues where key like 'fulfillment.%'`.execute(db)).rows[0]!.n).toBe(4);
  });
});

describe('fulfillment-service raises', () => {
  const subject = () => ({ type: 'other' as const, id: newId(), ref: 'FS-IN-261011-0001' });

  it('land in the seeded queue of their dedupe prefix, whatever queue the caller names, and resolveBySource closes them', async () => {
    const id = newId();
    const cases = [
      { kind: 'receiving', dedupeKey: `fs_inbound_overdue:${id}`, queue: 'fulfillment.receiving' },
      { kind: 'receiving', dedupeKey: `fs_discrepancy:${id}`, queue: 'fulfillment.receiving' },
      { kind: 'manual_task', dedupeKey: `fs_stock_difference:${newId()}`, queue: 'fulfillment.reconciliation' },
      { kind: 'pick_pack', dedupeKey: `fs_request_short:${newId()}`, queue: 'fulfillment.requests' },
      { kind: 'application_waiting', dedupeKey: `fs_enrollment:${newId()}`, queue: 'fulfillment.enrollments' },
      { kind: 'application_waiting', dedupeKey: `fs_sku:${newId()}`, queue: 'fulfillment.enrollments' },
    ] as const;
    for (const c of cases) {
      // named queue: the right one, and a wrong one (routed by the prefix)
      const item = await t.service.raise({ sourceModule: 'fulfillment-service', queueKey: c.queue, kind: c.kind, title: `FS ${c.kind}`, subject: subject(), dedupeKey: c.dedupeKey });
      expect(item, c.dedupeKey).toMatchObject({ queueKey: c.queue, kind: c.kind, state: 'open' });
      expect(item.visibleToSeller ?? false).toBe(false);
      const again = await t.service.raise({ sourceModule: 'fulfillment-service', queueKey: 'warehouse.pick_pack', kind: c.kind, title: `FS ${c.kind} (refreshed)`, subject: subject(), dedupeKey: c.dedupeKey });
      expect(again.id).toBe(item.id);
      expect(again.queueKey).toBe(c.queue);
    }
    // ordinary receiving work keeps the queue its raiser names
    const po = await t.service.raise({ sourceModule: 'purchasing', queueKey: 'purchasing.receiving', kind: 'receiving', title: 'PO arrival', subject: { type: 'purchase_order', id: newId() }, dedupeKey: `po_receiving:${newId()}` });
    expect(po.queueKey).toBe('purchasing.receiving');

    const closed = await t.service.resolveBySource(`fs_discrepancy:${id}`, { note: 'Discrepancy decided', by: { kind: 'system', id: null, name: 'fulfillment-service' } as never });
    expect(closed).toBe(1);
    expect(await active(`fs_discrepancy:${id}`)).toBeNull();
    expect(await active(`fs_inbound_overdue:${id}`)).toMatchObject({ queue_key: 'fulfillment.receiving' });
  });
});

describe('Fulfilled by Marketly dispatch and delivery items', () => {
  it('shipping.dispatch.overdue (marketly_service): warehouse.pick_pack, "Fulfilled by Marketly (warehouse)", not seller-visible; dispatch closes it', async () => {
    const sellerId = newId();
    const [a, b] = [newId(), newId()];
    const orderId = newId();
    await publish(t.app, 'shipping.dispatch.overdue', ev('shipping.dispatch.overdue', { orderId, orderRef: 'MK-261011-50001', ownerType: 'seller', sellerId, fulfilledBy: 'marketly_service', orderItemIds: [a, b], exceptionId: newId(), dueAt: new Date(Date.now() - 3_600_000).toISOString() }));
    const item = await active(`overdue_dispatch:${a}`);
    expect(item).toMatchObject({ kind: 'overdue_dispatch', queue_key: 'warehouse.pick_pack', summary: 'Fulfilled by Marketly (warehouse)', visible_to_seller: false, seller_id: sellerId, subject_type: 'order', subject_ref: 'MK-261011-50001', priority: 'high' });

    // the seller sees no task for it
    const tasks = await t.app.inject({ method: 'GET', url: '/api/seller/workqueues/tasks', headers: as.seller(sellerId) });
    expect(tasks.statusCode, tasks.body).toBe(200);
    expect(tasks.json().items).toEqual([]);

    await publish(t.app, 'shipping.shipment.dispatched', ev('shipping.shipment.dispatched', { orderId, sellerId, fulfilledBy: 'marketly_service', trackingValid: true, lines: [{ orderItemId: a, title: 'x', variantLabel: 'v', quantity: 1 }, { orderItemId: b, title: 'y', variantLabel: 'v', quantity: 1 }] }));
    expect(await active(`overdue_dispatch:${a}`)).toBeNull();
    expect(await active(`overdue_dispatch:${b}`)).toBeNull();
  });

  it('seller-fulfilled overdue dispatch still goes to shipping.overdue_dispatch, seller-visible', async () => {
    const sellerId = newId();
    const a = newId();
    await publish(t.app, 'shipping.dispatch.overdue', ev('shipping.dispatch.overdue', { ownerType: 'seller', sellerId, fulfilledBy: 'seller', orderItemIds: [a], exceptionId: newId() }));
    expect(await active(`overdue_dispatch:${a}`)).toMatchObject({ queue_key: 'shipping.overdue_dispatch', visible_to_seller: true, seller_id: sellerId });
  });

  it('shipping.shipment.exception (marketly_service): "Fulfilled by Marketly (warehouse)", not seller-visible', async () => {
    const sellerId = newId();
    const lost = newId();
    await publish(t.app, 'shipping.shipment.exception', ev('shipping.shipment.exception', { kind: 'lost_or_damaged', exceptionId: lost, sellerId, fulfilledBy: 'marketly_service', customerAction: null, shipmentId: newId() }));
    expect(await active(`exception:${lost}`)).toMatchObject({ kind: 'delivery_exception', queue_key: 'shipping.delivery_exceptions', summary: 'Fulfilled by Marketly (warehouse)', visible_to_seller: false });

    const item = newId();
    await publish(t.app, 'shipping.shipment.exception', ev('shipping.shipment.exception', { kind: 'missing_tracking', exceptionId: newId(), sellerId, fulfilledBy: 'marketly_service', orderItemIds: [item] }));
    const mt = await active(`missing_tracking:${item}`);
    expect(mt).toMatchObject({ kind: 'missing_tracking', visible_to_seller: false });
    expect(mt!.summary).toContain('Fulfilled by Marketly (warehouse)');

    const cannot = newId();
    await publish(t.app, 'shipping.shipment.exception', ev('shipping.shipment.exception', { kind: 'seller_cannot_fulfill', exceptionId: cannot, sellerId, fulfilledBy: 'marketly_service', orderItemIds: [newId()] }));
    expect(await active(`exception:${cannot}`)).toMatchObject({ visible_to_seller: false });

    // a seller-fulfilled missing tracking stays seller-visible
    const own = newId();
    await publish(t.app, 'shipping.shipment.exception', ev('shipping.shipment.exception', { kind: 'missing_tracking', exceptionId: newId(), sellerId, fulfilledBy: 'seller', orderItemIds: [own] }));
    expect(await active(`missing_tracking:${own}`)).toMatchObject({ visible_to_seller: true, summary: 'The package has no valid tracking number' });
  });
});
