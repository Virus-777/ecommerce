/**
 * Fulfilled by Marketly: the seller gets no shipping or dispatch notices for groups Marketly ships (new order,
 * dispatch reminder, overdue dispatch, cancellation requests), staff get them instead (Warehouse Manager,
 * Order Manager), the generic low-stock notice is skipped for service-managed stock, and the
 * fulfillment-service topics are accepted by notify (preference group fulfillment_service).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOPICS, topicDef } from '../domain/catalog.js';
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

const inbox = async (headers: Record<string, string>, area: 'store' | 'seller' | 'admin', query = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/${area}/notifications/inbox${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as any[];
};

const soon = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

/** A seller workspace with an owner and members (known to notifications after a first visit) */
async function workspace() {
  const sellerId = newId();
  const owner = world.member(sellerId, { isOwner: true, role: 'Owner' });
  const packer = world.member(sellerId, { permissions: ['orders.fulfillment.view'] });
  const stockist = world.member(sellerId, { permissions: ['fulfillment-service.inbound.manage'] });
  for (const m of [owner, packer, stockist]) await inbox(as.seller(m), 'seller');
  return { sellerId, owner, packer, stockist };
}

function staffRole(roleKey: string) {
  const lead = world.staff();
  world.role(roleKey, { leadAccountId: lead.accountId, accountIds: [lead.accountId] });
  return lead;
}

describe('orders.order.accepted', () => {
  it('sends seller.order.new and schedules the dispatch reminder only for the group the seller ships', async () => {
    const c = world.customer();
    const { sellerId, owner } = await workspace();
    const own = newId();
    const service_ = newId();
    const orderId = newId();
    await publish(app, 'orders.order.accepted', {
      orderId,
      ref: 'MK-261011-40001',
      customerId: c.customerId,
      contactEmail: c.email,
      total: money(30000),
      groups: [
        { groupId: own, ownerType: 'seller', sellerId, fulfilledBy: 'seller', dispatchBy: soon(48), itemIds: [newId()], total: money(10000) },
        { groupId: service_, ownerType: 'seller', sellerId, fulfilledBy: 'marketly_service', dispatchBy: soon(48), itemIds: [newId()], total: money(20000) },
      ],
      items: [],
      acceptedAt: new Date().toISOString(),
    });

    const notices = await inbox(as.seller(owner), 'seller');
    expect(notices.map((n) => [n.topicKey, n.link.id])).toEqual([['seller.order.new', own]]);
    expect(await service.core.repo.hasPendingScheduled(`seller.dispatch.reminder:${own}`)).toBe(true);
    expect(await service.core.repo.hasPendingScheduled(`seller.dispatch.reminder:${service_}`)).toBe(false);
    // the customer is told once, as for any order
    expect((await inbox(as.customer(c), 'store')).map((n) => n.topicKey)).toEqual(['customer.order.accepted']);
  });

  it('a Fulfilled by Marketly order alone gives the seller nothing from the event routing', async () => {
    const c = world.customer();
    const { sellerId, owner } = await workspace();
    const groupId = newId();
    await publish(app, 'orders.order.accepted', {
      orderId: newId(),
      ref: 'MK-261011-40002',
      customerId: c.customerId,
      contactEmail: c.email,
      total: money(20000),
      groups: [{ groupId, ownerType: 'seller', sellerId, fulfilledBy: 'marketly_service', dispatchBy: soon(48), itemIds: [newId()], total: money(20000) }],
      items: [],
      acceptedAt: new Date().toISOString(),
    });
    expect(await inbox(as.seller(owner), 'seller')).toHaveLength(0);
    expect(emailsTo(owner.email)).toHaveLength(0);
    expect(await service.core.repo.hasPendingScheduled(`seller.dispatch.reminder:${groupId}`)).toBe(false);
  });
});

