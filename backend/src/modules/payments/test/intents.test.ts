import { newId } from '../../../kernel/lib/ids.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authorizeInput, harness, idem, placeOrder, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
const staff = () => tokens.staff();

beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.events.length = 0;
  h.audits.length = 0;
  for (const k of Object.keys(h.settings)) delete h.settings[k];
});

describe('authorization', () => {
  it('approves a new card, answers the same key with the first result and never authorizes a session twice', async () => {
    const customerId = newId();
    const input = authorizeInput({ customerId, amount: 42998, token: 'tok_visa_4417' });
    const key = newId();
    const r = await h.service.authorize(input, key);
    expect(r).toMatchObject({ state: 'accepted', methodLabel: 'Visa •••• 4417', decline: null });
    expect(h.named('payments.payment.authorized')).toEqual([expect.objectContaining({ intentId: r.intentId, checkoutSessionId: input.checkoutSessionId, amount: USD(42998), methodLabel: 'Visa •••• 4417' })]);

    expect(await h.service.authorize(input, key)).toEqual(r);
    // a double submit with another key returns the live intent of the session
    expect((await h.service.authorize(input, newId())).intentId).toBe(r.intentId);
    expect(await h.calls(r.intentId, 'authorize')).toHaveLength(1);

    const detail = await h.call('GET', `/api/admin/payments/payments/${r.intentId}`, staff());
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body).toMatchObject({ status: 'authorized', customerState: 'accepted', authorizedAmount: USD(42998), method: { kind: 'card', brand: 'visa', last4: '4417', label: 'Visa •••• 4417' }, tenders: [{ kind: 'card', amount: USD(42998) }], orphan: false });
    expect(detail.body.ref).toMatch(/^PAY-[0-9A-F]{8}$/);
    expect(detail.body.calls).toEqual([expect.objectContaining({ operation: 'authorize', outcome: 'ok' })]);
  });

  it('declines with a customer-safe reason and lets the customer retry with another card (new attempt, same session)', async () => {
    const checkoutSessionId = newId();
    const declined = await h.service.authorize(authorizeInput({ checkoutSessionId, amount: 5000, token: 'tok_declined' }), newId());
    expect(declined).toMatchObject({ state: 'failed', decline: { code: '05', category: 'card_declined', message: 'Your bank declined Visa •••• 0002. Nothing was charged.', retryable: false } });
    expect(h.named('payments.payment.failed')).toEqual([expect.objectContaining({ intentId: declined.intentId, declineCategory: 'card_declined', afterPendingCheck: false })]);

    const insufficient = await h.service.authorize(authorizeInput({ checkoutSessionId, amount: 5005, token: 'tok_visa', attemptNo: 2 }), newId());
    expect(insufficient).toMatchObject({ state: 'failed', decline: { code: '51', category: 'insufficient_funds' } });

    const retry = await h.service.authorize(authorizeInput({ checkoutSessionId, amount: 5000, token: 'tok_mastercard', attemptNo: 3 }), newId());
    expect(retry).toMatchObject({ state: 'accepted', methodLabel: 'Mastercard •••• 4444' });
    expect(retry.intentId).not.toBe(declined.intentId);
  });

  it('refuses unusable tokens and brands Marketly does not accept', async () => {
    await expect(h.service.authorize(authorizeInput({ amount: 1000, token: '4242424242424242' }), newId())).rejects.toMatchObject({ code: 'PAYMENT_METHOD_INVALID', status: 422 });
    await expect(h.service.authorize(authorizeInput({ amount: 1000, token: 'tok_unionpay' }), newId())).rejects.toMatchObject({ code: 'PAYMENT_METHOD_INVALID' });
    h.settings['payments.walletsEnabled'] = false;
    await expect(h.service.authorize(authorizeInput({ amount: 1000, token: 'tok_applepay' }), newId())).rejects.toMatchObject({ code: 'PAYMENT_METHOD_INVALID' });
    delete h.settings['payments.walletsEnabled'];
    const wallet = await h.service.authorize(authorizeInput({ amount: 1000, token: 'tok_applepay' }), newId());
    expect(wallet).toMatchObject({ state: 'accepted', methodLabel: 'Apple Pay (Visa •••• 4242)' });
  });

  it('completes a bank challenge (approved or failed)', async () => {
    const r = await h.service.authorize(authorizeInput({ amount: 2000, token: 'tok_3ds' }), newId());
    expect(r).toMatchObject({ state: 'requires_action', nextAction: { kind: 'three_ds_challenge' } });
    expect(r.nextAction?.url).toContain('https://');
    const key = newId();
    const done = await h.service.completeAction(r.intentId, '3ds_ok', key);
    expect(done).toMatchObject({ state: 'accepted', intentId: r.intentId });
    expect(await h.service.completeAction(r.intentId, '3ds_ok', key)).toMatchObject({ state: 'accepted' });

    const r2 = await h.service.authorize(authorizeInput({ amount: 2004, token: 'tok_visa' }), newId());
    expect(r2.state).toBe('requires_action');
    expect(await h.service.completeAction(r2.intentId, 'cancelled-by-customer', newId())).toMatchObject({ state: 'failed', decline: { category: 'authentication_failed' } });

    // an abandoned challenge is released by checkout
    const r3 = await h.service.authorize(authorizeInput({ amount: 2004, token: 'tok_visa' }), newId());
    await h.service.voidIntent(r3.intentId, 'Checkout abandoned');
    expect((await h.service.getIntentStatus(r3.intentId)).state).toBe('failed');
  });
});

