import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { addProduct, addSeller, asSeller, DAY, emit, eventsNamed, harness, offerInput, profile, sellerOffer, setStock, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

describe('creating and publishing seller offers', () => {
  it('creates a draft with its stock item, then publishes it; other sellers do not see it', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const res = await asSeller(h, sellerId, 'POST', '/offers', offerInput(p.id, p.variants[0]!, profile(h, 599, 3, sellerId), { quantity: 7 }));
    expect(res.statusCode, res.body).toBe(201);
    const detail = res.json();
    expect(detail.offer).toMatchObject({ status: 'draft', ownerType: 'seller', sellerId, condition: 'new', complete: true, termsVersion: 1 });
    expect(detail.offer.includedItems).toEqual(['Headphones', 'USB-C cable', 'Carry case']);
    expect(detail.stock.available).toBe(7);
    expect(detail.statusLog[0]).toMatchObject({ to: 'draft', event: 'create' });
    expect(eventsNamed(h, 'offers.offer.created').find((e) => e.offerId === detail.offer.id)).toMatchObject({ productId: p.id, sellerId, stockItemId: detail.offer.stockItemId });

    const pub = await asSeller(h, sellerId, 'POST', `/offers/${detail.offer.id}/publish`);
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json().offer.status).toBe('active');
    expect(pub.json().offer.publishedAt).toBeTruthy();
    expect(eventsNamed(h, 'offers.offer.status_changed').filter((e) => e.offerId === detail.offer.id)).toEqual([expect.objectContaining({ from: 'draft', to: 'active', sellerId })]);

    const other = addSeller(h);
    expect((await asSeller(h, other, 'GET', `/offers/${detail.offer.id}`)).statusCode).toBe(404);
    expect((await asSeller(h, other, 'POST', `/offers/${detail.offer.id}/pause`, {})).statusCode).toBe(404);
    expect((await asSeller(h, sellerId, 'GET', `/offers/${detail.offer.id}`)).json().offer.id).toBe(detail.offer.id);
  });

  it('lands on out of stock when published without stock', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!, { quantity: 0 });
    expect(o.body.offer.status).toBe('out_of_stock');
    const steps = eventsNamed(h, 'offers.offer.status_changed').filter((e) => e.offerId === o.id).map((e) => `${e.from}>${e.to}`);
    expect(steps).toEqual(['draft>active', 'active>out_of_stock']);
  });

  it('checks the offer form: condition notes, missing items, return baseline, variant, duplicates and was-price', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const prof = profile(h, 599, 3, sellerId);
    const post = (over: Record<string, unknown>) => asSeller(h, sellerId, 'POST', '/offers', offerInput(p.id, p.variants[0]!, prof, over));
    expect((await post({ condition: 'used_good' })).json().error.code).toBe('MISSING_ITEMS_REQUIRED');
    expect((await post({ condition: 'used_good', conditionNotes: 'Light scuffs', missingItems: ['Remote'] })).json().error.code).toBe('MISSING_ITEMS_REQUIRED');
    const below = await post({ returnTerms: { kind: 'extended', windowDays: 14 } });
    expect(below.statusCode).toBe(400);
    expect(below.json().error).toMatchObject({ code: 'RETURN_TERMS_BELOW_BASELINE', details: { baseline: { windowDays: 30 } } });
    expect((await post({ variantId: newId() })).json().error.code).toBe('VARIANT_NOT_IN_PRODUCT');
    expect((await post({ shippingProfileId: newId() })).json().error.code).toBe('SHIPPING_PROFILE_INVALID');
    const was = await post({ compareAt: { amount: { amount: 24900, currency: 'USD' }, basis: 'lowest_30_days' } });
    expect(was.statusCode).toBe(400);
    expect(was.json().error.code).toBe('WAS_PRICE_NOT_VERIFIED');

    const used = await post({ condition: 'used_like_new', conditionNotes: 'Opened once', missingItems: ['carry case'], sellerSku: 'NW-USED-1' });
    expect(used.statusCode, used.body).toBe(201);
    expect(used.json().offer).toMatchObject({ missingItems: ['Carry case'], complete: false, includedItems: ['Headphones', 'USB-C cable'] });

    expect((await post({ sellerSku: 'NW-FIRST' })).statusCode).toBe(201);
    const dupNew = await post({});
    expect(dupNew.statusCode).toBe(409);
    expect(dupNew.json().error.code).toBe('DUPLICATE_OFFER');
    const dupSku = await post({ variantId: p.variants[1], sellerSku: 'NW-FIRST' });
    expect(dupSku.json().error.code).toBe('DUPLICATE_OFFER');

    // G10: a list price catalog staff set on the variant backs a list_price was-price, up to that price
    const variantList = addProduct(h, { listPrices: [29900, null], specs: { 'List price': '$399.00' } });
    const wasList = (variantId: string, amount: number) => offerInput(variantList.id, variantId, prof, { compareAt: { amount: { amount, currency: 'USD' }, basis: 'list_price' } });
    const byVariant = await asSeller(h, sellerId, 'POST', '/offers', wasList(variantList.variants[0]!, 29900));
    expect(byVariant.statusCode, byVariant.body).toBe(201);
    expect(byVariant.json().offer.compareAt).toMatchObject({ verified: true, basis: 'list_price', amount: { amount: 29900 } });
    const higher = await asSeller(h, sellerId, 'POST', '/offers', { ...wasList(variantList.variants[0]!, 30900), condition: 'used_like_new', conditionNotes: 'Opened once', sellerSku: 'NW-LIST-2' });
    expect(higher.json().error).toMatchObject({ code: 'WAS_PRICE_NOT_VERIFIED', details: { listPrice: { amount: 29900 } } });

    // H15: a list price a seller typed into the specs ("MSRP", "List price") is not evidence for a was-price
    const fake = await asSeller(h, sellerId, 'POST', '/offers', wasList(variantList.variants[1]!, 39900));
    expect(fake.statusCode).toBe(400);
    expect(fake.json().error).toMatchObject({ code: 'WAS_PRICE_NOT_VERIFIED', message: 'There is no manufacturer list price on file for this product' });
    const msrp = addProduct(h, { specs: { MSRP: '$199' } });
    const fakeMsrp = await asSeller(h, sellerId, 'POST', '/offers', offerInput(msrp.id, msrp.variants[0]!, prof, { compareAt: { amount: { amount: 19900, currency: 'USD' }, basis: 'list_price' } }));
    expect(fakeMsrp.json().error.code).toBe('WAS_PRICE_NOT_VERIFIED');
  });

  it('refuses restricted sellers and products that cannot be sold', async () => {
    const restricted = addSeller(h, { status: 'restricted', restrictions: [{ id: newId(), activities: ['new_offers'], scope: { conditions: ['refurbished'] } }] });
    const p = addProduct(h);
    const refurb = await asSeller(h, restricted, 'POST', '/offers', offerInput(p.id, p.variants[0]!, profile(h, 599, 3, restricted), { condition: 'refurbished', conditionNotes: 'Grade A' }));
    expect(refurb.statusCode).toBe(409);
    expect(refurb.json().error).toMatchObject({ code: 'SELLER_RESTRICTED', details: { appealRoute: 'Appeal in Seller Center' } });
    // the restriction covers refurbished only
    expect((await asSeller(h, restricted, 'POST', '/offers', offerInput(p.id, p.variants[0]!, profile(h, 599, 3, restricted)))).statusCode).toBe(201);

    const rejected = addProduct(h, { reviewState: 'rejected', ownerSellerId: restricted });
    expect((await asSeller(h, restricted, 'POST', '/offers', offerInput(rejected.id, rejected.variants[0]!, profile(h, 599, 3, restricted)))).json().error.code).toBe('PRODUCT_NOT_PURCHASABLE');
  });

  it('keeps drafts on products in review and publishes them when the product is approved', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h, { reviewState: 'submitted', ownerSellerId: sellerId });
    const res = await asSeller(h, sellerId, 'POST', '/offers', offerInput(p.id, p.variants[0]!, profile(h, 599, 3, sellerId), { publish: true }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().offer).toMatchObject({ status: 'draft', publishOnApproval: true });
    expect((await asSeller(h, sellerId, 'POST', `/offers/${res.json().offer.id}/publish`)).json().error.code).toBe('PRODUCT_NOT_PURCHASABLE');

    p.product.reviewState = 'approved';
    await emit(h, 'catalog.product.approved', { productId: p.id, ownerSellerId: sellerId });
    expect((await h.api.getOffer(res.json().offer.id))?.status).toBe('active');
  });

  it('waits for the launch review before publishing', async () => {
    const sellerId = addSeller(h, { launchReady: false });
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    expect(o.body.offer).toMatchObject({ status: 'draft', publishOnApproval: true, statusReason: { code: 'awaiting_launch_review' } });
    h.sellers.get(sellerId)!.launchReady = true;
    await emit(h, 'sellers.launch_review.decided', { sellerId, outcome: 'passed', decidedAt: new Date().toISOString() });
    const after = await h.api.getOffer(o.id);
    expect(after).toMatchObject({ status: 'active', statusReason: null });
  });
});

