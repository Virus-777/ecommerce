/**
 * Wave 2 (BACKEND-REQUESTS): inbox archive in the three areas (G62), staff mark-unread (G73), a channel toggle
 * without a reason (G68) and an invited seller member's preferences (G49a).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationsService } from '../service.js';
import { as, bootWorld, newId, publish, type World } from './harness.js';

let app: FastifyInstance;
let world: World;
let service: NotificationsService;

beforeAll(async () => {
  ({ app, world, service } = await bootWorld());
});
afterAll(async () => {
  await app?.close();
});

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, headers: Record<string, string>, payload?: unknown) => app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const ok = async (method: 'GET' | 'POST' | 'PUT', url: string, headers: Record<string, string>, payload?: unknown) => {
  const res = await call(method, url, headers, payload);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const welcome = (accountId: string) => service.notify({ topic: 'customer.account.welcome', recipients: [{ kind: 'customer', accountId }], link: { kind: 'account', id: accountId, screen: 'account/overview' }, context: {}, dedupeKey: `w2:${newId()}` });
const mention = (accountId: string, actionRequired = false) =>
  service.notify({ topic: 'staff.mention', recipients: [{ kind: 'staff_member', accountId }], link: { kind: 'payout', id: newId(), screen: 'admin/payouts' }, context: { mention: { by: 'Theo Grant', text: 'Check this' } }, dedupeKey: `w2:${newId()}`, actionRequired });

describe('inbox archive (G62)', () => {
  it('a customer archives one notice and all the rest; archived notices leave the inbox and its counts', async () => {
    const c = world.customer();
    const h = as.customer(c);
    const [first] = (await welcome(c.accountId)).noticeIds;
    await welcome(c.accountId);
    await welcome(c.accountId);
    expect((await ok('GET', '/api/store/notifications/inbox/summary', h)).total).toBe(3);

    const archived = await ok('POST', `/api/store/notifications/inbox/${first}/archive`, h);
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(archived.readAt).toBeNull(); // archiving does not read it
    expect((await ok('GET', '/api/store/notifications/inbox', h)).items).toHaveLength(2);
    expect((await ok('GET', '/api/store/notifications/inbox?archived=true', h)).items.map((n: any) => n.id)).toEqual([first]);
    expect(await ok('GET', '/api/store/notifications/inbox/summary', h)).toMatchObject({ total: 2, unread: 2 });
    // again: nothing changes
    expect((await ok('POST', `/api/store/notifications/inbox/${first}/archive`, h)).archivedAt).toBe(archived.archivedAt);

    expect(await ok('POST', '/api/store/notifications/inbox/archive-all', h, {})).toEqual({ updated: 2 });
    expect((await ok('GET', '/api/store/notifications/inbox', h)).items).toEqual([]);
    expect((await ok('GET', '/api/store/notifications/inbox?archived=true', h)).items).toHaveLength(3);
    expect(await ok('GET', '/api/store/notifications/inbox/summary', h)).toMatchObject({ total: 0, unread: 0 });

    // another customer's notice is not found
    const other = world.customer();
    expect((await call('POST', `/api/store/notifications/inbox/${first}/archive`, as.customer(other))).statusCode).toBe(404);
  });

  it('archive-all can keep unread notices (readOnly)', async () => {
    const c = world.customer();
    const h = as.customer(c);
    const [read] = (await welcome(c.accountId)).noticeIds;
    await welcome(c.accountId);
    await ok('POST', `/api/store/notifications/inbox/${read}/read`, h);
    expect(await ok('POST', '/api/store/notifications/inbox/archive-all', h, { readOnly: true })).toEqual({ updated: 1 });
    expect((await ok('GET', '/api/store/notifications/inbox', h)).items).toHaveLength(1);
  });

  it('staff archive, but an open action notice stays until its work is done', async () => {
    const s = world.staff();
    const h = as.staff(s);
    const [info] = (await mention(s.accountId)).noticeIds;
    const [action] = (await mention(s.accountId, true)).noticeIds;

    const refused = await call('POST', `/api/admin/notifications/inbox/${action}/archive`, h);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('NOTICE_ACTION_OPEN');
    expect(await ok('POST', '/api/admin/notifications/inbox/archive-all', h, {})).toEqual({ updated: 1 });
    expect((await ok('GET', '/api/admin/notifications/inbox', h)).items.map((n: any) => n.id)).toEqual([action]);
    expect((await ok('GET', '/api/admin/notifications/inbox?archived=true', h)).items.map((n: any) => n.id)).toEqual([info]);
    expect((await ok('GET', '/api/admin/notifications/inbox/summary', h)).unread).toBe(1);
  });

  it('a seller member archives for themselves only', async () => {
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true, role: 'Owner' });
    const other = world.member(sellerId, { isOwner: true, role: 'Owner' });
    const [id] = (await service.notify({ topic: 'seller.application.decided', recipients: [{ kind: 'seller', sellerId }], link: { kind: 'account', id: sellerId, screen: 'seller/dashboard' }, context: {}, dedupeKey: `w2:${newId()}`, sellerId })).noticeIds;
    expect(id).toBeDefined();
    expect((await ok('POST', `/api/seller/notifications/inbox/${id}/archive`, as.seller(owner))).archivedAt).toEqual(expect.any(String));
    expect((await ok('GET', '/api/seller/notifications/inbox', as.seller(owner))).items.map((n: any) => n.id)).not.toContain(id);
    expect((await ok('GET', '/api/seller/notifications/inbox', as.seller(other))).items.map((n: any) => n.id)).toContain(id);
  });
});

describe('staff mark-unread (G73)', () => {
  it('puts a read notice back to unread for me', async () => {
    const s = world.staff();
    const h = as.staff(s);
    const [id] = (await mention(s.accountId)).noticeIds;
    await ok('POST', `/api/admin/notifications/inbox/${id}/read`, h);
    expect((await ok('GET', '/api/admin/notifications/inbox/summary', h)).unread).toBe(0);
    const n = await ok('POST', `/api/admin/notifications/inbox/${id}/unread`, h);
    expect(n.readAt).toBeNull();
    expect((await ok('GET', '/api/admin/notifications/inbox/summary', h)).unread).toBe(1);
    expect((await call('POST', `/api/admin/notifications/inbox/${newId()}/unread`, h)).statusCode).toBe(404);
  });
});

describe('topic channels without a reason (G68)', () => {
  it('records the default reason', async () => {
    const res = await call('PUT', '/api/admin/notifications/topics/customer.order.delayed/channels', as.staff(world.staff()), { channels: [{ channel: 'email', enabled: true, available: true, locked: false }] });
    expect(res.statusCode, res.body).toBe(200);
    const audit = world.audits.filter((a) => a.action === 'notifications.topic.channels').at(-1);
    expect(audit?.reason).toBe('Notification channels changed in the Admin Center');
  });
});

describe('invited seller member preferences (G49a)', () => {
  it('answers 409 MEMBER_NOT_JOINED until the invitation is accepted, 404 once it is revoked', async () => {
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true, role: 'Owner' });
    const memberId = newId();
    const put = () => call('PUT', `/api/seller/notifications/preferences/members/${memberId}`, as.seller(owner), { groups: {}, channel: 'in_app' });

    expect((await put()).statusCode).toBe(404);
    await publish(app, 'sellers.member.invited', { sellerId, memberId, email: 'new.agent@example.com' });
    const pending = await put();
    expect(pending.statusCode).toBe(409);
    expect(pending.json().error).toMatchObject({ code: 'MEMBER_NOT_JOINED', details: { memberId } });

    // accepted: the member's preferences open
    const accountId = newId();
    world.member(sellerId, { accountId, memberId, role: 'Staff' });
    await publish(app, 'sellers.member.joined', { sellerId, memberId, accountId });
    expect((await put()).statusCode).toBe(200);

    // a revoked invitation is forgotten
    const revoked = newId();
    await publish(app, 'sellers.member.invited', { sellerId, memberId: revoked, email: 'gone@example.com' });
    await publish(app, 'sellers.member.removed', { sellerId, memberId: revoked, accountId: null });
    expect((await call('PUT', `/api/seller/notifications/preferences/members/${revoked}`, as.seller(owner), { groups: {}, channel: 'in_app' })).statusCode).toBe(404);
  });
});