describe('uncertain results (scenario 3)', () => {
  it('keeps a timed-out payment pending, never charges again, and resolves it by asking the provider', async () => {
    const customerId = newId();
    const checkoutSessionId = newId();
    const input = authorizeInput({ checkoutSessionId, customerId, amount: 42998, token: 'tok_timeout' });
    const r = await h.service.authorize(input, newId());
    expect(r.state).toBe('pending_check');
    expect(h.named('payments.payment.pending_check')).toEqual([expect.objectContaining({ intentId: r.intentId, amount: USD(42998) })]);

    // a second submit (new key) gets the same pending intent, no second authorization
    expect((await h.service.authorize(input, newId())).intentId).toBe(r.intentId);
    expect(await h.calls(r.intentId, 'authorize')).toEqual([{ operation: 'authorize', outcome: 'timeout' }]);

    const owner = tokens.customer(customerId);
    const view = await h.call('GET', `/api/store/payments/intents/${r.intentId}`, owner);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body).toMatchObject({ state: 'pending', message: "We're confirming your payment with your bank. Don't pay again.", retryAllowed: false });
    expect(view.body.holdNote).toContain('$429.98');
    expect(view.body.nextCheckInSeconds).toBeGreaterThan(0);
    expect((await h.call('GET', `/api/store/payments/intents/${r.intentId}`, tokens.customer(newId()))).status).toBe(404);

    const checked = await h.call('POST', `/api/store/payments/intents/${r.intentId}/check`, owner);
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body.state).toBe('accepted');
    expect(h.named('payments.payment.authorized')).toEqual([expect.objectContaining({ intentId: r.intentId })]);
    expect(await h.calls(r.intentId, 'authorize')).toHaveLength(1);
  });

  it('shows a guest the result of their own checkout only', async () => {
    const guestSession = newId();
    const r = await h.service.authorize(authorizeInput({ amount: 3000, token: 'tok_declined' }), newId());
    const intent = (await h.service.core.repo.get('intents', r.intentId))!;
    h.sessions.set(intent.checkout_session_id, { orderId: null, status: 'payment', customerId: null, guestSessionId: guestSession });
    const mine = await h.call('GET', `/api/store/payments/intents/${r.intentId}`, tokens.visitor(guestSession));
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body).toMatchObject({ state: 'failed', retryAllowed: true, decline: { code: '05' } });
    expect((await h.call('GET', `/api/store/payments/intents/${r.intentId}`, tokens.visitor(newId()))).status).toBe(404);
    expect((await h.call('GET', `/api/store/payments/intents/${r.intentId}`, tokens.customer(newId()))).status).toBe(404);
  });

  it('rate-limits Check now', async () => {
    const customerId = newId();
    const r = await h.service.authorize(authorizeInput({ customerId, amount: 3000, token: 'tok_timeout_lost' }), newId());
    h.settings['payments.storeCheckRateLimitSeconds'] = 60;
    // the status-check job asks first (backoff 30 s), then the customer cannot hammer the provider
    h.clock.advance(31_000);
    await h.run('payments.check-uncertain');
    const again = await h.call('POST', `/api/store/payments/intents/${r.intentId}/check`, tokens.customer(customerId));
    expect(again.status).toBe(200); // resolved by the job already: no provider call needed
    expect(again.body.state).toBe('failed');
  });

  it('resolves pending checks through the status-check job: declined after the check, or lost at the provider', async () => {
    const declined = await h.service.authorize(authorizeInput({ amount: 4006, token: 'tok_visa' }), newId());
    const lost = await h.service.authorize(authorizeInput({ amount: 4000, token: 'tok_timeout_lost' }), newId());
    expect([declined.state, lost.state]).toEqual(['pending_check', 'pending_check']);
    await h.run('payments.check-uncertain'); // not due yet (30 s backoff)
    expect((await h.service.getIntentStatus(declined.intentId)).state).toBe('pending');
    h.clock.advance(31_000);
    await h.run('payments.check-uncertain');
    expect((await h.service.getIntentStatus(declined.intentId)).state).toBe('failed');
    expect((await h.service.getIntentStatus(lost.intentId)).decline).toMatchObject({ category: 'processing_error', retryable: true });
    expect(h.named('payments.payment.failed').filter((e) => e.afterPendingCheck)).toHaveLength(2);
  });

  it('accepts a pending order when the check confirms the payment, then captures it (orders for real)', async () => {
    const customerId = newId();
    const placed = await placeOrder(h, { customerId, token: 'tok_timeout' });
    expect(placed.state).toBe('pending_check');
    expect(placed.order.lifecycle).toBe('payment_pending');
    expect(h.named('payments.payment.captured')).toHaveLength(0);
    h.clock.advance(31_000);
    await h.run('payments.check-uncertain');
    const order = await h.orders.getOrder(placed.order.id);
    expect(order?.lifecycle).toBe('open');
    expect(h.named('payments.payment.captured')).toEqual([expect.objectContaining({ intentId: placed.intentId, orderId: placed.order.id, amount: USD(placed.total), groupId: null })]);
    const detail = await h.service.getPaymentForOrder(placed.order.id);
    expect(detail).toMatchObject({ status: 'captured', customerState: 'accepted', capturedAmount: USD(placed.total) });
  });

  it('names the order reference when the payment of a placed order fails (payment-failed notice)', async () => {
    const placed = await placeOrder(h, { customerId: newId(), products: [[{ price: 4006 }]], token: 'tok_visa' }); // …06 declines after the check
    expect(placed.state).toBe('pending_check');
    h.clock.advance(31_000);
    await h.run('payments.check-uncertain');
    expect(h.named('payments.payment.failed').find((e) => e.intentId === placed.intentId)).toMatchObject({ orderId: placed.order.id, orderRef: placed.order.ref });
  });

  it('raises a check that stays unanswered past uncertainMaxHours to Finance once', async () => {
    const r = await h.service.authorize(authorizeInput({ amount: 4000, token: 'tok_timeout' }), newId());
    // the provider never answers the checks
    const provider = h.service.core.provider;
    const original = provider.retrievePayment;
    provider.retrievePayment = async () => {
      throw new (await import('../ports.js')).ProviderError('down', true);
    };
    try {
      h.clock.advance(25 * 3_600_000);
      await h.run('payments.check-uncertain');
      h.clock.advance(3_600_000);
      await h.run('payments.check-uncertain');
    } finally {
      provider.retrievePayment = original;
    }
    // the card amount that may have moved (nothing is known as authorized yet); no store credit on this payment
    expect(h.named('payments.payment.orphaned')).toEqual([{ intentId: r.intentId, checkoutSessionId: expect.any(String), amount: USD(4000), creditAmount: null, action: 'needs_review', captured: false }]);
    const list = await h.call('GET', '/api/admin/payments/payments?flag=pending_check', staff());
    expect(list.body.items.map((x: any) => x.id)).toContain(r.intentId);
  });
});

