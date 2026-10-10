/** Lists, review queue, stats, exports, corrections, merges, bulk edits, catalog matching and the listing read model. */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { decodeCursor, encodeCursor, pageOf, toPageRequest, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type { AffectedSeller, CatalogMatch, CorrectionSuggestion, MergedRecord, MergePreview, MergePreviewRecord, MergeRequest, MergeResult, ProductAdmin, ProductStats, ProductSummary } from '../../../spec/catalog.js';
import type { ExportJob } from '../../../spec/reports.js';
import { IDENTITY_FIELDS, isCorrectableField, linesOf, matchQuality, PARCEL_COLUMNS, PARCEL_FIELDS, sameOptions, variantLabel } from '../domain/rules.js';
import { checkListPrice, checkParcelValue, currentListPrice } from './products.js';
import { stringMap, strings, toCorrection } from '../mappers.js';
import type { CorrectionRow, OfferIndexRow, ProductFilter, ProductRow, VariantRow } from '../ports.js';
import { invalid, notFound, requireReason, type By, type Viewer } from './base.js';
import { CatalogReview } from './review.js';

export const EXPORT_DATASET = 'catalog.admin.products';
const EXPORT_BATCH = 500;
const NOT_LIVE: Record<string, string> = { paused: 'paused', out_of_stock: 'out of stock', ineligible: 'ineligible', draft: 'not published' };

export interface AdminProductQuery {
  q?: string;
  categoryId?: string;
  brandId?: string;
  sellerId?: string;
  reviewState?: string;
  publication?: string;
  missingContent?: boolean;
  duplicateSuspected?: boolean;
}

const bool = (v: unknown) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export class CatalogAdmin extends CatalogReview {
  /* ================================================================ lists */

  protected async productFilter(q: AdminProductQuery): Promise<ProductFilter> {
    const tax = q.categoryId ? await this.taxonomy() : null;
    return {
      q: q.q,
      categoryIds: q.categoryId ? tax!.subtree(q.categoryId) : undefined,
      brandId: q.brandId,
      ownerSellerId: q.sellerId,
      reviewStates: q.reviewState ? [q.reviewState] : undefined,
      publication: q.publication,
      missingContent: q.missingContent,
      duplicateSuspected: q.duplicateSuspected,
    };
  }

  async listProductsAdmin(query: AdminProductQuery, page: PageRequest, viewer: Viewer): Promise<common.Page<ProductAdmin>> {
    const p = await this.repo.listProducts(await this.productFilter(query), page);
    return { ...p, items: await this.adminViews(p.items, viewer) };
  }

  async listOwnProducts(sellerId: string, query: { reviewState?: string; q?: string }, page: PageRequest): Promise<common.Page<ProductAdmin>> {
    const p = await this.repo.listProducts({ ownerSellerId: sellerId, reviewStates: query.reviewState ? [query.reviewState] : undefined, q: query.q }, page);
    return { ...p, items: await this.adminViews(p.items, { kind: 'seller', sellerId }) };
  }

  async getOwnProduct(sellerId: string, id: string): Promise<ProductAdmin> {
    return this.adminView(await this.ownProduct(sellerId, id), { kind: 'seller', sellerId });
  }

  async productAdminFor(id: string, viewer: Viewer): Promise<ProductAdmin> {
    return this.adminView(await this.product(id), viewer);
  }

  /** Open submissions, by review deadline; paused ones (restricted or suspended sellers) are left out */
  async reviewQueue(filter: { kind?: string; categoryId?: string }, page: PageRequest, viewer: Viewer): Promise<common.Page<ProductAdmin>> {
    const kind = filter.kind === 'correction' ? 'content_change' : filter.kind;
    const categoryIds = filter.categoryId ? (await this.taxonomy()).subtree(filter.categoryId) : undefined;
    const p = await this.repo.reviewQueue({ kind, categoryIds }, page);
    const products = new Map((await this.repo.getProducts(p.items.map((s) => s.product_id))).map((r) => [r.id, r]));
    const rows = p.items.flatMap((s) => (products.has(s.product_id) ? [products.get(s.product_id)!] : []));
    return { ...p, items: await this.adminViews(rows, viewer) };
  }

  async productStats(): Promise<ProductStats> {
    return this.repo.productStats();
  }

  /* ================================================================ exports (reports runs the job) */

  #datasetRegistered?: Promise<void>;

  private registerDataset(): Promise<void> {
    const reports = this.ctx.tryUse('reports');
    if (!reports) return Promise.resolve();
    this.#datasetRegistered ??= reports
      .registerDataset({
        key: EXPORT_DATASET,
        owner: 'catalog',
        title: 'Catalog products',
        permission: 'catalog.products.export',
        audience: 'staff',
        screens: ['admin/catalog'],
        available: true,
        phase: 1,
        columns: [
          ['ref', 'Reference'], ['title', 'Title'], ['brand', 'Brand'], ['category', 'Category'], ['owner', 'Owner'], ['sellerId', 'Seller id'],
          ['reviewState', 'Review state'], ['publication', 'Publication'], ['contentScore', 'Content score'], ['duplicateSuspected', 'Duplicate suspected'],
          ['offerCount', 'Offers'], ['liveOfferCount', 'Live offers'], ['bestPrice', 'Best price'], ['modelNumber', 'Model number'], ['updatedAt', 'Updated'], ['listedAt', 'Listed'],
        ].map(([key, label]) => ({ key, label })),
      })
      .catch((err) => {
        this.#datasetRegistered = undefined;
        if (!isNotImplemented(err)) throw err; // reports not built yet: requestExport answers for it
      });
    return this.#datasetRegistered;
  }

  /** At boot: reports lists the dataset (and hides the Export button while catalog is off) */
  async registerExportDataset() {
    try {
      await this.registerDataset();
    } catch (err) {
      this.ctx.log.warn({ err }, 'catalog: could not register the export dataset');
    }
  }

  async exportProducts(body: { filters: unknown; format?: 'csv' | 'xlsx' | null }, by: By): Promise<ExportJob> {
    const reports = this.ctx.tryUse('reports');
    if (!reports || !by.principal) throw new AppError('SERVICE_UNAVAILABLE', 'Exports are unavailable right now', { dataset: EXPORT_DATASET });
    const filters = this.parseExportFilters(body.filters);
    await this.registerDataset();
    await this.audit(
      { action: 'catalog.products.export', actionLabel: 'Exported product list', category: 'catalog', target: { type: 'export', id: EXPORT_DATASET, label: `Product list (${(body.format ?? 'csv').toUpperCase()})`, screen: 'admin/catalog' }, after: { filters, format: body.format ?? 'csv' } },
      by,
    );
    return reports.requestExport({ dataset: EXPORT_DATASET, filters, format: body.format ?? 'csv', principal: by.principal });
  }

  protected parseExportFilters(f: unknown): AdminProductQuery {
    const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    return {
      q: str(o.q),
      categoryId: str(o.categoryId),
      brandId: str(o.brandId),
      sellerId: str(o.sellerId),
      reviewState: str(o.reviewState),
      publication: str(o.publication),
      missingContent: bool(o.missingContent),
      duplicateSuspected: bool(o.duplicateSuspected),
    };
  }

  async exportRows(dataset: string, filters: unknown, principal: Principal | { kind: string }, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (dataset !== EXPORT_DATASET) throw invalid('dataset', `catalog serves only the ${EXPORT_DATASET} dataset`);
    if (principal?.kind !== 'staff') throw new AppError('FORBIDDEN', 'The product list is exported by staff only', { permission: 'catalog.products.export' });
    const after = cursor ? String(decodeCursor(cursor)[0]) : null;
    const rows = await this.repo.productBatch(await this.productFilter(this.parseExportFilters(filters)), after, EXPORT_BATCH + 1);
    const batch = rows.slice(0, EXPORT_BATCH);
    const views = await this.adminViews(batch, { kind: 'system' });
    const out = views.map((v) => ({
      ref: v.product.ref,
      title: v.product.title,
      brand: v.product.brand?.name ?? null,
      category: v.product.categoryPath.join(' › '),
      owner: v.owner,
      sellerId: v.ownerSellerId ?? null,
      reviewState: v.reviewState,
      publication: v.publication,
      contentScore: v.contentScore,
      duplicateSuspected: v.duplicateSuspected,
      offerCount: v.offerCount,
      liveOfferCount: v.liveOfferCount,
      bestPrice: v.bestPrice ? (v.bestPrice.amount / 100).toFixed(2) : null,
      modelNumber: v.product.modelNumber ?? null,
      updatedAt: v.product.updatedAt,
      listedAt: v.product.listedAt ?? null,
    }));
    return rows.length > EXPORT_BATCH ? { rows: out, nextCursor: encodeCursor([batch.at(-1)!.id]) } : { rows: out };
  }

  /* ================================================================ corrections */

  /** The current value of a field as text (for the suggestion and the reviewer) */
  private async currentText(p: ProductRow, field: string): Promise<string | null> {
    switch (field) {
      case 'title':
        return p.title;
      case 'description':
        return p.description;
      case 'keyFeatures':
        return strings(p.key_features).join('\n');
      case 'includedItems':
        return strings(p.included_items).join('\n');
      case 'modelNumber':
        return p.model_number;
      case 'manufacturerPartNumber':
        return p.mpn;
      case 'brand':
        return p.brand_id ? ((await this.repo.getBrand(p.brand_id))?.name ?? null) : null;
      case 'category':
        return (await this.taxonomy()).path(p.category_id).map((c) => c.name).join(' › ') || null;
      case 'variants':
        return (await this.repo.variantsOf([p.id])).map((v) => variantLabel(stringMap(v.options))).join('\n');
      default:
        return field.startsWith('specs.') ? (stringMap(p.specs)[field.slice(6)] ?? null) : null;
    }
  }

  async suggestCorrection(sellerId: string, id: string, body: { field: string; proposed: string; evidenceIds?: string[] | null }, by: By): Promise<CorrectionSuggestion> {
    const p = await this.repo.getProduct(id);
    if (!p || p.merged_into_id || (p.owner_seller_id !== sellerId && p.review_state !== 'approved')) throw notFound();
    if (p.review_state !== 'approved') throw new AppError('ILLEGAL_TRANSITION', 'Edit your draft instead; corrections are for approved products', { from: p.review_state, event: 'suggestCorrection' });
    const field = body.field?.trim();
    if (!field || !isCorrectableField(field)) throw invalid('field', 'Choose a product field to correct (title, description, keyFeatures, includedItems, modelNumber, manufacturerPartNumber, brand, category, images, variants, video or specs.<attribute>)');
    const proposed = body.proposed?.trim();
    if (!proposed) throw invalid('proposed', 'Say what the field should be');
    if (proposed.length > 10_000) throw invalid('proposed', 'The proposal is too long');
    const evidenceIds = [...new Set(body.evidenceIds ?? [])];
    if (evidenceIds.length > 10) throw invalid('evidenceIds', 'Up to 10 evidence files');
    const suggestionId = newId();
    // evidence (photos, invoices, brand letters) is kept as correction evidence so the orphan sweep never deletes it
    const items = [];
    for (const [i, assetId] of evidenceIds.entries()) {
      const asset = await this.media.getAsset(assetId);
      if (!asset) throw invalid(`evidenceIds[${i}]`, 'File not found; upload it again');
      items.push({ assetId, kind: 'correction_evidence' as const, path: `evidenceIds[${i}]` });
    }
    const undo = await this.attachAll(items, { refId: suggestionId, refLabel: `Correction to ${p.ref}` }, { kind: 'seller', id: sellerId });
    let row: CorrectionRow;
    try {
      row = await this.repo.insertCorrection({
        id: suggestionId,
        product_id: id,
        seller_id: sellerId,
        field,
        current: await this.currentText(p, field),
        proposed,
        evidence_media_ids: evidenceIds as never,
        state: 'open',
        decision_reason: null,
        decided_by: null,
        created_at: this.now(),
      });
    } catch (err) {
      await undo();
      throw err;
    }
    this.ctx.events.publish('catalog.correction.suggested', { suggestionId, productId: id }, { actor: by.actor, requestId: by.requestId });
    return toCorrection(row, await this.refsMap(evidenceIds));
  }

  async listCorrections(state: string | undefined, page: PageRequest): Promise<common.Page<CorrectionSuggestion>> {
    const p = await this.repo.listCorrections({ state: state ?? 'open' }, page);
    const refs = await this.refsMap(p.items.flatMap((c) => strings(c.evidence_media_ids)));
    return { ...p, items: p.items.map((c) => toCorrection(c, refs)) };
  }

  /**
   * Accepting applies text fields to the shared content (version bump, catalog.product.updated); fields that change
   * what the product is (model, MPN, brand, category, variants) send it back to review (reopen).
   */
  async decideCorrection(id: string, body: { accept: boolean; reason: string }, by: By): Promise<CorrectionSuggestion> {
    const reason = requireReason(body.reason);
    const before = await this.repo.getCorrection(id);
    if (!before) throw notFound('Correction');
    if (before.state !== 'open') throw new AppError('ILLEGAL_TRANSITION', `This correction was already ${before.state}`, { from: before.state, event: body.accept ? 'accept' : 'decline' });
    const now = this.now();
    // prepared outside the transaction (lookups and references use their own connection)
    const current = body.accept ? await this.repo.getProduct(before.product_id) : undefined;
    if (body.accept && !current) throw notFound();
    const patch = current ? await this.correctionPatch(current, before.field, before.proposed) : {};
    const ref = current && IDENTITY_FIELDS.includes(before.field) && current.review_state === 'approved' ? await this.submissionRef() : null;
    const targetDays = ref ? await this.reviewTargetDays() : 1;
    let product: ProductRow | null = null;
    let reopened: Awaited<ReturnType<typeof this.reopenTx>> | null = null;
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.getCorrection(id, { forUpdate: true });
      if (!locked || locked.state !== 'open') throw new AppError('ILLEGAL_TRANSITION', 'This correction was already decided', { from: locked?.state, event: 'decide' });
      if (body.accept) {
        const p = await tx.getProduct(locked.product_id, { forUpdate: true });
        if (!p) throw notFound();
        product = await tx.updateProduct(p.id, { ...patch, version: p.version + 1, updated_at: now });
        await tx.insertLog({ id: newId(), product_id: p.id, action: 'correction_accepted', reason, fields: { field: locked.field, proposed: locked.proposed.slice(0, 500) } as never, actor_kind: by.actor.kind, actor_id: by.actor.id ?? null, at: now });
        if (ref && product.review_state === 'approved') {
          reopened = await this.reopenTx(tx, product, by, `Accepted correction to ${locked.field}: ${locked.proposed.slice(0, 200)}`, ref, targetDays);
          product = reopened.product;
        }
      }
      return tx.updateCorrection(id, { state: body.accept ? 'accepted' : 'declined', decision_reason: reason, decided_by: by.actor.id ?? by.actor.kind });
    });
    const meta = { actor: by.actor, requestId: by.requestId };
    if (product) {
      const p = product as ProductRow;
      await this.recomputeScores([p]);
      this.ctx.events.publish('catalog.product.updated', { productId: p.id, version: p.version, title: p.title }, meta);
    }
    if (reopened) {
      const r = reopened as Awaited<ReturnType<typeof this.reopenTx>>;
      await this.afterSubmit(r.product, r.submission, by, null);
    }
    this.ctx.events.publish('catalog.correction.decided', { suggestionId: id, accepted: body.accept }, meta);
    const target = await this.repo.getProduct(before.product_id);
    await this.audit(
      {
        action: body.accept ? 'catalog.correction.accept' : 'catalog.correction.decline',
        actionLabel: body.accept ? 'Accepted correction' : 'Declined correction',
        category: 'catalog',
        target: target ? this.productTarget(target) : { type: 'product', id: before.product_id },
        relatedTargets: [{ type: 'correction', id, label: before.field, sellerId: before.seller_id }],
        reason,
        before: { field: before.field, value: before.current },
        after: { field: before.field, value: body.accept ? before.proposed : before.current, state: after.state },
        visibleToSeller: true,
      },
      by,
    );
    return toCorrection(after, await this.refsMap(strings(after.evidence_media_ids)));
  }

  private async correctionPatch(p: ProductRow, field: string, proposed: string): Promise<Partial<ProductRow>> {
    switch (field) {
      case 'title':
        return { title: proposed.slice(0, 200) };
      case 'description':
        return { description: proposed };
      case 'keyFeatures':
        return { key_features: linesOf(proposed) as never };
      case 'includedItems':
        return { included_items: linesOf(proposed) as never };
      case 'modelNumber':
        return { model_number: proposed };
      case 'manufacturerPartNumber':
        return { mpn: proposed };
      case 'brand': {
        const b = await this.repo.findBrandByName(proposed);
        return b && b.status === 'active' ? { brand_id: b.id } : {};
      }
      case 'category': {
        const leaf = proposed.split(/›|>|\//).pop()!.trim().toLowerCase();
        const c = (await this.repo.allCategories()).find((x) => x.name.toLowerCase() === leaf);
        return c ? { category_id: c.id } : {};
      }
      default:
        if (field.startsWith('specs.')) return { specs: { ...stringMap(p.specs), [field.slice(6)]: proposed } as never };
        return {}; // images, video, variants: recorded and reviewed; the owner changes the files
    }
  }

  /* ================================================================ merges */

  private async mergePlan(req: MergeRequest) {
    if (!req.reason?.trim()) throw invalid('reason', 'A reason is required (shown to the affected sellers)');
    if (!req.merges?.length) throw invalid('merges', 'Choose at least one record to merge');
    const keep = await this.repo.getProduct(req.keepProductId);
    if (!keep) throw invalid('keepProductId', 'The product to keep was not found');
    if (keep.merged_into_id) throw invalid('keepProductId', `${keep.ref} was itself merged into another product`);
    if (keep.review_state !== 'approved') throw invalid('keepProductId', 'Keep an approved product');
    const ids = req.merges.map((m) => m.productId);
    if (new Set(ids).size !== ids.length) throw invalid('merges', 'A record is listed twice');
    if (ids.includes(keep.id)) throw invalid('merges', 'The kept product cannot be merged into itself');
    const rows = new Map((await this.repo.getProducts(ids)).map((r) => [r.id, r]));
    const keptVariants = await this.repo.variantsOf([keep.id]);
    const variants = await this.repo.variantsOf(ids);
    const plan = req.merges.map((m, i) => {
      const row = rows.get(m.productId);
      if (!row) throw invalid(`merges[${i}].productId`, 'Product not found');
      if (row.merged_into_id) throw new AppError('CONFLICT', `${row.ref} was already merged`, { productId: row.id });
      if (m.intoVariantId && !keptVariants.some((v) => v.id === m.intoVariantId)) throw invalid(`merges[${i}].intoVariantId`, `That variation is not one of ${keep.ref}'s`);
      if (m.asNewVariant && m.intoVariantId) throw invalid(`merges[${i}]`, 'Choose a new variation or an existing one, not both');
      if (m.asNewVariant) {
        if (!Object.keys(m.asNewVariant).length) throw invalid(`merges[${i}].asNewVariant`, 'Give the new variation its options');
        if (keptVariants.some((v) => sameOptions(stringMap(v.options), m.asNewVariant!))) throw invalid(`merges[${i}].asNewVariant`, 'The kept product already has a variation with these options');
      }
      const action: MergePreviewRecord['action'] = m.asNewVariant ? 'new_variant' : m.intoVariantId ? 'into_variant' : 'by_options';
      const label = m.asNewVariant ? variantLabel(m.asNewVariant) : m.intoVariantId ? variantLabel(stringMap(keptVariants.find((v) => v.id === m.intoVariantId)!.options)) : null;
      return { item: m, row, action, label, variants: variants.filter((v) => v.product_id === row.id) };
    });
    return { keep, keptVariants, plan };
  }

  private async reviewCounts(ids: string[]) {
    const reviews = this.ctx.tryUse('reviews');
    if (!reviews) return null;
    return new Map((await reviews.getRatingSummaries(ids)).map((r) => [r.productId, r]));
  }

  async previewMerge(req: MergeRequest): Promise<MergePreview> {
    const { keep, plan } = await this.mergePlan(req);
    const ids = [keep.id, ...plan.map((p) => p.row.id)];
    const offers = await this.repo.offersOf(ids);
    const ratings = await this.reviewCounts(ids);
    const count = (id: string) => offers.filter((o) => o.product_id === id && o.status !== 'removed');
    const records: MergePreviewRecord[] = plan.map((p) => ({
      productId: p.row.id,
      ref: p.row.ref,
      title: p.row.title,
      kind: p.row.review_state === 'approved' ? 'product' : 'submission',
      action: p.action,
      variantLabel: p.label,
      offers: count(p.row.id).length,
      reviews: ratings?.get(p.row.id)?.ratingCount ?? 0,
    }));
    const moved = plan.flatMap((p) => count(p.row.id));
    const allAfter = [...count(keep.id), ...moved];
    const reviewsMoved = records.reduce((a, r) => a + r.reviews, 0);
    const keptReviews = ratings?.get(keep.id)?.ratingCount ?? 0;
    let ratingAfter: number | null = null;
    if (ratings) {
      const all = ids.map((id) => ratings.get(id)).filter((r) => r && r.average != null && r.ratingCount > 0);
      const n = all.reduce((a, r) => a + r!.ratingCount, 0);
      ratingAfter = n ? Math.round((all.reduce((a, r) => a + r!.average! * r!.ratingCount, 0) / n) * 10) / 10 : null;
    }
    const reviews = this.ctx.tryUse('reviews');
    let questionsMoved: number | null = null;
    let questionsAfter: number | null = null;
    if (reviews) {
      const totals = await Promise.all(ids.map(async (id) => (await reviews.listProductQuestions(id, null, { page: 1, limit: 1 })).total ?? 0));
      questionsAfter = totals.reduce((a, b) => a + b, 0);
      questionsMoved = questionsAfter - totals[0]!;
    }
    const orders = this.ctx.tryUse('orders');
    let pastOrders: number | null = null;
    if (orders) {
      const c = await orders.countOrderItemsForProducts(plan.map((p) => p.row.id));
      pastOrders = Object.values(c).reduce((a, x) => a + x.open + x.past, 0);
    }
    const sellers = new Map<string, AffectedSeller>();
    for (const o of moved) {
      const key = o.seller_id ?? 'official';
      const s = sellers.get(key) ?? { sellerId: o.seller_id, name: o.seller_id ? (o.seller_name ?? 'Seller') : OFFICIAL_STORE_NAME, offers: 0 };
      s.offers++;
      sellers.set(key, s);
    }
    const notes = [
      ...moved.filter((o) => !o.eligible).map((o) => `${o.seller_id ? (o.seller_name ?? 'A seller') : OFFICIAL_STORE_NAME} offer moves to ${keep.ref} and stays ${NOT_LIVE[o.status] ?? o.status}`),
      'Old URLs, ads and coupons now point to the kept product',
      'Past orders keep their purchase snapshots',
    ];
    return {
      keepProductId: keep.id,
      records,
      offersMoved: moved.length,
      offersAfter: allAfter.length,
      offersOnSaleAfter: allAfter.filter((o) => o.eligible).length,
      reviewsMoved,
      reviewsAfter: keptReviews + reviewsMoved,
      ratingAfter,
      questionsMoved,
      questionsAfter,
      pastOrders,
      redirects: plan.length,
      sellersNotified: [...sellers.values()],
      notes,
    };
  }

  async mergeDuplicate(req: MergeRequest, by: By): Promise<MergeResult> {
    const { keep, plan } = await this.mergePlan(req);
    const reason = req.reason.trim();
    const ratings = await this.reviewCounts(plan.map((p) => p.row.id));
    const now = this.now();
    const merged: MergedRecord[] = await this.repo.transaction(async (tx) => {
      const out: MergedRecord[] = [];
      const kept = (await tx.getProduct(keep.id, { forUpdate: true }))!;
      let keptVariants = await tx.variantsOf([kept.id]);
      let position = keptVariants.length;
      for (const p of plan) {
        const locked = (await tx.getProduct(p.row.id, { forUpdate: true }))!;
        if (locked.merged_into_id) throw new AppError('CONFLICT', `${locked.ref} was already merged`, { productId: locked.id });
        const map = new Map<string, string>();
        let newVariantId: string | null = null;
        const addVariant = async (options: Record<string, string>, from: VariantRow[]) => {
          const single = from.length === 1 ? from[0]! : null;
          const gtin = single?.gtin ?? null;
          if (gtin) await tx.updateVariant(single!.id, { gtin: null }); // the GTIN moves with the variation
          const v = await tx.insertVariant({
            id: newId(),
            product_id: kept.id,
            options: options as never,
            gtin,
            media_ids: (single ? strings(single.media_ids) : []) as never,
            position: position++,
            // parcel data and list price describe the same unit, so they move with it
            weight_grams: single?.weight_grams ?? null,
            length_cm: single?.length_cm ?? null,
            width_cm: single?.width_cm ?? null,
            height_cm: single?.height_cm ?? null,
            list_price_amount: single?.list_price_amount ?? null,
            list_price_currency: single?.list_price_currency ?? null,
          });
          keptVariants = [...keptVariants, v];
          return v.id;
        };
        if (p.item.asNewVariant) {
          newVariantId = await addVariant(p.item.asNewVariant, p.variants);
          for (const v of p.variants) map.set(v.id, newVariantId);
        } else if (p.item.intoVariantId) {
          for (const v of p.variants) map.set(v.id, p.item.intoVariantId);
        } else {
          for (const v of p.variants) {
            const same = keptVariants.find((k) => sameOptions(stringMap(k.options), stringMap(v.options)));
            map.set(v.id, same?.id ?? (newVariantId = await addVariant(stringMap(v.options), [v])));
          }
        }
        const movedOffers = await tx.moveOffers(locked.id, kept.id, map);
        const open = await tx.openSubmission(locked.id, { forUpdate: true });
        if (open) {
          await tx.updateSubmission(open.id, { state: 'decided', decided_at: now });
          await tx.deleteDrafts(open.id);
        }
        await tx.updateProduct(locked.id, { merged_into_id: kept.id, updated_at: now });
        const fields = { keptProductId: kept.id, keptRef: kept.ref, duplicateProductId: locked.id, duplicateRef: locked.ref };
        for (const productId of [locked.id, kept.id]) {
          await tx.insertLog({ id: newId(), product_id: productId, action: 'merged', reason, fields: fields as never, actor_kind: by.actor.kind, actor_id: by.actor.id ?? null, at: now });
        }
        out.push({
          productId: locked.id,
          ref: locked.ref,
          newVariantId: p.item.asNewVariant ? newVariantId : null,
          intoVariantId: p.item.intoVariantId ?? null,
          movedOffers,
          movedReviews: ratings?.get(locked.id)?.ratingCount ?? 0,
          redirectFrom: locked.slug,
        });
      }
      await tx.updateProduct(kept.id, { version: kept.version + 1, updated_at: now });
      return out;
    });
    for (const id of [keep.id, ...plan.map((p) => p.row.id)]) await this.refreshListing(id);
    const meta = { actor: by.actor, requestId: by.requestId };
    for (const m of merged) {
      this.ctx.events.publish('catalog.product.merged', { keptProductId: keep.id, duplicateProductId: m.productId, newVariantId: m.newVariantId ?? null, intoVariantId: m.intoVariantId ?? null, reason }, meta);
    }
    await this.audit(
      {
        action: 'catalog.product.merge',
        actionLabel: 'Merged duplicate products',
        category: 'catalog',
        target: this.productTarget(keep),
        relatedTargets: plan.map((p) => ({ type: 'product', id: p.row.id, ref: p.row.ref, label: p.row.title, sellerId: p.row.owner_seller_id })),
        reason,
        after: { merged },
      },
      by,
    );
    return { keptProductId: keep.id, movedOffers: merged.reduce((a, m) => a + m.movedOffers, 0), movedReviews: merged.reduce((a, m) => a + m.movedReviews, 0), merged };
  }

  /* ================================================================ variant parcel data and list price (staff) */

  /**
   * PATCH /products/{id}/variants/{variantId}: weight, packaged dimensions and list price on any product, approved
   * ones included (they do not change what the product is: no correction or re-review). Omitted fields stay; null
   * clears. Logged (variant_details_changed), versioned, audited and published as catalog.product.updated.
   */
  async updateVariantDetails(
    id: string,
    variantId: string,
    body: { weightGrams?: number | null; lengthCm?: number | null; widthCm?: number | null; heightCm?: number | null; listPrice?: common.Money | null; reason: string },
    by: By,
  ): Promise<ProductAdmin> {
    const reason = requireReason(body.reason);
    const product = await this.repo.getProduct(id);
    const variant = product ? await this.repo.getVariant(variantId) : undefined;
    if (!product || !variant || variant.product_id !== product.id) throw notFound('Variant');
    const patch: Partial<VariantRow> = {};
    for (const field of PARCEL_FIELDS) {
      if (body[field] !== undefined) patch[PARCEL_COLUMNS[field]] = checkParcelValue(body[field], field, field);
    }
    if (body.listPrice !== undefined) {
      const price = checkListPrice(body.listPrice, 'listPrice', this.ctx.config.market.currency);
      patch.list_price_amount = price?.amount ?? null;
      patch.list_price_currency = price?.currency ?? null;
    }
    const changed = Object.entries(patch).filter(([k, v]) => {
      const cur = variant[k as keyof VariantRow];
      return (typeof cur === 'string' ? cur.trim() : cur === null ? null : Number(cur)) !== v;
    });
    if (!changed.length) return this.adminView(product, this.staffViewer(by));

    const describe = (v: Pick<VariantRow, 'weight_grams' | 'length_cm' | 'width_cm' | 'height_cm' | 'list_price_amount' | 'list_price_currency'>) => ({
      weightGrams: v.weight_grams ?? null,
      lengthCm: v.length_cm ?? null,
      widthCm: v.width_cm ?? null,
      heightCm: v.height_cm ?? null,
      listPrice: currentListPrice(v as VariantRow),
    });
    const now = this.now();
    const { after, saved } = await this.repo.transaction(async (tx) => {
      const locked = await tx.getProduct(id, { forUpdate: true });
      if (!locked) throw notFound();
      await tx.updateVariant(variantId, patch);
      const after = await tx.updateProduct(id, { version: locked.version + 1, updated_at: now });
      const saved = (await tx.getVariant(variantId))!;
      const d = describe(saved);
      const fields: Record<string, string> = { variantId, variant: variantLabel(stringMap(saved.options)) };
      for (const field of PARCEL_FIELDS) if (patch[PARCEL_COLUMNS[field]] !== undefined) fields[field] = d[field] === null ? 'cleared' : String(d[field]);
      if (patch.list_price_amount !== undefined) fields.listPrice = d.listPrice ? `${d.listPrice.amount} ${d.listPrice.currency}` : 'cleared';
      await tx.insertLog({ id: newId(), product_id: id, action: 'variant_details_changed', reason, fields: fields as never, actor_kind: by.actor.kind, actor_id: by.actor.id ?? null, at: now });
      return { after, saved };
    });
    this.ctx.events.publish('catalog.product.updated', { productId: id, version: after.version, title: after.title }, { actor: by.actor, requestId: by.requestId });
    await this.audit(
      {
        action: 'catalog.variant.details_update',
        actionLabel: 'Changed variant weight, size or list price',
        category: 'catalog',
        target: this.productTarget(after),
        relatedTargets: [{ type: 'variant', id: variantId, label: variantLabel(stringMap(saved.options)) }],
        reason,
        before: describe(variant),
        after: describe(saved),
        visibleToSeller: Boolean(after.owner_seller_id),
      },
      by,
    );
    return this.adminView(after, this.staffViewer(by));
  }

  /* ================================================================ bulk edits (phase 2) */

  async bulkUpdate(body: { productIds: string[]; change: unknown; reason: string; dryRun: boolean }, by: By): Promise<{ affected: number; preview: ProductSummary[]; errors: unknown[] }> {
    const reason = requireReason(body.reason);
    const change = (body.change && typeof body.change === 'object' ? body.change : {}) as Record<string, unknown>;
    const categoryId = str(change.categoryId);
    const brandId = str(change.brandId);
    const publication = str(change.publication) as 'active' | 'hidden' | 'suspended' | undefined;
    if (!categoryId && !brandId && !publication) throw invalid('change', 'Change the category, the brand or the publication');
    if (publication && !['active', 'hidden', 'suspended'].includes(publication)) throw invalid('change.publication', 'Publication is active, hidden or suspended');
    const ids = [...new Set(body.productIds)];
    if (!ids.length) throw invalid('productIds', 'Choose at least one product');
    if (ids.length > 500) throw invalid('productIds', 'Up to 500 products at a time');
    if (categoryId && !(await this.repo.getCategory(categoryId))) throw invalid('change.categoryId', 'Category not found');
    if (brandId) {
      const b = await this.repo.getBrand(brandId);
      if (!b) throw invalid('change.brandId', 'Brand not found');
      if (b.status !== 'active') throw new AppError('BRAND_NOT_ACTIVE', `${b.name} is not active`, { brandId: b.id, status: b.status });
    }
    const rows = new Map((await this.repo.getProducts(ids)).map((r) => [r.id, r]));
    const errors: { productId: string; code: string; message: string }[] = [];
    const ok: ProductRow[] = [];
    for (const id of ids) {
      const r = rows.get(id);
      if (!r || r.merged_into_id) {
        errors.push({ productId: id, code: 'NOT_FOUND', message: 'Product not found' });
        continue;
      }
      if (publication && publication !== r.publication) {
        const allowed = { active: ['hidden', 'suspended'], hidden: ['active'], suspended: ['active', 'hidden'] }[publication] ?? [];
        if (!allowed.includes(r.publication)) {
          errors.push({ productId: id, code: 'ILLEGAL_TRANSITION', message: `${r.ref} is ${r.publication}; it can't become ${publication}` });
          continue;
        }
        if (publication === 'active' && (await this.suspensionReport(r))) {
          errors.push({ productId: id, code: 'APPROVAL_REQUIRED', message: `${r.ref} was suspended after a trust report; reactivate it on its own page` });
          continue;
        }
      }
      ok.push(r);
    }
    const summaries = await this.summaries(ok);
    const preview = ok.map((r) => summaries.get(r.id)!);
    if (body.dryRun) return { affected: ok.length, preview, errors };
    const now = this.now();
    for (const r of ok) {
      if (categoryId || brandId) {
        const after = await this.repo.updateProduct(r.id, { ...(categoryId ? { category_id: categoryId } : {}), ...(brandId ? { brand_id: brandId } : {}), version: r.version + 1, updated_at: now });
        if (after.listed_at) this.ctx.events.publish('catalog.product.updated', { productId: r.id, version: after.version, title: after.title }, { actor: by.actor, requestId: by.requestId });
      }
      if (publication && publication !== r.publication) await this.changePublication(r.id, { to: publication, reason, trustReportId: null }, by, { system: false });
    }
    if (categoryId) await this.recomputeScores(await this.repo.getProducts(ok.map((r) => r.id)));
    await this.audit(
      { action: 'catalog.products.bulk_edit', actionLabel: `Bulk edited ${ok.length} products`, category: 'catalog', target: { type: 'product_bulk', id: newId(), label: `${ok.length} products`, screen: 'admin/catalog' }, reason, after: { change, productIds: ok.map((r) => r.id) } },
      by,
    );
    return { affected: ok.length, preview: [...(await this.summaries(await this.repo.getProducts(ok.map((r) => r.id)))).values()], errors };
  }

  /* ================================================================ catalog matching (sellers) */

  async matchCatalog(sellerId: string, query: { q: string; gtin?: string; sort?: 'best_match' | 'most_offers' | 'newest' }, page: PageRequest): Promise<common.Page<CatalogMatch>> {
    const hits = await this.repo.matchProducts({ q: query.q ?? '', gtin: query.gtin, limit: 100 });
    const rows = hits.map((h) => h.product);
    const [views, listing] = await Promise.all([this.productViews(rows), this.repo.listingStats(rows.map((r) => r.id))]);
    const listingBy = new Map(listing.map((l) => [l.product_id, l]));
    const RANK = { exact: 0, same_model_different_bundle: 1, different_model: 2, title_only: 3 } as const;
    const matches: (CatalogMatch & { rank: number })[] = hits.map((h) => {
      const p = views.get(h.product.id)!;
      const q = h.matchedOn === 'gtin' ? { quality: 'exact' as const, matchedOn: 'gtin' as const } : matchQuality(query.q ?? '', { modelNumber: h.product.model_number });
      const l = listingBy.get(h.product.id);
      return {
        product: { id: p.id, ref: p.ref, title: p.title, slug: p.slug, brand: p.brand ?? null, categoryId: p.categoryId ?? null, image: p.images[0] ?? null, variantCount: p.variants.length },
        matchedOn: h.matchedOn === 'gtin' ? 'gtin' : q.matchedOn,
        variants: p.variants,
        offerCount: l?.offer_count ?? 0,
        matchQuality: q.quality,
        modelNumber: p.modelNumber ?? null,
        categoryPath: p.categoryPath,
        includedItems: p.includedItems,
        lowestPrice: (l?.best_price as common.Money | null) ?? null,
        myOffers: [],
        listedAt: p.listedAt ?? null,
        rank: RANK[q.quality],
      };
    });
    if (query.sort === 'most_offers') matches.sort((a, b) => b.offerCount - a.offerCount || a.rank - b.rank);
    else if (query.sort === 'newest') matches.sort((a, b) => (b.listedAt ?? '').localeCompare(a.listedAt ?? ''));
    else matches.sort((a, b) => a.rank - b.rank || b.offerCount - a.offerCount);
    const p = pageOf(matches, page);
    // the caller's own offers on the page's products
    const ids = p.items.map((m) => m.product.id);
    const own = await this.myOffers(sellerId, ids, p.items);
    return { ...p, items: p.items.map(({ rank: _r, ...m }) => ({ ...m, myOffers: own.get(m.product.id) ?? [] })) };
  }

  private async myOffers(sellerId: string, productIds: string[], matches: CatalogMatch[]) {
    const out = new Map<string, CatalogMatch['myOffers']>();
    if (!productIds.length) return out;
    const label = (productId: string, variantId: string) => {
      const v = matches.find((m) => m.product.id === productId)?.variants.find((x) => x.id === variantId);
      return v ? variantLabel(v.options) : 'Variant';
    };
    const offers = this.ctx.tryUse('offers');
    if (offers) {
      const own = await offers.listOwnOffersForProduct(sellerId, productIds);
      for (const [pid, list] of Object.entries(own)) out.set(pid, list.map((o) => ({ offerId: o.id, variantId: o.variantId, variantLabel: label(pid, o.variantId), condition: o.condition })));
      return out;
    }
    for (const o of await this.repo.offersOfSeller(sellerId, productIds)) {
      if (o.status === 'removed') continue;
      out.set(o.product_id, [...(out.get(o.product_id) ?? []), { offerId: o.offer_id, variantId: o.variant_id, variantLabel: label(o.product_id, o.variant_id), condition: o.condition }]);
    }
    return out;
  }

  /* ================================================================ listing read model */

  /** listing_stats of one product from offer_index */
  protected async refreshListing(productId: string) {
    const offers = (await this.repo.offersOf([productId])).filter((o) => o.status !== 'removed');
    const live = offers.filter((o) => o.eligible && o.in_stock);
    const prices = live.map((o) => o.price as common.Money | null).filter((m): m is common.Money => Boolean(m));
    const best = prices.length ? prices.reduce((a, b) => (b.currency === a.currency && b.amount < a.amount ? b : a)) : null;
    const notLive = offers.filter((o) => !(o.eligible && o.in_stock));
    let note: string | null = null;
    if (notLive.length) {
      const first = notLive[0]!;
      const who = first.seller_id ? (first.seller_name ?? 'A seller') : OFFICIAL_STORE_NAME;
      const state = first.eligible && !first.in_stock ? 'out of stock' : (NOT_LIVE[first.status] ?? first.status.replace(/_/g, ' '));
      const more = notLive.length > 1 ? ` (+${notLive.length - 1} more not live)` : '';
      note = `${who} offer ${state}${more} · ${live.length} other offer${live.length === 1 ? '' : 's'} live`;
    }
    if (!(await this.repo.getProduct(productId))) return;
    await this.repo.saveListingStats({ product_id: productId, offer_count: offers.length, live_offer_count: live.length, in_stock: live.length > 0, best_price: best as never, offer_note: note, refreshed_at: this.now() });
  }

  /** Job catalog.refresh-counts: listing_stats → category_stats (with subcategories) and brand_stats (overall and per top-level category) */
  async refreshCounts(): Promise<{ products: number; categories: number; brands: number }> {
    const withOffers = await this.repo.productIdsWithOffers();
    for (const id of withOffers) await this.refreshListing(id);
    const tax = await this.taxonomy();
    const source = await this.repo.liveCountsSource();
    const liveIds = source.filter((s) => s.live).map((s) => s.id);
    const eligible: OfferIndexRow[] = [];
    for (let i = 0; i < liveIds.length; i += 500) eligible.push(...(await this.repo.offersOf(liveIds.slice(i, i + 500))).filter((o) => o.eligible));
    const eligibleBy = new Map<string, OfferIndexRow[]>();
    for (const o of eligible) eligibleBy.set(o.product_id, [...(eligibleBy.get(o.product_id) ?? []), o]);
    const now = this.now();

    const perCategory = new Map<string, { products: number; offers: number }>();
    for (const s of source) {
      if (!s.live || !s.category_id) continue;
      for (const c of tax.path(s.category_id)) {
        const cur = perCategory.get(c.id) ?? { products: 0, offers: 0 };
        if (s.live_offers > 0) cur.products++;
        cur.offers += eligibleBy.get(s.id)?.length ?? 0;
        perCategory.set(c.id, cur);
      }
    }
    await this.repo.replaceCategoryStats(tax.rows.map((c) => ({ category_id: c.id, product_count: perCategory.get(c.id)?.products ?? 0, offer_count: perCategory.get(c.id)?.offers ?? 0, refreshed_at: now })));

    const perBrand = new Map<string, { products: number; offers: number; sellers: Set<string> }>();
    const bump = (key: string, s: (typeof source)[number]) => {
      const cur = perBrand.get(key) ?? { products: 0, offers: 0, sellers: new Set<string>() };
      if (s.live && s.live_offers > 0) cur.products++;
      for (const o of s.live ? (eligibleBy.get(s.id) ?? []) : []) {
        cur.offers++;
        cur.sellers.add(o.seller_id ?? 'official');
      }
      perBrand.set(key, cur);
    };
    for (const s of source) {
      if (!s.brand_id) continue;
      bump(`${s.brand_id}|`, s);
      const top = s.category_id ? tax.top(s.category_id) : null;
      if (top) bump(`${s.brand_id}|${top}`, s);
    }
    const rows = [...perBrand.entries()]
      .filter(([key, v]) => key.endsWith('|') || v.products > 0 || v.offers > 0)
      .map(([key, v]) => {
        const [brandId, categoryId] = key.split('|') as [string, string];
        return { brand_id: brandId, category_id: categoryId || null, product_count: v.products, offer_count: v.offers, seller_count: v.sellers.size, refreshed_at: now };
      });
    await this.repo.replaceBrandStats(rows);
    return { products: withOffers.length, categories: tax.rows.length, brands: rows.length };
  }

  protected pageRequest = toPageRequest;
}
