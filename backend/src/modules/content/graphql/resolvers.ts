import { isAppError } from '../../../kernel/errors/index.js';
import type { GraphQLContext, ModuleResolvers } from '../../../kernel/graphql/index.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type { BannerBlock, BrandTile, CategoryTile, ContactChannel, HelpArticle, HelpArticleSummary, HelpCategory, HelpHome, LinkRef, PageBlock, ProductTile, StorePage } from '../../../spec/content.js';
import type { ContentService } from '../service.js';
import type { ResolvedHomepage, ResolvedHomeSection } from '../service/homepage.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals) */

const up = (s: string | null | undefined) => (s ? s.toUpperCase() : null);
const pairs = (m: Record<string, string> | null | undefined) => Object.entries(m ?? {}).map(([name, value]) => ({ name, value }));
const link = (l: LinkRef | null | undefined) => (l ? { label: l.label, url: l.url, kind: up(l.kind) } : null);
const banner = (b: BannerBlock | null | undefined) => (b ? { ...b, theme: up(b.theme), images: b.images ?? [], primaryCta: link(b.primaryCta), secondaryCta: link(b.secondaryCta) } : null);
export const money = (m: common.Money | null | undefined) => (m ? { ...m, formatted: formatMoney(m) } : null);

const nullOnNotFound = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (err) {
    if (isAppError(err) && err.code === 'NOT_FOUND') return null;
    throw err;
  }
};

function mappers(service: ContentService) {
  const categoryOut = (c: catalog.Category): Record<string, unknown> => ({ ...c, children: (c.children ?? []).map(categoryOut), filters: [], attributes: [] });

  const productOut = (p: catalog.Product, cats: Map<string, catalog.Category>): Record<string, unknown> => ({
    ...p,
    specs: pairs(p.specs),
    variants: p.variants.map((v) => ({ ...v, options: pairs(v.options) })),
    category: () => {
      const c = p.categoryId ? cats.get(p.categoryId) : undefined;
      return c ? categoryOut(c) : null;
    },
  });

  /** Tiles whose product the catalog still serves; the offer is left to product.featuredOffer */
  const tiles = async (list: ProductTile[]) => {
    const [products, cats] = await Promise.all([service.productsByIds(list.map((t) => t.productId)), service.categoriesById()]);
    return list
      .filter((t) => products.has(t.productId))
      .map((t) => ({ product: productOut(products.get(t.productId)!, cats), offer: null, badge: t.badge ?? null, rank: t.rank ?? null, group: null, checkedAt: t.checkedAt ?? null }));
  };

  const shortcuts = async (list: CategoryTile[]) => {
    const cats = await service.categoriesById();
    return list.filter((t) => cats.has(t.categoryId)).map((t) => ({ category: categoryOut(cats.get(t.categoryId)!), image: t.image ?? null, label: t.name }));
  };

  const sellersOut = async (ids: string[]) => {
    const found = await service.sellersByIds(ids);
    return ids
      .filter((id) => found.has(id))
      .map((id) => {
        const { card, snapshot } = found.get(id)!;
        return { ...card, ref: snapshot?.ref ?? '', sellingNow: snapshot?.canSellNew ?? true, status: up(snapshot?.status) };
      });
  };

  const brandOut = (b: BrandTile) => ({ id: b.brandId, name: b.name, slug: '', logo: b.logo ?? null, description: null, productCount: b.productCount, banner: null });

  const collectionOut = async (pageId: string | null | undefined) => {
    const c = pageId ? await service.collectionInfo(pageId) : null;
    return c ? { ...c, kind: up(c.kind), curator: c.curator ? { ...c.curator, avatar: null } : null, categoryFilters: [] } : null;
  };

  const sectionOut = (s: ResolvedHomeSection) => ({
    id: s.id,
    position: s.position,
    kind: up(s.kind),
    heading: s.heading ?? null,
    subheading: s.subheading ?? null,
    link: link(s.link),
    banner: banner(s.banner),
    products: async (args: { limit?: number | null }) => tiles(args?.limit ? s.products.slice(0, Math.max(args.limit, 0)) : s.products),
    categories: () => shortcuts(s.categories),
    sellers: () => sellersOut(s.sellers.map((x) => x.sellerId)),
    brands: s.brands.map(brandOut),
    collection: () => collectionOut(s.meta.collectionId),
    selectionRule: s.meta.selectionRule,
    adPlacementKey: s.adPlacementKey ?? null,
    endsAt: s.endsAt ?? null,
    promiseItems: s.promiseItems,
    // read by promotions' HomeSection.campaign / flashSales resolvers
    linkedPromotionId: s.meta.linkedPromotionId,
    campaignId: s.meta.linkedPromotionId,
  });

  const homeOut = (h: ResolvedHomepage) => ({ version: h.version, generatedAt: h.generatedAt, sections: h.sections.map(sectionOut) });

  const blockOut = (b: PageBlock) => ({
    ...b,
    type: up(b.type),
    banner: banner(b.banner),
    link: link(b.link),
    items: b.items ?? [],
    products: () => tiles(b.products ?? []),
  });

  const pageOut = async (p: StorePage, opts: { draft?: boolean } = {}) => {
    const extras = await service.pageExtras(p.id, opts);
    return {
      ...p,
      kind: up(p.kind),
      breadcrumb: p.breadcrumb.map(link),
      blocks: p.blocks.map(blockOut),
      collection: () => (p.kind === 'collection' ? collectionOut(p.id) : null),
      seoTitle: extras?.seoTitle ?? null,
      seoDescription: extras?.seoDescription ?? null,
      linkedPromotionId: extras?.linkedPromotionId ?? null,
      campaignId: extras?.linkedPromotionId ?? null,
    };
  };

  const helpCategoryOut = (c: HelpCategory) => ({ ...c, audience: up(c.audience) });

  const summaryOut = (s: HelpArticleSummary, cats: Map<string, HelpCategory>) => {
    const c = cats.get(s.categoryId);
    return {
      ...s,
      category: c ? helpCategoryOut(c) : { id: s.categoryId, slug: '', name: s.categoryName, icon: null, description: null, position: 0, visible: true, audience: 'BOTH', articleCount: 0 },
    };
  };

  const summariesOut = async (list: HelpArticleSummary[]) => {
    const cats = await service.helpCategoriesById();
    return list.map((s) => summaryOut(s, cats));
  };

  const articleOut = async (a: HelpArticle) => ({
    ...a,
    category: helpCategoryOut(a.category),
    breadcrumb: a.breadcrumb.map(link),
    tables: a.tables ?? [],
    related: await summariesOut(a.related),
    actions: a.actions.map(link),
    policyLinks: a.policyLinks.map(link),
  });

  const contactOut = (c: ContactChannel) => ({ ...c, kind: up(c.kind), action: link(c.action) });

  const helpCenterOut = async (h: HelpHome) => ({
    topics: h.topics.map(helpCategoryOut),
    popular: await summariesOut(h.popular),
    popularSearches: h.popularSearches.map(link),
    contact: h.contact.map(contactOut),
    sellerFirstNote: h.sellerFirstNote,
  });

  return { homeOut, pageOut, tiles, articleOut, summariesOut, helpCenterOut };
}

