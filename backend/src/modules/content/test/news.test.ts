import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, harness, inMs, MIN, newId, uploadImage, type Harness } from './helpers.js';

// News for customers (docs/06-news.md): categories, posts with two-person review, pin, archive, schedule, store reads.

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const writer = newId();
const editor = newId();
let categoryId = '';

const post = (over: Record<string, unknown> = {}) => ({
  title: 'Holiday shipping cut-offs',
  categoryId,
  summary: 'Order by Dec 18 for delivery before the holidays.',
  body: '<h2>Order by Dec 18</h2><p onclick="x()">Standard delivery cut-off.</p><script>alert(1)</script>',
  cta: { label: 'See the deals', url: '/deals' },
  ...over,
});
const t = (id: string, body: Record<string, unknown>, as = editor) => h.admin('POST', `/news/${id}/transition`, body, h.staff(as));
/** Writer drafts, submits; the editor approves and publishes */
const publishNew = async (over: Record<string, unknown> = {}) => {
  const id = (await h.admin('POST', '/news', post(over), h.staff(writer))).json().post.id as string;
  await t(id, { action: 'submit' }, writer);
  await t(id, { action: 'approve' });
  expect((await t(id, { action: 'publish' })).statusCode).toBe(200);
  return id;
};

describe('news categories', () => {
  it('starts with the seeded categories and lets staff add, rename, hide, reorder and delete them', async () => {
    const seeded = (await h.admin('GET', '/news-categories')).json();
    expect(seeded.map((c: any) => c.slug)).toEqual(['announcements', 'service-updates', 'events', 'policy-changes']);
    categoryId = seeded[1].id;

    const res = await h.admin('POST', '/news-categories', { name: 'New sellers', icon: 'store' });
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c).toMatchObject({ slug: 'new-sellers', position: 5, visible: true, postCount: 0 });
    const dup = await h.admin('POST', '/news-categories', { name: 'new sellers' });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.details.issues[0].path).toBe('name');

    const renamed = (await h.admin('PATCH', `/news-categories/${c.id}`, { name: 'Marketplace', position: 1 })).json();
    expect(renamed).toMatchObject({ slug: 'marketplace', name: 'Marketplace', position: 1 });
    expect((await h.admin('GET', '/news-categories')).json().map((x: any) => x.slug)).toEqual(['marketplace', 'announcements', 'service-updates', 'events', 'policy-changes']);
    expect(h.audits.some((a) => a.action === 'content.news.category.update' && a.target.id === c.id)).toBe(true);

    const del = await h.admin('DELETE', `/news-categories/${c.id}`);
    expect(del.statusCode).toBe(204);
    expect((await h.admin('GET', '/news-categories')).json().map((x: any) => x.position)).toEqual([1, 2, 3, 4]);
  });
});