describe('shipping.dispatch.overdue', () => {
  it('Fulfilled by Marketly: no seller notice; the Warehouse Manager is told the Marketly warehouse is late', async () => {
    const { sellerId, owner } = await workspace();
    const warehouse = staffRole('warehouse_manager');
    const shipping = staffRole('shipping_manager');
    const orderId = newId();
    const groupId = newId();
    await publish(app, 'shipping.dispatch.overdue', { orderId, orderRef: 'MK-261011-40003', groupId, ownerType: 'seller', sellerId, fulfilledBy: 'marketly_service', orderItemIds: [newId()], dueAt: soon(-1), exceptionId: newId() });

    expect(await inbox(as.seller(owner), 'seller')).toHaveLength(0);
    expect(await inbox(as.staff(shipping), 'admin')).toHaveLength(0);
    const [n, ...rest] = await inbox(as.staff(warehouse), 'admin');
    expect(rest).toHaveLength(0);
    expect(n).toMatchObject({ topicKey: 'staff.shipping.dispatch_overdue', actionRequired: true, link: { kind: 'order', id: orderId, screen: 'ops/pick-pack' }, routedTo: { roleKey: 'warehouse_manager' } });
    expect(n.body).toContain('Marketly warehouse');

    // dispatching resolves it like any overdue notice
    await publish(app, 'shipping.shipment.dispatched', { shipmentId: newId(), kind: 'outbound', orderId, groupId, returnId: null, ownerType: 'seller', sellerId, fulfilledBy: 'marketly_service', lines: [], shippedAt: new Date().toISOString(), dispatchDueAt: null, onTime: false, trackingValid: true, estimatedArrival: null });
    expect((await inbox(as.staff(warehouse), 'admin'))[0].resolvedAt).toBeTruthy();
  });

  it('seller-fulfilled groups still notify the seller and the Shipping Manager', async () => {
    const { sellerId, owner } = await workspace();
    const shipping = staffRole('shipping_manager');
    await publish(app, 'shipping.dispatch.overdue', { orderId: newId(), orderRef: 'MK-261011-40004', groupId: newId(), ownerType: 'seller', sellerId, fulfilledBy: 'seller', orderItemIds: [newId()], dueAt: soon(-1), exceptionId: newId() });
    expect((await inbox(as.seller(owner), 'seller')).map((n) => n.topicKey)).toEqual(['seller.dispatch.overdue']);
    const [n] = await inbox(as.staff(shipping), 'admin');
    expect(n).toMatchObject({ topicKey: 'staff.shipping.dispatch_overdue', link: { screen: 'ops/dispatch' } });
    expect(n.body).toContain('The seller');
  });
});

