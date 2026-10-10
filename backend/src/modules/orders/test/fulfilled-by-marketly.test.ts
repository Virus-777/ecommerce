/**
 * Fulfilled by Marketly (fulfillment-service, phase 4; decisions D6 and D10): placement check against
 * fulfillment-service.isServiceOffer, Official-Store-like cancellations, seller actions refused with
 * FULFILLED_BY_MARKETLY, seller views and counts, customer wording, event fields and list filters.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { checkout, group, harness, idem, line, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness({ fulfillmentService: true });
});
afterAll(async () => {
  await h.app.close();
});

/** One seller selling a Marketly-fulfilled offer and a self-shipped offer in one checkout */
async function mixed() {
  const customerId = newId();
  const sellerId = newId();
  const ps = product(h, { title: 'Desk Lamp', price: 3000, sellerId, sellerName: 'Casa Verde Home' });
  const pm = product(h, { title: 'Throw Pillow', price: 2000, sellerId, sellerName: 'Casa Verde Home' });
  h.serviceOffers.add(ps.offerId);
  const order = await h.service.createOrder(
    checkout(
      [
        group(h, [line(ps, 2, { shipping: 500, tax: 300 })], { sellerId, fulfilledBy: 'marketly_service' }),
        group(h, [line(pm, 1, { tax: 200 })], { sellerId }),
      ],
      { customerId },
    ),
  );
  await h.app.kernel.events.drain();
  return { order, customerId, sellerId, ps, pm, service: order.groups[0]!, own: order.groups[1]! };
}

const picking = (orderId: string, groupId: string, sellerId: string, to = 'picking', from = 'awaiting_pick') =>
  h.publish('warehouse', 'warehouse.fulfillment.status_changed', { fulfillmentId: newId(), orderId, sellerGroupId: groupId, fulfilledBy: 'marketly_service', sellerId, from, to, reason: null });

describe('placement (fulfillment-service on)', () => {
  it('accepts a Fulfilled by Marketly package of service offers next to a self-shipped one', async () => {
    const m = await mixed();
    expect(m.order.groups.map((g) => g.fulfilledBy)).toEqual(['marketly_service', 'seller']);
    const placed = h.named('orders.order.placed').find((e) => e.orderId === m.order.id);
    expect(placed.groups.map((g: any) => g.fulfilledBy)).toEqual(['marketly_service', 'seller']);
  });

  it('refuses a Fulfilled by Marketly package holding an offer Marketly does not fulfil, and a seller package holding one it does', async () => {
    const sellerId = newId();
    const ps = product(h, { title: 'Kettle', price: 3000, sellerId });
    const pm = product(h, { title: 'Mug', price: 900, sellerId });
    h.serviceOffers.add(ps.offerId);
    const wrongService = h.service.createOrder(checkout([group(h, [line(pm, 1)], { sellerId, fulfilledBy: 'marketly_service' })], { customerId: newId() }));
    await expect(wrongService).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'groups[0].items[0].offerId' }] } });
    const wrongSeller = h.service.createOrder(checkout([group(h, [line(ps, 1)], { sellerId })], { customerId: newId() }));
    await expect(wrongSeller).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'groups[0].items[0].offerId' }] } });
    const official = product(h, { title: 'Pan', price: 2500, ownerType: 'official' });
    const officialService = h.service.createOrder(checkout([group(h, [line(official, 1)], { ownerType: 'official', fulfilledBy: 'marketly_service' })], { customerId: newId() }));
    await expect(officialService).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'groups[0].fulfilledBy' }] } });
  });
});

