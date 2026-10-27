import { AppError } from '../../kernel/errors/index.js';
import { encodeCursor, toPageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type { DepartmentSection, ProductCard, SearchPublicApi, Suggestions, ZeroResultQuery } from '../../spec/search.js';
import type { SearchQuery, SearchResultSet, SearchSession } from './domain/types.js';
import { windowOf } from './service/queries.js';
import { SearchAdmin } from './service/admin.js';

export type { SearchServiceDeps } from './service/base.js';

/**
 * Search use cases. Depends only on its repository, the search engine, the event bus, the clock and other
 * modules' public APIs. Each method maps to a publicApi function, an endpoint, a consumed event or a job
 * in docs/api/spec/modules/search.json. The use cases are layered in service/:
 * base → indexer (index, consumers, jobs) → queries (search, context, suggestions) → admin → this class.
 */
export class SearchService extends SearchAdmin implements SearchPublicApi {
  /** catalog's public API (GraphQL read layer: products and categories of results) */
  catalogApi() {
    return this.catalog;
  }
  /** offers' public API (GraphQL read layer: the offer of a search match) */
  offersApi() {
    return this.offers;
  }

  /* ---------------------------------------------------------------- endpoints */

  /**
   * One department's own results for the query (the scoped list behind a department's chip). An unknown key, or a
   * department whose module is switched off, is NOT_FOUND: the chip only exists when that department answered.
   */
  async departmentScope(key: string, query: { q: string; kind?: string; cursor?: string; limit?: number }): Promise<DepartmentSection> {
    const section = await this.departmentSection(key, query.q, query);
    if (!section) throw new AppError('NOT_FOUND', 'Department not found');
    return section;
  }

  /* ---------------------------------------------------------------- public API (in-process) */

  /** Same engine as the store endpoint, without sponsored slots. Used for collections (new arrivals, best sellers, category picks). */
  async searchProducts(query: unknown): Promise<{ items: ProductCard[]; total: number; nextCursor: string | null }> {
    const q = (query ?? {}) as SearchQuery & { limit?: number; cursor?: string };
    const p = await this.prepare(q, q.q?.trim() ? { kind: 'search' } : { kind: 'collection' }, { strictSort: false });
    const page = toPageRequest({ limit: q.limit ?? (await this.setting('pageSize')), ...(q.cursor ? { cursor: q.cursor } : {}) });
    const window = windowOf(page);
    const { cards, total } = await this.results(p, window);
    return { items: cards.map((c) => c.card), total, nextCursor: window.offset + window.limit < total ? encodeCursor([window.offset + window.limit]) : null };
  }

  /** Cards for any product list (home sections, recently viewed, related products), same shape everywhere */
  async getProductCards(productIds: string[], opts?: { postalCode?: string; sellerId?: string }): Promise<ProductCard[]> {
    return this.cardsFor(productIds, opts?.sellerId ? { sellerId: opts.sellerId } : {});
  }

  /** Unavailable searches for the products and discovery report */
  async zeroResultStats(from: string, to: string): Promise<ZeroResultQuery[]> {
    return this.zeroResultQueries(from, to);
  }

  /** Store search with spelling correction, facets, store match, empty guidance and sponsored placeholders (ads are filled by advertising) */
  async runSearch(query: SearchQuery & { exact?: boolean; postalCode?: string; searchId?: string }, page: common.PageInput, session?: SearchSession): Promise<SearchResultSet> {
    return this.resultSet(query ?? {}, { kind: 'search' }, toPageRequest(page ?? {}), session);
  }

  /** Category page listing with category attribute facets and category context */
  async listCategoryProducts(slug: string, query: SearchQuery & { postalCode?: string; searchId?: string }, page: common.PageInput): Promise<SearchResultSet | null> {
    const tree = await this.categoryTree();
    const node = tree.bySlug.get(slug);
    if (!node || !tree.path(node.id).every((c) => c.visible)) return null;
    const detail = await this.optional('catalog', 'category', (c) => c.getCategoryBySlug(slug));
    if (detail === null) return null;
    const { categoryIds: _ids, ...filters } = query?.filters ?? {};
    return this.resultSet({ ...(query ?? {}), q: null, filters: { ...filters, categorySlug: slug } }, { kind: 'category' }, toPageRequest(page ?? {}));
  }

  /** Lets the engine prepare the recommended order for the published ranking weights (after a start; searches do it too) */
  async prepareRanking(): Promise<void> {
    await this.engine.prepareRanking?.(await this.weights());
  }

  /** Suggestions while typing: queries, categories, brands, stores, products and recent searches */
  async getSuggestions(prefix: string, session?: { customerId?: string; guestSessionId?: string }): Promise<Suggestions> {
    return this.suggestions(prefix, session);
  }

  /** Similar in-stock products per product (related products, alternatives for unavailable products) */
  async similarProducts(productIds: string[], limit: number): Promise<Record<string, string[]>> {
    const n = Math.min(Math.max(limit || 10, 1), 50);
    const out: Record<string, string[]> = {};
    for (const id of [...new Set(productIds)]) out[id] = await this.engine.similar(id, n);
    return out;
  }

  /** Storefront product grid: products with a live offer from this seller, with the same filters, facets and sorts as search (query.filters.sellerIds is replaced by the seller). Each result's match.offer is this seller's offer. No store match and no sponsored slots. */
  async listSellerProducts(sellerId: string, query: SearchQuery & { postalCode?: string; searchId?: string }, page: common.PageInput): Promise<SearchResultSet> {
    const { sellerIds: _s, sellerSlugs: _slugs, official: _o, ...filters } = query?.filters ?? {};
    return this.resultSet({ ...(query ?? {}), filters }, { kind: 'seller', sellerId }, toPageRequest(page ?? {}));
  }

  /** Storefront category chips: categories in which the seller has live offers, with product counts from the search index (the REST storefront's categories) */
  async sellerCategoryCounts(sellerIds: string[]): Promise<Record<string, { categoryId: string; name: string; slug: string; count: number; comingSoon: boolean }[]>> {
    const ids = [...new Set(sellerIds)];
    const out: Record<string, { categoryId: string; name: string; slug: string; count: number; comingSoon: boolean }[]> = Object.fromEntries(ids.map((id) => [id, []]));
    if (!ids.length) return out;
    const [rows, tree] = await Promise.all([this.engine.sellerCategoryCounts(ids), this.categoryTree()]);
    for (const r of rows) {
      const node = tree.byId.get(r.categoryId);
      if (!node || !tree.path(node.id).every((c) => c.visible)) continue;
      out[r.sellerId]?.push({ categoryId: node.id, name: node.name, slug: node.slug, count: r.count, comingSoon: node.comingSoon });
    }
    return out;
  }

  /** Best-seller rank of products in their category by 30-day units sold; null when not ranked (outside the top 100 or below bestSellingMinOrders) */
  async bestSellerRanks(productIds: string[]): Promise<Record<string, { rank: number; categoryId: string; categoryName: string; label: string; updatedAt: string } | null>> {
    const ids = [...new Set(productIds)];
    const out: Record<string, { rank: number; categoryId: string; categoryName: string; label: string; updatedAt: string } | null> = Object.fromEntries(ids.map((id) => [id, null]));
    const rows = await this.repo.bestSellerRows(ids);
    if (!rows.length) return out;
    const tree = await this.categoryTree();
    for (const r of rows) {
      if (r.best_seller_rank === null || !r.best_seller_category_id) continue;
      const name = tree.byId.get(r.best_seller_category_id)?.name ?? 'its category';
      out[r.product_id] = {
        rank: r.best_seller_rank,
        categoryId: r.best_seller_category_id,
        categoryName: name,
        label: `#${r.best_seller_rank} in ${name}`,
        updatedAt: (this.salesCountedAt ?? new Date(r.indexed_at)).toISOString(),
      };
    }
    return out;
  }
}
