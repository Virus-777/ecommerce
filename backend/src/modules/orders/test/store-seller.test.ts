import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { checkout, group, harness, idem, line, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

/** A mixed order: two sellers and the Official Store */
async function mixed(o: { customerId?: string; email?: string } = {}) {
  const customerId = o.customerId ?? newId();
  const sellerA = newId();
  const sellerB = newId();
  const pa = product(h, { title: 'Pocket Speaker', price: 5000, sellerId: sellerA, sellerName: 'Pixel & Port' });
  const pb = product(h, { title: 'Duvet', price: 10000, sellerId: sellerB });
  const po = product(h, { title: 'Skillet', price: 4000, ownerType: 'official' });
  const order = await h.service.createOrder(
    checkout(
      [
        group(h, [line(pa, 2, { discount: 1000, shipping: 600, tax: 800 })], { sellerId: sellerA }),
        group(h, [line(pb, 1, { shipping: 500, tax: 900 })], { sellerId: sellerB }),
        group(h, [line(po, 1, { tax: 300 })], { ownerType: 'official' }),
      ],
      { customerId: o.email ? null : customerId, email: o.email },
    ),
  );
  await h.app.kernel.events.drain();
  return { order, customerId, sellerA, sellerB, pa, pb, po, groupA: order.groups[0]!, groupB: order.groups[1]!, groupO: order.groups[2]! };
}

describe('store: record scope and reads', () => {
  it('lists, counts and shows the customer’s own orders; another customer gets 404', async () => {
    const m = await mixed();
    const me = tokens.customer(m.customerId);
    const list = await h.call('GET', '/api/store/orders/orders', me);
    expect(list.status).toBe(200);
    expect(list.body.items.map((o: any) => o.id)).toEqual([m.order.id]);
    expect(list.body.items[0]).toMatchObject({ itemCount: 4, sellerCount: 3, packageCount: 3, actions: expect.arrayContaining(['view', 'cancel']) });
    const search = await h.call('GET', '/api/store/orders/orders?q=duvet&tab=in_progress', me);
    expect(search.body.items).toHaveLength(1);
    const none = await h.call('GET', '/api/store/orders/orders?tab=cancelled', me);
    expect(none.body.items).toHaveLength(0);
    const counts = await h.call('GET', '/api/store/orders/orders/counts', me);
    expect(counts.body).toEqual({ all: 1, inProgress: 1, delivered: 0, returns: 0, cancelled: 0 });
    const detail = await h.call('GET', `/api/store/orders/orders/${m.order.id}`, me);
    expect(detail.status).toBe(200);
    expect(detail.body.groups[0].items[0].offer.sellerSku).toBeNull();
    expect(detail.body.groups[0].items[0].actions).toContain('cancel');
    // G14: units per item state (not package labels), adding up to itemCount
    const units: Record<string, number> = {};
    for (const g of detail.body.groups) for (const i of g.items) units[i.state] = (units[i.state] ?? 0) + i.quantity;
    expect(list.body.items[0].itemStates).toEqual(units);
    expect(Object.values(units).reduce((s, n) => s + n, 0)).toBe(4);

    const other = tokens.customer(newId());
    expect((await h.call('GET', `/api/store/orders/orders/${m.order.id}`, other)).status).toBe(404);
    expect((await h.call('GET', `/api/store/orders/orders/${m.order.id}/documents`, other)).status).toBe(404);
    expect((await h.call('GET', `/api/store/orders/orders/${m.order.id}/cancellation-options`, other)).status).toBe(404);
  });

  it('lets a guest session see the order only with granted access', async () => {
    const m = await mixed({ email: 'guest@example.com' });
    const visitor = tokens.visitor();
    expect((await h.call('GET', `/api/store/orders/orders/${m.order.id}`, visitor)).status).toBe(404);
    const sid = JSON.parse(Buffer.from(visitor.split('.')[1]!, 'base64url').toString()).sid;
    h.guestGrants.add(`${sid}:${m.order.id}`);
    const res = await h.call('GET', `/api/store/orders/orders/${m.order.id}`, visitor);
    expect(res.status).toBe(200);
    expect(res.body.contact.kind).toBe('guest');
  });

  it('issues short-lived document links rendered from the frozen order', async () => {
    const m = await mixed();
    const me = tokens.customer(m.customerId);
    const docs = await h.call('GET', `/api/store/orders/orders/${m.order.id}/documents`, me);
    expect(docs.body.map((d: any) => d.label)).toEqual(['Order receipt', 'Invoice, Pixel & Port', 'Invoice, Casa Verde Home', 'Invoice, Marketly Official Store']);
    const link = await h.call('GET', `/api/store/orders/orders/${m.order.id}/documents/${docs.body[0].id}`, me);
    expect(link.status).toBe(200);
    expect(link.body.fileName).toBe(`${m.order.ref}-R.pdf`);
    expect(new Date(link.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect((await h.call('GET', `/api/store/orders/orders/${m.order.id}/documents/${newId()}`, me)).status).toBe(404);
  });
});

describe('cancellations', () => {
  it('previews the refund: coupon share deducted, shipping only when the whole group is cancelled', async () => {
    const m = await mixed();
    const me = tokens.customer(m.customerId);
    const itemA = m.groupA.items[0]!;
    const one = await h.call('POST', `/api/store/orders/orders/${m.order.id}/cancellation-preview`, me, { items: [{ itemId: itemA.id, quantity: 1 }] });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ itemAmount: { amount: 5000 }, discountShare: { amount: 500 }, shippingRefund: { amount: 0 }, taxRefund: { amount: 400 }, total: { amount: 4900 }, destination: 'Visa •••• 4417' });
    const all = await h.call('POST', `/api/store/orders/orders/${m.order.id}/cancellation-preview`, me, { items: [{ itemId: itemA.id, quantity: 2 }] });
    expect(all.body).toMatchObject({ shippingRefund: { amount: 600 }, total: { amount: 10000 - 1000 + 600 + 800 } });
    const tooMany = await h.call('POST', `/api/store/orders/orders/${m.order.id}/cancellation-preview`, me, { items: [{ itemId: itemA.id, quantity: 3 }] });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error).toMatchObject({ code: 'QUANTITY_EXCEEDS_REMAINING', details: { max: 2 } });
  });

  it('a customer request on a seller item waits for the seller, who accepts; Official Store items cancel at once', async () => {
    const m = await mixed();
    const me = tokens.customer(m.customerId);
    const itemA = m.groupA.items[0]!;
    const itemO = m.groupO.items[0]!;
    const res = await h.call('POST', `/api/store/orders/orders/${m.order.id}/cancellations`, me, { items: [{ itemId: itemA.id, quantity: 1 }, { itemId: itemO.id, quantity: 1 }], reasonCode: 'changed_mind' }, idem());
    expect(res.status).toBe(201);
    const [reqA, reqO] = res.body.requests;
    expect(reqA).toMatchObject({ groupId: m.groupA.id, status: 'requested', initiatedBy: 'customer', refundStatus: 'none' });
    expect(reqA.respondBy.dueAt).toBeTruthy();
    expect(reqO).toMatchObject({ groupId: m.groupO.id, status: 'accepted', refundStatus: 'requested' });
    expect(h.named('orders.cancellation.requested').find((e) => e.cancellationId === reqA.id)).toMatchObject({ sellerId: m.sellerA, itemIds: [itemA.id] });
    expect(h.named('orders.item.cancelled').find((e) => e.cancellationId === reqO.id)).toMatchObject({ itemId: itemO.id, ownerType: 'official', initiatedBy: 'customer', beforeDispatch: true, countsAgainstSeller: false, refund: { total: { amount: 4300 } } });

    // the partial request split the line: 1 requested (same id), 1 still confirmed
    const detail = await h.call('GET', `/api/store/orders/orders/${m.order.id}`, me);
    const groupA = detail.body.groups[0];
    expect(groupA.items.map((i: any) => [i.quantity, i.state])).toEqual([
      [1, 'cancellation_requested'],
      [1, 'confirmed'],
    ]);
    expect(groupA.items[1].splitFromItemId).toBe(itemA.id);
    expect(detail.body.status.flags).toContain('cancellation_requested');

    const again = await h.call('POST', `/api/store/orders/orders/${m.order.id}/cancellations`, me, { items: [{ itemId: itemA.id, quantity: 1 }], reasonCode: 'changed_mind' }, idem());
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'CANCELLATION_ALREADY_REQUESTED', details: { cancellationId: reqA.id } });

    // another seller cannot see or answer it
    const sellerB = tokens.seller(m.sellerB);
    expect((await h.call('POST', `/api/seller/orders/orders/${m.groupA.id}/cancellation-requests/${reqA.id}/accept`, sellerB, undefined, idem())).status).toBe(404);
    const sellerA = tokens.seller(m.sellerA);
    const accepted = await h.call('POST', `/api/seller/orders/orders/${m.groupA.id}/cancellation-requests/${reqA.id}/accept`, sellerA, undefined, idem());
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'accepted', refundStatus: 'requested', refundPreview: { total: { amount: 4900 } } });
    expect(h.named('orders.cancellation.decided').find((e) => e.cancellationId === reqA.id)).toMatchObject({ outcome: 'accepted', by: { kind: 'seller' } });
    expect(h.named('orders.item.cancelled').find((e) => e.cancellationId === reqA.id)).toMatchObject({ itemId: itemA.id, quantity: 1, initiatedBy: 'customer', countsAgainstSeller: false });
    const order = await h.service.getOrder(m.order.id);
    expect(order!.groups[0]!.status).toBe('new');
    expect(order!.documents.filter((d) => d.kind === 'credit_note')).toHaveLength(2);
  });

  it('withdraws a pending request and restores the state before it', async () => {
    const m = await mixed();
    const me = tokens.customer(m.customerId);
    const seller = tokens.seller(m.sellerB);
    await h.call('POST', `/api/seller/orders/orders/${m.groupB.id}/start-preparing`, seller);
    const itemB = m.groupB.items[0]!;
    const res = await h.call('POST', `/api/store/orders/orders/${m.order.id}/cancellations`, me, { items: [{ itemId: itemB.id, quantity: 1 }], reasonCode: 'found_better_price' }, idem());
    const id = res.body.requests[0].id;
    const w = await h.call('POST', `/api/store/orders/orders/${m.order.id}/cancellations/${id}/withdraw`, me);
    expect(w.status).toBe(200);
    expect(w.body.status).toBe('withdrawn');
    const item = (await h.service.getOrder(m.order.id))!.groups[1]!.items[0]!;
    expect(item.state).toBe('preparing');
    expect((await h.call('POST', `/api/store/orders/orders/${m.order.id}/cancellations/${id}/withdraw`, me)).status).toBe(409);
    expect((await h.call('GET', `/api/store/orders/orders/${m.order.id}/cancellations/${id}`, me)).body.status).toBe('withdrawn');
  });

  it('a seller declines because it shipped only with a tracked shipment', async () => {
    const m = await mixed();
    const me = tokens.customer(m.customerId);
    const itemB = m.groupB.items[0]!;
    const req = (await h.call('POST', `/api/store/orders/orders/${m.order.id}/cancellations`, me, { items: [{ itemId: itemB.id, quantity: 1 }], reasonCode: 'changed_mind' }, idem())).body.requests[0];
    const seller = tokens.seller(m.sellerB);
    const early = await h.call('POST', `/api/seller/orders/orders/${m.groupB.id}/cancellation-requests/${req.id}/decline`, seller, { reason: 'already_shipped' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('SHIPMENT_REQUIRED');
    const shipmentId = newId();
    await h.publish('shipping', 'shipping.shipment.created', { shipmentId, kind: 'outbound', orderId: m.order.id, groupId: m.groupB.id, sellerId: m.sellerB, fulfilledBy: 'seller', packageLabel: 'Package 2 of 3', carrierCode: 'ups', carrierName: 'UPS', serviceName: 'Ground', trackingNumber: '1Z999', trackingUrl: 'https://ups.example/1Z999', lines: [{ orderItemId: itemB.id, title: 'Duvet', variantLabel: 'Teal', quantity: 1 }], status: 'label_created' });
    await h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId, kind: 'outbound', orderId: m.order.id, groupId: m.groupB.id, ownerType: 'seller', fulfilledBy: 'seller', sellerId: m.sellerB, lines: [{ orderItemId: itemB.id, title: 'Duvet', variantLabel: 'Teal', quantity: 1 }], shippedAt: new Date().toISOString(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
    const ok = await h.call('POST', `/api/seller/orders/orders/${m.groupB.id}/cancellation-requests/${req.id}/decline`, seller, { reason: 'already_shipped', note: 'Left this morning' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'declined', items: [{ shipped: true }] });
    expect(h.named('orders.cancellation.decided').find((e) => e.cancellationId === req.id)).toMatchObject({ outcome: 'declined' });
  });

  it('refuses a seller cancellation of items on a bought label until the label is voided (G41c)', async () => {
    const m = await mixed();
    const seller = tokens.seller(m.sellerB);
    const itemB = m.groupB.items[0]!;
    const shipmentId = newId();
    await h.publish('shipping', 'shipping.shipment.created', { shipmentId, kind: 'outbound', orderId: m.order.id, groupId: m.groupB.id, sellerId: m.sellerB, fulfilledBy: 'seller', packageLabel: 'Package 2 of 3', carrierCode: 'ups', carrierName: 'UPS', serviceName: 'Ground', trackingNumber: '1Z998', trackingUrl: null, lines: [{ orderItemId: itemB.id, title: 'Duvet', variantLabel: 'Teal', quantity: 1 }], status: 'label_created' });
    const detail = await h.call('GET', `/api/seller/orders/orders/${m.groupB.id}`, seller);
    expect(detail.body.allowedActions).not.toContain('cancel_items');
    const cancel = () => h.call('POST', `/api/seller/orders/orders/${m.groupB.id}/cancel-items`, seller, { items: [{ itemId: itemB.id, quantity: 1 }], reasonCode: 'out_of_stock' }, idem());
    const refused = await cancel();
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'CANCELLATION_NOT_ALLOWED', details: { items: [{ itemId: itemB.id, reason: expect.stringContaining('Void the label first') }] } });
    // the label is voided: the shipment is cancelled and the item can be cancelled
    await h.publish('shipping', 'shipping.shipment.status_changed', { shipmentId, kind: 'outbound', orderId: m.order.id, groupId: m.groupB.id, from: 'label_created', to: 'cancelled', statusLabel: 'Cancelled', estimatedArrival: null, at: new Date().toISOString() });
    expect((await h.call('GET', `/api/seller/orders/orders/${m.groupB.id}`, seller)).body.allowedActions).toContain('cancel_items');
    expect((await cancel()).status).toBe(201);
  });

  it('auto-accepts requests past respondBy when nothing shipped', async () => {
    const m = await mixed();
    const me = tokens.customer(m.customerId);
    const itemB = m.groupB.items[0]!;
    const req = (await h.call('POST', `/api/store/orders/orders/${m.order.id}/cancellations`, me, { items: [{ itemId: itemB.id, quantity: 1 }], reasonCode: 'delivery_too_slow' }, idem())).body.requests[0];
    await h.app.kernel.jobs.runNow('orders.auto-accept-cancellations');
    expect((await h.call('GET', `/api/store/orders/orders/${m.order.id}/cancellations/${req.id}`, me)).body.status).toBe('requested');
    h.clock.advance(5 * 86_400_000);
    await h.app.kernel.jobs.runNow('orders.auto-accept-cancellations');
    await h.app.kernel.events.drain();
    h.clock.set(new Date());
    const after = await h.call('GET', `/api/store/orders/orders/${m.order.id}/cancellations/${req.id}`, me);
    expect(after.body.status).toBe('accepted');
    expect(h.named('orders.cancellation.decided').find((e) => e.cancellationId === req.id)).toMatchObject({ outcome: 'auto_accepted', by: { kind: 'system' } });
    // whole group cancelled before dispatch: shipping is refunded
    expect(after.body.refundPreview.shippingRefund.amount).toBe(500);
  });

  it('refuses shipped items with the alternative, and cancels the whole order when every item is cancelled', async () => {
    const sellerId = newId();
    const customerId = newId();
    const p = product(h, { title: 'Chair', price: 7000, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1, { shipping: 400 })], { sellerId })], { customerId }));
    const me = tokens.customer(customerId);
    const seller = tokens.seller(sellerId);
    const item = order.groups[0]!.items[0]!;
    const res = await h.call('POST', `/api/seller/orders/orders/${order.groups[0]!.id}/cancel-items`, seller, { items: [{ itemId: item.id, quantity: 1 }], reasonCode: 'out_of_stock' }, idem());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'accepted', initiatedBy: 'seller', refundPreview: { total: { amount: 7400 } } });
    expect(h.named('orders.item.cancelled').find((e) => e.itemId === item.id)).toMatchObject({ initiatedBy: 'seller', countsAgainstSeller: true });
    expect(h.named('orders.order.cancelled').find((e) => e.orderId === order.id)).toMatchObject({ reason: 'all_items_cancelled' });
    const detail = await h.call('GET', `/api/store/orders/orders/${order.id}`, me);
    expect(detail.body).toMatchObject({ lifecycle: 'cancelled', status: { value: 'cancelled' }, canCancelSomething: false });
    const opts = await h.call('GET', `/api/store/orders/orders/${order.id}/cancellation-options`, me);
    expect(opts.body.items[0]).toMatchObject({ eligible: false, maxQuantity: 0 });
    const again = await h.call('POST', `/api/store/orders/orders/${order.id}/cancellations`, me, { items: [{ itemId: item.id, quantity: 1 }], reasonCode: 'other' }, idem());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CANCELLATION_NOT_ALLOWED');
  });
});

