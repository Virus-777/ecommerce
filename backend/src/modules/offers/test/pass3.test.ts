/**
 * Gap pass 3: batch reads and profile counts for other modules, shipping profile ownership, uniqueness enforced by
 * the database (Official Store included) and mapped to DUPLICATE_OFFER, reinstating into a taken slot, the stock
 * item following a draft's variant, confirmLargeChange on PATCH, title search, and trust enforcement reversals.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type { OffersService } from '../service.js';
import { addProduct, addSeller, asSeller, asStaff, emit, eventsNamed, harness, offerInput, profile, sellerOffer, sku, warehouse, type Harness } from './helpers.js';

let h: Harness;
let svc: OffersService;
beforeAll(async () => {
  h = await harness();
  svc = h.app.kernel.boot.apis.get('offers') as OffersService;
  await warehouse(h);
});
afterAll(async () => {
  await h?.app.close();
});

const officialInput = (productId: string, variantId: string, over: Record<string, unknown> = {}) => ({
  productId,
  variantId,
  condition: 'new',
  price: { amount: 19900, currency: 'USD' },
  sku: sku('HAL'),
  dispatchBusinessDays: 0,
  shippingProfileId: profile(h, 0, 2, null),
  returnTerms: { kind: 'baseline' },
  warranty: { kind: 'manufacturer', months: 24 },
  ...over,
});

describe('public API for other modules', () => {
  it('getOffers reads offers in any status in one batch; unknown ids are null', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h, { variants: 3 });
    const live = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const draft = (await asSeller(h, sellerId, 'POST', '/offers', offerInput(p.id, p.variants[1]!, profile(h, 599, 3, sellerId)))).json().offer;
    const ended = await sellerOffer(h, sellerId, p.id, p.variants[2]!);
    await asSeller(h, sellerId, 'POST', `/offers/${ended.id}/end`, { reason: 'Stopped' });
    const unknown = newId();
    const got = await h.api.getOffers([live.id, draft.id, ended.id, unknown]);
    expect(got[live.id]).toMatchObject({ status: 'active', sellerId, title: 'Halden Aurora ANC Headphones – Black' });
    expect(got[draft.id]).toMatchObject({ status: 'draft' });
    expect(got[ended.id]).toMatchObject({ status: 'removed' });
    expect(got[unknown]).toBeNull();
  });

  it('countActiveOffersByProfile counts every status but removed', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h, { variants: 3 });
    const prof = profile(h, 599, 3, sellerId);
    await sellerOffer(h, sellerId, p.id, p.variants[0]!, { shippingProfileId: prof });
    await asSeller(h, sellerId, 'POST', '/offers', offerInput(p.id, p.variants[1]!, prof)); // draft
    const ended = await sellerOffer(h, sellerId, p.id, p.variants[2]!, { shippingProfileId: prof });
    expect(await h.api.countActiveOffersByProfile(prof)).toBe(3);
    await asSeller(h, sellerId, 'POST', `/offers/${ended.id}/end`, { reason: 'Stopped' });
    expect(await h.api.countActiveOffersByProfile(prof)).toBe(2);
    expect(await h.api.countActiveOffersByProfile(newId())).toBe(0);
  });

  it('snapshots carry the seller SKU and the title', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!, { sellerSku: 'SNAP-1' });
    expect(await h.api.snapshotForOrder(o.id)).toMatchObject({ sellerSku: 'SNAP-1', title: 'Halden Aurora ANC Headphones – Black' });
  });
});

describe('shipping profile ownership', () => {
  it("refuses another seller's profile on create and edit, and a seller profile on an Official Store offer", async () => {
    const mine = addSeller(h);
    const theirs = addSeller(h);
    const p = addProduct(h);
    const foreign = profile(h, 599, 3, theirs);
    const create = await asSeller(h, mine, 'POST', '/offers', offerInput(p.id, p.variants[0]!, foreign));
    expect(create.statusCode).toBe(400);
    expect(create.json().error).toMatchObject({ code: 'SHIPPING_PROFILE_INVALID', details: { reason: 'not_your_profile' } });
    const o = await sellerOffer(h, mine, p.id, p.variants[0]!);
    const edit = await asSeller(h, mine, 'PATCH', `/offers/${o.id}`, { shippingProfileId: foreign });
    expect(edit.json().error.code).toBe('SHIPPING_PROFILE_INVALID');
    const official = await asStaff(h, 'POST', '/official/offers', officialInput(p.id, p.variants[1]!, { shippingProfileId: profile(h, 0, 2, mine) }));
    expect(official.json().error.code).toBe('SHIPPING_PROFILE_INVALID');
    expect((await asStaff(h, 'POST', '/official/offers', officialInput(p.id, p.variants[1]!))).statusCode).toBe(201);
  });
});

describe('uniqueness (database indexes, Official Store included)', () => {
  it('the database refuses a second Official Store offer with the same SKU, New variant or live stock item; 23505 maps to DUPLICATE_OFFER', async () => {
    const p = addProduct(h, { variants: 3 });
    const created = await asStaff(h, 'POST', '/official/offers', officialInput(p.id, p.variants[0]!));
    expect(created.statusCode, created.body).toBe(201);
    const row = (await svc.core.repo.get('offers', created.json().offer.id))!;
    const copy = (over: Record<string, unknown>) => svc.core.unique(() => svc.core.repo.insert('offers', { ...row, id: newId(), ...over } as never));
    // seller_id is null for every Official Store row: without NULLS NOT DISTINCT these went through
    await expect(copy({ variant_id: p.variants[1], stock_item_id: newId() })).rejects.toMatchObject({ code: 'DUPLICATE_OFFER', details: { reason: 'sku_in_use' } });
    await expect(copy({ seller_sku: sku('X'), stock_item_id: newId() })).rejects.toMatchObject({ code: 'DUPLICATE_OFFER', details: { reason: 'new_offer_exists' } });
    await expect(copy({ seller_sku: sku('X'), variant_id: p.variants[2], condition: 'refurbished' })).rejects.toMatchObject({ code: 'DUPLICATE_OFFER', details: { reason: 'stock_item_in_use' } });
  });

  it('reinstating an offer whose New-variant slot was taken meanwhile is DUPLICATE_OFFER', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const first = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    expect((await asStaff(h, 'POST', `/offers/${first.id}/remove`, { reasonCode: 'policy_violation', reason: 'Listing policy' })).statusCode).toBe(200);
    await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const back = await asStaff(h, 'POST', `/offers/${first.id}/reinstate`, { reason: 'Appeal upheld' });
    expect(back.statusCode).toBe(409);
    expect(back.json().error.code).toBe('DUPLICATE_OFFER');
    expect((await h.api.getOffer(first.id))!.status).toBe('removed');
  });

  it('status_changed carries the stock item, so inventory can archive on removal and unarchive on reinstatement', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    await asStaff(h, 'POST', `/offers/${o.id}/remove`, { reasonCode: 'policy_violation', reason: 'Listing policy' });
    await asStaff(h, 'POST', `/offers/${o.id}/reinstate`, { reason: 'Appeal upheld' });
    const changes = eventsNamed(h, 'offers.offer.status_changed').filter((e) => e.offerId === o.id);
    expect(changes.slice(-2)).toEqual([expect.objectContaining({ from: 'active', to: 'removed', stockItemId: o.stockItemId }), expect.objectContaining({ from: 'removed', to: 'paused', stockItemId: o.stockItemId, trustEnforcementId: null })]);
  });
});

describe('editing', () => {
  it('a large price change on PATCH needs confirmLargeChange; without it nothing is saved', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const refused = await asSeller(h, sellerId, 'PATCH', `/offers/${o.id}`, { price: { amount: 5900, currency: 'USD' }, purchaseLimit: 2 });
    expect(refused.json().error.code).toBe('LARGE_PRICE_CHANGE_UNCONFIRMED');
    expect(await h.api.getOffer(o.id)).toMatchObject({ price: { amount: 18900 }, purchaseLimit: null });
    const ok = await asSeller(h, sellerId, 'PATCH', `/offers/${o.id}`, { price: { amount: 5900, currency: 'USD' }, purchaseLimit: 2, confirmLargeChange: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await h.api.getOffer(o.id)).toMatchObject({ price: { amount: 5900 }, purchaseLimit: 2 });
  });

  it("a draft's variant change moves its stock item and title", async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const draft = (await asSeller(h, sellerId, 'POST', '/offers', offerInput(p.id, p.variants[0]!, profile(h, 599, 3, sellerId)))).json().offer;
    const res = await asSeller(h, sellerId, 'PATCH', `/offers/${draft.id}`, { variantId: p.variants[1] });
    expect(res.statusCode, res.body).toBe(200);
    expect(h.stockUpdates).toContainEqual(expect.objectContaining({ stockItemId: draft.stockItemId, productId: p.id, variantId: p.variants[1] }));
    expect((await h.api.getOffer(draft.id))!.title).toBe('Halden Aurora ANC Headphones – Silver');
  });

  it('staff search offers by title and filter by shipping profile', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    p.product.product.title = 'Quillon Espresso Grinder';
    const prof = profile(h, 599, 3, sellerId);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!, { shippingProfileId: prof });
    const byTitle = await asStaff(h, 'GET', '/offers?q=espresso%20grinder');
    expect(byTitle.statusCode, byTitle.body).toBe(200);
    expect(byTitle.json().items.map((r: any) => r.offer.offerId ?? r.offer.id)).toContain(o.id);
    const byProfile = await asStaff(h, 'GET', `/offers?shippingProfileId=${prof}`);
    expect(byProfile.json().items.map((r: any) => r.offer.offerId ?? r.offer.id)).toEqual([o.id]);
  });
});

describe('trust enforcement reversed', () => {
  const recorded = (enforcementId: string, offerId: string, mode?: 'hold') => ({ enforcementId, reportId: newId(), action: 'suspend_offer', ownerTeam: 'catalog', targets: [{ type: 'offer', id: offerId, label: 'Offer' }], reason: 'Counterfeit report', params: mode ? { mode } : {}, appealDeadline: null, alreadyApplied: false });
  const reversed = (enforcementId: string, offerIds: string[]) => ({ enforcementId, ref: 'EN-261010-0001', reportId: newId(), reportRef: 'TR-261010-0001', action: 'suspend_offer', ownerTeam: 'catalog', targets: offerIds.map((id) => ({ type: 'offer', id, label: 'Offer' })), params: {}, executionState: 'applied', reason: 'Appeal upheld', appealId: newId(), reversedBy: { kind: 'staff', id: newId() }, reversedAt: new Date().toISOString() });

  it('brings a removed offer back as paused and releases a held one, with trustEnforcementId on status_changed', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const removed = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const held = await sellerOffer(h, sellerId, p.id, p.variants[1]!);
    const e1 = newId();
    const e2 = newId();
    await emit(h, 'trust.enforcement.recorded', recorded(e1, removed.id));
    await emit(h, 'trust.enforcement.recorded', recorded(e2, held.id, 'hold'));
    expect((await h.api.getOffer(removed.id))!.status).toBe('removed');
    expect((await h.api.getOffer(held.id))!.status).toBe('ineligible');
    expect(eventsNamed(h, 'offers.offer.status_changed').filter((e) => e.offerId === removed.id).at(-1)).toMatchObject({ to: 'removed', trustEnforcementId: e1 });

    await emit(h, 'trust.enforcement.reversed', reversed(e1, [removed.id]));
    await emit(h, 'trust.enforcement.reversed', reversed(e2, [held.id]));
    expect((await h.api.getOffer(removed.id))!.status).toBe('paused');
    expect((await h.api.getOffer(held.id))!.status).toBe('active');
    expect(eventsNamed(h, 'offers.offer.status_changed').filter((e) => e.offerId === removed.id).at(-1)).toMatchObject({ from: 'removed', to: 'paused', trustEnforcementId: e1, stockItemId: removed.stockItemId });
    expect(eventsNamed(h, 'offers.offer.status_changed').filter((e) => e.offerId === held.id).at(-1)).toMatchObject({ from: 'ineligible', to: 'active', trustEnforcementId: e2 });
  });

  it('leaves offers changed by someone else alone and notes it in the status log', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const e1 = newId();
    await emit(h, 'trust.enforcement.recorded', recorded(e1, o.id));
    // staff removal for another reason after the enforcement: reinstated by staff, then removed again by staff
    await asStaff(h, 'POST', `/offers/${o.id}/reinstate`, { reason: 'Reviewed' });
    await asStaff(h, 'POST', `/offers/${o.id}/remove`, { reasonCode: 'policy_violation', reason: 'Another policy problem' });
    await emit(h, 'trust.enforcement.reversed', reversed(e1, [o.id]));
    expect((await h.api.getOffer(o.id))!.status).toBe('removed');
    const log = await svc.core.repo.find('offer_status_log', { offer_id: o.id, event: 'enforcement_reversed' });
    expect(log).toEqual([expect.objectContaining({ reason_code: 'enforcement_reversal_skipped' })]);
  });
});
