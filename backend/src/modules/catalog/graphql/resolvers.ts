import { isAppError } from '../../../kernel/errors/index.js';
import { gqlActor, type GraphQLContext, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import { format } from '../../../kernel/lib/money.js';
import { toPageRequest } from '../../../kernel/lib/pagination.js';
import type { Money, PageInput } from '../../../spec/common.js';
import type { Attribute, Category, Product, ProductAdmin, ProductCheck } from '../../../spec/catalog.js';
import type { CatalogService } from '../service.js';

/** GraphQL enums are the upper-case names of the REST values (changes_requested ↔ CHANGES_REQUESTED). */
const up = (s: string | null | undefined) => (s ? s.toUpperCase() : null);
const actorOut = gqlActor;
const pairs = (m: Record<string, string> | null | undefined) => Object.entries(m ?? {}).map(([name, value]) => ({ name, value }));
const money = (m: Money | null | undefined) => (m ? { ...m, formatted: format(m) } : null);
const nullOnNotFound = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (err) {
    if (isAppError(err) && err.code === 'NOT_FOUND') return null;
    throw err;
  }
};

const pagingIn = (p: PageInput | null | undefined): PageInput => ({
  ...(p?.cursor ? { cursor: p.cursor } : {}),
  ...(p?.page ? { page: p.page } : {}),
  ...(p?.limit ? { limit: p.limit } : {}),
});

/**
 * A read done once per GraphQL request (the context object) and shared by every field that asks for it: a field
 * on each item of a list (a product's category, a category's filters and attributes) reads once, not per item.
 */
function perRequest<K, V>(read: (key: K) => Promise<V>) {
  const memo = new WeakMap<object, Map<K, Promise<V>>>();
  return (key: K, ctx: GraphQLContext | undefined): Promise<V> => {
    if (!ctx) return read(key);
    let byKey = memo.get(ctx);
    if (!byKey) memo.set(ctx, (byKey = new Map()));
    let hit = byKey.get(key);
    if (!hit) byKey.set(key, (hit = read(key)));
    return hit;
  };
}

export function graphqlMappers(service: CatalogService) {
  const attributeOut = (a: Attribute) => ({ ...a, kind: up(a.kind) });
  const categoryAttributes = perRequest((id: string) => service.categoryAttributes(id));
  // every category of the full tree by id
  const categoryNodes = perRequest(async (_: null) => {
    const out = new Map<string, Category>();
    const walk = (list: Category[]) => {
      for (const c of list) {
        out.set(c.id, c);
        walk(c.children);
      }
    };
    walk(await service.listCategories({ includeHidden: true }));
    return out;
  });

  const categoryOut = (c: Category): Record<string, unknown> => ({
    ...c,
    children: c.children.map(categoryOut),
    filters: async (_args: unknown, ctx?: GraphQLContext) =>
      (await categoryAttributes(c.id, ctx)).attributes.filter((a) => a.filterable).map((a) => ({ name: a.name, kind: a.kind, unit: a.unit ?? null, options: a.options })),
    attributes: async (_args: unknown, ctx?: GraphQLContext) => (await categoryAttributes(c.id, ctx)).attributes.map(attributeOut),
  });

  const categoryById = async (id: string | null | undefined, ctx?: GraphQLContext) => {
    if (!id) return null;
    const c = (await categoryNodes(null, ctx)).get(id);
    return c ? categoryOut({ ...c, offerCount: null }) : null;
  };

  const productById = async (id: string | null | undefined) => {
    if (!id) return null;
    const p = await service.getProduct(id);
    return p ? productOut(p) : null;
  };

  const productOut = (p: Product): Record<string, unknown> => ({
    ...p,
    category: (_args: unknown, ctx?: GraphQLContext) => categoryById(p.categoryId, ctx),
    specs: pairs(p.specs),
    variants: p.variants.map((v) => ({ ...v, options: pairs(v.options), listPrice: money(v.listPrice) })),
  });

  const checkOut = (c: ProductCheck) => ({
    ...c,
    kind: up(c.kind),
    result: up(c.result),
    evidence: c.evidence.map((e) => ({
      ...e,
      matchedProduct: () => productById(e.matchedProductId),
      suggestedCategory: (_args: unknown, ctx?: GraphQLContext) => categoryById(e.suggestedCategoryId, ctx),
      media: null,
    })),
    dismissal: c.dismissal ? { ...c.dismissal, by: actorOut(c.dismissal.by), matchedProduct: () => productById(c.dismissal!.matchedProductId) } : null,
  });

  /** A product as Seller Center or Admin Center sees it; review fields only for the submitter (seller area) */
  const adminOut = (a: ProductAdmin, opts: { owns: boolean; area: 'seller' | 'admin' }): Record<string, unknown> => {
    const own = opts.area === 'admin' || opts.owns;
    return {
      ...productOut(a.product),
      reviewState: up(opts.owns || opts.area === 'admin' ? a.reviewState : 'approved'),
      publication: up(a.publication),
      missing: own ? a.missing : null,
      reviewLog: own ? a.reviewLog.map((l) => ({ ...l, fields: pairs(l.fields), actor: actorOut(l.actor) })) : null,
      submission:
        own && a.submission
          ? {
              ...a.submission,
              kind: up(a.submission.kind),
              state: up(a.submission.state),
              submittedBy: actorOut(a.submission.submittedBy),
              lastSavedBy: actorOut(a.submission.lastSavedBy),
              assignee: actorOut(a.submission.assignee),
              reviewDeadline: a.submission.reviewDeadline ? { dueAt: a.submission.reviewDeadline.dueAt, state: up(a.submission.reviewDeadline.state) } : null,
            }
          : null,
      submittedByMe: opts.owns,
      noGtin: own ? a.product.noGtin : null,
      requestedBrandName: own ? (a.requestedBrand?.name ?? null) : null,
      imagesToRecrop: own ? (a.imagesToRecrop ?? []) : null,
      reviewDraft: a.reviewDraft ? { ...a.reviewDraft, decision: up(a.reviewDraft.decision), fields: pairs(a.reviewDraft.fields), savedBy: actorOut(a.reviewDraft.savedBy) } : null,
      owner: { type: up(a.owner), sellerId: a.ownerSellerId ?? null },
      // one batched read (a duplicate check lists 20 candidates at most)
      duplicateCandidates: async () => (await service.getProducts(a.duplicateCandidates.map((d) => d.id))).map((r) => productOut(r.product)),
      checks: a.checks.map(checkOut),
    };
  };

  return { categoryOut, productOut, adminOut };
}

