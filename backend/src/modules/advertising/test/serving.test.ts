import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { ADMIN, boot, creative, liveCampaign, serve, STORE, track, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});
beforeEach(() => k.clock.set(new Date()));

/** Finish every running campaign so each test starts from an empty site */
async function clearSite() {
  const list = await k.call('GET', `${ADMIN}/campaigns?status=live,scheduled,paused&limit=100`, k.staff);
  for (const c of list.body.items) await k.call('POST', `${ADMIN}/campaigns/${c.id}/finish`, k.staff, { reason: 'test reset' });
}

let n = 0;
const visitor = () => `visitor-${++n}-${newId()}`;

describe('scenario 8: opening advertisement', () => {
  beforeEach(clearSite);

  it('an eligible visitor sees it on the entry page, closes it, and it respects the cap, pause and expiry', async () => {
    const c = await liveCampaign(k, { endsAt: new Date(k.clock.now().getTime() + 3 * 3_600_000).toISOString() });
    const v = visitor();

    // entry page: the opening ad, labelled, with a visible close control and a way back to the page
    let d = await serve(k, { visitorId: v, sessionId: 's1' });
    expect(d.overlay).toMatchObject({ campaignId: c.id, placementKey: 'opening_fullscreen', label: 'Ad', dismissible: true, closeLabel: 'Close', secondaryText: 'Continue to home page', headline: 'Fall Home Week: up to 30% off' });
    expect(d.overlay.footnote).toMatch(/Shown once per visit/);
    expect(d.ttlSeconds).toBe(60);
    // the phone gets the phone creative
    const phone = await serve(k, { visitorId: v, sessionId: 's1', device: 'phone' });
    expect(phone.overlay.creativeId).not.toBe(d.overlay.creativeId);
    // not on later pages of the visit
    expect((await serve(k, { visitorId: v, sessionId: 's1', entry: false })).overlay).toBeNull();

    // displayed, then closed: the visitor continues; once per session
    let t = await track(k, [
      { impressionToken: d.overlay.impressionToken, kind: 'display' },
      { impressionToken: d.overlay.impressionToken, kind: 'close' },
    ]);
    expect(t.status).toBe(202);
    expect(t.body).toEqual({ accepted: 2, ignored: 0 });
    expect((await serve(k, { visitorId: v, sessionId: 's1' })).overlay).toBeNull();
    // duplicates of the same token and kind are ignored
    t = await track(k, [{ impressionToken: d.overlay.impressionToken, kind: 'display' }]);
    expect(t.body).toEqual({ accepted: 0, ignored: 1 });

    // a new visit shows it again (session dismissal), up to 3 per visitor per 7 days
    for (const s of ['s2', 's3']) {
      d = await serve(k, { visitorId: v, sessionId: s });
      expect(d.overlay?.campaignId, s).toBe(c.id);
      await track(k, [{ impressionToken: d.overlay.impressionToken, kind: 'display' }]);
    }
    expect((await serve(k, { visitorId: v, sessionId: 's4' })).overlay).toBeNull();

    // staff pause takes it off the site at once (clients may reuse a decision for ttlSeconds)
    const other = visitor();
    expect((await serve(k, { visitorId: other })).overlay?.campaignId).toBe(c.id);
    await k.call('POST', `${ADMIN}/campaigns/${c.id}/pause`, k.staff, { reason: 'Check the price' });
    expect((await serve(k, { visitorId: other, sessionId: 'x2' })).overlay).toBeNull();
    await k.call('POST', `${ADMIN}/campaigns/${c.id}/resume`, k.staff, {});
    expect((await serve(k, { visitorId: other, sessionId: 'x3' })).overlay?.campaignId).toBe(c.id);

    // expiry: past endsAt it no longer shows and the finish job closes it
    k.clock.advance(4 * 3_600_000);
    expect((await serve(k, { visitorId: visitor() })).overlay).toBeNull();
    await k.job('advertising.finish-due');
    const after = await k.call('GET', `${ADMIN}/campaigns/${c.id}`, k.staff);
    expect(after.body).toMatchObject({ status: 'finished', finishedReason: 'ended' });
    k.clock.advance(-4 * 3_600_000);
  });

  it('never covers checkout, payment results, tracking or returns', async () => {
    await liveCampaign(k);
    for (const page of ['checkout', 'payment_result', 'order_tracking', 'returns']) {
      const d = await serve(k, { page, visitorId: visitor() });
      expect(d).toMatchObject({ overlay: null, slots: {}, sponsoredProducts: [] });
      expect(await k.svc.isAdBlockedPage({ page: page as never })).toBe(true);
    }
    expect(await k.svc.isAdBlockedPage({ page: 'home' })).toBe(false);
  });

  it('one overlay per page view: the higher priority shows; a pop-up is skipped when an overlay already showed', async () => {
    const low = await liveCampaign(k, { name: 'Low', priority: 1 });
    const high = await liveCampaign(k, { name: 'High', priority: 3 });
    for (let i = 0; i < 3; i++) expect((await serve(k, { visitorId: visitor() })).overlay.campaignId).toBe(high.id);
    expect(low.id).not.toBe(high.id);
    const popupCreative = await creative(k, 'popup', 'any', [600, 600], { headline: 'Take 20% off with HOME20' });
    const promo = k.promotion();
    const popup = await liveCampaign(k, { name: 'Popup', placementKey: 'popup', pages: ['home', 'category'], creativeIds: [popupCreative.id], linkedPromotionId: promo.id, frequencyCap: null });
    // not the entry page: the opening ad doesn't apply, the pop-up does (with its trigger and coupon code)
    let d = await serve(k, { visitorId: visitor(), entry: false });
    expect(d.overlay).toMatchObject({ campaignId: popup.id, code: 'HOME20', secondaryText: 'No thanks', eyebrow: 'Fall Home Week' });
    expect(d.popupTrigger).toMatchObject({ afterSeconds: 8, skipIfOverlayShownThisSession: true });
    d = await serve(k, { visitorId: visitor(), entry: false, overlayShown: true });
    expect(d.overlay).toBeNull();
  });

  it('a pop-up dismissal hides that campaign for 7 days', async () => {
    const pc = await creative(k, 'popup', 'any', [600, 600]);
    const popup = await liveCampaign(k, { name: 'Popup 2', placementKey: 'popup', pages: ['home'], creativeIds: [pc.id], frequencyCap: null });
    const v = visitor();
    const d = await serve(k, { visitorId: v, entry: false });
    expect(d.overlay.campaignId).toBe(popup.id);
    await track(k, [{ impressionToken: d.overlay.impressionToken, kind: 'dismiss' }]);
    expect((await serve(k, { visitorId: v, sessionId: 'another', entry: false })).overlay).toBeNull();
    k.clock.advance(2 * 86_400_000);
    expect((await serve(k, { visitorId: v, sessionId: 'later', entry: false })).overlay).toBeNull();
    expect((await serve(k, { visitorId: visitor(), sessionId: 'later', entry: false })).overlay?.campaignId).toBe(popup.id);
    k.clock.advance(-2 * 86_400_000);
  });

  it('banners rotate evenly at equal priority, in the carousel order', async () => {
    const mk = async (name: string) => {
      const c1 = await creative(k, 'home_banner', 'any', [1200, 300]);
      return liveCampaign(k, { name, placementKey: 'home_banner', creativeIds: [c1.id], dismissal: null, frequencyCap: null });
    };
    const a = await mk('Banner A');
    const b = await mk('Banner B');
    const firsts = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const d = await serve(k, { visitorId: visitor(), slots: ['home_banner'] });
      expect(d.overlay).toBeNull();
      expect(d.slots.home_banner).toHaveLength(2);
      expect(d.rotationSeconds).toBe(6);
      firsts.add(d.slots.home_banner[0].campaignId);
    }
    expect(firsts).toEqual(new Set([a.id, b.id]));
  });

  it('audience: only data the privacy choices allow; signed-in and region targeting', async () => {
    const c1 = await creative(k, 'home_banner', 'any', [1200, 300]);
    const c = await liveCampaign(k, { name: 'Signed-in CA', placementKey: 'home_banner', creativeIds: [c1.id], audience: { mode: 'selected', regions: ['CA'], visitors: 'all', signIn: 'signed_in', categoryIds: [] } });
    const shown = (d: any) => (d.slots.home_banner ?? []).some((x: any) => x.campaignId === c.id);
    const customer = callers.customer();
    expect(shown(await serve(k, { token: customer, region: 'CA', slots: ['home_banner'] }))).toBe(true);
    expect(shown(await serve(k, { token: customer, region: 'WA', slots: ['home_banner'] }))).toBe(false);
    expect(shown(await serve(k, { region: 'CA', slots: ['home_banner'] }))).toBe(false);
    expect(shown(await serve(k, { token: customer, region: 'CA', personalization: false, slots: ['home_banner'] }))).toBe(false);
  });
});

