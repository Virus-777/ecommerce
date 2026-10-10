import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, bootWorld, capture, emailsTo, money, newId, publish, type World } from './harness.js';
import type { NotificationsService } from '../service.js';
import { ROUTES } from '../domain/routing.js';
import { spec } from '../../../spec/notifications.js';
import { TOPICS, topicDef } from '../domain/catalog.js';
import { validateContent } from '../domain/templates.js';
import { defaultContent, templateChannels } from '../domain/catalog.js';

let app: FastifyInstance;
let world: World;
let service: NotificationsService;

beforeAll(async () => {
  ({ app, world, service } = await bootWorld());
});
afterAll(async () => {
  await app?.close();
});

const inbox = async (headers: Record<string, string>, area: 'store' | 'seller' | 'admin', query = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/${area}/notifications/inbox${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as any[];
};

function orderAccepted(o: { orderId?: string; customerId?: string | null; email: string; sellerId?: string; ref?: string }) {
  const orderId = o.orderId ?? newId();
  const groupId = newId();
  return {
    payload: {
      orderId,
      ref: o.ref ?? `MK-261009-${Math.floor(Math.random() * 90000 + 10000)}`,
      customerId: o.customerId ?? null,
      contactEmail: o.email,
      total: money(18900),
      groups: o.sellerId
        ? [{ groupId, ownerType: 'seller', sellerId: o.sellerId, fulfilledBy: 'seller', dispatchBy: new Date(Date.now() + 86_400_000).toISOString(), itemIds: [newId()], total: money(18900) }]
        : [{ groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', dispatchBy: new Date(Date.now() + 86_400_000).toISOString(), itemIds: [newId()], total: money(18900) }],
      items: [], acceptedAt: new Date().toISOString(),
    },
    orderId,
    groupId,
  };
}

describe('catalogue', () => {
  it('routes every consumed event and seeds valid default templates', () => {
    expect(Object.keys(ROUTES).sort()).toEqual(Object.keys(spec.events.consumes).sort());
    expect(Object.keys(spec.events.consumes)).toHaveLength(107);
    for (const t of TOPICS) {
      for (const channel of templateChannels(t)) {
        const v = validateContent(t, channel, defaultContent(t, channel, {}));
        expect(v.ok, `${t.key} ${channel}: ${JSON.stringify(v.issues)}`).toBe(true);
      }
    }
    // every topic the routing table names exists
    const named = JSON.stringify(Object.values(ROUTES).map((r) => String((r as { sends?: unknown }).sends ?? '')));
    // the compiled source may quote with ' or " (escaped in the JSON)
    const keys = [...named.matchAll(/(?:'|\\")((?:customer|seller|staff|supplier|rights_owner|trust)\.[a-z_.]+)(?:'|\\")/g)].map((m) => m[1]!);
    for (const k of [
      'supplier.purchase_order.sent',
      'rights_owner.report.received',
      'trust.report.resolved',
      'staff.day_end.summary',
      'staff.day_end.completed',
      'staff.official_store.message_received',
      'customer.trust.evidence_requested',
      'seller.trust.evidence_requested',
      'customer.trust.appeal_decided',
      'seller.trust.appeal_decided',
      'customer.refund.destination_needed',
      'customer.account.closure_delayed',
      'staff.inventory.low_stock_digest',
      'seller.stock.low_digest',
      'seller.application.information_reminder',
      'seller.offer.missing_items_review',
      'staff.offer.missing_items_review',
    ])
      expect(keys).toContain(k);
    for (const k of keys) expect(topicDef(k), k).toBeDefined();
    // external topics: essential, email only, no inbox
    for (const t of TOPICS.filter((x) => x.audience === 'external')) {
      expect(t.category, t.key).toBe('essential');
      expect(t.supports, t.key).toEqual(['email']);
    }
  });
});

describe('order notices', () => {
  it('tells the customer and the seller workspace about an accepted order, and correlates the dispatch', async () => {
    const c = world.customer();
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true, role: 'Owner' });
    const packer = world.member(sellerId, { permissions: ['orders.fulfillment.view'] });
    const writer = world.member(sellerId, { permissions: ['catalog.products.submit'] });
    // members become known to notifications on their first visit (for email fan-out)
    await inbox(as.seller(owner), 'seller');
    await inbox(as.seller(packer), 'seller');

    const { payload, orderId, groupId } = orderAccepted({ customerId: c.customerId, email: c.email, sellerId });
    await publish(app, 'orders.order.accepted', payload);

    const mine = await inbox(as.customer(c), 'store');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ topicKey: 'customer.order.accepted', category: 'essential', group: 'orders', link: { kind: 'order', id: orderId, ref: payload.ref, screen: 'account/order' }, readAt: null });
    expect(mine[0].title).toContain(payload.ref);
    const mail = emailsTo(c.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.message.subject).toBe(`Your order ${payload.ref} is confirmed`);
    expect(mail[0]!.message.from).toContain('orders@marketly.example');

    expect((await inbox(as.seller(owner), 'seller')).map((n) => n.topicKey)).toEqual(['seller.order.new']);
    expect((await inbox(as.seller(packer), 'seller')).map((n) => n.topicKey)).toEqual(['seller.order.new']);
    expect(await inbox(as.seller(writer), 'seller')).toHaveLength(0); // no order permission
    expect(emailsTo(owner.email)).toHaveLength(1); // essential: the owner always gets email
    expect(emailsTo(packer.email)).toHaveLength(0); // members default to in-app only
    // the seller dispatch reminder is scheduled sellerDispatchReminderHours (4 h) before the deadline
    expect(await service.core.repo.hasPendingScheduled(`seller.dispatch.reminder:${groupId}`)).toBe(true);

    // dispatch: event without customer id → found from the order notice; overdue notice resolved
    await publish(app, 'shipping.dispatch.overdue', { orderId, orderRef: payload.ref, groupId, ownerType: 'seller', sellerId, fulfilledBy: 'seller', orderItemIds: [newId()], dueAt: new Date(Date.now() - 3_600_000).toISOString(), exceptionId: newId() });
    let sellerNotices = await inbox(as.seller(owner), 'seller', '?actionRequired=true');
    expect(sellerNotices.map((n) => n.topicKey)).toEqual(['seller.dispatch.overdue']);
    expect(sellerNotices[0].deadline.state).toBe('overdue');

    await publish(app, 'shipping.shipment.dispatched', {
      shipmentId: newId(),
      kind: 'outbound',
      orderId,
      groupId,
      returnId: null,
      ownerType: 'seller',
      sellerId,
      fulfilledBy: 'seller',
      lines: [{ orderItemId: newId(), title: 'Aurora Desk Lamp', variantLabel: 'Black', quantity: 1 }],
      shippedAt: new Date().toISOString(),
      dispatchDueAt: null,
      onTime: false,
      trackingValid: true,
      estimatedArrival: { from: '2026-10-11', to: '2026-10-13' },
    });
    const after = await inbox(as.customer(c), 'store');
    expect(after.map((n) => n.topicKey)).toEqual(['customer.shipment.dispatched', 'customer.order.accepted']);
    expect(after[0].body).toContain('Aurora Desk Lamp (Black) × 1');
    sellerNotices = await inbox(as.seller(owner), 'seller', '?actionRequired=true');
    expect(sellerNotices).toHaveLength(0);
    expect(await service.core.repo.hasPendingScheduled(`seller.dispatch.reminder:${groupId}`)).toBe(false);
    const all = await inbox(as.seller(owner), 'seller');
    expect(all.find((n) => n.topicKey === 'seller.dispatch.overdue').resolvedAt).toBeTruthy();
  });

  it('emails guests with the order link minted by identity, and never creates a guest inbox', async () => {
    const email = `guest-${newId().slice(0, 8)}@example.com`;
    const { payload, orderId } = orderAccepted({ email });
    await publish(app, 'orders.order.accepted', payload);
    const mail = emailsTo(email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.message.text).toContain(`https://marketly.example/orders/link/${orderId}-token`);
    const res = await app.inject({ method: 'GET', url: `/api/admin/notifications/deliveries?topicKey=customer.order.accepted&address=${encodeURIComponent(email)}`, headers: as.staff(world.staff()) });
    expect(res.json().items).toMatchObject([{ recipientKind: 'guest_email', status: 'delivered', addressMasked: `${email[0]}***@example.com` }]);
  });

  it('is idempotent: the same event twice gives one notice', async () => {
    const c = world.customer();
    const { payload } = orderAccepted({ customerId: c.customerId, email: c.email });
    await publish(app, 'orders.order.accepted', payload);
    await publish(app, 'orders.order.accepted', payload);
    expect(await inbox(as.customer(c), 'store')).toHaveLength(1);
    expect(emailsTo(c.email)).toHaveLength(1);
    const res = await app.inject({ method: 'GET', url: `/api/admin/notifications/deliveries?accountId=${c.accountId}`, headers: as.staff(world.staff()) });
    expect(res.json().items.map((d: any) => d.status).sort()).toEqual(['delivered', 'skipped']);
    expect(res.json().items.find((d: any) => d.status === 'skipped').skipReason).toBe('duplicate');
  });

  it('combines payment captured with a just-sent order acceptance', async () => {
    const c = world.customer();
    const { payload, orderId } = orderAccepted({ customerId: c.customerId, email: c.email });
    await publish(app, 'orders.order.accepted', payload);
    await publish(app, 'payments.payment.captured', { intentId: newId(), captureId: newId(), orderId, groupId: null, amount: money(18900), allocations: [], providerRef: null, capturedAt: new Date().toISOString() });
    expect((await inbox(as.customer(c), 'store')).map((n) => n.topicKey)).toEqual(['customer.order.accepted']);
  });

  it('keeps inboxes apart: another customer cannot read or mark my notice (404)', async () => {
    const a = world.customer();
    const b = world.customer();
    const { payload } = orderAccepted({ customerId: a.customerId, email: a.email });
    await publish(app, 'orders.order.accepted', payload);
    const [n] = await inbox(as.customer(a), 'store');
    const other = await app.inject({ method: 'POST', url: `/api/store/notifications/inbox/${n.id}/read`, headers: as.customer(b) });
    expect(other.statusCode).toBe(404);
    const mine = await app.inject({ method: 'POST', url: `/api/store/notifications/inbox/${n.id}/read`, headers: as.customer(a) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().readAt).toBeTruthy();
    const summary = await app.inject({ method: 'GET', url: '/api/store/notifications/inbox/summary', headers: as.customer(a) });
    expect(summary.json()).toMatchObject({ unread: 0, total: 1, totalByGroup: { orders: 1 } });
  });

  it('falls back to earlier notices when an event names no customer (returns and cases)', async () => {
    const c = world.customer();
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true });
    const { payload, orderId } = orderAccepted({ customerId: c.customerId, email: c.email, sellerId });
    await publish(app, 'orders.order.accepted', payload);
    const returnId = newId();
    await publish(app, 'returns.return.requested', { returnId, ref: 'RT-261009-0001', orderId, orderRef: payload.ref, ownerType: 'seller', sellerId, fulfilledBy: 'seller', orderItemIds: [newId()], reason: 'arrived_damaged', responseDueAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    await publish(app, 'returns.return.info_requested', { returnId, ref: 'RT-261009-0001', orderId, orderRef: payload.ref, replyDueAt: new Date(Date.now() + 86_400_000).toISOString() });
    await publish(app, 'returns.return.approved', { returnId, ref: 'RT-261009-0001', orderId, orderRef: payload.ref, ownerType: 'seller', sellerId, fulfilledBy: 'seller', items: [{ orderItemId: newId(), quantity: 1 }], withoutReturn: false, platformDecision: false, dropOffBy: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    const notices = await inbox(as.customer(c), 'store', '?group=returns_refunds');
    expect(notices.map((n) => n.topicKey)).toEqual(['customer.return.approved', 'customer.return.info_requested']);
    expect(notices[1].actionRequired).toBe(true);
    const sellerSide = await inbox(as.seller(owner), 'seller', '?group=returns_cases');
    expect(sellerSide[0]).toMatchObject({ topicKey: 'seller.return.requested', actionRequired: true });
    expect(sellerSide[0].resolvedAt).toBeTruthy(); // approved resolves "respond by"

    // label → drop-off reminder scheduled (1 day before drop-off), cancelled when received
    await publish(app, 'returns.label.created', { returnId, ref: 'RT-261009-0001', orderRef: payload.ref, ownerType: 'seller', sellerId, labelId: newId(), orderId, cost: money(599), paidBy: 'seller' });
    const scheduled = await service.core.repo.dueScheduled(new Date(Date.now() + 30 * 86_400_000), 100);
    expect(scheduled.filter((s) => s.dedupe_key === `return-dropoff:${returnId}`)).toHaveLength(1);
    await publish(app, 'returns.return.received', { returnId, ref: 'RT-261009-0001', orderId, orderRef: payload.ref, ownerType: 'seller', sellerId, fulfilledBy: 'seller', items: [], receivedAt: new Date().toISOString() });
    const left = await service.core.repo.dueScheduled(new Date(Date.now() + 30 * 86_400_000), 100);
    expect(left.filter((s) => s.dedupe_key === `return-dropoff:${returnId}`)).toHaveLength(0);

    // case reply carries a reply-to address
    const caseId = newId();
    await publish(app, 'support.case.opened', { caseId, ref: 'CS-261009-0001', kind: 'order_problem', category: 'damaged', priority: 'medium', customerId: c.customerId, sellerId, orderId, orderItemIds: [], handler: 'seller', nextResponseDueAt: new Date(Date.now() + 86_400_000).toISOString() });
    await publish(app, 'support.case.message_added', { caseId, messageId: newId(), audience: 'all', authorRole: 'seller' });
    const caseMail = emailsTo(c.email).filter((e) => e.message.subject.includes('New reply'));
    expect(caseMail).toHaveLength(1);
    expect(caseMail[0]!.message.replyTo).toMatch(/^reply\+s[0-9a-f]{32}[0-9a-z]+\.[A-Za-z0-9]{16}@reply\.marketly\.example$/);
    await publish(app, 'support.case.decided', { caseId, ref: 'CS-261009-0001', outcome: 'refund_full', orderId, returnId: null, sellerId, remedies: [], appealDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(), final: false, notified: true });
    const sellerCase = (await inbox(as.seller(owner), 'seller')).find((n) => n.topicKey === 'seller.case.opened');
    expect(sellerCase.resolvedAt).toBeTruthy();
  });
});

describe('staff routing', () => {
  it('routes role notices to the covering backup (the away lead keeps a copy) and resolves them', async () => {
    const lead = world.staff({ name: 'Theo Grant' });
    const backup = world.staff({ name: 'Ana Silva' });
    world.role('shipping_manager', { leadAccountId: lead.accountId, accountIds: [backup.accountId], ccAccountIds: [lead.accountId], viaBackup: true });
    const groupId = newId();
    const orderId = newId();
    await publish(app, 'shipping.dispatch.overdue', { orderId, orderRef: 'MK-261009-77777', groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', orderItemIds: [], dueAt: new Date(Date.now() - 60_000).toISOString(), exceptionId: newId() });
    const mine = await inbox(as.staff(backup), 'admin');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ topicKey: 'staff.shipping.dispatch_overdue', group: 'Shipping', actionRequired: true, routedTo: { roleKey: 'shipping_manager', roleName: 'Shipping Manager', reason: 'backup', coveringFor: 'Theo Grant' } });
    expect(mine[0].routedTo.recipients).toEqual(expect.arrayContaining([{ staffId: backup.accountId, name: 'Ana Silva', as: 'backup' }, { staffId: lead.accountId, name: 'Theo Grant', as: 'lead' }]));
    expect(await inbox(as.staff(lead), 'admin')).toHaveLength(1);
    expect(emailsTo(backup.email)).toHaveLength(1); // urgent topic: emailed
    expect(emailsTo(lead.email)).toHaveLength(0); // away: sees it on return

    let summary = await app.inject({ method: 'GET', url: '/api/admin/notifications/inbox/summary', headers: as.staff(backup) });
    expect(summary.json()).toMatchObject({ unread: 1, byArea: { Shipping: 1 }, needsMyAction: 1, mentions: 0 });

    // a new receiver takes over: open notices re-routed
    const third = world.staff();
    await publish(app, 'access.coverage.changed', { roleId: newId(), roleKey: 'shipping_manager', leadAccountId: lead.accountId, receivingAccountIds: [third.accountId], viaBackup: true });
    expect(await inbox(as.staff(third), 'admin')).toHaveLength(1);

    await service.resolve(`dispatch:${groupId}`, 'dispatched');
    summary = await app.inject({ method: 'GET', url: '/api/admin/notifications/inbox/summary', headers: as.staff(backup) });
    expect(summary.json().needsMyAction).toBe(0);
    const marked = await app.inject({ method: 'POST', url: '/api/admin/notifications/inbox/read-all', headers: as.staff(backup), payload: {} });
    expect(marked.json()).toEqual({ updated: 1 });
  });

  it('sends approvals to the approvers, reminds before the due date and resolves on decision', async () => {
    const requester = world.staff({ name: 'Priya Nair' });
    const approver = world.staff({ name: 'Morgan Hale' });
    const requestId = newId();
    const due = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const target = { type: 'payout_run', id: newId(), ref: 'PO-RUN-261009', label: 'Payout run' };
    await publish(app, 'access.approval.requested', { requestId, ref: 'AP-1', actionKey: 'finance.payouts.release', module: 'finance', target, amount: money(4821000), summary: 'Release payout run', requestedBy: { kind: 'staff', id: requester.accountId, name: 'Priya Nair' }, eligibleRoleKeys: ['business_owner'], eligibleAccountIds: [approver.accountId], nominatedReviewerId: null, dueAt: due });
    const [n] = await inbox(as.staff(approver), 'admin', '?view=needs_my_action');
    expect(n).toMatchObject({ topicKey: 'staff.approval.waiting', group: 'Approvals', actionRequired: true, routedTo: null });
    expect(n.body).toContain('Priya Nair');
    let pending = (await service.core.repo.dueScheduled(new Date(Date.now() + 2 * 86_400_000), 200)).filter((s) => s.dedupe_key === `approval:${requestId}`);
    expect(pending).toHaveLength(1);

    await publish(app, 'access.approval.decided', { requestId, ref: 'AP-1', actionKey: 'finance.payouts.release', module: 'finance', target, outcome: 'approved', decidedBy: { kind: 'staff', id: approver.accountId }, reason: null, amount: money(4821000), approverIds: [approver.accountId], requestedById: requester.accountId });
    expect(await inbox(as.staff(approver), 'admin', '?view=needs_my_action')).toHaveLength(0);
    expect((await inbox(as.staff(requester), 'admin')).map((x) => x.topicKey)).toEqual(['staff.approval.decided']);
    pending = (await service.core.repo.dueScheduled(new Date(Date.now() + 2 * 86_400_000), 200)).filter((s) => s.dedupe_key === `approval:${requestId}`);
    expect(pending).toHaveLength(0);
  });

  it('delivers overdue work items to lead and backup and resolves them with the item', async () => {
    const lead = world.staff();
    const backup = world.staff();
    const itemId = newId();
    await publish(app, 'workqueues.item.overdue', { itemId, queueKey: 'overdue_dispatch', kind: 'late_dispatch', subjectRef: 'MK-260914-48213', dueAt: new Date(Date.now() - 1000).toISOString(), leadId: lead.accountId, backupId: backup.accountId, assigneeId: null, sellerId: null });
    const [n] = await inbox(as.staff(backup), 'admin', '?area=Shipping');
    expect(n).toMatchObject({ topicKey: 'staff.queue.item_overdue', group: 'Shipping', link: { ref: 'MK-260914-48213' } });
    await publish(app, 'workqueues.item.resolved', { itemId, queueKey: 'overdue_dispatch', outcome: 'dispatched' });
    expect(await inbox(as.staff(lead), 'admin', '?view=needs_my_action')).toHaveLength(0);
  });

  it('notifies seller owners of account-health changes but not other members', async () => {
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true });
    const staffer = world.member(sellerId, { permissions: ['orders.fulfillment.view', 'sellers.account.manage'] });
    await inbox(as.seller(owner), 'seller');
    await publish(app, 'sellers.seller.restricted', {
      sellerId,
      restrictionId: newId(),
      reasonCode: 'late_dispatch',
      reason: 'Late dispatch 11% over 30 days',
      affectedActivities: ['new_offers'],
      scope: { categoryIds: [], conditions: [], offerIds: [] },
      categoryIds: [],
      appealRoute: 'Seller Center → Account health',
      appealDeadline: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      reviewDate: '2026-11-01',
      trustReportId: null,
      trustEnforcementId: null,
    });
    const ownerNotices = await inbox(as.seller(owner), 'seller', '?group=account_finance');
    expect(ownerNotices.map((n) => n.topicKey)).toEqual(['seller.account.restricted']);
    expect(ownerNotices[0].body).toContain('new offers');
    expect(await inbox(as.seller(staffer), 'seller')).toHaveLength(0);
    expect(emailsTo(owner.email).length).toBeGreaterThan(0);
  });
});

describe('graphql', () => {
  it('reads the caller inbox, badge and summary', async () => {
    const c = world.customer();
    const { payload } = orderAccepted({ customerId: c.customerId, email: c.email });
    await publish(app, 'orders.order.accepted', payload);
    const res = await app.inject({
      method: 'POST',
      url: '/graphql/store',
      headers: as.customer(c),
      payload: { query: '{ unreadNotificationCount notifications(filter: { category: ESSENTIAL }) { total items { topicKey category tone read link { kind screen } } } notificationInbox { unread byGroup { group unread total } actionRequired } }' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(res.json().errors).toBeUndefined();
    expect(data.unreadNotificationCount).toBe(1);
    expect(data.notifications.items[0]).toMatchObject({ topicKey: 'customer.order.accepted', category: 'ESSENTIAL', tone: 'SUCCESS', read: false, link: { kind: 'order', screen: 'account/order' } });
    expect(data.notificationInbox).toMatchObject({ unread: 1, byGroup: [{ group: 'orders', unread: 1, total: 1 }], actionRequired: 0 });
  });

  it('gives visitors an empty inbox', async () => {
    const { auth, callers } = await import('../../../testing/app.js');
    const res = await app.inject({ method: 'POST', url: '/graphql/store', headers: auth(callers.visitor()), payload: { query: '{ unreadNotificationCount }' } });
    expect(res.json().data.unreadNotificationCount).toBe(0);
  });
});

describe('events published', () => {
  it('publishes delivery.failed when an address cannot be reached', async () => {
    const seen = capture(app, 'notifications.delivery.failed');
    const c = world.customer({ email: `nobody-${newId().slice(0, 6)}@reject.test` });
    const { payload } = orderAccepted({ customerId: c.customerId, email: c.email });
    await publish(app, 'orders.order.accepted', payload);
    await app.kernel.events.drain();
    expect(seen.find((e) => e.payload.accountId === c.accountId)).toMatchObject({ payload: { topicKey: 'customer.order.accepted', channel: 'email', recipientKind: 'customer' } });
  });
});