describe('seller views and counts', () => {
  it('shows marketly_fulfils, no actions, the warehouse stage and only the city and region', async () => {
    const m = await mixed();
    const seller = tokens.seller(m.sellerId);
    const list = await h.call('GET', `/api/seller/orders/orders?q=${m.order.ref}`, seller);
    expect(list.status).toBe(200);
    const rows = new Map(list.body.items.map((r: any) => [r.id, r]));
    expect(rows.get(m.service.id)).toMatchObject({ fulfilledBy: 'marketly_service', nextAction: 'marketly_fulfils', statusLabel: 'Fulfilled by Marketly · Awaiting picking' });
    expect(rows.get(m.own.id)).toMatchObject({ fulfilledBy: 'seller', nextAction: 'prepare', statusLabel: 'New' });

    await picking(m.order.id, m.service.id, m.sellerId);
    const after = await h.call('GET', `/api/seller/orders/orders?q=${m.order.ref}&fulfilledBy=marketly_service`, seller);
    expect(after.body.items.map((r: any) => r.id)).toEqual([m.service.id]);
    expect(after.body.items[0].statusLabel).toBe('Fulfilled by Marketly · Picking');
    // a redelivered stage writes no second entry; the next stage replaces it
    await picking(m.order.id, m.service.id, m.sellerId);
    await picking(m.order.id, m.service.id, m.sellerId, 'packed', 'packing');

    const detail = await h.call('GET', `/api/seller/orders/orders/${m.service.id}`, seller);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ fulfilledBy: 'marketly_service', statusLabel: 'Fulfilled by Marketly · Packed', allowedActions: [] });
    expect(detail.body.shipTo).toMatchObject({ name: 'Sam R.', city: 'Portland', region: 'OR', postalCode: '', phone: null, line2: null });
    expect(detail.body.shipTo.line1).not.toContain('Main St');
    expect(detail.body.timeline.filter((t: any) => t.label === 'Marketly warehouse').map((t: any) => t.detail)).toEqual(['Picking', 'Packed']);
    const own = await h.call('GET', `/api/seller/orders/orders/${m.own.id}`, seller);
    expect(own.body.shipTo.line1).toBe('1 Main St');
    expect(own.body.allowedActions).toContain('start_preparing');

    // only-service seller: the order-wide address is masked too (public API)
    const sellerId = newId();
    const p = product(h, { title: 'Vase', price: 1500, sellerId });
    h.serviceOffers.add(p.offerId);
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId, fulfilledBy: 'marketly_service' })], { customerId: newId() }));
    const view = await h.service.getOrderForSeller(sellerId, order.ref);
    expect(view!.order.deliveryAddress).toMatchObject({ city: 'Portland', region: 'OR', postalCode: '' });
    expect(view!.order.deliveryAddress.line1).not.toContain('Main St');
  });

  it('leaves service groups out of new, preparing, cancellation, overdue and due-today, and counts them in fulfilledByMarketly', async () => {
    const sellerId = newId();
    const ps = product(h, { title: 'Clock', price: 3000, sellerId });
    const pm = product(h, { title: 'Frame', price: 1000, sellerId });
    h.serviceOffers.add(ps.offerId);
    const customerId = newId();
    // both packages are past their dispatch deadline; a second service package is due within the minute
    const order = await h.service.createOrder(
      checkout(
        [
          group(h, [line(ps, 1)], { sellerId, fulfilledBy: 'marketly_service', dispatchInHours: -1 }),
          group(h, [line(pm, 1)], { sellerId, dispatchInHours: -1 }),
        ],
        { customerId },
      ),
    );
    await h.service.createOrder(checkout([group(h, [line(ps, 1)], { sellerId, fulfilledBy: 'marketly_service', dispatchInHours: 1 / 60 })], { customerId }));
    // the overdue service group, with a pending cancellation after picking, is still not the seller's work
    const service = order.groups[0]!;
    await picking(order.id, service.id, sellerId);
    await h.call('POST', `/api/store/orders/orders/${order.id}/cancellations`, tokens.customer(customerId), { items: [{ itemId: service.items[0]!.id, quantity: 1 }], reasonCode: 'changed_mind' }, idem());
    const seller = tokens.seller(sellerId);
    const counts = await h.call('GET', '/api/seller/orders/orders/counts', seller);
    expect(counts.status).toBe(200);
    expect(counts.body).toMatchObject({ new: 1, preparing: 0, cancellationRequests: 0, overdue: 1, dueToday: 0, fulfilledByMarketly: 2 });
    const tiles = await h.service.countOrdersForSellers([sellerId]);
    expect(tiles[sellerId]).toMatchObject({ overdueDispatch: 1, dueToday: 0, cancellationRequests: 0 });
    const tabs = await h.call('GET', '/api/seller/orders/orders?tabs=new,preparing,cancellation_requests', seller);
    expect(tabs.body.items.map((r: any) => r.id)).toEqual([order.groups[1]!.id]);
    const late = await h.call('GET', '/api/seller/orders/orders?overdueOnly=true', seller);
    expect(late.body.items.map((r: any) => r.id)).toEqual([order.groups[1]!.id]);
    // without a tab the service groups are listed (read only)
    const all = await h.call('GET', '/api/seller/orders/orders', seller);
    expect(all.body.items).toHaveLength(3);
  });
});

