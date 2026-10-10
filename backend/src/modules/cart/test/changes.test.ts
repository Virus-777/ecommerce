/**
 * Scenario 2 (plan ch. 21): the offer changes before purchase. Every read re-checks; changes are explained
 * per line, the rest of the cart is kept, and a seller is never switched silently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, lineOf, STORE, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

async function cartWith(...specs: { price: number; stock?: number; purchaseLimit?: number; quantity?: number; sellerName?: string }[]) {
  const v = k.visitor();
  const offers = [];
  for (const s of specs) {
    const { productId, variantIds } = await k.product();
    const o = await k.offer({ productId, variantId: variantIds[0]!, price: s.price, stock: s.stock, purchaseLimit: s.purchaseLimit, sellerName: s.sellerName });
    const add = await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: o.id, quantity: s.quantity ?? 1 } });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    offers.push(o);
  }
  const get = async () => (await k.call('GET', `${STORE}/cart`, { token: v.token })).body;
  return { v, offers, get };
}

describe('scenario 2: changed offers', () => {
  it('a price increase needs the customer to accept it; the other lines stay ready', async () => {
    const { v, offers, get } = await cartWith({ price: 9499 }, { price: 2000, sellerName: 'Harbor Goods' });
    k.change(offers[0]!.id, { price: { amount: 9999, currency: 'USD' } });
    const view = await get();
    const line = lineOf(view, offers[0]!.id);
    expect(line).toMatchObject({ state: 'needs_attention', includedInCheckout: false, unitPrice: { amount: 9999 }, acceptedUnitPrice: { amount: 9499 }, lineTotal: { amount: 9999 } });
    expect(line.notices).toHaveLength(1);
    const n = line.notices[0];
    expect(n).toMatchObject({ kind: 'price_increased', severity: 'warning', previousPrice: { amount: 9499 }, currentPrice: { amount: 9999 }, changedBy: 'Northwind Audio', actions: ['accept', 'remove'] });
    expect(n.message).toMatch(/^Price changed since you added it: was \$94\.99, now \$99\.99\. Northwind Audio updated this offer on \w{3} \d+\.$/);
    expect(lineOf(view, offers[1]!.id)).toMatchObject({ state: 'ok', includedInCheckout: true });
    expect(view.checkoutReady).toBe(false);
    expect(view.checkoutBlockers).toEqual(['1 item changed since you added it. Review the change to continue.']);
    expect(view.attention).toMatchObject({ count: 1, title: '1 item needs your attention' });
    expect((await k.call('GET', `${STORE}/cart/badge`, { token: v.token })).body).toEqual({ itemCount: 2, attentionCount: 1 });
    // the same change is the same notice on the next read
    expect(lineOf(await get(), offers[0]!.id).notices[0].id).toBe(n.id);

    const accepted = await k.call('POST', `${STORE}/cart/items/${line.id}/accept`, { token: v.token, body: { noticeIds: [n.id] } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(lineOf(accepted.body, offers[0]!.id)).toMatchObject({ state: 'ok', acceptedUnitPrice: { amount: 9999 }, notices: [] });
    expect(accepted.body.checkoutReady).toBe(true);
    const again = await k.call('POST', `${STORE}/cart/items/${line.id}/accept`, { token: v.token, body: { noticeIds: [n.id] } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });

  it('accepting a price that changed again is a conflict', async () => {
    const { v, offers, get } = await cartWith({ price: 5000 });
    k.change(offers[0]!.id, { price: { amount: 5500, currency: 'USD' } });
    const first = lineOf(await get(), offers[0]!.id);
    k.change(offers[0]!.id, { price: { amount: 5900, currency: 'USD' } });
    const res = await k.call('POST', `${STORE}/cart/items/${first.id}/accept`, { token: v.token, body: { noticeIds: [first.notices[0].id] } });
    expect(res.status).toBe(409);
    const now = lineOf(await get(), offers[0]!.id);
    expect(now.notices[0]).toMatchObject({ kind: 'price_increased', currentPrice: { amount: 5900 } });
  });

  it('a price decrease is accepted automatically and shown once', async () => {
    const { offers, get } = await cartWith({ price: 5000 });
    k.change(offers[0]!.id, { price: { amount: 4500, currency: 'USD' } });
    const line = lineOf(await get(), offers[0]!.id);
    expect(line).toMatchObject({ state: 'ok', includedInCheckout: true, acceptedUnitPrice: { amount: 4500 }, unitPrice: { amount: 4500 } });
    expect(line.notices).toMatchObject([{ kind: 'price_decreased', severity: 'info', message: 'Good news: the price dropped from $50.00 to $45.00.', actions: [] }]);
    expect(lineOf(await get(), offers[0]!.id).notices).toEqual([]);
  });

  it('changed return, warranty or dispatch terms (OfferChange terms) need the customer to accept them', async () => {
    const { v, offers, get } = await cartWith({ price: 5000 }, { price: 1200, sellerName: 'Harbor Goods' });
    k.change(offers[0]!.id, { returnTerms: { kind: 'extended', windowDays: 60, freeReturnShipping: true, summary: '60-day free returns.' } });
    const view = await get();
    const line = lineOf(view, offers[0]!.id);
    expect(line).toMatchObject({ state: 'needs_attention', includedInCheckout: false, acceptedTermsVersion: 1 });
    expect(line.notices).toMatchObject([{ kind: 'terms_changed', severity: 'warning', actions: ['accept', 'remove'] }]);
    expect(line.notices[0].message).toContain('Northwind Audio updated the delivery, return or warranty terms');
    expect(lineOf(view, offers[1]!.id)).toMatchObject({ state: 'ok' });
    expect(view.checkoutReady).toBe(false);
    const accepted = await k.call('POST', `${STORE}/cart/items/${line.id}/accept`, { token: v.token, body: { noticeIds: [line.notices[0].id] } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(lineOf(accepted.body, offers[0]!.id)).toMatchObject({ state: 'ok', acceptedTermsVersion: 2, notices: [] });
    expect(lineOf(await get(), offers[0]!.id)).toMatchObject({ state: 'ok', notices: [] });
  });

  it('out of stock blocks only that line, with alternatives hinted and never applied; restock clears it', async () => {
    const { v, offers, get } = await cartWith({ price: 3000 }, { price: 1000, sellerName: 'Harbor Goods' });
    const other = await k.offer({ productId: offers[0]!.productId, variantId: offers[0]!.variantId, price: 2900, sellerName: 'Cedar & Co' });
    await k.stock(offers[0]!.id, 0);
    const view = await get();
    const line = lineOf(view, offers[0]!.id);
    expect(line).toMatchObject({ offerId: offers[0]!.id, state: 'unavailable', includedInCheckout: false, maxQuantity: 0 });
    expect(line.notices[0]).toMatchObject({ kind: 'out_of_stock', severity: 'blocking', alternatives: { count: 1, lowestPrice: { amount: 2900 }, condition: 'new' } });
    expect(line.notices[0].actions).toEqual(expect.arrayContaining(['remove', 'choose_offer', 'save_for_later']));
    expect(view.packages[0].delivery).toBeNull();
    expect(view.totals).toMatchObject({ itemsSubtotal: { amount: 1000 }, excludedItemCount: 1 });
    expect(view.checkoutReady).toBe(true);
    const blocked = await k.call('POST', `${STORE}/cart/items/${line.id}/accept`, { token: v.token, body: { noticeIds: [line.notices[0].id] } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ILLEGAL_TRANSITION');
    expect(lineOf(view, other.id)).toBeUndefined();

    await k.stock(offers[0]!.id, 5);
    expect(lineOf(await get(), offers[0]!.id)).toMatchObject({ state: 'ok', notices: [] });
  });

  it('reduced stock asks to reduce the quantity; accepting takes what is available', async () => {
    const { v, offers, get } = await cartWith({ price: 1000, quantity: 3 });
    await k.stock(offers[0]!.id, 2);
    const line = lineOf(await get(), offers[0]!.id);
    expect(line).toMatchObject({ state: 'needs_attention', availableQuantity: 2, maxQuantity: 2 });
    expect(line.notices[0]).toMatchObject({ kind: 'quantity_reduced', severity: 'warning', previousQuantity: 3, availableQuantity: 2, message: 'Only 2 left from Northwind Audio. You have 3 in your cart.' });
    const res = await k.call('POST', `${STORE}/cart/items/${line.id}/accept`, { token: v.token, body: { noticeIds: [line.notices[0].id] } });
    expect(lineOf(res.body, offers[0]!.id)).toMatchObject({ quantity: 2, state: 'ok' });
  });

  it('a lower purchase limit is resolved by reducing the quantity', async () => {
    const { v, offers, get } = await cartWith({ price: 1000, quantity: 3 });
    k.change(offers[0]!.id, { purchaseLimit: 1 });
    const line = lineOf(await get(), offers[0]!.id);
    expect(line.notices[0]).toMatchObject({ kind: 'purchase_limit_reduced', severity: 'warning', message: 'Limit 1 per customer. You have 3 in your cart.' });
    expect(line.purchaseLimit).toBe(1);
    const res = await k.call('PATCH', `${STORE}/cart/items/${line.id}`, { token: v.token, body: { quantity: 1 } });
    expect(lineOf(res.body, offers[0]!.id)).toMatchObject({ quantity: 1, state: 'ok', notices: [] });
  });

  it('a restricted seller, an ended offer, a hidden product and an unshippable location block their lines only', async () => {
    const { v, offers, get } = await cartWith({ price: 1000 }, { price: 2000 }, { price: 3000 }, { price: 4000 }, { price: 500, sellerName: 'Harbor Goods' });
    const [restricted, ended, hidden, far, fine] = offers;
    k.world.restricted.add(restricted!.id);
    k.change(ended!.id, { status: 'removed' });
    k.world.purchasable.set(hidden!.productId, false);
    k.world.notShippable.add(far!.id);
    const view = await get();
    expect(lineOf(view, restricted!.id).notices.map((n: any) => n.kind)).toEqual(['seller_unavailable']);
    expect(lineOf(view, ended!.id).notices.map((n: any) => n.kind)).toEqual(['offer_ended']);
    expect(lineOf(view, hidden!.id).notices.map((n: any) => n.kind)).toEqual(['product_unavailable']);
    const farLine = lineOf(view, far!.id);
    expect(farLine.notices.map((n: any) => n.kind)).toEqual(['not_shippable']);
    expect(view.packages.find((p: any) => p.items.some((i: any) => i.offerId === far!.id)).notShippable).toBe(true);
    expect(lineOf(view, fine!.id)).toMatchObject({ state: 'ok' });
    // lines stay on their own offers
    for (const o of offers) expect(lineOf(view, o.id)).toBeDefined();
    expect(view.attention.count).toBe(4);

    const removed = await k.call('POST', `${STORE}/cart/remove-unavailable`, { token: v.token });
    expect(removed.status).toBe(200);
    expect(removed.body.packages.flatMap((p: any) => p.items).map((i: any) => i.offerId)).toEqual([fine!.id]);
    expect(k.of('cart.item.removed').filter((e) => e.reason === 'unavailable').map((e) => e.offerId)).toEqual(expect.arrayContaining([restricted!.id, ended!.id, hidden!.id, far!.id]));
  });

  it('checkout gets eligible lines and the excluded ones separately after a fresh check', async () => {
    const { v, offers } = await cartWith({ price: 1000, quantity: 2 }, { price: 2000 });
    k.change(offers[1]!.id, { status: 'paused' });
    const snap = await k.service.getCartForCheckout({ kind: 'guest', guestSessionId: v.sid });
    expect(snap.eligible).toHaveLength(1);
    expect(snap.eligible[0]).toMatchObject({ offerId: offers[0]!.id, quantity: 2, ownerType: 'seller', stockItemId: offers[0]!.stockItemId, acceptedUnitPrice: { amount: 1000 }, currentUnitPrice: { amount: 1000 }, acceptedTermsVersion: 1 });
    expect(snap.eligible[0]!.packageKey).toContain('Reno, NV');
    expect(snap.excluded.map((i) => i.offerId)).toEqual([offers[1]!.id]);
    const only = await k.service.getCartForCheckout({ kind: 'guest', guestSessionId: v.sid }, [snap.eligible[0]!.itemId]);
    expect(only.excluded).toEqual([]);
  });
});
