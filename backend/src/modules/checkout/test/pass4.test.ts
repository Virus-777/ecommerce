/**
 * Gap pass 4: session facts in columns (email, contact name, payment intent and state, order attempt, quote total)
 * and guest ad attribution: the visitor key and the shopper's personalization choice kept on the session; createOrder gets visitorId only when personalization is allowed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callers } from '../../../testing/app.js';
import { STORE, key, placeBody, readyCheckout, world, type World } from './helpers.js';

let w: World;

beforeAll(async () => {
  w = await world();
}, 120_000);
afterAll(async () => {
  await w?.app.close();
});

const row = async (id: string) => (await w.service.core.repo.getSession(id))!;
const placedEvent = (orderId: string) => w.named('orders.order.placed').find((e) => e.orderId === orderId);

describe('guest ad attribution', () => {
  it('a customer who allows personalization: the order carries the visitor id of their app session', async () => {
    const ana = await w.customer('ana-personal@example.com');
    const prefs = await w.call('PUT', '/api/store/customers/marketing-preferences', ana.token, { personalizedRecommendations: true });
    expect(prefs.status, JSON.stringify(prefs.body)).toBe(200);
    const v = await readyCheckout(w, ana.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 });
    expect(await row(v.id)).toMatchObject({ visitor_key: w.sid(ana.token), personalization_allowed: true });
    const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, ana.token, placeBody(v), { 'idempotency-key': key() });
    expect(placed.body.outcome, JSON.stringify(placed.body)).toBe('accepted');
    expect(placedEvent(placed.body.orderId)).toMatchObject({ visitorId: w.sid(ana.token) });
  });

  it('without the personalization choice (customer opted out, or a visitor) the order has no visitor id', async () => {
    const ben = await w.customer('ben-private@example.com');
    await w.call('PUT', '/api/store/customers/marketing-preferences', ben.token, { personalizedRecommendations: false });
    const v = await readyCheckout(w, ben.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 });
    expect((await row(v.id)).personalization_allowed).toBe(false);
    const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, ben.token, placeBody(v), { 'idempotency-key': key() });
    expect(placedEvent(placed.body.orderId)).toMatchObject({ visitorId: null });

    const visitor = callers.visitor();
    const g = await readyCheckout(w, visitor, { source: 'buy_now', offerId: w.offers.white, quantity: 1 });
    expect(await row(g.id)).toMatchObject({ visitor_key: w.sid(visitor), personalization_allowed: false });
    const gp = await w.call('POST', `${STORE}/sessions/${g.id}/place`, visitor, placeBody(g), { 'idempotency-key': key() });
    expect(gp.body.outcome, JSON.stringify(gp.body)).toBe('accepted');
    expect(placedEvent(gp.body.orderId)).toMatchObject({ visitorId: null });
  });
});

describe('session columns', () => {
  it('keeps the contact, the payment intent and state, the order attempt and the quote total in columns', async () => {
    const visitor = callers.visitor();
    const v = await readyCheckout(w, visitor, { source: 'buy_now', offerId: w.offers.white, quantity: 2 });
    const before = await row(v.id);
    expect(before).toMatchObject({ email: `guest-${v.id.slice(-6)}@example.com`, contact_name: 'Ana Lopez', quote_total: v.totals.total.amount, payment_intent_id: null, payment_state: null, order_attempt: null });
    expect(before.account).not.toHaveProperty('email');
    expect(before.account).not.toHaveProperty('name');
    const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, visitor, placeBody(v), { 'idempotency-key': key() });
    expect(placed.body.outcome, JSON.stringify(placed.body)).toBe('accepted');
    const after = await row(v.id);
    expect(after).toMatchObject({ payment_state: 'accepted', order_attempt: 1, order_id: placed.body.orderId });
    expect(after.payment_intent_id).toEqual(expect.any(String));
    expect(after.payment_selection).not.toHaveProperty('intentId');
    // the staff list searches the email column
    const list = await w.call('GET', `${STORE.replace('/store/', '/admin/')}/sessions?q=${encodeURIComponent(`guest-${v.id.slice(-6)}`)}`, callers.staff());
    expect(list.body.items.map((r: { id: string }) => r.id)).toEqual([v.id]);
  });
});