describe('seller actions answer 409 FULFILLED_BY_MARKETLY', () => {
  it('refuses preparing, delays, cancelling, answering cancellations and packing slips', async () => {
    const m = await mixed();
    const seller = tokens.seller(m.sellerId);
    const id = m.service.id;
    const item = m.service.items[0]!;
    const expect409 = (r: { status: number; body: any }) => {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('FULFILLED_BY_MARKETLY');
    };
    expect409(await h.call('POST', `/api/seller/orders/orders/${id}/start-preparing`, seller));
    expect409(await h.call('POST', `/api/seller/orders/orders/${id}/report-delay`, seller, { reason: 'restock', expectedDispatchBy: new Date(Date.now() + 3 * 86_400_000).toISOString() }));
    expect409(await h.call('POST', `/api/seller/orders/orders/${id}/cancel-items`, seller, { items: [{ itemId: item.id, quantity: 1 }], reasonCode: 'out_of_stock' }, idem()));
    expect409(await h.call('GET', `/api/seller/orders/orders/${id}/packing-slip`, seller));
    expect409(await h.call('POST', '/api/seller/orders/packing-slips', seller, { orderIds: [m.own.id, id] }));

    const bulk = await h.call('POST', '/api/seller/orders/orders/bulk-start-preparing', seller, { orderIds: [id, m.own.id] });
    expect(bulk.status).toBe(200);
    expect(bulk.body).toMatchObject({ updated: 1, failed: [{ id, code: 'FULFILLED_BY_MARKETLY' }] });

    // nothing moved on the service group; another seller still gets 404
    expect((await h.service.getOrder(m.order.id))!.groups[0]!.items[0]!.state).toBe('confirmed');
    expect((await h.call('POST', `/api/seller/orders/orders/${id}/start-preparing`, tokens.seller(newId()))).status).toBe(404);
  });

  it('a customer cancels instantly before picking; after picking the Order Manager decides and the seller cannot', async () => {
    const m = await mixed();
    const me = tokens.customer(m.customerId);
    const item = m.service.items[0]!;
    const early = await h.call('POST', `/api/store/orders/orders/${m.order.id}/cancellations`, me, { items: [{ itemId: item.id, quantity: 1 }], reasonCode: 'changed_mind' }, idem());
    expect(early.status).toBe(201);
    expect(early.body.requests[0]).toMatchObject({ groupId: m.service.id, status: 'accepted' });
    expect(h.named('orders.item.cancelled').find((e) => e.cancellationId === early.body.requests[0].id)).toMatchObject({ fulfilledBy: 'marketly_service', ownerType: 'seller', sellerId: m.sellerId, quantity: 1 });

    await picking(m.order.id, m.service.id, m.sellerId);
    const rest = (await h.service.getOrder(m.order.id))!.groups[0]!.items.find((i) => i.state === 'preparing')!;
    const late = await h.call('POST', `/api/store/orders/orders/${m.order.id}/cancellations`, me, { items: [{ itemId: rest.id, quantity: 1 }], reasonCode: 'changed_mind' }, idem());
    const req = late.body.requests[0];
    expect(req.status).toBe('requested');
    expect(h.named('orders.cancellation.requested').find((e) => e.cancellationId === req.id)).toMatchObject({ fulfilledBy: 'marketly_service', sellerId: m.sellerId, itemIds: [rest.id] });
    const store = await h.call('GET', `/api/store/orders/orders/${m.order.id}`, me);
    expect(store.body.groups[0].items.find((i: any) => i.id === rest.id).stateNote).toMatch(/^Cancellation requested\. Marketly will confirm by /);

    const seller = tokens.seller(m.sellerId);
    const accept = await h.call('POST', `/api/seller/orders/orders/${m.service.id}/cancellation-requests/${req.id}/accept`, seller, undefined, idem());
    expect(accept.status).toBe(409);
    expect(accept.body.error.code).toBe('FULFILLED_BY_MARKETLY');
    expect((await h.call('POST', `/api/seller/orders/orders/${m.service.id}/cancellation-requests/${req.id}/decline`, seller, { reason: 'other' })).status).toBe(409);

    const staff = tokens.staff(['orders.orders.view', 'orders.cancellations.decide']);
    const decided = await h.call('POST', `/api/admin/orders/orders/${m.order.id}/cancellation-requests/${req.id}/decide`, staff, { accept: true, reason: 'Pulled from the pick cart' }, idem());
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe('accepted');
    expect(h.named('orders.item.cancelled').find((e) => e.cancellationId === req.id)).toMatchObject({ fulfilledBy: 'marketly_service', itemId: rest.id });
  });
});

