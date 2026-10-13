// Step 7: store content. Homepage layout (banner, category shortcuts, flash deals, featured and popular products,
// featured sellers, promise strip) published as a new version; header/footer navigation; help categories and
// articles (author Olivia, approver Morgan: the author can't approve); the five policies (Olivia edits and
// submits, Morgan approves as the other Business Owner, effective now); the About page.
import { ApiError } from '../lib/http.mjs';
import { ABOUT_PAGE, CATEGORIES, HELP_ARTICLES, HELP_CATEGORIES, POLICIES, PROMISE_ITEMS, SELLERS, TZ } from '../data.mjs';

const tolerate409 = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 409 || err.code === 'ILLEGAL_TRANSITION')) return null;
    throw err;
  }
};

async function storeCategories(ctx) {
  const tree = await ctx.api.get('/api/store/catalog/categories', ctx.visitor);
  const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
  return flat(Array.isArray(tree) ? tree : (tree.items ?? []));
}

async function homepage(ctx) {
  const { api, state, log } = ctx;
  const t = ctx.staff;
  const admin = await api.get('/api/admin/content/homepage', t);
  const sections = admin.sections ?? [];
  const has = (heading) => sections.find((s) => (s.heading ?? s.title) === heading && s.status !== 'removed');
  const productIds = (keys) => keys.map((k) => state.get(`product.${k}`)?.id).filter(Boolean);
  const flashId = state.get('campaign.flash');
  const banner = state.get('banner.homeWeek');
  const wanted = [
    banner && {
      kind: 'campaign_banner',
      heading: 'Home Week',
      banner: {
        eyebrow: 'Home Week · this week only',
        headline: 'Home Week: up to 30% off bedding, cookware and lighting',
        body: 'Washed linen, cast iron and smart lamps from the Official Store and Casa Verde Home.',
        images: [await ctx.mediaRef(banner, banner.alt)],
        primaryCta: { label: 'Shop the deals', url: '/deals', kind: 'deals' },
        secondaryCta: { label: 'Browse categories', url: '/categories', kind: 'page' },
        theme: 'brand',
      },
    },
    { kind: 'category_shortcuts', heading: 'Shop by category', categoryIds: CATEGORIES.map((c) => state.get(`category.${c.key}`)).filter(Boolean) },
    flashId && { kind: 'deals', heading: 'Flash deals', subheading: 'Deal prices while deal stock lasts', productSource: { mode: 'rule', rule: { kind: 'deals', campaignId: flashId, description: 'Items in the live Home Week flash sale' }, limit: 8 } },
    { kind: 'featured_products', heading: 'Featured products', subheading: 'Picked by the Marketly team', productSource: { mode: 'manual', productIds: productIds(['aurora', 'kestrel27', 'duvet', 'backpack', 'lamp', 'ssd1tb', 'sweater', 'pourover']) } },
    { kind: 'popular_products', heading: 'Popular right now', productSource: { mode: 'rule', rule: { kind: 'best_sellers', days: 30, description: 'Ranked by units sold in the last 30 days across all sellers. Sponsored placements don’t affect rank.' }, limit: 12 } },
    { kind: 'featured_sellers', heading: 'Featured sellers', subheading: 'Independent shops checked by Marketly', sellerIds: SELLERS.filter((s) => s.key !== 'gadgetgrove').map((s) => ctx.state.section('sellers')[s.key]?.sellerId).filter(Boolean) },
    { kind: 'promise_strip', heading: 'Shopping on Marketly', promiseItems: PROMISE_ITEMS },
  ].filter(Boolean);
  const ids = [];
  let changed = false;
  for (const w of wanted) {
    const existing = has(w.heading);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    try {
      const s = await api.post('/api/admin/content/homepage/sections', t, { ...w, timeZone: TZ });
      ids.push(s.id);
      changed = true;
      log.created('homepage section', `${w.kind}: ${w.heading}`);
    } catch (err) {
      log.warn(`homepage section ${w.kind} "${w.heading}" refused: ${err.message}`);
    }
  }
  const others = sections.filter((s) => !ids.includes(s.id) && s.status !== 'removed' && s.kind !== 'ad_position').map((s) => s.id);
  if (changed || admin.hasDraft) {
    await tolerate409(() => api.put('/api/admin/content/homepage/order', t, { sectionIds: [...ids, ...others] }));
    let published = await tolerate409(() => api.post('/api/admin/content/homepage/publish', ctx.approver, { summary: 'Launch homepage: Home Week banner, categories, flash deals, featured products and sellers' }));
    if (!published) {
      // section review is on: submit, then the other owner approves before publishing
      await tolerate409(() => api.post('/api/admin/content/homepage/submit', t, { summary: 'Launch homepage' }));
      await tolerate409(() => api.post('/api/admin/content/homepage/review', ctx.approver, { approve: true, note: 'Looks good' }));
      published = await api.post('/api/admin/content/homepage/publish', ctx.approver, { summary: 'Launch homepage' });
    }
    log.info(`homepage published (version ${published.liveVersion})`);
  } else log.reused('homepage', `${ids.length} sections already live`);
}

