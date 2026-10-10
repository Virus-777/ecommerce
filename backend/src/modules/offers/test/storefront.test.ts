import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { addProduct, addSeller, asSeller, asStaff, asVisitor, call, eventsNamed, harness, profile, sellerOffer, setStock, visitorHeaders, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

/** Three sellers on one variant: cheap item with dear shipping, best total, and a used offer */
async function market() {
  const p = addProduct(h);
  const v = p.variants[0]!;
  const a = addSeller(h, { name: 'Northwind Audio' });
  const b = addSeller(h, { name: 'Gadget Grove' });
  const c = addSeller(h, { name: 'Second Life' });
  const oa = await sellerOffer(h, a, p.id, v, { price: { amount: 17900, currency: 'USD' }, shippingProfileId: profile(h, 1999, 3, a) }); // total 19899
  const ob = await sellerOffer(h, b, p.id, v, { price: { amount: 18900, currency: 'USD' }, shippingProfileId: profile(h, 0, 3, b) }); // total 18900
  const oc = await sellerOffer(h, c, p.id, v, { condition: 'used_good', conditionNotes: 'Scuffed', price: { amount: 9900, currency: 'USD' } });
  return { p, v, a, b, c, oa, ob, oc };
}

describe('comparing offers', () => {
  it('ranks by comparable total, marks the featured offer and counts conditions', async () => {
    const m = await market();
    const res = await asVisitor(h, `/products/${m.p.id}/offers?postalCode=97205`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.featuredOfferId).toBe(m.ob.id);
    expect(body.conditionCounts).toEqual({ all: 3, new: 2, used: 1, refurbished: 0 });
    expect(body.deliverTo).toMatchObject({ postalCode: '97205', source: 'entered' });
    expect(body.taxNote).toBe('Totals include shipping; sales tax is added at checkout.');
    const byId = Object.fromEntries(body.offers.map((o: { offerId: string }) => [o.offerId, o]));
    expect(byId[m.ob.id]).toMatchObject({ featured: true, featuredEligible: true, total: { amount: 18900 }, delivery: { free: true, shipsToLocation: true }, seller: { name: 'Gadget Grove', onTimeDispatchPct: 97 } });
    expect(byId[m.oa.id]).toMatchObject({ featured: false, total: { amount: 19899 } });
    expect(byId[m.oc.id]).toMatchObject({ conditionLabel: 'Used – Good', featured: false, ineligibleNote: null });
    expect(body.offers[0].offerId).toBe(m.oc.id); // cheapest total first
    const used = await asVisitor(h, `/products/${m.p.id}/offers?condition=used`);
    expect(used.json().offers.map((o: { offerId: string }) => o.offerId)).toEqual([m.oc.id]);
    expect(used.json().featuredOfferId).toBe(m.oc.id);

    const decision = await asStaff(h, 'GET', `/products/${m.p.id}/featured-decision?variantId=${m.v}&postalCode=97205`);
    expect(decision.statusCode, decision.body).toBe(200);
    const cands = decision.json().candidates;
    expect(cands[0]).toMatchObject({ offerId: m.ob.id, rank: 1, eligible: true });
    expect(cands.find((c: { offerId: string }) => c.offerId === m.oc.id)).toMatchObject({ eligible: false, reasons: [expect.objectContaining({ code: 'condition_not_competing' })] });
    expect(await h.api.getFeaturedOffer(m.v, '97205')).toMatchObject({ offerId: m.ob.id, featured: true });
  });

  it('changes the featured offer when the winner goes out of stock and tells search', async () => {
    const m = await market();
    expect((await h.api.getFeaturedOffer(m.v, '97205'))?.offerId).toBe(m.ob.id);
    await setStock(h, m.b, m.ob.stockItemId, 0);
    await h.app.kernel.jobs.runNow('offers.recompute-featured');
    await h.app.kernel.events.drain();
    expect(eventsNamed(h, 'offers.featured.changed').find((e) => e.variantId === m.v)).toMatchObject({ fromOfferId: m.ob.id, toOfferId: m.oa.id, conditionGroup: 'new', zoneKey: '972' });
    expect((await h.api.getFeaturedOffer(m.v, '97205'))?.offerId).toBe(m.oa.id);
  });

  it('explains offers that do not ship to the location', async () => {
    const m = await market();
    const res = await asVisitor(h, `/products/${m.p.id}/offers?postalCode=99501`);
    expect(res.json().featuredOfferId).toBeNull();
    expect(res.json().offers.every((o: { featuredEligible: boolean; ineligibleNote: string }) => !o.featuredEligible && o.ineligibleNote)).toBe(true);
    const box = await asVisitor(h, `/products/${m.p.id}/purchase-box?postalCode=99501`);
    expect(box.json()).toMatchObject({ selected: null, unavailable: { reason: 'not_shippable' } });
  });
});

describe('the purchase box', () => {
  it('shows the featured offer, or keeps the seller the customer chose with the featured one beside it', async () => {
    const m = await market();
    const box = await asVisitor(h, `/products/${m.p.id}/purchase-box`);
    expect(box.statusCode, box.body).toBe(200);
    expect(box.json()).toMatchObject({ selectedBy: 'featured', selected: { offerId: m.ob.id }, featured: null, deliverTo: { source: 'market_default' }, quantityOptions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], otherOffers: { count: 2 } });
    expect(box.json().variants).toHaveLength(2);
    expect(box.json().variants[0]).toMatchObject({ variantId: m.v, offerCount: 3, inStock: true });
    const chosen = await asVisitor(h, `/products/${m.p.id}/purchase-box?offerId=${m.oa.id}`);
    expect(chosen.json()).toMatchObject({ selectedBy: 'customer_choice', selected: { offerId: m.oa.id }, featured: { offerId: m.ob.id } });
  });

  it('explains an out-of-stock only offer with alternatives', async () => {
    const p = addProduct(h, { variants: 1 });
    const s = addSeller(h, { name: 'Solo Shop' });
    const o = await sellerOffer(h, s, p.id, p.variants[0]!, { quantity: 0 });
    const box = await asVisitor(h, `/products/${p.id}/purchase-box?offerId=${o.id}`);
    expect(box.json()).toMatchObject({ selectedBy: 'customer_choice', selected: { offerId: o.id, status: 'out_of_stock' }, quantityOptions: [], unavailable: { reason: 'out_of_stock', title: 'Out of stock at Solo Shop' } });
    expect((await asVisitor(h, `/products/${newId()}/purchase-box`)).statusCode).toBe(404);
  });
});

