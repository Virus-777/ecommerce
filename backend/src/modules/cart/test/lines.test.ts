import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { boot, lineOf, linesOf, STORE, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

describe('cart lines', () => {
  it('an owner without a cart gets an empty view and creates nothing', async () => {
    const v = k.visitor();
    const res = await k.call('GET', `${STORE}/cart`, { token: v.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ owner: 'guest', itemCount: 0, packages: [], checkoutReady: false, checkoutBlockers: ['Your cart is empty.'] });
    expect(res.body.retentionNote).toBe('Items stay in your cart for 30 days. Prices and stock are checked again at checkout.');
    const badge = await k.call('GET', `${STORE}/cart/badge`, { token: v.token });
    expect(badge.body).toEqual({ itemCount: 0, attentionCount: 0 });
    expect((await k.service.getCartView({ kind: 'guest', guestSessionId: v.sid }))).toBeNull();
  });

  it('adds an offer, increases its quantity and caps at the purchase limit', async () => {
    const { productId, variantIds } = await k.product();
    const offer = await k.offer({ productId, variantId: variantIds[0]!, price: 9499, purchaseLimit: 3 });
    const v = k.visitor();
    const add = await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: offer.id, quantity: 1, source: 'product_page' } });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body).toMatchObject({ outcome: 'added', message: 'Added to your cart.' });
    const line = lineOf(add.body.cart, offer.id);
    expect(line).toMatchObject({
      productId,
      productSlug: 'linen-duvet-cover',
      quantity: 1,
      maxQuantity: 3,
      purchaseLimit: 3,
      title: 'Linen Duvet Cover',
      variantLabel: 'Queen · Sage',
      options: { size: 'Queen', color: 'Sage' },
      unitPrice: { amount: 9499, currency: 'USD' },
      acceptedUnitPrice: { amount: 9499, currency: 'USD' },
      state: 'ok',
      includedInCheckout: true,
      seller: { ownerType: 'seller', name: 'Northwind Audio', official: false, verified: true },
    });
    expect(add.body.cart).toMatchObject({ itemCount: 1, sellerCount: 1, packageCount: 1, checkoutReady: true });
    expect(add.body.cart.packages[0]).toMatchObject({ label: 'Package 1 of 1', shipsFrom: 'Reno, NV', returnTerms: '30-day returns.', notShippable: false });
    // $94.99 is over the offer's $35 free-shipping threshold
    expect(add.body.cart.packages[0].delivery).toMatchObject({ arrivalLabel: 'Arrives Wed, Oct 14 – Fri, Oct 16', shipping: { amount: 0 }, free: true, freeShippingNote: 'Free over $35', amountToFreeShipping: null, estimateBasis: 'default_region' });
    expect(k.of('cart.item.added').at(-1)).toMatchObject({ offerId: offer.id, quantity: 1, unitPrice: { amount: 9499 }, ownerKind: 'guest', source: 'product_page' });

    const more = await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: offer.id, quantity: 1 } });
    expect(more.body).toMatchObject({ outcome: 'quantity_increased', itemId: add.body.itemId });
    expect(lineOf(more.body.cart, offer.id).quantity).toBe(2);

    const capped = await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: offer.id, quantity: 5 } });
    expect(capped.status).toBe(201);
    expect(capped.body.outcome).toBe('capped_at_limit');
    expect(capped.body.message).toContain('up to 3');
    expect(lineOf(capped.body.cart, offer.id).quantity).toBe(3);
    expect(k.of('cart.item.added').at(-1)).toMatchObject({ quantity: 1 });

    const full = await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: offer.id, quantity: 1 } });
    expect(full.status).toBe(422);
    expect(full.body.error).toMatchObject({ code: 'QUANTITY_LIMIT_EXCEEDED', details: { max: 3, limitKind: 'purchase_limit' } });

    const badge = await k.call('GET', `${STORE}/cart/badge`, { token: v.token });
    expect(badge.body).toEqual({ itemCount: 3, attentionCount: 0 });
  });

  it('keeps a second offer for the same variant as its own line and groups packages by seller and ship-from', async () => {
    const { productId, variantIds } = await k.product();
    const a = await k.offer({ productId, variantId: variantIds[0]!, price: 3000, sellerName: 'Northwind Audio' });
    const b = await k.offer({ productId, variantId: variantIds[0]!, price: 2800, sellerName: 'Harbor Goods', shipsFrom: 'Austin, TX' });
    const c = await k.offer({ productId, variantId: variantIds[0]!, price: 3200, official: true });
    const v = k.visitor();
    for (const o of [a, b, c]) expect((await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: o.id, quantity: 1 } })).status).toBe(201);
    const view = (await k.call('GET', `${STORE}/cart`, { token: v.token })).body;
    expect(linesOf(view).map((l) => l.offerId)).toEqual([a.id, b.id, c.id]);
    expect(view.packages.map((p: any) => p.label)).toEqual(['Package 1 of 3', 'Package 2 of 3', 'Package 3 of 3']);
    expect(view.packages[2].seller).toMatchObject({ ownerType: 'official', official: true, id: null, name: 'Marketly Official Store' });
    expect(view).toMatchObject({ sellerCount: 3, packageCount: 3, itemCount: 3 });
    expect(view.totals).toMatchObject({ itemCount: 3, itemsSubtotal: { amount: 9000 }, shippingTotal: { amount: 1797 }, total: { amount: 10797 }, excludedItemCount: 0 });
    expect(view.totals.taxNote).toContain('Calculated after you enter an address');
  });

  it('refuses unavailable offers with alternatives, and unknown offers', async () => {
    const { productId, variantIds } = await k.product();
    const ended = await k.offer({ productId, variantId: variantIds[0]!, price: 3000 });
    await k.offer({ productId, variantId: variantIds[0]!, price: 2800, sellerName: 'Harbor Goods' });
    k.change(ended.id, { status: 'removed' });
    const v = k.visitor();
    const res = await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: ended.id, quantity: 1 } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'OFFER_UNAVAILABLE', details: { reason: 'offer_ended', alternatives: { count: 1, lowestPrice: { amount: 2800 } } } });

    const empty = await k.offer({ productId, variantId: variantIds[0]!, price: 3000, stock: 0 });
    const oos = await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: empty.id, quantity: 1 } });
    expect(oos.body.error).toMatchObject({ code: 'OFFER_UNAVAILABLE', details: { reason: 'out_of_stock' } });

    const unknown = await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: newId(), quantity: 1 } });
    expect(unknown.status).toBe(404);
    const zero = await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: empty.id, quantity: 0 } });
    expect(zero.status).toBe(400);
  });

  it('changes quantities within the line maximum and removes lines', async () => {
    const { productId, variantIds } = await k.product();
    const offer = await k.offer({ productId, variantId: variantIds[0]!, price: 1000, stock: 4 });
    const c = k.customer();
    const add = await k.call('POST', `${STORE}/cart/items`, { token: c.token, body: { offerId: offer.id, quantity: 1 } });
    expect(add.body.cart.owner).toBe('customer');
    const id = add.body.itemId;
    const up = await k.call('PATCH', `${STORE}/cart/items/${id}`, { token: c.token, body: { quantity: 4 } });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(lineOf(up.body, offer.id)).toMatchObject({ quantity: 4, maxQuantity: 4 });
    const over = await k.call('PATCH', `${STORE}/cart/items/${id}`, { token: c.token, body: { quantity: 5 } });
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({ code: 'QUANTITY_LIMIT_EXCEEDED', details: { max: 4, limitKind: 'stock' } });
    // the platform line maximum applies when the offer has no limit
    const bigOffer = await k.offer({ productId, variantId: variantIds[0]!, price: 1000, stock: 100, sellerName: 'Harbor Goods' });
    const big = await k.call('POST', `${STORE}/cart/items`, { token: c.token, body: { offerId: bigOffer.id, quantity: 30 } });
    expect(big.body.outcome).toBe('capped_at_limit');
    expect(lineOf(big.body.cart, bigOffer.id)).toMatchObject({ quantity: 10, maxQuantity: 10 });

    const del = await k.call('DELETE', `${STORE}/cart/items/${id}`, { token: c.token });
    expect(del.status).toBe(200);
    expect(lineOf(del.body, offer.id)).toBeUndefined();
    expect(k.of('cart.item.removed').at(-1)).toMatchObject({ itemId: id, offerId: offer.id, reason: 'customer' });
  });

  it("another shopper's line is not found", async () => {
    const { productId, variantIds } = await k.product();
    const offer = await k.offer({ productId, variantId: variantIds[0]!, price: 1000 });
    const owner = k.visitor();
    const add = await k.call('POST', `${STORE}/cart/items`, { token: owner.token, body: { offerId: offer.id, quantity: 1 } });
    const other = k.visitor();
    const customer = k.customer();
    for (const t of [other.token, customer.token]) {
      expect((await k.call('PATCH', `${STORE}/cart/items/${add.body.itemId}`, { token: t, body: { quantity: 2 } })).status).toBe(404);
      expect((await k.call('DELETE', `${STORE}/cart/items/${add.body.itemId}`, { token: t })).status).toBe(404);
      expect((await k.call('POST', `${STORE}/cart/items/${add.body.itemId}/accept`, { token: t, body: { noticeIds: [newId()] } })).status).toBe(404);
      expect((await k.call('POST', `${STORE}/cart/items/${add.body.itemId}/switch-offer`, { token: t, body: { offerId: offer.id } })).status).toBe(404);
      expect((await k.call('POST', `${STORE}/cart/items/${add.body.itemId}/save-for-later`, { token: t })).status).toBe(404);
    }
    expect(lineOf((await k.call('GET', `${STORE}/cart`, { token: owner.token })).body, offer.id).quantity).toBe(1);
  });

  it('switches a line only to an offer the customer chose, for the same variant', async () => {
    const { productId, variantIds } = await k.product({ variants: 2 });
    const a = await k.offer({ productId, variantId: variantIds[0]!, price: 5000 });
    const b = await k.offer({ productId, variantId: variantIds[0]!, price: 4500, sellerName: 'Harbor Goods', shipsFrom: 'Austin, TX' });
    const otherVariant = await k.offer({ productId, variantId: variantIds[1]!, price: 4500 });
    const v = k.visitor();
    const add = await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: a.id, quantity: 2 } });
    const mismatch = await k.call('POST', `${STORE}/cart/items/${add.body.itemId}/switch-offer`, { token: v.token, body: { offerId: otherVariant.id } });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('OFFER_MISMATCH');
    const sw = await k.call('POST', `${STORE}/cart/items/${add.body.itemId}/switch-offer`, { token: v.token, body: { offerId: b.id } });
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    const line = lineOf(sw.body, b.id);
    expect(line).toMatchObject({ id: add.body.itemId, quantity: 2, unitPrice: { amount: 4500 }, acceptedUnitPrice: { amount: 4500 }, seller: { name: 'Harbor Goods' } });
    expect(sw.body.packages[0].shipsFrom).toBe('Austin, TX');
    expect(k.of('cart.item.offer_switched').at(-1)).toMatchObject({ itemId: add.body.itemId, fromOfferId: a.id, toOfferId: b.id });
  });

  it('sets the deliver-to location from a postal code', async () => {
    const { productId, variantIds } = await k.product();
    const offer = await k.offer({ productId, variantId: variantIds[0]!, price: 1000 });
    const v = k.visitor();
    await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: offer.id, quantity: 1 } });
    const bad = await k.call('PUT', `${STORE}/cart/destination`, { token: v.token, body: { postalCode: '9720' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const guestAddress = await k.call('PUT', `${STORE}/cart/destination`, { token: v.token, body: { addressId: newId() } });
    expect(guestAddress.status).toBe(400);
    const ok = await k.call('PUT', `${STORE}/cart/destination`, { token: v.token, body: { postalCode: '97205' } });
    expect(ok.status).toBe(200);
    expect(ok.body.destination).toMatchObject({ postalCode: '97205', country: 'US', source: 'postal_code' });
    expect(ok.body.packages[0].delivery.estimateBasis).toBe('postal_code');
    expect(ok.body.totals.taxNote).toBe('Tax is calculated at checkout.');
    // a read-only override
    const other = await k.call('GET', `${STORE}/cart?postalCode=10001`, { token: v.token });
    expect(other.body.destination.postalCode).toBe('10001');
    expect((await k.call('GET', `${STORE}/cart`, { token: v.token })).body.destination.postalCode).toBe('97205');
  });

  it('counts active carts holding an offer', async () => {
    const { productId, variantIds } = await k.product();
    const offer = await k.offer({ productId, variantId: variantIds[0]!, price: 1000 });
    for (const v of [k.visitor(), k.visitor(), k.customer()]) await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: offer.id, quantity: 1 } });
    expect(await k.service.countOfferInCarts(offer.id)).toBe(3);
  });
});