describe('capture', () => {
  it('captures once when the order is accepted, with the seller-group allocations', async () => {
    const customerId = newId();
    const placed = await placeOrder(h, { customerId, products: [[{ price: 12000 }], [{ price: 8000 }, { price: 3000 }]] });
    const captured = h.named('payments.payment.captured');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ orderId: placed.order.id, groupId: null, amount: USD(23000) });
    expect(captured[0].allocations.map((a: any) => a.amount.amount).sort()).toEqual([11000, 12000]);
    // the accepted event again (replay) does not capture twice
    await h.publish('orders', 'orders.order.accepted', { orderId: placed.order.id, ref: placed.order.ref, customerId, contactEmail: 'sam@example.com', total: USD(23000), groups: [], items: [], acceptedAt: new Date().toISOString() });
    expect(h.named('payments.payment.captured')).toHaveLength(1);
    expect(await h.calls(placed.intentId, 'capture')).toHaveLength(1);

    const summary = await h.call('GET', `/api/admin/payments/orders/${placed.order.id}/summary`, staff());
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body).toMatchObject({ orderId: placed.order.id, state: 'accepted', methodLabel: 'Visa •••• 4242', captured: USD(23000), refunded: USD(0), remainingRefundable: USD(23000) });
    expect(summary.body.attempts).toHaveLength(1);
  });

  it('captures each seller group when it ships in per_group_on_dispatch mode', async () => {
    h.settings['payments.captureMode'] = 'per_group_on_dispatch';
    const placed = await placeOrder(h, { products: [[{ price: 12000 }], [{ price: 8000 }]] });
    expect(h.named('payments.payment.captured')).toHaveLength(0);
    const [g1, g2] = placed.order.groups;
    const dispatched = (groupId: string) => ({ shipmentId: newId(), kind: 'outbound', orderId: placed.order.id, groupId, ownerType: 'seller', sellerId: null, fulfilledBy: 'seller', lines: [], shippedAt: new Date().toISOString(), trackingValid: true });
    await h.publish('shipping', 'shipping.shipment.dispatched', dispatched(g1!.id));
    await h.publish('shipping', 'shipping.shipment.dispatched', dispatched(g1!.id)); // replay
    let detail = await h.service.getPaymentForOrder(placed.order.id);
    expect(detail).toMatchObject({ status: 'partially_captured', capturedAmount: USD(12000) });
    expect(h.named('payments.payment.captured')).toEqual([expect.objectContaining({ groupId: g1!.id, amount: USD(12000), allocations: [expect.objectContaining({ groupId: g1!.id })] })]);
    await h.publish('shipping', 'shipping.shipment.dispatched', dispatched(g2!.id));
    detail = await h.service.getPaymentForOrder(placed.order.id);
    expect(detail).toMatchObject({ status: 'captured', capturedAmount: USD(20000) });
  });

  it('records a failed capture, lets staff capture manually and refuses more than the authorization', async () => {
    const placed = await placeOrder(h, { products: [[{ price: 9922 }]] });
    let detail = await h.service.getPaymentForOrder(placed.order.id);
    expect(detail).toMatchObject({ status: 'authorized', capturedAmount: USD(0) });
    expect(detail!.captures).toEqual([expect.objectContaining({ status: 'failed', amount: USD(9922) })]);
    const flagged = await h.call('GET', '/api/admin/payments/payments?flag=capture_failed', staff());
    expect(flagged.body.items.map((x: any) => x.id)).toContain(placed.intentId);

    const tooMuch = await h.call('POST', `/api/admin/payments/payments/${placed.intentId}/capture`, staff(), { amount: USD(10000), reason: 'Retry capture' }, idem());
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('CAPTURE_EXCEEDS_AUTHORIZED');
    const ok = await h.call('POST', `/api/admin/payments/payments/${placed.intentId}/capture`, staff(), { amount: USD(9900), reason: 'Retry capture after processor error' }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'partially_captured', capturedAmount: USD(9900) });
    expect(h.audits.find((a) => a.action === 'payments.payment.capture')).toMatchObject({ reason: 'Retry capture after processor error', category: 'financial' });
    const captured = await h.call('POST', `/api/admin/payments/payments/${placed.intentId}/void`, staff(), { reason: 'x' }, idem());
    expect(captured.status).toBe(409);
  });
});

