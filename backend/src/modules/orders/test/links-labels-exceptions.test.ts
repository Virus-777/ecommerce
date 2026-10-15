/**
 * Order list links and search (G19, G22d, G22e), units on unhanded labels and cancellations around them (G41a,
 * G41c), seller exports of selected orders (G54d) and open delivery exceptions on admin rows (G73).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth } from '../../../testing/app.js';
import { checkout, group, harness, idem, line, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const now = () => new Date().toISOString();

/** One customer order: 3 lamps from Lumen Works, 1 throw from Casa Verde Home */
async function order() {
  const customerId = newId();
  const sellerA = newId();
  const sellerB = newId();
  const lamp = product(h, { title: 'Arc Lamp', price: 5000, sellerId: sellerA, sellerName: `Lumen Works ${customerId.slice(0, 4)}` });
  const pb = product(h, { title: 'Wool Throw', price: 4000, sellerId: sellerB });
  const o = await h.service.createOrder(checkout([group(h, [line(lamp, 3)], { sellerId: sellerA }), group(h, [line(pb, 1)], { sellerId: sellerB })], { customerId }));
  await h.app.kernel.events.drain();
  return { o, customerId, sellerA, sellerB, lamp, lumen: `Lumen Works ${customerId.slice(0, 4)}` };
}

/** A label bought for some units (shipping.shipment.created, label_created): not handed over yet */
async function buyLabel(orderId: string, groupId: string, sellerId: string, itemId: string, quantity: number) {
  const shipmentId = newId();
  await h.publish('shipping', 'shipping.shipment.created', { shipmentId, kind: 'outbound', orderId, groupId, sellerId, fulfilledBy: 'seller', packageLabel: 'Package 1 of 2', carrierCode: 'ups', carrierName: 'UPS', serviceName: 'Ground', trackingNumber: `1Z${shipmentId.slice(0, 8)}`, trackingUrl: null, lines: [{ orderItemId: itemId, title: 'Arc Lamp', variantLabel: 'Teal', quantity }], status: 'label_created' });
  return shipmentId;
}

describe('order list links and search', () => {
  it('lists every item with product id, current slug and offer, and searches seller names', async () => {
    const { o, customerId, lamp, lumen } = await order();
    const me = tokens.customer(customerId);
    const list = await h.call('GET', '/api/store/orders/orders', me);
    expect(list.status).toBe(200);
    expect(list.body.items[0].items).toEqual([
      expect.objectContaining({ itemId: o.groups[0]!.items[0]!.id, productId: lamp.productId, productSlug: 'arc-lamp', offerId: lamp.offerId, title: 'Arc Lamp', quantity: 3 }),
      expect.objectContaining({ productSlug: 'wool-throw', quantity: 1 }),
    ]);
    // G22d: a seller name finds the order; G22e: the tab counts follow the same search
    expect((await h.call('GET', `/api/store/orders/orders?q=${encodeURIComponent(lumen)}`, me)).body.items.map((x: any) => x.id)).toEqual([o.id]);
    expect((await h.call('GET', '/api/store/orders/orders?q=Nobody%20Sells%20This', me)).body.items).toEqual([]);
    expect((await h.call('GET', `/api/store/orders/orders/counts?q=${encodeURIComponent(lumen)}`, me)).body).toMatchObject({ all: 1, inProgress: 1 });
    expect((await h.call('GET', '/api/store/orders/orders/counts?q=Nobody%20Sells%20This', me)).body).toMatchObject({ all: 0, inProgress: 0 });

    const gql = await h.app.inject({
      method: 'POST',
      url: '/graphql/store',
      headers: auth(me),
      payload: { query: `{ orders { items { groups { items { productId productSlug } } } } }` },
    });
    const body = gql.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.orders.items[0].groups[0].items[0]).toEqual({ productId: lamp.productId, productSlug: 'arc-lamp' });
  });
});

