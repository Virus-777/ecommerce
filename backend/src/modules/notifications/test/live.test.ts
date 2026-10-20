/**
 * Live notifications (GET /api/seller|admin/notifications/stream, app/live.ts, kernel/http/event-stream.ts) over
 * real HTTP: who receives which notice, catch-up with Last-Event-ID, the heartbeat's sign-in checks, shutdown.
 */
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, movingClock } from '../../../testing/app.js';
import { flows } from '../../../testing/flows.js';
import type { NotificationsService } from '../service.js';
import { as, MODULES, newId, World } from './harness.js';
import { settle, SseClient } from './sse.js';

const HEARTBEAT_MS = 100;
const STAFF_STREAM = '/api/admin/notifications/stream';
const SELLER_STREAM = '/api/seller/notifications/stream';

async function listen(app: FastifyInstance) {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

describe('who receives a live notice (staff and seller streams)', () => {
  const clock = movingClock();
  const world = new World();
  let app: FastifyInstance;
  let service: NotificationsService;
  let base: string;
  const open: SseClient[] = [];
  const stream = async (url: string, headers: Record<string, string>) => {
    const c = await SseClient.open(base + url, headers);
    open.push(c);
    return c;
  };

  beforeAll(async () => {
    app = await buildTestApp({ modules: MODULES, clock, config: { launchPhase: 4, rateLimits: false, eventStreamHeartbeatMs: HEARTBEAT_MS }, apiStubs: world.stubs() });
    service = app.kernel.boot.apis.get('notifications') as NotificationsService;
    base = await listen(app);
  });
  afterAll(async () => {
    for (const c of open) c.close();
    await app?.close();
  });

  const shortage = (label: string) =>
    service.notify({ topic: 'staff.inventory.stock_shortage', recipients: [{ kind: 'staff_role', roleKey: 'inventory_manager' }], link: { kind: 'stock', id: newId(), screen: 'admin/inventory' }, context: { stock: { label, available: 2 } }, dedupeKey: `live:${newId()}` });
  const inbox = async (url: string, headers: Record<string, string>) => {
    const res = await app.inject({ method: 'GET', url, headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().items as any[];
  };

  it('pushes a staff notice to the role\'s staff, exactly as GET /inbox shows it, and to nobody else', async () => {
    const lead = world.staff({ name: 'Ines Inventory' });
    const other = world.staff();
    world.role('inventory_manager', { leadAccountId: lead.accountId, accountIds: [lead.accountId] });
    const mine = await stream(STAFF_STREAM, as.staff(lead));
    const theirs = await stream(STAFF_STREAM, as.staff(other));
    expect(mine.status).toBe(200);
    expect(mine.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(mine.headers.get('cache-control')).toBe('private, no-store, no-transform');
    expect(mine.headers.get('x-request-id')).toBeTruthy(); // headers set before the stream opened stay
    expect((await mine.waitFor((e) => e.event === 'ready')).data).toMatchObject({ caughtUp: 0 });
    expect(mine.retry).toBe(5000);
    await theirs.waitFor((e) => e.event === 'ready');

    await shortage('Blue mug');
    const pushed = await mine.waitFor((e) => e.event === 'notice');
    expect(pushed.id).toBe(pushed.data.id);
    expect(pushed.data).toMatchObject({ topicKey: 'staff.inventory.stock_shortage', title: 'Stock shortage: Blue mug', routedTo: { roleKey: 'inventory_manager', reason: 'lead', recipients: [{ staffId: lead.accountId, name: 'Ines Inventory', as: 'lead' }] } });
    // the same mapper as the inbox: the streamed notice is the inbox item
    expect(pushed.data).toEqual((await inbox('/api/admin/notifications/inbox', as.staff(lead)))[0]);
    await settle();
    expect(theirs.notices()).toEqual([]);
    // pings keep the line open
    expect(mine.comments).toContain('ping');
  });

  it('sends what was missed after Last-Event-ID (oldest first), then ready', async () => {
    const lead = world.staff();
    world.role('inventory_manager', { leadAccountId: lead.accountId, accountIds: [lead.accountId] });
    const first = await stream(STAFF_STREAM, as.staff(lead));
    await first.waitFor((e) => e.event === 'ready');
    await shortage('Kettle');
    const seen = await first.waitFor((e) => e.event === 'notice');
    first.close();
    await shortage('Teapot');
    await shortage('Saucer');

    const again = await stream(STAFF_STREAM, { ...as.staff(lead), 'last-event-id': seen.id! });
    const ready = await again.waitFor((e) => e.event === 'ready');
    expect(ready.data.caughtUp).toBe(2);
    expect(again.events.map((e) => e.event)).toEqual(['notice', 'notice', 'ready']);
    expect(again.notices().map((n) => n.title)).toEqual(['Stock shortage: Teapot', 'Stock shortage: Saucer']);

    const unknown = await stream(STAFF_STREAM, { ...as.staff(lead), 'last-event-id': newId() });
    expect((await unknown.waitFor((e) => e.event === 'ready')).data.caughtUp).toBe(0);
    expect(unknown.notices()).toEqual([]);
  });

  it('pushes a workspace notice to members whose topics include it, and a member notice only to that member', async () => {
    const sellerId = newId();
    const packer = world.member(sellerId, { permissions: ['orders.fulfillment.view'] });
    const writer = world.member(sellerId, { permissions: ['catalog.products.submit'] });
    const outsider = world.member(newId(), { permissions: ['orders.fulfillment.view'] });
    const packerStream = await stream(SELLER_STREAM, as.seller(packer));
    const writerStream = await stream(SELLER_STREAM, as.seller(writer));
    const outsiderStream = await stream(SELLER_STREAM, as.seller(outsider));
    for (const s of [packerStream, writerStream, outsiderStream]) await s.waitFor((e) => e.event === 'ready');

    await service.notify({ topic: 'seller.order.new', recipients: [{ kind: 'seller', sellerId }], sellerId, link: { kind: 'order', id: newId(), screen: 'seller/orders' }, context: { order: { ref: 'MK-1001', total: '$20.00' }, due: { date: 'Oct 22' } } });
    const order = await packerStream.waitFor((e) => e.event === 'notice');
    expect(order.data).toMatchObject({ topicKey: 'seller.order.new', title: 'New order MK-1001', routedTo: null });
    expect(order.data).toEqual((await inbox('/api/seller/notifications/inbox', as.seller(packer)))[0]);

    // to one member (<sellerId>/<accountId>): whatever their topics
    await service.notify({ topic: 'seller.order.new', recipients: [{ kind: 'seller_member', sellerId, accountId: writer.accountId }], sellerId, link: { kind: 'order', id: newId(), screen: 'seller/orders' }, context: { order: { ref: 'MK-1002', total: '$5.00' }, due: { date: 'Oct 23' } } });
    expect((await writerStream.waitFor((e) => e.event === 'notice')).data.title).toBe('New order MK-1002');
    await settle();
    expect(packerStream.notices().map((n) => n.title)).toEqual(['New order MK-1001']);
    expect(writerStream.notices().map((n) => n.title)).toEqual(['New order MK-1002']);
    expect(outsiderStream.notices()).toEqual([]);
  });

  it('refuses a stream without a token, or with another app\'s token, before it opens', async () => {
    const none = await SseClient.open(base + STAFF_STREAM, {});
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('UNAUTHORIZED');
    const wrong = await SseClient.open(base + SELLER_STREAM, as.staff(world.staff()));
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('WRONG_AUDIENCE');
  });

  it('forgets closed streams, and ends seller streams after 60 minutes with max_age', async () => {
    for (const c of open) c.close();
    await settle();
    expect(service.live.size).toBe(0);
    const member = world.member(newId(), { permissions: ['orders.fulfillment.view'] });
    const s = await stream(SELLER_STREAM, as.seller(member));
    await s.waitFor((e) => e.event === 'ready');
    expect(service.live.size).toBe(1);
    clock.advance(61 * 60_000);
    expect((await s.waitFor((e) => e.event === 'end')).data).toEqual({ reason: 'max_age' });
    await s.waitEnded();
    await settle(50);
    expect(service.live.size).toBe(0);
  });
});

describe('the heartbeat re-checks real staff sessions, without counting as activity', () => {
  const clock = movingClock();
  let app: FastifyInstance;
  let base: string;
  let owner: { email: string; password: string };
  /** identity's sessions collection (another module's: read and written directly, as a test only may) */
  const sessions = () => app.kernel.mongo.db.collection<{ _id: string; last_active_at: Date }>('identity.sessions');
  const setSession = (sid: string, patch: Record<string, unknown>) => sessions().updateOne({ _id: sid }, { $set: patch });
  /** A new Admin Center session of the owner (password sign-in) */
  const signIn = async () => {
    const r = await flows(app, clock).signIn({ email: owner.email, password: owner.password, audience: 'admin' });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body.tokens.accessToken as string;
  };
  const sessionOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sid as string;
  const staffStream = async (token: string) => {
    const s = await SseClient.open(base + STAFF_STREAM, { authorization: `Bearer ${token}` });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    await s.waitFor((e) => e.event === 'ready');
    return s;
  };

  beforeAll(async () => {
    app = await buildTestApp({ only: ['notifications', 'access'], clock, config: { launchPhase: 4, rateLimits: false, eventStreamHeartbeatMs: HEARTBEAT_MS } });
    base = await listen(app);
    const o = await flows(app, clock).bootstrapOwner('live.owner@marketly.test', 'Lee Owner');
    owner = { email: 'live.owner@marketly.test', password: o.password };
  });
  afterAll(async () => {
    await app?.close();
  });

  it('an open stream does not move last_active_at, and ends with session_idle once the session goes idle', async () => {
    const token = await signIn();
    const sid = sessionOf(token);
    const s = await staffStream(token);
    // ten minutes since the last request: heartbeats come and go (past the 5 s cache), nothing is recorded
    const tenMinutesAgo = new Date(clock.now().getTime() - 10 * 60_000);
    await setSession(sid, { last_active_at: tenMinutesAgo });
    for (let i = 0; i < 3; i++) {
      clock.advance(6_000);
      await settle(3 * HEARTBEAT_MS);
    }
    expect(s.ended).toBe(false);
    expect((await sessions().findOne({ _id: sid }))!.last_active_at.getTime()).toBe(tenMinutesAgo.getTime());
    // past staffIdleMinutes (30) without a request
    await setSession(sid, { last_active_at: new Date(clock.now().getTime() - 31 * 60_000) });
    clock.advance(6_000);
    expect((await s.waitFor((e) => e.event === 'end')).data).toEqual({ reason: 'session_idle' });
    await s.waitEnded();
  });

  it('ends with signed_out when the session is revoked', async () => {
    const token = await signIn();
    const sid = sessionOf(token);
    const s = await staffStream(token);
    await setSession(sid, { revoked_at: clock.now(), revoke_reason: 'test' });
    await app.kernel.auth.k.revocations.sync();
    expect((await s.waitFor((e) => e.event === 'end')).data).toEqual({ reason: 'signed_out' });
    await s.waitEnded();
  });

  it('app.close() ends every open stream with restart and does not hang', async () => {
    const token = await signIn();
    const a = await staffStream(token);
    const b = await staffStream(token);
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    for (const s of [a, b]) {
      expect((await s.waitFor((e) => e.event === 'end')).data).toEqual({ reason: 'restart' });
      await s.waitEnded();
    }
  });
});
