/**
 * Slot settings (2026-10-23): slot names and page options, carousel speed and live-ad limit (an ad waits as scheduled
 * in a full carousel), single-ad slots taking turns in position order, and live counts that match the Advertisements
 * page.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { ADMIN, boot, campaignInput, creative, serve, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});

const staffWith = (roles: string[]) => {
  const id = newId();
  k.roles.set(id, roles);
  return callers.staff(undefined, { sub: id } as never);
};
const days = (n: number) => new Date(k.clock.now().getTime() + n * 86_400_000).toISOString();
const SIZES: Record<string, [number, number]> = { deals_top: [750, 150], popup: [600, 600], category_banner: [750, 300], home_banner: [750, 400] };
const placement = async (key: string) => (await k.call('GET', `${ADMIN}/placements`, k.staff)).body.find((p: any) => p.key === key);

/** A staff ad sent for review and approved by two other people */
async function approved(placementKey: string, over: Record<string, unknown> = {}) {
  const [w, h] = SIZES[placementKey]!;
  const created = await k.call('POST', `${ADMIN}/ads`, k.staff, { name: `${placementKey} ad`, placementKey, imageId: k.asset(w, h).id, alt: 'Banner', destination: { kind: 'url', url: 'https://example.com/fall' }, endsAt: days(10), ...over });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  await k.call('POST', `${ADMIN}/ads/${created.body.id}/submit`, k.staff);
  for (const step of ['advertising', 'content']) await k.call('POST', `${ADMIN}/ads/${created.body.id}/review`, staffWith([`${step}_manager`]), { decision: 'approve' });
  return (await k.call('GET', `${ADMIN}/ads/${created.body.id}`, k.staff)).body;
}

describe('slots', () => {
  it('are named like the Advertisements tabs, with the pages each can show on', async () => {
    const list = (await k.call('GET', `${ADMIN}/placements`, k.staff)).body;
    const by = (key: string) => list.find((p: any) => p.key === key);
    expect(by('opening_fullscreen')).toMatchObject({ name: 'Full-screen ad', inUse: true, pageOptions: ['home', 'category', 'deals'], eligiblePages: ['home', 'category', 'deals'], rotation: { label: 'Ads take turns in the order on Advertisements' } });
    expect(by('popup')).toMatchObject({ name: 'Pop-up', pageOptions: ['home', 'category', 'search', 'collection', 'deals'], eligiblePages: ['home', 'category', 'search', 'collection', 'deals'] });
    expect(by('category_banner')).toMatchObject({ name: 'Category banner', pageOptions: ['category'], rotation: { label: 'Ads for that category first, then the rest take turns in order' } });
    expect(by('software_top')).toMatchObject({ name: 'Softwares carousel', maxPerPage: 10, pageOptions: ['software'] });
    expect(by('deals_top')).toMatchObject({ name: 'Deals carousel', inUse: true });
    expect(by('sponsored_product')).toMatchObject({ name: 'Sponsored product', inUse: false });
    expect(list.filter((p: any) => !p.inUse).map((p: any) => p.key).sort()).toEqual(['campaign_banner', 'floating', 'interstitial', 'sponsored_product', 'sponsored_store', 'video']);
  });

  it('refuses pages outside the options and settings outside the limits', async () => {
    const popup = await placement('popup');
    const product = await k.call('PATCH', `${ADMIN}/placements/${popup.id}`, k.staff, { eligiblePages: ['home', 'product'], reason: 'x', version: popup.version });
    expect(product.status).toBe(422);
    expect(product.body.error).toMatchObject({ code: 'PAGE_NOT_ELIGIBLE', details: { pageOptions: ['home', 'category', 'search', 'collection', 'deals'] } });
    const often = await k.call('PATCH', `${ADMIN}/placements/${popup.id}`, k.staff, { frequencyCap: { perSession: 21 }, reason: 'x', version: popup.version });
    expect(often.body.error.details.issues[0].path).toBe('frequencyCap.perSession');
    const cat = await placement('category_banner');
    expect((await k.call('PATCH', `${ADMIN}/placements/${cat.id}`, k.staff, { maxPerPage: 6, reason: 'x', version: cat.version })).status).toBe(400);
    const home = await placement('home_banner');
    const fast = await k.call('PATCH', `${ADMIN}/placements/${home.id}`, k.staff, { rotation: { mode: 'carousel', carouselSeconds: 1, pauseOnHoverAndFocus: true }, reason: 'x', version: home.version });
    expect(fast.body.error.details.issues[0].path).toBe('rotation.carouselSeconds');
    const many = await k.call('PATCH', `${ADMIN}/placements/${home.id}`, k.staff, { maxPerPage: 21, reason: 'x', version: home.version });
    expect(many.body.error.details.issues[0].message).toBe('Live ads at most: 1 to 20');
    const ok = await k.call('PATCH', `${ADMIN}/placements/${home.id}`, k.staff, { rotation: { mode: 'carousel', carouselSeconds: 8, pauseOnHoverAndFocus: true }, maxPerPage: 12, reason: 'Slower', version: home.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ maxPerPage: 12, rotation: { carouselSeconds: 8, label: 'Each ad shows 8 s, in the order on Advertisements' } });
  });
});

