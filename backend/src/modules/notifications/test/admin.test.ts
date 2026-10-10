import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { auth, buildTestApp, callers } from '../../../testing/app.js';
import type { NotificationsService } from '../service.js';
import { as, bootWorld, capture, devOutbox, emailsTo, money, newId, publish, type World } from './harness.js';

const clock = fixedClock(new Date());
let app: FastifyInstance;
let world: World;
let service: NotificationsService;
let admin: Record<string, string>;

beforeAll(async () => {
  ({ app, world, service } = await bootWorld({ clock }));
  admin = as.staff(world.staff({ email: 'riley.chen@marketly.example' }));
});
afterAll(async () => {
  await app?.close();
});

const get = async (url: string, headers = admin) => {
  const res = await app.inject({ method: 'GET', url, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};

describe('topic matrix and channels', () => {
  it('lists topics per audience with locked in-app for essential topics', async () => {
    const m = await get('/api/admin/notifications/topics');
    expect(m.customer.length).toBeGreaterThan(20);
    expect(m.promotional.map((t: any) => t.key)).toEqual(expect.arrayContaining(['customer.promotions.newsletter', 'customer.wishlist.alert', 'seller.promotions.tips']));
    const dispatched = m.customer.find((t: any) => t.key === 'customer.shipment.dispatched');
    expect(dispatched.channels.find((c: any) => c.channel === 'in_app')).toEqual({ channel: 'in_app', enabled: true, available: true, locked: true });
    expect(dispatched.variables.find((v: any) => v.name === 'link.url')).toMatchObject({ required: true });
    expect(m.stats.essentialTopics).toBeGreaterThan(50);
  });

  it('switches channels with a reason, refuses locked ones and stops sending on that channel', async () => {
    const seen = capture(app, 'notifications.topic.changed');
    const locked = await app.inject({ method: 'PUT', url: '/api/admin/notifications/topics/customer.order.delayed/channels', headers: admin, payload: { channels: [{ channel: 'in_app', enabled: false, available: true, locked: true }], reason: 'test' } });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('CHANNEL_LOCKED');
    const res = await app.inject({ method: 'PUT', url: '/api/admin/notifications/topics/customer.order.delayed/channels', headers: admin, payload: { channels: [{ channel: 'email', enabled: false, available: true, locked: false }], reason: 'In-app is enough' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().channels.find((c: any) => c.channel === 'email').enabled).toBe(false);
    await app.kernel.events.drain();
    expect(seen[0]!.payload).toMatchObject({ topicKey: 'customer.order.delayed' });
    expect(world.audits.find((a) => a.action === 'notifications.topic.channels')).toMatchObject({ reason: 'In-app is enough' });
    const unknown = await app.inject({ method: 'PUT', url: '/api/admin/notifications/topics/customer.nope/channels', headers: admin, payload: { channels: [], reason: 'x' } });
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses channels before their launch phase', async () => {
    const early = await buildTestApp({ only: ['notifications'], config: { launchPhase: 1, rateLimits: false } });
    try {
      const res = await early.inject({ method: 'PUT', url: '/api/admin/notifications/topics/customer.shipment.exception/channels', headers: auth(callers.staff()), payload: { channels: [{ channel: 'sms', enabled: true, available: false, locked: false }], reason: 'texts' } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CHANNEL_NOT_AVAILABLE');
    } finally {
      await early.close();
    }
  });
});

describe('templates', () => {
  it('drafts, validates, previews, test-sends, publishes and restores versions', async () => {
    const list = await get('/api/admin/notifications/templates?topicKey=customer.shipment.dispatched&channel=email');
    expect(list.items).toHaveLength(1);
    const tpl = list.items[0];
    expect(tpl.live).toMatchObject({ version: 1, status: 'published' });
    const detail = await get(`/api/admin/notifications/templates/${tpl.id}`);
    expect(detail.otherChannels.map((t: any) => t.channel).sort()).toEqual(['in_app', 'push']);
    expect(detail.topic.key).toBe('customer.shipment.dispatched');

    const draft = await app.inject({ method: 'POST', url: `/api/admin/notifications/templates/${tpl.id}/versions`, headers: admin, payload: {} });
    expect(draft.statusCode, draft.body).toBe(201);
    const v2 = draft.json();
    expect(v2).toMatchObject({ version: 2, status: 'draft', validation: { ok: true } });
    const twice = await app.inject({ method: 'POST', url: `/api/admin/notifications/templates/${tpl.id}/versions`, headers: admin, payload: {} });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toMatchObject({ code: 'DRAFT_EXISTS', details: { versionId: v2.id } });

    const bad = { ...v2.content, body: 'Your {{package.items}} shipped with {{carrier.secret}}. 20% off your next order!', button: null };
    const edited = await app.inject({ method: 'PATCH', url: `/api/admin/notifications/templates/${tpl.id}/versions/${v2.id}`, headers: admin, payload: { content: bad, note: 'shorter' } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().validation.ok).toBe(false);
    const messages = edited.json().validation.issues.map((i: any) => i.message).join(' | ');
    expect(messages).toContain('Unknown variable {{carrier.secret}}');
    expect(messages).toContain('Missing required variable {{link.url}}');
    expect(messages).toContain('promotional');
    const refused = await app.inject({ method: 'POST', url: `/api/admin/notifications/templates/${tpl.id}/versions/${v2.id}/publish`, headers: admin, payload: {} });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('TEMPLATE_INVALID');

    const good = { ...v2.content, subject: 'On its way: {{order.ref}}', body: 'Good news! {{package.items}} is on its way.' };
    await app.inject({ method: 'PATCH', url: `/api/admin/notifications/templates/${tpl.id}/versions/${v2.id}`, headers: admin, payload: { content: good } });
    const preview = await app.inject({ method: 'POST', url: `/api/admin/notifications/templates/${tpl.id}/versions/${v2.id}/preview`, headers: admin, payload: { device: 'phone', sampleContext: { order: { ref: 'MK-1' } } } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ channel: 'email', device: 'phone', subject: 'On its way: MK-1', validation: { ok: true } });
    expect(preview.json().html).toContain('width="360"');
    expect(preview.json().footer).toContain("can't unsubscribe");

    const test = await app.inject({ method: 'POST', url: `/api/admin/notifications/templates/${tpl.id}/versions/${v2.id}/test-send`, headers: admin, payload: {} });
    expect(test.statusCode, test.body).toBe(202);
    expect(test.json()).toMatchObject({ recipientKind: 'staff_member', templateVersionId: v2.id });
    expect(emailsTo('riley.chen@marketly.example').at(-1)!.message.subject).toMatch(/^\[Test\] On its way:/);
    const outside = await app.inject({ method: 'POST', url: `/api/admin/notifications/templates/${tpl.id}/versions/${v2.id}/test-send`, headers: admin, payload: { to: 'someone@gmail.com' } });
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error.code).toBe('TEST_RECIPIENT_NOT_ALLOWED');

    const seen = capture(app, 'notifications.template.published');
    const pub = await app.inject({ method: 'POST', url: `/api/admin/notifications/templates/${tpl.id}/versions/${v2.id}/publish`, headers: admin, payload: { note: 'Friendlier' } });
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json()).toMatchObject({ status: 'published', note: 'Friendlier' });
    await app.kernel.events.drain();
    expect(seen[0]!.payload).toMatchObject({ templateId: tpl.id, topicKey: 'customer.shipment.dispatched', channel: 'email', version: 2 });
    expect(world.audits.find((a) => a.action === 'notifications.template.publish')).toBeTruthy();
    const after = await get(`/api/admin/notifications/templates/${tpl.id}`);
    expect(after.live.version).toBe(2);
    expect(after.versions.map((v: any) => [v.version, v.status])).toEqual([[2, 'published'], [1, 'superseded']]);
    expect((await app.inject({ method: 'POST', url: `/api/admin/notifications/templates/${tpl.id}/versions/${v2.id}/publish`, headers: admin, payload: {} })).statusCode).toBe(409);

    // the new live version is used
    const c = world.customer();
    const order = { orderId: newId(), ref: 'MK-261009-55555', customerId: c.customerId, contactEmail: c.email, total: money(100), groups: [], items: [], acceptedAt: clock.now().toISOString() };
    await publish(app, 'orders.order.accepted', order);
    await publish(app, 'shipping.shipment.dispatched', { shipmentId: newId(), kind: 'outbound', orderId: order.orderId, groupId: newId(), returnId: null, ownerType: 'official', sellerId: null, lines: [{ orderItemId: newId(), title: 'Lamp', variantLabel: '', quantity: 2 }], shippedAt: clock.now().toISOString(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
    expect(emailsTo(c.email).map((e) => e.message.subject)).toContain('On its way: MK-261009-55555');

    // restore version 1 as a new draft, then discard it
    const restore = await app.inject({ method: 'POST', url: `/api/admin/notifications/templates/${tpl.id}/versions`, headers: admin, payload: { fromVersionId: tpl.live.id } });
    expect(restore.json()).toMatchObject({ version: 3, status: 'draft', note: 'Restored from version 1' });
    const discarded = await app.inject({ method: 'POST', url: `/api/admin/notifications/templates/${tpl.id}/versions/${restore.json().id}/discard`, headers: admin });
    expect(discarded.json().status).toBe('discarded');
    const editDiscarded = await app.inject({ method: 'PATCH', url: `/api/admin/notifications/templates/${tpl.id}/versions/${restore.json().id}`, headers: admin, payload: { content: good } });
    expect(editDiscarded.statusCode).toBe(409);
  });
});

describe('broadcasts', () => {
  it('drafts, schedules and sends to consenting customers only', async () => {
    const yes = world.customer({ consent: { emailPromotions: true } });
    const no = world.customer({ consent: { emailPromotions: false } });
    const templates = await get('/api/admin/notifications/templates?topicKey=customer.promotions.newsletter&channel=email');
    const versionId = templates.items[0].live.id;
    const essential = await get('/api/admin/notifications/templates?topicKey=customer.order.accepted&channel=email');
    const wrong = await app.inject({ method: 'POST', url: '/api/admin/notifications/broadcasts', headers: admin, payload: { name: 'x', audience: 'customers', topicKey: 'customer.order.accepted', templateVersionId: essential.items[0].live.id, segment: { consentChannel: 'email', filters: {} } } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('TOPIC_NOT_PROMOTIONAL');

    const created = await app.inject({ method: 'POST', url: '/api/admin/notifications/broadcasts', headers: admin, payload: { name: 'Home Week deals', audience: 'customers', topicKey: 'customer.promotions.newsletter', templateVersionId: versionId, segment: { consentChannel: 'email', filters: {} } } });
    expect(created.statusCode, created.body).toBe(201);
    const b = created.json();
    expect(b).toMatchObject({ status: 'draft', recipientEstimate: expect.any(Number) });
    expect(b.recipientEstimate).toBeGreaterThanOrEqual(1);

    const seen = capture(app, 'notifications.broadcast.scheduled', 'notifications.broadcast.sent');
    const at = new Date(clock.now().getTime() + 3_600_000).toISOString();
    const scheduled = await app.inject({ method: 'POST', url: `/api/admin/notifications/broadcasts/${b.id}/schedule`, headers: admin, payload: { scheduledAt: at } });
    expect(scheduled.statusCode, scheduled.body).toBe(200);
    expect(scheduled.json()).toMatchObject({ status: 'scheduled', scheduledAt: at });
    await app.kernel.events.drain();
    expect(seen.find((e) => e.name === 'notifications.broadcast.scheduled')!.payload).toMatchObject({ broadcastId: b.id, audience: 'customers' });

    await app.kernel.jobs.runNow('notifications.send-broadcasts');
    expect((await get(`/api/admin/notifications/broadcasts?status=scheduled`)).items.map((x: any) => x.id)).toContain(b.id);
    clock.advance(3_600_000 + 1000);
    await app.kernel.jobs.runNow('notifications.send-broadcasts');
    const sent = (await get('/api/admin/notifications/broadcasts?status=sent')).items.find((x: any) => x.id === b.id);
    expect(sent.stats.sent).toBeGreaterThanOrEqual(1);
    expect(emailsTo(yes.email)).toHaveLength(1);
    expect(emailsTo(no.email)).toHaveLength(0);
    const mail = emailsTo(yes.email)[0]!.message;
    expect(mail.from).toContain('deals@marketly.example');
    const token = /token=([^>&\s]+)/.exec(mail.headers['List-Unsubscribe']!)![1]!;
    expect(await service.verifyUnsubscribeToken(token)).toEqual({ audience: 'customer', accountId: yes.accountId, email: yes.email, channel: 'email', topicGroup: 'promotions' });
    expect(await service.verifyUnsubscribeToken(`${token}x`)).toBeNull();
    await app.kernel.events.drain();
    expect(seen.find((e) => e.name === 'notifications.broadcast.sent')!.payload).toMatchObject({ broadcastId: b.id });

    const cancel = await app.inject({ method: 'POST', url: `/api/admin/notifications/broadcasts/${b.id}/cancel`, headers: admin, payload: { reason: 'too late' } });
    expect(cancel.statusCode).toBe(409);
  });

  it('cancels a draft', async () => {
    const templates = await get('/api/admin/notifications/templates?topicKey=seller.promotions.tips&channel=email');
    const created = await app.inject({ method: 'POST', url: '/api/admin/notifications/broadcasts', headers: admin, payload: { name: 'Tips', audience: 'sellers', topicKey: 'seller.promotions.tips', templateVersionId: templates.items[0].live.id, segment: { consentChannel: 'email', filters: {} } } });
    expect(created.statusCode, created.body).toBe(201);
    const res = await app.inject({ method: 'POST', url: `/api/admin/notifications/broadcasts/${created.json().id}/cancel`, headers: admin, payload: { reason: 'Not this month' } });
    expect(res.json().status).toBe('cancelled');
    expect(world.audits.find((a) => a.action === 'notifications.broadcast.cancel')).toMatchObject({ reason: 'Not this month' });
  });
});

describe('seller preferences', () => {
  it('lets the owner set who hears about what, with locked groups', async () => {
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true, role: 'Owner', name: 'Casa Owner' });
    const agent = world.member(sellerId, { permissions: ['messaging.conversations.reply', 'orders.fulfillment.view'], role: 'Customer service', name: 'Casa Agent' });
    await app.inject({ method: 'GET', url: '/api/seller/notifications/inbox', headers: as.seller(agent) });
    const prefs = await get('/api/seller/notifications/preferences', as.seller(owner));
    expect(prefs.groups.map((g: any) => g.key)).toEqual(expect.arrayContaining(['new_orders', 'payouts_holds', 'promotions']));
    const ownerRow = prefs.members.find((m: any) => m.isOwner);
    expect(ownerRow).toMatchObject({ name: 'Casa Owner', channel: 'in_app_and_email', groups: { payouts_holds: true } });
    expect(ownerRow.lockedGroups).toContain('new_orders');
    const agentRow = prefs.members.find((m: any) => m.accountId === agent.accountId);
    expect(agentRow).toMatchObject({ roleLabel: 'Customer service', isOwner: false, groups: { payouts_holds: false } });

    const lockedOwner = await app.inject({ method: 'PUT', url: `/api/seller/notifications/preferences/members/${owner.memberId}`, headers: as.seller(owner), payload: { groups: { new_orders: false }, channel: 'in_app_and_email' } });
    expect(lockedOwner.json().error.code).toBe('GROUP_LOCKED');
    const ownerOnly = await app.inject({ method: 'PUT', url: `/api/seller/notifications/preferences/members/${agent.memberId}`, headers: as.seller(owner), payload: { groups: { payouts_holds: true }, channel: 'in_app' } });
    expect(ownerOnly.statusCode).toBe(409);
    expect(ownerOnly.json().error.code).toBe('GROUP_LOCKED');
    const ok = await app.inject({ method: 'PUT', url: `/api/seller/notifications/preferences/members/${agent.memberId}`, headers: as.seller(owner), payload: { groups: { customer_messages: false }, channel: 'in_app_and_email' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ groups: { customer_messages: false }, channel: 'in_app_and_email' });
    expect(world.audits.find((a) => a.action === 'notifications.member_preferences.update')).toMatchObject({ visibleToSeller: true });

    // the agent no longer sees customer messages; the owner does
    await publish(app, 'messaging.message.sent', { messageId: newId(), conversationId: newId(), conversationKind: 'order', authorKind: 'customer', recipientKinds: ['seller'], customerId: null, sellerId, officialStore: false, staffIds: [], orderId: null });
    const agentInbox = (await get('/api/seller/notifications/inbox', as.seller(agent))).items;
    expect(agentInbox.map((n: any) => n.topicKey)).not.toContain('seller.message.new');
    expect((await get('/api/seller/notifications/inbox', as.seller(owner))).items.map((n: any) => n.topicKey)).toContain('seller.message.new');
    const skipped = (await get(`/api/admin/notifications/deliveries?accountId=${agent.accountId}`)).items;
    expect(skipped[0]).toMatchObject({ status: 'skipped', skipReason: 'preference_off' });

    // members change their own channel but not the essential groups (the owner sets those)
    const self = await app.inject({ method: 'PUT', url: `/api/seller/notifications/preferences/members/${agent.memberId}`, headers: as.seller(agent), payload: { groups: { new_orders: false }, channel: 'email' } });
    expect(self.json().error.code).toBe('GROUP_LOCKED');
    const selfOk = await app.inject({ method: 'PUT', url: `/api/seller/notifications/preferences/members/${agent.memberId}`, headers: as.seller(agent), payload: { groups: {}, channel: 'email' } });
    expect(selfOk.json().channel).toBe('email');
    const other = await app.inject({ method: 'PUT', url: `/api/seller/notifications/preferences/members/${owner.memberId}`, headers: as.seller(agent), payload: { groups: {}, channel: 'email' } });
    expect(other.statusCode).toBe(403);
    const unknown = await app.inject({ method: 'PUT', url: `/api/seller/notifications/preferences/members/${newId()}`, headers: as.seller(owner), payload: { groups: {}, channel: 'email' } });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('staff preferences and the daily digest', () => {
  it('replaces individual emails with one digest, except urgent notices', async () => {
    const person = world.staff();
    const before = await get('/api/admin/notifications/my-preferences', as.staff(person));
    expect(before).toMatchObject({ accountId: person.accountId, emailForMentions: true, dailyDigest: false, emailByArea: { Finance: true } });
    const put = await app.inject({ method: 'PUT', url: '/api/admin/notifications/my-preferences', headers: as.staff(person), payload: { emailByArea: { Finance: true }, emailForMentions: true, dailyDigest: true } });
    expect(put.json().dailyDigest).toBe(true);
    world.role('finance_manager', { leadAccountId: person.accountId, accountIds: [person.accountId] });
    await publish(app, 'finance.reconciliation.mismatch_found', { itemId: newId(), check: 'card_deposits', difference: money(1240) });
    expect(emailsTo(person.email)).toHaveLength(0);
    await publish(app, 'finance.payout.failed', { payoutId: newId(), ref: 'PO-261009-0418', sellerId: newId(), amount: money(124000), failureCode: null, failureReason: 'Account closed' });
    expect(emailsTo(person.email)).toHaveLength(1); // urgent
    await app.kernel.jobs.runNow('notifications.staff-digest');
    const digest = emailsTo(person.email).at(-1)!.message;
    expect(digest.subject).toBe('Your Marketly daily summary (1)');
    expect(digest.text).toContain('Reconciliation mismatch');
    await app.kernel.jobs.runNow('notifications.staff-digest');
    expect(emailsTo(person.email)).toHaveLength(2); // once a day
  });
});

describe('customer preferences and push devices', () => {
  it('registers, updates and removes Android devices and sends order pushes to them', async () => {
    const c = world.customer();
    const prefs = await get('/api/store/notifications/preferences', as.customer(c));
    expect(prefs).toMatchObject({ promotional: { managedBy: 'customers', path: '/api/store/customers/marketing-preferences' }, push: { available: true, orderUpdates: true, devices: [] } });
    expect(prefs.essential.topics).toContain('Dispatched, with tracking');

    const reg = await app.inject({ method: 'POST', url: '/api/store/notifications/push-devices', headers: as.customer(c), payload: { token: 'fcm-token-abc123456', platform: 'android', appVersion: '1.0.0', installationId: 'inst-1' } });
    expect(reg.statusCode, reg.body).toBe(201);
    expect(reg.json()).toMatchObject({ tokenSuffix: '123456', enabled: true });
    const again = await app.inject({ method: 'POST', url: '/api/store/notifications/push-devices', headers: as.customer(c), payload: { token: 'fcm-token-new654321', platform: 'android', appVersion: '1.0.1', installationId: 'inst-1' } });
    expect(again.json()).toMatchObject({ id: reg.json().id, tokenSuffix: '654321', appVersion: '1.0.1' });

    await publish(app, 'orders.order.accepted', { orderId: newId(), ref: 'MK-261009-12121', customerId: c.customerId, contactEmail: c.email, total: money(100), groups: [], items: [], acceptedAt: clock.now().toISOString() });
    const push = devOutbox.push.find((p) => p.message.token === 'fcm-token-new654321')!.message;
    expect(push).toMatchObject({ title: 'Order MK-261009-12121 accepted', data: { kind: 'order', screen: 'account/order', ref: 'MK-261009-12121' } });

    const off = await app.inject({ method: 'PUT', url: '/api/store/notifications/preferences/push', headers: as.customer(c), payload: { orderUpdates: false } });
    expect(off.json()).toMatchObject({ orderUpdates: false });
    const other = world.customer();
    expect((await app.inject({ method: 'DELETE', url: `/api/store/notifications/push-devices/${reg.json().id}`, headers: as.customer(other) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/store/notifications/push-devices/${reg.json().id}`, headers: as.customer(c) })).statusCode).toBe(204);
    expect((await get('/api/store/notifications/preferences', as.customer(c))).push.devices).toEqual([]);
  });

  it('drops invalid tokens and closed accounts', async () => {
    const c = world.customer();
    await app.inject({ method: 'POST', url: '/api/store/notifications/push-devices', headers: as.customer(c), payload: { token: 'invalid-token-000001', platform: 'android', appVersion: '1.0.0' } });
    await publish(app, 'orders.order.accepted', { orderId: newId(), ref: 'MK-261009-13131', customerId: c.customerId, contactEmail: c.email, total: money(100), groups: [], items: [], acceptedAt: clock.now().toISOString() });
    expect((await get('/api/store/notifications/preferences', as.customer(c))).push.devices).toEqual([]);

    const d = world.customer();
    await app.inject({ method: 'POST', url: '/api/store/notifications/push-devices', headers: as.customer(d), payload: { token: 'fcm-closing-0000002', platform: 'android', appVersion: '1.0.0' } });
    await publish(app, 'customers.account.closed', { customerId: d.customerId, userId: d.accountId });
    expect((await get('/api/store/notifications/preferences', as.customer(d))).push.devices).toEqual([]);
  });

  it('checks wishlist consent before promotional notices', async () => {
    const off = world.customer();
    const on = world.customer({ consent: { wishlistAlerts: true } });
    for (const c of [off, on]) await publish(app, 'wishlist.alert.triggered', { alertId: newId(), customerId: c.customerId, kind: 'price_drop', productId: newId(), offerId: null, price: money(15900), previousPrice: money(18900) });
    expect((await get('/api/store/notifications/inbox', as.customer(off))).items).toHaveLength(0);
    expect((await get(`/api/admin/notifications/deliveries?accountId=${off.accountId}`)).items[0]).toMatchObject({ status: 'skipped', skipReason: 'no_consent' });
    const mine = (await get('/api/store/notifications/inbox?group=promotions', as.customer(on))).items;
    expect(mine[0]).toMatchObject({ topicKey: 'customer.wishlist.alert', category: 'promotional', tone: 'deal' });
    expect(emailsTo(on.email)[0]!.message.headers['List-Unsubscribe']).toBeTruthy();
    expect(await service.canSendPromotional({ kind: 'customer', accountId: on.accountId }, 'email')).toBe(false); // wishlist alerts ≠ email promotions
    const promo = world.customer({ consent: { emailPromotions: true } });
    expect(await service.canSendPromotional({ kind: 'customer', accountId: promo.accountId }, 'email')).toBe(true);
    expect(await service.canSendPromotional({ kind: 'guest_email', email: 'x@example.com' }, 'email')).toBe(false);
  });
});

describe('public API', () => {
  it('notifies, schedules, cancels and resolves', async () => {
    const mentioned = world.staff();
    const res = await service.notify({ topic: 'staff.mention', recipients: [{ kind: 'staff_member', accountId: mentioned.accountId }], link: { kind: 'payout', id: newId(), screen: 'admin/payouts' }, context: { mention: { by: 'Theo Grant', text: 'Can you check this payout?' } } });
    expect(res.noticeIds).toHaveLength(1);
    const summary = await get('/api/admin/notifications/inbox/summary', as.staff(mentioned));
    expect(summary).toMatchObject({ mentions: 1, unread: 1 });
    expect((await get('/api/admin/notifications/inbox?view=mentions', as.staff(mentioned))).items[0].title).toBe('Theo Grant mentioned you');

    await expect(service.notify({ topic: 'nope', recipients: [], link: { kind: 'x', id: 'y', screen: 'z' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.schedule({ topic: 'seller.dispatch.reminder', recipients: [], link: { kind: 'x', id: 'y', screen: 'z' } }, clock.now().toISOString())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true });
    const groupId = newId();
    const input = { topic: 'seller.dispatch.reminder', recipients: [{ kind: 'seller' as const, sellerId }], link: { kind: 'seller_order', id: groupId, screen: 'seller/order' }, context: { order: { ref: 'MK-1' }, due: { date: '5:00 PM' } }, dedupeKey: `seller.dispatch.reminder:${groupId}`, actionRequired: true };
    await service.schedule(input, new Date(clock.now().getTime() + 3_600_000).toISOString());
    await service.schedule({ ...input, dedupeKey: 'other-key' }, new Date(clock.now().getTime() + 3_600_000).toISOString());
    expect(await service.cancelScheduled('other-key')).toBe(1);
    await app.kernel.jobs.runNow('notifications.send-scheduled');
    expect((await get('/api/seller/notifications/inbox', as.seller(owner))).items).toHaveLength(0);
    clock.advance(3_600_000 + 1000);
    await app.kernel.jobs.runNow('notifications.send-scheduled');
    const items = (await get('/api/seller/notifications/inbox', as.seller(owner))).items;
    expect(items.map((n: any) => n.topicKey)).toEqual(['seller.dispatch.reminder']);
    expect(await service.resolve(`seller.dispatch.reminder:${groupId}`, 'dispatched')).toBe(1);
    expect(await service.unreadCount({ kind: 'seller', accountId: owner.accountId, sellerId, sellerMemberId: owner.memberId, sessionId: newId() })).toBeGreaterThan(0);
  });

  it('purges old notices and delivery rows', async () => {
    const c = world.customer();
    await publish(app, 'customers.data_export.ready', { customerId: c.customerId, requestId: newId(), expiresAt: clock.now().toISOString() });
    expect((await get('/api/store/notifications/inbox', as.customer(c))).items).toHaveLength(1);
    clock.advance(400 * 86_400_000);
    await app.kernel.jobs.runNow('notifications.purge');
    clock.advance(-400 * 86_400_000);
    expect((await get('/api/store/notifications/inbox', as.customer(c))).items).toHaveLength(0);
    expect((await get(`/api/admin/notifications/deliveries?accountId=${c.accountId}`)).items).toHaveLength(0);
  });
});
