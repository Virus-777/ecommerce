/**
 * Queues (definitions, live counts, changes, coverage), My work queues, the dashboard summary,
 * saved filters and the GraphQL read layer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allSpecs } from '../../../kernel/module-system/loader.js';
import { validSample } from '../../../testing/samples.js';
import { PLACEHOLDER_BACKUP, PLACEHOLDER_LEAD } from '../domain/catalog.js';
import { as, boot, capture, H, newId, publish, type Person } from './harness.js';

type Booted = Awaited<ReturnType<typeof boot>>;
let t: Booted;
let lead: Person;
let backup: Person;
let financeLead: Person;
let financeBackup: Person;
let owner: Person;
let outsider: Person;

const WORKER = ['workqueues.items.view', 'workqueues.items.work'];
const MANAGER = [...WORKER, 'workqueues.queues.manage', 'workqueues.items.export'];

function ev(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const def = allSpecs[name.split('.')[0]!]!.events.publishes[name]!;
  return { ...(validSample(def.payload()).value as Record<string, unknown>), ...over };
}
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, who: Person, perms?: string[], payload?: unknown) =>
  t.app.inject({ method, url: `/api/admin/workqueues${url}`, headers: as.staff(who, perms), ...(payload !== undefined ? { payload: payload as object } : {}) });
const covered = (role: string, l: Person) => publish(t.app, 'access.coverage.changed', { roleId: newId(), roleKey: role, leadAccountId: l.id, receivingAccountIds: [l.id], viaBackup: false });
const route = [
  { afterMinutes: 0, to: { kind: 'role', key: 'seller_manager', name: 'Seller Manager' }, condition: 'seller items only', notify: true },
  { afterMinutes: 2880, to: { kind: 'role', key: 'business_owner', name: 'Business Owner' }, notify: true },
];

beforeAll(async () => {
  t = await boot();
  lead = t.world.person('Sam Lead', ['shipping_manager']);
  backup = t.world.person('Bea Backup', ['shipping_manager']);
  financeLead = t.world.person('Fay Finance', ['finance_manager']);
  financeBackup = t.world.person('Fin Backup', ['finance_manager']);
  owner = t.world.person('Olga Owner', ['business_owner']);
  outsider = t.world.person('Otto Outsider', ['content_manager']);
  t.world.cover('shipping_manager', lead, backup);
  t.world.cover('finance_manager', financeLead, financeBackup);
  await covered('shipping_manager', lead);
  await covered('finance_manager', financeLead);
});
afterAll(async () => {
  await t?.app.close();
});

describe('queue definitions', () => {
  it('seeds every seedQueues queue with placeholders until access names people; coverage.changed fills them in', async () => {
    const all = await call('GET', '/queues', owner, [...WORKER, 'workqueues.items.view-all']);
    expect(all.statusCode, all.body).toBe(200);
    const keys = all.json().map((q: { key: string }) => q.key);
    for (const k of (allSpecs.workqueues!.settings as Record<string, { default: unknown }>).seedQueues!.default as string[]) expect(keys).toContain(k);
    const catalog = all.json().find((q: { key: string }) => q.key === 'catalog.product_review');
    expect(catalog.lead.staffId).toBe(PLACEHOLDER_LEAD);
    expect(catalog.backup.staffId).toBe(PLACEHOLDER_BACKUP);
    const ship = all.json().find((q: { key: string }) => q.key === 'shipping.overdue_dispatch');
    expect(ship).toMatchObject({ lead: { staffId: lead.id, name: lead.name }, backup: { staffId: backup.id }, escalationLabel: 'Seller Manager (seller items only), Order Manager after 4 h, Business Owner after 48 h' });
  });

  it('lists the queues the caller reaches, with live counts and mine; area filter', async () => {
    await publish(t.app, 'shipping.dispatch.overdue', ev('shipping.dispatch.overdue', { ownerType: 'seller', sellerId: newId(), orderItemIds: [newId()] }));
    const res = await call('GET', '/queues', lead, WORKER);
    const keys = res.json().map((q: { key: string }) => q.key);
    expect(keys).toContain('shipping.overdue_dispatch');
    expect(keys).not.toContain('finance.daily_checks');
    const od = res.json().find((q: { key: string }) => q.key === 'shipping.overdue_dispatch');
    expect(od).toMatchObject({ mine: true, screen: 'ops/dispatch' });
    expect(od.open).toBeGreaterThanOrEqual(1);
    expect(od.oldest).toMatchObject({ ageLabel: expect.stringContaining('·') });
    expect((await call('GET', '/queues?area=finance', lead, WORKER)).json()).toEqual([]);
    expect((await call('GET', '/queues?area=moon', lead, WORKER)).statusCode).toBe(400);
    const one = await call('GET', '/queues/shipping.overdue_dispatch', lead, WORKER);
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json().queue).toMatchObject({ key: 'shipping.overdue_dispatch', ownerRole: 'shipping_manager', visibleToSeller: true });
    expect(one.json().intakeRules.map((r: { event: string }) => r.event)).toContain('shipping.dispatch.overdue');
    expect(one.json().counts.open).toBeGreaterThanOrEqual(1);
    expect((await call('GET', '/queues/finance.daily_checks', lead, WORKER)).statusCode).toBe(404);
  });

  it('creates a queue (lead, backup, route required; backup differs from lead), audited', async () => {
    const body = { name: 'Bay Area carrier delays', area: 'orders_shipping', ownerRole: 'shipping_manager', leadId: lead.id, backupId: backup.id, escalationRoute: route, defaultDeadlineMinutes: 240, screen: 'ops/dispatch', reason: 'Storm week' };
    const res = await call('POST', '/queues', owner, MANAGER, body);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ key: 'orders_shipping.bay_area_carrier_delays', escalationLabel: 'Seller Manager (seller items only), Business Owner after 48 h', active: true, businessHoursOnly: false });
    expect((await call('POST', '/queues', owner, MANAGER, body)).json().key).toBe('orders_shipping.bay_area_carrier_delays_2');
    expect(t.world.audits.some((a) => a.action === 'workqueues.queue.create')).toBe(true);
    const same = await call('POST', '/queues', owner, MANAGER, { ...body, backupId: lead.id });
    expect(same.statusCode).toBe(422);
    expect(same.json().error.code).toBe('LEAD_EQUALS_BACKUP');
    expect((await call('POST', '/queues', owner, MANAGER, { ...body, escalationRoute: [] })).statusCode).toBe(400);
    expect((await call('POST', '/queues', owner, MANAGER, { ...body, leadId: newId() })).statusCode).toBe(400);
    expect((await call('POST', '/queues', owner, MANAGER, { ...body, area: 'moon' })).statusCode).toBe(400);
  });

  it('changing the lead publishes queue.changed; open items show the new lead at once; manual choices survive coverage changes', async () => {
    const itemId = newId();
    await publish(t.app, 'finance.payout.failed', ev('finance.payout.failed', { payoutId: itemId, ref: 'PO-1' }));
    const item = (await t.service.core.repo.activeByDedupe(`payout_failed:${itemId}`))!;
    const seen = capture(t.app, 'workqueues.queue.changed');
    const def = (await call('GET', '/queues/finance.payout_failures', owner, [...MANAGER, 'workqueues.items.view-all'])).json().queue;
    const res = await call('PATCH', '/queues/finance.payout_failures', owner, MANAGER, { name: def.name, area: def.area, ownerRole: def.ownerRole, leadId: financeBackup.id, backupId: financeLead.id, escalationRoute: def.escalationRoute, defaultDeadlineMinutes: def.defaultDeadlineMinutes, businessHoursOnly: def.businessHoursOnly, screen: def.screen, reason: 'Fay on leave rotation' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().lead.staffId).toBe(financeBackup.id);
    await t.app.kernel.events.drain();
    expect(seen.map((e) => e.payload)).toEqual([{ queueKey: 'finance.payout_failures', leadId: financeBackup.id, backupId: financeLead.id }]);
    expect(t.world.audits.find((a) => a.action === 'workqueues.queue.update')).toMatchObject({ reason: 'Fay on leave rotation' });
    expect((await call('GET', `/items/${item.id}`, financeBackup, WORKER)).json().lead.staffId).toBe(financeBackup.id);
    await covered('finance_manager', financeLead);
    expect((await t.service.core.repo.getQueue('finance.payout_failures'))!.lead_staff_id).toBe(financeBackup.id);
    expect((await call('PATCH', '/queues/nope.queue', owner, MANAGER, { ...def, leadId: financeLead.id, backupId: financeBackup.id, reason: 'x' })).statusCode).toBe(404);
  });

  it('coverage gaps: placeholders, a lead away without cover, one backup for many queues', async () => {
    const res = await call('GET', '/coverage-gaps', owner, MANAGER);
    expect(res.statusCode).toBe(200);
    const gaps = res.json() as { queueKey: string; problem: string }[];
    expect(gaps).toEqual(expect.arrayContaining([expect.objectContaining({ queueKey: 'catalog.product_review', problem: 'no_lead' }), expect.objectContaining({ queueKey: 'catalog.product_review', problem: 'no_backup' })]));
    expect(gaps.some((g) => g.queueKey === 'shipping.overdue_dispatch' && g.problem === 'no_lead')).toBe(false);
    // shipping backup also covers the shipping queues: 3 seeded + 2 created → more than 3
    expect(gaps.some((g) => g.problem === 'same_backup_for_many')).toBe(true);
    lead.away = true;
    backup.away = true;
    await publish(t.app, 'access.away.started', { awayPeriodId: newId(), accountId: lead.id, until: new Date(Date.now() + 86_400_000).toISOString(), coverage: [], delegateApprovals: false });
    const away = (await call('GET', '/coverage-gaps', owner, MANAGER)).json() as { queueKey: string; problem: string }[];
    expect(away.some((g) => g.queueKey === 'shipping.overdue_dispatch' && g.problem === 'lead_away_no_cover')).toBe(true);
    lead.away = false;
    backup.away = false;
    await publish(t.app, 'access.away.ended', { awayPeriodId: newId(), accountId: lead.id });
  });
});

describe('My work queues and the dashboard', () => {
  it('GET /me: my queues, stats, routine, saved filters, export scope and reminders', async () => {
    const res = await call('GET', '/me', lead, [...WORKER, 'workqueues.items.export']);
    expect(res.statusCode, res.body).toBe(200);
    const me = res.json();
    expect(me.me).toEqual({ staffId: lead.id, name: lead.name, roles: ['shipping_manager'] });
    expect(me.queues.map((q: { key: string }) => q.key)).toEqual(expect.arrayContaining(['shipping.overdue_dispatch', 'shipping.missing_tracking']));
    expect(me.queues.map((q: { key: string }) => q.key)).not.toContain('finance.daily_checks');
    expect(me.stats.queuesILead).toBeGreaterThanOrEqual(3);
    expect(me.stats.oldestOpen).toMatchObject({ ageLabel: expect.any(String) });
    expect(me.routine.date).toBe(me.date);
    expect(me.exportScope).toEqual(['orders_shipping']);
    expect(me.reminders.some((r: string) => / escalates to .*Business Owner/.test(r))).toBe(true);
    expect(me.reminders.at(-1)).toBe('Exports are limited to your areas: orders_shipping');
    const noExport = await call('GET', '/me', lead, WORKER);
    expect(noExport.json().exportScope).toEqual([]);
    const all = await call('GET', '/me?all=true', owner, [...WORKER, 'workqueues.items.view-all']);
    expect(all.json().queues.length).toBeGreaterThan(15);
    const notAll = await call('GET', '/me?all=true', outsider, WORKER);
    expect(notAll.json().queues).toEqual([]);
  });

  it('GET /summary: tiles (danger when overdue), overdue dispatch and team on shift', async () => {
    const itemId = newId();
    await publish(t.app, 'shipping.dispatch.overdue', ev('shipping.dispatch.overdue', { ownerType: 'seller', sellerId: newId(), orderItemIds: [itemId] }));
    t.clock.advance(5 * H);
    try {
      const res = await call('GET', '/summary', lead, WORKER);
      expect(res.statusCode, res.body).toBe(200);
      const tile = res.json().needsAttention.find((x: { queueKey: string }) => x.queueKey === 'shipping.overdue_dispatch');
      expect(tile).toMatchObject({ tone: 'danger', areaLabel: 'Order & Shipping', screen: 'ops/dispatch', screenFilter: 'overdue' });
      expect(tile.overdue).toBeGreaterThanOrEqual(1);
      expect(res.json().overdueDispatch.length).toBeGreaterThanOrEqual(1);
      expect(res.json().overdueDispatch.length).toBeLessThanOrEqual(5);
      expect(res.json().team).toEqual(expect.arrayContaining([expect.objectContaining({ staff: expect.objectContaining({ staffId: lead.id }), role: 'lead', status: 'on_shift' }), expect.objectContaining({ staff: expect.objectContaining({ staffId: backup.id }), role: 'backup' })]));
      expect(res.json().team.some((m: { staff: { staffId: string } }) => m.staff.staffId === financeLead.id)).toBe(false);
      const outsiderView = await call('GET', '/summary', outsider, WORKER);
      expect(outsiderView.json().needsAttention).toEqual([]);
    } finally {
      t.clock.advance(-5 * H);
    }
  });
});

describe('saved filters', () => {
  it('saves my filter with a live count, shares it, only the owner changes or deletes it, and it filters the list', async () => {
    const created = await call('POST', '/saved-filters', lead, WORKER, { name: 'Overdue marketplace dispatch', target: 'work_items', filters: { queueKey: 'shipping.overdue_dispatch', sellerKind: 'marketplace' } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ owner: { staffId: lead.id }, shared: false, target: 'work_items' });
    expect(created.json().count).toBeGreaterThanOrEqual(1);
    const screen = await call('POST', '/saved-filters', lead, WORKER, { name: 'Overdue over 24 h', target: 'screen', screen: 'ops/dispatch', filters: { overdueOver: '24h', sellerKind: 'marketplace' }, shared: true });
    expect(screen.json()).toMatchObject({ target: 'screen', count: null, shared: true });
    expect((await call('POST', '/saved-filters', lead, WORKER, { name: 'x', target: 'screen', filters: {} })).statusCode).toBe(400);
    expect((await call('POST', '/saved-filters', lead, WORKER, { name: 'x', target: 'work_items', filters: { kind: 'teleport' } })).statusCode).toBe(400);

    const theirs = await call('GET', '/saved-filters', backup, WORKER);
    expect(theirs.json().map((f: { id: string }) => f.id)).toEqual([screen.json().id]);
    expect((await call('GET', '/saved-filters?screen=ops/dispatch', lead, WORKER)).json().map((f: { id: string }) => f.id)).toEqual([screen.json().id]);
    expect((await call('PATCH', `/saved-filters/${screen.json().id}`, backup, WORKER, { name: 'mine now', target: 'screen', screen: 'ops/dispatch', filters: {} })).statusCode).toBe(403);
    expect((await call('PATCH', `/saved-filters/${created.json().id}`, backup, WORKER, { name: 'x', target: 'work_items', filters: {} })).statusCode).toBe(404);
    const renamed = await call('PATCH', `/saved-filters/${created.json().id}`, lead, WORKER, { name: 'Marketplace overdue', target: 'work_items', shared: true, filters: { queueKey: 'shipping.overdue_dispatch', sellerKind: 'marketplace' } });
    expect(renamed.json()).toMatchObject({ name: 'Marketplace overdue', shared: true });

    const listed = await call('GET', `/items?savedFilterId=${created.json().id}&limit=100`, backup, WORKER);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.every((i: { queueKey: string; sellerId: string | null }) => i.queueKey === 'shipping.overdue_dispatch' && i.sellerId)).toBe(true);
    expect((await call('GET', `/items?savedFilterId=${screen.json().id}`, lead, WORKER)).statusCode).toBe(400);

    expect((await call('DELETE', `/saved-filters/${screen.json().id}`, backup, WORKER)).statusCode).toBe(403);
    expect((await call('DELETE', `/saved-filters/${screen.json().id}`, lead, WORKER)).statusCode).toBe(204);
    expect((await call('GET', '/saved-filters', backup, WORKER)).json().map((f: { id: string }) => f.id)).toEqual([created.json().id]);
  });
});

describe('GraphQL', () => {
  const gql = (who: Person, query: string, variables?: unknown) => t.app.inject({ method: 'POST', url: '/graphql/admin', headers: as.staff(who, WORKER), payload: { query, variables } });

  it('myQueues, workSummary, workItems and workItem resolve with the REST rules', async () => {
    const res = await gql(
      lead,
      `{ myQueues { me { staffId name } roles stats { overdue queuesILead } queues { key area lead { name } escalationRoute { toName afterMinutes } open items(paging: { limit: 2 }) { items { ref kind state deadline { state } subject { type ref } } } } routine { total checks { state } } exportScope }
         workSummary { needsAttention { queueKey tone } overdueDispatch(limit: 2) { ref priority } team { role status staff { name } } }
         workItems(filter: { kinds: [OVERDUE_DISPATCH] }, paging: { limit: 3 }) { items { id ref kind area amount { formatted } source { raisedBy { kind } } history { label actor { kind } } } } }`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
    expect(body.data.myQueues.me.staffId).toBe(lead.id);
    const od = body.data.myQueues.queues.find((q: { key: string }) => q.key === 'shipping.overdue_dispatch');
    expect(od).toMatchObject({ area: 'ORDERS_SHIPPING', lead: { name: lead.name } });
    expect(od.escalationRoute[0]).toEqual({ toName: 'Seller Manager', afterMinutes: 0 });
    expect(od.items.items[0]).toMatchObject({ kind: 'OVERDUE_DISPATCH', subject: { type: 'ORDER' } });
    expect(body.data.workItems.items[0]).toMatchObject({ kind: 'OVERDUE_DISPATCH', area: 'ORDERS_SHIPPING', source: { raisedBy: { kind: 'SYSTEM' } } });
    const id = body.data.workItems.items[0].id;
    const one = await gql(lead, 'query($id: UUID!) { workItem(id: $id) { id state lead { staffId } } }', { id });
    expect(one.json().data.workItem).toMatchObject({ id, state: expect.any(String), lead: { staffId: lead.id } });
    const hidden = await gql(outsider, 'query($id: UUID!) { workItem(id: $id) { id } }', { id });
    expect(hidden.json().data.workItem).toBeNull();
  });

  it("uses the caller's permissions from the request like REST (dev-token view-all) (G64c)", async () => {
    const viewAll = (query: string, variables?: unknown) =>
      t.app.inject({ method: 'POST', url: '/graphql/admin', headers: as.staff(outsider, [...WORKER, 'workqueues.items.view-all']), payload: { query, variables } });
    const rest = await call('GET', '/summary', outsider, [...WORKER, 'workqueues.items.view-all']);
    expect(rest.statusCode).toBe(200);
    const res = await viewAll('{ workSummary { needsAttention { queueKey } } workItems(filter: { kinds: [OVERDUE_DISPATCH] }, paging: { limit: 1 }) { items { id } } }');
    const body = res.json();
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
    expect(body.data.workSummary.needsAttention.map((x: { queueKey: string }) => x.queueKey)).toEqual(rest.json().needsAttention.map((x: { queueKey: string }) => x.queueKey));
    expect(body.data.workSummary.needsAttention.length).toBeGreaterThan(0);
    const id = body.data.workItems.items[0].id;
    expect((await viewAll('query($id: UUID!) { workItem(id: $id) { id } }', { id })).json().data.workItem).toEqual({ id });
  });
});