describe('customer wording and admin filter', () => {
  it('reads Shipped by Marketly with the Marketly handling note', async () => {
    const m = await mixed();
    const detail = await h.call('GET', `/api/store/orders/orders/${m.order.id}`, tokens.customer(m.customerId));
    const [service, own] = detail.body.groups;
    expect(service.handlingNote).toBe('Marketly ships this package and handles its returns');
    expect(service.items[0].stateNote).toBe('Not shipped yet. You can cancel it until Marketly ships it.');
    expect(own.handlingNote).toBe('Casa Verde Home handles this package. Marketly support can step in.');
    expect(h.service.views.soldBy((await h.service.core.load(m.order.id))!.groups[0]!)).toBe('Sold by Casa Verde Home · Shipped by Marketly');
  });

  it('filters the admin list by how a group is fulfilled', async () => {
    const m = await mixed();
    const staff = tokens.staff(['orders.orders.view']);
    const service = await h.call('GET', `/api/admin/orders/orders?q=${m.order.ref}&fulfilledBy=marketly_service`, staff);
    expect(service.status).toBe(200);
    expect(service.body.items.map((o: any) => o.id)).toEqual([m.order.id]);
    const official = await h.call('GET', `/api/admin/orders/orders?q=${m.order.ref}&fulfilledBy=official_warehouse`, staff);
    expect(official.body.items).toHaveLength(0);
    const page = await h.service.listOrdersAdmin({ q: m.order.ref, fulfilledBy: 'seller' }, { limit: 5 });
    expect(page.items.map((o) => o.order.id)).toEqual([m.order.id]);
  });
});

describe('placement (fulfillment-service off)', () => {
  let off: Harness;
  beforeAll(async () => {
    off = await harness();
  });
  afterAll(async () => {
    await off.app.close();
  });

  it('refuses a Fulfilled by Marketly package and places seller packages without asking', async () => {
    const sellerId = newId();
    const p = product(off, { title: 'Rug', price: 8000, sellerId });
    const refused = off.service.createOrder(checkout([group(off, [line(p, 1)], { sellerId, fulfilledBy: 'marketly_service' })], { customerId: newId() }));
    await expect(refused).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'groups[0].fulfilledBy' }] } });
    const ok = await off.service.createOrder(checkout([group(off, [line(p, 1)], { sellerId })], { customerId: newId() }));
    expect(ok.groups[0]!.fulfilledBy).toBe('seller');
  });
});
