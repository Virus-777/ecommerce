/**
 * Flow 3d, store content: what the store needs before anyone signs up. Without it the sign-up page fails ("Policy
 * not found": it loads GET /api/store/content/policies/purchase_terms) and the homepage, header and footer, help
 * center, About page and policy pages are empty. Everything goes through the Admin Center API as real staff do it:
 *
 *   - the five policies the store links to (content-data.ts POLICIES): the Content Manager writes and submits each
 *     version, the second Content Manager approves it as the policy owner, a Business Owner gives the final approval
 *     (an access approval request), and the version is scheduled effective now, so it is in force at once;
 *   - header and footer navigation and the service strip;
 *   - help categories and articles: written by one Content Manager, approved by the other (the author cannot
 *     approve their own article), then published;
 *   - the About page (text blocks, no images): submitted, approved and published;
 *   - the homepage, built from what the earlier flows made (categories, products, sellers): a section is left out
 *     when its data is missing; then published as a new version.
 *
 * Why two Content Managers: the Business Owner role holds no content permissions (access/domain/seed.ts), so the
 * owners cannot write content; they only give the policies' final approval.
 *
 * Runs again on the same database without duplicates: what is already in force or published is left alone (a
 * policy with a current version, a help category or article with the same slug or title, the About page, a homepage
 * section with the same kind and heading). The texts are samples (see content-data.ts).
 */
import { ABOUT_PAGE, CONTENT_TZ, HELP_ARTICLES, HELP_CATEGORIES, POLICIES, PROMISE_ITEMS, STORE_POLICY_KEYS } from '../content-data.js';
import { CATEGORIES } from '../data.js';
import type { Session } from '../http.js';
import type { Staff } from '../people.js';
import type { Sim } from '../sim.js';

/* ---------------------------------------------------------------- the parts of the API answers the flow reads */

interface PolicySummary {
  id: string;
  key: string;
  current?: { version: string } | null;
}

interface PolicyVersion {
  id: string;
  version: string;
  state: 'draft' | 'in_review' | 'approved' | 'scheduled' | 'current' | 'superseded' | 'withdrawn';
  approvals: { role: 'policy_owner' | 'business_owner'; state: string }[];
  approval?: { approvalRequestId?: string | null } | null;
}

interface ApprovalRequest {
  status: string;
  amount?: unknown;
  canDecide: boolean;
}

interface HelpArticleAdmin {
  article: { id: string; slug: string; title: string };
  status: string;
}

interface PageAdmin {
  summary: { id: string; slug: string; status: string };
}

interface HomepageAdmin {
  liveVersion: number;
  hasDraft: boolean;
  draftReview: { state: string };
  sections: { id: string; kind: string; title: string; status: string; config?: { heading?: string | null } | null }[];
}

interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  parentId?: string | null;
  children?: CategoryNode[];
}

/* ---------------------------------------------------------------- the flow */

export async function contentFlow(sim: Sim): Promise<void> {
  const { run, world: w } = sim;
  const writer = w.staff.content!;
  const reviewer = w.staff.contentReviewer!;
  const visitor = await sim.people.visitor('store', 'web', 'visitor (content)');
  // each part on its own: a refused step in one part is recorded (and fails the flow) without hiding the others
  await run.attempt('policies', () => policies(sim, writer, reviewer, visitor));
  await run.attempt('navigation', () => navigation(sim, writer, visitor));
  await run.attempt('help center', () => helpCenter(sim, writer, reviewer, visitor));
  await run.attempt('About page', () => aboutPage(sim, writer, reviewer, visitor));
  await run.attempt('homepage', () => homepage(sim, writer, reviewer, visitor));
}

/* ---------------------------------------------------------------- policies */

/**
 * Each policy: created once (the reviewing Content Manager is its policy owner, the writing one its editor), then
 * version 1.0 is written, submitted, approved by the policy owner and by a Business Owner, and scheduled effective
 * now. A policy that already has a version in force is skipped; an open version from an interrupted run is taken
 * up where it stopped.
 */
