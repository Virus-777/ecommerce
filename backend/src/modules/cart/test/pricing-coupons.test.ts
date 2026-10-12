/**
 * With the optional modules on (stubbed: promotions and shipping are built in parallel, customers' saved
 * addresses are controlled here): campaign prices, package delivery from shipping, coupon preview,
 * saved for later, checkout hand-offs and the GraphQL read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import { spec } from '../../../spec/cart.js';
import { schemas } from '../infra/mongo/schema.js';
import type { CartDb } from '../../../spec/cart.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import type * as promotions from '../../../spec/promotions.js';
import type * as shipping from '../../../spec/shipping.js';
import { auth } from '../../../testing/app.js';
import { boot, lineOf, linesOf, STORE, type Kit } from './helpers.js';

let k: Kit;
const promo = new Map<string, promotions.OfferPromotion>();
/** code → what evaluateCart answers: offers it covers, or a rejection */
const codes = new Map<string, { covers: string[]; amount: number; seller?: boolean } | { reject: promotions.RejectedCode['reason'] }>();
const freeShippingSellers = new Set<string>();
const ADDRESS_ID = newId();
const quoteCalls: shipping.PackageQuoteInput[] = [];
const evalInputs: promotions.CartEvaluationInput[] = [];

beforeAll(async () => {
  k = await boot({
    only: ['promotions', 'shipping', 'customers', 'settings'],
    apiStubs: {
      settings: { get: async (key: string) => (key === 'cart.couponPreviewRateLimitPerHour' ? 6 : null) as never },
      customers: {
        getCustomerByUserId: async () => null,
        getAddressForOrder: async (_c, id) => {
          if (id !== ADDRESS_ID) throw new AppError('NOT_FOUND', 'Address not found');
          return { name: 'Ana Lopez', line1: '1 Main St', city: 'Portland', region: 'OR', postalCode: '97205', country: 'US' };
        },
      },
      promotions: {
        priceOffers: async (ids) => ids.map((id) => promo.get(id)).filter((p): p is promotions.OfferPromotion => !!p),
        evaluateCart: async (input) => {
          evalInputs.push(input);
          const applied: promotions.AppliedPromotion[] = [];
          const rejected: promotions.RejectedCode[] = [];
          const lines: promotions.LineDiscount[] = input.lines.map((l) => ({ lineId: l.lineId, regularUnitPrice: l.unitPrice, unitPrice: l.unitPrice, allocations: [], lineDiscount: money(0), limitExceeded: false, discountedQuantity: l.quantity }));
          for (const code of input.codes) {
            const rule = codes.get(code) ?? { reject: 'not_found' as const };
            if ('reject' in rule || (code === 'MEMBER' && !input.customerId)) {
              const reason = 'reject' in rule ? rule.reject : 'sign_in_required';
              rejected.push({ code, reason, message: reason === 'sign_in_required' ? 'Sign in to use this coupon.' : reason === 'not_found' ? "We couldn't find that code." : 'Spend $100 or more to use this code.', details: [] });
              continue;
            }
            const covered = input.lines.filter((l) => rule.covers.includes(l.offerId));
            if (!covered.length) {
              rejected.push({ code, reason: 'no_eligible_items', message: 'None of your items qualify.', details: [] });
              continue;
            }
            const campaignId = newId();
            for (const l of covered) {
              const share = Math.floor(rule.amount / covered.length);
              lines.find((x) => x.lineId === l.lineId)!.allocations.push({ campaignId, code, label: `${code} discount`, amount: money(share), platformPart: money(rule.seller ? 0 : share), sellerPart: money(rule.seller ? share : 0) });
            }
            applied.push({ campaignId, code, label: `$${rule.amount / 100} off`, amount: money(rule.amount), coversLineIds: covered.map((l) => l.lineId), source: 'code' });
          }
          const packages = [...new Set(input.lines.map((l) => l.packageId))]
            .filter((p) => input.lines.some((l) => l.packageId === p && freeShippingSellers.has(l.sellerId)))
            .map((packageId) => ({ packageId, sellerId: input.lines.find((l) => l.packageId === packageId)!.sellerId, shippingDiscount: input.shipping?.[packageId] ?? money(0), freeShipping: true }));
          return { evaluationId: newId(), validUntil: new Date().toISOString(), lines, packages, applied, rejected, skipped: [], totals: { total: money(0), platform: money(0), seller: money(0) }, changes: [] };
        },
      },
      shipping: {
        quoteOptions: async (input) => {
          quoteCalls.push(input);
          const blocked = input.items.filter((i) => [...k.world.notShippable].some((offerId) => k.world.offers.get(offerId)?.shippingProfileId === i.profileId)).map((i) => i.lineId);
          const option: shipping.DeliveryOption = {
            id: 'opt-1',
            methodCode: 'standard',
            methodName: 'Standard',
            price: money(499),
            free: false,
            fundedBy: 'customer',
            freeReason: null,
            arrival: { from: '2026-10-19', to: '2026-10-20' },
            arrivalLabel: 'Arrives Mon, Oct 19 – Tue, Oct 20',
            dispatchBy: '2026-10-12T00:00:00Z',
            dispatchLabel: 'Ships tomorrow',
            notices: ['Carrier delays expected around the holiday'],
            isDefault: true,
          };
          return { shipsToLocation: true, notShippableLineIds: blocked, options: [option], default: option };
        },
      },
    },
  });
});
afterAll(async () => {
  await k?.app.close();
});