describe('units on a bought label (G41a, G41c)', () => {
  it('shows the units on the label and refuses staff cancellation and accepting a request until it is voided', async () => {
    const { o, customerId, sellerA } = await order();
    const lamp = o.groups[0]!.items[0]!;
    await buyLabel(o.id, o.groups[0]!.id, sellerA, lamp.id, 2);

    const seller = await h.call('GET', `/api/seller/orders/orders/${o.groups[0]!.id}`, tokens.seller(sellerA));
    expect(seller.status).toBe(200);
    expect(seller.body.items[0]).toMatchObject({ itemId: lamp.id, quantity: 3, shippedQuantity: 0, onLabelQuantity: 2 });
    const store = await h.call('GET', `/api/store/orders/orders/${o.id}`, tokens.customer(customerId));
    expect(store.body.groups[0].items[0].onLabelQuantity).toBe(2);
    expect(store.body.groups[1].items[0].onLabelQuantity).toBe(0);

    // staff cancel refuses the labelled item
    const staff = tokens.staff(['orders.orders.view', 'orders.orders.cancel']);
    const refused = await h.call('POST', `/api/admin/orders/orders/${o.id}/cancel-items`, staff, { items: [{ itemId: lamp.id, quantity: 1 }], reasonCode: 'seller_cannot_fulfill', reason: 'No stock', notifyCustomer: false }, idem());
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'CANCELLATION_NOT_ALLOWED', details: { items: [{ itemId: lamp.id }] } });

    // a customer request on the labelled item: the seller cannot accept it while the label stands
    const req = await h.call('POST', `/api/store/orders/orders/${o.id}/cancellations`, tokens.customer(customerId), { items: [{ itemId: lamp.id, quantity: 3 }], reasonCode: 'changed_mind' }, idem());
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const requestId = req.body.requests[0].id;
    const accept = await h.call('POST', `/api/seller/orders/orders/${o.groups[0]!.id}/cancellation-requests/${requestId}/accept`, tokens.seller(sellerA), undefined, idem());
    expect(accept.status).toBe(409);
    expect(accept.body.error.code).toBe('CANCELLATION_NOT_ALLOWED');
    const decide = await h.call('POST', `/api/admin/orders/orders/${o.id}/cancellation-requests/${requestId}/decide`, tokens.staff(['orders.orders.view', 'orders.cancellations.decide']), { accept: true, reason: 'Customer asked' }, idem());
    expect(decide.status).toBe(409);
  });
});

describe('seller export of selected orders (G54d)', () => {
  it('exports only the named groups or order references', async () => {
    const sellerId = newId();
    // one seller with two orders
    const p = product(h, { title: 'Mug', price: 1200, sellerId });
    const o1 = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId() }));
    const o2 = await h.service.createOrder(checkout([group(h, [line(p, 2)], { sellerId })], { customerId: newId() }));
    const token = tokens.seller(sellerId, ['orders.fulfillment.view', 'orders.fulfillment.export']);
    const res = await h.call('POST', '/api/seller/orders/exports', token, { filters: { groupIds: [o2.groups[0]!.id] }, format: 'csv' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const req = h.exports.requested.at(-1);
    expect(req.filters).toMatchObject({ groupIds: [o2.groups[0]!.id] });
    const principal = { kind: 'seller', sellerId, accountId: newId(), sessionId: newId() } as never;
    expect((await h.service.exportRows('orders.seller.orders', req.filters, principal)).rows.map((r: any) => r.ref)).toEqual([o2.ref]);
    expect((await h.service.exportRows('orders.seller.orders', { refs: [o1.ref.toLowerCase()] }, principal)).rows.map((r: any) => r.ref)).toEqual([o1.ref]);
    // a list with nothing usable exports nothing (never widens to every order)
    expect((await h.service.exportRows('orders.seller.orders', { groupIds: ['not-an-id'] }, principal)).rows).toEqual([]);
    expect((await h.service.exportRows('orders.seller.orders', {}, principal)).rows).toHaveLength(2);
  });
});

describe('open delivery exceptions on admin rows (G73)', () => {
  it('lists the open exception ids until shipping resolves them', async () => {
    const { o, sellerA } = await order();
    const exceptionId = newId();
    await h.publish('shipping', 'shipping.shipment.exception', { exceptionId, kind: 'late_dispatch', orderId: o.id, groupId: o.groups[0]!.id, shipmentId: null, sellerId: sellerA, fulfilledBy: 'seller', orderItemIds: [], dueAt: now(), customerAction: null, source: 'system' });
    const staff = tokens.staff(['orders.orders.view']);
    const row = async () => (await h.call('GET', `/api/admin/orders/orders?q=${o.ref}`, staff)).body.items[0];
    expect((await row()).openExceptionIds).toEqual([exceptionId]);
    const gql = await h.app.inject({ method: 'POST', url: '/graphql/admin', headers: auth(staff), payload: { query: `{ orderAdmin(ref: "${o.ref}") { openExceptionIds } }` } });
    expect(gql.json().data.orderAdmin.openExceptionIds).toEqual([exceptionId]);

    await h.publish('shipping', 'shipping.exception.resolved', { exceptionId, kind: 'late_dispatch', orderId: o.id, groupId: o.groups[0]!.id, resolution: 'Seller shipped' });
    const after = await row();
    expect(after.openExceptionIds).toEqual([]);
    expect(after.flags.map((f: any) => f.kind)).not.toContain('delivery_issue');
  });
});
