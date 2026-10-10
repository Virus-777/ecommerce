/**
 * Gap pass 3: sourceModule on raise(), the new kinds and their queues (seeded on existing installs),
 * deadlines from the source (catalog reviewDueAt, sellers decisionTargetAt), Official Store reply
 * overdue skipped, reviews.moderation.decided closing review_moderation_overdue, reassigning in-progress
 * and waiting items, queues that pause while waiting, and the day-end reminder only while open.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allSpecs } from '../../../kernel/module-system/loader.js';
import { validSample } from '../../../testing/samples.js';
import { Core } from '../app/core.js';
import { PLACEHOLDER_BACKUP, PLACEHOLDER_LEAD, SYSTEM_UPDATED_BY } from '../domain/catalog.js';
import { as, boot, capture, H, MIN, newId, publish, type Person } from './harness.js';

type Booted = Awaited<ReturnType<typeof boot>>;
let t: Booted;
let lead: Person;
let backup: Person;
let agent: Person;
let sellerLead: Person;
let sellerBackup: Person;

const WORKER = ['workqueues.items.view', 'workqueues.items.work'];
const LEAD = [...WORKER, 'workqueues.items.assign-others'];
const MANAGER = [...WORKER, 'workqueues.queues.manage'];
const RUNNER = [...WORKER, 'workqueues.day-end.run'];

function ev(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const def = allSpecs[name.split('.')[0]!]!.events.publishes[name]!;
  return { ...(validSample(def.payload()).value as Record<string, unknown>), ...over };
}
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who: Person, perms?: string[], payload?: unknown) =>
  t.app.inject({ method, url: `/api/admin/workqueues${url}`, headers: as.staff(who, perms), ...(payload !== undefined ? { payload: payload as object } : {}) });
const active = async (dedupeKey: string) => (await t.service.core.repo.activeByDedupe(dedupeKey)) ?? null;
const by = { kind: 'system' as const, name: 'test' };

beforeAll(async () => {
  t = await boot();
  lead = t.world.person('Sam Lead', ['shipping_manager']);
  backup = t.world.person('Bea Backup', ['shipping_manager']);
  agent = t.world.person('Ana Agent', ['shipping_manager']);
  sellerLead = t.world.person('Sue Sellers', ['seller_manager']);
  sellerBackup = t.world.person('Sid Sellers', ['seller_manager']);
  t.world.cover('shipping_manager', lead, backup);
  await publish(t.app, 'access.coverage.changed', { roleId: newId(), roleKey: 'shipping_manager', leadAccountId: lead.id, receivingAccountIds: [lead.id], viaBackup: false });
});
afterAll(async () => {
  await t?.app.close();
});

describe('raise(): sourceModule', () => {
  it('stores the calling module and refuses a raise without one', async () => {
    const id = newId();
    const item = await t.service.raise({ sourceModule: 'purchasing', queueKey: 'purchasing.receiving', kind: 'receiving', title: 'Receive PO-1', subject: { type: 'purchase_order', id, ref: 'PO-1' }, dedupeKey: `receiving:${id}` });
    // before pass 3 the module was guessed from the queue key's prefix
    expect(item.source).toMatchObject({ module: 'purchasing', event: null, raisedBy: { kind: 'system', name: 'purchasing' } });
    const other = await t.service.raise({ sourceModule: 'inventory', queueKey: 'warehouse.pick_pack', kind: 'pick_pack', title: 'Pick', subject: { type: 'order', id: newId() }, dedupeKey: `pick:${newId()}` });
    expect(other.source).toMatchObject({ module: 'inventory' });
    await expect(t.service.raise({ queueKey: 'warehouse.pick_pack', kind: 'pick_pack', title: 'x', subject: { type: 'other', id: 'x' }, dedupeKey: `x:${newId()}` } as never)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(t.service.raise({ sourceModule: ' ', queueKey: 'warehouse.pick_pack', kind: 'pick_pack', title: 'x', subject: { type: 'other', id: 'x' }, dedupeKey: `x:${newId()}` })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('new kinds and their queues', () => {
  it('seeds sellers.accounts, reviews.moderation and official_store.messages with their owner roles', async () => {
    const queues = new Map((await t.service.core.repo.listQueues()).map((q) => [q.key, q]));
    expect(queues.get('sellers.accounts')).toMatchObject({ owner_role: 'seller_manager', visible_to_seller: false, active: true });
    expect(queues.get('reviews.moderation')).toMatchObject({ owner_role: 'trust_and_risk_manager', visible_to_seller: false });
    expect(queues.get('official_store.messages')).toMatchObject({ owner_role: 'official_store_manager', visible_to_seller: false });
  });

  it('routes seller_owner_missing, review_moderation_overdue and official_store_reply to their queues; enforcement_reversal stays in the owning team queue', async () => {
    const sellerId = newId();
    const owner = await t.service.raise({ sourceModule: 'sellers', queueKey: 'sellers.performance', kind: 'seller_owner_missing', title: 'Seller has no owner', subject: { type: 'seller', id: sellerId }, sellerId, dedupeKey: `seller_owner_missing:${sellerId}` });
    expect(owner).toMatchObject({ queueKey: 'sellers.accounts', kind: 'seller_owner_missing', ownerRole: 'seller_manager', visibleToSeller: false });
    expect(await t.service.resolveBySource(`seller_owner_missing:${sellerId}`, { note: 'New owner active', by })).toBe(1);

    const conv = newId();
    const reply = await t.service.raise({ sourceModule: 'messaging', queueKey: 'official_store.messages', kind: 'official_store_reply', title: 'Reply to a customer', subject: { type: 'conversation', id: conv }, dedupeKey: `official_store_reply:${conv}` });
    expect(reply).toMatchObject({ queueKey: 'official_store.messages', ownerRole: 'official_store_manager', visibleToSeller: false, subject: { type: 'conversation', id: conv } });

    const enf = newId();
    const reversal = await t.service.raise({ sourceModule: 'trust', queueKey: 'catalog.product_review', kind: 'enforcement_reversal', title: 'Undo suspend product', subject: { type: 'enforcement', id: enf }, dedupeKey: `enforcement_reversal:${enf}` });
    expect(reversal).toMatchObject({ queueKey: 'catalog.product_review', kind: 'enforcement_reversal', source: { module: 'trust' } });
  });

  it('reviews.moderation.decided closes the review_moderation_overdue item by its dedupe key (idempotent)', async () => {
    const mod = newId();
    const item = await t.service.raise({ sourceModule: 'reviews', queueKey: 'reviews.moderation', kind: 'review_moderation_overdue', title: 'Moderation overdue', subject: { type: 'moderation_item', id: mod }, dedupeKey: `review_moderation_overdue:${mod}` });
    expect(item.queueKey).toBe('reviews.moderation');
    // a moderation item raised with another subject still closes by its dedupe key
    const mod2 = newId();
    const item2 = await t.service.raise({ sourceModule: 'reviews', queueKey: 'reviews.moderation', kind: 'review_moderation_overdue', title: 'Moderation overdue', subject: { type: 'other', id: newId() }, dedupeKey: `review_moderation_overdue:${mod2}` });
    const resolved = capture(t.app, 'workqueues.item.resolved');
    const payload = ev('reviews.moderation.decided', { moderationItemId: mod, decision: 'removed' });
    t.app.kernel.events.publish('reviews', 'reviews.moderation.decided', payload);
    t.app.kernel.events.publish('reviews', 'reviews.moderation.decided', payload);
    await t.app.kernel.events.drain();
    expect(await t.service.core.repo.getItem(item.id)).toMatchObject({ state: 'resolved', resolution: { outcome: 'fixed_at_source', note: 'Moderation decided: removed' } });
    expect(resolved.filter((e) => e.payload.itemId === item.id)).toHaveLength(1);
    await publish(t.app, 'reviews.moderation.decided', ev('reviews.moderation.decided', { moderationItemId: mod2 }));
    expect(await t.service.core.repo.getItem(item2.id)).toMatchObject({ state: 'resolved' });
  });

  it('a migration-seeded queue on placeholders takes the role lead and backup from access at boot; queues set by hand are kept', async () => {
    const repo = t.service.core.repo;
    await repo.updateQueue('sellers.accounts', { lead_staff_id: PLACEHOLDER_LEAD, backup_staff_id: PLACEHOLDER_BACKUP, updated_by: SYSTEM_UPDATED_BY });
    await repo.updateQueue('sellers.appeals', { lead_staff_id: PLACEHOLDER_LEAD, backup_staff_id: PLACEHOLDER_BACKUP, updated_by: JSON.stringify({ kind: 'staff', id: newId() }) });
    t.world.cover('seller_manager', sellerLead, sellerBackup);
    await new Core({ repo, ctx: t.service.core.ctx }).ensureSeeded();
    expect(await repo.getQueue('sellers.accounts')).toMatchObject({ lead_staff_id: sellerLead.id, backup_staff_id: sellerBackup.id });
    expect(await repo.getQueue('sellers.appeals')).toMatchObject({ lead_staff_id: PLACEHOLDER_LEAD, backup_staff_id: PLACEHOLDER_BACKUP });
  });
});

describe('deadlines and subjects from the source', () => {
  it('product_review is due at catalog reviewDueAt with the product as subject; old items with an other subject still close', async () => {
    const productId = newId();
    const reviewDueAt = new Date(t.clock.now().getTime() + 30 * H).toISOString();
    await publish(t.app, 'catalog.product.submitted', ev('catalog.product.submitted', { productId, ownerSellerId: null, reviewDueAt, ref: 'SUB-261010-0001', title: 'Desk lamp' }));
    const item = await active(`product_review:${productId}`);
    expect(item).toMatchObject({ subject_type: 'product', subject_id: productId, subject_label: 'Desk lamp' });
    expect(item!.due_at.toISOString()).toBe(reviewDueAt);
    await publish(t.app, 'catalog.product.approved', ev('catalog.product.approved', { productId }));
    expect(await active(`product_review:${productId}`)).toBeNull();

    const old = newId();
    const before = await t.service.raise({ sourceModule: 'catalog', queueKey: 'catalog.product_review', kind: 'product_review', title: 'Old', subject: { type: 'other', id: old }, dedupeKey: `product_review:${old}` });
    await publish(t.app, 'catalog.product.rejected', ev('catalog.product.rejected', { productId: old }));
    expect(await t.service.core.repo.getItem(before.id)).toMatchObject({ state: 'resolved' });
  });

  it('application_waiting is due at sellers decisionTargetAt', async () => {
    const applicationId = newId();
    const decisionTargetAt = new Date(t.clock.now().getTime() + 50 * H).toISOString();
    await publish(t.app, 'sellers.application.submitted', ev('sellers.application.submitted', { applicationId, ref: 'SA-261010-0001', decisionTargetAt, duplicateCount: 0, invited: false }));
    const item = await active(`application:${applicationId}`);
    expect(item).toMatchObject({ subject_type: 'application', subject_ref: 'SA-261010-0001', priority: 'normal' });
    expect(item!.due_at.toISOString()).toBe(decisionTargetAt);
  });

  it('messaging.reply.overdue for the Official Store raises no seller task (messaging owns official_store_reply)', async () => {
    const c = newId();
    await publish(t.app, 'messaging.reply.overdue', ev('messaging.reply.overdue', { conversationId: c, officialStore: true }));
    expect(await active(`reply_overdue:${c}`)).toBeNull();
    const s = newId();
    await publish(t.app, 'messaging.reply.overdue', ev('messaging.reply.overdue', { conversationId: s, officialStore: false }));
    expect(await active(`reply_overdue:${s}`)).toMatchObject({ visible_to_seller: true, subject_type: 'conversation' });
    await publish(t.app, 'messaging.message.sent', ev('messaging.message.sent', { conversationId: s, authorKind: 'seller' }));
    expect(await active(`reply_overdue:${s}`)).toBeNull();
  });
});

async function overdueDispatch() {
  const itemId = newId();
  await publish(t.app, 'shipping.dispatch.overdue', ev('shipping.dispatch.overdue', { ownerType: 'official', sellerId: null, orderItemIds: [itemId] }));
  return (await t.service.core.repo.activeByDedupe(`overdue_dispatch:${itemId}`))!;
}

describe('reassigning keeps the state', () => {
  it('in-progress and waiting items can be reassigned and keep their state (bug: 409 before)', async () => {
    const item = await overdueDispatch();
    expect((await call('POST', `/items/${item.id}/start`, agent, WORKER)).json()).toMatchObject({ state: 'in_progress', assignee: { staffId: agent.id } });
    const moved = await call('POST', `/items/${item.id}/assign`, lead, LEAD, { assigneeId: backup.id, nextAction: 'Take over' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ state: 'in_progress', assignee: { staffId: backup.id } });

    const w = await call('POST', `/items/${item.id}/wait`, backup, WORKER, { waitingOn: 'seller', note: 'Waiting for the seller' });
    expect(w.json()).toMatchObject({ state: 'waiting' });
    const again = await call('POST', `/items/${item.id}/assign`, lead, LEAD, { assigneeId: agent.id });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ state: 'waiting', waitingOn: 'seller', assignee: { staffId: agent.id } });
    // the holder of a waiting item claims it back without leaving waiting
    expect((await call('POST', `/items/${item.id}/claim`, agent, WORKER)).json()).toMatchObject({ state: 'waiting', assignee: { staffId: agent.id } });
    // resolved items still cannot be assigned
    await call('POST', `/items/${item.id}/resolve`, agent, WORKER, { note: 'done' });
    expect((await call('POST', `/items/${item.id}/assign`, lead, LEAD, { assigneeId: agent.id })).statusCode).toBe(409);
  });
});

describe('queues that pause while waiting', () => {
  it('the sweep ignores waiting items and resume moves the deadline later by the time spent waiting', async () => {
    const def = (await call('GET', '/queues/shipping.delivery_exceptions', lead, MANAGER)).json().queue;
    expect(def.pauseWhileWaiting).toBe(false);
    const res = await call('PATCH', '/queues/shipping.delivery_exceptions', lead, MANAGER, { name: def.name, area: def.area, ownerRole: def.ownerRole, leadId: lead.id, backupId: backup.id, escalationRoute: def.escalationRoute, defaultDeadlineMinutes: def.defaultDeadlineMinutes, screen: def.screen, pauseWhileWaiting: true, reason: 'Carrier waits do not count' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().pauseWhileWaiting).toBe(true);

    const raise = (key: string) => {
      const id = newId();
      return t.service.raise({ sourceModule: 'shipping', queueKey: key, kind: 'delivery_exception', title: 'Lost parcel', subject: { type: 'delivery_exception', id }, dedupeKey: `exception:${id}`, dueAt: new Date(t.clock.now().getTime() + H).toISOString() });
    };
    const paused = await raise('shipping.delivery_exceptions');
    const dueBefore = new Date(paused.deadline.dueAt).getTime();
    await call('POST', `/items/${paused.id}/start`, agent, WORKER);
    await call('POST', `/items/${paused.id}/wait`, agent, WORKER, { waitingOn: 'carrier', note: 'Carrier trace' });
    // a queue without pausing keeps the deadline while waiting
    const def2 = (await call('GET', '/queues/shipping.missing_tracking', lead, MANAGER)).json().queue;
    expect(def2.pauseWhileWaiting).toBe(false);
    const kept = await t.service.raise({ sourceModule: 'shipping', queueKey: 'shipping.missing_tracking', kind: 'missing_tracking', title: 'No tracking', subject: { type: 'order', id: newId() }, dedupeKey: `mt:${newId()}`, dueAt: new Date(t.clock.now().getTime() + H).toISOString() });
    await call('POST', `/items/${kept.id}/start`, agent, WORKER);
    await call('POST', `/items/${kept.id}/wait`, agent, WORKER, { waitingOn: 'seller', note: 'Seller' });

    const overdue = capture(t.app, 'workqueues.item.overdue');
    t.clock.advance(3 * H);
    try {
      await t.app.kernel.jobs.runNow('workqueues.deadline-sweep');
      await t.app.kernel.events.drain();
      expect(overdue.map((e) => e.payload.itemId)).toContain(kept.id);
      expect(overdue.map((e) => e.payload.itemId)).not.toContain(paused.id);
      expect((await t.service.core.repo.getItem(paused.id))!.deadline_state).not.toBe('overdue');

      const resumed = await call('POST', `/items/${paused.id}/resume`, agent, WORKER);
      expect(resumed.statusCode, resumed.body).toBe(200);
      expect(new Date(resumed.json().deadline.dueAt).getTime()).toBe(dueBefore + 3 * H);
      expect(resumed.json()).toMatchObject({ state: 'in_progress', deadline: { state: 'due_soon' } });
      expect((await t.service.core.repo.getItem(paused.id))!.waiting_since).toBeNull();
      const keptAfter = await call('POST', `/items/${kept.id}/resume`, agent, WORKER);
      expect(new Date(keptAfter.json().deadline.dueAt).getTime()).toBe(new Date(kept.deadline.dueAt).getTime());
    } finally {
      t.clock.advance(-3 * H);
    }
  });
});

describe('day-end reminder only while open', () => {
  it('the prepare job refreshes an open review (checks kept) and sends no reminder once the review is completed', async () => {
    t.clock.advance(5 * 24 * H);
    try {
      // a review opened and completed before the 15:00 job
      const cur = await call('GET', '/day-end-reviews/current', lead, RUNNER);
      const review = cur.json();
      for (const i of review.items) await call('POST', `/day-end-reviews/${review.id}/items/${i.key}/check`, lead, RUNNER, { note: 'ok' });
      const done = await call('POST', `/day-end-reviews/${review.id}/complete`, lead, RUNNER, {});
      expect(done.statusCode, done.body).toBe(200);
      const prepared = capture(t.app, 'workqueues.day_end.prepared');
      await t.app.kernel.jobs.runNow('workqueues.day-end-prepare');
      await t.app.kernel.events.drain();
      expect(prepared).toEqual([]);

      // the next day: opened early, one item checked; the job refreshes it, keeps the check and reminds once
      t.clock.advance(24 * H);
      const next = (await call('GET', '/day-end-reviews/current', lead, RUNNER)).json();
      await call('POST', `/day-end-reviews/${next.id}/items/upcoming_campaigns/check`, lead, RUNNER, { note: 'Nothing planned' });
      await overdueDispatch();
      await t.app.kernel.jobs.runNow('workqueues.day-end-prepare');
      await t.app.kernel.jobs.runNow('workqueues.day-end-prepare');
      await t.app.kernel.events.drain();
      expect(prepared.map((e) => e.payload.reviewId)).toEqual([next.id]);
      const after = (await call('GET', '/day-end-reviews/current', lead, RUNNER)).json();
      expect(after.items.find((i: { key: string }) => i.key === 'upcoming_campaigns')).toMatchObject({ checked: true, note: 'Nothing planned' });
      expect(after.items.find((i: { key: string }) => i.key === 'unresolved_commitments').summary).not.toBe(next.items.find((i: { key: string }) => i.key === 'unresolved_commitments').summary);
    } finally {
      t.clock.advance(-6 * 24 * H);
    }
  });
});

void MIN;
