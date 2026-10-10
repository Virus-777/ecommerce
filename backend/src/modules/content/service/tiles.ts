/**
 * Which products, categories, sellers and brands a section or page block shows, resolved through
 * their owning modules (search cards first, catalog and offers when search cannot answer).
 * Content only decides WHICH products appear and in what order; unavailable ones are hidden.
 */
import type * as catalog from '../../../spec/catalog.js';
import type { BrandTile, CategoryTile, PageInput, ProductSource, ProductTile, SectionProductRow, SellerTile, SourceRule } from '../../../spec/content.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import type * as promotions from '../../../spec/promotions.js';
import type * as search from '../../../spec/search.js';
import { RULE_DESCRIPTIONS } from '../domain/rules.js';
import { ContentBase, unique } from './base.js';

export interface ResolvedProduct {
  productId: string;
  offerId: string | null;
  tile: ProductTile;
  available: boolean;
  hiddenReason: SectionProductRow['hiddenReason'] | null;
  sellerId: string | null;
}

export interface Resolved {
  items: ResolvedProduct[];
  /** Published selection rule for rule-based sources */
  rule: string | null;
}

const MAX_RESOLVE = 100;

export class ContentTiles extends ContentBase {
  /* ---------------------------------------------------------------- products */

  /**
   * Products of a source in order. `includeHidden` keeps unavailable products (with hiddenReason) for the
   * admin drawers; store reads leave them out.
   */
  protected async resolveSource(source: ProductSource | null | undefined, opts: { limit?: number; categoryId?: string | null; includeHidden?: boolean; depth?: number } = {}): Promise<Resolved> {
    if (!source) return { items: [], rule: null };
    const limit = Math.min(Math.max(opts.limit ?? source.limit ?? MAX_RESOLVE, 1), MAX_RESOLVE);
    let items: ResolvedProduct[] = [];
    let rule: string | null = null;
    if (source.mode === 'manual') {
      items = await this.resolveIds(source.productIds ?? [], { categoryId: opts.categoryId, includeHidden: opts.includeHidden });
    } else if (source.mode === 'collection') {
      if (source.collectionId && (opts.depth ?? 0) < 2) {
        const r = await this.collectionSources(source.collectionId, { live: true });
        for (const s of r.sources) {
          const sub = await this.resolveSource(s, { ...opts, limit: MAX_RESOLVE, depth: (opts.depth ?? 0) + 1 });
          items.push(...sub.items);
          rule ??= sub.rule;
        }
        const seen = new Set<string>();
        items = items.filter((i) => (seen.has(i.productId) ? false : (seen.add(i.productId), true)));
      }
    } else if (source.mode === 'rule' && source.rule) {
      rule = source.rule.description || RULE_DESCRIPTIONS[source.rule.kind] || null;
      items = await this.resolveRule(source.rule, { limit, categoryId: opts.categoryId });
    }
    if (!opts.includeHidden) items = items.filter((i) => i.available);
    return { items: items.slice(0, limit), rule };
  }

  /** Product sources of a collection page's live (or draft) blocks */
  protected async collectionSources(pageId: string, opts: { live: boolean }): Promise<{ sources: ProductSource[] }> {
    const page = await this.repo.getPage(pageId);
    const versionId = page ? (opts.live ? page.live_version_id : (page.draft_version_id ?? page.live_version_id)) : null;
    if (!page || !versionId) return { sources: [] };
    if (opts.live && page.status !== 'published') return { sources: [] };
    const v = await this.repo.getVersion(versionId);
    const snap = v?.snapshot as unknown as PageInput | undefined;
    return { sources: (snap?.blocks ?? []).map((b) => b.productSource).filter((s): s is ProductSource => Boolean(s)) };
  }

  private async categorySlug(categoryId: string | null | undefined): Promise<string | undefined> {
    if (!categoryId) return undefined;
    const cats = await this.categoryIndex();
    return cats.get(categoryId)?.slug;
  }

  /** Every catalog category by id (flattened tree), empty when catalog is off */
  protected async categoryIndex(): Promise<Map<string, catalog.Category>> {
    const catalogApi = this.ctx.tryUse('catalog');
    const tree = await this.soft('catalog.listCategories', catalogApi && (() => catalogApi.listCategories({ includeHidden: false })), [] as catalog.Category[]);
    const out = new Map<string, catalog.Category>();
    const walk = (list: catalog.Category[]) => {
      for (const c of list) {
        out.set(c.id, c);
        walk(c.children ?? []);
      }
    };
    walk(tree);
    return out;
  }