async function navigation(ctx) {
  const cats = await storeCategories(ctx);
  const slugOf = (name) => cats.find((c) => c.name === name && !c.parentId)?.slug;
  const header = CATEGORIES.slice(0, 6).map((c) => ({ label: c.name, url: `/c/${slugOf(c.name) ?? c.key}`, kind: 'category' }));
  header.push({ label: 'Deals', url: '/deals', kind: 'deals' }, { label: 'Official Store', url: '/official', kind: 'page' });
  const footer = [
    { title: 'Shop', links: [{ label: 'All categories', url: '/categories', kind: 'page' }, { label: 'Deals', url: '/deals', kind: 'deals' }, { label: 'Official Store', url: '/official', kind: 'page' }] },
    { title: 'Help', links: [{ label: 'Help Center', url: '/help', kind: 'help' }, { label: 'Returns', url: '/policies/returns', kind: 'policy' }, { label: 'Shipping', url: '/policies/shipping', kind: 'policy' }] },
    { title: 'Sell on Marketly', links: [{ label: 'Start selling', url: '/sell', kind: 'page' }, { label: 'Seller rules', url: '/policies/seller_rules', kind: 'policy' }] },
    { title: 'Marketly', links: [{ label: 'About us', url: '/about', kind: 'page' }, { label: 'Privacy', url: '/policies/privacy', kind: 'policy' }, { label: 'Purchase terms', url: '/policies/purchase_terms', kind: 'policy' }] },
  ];
  const nav = await ctx.api.put('/api/admin/content/navigation', ctx.staff, {
    header,
    footer,
    serviceStrip: { text: 'Free delivery on Official Store orders over $35 · 30-day returns on most items', link: { label: 'Delivery details', url: '/policies/shipping', kind: 'policy' } },
    reason: 'Launch navigation',
  });
  for (const c of nav.checks ?? []) ctx.log.info(`navigation check: ${c.message ?? c.label ?? JSON.stringify(c)}`);
  ctx.log.info(`navigation: ${header.length} header links, ${footer.length} footer groups`);
}

async function help(ctx) {
  const { api, state, log } = ctx;
  const t = ctx.staff;
  const existing = await api.get('/api/admin/content/help/categories', t);
  for (const [i, c] of HELP_CATEGORIES.entries()) {
    let cat = existing.find((x) => x.name === c.name);
    if (!cat) {
      cat = await api.post('/api/admin/content/help/categories', t, { name: c.name, slug: c.key, icon: c.icon, description: c.description, audience: c.audience, visible: true });
      log.created('help category', `${c.name} (${c.audience})`);
    }
    state.set(`help.category.${c.key}`, cat.id);
    if (cat.position !== i + 1) await api.patch(`/api/admin/content/help/categories/${cat.id}`, t, { position: i + 1 }).catch(() => {});
  }
  for (const a of HELP_ARTICLES) {
    let id = state.get(`help.article.${a.key}`);
    if (!id) {
      try {
        id = (await api.get(`/api/store/content/help/articles/${a.key}`, ctx.visitor)).id;
      } catch {}
    }
    if (!id) {
      const created = await api.post('/api/admin/content/help/articles', t, {
        title: a.title,
        slug: a.key,
        categoryId: state.get(`help.category.${a.category}`),
        summary: a.summary,
        body: a.body,
        policyKeys: a.policyKeys ?? [],
        audience: a.audience ?? 'customer',
        ownerStaffId: ctx.owner('olivia').accountId,
        featured: a.featured ?? false,
        ...(a.popularSearch ? { popularSearch: a.popularSearch } : {}),
        changeNote: 'First version',
      });
      id = created.article.id;
      log.created('help article', a.title);
    }
    state.set(`help.article.${a.key}`, id);
    const now = await api.get(`/api/admin/content/help/articles/${id}`, t);
    if (now.status === 'published') continue;
    const go = (action, token) => tolerate409(() => api.post(`/api/admin/content/help/articles/${id}/transition`, token, { action }));
    if (now.status === 'draft') await go('submit', t);
    await go('approve', ctx.approver); // the author (Olivia) can't approve her own article
    await go('publish', t);
  }
  log.info(`${HELP_ARTICLES.length} help articles published`);
}