const addTo = async (token: string, offerId: string, quantity = 1) => {
  const r = await k.call('POST', `${STORE}/cart/items`, { token, body: { offerId, quantity } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

describe('campaign prices and package delivery', () => {
  it('uses the campaign price with its was-price; when the campaign ends the increase is explained', async () => {
    const p = await k.product();
    const offer = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 5000 });
    promo.set(offer.id, { offerId: offer.id, regularPrice: money(5000), price: money(4000), wasPrice: money(5000), badges: [], campaignId: newId(), purchaseLimit: 2, sellerPromos: [] });
    const v = k.visitor();
    const add = await addTo(v.token, offer.id, 5);
    expect(add.outcome).toBe('capped_at_limit');
    expect(lineOf(add.cart, offer.id)).toMatchObject({ quantity: 2, purchaseLimit: 2, unitPrice: { amount: 4000 }, compareAtPrice: { amount: 5000 }, acceptedUnitPrice: { amount: 4000 } });
    promo.delete(offer.id);
    const line = lineOf((await k.call('GET', `${STORE}/cart`, { token: v.token })).body, offer.id);
    expect(line.notices[0]).toMatchObject({ kind: 'price_increased', previousPrice: { amount: 4000 }, currentPrice: { amount: 5000 } });
  });

  it('quotes each package through shipping at the deliver-to location; a seller that does not ship there blocks its line', async () => {
    const p = await k.product();
    const a = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 2000 });
    const b = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 2000, sellerName: 'Harbor Goods' });
    const c = k.customer();
    await addTo(c.token, a.id, 2);
    await addTo(c.token, b.id);
    k.world.notShippable.add(b.id);
    const missing = await k.call('PUT', `${STORE}/cart/destination`, { token: c.token, body: { addressId: newId() } });
    expect(missing.status).toBe(400);
    const view = (await k.call('PUT', `${STORE}/cart/destination`, { token: c.token, body: { addressId: ADDRESS_ID } })).body;
    expect(view.destination).toEqual({ postalCode: '97205', country: 'US', region: 'OR', city: 'Portland', addressId: ADDRESS_ID, source: 'address' });
    expect(view.packages[0].delivery).toMatchObject({ methodName: 'Standard', shipping: { amount: 499 }, arrival: { from: '2026-10-19', to: '2026-10-20' }, estimateBasis: 'address', serviceNotices: ['Carrier delays expected around the holiday'] });
    expect(quoteCalls.at(-1)).toMatchObject({ destination: { postalCode: '97205', country: 'US', region: 'OR' } });
    expect(lineOf(view, b.id).notices.map((n: any) => n.kind)).toEqual(['not_shippable']);
    expect(lineOf(view, b.id).notices[0].message).toBe("Harbor Goods doesn't ship this item to 97205.");
    expect(view.packages[1]).toMatchObject({ notShippable: true, delivery: null });
    expect(view.totals).toMatchObject({ itemsSubtotal: { amount: 4000 }, shippingTotal: { amount: 499 }, total: { amount: 4499 }, shippingByPackage: [{ amount: { amount: 499 }, sellerName: 'Northwind Audio', free: false }] });
    k.world.notShippable.delete(b.id);
  });
});

