import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { GraphQLContext, ModuleResolvers } from '../../../kernel/graphql/index.js';
import type * as catalog from '../../../spec/catalog.js';
import type { PageInput } from '../../../spec/common.js';
import type { CategoryCrumb, SearchContext } from '../../../spec/search.js';
import type { ConditionGroup, SearchFilters, SearchMatch, SearchResultSet, SortKey } from '../domain/types.js';
import type { SearchService } from '../service.js';

/** GraphQL enums are the upper-case names of the REST values (price_asc ↔ PRICE_ASC). */
const up = (s: string | null | undefined) => (s ? s.toUpperCase() : null);
const down = <T extends string>(s: string | null | undefined): T | undefined => (s ? (s.toLowerCase() as T) : undefined);

interface FilterInput {
  categoryIds?: string[] | null;
  priceMin?: number | null;
  priceMax?: number | null;
  brandIds?: string[] | null;
  sellerIds?: string[] | null;
  official?: boolean | null;
  minRating?: number | null;
  conditions?: string[] | null;
  inStockOnly?: boolean | null;
  freeDelivery?: boolean | null;
  arrivesBy?: string | null;
  shipsToday?: boolean | null;
  onSale?: boolean | null;
  attributes?: { key: string; values: string[] }[] | null;
}

interface ResultArgs {
  filters?: FilterInput | null;
  sort?: string | null;
  postalCode?: string | null;
  searchId?: string | null;
  paging?: PageInput | null;
}

/** SearchFilterInput → SearchFilters (OfferConditionFilter ALL means no condition filter) */
export function filtersIn(f: FilterInput | null | undefined): SearchFilters {
  if (!f) return {};
  const out: SearchFilters = {};
  if (f.categoryIds?.length) out.categoryIds = f.categoryIds;
  if (f.priceMin != null) out.priceMin = f.priceMin;
  if (f.priceMax != null) out.priceMax = f.priceMax;
  if (f.brandIds?.length) out.brandIds = f.brandIds;
  if (f.sellerIds?.length) out.sellerIds = f.sellerIds;
  if (f.official) out.official = true;
  if (f.minRating != null) out.minRating = f.minRating;
  const conditions = (f.conditions ?? []).map((c) => c.toLowerCase()).filter((c) => c !== 'all') as ConditionGroup[];
  if (conditions.length) out.conditions = conditions;
  if (f.inStockOnly != null) out.inStockOnly = f.inStockOnly;
  if (f.freeDelivery) out.freeDelivery = true;
  if (f.shipsToday) out.shipsToday = true;
  if (f.arrivesBy) out.arrivesBy = f.arrivesBy;
  if (f.onSale) out.onSale = true;
  if (f.attributes?.length) out.attributes = f.attributes.map((a) => ({ key: a.key, values: a.values }));
  return out;
}

const pagingIn = (p: PageInput | null | undefined): PageInput => ({
  ...(p?.cursor ? { cursor: p.cursor } : {}),
  ...(p?.page ? { page: p.page } : {}),
  ...(p?.limit ? { limit: p.limit } : {}),
});

const pairs = (m: Record<string, string> | null | undefined) => Object.entries(m ?? {}).map(([name, value]) => ({ name, value }));

export function graphqlMappers(service: SearchService) {
  const catalogApi = () => service.catalogApi();

  const categoryOut = (c: catalog.Category): Record<string, unknown> => ({
    ...c,
    offerCount: null,
    children: c.children.map(categoryOut),
    filters: async () => ((await catalogApi().getCategoryBySlug(c.slug))?.filters ?? []).filter((a) => a.filterable).map((a) => ({ name: a.name, kind: a.kind, unit: a.unit ?? null, options: a.options })),
    attributes: [],
  });

  const categoryById = async (id: string | null | undefined) => {
    if (!id) return null;
    const find = (list: catalog.Category[]): catalog.Category | null => {
      for (const c of list) {
        if (c.id === id) return c;
        const hit = find(c.children);
        if (hit) return hit;
      }
      return null;
    };
    const c = find(await catalogApi().listCategories({ includeHidden: true }));
    return c ? categoryOut(c) : null;
  };

  const crumbOut = (c: CategoryCrumb | null | undefined) => (c ? () => categoryById(c.id) : null);

  /** A catalog product as the Product type (catalog's fields; other modules add theirs by id) */
  const productOut = (p: catalog.Product, match?: SearchMatch): Record<string, unknown> => ({
    ...p,
    category: () => categoryById(p.categoryId),
    specs: pairs(p.specs),
    variants: p.variants.map((v) => ({ ...v, options: pairs(v.options) })),
    __searchMatch: match ?? null,
  });

  const productsOut = async (items: { productId: string; match?: SearchMatch }[]) => {
    const found = await Promise.all(items.map(async (it) => ({ it, p: await catalogApi().getProduct(it.productId).catch(() => null) })));
    return found.filter((x) => x.p).map((x) => productOut(x.p!, x.it.match));
  };

  const matchOut = (m: SearchMatch | null | undefined) =>
    m
      ? {
          ...m,
          offer: async () => {
            if (!m.offerId) return null;
            try {
              return await service.offersApi().getOffer(m.offerId);
            } catch (err) {
              if (isAppError(err)) return null;
              throw err;
            }
          },
        }
      : null;

  const contextOut = (c: SearchContext) => ({
    ...c,
    facets: c.facets.map((f) => ({ ...f, group: up(f.group), kind: up(f.kind) })),
    sorts: c.sorts.map((s) => ({ ...s, key: up(s.key) })),
    category: c.category
      ? {
          ...c.category,
          category: () => categoryById(c.category!.category.id),
          breadcrumb: async () => (await Promise.all(c.category!.breadcrumb.map((b) => categoryById(b.id)))).filter(Boolean),
        }
      : null,
    emptyGuidance: c.emptyGuidance ? { ...c.emptyGuidance, popular: () => productsOut(c.emptyGuidance!.popular.map((p) => ({ productId: p.productId }))) } : null,
  });

  /** SearchResults: the context, the organic items as Product (with searchMatch) and sponsored placeholders */
  const resultsOut = (r: SearchResultSet) => ({
    ...contextOut(r.context),
    items: () => productsOut(r.items),
    nextCursor: r.page.nextCursor,
    page: r.page.page ?? null,
    totalPages: r.page.totalPages ?? null,
    total: r.page.total ?? r.context.total,
    sponsoredSlots: r.sponsoredSlots.map((s) => ({ ...s, kind: up(s.kind) })),
  });

  return { categoryOut, categoryById, crumbOut, productOut, productsOut, matchOut, resultsOut };
}