async function policies(sim: Sim, writer: Staff, reviewer: Staff, visitor: Session): Promise<void> {
  const { api, run } = sim;
  const list = (await api.call(writer.session, 'GET', '/api/admin/content/policies')) as PolicySummary[];
  for (const p of POLICIES) {
    let pol = list.find((x) => x.key === p.key);
    if (pol?.current) continue;
    if (!pol) {
      pol = (await api.call(writer.session, 'POST', '/api/admin/content/policies', {
        key: p.key,
        kind: p.key,
        title: p.title,
        ownerStaffId: reviewer.accountId,
        editorStaffId: writer.accountId,
        audience: p.audience,
      })) as PolicySummary;
    }
    const versions = (await api.call(writer.session, 'GET', `/api/admin/content/policies/${pol.id}/versions`)) as PolicyVersion[];
    let v = versions.find((x) => ['draft', 'in_review', 'approved', 'scheduled'].includes(x.state));
    // the first version is 1.0; after a withdrawn one the server picks the next number
    if (!v) v = (await api.call(writer.session, 'POST', `/api/admin/content/policies/${pol.id}/versions`, versions.some((x) => x.version === '1.0') ? {} : { version: '1.0' })) as PolicyVersion;
    if (v.state === 'draft') {
      await api.call(writer.session, 'PATCH', `/api/admin/content/policy-versions/${v.id}`, {
        title: p.title,
        body: p.body,
        changeSummary: 'First published version',
        impact: 'new_orders_only',
        notifyCustomers: false,
        notifySellers: false,
      });
      v = (await api.call(writer.session, 'POST', `/api/admin/content/policy-versions/${v.id}/submit`)) as PolicyVersion;
    }
    // the policy owner's step. A Content Manager can only recommend the final approval (access limit), so this
    // raises an approval request for the Business Owner and the version stays in review
    const ownerApproved = v.approvals.some((a) => a.role === 'policy_owner' && a.state === 'approved');
    if (v.state === 'in_review' && !ownerApproved) {
      v = (await api.call(reviewer.session, 'POST', `/api/admin/content/policy-versions/${v.id}/approve`, { approve: true, note: 'Checked against the returns and shipping settings' })) as PolicyVersion;
    }
    if (v.state === 'in_review' && v.approval?.approvalRequestId) {
      await businessOwnerApproves(sim, v.approval.approvalRequestId, `${p.title} ${v.version}`);
      // access tells content when the request is decided (an event; the client waited for consumers)
      v = (await api.call(writer.session, 'GET', `/api/admin/content/policy-versions/${v.id}`)) as PolicyVersion;
    }
    run.check(`${p.title} ${v.version} approved by the policy owner and a Business Owner`, v.state === 'approved' || v.state === 'scheduled', { state: v.state, approvals: v.approvals });
    // effective now: a first version is no change to existing terms, so no notice period applies. A date that is
    // not in the future makes the version current at once (the server runs the effective-date step itself)
    if (v.state === 'approved') v = (await api.call(writer.session, 'POST', `/api/admin/content/policy-versions/${v.id}/schedule`, { effectiveAt: new Date().toISOString() })) as PolicyVersion;
  }
  // the scheduled job a production server runs every few minutes (development servers run none): it makes any
  // scheduled version whose date has passed current, e.g. one an interrupted earlier run left scheduled
  await sim.job('content.policy-effective');

  const after = (await api.call(writer.session, 'GET', '/api/admin/content/policies')) as PolicySummary[];
  for (const key of STORE_POLICY_KEYS) run.check(`policy ${key} has a version in force`, Boolean(after.find((x) => x.key === key)?.current), after.find((x) => x.key === key) ?? 'no such policy');
  // what the store's sign-up page loads
  const terms = await api.call(visitor, 'GET', '/api/store/content/policies/purchase_terms');
  run.check('the store loads the purchase terms (sign-up page)', terms.key === 'purchase_terms' && terms.body.length > 0, { key: terms.key, version: terms.version });
}

/**
 * The Business Owner's final approval of a policy version: an access approval request raised by the policy owner,
 * decided by an owner who did not raise it (the requester can never decide their own request).
 */
async function businessOwnerApproves(sim: Sim, requestId: string, what: string): Promise<void> {
  const { api, world: w } = sim;
  for (const owner of [w.owner!, w.deputy!]) {
    const r = (await api.call(owner.session, 'GET', `/api/admin/access/approval-requests/${requestId}`)) as ApprovalRequest;
    if (r.status !== 'pending' && r.status !== 'partially_approved') return;
    if (!r.canDecide) continue;
    // the password again is needed only to approve money above access stepUpAbove; a policy version has no amount,
    // so the API asks for none (sending one would only spend a re-auth token)
    const reauthToken = r.amount ? await sim.people.reauth(owner, 'approval') : undefined;
    await api.call(owner.session, 'POST', `/api/admin/access/approval-requests/${requestId}/approve`, { note: `Approved as Business Owner: ${what}`, ...(reauthToken ? { reauthToken } : {}) });
  }
}

