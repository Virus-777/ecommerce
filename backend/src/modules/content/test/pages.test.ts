import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaPublicApi } from '../../../spec/media.js';
import { DAY, harness, inMs, MIN, newId, uploadImage, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const pageInput = (over: Record<string, unknown> = {}) => ({
  kind: 'campaign',
  title: 'Home Week',
  eyebrow: 'Oct 6 – Oct 19',
  intro: '<p>Fresh looks for every room <img src=x onerror=alert(1)></p>',
  blocks: [{ id: 'intro', type: 'text', body: '<h2>Rooms</h2><p onclick="steal()">Pick a room</p><a href="javascript:alert(1)">bad</a><a href="/c/lighting">Lighting</a>', products: [] }],
  ...over,
});

describe('pages and collections', () => {
  it('creates a draft with a slug, sanitized text and version 1', async () => {
    const res = await h.admin('POST', '/pages', pageInput());
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.summary).toMatchObject({ slug: 'home-week', url: '/pages/home-week', status: 'draft', draftVersion: 1, liveVersion: null });
    expect(p.summary.allowedActions).toEqual(expect.arrayContaining(['publish', 'schedule', 'submit', 'edit']));
    expect(p.draft.intro).toBe('<p>Fresh looks for every room </p>');
    expect(p.draft.blocks[0].body).toBe('<h2>Rooms</h2><p>Pick a room</p><a>bad</a><a href="/c/lighting">Lighting</a>');
    expect(h.audits.some((a) => a.action === 'content.page.create' && a.target.id === p.summary.id)).toBe(true);

    const dup = await h.admin('POST', '/pages', pageInput());
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('SLUG_TAKEN');
    const bad = await h.admin('POST', '/pages', pageInput({ kind: 'collection', slug: 'home-week-2' }));
    expect(bad.json().error.details.issues[0].path).toBe('collectionKind');
  });

  it('is not visible in the store until published; publishing records the live version and the event', async () => {
    const id = (await h.admin('GET', '/pages?q=home')).json().items[0].id;
    expect((await h.store('GET', '/pages/home-week')).statusCode).toBe(404);
    expect((await h.store('GET', '/campaign-pages')).json().items).toEqual([]);
    const preview = await h.admin('POST', `/pages/${id}/preview`, { device: 'desktop', useDraft: true });
    expect(preview.json()).toMatchObject({ slug: 'home-week', version: 1 });
    const pub = await h.admin('POST', `/pages/${id}/publish`);
    expect(pub.statusCode).toBe(200);
    expect(pub.json().summary).toMatchObject({ status: 'published', liveVersion: 1, draftVersion: null });
    expect(h.eventsNamed('content.page.published').at(-1)).toEqual({ entity: 'page', entityId: id, slug: 'home-week', version: 1, url: '/pages/home-week' });
    const store = (await h.store('GET', '/pages/home-week')).json();
    expect(store).toMatchObject({ id, title: 'Home Week', version: 1 });
    expect(store.breadcrumb.at(-1)).toEqual({ label: 'Home Week', url: '/pages/home-week', kind: 'page' });
    expect((await h.store('GET', '/campaign-pages')).json().items).toEqual([{ id, slug: 'home-week', url: '/pages/home-week', title: 'Home Week', eyebrow: 'Oct 6 – Oct 19', image: null, endsAt: null }]);
    // publishing again with no draft is illegal
    expect((await h.admin('POST', `/pages/${id}/publish`)).json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('editing a live page creates a draft version; the live version stays until the draft is published', async () => {
    const id = (await h.admin('GET', '/pages?q=home')).json().items[0].id;
    const res = await h.admin('PATCH', `/pages/${id}`, pageInput({ title: 'Home Week: last days', slug: 'home-week', changeNote: 'New title' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toMatchObject({ status: 'published', liveVersion: 1, draftVersion: 2 });
    expect((await h.store('GET', '/pages/home-week')).json().title).toBe('Home Week');
    await h.admin('POST', `/pages/${id}/publish`);
    expect((await h.store('GET', '/pages/home-week')).json()).toMatchObject({ title: 'Home Week: last days', version: 2 });
    const versions = (await h.admin('GET', `/pages/${id}/versions`)).json().items;
    expect(versions.map((v: any) => [v.number, v.state])).toEqual([
      [2, 'live'],
      [1, 'superseded'],
    ]);
    // restore 1 as a new draft (3), nothing overwritten
    const restored = await h.admin('POST', `/pages/${id}/versions/1/restore`, { reason: 'Old title tested better' });
    expect(restored.json().summary).toMatchObject({ liveVersion: 2, draftVersion: 3 });
    expect(restored.json().draft.title).toBe('Home Week');
    expect((await h.admin('POST', `/pages/${id}/versions/9/restore`, { reason: 'x' })).statusCode).toBe(404);
  });

  it('unpublishes and removes with a reason (correction note shown in place of the page)', async () => {
    const id = (await h.admin('GET', '/pages?q=home')).json().items[0].id;
    const un = await h.admin('POST', `/pages/${id}/unpublish`, { reason: 'Paused' });
    expect(un.json().summary.status).toBe('unpublished');
    expect((await h.store('GET', '/campaign-pages')).json().items).toEqual([]);
    expect(h.eventsNamed('content.page.unpublished').at(-1)).toEqual({ pageId: id, slug: 'home-week', reason: 'Paused' });
    expect((await h.store('GET', '/pages/home-week')).statusCode).toBe(404);
    expect((await h.admin('POST', `/pages/${id}/unpublish`, {})).json().error.code).toBe('ILLEGAL_TRANSITION');
    const rm = await h.admin('POST', `/pages/${id}/remove`, { kind: 'correction', reason: 'Prices were wrong', correctionNote: 'This campaign page listed wrong prices and was taken down.' });
    expect(rm.statusCode).toBe(200);
    expect(rm.json().removal).toMatchObject({ kind: 'correction', reason: 'Prices were wrong', actor: { kind: 'staff', id: h.staffId } });
    expect(h.eventsNamed('content.page.removed').at(-1)).toEqual({ entity: 'page', entityId: id, kind: 'correction', reason: 'Prices were wrong' });
    const store = (await h.store('GET', '/pages/home-week')).json();
    expect(store.blocks[0]).toMatchObject({ id: 'correction', body: 'This campaign page listed wrong prices and was taken down.' });
    expect(h.audits.some((a) => a.action === 'content.page.correction' && a.reason === 'Prices were wrong')).toBe(true);
  });

  it('schedules publish and removal times; the job publishes and takes the page down at those times', async () => {
    const campaignId = newId();
    h.campaigns.set(campaignId, { name: 'Autumn', startsAt: inMs(h, 10 * MIN), endsAt: inMs(h, DAY), active: false, status: 'scheduled' });
    const p = (await h.admin('POST', '/pages', pageInput({ title: 'Autumn sale', linkedPromotionId: campaignId }))).json();
    const id = p.summary.id;
    expect(p.linkedPromotion).toMatchObject({ id: campaignId, name: 'Autumn' });
    expect((await h.admin('POST', `/pages/${id}/schedule`, { publishAt: inMs(h, 20 * MIN), unpublishAt: inMs(h, 10 * MIN), timeZone: 'America/Los_Angeles' })).json().error.details.issues[0].path).toBe('unpublishAt');
    const res = await h.admin('POST', `/pages/${id}/schedule`, { publishAt: inMs(h, 15 * MIN), unpublishAt: inMs(h, 60 * MIN), timeZone: 'America/Los_Angeles' });
    expect(res.json().summary.status).toBe('scheduled');
    expect(res.json().checks.find((c: any) => c.label.startsWith('Campaign'))).toMatchObject({ state: 'warn' });
    expect((await h.service.pageLink(id))).toMatchObject({ url: '/pages/autumn-sale', status: 'scheduled' });

    h.clock.advance(16 * MIN);
    await h.app.kernel.jobs.runNow('content.run-schedules');
    await h.app.kernel.events.drain();
    expect((await h.store('GET', '/pages/autumn-sale')).statusCode).toBe(200);
    expect(h.eventsNamed('content.page.published').some((e: any) => e.entityId === id)).toBe(true);

    h.clock.advance(45 * MIN);
    await h.app.kernel.jobs.runNow('content.run-schedules');
    await h.app.kernel.events.drain();
    expect((await h.store('GET', '/pages/autumn-sale')).statusCode).toBe(404);
    expect(h.eventsNamed('content.page.unpublished').at(-1)).toMatchObject({ pageId: id, reason: 'Reached its removal time' });
  });

  it('flags a linked campaign page that stays up after its promotion ends', async () => {
    const campaignId = newId();
    h.campaigns.set(campaignId, { name: 'Flash', startsAt: inMs(h, -DAY), endsAt: inMs(h, -MIN), active: false, status: 'ended' });
    const p = (await h.admin('POST', '/pages', pageInput({ title: 'Flash page', linkedPromotionId: campaignId }))).json();
    await h.admin('POST', `/pages/${p.summary.id}/publish`);
    h.app.kernel.events.publish('promotions', 'promotions.campaign.ended', { campaignId, reason: 'period_over' });
    await h.app.kernel.events.drain();
    const admin = (await h.admin('GET', `/pages/${p.summary.id}`)).json();
    expect(admin.checks).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'warn', label: 'Linked promotion has ended' })]));
  });

  it('lists collections of a brand with available product counts and pages their products', async () => {
    const brandId = newId();
    const a = h.card({ title: 'Vase A' });
    const b = h.card({ title: 'Vase B' });
    const gone = h.card({ title: 'Vase C', availability: 'out_of_stock' });
    for (const c of [a, b, gone]) h.cards.set(c.productId, c);
    const cover = await uploadImage(h);
    const created = await h.admin('POST', '/pages', {
      kind: 'collection',
      collectionKind: 'brand',
      brandId,
      title: 'Casa Verde vases',
      curatorName: 'Dana',
      coverImage: cover,
      blocks: [{ id: 'grid', type: 'product_grid', productSource: { mode: 'manual', productIds: [a.productId, gone.productId, b.productId] }, products: [] }],
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().summary.id;
    expect(created.json().summary.url).toBe('/collections/casa-verde-vases');
    expect(created.json().checks[0]).toMatchObject({ state: 'warn', label: '1 unavailable product hidden' });
    const media = h.app.kernel.boot.apis.get('media') as MediaPublicApi;
    expect((await media.getAsset(cover.id))!.usageCount).toBe(1);
    await h.admin('POST', `/pages/${id}/publish`);

    const cards = (await h.store('GET', `/collections?brandId=${brandId}`)).json();
    expect(cards.items).toEqual([expect.objectContaining({ id, title: 'Casa Verde vases', productCount: 2, collectionKind: 'brand' })]);
    expect(cards.items[0].image.id).toBe(cover.id);
    const page = (await h.store('GET', '/pages/casa-verde-vases')).json();
    expect(page.curator).toMatchObject({ name: 'Dana', productCount: 2, sectionCount: 1 });
    expect(page.notes).toContain('No seller paid to be included');
    expect(page.blocks[0].products.map((p: any) => p.title)).toEqual(['Vase A', 'Vase B']);
    const first = (await h.store('GET', '/pages/casa-verde-vases/products?limit=1')).json();
    expect(first.items.map((p: any) => p.title)).toEqual(['Vase A']);
    const next = (await h.store('GET', `/pages/casa-verde-vases/products?limit=1&cursor=${first.nextCursor}`)).json();
    expect(next.items.map((p: any) => p.title)).toEqual(['Vase B']);
    expect((await h.store('GET', '/pages/nope/products')).statusCode).toBe(404);

    // a homepage brand_collections section shows the brand through its collection
    const s = (await h.admin('POST', '/homepage/sections', { kind: 'brand_collections', brandIds: [brandId] })).json();
    await h.admin('POST', '/homepage/publish', { summary: 'Brands' });
    const home = (await h.store('GET', '/home')).json();
    expect(home.sections.find((x: any) => x.id === s.id).brands).toEqual([expect.objectContaining({ brandId, name: 'Casa Verde vases', productCount: 2 })]);

    // the curated collection is checked hourly; a hidden product leaves the draft of manual selections
    await h.app.kernel.jobs.runNow('content.refresh-collections');
    h.app.kernel.events.publish('catalog', 'catalog.product.publication_changed', { productId: a.productId, from: 'active', to: 'hidden', reason: 'Recall' });
    await h.app.kernel.events.drain();
    const after = (await h.admin('GET', `/pages/${id}`)).json();
    expect(after.draft.blocks[0].productSource.productIds).toEqual([gone.productId, b.productId]);
    expect(after.live.blocks[0].productSource.productIds).toHaveLength(3);
  });

  it('requires review before publishing when content.reviewRequired.page is on', async () => {
    // settings module is off in this harness: the spec default (page: false) applies, so publishing a draft directly works
    const p = (await h.admin('POST', '/pages', pageInput({ title: 'About Marketly', kind: 'about' }))).json();
    expect(p.summary).toMatchObject({ slug: 'about', url: '/about' });
    const sub = await h.admin('POST', `/pages/${p.summary.id}/submit`);
    expect(sub.json().summary.status).toBe('in_review');
    expect((await h.admin('PATCH', `/pages/${p.summary.id}`, pageInput({ title: 'About', kind: 'about' }))).statusCode).toBe(409);
    const changes = await h.admin('POST', `/pages/${p.summary.id}/approve`, { approve: false, reason: 'Add the company address' });
    expect(changes.json().summary.status).toBe('draft');
    await h.admin('POST', `/pages/${p.summary.id}/submit`);
    // someone other than the writer approves
    const ok = await h.admin('POST', `/pages/${p.summary.id}/approve`, { approve: true }, h.staff(newId()));
    expect(ok.json().summary.status).toBe('approved');
    expect((await h.admin('POST', `/pages/${p.summary.id}/publish`)).json().summary.status).toBe('published');
    expect((await h.store('GET', '/pages/about')).json().kind).toBe('about');
  });
});

describe('page review is by someone else', () => {
  it('the writer of a page cannot approve it', async () => {
    const writer = newId();
    const p = (await h.admin('POST', '/pages', pageInput({ title: 'Our story', kind: 'about', slug: 'our-story' }), h.staff(writer))).json();
    expect(p.summary?.id, JSON.stringify(p)).toBeTruthy();
    await h.admin('POST', `/pages/${p.summary.id}/submit`, {}, h.staff(writer));
    const own = await h.admin('POST', `/pages/${p.summary.id}/approve`, { approve: true }, h.staff(writer));
    expect(own.json().error.code).toBe('SAME_REVIEWER');
    expect((await h.admin('POST', `/pages/${p.summary.id}/approve`, { approve: true }, h.staff(newId()))).json().summary.status).toBe('approved');
  });
});
