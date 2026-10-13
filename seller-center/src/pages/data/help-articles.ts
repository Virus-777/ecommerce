import { toApiError, type components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import type { IconName } from '@marketly/web-shared/ui';
import { iconOf } from './home';

// Seller help content from the content module (audience seller): help home, search, articles and
// "Was this helpful?". The help routes are store-area only (GET /api/store/content/help…), and the Seller
// Center's seller token is refused there (WRONG_AUDIENCE). Until the API serves seller help in the seller
// area, these calls use a store visitor session of their own: started with POST
// /api/public/identity/app-sessions (no cookie, token kept in memory) and started again when it expires.

export type HelpHome = components['schemas']['content.HelpHome'];
export type HelpArticle = components['schemas']['content.HelpArticle'];
export type HelpArticleSummary = components['schemas']['content.HelpArticleSummary'];
export type HelpCategory = components['schemas']['content.HelpCategory'];
export type LinkRef = components['schemas']['content.LinkRef'];

let visitor: { token: string; exp: number } | null = null;
let starting: Promise<string> | null = null;

async function startVisitor(): Promise<string> {
  const res = await fetch('/api/public/identity/app-sessions', {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json', 'X-Client': 'web', 'X-App-Proof': 'dev' },
    body: JSON.stringify({ audience: 'store', device: { kind: 'web' } }),
  });
  if (!res.ok) throw await toApiError(res);
  const t = (await res.json()) as { accessToken: string; accessTokenExpiresAt: string };
  visitor = { token: t.accessToken, exp: new Date(t.accessTokenExpiresAt).getTime() };
  return t.accessToken;
}

async function visitorToken(fresh = false): Promise<string> {
  if (!fresh && visitor && visitor.exp - Date.now() > 30_000) return visitor.token;
  return starting ?? (starting = startVisitor().finally(() => (starting = null)));
}

async function helpFetch(path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  const send = async (token: string) =>
    fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${token}`, 'X-Client': 'web', ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  let res = await send(await visitorToken());
  if (res.status === 401) res = await send(await visitorToken(true));
  return res;
}

async function helpGet<T>(path: string): Promise<T> {
  const res = await helpFetch(path);
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/** Help home for sellers: topics with their top articles, popular articles and searches, the featured guide. */
export const getHelpHome = () => helpGet<HelpHome>('/api/store/content/help?audience=seller');

/** Seller help search (title, summary, topics and body). */
export const searchHelp = (q: string, limit = 24) =>
  helpGet<{ items: HelpArticleSummary[]; nextCursor: string | null }>(`/api/store/content/help/articles?${new URLSearchParams({ q, audience: 'seller', limit: String(limit) })}`);

/** One article by slug; null when there is none, or when it is a customer-only article. */
export async function getHelpArticle(slug: string): Promise<HelpArticle | null> {
  const res = await helpFetch(`/api/store/content/help/articles/${encodeURIComponent(slug)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw await toApiError(res);
  const a = (await res.json()) as HelpArticle;
  return a.category.audience === 'customer' ? null : a;
}

/** "Was this helpful?" */
export async function rateHelpArticle(id: string, helpful: boolean, comment?: string): Promise<void> {
  const res = await helpFetch(`/api/store/content/help/articles/${id}/feedback`, { method: 'POST', body: { helpful, ...(comment ? { comment } : {}) } });
  if (!res.ok) throw await toApiError(res);
}

/** Query keys (module first). */
export const helpKeys = {
  home: ['content', 'help', 'seller'] as const,
  search: (q: string) => ['content', 'help', 'seller', 'search', q] as const,
  article: (slug: string) => ['content', 'help', 'article', slug] as const,
};

export const articleHref = (slug: string) => href('seller/help-article', '', { slug });

/** Topic icon from the API (design icon names), with a fallback for names outside the app's set. */
export const topicIcon = (name?: string | null): IconName => iconOf(name, 'book-open');

/**
 * Seller support topic (support category key) for a help topic, so "Contact seller support" from an
 * article starts with a fitting topic. Help topics (content) and support categories (support) are
 * separate lists, so this matches on the topic's words.
 */
const SUPPORT_TOPIC_BY_WORD: Array<[RegExp, string]> = [
  [/payout|fee|finance|statement|tax/, 'fees_payouts'],
  [/listing|product|selling|catalog|image|photo|brand/, 'listing_rules'],
  [/ship|dispatch|deliver|tracking/, 'shipping_dispatch'],
  [/return|refund|dispute|case/, 'seller_returns_disputes'],
  [/health|restriction|appeal|performance|account/, 'account_health'],
  [/advert|sponsor|\bads?\b|campaign/, 'advertising'],
];
export function supportTopicFor(category?: Pick<HelpCategory, 'slug' | 'name'> | null): string | undefined {
  if (!category) return undefined;
  const text = `${category.slug} ${category.name}`.toLowerCase();
  return SUPPORT_TOPIC_BY_WORD.find(([re]) => re.test(text))?.[1];
}

/** Contact seller support, prefilled from an article (topic and subject; read by the Help page's form). */
export function contactHref(a?: Pick<HelpArticle, 'slug' | 'category'> | null): string {
  if (!a) return href('seller/help', 'contact-seller-support');
  const topic = supportTopicFor(a.category);
  return href('seller/help', 'contact-seller-support', undefined, { ...(topic ? { topic } : {}), article: a.slug });
}

/** Where a content link (LinkRef url) goes in the Seller Center: an in-app path, an external URL, or nowhere. */
export function helpLinkTo(url?: string | null): { to?: string; external?: string } {
  if (!url) return {};
  if (/^(https?:|tel:|mailto:)/.test(url)) return { external: url };
  const [path, qs = ''] = url.split('?');
  const article = path.match(/^\/(?:seller\/)?help\/articles\/([^/]+)$/);
  if (article) return { to: articleHref(article[1]) };
  if (/^\/(?:seller\/)?help\/contact/.test(path)) return { to: href('seller/help', 'contact-seller-support') };
  if (/^\/(?:seller\/)?help(\/topics\/[^/]+)?\/?$/.test(path)) return { to: href('seller/help') };
  // Seller Center screens are addressed as /seller/<path> in content; this app serves them from /<path>.
  const screen = path.match(/^\/seller(\/.*)?$/);
  if (screen) return { to: (screen[1] || '/') + (qs ? `?${qs}` : '') };
  return {};
}

/** Is this content link the "Contact seller support" action (the pages show their own)? */
export const isContactLink = (l: LinkRef) => /\/help\/contact/.test(l.url);