  /** deals limited to one promotion: its live flash items (promotions.liveDeals({ campaignId })) */
  private async campaignDeals(campaignId: string, limit: number): Promise<ResolvedProduct[]> {
    const promotionsApi = this.ctx.tryUse('promotions');
    if (!promotionsApi) return [];
    const blocks = await this.soft('promotions.liveDeals', () => promotionsApi.liveDeals({ limit, campaignId }), [] as promotions.FlashSaleBlock[]);
    return blocks
      .filter((b) => b.campaignId === campaignId)
      .flatMap((b) => b.items ?? [])
      .slice(0, limit)
      .map((item): ResolvedProduct => {
        const left = Math.max(0, item.dealStock - item.claimed);
        const official = item.sellerId === OFFICIAL_STORE_ID;
        return {
          productId: item.productId,
          offerId: item.offerId,
          sellerId: official ? null : item.sellerId,
          available: left > 0,
          hiddenReason: left > 0 ? null : 'out_of_stock',
          tile: {
            productId: item.productId,
            offerId: item.offerId,
            title: item.title,
            image: item.image ?? null,
            price: item.dealPrice,
            wasPrice: item.regularPrice,
            fromPrice: false,
            sellerName: item.sellerName,
            officialStore: official,
            rating: null,
            ratingCount: null,
            availability: left > 0 ? 'in_stock' : 'out_of_stock',
            availableQty: left,
            checkedAt: this.now().toISOString(),
            badge: item.percentOffBps ? `−${Math.round(item.percentOffBps / 100)}%` : null,
            rank: null,
          },
        };
      });
  }

  private async resolveRule(rule: SourceRule, opts: { limit: number; categoryId?: string | null }): Promise<ResolvedProduct[]> {
    if (rule.kind === 'deals' && rule.campaignId) return this.campaignDeals(rule.campaignId, opts.limit);
    const searchApi = this.ctx.tryUse('search');
    if (!searchApi) return [];
    const category = await this.categorySlug(opts.categoryId ?? rule.categoryId);
    const query: Record<string, unknown> = { availability: 'in_stock', limit: opts.limit, ...(category ? { category } : {}) };
    switch (rule.kind) {
      case 'new_arrivals':
        Object.assign(query, { sort: 'newest', listedWithinDays: rule.days ?? 30 });
        break;
      case 'best_sellers':
      case 'top_sellers_in_category':
        Object.assign(query, { sort: 'best_selling' });
        break;
      case 'official_store':
        Object.assign(query, { seller: ['official'], sort: 'recommended' });
        break;
      case 'deals':
        Object.assign(query, { onSale: true, sort: 'recommended' });
        break;
    }
    const res = await this.soft('search.searchProducts', () => searchApi.searchProducts(query), { items: [] as search.ProductCard[], total: 0, nextCursor: null });
    const ranked = rule.kind === 'best_sellers' || rule.kind === 'top_sellers_in_category';
    return (res.items ?? []).map((card, i) => this.fromCard(card, ranked ? i + 1 : null));
  }

  private fromCard(card: search.ProductCard, rank: number | null): ResolvedProduct {
    const out = card.availability === 'out_of_stock';
    return {
      productId: card.productId,
      offerId: card.offerId ?? null,
      sellerId: card.sellerId ?? null,
      available: !out,
      hiddenReason: out ? 'out_of_stock' : null,
      tile: {
        productId: card.productId,
        offerId: card.offerId ?? null,
        title: card.title,
        image: card.image ?? null,
        price: card.price ?? null,
        wasPrice: card.wasPrice ?? null,
        fromPrice: Boolean(card.priceIsFrom),
        sellerName: card.sellerName ?? null,
        officialStore: Boolean(card.official),
        rating: card.rating ?? null,
        ratingCount: card.ratingCount ?? null,
        availability: card.availability ?? null,
        availableQty: null,
        checkedAt: this.now().toISOString(),
        badge: card.discountPct ? `−${card.discountPct}%` : (card.badges?.[0] ?? null),
        rank,
      },
    };
  }

