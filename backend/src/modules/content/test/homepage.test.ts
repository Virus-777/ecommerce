import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaPublicApi } from '../../../spec/media.js';
import { auth, callers, DAY, harness, inMs, MIN, newId, uploadImage, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const home = async () => (await h.store('GET', '/home')).json();
const admin = async () => (await h.admin('GET', '/homepage')).json();

describe('homepage layout', () => {
  it('starts with the locked ad positions from advertising as the first live layout', async () => {
    const a = await admin();
    expect(a.liveVersion).toBe(1);
    expect(a.hasDraft).toBe(false);
    const ads = a.sections.filter((s: any) => s.kind === 'ad_position');
    expect(ads.map((s: any) => s.adPlacementKey)).toEqual(['opening_fullscreen', 'home_banner']);
    expect(ads[0]).toMatchObject({ locked: true, managedIn: 'Managed in Advertisements', config: null });
    const page = await home();
    expect(page.sections.map((s: any) => s.adPlacementKey)).toEqual(['opening_fullscreen', 'home_banner']);
    expect(page.sections[0].products).toEqual([]);
  });

  it('refuses edits to ad positions (SECTION_LOCKED)', async () => {
    const ad = (await admin()).sections[0];
    const res = await h.admin('PATCH', `/homepage/sections/${ad.id}`, { kind: 'featured_products', productSource: { mode: 'manual', productIds: [newId()] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SECTION_LOCKED');
    const rm = await h.admin('POST', `/homepage/sections/${ad.id}/remove`, { kind: 'removal', reason: 'x', immediately: true });
    expect(rm.json().error.code).toBe('SECTION_LOCKED');
  });

  it('adds sections to the draft; customers see them only after Publish', async () => {
    const available = h.card({ title: 'Brass desk lamp' });
    const soldOut = h.card({ title: 'Sold out lamp', availability: 'out_of_stock' });
    const missing = newId();
    h.cards.set(available.productId, available);
    h.cards.set(soldOut.productId, soldOut);
    const res = await h.admin('POST', '/homepage/sections', { kind: 'featured_products', heading: 'Picked for your desk', productSource: { mode: 'manual', productIds: [available.productId, soldOut.productId, missing] }, position: 2 });
    expect(res.statusCode).toBe(201);
    const section = res.json();
    expect(section).toMatchObject({ position: 2, status: 'draft', title: 'Picked for your desk', productCount: 1, unavailableHidden: 2, locked: false });
    expect(section.description).toBe('1 product · manual selection');
    expect(h.audits.some((a) => a.action === 'content.homepage.section.add' && a.target.id === section.id)).toBe(true);

    const a = await admin();
    expect(a.hasDraft).toBe(true);
    expect(a.draftVersion).toBe(2);
    expect(a.sections.map((s: any) => s.kind)).toEqual(['ad_position', 'featured_products', 'ad_position']);
    expect((await home()).sections.some((s: any) => s.id === section.id)).toBe(false);

    // the drawer lists hidden products only on request, with the reason
    const rows = (await h.admin('GET', `/homepage/sections/${section.id}/products?includeHidden=true`)).json();
    expect(rows.items.map((r: any) => [r.title, r.available, r.hiddenReason ?? null])).toEqual([
      ['Brass desk lamp', true, null],
      ['Sold out lamp', false, 'out_of_stock'],
      ['Product no longer available', false, 'product_hidden'],
    ]);
    expect((await h.admin('GET', `/homepage/sections/${section.id}/products`)).json().items).toHaveLength(1);

    // the preview shows the draft as customers will see it
    const preview = (await h.admin('POST', '/homepage/preview', { device: 'phone', useDraft: true })).json();
    const previewed = preview.sections.find((s: any) => s.id === section.id);
    expect(previewed.products.map((p: any) => p.title)).toEqual(['Brass desk lamp']);

    const pub = await h.admin('POST', '/homepage/publish', { summary: 'Desk picks' });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ liveVersion: 2, hasDraft: false, draftVersion: null });
    expect(h.eventsNamed('content.page.published').at(-1)).toMatchObject({ entity: 'homepage', version: 2, url: '/' });
    const live = await home();
    expect(live.version).toBe(2);
    const shown = live.sections.find((s: any) => s.id === section.id);
    expect(shown.products.map((p: any) => p.title)).toEqual(['Brass desk lamp']);
    expect(shown.products[0]).toMatchObject({ price: { amount: 2999, currency: 'USD' }, officialStore: true, availability: 'in_stock' });
  });

  it('publishing without changes is a conflict', async () => {
    const res = await h.admin('POST', '/homepage/publish', { summary: 'again' });
    expect(res.statusCode).toBe(409);
  });

  it('validates sections (promise strip needs 2–4 items, banners need their banner, links must be safe)', async () => {
    let res = await h.admin('POST', '/homepage/sections', { kind: 'promise_strip', promiseItems: [{ icon: 'truck', title: 'Fast', body: 'x' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.issues[0].path).toBe('promiseItems');
    res = await h.admin('POST', '/homepage/sections', { kind: 'campaign_banner', heading: 'No banner' });
    expect(res.json().error.details.issues[0].path).toBe('banner');
    res = await h.admin('POST', '/homepage/sections', {
      kind: 'campaign_banner',
      banner: { headline: 'Home Week', images: [], primaryCta: { label: 'Shop', url: 'javascript:alert(1)' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.issues[0].path).toBe('banner.primaryCta.url');
    res = await h.admin('POST', '/homepage/sections', { kind: 'featured_products', productSource: { mode: 'manual', productIds: [newId()] }, showFrom: inMs(h, DAY), removeAt: inMs(h, MIN) });
    expect(res.json().error.details.issues[0].path).toBe('removeAt');
  });

  it('reorders the draft (ad positions move with the layout) and refuses a stale order', async () => {
    const a = await admin();
    const ids = a.sections.map((s: any) => s.id);
    const reversed = [...ids].reverse();
    const res = await h.admin('PUT', '/homepage/order', { sectionIds: reversed });
    expect(res.statusCode).toBe(200);
    expect(res.json().sections.map((s: any) => s.id)).toEqual(reversed);
    expect(res.json().hasDraft).toBe(true);
    const stale = await h.admin('PUT', '/homepage/order', { sectionIds: ids.slice(1) });
    expect(stale.statusCode).toBe(409);
    // discarding puts the live order back
    const discarded = (await h.admin('POST', '/homepage/discard-draft')).json();
    expect(discarded.hasDraft).toBe(false);
    expect(discarded.sections.map((s: any) => s.id)).toEqual(ids);
  });

  it('attaches banner images as content usages and shows them with fresh media refs', async () => {
    const img = await uploadImage(h);
    const res = await h.admin('POST', '/homepage/sections', {
      kind: 'campaign_banner',
      banner: { headline: 'Home Week', body: '<p>Up to <strong>30%</strong> off<script>alert(1)</script></p>', images: [img], primaryCta: { label: 'Shop Home Week', url: '/pages/home-week' }, theme: 'brand' },
      position: 1,
    });
    expect(res.statusCode).toBe(201);
    const media = h.app.kernel.boot.apis.get('media') as MediaPublicApi;
    expect((await media.getAsset(img.id))!.usageCount).toBe(1);
    expect(res.json().config.banner.body).toBe('<p>Up to <strong>30%</strong> off</p>');
    // an unknown file is a form problem
    const bad = await h.admin('POST', '/homepage/sections', { kind: 'campaign_banner', banner: { headline: 'x', images: [{ id: newId(), url: 'https://cdn.example.com/x.png' }], primaryCta: { label: 'Go', url: '/deals' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.issues[0].path).toBe('banner.images[0]');

    await h.admin('POST', '/homepage/publish', { summary: 'Home Week banner' });
    const banner = (await home()).sections.find((s: any) => s.kind === 'campaign_banner');
    expect(banner.banner.images[0].id).toBe(img.id);
    expect(banner.banner.images[0].url).not.toBe(img.url);
  });

  it('keeps a version history and restores an earlier layout as a new version', async () => {
    const versions = (await h.admin('GET', '/homepage/versions')).json().items;
    expect(versions[0]).toMatchObject({ entity: 'homepage', state: 'live', summary: 'Home Week banner' });
    expect(versions.some((v: any) => v.state === 'discarded')).toBe(true);
    const before = versions[0].number;
    const res = await h.admin('POST', '/homepage/versions/2/restore', { reason: 'Banner went out too early', publish: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().liveVersion).toBe(before + 1);
    expect((await home()).sections.some((s: any) => s.kind === 'campaign_banner')).toBe(false);
    const after = (await h.admin('GET', '/homepage/versions')).json().items;
    expect(after[0]).toMatchObject({ restoredFrom: 2, state: 'live' });
    expect((await h.admin('POST', '/homepage/versions/999/restore', { reason: 'x', publish: false })).statusCode).toBe(404);
  });
});

describe('section schedules', () => {
  it('a scheduled section appears at showFrom and goes at removeAt without a new publish', async () => {
    const lamp = h.card({ title: 'Scheduled lamp' });
    h.cards.set(lamp.productId, lamp);
    const s = (await h.admin('POST', '/homepage/sections', { kind: 'featured_products', heading: 'Weekend', productSource: { mode: 'manual', productIds: [lamp.productId] } })).json();
    const sched = await h.admin('POST', `/homepage/sections/${s.id}/schedule`, { showFrom: inMs(h, 10 * MIN), removeAt: inMs(h, 30 * MIN), timeZone: 'America/Los_Angeles' });
    expect(sched.statusCode).toBe(200);
    expect(sched.json().status).toBe('scheduled');
    expect(sched.json().schedule.label).toMatch(/–/);
    await h.admin('POST', '/homepage/publish', { summary: 'Weekend picks' });
    expect((await home()).sections.some((x: any) => x.id === s.id)).toBe(false);
    // the preview at a later time includes it
    const at = inMs(h, 15 * MIN);
    expect((await h.admin('POST', '/homepage/preview', { device: 'desktop', useDraft: false, at })).json().sections.some((x: any) => x.id === s.id)).toBe(true);

    const published = h.eventsNamed('content.page.published').length;
    h.clock.advance(11 * MIN);
    await h.app.kernel.jobs.runNow('content.run-schedules');
    await h.app.kernel.events.drain();
    expect((await home()).sections.find((x: any) => x.id === s.id)?.endsAt).toBeTruthy();
    expect(h.eventsNamed('content.page.published').length).toBe(published + 1);
    expect((await admin()).sections.find((x: any) => x.id === s.id).status).toBe('published');
    // idempotent
    await h.app.kernel.jobs.runNow('content.run-schedules');
    expect(h.eventsNamed('content.page.published').length).toBe(published + 1);

    h.clock.advance(20 * MIN);
    await h.app.kernel.jobs.runNow('content.run-schedules');
    expect((await home()).sections.some((x: any) => x.id === s.id)).toBe(false);
    expect((await admin()).sections.find((x: any) => x.id === s.id).status).toBe('unpublished');
    const versions = (await h.admin('GET', '/homepage/versions')).json().items;
    expect(versions[0].summary).toMatch(/reached its removal time/);
    expect(versions[1].summary).toMatch(/appeared/);
  });

  it('scheduling a live section is an illegal transition', async () => {
    const live = (await admin()).sections.find((s: any) => s.status === 'published' && !s.locked);
    const res = await h.admin('POST', `/homepage/sections/${live.id}/schedule`, { showFrom: inMs(h, MIN), timeZone: 'America/Los_Angeles' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('removes a live section now (correction) with a reason and a new live version', async () => {
    const live = (await admin()).sections.find((s: any) => s.status === 'published' && !s.locked);
    expect((await h.admin('POST', `/homepage/sections/${live.id}/remove`, { kind: 'correction', reason: '', immediately: true })).statusCode).toBe(400);
    const res = await h.admin('POST', `/homepage/sections/${live.id}/remove`, { kind: 'correction', reason: 'Wrong price shown', immediately: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('removed');
    expect(h.eventsNamed('content.page.removed').at(-1)).toMatchObject({ entity: 'homepage_section', entityId: live.id, kind: 'correction', reason: 'Wrong price shown' });
    expect((await home()).sections.some((s: any) => s.id === live.id)).toBe(false);
    const again = await h.admin('POST', `/homepage/sections/${live.id}/remove`, { kind: 'correction', reason: 'again', immediately: true });
    expect(again.json().error.code).toBe('ILLEGAL_TRANSITION');
    await h.admin('POST', '/homepage/publish', { summary: 'Clean up' });
  });

  it('hides a live section now; showing it again waits for Publish', async () => {
    const lamp = h.card({ title: 'Paper floor lamp' });
    h.cards.set(lamp.productId, lamp);
    const live = (await h.admin('POST', '/homepage/sections', { kind: 'featured_products', heading: 'Lamps', productSource: { mode: 'manual', productIds: [lamp.productId] } })).json();
    await h.admin('POST', '/homepage/publish', { summary: 'Lamps' });
    expect((await home()).sections.some((s: any) => s.id === live.id)).toBe(true);
    const before = await admin();
    const hid = await h.admin('POST', `/homepage/sections/${live.id}/visibility`, { hidden: true });
    expect(hid.statusCode).toBe(200);
    expect(hid.json()).toMatchObject({ hidden: true, hiddenLive: true, status: 'published' });
    expect((await admin()).liveVersion).toBeGreaterThan(before.liveVersion);
    expect((await home()).sections.some((s: any) => s.id === live.id)).toBe(false);
    const shown = (await h.admin('POST', `/homepage/sections/${live.id}/visibility`, { hidden: false })).json();
    expect(shown).toMatchObject({ hidden: false, hiddenLive: true });
    expect((await admin()).hasDraft).toBe(true);
    expect((await home()).sections.some((s: any) => s.id === live.id)).toBe(false);
    await h.admin('POST', '/homepage/publish', { summary: 'Shown again' });
    expect((await home()).sections.some((s: any) => s.id === live.id)).toBe(true);
  });
});

describe('store homepage resolution', () => {
  it('resolves category, seller, rule and deals sections through their modules', async () => {
    // shoppers only see a category with stock or marked coming soon
    const cat = (await h.call('POST', '/api/admin/catalog/categories', { name: `Lighting ${newId().slice(0, 4)}`, comingSoon: true })).json();
    const sellerOk = newId();
    const sellerSuspended = newId();
    h.sellers.set(sellerOk, { name: 'Casa Verde Home', status: 'approved' });
    h.sellers.set(sellerSuspended, { name: 'Gone Store', status: 'suspended' });
    h.ruleCards = [h.card({ title: 'Best 1' }), h.card({ title: 'Best 2' })];
    const add = (body: unknown) => h.admin('POST', '/homepage/sections', body);
    const cats = (await add({ kind: 'category_shortcuts', categoryIds: [cat.id, newId()] })).json();
    const sellers = (await add({ kind: 'featured_sellers', sellerIds: [sellerOk, sellerSuspended] })).json();
    const popular = (await add({ kind: 'popular_products' })).json();
    const deals = (await add({ kind: 'deals', heading: 'Flash deals' })).json();
    const promise = (await add({ kind: 'promise_strip', promiseItems: [{ icon: 'calendar-check', title: 'Delivery date first', body: 'See arrival dates before you pay.' }, { icon: 'rotate', title: '30-day returns', body: 'On most items.' }] })).json();
    expect((await h.admin('POST', '/homepage/publish', { summary: 'More sections' })).statusCode).toBe(200);
    const page = await home();
    const by = (id: string) => page.sections.find((s: any) => s.id === id);
    expect(by(cats.id).categories).toEqual([{ categoryId: cat.id, slug: cat.slug, name: cat.name, image: null }]);
    expect(by(sellers.id).sellers.map((s: any) => s.name)).toEqual(['Casa Verde Home']);
    // links: storefront slug on seller tiles (G18), product slug on product tiles (G19)
    expect(by(sellers.id).sellers[0].sellerSlug).toBe(`store-${sellerOk.slice(0, 4)}`);
    expect(by(popular.id).products.map((p: any) => p.slug)).toEqual([h.ruleCards[0]!.slug, h.ruleCards[1]!.slug]);
    expect(by(popular.id).products.map((p: any) => [p.title, p.rank])).toEqual([
      ['Best 1', 1],
      ['Best 2', 2],
    ]);
    expect(h.searchQueries.at(-1)).toMatchObject({ sort: 'best_selling', availability: 'in_stock' });
    expect(by(deals.id).link).toEqual({ label: 'See all deals', url: '/deals', kind: 'deals' });
    expect(by(deals.id).deals[0].name).toBe('Flash Friday');
    expect(by(promise.id).promiseItems).toHaveLength(2);
    expect(page.sections.map((s: any) => s.kind)).toContain('ad_position');
    expect(page.sections.find((s: any) => s.kind === 'ad_position').products).toEqual([]);
  });

  it('hides sections whose linked promotion ended (event) and drops a suspended seller from Featured sellers', async () => {
    const campaignId = newId();
    h.campaigns.set(campaignId, { name: 'Home Week', startsAt: inMs(h, -DAY), endsAt: inMs(h, DAY), active: true, status: 'active' });
    const lamp = h.card();
    h.cards.set(lamp.productId, lamp);
    const s = (await h.admin('POST', '/homepage/sections', { kind: 'featured_products', heading: 'Home Week picks', linkedPromotionId: campaignId, productSource: { mode: 'manual', productIds: [lamp.productId] } })).json();
    expect(s.schedule.label).toBe('Follows campaign');
    await h.admin('POST', '/homepage/publish', { summary: 'Home Week' });
    expect((await home()).sections.some((x: any) => x.id === s.id)).toBe(true);
    h.app.kernel.events.publish('promotions', 'promotions.campaign.ended', { campaignId, reason: 'ended_early' });
    await h.app.kernel.events.drain();
    expect((await home()).sections.some((x: any) => x.id === s.id)).toBe(false);
    // twice is the same
    h.app.kernel.events.publish('promotions', 'promotions.campaign.ended', { campaignId, reason: 'ended_early' });
    await h.app.kernel.events.drain();

    const sellerId = [...h.sellers.entries()].find(([, v]) => v.status === 'approved')![0];
    h.app.kernel.events.publish('sellers', 'sellers.seller.suspended', { sellerId, suspensionId: newId(), reasonCode: 'fraud', reason: 'x', reviewDate: inMs(h, DAY).slice(0, 10), openOrders: 'seller_keeps_fulfilling', appealDeadline: inMs(h, DAY) });
    await h.app.kernel.events.drain();
    const featured = (await admin()).sections.find((x: any) => x.kind === 'featured_sellers');
    expect(featured.config.sellerIds).not.toContain(sellerId);
  });

  it('replaces a merged duplicate product in manual selections', async () => {
    const kept = h.card({ title: 'Kept lamp' });
    const dup = newId();
    h.cards.set(kept.productId, kept);
    const s = (await h.admin('POST', '/homepage/sections', { kind: 'featured_products', productSource: { mode: 'manual', productIds: [dup] } })).json();
    h.app.kernel.events.publish('catalog', 'catalog.product.merged', { keptProductId: kept.productId, duplicateProductId: dup, reason: 'duplicate' });
    await h.app.kernel.events.drain();
    const after = (await admin()).sections.find((x: any) => x.id === s.id);
    expect(after.config.productSource.productIds).toEqual([kept.productId]);
    expect(after.productCount).toBe(1);
  });

  it('serves the homepage over GraphQL with nested sections', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/graphql/store', headers: auth(callers.visitor()), payload: { query: '{ homePage { version sections { id position kind heading adPlacementKey promiseItems { title } link { url kind } } } }' } });
    const body = res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.homePage.sections[0]).toMatchObject({ position: 1 });
    expect(body.data.homePage.sections.some((s: any) => s.kind === 'AD_POSITION')).toBe(true);
  });
});
