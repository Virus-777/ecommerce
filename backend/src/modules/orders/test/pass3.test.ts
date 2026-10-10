/**
 * Gap pass 3: orders per payment attempt, the placed event's new fields, orders.item.split on every line split,
 * notifyCustomer on staff cancellations, support case resolved/reopened, hasPlacedOrder and snapshot images.
 */
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

const now = () => new Date().toISOString();

describe('orders per payment attempt', () => {
  it('a retry after a finally declined pending payment creates a new order with the next attemptNo', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Kettle', price: 5400, sellerId });
    const first = checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId(), paymentState: 'pending_check' });
    const declined = await h.service.createOrder(first);
    await h.publish('payments', 'payments.payment.failed', { intentId: first.paymentIntentId, checkoutSessionId: first.checkoutSessionId, orderId: declined.id, declineCategory: 'insufficient_funds', afterPendingCheck: true, at: now() });
    expect((await h.service.getOrder(declined.id))!.lifecycle).toBe('cancelled');

    // same session, attempt 2: before pass 3 this returned the cancelled order
    const retry = { ...first, attemptNo: 2, paymentIntentId: newId(), paymentState: 'accepted' as const };
    const second = await h.service.createOrder(retry);
    expect(second.id).not.toBe(declined.id);
    expect(second.lifecycle).toBe('open');
    expect((await h.service.createOrder(retry)).id).toBe(second.id); // idempotent per (session, attempt)
    expect((await h.service.createOrder(first)).id).toBe(declined.id);
    await h.app.kernel.events.drain();
    expect(h.named('orders.order.placed').filter((e) => e.checkoutSessionId === first.checkoutSessionId).map((e) => e.attemptNo)).toEqual([1, 2]);

    // a late authorization for the session finds the latest attempt
    await h.publish('payments', 'payments.payment.authorized', { intentId: retry.paymentIntentId, checkoutSessionId: first.checkoutSessionId, orderId: null, amount: { amount: 5400, currency: 'USD' }, methodLabel: 'Visa', at: now() });
    expect((await h.service.getOrder(declined.id))!.lifecycle).toBe('cancelled');
  });

  it('publishes attemptNo, deliveryAddressId, contactName and visitorId on orders.order.placed', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Mug', price: 1200, sellerId });
    const deliveryAddressId = newId();
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { visitorId: 'v-123', deliveryAddressId }));
    await h.app.kernel.events.drain();
    expect(h.named('orders.order.placed').find((e) => e.orderId === order.id)).toMatchObject({ attemptNo: 1, deliveryAddressId, contactName: 'Gia Guest', visitorId: 'v-123' });
    const plain = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId() }));
    await h.app.kernel.events.drain();
    expect(h.named('orders.order.placed').find((e) => e.orderId === plain.id)).toMatchObject({ attemptNo: 1, deliveryAddressId: null, visitorId: null, contactName: 'Sam Rivera' });
  });

  it('keeps each item snapshot image for the order (media usage order_evidence) and shows checkoutLineId', async () => {
    const sellerId = newId();
    const imageId = newId();
    const p = product(h, { title: 'Lamp', price: 2000, sellerId, imageId });
    const l = line(p, 1);
    const order = await h.service.createOrder(checkout([group(h, [l], { sellerId })], { customerId: newId() }));
    expect(h.attached).toContainEqual({ assetId: imageId, usage: expect.objectContaining({ module: 'orders', kind: 'order_evidence', refId: order.id }) });
    expect(order.groups[0]!.items[0]!.checkoutLineId).toBe(l.checkoutLineId);
  });
});

describe('hasPlacedOrder', () => {
  it('counts accepted orders of the customer or the guest email, not pending or declined ones', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Pen', price: 300, sellerId });
    const customerId = newId();
    expect(await h.service.hasPlacedOrder({ customerId })).toBe(false);
    const pending = checkout([group(h, [line(p, 1)], { sellerId })], { customerId, paymentState: 'pending_check' });
    const o = await h.service.createOrder(pending);
    expect(await h.service.hasPlacedOrder({ customerId })).toBe(false);
    await h.publish('payments', 'payments.payment.failed', { intentId: pending.paymentIntentId, checkoutSessionId: pending.checkoutSessionId, orderId: o.id, declineCategory: 'do_not_honor', afterPendingCheck: true, at: now() });
    expect(await h.service.hasPlacedOrder({ customerId })).toBe(false);
    await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId }));
    expect(await h.service.hasPlacedOrder({ customerId })).toBe(true);

    const email = `New-${newId().slice(0, 8)}@Example.com`;
    expect(await h.service.hasPlacedOrder({ email })).toBe(false);
    await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { email }));
    expect(await h.service.hasPlacedOrder({ email: ` ${email.toLowerCase()} ` })).toBe(true);
    expect(await h.service.hasPlacedOrder({})).toBe(false);
  });
});

