/**
 * Work items over HTTP: who sees what, assignment rules, every state transition (and an illegal
 * one), manual escalation along the route, notes and history, manual tasks, filters and paging,
 * bulk assignment and exports.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allSpecs } from '../../../kernel/module-system/loader.js';
import { validSample } from '../../../testing/samples.js';
import { as, boot, capture, H, newId, publish, type Person } from './harness.js';

type Booted = Awaited<ReturnType<typeof boot>>;
let t: Booted;
let lead: Person;
let backup: Person;
let agent: Person;
let outsider: Person;
let manager: Person;

/** Permissions of a queue worker (no view-all, no assign-others) */
const WORKER = ['workqueues.items.view', 'workqueues.items.work'];
const LEAD = [...WORKER, 'workqueues.items.assign-others', 'workqueues.items.export'];

function ev(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const def = allSpecs[name.split('.')[0]!]!.events.publishes[name]!;
  return { ...(validSample(def.payload()).value as Record<string, unknown>), ...over };
}

async function overdueDispatch(o: { seller?: boolean; ref?: string } = {}) {
  const itemId = newId();
  await publish(t.app, 'shipping.dispatch.overdue', ev('shipping.dispatch.overdue', { orderId: newId(), orderRef: o.ref ?? `MK-261008-${Math.floor(Math.random() * 90000) + 10000}`, ownerType: o.seller === false ? 'official' : 'seller', sellerId: o.seller === false ? null : newId(), orderItemIds: [itemId] }));
  return (await t.service.core.repo.activeByDedupe(`overdue_dispatch:${itemId}`))!;
}

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, who: Person, perms?: string[], payload?: unknown) =>
  t.app.inject({ method, url: `/api/admin/workqueues${url}`, headers: as.staff(who, perms), ...(payload !== undefined ? { payload: payload as object } : {}) });

beforeAll(async () => {
  t = await boot();
  lead = t.world.person('Sam Lead', ['shipping_manager']);
  backup = t.world.person('Bea Backup', ['shipping_manager']);
  agent = t.world.person('Ana Agent', ['shipping_manager']);
  outsider = t.world.person('Otto Outsider', ['catalog_manager']);
  manager = t.world.person('Mia Owner', ['business_owner']);
  t.world.cover('shipping_manager', lead, backup);
  await publish(t.app, 'access.coverage.changed', { roleId: newId(), roleKey: 'shipping_manager', leadAccountId: lead.id, receivingAccountIds: [lead.id], viaBackup: false });
});
afterAll(async () => {
  await t?.app.close();
});

describe('visibility', () => {
  it('the queue role sees the item; others get 404; view-all sees everything', async () => {
    const item = await overdueDispatch();
    const mine = await call('GET', `/items/${item.id}`, agent, WORKER);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json()).toMatchObject({ ref: item.ref, queueName: 'Overdue dispatch', area: 'orders_shipping', lead: { staffId: lead.id, name: lead.name }, backup: { staffId: backup.id }, deadline: { state: 'on_time' }, source: { module: 'shipping', event: 'shipping.dispatch.overdue' } });
    expect(mine.json().history[0]).toMatchObject({ label: 'Raised from shipping.dispatch.overdue' });
    expect((await call('GET', `/items/${item.id}`, outsider, WORKER)).statusCode).toBe(404);
    expect((await call('POST', `/items/${item.id}/claim`, outsider, WORKER)).statusCode).toBe(404);
    const list = await call('GET', '/items?queueKey=shipping.overdue_dispatch&limit=100', outsider, WORKER);
    expect(list.json().items).toEqual([]);
    expect((await call('GET', `/items/${item.id}`, manager, [...WORKER, 'workqueues.items.view-all'])).statusCode).toBe(200);
    expect((await call('GET', `/items/${newId()}`, agent, WORKER)).statusCode).toBe(404);
  });

  it('the public getItem and listItems apply the same visibility', async () => {
    const item = await overdueDispatch();
    expect(await t.service.getItem(item.id, { kind: 'staff', accountId: outsider.id })).toBeNull();
    expect((await t.service.getItem(item.id, { kind: 'staff', accountId: agent.id }))?.id).toBe(item.id);
    const page = await t.service.listItems({ kinds: ['overdue_dispatch'] }, { limit: 100 }, { kind: 'staff', accountId: outsider.id });
    expect(page.items).toEqual([]);
  });
});

