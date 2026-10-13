/**
 * Advertising with the real modules it calls, no stubs and no development tokens:
 *
 *   a seller with a live offer (flows.liveListing) and staff with real roles
 *   → the Advertising Manager proposes turning paid seller ads on; the Business Owner approves it in access
 *   → the seller uploads a creative through media and requests a sponsored product campaign for its own offer
 *     (offers, inventory and catalog answer the promotable checks)
 *   → Advertising and a second reviewer approve; it goes live; search-style results get the sponsored card
 *   → a visitor clicks; the charge accrues and is posted to finance as an ad-charge line
 *   → the seller pauses the offer in offers; the ad pauses with it.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import { buildTestApp, movingClock } from '../../../testing/app.js';
import { flows, pngHeader, type Flows, type Listing, type Staff } from '../../../testing/flows.js';

const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let listing: Listing;
let ads: Staff;
let ads2: Staff;
const seen: EventEnvelope[] = [];

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies(['identity', 'access', 'audit', 'media', 'notifications', 'settings', 'customers', 'sellers', 'catalog', 'inventory', 'offers', 'shipping', 'promotions', 'finance', 'advertising']),
    clock,
    config: { rateLimits: false, launchPhase: 4 },
  });
  for (const name of ['advertising.campaign.status_changed', 'advertising.charge.posted', 'access.approval.decided']) app.kernel.events.subscribe('ads-test', name, async (e) => void seen.push(e));
  f = flows(app, clock);
  listing = await f.liveListing({ quantity: 40 });
  ads = await f.staffWithRoles(listing.owner, 'ada@marketly.test', 'Ada Ads', ['advertising_manager']);
  // the Content step is reviewed by a Content Manager (review steps come from access roles, access.rolesOf)
  ads2 = await f.staffWithRoles(listing.owner, 'ben@marketly.test', 'Ben Content', ['content_manager']);
}, 120_000);
afterAll(async () => {
  await app?.close();
});

describe('a sponsored product campaign, end to end', () => {
  let campaignId: string;

  it('turns paid seller ads on with the Business Owner approval', async () => {
    const proposed = await f.call('PUT', '/api/admin/advertising/rules', { token: ads.accessToken, body: { paidSellerAdsEnabled: true, reason: 'Sponsored product pilot' } });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(202);
    const requestId = proposed.body.approval.approvalRequestId;
    expect(requestId).toBeTruthy();
    const approve = await f.call('POST', `/api/admin/access/approval-requests/${requestId}/approve`, { token: listing.owner.accessToken, body: { note: 'Go', reauthToken: await f.reauth(listing.owner, 'approval') } });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    await app.kernel.events.drain();
    const rules = await f.call('GET', '/api/admin/advertising/rules', { token: ads.accessToken });
    expect(rules.body).toMatchObject({ paidSellerAdsEnabled: true, version: 2 });
  });

  it('the seller requests a campaign for its own offer, with a creative uploaded through media', async () => {
    const assetId = await f.upload('seller', listing.sellerToken, { purpose: 'ad_creative', fileName: 'card.png', contentType: 'image/png', body: pngHeader(600, 600) });
    const creative = await f.call('POST', '/api/seller/advertising/creatives', { token: listing.sellerToken, body: { kind: 'image', device: 'any', placementKey: 'sponsored_product', mediaId: assetId, headline: 'Aurora ANC headphones' } });
    expect(creative.status, JSON.stringify(creative.body)).toBe(201);
    expect(creative.body).toMatchObject({ status: 'draft', advertiser: { kind: 'seller', sellerId: listing.sellerId }, width: 600, media: { id: assetId } });

    const offers = await f.call('GET', '/api/seller/advertising/promotable-offers', { token: listing.sellerToken });
    expect(offers.status, JSON.stringify(offers.body)).toBe(200);
    expect(offers.body.items).toEqual([expect.objectContaining({ offerId: listing.offerId, productId: listing.productId, title: 'Aurora wireless headphones', eligible: true })]);

    const now = clock.now().getTime();
    const created = await f.call('POST', '/api/seller/advertising/campaigns', {
      token: listing.sellerToken,
      body: { name: 'Aurora search boost', type: 'sponsored_product', offerIds: [listing.offerId], pages: ['search', 'category'], startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 14 * 86_400_000).toISOString(), dailyLimit: { amount: 500, currency: 'USD' }, totalLimit: { amount: 5000, currency: 'USD' }, billing: 'cpc', creativeIds: [creative.body.id] },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    campaignId = created.body.campaign.id;
    expect(created.body).toMatchObject({ promotes: 'Aurora wireless headphones', campaign: { advertiser: { name: 'Northwind Audio', paid: true } } });
    const submitted = await f.call('POST', `/api/seller/advertising/campaigns/${campaignId}/submit`, { token: listing.sellerToken });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.campaign.status).toBe('in_review');
  });

  it('Advertising and a second reviewer approve it; it goes live and fills sponsored results', async () => {
    let res = await f.call('POST', `/api/admin/advertising/campaigns/${campaignId}/approve`, { token: ads.accessToken, body: { role: 'advertising', note: 'Limits fine' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // an Advertising Manager cannot take the Content step by naming it
    res = await f.call('POST', `/api/admin/advertising/campaigns/${campaignId}/approve`, { token: ads.accessToken, body: { role: 'content' } });
    expect(res.status).toBe(403);
    res = await f.call('POST', `/api/admin/advertising/campaigns/${campaignId}/approve`, { token: ads2.accessToken, body: { role: 'content', note: 'Claims match the product page' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('live');
    expect(seen.filter((e) => e.name === 'advertising.campaign.status_changed' && (e.payload as any).campaignId === campaignId).map((e) => (e.payload as any).to)).toEqual(['in_review', 'approved', 'scheduled', 'live']);

    const api = app.kernel.boot.apis.get('advertising') as any;
    const slots = await api.sponsoredForResults({ page: 'search', query: 'aurora headphones', visitorId: 'v1', sessionId: 's1', device: 'web', organicOfferIds: [] });
    expect(slots).toEqual([expect.objectContaining({ position: 3, impression: expect.objectContaining({ campaignId, label: 'Sponsored', sellerName: 'Northwind Audio', promotedOffer: expect.objectContaining({ offerId: listing.offerId, price: { amount: 18900, currency: 'USD' } }) }) })]);

    // a visitor clicks the card: $0.35 is charged within the limits
    const visitor = await f.visitor('store');
    const click = await f.call('POST', '/api/store/advertising/events', { token: visitor, body: { events: [{ impressionToken: slots[0].impression.impressionToken, kind: 'click', at: clock.now().toISOString() }] } });
    expect(click.status, JSON.stringify(click.body)).toBe(202);
    const view = await f.call('GET', `/api/seller/advertising/campaigns/${campaignId}`, { token: listing.sellerToken });
    expect(view.body.spend).toEqual({ amount: 35, currency: 'USD' });
  });

  it('posts the day’s charge to finance as an ad-charge line, separate from commission', async () => {
    await app.kernel.jobs.runNow('advertising.accrue-charges');
    // the next market day (jobs only; sessions stay valid once the clock is back)
    clock.advance(86_400_000);
    await app.kernel.jobs.runNow('advertising.post-charges');
    await app.kernel.events.drain();
    clock.advance(-86_400_000);
    const charges = await f.call('GET', '/api/seller/advertising/charges', { token: listing.sellerToken });
    expect(charges.status, JSON.stringify(charges.body)).toBe(200);
    expect(charges.body.items).toEqual([expect.objectContaining({ campaignId, basis: 'clicks', units: 1, amount: { amount: 35, currency: 'USD' }, state: 'posted' })]);
    expect(seen.some((e) => e.name === 'advertising.charge.posted' && (e.payload as any).campaignId === campaignId)).toBe(true);
    const finance = app.kernel.boot.apis.get('finance') as any;
    const account = await finance.getSellerAccount(listing.sellerId);
    // the seller's balance carries the ad charge (no sales yet): its own line, not commission
    expect(account.balances.available).toEqual({ amount: -35, currency: 'USD' });
  });

  it('pausing the offer in offers pauses the ad', async () => {
    const paused = await f.call('POST', `/api/seller/offers/offers/${listing.offerId}/pause`, { token: listing.sellerToken, body: { reason: 'Restocking' } });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    await app.kernel.events.drain();
    const view = await f.call('GET', `/api/seller/advertising/campaigns/${campaignId}`, { token: listing.sellerToken });
    expect(view.body.campaign.status).toBe('paused');
    expect(view.body.campaign.allowedActions).toEqual([]);
  });
});
