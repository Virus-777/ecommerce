/**
 * Gap pass 3: the payment attempt limit (place and retry; edits never reset it), orders created with the real
 * authorize result and the attempt number, the card token cleared after authorize, terms_changed, an Official
 * Store item under a coupon, and guests without an email in the support list.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callers } from '../../../testing/app.js';
import { STORE, USD, fillCart, key, placeBody, readyCheckout, world, type World } from './helpers.js';

let w: World;

beforeAll(async () => {
  w = await world();
}, 120_000);
afterAll(async () => {
  await w?.app.close();
});

const publish = async (source: string, name: string, payload: unknown) => {
  w.app.kernel.events.publish(source, name as never, payload as never);
  await w.app.kernel.events.drain();
};
const storedToken = async (sessionId: string) => w.service.core.payment((await w.service.core.repo.getSession(sessionId))!).method?.providerToken ?? null;

describe('payment attempt limit', () => {
  it('decline → edit → place cannot bypass maxPaymentAttempts (PAYMENT_ATTEMPTS_EXCEEDED); a retry is refused too', async () => {
    const kim = await w.customer('kim-limit@example.com');
    const v = await readyCheckout(w, kim.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 }, { card: 'tok_decline' });
    // four attempts already used on this checkout; the fifth declines
    await w.service.core.repo.updateSession(v.id, { attempt_count: 4 });
    const failed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, kim.token, placeBody(v), { 'idempotency-key': key() });
    expect(failed.body.outcome, JSON.stringify(failed.body)).toBe('payment_failed');

    const retry = await w.call('POST', `${STORE}/sessions/${v.id}/retry-payment`, kim.token, { method: { kind: 'new_card', providerToken: 'tok_mc' }, quoteVersion: failed.body.checkout.quoteVersion, expectedTotal: failed.body.checkout.totals.total, returnUrl: 'https://store.marketly.test/r' }, { 'idempotency-key': key() });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatchObject({ code: 'PAYMENT_ATTEMPTS_EXCEEDED', details: { max: 5 } });

    // go back to checkout (an edit), choose a new card and place again: still refused, nothing authorized
    const pkg = failed.body.checkout.packages[0];
    const edited = await w.call('PUT', `${STORE}/sessions/${v.id}/delivery`, kim.token, { selections: [{ packageKey: pkg.key, optionId: pkg.options[1].id }] });
    expect(edited.body.status).toBe('open');
    const card = await w.call('PUT', `${STORE}/sessions/${v.id}/payment-method`, kim.token, { kind: 'new_card', providerToken: 'tok_visa', label: 'Mastercard •••• 4444' });
    expect(card.status).toBe(200);
    const auths = w.pay.calls.authorize.length;
    const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, kim.token, placeBody(card.body), { 'idempotency-key': key() });
    expect(placed.status).toBe(409);
    expect(placed.body.error).toMatchObject({ code: 'PAYMENT_ATTEMPTS_EXCEEDED', details: { max: 5, attempts: 5 } });
    expect(w.pay.calls.authorize.length).toBe(auths);
    expect((await w.service.core.repo.getSession(v.id))!.attempt_count).toBe(5);
  });
});

describe('the order from the authorize result', () => {
  it('an accepted payment creates the order open in one step, with attemptNo, and clears the card token', async () => {
    const lea = await w.customer('lea-accepted@example.com');
    const v = await readyCheckout(w, lea.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 });
    expect(await storedToken(v.id)).toBe('tok_visa');
    const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, lea.token, placeBody(v), { 'idempotency-key': key() });
    expect(placed.body.outcome, JSON.stringify(placed.body)).toBe('accepted');
    const event = w.named('orders.order.placed').find((e) => e.orderId === placed.body.orderId);
    // before pass 3 the order was created pending_check and accepted afterwards
    expect(event).toMatchObject({ checkoutSessionId: v.id, paymentState: 'accepted', attemptNo: 1, contactName: expect.any(String) });
    expect((await w.api('orders').getOrder(placed.body.orderId)).lifecycle).toBe('open');
    expect(await storedToken(v.id)).toBeNull();
  });

  it('a declined card token is cleared too; the retry after a finally declined pending payment is attempt 2 of the same session', async () => {
    const max = await w.customer('max-pending@example.com');
    await fillCart(w, max.token, [{ offerId: w.offers.white, quantity: 1 }]);
    const v = await readyCheckout(w, max.token, { source: 'cart' }, { card: 'tok_pending' });
    const res = await w.call('POST', `${STORE}/sessions/${v.id}/place`, max.token, placeBody(v), { 'idempotency-key': key() });
    expect(res.body.outcome).toBe('payment_pending');
    expect(await storedToken(v.id)).toBeNull();
    const firstOrder = res.body.orderId;
    const intentId = [...w.pay.intents.values()].find((i) => i.input.checkoutSessionId === v.id)!.id;
    w.pay.intents.get(intentId)!.state = 'failed';
    await publish('payments', 'payments.payment.failed', { intentId, checkoutSessionId: v.id, orderId: firstOrder, declineCategory: 'card_declined', afterPendingCheck: true, at: new Date().toISOString() });
    const s = (await w.call('GET', `${STORE}/sessions/${v.id}`, max.token)).body;
    expect(s.status).toBe('payment_failed');

    const retried = await w.call('POST', `${STORE}/sessions/${v.id}/retry-payment`, max.token, { method: { kind: 'digital_wallet', providerToken: 'tok_wallet', label: 'Apple Pay' }, quoteVersion: s.quoteVersion, expectedTotal: s.totals.total, returnUrl: 'https://store.marketly.test/r' }, { 'idempotency-key': key() });
    expect(retried.body.outcome, JSON.stringify(retried.body)).toBe('accepted');
    expect(retried.body.orderId).not.toBe(firstOrder);
    const placedEvents = w.named('orders.order.placed').filter((e) => e.checkoutSessionId === v.id);
    expect(placedEvents.map((e) => [e.attemptNo, e.paymentState])).toEqual([
      [1, 'pending_check'],
      [2, 'accepted'],
    ]);
    expect(await storedToken(v.id)).toBeNull();
  });
});

describe('terms_changed', () => {
  it('shows changed dispatch terms as a change to accept before Place order', async () => {
    const ned = await w.customer('ned-terms@example.com');
    const v = await readyCheckout(w, ned.token, { source: 'buy_now', offerId: w.offers.black, quantity: 1 });
    const patched = await w.call('PATCH', `/api/seller/offers/offers/${w.offers.black}`, w.sellerToken, { dispatchBusinessDays: 3 });
    expect(patched.status, JSON.stringify(patched.body)).toBeLessThan(300);
    const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, ned.token, placeBody(v), { 'idempotency-key': key() });
    expect(placed.body.outcome, JSON.stringify(placed.body)).toBe('changes_required');
    const change = placed.body.changeSet.changes.find((c: any) => c.kind === 'terms_changed');
    expect(change).toMatchObject({ headline: 'Return or delivery terms changed', defaultChoice: 'accept', lineId: expect.any(String) });
    expect(change.choices).toEqual(expect.arrayContaining(['accept', 'remove']));

    const decisions = placed.body.changeSet.changes.map((c: any) => ({ changeId: c.id, choice: c.defaultChoice }));
    const accepted = await w.call('POST', `${STORE}/sessions/${v.id}/changes/${placed.body.changeSet.id}/accept`, ned.token, { decisions, acceptPartialOrder: false });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const card = await w.call('PUT', `${STORE}/sessions/${v.id}/payment-method`, ned.token, { kind: 'new_card', providerToken: 'tok_visa', label: 'Mastercard •••• 4444' });
    const done = await w.call('POST', `${STORE}/sessions/${v.id}/place`, ned.token, placeBody(card.body), { 'idempotency-key': key() });
    expect(done.body.outcome, JSON.stringify(done.body)).toBe('accepted');
  });
});

describe('an Official Store item under a coupon', () => {
  it('places the order with the discount (promotions gets OFFICIAL_STORE_ID, never an empty seller id)', async () => {
    const marketing = await w.f.staffWithRoles(w.owner, 'ola@marketly.test', 'Ola Marketing', ['marketing_manager']);
    // a campaign's creator can't confirm its own funding: a second marketing manager does
    const reviewer = await w.f.staffWithRoles(w.owner, 'oscar@marketly.test', 'Oscar Marketing', ['marketing_manager']);
    const now = w.clock.now().getTime();
    const created = await w.call('POST', '/api/admin/promotions/campaigns', marketing.accessToken, {
      name: 'Official three',
      description: '$3 off',
      discount: { kind: 'fixed_coupon', amountOff: USD(300) },
      code: 'OFF3',
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 7 * 86_400_000).toISOString(),
      timeZone: 'America/Los_Angeles',
      scope: { mode: 'sitewide', include: [], exclude: [] },
      eligibility: { audience: 'everyone' },
      limits: { budget: USD(100_000) },
      funding: { owner: 'platform', costCenter: 'MKT-01' },
      stacking: { withSellerMarkdowns: true, withOtherCoupons: false, withFreeShipping: true, withFlashSalePrices: false },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    for (const step of ['submit', 'confirm-funding', 'schedule']) {
      const r = await w.call('POST', `/api/admin/promotions/campaigns/${created.body.id}/${step}`, (step === 'confirm-funding' ? reviewer : marketing).accessToken, {});
      expect(r.status, `${step}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    const promo = w.api('promotions') as { evaluateCart(input: any): Promise<unknown> };
    const evaluate = promo.evaluateCart.bind(promo);
    const seen: any[] = [];
    promo.evaluateCart = async (input: any) => {
      seen.push(input);
      return evaluate(input);
    };
    try {
      const oz = await w.customer('oz-official@example.com');
      const v = await readyCheckout(w, oz.token, { source: 'buy_now', offerId: w.offers.officialWhite, quantity: 1 });
      const applied = await w.call('POST', `${STORE}/sessions/${v.id}/coupons`, oz.token, { code: 'OFF3' });
      expect(applied.body.result, JSON.stringify(applied.body)).toMatchObject({ status: 'applied', amount: USD(300) });
      expect(seen.at(-1).lines[0]).toMatchObject({ sellerId: '00000000-0000-7000-8000-000000000001', officialStore: true });
      const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, oz.token, placeBody(applied.body.checkout), { 'idempotency-key': key() });
      expect(placed.status, JSON.stringify(placed.body)).toBe(200);
      expect(placed.body.outcome).toBe('accepted');
      const order = await w.api('orders').getOrder(placed.body.orderId);
      expect(order.totals.discountTotal).toEqual(USD(300));
    } finally {
      promo.evaluateCart = evaluate;
    }
  });
});

describe('coupon "not covered" reasons (G15c)', () => {
  it('explains the lines an applied coupon leaves out with the same wording as the cart', async () => {
    const promo = w.api('promotions') as { evaluateCart(input: any): Promise<unknown> };
    const evaluate = promo.evaluateCart.bind(promo);
    const campaignId = randomUUID();
    // the coupon covers the first line; the second already has a sale price
    promo.evaluateCart = async (input: any) => {
      const [first, second] = input.lines;
      return {
        evaluationId: randomUUID(),
        validUntil: new Date(w.clock.now().getTime() + 600_000).toISOString(),
        lines: input.lines.map((l: any) => ({
          lineId: l.lineId,
          regularUnitPrice: l.unitPrice,
          unitPrice: l.lineId === second.lineId ? USD(l.unitPrice.amount - 100) : l.unitPrice,
          allocations: l.lineId === first.lineId && input.codes.includes('G15C') ? [{ campaignId, code: 'G15C', label: '$1 off', amount: USD(100), platformPart: USD(100), sellerPart: USD(0) }] : [],
          lineDiscount: USD(0),
          limitExceeded: false,
          discountedQuantity: l.quantity,
        })),
        packages: [],
        applied: input.codes.includes('G15C') ? [{ campaignId, code: 'G15C', label: '$1 off', amount: USD(100), coversLineIds: [first.lineId], source: 'code' }] : [],
        rejected: [],
        skipped: [],
        totals: { total: USD(0), platform: USD(0), seller: USD(0) },
        changes: [],
      };
    };
    try {
      const gus = await w.customer('gus-coupon@example.com');
      await fillCart(w, gus.token, [
        { offerId: w.offers.black, quantity: 1 },
        { offerId: w.offers.white, quantity: 1 },
      ]);
      const v = await readyCheckout(w, gus.token, { source: 'cart' });
      const applied = await w.call('POST', `${STORE}/sessions/${v.id}/coupons`, gus.token, { code: 'G15C' });
      expect(applied.body.result, JSON.stringify(applied.body)).toMatchObject({ status: 'applied', amount: USD(100) });
      expect(applied.body.result.coverage).toHaveLength(1);
      expect(applied.body.result.notCovered).toEqual([{ lineId: expect.any(String), title: expect.any(String), reason: 'Already on sale' }]);
      expect(applied.body.result.notCovered[0].lineId).not.toBe(applied.body.result.coverage[0].lineId);
    } finally {
      promo.evaluateCart = evaluate;
    }
  });
});

describe('support list', () => {
  it('lists a guest checkout that expired before the contact step (no email)', async () => {
    const visitor = callers.visitor();
    const started = await w.call('POST', `${STORE}/sessions`, visitor, { source: 'buy_now', offerId: w.offers.white, quantity: 1 });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    await w.service.core.repo.updateSession(started.body.id, { status: 'expired' });
    const list = await w.call('GET', '/api/admin/checkout/sessions?status=expired&limit=100', callers.staff(['checkout.sessions.view']));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.find((r: any) => r.id === started.body.id)).toMatchObject({ guest: true, email: null, customerName: null });
  });
});
