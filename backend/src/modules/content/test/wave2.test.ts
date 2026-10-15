/**
 * Wave 2 (web team requests): the Official Store profile (G8), About facts (G32c), contact channels from support
 * without chat (G7, G31c), help topic links (G31b), typed tables and tabs (G20), seller help routes (G43),
 * who wrote a help draft (G65b) and the content.view permission (G77).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spec } from '../../../spec/content.js';
import { contactChannelsFrom } from '../domain/rules.js';
import { schemas } from '../schema.js';
import { auth, callers, DAY, harness, newId, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const table = (name: string) => h.app.kernel.mongo.module('content', spec.collections, schemas).table<any>(name);

/** A policy with a version in force (the approval flow is covered by policies.test.ts) */
async function currentPolicy(key: string, kind: string, title: string) {
  const policyId = newId();
  await table('policies').insert({ id: policyId, key, kind, title, owner_staff_id: newId(), editor_staff_id: null, audience: 'customer' });
  const at = new Date(h.clock.now().getTime() - DAY);
  await table('policy_versions').insert({
    id: newId(),
    policy_id: policyId,
    version: '1.0',
    state: 'current',
    title,
    body: '<p>Terms</p>',
    tables: [{ caption: 'Who pays return shipping', columns: ['Reason', 'Who pays'], rows: [['Damaged', 'Seller']] }, { not: 'a table' }],
    effective_at: at,
    change_summary: null,
    impact: 'new_orders_only',
    notify_customers: false,
    notify_sellers: false,
    approval_request_id: null,
    created_by: 'staff:x',
    created_at: at,
    published_at: at,
  });
}

describe('Official Store profile (G8)', () => {
  it('comes from the content settings, the current policies of the chosen kinds and the reviews feedback summary', async () => {
    await currentPolicy('shipping', 'shipping', 'Shipping and delivery');
    await currentPolicy('returns', 'returns', 'Returns policy');
    await currentPolicy('privacy', 'privacy', 'Privacy');
    const res = await h.store('GET', '/official-store');
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json();
    expect(p).toMatchObject({ id: '00000000-0000-7000-8000-000000000001', name: 'Marketly Official Store', logoUrl: '/brand/official-store-logo.svg', bannerUrl: null, introduction: expect.stringContaining('Marketly') });
    // in the order of officialStorePolicyKinds; privacy is not one of them
    expect(p.policies).toEqual([
      { label: 'Returns policy', url: '/policies/returns', kind: 'policy' },
      { label: 'Shipping and delivery', url: '/policies/shipping', kind: 'policy' },
    ]);
    expect(p.feedback).toMatchObject({ official: true, positivePct: 97, label: '97% positive · 40 ratings' });
    h.settingsValues['content.officialStoreBannerUrl'] = 'https://cdn.example.com/official.jpg';
    expect((await h.store('GET', '/official-store')).json().bannerUrl).toBe('https://cdn.example.com/official.jpg');
    delete h.settingsValues['content.officialStoreBannerUrl'];
  });

  it('policy tables are typed: entries of another shape are left out (G20)', async () => {
    const res = await h.store('GET', '/policies/returns');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().tables).toEqual([{ caption: 'Who pays return shipping', columns: ['Reason', 'Who pays'], rows: [['Damaged', 'Seller']], note: null }]);
  });
});

describe('About pages (G32c)', () => {
  it('carry the approved-seller count', async () => {
    h.sellers.set(newId(), { name: 'A', status: 'approved' });
    h.sellers.set(newId(), { name: 'B', status: 'restricted' });
    h.sellers.set(newId(), { name: 'C', status: 'suspended' });
    const created = await h.admin('POST', '/pages', { kind: 'about', title: 'About Marketly', slug: `about-${newId().slice(0, 6)}`, blocks: [{ id: 'intro', type: 'text', body: '<p>Hello</p>', products: [] }] });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().summary.id;
    expect((await h.admin('POST', `/pages/${id}/publish`)).statusCode).toBe(200);
    const page = (await h.store('GET', `/pages/${created.json().summary.slug}`)).json();
    expect(page.about).toEqual({ company: null, approvedSellerCount: 2 });
  });
});