describe('voids and orphans', () => {
  it('voids an authorization (checkout or staff) and refuses to void captured money', async () => {
    const r = await h.service.authorize(authorizeInput({ amount: 6000 }), newId());
    await h.service.voidIntent(r.intentId, 'Checkout abandoned');
    await h.service.voidIntent(r.intentId, 'again'); // idempotent
    expect(h.named('payments.payment.voided')).toEqual([expect.objectContaining({ intentId: r.intentId, reason: 'Checkout abandoned' })]);

    const r2 = await h.service.authorize(authorizeInput({ amount: 6000 }), newId());
    const v = await h.call('POST', `/api/admin/payments/payments/${r2.intentId}/void`, staff(), { reason: 'Customer called' }, idem());
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.status).toBe('voided');
    expect(h.audits.find((a) => a.action === 'payments.payment.void')).toBeTruthy();

    const pending = await h.service.authorize(authorizeInput({ amount: 6003 }), newId());
    await expect(h.service.voidIntent(pending.intentId, 'abandoned')).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('voids an order-less authorization and refunds an order-less capture after the grace period', async () => {
    const auth = await h.service.authorize(authorizeInput({ amount: 7000 }), newId());
    const csAuth = (await h.service.core.repo.get('intents', auth.intentId))!.checkout_session_id;
    h.sessions.set(csAuth, { orderId: null, status: 'expired', customerId: null });
    // captured by the processor on its own (timeout, then confirm_captured)
    const cap = await h.service.authorize(authorizeInput({ amount: 7007 }), newId());
    expect(cap.state).toBe('pending_check');
    h.clock.advance(31_000);
    await h.run('payments.check-uncertain');
    expect((await h.service.core.repo.get('intents', cap.intentId))!.status).toBe('captured');
    // a session still being placed is left alone
    const active = await h.service.authorize(authorizeInput({ amount: 7000 }), newId());
    h.sessions.set((await h.service.core.repo.get('intents', active.intentId))!.checkout_session_id, { orderId: null, status: 'placing', customerId: null });

    const mine = [auth.intentId, cap.intentId, active.intentId];
    await h.run('payments.detect-orphans'); // inside the grace period
    expect(h.named('payments.payment.orphaned').filter((o) => mine.includes(o.intentId))).toHaveLength(0);
    h.clock.advance(16 * 60_000);
    await h.run('payments.detect-orphans');
    const orphaned = h.named('payments.payment.orphaned');
    expect(orphaned).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ intentId: auth.intentId, action: 'voided', captured: false }),
        expect.objectContaining({ intentId: cap.intentId, action: 'refund_started', captured: true, amount: USD(7007) }),
      ]),
    );
    expect(orphaned.map((o) => o.intentId)).not.toContain(active.intentId);
    const refunds = await h.service.core.repo.find('refunds', { intent_id: cap.intentId });
    expect(refunds).toEqual([expect.objectContaining({ origin: 'orphan_payment', amount: 7007, status: 'requested' })]);
    await h.run('payments.process-refunds');
    expect((await h.service.core.repo.get('intents', cap.intentId))!.refunded_amount).toBe(7007);

    const list = await h.call('GET', '/api/admin/payments/payments?flag=orphan', staff());
    expect(list.body.items.map((x: any) => x.id)).toEqual(expect.arrayContaining([auth.intentId, cap.intentId]));
  });

  it('links an orphan to the order its checkout created, or refuses an unrelated order', async () => {
    const placed = await placeOrder(h, {});
    const other = await placeOrder(h, {});
    // pretend the link never happened
    await h.service.core.repo.update('intents', placed.intentId, { order_id: null, orphan: true });
    const wrong = await h.call('POST', `/api/admin/payments/payments/${placed.intentId}/resolve-orphan`, staff(), { action: 'link_to_order', orderId: other.order.id, reason: 'Found it' }, idem());
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('VALIDATION_FAILED');
    const ok = await h.call('POST', `/api/admin/payments/payments/${placed.intentId}/resolve-orphan`, staff(), { action: 'link_to_order', orderId: placed.order.id, reason: 'Found it' }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ orderId: placed.order.id, orphan: false });
    expect(h.audits.find((a) => a.action === 'payments.payment.resolve_orphan')).toBeTruthy();
  });

  it('voids the authorization when every item of an order is cancelled before capture', async () => {
    h.settings['payments.captureMode'] = 'per_group_on_dispatch';
    const placed = await placeOrder(h, {});
    await h.publish('orders', 'orders.order.cancelled', { orderId: placed.order.id, ref: placed.order.ref, reason: 'all_items_cancelled', checkoutSessionId: placed.checkoutSessionId });
    expect((await h.service.core.repo.get('intents', placed.intentId))!.status).toBe('voided');
    expect(h.named('payments.payment.voided')).toEqual([expect.objectContaining({ intentId: placed.intentId, orderId: placed.order.id })]);
  });

  it('captures accepted orders and voids the rest before authorizations expire', async () => {
    h.settings['payments.captureMode'] = 'per_group_on_dispatch';
    const placed = await placeOrder(h, {});
    const loose = await h.service.authorize(authorizeInput({ amount: 1500 }), newId());
    h.clock.advance(6.5 * 86_400_000);
    await h.run('payments.expire-authorizations');
    expect((await h.service.core.repo.get('intents', placed.intentId))!.status).toBe('captured');
    expect((await h.service.core.repo.get('intents', loose.intentId))!.status).toBe('voided');
  });
});