describe('news posts', () => {
  let id = '';

  it('creates a sanitized draft that the store does not show', async () => {
    const res = await h.admin('POST', '/news', post(), h.staff(writer));
    expect(res.statusCode).toBe(201);
    const a = res.json();
    id = a.post.id;
    expect(a).toMatchObject({ status: 'draft', draftVersion: 1, liveVersion: null, reviewRequired: true, pinned: false, canApprove: false });
    expect(a.post).toMatchObject({ slug: 'holiday-shipping-cut-offs', url: '/news/holiday-shipping-cut-offs', category: { id: categoryId, slug: 'service-updates' }, cta: { label: 'See the deals', url: '/deals' }, publishedAt: null });
    expect(a.post.body).not.toMatch(/script|onclick/);
    expect((await h.store('GET', '/news/holiday-shipping-cut-offs')).statusCode).toBe(404);
    expect((await h.store('GET', '/news')).json().items).toEqual([]);

    // a second post without its own slug gets the next free one; a chosen slug must be free
    const twin = (await h.admin('POST', '/news', post(), h.staff(writer))).json();
    expect(twin.post.slug).toBe('holiday-shipping-cut-offs-2');
    expect((await h.admin('POST', '/news', post({ slug: 'holiday-shipping-cut-offs' }), h.staff(writer))).json().error.code).toBe('SLUG_TAKEN');
    expect((await h.admin('POST', '/news', post({ slug: 'summary' }), h.staff(writer))).statusCode).toBe(400);
    expect((await h.admin('POST', '/news', post({ cta: { label: 'Bad', url: 'javascript:alert(1)' } }), h.staff(writer))).statusCode).toBe(400);
    await t(twin.post.id, { action: 'remove', kind: 'removal', reason: 'Duplicate' });
  });

  it('needs a second person: the writer cannot publish or approve their own post', async () => {
    const direct = await t(id, { action: 'publish' }, writer);
    expect(direct.statusCode).toBe(409);
    expect(direct.json().error.code).toBe('ILLEGAL_TRANSITION');
    expect((await t(id, { action: 'submit' }, writer)).json()).toMatchObject({ status: 'in_review' });
    const own = await t(id, { action: 'approve' }, writer);
    expect(own.json().error.code).toBe('SAME_REVIEWER');
    expect((await h.admin('GET', `/news/${id}`, undefined, h.staff(editor))).json().canApprove).toBe(true);

    // changes requested: the note reaches the writer, who edits and submits again
    const back = (await t(id, { action: 'requestChanges', reason: 'Add the express cut-off' })).json();
    expect(back).toMatchObject({ status: 'draft', draftReview: { state: 'changes_requested', reason: 'Add the express cut-off' } });
    const edited = await h.admin('PATCH', `/news/${id}`, post({ body: '<p>Standard by Dec 18, express by Dec 21.</p>' }), h.staff(writer));
    expect(edited.statusCode).toBe(200);
    expect((await t(id, { action: 'submit' }, writer)).json()).toMatchObject({ status: 'in_review', draftReview: null });
    expect((await t(id, { action: 'approve' })).json().status).toBe('approved');
  });

  it('publishing lists it in the store, counts it in the summary and tells the event bus', async () => {
    const pub = await t(id, { action: 'publish' });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ status: 'published', liveVersion: 1, draftVersion: null });
    expect(h.eventsNamed('content.news.published').at(-1)).toEqual({ postId: id, slug: 'holiday-shipping-cut-offs', url: '/news/holiday-shipping-cut-offs', version: 1 });

    const list = (await h.store('GET', '/news')).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id, title: 'Holiday shipping cut-offs', category: { slug: 'service-updates', name: 'Service updates' }, pinned: false });
    expect((await h.store('GET', '/news?category=service-updates')).json().items).toHaveLength(1);
    expect((await h.store('GET', '/news?category=events')).json().items).toHaveLength(0);
    const summary = (await h.store('GET', '/news/summary')).json();
    expect(summary).toMatchObject({ count: 1 });
    expect(summary.latestPublishedAt).toBeTruthy();
    const cats = (await h.store('GET', '/news/categories')).json();
    expect(cats.map((c: any) => [c.slug, c.postCount])).toEqual([['service-updates', 1]]);

    const one = (await h.store('GET', '/news/holiday-shipping-cut-offs')).json();
    expect(one).toMatchObject({ id, archived: false, version: 1, body: '<p>Standard by Dec 18, express by Dec 21.</p>' });
    expect(one.publishedAt).toBeTruthy();
  });

  it('editing a live post makes a draft; a new address keeps the old one working', async () => {
    const res = await h.admin('PATCH', `/news/${id}`, post({ title: 'Holiday shipping: order dates', slug: 'holiday-order-dates', changeNote: 'Clearer title' }), h.staff(writer));
    expect(res.json()).toMatchObject({ status: 'published', liveVersion: 1, draftVersion: 2 });
    expect((await h.store('GET', '/news/holiday-shipping-cut-offs')).json().title).toBe('Holiday shipping cut-offs');
    await t(id, { action: 'submit' }, writer);
    expect((await t(id, { action: 'publish' })).json().error.code).toBe('ILLEGAL_TRANSITION');
    await t(id, { action: 'approve' });
    await t(id, { action: 'publish' });
    const old = (await h.store('GET', '/news/holiday-shipping-cut-offs')).json();
    expect(old).toMatchObject({ slug: 'holiday-order-dates', title: 'Holiday shipping: order dates', version: 2 });
    const versions = (await h.admin('GET', `/news/${id}/versions`)).json().items;
    expect(versions.map((v: any) => [v.number, v.state])).toEqual([
      [2, 'live'],
      [1, 'superseded'],
    ]);
  });

  it('keeps at most 3 pinned posts, pinned first', async () => {
    const ids = [await publishNew({ title: 'Spring sale' }), await publishNew({ title: 'New warehouse' }), await publishNew({ title: 'App update' })];
    for (const x of [id, ...ids]) expect((await h.admin('POST', `/news/${x}/pin`, { pinned: true })).statusCode).toBe(200);
    const listed = (await h.store('GET', '/news')).json().items;
    // the first pin (the holiday post) gave way to the fourth
    expect(listed.filter((n: any) => n.pinned).map((n: any) => n.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(listed.at(-1).id).toBe(id);
    expect(h.audits.some((a) => a.action === 'content.news.pin')).toBe(true);
    // pinning needs publish rights
    expect((await h.admin('POST', `/news/${id}/pin`, { pinned: true }, h.staff(writer, ['content.news.manage', 'content.view']))).statusCode).toBe(403);
  });

  it('an archived post leaves the list but its link still opens it', async () => {
    const x = await publishNew({ title: 'Black Friday hours', archiveAt: inMs(h, 2 * DAY) });
    expect((await h.store('GET', '/news')).json().items.some((n: any) => n.id === x)).toBe(true);
    h.clock.advance(3 * DAY);
    expect((await h.store('GET', '/news')).json().items.some((n: any) => n.id === x)).toBe(false);
    expect((await h.store('GET', '/news/black-friday-hours')).json()).toMatchObject({ id: x, archived: true });
    const counts = (await h.admin('GET', '/news/counts')).json();
    expect(counts.archived).toBeGreaterThanOrEqual(1);
    expect((await h.admin('GET', '/news?status=archived')).json().items.map((n: any) => n.id)).toContain(x);
  });

  it('schedules an approved post and the schedule job publishes it', async () => {
    const x = (await h.admin('POST', '/news', post({ title: 'Gift guide' }), h.staff(writer))).json().post.id;
    await t(x, { action: 'submit' }, writer);
    await t(x, { action: 'approve' });
    const s = await t(x, { action: 'schedule', publishAt: inMs(h, 30 * MIN) });
    expect(s.json().status).toBe('scheduled');
    await h.app.kernel.jobs.runNow('content.run-schedules');
    expect((await h.store('GET', '/news/gift-guide')).statusCode).toBe(404);
    h.clock.advance(31 * MIN);
    await h.app.kernel.jobs.runNow('content.run-schedules');
    expect((await h.store('GET', '/news/gift-guide')).statusCode).toBe(200);
  });

  it('approving and publishing need content.news.publish; a category in use cannot be deleted', async () => {
    const x = (await h.admin('POST', '/news', post({ title: 'Writers only' }), h.staff(writer))).json().post.id;
    await t(x, { action: 'submit' }, writer);
    const marketing = h.staff(newId(), ['content.news.manage', 'content.view']);
    expect((await h.admin('POST', `/news/${x}/transition`, { action: 'approve' }, marketing)).statusCode).toBe(403);
    const inUse = await h.admin('DELETE', `/news-categories/${categoryId}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().error.details.posts.length).toBeGreaterThan(0);
  });

  it('an approved post can be sent back or removed before it goes live; a live post\'s draft can be discarded', async () => {
    const x = (await h.admin('POST', '/news', post({ title: 'Approved then changed' }), h.staff(writer))).json().post.id;
    await t(x, { action: 'submit' }, writer);
    await t(x, { action: 'approve' });
    expect((await t(x, { action: 'requestChanges', reason: 'Wrong date' })).json()).toMatchObject({ status: 'draft', draftReview: { state: 'changes_requested', reason: 'Wrong date' } });
    await t(x, { action: 'submit' }, writer);
    await t(x, { action: 'approve' });
    expect((await t(x, { action: 'remove', kind: 'removal', reason: 'Not needed' })).json().status).toBe('removed');

    // a live post's approved draft goes back to the writer; a draft is discarded and the live post stays
    const live = await publishNew({ title: 'Live with a draft' });
    await h.admin('PATCH', `/news/${live}`, post({ title: 'Live with a draft (edited)', slug: 'live-with-a-draft' }), h.staff(writer));
    await t(live, { action: 'submit' }, writer);
    await t(live, { action: 'approve' });
    expect((await t(live, { action: 'requestChanges', reason: 'Keep the old title' })).json().draftReview).toMatchObject({ state: 'changes_requested' });
    const dropped = (await t(live, { action: 'discardDraft' })).json();
    expect(dropped).toMatchObject({ status: 'published', draftVersion: null, liveVersion: 1 });
    expect((await h.store('GET', '/news/live-with-a-draft')).json().title).toBe('Live with a draft');
    expect((await t(live, { action: 'discardDraft' })).json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('unpublishing takes it off the list at once', async () => {
    const res = await t(id, { action: 'unpublish', reason: 'Dates changed' });
    expect(res.json().status).toBe('unpublished');
    expect(h.eventsNamed('content.news.unpublished').at(-1)).toEqual({ postId: id, slug: 'holiday-order-dates', reason: 'Dates changed' });
    expect((await h.store('GET', '/news/holiday-order-dates')).statusCode).toBe(404);
  });

  it('with review turned off the writer publishes directly', async () => {
    h.settingsValues['content.reviewRequired'] = { page: false, section: false, article: true, news: false };
    try {
      const x = (await h.admin('POST', '/news', post({ title: 'Quick note' }), h.staff(writer))).json();
      expect(x.reviewRequired).toBe(false);
      expect((await t(x.post.id, { action: 'publish' }, writer)).json().status).toBe('published');
    } finally {
      delete h.settingsValues['content.reviewRequired'];
    }
  });
});

describe('news on the homepage', () => {
  it('a news section shows the newest listed posts, pinned first, with an All news link', async () => {
    const res = await h.admin('POST', '/homepage/sections', { kind: 'news', heading: 'Latest news', position: 2 });
    expect(res.statusCode).toBe(201);
    expect(res.json().description).toBe('The newest news posts, pinned first');
    expect((await h.admin('POST', '/homepage/publish', { summary: 'News row' })).statusCode).toBe(200);
    const section = (await h.store('GET', '/home')).json().sections.find((s: any) => s.kind === 'news');
    expect(section.link).toEqual({ label: 'All news', url: '/news', kind: 'page' });
    expect(section.news.length).toBe(3);
    expect(section.news.slice(0, 1).every((n: any) => n.pinned)).toBe(true);
  });

  it('a cover image is resolved on the cards', async () => {
    const img = await uploadImage(h);
    const x = await publishNew({ title: 'Cover story', cover: { id: img.id, url: img.url } });
    const card = (await h.store('GET', '/news')).json().items.find((n: any) => n.id === x);
    expect(card.cover?.id).toBe(img.id);
  });
});

describe('the second person stays a second person', () => {
  it('a colleague touching the draft does not let the writer approve it', async () => {
    const id = (await h.admin('POST', '/news', post({ title: 'Store hours over the holidays', slug: 'holiday-hours' }), h.staff(writer))).json().post.id as string;
    // the editor fixes a typo and sends it on; the writer was still the one who wrote it
    expect((await h.admin('PATCH', `/news/${id}`, post({ title: 'Store hours over the holidays', slug: 'holiday-hours', body: '<p>Fixed a typo.</p>' }), h.staff(editor))).statusCode).toBe(200);
    expect((await t(id, { action: 'submit' }, editor)).json().status).toBe('in_review');
    const own = await t(id, { action: 'approve' }, writer);
    expect(own.json().error.code).toBe('SAME_REVIEWER');
    expect((await h.admin('GET', `/news/${id}`, undefined, h.staff(writer))).json().canApprove).toBe(false);
    expect((await t(id, { action: 'approve' }, newId())).json().status).toBe('approved');
  });

  it('a removed post restored by its writer still needs someone else to approve it', async () => {
    const id = await publishNew({ title: 'Recall notice', slug: 'recall-notice' });
    expect((await t(id, { action: 'remove', kind: 'removal', reason: 'Posted too early' })).statusCode).toBe(200);
    const restored = await t(id, { action: 'restore', reason: 'Ready now' }, writer);
    expect(restored.statusCode, restored.body).toBe(200);
    await t(id, { action: 'submit' }, writer);
    const own = await t(id, { action: 'approve' }, writer);
    expect(own.json().error?.code, own.body).toBe('SAME_REVIEWER');
  });
});
