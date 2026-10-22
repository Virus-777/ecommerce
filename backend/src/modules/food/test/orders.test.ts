import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { item, pizzeria, regular, section } from './fixtures.js';
import { ADDRESS, ADDRESS_ID, boot, newId, START, usd, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const card = (token: string) => ({ kind: 'new_card', providerToken: token });
const RETURN = 'https://app.marketly.example/food/return';

/** A customer with a pizza ($14.50) and a lemonade ($3.50) in the basket: $18.00 + $1.99 delivery = $19.99 */
async function shopper(over: Record<string, unknown> = {}) {
  const shop = await pizzeria(k, over);
  const accountId = newId();
  const me = k.customer(accountId);
  await k.store('POST', '/basket/lines', { itemId: shop.pizza.id, quantity: 1, options: regular }, me);
  const basket = (await k.store('POST', '/basket/lines', { itemId: shop.drink.id, quantity: 1 }, me)).body;
  return { ...shop, accountId, me, basket };
}
const place = (me: Record<string, string>, total: { amount: number; currency: string }, token = 'tok_visa', over: Record<string, unknown> = {}, key = newId()) =>
  k.store('POST', '/orders', { addressId: ADDRESS_ID, expectedTotal: total, method: card(token), returnUrl: RETURN, courierNote: 'Ring twice', ...over }, { ...me, 'idempotency-key': key });
const move = (id: string, action: string, over: Record<string, unknown> = {}) => k.admin('POST', `/orders/${id}/status`, { action, ...over });

describe('placing an order', () => {
  it('authorizes the card, places the order, empties the basket and tells the customer', async () => {
    const { r, me, basket } = await shopper({ name: 'Napoli Corner' });
    expect(basket.total).toEqual(usd(1999));
    const key = newId();
    const res = await place(me, basket.total, 'tok_visa', {}, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const o = res.body;
    expect(o.ref).toMatch(/^FD-[2-9A-HJ-NP-Z]{5}$/);
    expect(o).toMatchObject({ status: 'placed', statusLabel: 'Waiting for Napoli Corner to accept', etaLabel: 'Usually 20–30 min', total: usd(1999), subtotal: usd(1800), deliveryFee: usd(199), itemCount: 2, canCancel: true, canReview: false, courierNote: 'Ring twice', contactPhone: ADDRESS.phone, address: ADDRESS });
    expect(o.lines[0]).toMatchObject({ name: 'Margherita pizza 12"', optionsLabel: '12" regular', unitPrice: usd(1450), quantity: 1 });
    expect(o.payment).toMatchObject({ state: 'accepted', module: 'food', refId: o.id, amount: usd(1999) });
    expect(o.history.map((h: any) => h.status)).toEqual(['payment_pending', 'placed']);
    expect(o.restaurant.id).toBe(r.id);
    expect((await k.store('GET', '/basket', undefined, me)).body.lines).toEqual([]);
    expect(k.events.filter((e) => e.payload.orderId === o.id).map((e) => e.payload)).toEqual([{ orderId: o.id, ref: o.ref, customerId: expect.any(String), restaurantName: 'Napoli Corner', status: 'placed', note: null }]);
    // the same key answers the same order
    expect((await place(me, basket.total, 'tok_visa', {}, key)).body.id).toBe(o.id);
    expect((await k.store('GET', '/orders?state=open', undefined, me)).body.items.map((x: any) => x.id)).toEqual([o.id]);
    expect((await k.store('GET', `/orders/${o.id}`, undefined, k.customer(newId()))).status).toBe(404);
    // a restaurant with orders can't be deleted
    expect((await k.admin('DELETE', `/restaurants/${r.id}`)).body.error.code).toBe('IN_USE');
  });

  it('refuses an empty basket, a changed total, the minimum, a closed restaurant, unavailable items and an unknown address', async () => {
    expect((await place(k.customer(newId()), usd(100))).body.error.code).toBe('BASKET_EMPTY');
    const { me, basket, drink, r } = await shopper({ minOrder: usd(1200), name: 'Corner Two' });
    const changed = (await place(me, usd(1500))).body.error;
    expect(changed).toMatchObject({ code: 'PRICE_CHANGED', details: { total: basket.total } });
    expect((await place(me, basket.total, 'tok_visa', { addressId: newId() })).status).toBe(404);

    const other = k.customer(newId());
    const small = (await k.store('POST', '/basket/lines', { itemId: drink.id, quantity: 1 }, other)).body;
    expect((await place(other, small.total)).body.error).toMatchObject({ code: 'BELOW_MINIMUM', details: { missing: usd(850) } });

    // it is noon: a restaurant opening at 1 PM is closed
    const later = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((weekday) => ({ weekday, open: true, from: '13:00', to: '23:00' }));
    await k.admin('PATCH', `/restaurants/${r.id}`, { name: r.name, cuisine: r.cuisine, deliveryMinMinutes: 20, deliveryMaxMinutes: 30, deliveryFee: usd(199), hours: later });
    expect((await place(me, basket.total)).body.error).toMatchObject({ code: 'RESTAURANT_CLOSED', details: { opensLabel: 'opens 1 PM' } });
    await k.admin('PATCH', `/restaurants/${r.id}`, { name: r.name, cuisine: r.cuisine, deliveryMinMinutes: 20, deliveryMaxMinutes: 30, deliveryFee: usd(199), hours: null });

    await k.admin('PATCH', `/items/${drink.id}`, { sectionId: drink.sectionId, name: drink.name, price: usd(350), available: false });
    expect((await place(me, basket.total)).body.error).toMatchObject({ code: 'ITEM_UNAVAILABLE', details: { itemIds: [drink.id] } });
    expect((await k.store('GET', '/orders', undefined, me)).body.items).toEqual([]);
    void r;
  });

  it('keeps the basket when the card is declined, and places the order on a retry', async () => {
    const { me, basket } = await shopper();
    const failed = (await place(me, basket.total, 'tok_declined')).body;
    expect(failed).toMatchObject({ status: 'payment_failed', statusLabel: 'Payment failed', canCancel: false, payment: { state: 'failed', decline: { code: '05' } } });
    expect((await k.store('GET', '/basket', undefined, me)).body.lines).toHaveLength(2);
    expect(k.events.find((e) => e.payload.orderId === failed.id)?.payload.status).toBe('payment_failed');
    // only failed orders are retried
    const retried = await k.store('POST', `/orders/${failed.id}/retry`, { method: card('tok_visa'), returnUrl: RETURN }, me);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({ status: 'placed', payment: { state: 'accepted' } });
    expect(retried.body.history.map((h: any) => h.status)).toEqual(['payment_pending', 'payment_failed', 'payment_pending', 'placed']);
    expect((await k.store('POST', `/orders/${failed.id}/retry`, { method: card('tok_visa'), returnUrl: RETURN }, me)).body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await k.store('GET', '/basket', undefined, me)).body.lines).toEqual([]);
  });

  it('waits for the bank challenge and places the order when it is finished', async () => {
    const { me, basket } = await shopper();
    const waiting = (await place(me, basket.total, 'tok_3ds')).body;
    expect(waiting).toMatchObject({ status: 'payment_pending', payment: { state: 'requires_action', nextAction: { kind: 'three_ds_challenge' } } });
    expect((await k.store('GET', '/basket', undefined, me)).body.lines).toHaveLength(2);
    const done = await k.store('POST', `/orders/${waiting.id}/complete-action`, { resultToken: '3ds_ok' }, me);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('placed');
    expect((await k.store('GET', '/basket', undefined, me)).body.lines).toEqual([]);
    expect((await k.store('POST', `/orders/${waiting.id}/complete-action`, { resultToken: '3ds_ok' }, me)).body.error.code).toBe('ILLEGAL_TRANSITION');

    // a failed challenge: payment failed
    const second = await shopper();
    const w2 = (await place(second.me, second.basket.total, 'tok_3ds')).body;
    expect((await k.store('POST', `/orders/${w2.id}/complete-action`, { resultToken: 'nope' }, second.me)).body.status).toBe('payment_failed');
  });

  it('places an order whose payment is checked later when payments says it went through', async () => {
    const { me, basket, accountId } = await shopper();
    const waiting = (await place(me, basket.total, 'tok_pending')).body;
    expect(waiting).toMatchObject({ status: 'payment_pending', statusLabel: 'Confirming your payment', payment: { state: 'pending' } });
    const settled = await k.call('POST', `/api/dev/payments/intents/${waiting.payment.intentId}/settle`, { outcome: 'authorized' }, k.customer(accountId));
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    const now = (await k.store('GET', `/orders/${waiting.id}`, undefined, me)).body;
    expect(now.status).toBe('placed');
    expect((await k.store('GET', '/basket', undefined, me)).body.lines).toEqual([]);
  });
});

describe('moving an order', () => {
  it('goes from accepted to delivered on the restaurant’s behalf and charges the card on delivery', async () => {
    const { me, basket } = await shopper({ name: 'Harbor Grill Test' });
    const o = (await place(me, basket.total)).body;
    const admin = (await k.admin('GET', `/orders/${o.id}`)).body;
    expect(admin).toMatchObject({ actions: ['accept', 'decline', 'cancel'], customer: { id: expect.any(String) }, paymentState: 'accepted', intentId: o.payment.intentId });
    expect((await move(o.id, 'deliver')).body.error.code).toBe('ILLEGAL_TRANSITION');

    k.clock.set(new Date('2030-01-10T03:18:00Z')); // 7:18 PM
    const accepted = (await move(o.id, 'accept', { staffNote: 'Called the kitchen' })).body;
    expect(accepted).toMatchObject({ status: 'accepted', etaLabel: 'Arrives 7:40–7:50 PM', staffNote: 'Called the kitchen', actions: ['prepare', 'send', 'cancel'] });
    expect((await k.store('GET', `/orders/${o.id}`, undefined, me)).body).toMatchObject({ statusLabel: 'Accepted by Harbor Grill Test', etaLabel: 'Arrives 7:40–7:50 PM', canCancel: false });
    expect((await move(o.id, 'prepare')).body.statusLabel).toBe('Preparing your food');
    expect((await move(o.id, 'send')).body.statusLabel).toBe('On the way');
    const delivered = (await move(o.id, 'deliver')).body;
    expect(delivered).toMatchObject({ status: 'delivered', paymentState: 'captured', actions: [] });
    expect(delivered.history.map((h: any) => h.status)).toEqual(['payment_pending', 'placed', 'accepted', 'preparing', 'on_the_way', 'delivered']);
    expect(delivered.history[2].by).toBeTruthy();
    const mine = (await k.store('GET', `/orders/${o.id}`, undefined, me)).body;
    expect(mine).toMatchObject({ statusLabel: 'Delivered', canReview: true, etaLabel: null, payment: { state: 'captured' } });
    expect(mine.history.every((h: any) => h.by === null)).toBe(true);
    expect(mine.deliveredAt).toBeTruthy();
    expect(k.events.filter((e) => e.payload.orderId === o.id).map((e) => e.payload.status)).toEqual(['placed', 'accepted', 'preparing', 'on_the_way', 'delivered']);
    expect(k.audits.filter((a) => a.target.id === o.id).map((a) => a.action)).toEqual(['food.order.accept', 'food.order.prepare', 'food.order.send', 'food.order.deliver']);
    k.clock.set(START);
    expect((await k.admin('GET', `/orders?q=${o.ref}`)).body.items.map((x: any) => x.id)).toEqual([o.id]);
    expect((await move(o.id, 'accept', {}, )).status).toBe(409);
    expect((await k.admin('POST', `/orders/${o.id}/status`, { action: 'accept' }, k.staff(['food.view']))).status).toBe(403);
  });

  it('keeps the order on the way when the card can’t be charged', async () => {
    // $10.23 + $1.99 = $12.22: the development processor fails captures of amounts ending in 22
    const shop = await pizzeria(k);
    const s = await section(k, shop.r.id, 'Specials');
    const special = await item(k, shop.r.id, s.id, { name: 'Odd special', price: usd(1023) });
    const me = k.customer(newId());
    const basket = (await k.store('POST', '/basket/lines', { itemId: special.id, quantity: 1 }, me)).body;
    expect(basket.total).toEqual(usd(1222));
    const o = (await place(me, basket.total)).body;
    await move(o.id, 'accept');
    await move(o.id, 'send');
    const res = await move(o.id, 'deliver');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_CAPTURE_FAILED');
    expect((await k.admin('GET', `/orders/${o.id}`)).body).toMatchObject({ status: 'on_the_way', actions: ['deliver', 'cancel'] });
  });

  it('voids the payment when the restaurant declines or the customer cancels', async () => {
    const a = await shopper();
    const declined = (await place(a.me, a.basket.total)).body;
    const res = (await move(declined.id, 'decline', { note: 'Out of mozzarella' })).body;
    expect(res).toMatchObject({ status: 'declined', restaurantNote: 'Out of mozzarella', paymentState: 'voided' });
    expect((await k.store('GET', `/orders/${declined.id}`, undefined, a.me)).body).toMatchObject({ statusLabel: 'Declined by the restaurant', restaurantNote: 'Out of mozzarella', payment: { state: 'voided' } });
    expect(k.events.findLast((e) => e.payload.orderId === declined.id)?.payload).toMatchObject({ status: 'declined', note: 'Out of mozzarella' });

    const b = await shopper();
    const placed = (await place(b.me, b.basket.total)).body;
    const cancelled = await k.store('POST', `/orders/${placed.id}/cancel`, { reason: 'Ordered twice' }, b.me);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', statusLabel: 'Cancelled', payment: { state: 'voided' } });
    expect((await k.store('POST', `/orders/${placed.id}/cancel`, {}, b.me)).body.error.code).toBe('ILLEGAL_TRANSITION');

    const c = await shopper();
    const accepted = (await place(c.me, c.basket.total)).body;
    await move(accepted.id, 'accept');
    expect((await k.store('POST', `/orders/${accepted.id}/cancel`, {}, c.me)).body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await move(accepted.id, 'cancel', { note: 'Courier unavailable' })).body).toMatchObject({ status: 'cancelled', paymentState: 'voided' });
  });

  it('declines orders not accepted in time and drops ones left in a bank challenge', async () => {
    k.settingsValues['food.acceptMinutes'] = 10;
    const a = await shopper();
    const placed = (await place(a.me, a.basket.total)).body;
    const b = await shopper();
    const challenged = (await place(b.me, b.basket.total, 'tok_3ds')).body;
    k.clock.set(new Date(START.getTime() + 5 * 60_000));
    await k.app.kernel.jobs.runNow('food.expire-unaccepted');
    await k.app.kernel.events.drain();
    expect((await k.admin('GET', `/orders/${placed.id}`)).body.status).toBe('placed');

    k.clock.set(new Date(START.getTime() + 11 * 60_000));
    await k.app.kernel.jobs.runNow('food.expire-unaccepted');
    await k.app.kernel.events.drain();
    expect((await k.admin('GET', `/orders/${placed.id}`)).body).toMatchObject({ status: 'declined', paymentState: 'voided', restaurantNote: "The restaurant didn't accept the order in time" });
    expect((await k.admin('GET', `/orders/${challenged.id}`)).body.status).toBe('payment_pending');

    k.clock.set(new Date(START.getTime() + 31 * 60_000));
    await k.app.kernel.jobs.runNow('food.expire-unaccepted');
    await k.app.kernel.events.drain();
    expect((await k.admin('GET', `/orders/${challenged.id}`)).body.status).toBe('cancelled');
    delete k.settingsValues['food.acceptMinutes'];
    k.clock.set(START);
  });
});

