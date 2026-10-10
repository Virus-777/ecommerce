/**
 * Pass 3: honoured notify flags (orders notifyCustomer, support notified), store-credit payments, Official
 * Store messages to staff, the new topics (trust evidence and appeals, refund destination, closure delayed,
 * low-stock digests, application reminders, missing-items review, day-end summary), Notice.state with
 * expired action notices, Recipient.customerId, external audiences in the admin views, inbound email
 * attachments through media and the staff digest on closed days.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../kernel/errors/index.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import { buildTestApp } from '../../../testing/app.js';
import type { NotificationsService } from '../service.js';
import { as, capture, emailsTo, MODULES, money, newId, publish, World } from './harness.js';

let app: FastifyInstance;
let service: NotificationsService;
const world = new World();
const calendar = { closed: new Set<string>() };
const stored: { fileName: string; purpose: string; owner: unknown; bytes: number }[] = [];

beforeAll(async () => {
  app = await buildTestApp({
    modules: [...MODULES, 'settings'],
    config: { launchPhase: 4, rateLimits: false },
    apiStubs: {
      ...world.stubs(),
      media: {
        storeInboundFile: async (input) => {
          if (/\.exe$/i.test(input.fileName)) throw new AppError('FILE_TYPE_NOT_ALLOWED', 'This file type is not allowed', undefined, 415);
          stored.push({ fileName: input.fileName, purpose: input.purpose, owner: input.owner, bytes: input.body.length });
          return { id: newId() } as never;
        },
      },
      settings: {
        // spec defaults for every setting (the stubbed service cannot reach its own private state)
        get: async () => null as never,
        businessCalendar: async () =>
          ({
            isBusinessDay: (day: string) => !calendar.closed.has(day),
            isOpen: () => true,
            addBusinessMinutes: (from: string) => from,
            addBusinessDays: (from: string) => from,
            nextOpen: (after: string) => after,
          }) as never,
      },
    },
  });
  service = app.kernel.boot.apis.get('notifications') as NotificationsService;
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  calendar.closed.clear();
});

const inbox = async (headers: Record<string, string>, area: 'store' | 'seller' | 'admin', query = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/${area}/notifications/inbox${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as any[];
};
const admin = () => as.staff(world.staff());
const getJson = async (url: string) => {
  const res = await app.inject({ method: 'GET', url, headers: admin() });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const addr = (who: string) => `${who}-${newId().slice(-12)}@example.com`;

function cancelled(o: { customerId: string; sellerId: string; notifyCustomer: boolean }) {
  return {
    orderId: newId(),
    ref: 'MK-261010-30001',
    customerId: o.customerId,
    contactEmail: null,
    groupId: newId(),
    ownerType: 'seller',
    sellerId: o.sellerId,
    itemId: newId(),
    offerId: newId(),
    stockItemId: newId(),
    quantity: 1,
    cancellationId: newId(),
    initiatedBy: 'staff',
    reasonCode: 'policy',
    beforeDispatch: true,
    countsAgainstSeller: false,
    refund: { itemAmount: money(4900), discountShare: money(0), shippingRefund: money(0), taxRefund: money(0), total: money(4900) },
    paymentIntentId: newId(),
    notifyCustomer: o.notifyCustomer,
  };
}

describe('flags the publisher sets', () => {
  it('orders.item.cancelled with notifyCustomer false tells the seller only', async () => {
    const c = world.customer();
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true });
    await publish(app, 'orders.item.cancelled', cancelled({ customerId: c.customerId, sellerId, notifyCustomer: false }));
    expect(await inbox(as.customer(c), 'store')).toHaveLength(0);
    expect(emailsTo(c.email)).toHaveLength(0);
    expect((await inbox(as.seller(owner), 'seller')).map((n) => n.topicKey)).toEqual(['seller.order.item_cancelled']);
    // notifyCustomer true: the customer is told
    await publish(app, 'orders.item.cancelled', cancelled({ customerId: c.customerId, sellerId, notifyCustomer: true }));
    expect((await inbox(as.customer(c), 'store')).map((n) => n.topicKey)).toEqual(['customer.order.item_cancelled']);
  });

  it('support.case.decided with notified false sends nothing, but still resolves the case action notices', async () => {
    const c = world.customer();
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true });
    const caseId = newId();
    const orderId = newId();
    await publish(app, 'support.case.opened', { caseId, ref: 'CS-261010-0101', kind: 'order_problem', category: 'damaged', priority: 'medium', customerId: c.customerId, contactEmail: null, sellerId, orderId, orderItemIds: [], handler: 'seller', nextResponseDueAt: inDays(1) });
    const decided = { caseId, ref: 'CS-261010-0101', outcome: 'refund_full', orderId, customerId: c.customerId, contactEmail: null, returnId: null, sellerId, remedies: [], appealDeadline: inDays(7), final: true, notified: false };
    await publish(app, 'support.case.decided', decided);
    expect((await inbox(as.customer(c), 'store')).map((n) => n.topicKey)).toEqual(['customer.case.opened']);
    const sellerSide = await inbox(as.seller(owner), 'seller');
    expect(sellerSide.map((n) => n.topicKey)).toEqual(['seller.case.opened']);
    expect(sellerSide[0]).toMatchObject({ state: 'resolved' });
    expect(emailsTo(c.email).map((m) => m.message.subject)).not.toContain('Decision on your case CS-261010-0101');
  });

  it('a payment made with store credit alone says so', async () => {
    const c = world.customer();
    await publish(app, 'payments.payment.captured', { intentId: newId(), captureId: newId(), orderId: newId(), customerId: c.customerId, contactEmail: null, groupId: null, amount: money(0), creditAmount: money(1500), allocations: [], providerRef: null, capturedAt: new Date().toISOString() });
    const [n] = await inbox(as.customer(c), 'store');
    expect(n.topicKey).toBe('customer.payment.captured');
    expect(n.body).toContain('$15.00 in store credit');
    const d = world.customer();
    await publish(app, 'payments.payment.captured', { intentId: newId(), captureId: newId(), orderId: newId(), customerId: d.customerId, contactEmail: null, groupId: null, amount: money(3000), creditAmount: money(500), allocations: [], providerRef: null, capturedAt: new Date().toISOString() });
    expect((await inbox(as.customer(d), 'store'))[0].body).toContain('$30.00 plus $5.00 in store credit');
  });
});

describe('Official Store messages', () => {
  it('go to the Official Store Manager role (action required) instead of a seller workspace, resolved by the reply', async () => {
    const lead = world.staff();
    world.role('official_store_manager', { leadAccountId: lead.accountId, accountIds: [lead.accountId] });
    const c = world.customer();
    const conversationId = newId();
    const message = (o: Record<string, unknown>) => ({ messageId: newId(), conversationId, conversationKind: 'order', customerId: c.customerId, sellerId: OFFICIAL_STORE_ID, officialStore: true, staffIds: [], orderId: null, ...o });
    await publish(app, 'messaging.message.sent', message({ authorKind: 'customer', recipientKinds: ['official_store'] }));
    let [n] = await inbox(as.staff(lead), 'admin', '?view=needs_my_action');
    expect(n).toMatchObject({ topicKey: 'staff.official_store.message_received', actionRequired: true, state: 'open', link: { kind: 'conversation', id: conversationId } });
    expect(n.routedTo).toMatchObject({ roleKey: 'official_store_manager' });
    // the store answers: the customer is told, the staff notice is done
    await publish(app, 'messaging.message.sent', message({ authorKind: 'staff', recipientKinds: ['customer'] }));
    expect((await inbox(as.customer(c), 'store')).map((x) => x.topicKey)).toEqual(['customer.message.new']);
    expect(await inbox(as.staff(lead), 'admin', '?view=needs_my_action')).toHaveLength(0);
    [n] = await inbox(as.staff(lead), 'admin');
    expect(n).toMatchObject({ topicKey: 'staff.official_store.message_received', state: 'resolved' });
  });
});

describe('new topics', () => {
  it('trust evidence requests: customer or seller owner, action required until trust resolves them', async () => {
    const c = world.customer();
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true });
    const member = world.member(sellerId, { permissions: ['orders.fulfillment.view'] });
    const toCustomer = newId();
    const toSeller = newId();
    await publish(app, 'trust.evidence.requested', { requestId: toCustomer, reportId: newId(), reportRef: 'TR-261010-0300', toType: 'customer', toId: c.customerId, customerId: c.customerId, sellerId: null, question: 'Please explain the order you disputed.', dueAt: inDays(5) });
    await publish(app, 'trust.evidence.requested', { requestId: toSeller, reportId: newId(), reportRef: 'TR-261010-0301', toType: 'offer', toId: newId(), customerId: null, sellerId, question: 'Send the invoice for these units.', dueAt: inDays(5) });
    const [cn] = await inbox(as.customer(c), 'store');
    expect(cn).toMatchObject({ topicKey: 'customer.trust.evidence_requested', group: 'cases', actionRequired: true, state: 'open' });
    expect(cn.body).toContain('Please explain the order you disputed.');
    expect((await inbox(as.seller(owner), 'seller')).map((n) => n.topicKey)).toEqual(['seller.trust.evidence_requested']);
    expect(await inbox(as.seller(member), 'seller')).toHaveLength(0); // owner only
    expect(await service.resolve(`trust-evidence:${toCustomer}`, 'answered')).toBe(1);
    expect((await inbox(as.customer(c), 'store'))[0]).toMatchObject({ state: 'resolved' });
  });

  it('trust appeal decisions tell the appellant what changes', async () => {
    const c = world.customer();
    await publish(app, 'trust.appeal.decided', { appealId: newId(), ref: 'AP-261010-0007', enforcementId: newId(), outcome: 'overturned', explanation: 'The messages were quoted out of context.', customerId: c.customerId, sellerId: null });
    const [n] = await inbox(as.customer(c), 'store');
    expect(n).toMatchObject({ topicKey: 'customer.trust.appeal_decided', group: 'cases' });
    expect(n.body).toContain('overturned');
    expect(n.body).toContain('We are lifting the action on your account.');
  });

  it('refund destination requests: customer or guest, resolved when the refund is sent', async () => {
    const c = world.customer();
    const refundId = newId();
    const orderId = newId();
    await publish(app, 'payments.refund.destination_requested', { refundId, ref: 'RF-261010-0001', orderId, orderRef: 'MK-261010-30010', customerId: c.customerId, contactEmail: null, amount: money(4900), failureReason: 'The card was closed', message: null });
    let [n] = await inbox(as.customer(c), 'store');
    expect(n).toMatchObject({ topicKey: 'customer.refund.destination_needed', group: 'returns_refunds', actionRequired: true, state: 'open', link: { kind: 'refund', id: refundId } });
    expect(n.body).toContain('$49.00');
    await publish(app, 'payments.refund.sent', { refundId, ref: 'RF-261010-0001', orderId, customerId: c.customerId, contactEmail: null, origin: 'return', originId: null, amount: money(4900), items: [], destination: 'Store credit', sentAt: new Date().toISOString() });
    n = (await inbox(as.customer(c), 'store')).find((x) => x.topicKey === 'customer.refund.destination_needed');
    expect(n.state).toBe('resolved');

    const guest = addr('guest');
    await publish(app, 'payments.refund.destination_requested', { refundId: newId(), ref: 'RF-261010-0002', orderId: newId(), orderRef: 'MK-261010-30011', customerId: null, contactEmail: guest, amount: money(1000), failureReason: null, message: 'Your card ending 4417 was closed.' });
    expect(emailsTo(guest).map((m) => m.message.subject)).toEqual(['Action needed: choose where to receive your refund']);
  });

  it('closure delayed tells the customer what is open and when it is checked again', async () => {
    const c = world.customer();
    await publish(app, 'customers.closure.delayed', { customerId: c.customerId, userId: c.accountId, requestId: newId(), blockers: [{ kind: 'open_orders', count: 1, detail: '1 open order' }], nextCheckAt: inDays(1) });
    const [n] = await inbox(as.customer(c), 'store');
    expect(n).toMatchObject({ topicKey: 'customer.account.closure_delayed', group: 'account' });
    expect(n.body).toContain('1 open order');
  });

  it('low-stock digests: Official Store items to the Inventory Manager role, seller items to the seller', async () => {
    const lead = world.staff();
    world.role('inventory_manager', { leadAccountId: lead.accountId, accountIds: [lead.accountId] });
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true });
    const item = (label: string, state: 'low_stock' | 'out_of_stock', available: number) => ({ stockItemId: newId(), offerId: null, sku: label.toUpperCase(), label, available, threshold: 5, state });
    await publish(app, 'inventory.stock.low_digest', { ownerType: 'official', sellerId: null, date: '2026-10-10', lowCount: 1, outOfStockCount: 1, items: [item('Aurora Desk Lamp', 'out_of_stock', 0), item('Lamp shade', 'low_stock', 2)] });
    await publish(app, 'inventory.stock.low_digest', { ownerType: 'seller', sellerId, date: '2026-10-10', lowCount: 1, outOfStockCount: 0, items: [item('Mug', 'low_stock', 3)] });
    const [s] = await inbox(as.staff(lead), 'admin');
    expect(s).toMatchObject({ topicKey: 'staff.inventory.low_stock_digest', group: 'Inventory' });
    expect(s.body).toContain('Aurora Desk Lamp (out of stock); Lamp shade (2 left)');
    const [o] = await inbox(as.seller(owner), 'seller');
    expect(o).toMatchObject({ topicKey: 'seller.stock.low_digest', group: 'products' });
    expect(o.body).toContain('Mug (3 left)');
  });

  it('application information reminders go to the applicant (owner) as an action notice', async () => {
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true });
    const applicationId = newId();
    await publish(app, 'sellers.application.information_reminder', { applicationId, ref: 'SA-261010-0001', sellerId, applicantAccountId: owner.accountId, dueAt: inDays(2), openItems: 2 });
    const [n] = await inbox(as.seller(owner), 'seller');
    expect(n).toMatchObject({ topicKey: 'seller.application.information_reminder', actionRequired: true, state: 'open' });
    expect(n.body).toContain('2 requested item(s)');
  });

  it('missing-items reviews: seller members who manage offers, or the Catalog Manager role for Official Store offers', async () => {
    const sellerId = newId();
    const manager = world.member(sellerId, { permissions: ['offers.offers.manage'] });
    const packer = world.member(sellerId, { permissions: ['orders.fulfillment.view'] });
    await app.inject({ method: 'GET', url: '/api/seller/notifications/inbox', headers: as.seller(manager) });
    const base = { productId: newId(), variantId: newId(), title: 'Aurora Desk Lamp', staleItems: ['USB cable'], newBoxItems: [] };
    await publish(app, 'offers.offer.missing_items_stale', { ...base, offerId: newId(), ownerType: 'seller', sellerId });
    expect((await inbox(as.seller(manager), 'seller')).map((n) => n.topicKey)).toEqual(['seller.offer.missing_items_review']);
    expect(await inbox(as.seller(packer), 'seller')).toHaveLength(0);

    const catalogLead = world.staff();
    world.role('catalog_manager', { leadAccountId: catalogLead.accountId, accountIds: [catalogLead.accountId] });
    await publish(app, 'offers.offer.missing_items_stale', { ...base, offerId: newId(), ownerType: 'official', sellerId: null });
    const [n] = await inbox(as.staff(catalogLead), 'admin');
    expect(n).toMatchObject({ topicKey: 'staff.offer.missing_items_review' });
    expect(n.body).toContain('no longer in the box: USB cable');
  });

  it('missing-items reviews are action notices resolved by offers.offer.missing_items_reviewed (pass 5)', async () => {
    const sellerId = newId();
    const manager = world.member(sellerId, { permissions: ['offers.offers.manage'] });
    await app.inject({ method: 'GET', url: '/api/seller/notifications/inbox', headers: as.seller(manager) });
    const offerId = newId();
    const productId = newId();
    await publish(app, 'offers.offer.missing_items_stale', { offerId, productId, variantId: newId(), ownerType: 'seller', sellerId, title: 'Aurora Desk Lamp', staleItems: ['USB cable'], newBoxItems: [] });
    const states = async () => (await inbox(as.seller(manager), 'seller')).map((n) => [n.topicKey, n.actionRequired, n.state]);
    expect(await states()).toEqual([['seller.offer.missing_items_review', true, 'open']]);
    // another offer's review leaves it open
    await publish(app, 'offers.offer.missing_items_reviewed', { offerId: newId(), productId, ownerType: 'seller', sellerId, missingItems: [], changed: true, reviewedBy: { kind: 'seller', id: manager.accountId } });
    expect(await states()).toEqual([['seller.offer.missing_items_review', true, 'open']]);
    await publish(app, 'offers.offer.missing_items_reviewed', { offerId, productId, ownerType: 'seller', sellerId, missingItems: [], changed: false, reviewedBy: { kind: 'seller', id: manager.accountId } });
    expect(await states()).toEqual([['seller.offer.missing_items_review', true, 'resolved']]);

    const catalogLead = world.staff();
    world.role('catalog_manager', { leadAccountId: catalogLead.accountId, accountIds: [catalogLead.accountId] });
    const official = newId();
    await publish(app, 'offers.offer.missing_items_stale', { offerId: official, productId, variantId: newId(), ownerType: 'official', sellerId: null, title: 'Aurora Desk Lamp', staleItems: [], newBoxItems: ['Travel case'] });
    expect((await inbox(as.staff(catalogLead), 'admin', '?view=needs_my_action')).map((n) => n.topicKey)).toEqual(['staff.offer.missing_items_review']);
    await publish(app, 'offers.offer.missing_items_reviewed', { offerId: official, productId, ownerType: 'official', sellerId: null, missingItems: [], changed: false, reviewedBy: { kind: 'staff', id: catalogLead.accountId } });
    expect(await inbox(as.staff(catalogLead), 'admin', '?view=needs_my_action')).toHaveLength(0);
  });

  it('the day-end summary resolves the day-end reminders and lists the notes', async () => {
    const lead = world.staff();
    world.role('shipping_manager', { leadAccountId: lead.accountId, accountIds: [lead.accountId] });
    const reviewId = newId();
    await publish(app, 'workqueues.day_end.prepared', { reviewId, date: '2026-10-10', dueAt: inDays(0.25), openItems: 4, overdueItems: 1, roleKeys: ['shipping_manager'] });
    expect((await inbox(as.staff(lead), 'admin', '?view=needs_my_action')).map((n) => n.topicKey)).toEqual(['staff.day_end.summary']);
    await publish(app, 'workqueues.day_end.completed', {
      reviewId,
      date: '2026-10-10',
      completedBy: { kind: 'staff', id: lead.accountId, name: 'Morgan Hale' },
      completedAt: new Date().toISOString(),
      openItems: 3,
      overdueItems: 0,
      note: 'Carrier pickup moved to 6 PM.',
      items: [{ key: 'dispatch', title: 'Overdue dispatch', summary: '0 overdue', note: 'All shipped' }],
      roleKeys: ['shipping_manager'],
    });
    expect(await inbox(as.staff(lead), 'admin', '?view=needs_my_action')).toHaveLength(0);
    const all = await inbox(as.staff(lead), 'admin');
    expect(all.map((n) => [n.topicKey, n.state])).toEqual([
      ['staff.day_end.completed', null],
      ['staff.day_end.summary', 'resolved'],
    ]);
    expect(all[0].body).toContain('Morgan Hale completed the day-end review');
    expect(all[0].body).toContain('Carrier pickup moved to 6 PM.; Overdue dispatch: All shipped');
  });
});

describe('Notice.state', () => {
  it('purge expires old unresolved action notices: shown as expired, never as resolved', async () => {
    const c = world.customer();
    const res = await service.notify({ topic: 'customer.return.info_requested', recipients: [{ kind: 'customer', customerId: c.customerId }], link: { kind: 'return', id: newId(), screen: 'account/return' }, actionRequired: true, deadline: new Date(Date.now() - 40 * 86_400_000).toISOString(), dedupeKey: `return:${newId()}:info` });
    expect(res.noticeIds).toHaveLength(1);
    let [n] = await inbox(as.customer(c), 'store');
    expect(n).toMatchObject({ actionRequired: true, state: 'open', resolvedAt: null, expiredAt: null });
    await app.kernel.jobs.runNow('notifications.purge');
    [n] = await inbox(as.customer(c), 'store');
    expect(n).toMatchObject({ state: 'expired', resolvedAt: null });
    expect(n.expiredAt).toBeTruthy();
    // no longer counted as needing action
    const summary = await app.inject({ method: 'GET', url: '/api/store/notifications/inbox/summary', headers: as.customer(c) });
    expect(summary.json()).toMatchObject({ actionRequired: 0, needsAction: [] });
    // information notices have no state
    await service.notify({ topic: 'customer.case.resolved', recipients: [{ kind: 'customer', customerId: c.customerId }], link: { kind: 'case', id: newId(), screen: 'help/case' } });
    expect((await inbox(as.customer(c), 'store'))[0]).toMatchObject({ topicKey: 'customer.case.resolved', state: null });
  });
});

describe('Recipient.customerId', () => {
  it('addresses a customer by the customers-module id (account and email resolved through customers)', async () => {
    const c = world.customer();
    const res = await service.notify({ topic: 'customer.case.resolved', recipients: [{ kind: 'customer', customerId: c.customerId }], link: { kind: 'case', id: newId(), screen: 'help/case' }, context: { case: { ref: 'CS-261010-0500' } } });
    expect(res.noticeIds).toHaveLength(1);
    expect((await inbox(as.customer(c), 'store')).map((n) => n.topicKey)).toEqual(['customer.case.resolved']);
    expect(emailsTo(c.email)).toHaveLength(1);
    await expect(service.notify({ topic: 'customer.case.resolved', recipients: [{ kind: 'customer' }], link: { kind: 'case', id: newId(), screen: 'help/case' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await service.canSendPromotional({ kind: 'customer', customerId: c.customerId }, 'email')).toBe(false); // no consent
  });
});

describe('external audience in the admin views', () => {
  it('lists external topics, templates and deliveries as external', async () => {
    const matrix = await getJson('/api/admin/notifications/topics');
    expect(matrix.external.map((t: any) => t.key)).toEqual(expect.arrayContaining(['supplier.purchase_order.sent', 'rights_owner.report.received']));
    expect(matrix.staff.map((t: any) => t.key)).not.toContain('supplier.purchase_order.sent');
    const templates = await getJson('/api/admin/notifications/templates?audience=external&limit=50');
    expect(templates.items.length).toBeGreaterThan(0);
    expect(templates.items.every((t: any) => t.audience === 'external')).toBe(true);
    const to = addr('rights');
    await publish(app, 'trust.rights_report.received', { reportId: newId(), ref: 'TR-261010-0400', brandName: 'Northwind Audio', contactName: 'Dana Whitfield', contactEmail: to });
    const log = await getJson(`/api/admin/notifications/deliveries?address=${encodeURIComponent(to)}`);
    expect(log.items).toMatchObject([{ recipientKind: 'external_email' }]);
  });
});

describe('inbound email attachments', () => {
  it('stores attachments through media.storeInboundFile and names refused files in an automatic answer', async () => {
    const seen = capture(app, 'notifications.email_reply.received');
    const from = addr('replier');
    const conversationId = newId();
    const token = service.core.replyToken('messaging', conversationId, from);
    const domain = String(await service.core.setting('replyDomain'));
    stored.length = 0;
    await service.webhooks.inbound({
      providerEventId: `evt-${newId()}`,
      to: `reply+${token}@${domain}`,
      from,
      subject: 'Re: your message',
      text: 'Here is the photo.\n\nOn Oct 9 Marketly wrote:\n> old text',
      attachments: [
        { fileName: 'lamp.jpg', contentType: 'image/jpeg', sizeBytes: 4, downloadUrl: `data:image/jpeg;base64,${Buffer.from([1, 2, 3, 4]).toString('base64')}` },
        { fileName: 'invoice.exe', contentType: 'application/octet-stream', sizeBytes: 10, downloadUrl: 'https://provider.example/att/2' },
      ],
      receivedAt: new Date().toISOString(),
    });
    await app.kernel.events.drain();
    expect(stored).toEqual([{ fileName: 'lamp.jpg', purpose: 'message_attachment', owner: { kind: 'guest', id: null }, bytes: 4 }]);
    const reply = seen.find((e) => e.payload.refId === conversationId)!.payload;
    expect(reply).toMatchObject({ module: 'messaging', text: 'Here is the photo.' });
    expect(reply.attachmentAssetIds).toHaveLength(1);
    const answer = emailsTo(from);
    expect(answer.map((m) => m.message.subject)).toEqual(['Some files in your reply were not attached']);
    expect(answer[0]!.message.text).toContain('invoice.exe (this file type is not accepted)');
  });
});

describe('staff digest', () => {
  it('waits on closed days and covers them on the next open day', async () => {
    const person = world.staff();
    await app.inject({ method: 'PUT', url: '/api/admin/notifications/my-preferences', headers: as.staff(person), payload: { emailByArea: { Finance: true }, emailForMentions: true, dailyDigest: true } });
    world.role('finance_manager', { leadAccountId: person.accountId, accountIds: [person.accountId] });
    await publish(app, 'finance.reconciliation.mismatch_found', { itemId: newId(), check: 'card_deposits', difference: money(1240) });
    const tz = service.core.timeZone;
    const { dateInZone } = await import('../../../kernel/lib/clock.js');
    calendar.closed.add(dateInZone(new Date(), tz));
    await app.kernel.jobs.runNow('notifications.staff-digest');
    expect(emailsTo(person.email)).toHaveLength(0);
    calendar.closed.clear();
    await app.kernel.jobs.runNow('notifications.staff-digest');
    expect(emailsTo(person.email).map((m) => m.message.subject)).toEqual(['Your Marketly daily summary (1)']);
  });
});