  /** Manual product lists: search cards, else catalog products with the featured offer */
  protected async resolveIds(productIds: string[], opts: { categoryId?: string | null; includeHidden?: boolean } = {}): Promise<ResolvedProduct[]> {
    const ids = unique(productIds).slice(0, MAX_RESOLVE);
    if (!ids.length) return [];
    const searchApi = this.ctx.tryUse('search');
    const catalogApi = this.ctx.tryUse('catalog');
    const cards = searchApi ? await this.soft('search.getProductCards', () => searchApi.getProductCards(ids), null as search.ProductCard[] | null) : null;
    let out: ResolvedProduct[];
    if (cards) {
      const byId = new Map(cards.map((c) => [c.productId, c]));
      out = ids.map((id) => {
        const card = byId.get(id);
        return card ? this.fromCard(card, null) : this.missing(id);
      });
    } else {
      out = await this.fromCatalog(ids);
    }
    if (opts.categoryId && catalogApi) {
      const products = await Promise.all(ids.map((id) => this.soft('catalog.getProduct', () => catalogApi.getProduct(id), null as catalog.Product | null)));
      const tree = await this.categoryIndex();
      const inCategory = (cid: string | null | undefined): boolean => {
        let cur = cid ? tree.get(cid) : undefined;
        while (cur) {
          if (cur.id === opts.categoryId) return true;
          cur = cur.parentId ? tree.get(cur.parentId) : undefined;
        }
        return false;
      };
      const keep = new Set(products.filter((p) => p && inCategory(p.categoryId)).map((p) => p!.id));
      out = out.filter((r) => keep.has(r.productId));
    }
    if (opts.includeHidden) await this.markSuspendedSellers(out);
    return out;
  }

  private missing(productId: string): ResolvedProduct {
    return {
      productId,
      offerId: null,
      sellerId: null,
      available: false,
      hiddenReason: 'product_hidden',
      tile: { productId, offerId: null, title: 'Product no longer available', image: null, price: null, wasPrice: null, fromPrice: false, sellerName: null, officialStore: false, availability: null, checkedAt: this.now().toISOString(), badge: null, rank: null },
    };
  }

  private async fromCatalog(ids: string[]): Promise<ResolvedProduct[]> {
    const catalogApi = this.ctx.tryUse('catalog');
    if (!catalogApi) return ids.map((id) => this.missing(id));
    const offersApi = this.ctx.tryUse('offers');
    const featured = offersApi ? await this.soft('offers.getFeaturedOfferForProduct', () => offersApi.getFeaturedOfferForProduct(ids.map((productId) => ({ productId }))), null) : null;
    return Promise.all(
      ids.map(async (id) => {
        const [product, purchasable] = await Promise.all([
          this.soft('catalog.getProduct', () => catalogApi.getProduct(id), null as catalog.Product | null),
          this.soft('catalog.isPurchasable', () => catalogApi.isPurchasable(id), false),
        ]);
        if (!product || !purchasable) return this.missing(id);
        const offer = featured ? (featured[id] ?? null) : undefined;
        const r: ResolvedProduct = {
          productId: id,
          offerId: offer?.id ?? null,
          sellerId: offer?.sellerId ?? null,
          available: offer !== null,
          hiddenReason: offer === null ? 'offer_paused' : null,
          tile: {
            productId: id,
            offerId: offer?.id ?? null,
            title: product.title,
            image: product.images[0] ?? null,
            price: offer?.price ?? null,
            wasPrice: null,
            fromPrice: false,
            sellerName: offer?.sellerName ?? null,
            officialStore: offer?.ownerType === 'official',
            availability: offer ? 'in_stock' : null,
            checkedAt: this.now().toISOString(),
            badge: null,
            rank: null,
          },
        };
        return r;
      }),
    );
  }

  /** Admin drawers say why a product is hidden: a suspended or closed seller */
  private async markSuspendedSellers(rows: ResolvedProduct[]) {
    const sellersApi = this.ctx.tryUse('sellers');
    const ids = unique(rows.map((r) => r.sellerId).filter((x): x is string => Boolean(x)));
    if (!sellersApi || !ids.length) return;
    const snaps = await this.soft('sellers.getSellers', () => sellersApi.getSellers(ids), []);
    const blocked = new Set(snaps.filter((s) => s.status === 'suspended' || s.status === 'closed').map((s) => s.id));
    for (const r of rows) {
      if (r.sellerId && blocked.has(r.sellerId)) {
        r.available = false;
        r.hiddenReason = 'seller_suspended';
      }
    }
  }