describe('coupon preview', () => {
  it('applies, explains coverage, rejects without keeping, and asks guests to sign in for account coupons', async () => {
    const p = await k.product();
    const a = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 6000 });
    const marked = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 3000, sellerName: 'Harbor Goods' });
    promo.set(marked.id, { offerId: marked.id, regularPrice: money(3000), price: money(2500), wasPrice: money(3000), badges: [], campaignId: newId(), sellerPromos: [] });
    codes.set('SAVE10', { covers: [a.id], amount: 1000 });
    codes.set('MEMBER', { covers: [a.id], amount: 500, seller: true });
    const v = k.visitor();
    await addTo(v.token, a.id);
    await addTo(v.token, marked.id);

    const ok = await k.call('POST', `${STORE}/cart/coupons`, { token: v.token, body: { code: ' save10 ' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const itemA = lineOf(ok.body.cart, a.id).id;
    const itemM = lineOf(ok.body.cart, marked.id).id;
    expect(ok.body.result).toMatchObject({ code: 'SAVE10', status: 'applied', amount: { amount: 1000 }, label: '$10 off', fundedBy: 'platform', coverage: [{ itemId: itemA, amount: { amount: 1000 } }], notCovered: [{ itemId: itemM, reason: 'already on a seller markdown' }] });
    expect(ok.body.cart.totals.discounts).toEqual([{ code: 'SAVE10', label: '$10 off', amount: { amount: 1000, currency: 'USD' }, fundedBy: 'platform' }]);
    expect(ok.body.cart.totals.itemsSubtotal.amount).toBe(8500);
    expect(ok.body.cart.totals.total.amount).toBe(8500 - 1000 + 2 * 599);

    const bad = await k.call('POST', `${STORE}/cart/coupons`, { token: v.token, body: { code: 'BOGUS' } });
    expect(bad.body.result).toMatchObject({ code: 'BOGUS', status: 'rejected', reason: "We couldn't find that code." });
    expect(bad.body.cart.coupons.map((c: any) => c.code)).toEqual(['SAVE10']);

    const member = await k.call('POST', `${STORE}/cart/coupons`, { token: v.token, body: { code: 'MEMBER' } });
    expect(member.body.result).toMatchObject({ status: 'needs_sign_in', reason: 'Sign in to use this coupon.' });
    expect(member.body.cart.coupons.map((c: any) => c.code)).toEqual(['SAVE10', 'MEMBER']);

    // the coupon stops covering a line: the line says so once
    codes.set('SAVE10', { reject: 'min_spend_not_met' });
    const after = (await k.call('GET', `${STORE}/cart`, { token: v.token })).body;
    expect(lineOf(after, a.id).notices).toMatchObject([{ kind: 'coupon_no_longer_applies', severity: 'info', message: 'Coupon SAVE10 no longer applies to this item.' }]);
    expect(after.coupons[0]).toMatchObject({ code: 'SAVE10', status: 'rejected', reason: 'Spend $100 or more to use this code.' });
    expect(lineOf((await k.call('GET', `${STORE}/cart`, { token: v.token })).body, a.id).notices).toEqual([]);

    const removed = await k.call('DELETE', `${STORE}/cart/coupons/SAVE10`, { token: v.token });
    expect(removed.body.coupons.map((c: any) => c.code)).toEqual(['MEMBER']);

    // signing in carries the account coupon over, now valid
    const c = k.customer();
    await k.publish('identity', 'identity.guest_session.claimed', { guestSessionId: v.sid, accountId: c.accountId });
    const merged = await k.call('POST', `${STORE}/cart/merge`, { token: c.token, body: { guestSessionId: v.sid } });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    const view = (await k.call('GET', `${STORE}/cart`, { token: c.token })).body;
    expect(view.coupons).toMatchObject([{ code: 'MEMBER', status: 'applied', fundedBy: 'seller' }]);
  });

  it('sends Official Store lines to promotions with OFFICIAL_STORE_ID (never an empty seller id) and the category when known', async () => {
    const p = await k.product();
    const official = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 4000, official: true });
    const sellerId = newId();
    const seller = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 3000, sellerId, sellerName: 'Harbor Goods' });
    codes.set('OFFICIAL5', { covers: [official.id], amount: 500 });
    const v = k.visitor();
    await addTo(v.token, official.id);
    await addTo(v.token, seller.id);
    evalInputs.length = 0;
    const ok = await k.call('POST', `${STORE}/cart/coupons`, { token: v.token, body: { code: 'OFFICIAL5' } });
    expect(ok.body.result).toMatchObject({ status: 'applied', amount: { amount: 500 } });
    const lines = evalInputs.at(-1)!.lines;
    const categoryId = k.world.products.get(p.productId)!.categoryId;
    expect(lines.find((l) => l.offerId === official.id)).toMatchObject({ sellerId: OFFICIAL_STORE_ID, officialStore: true, categoryId });
    expect(lines.find((l) => l.offerId === seller.id)).toMatchObject({ sellerId, officialStore: false, categoryId });
    for (const input of evalInputs) for (const l of input.lines) expect(l.sellerId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('limits coupon attempts per owner per hour', async () => {
    const v = k.visitor();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await k.call('POST', `${STORE}/cart/coupons`, { token: v.token, body: { code: `TRY${i}` } })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });

  it('free shipping from promotions makes the package free', async () => {
    const p = await k.product();
    const sellerId = newId();
    const a = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 6000, sellerId });
    freeShippingSellers.add(sellerId);
    const v = k.visitor();
    await addTo(v.token, a.id);
    const view = (await k.call('PUT', `${STORE}/cart/destination`, { token: v.token, body: { postalCode: '97205' } })).body;
    expect(view.packages[0].delivery).toMatchObject({ free: true, shipping: { amount: 0 } });
    expect(view.totals.shippingTotal.amount).toBe(0);
  });
});