/** The topic a support case is about (support's Case shape: category key or topic) */
const caseTopic = (root: Record<string, unknown> | null | undefined): string => {
  const c = root?.category as unknown;
  if (typeof root?.categoryKey === 'string') return root.categoryKey;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && typeof (c as { key?: unknown }).key === 'string') return (c as { key: string }).key;
  if (typeof root?.topic === 'string') return root.topic;
  return '';
};

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "content", …)` in graphql/schema.ts).
 * Fields of this module's own types without @source resolve from the parent object (lazy ones are functions).
 *
 *   Collection.products → service.collectionProducts
 *   Case.helpArticles → service.helpArticlesFor
 *   Query.homePage → service.getHomePage
 *   Query.contentPage → service.getStorePage
 *   Query.helpCenter → service.getHelpCenter
 *   Query.helpArticle → service.getHelpArticle
 *   Query.homePagePreview → service.previewHomePage
 *   Query.contentPagePreview → service.previewPage
 */
export const resolvers = (service: ContentService): ModuleResolvers => {
  const m = mappers(service);
  return {
    Query: {
      homePage: async () => m.homeOut(await service.resolvedHomePage({})),
      contentPage: async (_root, args: { slug: string }) => {
        const p = await service.getStorePage(args.slug);
        return p ? m.pageOut(p) : null;
      },
      helpCenter: async (_root, _args, ctx: GraphQLContext) => m.helpCenterOut(await service.getHelpCenter(ctx.principal?.kind === 'seller' ? 'seller' : 'customer')),
      helpArticle: async (_root, args: { slug: string }) => {
        const a = await service.getHelpArticle(args.slug);
        return a ? m.articleOut(a) : null;
      },
      homePagePreview: async (_root, args: { at?: string | null; device?: string | null; useDraft?: boolean | null }) =>
        m.homeOut(await service.resolvedPreview({ device: args.device === 'phone' ? 'phone' : 'desktop', at: args.at ?? null, useDraft: args.useDraft ?? true })),
      contentPagePreview: async (_root, args: { id: string }) => {
        const p = await nullOnNotFound(service.previewPage(args.id));
        return p ? m.pageOut(p, { draft: true }) : null;
      },
    },
    Collection: {
      products: async (root: { id: string }, args: { categoryId?: string | null; paging?: common.PageInput | null }) => {
        const page = await service.collectionProducts(root.id, { categoryId: args.categoryId ?? undefined, paging: args.paging ?? {} });
        return { ...page, items: await m.tiles(page.items) };
      },
    },
    Case: {
      helpArticles: async (root: Record<string, unknown>, args: { limit?: number | null }) => m.summariesOut(await service.helpArticlesFor(caseTopic(root), args.limit ?? 3)),
    },
  };
};