describe('carts and orders', () => {
  it('reports what changed and never substitutes another seller (scenario 2)', async () => {
    const m = await market();
    const lineA = { offerId: m.oa.id, quantity: 1, termsVersion: 1, price: { amount: 17900, currency: 'USD' } };
    const lineB = { offerId: m.ob.id, quantity: 1, termsVersion: 1, price: { amount: 18900, currency: 'USD' } };
    expect(await h.api.revalidate([lineA, lineB], '97205')).toEqual({ ok: true, changes: [] });

    await asSeller(h, m.a, 'PATCH', `/offers/${m.oa.id}`, { price: { amount: 18400, currency: 'USD' } });
    await asSeller(h, m.b, 'PATCH', `/offers/${m.ob.id}`, { warranty: { kind: 'seller', months: 12 } });
    const r = await h.api.revalidate([lineA, lineB, { ...lineB, offerId: m.oc.id, quantity: 50, price: { amount: 9900, currency: 'USD' } }], '97205');
    expect(r.ok).toBe(false);
    expect(r.changes).toEqual([
      expect.objectContaining({ offerId: m.oa.id, kind: 'price', before: '$179.00', after: '$184.00', alternatives: [] }),
      expect.objectContaining({ offerId: m.ob.id, kind: 'terms' }),
      expect.objectContaining({ offerId: m.oc.id, kind: 'availability', after: '10' }),
    ]);

    await asSeller(h, m.a, 'POST', `/offers/${m.oa.id}/end`, {});
    const gone = await h.api.revalidate([{ ...lineA, price: { amount: 18400, currency: 'USD' }, termsVersion: 2 }], '97205');
    expect(gone.changes[0]).toMatchObject({ offerId: m.oa.id, kind: 'removed' });
    expect(gone.changes[0]!.alternatives.map((v) => v.offerId)).toContain(m.ob.id);
  });

  it('freezes the terms for an order item and refuses offers that cannot be bought', async () => {
    const m = await market();
    const snap = await h.api.snapshotForOrder(m.oc.id);
    expect(snap).toMatchObject({ offerId: m.oc.id, sellerId: m.c, sellerName: 'Second Life', condition: 'used_good', conditionNotes: 'Scuffed', price: { amount: 9900 }, termsVersion: 1, stockItemId: m.oc.stockItemId });
    await asSeller(h, m.c, 'POST', `/offers/${m.oc.id}/pause`, {});
    await expect(h.api.snapshotForOrder(m.oc.id)).rejects.toMatchObject({ code: 'OFFER_UNAVAILABLE', status: 409 });
  });

  it('answers quotes, stats and promotability for other modules', async () => {
    const m = await market();
    const view = await asVisitor(h, `/offers/${m.oa.id}?quantity=2&postalCode=97205`);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({ total: { amount: 17900 * 2 + 1999 }, availability: { maxPerOrder: 10 } });
    const stats = await h.api.getOfferStats([m.p.id, newId()]);
    expect(stats[m.p.id]).toMatchObject({ count: 3, lowest: { amount: 9900 }, highest: { amount: 18900 }, lowestOfferId: m.oc.id });
    expect(Object.values(stats)[1]).toBeNull();
    expect(await h.api.isPromotable(m.ob.id)).toBe(true);
    expect((await h.api.listActiveOffersForProduct(m.p.id)).map((s) => s.id).sort()).toEqual([m.oa.id, m.ob.id, m.oc.id].sort());
    expect((await h.api.listActiveOffersByIds([m.oc.id, newId(), m.oa.id])).map((o) => o.id)).toEqual([m.oc.id, m.oa.id]);
    const boxOffer = await h.api.getPurchaseBoxOffer([{ productId: m.p.id, offerId: m.oa.id }]);
    expect(boxOffer[m.p.id]?.id).toBe(m.oa.id);
  });
});

describe('GraphQL', () => {
  it('serves offers with quotes primed by the comparison', async () => {
    const m = await market();
    const query = `query($id: UUID!) { offer(id: $id) { id ownerType condition conditionLabel price { amount formatted } quote(postalCode: "97205") { total { amount } featured deliverTo { source } } } }`;
    const res = await call(h, 'POST', '/graphql/store', visitorHeaders(), { query, variables: { id: m.ob.id } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().errors).toBeUndefined();
    expect(res.json().data.offer).toMatchObject({ id: m.ob.id, ownerType: 'SELLER', condition: 'NEW', price: { formatted: '$189.00' }, quote: { total: { amount: 18900 }, featured: true, deliverTo: { source: 'ENTERED' } } });
  });
});