describe('the offer lifecycle', () => {
  it('pauses, resumes and ends; illegal moves are refused', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    expect((await asSeller(h, sellerId, 'POST', `/offers/${o.id}/resume`)).statusCode).toBe(409);
    const paused = await asSeller(h, sellerId, 'POST', `/offers/${o.id}/pause`, { reason: 'Holiday' });
    expect(paused.json().offer.status).toBe('paused');
    expect(paused.json().statusLog[0]).toMatchObject({ from: 'active', to: 'paused', reason: 'Holiday' });
    expect((await asSeller(h, sellerId, 'POST', `/offers/${o.id}/resume`)).json().offer.status).toBe('active');
    const ended = await asSeller(h, sellerId, 'POST', `/offers/${o.id}/end`, { reason: 'Discontinued' });
    expect(ended.json().offer).toMatchObject({ status: 'removed', statusReason: { code: 'ended_by_seller' } });
    expect((await asSeller(h, sellerId, 'POST', `/offers/${o.id}/pause`, {})).statusCode).toBe(409);
    expect((await asSeller(h, sellerId, 'DELETE', `/offers/${o.id}`)).statusCode).toBe(409);
  });

  it('deletes drafts that were never published', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const res = await asSeller(h, sellerId, 'POST', '/offers', offerInput(p.id, p.variants[0]!, profile(h, 599, 3, sellerId)));
    const id = res.json().offer.id;
    expect((await asSeller(h, addSeller(h), 'DELETE', `/offers/${id}`)).statusCode).toBe(404);
    expect((await asSeller(h, sellerId, 'DELETE', `/offers/${id}`)).statusCode).toBe(204);
    expect(await h.api.getOffer(id)).toBeNull();
  });

  it('pauses several offers, each on its own', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h, { variants: 2 });
    const a = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const draft = await asSeller(h, sellerId, 'POST', '/offers', offerInput(p.id, p.variants[1]!, profile(h, 599, 3, sellerId)));
    const res = await asSeller(h, sellerId, 'POST', '/offers/bulk-pause', { offerIds: [a.id, draft.json().offer.id, newId()] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results).toEqual([
      { offerId: a.id, ok: true, status: 'paused' },
      expect.objectContaining({ offerId: draft.json().offer.id, ok: false, error: expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }) }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) }),
    ]);
  });

  it('follows inventory: out of stock at zero, active again when stock returns', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!, { quantity: 2 });
    await setStock(h, sellerId, o.stockItemId, 0);
    expect((await h.api.getOffer(o.id))?.status).toBe('out_of_stock');
    await setStock(h, sellerId, o.stockItemId, 5);
    expect((await h.api.getOffer(o.id))?.status).toBe('active');
  });

  it('lists own offers with stock and counts the tabs', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h, { variants: 3 });
    const a = await sellerOffer(h, sellerId, p.id, p.variants[0]!, { sellerSku: 'LIST-A' });
    await sellerOffer(h, sellerId, p.id, p.variants[1]!, { quantity: 0 });
    await asSeller(h, sellerId, 'POST', '/offers', offerInput(p.id, p.variants[2]!, profile(h, 599, 3, sellerId)));
    const list = await asSeller(h, sellerId, 'GET', '/offers?limit=10');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toHaveLength(3);
    expect(list.json().items[0]).toMatchObject({ productReviewState: 'approved', productPublication: 'active' });
    const search = await asSeller(h, sellerId, 'GET', '/offers?q=list-a');
    expect(search.json().items.map((r: { offer: { id: string } }) => r.offer.id)).toEqual([a.id]);
    const stock = await asSeller(h, sellerId, 'GET', '/offers?stockState=out_of_stock');
    expect(stock.json().items).toHaveLength(1);
    const counts = await asSeller(h, sellerId, 'GET', '/offers/counts');
    expect(counts.json()).toMatchObject({ all: 3, active: 1, draft: 1, outOfStock: 1, productCount: 1 });
  });
});

