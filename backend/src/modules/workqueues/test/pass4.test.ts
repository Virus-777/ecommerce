/**
 * Gap pass 4: QueueInput.key (given or derived) and the inventory.merge_candidates queue (seeded, routed by
 * the merge-candidate dedupe prefix, and the migration that moves old items out of inventory.low_stock).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { m0003Pass4 } from '../infra/postgres/migrations/0003_pass4.js';
import { as, boot, newId, type Person } from './harness.js';

type Booted = Awaited<ReturnType<typeof boot>>;
let t: Booted;
let lead: Person;
let backup: Person;
let owner: Person;

const MANAGER = ['workqueues.items.view', 'workqueues.items.work', 'workqueues.queues.manage', 'workqueues.items.view-all'];
const call = (method: 'GET' | 'POST', url: string, who: Person, payload?: unknown) =>
  t.app.inject({ method, url: `/api/admin/workqueues${url}`, headers: as.staff(who, MANAGER), ...(payload !== undefined ? { payload: payload as object } : {}) });
const route = [{ afterMinutes: 0, to: { kind: 'role', key: 'business_owner', name: 'Business Owner' }, notify: true }];

beforeAll(async () => {
  t = await boot();
  lead = t.world.person('Ivy Inventory', ['inventory_manager']);
  backup = t.world.person('Ian Inventory', ['inventory_manager']);
  owner = t.world.person('Olga Owner', ['business_owner']);
});
afterAll(async () => {
  await t?.app.close();
});

describe('QueueInput.key', () => {
  const body = () => ({ name: 'Cycle counts', area: 'inventory_warehouse', ownerRole: 'inventory_manager', leadId: lead.id, backupId: backup.id, escalationRoute: route, defaultDeadlineMinutes: 600, screen: 'ops/inventory', reason: 'Quarterly counts' });

  it('uses the given key; a taken key is 409; a malformed key is 400', async () => {
    const res = await call('POST', '/queues', owner, { ...body(), key: 'inventory.cycle_counts' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().key).toBe('inventory.cycle_counts');
    const again = await call('POST', '/queues', owner, { ...body(), key: 'inventory.cycle_counts' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('CONFLICT');
    for (const key of ['Inventory.Counts', 'inventory', 'a.b.c', 'inventory.cycle-counts']) {
      expect((await call('POST', '/queues', owner, { ...body(), key })).statusCode, key).toBe(400);
    }
  });

  it('derives <area>.<name slug> when no key is given', async () => {
    const res = await call('POST', '/queues', owner, body());
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().key).toBe('inventory_warehouse.cycle_counts');
  });
});

describe('inventory.merge_candidates', () => {
  it('is seeded with the inventory manager as owner role', async () => {
    const res = await call('GET', '/queues/inventory.merge_candidates', owner);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().queue).toMatchObject({ key: 'inventory.merge_candidates', ownerRole: 'inventory_manager', area: 'inventory_warehouse', screen: 'ops/inventory', screenFilter: 'merge_candidates', visibleToSeller: false });
  });

  it('merge candidates raised into inventory.low_stock land in inventory.merge_candidates; other manual tasks stay where named', async () => {
    const [a, b] = [newId(), newId()];
    const item = await t.service.raise({ sourceModule: 'inventory', queueKey: 'inventory.low_stock', kind: 'manual_task', title: 'Merge SKU-1 into SKU-2', subject: { type: 'stock_item', id: a, ref: 'SKU-1' }, priority: 'normal', dedupeKey: `inventory.merge_candidate:${a}:${b}` });
    expect(item.queueKey).toBe('inventory.merge_candidates');
    const other = await t.service.raise({ sourceModule: 'inventory', queueKey: 'inventory.low_stock', kind: 'manual_task', title: 'Count shelf 4', subject: { type: 'stock_item', id: newId() }, dedupeKey: `inventory.count:${newId()}` });
    expect(other.queueKey).toBe('inventory.low_stock');
  });

  it('the pass 4 migration moves open merge candidates out of inventory.low_stock (idempotent)', async () => {
    const [a, b] = [newId(), newId()];
    const item = await t.service.raise({ sourceModule: 'inventory', queueKey: 'inventory.low_stock', kind: 'manual_task', title: 'Merge', subject: { type: 'stock_item', id: a }, dedupeKey: `inventory.merge_candidate:${a}:${b}` });
    const low = await t.service.raise({ sourceModule: 'inventory', queueKey: 'inventory.low_stock', kind: 'low_stock', title: 'Low', subject: { type: 'stock_item', id: a }, dedupeKey: `low_stock:${a}` });
    await t.service.core.repo.updateItem(item.id, { queue_key: 'inventory.low_stock' });
    await t.app.kernel.database.exec(m0003Pass4.sql!);
    await t.app.kernel.database.exec(m0003Pass4.sql!);
    expect(await t.service.core.repo.getItem(item.id)).toMatchObject({ queue_key: 'inventory.merge_candidates' });
    expect(await t.service.core.repo.getItem(low.id)).toMatchObject({ queue_key: 'inventory.low_stock' });
  });
});