  /** Stock of the offers shown (admin section drawer) */
  protected async stockOf(offerIds: string[]): Promise<Map<string, number>> {
    const inventoryApi = this.ctx.tryUse('inventory');
    const ids = unique(offerIds.filter(Boolean));
    if (!inventoryApi || !ids.length) return new Map();
    const items = await this.soft('inventory.getStockForOffers', () => inventoryApi.getStockForOffers(ids, {}), {} as Record<string, { quantities: { available: number } } | null>);
    const out = new Map<string, number>();
    for (const [offerId, item] of Object.entries(items)) if (item) out.set(offerId, item.quantities.available);
    return out;
  }

  /* ---------------------------------------------------------------- categories, sellers, brands */

  protected async categoryTiles(ids: string[]): Promise<CategoryTile[]> {
    if (!ids.length) return [];
    const index = await this.categoryIndex();
    return ids
      .map((id) => index.get(id))
      .filter((c): c is catalog.Category => Boolean(c && c.visible))
      .map((c) => ({ categoryId: c.id, name: c.name, image: c.image ?? null }));
  }

  /** Featured seller cards in order; suspended or closed sellers are left out */
  protected async sellerTiles(ids: string[]): Promise<SellerTile[]> {
    const sellersApi = this.ctx.tryUse('sellers');
    if (!sellersApi || !ids.length) return [];
    const [cards, snaps] = await Promise.all([this.soft('sellers.getStorefrontCard', () => sellersApi.getStorefrontCard(ids), []), this.soft('sellers.getSellers', () => sellersApi.getSellers(ids), [])]);
    const status = new Map(snaps.map((s) => [s.id, s.status]));
    const byId = new Map(cards.map((c) => [c.id, c]));
    return ids
      .filter((id) => byId.has(id) && !['suspended', 'closed'].includes(status.get(id) ?? 'approved'))
      .map((id) => {
        const c = byId.get(id)!;
        return { sellerId: c.id, name: c.storeName, logo: c.logo ?? null, verified: c.verified, positivePct: c.positivePct ?? null, location: c.location ?? null, dispatchLabel: c.dispatchLabel ?? null };
      });
  }

  /**
   * Brand cards: catalog's public API has no brand-by-id lookup, so a brand appears through its published
   * brand collection page (title, cover image, available products).
   */
  protected async brandTiles(ids: string[]): Promise<BrandTile[]> {
    if (!ids.length) return [];
    const pages = (await this.repo.listPages({ kind: 'collection', collectionKind: 'brand', statuses: ['published'] })).filter((p) => p.brand_id && ids.includes(p.brand_id));
    const now = this.now();
    const live = pages.filter((p) => (!p.publish_at || p.publish_at <= now) && (!p.unpublish_at || p.unpublish_at > now));
    const tiles: BrandTile[] = [];
    for (const id of ids) {
      const page = live.find((p) => p.brand_id === id);
      if (!page) continue;
      const v = page.live_version_id ? await this.repo.getVersion(page.live_version_id) : undefined;
      const snap = v?.snapshot as unknown as PageInput | undefined;
      const count = (await this.collectionItems(page.id)).length;
      const refs = await this.refsMap([snap?.coverImage?.id]);
      tiles.push({ brandId: id, name: page.title, logo: (snap?.coverImage?.id && refs.get(snap.coverImage.id)) || null, productCount: count });
    }
    return tiles;
  }

  /** Available products of a live collection page, in order */
  protected async collectionItems(pageId: string, opts: { categoryId?: string | null; blockId?: string | null; live?: boolean } = {}): Promise<ResolvedProduct[]> {
    const page = await this.repo.getPage(pageId);
    const versionId = opts.live === false ? (page?.draft_version_id ?? page?.live_version_id) : page?.live_version_id;
    if (!page || !versionId) return [];
    const v = await this.repo.getVersion(versionId);
    const snap = v?.snapshot as unknown as PageInput | undefined;
    const blocks = (snap?.blocks ?? []).filter((b) => b.productSource && (!opts.blockId || b.id === opts.blockId));
    const out: ResolvedProduct[] = [];
    const seen = new Set<string>();
    for (const b of blocks) {
      const r = await this.resolveSource(b.productSource, { categoryId: opts.categoryId, limit: MAX_RESOLVE });
      for (const item of r.items) {
        if (seen.has(item.productId)) continue;
        seen.add(item.productId);
        out.push(item);
      }
    }
    return out;
  }

}