describe('seller prices', () => {
  it('changes the price, records history and bumps the terms version', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const res = await asSeller(h, sellerId, 'PATCH', `/offers/${o.id}`, { price: { amount: 17900, currency: 'USD' }, dispatchBusinessDays: 2 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().offer).toMatchObject({ price: { amount: 17900 }, termsVersion: 3, dispatch: { businessDays: 2, label: 'Ships in 2 business days' } });
    expect(res.json().priceHistory.map((x: { price: { amount: number } }) => x.price.amount)).toEqual([17900, 18900]);
    expect(eventsNamed(h, 'offers.offer.price_changed').find((e) => e.offerId === o.id)).toMatchObject({ from: { amount: 18900 }, to: { amount: 17900 }, termsVersion: 3 });
    expect(eventsNamed(h, 'offers.offer.updated').find((e) => e.offerId === o.id)).toMatchObject({ fields: ['dispatch'], termsVersion: 2 });
  });

  it('needs confirmation for large changes', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const big = await asSeller(h, sellerId, 'POST', '/price-changes', { items: [{ offerId: o.id, price: { amount: 5900, currency: 'USD' } }] });
    expect(big.statusCode).toBe(409);
    expect(big.json().error).toMatchObject({ code: 'LARGE_PRICE_CHANGE_UNCONFIRMED', details: { offers: [expect.objectContaining({ offerId: o.id, changePct: -68.78 })] } });
    expect((await asSeller(h, sellerId, 'PATCH', `/offers/${o.id}`, { price: { amount: 5900, currency: 'USD' } })).json().error.code).toBe('LARGE_PRICE_CHANGE_UNCONFIRMED');
    const ok = await asSeller(h, sellerId, 'POST', '/price-changes', { items: [{ offerId: o.id, price: { amount: 5900, currency: 'USD' } }, { offerId: newId(), price: { amount: 100, currency: 'USD' } }], confirmLargeChange: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().results[0]).toMatchObject({ ok: true, change: { state: 'applied', source: 'seller', changePct: -68.78 } });
    expect(ok.json().results[1]).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('accepts a was-price only when the price was charged for the whole look-back window', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const sale = { offerId: o.id, price: { amount: 15900, currency: 'USD' }, compareAt: { amount: { amount: 18900, currency: 'USD' }, basis: 'lowest_30_days' } };
    const early = await asSeller(h, sellerId, 'POST', '/price-changes', { items: [sale] });
    expect(early.json().results[0]).toMatchObject({ ok: false, error: { code: 'WAS_PRICE_NOT_VERIFIED' } });
    h.clock.advance(31 * DAY);
    const tooHigh = await asSeller(h, sellerId, 'POST', '/price-changes', { items: [{ ...sale, compareAt: { amount: { amount: 19900, currency: 'USD' }, basis: 'lowest_30_days' } }] });
    expect(tooHigh.json().results[0].error.code).toBe('WAS_PRICE_NOT_VERIFIED');
    const ok = await asSeller(h, sellerId, 'POST', '/price-changes', { items: [{ ...sale, saleEndsAt: new Date(h.clock.now().getTime() + 7 * DAY).toISOString() }] });
    expect(ok.json().results[0], JSON.stringify(ok.json())).toMatchObject({ ok: true });
    const offer = await h.api.getOffer(o.id);
    expect(offer?.compareAt).toMatchObject({ verified: true, amount: { amount: 18900 }, basis: 'lowest_30_days' });
    expect(await h.api.lowestPrice(o.id, 30)).toEqual({ amount: 15900, currency: 'USD' });
    expect(await h.api.lowestPrice(o.id, 30, new Date(h.clock.now().getTime() - 1000).toISOString())).toEqual({ amount: 18900, currency: 'USD' });
    expect(await h.api.priceRange(o.id, 60)).toMatchObject({ lowest: { amount: 15900 }, highest: { amount: 18900 }, current: { amount: 15900 }, unchanged: false });

    // the sale ends: the price reverts and the was-price goes
    h.clock.advance(8 * DAY);
    await h.app.kernel.jobs.runNow('offers.apply-price-schedule');
    await h.app.kernel.events.drain();
    expect(await h.api.getOffer(o.id)).toMatchObject({ price: { amount: 18900 }, compareAt: null, saleEndsAt: null });
    h.clock.set(new Date());
  });
});
