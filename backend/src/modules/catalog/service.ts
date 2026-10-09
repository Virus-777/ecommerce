import { SYSTEM_ACTOR } from '../../kernel/auth/index.js';
import { AppError } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { toPageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { Attribute, Brand, CatalogPublicApi, Category, Product, ProductAdmin, ProductSnapshot } from '../../spec/catalog.js';
import { addBusinessDays, REVIEW_TARGET_BUSINESS_DAYS } from './domain/rules.js';
import { stringMap, strings } from './mappers.js';
import type { OfferIndexRow } from './ports.js';
import { CatalogAdmin } from './service/admin.js';
import type { By } from './service/base.js';

export type { CatalogServiceDeps } from './service/base.js';

const SYSTEM: By = { actor: SYSTEM_ACTOR };

/**
 * Catalog use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, an endpoint, a consumed event or a job in docs/api/spec/modules/catalog.json.
 * The use cases are layered in service/: base → views → taxonomy → products → review → admin → this class.
 */
export class CatalogService extends CatalogAdmin implements CatalogPublicApi {
  /* ---------------------------------------------------------------- public API (in-process) */

  /** Read shared product content (any product: offers prepare drafts on products still in review) */
  async getProduct(productId: string): Promise<Product | null> {
    const row = await this.repo.getProduct(productId);
    return row ? ((await this.productViews([row])).get(row.id) ?? null) : null;
  }

  /** Approved and Active. Offers only go live on purchasable products. */
  async isPurchasable(productId: string): Promise<boolean> {
    const row = await this.repo.getProduct(productId);
    return Boolean(row && !row.merged_into_id && row.review_state === 'approved' && row.publication === 'active');
  }

  /** Frozen copy of title, brand, options and version stored on an order item (plan ch. 8: purchases keep what was accepted) */
  async snapshotForOrder(variantId: string): Promise<ProductSnapshot> {
    const variant = await this.repo.getVariant(variantId);
    const product = variant && (await this.repo.getProduct(variant.product_id));
    if (!variant || !product) throw new AppError('NOT_FOUND', 'Variant not found');
    const brand = product.brand_id ? await this.repo.getBrand(product.brand_id) : undefined;
    const imageId = strings(variant.media_ids)[0] ?? strings(product.media_ids)[0];
    const image = imageId ? (await this.refsMap([imageId])).get(imageId) : undefined;
    return {
      productId: product.id,
      variantId,
      productVersion: product.version,
      title: product.title,
      brandName: brand?.name ?? null,
      options: stringMap(variant.options),
      modelNumber: product.model_number,
      imageUrl: image?.url ?? null,
      takenAt: this.now().toISOString(),
    };
  }

  /** Category tree for menus and the Categories tab, with in-stock product counts and category images */
  async listCategories(opts: { includeHidden?: boolean } = {}): Promise<Category[]> {
    return this.categoryTree({ includeHidden: Boolean(opts?.includeHidden), admin: Boolean(opts?.includeHidden) });
  }

  /** Category page header, breadcrumb and filterable attributes */
  async getCategoryBySlug(slug: string): Promise<{ category: Category; breadcrumb: Category[]; filters: Attribute[] } | null> {
    const tax = await this.taxonomy();
    const row = tax.rows.find((c) => c.slug === slug);
    if (!row || !tax.visible(row.id)) return null;
    const category = await this.categoryNode(row.id, false);
    const breadcrumb = await Promise.all(tax.path(row.id).map(async (c) => ({ ...(await this.categoryNode(c.id, false)), children: [] })));
    const filters = (await this.effectiveAttributes(row.id, tax)).map((a) => a.attribute).filter((a) => a.filterable);
    return { category, breadcrumb, filters };
  }

  /** Brand page header */
  override async getBrandBySlug(slug: string): Promise<Brand | null> {
    return super.getBrandBySlug(slug);
  }

  /**
   * A product the seller submitted, an approved product the seller has offers on, or any approved and active
   * product. Review fields are filled only for the submitter (ownsSubmission); others see reviewState approved.
   */
  async getProductForSeller(sellerId: string, productId: string): Promise<{ product: ProductAdmin; ownsSubmission: boolean } | null> {
    const row = await this.repo.getProduct(productId);
    if (!row || row.merged_into_id) return null;
    if (row.owner_seller_id === sellerId) return { product: await this.adminView(row, { kind: 'seller', sellerId }), ownsSubmission: true };
    if (row.review_state !== 'approved') return null;
    if (row.publication !== 'active') {
      const mine = await this.repo.offersOfSeller(sellerId, [row.id]);
      if (!mine.some((o) => o.status !== 'removed')) return null;
    }
    const view = await this.adminView(row, { kind: 'seller', sellerId });
    return { product: { ...view, reviewState: 'approved', missing: [], reviewLog: [], submission: null, requestedBrand: null, checks: [], duplicateCandidates: [], reviewDraft: null }, ownsSubmission: false };
  }

  /** Any product with review history and duplicate candidates (staff) */
  async getProductAdmin(productId: string): Promise<ProductAdmin | null> {
    const row = await this.repo.getProduct(productId);
    return row ? this.adminView(row, { kind: 'system' }) : null;
  }

  /** Submissions waiting for review */
  async listReviewQueue(filter: { kind?: unknown; categoryId?: unknown }, page: common.PageInput): Promise<common.Page<ProductAdmin>> {
    return this.reviewQueue(
      { kind: typeof filter?.kind === 'string' ? filter.kind : undefined, categoryId: typeof filter?.categoryId === 'string' ? filter.categoryId : undefined },
      toPageRequest(page),
      { kind: 'system' },
    );
  }

  /** Seller 360 catalog tiles (staff) */
  async countProductsForSellers(
    sellerIds: string[],
  ): Promise<Record<string, { approved: number; inReview: number; changesRequested: number; rejected: number; drafts: number; submissionsBlocked: boolean; blockedNote: string | null; pausedSubmissions: number }>> {
    const ids = [...new Set(sellerIds)];
    const [counts, paused] = await Promise.all([this.repo.countBySellerAndState(ids), this.repo.pausedCounts(ids)]);
    const sellers = this.ctx.tryUse('sellers');
    const out: Awaited<ReturnType<CatalogPublicApi['countProductsForSellers']>> = {};
    for (const id of ids) {
      const n = (state: string) => counts.find((c) => c.seller_id === id && c.review_state === state)?.n ?? 0;
      const can = sellers ? await sellers.canSell(id, { activity: 'product_submissions' }) : { allowed: true as const, reason: undefined };
      out[id] = {
        approved: n('approved'),
        inReview: n('submitted'),
        changesRequested: n('changes_requested'),
        rejected: n('rejected'),
        drafts: n('draft'),
        submissionsBlocked: !can.allowed,
        blockedNote: can.allowed ? null : (can.reason ?? 'Product submissions blocked'),
        pausedSubmissions: paused.get(id) ?? 0,
      };
    }
    return out;
  }

  /** Export rows for reports dataset catalog.admin.products (the filtered admin product list) */
  override async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return super.exportRows(dataset, filters, principal, cursor);
  }

  /* ---------------------------------------------------------------- store reads */

  /** Store product page: approved and active only; a merged duplicate answers with the product it was merged into */
  async storeProduct(id: string): Promise<Product> {
    let row = await this.repo.getProduct(id);
    if (row?.merged_into_id) row = await this.repo.getProduct(row.merged_into_id);
    if (!row || row.merged_into_id || row.review_state !== 'approved' || row.publication !== 'active') throw new AppError('NOT_FOUND', 'Product not found');
    return (await this.productViews([row])).get(row.id)!;
  }

  /* ---------------------------------------------------------------- events consumed */

  /** sellers.seller.restricted: a restriction on product submissions (optionally in some categories) pauses the seller's open submissions */
  async onSellerRestrictedFromSellers(event: EventPayload<'sellers.seller.restricted'>): Promise<void> {
    if (!event.affectedActivities.includes('product_submissions')) return;
    const tax = await this.taxonomy();
    const scope = event.categoryIds?.length ? event.categoryIds : (event.scope?.categoryIds ?? []);
    const categoryIds = scope.length ? [...new Set(scope.flatMap((c) => tax.subtree(c)))] : undefined;
    if (categoryIds && !categoryIds.length) return;
    await this.pauseSubmissions(event.sellerId, categoryIds);
  }

  /** sellers.seller.suspended: pause the seller's open submissions in the review queue */
  async onSellerSuspendedFromSellers(event: EventPayload<'sellers.seller.suspended'>): Promise<void> {
    await this.pauseSubmissions(event.sellerId);
  }

  /** sellers.seller.reinstated: paused submissions go back to the queue (unless a remaining restriction still covers them) */
  async onSellerReinstatedFromSellers(event: EventPayload<'sellers.seller.reinstated'>): Promise<void> {
    const paused = await this.repo.openSubmissionsOfSeller(event.sellerId, { paused: true });
    if (!paused.length) return;
    const sellers = this.ctx.tryUse('sellers');
    const products = new Map((await this.repo.getProducts(paused.map((s) => s.product_id))).map((p) => [p.id, p]));
    for (const s of paused) {
      if (sellers && event.remainingRestrictionIds.length) {
        const can = await sellers.canSell(event.sellerId, { activity: 'product_submissions', ...(products.get(s.product_id)?.category_id ? { categoryId: products.get(s.product_id)!.category_id! } : {}) });
        if (!can.allowed) continue;
      }
      // back in its original place: the target counted from when it was submitted
      await this.repo.updateSubmission(s.id, { review_due_at: addBusinessDays(s.submitted_at, REVIEW_TARGET_BUSINESS_DAYS) });
    }
  }

  private async pauseSubmissions(sellerId: string, categoryIds?: string[]) {
    for (const s of await this.repo.openSubmissionsOfSeller(sellerId, { categoryIds, paused: false })) {
      await this.repo.updateSubmission(s.id, { review_due_at: null });
    }
  }

  /** trust.enforcement.recorded: suspend products named in a suspend_product enforcement */
  async onEnforcementRecordedFromTrust(event: EventPayload<'trust.enforcement.recorded'>): Promise<void> {
    if (event.action !== 'suspend_product' || event.alreadyApplied) return;
    const targets = (event.targets ?? []) as { type?: string; id?: string }[];
    for (const t of targets) {
      if (t?.type !== 'product' || !t.id) continue;
      const p = await this.repo.getProduct(t.id);
      if (!p) {
        this.ctx.log.info({ productId: t.id, enforcementId: event.enforcementId }, 'catalog: enforcement names an unknown product');
        continue;
      }
      if (p.publication === 'suspended') continue; // already applied
      await this.changePublication(p.id, { to: 'suspended', reason: `Trust and Risk enforcement: ${event.reason}`, trustReportId: event.reportId }, SYSTEM, { system: true });
    }
  }

  /** offers.offer.created: add the offer to offer_index and refresh listing_stats */
  async onOfferCreatedFromOffers(event: EventPayload<'offers.offer.created'>): Promise<void> {
    if (!(await this.repo.getProduct(event.productId))) {
      this.ctx.log.info({ offerId: event.offerId, productId: event.productId }, 'catalog: offer on an unknown product ignored');
      return;
    }
    const existing = await this.repo.getOffer(event.offerId);
    await this.repo.upsertOffer({
      offer_id: event.offerId,
      product_id: event.productId,
      variant_id: event.variantId,
      owner_type: event.ownerType === 'official' ? 'official' : 'seller',
      seller_id: event.sellerId ?? null,
      seller_name: existing?.seller_name ?? (await this.sellerName(event.sellerId ?? null)),
      condition: event.condition,
      status: existing?.status ?? 'draft',
      eligible: existing?.eligible ?? false,
      in_stock: existing?.in_stock ?? false,
      price: (existing?.price ?? null) as never,
      updated_at: this.now(),
    });
    await this.refreshListing(event.productId);
  }

  /** offers.offer.status_changed: eligibility in offer_index (active offers are eligible) and listing_stats */
  async onOfferStatusChangedFromOffers(event: EventPayload<'offers.offer.status_changed'>): Promise<void> {
    if (!(await this.ensureOffer(event))) return;
    await this.repo.updateOffer(event.offerId, { status: event.to, eligible: event.to === 'active', updated_at: this.now() });
    await this.refreshListing(event.productId);
  }

  /** offers.offer.price_changed: the offer price and the product's best price */
  async onOfferPriceChangedFromOffers(event: EventPayload<'offers.offer.price_changed'>): Promise<void> {
    if (!(await this.ensureOffer(event))) return;
    await this.repo.updateOffer(event.offerId, { price: event.to as never, updated_at: this.now() });
    await this.refreshListing(event.productId);
  }

  /** inventory.stock.changed: in_stock of the offer and listing_stats */
  async onStockChangedFromInventory(event: EventPayload<'inventory.stock.changed'>): Promise<void> {
    if (!event.offerId) return;
    const offer = await this.repo.getOffer(event.offerId);
    if (!offer) {
      this.ctx.log.debug({ offerId: event.offerId }, 'catalog: stock change for an offer not in offer_index');
      return;
    }
    await this.repo.updateOffer(offer.offer_id, { in_stock: event.available > 0 && event.state !== 'out_of_stock', updated_at: this.now() });
    await this.refreshListing(offer.product_id);
  }

  /** sellers.change_request.decided: an approved brand_request adds (or activates) the brand */
  async onChangeRequestDecidedFromSellers(event: EventPayload<'sellers.change_request.decided'>): Promise<void> {
    if (event.kind !== 'brand_request' || !event.approved) return;
    const req = (event.brandRequest ?? {}) as { brandName?: string; name?: string };
    const brandName = req.brandName ?? req.name;
    if (!brandName) {
      this.ctx.log.warn({ changeRequestId: event.changeRequestId }, 'catalog: approved brand request without a brand name');
      return;
    }
    await this.brandFromChangeRequest({ changeRequestId: event.changeRequestId, sellerId: event.sellerId, brandName });
  }

  /** An offer event can arrive before offers.offer.created was handled: index what the event says */
  private async ensureOffer(e: { offerId: string; productId: string; variantId: string; sellerId?: string | null; ownerType: string }): Promise<OfferIndexRow | null> {
    const existing = await this.repo.getOffer(e.offerId);
    if (existing) return existing;
    if (!(await this.repo.getProduct(e.productId))) return null;
    const row: OfferIndexRow = {
      offer_id: e.offerId,
      product_id: e.productId,
      variant_id: e.variantId,
      owner_type: e.ownerType === 'official' ? 'official' : 'seller',
      seller_id: e.sellerId ?? null,
      seller_name: await this.sellerName(e.sellerId ?? null),
      condition: 'unknown',
      status: 'draft',
      eligible: false,
      in_stock: false,
      price: null,
      updated_at: this.now(),
    };
    await this.repo.upsertOffer(row);
    return row;
  }

  private async sellerName(sellerId: string | null): Promise<string | null> {
    if (!sellerId) return null;
    try {
      return (await this.ctx.tryUse('sellers')?.getSellers([sellerId]))?.[0]?.storeName ?? null;
    } catch (err) {
      this.ctx.log.debug({ err, sellerId }, 'catalog: seller name unavailable');
      return null; // the name only decorates offer notes
    }
  }
}
