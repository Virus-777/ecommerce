import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { checkout, group, harness, line, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

describe('placing orders', () => {
  it('creates an accepted order with one group per seller, frozen snapshots, documents and events', async () => {
    const customerId = newId();
    const sellerA = newId();
    const sellerB = newId();
    const pa = product(h, { title: 'Halden Pocket Speaker', price: 4999, sellerId: sellerA, sellerName: 'Pixel & Port' });
    const pb = product(h, { title: 'Linen Duvet', price: 12900, sellerId: sellerB, sellerName: 'Casa Verde Home', options: { Size: 'Queen', Color: 'Sage' } });
    const po = product(h, { title: 'Cast Iron Skillet', price: 3500, ownerType: 'official' });
    const input = checkout(
      [
        group(h, [line(pa, 2, { discount: 1000, shipping: 500, tax: 400 })], { sellerId: sellerA }),
        group(h, [line(pb, 1, { tax: 900 })], { sellerId: sellerB }),
        group(h, [line(po, 1)], { ownerType: 'official' }),
      ],
      { customerId },
    );
    const order = await h.service.createOrder(input);
    await h.app.kernel.events.drain();

    expect(order.ref).toMatch(/^MK-\d{6}-\d{5}$/);
    expect(order.lifecycle).toBe('open');
    expect(order.status.value).toBe('confirmed');
    expect(order.groups).toHaveLength(3);
    expect(order.groups.map((g) => g.packageLabel)).toEqual(['Package 1 of 3', 'Package 2 of 3', 'Package 3 of 3']);
    expect(order.groups[2]!.seller).toMatchObject({ ownerType: 'official', id: null });
    expect(order.groups[2]!.handlingNote).toBe('Official Store item. Marketly handles returns.');
    const speaker = order.groups[0]!.items[0]!;
    expect(speaker).toMatchObject({ title: 'Halden Pocket Speaker', variantLabel: 'Teal', quantity: 2, state: 'confirmed' });
    expect(speaker.paidAmount.amount).toBe(2 * 4999 - 1000 + 500 + 400);
    expect(speaker.offer).toMatchObject({ condition: 'new', conditionLabel: 'New', dispatchLabel: 'Ships in 1 business day', warranty: '2-year manufacturer warranty' });
    expect(order.summaryLine).toBe(`4 items from 3 sellers · $${(order.totals.total.amount / 100).toFixed(2)}`);
    expect(order.documents.map((d) => d.kind)).toEqual(['receipt', 'invoice', 'invoice', 'invoice']);
    expect(order.policyVersions).toHaveLength(1);

    const placed = h.named('orders.order.placed').find((e) => e.orderId === order.id);
    expect(placed).toMatchObject({ ref: order.ref, paymentState: 'accepted', customerId, guestEmail: null });
    expect(placed.groups).toHaveLength(3);
    const accepted = h.named('orders.order.accepted').find((e) => e.orderId === order.id);
    expect(accepted.groups.map((g: any) => g.itemIds.length)).toEqual([1, 1, 1]);
    expect(h.named('orders.item.state_changed').filter((e) => e.orderId === order.id).every((e) => e.from === 'pending_payment' && e.to === 'confirmed')).toBe(true);

    // the snapshot is frozen: a later catalog change never alters the order
    h.products.get(pa.variantId)!.title = 'Renamed speaker';
    const again = await h.service.getOrder(order.id);
    expect(again!.groups[0]!.items[0]!.title).toBe('Halden Pocket Speaker');
  });

  it('is idempotent per checkout session: the same attempt returns the same order', async () => {
    const p = product(h, { title: 'Mug', price: 1200, sellerId: newId() });
    const input = checkout([group(h, [line(p, 1)], { sellerId: h.offers.get(p.offerId)!.sellerId })], { customerId: newId() });
    const [a, b] = await Promise.all([h.service.createOrder(input), h.service.createOrder(input)]);
    const c = await h.service.createOrder(input);
    expect(a.id).toBe(b.id);
    expect(c.id).toBe(a.id);
    await h.app.kernel.events.drain();
    expect(h.named('orders.order.placed').filter((e) => e.checkoutSessionId === input.checkoutSessionId)).toHaveLength(1);
  });

  it('rejects an incomplete order or an offer of another seller', async () => {
    const p = product(h, { title: 'Lamp', price: 2000, sellerId: newId() });
    await expect(h.service.createOrder(checkout([], { customerId: newId() }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId: newId() })], { customerId: newId() }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('keeps a pending payment as payment_pending, then accepts it on payments.payment.authorized', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Kettle', price: 5400, sellerId });
    const input = checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId(), paymentState: 'pending_check' });
    const order = await h.service.createOrder(input);
    await h.app.kernel.events.drain();
    expect(order.lifecycle).toBe('payment_pending');
    expect(order.status).toEqual({ value: 'payment_pending', flags: ['payment_checking'] });
    expect(order.groups[0]!.items[0]!.state).toBe('pending_payment');
    expect(h.named('orders.order.accepted').some((e) => e.orderId === order.id)).toBe(false);

    await h.publish('payments', 'payments.payment.authorized', { intentId: input.paymentIntentId, checkoutSessionId: input.checkoutSessionId, orderId: order.id, amount: { amount: 5400, currency: 'USD' }, methodLabel: 'Visa •••• 4417', at: new Date().toISOString() });
    const after = await h.service.getOrder(order.id);
    expect(after!.lifecycle).toBe('open');
    expect(after!.groups[0]!.items[0]!.state).toBe('confirmed');
    expect(h.named('orders.order.accepted').filter((e) => e.orderId === order.id)).toHaveLength(1);
    // idempotent
    await h.service.acceptOrder(order.id, input.paymentIntentId);
    expect(h.named('orders.order.accepted').filter((e) => e.orderId === order.id)).toHaveLength(1);
  });

  it('cancels a pending order when the payment is finally declined', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Blender', price: 8800, sellerId });
    const input = checkout([group(h, [line(p, 1)], { sellerId })], { paymentState: 'pending_check' });
    const order = await h.service.createOrder(input);
    await h.publish('payments', 'payments.payment.failed', { intentId: input.paymentIntentId, checkoutSessionId: input.checkoutSessionId, orderId: order.id, declineCategory: 'insufficient_funds', afterPendingCheck: true, at: new Date().toISOString() });
    const after = await h.service.getOrder(order.id);
    expect(after!.lifecycle).toBe('cancelled');
    expect(after!.status.value).toBe('cancelled');
    expect(h.named('orders.order.cancelled').find((e) => e.orderId === order.id)).toMatchObject({ reason: 'payment_declined', checkoutSessionId: input.checkoutSessionId });
    await expect(h.service.acceptOrder(order.id, input.paymentIntentId)).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('records captures as payment progress without touching delivery', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Toaster', price: 3000, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId() }));
    const capture = { intentId: order.paymentIntentId!, captureId: newId(), orderId: order.id, groupId: null, amount: { amount: 3000, currency: 'USD' }, allocations: [], capturedAt: new Date().toISOString() };
    await h.publish('payments', 'payments.payment.captured', capture);
    await h.publish('payments', 'payments.payment.captured', capture);
    const after = await h.service.getOrder(order.id);
    expect(after!.progress.payment.amountCharged.amount).toBe(3000);
    expect(after!.progress.delivery.state).toBe('not_shipped');
  });
});

