import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffHtml, isSafeUrl, nextMinorVersion, sanitizeHtml, scheduleLabel, slugify } from '../domain/rules.js';
import { auth, callers, DAY, harness, inMs, type Harness } from './helpers.js';

describe('content rules', () => {
  it('sanitizes rich text to an allow-list', () => {
    expect(sanitizeHtml('<p>Hi<script>alert(1)</script></p>')).toBe('<p>Hi</p>');
    expect(sanitizeHtml('<a href="JaVaScRiPt:alert(1)">x</a><a href="jav&#x61;script:alert(1)">y</a>')).toBe('<a>x</a><a>y</a>');
    expect(sanitizeHtml('<a href="https://marketly.example/help" target="_blank" onclick="x()">ok</a>')).toBe('<a href="https://marketly.example/help" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(sanitizeHtml('<img src=x onerror=alert(1)><svg><script>bad</script></svg><style>p{}</style>text')).toBe('text');
    expect(sanitizeHtml('<ul><li>one<li>two</ul><strong>bold')).toBe('<ul><li>one<li>two</li></li></ul><strong>bold</strong>');
    expect(sanitizeHtml('5 < 6 & "quotes"')).toBe('5 &lt; 6 &amp; "quotes"');
    const once = sanitizeHtml('<p style="color:red" class="x">a<!-- c --></p>');
    expect(once).toBe('<p>a</p>');
    expect(sanitizeHtml(once)).toBe(once);
  });

  it('accepts only safe links', () => {
    expect(['/deals', '#top', 'https://x.example', 'mailto:help@x.example', 'tel:+15035550100'].every(isSafeUrl)).toBe(true);
    expect(['javascript:alert(1)', '//evil.example', 'data:text/html,x', ' java\tscript:x', ''].some(isSafeUrl)).toBe(false);
  });

  it('numbers versions, slugs titles, labels schedules and diffs texts', () => {
    expect(nextMinorVersion([])).toBe('1.0');
    expect(nextMinorVersion(['1.0', '3.0', '2.9'])).toBe('3.1');
    expect(slugify('Home Week: Lamps & Rugs!')).toBe('home-week-lamps-and-rugs');
    expect(scheduleLabel(new Date('2026-10-09T13:00:00Z'), new Date('2026-10-31T07:00:00Z'), 'America/Los_Angeles')).toBe('Oct 9, 6:00 AM – Oct 31');
    expect(scheduleLabel(null, null, 'America/Los_Angeles')).toBe('Always on');
    expect(diffHtml('<p>Return within 30 days.</p>', '<p>Return within 45 days.</p>')).toBe('Return within <del>30</del><ins>45</ins> days.');
  });
});

describe('navigation', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h?.app.close();
  });

  it('replaces header and footer links and shows the service strip only inside its window', async () => {
    const empty = (await h.store('GET', '/navigation')).json();
    expect(empty).toMatchObject({ header: [], footer: [], serviceStrip: null });
    expect(empty.companyLine).toMatch(/Marketly/);
    const bad = await h.admin('PUT', '/navigation', { header: [{ label: 'x', url: 'javascript:alert(1)' }], footer: [] });
    expect(bad.json().error.details.issues[0].path).toBe('header[0].url');
    const body = {
      header: [
        { label: 'Deals', url: '/deals', kind: 'deals' },
        { label: 'Help', url: '/help', kind: 'help' },
      ],
      footer: [
        { title: 'Shop', links: [{ label: 'New arrivals', url: '/collections/new-arrivals', kind: 'collection' }] },
        { title: 'Policies', links: [{ label: 'Returns', url: '/policies/returns', kind: 'policy' }, { label: 'Privacy', url: '/policies/privacy', kind: 'policy' }] },
      ],
      serviceStrip: { text: 'Free delivery on Official Store orders over $35', link: { label: 'Delivery details', url: '/policies/shipping', kind: 'policy' }, activeFrom: inMs(h, DAY) },
      reason: 'Autumn update',
    };
    const res = await h.admin('PUT', '/navigation', body);
    expect(res.statusCode).toBe(200);
    expect(res.json().serviceStrip.text).toMatch(/Free delivery/);
    const nav = (await h.store('GET', '/navigation')).json();
    expect(nav.header).toEqual(body.header);
    expect(nav.footer).toEqual(body.footer);
    expect(nav.serviceStrip).toBeNull();
    expect(nav.contact.map((c: any) => c.kind)).toEqual(['message']); // no live chat (G7); no phone without settings
    h.clock.advance(DAY + 1000);
    expect((await h.store('GET', '/navigation', undefined, auth(callers.visitor()))).json().serviceStrip).toMatchObject({ text: body.serviceStrip.text, link: body.serviceStrip.link });
    expect(h.audits.find((a) => a.action === 'content.navigation.update')).toMatchObject({ reason: 'Autumn update' });
  });

  it('runs every job on an empty store and ignores decisions and events about unknown records', async () => {
    for (const job of ['content.run-schedules', 'content.policy-effective', 'content.refresh-collections', 'content.article-review-due', 'content.cache-warm'] as const) {
      await expect(h.app.kernel.jobs.runNow(job)).resolves.toBeUndefined();
    }
    await h.decide('6d1b1f0e-1a2b-4c3d-8e4f-0000000000ff', 'content.policies.approve', { id: '6d1b1f0e-1a2b-4c3d-8e4f-0000000000fe' }, 'approved');
    h.app.kernel.events.publish('catalog', 'catalog.product.publication_changed', { productId: '6d1b1f0e-1a2b-4c3d-8e4f-0000000000fd', from: 'active', to: 'suspended', reason: 'x' });
    h.app.kernel.events.publish('promotions', 'promotions.campaign.started', { campaignId: '6d1b1f0e-1a2b-4c3d-8e4f-0000000000fc', kind: 'flash_sale', offerIds: [], endsAt: inMs(h, DAY) });
    await h.app.kernel.events.drain();
    expect((await h.store('GET', '/home')).statusCode).toBe(200);
  });

  it('serves help and pages over GraphQL', async () => {
    const cat = (await h.admin('POST', '/help/categories', { name: 'Orders', audience: 'customer' })).json();
    const a = (await h.admin('POST', '/help/articles', { title: 'Track a package', categoryId: cat.id, body: '<p>Open your order.</p>', topics: ['delivery_late'] }, h.staff())).json();
    await h.admin('POST', `/help/articles/${a.article.id}/transition`, { action: 'submit' });
    // the reviewer is someone else
    await h.admin('POST', `/help/articles/${a.article.id}/transition`, { action: 'approve' }, h.staff('6d1b1f0e-1a2b-4c3d-8e4f-000000000001'));
    await h.admin('POST', `/help/articles/${a.article.id}/transition`, { action: 'publish' });
    const page = (await h.admin('POST', '/pages', { kind: 'landing', title: 'Gift guide', seoTitle: 'Gifts', blocks: [{ id: 'chips', type: 'chips', items: ['Under $25'], products: [] }] })).json();
    await h.admin('POST', `/pages/${page.summary.id}/publish`);
    const query = `{
      helpCenter { topics { name audience articleCount } popular { title category { name } } contact { kind action { kind } } sellerFirstNote }
      helpArticle(slug: "track-a-package") { title category { name } related { id } tables version }
      contentPage(slug: "gift-guide") { kind title seoTitle blocks { type items products { badge } } version }
    }`;
    const res = await h.app.inject({ method: 'POST', url: '/graphql/store', headers: auth(callers.visitor()), payload: { query } });
    const body = res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.helpCenter.topics).toEqual([{ name: 'Orders', audience: 'CUSTOMER', articleCount: 1 }]);
    expect(body.data.helpCenter.popular[0]).toEqual({ title: 'Track a package', category: { name: 'Orders' } });
    expect(body.data.helpArticle).toMatchObject({ title: 'Track a package', version: 1, tables: [] });
    expect(body.data.contentPage).toEqual({ kind: 'LANDING', title: 'Gift guide', seoTitle: 'Gifts', blocks: [{ type: 'CHIPS', items: ['Under $25'], products: [] }], version: 1 });
    const admin = await h.app.inject({ method: 'POST', url: '/graphql/admin', headers: h.staff(), payload: { query: `{ contentPagePreview(id: "${page.summary.id}") { title } homePagePreview(useDraft: true) { version } }` } });
    expect(admin.json().errors).toBeUndefined();
    expect(admin.json().data.contentPagePreview.title).toBe('Gift guide');
  });
});