const staffViewer = (ctx: GraphQLContext) => ({ kind: 'staff' as const, staffId: ctx.principal?.accountId ?? null });

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "catalog", …)` in graphql/schema.ts).
 * Fields of this module's own types without @source resolve from the parent object (lazy ones are functions).
 *
 *   Query.product → service.getProduct (store: approved and active only)
 *   Query.categories → service.listCategories
 *   Query.category → service.getCategoryBySlug
 *   Query.brand → service.getBrandBySlug
 *   Query.myProduct → service.getProductForSeller
 *   Query.productReviewQueue → service.listReviewQueue
 *   Query.productAdmin → service.getProductAdmin
 *   Seller.catalogCounts → service.countProductsForSellers
 */
export const resolvers = (service: CatalogService): ModuleResolvers => {
  const m = graphqlMappers(service);
  return {
    Query: {
      product: async (_root, args: { id: string }, ctx: GraphQLContext) => {
        if (ctx.area === 'store') {
          const p = await nullOnNotFound(service.storeProduct(args.id));
          return p ? m.productOut(p) : null;
        }
        if (ctx.area === 'seller') {
          const sellerId = ctx.principal?.sellerId;
          const r = sellerId ? await service.getProductForSeller(sellerId, args.id) : null;
          return r ? m.adminOut(r.product, { owns: r.ownsSubmission, area: 'seller' }) : null;
        }
        const a = await nullOnNotFound(service.productAdminFor(args.id, staffViewer(ctx)));
        return a ? m.adminOut(a, { owns: false, area: 'admin' }) : null;
      },
      categories: async () => (await service.listCategories({ includeHidden: false })).map(m.categoryOut),
      category: async (_root, args: { slug: string }) => {
        const c = await service.getCategoryBySlug(args.slug);
        return c ? m.categoryOut(c.category) : null;
      },
      brand: async (_root, args: { slug: string }) => service.getBrandBySlug(args.slug),
      myProduct: async (_root, args: { id: string }, ctx: GraphQLContext) => {
        const sellerId = ctx.principal?.sellerId;
        if (!sellerId) return null;
        const r = await service.getProductForSeller(sellerId, args.id);
        return r ? m.adminOut(r.product, { owns: r.ownsSubmission, area: 'seller' }) : null;
      },
      productReviewQueue: async (_root, args: { kind?: string | null; categoryId?: string | null; paging?: PageInput | null }, ctx: GraphQLContext) => {
        const page = await service.reviewQueue({ kind: args.kind?.toLowerCase() ?? undefined, categoryId: args.categoryId ?? undefined }, toPageRequest(pagingIn(args.paging)), staffViewer(ctx));
        return { ...page, items: page.items.map((a) => m.adminOut(a, { owns: false, area: 'admin' })) };
      },
      productAdmin: async (_root, args: { id: string }, ctx: GraphQLContext) => {
        const a = await nullOnNotFound(service.productAdminFor(args.id, staffViewer(ctx)));
        return a ? m.adminOut(a, { owns: false, area: 'admin' }) : null;
      },
    },
    Seller: {
      catalogCounts: async (root: { id?: string }) => {
        if (!root?.id) return null;
        return (await service.countProductsForSellers([root.id]))[root.id] ?? null;
      },
    },
  };
};