describe('assignment', () => {
  it('assigns to an eligible person (assigned event, audit); refuses others and needs assign-others for someone else', async () => {
    const item = await overdueDispatch();
    const seen = capture(t.app, 'workqueues.item.assigned');
    const res = await call('POST', `/items/${item.id}/assign`, lead, LEAD, { assigneeId: agent.id, nextAction: 'Call the seller' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ state: 'assigned', assignee: { staffId: agent.id, name: agent.name } });
    expect(res.json().history.at(-1)).toMatchObject({ label: `Assigned to ${agent.name}`, detail: 'Call the seller' });
    await t.app.kernel.events.drain();
    expect(seen.map((e) => e.payload)).toEqual([{ itemId: item.id, assigneeId: agent.id, queueKey: 'shipping.overdue_dispatch' }]);
    expect(t.world.audits.find((a) => a.action === 'workqueues.item.assign' && a.target.id === item.id)).toMatchObject({ module: 'workqueues', actor: { kind: 'staff', id: lead.id } });

    const notEligible = await call('POST', `/items/${item.id}/assign`, lead, LEAD, { assigneeId: outsider.id });
    expect(notEligible.statusCode).toBe(422);
    expect(notEligible.json().error.code).toBe('ASSIGNEE_NOT_ELIGIBLE');
    const noRight = await call('POST', `/items/${item.id}/assign`, agent, WORKER, { assigneeId: backup.id });
    expect(noRight.statusCode).toBe(403);
    // assigning yourself needs only items.work
    expect((await call('POST', `/items/${item.id}/assign`, backup, WORKER, { assigneeId: backup.id })).json()).toMatchObject({ assignee: { staffId: backup.id } });
  });

  it('claim takes and starts the item; claiming someone else\'s work in progress is a conflict', async () => {
    const item = await overdueDispatch();
    const c = await call('POST', `/items/${item.id}/claim`, agent, WORKER);
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ state: 'in_progress', assignee: { staffId: agent.id } });
    const again = await call('POST', `/items/${item.id}/claim`, backup, WORKER);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('CONFLICT');
  });

  it('bulk assign assigns what it can and lists what it skipped', async () => {
    const a = await overdueDispatch();
    const b = await overdueDispatch();
    const res = await call('POST', '/items/bulk-assign', lead, LEAD, { itemIds: [a.id, b.id, newId()], assigneeId: agent.id, nextAction: 'Chase today' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().assigned).toBe(2);
    expect(res.json().skipped).toEqual([expect.objectContaining({ code: 'NOT_FOUND' })]);
    expect((await call('POST', '/items/bulk-assign', agent, WORKER, { itemIds: [a.id], assigneeId: agent.id })).statusCode).toBe(403);
  });
});

describe('state transitions', () => {
  it('start → wait → resume → resolve (note required) → reopen → dismiss; illegal moves are 409', async () => {
    const item = await overdueDispatch();
    const resolved = capture(t.app, 'workqueues.item.resolved');
    const s = await call('POST', `/items/${item.id}/start`, agent, WORKER);
    expect(s.json()).toMatchObject({ state: 'in_progress', assignee: { staffId: agent.id } });
    const illegal = await call('POST', `/items/${item.id}/start`, agent, WORKER);
    expect(illegal.statusCode).toBe(409);
    expect(illegal.json().error.code).toBe('ILLEGAL_TRANSITION');
    const w = await call('POST', `/items/${item.id}/wait`, agent, WORKER, { waitingOn: 'seller', note: 'Seller promised tracking by noon', followUpAt: new Date(Date.now() + 3 * H).toISOString() });
    expect(w.json()).toMatchObject({ state: 'waiting', waitingOn: 'seller' });
    expect(w.json().notes.map((n: { body: string }) => n.body)).toEqual(['Seller promised tracking by noon']);
    expect((await call('POST', `/items/${item.id}/resume`, agent, WORKER)).json()).toMatchObject({ state: 'in_progress', waitingOn: null });
    const noNote = await call('POST', `/items/${item.id}/resolve`, agent, WORKER, { note: '  ' });
    expect(noNote.statusCode).toBe(400);
    const r = await call('POST', `/items/${item.id}/resolve`, agent, WORKER, { note: 'Seller shipped, tracking added by hand' });
    expect(r.json()).toMatchObject({ state: 'resolved', resolution: { outcome: 'resolved', note: 'Seller shipped, tracking added by hand' } });
    expect((await call('POST', `/items/${item.id}/resolve`, agent, WORKER, { note: 'again' })).statusCode).toBe(409);
    const re = await call('POST', `/items/${item.id}/reopen`, agent, WORKER, { reason: 'Tracking was wrong' });
    expect(re.json()).toMatchObject({ state: 'open', resolvedAt: null, resolution: null, assignee: null });
    const d = await call('POST', `/items/${item.id}/dismiss`, agent, WORKER, { reason: 'Duplicate of another order line' });
    expect(d.json()).toMatchObject({ state: 'dismissed', resolution: { outcome: 'dismissed' } });
    await t.app.kernel.events.drain();
    expect(resolved.map((e) => e.payload.outcome)).toEqual(['resolved', 'dismissed']);
    for (const action of ['workqueues.item.resolve', 'workqueues.item.reopen', 'workqueues.item.dismiss']) expect(t.world.audits.some((a) => a.action === action && a.target.id === item.id), action).toBe(true);
    const labels = (await call('GET', `/items/${item.id}`, agent, WORKER)).json().history.map((h: { label: string }) => h.label);
    expect(labels).toEqual(expect.arrayContaining(['Work started', 'Waiting on seller', 'Back in progress', 'Resolved', 'Reopened', 'Dismissed']));
  });

  it('reopening is refused while another item is open for the same source', async () => {
    const itemId = newId();
    const p = ev('shipping.dispatch.overdue', { ownerType: 'seller', sellerId: newId(), orderItemIds: [itemId] });
    await publish(t.app, 'shipping.dispatch.overdue', p);
    const first = (await t.service.core.repo.activeByDedupe(`overdue_dispatch:${itemId}`))!;
    await call('POST', `/items/${first.id}/resolve`, agent, WORKER, { note: 'Done by phone' });
    await publish(t.app, 'shipping.dispatch.overdue', p); // still not dispatched: a new item
    const second = (await t.service.core.repo.activeByDedupe(`overdue_dispatch:${itemId}`))!;
    expect(second.id).not.toBe(first.id);
    const re = await call('POST', `/items/${first.id}/reopen`, agent, WORKER, { reason: 'try' });
    expect(re.statusCode).toBe(409);
    expect(re.json().error.code).toBe('CONFLICT');
  });
});