describe('carousels', () => {
  it('a full carousel makes the next ad wait as scheduled; it starts when one ends', async () => {
    const deals = await placement('deals_top');
    const capped = await k.call('PATCH', `${ADMIN}/placements/${deals.id}`, k.staff, { maxPerPage: 1, rotation: { mode: 'carousel', carouselSeconds: 4, pauseOnHoverAndFocus: true }, reason: 'One at a time', version: deals.version });
    expect(capped.status, JSON.stringify(capped.body)).toBe(200);
    const first = await approved('deals_top', { name: 'First' });
    expect(first.status).toBe('live');
    const second = await approved('deals_top', { name: 'Second' });
    expect(second).toMatchObject({ status: 'scheduled', statusNote: 'Deals carousel is full (1 live) — it starts when one ends' });
    await k.job('advertising.start-due');
    expect((await k.call('GET', `${ADMIN}/ads/${second.id}`, k.staff)).body.status).toBe('scheduled');
    const page = (await k.call('GET', `${ADMIN}/ads?placement=deals_top`, k.staff)).body;
    expect(page.slots.deals_top).toMatchObject({ name: 'Deals carousel', live: 1, maxLive: 1, carouselSeconds: 4, rotationLabel: 'Each ad shows 4 s, in the order on Advertisements' });
    expect(page.slots.popup).toMatchObject({ maxLive: null, carouselSeconds: null });
    const d = await serve(k, { page: 'deals', slots: ['deals_top'], device: 'phone' });
    expect(d.rotationBySlot).toEqual({ deals_top: 4 });
    await k.call('POST', `${ADMIN}/ads/${first.id}/end`, k.staff, {});
    await k.job('advertising.start-due');
    expect((await k.call('GET', `${ADMIN}/ads/${second.id}`, k.staff)).body.status).toBe('live');
  });

  it('the Live count of a slot is the placement live count, brand ads made by staff included', async () => {
    const c1 = await creative(k, 'home_banner', 'any', [1200, 300]);
    const brand = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { name: 'Brand banner', advertiser: { kind: 'brand', brandId: newId() }, placementKey: 'home_banner', pages: ['home'], creativeIds: [c1.id], afterApproval: 'activate' }));
    expect(brand.status, JSON.stringify(brand.body)).toBe(201);
    await k.call('POST', `${ADMIN}/campaigns/${brand.body.id}/submit`, k.staff, {});
    await k.call('POST', `${ADMIN}/campaigns/${brand.body.id}/approve`, callers.staff(), { role: 'advertising' });
    await k.call('POST', `${ADMIN}/campaigns/${brand.body.id}/approve`, callers.staff(), { role: 'content' });
    await approved('home_banner');
    const page = (await k.call('GET', `${ADMIN}/ads?placement=home_banner`, k.staff)).body;
    expect(page.items.map((a: any) => a.id)).toContain(brand.body.id);
    expect(page.slots.home_banner.live).toBe((await placement('home_banner')).liveCampaigns);
    expect(page.statusCounts.live).toBe(page.slots.home_banner.live);
  });
});

describe('single-ad slots', () => {
  it('pop-up ads take turns in position order', async () => {
    const a = await approved('popup', { name: 'Pop A' });
    const b = await approved('popup', { name: 'Pop B' });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) seen.push((await serve(k, { visitorId: `v-${newId()}`, sessionId: `s-${newId()}`, entry: false, page: 'search', device: 'phone' })).overlay?.campaignId);
    const ours = seen.filter((id) => id === a.id || id === b.id);
    expect(new Set(ours)).toEqual(new Set([a.id, b.id]));
    for (let i = 1; i < ours.length; i++) expect(ours[i]).not.toBe(ours[i - 1]);
  });

  it('the category banner shows the ad for the page category first', async () => {
    const cat = newId();
    await approved('category_banner', { name: 'Any category' });
    const matched = await approved('category_banner', { name: 'This category', categoryId: cat });
    for (let i = 0; i < 3; i++) {
      const d = await serve(k, { visitorId: `v-${newId()}`, page: 'category', slots: ['category_banner'], context: { categoryId: cat }, device: 'phone' });
      expect(d.slots.category_banner[0].campaignId).toBe(matched.id);
    }
  });
});