describe('Help Center', () => {
  let catSlug: string;
  let sellerArticle: { id: string; slug: string };
  let customerArticle: { slug: string };
  const author = newId();
  const reviewer = newId();

  it('says who wrote a draft and whether the caller can approve it (G65b)', async () => {
    const cat = (await h.admin('POST', '/help/categories', { name: `Selling ${newId().slice(0, 4)}`, audience: 'both' })).json();
    catSlug = cat.slug;
    const created = await h.admin('POST', '/help/articles', { title: 'Payout schedule', categoryId: cat.id, body: '<p>Payouts run weekly.</p>', audience: 'seller', tables: [{ columns: ['Day', 'Run'], rows: [['Monday', 'Weekly payout']] }] }, h.staff(author));
    expect(created.statusCode, created.body).toBe(201);
    sellerArticle = { id: created.json().article.id, slug: created.json().article.slug };
    expect(created.json()).toMatchObject({ draftAuthor: { kind: 'staff', id: author, name: 'Dana Content' }, canApprove: false });
    expect((await h.admin('POST', `/help/articles/${sellerArticle.id}/transition`, { action: 'submit' }, h.staff(author))).statusCode).toBe(200);
    expect((await h.admin('GET', `/help/articles/${sellerArticle.id}`, undefined, h.staff(author))).json().canApprove).toBe(false);
    expect((await h.admin('GET', `/help/articles/${sellerArticle.id}`, undefined, h.staff(reviewer))).json().canApprove).toBe(true);
    expect((await h.admin('POST', `/help/articles/${sellerArticle.id}/transition`, { action: 'approve' }, h.staff(reviewer))).statusCode).toBe(200);
    const live = await h.admin('POST', `/help/articles/${sellerArticle.id}/transition`, { action: 'publish' }, h.staff(reviewer));
    expect(live.json()).toMatchObject({ status: 'published', canApprove: false });
    // a table of another shape is refused
    const bad = await h.admin('POST', '/help/articles', { title: 'Bad table', categoryId: cat.id, body: '<p>x</p>', tables: [{ cells: 1 }] });
    expect(bad.statusCode).toBe(400);
    const cust = await h.admin('POST', '/help/articles', { title: 'Track a parcel', categoryId: cat.id, body: '<p>Open your order.</p>', audience: 'customer' }, h.staff(author));
    customerArticle = { slug: cust.json().article.slug };
    await h.admin('POST', `/help/articles/${cust.json().article.id}/transition`, { action: 'submit' }, h.staff(author));
    await h.admin('POST', `/help/articles/${cust.json().article.id}/transition`, { action: 'approve' }, h.staff(reviewer));
    await h.admin('POST', `/help/articles/${cust.json().article.id}/transition`, { action: 'publish' }, h.staff(reviewer));
  });

  it('links the topic as /help?topic= and types the tables (G31b, G20)', async () => {
    const a = (await h.store('GET', `/help/articles/${sellerArticle.slug}`)).json();
    expect(a.breadcrumb[1]).toMatchObject({ url: `/help?topic=${catSlug}`, kind: 'help' });
    expect(a.tables).toEqual([{ caption: null, columns: ['Day', 'Run'], rows: [['Monday', 'Weekly payout']], note: null }]);
    const summary = (await h.admin('GET', '/help/summary')).json();
    expect(summary.tabs).toMatchObject({ all: expect.any(Number), articles: expect.any(Number), policies: expect.any(Number), needsReview: expect.any(Number) });
  });

  it('serves seller help with the seller session (G43)', async () => {
    const seller = auth(callers.seller());
    const home = await h.call('GET', '/api/seller/content/help', undefined, seller);
    expect(home.statusCode, home.body).toBe(200);
    expect(home.json().popular.map((x: any) => x.slug)).toContain(sellerArticle.slug);
    const search = (await h.call('GET', '/api/seller/content/help/articles?q=payout', undefined, seller)).json();
    expect(search.items.map((x: any) => x.slug)).toEqual([sellerArticle.slug]);
    expect((await h.call('GET', `/api/seller/content/help/articles/${sellerArticle.slug}`, undefined, seller)).statusCode).toBe(200);
    expect((await h.call('GET', `/api/seller/content/help/articles/${customerArticle.slug}`, undefined, seller)).statusCode).toBe(404);
    expect((await h.call('POST', `/api/seller/content/help/articles/${sellerArticle.id}/feedback`, { helpful: true }, seller)).statusCode).toBe(204);
  });

  it('shows support’s contact channels without chat (G7, G31c)', async () => {
    // the seller help home reads support's seller channels
    const seller = (await h.call('GET', '/api/seller/content/help', undefined, auth(callers.seller()))).json();
    expect(seller.contact.map((c: any) => [c.kind, c.detail, c.action])).toEqual([
      ['message', 'We reply within one business day', { label: 'Write to us', url: '/seller/help/contact', kind: 'help' }],
      ['phone', '1-800-555-0136', { label: '1-800-555-0136', url: 'tel:18005550136', kind: 'external' }],
    ]);
    // kinds content does not know (such as an old chat entry) are left out; no detail or action falls back
    const channels = contactChannelsFrom(
      [
        { kind: 'chat', label: 'Chat', expectedResponse: 'About 2 minutes', hours: 'Mon–Sat' },
        { kind: 'email', label: 'Email Marketly support', expectedResponse: 'Within 1 business day', hours: 'Any time' },
      ],
      '/help/contact',
    );
    expect(channels).toEqual([{ kind: 'email', label: 'Email Marketly support', hours: 'Any time', detail: 'Within 1 business day', action: { label: 'Write to us', url: '/help/contact', kind: 'help' } }]);
  });
});

describe('content.view (G77)', () => {
  it('reads admin content with the view key; editing keeps its manage key', async () => {
    const viewer = h.staff(newId(), ['content.view']);
    expect((await h.admin('GET', '/homepage', undefined, viewer)).statusCode).toBe(200);
    expect((await h.admin('GET', '/pages', undefined, viewer)).statusCode).toBe(200);
    expect((await h.admin('GET', '/help/summary', undefined, viewer)).statusCode).toBe(200);
    expect((await h.admin('GET', '/policies', undefined, viewer)).statusCode).toBe(200);
    expect((await h.admin('POST', '/help/categories', { name: 'Nope', audience: 'customer' }, viewer)).statusCode).toBe(403);
    expect((await h.admin('GET', '/homepage', undefined, h.staff(newId(), ['content.homepage.manage']))).statusCode).toBe(403);
  });
});
