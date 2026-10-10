import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, callers } from '../../../testing/app.js';
import { ADMIN, boot, campaignInput, creative, liveCampaign, SELLER_A, serve, track, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});
beforeEach(() => k.clock.set(new Date()));

const get = async (id: string) => (await k.call('GET', `${ADMIN}/campaigns/${id}`, k.staff)).body;
const official = async (offerId: string, over: Record<string, unknown> = {}) =>
  liveCampaign(k, { advertiser: { kind: 'official_store' }, placementKey: 'sponsored_product', pages: ['search'], creativeIds: [], promoted: [{ kind: 'offer', id: offerId }], dismissal: null, frequencyCap: null, ...over });

describe('placements', () => {
  it('lists placements with their rules and live counts; edits need the version and a reason', async () => {
    const list = await k.call('GET', `${ADMIN}/placements`, k.staff);
    expect(list.status).toBe(200);
    expect(list.body.map((p: any) => p.key)).toEqual(['opening_fullscreen', 'home_banner', 'category_banner', 'campaign_banner', 'popup', 'sponsored_product', 'sponsored_store', 'floating', 'interstitial', 'video']);
    // Placement.version is the optimistic lock PATCH sends back; the seeded placements start at version 1
    const popup = list.body.find((p: any) => p.key === 'popup');
    expect(popup).toMatchObject({ version: 1, kind: 'overlay', availability: 'launch', label: 'Ad', trigger: { afterSeconds: 8 }, dismissal: { mode: 'days', days: 7 }, pagesLabel: expect.stringContaining('Home') });
    let res = await k.call('PATCH', `${ADMIN}/placements/${popup.id}`, k.staff, { eligiblePages: ['home', 'checkout'], reason: 'x', version: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe('PAGE_NOT_ELIGIBLE');
    res = await k.call('PATCH', `${ADMIN}/placements/${popup.id}`, k.staff, { dismissal: { mode: 'not_dismissible', label: '' }, reason: 'x', version: 1 });
    expect(res.status).toBe(400);
    res = await k.call('PATCH', `${ADMIN}/placements/${popup.id}`, k.staff, { frequencyCap: { perSession: 1, perWindow: { count: 2, days: 7 }, label: '' }, reason: 'Fewer pop-ups', version: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ frequencyCap: { label: 'Once per session · max 2 per visitor per 7 days' }, updatedBy: { kind: 'staff' } });
    expect(k.of('advertising.placement.updated')).toContainEqual({ placementKey: 'popup', enabled: true, version: 2 });
    expect(res.body.version).toBe(2);
    res = await k.call('PATCH', `${ADMIN}/placements/${popup.id}`, k.staff, { enabled: false, reason: 'stale', version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    // a stale PATCH changes nothing
    expect((await k.call('GET', `${ADMIN}/placements`, k.staff)).body.find((p: any) => p.key === 'popup')).toMatchObject({ enabled: true, version: 2 });
    // turning a placement off takes effect for new displays at once
    res = await k.call('PATCH', `${ADMIN}/placements/${popup.id}`, k.staff, { enabled: false, reason: 'Pause pop-ups for the holidays', version: 2 });
    expect(res.body.enabled).toBe(false);
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { placementKey: 'popup' }));
    expect(created.body.error.code).toBe('PLACEMENT_DISABLED');
    expect(k.audits.filter((a) => a.action === 'advertising.placement.update')).toHaveLength(2);
    // later-phase placements can be turned on when their phase is on (launch phase 4 here)
    const video = list.body.find((p: any) => p.key === 'video');
    res = await k.call('PATCH', `${ADMIN}/placements/${video.id}`, k.staff, { enabled: true, reason: 'Video pilot', version: 1 });
    expect(res.body.enabled).toBe(true);
  });
});

describe('reactions to other modules', () => {
  it('promotion paused/resumed pauses and resumes linked ads; ended finishes those that stop with it', async () => {
    const promo = k.promotion();
    const a = await liveCampaign(k, { name: 'Linked stop', linkedPromotionId: promo.id, stopWithPromotion: true });
    const b = await liveCampaign(k, { name: 'Linked keep', linkedPromotionId: promo.id, stopWithPromotion: false });
    await k.emit('promotions.campaign.paused', { campaignId: promo.id, reason: 'Budget review' });
    expect((await get(a.id)).status).toBe('paused');
    expect((await get(b.id)).pausedReason).toBe('Linked promotion paused: Budget review');
    await k.emit('promotions.campaign.resumed', { campaignId: promo.id });
    expect((await get(a.id)).status).toBe('live');
    expect((await get(b.id)).status).toBe('live');
    await k.emit('promotions.campaign.ended', { campaignId: promo.id, reason: 'budget_exhausted' });
    await k.emit('promotions.campaign.ended', { campaignId: promo.id, reason: 'budget_exhausted' });
    expect(await get(a.id)).toMatchObject({ status: 'finished', finishedReason: 'promotion_ended' });
    expect((await get(b.id)).status).toBe('live');
    const linked = await k.svc.campaignsForPromotion(promo.id);
    expect(linked.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('offer, stock and product changes pause sponsored ads and resume those paused automatically', async () => {
    const offer = k.offer({ sellerId: null, title: 'Ceramic vase' });
    const c = await official(offer.id, { name: 'Vase ad' });
    const status = { offerId: offer.id, productId: offer.productId, variantId: offer.variantId, sellerId: null, ownerType: 'official', from: 'active', to: 'paused', stockItemId: newId() };
    await k.emit('offers.offer.status_changed', status);
    expect(await get(c.id)).toMatchObject({ status: 'paused', pausedBy: { kind: 'system' } });
    k.offers.get(offer.id)!.status = 'active';
    await k.emit('offers.offer.status_changed', { ...status, from: 'paused', to: 'active' });
    expect((await get(c.id)).status).toBe('live');

    await k.emit('inventory.stock.low', { stockItemId: offer.stockItemId, offerId: offer.id, ownerType: 'official', sellerId: null, productId: offer.productId, variantId: offer.variantId, sku: 'S', label: 'Vase', available: 4, threshold: 5 });
    expect((await get(c.id)).status).toBe('paused');
    k.offers.get(offer.id)!.stock = 30;
    await k.emit('inventory.stock.changed', { stockItemId: offer.stockItemId, offerId: offer.id, ownerType: 'official', sellerId: null, productId: offer.productId, variantId: offer.variantId, archived: false, available: 30, reserved: 0, previousAvailable: 4, state: 'in_stock', cause: 'receipt' });
    expect((await get(c.id)).status).toBe('live');

    await k.emit('catalog.product.publication_changed', { productId: offer.productId, from: 'active', to: 'hidden', reason: 'Listing review' });
    expect((await get(c.id)).status).toBe('paused');
    await k.emit('catalog.product.publication_changed', { productId: offer.productId, from: 'hidden', to: 'active', reason: 'Fixed' });
    expect((await get(c.id)).status).toBe('live');

    // a staff pause is never lifted by these events
    await k.call('POST', `${ADMIN}/campaigns/${c.id}/pause`, k.staff, { reason: 'Manual' });
    await k.emit('inventory.stock.changed', { stockItemId: offer.stockItemId, offerId: offer.id, ownerType: 'official', sellerId: null, productId: offer.productId, variantId: offer.variantId, archived: false, available: 40, reserved: 0, previousAvailable: 30, state: 'in_stock', cause: 'receipt' });
    expect((await get(c.id)).status).toBe('paused');
  });

  it('the availability sweep pauses unavailable offers and resumes them when available again', async () => {
    const offer = k.offer({ sellerId: null, title: 'Glass carafe' });
    const c = await official(offer.id, { name: 'Carafe ad' });
    k.offers.get(offer.id)!.stock = 0;
    await k.job('advertising.availability-sweep');
    expect(await get(c.id)).toMatchObject({ status: 'paused', pausedReason: expect.stringMatching(/Out of stock/) });
    k.offers.get(offer.id)!.stock = 25;
    await k.job('advertising.availability-sweep');
    expect((await get(c.id)).status).toBe('live');
  });

  it('a suspended seller: ads finish (seller_restricted), requests in review are rejected; a restriction pauses', async () => {
    const offer = k.offer({ title: 'Seller vase' });
    const live = await liveCampaign(k, { name: 'Seller banner', advertiser: { kind: 'seller', sellerId: SELLER_A }, goal: 'seller_offer', placementKey: 'sponsored_product', pages: ['search'], creativeIds: [], promoted: [{ kind: 'offer', id: offer.id }], dismissal: null, frequencyCap: null });
    await k.emit('sellers.seller.restricted', { sellerId: SELLER_A, restrictionId: newId(), reasonCode: 'late_dispatch', reason: 'Late dispatch', affectedActivities: ['advertising'], scope: {}, categoryIds: [], appealRoute: 'x', appealDeadline: '2026-12-01T00:00:00Z', reviewDate: '2026-12-01' });
    expect((await get(live.id)).status).toBe('paused');
    const review = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { name: 'In review', advertiser: { kind: 'seller', sellerId: SELLER_A }, goal: 'seller_offer', placementKey: 'sponsored_product', pages: ['search'], creativeIds: [], promoted: [{ kind: 'offer', id: offer.id }], dismissal: null, frequencyCap: null }));
    await k.call('POST', `${ADMIN}/campaigns/${review.body.id}/submit`, k.staff, {});
    await k.emit('sellers.seller.suspended', { sellerId: SELLER_A, suspensionId: newId(), reasonCode: 'fraud', reason: 'Counterfeit goods', reviewDate: '2026-12-01', openOrders: 'seller_keeps_fulfilling', appealDeadline: '2026-12-01T00:00:00Z' });
    expect(await get(live.id)).toMatchObject({ status: 'finished', finishedReason: 'seller_restricted' });
    expect((await get(review.body.id)).status).toBe('rejected');
  });

  it('trust enforcement revokes creatives and rejects requests promoting the offer', async () => {
    const offer = k.offer({ sellerId: null, title: 'Enforced lamp' });
    const c1 = await creative(k, 'sponsored_product', 'any', [600, 600]);
    const c = await official(offer.id, { name: 'Enforced', creativeIds: [c1.id] });
    expect((await get(c.id)).creatives[0].status).toBe('approved');
    const review = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { name: 'Enforced request', advertiser: { kind: 'official_store' }, placementKey: 'sponsored_product', pages: ['search'], creativeIds: [], promoted: [{ kind: 'offer', id: offer.id }], dismissal: null, frequencyCap: null }));
    await k.call('POST', `${ADMIN}/campaigns/${review.body.id}/submit`, k.staff, {});
    const enforcementId = newId();
    await k.emit('trust.enforcement.recorded', { enforcementId, reportId: newId(), action: 'suspend_offer', ownerTeam: 'catalog', targets: [{ type: 'offer', id: offer.id, label: 'Lamp' }], reason: 'Counterfeit', params: {}, alreadyApplied: false });
    const after = await get(c.id);
    expect(after.status).toBe('paused');
    // the enforcement id stays with the reason, so a reversal can find what it did
    expect(after.creatives[0]).toMatchObject({ status: 'rejected', reviews: [expect.objectContaining({ decision: 'rejected', comment: `Trust enforcement: Counterfeit (enforcement ${enforcementId})` })] });
    expect(k.of('advertising.creative.reviewed')).toContainEqual({ creativeId: c1.id, campaignId: c.id, decision: 'rejected', reasonCode: 'policy' });
    expect((await get(review.body.id)).status).toBe('rejected');

    // overturned: the creative goes back to review (never straight to approved), the request reopens as a draft; once per event
    const reversed = { id: newId(), payload: { enforcementId, ref: 'EN-261010-0001', reportId: newId(), reportRef: 'TR-1', action: 'suspend_offer', ownerTeam: 'catalog', targets: [{ type: 'offer', id: offer.id, label: 'Lamp' }], params: {}, appliedRef: null, executionState: 'applied', reason: 'Appeal upheld', appealId: newId(), reversedBy: { kind: 'staff', id: newId() }, reversedAt: k.clock.now().toISOString() } };
    await k.svc.onEnforcementReversedFromTrust(reversed.payload as never, reversed.id);
    await k.svc.onEnforcementReversedFromTrust(reversed.payload as never, reversed.id);
    const back = await get(c.id);
    expect(back.creatives[0].status).toBe('in_review');
    expect(back.status).toBe('paused'); // a running ad is not restarted by the reversal
    const reopened = await get(review.body.id);
    expect(reopened.status).toBe('draft');
    expect(k.of('advertising.campaign.status_changed').filter((e) => e.campaignId === review.body.id && e.from === 'rejected' && e.to === 'draft')).toHaveLength(1);
    // a different enforcement's reversal touches nothing
    await k.emit('trust.enforcement.reversed', { ...reversed.payload, enforcementId: newId() });
    expect((await get(review.body.id)).status).toBe('draft');
  });

  it('a product merge repoints promoted items and creative links to the kept product', async () => {
    const offer = k.offer({ sellerId: null, title: 'Merged lamp' });
    const kept = newId();
    const c1 = await creative(k, 'sponsored_product', 'any', [600, 600], { link: `/product/${offer.productId}` });
    const c = await official(offer.id, { name: 'Merged', creativeIds: [c1.id], destination: { kind: 'product', targetId: offer.productId, url: `/product/${offer.productId}` } });
    await k.emit('catalog.product.merged', { keptProductId: kept, duplicateProductId: offer.productId, reason: 'Duplicate' });
    const after = await get(c.id);
    expect(after.destination).toEqual({ kind: 'product', targetId: kept, url: `/product/${kept}` });
    expect(after.creatives[0].link).toBe(`/product/${kept}`);
    expect(after.timeline.map((t: any) => t.label)).toContain('Promoted product merged');
  });

  it('content publishing re-runs link checks of creatives pointing at the page', async () => {
    const c1 = await creative(k, 'home_banner', 'any', [1200, 300], { link: '/campaigns/fall-home-week' });
    await k.emit('content.page.published', { entity: 'page', entityId: newId(), slug: 'fall-home-week', version: 2, url: '/campaigns/fall-home-week' });
    const res = await k.call('GET', `${ADMIN}/creatives/${c1.id}`, k.staff);
    expect(new Date(res.body.linkCheck.checkedAt).getTime()).toBeGreaterThanOrEqual(new Date(c1.linkCheck.checkedAt).getTime());
    const recheck = await k.call('POST', `${ADMIN}/creatives/${c1.id}/check`, k.staff);
    expect(recheck.body.linkCheck.state).toBe('ok');
  });
});

describe('jobs', () => {
  it('starts scheduled campaigns, finishes at the delivery cap and reminds before the end', async () => {
    const start = new Date(k.clock.now().getTime() + 3_600_000).toISOString();
    const c = await liveCampaign(k, { name: 'Starts later', startsAt: start, endsAt: new Date(k.clock.now().getTime() + 2 * 86_400_000).toISOString(), budget: { billing: 'none', deliveryCap: 1, spent: { amount: 0, currency: 'USD' } } });
    expect(c.status).toBe('scheduled');
    k.clock.advance(2 * 3_600_000);
    await k.job('advertising.start-due');
    expect((await get(c.id)).status).toBe('live');
    const d = await serve(k, { visitorId: `cap-${newId()}` });
    expect(d.overlay?.campaignId).toBe(c.id);
    await track(k, [{ impressionToken: d.overlay.impressionToken, kind: 'display' }]);
    await k.job('advertising.finish-due');
    expect(await get(c.id)).toMatchObject({ status: 'finished', finishedReason: 'delivery_cap_reached' });

    const ownerStaffId = newId();
    const endsAt = new Date(k.clock.now().getTime() + 2 * 86_400_000 - 60_000).toISOString();
    const ending = await liveCampaign(k, { name: 'Ending soon', endsAt, ownerStaffId });
    const later = await liveCampaign(k, { name: 'Ends later', endsAt: new Date(k.clock.now().getTime() + 10 * 86_400_000).toISOString() });
    await k.job('advertising.ending-soon-notice');
    await k.job('advertising.ending-soon-notice');
    expect((await get(ending.id)).timeline.filter((t: any) => t.label === 'Owner reminded: ending soon')).toHaveLength(1);
    // published once, with what notifications needs to tell the owner
    expect(k.of('advertising.campaign.ending_soon').filter((e) => e.campaignId === ending.id)).toEqual([
      { campaignId: ending.id, ref: ending.ref, name: 'Ending soon', advertiserKind: ending.advertiser.kind, sellerId: null, ownerStaffId, endsAt, daysLeft: 2 },
    ]);
    expect(k.of('advertising.campaign.ending_soon').filter((e) => e.campaignId === later.id)).toEqual([]);
    await k.job('advertising.expire-frequency-state');
    await k.job('advertising.link-check');
  });
});

describe('reports, dashboard and GraphQL', () => {
  it('performance by placement with the attribution period, daily performance and the dashboard', async () => {
    const c = await liveCampaign(k, { name: 'Reported' });
    const d = await serve(k, { visitorId: `r-${newId()}` });
    await track(k, [
      { impressionToken: d.overlay.impressionToken, kind: 'display' },
      { impressionToken: d.overlay.impressionToken, kind: 'click' },
    ]);
    await k.job('advertising.stats-rollup');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(k.clock.now());
    const perf = await k.call('GET', `${ADMIN}/reports/performance?from=${today}&to=${today}&source=own`, k.staff);
    expect(perf.status).toBe(200);
    expect(perf.body.byPlacement.find((p: any) => p.placementKey === 'opening_fullscreen').displays).toBeGreaterThanOrEqual(1);
    expect(perf.body).toMatchObject({ timeZone: 'America/Los_Angeles', range: { from: today, to: today }, daily: [expect.objectContaining({ date: today, partial: true })] });
    const shown = d.overlay.campaignId;
    expect(c.id).toBeTruthy();
    const rows = await k.svc.dailyPerformance({ from: today, to: today }, { campaignId: shown });
    expect(rows).toEqual([expect.objectContaining({ campaignId: shown, displays: 1, clicks: 1, partial: true })]);
    const dash = await k.call('GET', `${ADMIN}/dashboard`, k.staff);
    expect(dash.status).toBe(200);
    expect(dash.body.liveNow.total).toBeGreaterThanOrEqual(1);
    expect(dash.body).toMatchObject({ attributionDays: 7, billing: { modelLabel: expect.any(String) }, performance: { attributionNote: expect.any(String) } });
    const summary = await k.svc.dashboardSummary({ listLimit: 2 });
    expect(summary.waitingList.length).toBeLessThanOrEqual(2);

    const gql = await k.app.inject({ method: 'POST', url: '/graphql/admin', headers: auth(k.staff), payload: { query: '{ adDashboard(listLimit: 2) { liveNow { total own paid } waitingApproval attributionDays live { id ref status advertiser { kind name } } } }' } });
    expect(gql.statusCode, gql.body).toBe(200);
    const data = gql.json().data.adDashboard;
    expect(data.liveNow.total).toBeGreaterThanOrEqual(1);
    expect(data.live[0]).toMatchObject({ status: 'LIVE', advertiser: { kind: 'PLATFORM' } });
    const denied = await k.app.inject({ method: 'POST', url: '/graphql/admin', headers: auth(callers.staff(['orders.view'])), payload: { query: '{ adDashboard { waitingApproval } }' } });
    expect(denied.json().errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });
});
