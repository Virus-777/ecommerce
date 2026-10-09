/**
 * Spec correctness pass: category at purchase on items, the checkout's stock hold on orders.order.accepted,
 * getOrderItem / listDeliveredItems, and the customer on customer-facing item events.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { CATEGORY, checkout, group, harness, idem, line, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const now = () => new Date().toISOString();

async function deliver(orderId: string, groupId: string, sellerId: string | null, items: { id: string; quantity: number }[]) {
  const shipmentId = newId();
  const lines = items.map((i) => ({ orderItemId: i.id, quantity: i.quantity, title: 'x', variantLabel: '' }));
  await h.publish('shipping', 'shipping.shipment.created', { shipmentId, kind: 'outbound', orderId, groupId, sellerId, packageLabel: 'Package', carrierCode: 'ups', carrierName: 'UPS', serviceName: null, trackingNumber: '1Z9', trackingUrl: null, lines, status: 'label_created' });
  await h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId, kind: 'outbound', orderId, groupId, ownerType: sellerId ? 'seller' : 'official', sellerId, lines, shippedAt: now(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
  await h.publish('shipping', 'shipping.shipment.delivered', { shipmentId, kind: 'outbound', orderId, groupId, sellerId, lines, deliveredAt: now() });
}

describe('category at purchase', () => {
  it('keeps the snapshot category on each item, falling back to the product when the snapshot has none', async () => {
    const sellerId = newId();
    const withCategory = product(h, { title: 'Pan', price: 2500, sellerId, categoryId: CATEGORY.root });
    const without = product(h, { title: 'Lid', price: 900, sellerId, categoryId: null });
    h.productCategories.set(without.productId, CATEGORY.child);
    const order = await h.service.createOrder(checkout([group(h, [line(withCategory, 1), line(without, 1)], { sellerId })], { customerId: newId() }));
    expect(order.groups[0]!.items.map((i) => i.categoryId)).toEqual([CATEGORY.root, CATEGORY.child]);
    const info = await h.service.getOrderItem(order.groups[0]!.items[1]!.id);
    expect(info!.categoryId).toBe(CATEGORY.child);
    // category exceptions count the stored category
    expect((await h.service.countOpenOrdersInCategory(CATEGORY.root, new Date(Date.now() + 60_000).toISOString())).items).toBeGreaterThanOrEqual(2);
  });
});

describe('stock hold on orders.order.accepted', () => {
  it('carries the reservation id from createOrder when the payment is already accepted', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Bowl', price: 1800, sellerId });
    const reservationId = newId();
    const order = await h.service.createOrder({ ...checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId() }), reservationId });
    await h.app.kernel.events.drain();
    expect(h.named('orders.order.accepted').find((e) => e.orderId === order.id)).toMatchObject({ reservationId });
  });

  it('carries it from acceptOrder after a pending payment check, and is null without one', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Plate', price: 1600, sellerId });
    const reservationId = newId();
    const input = { ...checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId(), paymentState: 'pending_check' }), reservationId };
    const order = await h.service.createOrder(input);
    await h.app.kernel.events.drain();
    expect(h.named('orders.order.accepted').some((e) => e.orderId === order.id)).toBe(false);
    await h.service.acceptOrder(order.id, input.paymentIntentId);
    await h.app.kernel.events.drain();
    expect(h.named('orders.order.accepted').find((e) => e.orderId === order.id)).toMatchObject({ reservationId });

    const plain = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId() }));
    await h.app.kernel.events.drain();
    expect(h.named('orders.order.accepted').find((e) => e.orderId === plain.id).reservationId).toBeNull();
  });
});

describe('order item reads for reviews', () => {
  it('answers one item with its order, owner and customer, and lists delivered items since a time', async () => {
    const customerId = newId();
    const sellerId = newId();
    const pa = product(h, { title: 'Chair', price: 9000, sellerId });
    const po = product(h, { title: 'Rug', price: 7000, ownerType: 'official' });
    const order = await h.service.createOrder(checkout([group(h, [line(pa, 2)], { sellerId }), group(h, [line(po, 1)], { ownerType: 'official' })], { customerId }));
    const chair = order.groups[0]!.items[0]!;
    const rug = order.groups[1]!.items[0]!;

    expect(await h.service.getOrderItem(chair.id)).toEqual({
      id: chair.id,
      orderId: order.id,
      orderRef: order.ref,
      groupId: order.groups[0]!.id,
      ownerType: 'seller',
      sellerId,
      customerId,
      offerId: pa.offerId,
      productId: pa.productId,
      variantId: pa.variantId,
      stockItemId: pa.stockItemId,
      categoryId: CATEGORY.child,
      quantity: 2,
      state: 'confirmed',
      deliveredAt: null,
      returnWindowEndsAt: null,
    });
    expect(await h.service.getOrderItem(newId())).toBeNull();
    expect(await h.service.getOrderItem('not-an-id')).toBeNull();
    expect(await h.service.listDeliveredItems(customerId)).toEqual([]);

    const before = new Date(Date.now() - 1000).toISOString();
    await deliver(order.id, order.groups[1]!.id, null, [{ id: rug.id, quantity: 1 }]);
    const delivered = await h.service.listDeliveredItems(customerId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ id: rug.id, ownerType: 'official', sellerId: null, state: 'delivered' });
    expect(delivered[0]!.deliveredAt).toBeTruthy();
    expect(delivered[0]!.returnWindowEndsAt).toBeTruthy();
    expect(await h.service.listDeliveredItems(customerId, before)).toHaveLength(1);
    expect(await h.service.listDeliveredItems(customerId, new Date(Date.now() + 60_000).toISOString())).toEqual([]);
    expect(await h.service.listDeliveredItems(newId())).toEqual([]);
    await expect(h.service.listDeliveredItems(customerId, 'yesterday')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('customer on customer-facing events', () => {
  it('names the customer and contact email on item.cancelled, cancellation.decided and item.delayed', async () => {
    const accountId = newId(); // the customer id equals the account id in these tests
    const sellerId = newId();
    const ps = product(h, { title: 'Desk', price: 15000, sellerId });
    const po = product(h, { title: 'Vase', price: 4300, ownerType: 'official' });
    const order = await h.service.createOrder(checkout([group(h, [line(ps, 1)], { sellerId }), group(h, [line(po, 1)], { ownerType: 'official' })], { customerId: accountId, email: 'sam@example.com' }));
    const vase = order.groups[1]!.items[0]!;
    const res = await h.call('POST', `/api/store/orders/orders/${order.id}/cancellations`, tokens.customer(accountId), { items: [{ itemId: vase.id, quantity: 1 }], reasonCode: 'changed_mind' }, idem());
    expect(res.status).toBeLessThan(300);
    expect(h.named('orders.item.cancelled').find((e) => e.itemId === vase.id)).toMatchObject({ customerId: accountId, contactEmail: 'sam@example.com' });
    expect(h.named('orders.cancellation.decided').find((e) => e.orderId === order.id)).toMatchObject({ customerId: accountId, contactEmail: 'sam@example.com', outcome: 'accepted' });

    await h.publish('shipping', 'shipping.dispatch.overdue', { orderId: order.id, orderRef: order.ref, groupId: order.groups[0]!.id, ownerType: 'seller', sellerId, orderItemIds: [order.groups[0]!.items[0]!.id], dueAt: now(), exceptionId: newId() });
    expect(h.named('orders.item.delayed').find((e) => e.orderId === order.id)).toMatchObject({ customerId: accountId, contactEmail: 'sam@example.com', source: 'overdue' });
  });

  it('has no customer id for a guest, only the contact email', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Shelf', price: 5000, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { email: 'guest-shelf@example.com' }));
    await h.publish('shipping', 'shipping.dispatch.overdue', { orderId: order.id, orderRef: order.ref, groupId: order.groups[0]!.id, ownerType: 'seller', sellerId, orderItemIds: [order.groups[0]!.items[0]!.id], dueAt: now(), exceptionId: newId() });
    expect(h.named('orders.item.delayed').find((e) => e.orderId === order.id)).toMatchObject({ customerId: null, contactEmail: 'guest-shelf@example.com' });
  });
});