describe('orders.item.split', () => {
  it('is published when a partial cancellation splits a line, before the cancellation event', async () => {
    const sellerId = newId();
    const accountId = newId();
    const p = product(h, { title: 'Glass', price: 800, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 3)], { sellerId })], { customerId: accountId }));
    const item = order.groups[0]!.items[0]!;
    const res = await h.call('POST', `/api/admin/orders/orders/${order.id}/cancel-items`, tokens.staff(), { items: [{ itemId: item.id, quantity: 1 }], reasonCode: 'seller_cannot_fulfill', reason: 'Broken in stock', notifyCustomer: true }, idem());
    expect(res.status).toBe(201);
    const split = h.named('orders.item.split').filter((e) => e.orderId === order.id);
    expect(split).toHaveLength(1);
    const after = (await h.service.getOrder(order.id))!.groups[0]!.items;
    const rest = after.find((i) => i.id !== item.id)!;
    expect(split[0]).toMatchObject({ itemId: item.id, newItemId: rest.id, rootItemId: item.id, offerId: p.offerId, stockItemId: p.stockItemId, quantity: 2, remainingQuantity: 1, reason: 'cancellation', groupId: order.groups[0]!.id });
    expect(rest).toMatchObject({ quantity: 2, splitFromItemId: item.id, state: 'confirmed' });
    // inventory sees the split before the cancellation of the remaining line
    const names = h.events.filter((e) => e.payload?.orderId === order.id).map((e) => e.name);
    expect(names.indexOf('orders.item.split')).toBeLessThan(names.indexOf('orders.item.cancelled'));
  });

  it('is published when a shipment takes part of a line, with the chain root for a line split off before', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Plate', price: 1000, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 4)], { sellerId })], { customerId: newId() }));
    const g = order.groups[0]!;
    const item = g.items[0]!;
    await h.call('POST', `/api/admin/orders/orders/${order.id}/cancel-items`, tokens.staff(), { items: [{ itemId: item.id, quantity: 1 }], reasonCode: 'customer_request', reason: 'Asked by phone', notifyCustomer: true }, idem());
    const rest = (await h.service.getOrder(order.id))!.groups[0]!.items.find((i) => i.id !== item.id)!;
    const shipmentId = newId();
    const lines = [{ orderItemId: rest.id, quantity: 1, title: 'Plate', variantLabel: '' }];
    await h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId, kind: 'outbound', orderId: order.id, groupId: g.id, ownerType: 'seller', sellerId, lines, shippedAt: now(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
    const ship = h.named('orders.item.split').find((e) => e.orderId === order.id && e.reason === 'shipment');
    expect(ship).toMatchObject({ itemId: rest.id, rootItemId: item.id, quantity: 2, remainingQuantity: 1 });
  });
});

describe('notifyCustomer on staff cancellations', () => {
  it('carries notifyCustomer false from cancelItemsAdmin, true otherwise', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Bowl', price: 1800, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1), line(product(h, { title: 'Cup', price: 900, sellerId }), 1)], { sellerId })], { customerId: newId() }));
    const [a, b] = order.groups[0]!.items;
    await h.call('POST', `/api/admin/orders/orders/${order.id}/cancel-items`, tokens.staff(), { items: [{ itemId: a!.id, quantity: 1 }], reasonCode: 'risk_review', reason: 'Trust case', notifyCustomer: false }, idem());
    expect(h.named('orders.item.cancelled').find((e) => e.itemId === a!.id)).toMatchObject({ notifyCustomer: false, initiatedBy: 'staff' });
    await h.call('POST', `/api/seller/orders/orders/${order.groups[0]!.id}/cancel-items`, tokens.seller(sellerId), { items: [{ itemId: b!.id, quantity: 1 }], reasonCode: 'out_of_stock' }, idem());
    expect(h.named('orders.item.cancelled').find((e) => e.itemId === b!.id)).toMatchObject({ notifyCustomer: true, initiatedBy: 'seller' });
  });
});

describe('support cases resolved and reopened', () => {
  it('clears the case_open flag on resolve, sets it again on reopen, and ignores a redelivered event', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Rug', price: 9900, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId() }));
    const itemId = order.groups[0]!.items[0]!.id;
    const caseId = newId();
    const base = { caseId, ref: 'CS-261010-0001', orderId: order.id, orderItemIds: [itemId], customerId: null, sellerId };
    await h.publish('support', 'support.case.opened', { ...base, kind: 'order', category: 'not_received', priority: 'normal', handler: 'seller', nextResponseDueAt: null });
    expect((await h.service.getOrder(order.id))!.status.flags).toContain('case_open');

    const resolved = { id: newId(), name: 'support.case.resolved', payload: { ...base, resolvedAt: now() } };
    await h.publish('support', 'support.case.resolved', resolved.payload);
    expect((await h.service.getOrder(order.id))!.status.flags).not.toContain('case_open');

    await h.publish('support', 'support.case.reopened', { ...base, by: { kind: 'customer', id: null }, reason: 'Still missing' });
    expect((await h.service.getOrder(order.id))!.status.flags).toContain('case_open');

    // the same resolved event delivered again (same envelope id) changes nothing
    await h.service.onCaseResolvedFromSupport(resolved.payload, resolved.id);
    await h.service.onCaseResolvedFromSupport(resolved.payload, resolved.id);
    expect((await h.service.getOrder(order.id))!.status.flags).not.toContain('case_open');
    await h.service.onCaseReopenedFromSupport({ ...base, by: { kind: 'customer', id: null }, reason: 'again' }, 'reopen-1');
    await h.service.onCaseResolvedFromSupport(resolved.payload, resolved.id);
    expect((await h.service.getOrder(order.id))!.status.flags).toContain('case_open');
  });
});
