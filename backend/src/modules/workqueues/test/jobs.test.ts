/**
 * Jobs and the time-driven parts: the daily routine (generate, check in, late), the day-end review
 * (prepare, check, NOTE_REQUIRED, complete, missed, daily counts), the deadline sweep (due soon,
 * overdue once, escalation along the route, backup routing while the lead is away) and the archive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allSpecs } from '../../../kernel/module-system/loader.js';
import { validSample } from '../../../testing/samples.js';
import { as, boot, capture, H, MIN, newId, publish, type Person } from './harness.js';

type Booted = Awaited<ReturnType<typeof boot>>;
let t: Booted;
let lead: Person;
let backup: Person;
let financeLead: Person;
let financeBackup: Person;
let owner: Person;

const WORKER = ['workqueues.items.view', 'workqueues.items.work'];
const RUNNER = [...WORKER, 'workqueues.day-end.run', 'workqueues.routines.manage', 'workqueues.queues.manage'];

function ev(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const def = allSpecs[name.split('.')[0]!]!.events.publishes[name]!;
  return { ...(validSample(def.payload()).value as Record<string, unknown>), ...over };
}
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, who: Person, perms?: string[], payload?: unknown) =>
  t.app.inject({ method, url: `/api/admin/workqueues${url}`, headers: as.staff(who, perms), ...(payload !== undefined ? { payload: payload as object } : {}) });
const covered = (role: string, l: Person) => publish(t.app, 'access.coverage.changed', { roleId: newId(), roleKey: role, leadAccountId: l.id, receivingAccountIds: [l.id], viaBackup: false });
const sweep = () => t.app.kernel.jobs.runNow('workqueues.deadline-sweep');

async function overdueDispatch(seller = true) {
  const itemId = newId();
  await publish(t.app, 'shipping.dispatch.overdue', ev('shipping.dispatch.overdue', { ownerType: seller ? 'seller' : 'official', sellerId: seller ? newId() : null, orderItemIds: [itemId] }));
  return (await t.service.core.repo.activeByDedupe(`overdue_dispatch:${itemId}`))!;
}

beforeAll(async () => {
  t = await boot();
  lead = t.world.person('Sam Lead', ['shipping_manager']);
  backup = t.world.person('Bea Backup', ['shipping_manager']);
  financeLead = t.world.person('Fay Finance', ['finance_manager']);
  financeBackup = t.world.person('Fin Backup', ['finance_manager']);
  owner = t.world.person('Olga Owner', ['business_owner']);
  t.world.cover('shipping_manager', lead, backup);
  t.world.cover('finance_manager', financeLead, financeBackup);
  await covered('shipping_manager', lead);
  await covered('finance_manager', financeLead);
});
afterAll(async () => {
  await t?.app.close();
});

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

describe('daily routine', () => {
  const ids = { review: newId(), shared: newId(), early: newId() };

  it('replaces the routine (validated, audited) and lists the templates', async () => {
    const bad = await call('PUT', '/routine-templates', owner, RUNNER, { reason: 'x', templates: [{ id: newId(), title: 'x', areaLabel: 'Ops', ownerRoles: [], dueTime: '25:00', weekdays: [9], active: true }] });
    expect(bad.statusCode).toBe(400);
    const res = await call('PUT', '/routine-templates', owner, RUNNER, {
      reason: 'New season routine',
      templates: [
        { id: ids.review, title: 'Review dispatch and delivery', areaLabel: 'Order & Shipping', ownerRoles: ['shipping_manager'], dueTime: '23:58', weekdays: EVERY_DAY, active: true },
        { id: ids.shared, title: 'Managers check in', areaLabel: 'Operations', ownerRoles: ['shipping_manager', 'finance_manager'], dueTime: '23:58', weekdays: EVERY_DAY, active: true },
        { id: ids.early, title: 'Early check', areaLabel: 'Order & Shipping', ownerRoles: ['shipping_manager'], dueTime: '00:00', weekdays: EVERY_DAY, active: true },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const active = res.json().filter((x: { active: boolean }) => x.active);
    expect(active.map((x: { id: string }) => x.id).sort()).toEqual(Object.values(ids).sort());
    expect(res.json().length).toBeGreaterThan(3); // the installed defaults stay, inactive
    expect(t.world.audits.some((a) => a.action === 'workqueues.routine.replace')).toBe(true);
    expect((await call('GET', '/routine-templates', owner, RUNNER)).json()).toHaveLength(res.json().length);
  });

  it("generates today's checks for the roles on shift; shared checks count check-ins", async () => {
    const res = await call('GET', '/routines/today', lead, WORKER);
    expect(res.statusCode, res.body).toBe(200);
    const day = res.json();
    expect(day.total).toBe(3);
    const review = day.checks.find((c: { title: string }) => c.title === 'Review dispatch and delivery');
    expect(review).toMatchObject({ owner: { staffId: lead.id }, state: 'not_done', checkedIn: null });
    const shared = day.checks.find((c: { title: string }) => c.title === 'Managers check in');
    expect(shared.checkedIn).toEqual({ done: 0, total: 2 });

    const done = await call('POST', `/routine-checks/${review.id}/complete`, lead, WORKER, { note: 'All dispatched' });
    expect(done.json()).toMatchObject({ state: 'done', doneBy: { staffId: lead.id }, note: expect.stringContaining('All dispatched') });
    expect((await call('POST', `/routine-checks/${review.id}/complete`, lead, WORKER, {})).statusCode).toBe(409);

    const first = await call('POST', `/routine-checks/${shared.id}/complete`, lead, WORKER, {});
    expect(first.json()).toMatchObject({ state: 'in_progress', checkedIn: { done: 1, total: 2 } });
    const second = await call('POST', `/routine-checks/${shared.id}/complete`, financeLead, WORKER, {});
    expect(second.json()).toMatchObject({ state: 'done', checkedIn: { done: 2, total: 2 }, doneBy: { staffId: financeLead.id } });
    expect((await call('POST', `/routine-checks/${newId()}/complete`, lead, WORKER, {})).statusCode).toBe(404);
  });

  it('routine-late marks checks past their due time late; a late check can still be completed', async () => {
    await t.app.kernel.jobs.runNow('workqueues.routine-late');
    const day = (await call('GET', '/routines/today', lead, WORKER)).json();
    const early = day.checks.find((c: { title: string }) => c.title === 'Early check');
    expect(early.state).toBe('late');
    expect((await call('POST', `/routine-checks/${early.id}/complete`, lead, WORKER, {})).json().state).toBe('done');
    expect(day.done).toBe(2);
  });
});

describe('day-end review', () => {
  it('is built from open items and forecasts (sources that are off are unavailable); completing needs every item checked', async () => {
    const overdue = await overdueDispatch();
    await t.service.core.repo.updateItem(overdue.id, { due_at: new Date(t.clock.now().getTime() - H) });
    const cur = await call('GET', '/day-end-reviews/current', lead, WORKER);
    expect(cur.statusCode, cur.body).toBe(200);
    const review = cur.json();
    expect(review).toMatchObject({ state: 'open', sharedWithRoles: expect.arrayContaining(['shipping_manager', 'finance_manager']), summarySentTo: [] });
    expect(review.items.map((i: { key: string }) => i.key)).toEqual(['unresolved_commitments', 'failed_payouts', 'upcoming_campaigns', 'next_day_shipping']);
    expect(review.items.find((i: { key: string }) => i.key === 'unresolved_commitments')).toMatchObject({ source: 'workqueues', checked: false });
    expect(review.items.find((i: { key: string }) => i.key === 'upcoming_campaigns').source).toBe('unavailable');
    expect((await call('GET', '/day-end-reviews/current', lead, WORKER)).json().id).toBe(review.id);

    const early = await call('POST', `/day-end-reviews/${review.id}/complete`, lead, RUNNER, {});
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatchObject({ code: 'DAY_END_INCOMPLETE', details: { items: expect.arrayContaining(['unresolved_commitments']) } });

    const noNote = await call('POST', `/day-end-reviews/${review.id}/items/unresolved_commitments/check`, lead, RUNNER, {});
    expect(noNote.statusCode).toBe(422);
    expect(noNote.json().error.code).toBe('NOTE_REQUIRED');
    expect((await call('POST', `/day-end-reviews/${review.id}/items/nothing/check`, lead, RUNNER, {})).statusCode).toBe(404);
    const ok = await call('POST', `/day-end-reviews/${review.id}/items/unresolved_commitments/check`, lead, RUNNER, { note: 'Seller promised dispatch tonight' });
    expect(ok.json().items[0]).toMatchObject({ checked: true, checkedBy: { staffId: lead.id }, note: 'Seller promised dispatch tonight' });
    for (const key of ['failed_payouts', 'upcoming_campaigns']) expect((await call('POST', `/day-end-reviews/${review.id}/items/${key}/check`, lead, RUNNER, {})).statusCode).toBe(200);
    // overdue dispatch work is open: next-day shipping needs a note too
    expect((await call('POST', `/day-end-reviews/${review.id}/items/next_day_shipping/check`, lead, RUNNER, {})).statusCode).toBe(422);
    await call('POST', `/day-end-reviews/${review.id}/items/next_day_shipping/check`, lead, RUNNER, { note: 'Carrier pickup at 18:00' });

    const seen = capture(t.app, 'workqueues.day_end.completed');
    const done = await call('POST', `/day-end-reviews/${review.id}/complete`, lead, RUNNER, { note: 'Quiet day' });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ state: 'completed', completedBy: { staffId: lead.id }, summarySentTo: review.sharedWithRoles });
    await t.app.kernel.events.drain();
    expect(seen[0]!.payload).toMatchObject({ reviewId: review.id, date: review.date });
    expect(seen[0]!.payload.openItems).toBeGreaterThanOrEqual(1);
    expect(t.world.notices.at(-1)).toMatchObject({ topic: 'staff.mention', recipients: expect.arrayContaining([{ kind: 'staff_role', roleKey: 'shipping_manager' }]) });
    expect(t.world.audits.some((a) => a.action === 'workqueues.day_end.complete')).toBe(true);
    expect((await call('POST', `/day-end-reviews/${review.id}/items/failed_payouts/check`, lead, RUNNER, {})).statusCode).toBe(409);
    expect((await call('POST', `/day-end-reviews/${review.id}/complete`, lead, RUNNER, {})).statusCode).toBe(409);

    // My work queues shows today's review
    expect((await call('GET', '/me', lead, WORKER)).json().dayEnd).toMatchObject({ id: review.id, state: 'completed' });
  });

  it('an uncompleted review is missed at day end (daily counts snapshot) and the next day lists it', async () => {
    t.clock.advance(24 * H);
    try {
      await t.app.kernel.jobs.runNow('workqueues.day-end-prepare');
      const review = await t.service.dayEnd.current();
      await t.app.kernel.jobs.runNow('workqueues.day-end-close');
      expect((await t.service.dayEnd.list({ state: 'missed' }, { mode: 'cursor', cursor: null, limit: 10 })).items.map((r) => r.id)).toContain(review.id);
      const counts = await t.service.core.repo.dailyCounts(review.date);
      expect(counts.find((c) => c.queue_key === 'shipping.overdue_dispatch')!.open).toBeGreaterThanOrEqual(1);
      const past = await call('GET', '/day-end-reviews?state=missed', lead, WORKER);
      expect(past.json().items.map((r: { id: string }) => r.id)).toContain(review.id);
      t.clock.advance(24 * H);
      const next = await t.service.dayEnd.current();
      expect(next.items.find((i) => i.key === 'custom')).toMatchObject({ title: "Yesterday's review was missed" });
      // yesterday's unfinished routine checks become late when today's are generated
      await t.app.kernel.jobs.runNow('workqueues.routine-generate');
      expect((await t.service.routines.today()).total).toBe(3);
    } finally {
      t.clock.advance(-48 * H);
    }
  });
});

describe('deadline sweep and escalation', () => {
  it('due soon, then overdue once (to the lead and backup), then each route step as its time comes', async () => {
    const seen = capture(t.app, 'workqueues.item.overdue', 'workqueues.item.escalated');
    const item = await overdueDispatch(true); // queue deadline 4 h, route: seller manager (seller items) at 0, order manager after 4 h, owner after 48 h
    t.clock.advance(3 * H + 10 * MIN);
    await sweep();
    expect((await t.service.core.repo.getItem(item.id))!.deadline_state).toBe('due_soon');
    expect(seen).toEqual([]);

    t.clock.advance(51 * MIN);
    await sweep();
    await sweep();
    await t.app.kernel.events.drain();
    const mine = seen.filter((e) => e.payload.itemId === item.id);
    expect(mine.filter((e) => e.name === 'workqueues.item.overdue').map((e) => e.payload)).toEqual([expect.objectContaining({ queueKey: 'shipping.overdue_dispatch', kind: 'overdue_dispatch', leadId: lead.id, backupId: backup.id, sellerId: item.seller_id })]);
    expect(mine.filter((e) => e.name === 'workqueues.item.escalated').map((e) => [e.payload.level, e.payload.to])).toEqual([[1, 'seller_manager']]);
    const row = (await t.service.core.repo.getItem(item.id))!;
    expect(row).toMatchObject({ deadline_state: 'overdue', escalation_level: 1, escalated_to: 'role:seller_manager' });

    t.clock.advance(4 * H);
    await sweep();
    t.clock.advance(44 * H);
    await sweep();
    await sweep();
    await t.app.kernel.events.drain();
    expect(seen.filter((e) => e.payload.itemId === item.id && e.name === 'workqueues.item.escalated').map((e) => e.payload.level)).toEqual([1, 2, 3]);
    const got = await call('GET', `/items/${item.id}`, lead, WORKER);
    expect(got.json()).toMatchObject({ deadline: { state: 'overdue' }, escalationLevel: 3 });
    expect(got.json().history.map((h: { label: string }) => h.label)).toEqual(expect.arrayContaining(['Due soon', 'Passed its deadline', 'Escalated to Business Owner (step 3)']));
    t.clock.advance(-(3 * H + 10 * MIN + 51 * MIN + 48 * H));
  });

  it('a refreshed later deadline goes back to on time', async () => {
    const subjectId = newId();
    const base = { queueKey: 'warehouse.pick_pack', kind: 'pick_pack', title: 'Pick', subject: { type: 'order' as const, id: subjectId }, dedupeKey: `pick_pack:${subjectId}`, dueAt: new Date(t.clock.now().getTime() - H).toISOString() };
    const first = await t.service.raise(base);
    await sweep();
    expect((await t.service.core.repo.getItem(first.id))!.deadline_state).toBe('overdue');
    await t.service.raise({ ...base, dueAt: new Date(t.clock.now().getTime() + 10 * H).toISOString() });
    await sweep();
    expect((await t.service.core.repo.getItem(first.id))).toMatchObject({ deadline_state: 'on_time', escalation_level: 0 });
  });

  it('while the lead is away, new and escalating work goes to the backup; routing returns when the lead is back', async () => {
    // a queue whose route escalates to its lead in person
    const q = await call('POST', '/queues', owner, RUNNER, { name: 'Lead escalation', area: 'orders_shipping', ownerRole: 'shipping_manager', leadId: lead.id, backupId: backup.id, escalationRoute: [{ afterMinutes: 0, to: { kind: 'staff', staffId: lead.id, name: lead.name }, notify: true }], defaultDeadlineMinutes: 60, screen: 'ops/dispatch', reason: 'test' });
    expect(q.statusCode, q.body).toBe(201);
    const seen = capture(t.app, 'workqueues.item.created', 'workqueues.item.escalated');
    lead.away = true;
    await publish(t.app, 'access.away.started', { awayPeriodId: newId(), accountId: lead.id, until: new Date(t.clock.now().getTime() + 3 * 86_400_000).toISOString(), coverage: [], delegateApprovals: false });
    const subjectId = newId();
    const item = await t.service.raise({ queueKey: q.json().key, kind: 'manual_task', title: 'Call carrier', subject: { type: 'other', id: subjectId }, dedupeKey: `lead-test:${subjectId}`, dueAt: new Date(t.clock.now().getTime() - MIN).toISOString() });
    expect(item.history.map((h) => h.label)).toEqual(expect.arrayContaining([expect.stringContaining('Routed to the backup')]));
    await sweep();
    await t.app.kernel.events.drain();
    expect(seen.find((e) => e.name === 'workqueues.item.created' && e.payload.itemId === item.id)!.payload.leadId).toBe(backup.id);
    expect(seen.find((e) => e.name === 'workqueues.item.escalated' && e.payload.itemId === item.id)!.payload).toMatchObject({ toKind: 'staff', to: backup.id, level: 1 });

    lead.away = false;
    await publish(t.app, 'access.away.ended', { awayPeriodId: newId(), accountId: lead.id });
    const subject2 = newId();
    await t.service.raise({ queueKey: q.json().key, kind: 'manual_task', title: 'Another', subject: { type: 'other', id: subject2 }, dedupeKey: `lead-test:${subject2}` });
    await t.app.kernel.events.drain();
    expect(seen.filter((e) => e.name === 'workqueues.item.created').at(-1)!.payload.leadId).toBe(lead.id);
  });

  it('archive moves resolved items older than itemRetentionDays to cold storage', async () => {
    const subjectId = newId();
    const item = await t.service.raise({ queueKey: 'warehouse.pick_pack', kind: 'pick_pack', title: 'Old', subject: { type: 'order', id: subjectId }, dedupeKey: `old:${subjectId}` });
    await t.service.resolveBySource(`old:${subjectId}`, { note: 'done', by: { kind: 'system' } });
    t.clock.advance(401 * 24 * H);
    try {
      await t.app.kernel.jobs.runNow('workqueues.archive');
      expect(await t.service.core.repo.getItem(item.id)).toBeNull();
    } finally {
      t.clock.advance(-401 * 24 * H);
    }
  });
});
