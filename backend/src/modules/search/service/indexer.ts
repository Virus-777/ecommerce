/**
 * The index: a read model fed by catalog, offers, inventory, reviews, sellers, promotions and orders
 * events. Consumers are idempotent and order-tolerant: they update what they can in place and mark the
 * product dirty; search.process-dirty rebuilds dirty documents from the source modules' public APIs.
 */
import { SYSTEM_ACTOR } from '../../../kernel/auth/index.js';
import { isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { Product } from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type * as offersSpec from '../../../spec/offers.js';
import { aggregatesFromOffers, buildDocument, type SourceOffer } from '../domain/document.js';
import { reindexJobMachine } from '../domain/state-machines.js';
import type { DocRow, ReindexJobRow } from '../ports.js';
import { SearchBase, type CategoryTree } from './base.js';

const LIVE_STATUSES = ['active', 'out_of_stock'];
const DIRTY_BATCH = 200;
const BEST_SELLER_TOP = 100;
/** Best-selling and popularity window (market days, today included) */
const SALES_WINDOW_DAYS = 30;
/** Daily sales rows are kept this long */
const SALES_KEEP_DAYS = 90;
/** YYYY-MM-DD plus n calendar days */
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type RebuildResult = 'indexed' | 'removed';

export class SearchIndexer extends SearchBase {
  /* ---------------------------------------------------------------- rebuilding documents */

  /**
   * Rebuilds one document from the source modules. Products that are not purchasable (not approved, hidden,
   * suspended, merged, unknown) are removed. When offers cannot answer, the offer rows the events built stay.
   */
  async rebuild(productId: string, tree?: CategoryTree): Promise<RebuildResult> {
    const catalog = this.catalog;
    const [product, purchasable] = await Promise.all([catalog.getProduct(productId), catalog.isPurchasable(productId)]);
    if (!product || !purchasable) {
      await this.repo.transaction((tx) => tx.deleteDocument(productId));
      return 'removed';
    }
    const t = tree ?? (await this.categoryTree());
    const path = t.path(product.categoryId).map((c) => ({ id: c.id, name: c.name, slug: c.slug }));
    // catalog answers getBrandBySlug for active brands only (undefined = catalog could not answer: keep it usable)
    const activeBrand = product.brand ? await this.optional('catalog', 'brand', (c) => c.getBrandBySlug(product.brand!.slug)) : null;
    const brandActive = Boolean(product.brand) && activeBrand !== null;
    const [source, rating, existing] = await Promise.all([
      this.sourceOffers(productId),
      this.optional('reviews', 'ratings', async (r) => (await r.getRatingSummaries([productId])).find((s) => s.productId === productId)),
      this.repo.getDocument(productId),
    ]);
    const now = this.now();
    const built = buildDocument(
      {
        product: await this.withThumbnails(product),
        categoryPath: path,
        offers: source?.offers ?? [],
        featuredOfferId: source?.featuredOfferId ?? null,
        rating: rating ? { average: rating.hasReviews ? (rating.average ?? null) : null, count: rating.hasReviews ? rating.ratingCount : 0 } : null,
        existing,
      },
      now,
    );
    if (source) {
      await this.repo.transaction((tx) => tx.upsertDocument(built.doc, built.offers, now));
    } else {
      // offers unavailable: keep the offer rows (and featured details) the events built
      const rows = await this.repo.offerRows([productId]);
      const kept: Partial<DocRow> = existing
        ? {
            featured_offer_id: existing.featured_offer_id,
            featured_price: existing.featured_price,
            featured_seller_name: existing.featured_seller_name,
            featured_official: existing.featured_official,
            was_price: existing.was_price,
            deal_ends_at: existing.deal_ends_at,
            on_sale: existing.on_sale,
            badges: existing.badges,
            low_stock: existing.low_stock,
            same_day_cutoff: existing.same_day_cutoff,
            currency: existing.currency,
          }
        : {};
      const doc = { ...built.doc, ...kept } as typeof built.doc;
      Object.assign(doc, aggregatesFromOffers({ ...(existing ?? ({} as DocRow)), ...doc } as DocRow, rows));
      await this.repo.transaction((tx) => tx.upsertDocument(doc, null, now));
    }
    // only active brands are suggested or offered as a facet: their brand suggestion term is the marker
    if (product.brand) {
      if (brandActive) {
        const n = (await this.engine.productCountsByBrand([product.brand.id])).get(product.brand.id) ?? 0;
        await this.repo.upsertTerm('brand', product.brand.id, product.brand.name, n, now);
      } else await this.repo.deleteTerms('brand', [product.brand.id]);
    }
    return 'indexed';
  }

  /** Live offers of a product from offers (+ stock from inventory, campaign prices from promotions); null when offers cannot answer */
  protected async sourceOffers(productId: string): Promise<{ offers: SourceOffer[]; featuredOfferId: string | null } | null> {
    const list: offersSpec.Offer[] = [];
    try {
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await this.offers.listOffersAdmin({ productId, status: LIVE_STATUSES }, { limit: 100, ...(cursor ? { cursor } : {}) });
        list.push(...page.items.filter((o) => o.productId === productId && LIVE_STATUSES.includes(o.status)));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, productId }, 'search: offers could not list offers');
      return null;
    }
    const ids = list.map((o) => o.id);
    const [featured, stock, promos, quotes] = await Promise.all([
      this.optional('offers', 'featured offer', (o) => o.getFeaturedOfferForProduct([{ productId }])),
      list.length ? this.optional('inventory', 'stock', (inv) => inv.getOfferAvailability(list.map((o) => ({ offerId: o.id, stockItemId: o.stockItemId, ...(o.purchaseLimit ? { purchaseLimit: o.purchaseLimit } : {}) })))) : undefined,
      list.length ? this.optional('promotions', 'campaign prices', (p) => p.priceOffers(ids, { at: this.now().toISOString() })) : undefined,
      Promise.all(list.map((o) => this.optional('offers', 'delivery', (x) => x.quoteOffer(o.id, 1)))),
    ]);
    const offers = list.map((o, i): SourceOffer => {
      const avail = stock?.[o.id];
      const promo = promos?.find((p) => p.offerId === o.id);
      const campaign = Boolean(promo && promo.price.amount < promo.regularPrice.amount);
      const verifiedCompareAt = o.compareAt?.verified ? o.compareAt.amount.amount : null;
      const state = avail?.state ?? (o.status === 'active' ? 'in_stock' : 'out_of_stock');
      return {
        offerId: o.id,
        variantId: o.variantId,
        sellerId: o.ownerType === 'official' ? null : (o.sellerId ?? null),
        sellerName: o.sellerName,
        official: o.ownerType === 'official',
        condition: o.condition,
        price: campaign ? promo!.price.amount : o.price.amount,
        currency: o.price.currency,
        wasPrice: campaign ? (promo!.wasPrice?.amount ?? promo!.regularPrice.amount) : verifiedCompareAt,
        saleEndsAt: (campaign ? promo!.flash?.endsAt : null) ?? o.saleEndsAt ?? null,
        campaign,
        inStock: o.status === 'active' && state !== 'out_of_stock',
        lowStock: state === 'low_stock',
        freeDelivery: Boolean(quotes[i]?.delivery.free),
        dispatchDays: o.dispatch.businessDays,
        sameDayCutoff: o.dispatch.sameDayCutoff ?? null,
        featuredEligible: o.featuredEligibility.eligible,
      };
    });
    return { offers, featuredOfferId: featured?.[productId]?.id ?? null };
  }

  /** Rebuild now; when a source cannot answer the product stays queued for search.process-dirty */
  protected async rebuildOrQueue(productId: string, reason: string) {
    try {
      await this.rebuild(productId);
    } catch (err) {
      this.ctx.log.warn({ err, productId }, 'search: rebuild failed; queued for process-dirty');
      await this.repo.markDirty([productId], reason, this.now());
    }
  }

  protected async markDirty(ids: string[], reason: string) {
    await this.repo.markDirty(ids, reason, this.now());
  }

  /** Recompute a document's offer aggregates after an in-place offer row change */
  protected async refreshAggregates(productId: string) {
    const doc = await this.repo.getDocument(productId);
    if (!doc) return;
    const rows = await this.repo.offerRows([productId]);
    await this.repo.updateDocument(productId, aggregatesFromOffers(doc, rows), this.now());
  }

  /**
   * Result cards show thumbnails: the product's and its variants' images in media's thumb size (catalog sends the
   * product-page size). Without media, the thumbUrl catalog's refs carry.
   */
  protected async withThumbnails(product: Product): Promise<Product> {
    const ids = [...new Set([...product.images, ...product.variants.flatMap((v) => v.images)].map((i) => i.id))];
    const thumbs = ids.length ? await this.optional('media', 'thumbnails', (m) => m.refs(ids, 'thumb')) : undefined;
    const byId = new Map((thumbs ?? []).map((r) => [r.id, r]));
    const thumb = (r: common.MediaRef): common.MediaRef => byId.get(r.id) ?? (r.thumbUrl ? { ...r, url: r.thumbUrl } : r);
    return { ...product, images: product.images.map(thumb), variants: product.variants.map((v) => ({ ...v, images: v.images.map(thumb) })) };
  }

  /* ---------------------------------------------------------------- consumers: media */

  /** media.product_images.rebuilt: new thumbnails for every product, so a full reindex is queued (search.process-dirty runs it) */
  async onProductImagesRebuiltFromMedia(e: EventPayload<'media.product_images.rebuilt'>) {
    if (await this.repo.activeFullJob()) return;
    await this.repo.insertJob({
      id: newId(),
      scope: 'all',
      ids: [],
      state: 'queued',
      total: 0,
      processed: 0,
      requested_by: JSON.stringify({ kind: SYSTEM_ACTOR.kind, id: SYSTEM_ACTOR.id ?? null, name: 'Product images rebuilt' }),
      reason: `Product images rebuilt at the product image spec (${e.aspectRatio}, ${e.rebuilt} images)`,
      started_at: null,
      finished_at: null,
      error: null,
    });
  }

  /* ---------------------------------------------------------------- consumers: catalog */

  async onProductApprovedFromCatalog(e: EventPayload<'catalog.product.approved'>) {
    await this.rebuildOrQueue(e.productId, 'catalog.product.approved');
  }

  async onProductPublicationChangedFromCatalog(e: EventPayload<'catalog.product.publication_changed'>) {
    if (e.to !== 'active') {
      // Hidden or Suspended: out of results now
      await this.repo.transaction((tx) => tx.deleteDocument(e.productId));
      return;
    }
    await this.rebuildOrQueue(e.productId, 'catalog.product.publication_changed');
  }

  async onProductUpdatedFromCatalog(e: EventPayload<'catalog.product.updated'>) {
    await this.rebuildOrQueue(e.productId, 'catalog.product.updated');
  }

  async onProductMergedFromCatalog(e: EventPayload<'catalog.product.merged'>) {
    await this.repo.transaction((tx) => tx.deleteDocument(e.duplicateProductId));
    await this.repo.deleteTerms('product', [e.duplicateProductId]);
    await this.rebuildOrQueue(e.keptProductId, 'catalog.product.merged');
  }

  async onBrandChangedFromCatalog(e: EventPayload<'catalog.brand.changed'>) {
    const ids = await this.repo.documentIds({ brandIds: [e.brandId] });
    if (e.status !== 'active') {
      // only active brands are suggested or offered as a facet
      await this.repo.deleteTerms('brand', [e.brandId]);
      if (ids.length) await this.markDirty(ids, 'catalog.brand.changed');
      return;
    }
    if (!ids.length) return;
    // the brand's name and slug come from its products' content
    await this.markDirty(ids, 'catalog.brand.changed');
    const product = await this.optional('catalog', 'brand name', (c) => c.getProduct(ids[0]!));
    if (product?.brand) {
      const n = (await this.engine.productCountsByBrand([e.brandId])).get(e.brandId) ?? 0;
      await this.repo.upsertTerm('brand', e.brandId, product.brand.name, n, this.now());
    }
  }

  /* ---------------------------------------------------------------- consumers: offers */

  async onOfferCreatedFromOffers(e: EventPayload<'offers.offer.created'>) {
    await this.markDirty([e.productId], 'offers.offer.created');
  }

  async onOfferPriceChangedFromOffers(e: EventPayload<'offers.offer.price_changed'>) {
    const row = await this.repo.offerRow(e.offerId);
    if (!row || row.product_id !== e.productId) {
      await this.markDirty([e.productId], 'offers.offer.price_changed');
      return;
    }
    await this.repo.updateOfferRow(e.offerId, { price: e.to.amount });
    await this.refreshAggregates(e.productId);
    const doc = await this.repo.getDocument(e.productId);
    if (doc?.featured_offer_id === e.offerId) {
      // a verified compare-at on the featured offer makes it a deal
      const was = e.compareAt && e.compareAt.amount > e.to.amount ? e.compareAt.amount : null;
      const badges = (Array.isArray(doc.badges) ? (doc.badges as string[]) : []).filter((b) => b !== 'Deal');
      const onSale = was !== null;
      await this.repo.updateDocument(e.productId, { was_price: was, on_sale: onSale, badges: (onSale ? [...badges, 'Deal'] : badges) as never, deal_ends_at: onSale ? doc.deal_ends_at : null }, this.now());
    }
  }

  async onOfferStatusChangedFromOffers(e: EventPayload<'offers.offer.status_changed'>) {
    const row = await this.repo.offerRow(e.offerId);
    const doc = await this.repo.getDocument(e.productId);
    if (doc) {
      if (!LIVE_STATUSES.includes(e.to)) {
        if (row) await this.repo.deleteOfferRow(e.offerId);
      } else if (row) {
        await this.repo.updateOfferRow(e.offerId, { in_stock: e.to === 'active' });
      }
      await this.refreshAggregates(e.productId);
    }
    // new live offers need their price and terms from offers
    await this.markDirty([e.productId], 'offers.offer.status_changed');
  }

  async onFeaturedChangedFromOffers(e: EventPayload<'offers.featured.changed'>) {
    const doc = await this.repo.getDocument(e.productId);
    if (!doc) {
      await this.markDirty([e.productId], 'offers.featured.changed');
      return;
    }
    const row = e.toOfferId ? await this.repo.offerRow(e.toOfferId) : undefined;
    if (row && row.product_id === e.productId) {
      await this.repo.updateDocument(e.productId, { featured_offer_id: row.offer_id, featured_price: row.price, featured_official: row.official }, this.now());
    } else if (!e.toOfferId && doc.featured_offer_id === e.fromOfferId) {
      await this.repo.updateDocument(e.productId, { featured_offer_id: null }, this.now());
      await this.refreshAggregates(e.productId);
    }
    // seller name, was price and delivery of the new featured offer
    await this.markDirty([e.productId], 'offers.featured.changed');
  }

  /* ---------------------------------------------------------------- consumers: inventory, reviews */

  async onStockChangedFromInventory(e: EventPayload<'inventory.stock.changed'>) {
    const row = e.offerId ? await this.repo.offerRow(e.offerId) : undefined;
    if (row) {
      await this.repo.updateOfferRow(row.offer_id, { in_stock: e.state !== 'out_of_stock' });
      await this.refreshAggregates(row.product_id);
      const doc = await this.repo.getDocument(row.product_id);
      if (doc?.featured_offer_id === row.offer_id) await this.repo.updateDocument(row.product_id, { low_stock: e.state === 'low_stock' }, this.now());
      return;
    }
    // an offer the index does not know yet: rebuild its product if the variant is known
    const productId = await this.repo.productIdForVariant(e.variantId);
    if (productId) await this.markDirty([productId], 'inventory.stock.changed');
    else this.ctx.log.debug({ variantId: e.variantId }, 'search: stock change for a product that is not indexed');
  }

  async onReviewPublishedFromReviews(e: EventPayload<'reviews.review.published'>) {
    const doc = await this.repo.getDocument(e.productId);
    if (!doc) return;
    const summary = await this.optional('reviews', 'ratings', async (r) => (await r.getRatingSummaries([e.productId])).find((s) => s.productId === e.productId));
    if (!summary) {
      await this.markDirty([e.productId], 'reviews.review.published');
      return;
    }
    const avg = summary.hasReviews && summary.average != null ? (Math.round(summary.average * 10) / 10).toFixed(1) : null;
    await this.repo.updateDocument(e.productId, { rating: avg, rating_count: summary.hasReviews ? summary.ratingCount : 0 }, this.now());
  }

  /* ---------------------------------------------------------------- consumers: sellers */

  protected async upsertStore(sellerId: string, storeName: string) {
    const n = (await this.engine.productCountsBySeller([sellerId])).get(sellerId) ?? 0;
    await this.repo.upsertTerm('store', sellerId, storeName, n, this.now());
  }

  async onSellerApprovedFromSellers(e: EventPayload<'sellers.seller.approved'>) {
    await this.upsertStore(e.sellerId, e.storeName);
  }

  async onSellerRestrictedFromSellers(e: EventPayload<'sellers.seller.restricted'>) {
    const ids = await this.repo.documentIds({ sellerIds: [e.sellerId] });
    await this.markDirty(ids, 'sellers.seller.restricted');
    const snap = await this.optional('sellers', 'store name', (s) => s.getSeller(e.sellerId));
    if (snap && (snap.status === 'approved' || snap.status === 'restricted')) await this.upsertStore(e.sellerId, snap.storeName);
  }

  async onSellerSuspendedFromSellers(e: EventPayload<'sellers.seller.suspended'>) {
    await this.repo.deleteTerms('store', [e.sellerId]);
  }

  async onSellerReinstatedFromSellers(e: EventPayload<'sellers.seller.reinstated'>) {
    const known = (await this.repo.terms('store', [e.sellerId]))[0];
    const snap = await this.optional('sellers', 'store name', (s) => s.getSeller(e.sellerId));
    const name = snap?.storeName ?? known?.term;
    if (name) await this.upsertStore(e.sellerId, name);
    else this.ctx.log.warn({ sellerId: e.sellerId }, 'search: reinstated seller without a known store name');
  }

  async onSellerClosedFromSellers(e: EventPayload<'sellers.seller.closed'>) {
    await this.repo.deleteTerms('store', [e.sellerId]);
  }

  /* ---------------------------------------------------------------- consumers: promotions, orders */

  async onCampaignStartedFromPromotions(e: EventPayload<'promotions.campaign.started'>) {
    const ids = await this.repo.productIdsForOffers(e.offerIds);
    const now = this.now();
    for (const id of ids) {
      const doc = await this.repo.getDocument(id);
      if (!doc) continue;
      const badges = (Array.isArray(doc.badges) ? (doc.badges as string[]) : []).filter((b) => b !== 'Deal');
      await this.repo.updateDocument(id, { on_sale: true, deal_ends_at: new Date(e.endsAt), badges: [...badges, 'Deal'] as never }, now);
    }
    // campaign prices and was prices come from promotions on rebuild
    await this.markDirty(ids, 'promotions.campaign.started');
  }

  async onCampaignEndedFromPromotions(_e: EventPayload<'promotions.campaign.ended'>) {
    // the event names only the campaign: every document with a deal end time is checked again
    const ids = await this.repo.documentIds({ onSale: true });
    await this.markDirty(ids, 'promotions.campaign.ended');
  }

  /** Units per product of an order and its market day (orders.getOrder); undefined when orders can't answer */
  protected async orderUnits(orderId: string): Promise<{ day: string; units: { productId: string; units: number }[] } | undefined> {
    const order = await this.optional('orders', 'order items', (o) => o.getOrder(orderId));
    if (!order) return undefined;
    const units = new Map<string, number>();
    for (const g of order.groups ?? []) for (const it of g.items ?? []) units.set(it.product.productId, (units.get(it.product.productId) ?? 0) + it.quantity);
    const placedAt = new Date(order.placedAt);
    return { day: this.marketDate(Number.isNaN(placedAt.getTime()) ? this.now() : placedAt), units: [...units].map(([productId, n]) => ({ productId, units: n })) };
  }

  /** orders.order.placed: the order's units per product go to product_sales_daily for the placed day, once per order */
  async onOrderPlacedFromOrders(e: EventPayload<'orders.order.placed'>) {
    const sales = await this.orderUnits(e.orderId);
    if (!sales) return;
    // an order counts once: a redelivered event finds its key claimed and adds nothing
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`order-placed:${e.orderId}`))) return;
      await tx.recordSales(sales.day, sales.units, 1, this.now());
    });
  }

  /**
   * orders.order.cancelled (declined payment, every item cancelled): the order's units come off the day it was
   * placed, once. A cancellation that arrives before the placement claims the placement too, so the order never counts.
   */
  async onOrderCancelledFromOrders(e: EventPayload<'orders.order.cancelled'>) {
    const sales = await this.orderUnits(e.orderId);
    if (!sales) return;
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`order-cancelled:${e.orderId}`))) return;
      const notCountedYet = await tx.claim(`order-placed:${e.orderId}`);
      if (notCountedYet) return;
      await tx.recordSales(sales.day, sales.units, -1, this.now());
    });
  }

  /* ---------------------------------------------------------------- consumers: identity, customers */

  /** Customer id of an account (customers module); undefined when customers is off */
  protected async customerIdOf(accountId: string): Promise<string | undefined> {
    return (await this.optional('customers', 'customer id', (c) => c.getCustomerByUserId(accountId)))?.id;
  }

  /** Recent searches are saved to an account only while the customer keeps them on (customers.getMarketingConsent) */
  protected async recentSearchesOn(customerId: string): Promise<boolean> {
    const prefs = await this.optional('customers', 'marketing consent', (c) => c.getMarketingConsent(customerId));
    return Boolean(prefs?.recentSearches);
  }

  async onGuestSessionClaimedFromIdentity(e: EventPayload<'identity.guest_session.claimed'>) {
    const guest = { kind: 'guest' as const, id: e.guestSessionId };
    const customerId = await this.customerIdOf(e.accountId);
    if (!customerId || !(await this.recentSearchesOn(customerId))) {
      // nothing is saved to the account; the guest list ends with the guest session
      await this.repo.clearRecentSearches(guest);
      return;
    }
    await this.repo.moveRecentSearches(guest, { kind: 'customer', id: customerId }, await this.setting('recentSearchesMax'));
  }

  async onMarketingPreferencesChangedFromCustomers(e: EventPayload<'customers.marketing_preferences.changed'>) {
    if (!e.recentSearches) await this.repo.clearRecentSearches({ kind: 'customer', id: e.customerId });
  }

  /* ---------------------------------------------------------------- jobs */

  /** search.process-dirty: queued reindex jobs, then dirty documents in bounded batches */
  async processDirty(): Promise<void> {
    for (const job of await this.repo.queuedJobs()) await this.runJob(job);
    await this.drainDirty(DIRTY_BATCH);
  }

  protected async drainDirty(limit: number): Promise<number> {
    const batch = await this.repo.takeDirty(limit);
    if (!batch.length) return 0;
    const tree = await this.categoryTree();
    let done = 0;
    for (const item of batch) {
      try {
        await this.rebuild(item.product_id, tree);
        await this.repo.clearDirty(item.product_id, item.queued_at);
        done++;
      } catch (err) {
        this.ctx.log.warn({ err, productId: item.product_id }, 'search: could not rebuild a dirty document; it stays queued');
      }
    }
    return done;
  }

  /** search.refresh-delivery-flags: delivery aggregates from offer rows ('Ships today' is checked against the cutoff at query time) */
  async refreshDeliveryFlags(): Promise<void> {
    const ids = await this.repo.documentIds({});
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const [docs, rows] = await Promise.all([this.repo.getDocuments(chunk), this.repo.offerRows(chunk)]);
      for (const d of docs) {
        const mine = rows.filter((r) => r.product_id === d.product_id);
        const inStock = mine.filter((r) => r.in_stock);
        const featured = mine.find((r) => r.offer_id === d.featured_offer_id);
        const fastest = inStock.length ? Math.min(...inStock.map((r) => r.dispatch_days)) : null;
        const free = Boolean(featured?.free_delivery);
        if (fastest !== d.fastest_dispatch_days || free !== d.free_delivery || (fastest !== 0 && d.same_day_cutoff !== null)) {
          await this.repo.updateDocument(d.product_id, { fastest_dispatch_days: fastest, free_delivery: free, ...(fastest !== 0 ? { same_day_cutoff: null } : {}) }, this.now());
        }
      }
    }
  }

  /** search.refresh-suggestions: popular queries (with results), categories, brands, stores and product names */
  async refreshSuggestions(): Promise<void> {
    const now = this.now();
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const queries = await this.repo.popularQueries(since, 2000);
    await this.repo.replaceTerms('query', queries.map((q) => ({ term: q.normalized, targetId: null, weight: q.count })), now);

    const tree = await this.categoryTree();
    const ids = await this.repo.documentIds({});
    const docs = await this.repo.getDocuments(ids);
    const live = docs.filter((d) => d.offer_count > 0);
    const perCategory = new Map<string, number>();
    for (const d of live) for (const c of d.category_path_ids) perCategory.set(c, (perCategory.get(c) ?? 0) + 1);
    const categoryRows = [...tree.byId.values()]
      .filter((c) => tree.path(c.id).every((p) => p.visible))
      .map((c) => ({ term: c.name, targetId: c.id, weight: perCategory.get(c.id) ?? 0 }));
    await this.repo.replaceTerms('category', categoryRows, now);

    // brands: only the active ones (catalog answers getBrandBySlug for active brands only)
    const brands = new Map<string, { name: string; n: number; productId: string }>();
    for (const d of live) {
      if (!d.brand_id) continue;
      const b = brands.get(d.brand_id) ?? { name: d.brand_name ?? '', n: 0, productId: d.product_id };
      b.n++;
      brands.set(d.brand_id, b);
    }
    const brandRows: { term: string; targetId: string; weight: number }[] = [];
    for (const [id, b] of brands) {
      const product = await this.optional('catalog', 'brand', (c) => c.getProduct(b.productId));
      const active = product?.brand ? await this.optional('catalog', 'brand', (c) => c.getBrandBySlug(product.brand!.slug)) : undefined;
      if (active === null) continue;
      brandRows.push({ term: product?.brand?.name ?? b.name, targetId: id, weight: b.n });
    }
    await this.repo.replaceTerms('brand', brandRows, now);

    // stores keep their membership from seller events; weights follow product counts
    const stores = await this.repo.terms('store');
    const counts = await this.engine.productCountsBySeller(stores.map((s) => s.target_id!).filter(Boolean));
    for (const s of stores) if (s.target_id) await this.repo.upsertTerm('store', s.target_id, s.term, counts.get(s.target_id) ?? 0, now);

    await this.repo.replaceTerms(
      'product',
      live.map((d) => ({ term: d.title, targetId: d.product_id, weight: Number(d.popularity) + d.rating_count / 10 })),
      now,
    );
  }

  /**
   * At startup: an engine index that is new (empty) or was built with an older mapping gets a full reindex,
   * queued for search.process-dirty (once per index and mapping, whichever server sees it first).
   */
  async bootstrapEngineIndex(): Promise<void> {
    const feed = this.engine.feed;
    if (!feed) return;
    const key = await feed.needsRebuild();
    if (!key || (await this.repo.activeFullJob()) || !(await this.repo.documentStats()).documents) return;
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`engine-index:${key}`))) return;
      await tx.insertJob({
        id: newId(),
        scope: 'all',
        ids: [],
        state: 'queued',
        total: 0,
        processed: 0,
        requested_by: JSON.stringify({ kind: SYSTEM_ACTOR.kind, id: SYSTEM_ACTOR.id ?? null, name: 'Search engine index' }),
        reason: 'The search engine index is new or was built with an older mapping',
        started_at: null,
        finished_at: null,
        error: null,
      });
    });
    this.ctx.log.info({ key }, 'search: full reindex queued for the search engine index');
  }

  /** search.full-reindex: nightly full rebuild (catches category tree changes) */
  async fullReindex(): Promise<void> {
    let job = await this.repo.activeFullJob();
    if (!job) {
      job = await this.repo.insertJob({
        id: newId(),
        scope: 'all',
        ids: [],
        state: 'queued',
        total: 0,
        processed: 0,
        requested_by: JSON.stringify({ kind: SYSTEM_ACTOR.kind, id: SYSTEM_ACTOR.id ?? null, name: 'Nightly full reindex' }),
        reason: 'Nightly full reindex',
        started_at: null,
        finished_at: null,
        error: null,
      });
    }
    await this.runJob(job);
  }

  /** Runs a queued (or interrupted) reindex job */
  protected async runJob(job: ReindexJobRow): Promise<void> {
    let current = job;
    if (current.state === 'queued') {
      current = await this.repo.updateJob(current.id, { state: reindexJobMachine.next('queued', 'start'), started_at: this.now() });
    }
    if (current.state !== 'running') return;
    // an engine with its own index (OpenSearch) rebuilds into a new index and swaps it in when done (blue/green)
    const feed = current.scope === 'all' ? this.engine.feed : undefined;
    let building = false;
    try {
      let documents = 0;
      if (current.scope === 'all') {
        if (feed) {
          await feed.beginRebuild();
          building = true;
        }
        const ids = await this.allProductIds();
        await this.repo.updateJob(current.id, { total: ids.length });
        const tree = await this.categoryTree();
        let processed = 0;
        const failed: string[] = [];
        for (const id of ids) {
          // the live index keeps serving: each product's new rows swap in on their own
          try {
            if ((await this.rebuild(id, tree)) === 'indexed') documents++;
          } catch (err) {
            this.ctx.log.warn({ err, productId: id }, 'search: full reindex could not rebuild a product; queued for process-dirty');
            await this.markDirty([id], 'full_reindex');
            failed.push(id);
          }
          processed++;
          if (processed % 50 === 0) await this.repo.updateJob(current.id, { processed });
        }
        await this.repo.updateJob(current.id, { processed });
        if (feed) {
          // products that could not be rebuilt keep their current document
          await feed.finishRebuild(true, failed);
          building = false;
        }
      } else {
        // scoped jobs only mark documents dirty
        documents = (await this.repo.getJob(current.id))?.total ?? 0;
      }
      const done = await this.repo.updateJob(current.id, { state: reindexJobMachine.next('running', 'complete'), finished_at: this.now() });
      this.ctx.events.publish('search.index.rebuilt', { jobId: done.id, scope: done.scope, documents });
    } catch (err) {
      this.ctx.log.error({ err, jobId: current.id }, 'search: reindex job failed');
      if (building) await feed!.finishRebuild(false, []).catch((e) => this.ctx.log.error({ err: e }, 'search: could not drop the half-built index'));
      await this.repo.updateJob(current.id, { state: reindexJobMachine.next('running', 'fail'), finished_at: this.now(), error: err instanceof Error ? err.message.slice(0, 500) : 'Reindex failed' });
    }
  }

  /** Every product the index should look at: documents already indexed plus products with live offers */
  protected async allProductIds(): Promise<string[]> {
    const ids = new Set(await this.repo.documentIds({}));
    try {
      let cursor: string | undefined;
      for (let i = 0; i < 1000; i++) {
        const page = await this.offers.listOffersAdmin({ status: LIVE_STATUSES }, { limit: 100, ...(cursor ? { cursor } : {}) });
        for (const o of page.items) ids.add(o.productId);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'search: offers could not list live offers for a full reindex');
    }
    return [...ids];
  }

  /**
   * search.sales-counts: sales_30d = units of the last 30 market days (product_sales_daily), daily rows older than
   * 90 days deleted, best_selling availability and the top 100 per leaf category
   */
  async salesCounts(): Promise<void> {
    const today = this.marketDate();
    await this.repo.sumSales(addDays(today, -(SALES_WINDOW_DAYS - 1)));
    await this.repo.pruneSales(addDays(today, -SALES_KEEP_DAYS));
    const enabled = (await this.repo.platformUnits30d()) >= (await this.setting('bestSellingMinOrders'));
    await this.repo.rankBestSellers(BEST_SELLER_TOP, enabled);
    this.salesCountedAt = this.now();
  }

  /** When the 30-day sales counts were last refreshed (process memory; documents' indexed_at before the first run) */
  protected salesCountedAt: Date | null = null;

  /** search.prune-logs: recent searches past retention, query and click logs older than 13 months */
  async pruneLogs(): Promise<void> {
    const now = this.now();
    const days = await this.setting('recentSearchRetentionDays');
    await this.repo.pruneRecentSearches(new Date(now.getTime() - days * 86_400_000));
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 13);
    await this.repo.pruneLogs(cutoff);
  }
}