describe('manual escalation', () => {
  it('walks the route one step at a time (conditions apply) and ends with ESCALATION_ROUTE_END', async () => {
    const seen = capture(t.app, 'workqueues.item.escalated');
    const seller = await overdueDispatch({ seller: true });
    const steps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', `/items/${seller.id}/escalate`, agent, WORKER, { reason: 'Seller unreachable' });
      expect(r.statusCode, r.body).toBe(200);
      steps.push(r.json().escalationLevel);
    }
    expect(steps).toEqual([1, 2, 3]);
    const end = await call('POST', `/items/${seller.id}/escalate`, agent, WORKER, { reason: 'More' });
    expect(end.statusCode).toBe(409);
    expect(end.json().error.code).toBe('ESCALATION_ROUTE_END');
    await t.app.kernel.events.drain();
    expect(seen.filter((e) => e.payload.itemId === seller.id).map((e) => [e.payload.level, e.payload.toKind, e.payload.to])).toEqual([
      [1, 'role', 'seller_manager'],
      [2, 'role', 'order_manager'],
      [3, 'role', 'business_owner'],
    ]);

    // Official Store items skip the 'seller items only' step
    const official = await overdueDispatch({ seller: false });
    const first = await call('POST', `/items/${official.id}/escalate`, agent, WORKER, { reason: 'Warehouse stuck' });
    expect(first.json()).toMatchObject({ escalationLevel: 2 });
    expect(t.world.audits.some((a) => a.action === 'workqueues.item.escalate' && a.target.id === official.id)).toBe(true);
  });
});

