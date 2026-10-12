/**
 * Pass 4: never-edited default templates follow the current defaults (existing installs get the purchase
 * order email's "Deliver to" line), staff-edited templates are left alone, and action notices without a
 * deadline expire actionNoticeExpiryDays after they were created.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actorText, LANGUAGE } from '../app/core.js';
import type { NotificationsService } from '../service.js';
import { as, bootWorld, newId, publish, tables, type World } from './harness.js';

let app: FastifyInstance;
let world: World;
let service: NotificationsService;

beforeAll(async () => {
  ({ app, world, service } = await bootWorld());
});
afterAll(async () => {
  await app?.close();
});

const inbox = async (headers: Record<string, string>) => {
  const res = await app.inject({ method: 'GET', url: '/api/store/notifications/inbox', headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as any[];
};

describe('default template refresh', () => {
  it('moves a never-edited template to the current default (new system version; the old one superseded), once', async () => {
    const repo = service.core.repo;
    const t = (await repo.templateFor('supplier.purchase_order.sent', 'email', LANGUAGE))!;
    const live = (await repo.getVersion(t.live_version_id!))!;
    const content = live.content as unknown as { body: string };
    expect(content.body).toContain('Deliver to: {{po.shipTo}}');
    // an install seeded before the Deliver to line
    await repo.updateVersion(live.id, { content: { ...content, body: content.body.replace('Deliver to: {{po.shipTo}}\n\n', '') } as never });

    expect(await service.core.refreshDefaultTemplates()).toBe(1);
    const versions = await repo.versionsOf([t.id]);
    expect(versions.map((v) => [v.version, v.status, v.note])).toEqual([
      [2, 'published', 'Default template updated'],
      [1, 'superseded', 'Default template'],
    ]);
    expect(versions[0]!.created_by).toBe(actorText({ kind: 'system' }));
    expect((await repo.getTemplate(t.id))!.live_version_id).toBe(versions[0]!.id);
    expect((versions[0]!.content as unknown as { body: string }).body).toContain('Deliver to: {{po.shipTo}}');
    // the live template read by senders is the new one at once
    const def = (await import('../domain/catalog.js')).topicDef('supplier.purchase_order.sent')!;
    expect((await service.core.liveTemplate(def, 'email')).versionId).toBe(versions[0]!.id);

    // idempotent: nothing more to do
    expect(await service.core.refreshDefaultTemplates()).toBe(0);
    expect(await repo.versionsOf([t.id])).toHaveLength(2);
  });

  it('leaves a template with any staff version alone', async () => {
    const repo = service.core.repo;
    const t = (await repo.templateFor('customer.case.resolved', 'email', LANGUAGE))!;
    const live = (await repo.getVersion(t.live_version_id!))!;
    const old = { ...(live.content as object), body: 'An older wording' };
    await repo.updateVersion(live.id, { content: old as never });
    const editor = world.staff();
    await repo.insertVersion({ id: newId(), template_id: t.id, version: 2, status: 'draft', content: live.content, note: 'Staff draft', created_by: actorText({ kind: 'staff', id: editor.accountId }), created_at: new Date(), published_by: null, published_at: null });

    await service.core.refreshDefaultTemplates();
    expect((await repo.getTemplate(t.id))!.live_version_id).toBe(live.id);
    expect((await repo.getVersion(live.id))!.content).toMatchObject({ body: 'An older wording' });
    expect(await repo.versionsOf([t.id])).toHaveLength(2);
  });
});

describe('reviews reinstated after a trust reversal', () => {
  it('tells the author their review was reinstated', async () => {
    const c = world.customer();
    await publish(app, 'reviews.moderation.decided', { moderationItemId: newId(), contentType: 'product_review', contentId: newId(), decision: 'reinstate', reasonCode: 'enforcement_reversed', author: { kind: 'customer', id: c.customerId }, reporters: [], reporterOutcome: null, appealUntil: null, trustEnforcementId: newId() });
    const [n] = await inbox(as.customer(c));
    expect(n).toMatchObject({ topicKey: 'customer.review.moderated', title: 'Your review was reinstated' });
  });
});

describe('action notices without a deadline', () => {
  it('expire actionNoticeExpiryDays (30) after they were created; younger ones stay open', async () => {
    const c = world.customer();
    const notify = (ref: string) =>
      service.notify({ topic: 'customer.return.info_requested', recipients: [{ kind: 'customer', customerId: c.customerId }], link: { kind: 'return', id: newId(), screen: 'account/return', ref }, actionRequired: true, dedupeKey: `return:${newId()}:info` });
    const [oldId] = (await notify('RT-OLD')).noticeIds;
    const [newerId] = (await notify('RT-NEW')).noticeIds;
    const notices = tables(app).table('notices');
    await notices.update(oldId, { created_at: new Date(Date.now() - 31 * 86_400_000) });
    await notices.update(newerId, { created_at: new Date(Date.now() - 5 * 86_400_000) });

    await app.kernel.jobs.runNow('notifications.purge');
    const byId = new Map((await inbox(as.customer(c))).map((n) => [n.id, n]));
    expect(byId.get(oldId)).toMatchObject({ actionRequired: true, deadline: null, state: 'expired', resolvedAt: null });
    expect(byId.get(newerId)).toMatchObject({ state: 'open', expiredAt: null });
  });
});
