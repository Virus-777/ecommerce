/**
 * Payment results (plan ch. 14, scenario 3): declined → retry within the hold window, uncertain → pending
 * order resolved by payments' events, bank challenges; guests; leaving; the support views; GraphQL; jobs.
 * Real cart, orders, inventory, promotions, customers and identity; payments and shipping stubbed (helpers.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { PORTLAND, STORE, USD, fillCart, key, placeBody, readyCheckout, world, type World } from './helpers.js';

let w: World;

beforeAll(async () => {
  w = await world();
}, 120_000);
afterAll(async () => {
  await w?.app.close();
});

const available = async (stockItemId: string) => ((await w.api('inventory').getAvailability([stockItemId])) as Record<string, { available: number }>)[stockItemId]!.available;
const publish = async (source: string, name: string, payload: unknown) => {
  w.app.kernel.events.publish(source, name as never, payload as never);
  await w.app.kernel.events.drain();
};

describe('a declined payment', () => {
  it('keeps the checkout and the stock until holdUntil, then a retry with another card is accepted', async () => {
    const dana = await w.customer('dana@example.com');
    const before = await available(w.stock.white);
    const v = await readyCheckout(w, dana.token, { source: 'buy_now', offerId: w.offers.white, quantity: 2 }, { card: 'tok_decline' });
    const failed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, dana.token, placeBody(v), { 'idempotency-key': key() });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body).toMatchObject({ outcome: 'payment_failed', next: 'payment_result', orderId: null, payment: { state: 'failed', retryAllowed: true }, checkout: { status: 'payment_failed' } });
    expect(failed.body.retryUntil).toEqual(failed.body.checkout.holdUntil);
    expect(new Date(failed.body.retryUntil).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect(failed.body.checkout.lastPayment.decline.message).toContain('declined');
    expect(await available(w.stock.white)).toBe(before - 2); // still held for the retry

    // Place order again is not how to pay again
    const again = await w.call('POST', `${STORE}/sessions/${v.id}/place`, dana.token, placeBody(failed.body.checkout), { 'idempotency-key': key() });
    expect(again.status).toBe(409);

    const retryBody = { method: { kind: 'new_card', providerToken: 'tok_mc', label: 'Mastercard •••• 4444' }, quoteVersion: failed.body.checkout.quoteVersion, expectedTotal: failed.body.checkout.totals.total, returnUrl: 'https://store.marketly.test/r' };
    const stale = await w.call('POST', `${STORE}/sessions/${v.id}/retry-payment`, dana.token, { ...retryBody, expectedTotal: USD(1) }, { 'idempotency-key': key() });
    expect(stale.body.error.code).toBe('QUOTE_OUTDATED');
    const retried = await w.call('POST', `${STORE}/sessions/${v.id}/retry-payment`, dana.token, retryBody, { 'idempotency-key': key() });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({ outcome: 'accepted', next: 'confirmation', checkout: { status: 'completed', holdUntil: null } });
    expect(w.named('checkout.payment.retried').at(-1)).toMatchObject({ sessionId: v.id, attemptNo: 2, methodKind: 'new_card' });
    const auths = w.pay.calls.authorize.filter((a) => a.input.checkoutSessionId === v.id);
    expect(auths.map((a) => a.key)).toEqual([`${v.id}:1`, `${v.id}:2`]);
    expect(await available(w.stock.white)).toBe(before - 2); // the same hold became the order's
    const order = await w.api('orders').getOrder(retried.body.orderId);
    expect(order.lifecycle).toBe('open');
  });

  it('refuses a retry once the hold window closed', async () => {
    const eli = await w.customer('eli@example.com');
    const v = await readyCheckout(w, eli.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 }, { card: 'tok_decline' });
    const failed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, eli.token, placeBody(v), { 'idempotency-key': key() });
    expect(failed.body.outcome).toBe('payment_failed');
    await w.service.core.repo.updateSession(v.id, { hold_until: new Date(Date.now() - 1000) });
    const late = await w.call('POST', `${STORE}/sessions/${v.id}/retry-payment`, eli.token, { method: { kind: 'new_card', providerToken: 'tok_ok' }, quoteVersion: failed.body.checkout.quoteVersion, expectedTotal: failed.body.checkout.totals.total, returnUrl: 'https://store.marketly.test/r' }, { 'idempotency-key': key() });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('RETRY_WINDOW_EXPIRED');
  });

  it('lets the customer go back to checkout after a decline; holds are released', async () => {
    const fay = await w.customer('fay@example.com');
    const before = await available(w.stock.white);
    const v = await readyCheckout(w, fay.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 }, { card: 'tok_decline' });
    const failed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, fay.token, placeBody(v), { 'idempotency-key': key() });
    expect(await available(w.stock.white)).toBe(before - 1);
    const pkg = failed.body.checkout.packages[0];
    const edited = await w.call('PUT', `${STORE}/sessions/${v.id}/delivery`, fay.token, { selections: [{ packageKey: pkg.key, optionId: pkg.options[1].id }] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.status).toBe('open');
    expect(await available(w.stock.white)).toBe(before);
    const left = await w.call('DELETE', `${STORE}/sessions/${v.id}`, fay.token);
    expect(left.status).toBe(204);
    expect(w.named('checkout.session.abandoned').at(-1)).toMatchObject({ sessionId: v.id, lastStatus: 'open', reason: 'left' });
    expect((await w.call('GET', `${STORE}/sessions/${v.id}`, fay.token)).body.status).toBe('cancelled');
    expect((await w.call('DELETE', `${STORE}/sessions/${v.id}`, fay.token)).status).toBe(409);
  });
});

describe('an uncertain payment (scenario 3)', () => {
  it('creates the order with payment checking, never charges twice, and completes when payments confirms', async () => {
    const gus = await w.customer('gus@example.com');
    const v = await readyCheckout(w, gus.token, { source: 'buy_now', offerId: w.offers.black, quantity: 1 }, { card: 'tok_pending' });
    const k = key();
    const res = await w.call('POST', `${STORE}/sessions/${v.id}/place`, gus.token, placeBody(v), { 'idempotency-key': k });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'payment_pending', next: 'payment_result', payment: { state: 'pending' }, checkout: { status: 'payment_pending' } });
    const orderId = res.body.orderId;
    expect(orderId).toEqual(expect.any(String));
    expect((await w.api('orders').getOrder(orderId)).lifecycle).toBe('payment_pending');
    expect(w.named('checkout.session.completed').at(-1)).toMatchObject({ sessionId: v.id, orderId, paymentState: 'pending_check' });
    expect((await w.call('GET', `${STORE}/sessions/${v.id}/confirmation`, gus.token)).status).toBe(409);

    // taps, refreshes and new keys while pending: the current result, no second authorization
    for (const kk of [k, key()]) {
      const again = await w.call('POST', `${STORE}/sessions/${v.id}/place`, gus.token, placeBody(v), { 'idempotency-key': kk });
      expect(again.body).toMatchObject({ outcome: 'payment_pending', orderId });
    }
    expect(w.pay.calls.authorize.filter((a) => a.input.checkoutSessionId === v.id)).toHaveLength(1);

    const intent = w.pay.calls.authorize.find((a) => a.input.checkoutSessionId === v.id)!;
    const intentId = [...w.pay.intents.values()].find((i) => i.key === intent.key)!.id;
    w.pay.intents.get(intentId)!.state = 'accepted';
    await publish('payments', 'payments.payment.authorized', { intentId, checkoutSessionId: v.id, orderId, amount: v.totals.total, methodLabel: 'Mastercard •••• 4444', at: new Date().toISOString() });
    const done = await w.call('GET', `${STORE}/sessions/${v.id}`, gus.token);
    expect(done.body.status).toBe('completed');
    expect((await w.api('orders').getOrder(orderId)).lifecycle).toBe('open');
    expect((await w.call('GET', `${STORE}/sessions/${v.id}/confirmation`, gus.token)).body).toMatchObject({ orderId, paymentState: 'accepted' });
    expect(w.named('inventory.reservation.allocated').some((e) => e.orderId === orderId)).toBe(true);
  });

  it('returns the lines to the cart when the pending payment is finally declined; a retry makes a new order', async () => {
    const hal = await w.customer('hal@example.com');
    await fillCart(w, hal.token, [{ offerId: w.offers.white, quantity: 1 }]);
    const v = await readyCheckout(w, hal.token, { source: 'cart' }, { card: 'tok_pending' });
    const res = await w.call('POST', `${STORE}/sessions/${v.id}/place`, hal.token, placeBody(v), { 'idempotency-key': key() });
    expect(res.body.outcome).toBe('payment_pending');
    const firstOrder = res.body.orderId;
    expect(JSON.stringify((await w.call('GET', '/api/store/cart/cart', hal.token)).body)).not.toContain(w.offers.white);

    const intentId = [...w.pay.intents.values()].find((i) => i.input.checkoutSessionId === v.id)!.id;
    w.pay.intents.get(intentId)!.state = 'failed';
    await publish('payments', 'payments.payment.failed', { intentId, checkoutSessionId: v.id, orderId: firstOrder, declineCategory: 'card_declined', afterPendingCheck: true, at: new Date().toISOString() });
    const s = (await w.call('GET', `${STORE}/sessions/${v.id}`, hal.token)).body;
    expect(s).toMatchObject({ status: 'payment_failed', orderId: null });
    expect((await w.api('orders').getOrder(firstOrder)).lifecycle).toBe('cancelled');
    expect(JSON.stringify((await w.call('GET', '/api/store/cart/cart', hal.token)).body)).toContain(w.offers.white);

    const retried = await w.call('POST', `${STORE}/sessions/${v.id}/retry-payment`, hal.token, { method: { kind: 'digital_wallet', providerToken: 'tok_wallet', label: 'Apple Pay' }, quoteVersion: s.quoteVersion, expectedTotal: s.totals.total, returnUrl: 'https://store.marketly.test/r' }, { 'idempotency-key': key() });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.outcome).toBe('accepted');
    expect(retried.body.orderId).not.toBe(firstOrder);
    expect((await w.api('orders').getOrder(retried.body.orderId)).lifecycle).toBe('open');
  });
});

describe('a bank challenge', () => {
  it('waits for the challenge, then completes the order', async () => {
    const ivy = await w.customer('ivy@example.com');
    const v = await readyCheckout(w, ivy.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 }, { card: 'tok_3ds' });
    const res = await w.call('POST', `${STORE}/sessions/${v.id}/place`, ivy.token, placeBody(v), { 'idempotency-key': key() });
    expect(res.body).toMatchObject({ outcome: 'requires_action', next: 'complete_action', orderId: null, payment: { state: 'requires_action', nextAction: { kind: 'three_ds_challenge' } }, checkout: { status: 'awaiting_action' } });
    const k = key();
    const done = await w.call('POST', `${STORE}/sessions/${v.id}/complete-action`, ivy.token, { resultToken: 'ok' }, { 'idempotency-key': k });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ outcome: 'accepted', checkout: { status: 'completed' } });
    const again = await w.call('POST', `${STORE}/sessions/${v.id}/complete-action`, ivy.token, { resultToken: 'ok' }, { 'idempotency-key': key() });
    expect(again.body).toMatchObject({ outcome: 'accepted', orderId: done.body.orderId });
    expect(w.pay.calls.completeAction).toHaveLength(1);
  });
});

describe('guests', () => {
  it('a visitor checks out with an email, and the visitor session may open the order', async () => {
    const visitor = await w.f.visitor();
    await fillCart(w, visitor, [{ offerId: w.offers.white, quantity: 1 }]);
    const started = await w.call('POST', `${STORE}/sessions`, visitor, { source: 'cart' });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.account).toBeNull();
    expect(started.body.blockers).toContain('Add your email address');
    const id = started.body.id;
    const contact = await w.call('PUT', `${STORE}/sessions/${id}/contact`, visitor, { email: 'Guest.Buyer@Example.com', phone: '+1 503 555 0199', createAccountAfter: true });
    expect(contact.body.account).toMatchObject({ kind: 'guest', email: 'guest.buyer@example.com', createAccountAfter: true, note: "We'll email a link to view and manage this order." });
    await w.call('PUT', `${STORE}/sessions/${id}/address`, visitor, { address: PORTLAND });
    const saved = await w.call('PUT', `${STORE}/sessions/${id}/payment-method`, visitor, { kind: 'saved_card', savedMethodId: crypto.randomUUID() });
    expect(saved.body.error.code).toBe('PAYMENT_METHOD_INVALID');
    const card = await w.call('PUT', `${STORE}/sessions/${id}/payment-method`, visitor, { kind: 'new_card', providerToken: 'tok_ok' });
    const placed = await w.call('POST', `${STORE}/sessions/${id}/place`, visitor, placeBody(card.body), { 'idempotency-key': key() });
    expect(placed.body.outcome, JSON.stringify(placed.body)).toBe('accepted');
    const orderId = placed.body.orderId;
    expect(await w.api('identity').hasGuestOrderAccess(w.sid(visitor), orderId)).toBe(true);
    expect((await w.api('orders').getOrder(orderId)).contact).toMatchObject({ kind: 'guest', email: 'guest.buyer@example.com', name: 'Ana Lopez' });
    expect(w.pay.calls.authorize.at(-1)!.input).toMatchObject({ customerId: null, guestEmail: 'guest.buyer@example.com' });
    expect(w.named('checkout.session.completed').at(-1)).toMatchObject({ guest: true, createAccountAfter: true, email: 'guest.buyer@example.com' });
    const conf = await w.call('GET', `${STORE}/sessions/${id}/confirmation`, visitor);
    expect(conf.body.offerAccountCreation).toBe(true);
    // a signed-in customer doesn't see the guest's checkout
    expect((await w.call('GET', `${STORE}/sessions/${id}`, (await w.customer('jo@example.com')).token)).status).toBe(404);
  });

  it('the guest checkout moves to the customer who signs in', async () => {
    const visitor = await w.f.visitor();
    const started = await w.call('POST', `${STORE}/sessions`, visitor, { source: 'buy_now', offerId: w.offers.white, quantity: 1 });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const kim = await w.customer('kim@example.com');
    await publish('identity', 'identity.guest_session.claimed', { guestSessionId: w.sid(visitor), accountId: kim.accountId });
    const mine = await w.call('GET', `${STORE}/sessions/${started.body.id}`, kim.token);
    expect(mine.status).toBe(200);
    expect(mine.body.account).toMatchObject({ kind: 'customer', customerId: kim.customerId, email: 'kim@example.com' });
    expect((await w.call('GET', `${STORE}/sessions/${started.body.id}`, visitor)).status).toBe(404);
  });
});

describe('start refusals', () => {
  it('explains an empty cart, an unknown offer and a quantity beyond stock', async () => {
    const lea = await w.customer('lea@example.com');
    expect((await w.call('POST', `${STORE}/sessions`, lea.token, { source: 'cart' })).body.error.code).toBe('CART_EMPTY');
    const unknown = await w.call('POST', `${STORE}/sessions`, lea.token, { source: 'buy_now', offerId: crypto.randomUUID() });
    expect(unknown.status).toBe(409);
    expect(unknown.body.error.code).toBe('OFFER_UNAVAILABLE');
    const tooMany = await w.call('POST', `${STORE}/sessions`, lea.token, { source: 'buy_now', offerId: w.offers.white, quantity: 500 });
    expect(tooMany.body.error).toMatchObject({ code: 'OFFER_UNAVAILABLE', details: { reason: 'not_enough_stock' } });
  });
});

describe('support views and GraphQL', () => {
  let sessionId: string;
  let token: string;

  it('lists checkouts with payment attempts and shows one with its keys, change sets and history', async () => {
    const max = await w.customer('max@example.com');
    token = max.token;
    const v = await readyCheckout(w, max.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 }, { card: 'tok_decline' });
    sessionId = v.id;
    const k = key();
    await w.call('POST', `${STORE}/sessions/${v.id}/place`, max.token, placeBody(v), { 'idempotency-key': k });
    const staff = callers.staff(['checkout.sessions.view']);
    const list = await w.call('GET', '/api/admin/checkout/sessions?status=payment_failed&q=max@', staff);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: v.id, status: 'payment_failed', email: 'max@example.com', guest: false, packageCount: 1, paymentAttempts: 1, lastDecline: expect.stringContaining('declined') });
    const one = await w.call('GET', `/api/admin/checkout/sessions/${v.id}`, staff);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.attempts).toEqual([expect.objectContaining({ idempotencyKey: k, outcome: 'payment_failed', quoteVersion: v.quoteVersion, total: v.totals.total })]);
    expect(one.body.history.map((h: any) => h.label)).toEqual(expect.arrayContaining(['Checkout started', 'Place order', 'Payment declined']));
    expect((await w.call('GET', `/api/admin/checkout/sessions/${crypto.randomUUID()}`, staff)).status).toBe(404);
  });

  it('reads the checkout through GraphQL for its owner only', async () => {
    const query = `query($id: UUID!) { checkoutSession(id: $id) { id status quoteVersion hidePricesOnSlip totals { total { amount formatted } } packages { label selectedOption { methodName arrivalFrom } } paymentOptions { walletKinds } lastPayment { state } confirmation { orderRef } } }`;
    const res = await w.app.inject({ method: 'POST', url: '/graphql/store', headers: { authorization: `Bearer ${token}` }, payload: { query, variables: { id: sessionId } } });
    const body = res.json();
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
    expect(body.data.checkoutSession).toMatchObject({ id: sessionId, status: 'PAYMENT_FAILED', hidePricesOnSlip: false, packages: [{ label: 'Package 1 of 1', selectedOption: { methodName: 'Standard' } }], paymentOptions: { walletKinds: ['APPLE_PAY', 'GOOGLE_PAY'] }, lastPayment: { state: 'FAILED' }, confirmation: null });
    expect(body.data.checkoutSession.totals.total.formatted).toMatch(/^\$/);
    const other = await w.app.inject({ method: 'POST', url: '/graphql/store', headers: { authorization: `Bearer ${(await w.customer('nik@example.com')).token}` }, payload: { query, variables: { id: sessionId } } });
    expect(other.json().data.checkoutSession).toBeNull();
  });

  it('answers payments’ orphan check', async () => {
    expect(await w.service.getSessionForOrder(sessionId)).toMatchObject({ status: 'payment_failed', orderId: null });
    expect(await w.service.getSessionForOrder(crypto.randomUUID())).toBeNull();
  });
});

describe('jobs', () => {
  it('expires idle checkouts and failed ones past their hold, releasing the stock, and purges old keys', async () => {
    const ola = await w.customer('ola@example.com');
    const idle = await readyCheckout(w, ola.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 });
    const pat = await w.customer('pat@example.com');
    const before = await available(w.stock.white);
    const failing = await readyCheckout(w, pat.token, { source: 'buy_now', offerId: w.offers.white, quantity: 3 }, { card: 'tok_decline' });
    await w.call('POST', `${STORE}/sessions/${failing.id}/place`, pat.token, placeBody(failing), { 'idempotency-key': key() });
    expect(await available(w.stock.white)).toBe(before - 3);

    w.clock.advance(61 * 60_000);
    await w.app.kernel.jobs.runNow('checkout.expire-sessions');
    await w.app.kernel.events.drain();
    const repo = w.service.core.repo;
    expect((await repo.getSession(idle.id))!.status).toBe('expired');
    expect((await repo.getSession(failing.id))!).toMatchObject({ status: 'expired', stock_reservation_id: null });
    // this hold and the earlier declined checkouts' holds are back on sale
    expect(await available(w.stock.white)).toBeGreaterThanOrEqual(before);
    const abandoned = w.named('checkout.session.abandoned');
    expect(abandoned).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: idle.id, reason: 'expired', lastStatus: 'open' }), expect.objectContaining({ sessionId: failing.id, reason: 'retry_window_closed', lastStatus: 'payment_failed' })]));

    await w.app.kernel.jobs.runNow('checkout.extend-pending-holds');
    w.clock.advance(8 * 86_400_000);
    await w.app.kernel.jobs.runNow('checkout.purge-idempotency');
    expect(await repo.listPlaceRequests(failing.id)).toEqual([]);
  });
});

// the clock moves past the 15-minute stock hold, so these run last and the customer signs in again to finish the challenge
describe('a bank challenge longer than the stock hold', () => {
  const signInAgain = async (c: { email: string; password: string }) => (await w.f.signIn({ email: c.email, password: c.password, audience: 'store' })).body.tokens.accessToken as string;

  it('holds the stock again when the hold expired during the challenge', async () => {
    const kai = await w.f.customer('kai@example.com');
    const before = await available(w.stock.black);
    const v = await readyCheckout(w, kai.accessToken, { source: 'buy_now', offerId: w.offers.black, quantity: 1 }, { card: 'tok_3ds' });
    const res = await w.call('POST', `${STORE}/sessions/${v.id}/place`, kai.accessToken, placeBody(v), { 'idempotency-key': key() });
    expect(res.body.checkout.status).toBe('awaiting_action');
    w.clock.advance(20 * 60_000);
    await w.app.kernel.jobs.runNow('inventory.expire-holds');
    expect(await available(w.stock.black)).toBe(before); // the expired hold gave the unit back
    const done = await w.call('POST', `${STORE}/sessions/${v.id}/complete-action`, await signInAgain(kai), { resultToken: 'ok' }, { 'idempotency-key': key() });
    expect(done.body, JSON.stringify(done.body)).toMatchObject({ outcome: 'accepted', checkout: { status: 'completed' } });
    expect(await available(w.stock.black)).toBe(before - 1);
  });

  it('voids the payment instead of overselling when the units sold during the challenge', async () => {
    const lena = await w.f.customer('lena@example.com');
    const v = await readyCheckout(w, lena.accessToken, { source: 'buy_now', offerId: w.offers.black, quantity: 1 }, { card: 'tok_3ds' });
    const res = await w.call('POST', `${STORE}/sessions/${v.id}/place`, lena.accessToken, placeBody(v), { 'idempotency-key': key() });
    expect(res.body.checkout.status).toBe('awaiting_action');
    w.clock.advance(20 * 60_000);
    await w.app.kernel.jobs.runNow('inventory.expire-holds');
    // the units went to other buyers while the bank challenge was open
    const left = await available(w.stock.black);
    const seller = { kind: 'seller' as const, id: w.sellerId };
    await w.api('inventory').applyBulkQuantities(w.sellerId, [{ stockItemId: w.stock.black, newAvailable: 0 }], newId(), seller);
    const voided = w.pay.calls.voidIntent.length;
    const done = await w.call('POST', `${STORE}/sessions/${v.id}/complete-action`, await signInAgain(lena), { resultToken: 'ok' }, { 'idempotency-key': key() });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ outcome: 'payment_failed', orderId: null, checkout: { status: 'payment_failed' } });
    expect(done.body.checkout.lastPayment.decline.message).toContain('sold out');
    expect(w.pay.calls.voidIntent).toHaveLength(voided + 1);
    expect(await available(w.stock.black)).toBe(0);
    await w.api('inventory').applyBulkQuantities(w.sellerId, [{ stockItemId: w.stock.black, newAvailable: left }], newId(), seller);
  });
});
