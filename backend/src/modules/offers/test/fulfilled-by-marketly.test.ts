/**
 * Fulfilled by Marketly (fulfillment-service, phase 4), batch C:
 * - C1: fulfillment-service.offer.service_changed sets fulfilled_by, bumps termsVersion, holds the offer Ineligible
 *   while the enrollment is suspended or offboarding (never seller-shipped) and restores it after;
 * - C2: Offer.shipping, the delivery estimate ('Ships from Marketly'), OfferView.fulfilledBy, the order snapshot and
 *   SellerOfferDetail.fulfillmentNote follow fulfillment-service.getServiceTerms; the service off or answering null makes
 *   a service offer not sellable;
 * - migration 0004 backfills fulfilled_by on existing offers.
 * fulfillment-service is being rebuilt in parallel: its getServiceTerms is stubbed (h.serviceTerms below).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type * as fulfillment from '../../../spec/fulfillment-service.js';
import { m0004FulfilledBy } from '../infra/postgres/migrations/0004_fulfilled_by.js';
import type { OffersService } from '../service.js';
import { addProduct, addSeller, asSeller, asStaff, asVisitor, emit, eventsNamed, harness, profile, sellerOffer, sku, warehouse, type Harness } from './helpers.js';

const MARKETLY = 'Reno, NV (Marketly warehouse)';

function terms(offerId: string, sellerId: string, stockItemId: string, profileId: string, over: Partial<fulfillment.ServiceTerms> = {}): fulfillment.ServiceTerms {
  return {
    offerId,
    sellerId,
    skuEnrollmentId: newId(),
    stockItemId,
    sellable: true,
    notSellableReason: null,
    locationId: newId(),
    shipsFrom: MARKETLY,
    dispatch: { businessDays: 0, sameDayCutoff: '14:00' },
    shippingProfileId: profileId,
    parcel: { weightGrams: 800, dimensionsCm: { length: 30, width: 20, height: 10 } },
    ...over,
  };
}

const changed = (t: fulfillment.ServiceTerms, over: Record<string, unknown> = {}) => ({
  offerId: t.offerId,
  sellerId: t.sellerId,
  skuEnrollmentId: t.skuEnrollmentId,
  stockItemId: t.stockItemId,
  fulfilledBy: 'marketly_service',
  sellable: true,
  reason: 'sku_activated',
  at: new Date().toISOString(),
  ...over,
});

describe('Fulfilled by Marketly (service on)', () => {
  let h: Harness;
  let svc: OffersService;
  const serviceTerms = new Map<string, fulfillment.ServiceTerms | null>();
  let marketlyProfile: string;

  beforeAll(async () => {
    h = await harness({ serviceTerms });
    svc = h.app.kernel.boot.apis.get('offers') as OffersService;
    await warehouse(h);
    marketlyProfile = profile(h, 0, 2, null); // the Official Store profile Marketly ships service packages with
  });
  afterAll(async () => {
    await h?.app.close();
  });

  async function serviceOffer() {
    const sellerId = addSeller(h, { name: 'Northwind Audio' });
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!, { dispatchBusinessDays: 3 });
    const t = terms(o.id, sellerId, o.stockItemId, marketlyProfile);
    return { sellerId, product: p, offer: o, terms: t };
  }

  it('new offers ship from their owner: seller and official_warehouse, Offer.shipping = their own terms', async () => {
    const { offer, sellerId } = await serviceOffer();
    const o = (await h.api.getOffer(offer.id))!;
    expect(o).toMatchObject({ fulfilledBy: 'seller', shipping: { fulfilledBy: 'seller', profileId: o.shippingProfileId, dispatch: { businessDays: 3 } } });
    expect((await h.api.quoteOffer(offer.id, 1)).fulfilledBy).toBe('seller');
    expect((await h.api.quoteOffer(offer.id, 1)).delivery.fulfilledByLabel ?? null).toBeNull();
    expect((await asSeller(h, sellerId, 'GET', `/offers/${offer.id}`)).json().fulfillmentNote ?? null).toBeNull();

    const p = addProduct(h);
    const res = await asStaff(h, 'POST', '/official/offers', { productId: p.id, variantId: p.variants[0], condition: 'new', price: { amount: 19900, currency: 'USD' }, sku: sku('OFF'), dispatchBusinessDays: 1, shippingProfileId: profile(h, 0, 2, null), returnTerms: { kind: 'baseline' }, warranty: { kind: 'none' }, quantity: 5, publish: true });
    expect(res.statusCode, res.body).toBe(201);
    expect((await h.api.getOffer(res.json().offer.id))!).toMatchObject({ fulfilledBy: 'official_warehouse', shipping: { fulfilledBy: 'official_warehouse' } });
  });

  it('service_changed (activated): fulfilled_by marketly_service, termsVersion bumped once, Marketly terms everywhere customers look', async () => {
    const { offer, sellerId, terms: t } = await serviceOffer();
    serviceTerms.set(offer.id, t);
    const before = (await h.api.getOffer(offer.id))!;
    h.events.length = 0;

    const eventId = newId();
    await svc.onServiceChangedFromFulfillmentService(changed(t) as never, { id: eventId, actor: { kind: 'system', id: null } });
    await svc.onServiceChangedFromFulfillmentService(changed(t) as never, { id: eventId, actor: { kind: 'system', id: null } }); // redelivery
    await h.app.kernel.events.drain();

    const o = (await h.api.getOffer(offer.id))!;
    expect(o.termsVersion).toBe(before.termsVersion + 1);
    expect(o).toMatchObject({
      fulfilledBy: 'marketly_service',
      status: 'active',
      // the seller's saved terms are kept
      dispatch: { businessDays: 3 },
      shippingProfileId: before.shippingProfileId,
      shipping: { fulfilledBy: 'marketly_service', profileId: marketlyProfile, dispatch: { businessDays: 0, sameDayCutoff: '14:00', shipsFrom: MARKETLY, label: 'Ships today' } },
    });
    expect(eventsNamed(h, 'offers.offer.updated')).toEqual([{ offerId: offer.id, productId: o.productId, termsVersion: o.termsVersion, fields: ['fulfilledBy'] }]);

    // the product page: Marketly's free 2-day delivery from the Marketly warehouse, the seller still named
    const view = await h.api.quoteOffer(offer.id, 1);
    expect(view).toMatchObject({ fulfilledBy: 'marketly_service', status: 'active', seller: { name: 'Northwind Audio' }, delivery: { shipsFrom: MARKETLY, fulfilledByLabel: 'Ships from Marketly', free: true, shippingCost: { amount: 0 } } });
    expect(view.delivery.arrivesTo).toBe(new Date(h.clock.now().getTime() + 2 * 86_400_000).toISOString().slice(0, 10));
    expect((await asVisitor(h, `/offers/${offer.id}`)).json()).toMatchObject({ fulfilledBy: 'marketly_service', delivery: { fulfilledByLabel: 'Ships from Marketly' } });

    // the order item freezes Marketly's dispatch
    expect(await h.api.snapshotForOrder(offer.id)).toMatchObject({ fulfilledBy: 'marketly_service', dispatch: { businessDays: 0, shipsFrom: MARKETLY, label: 'Ships today' }, termsVersion: o.termsVersion });

    // carts holding the old termsVersion are told the terms changed
    const rv = await h.api.revalidate([{ offerId: offer.id, quantity: 1, termsVersion: before.termsVersion, price: before.price }], '97205');
    expect(rv.changes).toEqual([expect.objectContaining({ kind: 'terms' })]);

    // the seller sees the note; dispatch edits are saved without a customer-visible change
    const detail = (await asSeller(h, sellerId, 'GET', `/offers/${offer.id}`)).json();
    expect(detail.fulfillmentNote).toMatch(/^Fulfilled by Marketly: customers see Marketly's delivery terms/);
    h.events.length = 0;
    const res = await asSeller(h, sellerId, 'PATCH', `/offers/${offer.id}`, { dispatchBusinessDays: 2 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().offer).toMatchObject({ dispatch: { businessDays: 2 }, termsVersion: o.termsVersion, shipping: { dispatch: { businessDays: 0 } } });
    expect(eventsNamed(h, 'offers.offer.updated')).toEqual([]);
  });

  it('suspension makes the offer Ineligible (never seller-shipped); reinstatement restores it', async () => {
    const { offer, sellerId, terms: t } = await serviceOffer();
    serviceTerms.set(offer.id, t);
    await emit(h, 'fulfillment-service.offer.service_changed', changed(t));
    const active = (await h.api.getOffer(offer.id))!;

    serviceTerms.set(offer.id, { ...t, sellable: false, notSellableReason: 'enrollment_suspended' });
    await emit(h, 'fulfillment-service.offer.service_changed', changed(t, { sellable: false, reason: 'enrollment_suspended' }));
    const held = (await h.api.getOffer(offer.id))!;
    expect(held).toMatchObject({ status: 'ineligible', fulfilledBy: 'marketly_service', termsVersion: active.termsVersion, statusReason: { code: 'fulfillment_service_suspended' }, featuredEligibility: { eligible: false } });
    expect((await svc.core.repo.get('offers', offer.id))!.ineligible_source).toEqual({ kind: 'fulfillment_service', id: t.skuEnrollmentId });
    expect(await h.api.quoteOffer(offer.id, 1)).toMatchObject({ status: 'ineligible', featuredEligible: false });
    await expect(h.api.snapshotForOrder(offer.id)).rejects.toMatchObject({ code: 'OFFER_UNAVAILABLE' });
    expect(await h.api.isPromotable(offer.id)).toBe(false);
    expect(await h.api.getFeaturedOffer(held.variantId)).toBeNull();
    const seller = (await asSeller(h, sellerId, 'GET', `/offers/${offer.id}`)).json();
    expect(seller.offer.statusReason).toMatchObject({ code: 'fulfillment_service_suspended', text: expect.stringMatching(/suspended/) });

    serviceTerms.set(offer.id, t);
    await emit(h, 'fulfillment-service.offer.service_changed', changed(t, { reason: 'enrollment_reinstated' }));
    expect((await h.api.getOffer(offer.id))!).toMatchObject({ status: 'active', statusReason: null, termsVersion: active.termsVersion, shipping: { fulfilledBy: 'marketly_service' } });
    expect((await h.api.snapshotForOrder(offer.id)).fulfilledBy).toBe('marketly_service');
  });

  it('a hold under another cause switches to the service hold when that cause is lifted', async () => {
    const { offer, terms: t, product } = await serviceOffer();
    serviceTerms.set(offer.id, t);
    await emit(h, 'fulfillment-service.offer.service_changed', changed(t));
    // the product is hidden, then the enrollment is suspended: the offer keeps its product hold
    product.product.publication = 'hidden';
    await emit(h, 'catalog.product.publication_changed', { productId: product.id, from: 'active', to: 'hidden', reason: 'Listing review' });
    serviceTerms.set(offer.id, { ...t, sellable: false, notSellableReason: 'enrollment_offboarding' });
    await emit(h, 'fulfillment-service.offer.service_changed', changed(t, { sellable: false, reason: 'enrollment_offboarding' }));
    expect((await svc.core.repo.get('offers', offer.id))!.ineligible_source).toMatchObject({ kind: 'product' });
    // the product is active again: the service still stops the offer
    product.product.publication = 'active';
    await emit(h, 'catalog.product.publication_changed', { productId: product.id, from: 'hidden', to: 'active', reason: 'Fixed' });
    const r = (await svc.core.repo.get('offers', offer.id))!;
    expect(r).toMatchObject({ status: 'ineligible', ineligible_source: { kind: 'fulfillment_service', id: t.skuEnrollmentId }, status_reason: expect.objectContaining({ code: 'fulfillment_service_suspended' }) });
  });

  it('leaving the service (sku_deactivated): back to seller shipping, termsVersion bumped, a service hold lifted', async () => {
    const { offer, terms: t } = await serviceOffer();
    serviceTerms.set(offer.id, { ...t, sellable: false, notSellableReason: 'enrollment_suspended' });
    await emit(h, 'fulfillment-service.offer.service_changed', changed(t, { sellable: false, reason: 'enrollment_suspended' }));
    const held = (await h.api.getOffer(offer.id))!;
    expect(held.status).toBe('ineligible');

    serviceTerms.set(offer.id, null);
    await emit(h, 'fulfillment-service.offer.service_changed', changed(t, { fulfilledBy: 'seller', reason: 'sku_deactivated' }));
    const o = (await h.api.getOffer(offer.id))!;
    expect(o).toMatchObject({ status: 'active', fulfilledBy: 'seller', termsVersion: held.termsVersion + 1, shipping: { fulfilledBy: 'seller', profileId: o.shippingProfileId, dispatch: { businessDays: 3 } } });
    expect((await h.api.quoteOffer(offer.id, 1)).delivery.fulfilledByLabel ?? null).toBeNull();
  });

  it('the service answering null for a marketly_service offer: not sellable, shown Ineligible', async () => {
    const { offer, terms: t } = await serviceOffer();
    serviceTerms.set(offer.id, t);
    await emit(h, 'fulfillment-service.offer.service_changed', changed(t));
    serviceTerms.delete(offer.id);
    const o = (await h.api.getOffer(offer.id))!;
    expect(o).toMatchObject({ status: 'ineligible', fulfilledBy: 'marketly_service', statusReason: { code: 'fulfillment_service_suspended' } });
    expect((await h.api.listActiveOffersByIds([offer.id])).length).toBe(0);
    await expect(h.api.snapshotForOrder(offer.id)).rejects.toMatchObject({ code: 'OFFER_UNAVAILABLE' });
    const rv = await h.api.revalidate([{ offerId: offer.id, quantity: 1, termsVersion: o.termsVersion, price: o.price }], '97205');
    expect(rv.changes).toEqual([expect.objectContaining({ kind: 'availability', current: { quantity: 0 } })]);
  });

  it('ignores events for unknown offers or another seller', async () => {
    const { offer, terms: t } = await serviceOffer();
    await emit(h, 'fulfillment-service.offer.service_changed', changed({ ...t, offerId: newId() }));
    await emit(h, 'fulfillment-service.offer.service_changed', changed({ ...t, sellerId: newId() }));
    expect((await h.api.getOffer(offer.id))!.fulfilledBy).toBe('seller');
  });
});

describe('Fulfilled by Marketly (service off)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    await warehouse(h);
  });
  afterAll(async () => {
    await h?.app.close();
  });

  it('a marketly_service offer is not sellable while the fulfillment service is off (never seller-shipped)', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    await emit(h, 'fulfillment-service.offer.service_changed', changed(terms(o.id, sellerId, o.stockItemId, newId())));
    const offer = (await h.api.getOffer(o.id))!;
    expect(offer).toMatchObject({ fulfilledBy: 'marketly_service', status: 'ineligible', statusReason: { code: 'fulfillment_service_suspended' } });
    expect(await h.api.quoteOffer(o.id, 1)).toMatchObject({ status: 'ineligible', featuredEligible: false, delivery: { fulfilledByLabel: 'Ships from Marketly', shippingCost: null } });
    await expect(h.api.snapshotForOrder(o.id)).rejects.toMatchObject({ code: 'OFFER_UNAVAILABLE' });
    // the stored status is untouched: turning the service on is enough to sell again
    const svc = h.app.kernel.boot.apis.get('offers') as OffersService;
    expect((await svc.core.repo.get('offers', o.id))!.status).toBe('active');
  });

  it('migration 0004 backfills fulfilled_by from the owner on existing offers', async () => {
    const svc = h.app.kernel.boot.apis.get('offers') as OffersService;
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const seller = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const q = addProduct(h);
    const res = await asStaff(h, 'POST', '/official/offers', { productId: q.id, variantId: q.variants[0], condition: 'new', price: { amount: 19900, currency: 'USD' }, sku: sku('MIG4'), dispatchBusinessDays: 1, shippingProfileId: profile(h, 0, 2, null), returnTerms: { kind: 'baseline' }, warranty: { kind: 'none' }, publish: true });
    expect(res.statusCode, res.body).toBe(201);
    const official = res.json().offer.id as string;

    // the state before 0004
    await h.app.kernel.database.exec(`alter table offers.offers drop constraint offers_fulfilled_by_check; alter table offers.offers drop column fulfilled_by`);
    await h.app.kernel.database.exec(m0004FulfilledBy.sql);

    expect((await svc.core.repo.get('offers', seller.id))!.fulfilled_by).toBe('seller');
    expect((await svc.core.repo.get('offers', official))!.fulfilled_by).toBe('official_warehouse');
    // and the column is required and checked from now on
    await expect(svc.core.repo.update('offers', seller.id, { fulfilled_by: 'somebody' as never })).rejects.toThrow();
  });
});
