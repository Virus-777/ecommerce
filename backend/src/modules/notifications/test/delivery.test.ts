import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock, zonedTimeToUtc, dateInZone } from '../../../kernel/lib/clock.js';
import { signWebhook } from '../../../testing/app.js';
import type { NotificationsService } from '../service.js';
import { as, bootWorld, capture, devOutbox, emailsTo, money, newId, publish, type World } from './harness.js';

const clock = fixedClock(new Date());
let app: FastifyInstance;
let world: World;
let service: NotificationsService;
let admin: Record<string, string>;

beforeAll(async () => {
  ({ app, world, service } = await bootWorld({ clock }));
  admin = as.staff(world.staff());
});
afterAll(async () => {
  await app?.close();
});

const deliveriesOf = async (accountId: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/admin/notifications/deliveries?accountId=${accountId}`, headers: admin });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as any[];
};

const orderFor = (c: { customerId: string; email: string }) => ({
  orderId: newId(),
  ref: `MK-261009-${Math.floor(Math.random() * 90000 + 10000)}`,
  customerId: c.customerId,
  contactEmail: c.email,
  total: money(4900),
  groups: [{ groupId: newId(), ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', dispatchBy: new Date(clock.now().getTime() + 86_400_000).toISOString(), itemIds: [newId()], total: money(4900) }],
  items: [], acceptedAt: clock.now().toISOString(),
});

const webhook = (path: string, body: unknown, eventId = newId()) => {
  const raw = JSON.stringify(body);
  return app.inject({ method: 'POST', url: `/webhooks/notifications/${path}`, headers: { 'content-type': 'application/json', 'x-event-id': eventId, ...signWebhook('dev-webhook-secret', raw, Math.floor(clock.now().getTime() / 1000)) }, payload: raw }).then(async (r) => (await app.kernel.events.drain(), r));
};

describe('sensitive messages', () => {
  it('sends verification codes without storing them, and they cannot be retried', async () => {
    const email = `code-${newId().slice(0, 6)}@example.com`;
    await publish(app, 'identity.verification.code_issued', { challengeId: newId(), accountId: null, purpose: 'email_verification', channel: 'email', to: email, code: '482913', existingAccount: false, expiresAt: new Date(clock.now().getTime() + 600_000).toISOString() });
    const [mail] = emailsTo(email);
    expect(mail!.message.text).toContain('482913');
    const log = await app.inject({ method: 'GET', url: `/api/admin/notifications/deliveries?address=${encodeURIComponent(email)}`, headers: admin });
    const [d] = log.json().items;
    const detail = await app.inject({ method: 'GET', url: `/api/admin/notifications/deliveries/${d.id}`, headers: admin });
    expect(detail.json().subject).toBe('Your Marketly verification code');
    expect(JSON.stringify(detail.json())).not.toContain('482913');

    const phone = '+15557654321';
    await publish(app, 'identity.verification.code_issued', { challengeId: newId(), accountId: null, purpose: 'phone_verification', channel: 'sms', to: phone, code: '111222', existingAccount: false, expiresAt: new Date(clock.now().getTime() + 600_000).toISOString() });
    expect(devOutbox.sms.find((s) => s.message.to === phone)?.message.text).toContain('111222');

    const rejected = `code-${newId().slice(0, 6)}@reject.test`;
    await publish(app, 'identity.verification.code_issued', { challengeId: newId(), accountId: null, purpose: 'email_verification', channel: 'email', to: rejected, code: '999999', existingAccount: false, expiresAt: new Date(clock.now().getTime() + 600_000).toISOString() });
    const failed = (await app.inject({ method: 'GET', url: `/api/admin/notifications/deliveries?address=${encodeURIComponent(rejected)}`, headers: admin })).json().items[0];
    expect(failed.status).toBe('failed');
    const retry = await app.inject({ method: 'POST', url: `/api/admin/notifications/deliveries/${failed.id}/retry`, headers: admin, payload: { reason: 'try again' } });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe('NOT_RETRYABLE');
  });

  it("sends 'you already have an account' instead of a code", async () => {
    const email = `dup-${newId().slice(0, 6)}@example.com`;
    await publish(app, 'identity.verification.code_issued', { challengeId: newId(), accountId: null, purpose: 'email_verification', channel: 'email', to: email, code: '123456', existingAccount: true, expiresAt: new Date(clock.now().getTime() + 600_000).toISOString() });
    const [mail] = emailsTo(email);
    expect(mail!.message.subject).toBe('You already have a Marketly account');
    expect(mail!.message.text).not.toContain('123456');
  });
});

describe('bounces and suppressions', () => {
  it('suppresses hard-bounced addresses, skips later sends and lets staff remove the suppression', async () => {
    const seen = capture(app, 'notifications.address.suppressed', 'notifications.suppression.removed');
    const c = world.customer({ email: `xavier-${newId().slice(0, 6)}@bounce.test` });
    await publish(app, 'orders.order.accepted', orderFor(c));
    let ds = await deliveriesOf(c.accountId);
    expect(ds[0]).toMatchObject({ status: 'bounced', channel: 'email' });
    expect(seen.find((e) => e.name === 'notifications.address.suppressed')?.payload).toMatchObject({ channel: 'email', accountId: c.accountId, reason: 'hard_bounce' });

    clock.advance(1000);
    await publish(app, 'orders.order.accepted', orderFor(c));
    ds = await deliveriesOf(c.accountId);
    expect(ds[0].status).toBe('suppressed');
    expect((await app.inject({ method: 'POST', url: `/api/admin/notifications/deliveries/${ds[0].id}/retry`, headers: admin, payload: { reason: 'x' } })).statusCode).toBe(409);

    const list = await app.inject({ method: 'GET', url: `/api/admin/notifications/suppressions?accountId=${c.accountId}&active=true`, headers: admin });
    const [s] = list.json().items;
    expect(s).toMatchObject({ channel: 'email', reason: 'hard_bounce', removedAt: null });
    const removed = await app.inject({ method: 'POST', url: `/api/admin/notifications/suppressions/${s.id}/remove`, headers: admin, payload: { reason: 'Customer fixed the address' } });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().removedAt).toBeTruthy();
    await app.kernel.events.drain();
    expect(seen.find((e) => e.name === 'notifications.suppression.removed')?.payload).toMatchObject({ suppressionId: s.id, channel: 'email' });
    expect(world.audits.find((a) => a.action === 'notifications.suppression.remove')).toMatchObject({ reason: 'Customer fixed the address', module: 'notifications' });
    const again = await app.inject({ method: 'POST', url: `/api/admin/notifications/suppressions/${s.id}/remove`, headers: admin, payload: { reason: 'again' } });
    expect(again.statusCode).toBe(409);
  });

  it('handles provider webhooks idempotently (complaints suppress; replays are ignored; signatures required)', async () => {
    const c = world.customer();
    await publish(app, 'orders.order.accepted', orderFor(c));
    const [d] = await deliveriesOf(c.accountId);
    expect(d.status).toBe('delivered');
    const body = { events: [{ providerEventId: `pe-${newId()}`, type: 'complained', providerMessageId: d.providerMessageId, recipient: c.email, at: clock.now().toISOString() }] };
    expect((await app.inject({ method: 'POST', url: '/webhooks/notifications/email-events', payload: body })).statusCode).toBe(401);
    const eventId = newId();
    const res = await webhook('email-events', body, eventId);
    expect(res.statusCode, res.body).toBe(204);
    const replay = await webhook('email-events', body, eventId);
    expect(replay.headers['x-webhook-duplicate']).toBe('true');
    await webhook('email-events', body); // same provider event, new delivery attempt of the webhook
    const detail = await app.inject({ method: 'GET', url: `/api/admin/notifications/deliveries/${d.id}`, headers: admin });
    expect(detail.json().delivery.status).toBe('complained');
    expect(detail.json().events.filter((e: any) => e.label === 'Marked as spam')).toHaveLength(1);
    expect(detail.json().events.map((e: any) => e.label)).toEqual(expect.arrayContaining(['Queued', 'Sent to the provider', 'Delivered']));
    const sup = await app.inject({ method: 'GET', url: `/api/admin/notifications/suppressions?address=${encodeURIComponent(c.email)}`, headers: admin });
    expect(sup.json().items[0]).toMatchObject({ reason: 'complaint' });
  });

  it('records SMS STOP as a suppression and START as its removal', async () => {
    const seen = capture(app, 'notifications.address.suppressed', 'notifications.suppression.removed');
    const phone = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
    expect((await webhook('sms-events', { providerEventId: newId(), type: 'stop', phone, at: clock.now().toISOString() })).statusCode).toBe(204);
    expect(seen.find((e) => e.name === 'notifications.address.suppressed')?.payload).toMatchObject({ channel: 'sms', reason: 'stop' });
    const list = await app.inject({ method: 'GET', url: `/api/admin/notifications/suppressions?channel=sms&address=${encodeURIComponent(phone)}&active=true`, headers: admin });
    expect(list.json().items[0]).toMatchObject({ channel: 'sms', source: 'sms_stop' });
    await webhook('sms-events', { providerEventId: newId(), type: 'start', phone, at: clock.now().toISOString() });
    expect(seen.filter((e) => e.name === 'notifications.suppression.removed')).toHaveLength(1);
  });
});

describe('retries', () => {
  it('backs off 1, 5, 15, 60, 240 minutes, then fails and lets staff retry', async () => {
    const seen = capture(app, 'notifications.delivery.failed');
    const c = world.customer({ email: `tom-${newId().slice(0, 6)}@tempfail.test` });
    await publish(app, 'orders.order.accepted', orderFor(c));
    let [d] = await deliveriesOf(c.accountId);
    expect(d).toMatchObject({ status: 'retrying', attempts: 1 });
    expect(new Date(d.nextAttemptAt).getTime() - clock.now().getTime()).toBe(60_000);
    for (const [minutes, attempts] of [[1, 2], [5, 3], [15, 4], [60, 5], [240, 6]] as const) {
      await app.kernel.jobs.runNow('notifications.retry'); // not due yet: nothing happens
      clock.advance(minutes * 60_000);
      await app.kernel.jobs.runNow('notifications.retry');
      [d] = await deliveriesOf(c.accountId);
      expect(d.attempts).toBe(attempts);
    }
    expect(d.status).toBe('failed');
    await app.kernel.events.drain();
    expect(seen.find((e) => e.payload.deliveryId === d.id)?.payload).toMatchObject({ topicKey: 'customer.order.accepted', channel: 'email' });

    const retried = await app.inject({ method: 'POST', url: `/api/admin/notifications/deliveries/${d.id}/retry`, headers: admin, payload: { reason: 'Mail server is back' } });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ status: 'retrying', attempts: 1 });
    expect(world.audits.find((a) => a.action === 'notifications.delivery.retry')).toBeTruthy();
    const notFailed = await app.inject({ method: 'POST', url: `/api/admin/notifications/deliveries/${d.id}/retry`, headers: admin, payload: { reason: 'again' } });
    expect(notFailed.statusCode).toBe(409);
    expect(notFailed.json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('reports delivery stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/notifications/stats?days=7', headers: admin });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.channelsLive).toEqual(['in_app', 'email', 'sms', 'push']);
    expect(s.bouncedOrBlocked).toBeGreaterThan(0);
    expect(s.failedLast24h).toBeGreaterThan(0);
    expect(s.emailDeliveryRate7d).toBeGreaterThan(0);
    expect(s.emailDeliveryRate7d).toBeLessThanOrEqual(1);
  });
});

describe('quiet hours and the dispatch queue', () => {
  it('holds promotional SMS and push until the quiet window ends', async () => {
    const c = world.customer({ phone: '+15551112222', consent: { smsPromotions: true, smsNumber: '+15553334444', pushPromotions: false, emailPromotions: true } });
    const tz = app.kernel.config.market.timeZone;
    let night = zonedTimeToUtc(dateInZone(clock.now(), tz), '23:00', tz);
    if (night <= clock.now()) night = new Date(night.getTime() + 86_400_000);
    clock.set(night);
    await service.notify({ topic: 'customer.promotions.newsletter', recipients: [{ kind: 'customer', accountId: c.accountId }], link: { kind: 'campaign', id: newId(), screen: 'store/deals' }, context: {} });
    const ds = await deliveriesOf(c.accountId);
    const sms = ds.find((d) => d.channel === 'sms');
    const email = ds.find((d) => d.channel === 'email');
    expect(email.status).toBe('delivered'); // quiet hours apply to SMS and push only
    expect(sms).toMatchObject({ status: 'queued' });
    expect(devOutbox.sms.find((s) => s.message.to === '+15553334444')).toBeUndefined();
    clock.advance(9 * 3_600_000 + 60_000); // 08:01
    await app.kernel.jobs.runNow('notifications.dispatch');
    expect(devOutbox.sms.find((s) => s.message.to === '+15553334444')?.message.text).toContain('Reply STOP');
    expect(emailsTo(c.email)[0]!.message.headers['List-Unsubscribe']).toMatch(/^<http:\/\/localhost:3000\/unsubscribe\/unsubscribe\?token=/); // STORE_URL (development default)
  });
});

describe('inbound replies', () => {
  it('forwards valid replies to support and answers unknown ones', async () => {
    const seen = capture(app, 'notifications.email_reply.received');
    const c = world.customer();
    const order = orderFor(c);
    await publish(app, 'orders.order.accepted', order);
    const caseId = newId();
    await publish(app, 'support.case.opened', { caseId, ref: 'CS-261009-0042', kind: 'customer_help', category: 'delivery', priority: 'low', customerId: c.customerId, sellerId: null, orderId: order.orderId, orderItemIds: [], handler: 'marketplace_support', nextResponseDueAt: null });
    await publish(app, 'support.case.message_added', { caseId, messageId: newId(), audience: 'customer', authorRole: 'staff' });
    const replyTo = emailsTo(c.email).find((e) => e.message.replyTo)!.message.replyTo!;
    const ok = await webhook('inbound-email', { providerEventId: newId(), to: replyTo, from: c.email, subject: 'Re: reply', text: 'Thanks, that works.\n\nOn Oct 9 Marketly wrote:\n> old text', attachments: [], receivedAt: clock.now().toISOString() });
    expect(ok.statusCode, ok.body).toBe(204);
    expect(seen[0]?.payload).toMatchObject({ module: 'support', refId: caseId, fromEmail: c.email.toLowerCase(), accountId: c.accountId, text: 'Thanks, that works.', attachmentAssetIds: [] });

    const stranger = `stranger-${newId().slice(0, 6)}@example.com`;
    await webhook('inbound-email', { providerEventId: newId(), to: replyTo, from: stranger, subject: 'Re: reply', text: 'hi', attachments: [], receivedAt: clock.now().toISOString() });
    expect(seen).toHaveLength(1);
    expect(emailsTo(stranger)[0]!.message.subject).toBe('Please reply in your Marketly account');
  });
});