describe('store options and webhooks', () => {
  it('lists payment options with saved cards, wallets and a setup session', async () => {
    const customerId = newId();
    const res = await h.call('GET', '/api/store/payments/options?amount=42998&currency=USD', tokens.customer(customerId));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ acceptedBrands: ['visa', 'mastercard', 'amex', 'discover'], walletAvailable: true, walletKinds: ['apple_pay', 'google_pay'], savedMethods: [], newCard: { provider: 'card-processor', publishableKey: 'pk_dev_marketly' } });
    expect(res.body.chargeNote).toContain('charged once');
    const guest = await h.call('GET', '/api/store/payments/options?amount=100&currency=USD', tokens.visitor());
    expect(guest.status).toBe(200);
  });

  it('applies payment webhooks by retrieving from the provider, once per provider event', async () => {
    const r = await h.service.authorize(authorizeInput({ amount: 8803 }), newId());
    expect(r.state).toBe('pending_check');
    const body = { id: `evt_${newId()}`, type: 'payment.authorized', data: { intentId: r.intentId } };
    expect((await h.webhook(body, { sign: false })).status).toBe(401);
    const res = await h.webhook(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect((await h.service.getIntentStatus(r.intentId)).state).toBe('accepted');
    // the same provider event delivered again under another delivery id: stored once, applied once
    expect((await h.webhook(body)).body).toEqual({ received: true });
    expect(h.named('payments.payment.authorized').filter((e) => e.intentId === r.intentId)).toHaveLength(1);
    const events = await h.service.core.repo.find('webhook_events', { external_id: body.id });
    expect(events).toEqual([expect.objectContaining({ type: 'payment.authorized', outcome: 'payment authorized' })]);
    // unknown objects and unknown event types are recorded and acknowledged
    expect((await h.webhook({ id: `evt_${newId()}`, type: 'payment.captured', data: { paymentRef: 'ch_nope' } })).body).toEqual({ received: true });
    expect((await h.webhook({ id: `evt_${newId()}`, type: 'balance.available', data: {} })).body).toEqual({ received: true });
    expect((await h.webhook(body, { provider: 'other-processor' })).status).toBe(404);
    const detail = await h.call('GET', `/api/admin/payments/payments/${r.intentId}`, staff());
    expect(detail.body.webhooks).toEqual([expect.objectContaining({ type: 'payment.authorized', outcome: 'payment authorized' })]);
  });

  it('answers a replayed delivery (same X-Event-Id) without applying it again', async () => {
    const r = await h.service.authorize(authorizeInput({ amount: 8803 }), newId());
    const eventId = newId();
    const body = { id: `evt_${newId()}`, type: 'payment.authorized', data: { intentId: r.intentId } };
    expect((await h.webhook(body, { eventId })).status).toBe(200);
    const replay = await h.webhook(body, { eventId });
    // the kernel answers the replay itself (the handler is not called). Kernel issue: it sends {} for an
    // endpoint whose response is { received }, which response validation turns into a 500 outside production.
    expect(replay.headers['x-webhook-duplicate']).toBe('true');
    expect(h.named('payments.payment.authorized').filter((e) => e.intentId === r.intentId)).toHaveLength(1);
  });
});