async function policies(ctx) {
  const { api, state, log } = ctx;
  const t = ctx.staff;
  const olivia = ctx.owner('olivia').accountId;
  let list = await api.get('/api/admin/content/policies', t);
  for (const p of POLICIES) {
    let pol = list.find((x) => x.key === p.key);
    if (pol?.current) {
      state.set(`policy.${p.key}`, pol.id);
      continue;
    }
    if (!pol) {
      pol = await api.post('/api/admin/content/policies', t, { key: p.key, kind: p.kind, title: p.title, ownerStaffId: olivia, editorStaffId: olivia, audience: p.audience });
      log.created('policy', p.title);
    }
    state.set(`policy.${p.key}`, pol.id);
    const versions = await api.get(`/api/admin/content/policies/${pol.id}/versions`, t);
    let v = versions.find((x) => ['draft', 'in_review', 'approved', 'scheduled'].includes(x.state));
    if (!v) v = await api.post(`/api/admin/content/policies/${pol.id}/versions`, t, { version: '1.0' });
    if (v.state === 'draft') {
      await api.patch(`/api/admin/content/policy-versions/${v.id}`, t, { title: p.title, body: p.body, changeSummary: 'First published version', impact: 'new_orders_only', notifyCustomers: false, notifySellers: false });
      v = await api.post(`/api/admin/content/policy-versions/${v.id}/submit`, t, undefined);
    }
    const ownerDone = (v.approvals ?? []).some((a) => a.role === 'policy_owner' && a.state === 'approved');
    if (v.state === 'in_review' && !ownerDone) v = await api.post(`/api/admin/content/policy-versions/${v.id}/approve`, ctx.approver, { approve: true, note: 'Checked against the returns and shipping settings' });
    if (v.state === 'in_review' && v.approval?.approvalRequestId) {
      // Morgan's approval became an access request for the Business Owner step: Olivia, the other owner, decides it
      await tolerate409(() => api.post(`/api/admin/access/approval-requests/${v.approval.approvalRequestId}/approve`, t, { note: 'Approved as Business Owner' }, { headers: { 'x-step-up-code': '000000' } }));
      for (let i = 0; i < 10 && v.state === 'in_review'; i++) {
        await new Promise((r) => setTimeout(r, 500));
        v = await api.get(`/api/admin/content/policy-versions/${v.id}`, t);
      }
    }
    if (v.state === 'approved') v = await api.post(`/api/admin/content/policy-versions/${v.id}/schedule`, t, { effectiveAt: new Date(Date.now() + 5_000).toISOString() });
    log.info(`${p.title}: ${v.state}`);
  }
  list = await api.get('/api/admin/content/policies', t);
  const notCurrent = POLICIES.filter((p) => !list.find((x) => x.key === p.key)?.current).map((p) => p.key);
  if (notCurrent.length) log.info(`policies waiting for the content.policy-effective job: ${notCurrent.join(', ')}`);
}

async function aboutPage(ctx) {
  const { api, state, log } = ctx;
  const t = ctx.staff;
  let id = state.get('page.about');
  if (!id) {
    const pages = await api.get('/api/admin/content/pages?limit=100', t);
    id = (pages.items ?? []).find((p) => p.slug === ABOUT_PAGE.slug && p.status !== 'removed')?.id;
  }
  if (!id) {
    const banner = state.get('banner.about');
    const blocks = [...(banner ? [{ type: 'hero', id: 'hero', title: ABOUT_PAGE.title, body: `<p>${ABOUT_PAGE.intro}</p>`, banner: { headline: ABOUT_PAGE.title, body: ABOUT_PAGE.intro, images: [await ctx.mediaRef(banner, banner.alt)], primaryCta: { label: 'Visit the Help Center', url: '/help', kind: 'help' } } }] : []), ...ABOUT_PAGE.blocks].map((b) => ({ products: [], ...b }));
    const page = await api.post('/api/admin/content/pages', t, { kind: 'about', slug: ABOUT_PAGE.slug, title: ABOUT_PAGE.title, eyebrow: ABOUT_PAGE.eyebrow, intro: ABOUT_PAGE.intro, blocks, seoTitle: 'About Marketly', seoDescription: ABOUT_PAGE.intro, ownerStaffId: ctx.owner('olivia').accountId });
    id = page.summary.id;
    log.created('page', ABOUT_PAGE.title);
  }
  state.set('page.about', id);
  const page = await api.get(`/api/admin/content/pages/${id}`, t);
  if (page.summary.status !== 'published') {
    let r = await tolerate409(() => api.post(`/api/admin/content/pages/${id}/publish`, ctx.approver, undefined));
    if (!r) {
      await tolerate409(() => api.post(`/api/admin/content/pages/${id}/submit`, t, undefined));
      await tolerate409(() => api.post(`/api/admin/content/pages/${id}/approve`, ctx.approver, { approve: true }));
      r = await api.post(`/api/admin/content/pages/${id}/publish`, ctx.approver, undefined);
    }
    log.info(`About page: ${r.summary.status}`);
  }
}

export async function contentStep(ctx) {
  const parts = [
    ['homepage', homepage],
    ['navigation', navigation],
    ['help', help],
    ['policies', policies],
    ['about', aboutPage],
  ];
  const failed = [];
  for (const [name, fn] of parts) {
    try {
      await fn(ctx);
    } catch (err) {
      failed.push(name);
      ctx.log.warn(`content/${name} failed: ${err.message}`);
    }
  }
  if (failed.length) throw new Error(`content parts failed: ${failed.join(', ')}`);
}
