/**
 * Checkout end to end on the real shopping path: a real cart becomes a real order (orders), stock is held
 * and allocated (inventory), the cart keeps the other lines (cart), plus idempotent Place order
 * (scenario 3), revalidation with change sets (scenario 2) and every payment result.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANCHORAGE, PORTLAND, SAVED_CARD_ID, SEATTLE, STORE, USD, fillCart, key, placeBody, readyCheckout, world, type World } from './helpers.js';

let w: World;

beforeAll(async () => {
  w = await world();
}, 120_000);
afterAll(async () => {
  await w?.app.close();
});

const available = async (stockItemId: string) => ((await w.api('inventory').getAvailability([stockItemId])) as Record<string, { available: number }>)[stockItemId]!.available;

describe('start, steps and totals', () => {
  let ana: Awaited<ReturnType<World['customer']>>;
  let id: string;

  it('starts from the cart with eligible lines, one seller package and the customer pre-filled', async () => {
    ana = await w.customer('ana@example.com');
    await fillCart(w, ana.token, [
      { offerId: w.offers.black, quantity: 1 },
      { offerId: w.offers.white, quantity: 2 },
    ]);
    const res = await w.call('POST', `${STORE}/sessions`, ana.token, { source: 'cart' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const v = res.body;
    id = v.id;
    expect(v).toMatchObject({ status: 'open', source: 'cart', currency: 'USD', readyToPlace: false, account: { kind: 'customer', email: 'ana@example.com', customerId: ana.customerId } });
    expect(v.packages).toHaveLength(1);
    expect(v.packages[0]).toMatchObject({ label: 'Package 1 of 1', soldAndShippedBy: 'Sold and shipped by Northwind Audio', seller: { name: 'Northwind Audio', ownerType: 'seller' } });
    expect(v.packages[0].lines.map((l: any) => [l.title, l.variantLabel, l.quantity, l.unitPrice.amount])).toEqual(
      expect.arrayContaining([
        ['Aurora wireless headphones', 'Black', 1, 18900],
        ['Aurora wireless headphones', 'White', 2, 2500],
      ]),
    );
    expect(v.totals).toMatchObject({ itemCount: 3, items: USD(23900), total: USD(23900), taxNote: 'Tax is calculated once you enter a delivery address.' });
    // G19: lines link to the product page (/p/{slug}/{id})
    expect(v.packages[0].lines[0]).toMatchObject({ productSlug: 'aurora-wireless-headphones', productId: expect.any(String) });
    // G15b: before an address no option is chosen, so the package's shipping is pending (not free)
    expect(v.totals.shippingByPackage).toEqual([expect.objectContaining({ amount: USD(0), free: false, pending: true })]);
    expect(v.blockers).toEqual(expect.arrayContaining(['Choose a delivery address', 'Choose a payment method']));
    expect(v.steps.find((s: any) => s.key === 'account')).toMatchObject({ status: 'done' });
    expect(v.payment.options.savedMethods[0].id).toBe(SAVED_CARD_ID);
    expect(w.named('checkout.session.started').at(-1)).toMatchObject({ sessionId: id, source: 'cart', customerId: ana.customerId, guest: false, lineCount: 2, total: USD(23900) });
  });

  it('keeps another shopper out (404)', async () => {
    const other = await w.customer('olga@example.com');
    expect((await w.call('GET', `${STORE}/sessions/${id}`, other.token)).status).toBe(404);
    expect((await w.call('PUT', `${STORE}/sessions/${id}/address`, other.token, { address: PORTLAND })).status).toBe(404);
    expect((await w.call('GET', `${STORE}/sessions/${id}`, await w.f.visitor())).status).toBe(404);
  });

  it('checks every item can ship to the address, then quotes delivery per package and tax', async () => {
    const res = await w.call('PUT', `${STORE}/sessions/${id}/address`, ana.token, { address: SEATTLE });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const v = res.body;
    expect(v.address).toMatchObject({ allShippable: true, message: 'All 2 items can ship to this address.', locationNote: 'Delivery dates below are for Seattle, WA 98101.' });
    expect(v.packages[0].options.map((o: any) => o.methodName)).toEqual(['Standard', 'Express']);
    expect(v.packages[0].selectedOptionId).toBe(v.packages[0].options[0].id);
    // free standard shipping over $50; WA 6.5% on the items
    expect(v.totals).toMatchObject({ shippingTotal: USD(0), taxTotal: USD(1554), total: USD(23900 + 1554) });
    expect(v.totals.shippingByPackage).toEqual([expect.objectContaining({ amount: USD(0), free: true, pending: false })]);
    expect(v.totals.tax[0]).toMatchObject({ jurisdiction: 'WA', rate: 0.065 });
    expect(v.quoteVersion).toBeGreaterThan(1);
  });

  it('refuses an address the validator rejects', async () => {
    const res = await w.call('PUT', `${STORE}/sessions/${id}/address`, ana.token, { address: { ...PORTLAND, postalCode: '12' } });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe('ADDRESS_INVALID');
  });

  it('marks lines that cannot ship to the address and keeps them out of the order', async () => {
    const res = await w.call('PUT', `${STORE}/sessions/${id}/address`, ana.token, { address: ANCHORAGE });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.address.allShippable).toBe(false);
    expect(res.body.address.lines.every((l: any) => l.reason === 'outside_seller_coverage')).toBe(true);
    expect(res.body.packages).toHaveLength(0);
    expect(res.body.excludedLines.map((l: any) => l.status)).toEqual(['not_shippable', 'not_shippable']);
    expect(res.body.blockers).toContain('None of your items can ship to this address');
    const back = await w.call('PUT', `${STORE}/sessions/${id}/address`, ana.token, { address: PORTLAND });
    expect(back.body.packages[0].lines).toHaveLength(2);
    expect(back.body.totals.tax[0]).toMatchObject({ jurisdiction: 'OR', label: 'Tax (Oregon has no sales tax)', amount: USD(0) });
  });

  it('switches a package to another delivery option and bumps the quote version', async () => {
    const before = (await w.call('GET', `${STORE}/sessions/${id}`, ana.token)).body;
    const pkg = before.packages[0];
    const express = pkg.options.find((o: any) => o.methodName === 'Express');
    const res = await w.call('PUT', `${STORE}/sessions/${id}/delivery`, ana.token, { selections: [{ packageKey: pkg.key, optionId: express.id }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.packages[0].selectedOptionId).toBe(express.id);
    expect(res.body.totals.shippingTotal).toEqual(USD(1499));
    expect(res.body.quoteVersion).toBe(before.quoteVersion + 1);
    const bad = await w.call('PUT', `${STORE}/sessions/${id}/delivery`, ana.token, { selections: [{ packageKey: pkg.key, optionId: 'gone' }] });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatchObject({ code: 'DELIVERY_OPTION_UNAVAILABLE' });
    expect(bad.body.error.details.options).toHaveLength(2);
  });

  it('explains a coupon that does not apply and keeps the total', async () => {
    const before = (await w.call('GET', `${STORE}/sessions/${id}`, ana.token)).body;
    const res = await w.call('POST', `${STORE}/sessions/${id}/coupons`, ana.token, { code: 'NOPE10' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toMatchObject({ code: 'NOPE10', status: 'rejected', rejectionCode: 'not_found' });
    expect(res.body.result.reason).toContain("couldn't find");
    expect(res.body.checkout.quoteVersion).toBe(before.quoteVersion);
    expect(res.body.checkout.coupons).toEqual([]);
    expect((await w.call('DELETE', `${STORE}/sessions/${id}/coupons/NOPE10`, ana.token)).status).toBe(200);
  });

  it('chooses a saved card, a gift note and checks what Place order needs', async () => {
    const card = await w.call('PUT', `${STORE}/sessions/${id}/payment-method`, ana.token, { kind: 'saved_card', savedMethodId: SAVED_CARD_ID });
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    expect(card.body.payment.selected).toMatchObject({ kind: 'saved_card', label: 'Visa •••• 4242', billingSummary: 'Home, Portland 97204' });
    const unknown = await w.call('PUT', `${STORE}/sessions/${id}/payment-method`, ana.token, { kind: 'saved_card', savedMethodId: crypto.randomUUID() });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('PAYMENT_METHOD_INVALID');
    const prefs = await w.call('PUT', `${STORE}/sessions/${id}/preferences`, ana.token, { giftNote: 'Happy birthday!', hidePricesOnSlip: true });
    expect(prefs.body).toMatchObject({ giftNote: 'Happy birthday!', readyToPlace: true, blockers: [] });
    const v = prefs.body;

    const terms = await w.call('POST', `${STORE}/sessions/${id}/place`, ana.token, placeBody(v, { acceptTerms: false }), { 'idempotency-key': key() });
    expect(terms.body.error.code).toBe('TERMS_NOT_ACCEPTED');
    const stale = await w.call('POST', `${STORE}/sessions/${id}/place`, ana.token, placeBody({ ...v, quoteVersion: v.quoteVersion - 1 }), { 'idempotency-key': key() });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'QUOTE_OUTDATED', details: { quoteVersion: v.quoteVersion } });
    const wrongTotal = await w.call('POST', `${STORE}/sessions/${id}/place`, ana.token, placeBody({ ...v, totals: { total: USD(1) } }), { 'idempotency-key': key() });
    expect(wrongTotal.body.error.code).toBe('QUOTE_OUTDATED');
    expect(w.pay.calls.authorize).toHaveLength(0);
  });

  it('places the order once: stock held then allocated, order accepted, purchased lines leave the cart', async () => {
    const v = (await w.call('GET', `${STORE}/sessions/${id}`, ana.token)).body;
    const blackBefore = await available(w.stock.black);
    const k = key();
    const res = await w.call('POST', `${STORE}/sessions/${id}/place`, ana.token, placeBody(v), { 'idempotency-key': k });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'accepted', next: 'confirmation', checkout: { status: 'completed' } });
    const orderId = res.body.orderId as string;
    expect(res.body.orderRef).toMatch(/^MK-/);

    // payments got one authorization for the total the customer saw
    expect(w.pay.calls.authorize).toHaveLength(1);
    expect(w.pay.calls.authorize[0]).toMatchObject({ key: `${id}:1`, input: { checkoutSessionId: id, attemptNo: 1, customerId: ana.customerId, amount: v.totals.total, method: { kind: 'saved_card', savedMethodId: SAVED_CARD_ID } } });
    expect(w.pay.calls.linkOrder.at(-1)).toMatchObject({ orderId });

    // orders: the real order, accepted, with the frozen choices
    const order = await w.api('orders').getOrder(orderId);
    expect(order).toMatchObject({ lifecycle: 'open', contact: { kind: 'customer', email: 'ana@example.com' }, paymentIntentId: w.pay.calls.authorize[0]!.input && expect.any(String) });
    expect(order.totals.total).toEqual(v.totals.total);
    expect(order.groups[0].delivery).toMatchObject({ methodName: 'Express' });
    expect(order.deliveryAddress).toMatchObject({ city: 'Portland', postalCode: '97204' });

    // inventory: the hold was attached and allocated on acceptance
    expect(await available(w.stock.black)).toBe(blackBefore - 1);
    expect(w.named('inventory.reservation.allocated').some((e) => e.orderId === orderId)).toBe(true);

    // cart: the purchased lines are gone
    const cart = await w.call('GET', '/api/store/cart/cart', ana.token);
    expect(JSON.stringify(cart.body)).not.toContain(w.offers.black);

    expect(w.named('checkout.session.completed').at(-1)).toMatchObject({ sessionId: id, orderId, paymentState: 'accepted', guest: false, email: 'ana@example.com', total: v.totals.total });

    // the same key, a new key, a refresh: the same order and no second charge
    const again = await w.call('POST', `${STORE}/sessions/${id}/place`, ana.token, placeBody(v), { 'idempotency-key': k });
    expect(again.body).toMatchObject({ outcome: 'accepted', orderId });
    const newKey = await w.call('POST', `${STORE}/sessions/${id}/place`, ana.token, placeBody(v), { 'idempotency-key': key() });
    expect(newKey.status, JSON.stringify(newKey.body)).toBe(200);
    expect(newKey.body).toMatchObject({ outcome: 'accepted', orderId });
    expect(w.pay.calls.authorize).toHaveLength(1);
    expect(w.named('orders.order.placed').filter((e) => e.orderId === orderId)).toHaveLength(1);

    const conf = await w.call('GET', `${STORE}/sessions/${id}/confirmation`, ana.token);
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    expect(conf.body).toMatchObject({ orderId, orderRef: res.body.orderRef, email: 'ana@example.com', charged: v.totals.total, paymentLabel: 'Visa •••• 4242', paymentState: 'accepted', offerAccountCreation: false });
    expect(conf.body.packages[0]).toMatchObject({ label: 'Package 1 of 1', shippingLabel: 'Express · $14.99' });
    expect(conf.body.receiptDocumentId).toEqual(expect.any(String));

    // a finished checkout can't be left or edited
    expect((await w.call('DELETE', `${STORE}/sessions/${id}`, ana.token)).status).toBe(409);
    expect((await w.call('PUT', `${STORE}/sessions/${id}/address`, ana.token, { address: SEATTLE })).status).toBe(409);
  });
});

describe('a mixed purchase (scenario 1)', () => {
  it('checks out the Official Store and a seller in one order: one package each, with their own options and totals', async () => {
    const mo = await w.customer('mo@example.com');
    await fillCart(w, mo.token, [
      { offerId: w.offers.black, quantity: 1 },
      { offerId: w.offers.officialWhite, quantity: 2 },
    ]);
    const v = await readyCheckout(w, mo.token, { source: 'cart' }, { address: SEATTLE });
    expect(v.packages.map((p: any) => [p.label, p.seller.name, p.seller.official])).toEqual([
      ['Package 1 of 2', 'Northwind Audio', false],
      ['Package 2 of 2', 'Marketly Official Store', true],
    ]);
    expect(v.packagesNote).toBe('Your items ship in 2 packages from different places, so each has its own options and arrival date.');
    expect(v.packages[1].sellerSupport).toBe('Marketly support replies within 1 business day');
    // the official package is under $50: Standard is charged there only
    expect(v.totals.shippingByPackage.map((s: any) => s.amount.amount)).toEqual([0, 599]);
    expect(v.totals.perPackage.map((p: any) => p.total.amount)).toEqual([18900 + 1229, 4600 + 599 + 299]);
    expect(v.totals.total.amount).toBe(18900 + 1229 + 4600 + 599 + 299);

    const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, mo.token, placeBody(v), { 'idempotency-key': key() });
    expect(placed.body.outcome, JSON.stringify(placed.body)).toBe('accepted');
    const order = await w.api('orders').getOrder(placed.body.orderId);
    expect(order.groups.map((g: any) => [g.seller.ownerType, g.fulfilledBy, g.totals.total.amount])).toEqual([
      ['seller', 'seller', 18900 + 1229],
      ['official', 'official_warehouse', 4600 + 599 + 299],
    ]);
    expect(w.pay.calls.linkOrder.at(-1)!.allocations.map((a) => a.amount.amount)).toEqual([18900 + 1229, 4600 + 599 + 299]);
  });

  it('enforces the per-customer purchase limit at Buy now', async () => {
    const ned = await w.customer('ned@example.com');
    const res = await w.call('POST', `${STORE}/sessions`, ned.token, { source: 'buy_now', offerId: w.offers.officialWhite, quantity: 4 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'PURCHASE_LIMIT_EXCEEDED', details: { max: 3 } });
  });
});

describe('coupons (promotions)', () => {
  it('applies a live coupon with its coverage, reserves it at Place order and commits it to the order', async () => {
    const marketing = await w.f.staffWithRoles(w.owner, 'mia@marketly.test', 'Mia Marketing', ['marketing_manager']);
    const staff = marketing.accessToken;
    // a campaign's creator can't confirm its own funding: a second marketing manager does
    const reviewer = (await w.f.staffWithRoles(w.owner, 'max@marketly.test', 'Max Marketing', ['marketing_manager'])).accessToken;
    const now = w.clock.now().getTime();
    const input = {
      name: 'Welcome five',
      description: '$5 off your order',
      discount: { kind: 'fixed_coupon', amountOff: USD(500) },
      code: 'SAVE5',
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 7 * 86_400_000).toISOString(),
      timeZone: 'America/Los_Angeles',
      scope: { mode: 'sitewide', include: [], exclude: [] },
      eligibility: { audience: 'everyone' },
      limits: { budget: USD(100_000) },
      funding: { owner: 'platform', costCenter: 'MKT-01' },
      stacking: { withSellerMarkdowns: true, withOtherCoupons: false, withFreeShipping: true, withFlashSalePrices: false },
    };
    const created = await w.call('POST', '/api/admin/promotions/campaigns', staff, input);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    for (const step of ['submit', 'confirm-funding', 'schedule']) {
      const r = await w.call('POST', `/api/admin/promotions/campaigns/${created.body.id}/${step}`, step === 'confirm-funding' ? reviewer : staff, {});
      expect(r.status, `${step}: ${JSON.stringify(r.body)}`).toBe(200);
    }

    const zoe = await w.customer('zoe@example.com');
    const v = await readyCheckout(w, zoe.token, { source: 'buy_now', offerId: w.offers.white, quantity: 2 });
    const applied = await w.call('POST', `${STORE}/sessions/${v.id}/coupons`, zoe.token, { code: 'save5' });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.result).toMatchObject({ code: 'SAVE5', status: 'applied', amount: USD(500), fundedBy: 'platform', fundingNote: 'Funded by Marketly, so sellers receive their full price.' });
    expect(applied.body.result.coverage).toHaveLength(1);
    const c = applied.body.checkout;
    expect(c.totals).toMatchObject({ discountTotal: USD(500), total: USD(v.totals.total.amount - 500) });
    expect(c.packages[0].lines[0].discounts[0]).toMatchObject({ code: 'SAVE5', amount: USD(500) });
    expect(c.quoteVersion).toBe(v.quoteVersion + 1);

    // removing and re-applying the code moves the total back and forth
    const removed = await w.call('DELETE', `${STORE}/sessions/${v.id}/coupons/SAVE5`, zoe.token);
    expect(removed.body).toMatchObject({ coupons: [], totals: { discountTotal: USD(0), total: v.totals.total } });
    const again = await w.call('POST', `${STORE}/sessions/${v.id}/coupons`, zoe.token, { code: 'SAVE5' });
    expect(again.body.result.status).toBe('applied');
    expect(again.body.checkout.totals.total).toEqual(c.totals.total);
    // store credit is a phase 3 step
    const credit = await w.call('PUT', `${STORE}/sessions/${v.id}/credit`, zoe.token, { use: true });
    expect(credit.body.error).toMatchObject({ code: 'NOT_IMPLEMENTED', details: { reason: 'later_phase' } });

    const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, zoe.token, placeBody(again.body.checkout), { 'idempotency-key': key() });
    expect(placed.body.outcome, JSON.stringify(placed.body)).toBe('accepted');
    const order = await w.api('orders').getOrder(placed.body.orderId);
    expect(order.totals.discountTotal).toEqual(USD(500));
    expect(order.groups[0].items[0].discounts[0]).toMatchObject({ code: 'SAVE5', amount: USD(500) });
    const split = await w.api('promotions').fundingSplitFor(order.groups[0].items[0].id);
    expect(split.platformFunded).toEqual(USD(500));
  });
});

describe('changes before charging (scenario 2)', () => {
  it('shows a price change as a change set, charges nothing, and places at the accepted price', async () => {
    const ben = await w.customer('ben@example.com');
    const v = await readyCheckout(w, ben.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 });
    expect(v.source).toBe('buy_now');
    expect(v.totals.items).toEqual(USD(2500));
    const raise = await w.call('POST', '/api/seller/offers/price-changes', w.sellerToken, { items: [{ offerId: w.offers.white, price: USD(2900) }] });
    expect(raise.status, JSON.stringify(raise.body)).toBeLessThan(300);
    const authBefore = w.pay.calls.authorize.length;

    const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, ben.token, placeBody(v), { 'idempotency-key': key() });
    expect(placed.status, JSON.stringify(placed.body)).toBe(200);
    expect(placed.body).toMatchObject({ outcome: 'changes_required', next: 'review_changes', orderId: null, checkout: { status: 'changes_pending' } });
    expect(w.pay.calls.authorize.length).toBe(authBefore);
    const cs = placed.body.changeSet;
    expect(cs).toMatchObject({ status: 'open', previousTotal: USD(2500 + 599), newTotal: USD(2900 + 599), partialOrder: false });
    expect(cs.changes).toHaveLength(1);
    expect(cs.changes[0]).toMatchObject({ kind: 'price_increased', headline: 'Price went up', previous: '$25.00', current: '$29.00', defaultChoice: 'accept', effectOnTotal: USD(400), sellerName: 'Northwind Audio' });
    expect(cs.changes[0].choices).toEqual(expect.arrayContaining(['accept', 'remove']));
    expect(w.named('checkout.changes.detected').at(-1)).toMatchObject({ sessionId: v.id, changeSetId: cs.id, kinds: ['price_increased'], previousTotal: USD(3099), newTotal: USD(3499) });

    const got = await w.call('GET', `${STORE}/sessions/${v.id}/changes/${cs.id}`, ben.token);
    expect(got.body.id).toBe(cs.id);
    expect((await w.call('PUT', `${STORE}/sessions/${v.id}/address`, ben.token, { address: SEATTLE })).status).toBe(409);
    const missing = await w.call('POST', `${STORE}/sessions/${v.id}/changes/${cs.id}/accept`, ben.token, { decisions: [], acceptPartialOrder: false });
    expect(missing.status).toBe(422);
    expect(missing.body.error).toMatchObject({ code: 'DECISION_MISSING', details: { changeIds: [cs.changes[0].id] } });

    const accepted = await w.call('POST', `${STORE}/sessions/${v.id}/changes/${cs.id}/accept`, ben.token, { decisions: [{ changeId: cs.changes[0].id, choice: 'accept' }], acceptPartialOrder: false });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'open', totals: { total: USD(3499) } });
    expect(accepted.body.quoteVersion).toBeGreaterThan(v.quoteVersion);
    expect(w.named('checkout.changes.accepted').at(-1)).toMatchObject({ sessionId: v.id, changeSetId: cs.id, removedLines: 0, switchedOffers: 0, partialOrder: false });
    const stale = await w.call('POST', `${STORE}/sessions/${v.id}/changes/${cs.id}/accept`, ben.token, { decisions: [{ changeId: cs.changes[0].id, choice: 'accept' }], acceptPartialOrder: false });
    expect(stale.body.error.code).toBe('CHANGESET_STALE');

    const done = await w.call('POST', `${STORE}/sessions/${v.id}/place`, ben.token, placeBody(accepted.body), { 'idempotency-key': key() });
    expect(done.body).toMatchObject({ outcome: 'accepted' });
    expect(w.pay.calls.authorize.at(-1)!.input.amount).toEqual(USD(3499));
    const order = await w.api('orders').getOrder(done.body.orderId);
    expect(order.groups[0].items[0].unitPrice).toEqual(USD(2900));
  });

  it('reports a moved delivery date and a new shipping cost; the customer picks another option', async () => {
    const dee = await w.customer('dee@example.com');
    const v = await readyCheckout(w, dee.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 });
    w.ship.knobs.shiftDays = 2;
    w.ship.knobs.standardPrice = 799;
    try {
      const found = await w.call('POST', `${STORE}/sessions/${v.id}/revalidate`, dee.token);
      expect(found.body.outcome, JSON.stringify(found.body)).toBe('changes_found');
      const cs = found.body.changeSet;
      const kinds = cs.changes.map((c: any) => c.kind).sort();
      expect(kinds).toEqual(['delivery_date_changed', 'shipping_cost_changed']);
      const cost = cs.changes.find((c: any) => c.kind === 'shipping_cost_changed');
      expect(cost).toMatchObject({ previous: '$5.99', current: '$7.99', effectOnTotal: USD(200), packageKey: v.packages[0].key, choices: ['accept', 'choose_other_option'] });
      expect(cs.newTotal).toEqual(USD(v.totals.total.amount + 200));
      const express = v.packages[0].options.find((o: any) => o.methodName === 'Express');
      const decided = await w.call('POST', `${STORE}/sessions/${v.id}/changes/${cs.id}/accept`, dee.token, {
        decisions: cs.changes.map((c: any) => ({ changeId: c.id, choice: 'choose_other_option', optionId: express.id })),
        acceptPartialOrder: false,
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      expect(decided.body.packages[0].selectedOptionId).toBe(express.id);
      expect(decided.body.totals.shippingTotal).toEqual(USD(1499));
    } finally {
      w.ship.knobs.shiftDays = 0;
      w.ship.knobs.standardPrice = 599;
    }
  });

  it('revalidates on demand: no changes, then a stock shortage with an explicit partial order', async () => {
    const cy = await w.customer('cy@example.com');
    await fillCart(w, cy.token, [
      { offerId: w.offers.black, quantity: 1 },
      { offerId: w.offers.white, quantity: 1 },
    ]);
    const v = await readyCheckout(w, cy.token, { source: 'cart' });
    const none = await w.call('POST', `${STORE}/sessions/${v.id}/revalidate`, cy.token);
    expect(none.status, JSON.stringify(none.body)).toBe(200);
    expect(none.body).toMatchObject({ outcome: 'no_changes', changeSet: null, checkout: { quoteVersion: v.quoteVersion } });

    // the seller's white stock runs out
    const zero = await w.call('POST', `/api/seller/inventory/stock-items/${w.stock.white}/adjustments`, w.sellerToken, { newAvailable: 0, reasonCode: 'moved_to_another_channel', note: 'Sold elsewhere' });
    expect(zero.status, JSON.stringify(zero.body)).toBeLessThan(300);
    const found = await w.call('POST', `${STORE}/sessions/${v.id}/revalidate`, cy.token);
    expect(found.body.outcome, JSON.stringify(found.body)).toBe('changes_found');
    const cs = found.body.changeSet;
    const change = cs.changes.find((c: any) => c.kind === 'out_of_stock');
    expect(change).toMatchObject({ defaultChoice: 'remove', availableQuantity: 0 });
    expect(cs.partialOrder).toBe(true);
    expect(cs.partialNote).toContain('rest of your order');

    const refused = await w.call('POST', `${STORE}/sessions/${v.id}/changes/${cs.id}/accept`, cy.token, { decisions: cs.changes.map((c: any) => ({ changeId: c.id, choice: c.defaultChoice })), acceptPartialOrder: false });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('PARTIAL_ORDER_NOT_ACCEPTED');
    const ok = await w.call('POST', `${STORE}/sessions/${v.id}/changes/${cs.id}/accept`, cy.token, { decisions: cs.changes.map((c: any) => ({ changeId: c.id, choice: c.defaultChoice })), acceptPartialOrder: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.packages[0].lines.map((l: any) => l.offerId)).toEqual([w.offers.black]);
    expect(ok.body.excludedLines.find((l: any) => l.offerId === w.offers.white)).toMatchObject({ status: 'removed' });
    expect(w.named('checkout.changes.accepted').at(-1)).toMatchObject({ removedLines: 1, partialOrder: true });

    const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, cy.token, placeBody(ok.body), { 'idempotency-key': key() });
    expect(placed.body.outcome, JSON.stringify(placed.body)).toBe('accepted');
    // only the bought line leaves the cart; the removed one stays
    const cart = await w.call('GET', '/api/store/cart/cart', cy.token);
    expect(JSON.stringify(cart.body)).toContain(w.offers.white);
    expect(JSON.stringify(cart.body)).not.toContain(w.offers.black);

    const restock = await w.call('POST', `/api/seller/inventory/stock-items/${w.stock.white}/adjustments`, w.sellerToken, { newAvailable: 40, reasonCode: 'received_stock', note: 'Restocked' });
    expect(restock.status, JSON.stringify(restock.body)).toBeLessThan(300);
  });

  it('lists another seller’s offer as an alternative and switches only when the customer picks it', async () => {
    const ray = await w.customer('ray@example.com');
    const v = await readyCheckout(w, ray.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 });
    await w.call('POST', `/api/seller/inventory/stock-items/${w.stock.white}/adjustments`, w.sellerToken, { newAvailable: 0, reasonCode: 'moved_to_another_channel', note: 'Sold elsewhere' });
    try {
      const found = await w.call('POST', `${STORE}/sessions/${v.id}/revalidate`, ray.token);
      const change = found.body.changeSet.changes.find((c: any) => c.kind === 'out_of_stock');
      expect(change.defaultChoice).toBe('remove');
      expect(change.choices).toContain('choose_offer');
      const alt = change.alternatives.find((a: any) => a.offerId === w.offers.officialWhite);
      expect(alt).toMatchObject({ differentSeller: true, note: 'Different seller. Only switched if you pick this.', seller: { official: true }, price: USD(2300) });

      const wrong = await w.call('POST', `${STORE}/sessions/${v.id}/changes/${found.body.changeSet.id}/accept`, ray.token, { decisions: [{ changeId: change.id, choice: 'choose_offer', offerId: w.offers.black }], acceptPartialOrder: true });
      expect(wrong.status).toBe(409);
      expect(wrong.body.error).toMatchObject({ code: 'OFFER_UNAVAILABLE', details: { reason: 'not_listed' } });
      const switched = await w.call('POST', `${STORE}/sessions/${v.id}/changes/${found.body.changeSet.id}/accept`, ray.token, { decisions: [{ changeId: change.id, choice: 'choose_offer', offerId: w.offers.officialWhite }], acceptPartialOrder: false });
      expect(switched.status, JSON.stringify(switched.body)).toBe(200);
      expect(switched.body.packages).toHaveLength(1);
      expect(switched.body.packages[0]).toMatchObject({ seller: { official: true }, lines: [{ offerId: w.offers.officialWhite, unitPrice: USD(2300) }] });
      expect(switched.body.packages[0].selectedOptionId).toEqual(expect.any(String));
      expect(w.named('checkout.changes.accepted').at(-1)).toMatchObject({ switchedOffers: 1, removedLines: 0, partialOrder: false });
      const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, ray.token, placeBody(switched.body), { 'idempotency-key': key() });
      expect(placed.body.outcome, JSON.stringify(placed.body)).toBe('accepted');
    } finally {
      await w.call('POST', `/api/seller/inventory/stock-items/${w.stock.white}/adjustments`, w.sellerToken, { newAvailable: 40, reasonCode: 'received_stock', note: 'Restocked' });
    }
  });
});

describe('development tooling (G30a)', () => {
  it('makes the next check find a price change or a stock shortage, needs a token and stays out of OpenAPI', async () => {
    const cleo = await w.customer('cleo@example.com');
    const v = await readyCheckout(w, cleo.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 });
    const url = `/api/dev/checkout/sessions/${v.id}/changes`;
    expect((await w.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);

    const price = await w.call('POST', url, cleo.token, {});
    expect(price.status, JSON.stringify(price.body)).toBe(200);
    expect(price.body).toMatchObject({ outcome: 'changes_found', checkout: { status: 'changes_pending' } });
    const unit = v.packages[0].lines[0].unitPrice.amount; // the offer's price now (an earlier test may have changed it)
    expect(price.body.changeSet.changes[0]).toMatchObject({ kind: 'price_increased', previousAmount: USD(Math.round(unit * 0.9)), currentAmount: USD(unit) });
    const accepted = await w.call('POST', `${STORE}/sessions/${v.id}/changes/${price.body.changeSet.id}/accept`, cleo.token, { decisions: [{ changeId: price.body.changeSet.changes[0].id, choice: 'accept' }], acceptPartialOrder: false });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.packages[0].lines[0].unitPrice).toEqual(USD(unit));

    const stock = await w.call('POST', url, cleo.token, { stock: true });
    expect(stock.status, JSON.stringify(stock.body)).toBe(200);
    expect(stock.body.changeSet.changes.map((c: any) => c.kind)).toContain('quantity_reduced');
    // a checkout waiting on changes cannot be given more
    expect((await w.call('POST', url, cleo.token, {})).status).toBe(409);
    expect(Object.keys((w.app.swagger() as any).paths).some((p) => p.startsWith('/api/dev'))).toBe(false);
  });
});
