import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { addProduct, addSeller, asSeller, emit, eventsNamed, harness, profile, sellerOffer, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const status = async (id: string) => (await h.api.getOffer(id))?.status;

describe('seller restrictions (scenario 7)', () => {
  it('stops only the offers in scope; other sellers keep selling; lifting restores them', async () => {
    const p = addProduct(h);
    const sellerId = addSeller(h);
    const other = addSeller(h);
    const refurb = await sellerOffer(h, sellerId, p.id, p.variants[0]!, { condition: 'refurbished', conditionNotes: 'Grade A' });
    const fresh = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const paused = await sellerOffer(h, sellerId, p.id, p.variants[1]!, { condition: 'refurbished', conditionNotes: 'Grade B' });
    await asSeller(h, sellerId, 'POST', `/offers/${paused.id}/pause`, {});
    const theirs = await sellerOffer(h, other, p.id, p.variants[0]!, { condition: 'refurbished', conditionNotes: 'Grade A' });

    const restrictionId = newId();
    h.sellers.get(sellerId)!.restrictions.push({ id: restrictionId, activities: ['sales', 'offer_reactivation'], scope: { conditions: ['refurbished'] } });
    h.sellers.get(sellerId)!.status = 'restricted';
    await emit(h, 'sellers.seller.restricted', {
      sellerId,
      restrictionId,
      reasonCode: 'counterfeit_risk',
      reason: 'Refurbished items without proof of source',
      affectedActivities: ['sales', 'offer_reactivation'],
      scope: { conditions: ['refurbished'] },
      categoryIds: [],
      appealRoute: 'Appeal in Seller Center within 14 days',
      appealDeadline: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      reviewDate: '2026-12-01',
    });
    expect(await status(refurb.id)).toBe('ineligible');
    expect(await status(paused.id)).toBe('ineligible');
    expect(await status(fresh.id)).toBe('active');
    expect(await status(theirs.id)).toBe('active');
    const offer = await h.api.getOffer(refurb.id);
    expect(offer?.statusReason).toMatchObject({ code: 'seller_restricted', text: 'Refurbished items without proof of source', appealRoute: 'Appeal in Seller Center within 14 days', affectedActivity: 'Refurbished offers: sales and offer reactivation' });
    expect(eventsNamed(h, 'offers.offer.status_changed').find((e) => e.offerId === refurb.id && e.to === 'ineligible')).toMatchObject({ reasonCode: 'seller_restricted' });
    // the event delivered twice changes nothing
    expect(eventsNamed(h, 'offers.offer.status_changed').filter((e) => e.offerId === refurb.id && e.to === 'ineligible')).toHaveLength(1);

    h.sellers.get(sellerId)!.restrictions = [];
    h.sellers.get(sellerId)!.status = 'approved';
    await emit(h, 'sellers.restriction.lifted', { sellerId, restrictionId, reason: 'Proof provided' });
    expect(await status(refurb.id)).toBe('active');
    expect(await status(paused.id)).toBe('paused'); // returns to the status held before
  });

  it('refuses resuming while offer reactivation is restricted', async () => {
    const p = addProduct(h);
    const sellerId = addSeller(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    await asSeller(h, sellerId, 'POST', `/offers/${o.id}/pause`, {});
    h.sellers.get(sellerId)!.restrictions.push({ id: newId(), activities: ['offer_reactivation'], scope: {} });
    const res = await asSeller(h, sellerId, 'POST', `/offers/${o.id}/resume`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SELLER_RESTRICTED');
  });

  it('suspends every offer of the seller and restores them on reinstatement', async () => {
    const p = addProduct(h);
    const sellerId = addSeller(h);
    const a = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const b = await sellerOffer(h, sellerId, p.id, p.variants[1]!, { quantity: 0 });
    const suspensionId = newId();
    h.sellers.get(sellerId)!.status = 'suspended';
    await emit(h, 'sellers.seller.suspended', { sellerId, suspensionId, reasonCode: 'fraud', reason: 'Payment fraud investigation', reviewDate: '2026-12-01', openOrders: 'seller_keeps_fulfilling', appealDeadline: new Date().toISOString() });
    expect(await h.api.getOffer(a.id)).toMatchObject({ status: 'ineligible', statusReason: { code: 'seller_suspended' }, featuredEligibility: { eligible: false } });
    expect(await status(b.id)).toBe('ineligible');
    h.sellers.get(sellerId)!.status = 'approved';
    await emit(h, 'sellers.seller.reinstated', { sellerId, from: 'suspended', to: 'approved', endedSuspensionId: suspensionId, liftedRestrictionId: null, remainingRestrictionIds: [] });
    expect(await status(a.id)).toBe('active');
    expect(await status(b.id)).toBe('out_of_stock');
  });

  it('removes all offers of a closed seller', async () => {
    const p = addProduct(h);
    const sellerId = addSeller(h);
    const a = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    h.sellers.get(sellerId)!.status = 'closed';
    await emit(h, 'sellers.seller.closed', { sellerId, reasonCode: 'requested_by_seller', closedBy: { kind: 'staff', id: newId() } });
    expect(await h.api.getOffer(a.id)).toMatchObject({ status: 'removed', statusReason: { code: 'seller_closed' } });
  });
});

describe('catalog changes', () => {
  it('hides offers with their product and brings them back when it is active again', async () => {
    const p = addProduct(h);
    const sellerId = addSeller(h);
    const a = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const b = await sellerOffer(h, sellerId, p.id, p.variants[1]!);
    await asSeller(h, sellerId, 'POST', `/offers/${b.id}/pause`, {});
    p.product.publication = 'suspended';
    await emit(h, 'catalog.product.publication_changed', { productId: p.id, from: 'active', to: 'suspended', reason: 'Safety recall' });
    expect(await h.api.getOffer(a.id)).toMatchObject({ status: 'ineligible', statusReason: { code: 'product_suspended', text: 'Safety recall' } });
    p.product.publication = 'active';
    await emit(h, 'catalog.product.publication_changed', { productId: p.id, from: 'suspended', to: 'active', reason: 'Recall closed' });
    expect(await status(a.id)).toBe('active');
    expect(await status(b.id)).toBe('paused');
  });

  it('moves offers to the kept product on a merge and pauses unmatched ones', async () => {
    const dup = addProduct(h, { variants: 2 });
    const kept = addProduct(h, { variants: 1 }); // only Black
    const sellerId = addSeller(h);
    const black = await sellerOffer(h, sellerId, dup.id, dup.variants[0]!);
    const silver = await sellerOffer(h, sellerId, dup.id, dup.variants[1]!);
    await emit(h, 'catalog.product.merged', { keptProductId: kept.id, duplicateProductId: dup.id, reason: 'Duplicate listing' });
    expect(await h.api.getOffer(black.id)).toMatchObject({ productId: kept.id, variantId: kept.variants[0], status: 'active' });
    expect(await h.api.getOffer(silver.id)).toMatchObject({ productId: dup.id, status: 'paused', statusReason: { code: 'product_merged' } });
    // the moved offer's stock item follows it, and its title is the kept product's
    expect(h.stockUpdates).toContainEqual({ stockItemId: black.stockItemId, productId: kept.id, variantId: kept.variants[0] });
    expect((await h.api.getOffer(black.id))!.title).toBe('Halden Aurora ANC Headphones – Black');
  });

  it('flags missing items that are no longer in the box', async () => {
    const p = addProduct(h);
    const sellerId = addSeller(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!, { condition: 'used_good', conditionNotes: 'Works', missingItems: ['Carry case'] });
    p.product.product.includedItems = ['Headphones', 'USB-C cable'];
    await emit(h, 'catalog.product.updated', { productId: p.id, version: 2, title: p.product.product.title });
    await emit(h, 'catalog.product.updated', { productId: p.id, version: 2, title: p.product.product.title });
    const detail = (await asSeller(h, sellerId, 'GET', `/offers/${o.id}`)).json();
    expect(detail.statusLog.filter((l: { event: string }) => l.event === 'review_missing_items')).toHaveLength(1);
    expect(detail.offer.includedItems).toEqual(['Headphones', 'USB-C cable']);
    // flagged once for the seller to review; the offer stays on sale; saving missingItems clears it
    expect(detail.offer.missingItemsStale).toBe(true);
    expect(eventsNamed(h, 'offers.offer.missing_items_stale').filter((e) => e.offerId === o.id)).toEqual([expect.objectContaining({ productId: p.id, ownerType: 'seller', sellerId, title: 'Halden Aurora ANC Headphones – Black', staleItems: ['Carry case'], newBoxItems: [] })]);
    expect(detail.offer.status).toBe('active');
    expect(eventsNamed(h, 'offers.offer.missing_items_reviewed').filter((e) => e.offerId === o.id)).toEqual([]);
    const saved = await asSeller(h, sellerId, 'PATCH', `/offers/${o.id}`, { missingItems: [] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await h.api.getOffer(o.id))!.missingItemsStale).toBe(false);
    // the review is done: notifications resolves the review notice (pass 5)
    expect(eventsNamed(h, 'offers.offer.missing_items_reviewed').filter((e) => e.offerId === o.id)).toEqual([
      { offerId: o.id, productId: p.id, ownerType: 'seller', sellerId, missingItems: [], changed: true, reviewedBy: expect.objectContaining({ kind: 'seller' }) },
    ]);
    // saving again without the flag publishes nothing more
    await asSeller(h, sellerId, 'PATCH', `/offers/${o.id}`, { missingItems: [] });
    expect(eventsNamed(h, 'offers.offer.missing_items_reviewed').filter((e) => e.offerId === o.id)).toHaveLength(1);
  });

  it('confirming the same missing-items list after the stale flag clears it and publishes missing_items_reviewed (changed: false)', async () => {
    const p = addProduct(h);
    const sellerId = addSeller(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!, { condition: 'used_good', conditionNotes: 'Works', missingItems: ['Carry case'] });
    // a new box item the offer says nothing about: the list is still right, the seller confirms it
    p.product.product.includedItems = [...p.product.product.includedItems, 'Travel adapter'];
    await emit(h, 'catalog.product.updated', { productId: p.id, version: 3, title: p.product.product.title });
    expect((await h.api.getOffer(o.id))!.missingItemsStale).toBe(true);
    const same = await asSeller(h, sellerId, 'PATCH', `/offers/${o.id}`, { missingItems: ['Carry case'] });
    expect(same.statusCode, same.body).toBe(200);
    expect((await h.api.getOffer(o.id))!.missingItemsStale).toBe(false);
    expect(eventsNamed(h, 'offers.offer.missing_items_reviewed').filter((e) => e.offerId === o.id)).toEqual([expect.objectContaining({ missingItems: ['Carry case'], changed: false })]);
  });
});

describe('trust and campaigns', () => {
  it('removes or holds offers named in a trust enforcement', async () => {
    const p = addProduct(h);
    const sellerId = addSeller(h);
    const a = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const b = await sellerOffer(h, sellerId, p.id, p.variants[1]!);
    await emit(h, 'trust.enforcement.recorded', { enforcementId: newId(), reportId: newId(), action: 'suspend_offer', ownerTeam: 'catalog', targets: [{ type: 'offer', id: a.id, label: 'x' }], reason: 'Counterfeit confirmed', params: {}, appealDeadline: null, alreadyApplied: false });
    await emit(h, 'trust.enforcement.recorded', { enforcementId: newId(), reportId: newId(), action: 'suspend_offer', ownerTeam: 'catalog', targets: [{ type: 'offer', id: b.id, label: 'x' }], reason: 'Under review', params: { mode: 'hold', reviewDate: '2026-12-01' }, appealDeadline: null, alreadyApplied: false });
    expect(await h.api.getOffer(a.id)).toMatchObject({ status: 'removed', statusReason: { code: 'enforcement' } });
    expect(await h.api.getOffer(b.id)).toMatchObject({ status: 'ineligible', statusReason: { code: 'enforcement', reviewDate: '2026-12-01' } });
  });

  it('ignores events about records it does not know', async () => {
    await emit(h, 'inventory.stock.changed', { stockItemId: newId(), offerId: newId(), ownerType: 'seller', sellerId: newId(), productId: newId(), variantId: newId(), available: 0, reserved: 0, previousAvailable: 3, state: 'out_of_stock', archived: false, cause: 'adjustment' });
    await emit(h, 'sellers.restriction.lifted', { sellerId: newId(), restrictionId: newId(), reason: 'x' });
    await emit(h, 'access.approval.decided', { requestId: newId(), ref: 'AP', actionKey: 'offers.prices.change', module: 'offers', target: { type: 'price_change', id: newId() }, outcome: 'approved', approverIds: [], requestedById: newId() });
    await emit(h, 'promotions.campaign.started', { campaignId: newId(), kind: 'markdown', offerIds: [newId()], endsAt: new Date().toISOString() });
    await emit(h, 'promotions.campaign.ended', { campaignId: newId(), reason: 'period_over' });
    expect(true).toBe(true);
  });
});

describe('jobs', () => {
  it('re-evaluates featured eligibility from seller performance', async () => {
    const p = addProduct(h);
    const sellerId = addSeller(h, { onTimePct: 97 });
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!, { shippingProfileId: profile(h, 599, 3, sellerId) });
    expect((await h.api.getOffer(o.id))?.featuredEligibility.eligible).toBe(true);
    h.sellers.get(sellerId)!.onTimePct = 72;
    await h.app.kernel.jobs.runNow('offers.reevaluate-eligibility');
    await h.app.kernel.events.drain();
    expect((await h.api.getOffer(o.id))?.featuredEligibility).toMatchObject({ eligible: false, reasons: [expect.objectContaining({ code: 'on_time_dispatch_below_standard' })] });
    expect(eventsNamed(h, 'offers.offer.eligibility_changed').filter((e) => e.offerId === o.id).at(-1)).toMatchObject({ eligible: false, reasons: ['on_time_dispatch_below_standard'] });
    expect(await h.api.isPromotable(o.id)).toBe(false);
  });
});