describe('saved for later, checkout hand-offs and GraphQL', () => {
  it('saves a line for later, lists it, moves it back and deletes it', async () => {
    const p = await k.product();
    const a = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 1500 });
    const v = k.visitor();
    const add = await addTo(v.token, a.id, 2);
    const saved = await k.call('POST', `${STORE}/cart/items/${add.itemId}/save-for-later`, { token: v.token });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ itemCount: 0, savedForLaterCount: 1 });
    expect(k.of('cart.item.removed').at(-1)).toMatchObject({ itemId: add.itemId, reason: 'saved_for_later' });
    const list = await k.call('GET', `${STORE}/cart/saved`, { token: v.token });
    expect(list.status).toBe(200);
    expect(list.body.items).toMatchObject([{ offerId: a.id, title: 'Linen Duvet Cover', variantLabel: 'Queen · Sage', currentPrice: { amount: 1500 }, available: true, seller: { name: 'Northwind Audio' } }]);
    const id = list.body.items[0].id;
    expect((await k.call('POST', `${STORE}/cart/saved/${id}/move-to-cart`, { token: k.visitor().token, body: {} })).status).toBe(404);
    const moved = await k.call('POST', `${STORE}/cart/saved/${id}/move-to-cart`, { token: v.token, body: { quantity: 1 } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ outcome: 'added', cart: { itemCount: 1, savedForLaterCount: 0 } });
    expect(k.of('cart.item.added').at(-1)).toMatchObject({ offerId: a.id, source: 'saved_for_later' });
    const again = await k.call('POST', `${STORE}/cart/items/${moved.body.itemId}/save-for-later`, { token: v.token });
    expect(again.body.savedForLaterCount).toBe(1);
    const sid = (await k.call('GET', `${STORE}/cart/saved`, { token: v.token })).body.items[0].id;
    expect((await k.call('DELETE', `${STORE}/cart/saved/${sid}`, { token: k.visitor().token })).status).toBe(404);
    expect((await k.call('DELETE', `${STORE}/cart/saved/${sid}`, { token: v.token })).status).toBe(204);
  });

  it('moves the guest saved-for-later items to the customer at sign-in, keeping an offer both saved once', async () => {
    const p = await k.product({ variants: 3 });
    const [a, b, c] = await Promise.all(p.variantIds.map((variantId, i) => k.offer({ productId: p.productId, variantId, price: 1000 + i })));
    const cust = k.customer();
    // the customer already saved b
    const addB = await addTo(cust.token, b!.id);
    await k.call('POST', `${STORE}/cart/items/${addB.itemId}/save-for-later`, { token: cust.token });
    // the guest saves a and b, and keeps c in the cart
    const v = k.visitor();
    for (const o of [a!, b!]) {
      const add = await addTo(v.token, o.id);
      expect((await k.call('POST', `${STORE}/cart/items/${add.itemId}/save-for-later`, { token: v.token })).status).toBe(200);
    }
    await addTo(v.token, c!.id);

    await k.publish('identity', 'identity.guest_session.claimed', { guestSessionId: v.sid, accountId: cust.accountId });
    const saved = (await k.call('GET', `${STORE}/cart/saved`, { token: cust.token })).body.items;
    expect(saved.map((s: any) => s.offerId).sort()).toEqual([a!.id, b!.id].sort());
    expect((await k.call('GET', `${STORE}/cart/saved`, { token: v.token })).body.items).toEqual([]);
    const merged = await k.call('POST', `${STORE}/cart/merge`, { token: cust.token, body: { guestSessionId: v.sid } });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merged.body.report).toMatchObject({ savedItemsMoved: 1, lines: [{ offerId: c!.id, outcome: 'added' }] });
    expect(merged.body.report.message).toContain('1 saved item');
    expect(merged.body.cart.savedForLaterCount).toBe(2);
  });

  it('moves guest saved items at sign-in even when the guest has no cart left', async () => {
    const p = await k.product();
    const a = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 1700 });
    const v = k.visitor();
    const add = await addTo(v.token, a.id);
    await k.call('POST', `${STORE}/cart/items/${add.itemId}/save-for-later`, { token: v.token });
    // the emptied guest cart expires before sign-in
    const guestCart = (await k.call('GET', `${STORE}/cart`, { token: v.token })).body.id;
    await k.app.kernel.mongo.module('cart', spec.collections, schemas).table<CartDb['carts']>('carts').update(guestCart, { status: 'expired' });
    const cust = k.customer();
    await k.publish('identity', 'identity.guest_session.claimed', { guestSessionId: v.sid, accountId: cust.accountId });
    const saved = (await k.call('GET', `${STORE}/cart/saved`, { token: cust.token })).body.items;
    expect(saved.map((s: any) => s.offerId)).toEqual([a.id]);
  });

  it('removes purchased lines (converting an emptied cart) and restores them after a declined payment', async () => {
    const p = await k.product();
    const a = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 1500 });
    const b = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 900, sellerName: 'Harbor Goods' });
    const c = k.customer();
    await addTo(c.token, a.id, 2);
    const add = await addTo(c.token, b.id);
    const snap = await k.service.getCartForCheckout({ kind: 'customer', customerId: c.accountId });
    expect(snap.eligible).toHaveLength(2);
    await k.service.removePurchasedItems(snap.cartId, [snap.eligible[0]!.itemId], newId());
    await k.drain();
    expect(k.of('cart.item.removed').at(-1)).toMatchObject({ cartId: snap.cartId, reason: 'purchased' });
    expect(linesOf((await k.call('GET', `${STORE}/cart`, { token: c.token })).body).map((l) => l.offerId)).toEqual([b.id]);
    await k.service.removePurchasedItems(snap.cartId, [add.itemId], newId());
    expect((await k.service.getCartAdmin(snap.cartId)).summary.status).toBe('converted');
    expect((await k.call('GET', `${STORE}/cart`, { token: c.token })).body.itemCount).toBe(0);

    await k.service.restoreItems(snap.cartId, [
      { offerId: a.id, quantity: 2, acceptedUnitPrice: money(1500) },
      { offerId: b.id, quantity: 1, acceptedUnitPrice: money(900) },
    ]);
    const back = (await k.call('GET', `${STORE}/cart`, { token: c.token })).body;
    expect(back.id).toBe(snap.cartId);
    expect(linesOf(back).map((l) => [l.offerId, l.quantity, l.state])).toEqual([
      [a.id, 2, 'ok'],
      [b.id, 1, 'ok'],
    ]);
    // retried: nothing doubles
    await k.service.restoreItems(snap.cartId, [{ offerId: a.id, quantity: 2, acceptedUnitPrice: money(1500) }]);
    expect(lineOf((await k.call('GET', `${STORE}/cart`, { token: c.token })).body, a.id).quantity).toBe(2);
  });

  it('GraphQL Query.cart reads the same re-checked cart', async () => {
    const p = await k.product();
    const a = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 1500 });
    const v = k.visitor();
    const none = await k.app.inject({ method: 'POST', url: '/graphql/store', headers: auth(v.token), payload: { query: '{ cart { id } }' } });
    expect(none.json()).toEqual({ data: { cart: null } });
    await addTo(v.token, a.id, 2);
    const q = `{ cart { id itemCount checkoutReady retentionNote savedForLaterCount savedForLater(limit: 5) { id }
      destination { postalCode }
      packages { key label seller { name official } delivery { methodName arrivalLabel estimateBasis shipping { formatted } }
        items { offerId quantity condition state options { name value } unitPrice { amount formatted } notices { kind } } }
      totals { total { amount formatted } itemsSubtotal { formatted } } } }`;
    const res = await k.app.inject({ method: 'POST', url: '/graphql/store', headers: auth(v.token), payload: { query: q } });
    const body = res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.cart).toMatchObject({
      itemCount: 2,
      checkoutReady: true,
      savedForLater: [],
      destination: null,
      packages: [{ label: 'Package 1 of 1', seller: { name: 'Northwind Audio', official: false }, items: [{ offerId: a.id, quantity: 2, condition: 'NEW', state: 'OK', options: [{ name: 'size', value: 'Queen' }, { name: 'color', value: 'Sage' }], unitPrice: { amount: 1500, formatted: '$15.00' }, notices: [] }] }],
      totals: { itemsSubtotal: { formatted: '$30.00' } },
    });
    expect(body.data.cart.packages[0].delivery.estimateBasis).toBe('DEFAULT_REGION');
  });
});
