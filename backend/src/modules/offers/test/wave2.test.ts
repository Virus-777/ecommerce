/**
 * Wave 2 (BACKEND-REQUESTS.md): the featured-offer tie rule (G17b), the Official Store cue in the purchase box (G59),
 * large changes flagged in the bulk preview (G38), stock item ids, draft counts and the publication filter (G47c,
 * G53a), the delivery location label (G53c) and the Official Store view permission (G77).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { rankCandidates, type RankInput } from '../domain/rules.js';
import { featuredRuleOfficialTie } from '../migrations.js';
import { addProduct, addSeller, asSeller, asStaff, asVisitor, call, harness, offerInput, profile, sellerOffer, setStock, sku, staffHeaders, warehouse, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await warehouse(h);
});
afterAll(async () => {
  await h?.app.close();
});

/** A published Official Store offer on the variant */
async function officialOffer(productId: string, variantId: string, over: Record<string, unknown> = {}) {
  const res = await asStaff(h, 'POST', '/official/offers', {
    productId,
    variantId,
    condition: 'new',
    price: { amount: 18900, currency: 'USD' },
    sku: sku('OFF'),
    dispatchBusinessDays: 1,
    shippingProfileId: profile(h, 0, 3, null),
    returnTerms: { kind: 'baseline' },
    warranty: { kind: 'none' },
    quantity: 5,
    publish: true,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  const stockItemId = res.json().offer.stockItemId as string;
  await setStock(h, '', stockItemId, 5); // company stock starts at 0
  return { id: res.json().offer.id as string, stockItemId };
}

const cand = (over: Partial<RankInput>): RankInput => ({ offerId: newId(), eligible: true, total: 18900, itemPrice: 18900, arrivesTo: null, dispatchDays: 1, onTimePct: 100, publishedAt: new Date('2026-01-01'), ...over });

describe('featured offer: lowest delivered total, the Official Store wins an exact tie (G17b)', () => {
  it('ranks with the rule tie-breakers in order; versions without any keep the first order', () => {
    const seller = cand({ publishedAt: new Date('2025-01-01') });
    const official = cand({ official: true, publishedAt: new Date('2026-06-01') });
    const cheaper = cand({ total: 18800 });
    const v2 = { deliveryDayAdjustmentPct: 0, tieBreakers: ['official_store', 'on_time_dispatch', 'earliest_publication'] };
    expect(rankCandidates([seller, official], v2).map((c) => c.offerId)).toEqual([official.offerId, seller.offerId]);
    // the lowest total still wins outright
    expect(rankCandidates([seller, official, cheaper], v2)[0]!.offerId).toBe(cheaper.offerId);
    // the first rule (and versions listing none) broke ties by on-time dispatch, then the earlier listing
    expect(rankCandidates([seller, official], { deliveryDayAdjustmentPct: 0, tieBreakers: ['on_time_dispatch', 'earliest_publication'] })[0]!.offerId).toBe(seller.offerId);
    expect(rankCandidates([seller, official], { deliveryDayAdjustmentPct: 0, tieBreakers: [] })[0]!.offerId).toBe(seller.offerId);
  });

  it('features the Official Store on an exact tie and the cheaper seller otherwise', async () => {
    const p = addProduct(h);
    const v = p.variants[0]!;
    const s = addSeller(h, { name: 'Northwind Audio', onTimePct: 100 });
    const so = await sellerOffer(h, s, p.id, v, { price: { amount: 18900, currency: 'USD' }, shippingProfileId: profile(h, 0, 3, s) }); // listed first
    const of = await officialOffer(p.id, v);
    const rule = (await asVisitor(h, '/featured-offer-rule')).json();
    expect(rule.parameters).toMatchObject({ deliveryDayAdjustmentPct: 0, tieBreakers: ['official_store', 'on_time_dispatch', 'earliest_publication'] });
    expect((await asVisitor(h, `/products/${p.id}/offers?postalCode=97205`)).json().featuredOfferId).toBe(of.id);

    await asSeller(h, s, 'PATCH', `/offers/${so.id}`, { price: { amount: 18400, currency: 'USD' } });
    await h.app.kernel.jobs.runNow('offers.recompute-featured');
    expect((await asVisitor(h, `/products/${p.id}/offers?postalCode=97205`)).json().featuredOfferId).toBe(so.id);
  });

  it('migration: an install with rule versions gets the new rule as a new version, once', async () => {
    const db = h.app.kernel.mongo.db;
    const rules = db.collection<{ _id: number }>('offers.featured_rules');
    const saved = await rules.find({}).toArray();
    await rules.deleteMany({});
    const old = { minOnTimeDispatchPct: 92, performanceWindowDays: 60, deliveryDayAdjustmentPct: 1, competingConditions: ['new'], tieBreakers: ['on_time_dispatch', 'earliest_publication'] };
    await rules.insertOne({ _id: 1, text: 'Old wording', steps: ['x'], parameters: old, effective_from: new Date('2000-01-01'), reason: 'Initial', published_by: 'system', published_at: new Date('2000-01-01') } as never);
    try {
      for (let run = 0; run < 2; run++) await featuredRuleOfficialTie.up(db);
      const rows = (await rules.find({}).sort({ _id: 1 }).toArray()) as unknown as { _id: number; parameters: Record<string, unknown>; reason: string }[];
      expect(rows.map((r) => r._id)).toEqual([1, 2]);
      expect(rows[1]!.parameters).toEqual({ ...old, deliveryDayAdjustmentPct: 0, tieBreakers: ['official_store', 'on_time_dispatch', 'earliest_publication'] });
      expect(rows[1]!.reason).toContain('G17b');
      const admin = (await asStaff(h, 'GET', '/featured-rule')).json();
      expect(admin).toMatchObject({ current: { version: 2 }, history: [{ version: 1 }] });
    } finally {
      await rules.deleteMany({});
      if (saved.length) await rules.insertMany(saved as never);
    }
  });
});

describe('purchase box: the Official Store cue (G59)', () => {
  it('says the Official Store is out of stock while another seller holds the buy box', async () => {
    const p = addProduct(h);
    const v = p.variants[0]!;
    const of = await officialOffer(p.id, v, { price: { amount: 17900, currency: 'USD' } });
    const s = addSeller(h, { name: 'Gadget Grove' });
    await sellerOffer(h, s, p.id, v, { price: { amount: 18900, currency: 'USD' } });
    // in stock and cheapest: the Official Store holds the buy box, no cue
    expect((await asVisitor(h, `/products/${p.id}/purchase-box`)).json()).toMatchObject({ selected: { offerId: of.id }, officialStore: null });

    await setStock(h, s, of.stockItemId, 0);
    await h.app.kernel.jobs.runNow('offers.recompute-featured');
    const box = (await asVisitor(h, `/products/${p.id}/purchase-box`)).json();
    expect(box.selected.seller.name).toBe('Gadget Grove');
    expect(box.officialStore).toMatchObject({ offerId: of.id, state: 'out_of_stock', title: 'Out of stock at the Official Store', price: { amount: 17900 }, expectedRestockDate: null });
  });
});

describe('Seller Center offer lists and previews', () => {
  it('flags large price changes in the bulk preview; drafts are exempt (G38)', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h, { variants: 3 });
    await sellerOffer(h, sellerId, p.id, p.variants[0]!, { sellerSku: 'W2-BIG' });
    await sellerOffer(h, sellerId, p.id, p.variants[1]!, { sellerSku: 'W2-SMALL' });
    const draft = await asSeller(h, sellerId, 'POST', '/offers', offerInput(p.id, p.variants[2]!, profile(h, 599, 3, sellerId), { sellerSku: 'W2-DRAFT' }));
    expect(draft.statusCode, draft.body).toBe(201);
    const fileId = newId();
    h.files.set(fileId, { name: 'prices.csv', owner: { kind: 'seller', id: sellerId } as never, text: 'seller_sku,price\nW2-BIG,999.00\nW2-SMALL,180.00\nW2-DRAFT,999.00\n' });
    const job = (await asSeller(h, sellerId, 'POST', '/bulk-updates', { fileId })).json();
    const rows = (await asSeller(h, sellerId, 'GET', `/bulk-updates/${job.id}/rows`)).json().items;
    expect(rows.map((r: { sellerSku: string; largeChange: boolean; changePct: number | null }) => [r.sellerSku, r.largeChange, r.changePct])).toEqual([
      ['W2-BIG', true, 428.57],
      ['W2-SMALL', false, -4.76],
      ['W2-DRAFT', false, 428.57],
    ]);
  });

  it('carries the stock item id, counts product drafts and filters by publication (G47c, G53a)', async () => {
    const sellerId = addSeller(h);
    const live = addProduct(h);
    const hidden = addProduct(h, { publication: 'hidden' });
    const own = addProduct(h, { reviewState: 'draft', ownerSellerId: sellerId });
    const o = await sellerOffer(h, sellerId, live.id, live.variants[0]!);
    await sellerOffer(h, sellerId, hidden.id, hidden.variants[0]!).catch(() => null);
    const d = await asSeller(h, sellerId, 'POST', '/offers', offerInput(own.id, own.variants[0]!, profile(h, 599, 3, sellerId)));
    expect(d.statusCode, d.body).toBe(201);

    const list = (await asSeller(h, sellerId, 'GET', '/offers')).json().items;
    expect(list.find((r: { offer: { id: string } }) => r.offer.id === o.id).offer.stockItemId).toBe(o.stockItemId);
    const counts = (await asSeller(h, sellerId, 'GET', '/offers/counts')).json();
    expect(counts.productDraft).toBe(1);
    expect(counts.productPublication).toEqual({ active: counts.all - counts.productPublication.hidden, hidden: counts.productPublication.hidden, suspended: 0 });
    const hiddenRows = (await asSeller(h, sellerId, 'GET', '/offers?productPublication=hidden')).json().items;
    expect(hiddenRows.every((r: { productPublication: string }) => r.productPublication === 'hidden')).toBe(true);
    expect(hiddenRows).toHaveLength(counts.productPublication.hidden);
    expect((await asSeller(h, sellerId, 'GET', '/offers?productPublication=active')).json().items.map((r: { offer: { id: string } }) => r.offer.id)).toContain(o.id);
  });

  it('labels the delivery location in the offer preview (G53c)', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const res = await asSeller(h, sellerId, 'POST', '/offers/preview', offerInput(p.id, p.variants[0]!, profile(h, 599, 3, sellerId)));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().delivery.locationLabel).toMatch(/\d{5}$/);
  });
});

describe('Official Store reads need offers.official.view (G77)', () => {
  it('lets a viewer read the Official Store list and keeps writes on the manage key', async () => {
    expect((await call(h, 'GET', '/api/admin/offers/official/offers', staffHeaders(['offers.official.view']))).statusCode).toBe(200);
    expect((await call(h, 'GET', '/api/admin/offers/price-changes', staffHeaders(['offers.official.view']))).statusCode).toBe(200);
    expect((await call(h, 'GET', '/api/admin/offers/official/offers', staffHeaders(['offers.official.manage']))).statusCode).toBe(403);
    const p = addProduct(h);
    const write = await call(h, 'POST', '/api/admin/offers/official/offers', staffHeaders(['offers.official.view']), { productId: p.id, variantId: p.variants[0], condition: 'new', price: { amount: 100, currency: 'USD' }, sku: sku('X'), dispatchBusinessDays: 1, shippingProfileId: profile(h, 0, 2, null), returnTerms: { kind: 'baseline' }, warranty: { kind: 'none' } });
    expect(write.statusCode).toBe(403);
  });
});
