import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, callers, DAY, harness, newId, type Harness } from './helpers.js';

let h: Harness;
let returnsCat: { id: string; slug: string };
let sellerCat: { id: string; slug: string };
const author = newId();
const reviewer = newId();

beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const article = (over: Record<string, unknown> = {}) => ({
  title: 'Start a return',
  categoryId: returnsCat.id,
  summary: 'How to send an item back',
  body: '<h2>Steps</h2><ol><li>Open your order</li><li>Choose items</li></ol><script>document.cookie</script><table><tr><td colspan="2" onmouseover="x()">Who pays</td></tr></table>',
  topics: ['Return_Request', 'damaged_item'],
  policyKeys: ['returns'],
  popularSearch: 'Return an item',
  ...over,
});

const publishWithReview = async (id: string) => {
  expect((await h.admin('POST', `/help/articles/${id}/transition`, { action: 'submit' }, h.staff(author))).statusCode).toBe(200);
  const ok = await h.admin('POST', `/help/articles/${id}/transition`, { action: 'approve' }, h.staff(reviewer));
  expect(ok.statusCode).toBe(200);
  return h.admin('POST', `/help/articles/${id}/transition`, { action: 'publish' }, h.staff(reviewer));
};

describe('help categories', () => {
  it('creates, renames, hides and reorders categories', async () => {
    returnsCat = (await h.admin('POST', '/help/categories', { name: 'Returns & refunds', icon: 'rotate', audience: 'customer' })).json();
    expect(returnsCat).toMatchObject({ slug: 'returns-and-refunds', position: 1, visible: true, articleCount: 0 });
    sellerCat = (await h.admin('POST', '/help/categories', { name: 'Payouts', audience: 'seller' })).json();
    const hidden = (await h.admin('POST', '/help/categories', { name: 'Internal', audience: 'both', visible: false })).json();
    const dup = await h.admin('POST', '/help/categories', { name: 'Again', slug: 'payouts', audience: 'seller' });
    expect(dup.json().error.code).toBe('SLUG_TAKEN');
    const moved = await h.admin('PATCH', `/help/categories/${hidden.id}`, { position: 1, name: 'Internal notes' });
    expect(moved.json()).toMatchObject({ position: 1, name: 'Internal notes', visible: false });
    const list = (await h.admin('GET', '/help/categories')).json();
    expect(list.map((c: any) => c.name)).toEqual(['Internal notes', 'Returns & refunds', 'Payouts']);
    expect(h.audits.some((a) => a.action === 'content.help.category.update')).toBe(true);
  });
});