describe('reviews', () => {
  it('rates a delivered order once, for the restaurant and every item, and hides it on moderation', async () => {
    const { me, basket, accountId, r, pizza, drink } = await shopper();
    const o = (await place(me, basket.total)).body;
    expect((await k.store('POST', `/orders/${o.id}/review`, { stars: 5 }, me)).body.error.code).toBe('ILLEGAL_TRANSITION');
    for (const a of ['accept', 'send', 'deliver']) await move(o.id, a);
    k.names.set((await k.admin('GET', `/orders/${o.id}`)).body.customer.id, 'Dana Ross');
    const rated = await k.store('POST', `/orders/${o.id}/review`, { stars: 4, text: 'Hot and quick' }, me);
    expect(rated.status, JSON.stringify(rated.body)).toBe(200);
    expect(rated.body).toMatchObject({ canReview: false, review: { name: 'Dana R.', stars: 4, text: 'Hot and quick' } });
    expect((await k.store('POST', `/orders/${o.id}/review`, { stars: 5 }, me)).body.error.code).toBe('ALREADY_REVIEWED');

    const page = (await k.store('GET', `/restaurants/${r.slug}`)).body;
    expect(page.ratings).toEqual({ average: 4, count: 1, stars: [0, 1, 0, 0, 0] });
    expect((await k.store('GET', `/items/${pizza.id}`)).body).toMatchObject({ rating: 4, ratingCount: 1 });
    expect((await k.store('GET', `/items/${drink.id}`)).body).toMatchObject({ rating: 4, ratingCount: 1 });

    const review = (await k.admin('GET', `/reviews?restaurantId=${r.id}`)).body.items[0];
    expect(review).toMatchObject({ orderRef: o.ref, name: 'Dana R.', stars: 4, hidden: false });
    expect((await k.admin('POST', `/reviews/${review.id}/moderate`, { hidden: true, reason: 'Spam' })).body.hidden).toBe(true);
    expect((await k.store('GET', `/restaurants/${r.slug}`)).body.ratings).toEqual({ average: null, count: 0, stars: [0, 0, 0, 0, 0] });
    expect((await k.store('GET', `/items/${pizza.id}`)).body.ratingCount).toBe(0);
    await k.admin('POST', `/reviews/${review.id}/moderate`, { hidden: false });
    expect((await k.store('GET', `/restaurants/${r.slug}`)).body.ratings.count).toBe(1);

    // the personal data export: the order and the review
    const customerId = (await k.admin('GET', `/orders/${o.id}`)).body.customer.id;
    const food = k.app.kernel.boot.apis.get('food') as { exportCustomerData(i: { customerId: string; accountId: string }): Promise<any[]> };
    const sections = await food.exportCustomerData({ customerId, accountId });
    expect(sections.map((s) => s.key)).toEqual(['food_orders', 'food_reviews']);
    expect(sections[0].records[0]).toMatchObject({ reference: o.ref, total: usd(1999), status: 'delivered' });
    expect(sections[1].records[0]).toMatchObject({ order: o.ref, stars: 4, text: 'Hot and quick' });
  });
});