describe('orders.cancellation.requested', () => {
  it('asks the seller for the groups it ships, until the cancellation is decided', async () => {
    const { sellerId, owner, packer, stockist } = await workspace();
    const cancellationId = newId();
    const groupId = newId();
    const respondBy = soon(24);
    await publish(app, 'orders.cancellation.requested', { cancellationId, orderId: newId(), groupId, sellerId, fulfilledBy: 'seller', itemIds: [newId(), newId()], respondBy });

    const [n] = await inbox(as.seller(owner), 'seller', '?actionRequired=true');
    expect(n).toMatchObject({ topicKey: 'seller.order.cancellation_requested', actionRequired: true, link: { kind: 'seller_order', id: groupId, screen: 'seller/order' } });
    expect(n.body).toContain('2 item(s)');
    expect(n.deadline).toBeTruthy();
    expect((await inbox(as.seller(packer), 'seller')).map((x) => x.topicKey)).toEqual(['seller.order.cancellation_requested']);
    expect(await inbox(as.seller(stockist), 'seller')).toHaveLength(0); // no order permission

    await publish(app, 'orders.cancellation.decided', { cancellationId, orderId: newId(), customerId: null, contactEmail: null, outcome: 'accepted', by: { kind: 'seller', id: owner.accountId } });
    expect((await inbox(as.seller(owner), 'seller'))[0].resolvedAt).toBeTruthy();
  });

  it('Fulfilled by Marketly and Official Store groups go to the Order Manager, never the seller', async () => {
    const { sellerId, owner } = await workspace();
    const orders = staffRole('order_manager');
    const orderId = newId();
    const cancellationId = newId();
    await publish(app, 'orders.cancellation.requested', { cancellationId, orderId, groupId: newId(), sellerId, fulfilledBy: 'marketly_service', itemIds: [newId()], respondBy: soon(8) });
    await publish(app, 'orders.cancellation.requested', { cancellationId: newId(), orderId: newId(), groupId: newId(), sellerId: null, fulfilledBy: 'official_warehouse', itemIds: [newId()], respondBy: soon(8) });

    expect(await inbox(as.seller(owner), 'seller')).toHaveLength(0);
    const notices = await inbox(as.staff(orders), 'admin');
    expect(notices.map((n) => n.topicKey)).toEqual(['staff.orders.cancellation_requested', 'staff.orders.cancellation_requested']);
    const fbm = notices.find((n) => n.link.id === orderId);
    expect(fbm).toMatchObject({ actionRequired: true, group: 'Operations', link: { screen: 'admin/order' }, routedTo: { roleKey: 'order_manager' } });
    expect(fbm.body).toContain('Fulfilled by Marketly');
    expect(notices.find((n) => n.link.id !== orderId).body).toContain('Official Store');

    await publish(app, 'orders.cancellation.decided', { cancellationId, orderId, customerId: null, contactEmail: null, outcome: 'declined', by: { kind: 'staff', id: orders.accountId } });
    expect((await inbox(as.staff(orders), 'admin')).find((n) => n.link.id === orderId).resolvedAt).toBeTruthy();
  });
});

describe('orders.item.cancelled', () => {
  it('still tells the seller about a cancelled Fulfilled by Marketly item, without asking them not to ship it', async () => {
    const { sellerId, owner } = await workspace();
    const base = {
      cancellationId: newId(),
      orderId: newId(),
      ref: 'MK-261011-40005',
      groupId: newId(),
      ownerType: 'seller',
      sellerId,
      customerId: null,
      contactEmail: null,
      offerId: newId(),
      stockItemId: newId(),
      quantity: 1,
      reasonCode: 'changed_mind',
      initiatedBy: 'customer',
      beforeDispatch: true,
      countsAgainstSeller: false,
      refund: { itemAmount: money(1000), discountShare: money(0), shippingRefund: money(0), taxRefund: money(0), total: money(1000) },
      paymentIntentId: newId(),
      notifyCustomer: false,
    };
    await publish(app, 'orders.item.cancelled', { ...base, itemId: newId(), fulfilledBy: 'marketly_service' });
    await publish(app, 'orders.item.cancelled', { ...base, cancellationId: newId(), itemId: newId(), fulfilledBy: 'seller' });
    const bodies = (await inbox(as.seller(owner), 'seller')).map((n) => n.body);
    expect(bodies).toHaveLength(2);
    expect(bodies.filter((b) => b.includes("Marketly's warehouse will not ship them."))).toHaveLength(1);
    expect(bodies.filter((b) => b.includes('Do not ship them.'))).toHaveLength(1);
  });
});

describe('inventory.stock.low', () => {
  it('skips the generic seller notice for service-managed stock (fulfillment-service sends its own)', async () => {
    const { sellerId, owner } = await workspace();
    const base = { offerId: null, ownerType: 'seller', sellerId, productId: newId(), variantId: newId(), sku: 'LAMP-BLK', label: 'Aurora Desk Lamp, black', available: 2, threshold: 5 };
    await publish(app, 'inventory.stock.low', { ...base, stockItemId: newId(), serviceManaged: true });
    expect(await inbox(as.seller(owner), 'seller')).toHaveLength(0);
    await publish(app, 'inventory.stock.low', { ...base, stockItemId: newId(), serviceManaged: false });
    expect((await inbox(as.seller(owner), 'seller')).map((n) => n.topicKey)).toEqual(['seller.stock.low']);
  });
});

