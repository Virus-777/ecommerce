import { SYSTEM_ACTOR } from '../../kernel/auth/index.js';
import { AppError } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { toPageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { Attribute, Brand, CatalogPublicApi, Category, CategoryPath, Product, ProductAdmin, ProductRecord, ProductSnapshot, ProductSummary, VariantParcel, VariantRef } from '../../spec/catalog.js';
import { isUuid } from '../../kernel/lib/ids.js';
import { stringMap, strings } from './mappers.js';
import { currentListPrice } from './service/products.js';
import type { OfferIndexRow } from './ports.js';
import { CatalogAdmin } from './service/admin.js';
import type { By } from './service/base.js';
import { OVERRIDE_ACTION } from './service/review.js';

export type { CatalogServiceDeps } from './service/base.js';

const SYSTEM: By = { actor: SYSTEM_ACTOR };
const MAX_BATCH = 200;
const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });

/**
 * Catalog use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
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
      categoryId: product.category_id ?? null,
      productVersion: product.version,
      title: product.title,
      brandName: brand?.name ?? null,
      options: stringMap(variant.options),
      modelNumber: product.model_number,
      imageUrl: image?.url ?? null,
      imageId: imageId ?? null,
      image: image ?? null,
      takenAt: this.now().toISOString(),
    };
  }

  /** Batch read in any review state or publication; merged records carry mergedIntoId. Unknown ids are left out (200 at most). */
  async getProducts(productIds: string[]): Promise<ProductRecord[]> {
    const ids = [...new Set((productIds ?? []).filter(isUuid))];
    if (ids.length > MAX_BATCH) throw invalid('productIds', `Ask for at most ${MAX_BATCH} products at a time`);
    const rows = await this.repo.getProducts(ids);
    const views = await this.productViews(rows);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      if (!r) return [];
      return [
        {
          product: views.get(id)!,
          reviewState: r.review_state as ProductRecord['reviewState'],
          publication: r.publication as ProductRecord['publication'],
          purchasable: !r.merged_into_id && r.review_state === 'approved' && r.publication === 'active',
          ownerSellerId: r.owner_seller_id,
          mergedIntoId: r.merged_into_id,
        },
      ];
    });
  }

  /** Product pickers in other modules' admin screens: q matches title, PRD- ref, model number, MPN and GTIN */
  async searchProducts(
    filter: { q?: string; categoryId?: string; brandId?: string; ownerSellerId?: string; purchasableOnly?: boolean; reviewStates?: string[] },
    page: common.PageInput,
  ): Promise<common.Page<ProductSummary>> {
    const tax = filter?.categoryId ? await this.taxonomy() : null;
    const p = await this.repo.listProducts(
      {
        q: filter?.q,
        matchGtin: true,
        ...(tax && filter.categoryId ? { categoryIds: tax.subtree(filter.categoryId) } : {}),
        ...(filter?.brandId ? { brandId: filter.brandId } : {}),
        ...(filter?.ownerSellerId ? { ownerSellerId: filter.ownerSellerId } : {}),
        ...(filter?.reviewStates?.length ? { reviewStates: filter.reviewStates } : {}),
        purchasableOnly: Boolean(filter?.purchasableOnly),
      },
      toPageRequest(page),
    );
    const s = await this.summaries(p.items);
    return { ...p, items: p.items.map((r) => s.get(r.id)!) };
  }

  /** Keyset walk over product ids (by id, 1–1000 per call) for index rebuilds */
  async listProductIds(opts: { after?: string; limit: number; purchasableOnly?: boolean; updatedSince?: string }): Promise<{ ids: string[]; nextAfter: string | null }> {
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(opts?.limit) || 0)));
    if (opts?.after && !isUuid(opts.after)) throw invalid('after', 'Not a product id');
    const since = opts?.updatedSince ? new Date(opts.updatedSince) : undefined;
    if (since && Number.isNaN(since.getTime())) throw invalid('updatedSince', 'Not a date and time');
    const ids = await this.repo.productIdsAfter({ includeMerged: true, purchasableOnly: Boolean(opts?.purchasableOnly), ...(since ? { updatedSince: since } : {}) }, opts?.after ?? null, limit);
    return { ids, nextAfter: ids.length === limit ? ids.at(-1)! : null };
  }

  /** Brands by id with status (any status). Unknown ids are left out. */
  async getBrands(brandIds: string[]): Promise<Brand[]> {
    const ids = [...new Set((brandIds ?? []).filter(isUuid))];
    const rows = await this.repo.getBrands(ids);
    const views = await this.brandViews(rows);
    return ids.flatMap((id) => (views.has(id) ? [views.get(id)!] : []));
  }

  /** Variants by id with product id and title, options, GTIN, parcel data and list price. Unknown ids are left out. */
  async getVariants(variantIds: string[]): Promise<VariantRef[]> {
    const ids = [...new Set((variantIds ?? []).filter(isUuid))];
    const variants = await this.repo.getVariants(ids);
    const products = new Map((await this.repo.getProducts([...new Set(variants.map((v) => v.product_id))])).map((p) => [p.id, p]));
    const byId = new Map(variants.map((v) => [v.id, v]));
    return ids.flatMap((id) => {
      const v = byId.get(id);
      const p = v && products.get(v.product_id);
      if (!v || !p) return [];
      return [
        {
          id: v.id,
          productId: p.id,
          productTitle: p.title,
          options: stringMap(v.options),
          gtin: v.gtin,
          weightGrams: v.weight_grams,
          lengthCm: v.length_cm,
          widthCm: v.width_cm,
          heightCm: v.height_cm,
          listPrice: currentListPrice(v),
        },
      ];
    });
  }

  /** Shipping weight and dimensions of one unit per variant; null when the variant has no weight yet (callers use their default parcel) */
  async getParcels(variantIds: string[]): Promise<Record<string, VariantParcel | null>> {
    const ids = [...new Set((variantIds ?? []).filter(isUuid))];
    const byId = new Map((await this.repo.getVariants(ids)).map((v) => [v.id, v]));
    const out: Record<string, VariantParcel | null> = {};
    for (const id of variantIds ?? []) {
      const v = byId.get(id);
      out[id] = v && v.weight_grams ? { weightGrams: v.weight_grams, lengthCm: v.length_cm, widthCm: v.width_cm, heightCm: v.height_cm } : null;
    }
    return out;
  }

  /** Root-first category names and ids per category (unknown ids are left out) */
  async getCategoryPaths(categoryIds: string[]): Promise<Record<string, CategoryPath>> {
    const tax = await this.taxonomy();
    const out: Record<string, CategoryPath> = {};
    for (const id of new Set(categoryIds ?? [])) {
      if (!tax.byId.has(id)) continue;
      const path = tax.path(id);
      out[id] = { categoryId: id, names: path.map((c) => c.name), ids: path.map((c) => c.id) };
    }
    return out;
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
    const clock = await this.reviewClock();
    const sellers = this.ctx.tryUse('sellers');
    const products = new Map((await this.repo.getProducts(paused.map((s) => s.product_id))).map((p) => [p.id, p]));
    for (const s of paused) {
      if (sellers && event.remainingRestrictionIds.length) {
        const can = await sellers.canSell(event.sellerId, { activity: 'product_submissions', ...(products.get(s.product_id)?.category_id ? { categoryId: products.get(s.product_id)!.category_id! } : {}) });
        if (!can.allowed) continue;
      }
      // back in its original place: the deadline it kept while paused (rows paused before paused_at existed have none:
      // the target counted from when it was submitted)
      await this.repo.updateSubmission(s.id, { paused_at: null, ...(s.review_due_at ? {} : { review_due_at: clock.addBusinessDays(s.submitted_at, clock.targetDays) }) });
    }
  }

  private async pauseSubmissions(sellerId: string, categoryIds?: string[]) {
    for (const s of await this.repo.openSubmissionsOfSeller(sellerId, { categoryIds, paused: false })) {
      await this.repo.updateSubmission(s.id, { paused_at: this.now() });
    }
  }

  /**
   * access.approval.decided: finish a publication override that needed approval. Approved: reactivate the product
   * (as the requester, with the approval on the audit entry). Rejected, cancelled or expired: the pending override is
   * dropped (it lives only in the approval request), so the product stays suspended.
   */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>, eventId?: string): Promise<void> {
    if (event.actionKey !== OVERRIDE_ACTION || event.target?.type !== 'product') return;
    const key = `approval-decided:${event.requestId}`;
    const p = await this.repo.getProduct(event.target.id);
    if (!p) {
      this.ctx.log.info({ productId: event.target.id, approvalRequestId: event.requestId, eventId }, 'catalog: approval decided for an unknown product');
      return;
    }
    if (event.outcome !== 'approved' || p.publication !== 'suspended') {
      if (event.outcome === 'approved') this.ctx.log.info({ productId: p.id, publication: p.publication, approvalRequestId: event.requestId }, 'catalog: approved override no longer applies');
      await this.repo.transaction((tx) => tx.claim(key));
      return;
    }
    const request = await this.ctx
      .tryUse('access')
      ?.getApproval(event.requestId)
      .catch(() => null);
    const actor: common.Actor = request?.requestedBy ?? { kind: 'staff', id: event.requestedById };
    const reason = request?.reason?.trim() || event.reason?.trim() || 'Second reviewer approved the reactivation';
    await this.changePublication(p.id, { to: 'active', reason, trustReportId: null }, { actor }, {
      system: true,
      claim: key,
      approvalRequestId: event.requestId,
      approvalNote: 'Second reviewer approved the reactivation',
    });
  }

  /**
   * trust.enforcement.recorded: suspend products named in a suspend_product enforcement. The review-log entry keeps
   * enforcementId and trustReportId, and catalog.product.publication_changed carries both (trust confirms with it).
   */
  async onEnforcementRecordedFromTrust(event: EventPayload<'trust.enforcement.recorded'>): Promise<void> {
    if (event.action !== 'suspend_product' || event.alreadyApplied) return;
    for (const t of productTargets(event.targets)) {
      const p = await this.repo.getProduct(t);
      if (!p) {
        this.ctx.log.info({ productId: t, enforcementId: event.enforcementId }, 'catalog: enforcement names an unknown product');
        continue;
      }
      if (p.publication === 'suspended') continue; // already applied
      await this.changePublication(
        p.id,
        { to: 'suspended', reason: `Trust and Risk enforcement: ${event.reason}`, trustReportId: event.reportId, trustEnforcementId: event.enforcementId },
        SYSTEM,
        { system: true, claim: `enforcement-recorded:${event.enforcementId}:${p.id}` },
      );
    }
  }

  /**
   * trust.enforcement.reversed: action suspend_product reactivates each target product whose current suspension came
   * from that enforcement (enforcementId on its latest publication_changed log entry). Products suspended again since,
   * or merged, are left alone. No publication-override approval: the reversal was approved in trust.
   */
  async onEnforcementReversedFromTrust(event: EventPayload<'trust.enforcement.reversed'>): Promise<void> {
    if (event.action !== 'suspend_product') return;
    for (const t of productTargets(event.targets)) {
      const p = await this.repo.getProduct(t);
      if (!p || p.merged_into_id || p.publication !== 'suspended') {
        this.ctx.log.info({ productId: t, enforcementId: event.enforcementId, publication: p?.publication ?? null }, 'catalog: reversed enforcement leaves the product as it is');
        continue;
      }
      const last = await this.repo.latestLog(p.id, 'publication_changed');
      const f = stringMap(last?.fields);
      if (f.to !== 'suspended' || f.enforcementId !== event.enforcementId) {
        this.ctx.log.info({ productId: p.id, enforcementId: event.enforcementId }, 'catalog: the current suspension is not from the reversed enforcement');
        continue;
      }
      await this.changePublication(
        p.id,
        { to: 'active', reason: `Trust and Risk enforcement ${event.ref} reversed: ${event.reason}`, trustReportId: event.reportId, trustEnforcementId: event.enforcementId },
        SYSTEM,
        { system: true, claim: `enforcement-reversed:${event.enforcementId}:${p.id}`, approvalNote: 'Reversal approved in Trust and Risk' },
      );
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
      // a price_changed handled first is newer than the creation price
      price: (existing?.price ?? event.price ?? null) as never,
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
    // the stock event can be handled before offers.offer.created: index what it says rather than lose the change
    const offer = await this.ensureOffer({ offerId: event.offerId, productId: event.productId, variantId: event.variantId, sellerId: event.sellerId, ownerType: event.ownerType });
    if (!offer) {
      this.ctx.log.debug({ offerId: event.offerId }, 'catalog: stock change for an offer on an unknown product');
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
    // another event of the same offer may index it at the same moment: never overwrite what it wrote
    await this.repo.insertOfferIfMissing(row);
    return (await this.repo.getOffer(e.offerId)) ?? row;
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

/** Product ids named by an enforcement's targets */
function productTargets(targets: unknown): string[] {
  const list = (Array.isArray(targets) ? targets : []) as { type?: string; id?: string }[];
  return [...new Set(list.filter((t) => t?.type === 'product' && typeof t.id === 'string' && isUuid(t.id)).map((t) => t.id!))];
}
