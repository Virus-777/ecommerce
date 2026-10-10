/**
 * Recipients named by the events (spec correctness pass): customerId / contactEmail on customer-facing
 * events, sellerId on case messages, seller members from sellers.listMembers / ownerOf, the invitation
 * to apply (code emailed, never stored) and idempotent consumers (ctx.inbox).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationsService } from '../service.js';
import { as, bootWorld, emailsTo, money, newId, publish, type World } from './harness.js';

let app: FastifyInstance;
let world: World;
let service: NotificationsService;

beforeAll(async () => {
  ({ app, world, service } = await bootWorld());
});
afterAll(async () => {
  await app?.close();
});

const admin = () => as.staff(world.staff());
const inbox = async (headers: Record<string, string>, area: 'store' | 'seller', query = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/${area}/notifications/inbox${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as any[];
};
const deliveriesTo = async (address: string) => (await app.inject({ method: 'GET', url: `/api/admin/notifications/deliveries?address=${encodeURIComponent(address)}`, headers: admin() })).json().items as any[];
const guestEmail = () => `guest-${newId().slice(-12)}@example.com`;

function cancelled(o: { orderId?: string; customerId?: string | null; contactEmail?: string | null; ref?: string; notifyCustomer?: boolean; ownerType?: 'official' | 'seller'; sellerId?: string | null; initiatedBy?: string }) {
  return {
    orderId: o.orderId ?? newId(),
    ref: o.ref ?? 'MK-261010-40001',
    customerId: o.customerId ?? null,
    contactEmail: o.contactEmail ?? null,
    groupId: newId(),
    ownerType: o.ownerType ?? 'official',
    sellerId: o.sellerId ?? null,
    fulfilledBy: o.ownerType === 'seller' ? 'seller' : 'official_warehouse',
    itemId: newId(),
    offerId: newId(),
    stockItemId: newId(),
    quantity: 1,
    cancellationId: newId(),
    initiatedBy: o.initiatedBy ?? 'customer',
    reasonCode: 'changed_mind',
    beforeDispatch: true,
    countsAgainstSeller: false,
    refund: { itemAmount: money(4900), discountShare: money(0), shippingRefund: money(0), taxRefund: money(0), total: money(4900) },
    paymentIntentId: newId(),
    notifyCustomer: o.notifyCustomer ?? true,
  };
}

describe('customers named by the event', () => {
  it('emails a guest order update to the contact address, with the order link, and keeps no inbox', async () => {
    const email = guestEmail();
    const p = cancelled({ contactEmail: email, ref: 'MK-261010-40002' });
    await publish(app, 'orders.item.cancelled', p);
    const [mail] = emailsTo(email);
    expect(mail!.message.subject).toBe('An item in MK-261010-40002 was cancelled');
    expect(mail!.message.text).toContain(`https://marketly.example/orders/link/${p.orderId}-token`);
    expect(await deliveriesTo(email)).toMatchObject([{ topicKey: 'customer.order.item_cancelled', recipientKind: 'guest_email', status: 'delivered' }]);

    // events without the order reference take it from the guest's order confirmation
    await publish(app, 'orders.order.accepted', {
      orderId: p.orderId,
      ref: 'MK-261010-40002',
      customerId: null,
      contactEmail: email,
      total: money(4900),
      groups: [{ groupId: p.groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', dispatchBy: new Date(Date.now() + 86_400_000).toISOString(), itemIds: [newId()], total: money(4900) }],
      items: [], acceptedAt: new Date().toISOString(),
    });
    // shipping and payments name the guest the same way (no earlier notice is needed)
    await publish(app, 'shipping.shipment.delivered', {
      shipmentId: newId(),
      kind: 'outbound',
      orderId: p.orderId,
      customerId: null,
      contactEmail: email,
      groupId: newId(),
      returnId: null,
      sellerId: null,
      fulfilledBy: 'official_warehouse',
      lines: [{ orderItemId: newId(), title: 'Aurora Desk Lamp', variantLabel: "Black", quantity: 1 }],
      deliveredAt: new Date().toISOString(),
    });
    expect(emailsTo(email).map((m) => m.message.subject)).toContain('Your package from MK-261010-40002 was delivered');
  });

  it('finds the customer of an Official Store return from the event (no earlier notice about it)', async () => {
    const c = world.customer();
    const returnId = newId();
    const orderId = newId();
    await publish(app, 'returns.return.approved', {
      returnId,
      ref: 'RT-261010-0042',
      orderRef: 'MK-261010-40042',
      orderId,
      customerId: c.customerId,
      contactEmail: null,
      ownerType: 'official',
      sellerId: null,
      fulfilledBy: 'official_warehouse',
      items: [{ orderItemId: newId(), quantity: 1 }],
      withoutReturn: false,
      platformDecision: false,
      dropOffBy: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      trackingNumber: null,
    });
    await publish(app, 'returns.return.received', { returnId, ref: 'RT-261010-0042', orderId, orderRef: 'MK-261010-40042', customerId: c.customerId, contactEmail: null, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', items: [], receivedAt: new Date().toISOString() });
    const mine = await inbox(as.customer(c), 'store', '?group=returns_refunds');
    expect(mine.map((n) => n.topicKey)).toEqual(['customer.return.received', 'customer.return.approved']);
    expect(mine[1]).toMatchObject({ link: { kind: 'return', id: returnId, ref: 'RT-261010-0042' } });
    expect(emailsTo(c.email).map((m) => m.message.subject)).toContain('Your return RT-261010-0042 was approved');

    // another customer's inbox stays empty
    expect(await inbox(as.customer(world.customer()), 'store')).toHaveLength(0);
  });

  it('opens a guest case by email and routes case replies to the seller named on the event', async () => {
    const email = guestEmail();
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true });
    const caseId = newId();
    await publish(app, 'support.case.opened', { caseId, ref: 'CS-261010-0007', kind: 'order_problem', category: 'damaged', priority: 'medium', customerId: null, contactEmail: email, sellerId, orderId: newId(), orderItemIds: [], handler: 'marketplace_support', nextResponseDueAt: null });
    expect(emailsTo(email).map((m) => m.message.subject)).toEqual(['We received your request CS-261010-0007']);

    const messageId = newId();
    await publish(app, 'support.case.message_added', { caseId, messageId, customerId: null, contactEmail: email, sellerId, audience: 'all', authorRole: 'staff' });
    expect(emailsTo(email).filter((m) => m.message.subject.includes('New reply'))).toHaveLength(1);
    const sellerSide = await inbox(as.seller(owner), 'seller', '?group=returns_cases');
    expect(sellerSide.map((n) => n.topicKey).sort()).toEqual(['seller.case.opened', 'seller.case.reply']);
  });
});

describe('seller members from sellers', () => {
  it('emails essential notices to an owner who never opened Seller Center; other members stay in-app', async () => {
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true, role: 'owner' });
    const packer = world.member(sellerId, { permissions: ['orders.fulfillment.view'], role: 'shipping' });
    await publish(app, 'sellers.seller.suspended', {
      sellerId,
      suspensionId: newId(),
      reasonCode: 'fraud_review',
      reason: 'Unusual order pattern under review',
      reviewDate: '2026-11-01',
      openOrders: 'seller_keeps_fulfilling',
      appealDeadline: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      trustReportId: null,
    });
    expect(emailsTo(owner.email).map((m) => m.message.subject)).toEqual(['Your Marketly seller account is suspended']);
    expect(emailsTo(packer.email)).toHaveLength(0); // owner-only topic

    // a new order: the owner is emailed (essential), the packer sees it in Seller Center only
    const orderId = newId();
    const groupId = newId();
    await publish(app, 'orders.order.accepted', {
      orderId,
      ref: 'MK-261010-40077',
      customerId: null,
      contactEmail: guestEmail(),
      total: money(18900),
      groups: [{ groupId, ownerType: 'seller', sellerId, fulfilledBy: 'seller', dispatchBy: new Date(Date.now() + 86_400_000).toISOString(), itemIds: [newId()], total: money(18900) }],
      items: [], acceptedAt: new Date().toISOString(),
    });
    expect(emailsTo(owner.email).map((m) => m.message.subject)).toContain('New order MK-261010-40077');
    expect(emailsTo(packer.email)).toHaveLength(0);
    expect((await inbox(as.seller(packer), 'seller')).map((n) => n.topicKey)).toEqual(['seller.order.new']);

    // the team preferences list the members who never visited, with their defaults
    const prefs = await app.inject({ method: 'GET', url: '/api/seller/notifications/preferences', headers: as.seller(owner) });
    expect(prefs.statusCode, prefs.body).toBe(200);
    expect(prefs.json().members.map((m: any) => m.accountId).sort()).toEqual([owner.accountId, packer.accountId].sort());
  });
});

describe('invitation to apply', () => {
  it('emails the business its code and keeps the code out of the delivery log', async () => {
    const email = `shop-${newId().slice(-12)}@example.com`;
    const code = '7F3A9C21B04E';
    const invitationId = newId();
    await publish(app, 'sellers.invitation.sent', { invitationId, email, businessName: 'Northwind Audio LLC', code, expiresAt: '2026-10-17T12:00:00.000Z' });
    const [mail] = emailsTo(email);
    expect(mail!.message.subject).toBe("You're invited to sell on Marketly");
    expect(mail!.message.text).toContain(code);
    expect(mail!.message.text).toContain('Northwind Audio LLC');
    expect(mail!.message.text).toContain('Oct 17');

    const [d] = await deliveriesTo(email);
    expect(d).toMatchObject({ topicKey: 'seller.application.invitation', channel: 'email', status: 'delivered' });
    const detail = await app.inject({ method: 'GET', url: `/api/admin/notifications/deliveries/${d.id}`, headers: admin() });
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(detail.json())).not.toContain(code);
    // nothing kept in the database carries the code (no in-app notice, redacted subject, no body)
    const db = service.core.ctx.db;
    const stored = [
      ...(await db.selectFrom('deliveries').selectAll().where('topic_key', '=', 'seller.application.invitation').execute()),
      ...(await db.selectFrom('notices').selectAll().where('topic_key', '=', 'seller.application.invitation').execute()),
      ...(await db.selectFrom('delivery_events').selectAll().where('delivery_id', '=', d.id).execute()),
    ];
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain(code);
  });
});

describe('idempotent consumers', () => {
  it('handles a redelivered event (same envelope id) once', async () => {
    const c = world.customer();
    const p = cancelled({ customerId: c.customerId, ref: 'MK-261010-40099' }) as any;
    const eventId = newId();
    await service.onItemCancelledFromOrders(p, eventId);
    await service.onItemCancelledFromOrders(p, eventId);
    expect(await inbox(as.customer(c), 'store')).toHaveLength(1);
    expect(emailsTo(c.email)).toHaveLength(1);
    const res = await app.inject({ method: 'GET', url: `/api/admin/notifications/deliveries?accountId=${c.accountId}`, headers: admin() });
    expect(res.json().items).toHaveLength(1); // no second (skipped) delivery row

    // reminders scheduled by a consumer are claimed too
    const returnId = newId();
    const label = { returnId, customerId: c.customerId, contactEmail: null, ownerType: 'official', sellerId: null, labelId: newId(), orderId: p.orderId, cost: money(599), paidBy: 'platform' } as any;
    const labelEvent = newId();
    await service.onLabelCreatedFromReturns(label, labelEvent);
    await service.onLabelCreatedFromReturns(label, labelEvent);
    const due = await service.core.repo.dueScheduled(new Date(Date.now() + 30 * 86_400_000), 500);
    expect(due.filter((s) => s.dedupe_key === `return-dropoff:${returnId}`)).toHaveLength(1);
    expect((due.find((s) => s.dedupe_key === `return-dropoff:${returnId}`)!.input as any).recipients).toEqual([{ kind: 'customer', customerId: c.customerId }]);
  });
});
