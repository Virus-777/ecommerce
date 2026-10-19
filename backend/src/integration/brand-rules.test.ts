/**
 * Brand selling rules with the real catalog and offers: the brand's policy decides who may sell it, for new offers
 * and for the ones already live, and a submission the seller may not sell is not approved.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDependencies } from '../kernel/module-system/loader.js';
import type { CatalogService } from '../modules/catalog/service.js';
import { buildTestApp, movingClock } from '../testing/app.js';
import { flows, type Flows, type Listing } from '../testing/flows.js';

const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let listing: Listing;
let brandId: string;

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies(['identity', 'access', 'audit', 'media', 'notifications', 'settings', 'customers', 'sellers', 'catalog', 'inventory', 'offers']),
    clock,
    config: { rateLimits: false },
  });
  f = flows(app, clock);
  listing = await f.liveListing({ quantity: 5 });
  brandId = (await (app.kernel.boot.apis.get('catalog') as unknown as CatalogService).getProduct(listing.productId))!.brand!.id;
});
afterAll(async () => {
  await app?.close();
});

const offerStatus = async () => (await f.call('GET', `/api/seller/offers/offers/${listing.offerId}`, { token: listing.sellerToken })).body.offer.status as string;
const setBrand = async (body: Record<string, unknown>) => {
  const res = await f.call('PATCH', `/api/admin/catalog/brands/${brandId}`, { token: listing.catalogManager.accessToken, body: { reason: 'Brand agreement', ...body } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await app.kernel.events.drain();
};

describe('brand selling rules', () => {
  it('stops a live offer when the brand goes authorized_list without the seller, and brings it back when the seller is added', async () => {
    expect(await offerStatus()).toBe('active');
    await setBrand({ sellingPolicy: 'authorized_list', authorizedSellerIds: [] });
    expect(await offerStatus()).toBe('ineligible');
    await setBrand({ authorizedSellerIds: [listing.sellerId] });
    expect(await offerStatus()).toBe('active');
  });

  it('refuses a new offer on a blocked brand', async () => {
    const blocked = await f.call('POST', `/api/admin/catalog/brands/${brandId}/status`, { token: listing.catalogManager.accessToken, body: { status: 'blocked', reason: 'Counterfeit reports' } });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    await app.kernel.events.drain();
    expect(await offerStatus(), 'the live offer stops too').toBe('ineligible');
    const created = await f.call('POST', '/api/seller/offers/offers', {
      token: listing.sellerToken,
      body: { productId: listing.productId, variantId: listing.variantId, condition: 'used_good', conditionNotes: 'Light scuffs on the band', price: { amount: 9900, currency: 'USD' }, sellerSku: `BR-${Date.now()}`, quantity: 1, dispatchBusinessDays: 1, shippingProfileId: await f.shippingProfile(listing.sellerToken), returnTerms: { kind: 'baseline' }, warranty: { kind: 'none' }, publish: true },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(409);
    expect(created.body.error.code).toBe('BRAND_NOT_AUTHORIZED');
  });
});