describe('seller fulfillment tasks', () => {
  it('lists only the seller’s own groups and never another seller’s items', async () => {
    const m = await mixed();
    const seller = tokens.seller(m.sellerA);
    const list = await h.call('GET', '/api/seller/orders/orders', seller);
    expect(list.status).toBe(200);
    expect(list.body.items.map((r: any) => r.id)).toEqual([m.groupA.id]);
    expect(list.body.items[0]).toMatchObject({ orderId: m.order.id, buyerName: 'Sam R.', units: 2, status: 'new', nextAction: 'prepare' });
    const detail = await h.call('GET', `/api/seller/orders/orders/${m.groupA.id}`, seller);
    expect(detail.status).toBe(200);
    expect(detail.body.items.map((i: any) => i.title)).toEqual(['Pocket Speaker']);
    expect(detail.body.mixedOrderNote).toMatch(/other sellers/);
    expect(detail.body.shipTo.line1).toBe('1 Main St');
    expect(detail.body.allowedActions).toEqual(expect.arrayContaining(['start_preparing', 'cancel_items']));
    expect((await h.call('GET', `/api/seller/orders/orders/${m.groupB.id}`, seller)).status).toBe(404);
    expect((await h.call('POST', `/api/seller/orders/orders/${m.groupB.id}/start-preparing`, seller)).status).toBe(404);
    const counts = await h.call('GET', '/api/seller/orders/orders/counts', seller);
    expect(counts.body).toMatchObject({ new: 1, preparing: 0, cancellationRequests: 0 });

    const view = await h.service.getOrderForSeller(m.sellerA, m.order.ref);
    expect(view!.order.groups.map((g) => g.id)).toEqual([m.groupA.id]);
    expect(view!.order.contact.email).not.toBe('sam@example.com');
    expect(await h.service.getOrderForSeller(newId(), m.order.ref)).toBeNull();
  });

  it('marks preparing (single and bulk) and reports a delay with a new date', async () => {
    const m = await mixed();
    const seller = tokens.seller(m.sellerA);
    const prep = await h.call('POST', `/api/seller/orders/orders/${m.groupA.id}/start-preparing`, seller);
    expect(prep.status).toBe(200);
    expect(prep.body.status).toBe('preparing');
    expect(h.named('orders.item.state_changed').some((e) => e.groupId === m.groupA.id && e.to === 'preparing')).toBe(true);
    const bulk = await h.call('POST', '/api/seller/orders/orders/bulk-start-preparing', seller, { orderIds: [m.groupA.id, newId(), m.groupB.id] });
    expect(bulk.body.updated).toBe(1);
    expect(bulk.body.failed).toHaveLength(2);

    const past = await h.call('POST', `/api/seller/orders/orders/${m.groupA.id}/report-delay`, seller, { reason: 'restock', expectedDispatchBy: new Date(Date.now() - 1000).toISOString() });
    expect(past.status).toBe(400);
    const until = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const delay = await h.call('POST', `/api/seller/orders/orders/${m.groupA.id}/report-delay`, seller, { reason: 'supplier_delay', expectedDispatchBy: until });
    expect(delay.status).toBe(200);
    expect(delay.body.status).toBe('delayed');
    expect(delay.body.dispatchDeadline.dueAt).toBe(m.groupA.dispatchDeadline.dueAt); // the performance deadline does not move
    expect(h.named('orders.item.delayed').find((e) => e.groupId === m.groupA.id)).toMatchObject({ source: 'seller', expectedDispatchBy: until, reason: 'supplier_delay' });
    const alerts = await h.service.listDelayedItemsForCustomer(m.customerId);
    expect(alerts[0]).toMatchObject({ orderId: m.order.id, groupId: m.groupA.id, options: ['wait', 'cancel', 'contact_support'] });
    expect((await h.service.countInProgress(m.customerId)).delayedPackages).toBe(1);
  });

  it('refuses preparing while the payment is being checked', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Rug', price: 9000, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId(), paymentState: 'pending_check' }));
    const res = await h.call('POST', `/api/seller/orders/orders/${order.groups[0]!.id}/start-preparing`, tokens.seller(sellerId));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await h.call('GET', `/api/seller/orders/orders/${order.groups[0]!.id}`, tokens.seller(sellerId))).body.paymentAccepted).toBe(false);
  });

  it('gives packing slips with only the seller’s items and exports its own orders', async () => {
    const m = await mixed();
    const seller = tokens.seller(m.sellerA);
    const slip = await h.call('GET', `/api/seller/orders/orders/${m.groupA.id}/packing-slip?hidePrices=true`, seller);
    expect(slip.status).toBe(200);
    expect(slip.body.fileName).toMatch(/^packing-slip-MK-/);
    const many = await h.call('POST', '/api/seller/orders/packing-slips', seller, { orderIds: [m.groupA.id] });
    expect(many.status).toBe(200);
    expect((await h.call('GET', `/api/seller/orders/orders/${m.groupB.id}/packing-slip`, seller)).status).toBe(404);

    const exp = await h.call('POST', '/api/seller/orders/exports', seller, { filters: { tab: 'new' }, format: 'csv' });
    expect(exp.status).toBe(202);
    expect(h.exports.requested.at(-1)).toMatchObject({ dataset: 'orders.seller.orders', sellerId: m.sellerA });
    expect(h.audits.at(-1)).toMatchObject({ action: 'orders.export', module: 'orders' });
    const got = await h.call('GET', `/api/seller/orders/exports/${exp.body.id}`, seller);
    expect(got.status).toBe(200);
    expect((await h.call('GET', `/api/seller/orders/exports/${exp.body.id}`, tokens.seller(newId()))).status).toBe(404);
    const rows = await h.service.exportRows('orders.seller.orders', {}, { kind: 'seller', sessionId: newId(), sellerId: m.sellerA, accountId: newId() } as never);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ ref: m.order.ref, buyerName: 'Sam R.' });
  });
});