describe('public API reads', () => {
  it('finds guest orders by reference and email, and attaches them when the email is verified', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Candle', price: 1500, sellerId });
    const email = `guest-${newId().slice(0, 8)}@example.com`;
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { email }));
    expect(await h.service.findGuestOrder(order.ref.toLowerCase(), email.toUpperCase())).toEqual({ orderId: order.id, signInRequired: false });
    expect(await h.service.findGuestOrder(order.ref, 'other@example.com')).toBeNull();
    expect((await h.service.listGuestOrdersByEmail(email)).map((o) => o.ref)).toEqual([order.ref]);

    const accountId = newId();
    await h.publish('identity', 'identity.user.verified', { accountId, channel: 'email', email, phone: null, guestSessionId: null, at: new Date().toISOString() });
    expect(await h.service.listGuestOrdersByEmail(email)).toEqual([]);
    const res = await h.call('GET', `/api/store/orders/orders/${order.id}`, tokens.customer(accountId));
    expect(res.status).toBe(200);
    expect(res.body.contact.kind).toBe('customer');
    // G29e: now a registered customer's order: the lookup asks to sign in, with the right email or a wrong one
    expect(await h.service.findGuestOrder(order.ref, email)).toEqual({ signInRequired: true });
    expect(await h.service.findGuestOrder(order.ref, 'other@example.com')).toEqual({ signInRequired: true });
  });

  it('counts purchases and answers paid amounts per item', async () => {
    const customerId = newId();
    const sellerId = newId();
    const p = product(h, { title: 'Pen', price: 300, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 3, { discount: 100, tax: 30 })], { sellerId })], { customerId }));
    expect(await h.service.countPurchased(customerId, p.offerId, 30)).toBe(3);
    const paid = await h.service.getPaidAmounts(order.id);
    expect(paid[0]).toMatchObject({ quantity: 3, ownerType: 'seller', sellerId, itemAmount: { amount: 900 }, discountShare: { amount: 100 }, taxShare: { amount: 30 }, paid: { amount: 830 } });
    expect((await h.service.countOrderItemsForProducts([p.productId]))[p.productId]).toEqual({ open: 1, past: 0 });
    const inCategory = await h.service.countOpenOrdersInCategory(h.products.get(p.variantId)!.categoryId!, new Date(Date.now() + 60_000).toISOString());
    expect(inCategory.items).toBeGreaterThanOrEqual(1);
    expect(await h.service.isVerifiedPurchase(customerId, p.productId)).toBeNull();
  });
});