/* ---------------------------------------------------------------- navigation */

/**
 * Header (top-level categories, Deals, Official Store), footer groups and the service strip. A PUT replaces them,
 * so a later run only saves when what the store shows differs (labels and links).
 */
async function navigation(sim: Sim, writer: Staff, visitor: Session): Promise<void> {
  const { api, run } = sim;
  const flat = (nodes: CategoryNode[]): CategoryNode[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
  const cats = flat((await api.call(visitor, 'GET', '/api/store/catalog/categories')) as CategoryNode[]);
  const header = CATEGORIES.map((c) => cats.find((x) => x.name === c.name && !x.parentId))
    .filter((c): c is CategoryNode => Boolean(c))
    .map((c) => ({ label: c.name, url: `/c/${c.slug}`, kind: 'category' }));
  header.push({ label: 'Deals', url: '/deals', kind: 'deals' }, { label: 'Official Store', url: '/official', kind: 'page' });
  const footer = [
    { title: 'Shop', links: [{ label: 'All categories', url: '/categories', kind: 'page' }, { label: 'Deals', url: '/deals', kind: 'deals' }, { label: 'Official Store', url: '/official', kind: 'page' }] },
    { title: 'Help', links: [{ label: 'Help Center', url: '/help', kind: 'help' }, { label: 'Returns', url: '/policies/returns', kind: 'policy' }, { label: 'Shipping', url: '/policies/shipping', kind: 'policy' }] },
    { title: 'Sell on Marketly', links: [{ label: 'Start selling', url: '/sell', kind: 'page' }, { label: 'Seller rules', url: '/policies/seller_rules', kind: 'policy' }] },
    { title: 'Marketly', links: [{ label: 'About us', url: '/about', kind: 'page' }, { label: 'Privacy', url: '/policies/privacy', kind: 'policy' }, { label: 'Purchase terms', url: '/policies/purchase_terms', kind: 'policy' }] },
  ];
  const serviceStrip = { text: 'Free delivery on Official Store orders over $35 · 30-day returns on most items', link: { label: 'Delivery details', url: '/policies/shipping', kind: 'policy' } };

  type Link = { label: string; url: string };
  type Nav = { header: Link[]; footer: { title: string; links: Link[] }[]; serviceStrip?: { text: string } | null };
  const signature = (n: Nav) => JSON.stringify([n.header.map((l) => `${l.label} ${l.url}`), n.footer.map((g) => [g.title, g.links.map((l) => `${l.label} ${l.url}`)]), n.serviceStrip?.text ?? null]);
  const shown = (await api.call(visitor, 'GET', '/api/store/content/navigation')) as Nav;
  if (signature(shown) === signature({ header, footer, serviceStrip })) return run.pass();

  const saved = await api.call(writer.session, 'PUT', '/api/admin/content/navigation', { header, footer, serviceStrip, reason: 'Store launch navigation' });
  // the strip text is compared with the shipping and returns settings: a mismatch is a warning, never a refusal
  for (const c of (saved.checks ?? []) as { state: string; label: string; detail?: string | null }[]) {
    if (c.state === 'warn' || c.state === 'fail') api.notes.push(`navigation: ${c.label}${c.detail ? ` (${c.detail})` : ''}`);
  }
  const now = (await api.call(visitor, 'GET', '/api/store/content/navigation')) as Nav;
  run.check('the store shows the new header and footer', signature(now) === signature({ header, footer, serviceStrip }), now);
}

/* ---------------------------------------------------------------- help center */

/** Help categories (by slug), then each article: written by one Content Manager, approved by the other, published */
async function helpCenter(sim: Sim, writer: Staff, reviewer: Staff, visitor: Session): Promise<void> {
  const { api, run } = sim;
  const existing = (await api.call(writer.session, 'GET', '/api/admin/content/help/categories')) as { id: string; slug: string; name: string }[];
  const categoryId = new Map<string, string>();
  for (const c of HELP_CATEGORIES) {
    let cat = existing.find((x) => x.slug === c.key) ?? existing.find((x) => x.name === c.name);
    // new categories are added at the end, so they keep this list's order
    if (!cat) cat = await api.call(writer.session, 'POST', '/api/admin/content/help/categories', { name: c.name, slug: c.key, icon: c.icon, description: c.description, audience: c.audience, visible: true });
    categoryId.set(c.key, cat!.id);
  }

  for (const a of HELP_ARTICLES) {
    const found = (await api.call(writer.session, 'GET', `/api/admin/content/help/items?type=article&q=${encodeURIComponent(a.title)}&limit=20`)).items as { id: string; title: string; status: string }[];
    const hit = found.find((x) => x.title === a.title && x.status !== 'removed');
    let art = (
      hit
        ? await api.call(writer.session, 'GET', `/api/admin/content/help/articles/${hit.id}`)
        : await api.call(writer.session, 'POST', '/api/admin/content/help/articles', {
            title: a.title,
            slug: a.key,
            categoryId: categoryId.get(a.category),
            summary: a.summary,
            body: a.body,
            policyKeys: a.policyKeys ?? [],
            audience: a.audience ?? 'customer',
            ownerStaffId: writer.accountId,
            featured: a.featured ?? false,
            ...(a.popularSearch ? { popularSearch: a.popularSearch } : {}),
            changeNote: 'First version',
          })
    ) as HelpArticleAdmin;
    if (art.status === 'published') continue;
    const id = art.article.id;
    const step = async (who: Staff, action: 'submit' | 'approve' | 'publish') => (art = (await api.call(who.session, 'POST', `/api/admin/content/help/articles/${id}/transition`, { action })) as HelpArticleAdmin);
    if (art.status === 'draft') await step(writer, 'submit');
    // the author cannot approve their own article (SAME_REVIEWER)
    if (art.status === 'in_review') await step(reviewer, 'approve');
    if (art.status === 'approved' || art.status === 'unpublished') await step(writer, 'publish');
    run.check(`help article "${a.title}" is published`, art.status === 'published', art.status);
  }
  const first = HELP_ARTICLES.find((a) => (a.audience ?? 'customer') === 'customer')!;
  const shown = await api.call(visitor, 'GET', `/api/store/content/help/articles/${first.key}`);
  run.check('the store shows a help article', shown.title === first.title, shown.title);
}

/* ---------------------------------------------------------------- About page */

/** The About page: created once by the writer, sent for review, approved and published by the reviewer */
async function aboutPage(sim: Sim, writer: Staff, reviewer: Staff, visitor: Session): Promise<void> {
  const { api, run } = sim;
  const pages = (await api.call(writer.session, 'GET', '/api/admin/content/pages?kind=about&limit=50')).items as { id: string; slug: string; status: string }[];
  const id0 = pages.find((p) => p.slug === ABOUT_PAGE.slug && p.status !== 'removed')?.id;
  let page = (
    id0
      ? await api.call(writer.session, 'GET', `/api/admin/content/pages/${id0}`)
      : await api.call(writer.session, 'POST', '/api/admin/content/pages', {
          kind: 'about',
          slug: ABOUT_PAGE.slug,
          title: ABOUT_PAGE.title,
          eyebrow: ABOUT_PAGE.eyebrow,
          intro: ABOUT_PAGE.intro,
          // product lists are resolved on read; text blocks have none
          blocks: ABOUT_PAGE.blocks.map((b) => ({ ...b, products: [] })),
          seoTitle: ABOUT_PAGE.title,
          seoDescription: ABOUT_PAGE.intro,
          ownerStaffId: writer.accountId,
          changeNote: 'First version',
        })
  ) as PageAdmin;
  const id = page.summary.id;
  // review is optional for pages (setting content.reviewRequired.page), but always allowed: submit, approve, publish
  if (page.summary.status === 'draft') page = (await api.call(writer.session, 'POST', `/api/admin/content/pages/${id}/submit`)) as PageAdmin;
  if (page.summary.status === 'in_review') page = (await api.call(reviewer.session, 'POST', `/api/admin/content/pages/${id}/approve`, { approve: true })) as PageAdmin;
  if (page.summary.status === 'approved' || page.summary.status === 'unpublished') page = (await api.call(reviewer.session, 'POST', `/api/admin/content/pages/${id}/publish`)) as PageAdmin;
  run.check('the About page is published', page.summary.status === 'published', page.summary);
  const shown = await api.call(visitor, 'GET', `/api/store/content/pages/${ABOUT_PAGE.slug}`);
  run.check('the store shows the About page', shown.title === ABOUT_PAGE.title, shown.title);
}

/* ---------------------------------------------------------------- homepage */

/**
 * Homepage sections from what the earlier flows made: category shortcuts (the category tree), featured products
 * (this run's products), new arrivals and best sellers (rules), featured sellers (this run's sellers) and the
 * promise strip. A section with the same kind and heading is kept as it is. Published only when this run added a
 * section, or when the homepage was never published (a draft someone else is preparing is left alone).
 */
async function homepage(sim: Sim, writer: Staff, reviewer: Staff, visitor: Session): Promise<void> {
  const { api, run, world: w } = sim;
  let admin = (await api.call(writer.session, 'GET', '/api/admin/content/homepage')) as HomepageAdmin;
  const has = (kind: string, heading: string) => admin.sections.some((s) => s.status !== 'removed' && s.kind === kind && (s.config?.heading ?? s.title) === heading);

  const categoryIds = CATEGORIES.flatMap((c) => [c.name, ...c.children])
    .map((name) => w.categories.get(name))
    .filter((id): id is string => Boolean(id));
  const productIds = [...new Set([...w.official, ...w.sellers.flatMap((s) => s.offers)].map((o) => o.productId))].slice(0, 8);
  const sellerIds = w.sellers.map((s) => s.sellerId);
  // the sections in page order; one whose data is missing is left out
  const wanted: ({ kind: string; heading: string } & Record<string, unknown>)[] = [];
  if (categoryIds.length) wanted.push({ kind: 'category_shortcuts', heading: 'Shop by category', categoryIds });
  if (productIds.length) {
    wanted.push(
      { kind: 'featured_products', heading: 'Featured products', subheading: 'Picked by the Marketly team', productSource: { mode: 'manual', productIds } },
      { kind: 'new_arrivals', heading: 'New arrivals', productSource: { mode: 'rule', rule: { kind: 'new_arrivals', days: 30, description: 'Products added in the last 30 days, newest first' }, limit: 12 } },
      {
        kind: 'popular_products',
        heading: 'Popular right now',
        productSource: { mode: 'rule', rule: { kind: 'best_sellers', days: 30, description: 'Ranked by units sold in the last 30 days across all sellers. Sponsored placements don’t affect rank.' }, limit: 12 },
      },
    );
  }
  if (sellerIds.length) wanted.push({ kind: 'featured_sellers', heading: 'Featured sellers', subheading: 'Independent shops checked by Marketly', sellerIds });
  wanted.push({ kind: 'promise_strip', heading: 'Shopping on Marketly', promiseItems: PROMISE_ITEMS });

  let added = 0;
  for (const s of wanted) {
    if (has(s.kind, s.heading)) continue;
    await api.call(writer.session, 'POST', '/api/admin/content/homepage/sections', { ...s, timeZone: CONTENT_TZ, ownerStaffId: writer.accountId });
    added++;
  }
  admin = (await api.call(writer.session, 'GET', '/api/admin/content/homepage')) as HomepageAdmin;
  if (admin.hasDraft && (added > 0 || admin.liveVersion === 0)) {
    const summary = 'Store launch homepage: categories, featured products and sellers, our promises';
    // with section review on (setting content.reviewRequired.section) the writer submits and the reviewer approves
    // first; the one who submitted or last edited the draft cannot approve it
    if (admin.draftReview.state === 'not_submitted' || admin.draftReview.state === 'changes_requested') admin = (await api.call(writer.session, 'POST', '/api/admin/content/homepage/submit', { summary })) as HomepageAdmin;
    if (admin.draftReview.state === 'in_review') admin = (await api.call(reviewer.session, 'POST', '/api/admin/content/homepage/review', { approve: true, note: 'Looks good' })) as HomepageAdmin;
    admin = (await api.call(reviewer.session, 'POST', '/api/admin/content/homepage/publish', { summary })) as HomepageAdmin;
  }
  run.check('the homepage has a published version', admin.liveVersion >= 1, { liveVersion: admin.liveVersion, hasDraft: admin.hasDraft });
  const home = await api.call(visitor, 'GET', '/api/store/content/home');
  run.check('the store homepage shows sections', (home.sections as unknown[]).length > 0, home.sections);
}