describe('notes, manual tasks, lists', () => {
  it('adds a note (201) shown on the item', async () => {
    const item = await overdueDispatch();
    const n = await call('POST', `/items/${item.id}/notes`, agent, WORKER, { body: 'Seller says the courier missed pickup' });
    expect(n.statusCode, n.body).toBe(201);
    expect(n.json()).toMatchObject({ body: 'Seller says the courier missed pickup', author: { kind: 'staff', id: agent.id } });
    expect((await call('POST', `/items/${item.id}/notes`, agent, WORKER, { body: '' })).statusCode).toBe(400);
    const got = (await call('GET', `/items/${item.id}`, agent, WORKER)).json();
    expect(got.notes).toHaveLength(1);
    expect(got.history.at(-1).label).toBe('Note added');
  });

  it('creates a manual task in a queue the caller works in, assigned when asked', async () => {
    const seen = capture(t.app, 'workqueues.item.created');
    const dueAt = new Date(Date.now() + 6 * H).toISOString();
    const res = await call('POST', '/items', lead, LEAD, { queueKey: 'shipping.delivery_exceptions', title: 'Call the carrier about the Bay Area delays', dueAt, assigneeId: agent.id, priority: 'high' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'manual_task', state: 'assigned', priority: 'high', assignee: { staffId: agent.id }, deadline: { dueAt }, source: { module: 'workqueues', raisedBy: { kind: 'staff', id: lead.id } } });
    await t.app.kernel.events.drain();
    expect(seen.some((e) => e.payload.itemId === res.json().id && e.payload.kind === 'manual_task')).toBe(true);
    expect((await call('POST', '/items', outsider, WORKER, { queueKey: 'shipping.delivery_exceptions', title: 'x', dueAt })).statusCode).toBe(403);
    expect((await call('POST', '/items', lead, LEAD, { queueKey: 'nope.queue', title: 'x', dueAt })).statusCode).toBe(400);
    expect((await call('POST', '/items', lead, LEAD, { queueKey: 'shipping.delivery_exceptions', title: 'x', dueAt, assigneeId: outsider.id })).json().error.code).toBe('ASSIGNEE_NOT_ELIGIBLE');
  });

  it('filters, sorts and pages', async () => {
    const ref = `MK-261009-${Math.floor(Math.random() * 90000) + 10000}`;
    const target = await overdueDispatch({ ref, seller: false });
    const bySubject = await call('GET', `/items?subjectRef=${ref}`, agent, WORKER);
    expect(bySubject.json().items.map((i: { id: string }) => i.id)).toEqual([target.id]);
    const byQ = await call('GET', `/items?q=${ref}`, agent, WORKER);
    expect(byQ.json().items.map((i: { id: string }) => i.id)).toEqual([target.id]);
    await call('POST', `/items/${target.id}/claim`, backup, WORKER);
    const mine = await call('GET', '/items?assignee=me&limit=100', backup, WORKER);
    expect(mine.json().items.map((i: { id: string }) => i.id)).toContain(target.id);
    expect((await call('GET', '/items?assignee=unassigned&limit=100', backup, WORKER)).json().items.map((i: { id: string }) => i.id)).not.toContain(target.id);
    expect((await call('GET', '/items?deadline=overdue&limit=100', backup, WORKER)).json().items.map((i: { id: string }) => i.id)).not.toContain(target.id);
    const paged = await call('GET', '/items?queueKey=shipping.overdue_dispatch&limit=1&sort=oldest', agent, WORKER);
    expect(paged.json().items).toHaveLength(1);
    expect(paged.json().nextCursor).toBeTruthy();
    const next = await call('GET', `/items?queueKey=shipping.overdue_dispatch&limit=1&sort=oldest&cursor=${paged.json().nextCursor}`, agent, WORKER);
    expect(next.json().items[0].id).not.toBe(paged.json().items[0].id);
    const numbered = await call('GET', '/items?area=orders_shipping&page=1&limit=2&sort=priority', agent, WORKER);
    expect(numbered.json()).toMatchObject({ page: 1 });
    expect(numbered.json().total).toBeGreaterThan(2);
    expect((await call('GET', '/items?assignee=nobody', agent, WORKER)).statusCode).toBe(400);
    expect((await call('GET', '/items?kind=teleport', agent, WORKER)).statusCode).toBe(400);
    const official = await call('GET', '/items?state=active&limit=100', agent, WORKER);
    expect(official.statusCode).toBe(200);
  });

  it('exports through reports, limited to the caller\'s queues (audited)', async () => {
    const res = await call('POST', '/items/exports', lead, LEAD, { filters: { queueKey: 'shipping.overdue_dispatch' }, format: 'csv' });
    expect(res.statusCode, res.body).toBe(202);
    expect(t.world.exports.at(-1)).toMatchObject({ dataset: 'workqueues.admin.items', format: 'csv' });
    expect(t.world.audits.some((a) => a.action === 'workqueues.items.export')).toBe(true);
    const rows = await t.service.exportRows('workqueues.admin.items', { queueKey: 'shipping.overdue_dispatch' }, { kind: 'staff', accountId: lead.id });
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows[0]).toMatchObject({ queue: 'Overdue dispatch', area: 'orders_shipping' });
    expect((await t.service.exportRows('workqueues.admin.items', {}, { kind: 'staff', accountId: outsider.id })).rows.every((r) => (r as { area: string }).area !== 'orders_shipping')).toBe(true);
    await expect(t.service.exportRows('other.dataset', {}, { kind: 'staff', accountId: lead.id })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