describe('addLine (public API, used by wishlist)', () => {
  it('creates the cart when needed, follows the POST /cart/items rules and publishes cart.item.added', async () => {
    const { productId, variantIds } = await k.product();
    const offer = await k.offer({ productId, variantId: variantIds[0]!, price: 2500, purchaseLimit: 2 });
    const c = k.customer();
    const item = await k.service.addLine({ customerId: c.accountId }, { offerId: offer.id, quantity: 1 });
    expect(item).toMatchObject({ offerId: offer.id, quantity: 1, unitPrice: { amount: 2500 }, state: 'ok' });
    await k.drain();
    expect(k.of('cart.item.added').at(-1)).toMatchObject({ itemId: item.id, offerId: offer.id, quantity: 1, ownerKind: 'customer' });
    const capped = await k.service.addLine({ customerId: c.accountId }, { offerId: offer.id, quantity: 5 });
    expect(capped).toMatchObject({ id: item.id, quantity: 2 });
    await expect(k.service.addLine({ customerId: c.accountId }, { offerId: offer.id, quantity: 1 })).rejects.toMatchObject({ code: 'QUANTITY_LIMIT_EXCEEDED' });
    const view = (await k.call('GET', `${STORE}/cart`, { token: c.token })).body;
    expect(lineOf(view, offer.id).quantity).toBe(2);

    const v = k.visitor();
    const guestItem = await k.service.addLine({ guestSessionId: v.sid }, { offerId: offer.id, quantity: 1 });
    expect(lineOf((await k.call('GET', `${STORE}/cart`, { token: v.token })).body, offer.id).id).toBe(guestItem.id);
    await expect(k.service.addLine({ guestSessionId: v.sid }, { offerId: newId(), quantity: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(k.service.addLine({}, { offerId: offer.id, quantity: 1 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('re-checks a cart without a deliver-to location against the market default location', async () => {
    const { productId, variantIds } = await k.product();
    const offer = await k.offer({ productId, variantId: variantIds[0]!, price: 1000 });
    const v = k.visitor();
    await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: offer.id, quantity: 1 } });
    k.world.revalidatedFor.length = 0;
    await k.call('GET', `${STORE}/cart`, { token: v.token });
    const expected = (k.service as any).deps.ctx.config.market.defaultLocation.postalCode;
    expect(expected).toBeTruthy();
    expect(k.world.revalidatedFor).toEqual([expected]);
  });

  it('without a destination, lines each below the free-shipping threshold make a free package together', async () => {
    const { productId, variantIds } = await k.product({ variants: 2 });
    const sellerId = newId();
    const a = await k.offer({ productId, variantId: variantIds[0]!, price: 2000, sellerId });
    const b = await k.offer({ productId, variantId: variantIds[1]!, price: 2000, sellerId });
    const v = k.visitor();
    const one = await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: a.id, quantity: 1 } });
    expect(one.body.cart.packages[0].delivery).toMatchObject({ shipping: { amount: 599 }, free: false, amountToFreeShipping: { amount: 1500 } });
    const two = await k.call('POST', `${STORE}/cart/items`, { token: v.token, body: { offerId: b.id, quantity: 1 } });
    expect(two.body.cart.packageCount).toBe(1);
    expect(two.body.cart.packages[0].delivery).toMatchObject({ shipping: { amount: 0 }, free: true, amountToFreeShipping: null });
    expect(two.body.cart.totals.shippingByPackage).toEqual([expect.objectContaining({ amount: { amount: 0, currency: 'USD' }, free: true })]);
  });
});