const queryOf = (args: ResultArgs & { query?: string; exact?: boolean | null }) => ({
  ...(args.query !== undefined ? { q: args.query } : {}),
  ...(args.exact ? { exact: true } : {}),
  filters: filtersIn(args.filters),
  ...(args.sort ? { sort: down<SortKey>(args.sort) } : {}),
  ...(args.postalCode ? { postalCode: args.postalCode } : {}),
  ...(args.searchId ? { searchId: args.searchId } : {}),
});

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "search", …)` in graphql/schema.ts).
 * Fields of this module's own types without @source resolve from the parent object (lazy ones are functions).
 *
 *   Product.bestSellerRank → service.bestSellerRanks
 *   Product.searchMatch → service.runSearch (the match travels with each result)
 *   Product.related → service.similarProducts
 *   Seller.products → service.listSellerProducts
 *   Seller.categories → service.sellerCategoryCounts
 *   Query.search → service.runSearch
 *   Query.categoryProducts → service.listCategoryProducts
 *   Query.searchSuggestions → service.getSuggestions
 */
export const resolvers = (service: SearchService): ModuleResolvers => {
  const m = graphqlMappers(service);
  return {
    Query: {
      search: async (_root, args: ResultArgs & { query: string; exact?: boolean | null }, ctx: GraphQLContext) => {
        const session = await service.sessionFor(ctx.principal);
        return m.resultsOut(await service.runSearch(queryOf(args), pagingIn(args.paging), session));
      },
      categoryProducts: async (_root, args: ResultArgs & { slug: string }) => {
        const r = await service.listCategoryProducts(args.slug, queryOf(args), pagingIn(args.paging));
        if (!r) throw new AppError('NOT_FOUND', 'Category not found');
        return m.resultsOut(r);
      },
      searchSuggestions: async (_root, args: { prefix: string }, ctx: GraphQLContext) => {
        const session = await service.sessionFor(ctx.principal);
        const s = await service.getSuggestions(args.prefix, { ...(session.customerId ? { customerId: session.customerId } : {}), ...(session.guestSessionId ? { guestSessionId: session.guestSessionId } : {}) });
        return {
          ...s,
          queries: s.queries.map((q) => ({ ...q, categoryScope: m.crumbOut(q.categoryScope) })),
          categories: s.categories.map((q) => ({ ...q, categoryScope: m.crumbOut(q.categoryScope) })),
          brands: s.brands.map((b) => ({ brand: { id: b.brandId, name: b.name, slug: b.slug, logo: b.logo ?? null, banner: null, description: null, productCount: b.productCount }, productCount: b.productCount })),
          products: () => m.productsOut(s.products.map((p) => ({ productId: p.productId }))),
        };
      },
    },
    Product: {
      bestSellerRank: async (root: { id?: string }) => {
        if (!root?.id) return null;
        const r = (await service.bestSellerRanks([root.id]))[root.id];
        return r ? { ...r, category: () => m.categoryById(r.categoryId) } : null;
      },
      searchMatch: (root: { __searchMatch?: SearchMatch | null }) => m.matchOut(root?.__searchMatch),
      related: async (root: { id?: string }, args: { limit?: number | null }) => {
        if (!root?.id) return [];
        const ids = (await service.similarProducts([root.id], args.limit ?? 10))[root.id] ?? [];
        return m.productsOut(ids.map((productId) => ({ productId })));
      },
    },
    Seller: {
      products: async (root: { id?: string }, args: ResultArgs) => {
        if (!root?.id) throw new AppError('NOT_FOUND', 'Seller not found');
        return m.resultsOut(await service.listSellerProducts(root.id, queryOf(args), pagingIn(args.paging)));
      },
      categories: async (root: { id?: string }) => {
        if (!root?.id) return [];
        return ((await service.sellerCategoryCounts([root.id]))[root.id] ?? []).map((c) => ({ id: c.categoryId, name: c.name, slug: c.slug, count: c.count, comingSoon: c.comingSoon }));
      },
    },
  };
};