describe('help articles', () => {
  let id: string;

  it('creates a sanitized draft; review is required and the author cannot approve it', async () => {
    const res = await h.admin('POST', '/help/articles', article(), h.staff(author));
    expect(res.statusCode).toBe(201);
    const a = res.json();
    id = a.article.id;
    expect(a).toMatchObject({ status: 'draft', draftVersion: 1, liveVersion: null, feedbackCount: 0 });
    expect(a.article.body).not.toMatch(/script|onmouseover/);
    expect(a.article.body).toContain('<td colspan="2">Who pays</td>');
    expect(a.article.slug).toBe('start-a-return');
    expect((await h.admin('POST', '/help/articles', article(), h.staff(author))).json().error.code).toBe('SLUG_TAKEN');

    const direct = await h.admin('POST', `/help/articles/${id}/transition`, { action: 'publish' }, h.staff(author));
    expect(direct.statusCode).toBe(409);
    expect(direct.json().error.code).toBe('ILLEGAL_TRANSITION');
    await h.admin('POST', `/help/articles/${id}/transition`, { action: 'submit' }, h.staff(author));
    const self = await h.admin('POST', `/help/articles/${id}/transition`, { action: 'approve' }, h.staff(author));
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('SAME_REVIEWER');
    expect((await h.admin('PATCH', `/help/articles/${id}`, article({ title: 'Edit in review' }), h.staff(author))).json().error.code).toBe('CONFLICT');
    const back = await h.admin('POST', `/help/articles/${id}/transition`, { action: 'requestChanges', reason: 'Add the label step' }, h.staff(reviewer));
    expect(back.json().status).toBe('draft');
  });

  it('publishes after review: store article, search, event and review-due date', async () => {
    const pub = await publishWithReview(id);
    expect(pub.json()).toMatchObject({ status: 'published', liveVersion: 1, draftVersion: null });
    expect(pub.json().reviewDueAt).toBeTruthy();
    expect(h.eventsNamed('content.article.published').at(-1)).toEqual({ articleId: id, slug: 'start-a-return', version: 1 });
    // policy link appears once the returns policy exists
    await h.admin('POST', '/policies', { key: 'returns', title: 'Returns policy', ownerStaffId: newId(), audience: 'customer' });
    const store = await h.store('GET', '/help/articles/start-a-return');
    expect(store.statusCode).toBe(200);
    expect(store.json()).toMatchObject({ title: 'Start a return', version: 1, category: { name: 'Returns & refunds', articleCount: 1 } });
    expect(store.json().policyLinks).toEqual([{ label: 'Returns policy', url: '/policies/returns', kind: 'policy' }]);
    expect(store.json().breadcrumb[0]).toEqual({ label: 'Help Center', url: '/help', kind: 'help' });

    const found = (await h.store('GET', '/help/articles?q=return')).json();
    expect(found.items.map((a: any) => a.id)).toEqual([id]);
    expect((await h.store('GET', '/help/articles?q=choose%20items')).json().items).toHaveLength(1);
    expect((await h.store('GET', `/help/articles?category=${sellerCat.slug}`)).json().items).toHaveLength(0);
    expect((await h.store('GET', '/help/articles?audience=seller')).json().items).toHaveLength(0);
    expect(await h.service.helpArticlesFor('return_request', 3)).toEqual([expect.objectContaining({ id, readMinutes: 1, categoryName: 'Returns & refunds' })]);
    expect(await h.service.countHelpArticlesForPolicy('returns')).toEqual({ count: 1, articleIds: [id] });
  });

  it('records one helpfulness answer per visitor and reports the helpful rating', async () => {
    const customer = auth(callers.customer());
    expect((await h.store('POST', `/help/articles/${id}/feedback`, { helpful: false }, customer)).statusCode).toBe(204);
    expect((await h.store('POST', `/help/articles/${id}/feedback`, { helpful: true, comment: '<b>Clear</b>' }, customer)).statusCode).toBe(204);
    await h.store('POST', `/help/articles/${id}/feedback`, { helpful: false }, auth(callers.customer()));
    const admin = (await h.admin('GET', `/help/articles/${id}`)).json();
    expect(admin).toMatchObject({ feedbackCount: 2, helpfulPct: 50 });
    expect((await h.store('POST', `/help/articles/${newId()}/feedback`, { helpful: true })).statusCode).toBe(404);
  });

  it('edits a live article as a new draft, keeps the live text, and restores versions', async () => {
    const edit = await h.admin('PATCH', `/help/articles/${id}`, article({ title: 'Start a return (updated)', changeNote: 'Label step', featured: true }), h.staff(author));
    expect(edit.json()).toMatchObject({ status: 'published', liveVersion: 1, draftVersion: 2 });
    expect((await h.store('GET', '/help/articles/start-a-return')).json().title).toBe('Start a return');
    // the draft of a live article also goes through review
    expect((await h.admin('POST', `/help/articles/${id}/transition`, { action: 'publish' }, h.staff(reviewer))).json().error.code).toBe('ILLEGAL_TRANSITION');
    await publishWithReview(id);
    expect((await h.store('GET', '/help/articles/start-a-return')).json()).toMatchObject({ title: 'Start a return (updated)', version: 2 });
    const home = (await h.store('GET', '/help')).json();
    expect(home.featured.id).toBe(id);
    expect(home.popularSearches).toEqual([{ label: 'Return an item', url: '/help/articles/start-a-return', kind: 'help' }]);
    expect(home.topics.map((t: any) => t.name)).toEqual(['Returns & refunds']);
    expect(home.topics[0].topArticles[0].id).toBe(id);
    expect(home.sellerFirstNote).toMatch(/seller answers first/);
    expect(home.contact.map((c: any) => c.kind)).toEqual(['message']); // no live chat (G7); no phone without settings
    const seller = (await h.store('GET', '/help?audience=seller')).json();
    expect(seller.topics.map((t: any) => t.name)).toEqual(['Payouts']);
    expect(seller.featured).toBeNull();

    const versions = (await h.admin('GET', `/help/articles/${id}/versions`)).json().items;
    expect(versions.map((v: any) => v.state)).toEqual(['live', 'superseded']);
    const restored = await h.admin('POST', `/help/articles/${id}/versions/1/restore`, { reason: 'Revert wording' });
    expect(restored.json()).toMatchObject({ draftVersion: 3, liveVersion: 2 });
    expect(restored.json().article.title).toBe('Start a return');
  });

  it('unpublishes, removes with kind and reason, and restores to draft', async () => {
    expect((await h.admin('POST', `/help/articles/${id}/transition`, { action: 'remove', reason: 'Wrong steps' })).json().error.details.issues[0].path).toBe('kind');
    const rm = await h.admin('POST', `/help/articles/${id}/transition`, { action: 'remove', kind: 'removal', reason: 'Wrong steps' });
    expect(rm.json().status).toBe('removed');
    expect(h.eventsNamed('content.page.removed').at(-1)).toEqual({ entity: 'article', entityId: id, kind: 'removal', reason: 'Wrong steps' });
    expect((await h.store('GET', '/help/articles/start-a-return')).statusCode).toBe(404);
    const restore = await h.admin('POST', `/help/articles/${id}/transition`, { action: 'restore' });
    expect(restore.json().status).toBe('draft');
    expect((await h.admin('POST', `/help/articles/${id}/transition`, { action: 'unpublish' })).json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('schedules an approved article; the job publishes it; review-due flags notify the owner once', async () => {
    const owner = newId();
    const a = (await h.admin('POST', '/help/articles', article({ title: 'Payout schedule', categoryId: sellerCat.id, slug: 'payout-schedule', topics: ['fees_payouts'], policyKeys: [], ownerStaffId: owner, popularSearch: null }), h.staff(author))).json();
    const aid = a.article.id;
    expect((await h.admin('POST', `/help/articles/${aid}/transition`, { action: 'schedule' }, h.staff(author))).json().error.details.issues[0].path).toBe('publishAt');
    await h.admin('POST', `/help/articles/${aid}/transition`, { action: 'submit' }, h.staff(author));
    await h.admin('POST', `/help/articles/${aid}/transition`, { action: 'approve' }, h.staff(reviewer));
    const at = new Date(h.clock.now().getTime() + 5 * 60_000).toISOString();
    const sched = await h.admin('POST', `/help/articles/${aid}/transition`, { action: 'schedule', publishAt: at }, h.staff(reviewer));
    expect(sched.json()).toMatchObject({ status: 'scheduled', schedule: { publishAt: at } });
    h.clock.advance(6 * 60_000);
    await h.app.kernel.jobs.runNow('content.run-schedules');
    await h.app.kernel.events.drain();
    expect((await h.store('GET', '/help/articles/payout-schedule')).statusCode).toBe(200);
    expect((await h.store('GET', '/help?audience=seller')).json().popular.map((x: any) => x.id)).toContain(aid);
    const publishedAt = h.clock.now().getTime();

    h.clock.advance(91 * DAY);
    await h.app.kernel.jobs.runNow('content.article-review-due');
    await h.app.kernel.jobs.runNow('content.article-review-due');
    await h.app.kernel.events.drain();
    // published once per due date; notifications tells the owner (no direct notice from content)
    const due = h.eventsNamed('content.article.review_due').filter((e) => e.articleId === aid);
    expect(due).toEqual([{ articleId: aid, slug: 'payout-schedule', title: 'Payout schedule', ownerStaffId: owner, lastReviewedAt: expect.any(String), dueSince: expect.any(String) }]);
    expect(Math.abs(Date.parse(due[0].lastReviewedAt) - publishedAt)).toBeLessThan(60_000);
    expect(Date.parse(due[0].dueSince)).toBe(Date.parse(due[0].lastReviewedAt) + 90 * DAY);
    expect(h.notices.filter((n: any) => n.recipients?.[0]?.accountId === owner)).toEqual([]);
    const summary = (await h.admin('GET', '/help/summary')).json();
    expect(summary).toMatchObject({ publishedArticles: 1, articlesNeedingReview: 1, policies: 1, helpfulWindowDays: 30 });
    const needs = (await h.admin('GET', '/help/items?needsReview=true')).json();
    expect(needs.items.map((x: any) => x.id)).toEqual([aid]);
    const all = (await h.admin('GET', '/help/items')).json();
    expect(all.items.map((x: any) => x.type).sort()).toEqual(['article', 'article', 'policy']);
    expect((await h.admin('GET', '/help/items?type=policy')).json().items[0]).toMatchObject({ type: 'policy', category: 'Policies', editUrl: expect.stringContaining('/admin/help-content/policies/') });
  });
});
