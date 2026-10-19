import { ApiError, call, type Api, type components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { iconFor, type IconName } from '@marketly/web-shared/ui';

// Seller help content from the content module, read in the seller area with the seller session: help home
// (GET /api/seller/content/help), search (…/help/articles), articles (…/help/articles/{slug}) and
// "Was this helpful?" (POST …/help/articles/{id}/feedback). Seller help serves seller articles only.

export type HelpHome = components['schemas']['content.HelpHome'];
export type HelpArticle = components['schemas']['content.HelpArticle'];
export type HelpArticleSummary = components['schemas']['content.HelpArticleSummary'];
export type HelpCategory = components['schemas']['content.HelpCategory'];
export type LinkRef = components['schemas']['content.LinkRef'];

/** Help home for sellers: topics with their top articles, popular articles and searches, the featured guide. */
export const getHelpHome = (api: Api): Promise<HelpHome> => call(api.GET('/api/seller/content/help'));

/** Seller help search (title, summary, topics and body). */
export const searchHelp = (api: Api, q: string, limit = 24) => call(api.GET('/api/seller/content/help/articles', { params: { query: { q, limit } } }));

/** One article by slug; null when there is none. */
export async function getHelpArticle(api: Api, slug: string): Promise<HelpArticle | null> {
  try {
    return await call(api.GET('/api/seller/content/help/articles/{slug}', { params: { path: { slug } } }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** "Was this helpful?" */
export async function rateHelpArticle(api: Api, id: string, helpful: boolean, comment?: string): Promise<void> {
  await call(api.POST('/api/seller/content/help/articles/{id}/feedback', { params: { path: { id } }, body: { helpful, ...(comment ? { comment } : {}) } }));
}

/** Query keys (module first). */
export const helpKeys = {
  home: ['content', 'help', 'seller'] as const,
  search: (q: string) => ['content', 'help', 'seller', 'search', q] as const,
  article: (slug: string) => ['content', 'help', 'article', slug] as const,
};

export const articleHref = (slug: string) => href('seller/help-article', '', { slug });

/** Topic icon from the API (design icon names), with a fallback for names outside the app's set. */
export const topicIcon = (name?: string | null): IconName => iconFor(name, 'book-open');

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