describe('tracking', () => {
  it('refuses tampered tokens (INVALID_IMPRESSION_TOKEN) and ignores expired ones', async () => {
    let res = await track(k, [{ impressionToken: 'not-a-token', kind: 'display' }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IMPRESSION_TOKEN');
    const c = await liveCampaign(k, { name: 'Tracked' });
    const d = await serve(k, { visitorId: visitor() });
    const [body, mac] = d.overlay.impressionToken.split('.');
    res = await track(k, [{ impressionToken: `${body}.${mac.slice(0, -2)}AA`, kind: 'click' }]);
    expect(res.status).toBe(400);
    k.clock.advance(2 * 86_400_000);
    res = await track(k, [{ impressionToken: d.overlay.impressionToken, kind: 'click' }]);
    expect(res.body).toEqual({ accepted: 0, ignored: 1 });
    k.clock.advance(-2 * 86_400_000);
    res = await track(k, [{ impressionToken: d.overlay.impressionToken, kind: 'click' }]);
    expect(res.body).toEqual({ accepted: 1, ignored: 0 });
    await k.job('advertising.stats-rollup');
    const view = await k.call('GET', `${ADMIN}/campaigns/${c.id}`, k.staff);
    expect(view.body.metrics).toMatchObject({ clicks: 1 });
  });
});

describe('positions for content and sponsored products for search', () => {
  it('adPositionsFor lists the layout positions of a page, the opening ad first', async () => {
    expect(await k.svc.adPositionsFor({ page: 'home' })).toEqual([
      { placementKey: 'opening_fullscreen', name: 'Opening full-screen ad', enabled: true },
      { placementKey: 'home_banner', name: 'Sponsored brand banner', enabled: true },
      { placementKey: 'sponsored_store', name: 'Sponsored store or brand', enabled: false },
    ]);
    expect(await k.svc.adPositionsFor({ page: 'checkout' })).toEqual([]);
  });

  it('sponsoredForResults returns labelled, relevant, in-stock promoted offers at the placement positions', async () => {
    await clearSite();
    const lamp = k.offer({ title: 'Brass desk lamp', stock: 40, sellerId: null });
    const low = k.offer({ title: 'Brass floor lamp', stock: 3, sellerId: null });
    const other = k.offer({ title: 'Cotton towels', stock: 40, sellerId: null });
    const c = await liveCampaign(k, {
      name: 'Official lamps',
      advertiser: { kind: 'official_store' },
      placementKey: 'sponsored_product',
      pages: ['search', 'category'],
      creativeIds: [],
      promoted: [
        { kind: 'offer', id: lamp.id },
        { kind: 'offer', id: other.id },
      ],
      dismissal: null,
      frequencyCap: null,
    });
    const slots = await k.svc.sponsoredForResults({ page: { page: 'search' }, query: 'brass lamp', visitorId: 'v1', sessionId: 's1', device: 'web', organicOfferIds: [] });
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ position: 3, impression: { campaignId: c.id, label: 'Sponsored', promotedOffer: { offerId: lamp.id, title: 'Brass desk lamp', price: { amount: 4900 }, wasPrice: { amount: 5900 }, sellerName: 'Marketly Official Store' } } });
    expect(low.stock).toBe(3);
    // nothing on blocked pages
    expect(await k.svc.sponsoredForResults({ page: { page: 'checkout' }, visitorId: 'v1', sessionId: 's1', device: 'web', organicOfferIds: [] })).toEqual([]);
    // the serve decision fills sponsored products too
    const d = await serve(k, { page: 'search', slots: ['sponsored_product'], context: { query: 'towels' } });
    expect(d.sponsoredProducts.map((s: any) => s.impression.promotedOffer.offerId)).toEqual([other.id]);
  });

  it('clicks start the attribution period: an order within it counts, a cancellation reduces it', async () => {
    const c = await liveCampaign(k, { name: 'Attribution' });
    const customerAccount = newId();
    const customerId = newId();
    const token = callers.customer({ accountId: customerAccount });
    // the store resolves the customer id from the account; with the customers module off, scope.customerId is null,
    // so the click is recorded straight through the service with the customer on the token claims
    const d = await k.svc.serving.serve({ page: 'home', context: {}, device: 'desktop', visitorId: 'v-attr', sessionId: 's-attr', isEntryPage: true, slots: [], personalizationAllowed: true }, { scope: { kind: 'customer', accountId: customerAccount, customerId }, principal: { kind: 'customer', audience: 'store', accountId: customerAccount, sessionId: 's' } });
    expect(d.overlay?.campaignId).toBe(c.id);
    expect((await track(k, [{ impressionToken: d.overlay!.impressionToken, kind: 'click' }], token)).status).toBe(202);
    const orderId = newId();
    const order = { orderId, ref: 'MK-1', checkoutSessionId: newId(), customerId, paymentIntentId: newId(), paymentState: 'accepted', total: { amount: 12000, currency: 'USD' }, couponCodes: [], groups: [], placedAt: k.clock.now().toISOString() };
    await k.emit('orders.order.placed', order);
    await k.emit('orders.order.placed', order);
    const cancellation = { orderId, ref: 'MK-1', groupId: newId(), ownerType: 'official', sellerId: null, itemId: newId(), offerId: newId(), stockItemId: newId(), quantity: 1, cancellationId: newId(), initiatedBy: 'customer', reasonCode: 'changed_mind', beforeDispatch: true, countsAgainstSeller: false, refund: { itemAmount: { amount: 2000, currency: 'USD' }, discountShare: { amount: 0, currency: 'USD' }, shippingRefund: { amount: 0, currency: 'USD' }, taxRefund: { amount: 0, currency: 'USD' }, total: { amount: 2000, currency: 'USD' } }, paymentIntentId: newId() };
    await k.emit('orders.item.cancelled', cancellation);
    await k.emit('orders.item.cancelled', cancellation);
    await k.job('advertising.stats-rollup');
    const view = await k.call('GET', `${ADMIN}/campaigns/${c.id}`, k.staff);
    expect(view.body.metrics).toMatchObject({ clicks: 1, attributedOrders: 1, attributedSales: { amount: 10000 }, attributionDays: 7 });
    const report = await k.call('GET', `${ADMIN}/campaigns/${c.id}/report`, k.staff);
    expect(report.body.attributionNote).toMatch(/within 7 days of a click/);
    expect(report.body.daily.at(-1)).toMatchObject({ clicks: 1, partial: true });
  });

  it('serves from cache quickly: unknown pages and slots are an empty decision', async () => {
    const res = await k.call('POST', `${STORE}/decisions`, callers.visitor(), { page: 'nowhere', context: {}, device: 'app', visitorId: 'x', sessionId: 'y', isEntryPage: true, slots: ['floating'], personalizationAllowed: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ overlay: null, slots: {}, sponsoredProducts: [], ttlSeconds: 60 });
  });
});