describe('fulfillment-service topics', () => {
  const SELLER_TOPICS: [string, Record<string, unknown>][] = [
    ['seller.fulfillment.enrollment_decided', { enrollment: { state: 'info_requested' }, reason: 'Tell us your expected monthly units.' }],
    ['seller.fulfillment.sku_reviewed', { sku: 'LAMP-BLK', approved: true, reason: null }],
    ['seller.fulfillment.inbound_received', { inbound: { ref: 'FS-IN-1' }, received: 48, damaged: 2, discrepancy: true }],
    ['seller.fulfillment.stock_available', { inbound: { ref: 'FS-IN-1' }, units: 46 }],
    ['seller.fulfillment.discrepancy_decided', { inbound: { ref: 'FS-IN-1' }, decision: 'reimburse' }],
    ['seller.fulfillment.order_received', { order: { ref: 'MK-261011-40006' }, items: [{ label: 'Aurora Desk Lamp, black', quantity: 2 }] }],
    ['seller.fulfillment.return_inspected', { return: { ref: 'RT-261011-0001' }, outcome: 'restocked' }],
    ['seller.fulfillment.removal_completed', { removal: { ref: 'FS-RM-1' }, units: 4 }],
    ['seller.fulfillment.stock_low', { stock: { label: 'Aurora Desk Lamp, black' }, available: 3 }],
    ['seller.fulfillment.stock_aged', { units: 12, effective: 'Nov 1' }],
    ['seller.fulfillment.disposal_scheduled', { units: 3, days: 90, removal: { ref: 'FS-RM-2' } }],
    ['seller.fulfillment.fee_schedule_changed', { version: '2026-11', effective: 'Nov 1' }],
    ['seller.fulfillment.offboarding', { removal: { refs: ['FS-RM-3', 'FS-RM-4'] } }],
  ];

  it('declares every topic in the fulfillment_service preference group (phase 4)', () => {
    const fbm = TOPICS.filter((t) => t.key.startsWith('seller.fulfillment.'));
    expect(fbm.map((t) => t.key).sort()).toEqual(SELLER_TOPICS.map(([k]) => k).sort());
    for (const t of fbm) expect(t).toMatchObject({ audience: 'seller', prefGroup: 'fulfillment_service', phase: 4, category: 'essential' });
    for (const [key, role] of [
      ['staff.fulfillment.enrollment_submitted', 'seller_manager'],
      ['staff.fulfillment.inbound_submitted', 'warehouse_manager'],
      ['staff.fulfillment.discrepancy_claimed', 'warehouse_manager'],
    ] as const)
      expect(topicDef(key)).toMatchObject({ audience: 'staff', staffRoleKeys: [role], phase: 4 });
  });

  it('notify accepts each seller topic: the owner and members with fulfillment-service.inbound.manage receive it', async () => {
    const { sellerId, owner, packer, stockist } = await workspace();
    for (const [topic, context] of SELLER_TOPICS) {
      const res = await service.notify({ topic, recipients: [{ kind: 'seller', sellerId }], context, link: { kind: 'fulfillment_service', id: newId(), screen: 'seller/inventory', label: 'Open' }, dedupeKey: `test:${topic}:${sellerId}`, sellerId });
      expect(res.noticeIds.length, topic).toBe(1); // one notice for the workspace (owner and stockist)
    }
    const mine = await inbox(as.seller(stockist), 'seller', '?limit=50');
    expect(mine).toHaveLength(SELLER_TOPICS.length);
    expect(await inbox(as.seller(packer), 'seller')).toHaveLength(0); // no fulfillment-service permission
    // essential for the owner: always emailed
    expect(emailsTo(owner.email)).toHaveLength(SELLER_TOPICS.length);

    const body = (key: string) => mine.find((n) => n.topicKey === key)!;
    expect(body('seller.fulfillment.enrollment_decided').title).toBe('Fulfilled by Marketly enrollment info requested');
    expect(body('seller.fulfillment.sku_reviewed').title).toBe('LAMP-BLK approved for Fulfilled by Marketly');
    expect(body('seller.fulfillment.inbound_received').body).toContain('48 units of inbound shipment FS-IN-1 (2 damaged). Some counts differ');
    expect(body('seller.fulfillment.discrepancy_decided').body).toContain(': reimburse.');
    expect(body('seller.fulfillment.order_received').body).toContain('Aurora Desk Lamp, black × 2');
    expect(body('seller.fulfillment.return_inspected').body).toContain(': restocked.');
    expect(body('seller.fulfillment.stock_low').body).toContain('Only 3 left of Aurora Desk Lamp, black');
    expect(body('seller.fulfillment.offboarding').body).toContain('FS-RM-3, FS-RM-4');
    for (const n of mine) expect(n.body, n.topicKey).not.toMatch(/\{\{|undefined|null/);
  });

  it('a member can turn the group off; the owner cannot', async () => {
    const { sellerId, owner, stockist } = await workspace();
    const prefs = await app.inject({ method: 'GET', url: '/api/seller/notifications/preferences', headers: as.seller(owner) });
    expect(prefs.json().groups).toEqual(expect.arrayContaining([{ key: 'fulfillment_service', label: 'Fulfilled by Marketly', ownerOnly: false, essentialForOwner: true, permission: 'fulfillment-service.inbound.manage' }]));
    const locked = await app.inject({ method: 'PUT', url: `/api/seller/notifications/preferences/members/${owner.memberId}`, headers: as.seller(owner), payload: { groups: { fulfillment_service: false }, channel: 'in_app_and_email' } });
    expect(locked.json().error.code).toBe('GROUP_LOCKED');
    const off = await app.inject({ method: 'PUT', url: `/api/seller/notifications/preferences/members/${stockist.memberId}`, headers: as.seller(owner), payload: { groups: { fulfillment_service: false }, channel: 'in_app' } });
    expect(off.statusCode, off.body).toBe(200);
    await service.notify({ topic: 'seller.fulfillment.stock_available', recipients: [{ kind: 'seller', sellerId }], context: { inbound: { ref: 'FS-IN-9' }, units: 5 }, link: { kind: 'fulfillment_service', id: newId(), screen: 'seller/inventory' }, dedupeKey: `fs:receipt:${newId()}:confirmed`, sellerId });
    expect(await inbox(as.seller(stockist), 'seller')).toHaveLength(0);
    expect((await inbox(as.seller(owner), 'seller')).map((n) => n.topicKey)).toEqual(['seller.fulfillment.stock_available']);
  });

  it('notify accepts the staff topics, routed to the role', async () => {
    const sellers = staffRole('seller_manager');
    const warehouse = staffRole('warehouse_manager');
    const send = (topic: string, roleKey: string, ref: string) =>
      service.notify({ topic, recipients: [{ kind: 'staff_role', roleKey }], link: { kind: 'fulfillment_service', id: newId(), ref, screen: 'ops/receiving' }, dedupeKey: `test:${topic}:${ref}` });
    await send('staff.fulfillment.enrollment_submitted', 'seller_manager', 'FS-EN-1');
    await send('staff.fulfillment.inbound_submitted', 'warehouse_manager', 'FS-IN-2');
    await send('staff.fulfillment.discrepancy_claimed', 'warehouse_manager', 'FS-IN-3');
    expect((await inbox(as.staff(sellers), 'admin')).map((n) => n.topicKey)).toEqual(['staff.fulfillment.enrollment_submitted']);
    const wh = await inbox(as.staff(warehouse), 'admin');
    expect(wh.map((n) => n.topicKey).sort()).toEqual(['staff.fulfillment.discrepancy_claimed', 'staff.fulfillment.inbound_submitted']);
    expect(wh.find((n) => n.topicKey === 'staff.fulfillment.discrepancy_claimed')).toMatchObject({ actionRequired: true, title: 'Discrepancy claimed on FS-IN-3' });
  });
});
