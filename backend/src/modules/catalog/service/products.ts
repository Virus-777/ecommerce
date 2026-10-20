/** Product drafts (sellers and the Official Store), submission for review and the automated submission checks. */
import { stringList } from '../../../kernel/lib/text.js';
import { slugify } from '../../../kernel/lib/text.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { MediaOwner } from '../../../spec/media.js';
import type { ProductCheck, ProductCheckEvidence, ProductInput, RequestedBrand, VariantInput } from '../../../spec/catalog.js';
import {
  attributeFilled,
  EXPECTED_REVIEW_MARGIN_BUSINESS_DAYS,
  findClaims,
  findRestricted,
  gtinValid,
  imageRulesOf,
  MAX_PARCEL_VALUE,
  normalize,
  normalizeModel,
  PARCEL_COLUMNS,
  PARCEL_FIELDS,
  sameOptions,
  titleSimilarity,
  words,
} from '../domain/rules.js';
import { productReviewMachine, publicationMachine } from '../domain/state-machines.js';
import { imageRulesOfRow, stringMap } from '../mappers.js';
import type { BrandRow, CheckRow, ProductRow, SubmissionRow, VariantRow } from '../ports.js';
import { GtinTakenError, type CatalogRepository } from '../repository.js';
import { invalid, notFound, type By, type ReviewClock, type Taxonomy } from './base.js';
import { CatalogTaxonomy } from './taxonomy.js';

export type Owner = { type: 'official'; sellerId: null } | { type: 'seller'; sellerId: string };

type CheckResult = Omit<ProductCheck, 'ranAt' | 'dismissal'>;

const brandNotActive = (b: BrandRow) =>
  new AppError('BRAND_NOT_ACTIVE', b.status === 'blocked' ? `${b.name} is blocked; choose another brand.` : `${b.name} is under review; it can be used once it is activated.`, { brandId: b.id, status: b.status });

export class CatalogProducts extends CatalogTaxonomy {
  protected mediaOwner(owner: { owner_type: string; owner_seller_id: string | null } | Owner): MediaOwner {
    const sellerId = 'type' in owner ? owner.sellerId : owner.owner_seller_id;
    const type = 'type' in owner ? owner.type : owner.owner_type;
    return type === 'seller' && sellerId ? { kind: 'seller', id: sellerId } : { kind: 'platform' };
  }

  /** A seller reaches only the products it submitted; anything else is not found */
  protected async ownProduct(sellerId: string, id: string): Promise<ProductRow> {
    const row = await this.repo.getProduct(id);
    if (!row || row.owner_seller_id !== sellerId || row.merged_into_id) throw notFound();
    return row;
  }

  protected async officialProduct(id: string): Promise<ProductRow> {
    const row = await this.repo.getProduct(id);
    if (!row || row.owner_type !== 'official' || row.merged_into_id) throw notFound();
    return row;
  }

  /** Restrictions covering product submissions (sellers.canSell) block new drafts and submissions */
  protected async assertMaySubmit(sellerId: string, categoryId: string | null) {
    const sellers = this.ctx.tryUse('sellers');
    if (!sellers) return;
    const r = await sellers.canSell(sellerId, { activity: 'product_submissions', ...(categoryId ? { categoryId } : {}) });
    if (!r.allowed) throw new AppError('FORBIDDEN', r.reason ?? 'A restriction on your account blocks product submissions', { restrictionId: r.restrictionId ?? null, appealRoute: r.appealRoute ?? null });
  }

  /* ================================================================ drafts */

  async createDraft(sellerId: string, body: ProductInput, by: By) {
    await this.assertMaySubmit(sellerId, body.categoryId ?? null);
    const row = await this.saveProduct({ existing: null, owner: { type: 'seller', sellerId }, body, by });
    return this.adminView(row, { kind: 'seller', sellerId });
  }

  async updateDraft(sellerId: string, id: string, body: ProductInput, by: By) {
    const existing = await this.ownProduct(sellerId, id);
    if (!['draft', 'changes_requested'].includes(existing.review_state)) {
      throw new AppError('ILLEGAL_TRANSITION', existing.review_state === 'approved' ? 'Approved products are changed through correction suggestions.' : `A ${existing.review_state.replace('_', ' ')} product can't be edited.`, {
        from: existing.review_state,
        event: 'edit',
      });
    }
    await this.assertMaySubmit(sellerId, body.categoryId ?? existing.category_id);
    const row = await this.saveProduct({ existing, owner: { type: 'seller', sellerId }, body, by });
    return this.adminView(row, { kind: 'seller', sellerId });
  }

  async createOfficialDraft(body: ProductInput, by: By) {
    const row = await this.saveProduct({ existing: null, owner: { type: 'official', sellerId: null }, body, by });
    await this.logWriter(row.id, 'created', by);
    return this.adminView(row, this.staffViewer(by));
  }

  /** Who wrote an Official Store product, for its two-person approval (CatalogReview.approve) */
  protected async logWriter(productId: string, action: 'created' | 'edited', by: By) {
    await this.repo.insertLog({ id: newId(), product_id: productId, action, reason: null, fields: {} as never, actor_kind: by.actor.kind, actor_id: by.actor.id ?? null, at: this.now() });
  }

  /** Drafts and products with changes requested are edited in place; an approved product's edit goes back to review (content_change) */
  async updateOfficialDraft(id: string, body: ProductInput, by: By) {
    const existing = await this.officialProduct(id);
    if (!['draft', 'changes_requested', 'approved'].includes(existing.review_state)) {
      throw new AppError('ILLEGAL_TRANSITION', `A ${existing.review_state.replace('_', ' ')} product can't be edited.`, { from: existing.review_state, event: 'edit' });
    }
    const row = await this.saveProduct({ existing, owner: { type: 'official', sellerId: null }, body, by });
    await this.logWriter(row.id, 'edited', by);
    if (existing.review_state !== 'approved') return this.adminView(row, this.staffViewer(by));
    const ref = await this.submissionRef();
    const clock = await this.reviewClock();
    const { product, submission } = await this.repo.transaction(async (tx) => {
      const locked = (await tx.getProduct(id, { forUpdate: true }))!;
      return this.reopenTx(tx, locked, by, 'Official Store edit', ref, clock);
    });
    await this.afterSubmit(product, submission, by, null);
    return this.adminView(product, this.staffViewer(by));
  }

  protected staffViewer(by: By) {
    return { kind: 'staff' as const, staffId: by.principal?.accountId ?? (by.actor.kind === 'staff' ? (by.actor.id ?? null) : null) };
  }

  /** Validates and stores a product draft: shared content, variants and the files it uses */
  protected async saveProduct(input: { existing: ProductRow | null; owner: Owner; body: ProductInput; by: By }): Promise<ProductRow> {
    const { existing, owner, body, by } = input;
    const keep = <T>(v: T | undefined, current: T) => (v === undefined ? current : v);
    const title = body.title?.trim() ?? '';
    if (!title) throw invalid('title', 'A title is required');
    if (title.length > 200) throw invalid('title', 'The title is too long (200 characters at most)');
    const description = (keep(body.description, existing?.description) ?? '').trim();
    if (description.length > 10_000) throw invalid('description', 'The description is too long (10,000 characters at most)');
    const keyFeatures = (keep(body.keyFeatures, existing ? stringList(existing.key_features) : []) ?? []).map((f) => f.trim()).filter(Boolean);
    if (keyFeatures.length > 20) throw invalid('keyFeatures', 'Up to 20 key features');
    const includedItems = (keep(body.includedItems, existing ? stringList(existing.included_items) : []) ?? []).map((f) => f.trim()).filter(Boolean);
    if (includedItems.length > 50) throw invalid('includedItems', 'Up to 50 items in the box');
    const specs = Object.fromEntries(
      Object.entries(keep(body.specs, existing ? stringMap(existing.specs) : {}) ?? {})
        .map(([k, v]) => [k.trim(), String(v ?? '').trim()])
        .filter(([k, v]) => k && v),
    );
    const imageIds = keep(body.imageIds, existing ? stringList(existing.media_ids) : []) ?? [];
    if (new Set(imageIds).size !== imageIds.length) throw invalid('imageIds', 'An image is listed twice');
    const maxImages = await this.ctx.settings.get('maxImagesPerProduct');
    if (imageIds.length > maxImages) throw invalid('imageIds', `Up to ${maxImages} images per product`);
    const videoId = keep(body.videoId, existing?.video_media_id ?? null) ?? null;

    // brand: an active one, the seller's own request still under review, or a requested brand
    let brandId = keep(body.brandId, existing?.brand_id ?? null) ?? null;
    let requestedBrand = (keep(body.requestedBrand, (existing?.requested_brand as RequestedBrand | null) ?? null) ?? null) as RequestedBrand | null;
    if (body.brandId && body.requestedBrand) throw invalid('requestedBrand', 'Choose a listed brand or request a new one, not both');
    if (body.brandId) requestedBrand = null;
    if (body.requestedBrand) brandId = null;
    if (requestedBrand) {
      if (owner.type === 'official') throw invalid('requestedBrand', 'Create the brand in the brand list first');
      const name = requestedBrand.name?.trim();
      if (!name) throw invalid('requestedBrand.name', 'Name the brand you are requesting');
      requestedBrand = { name, website: requestedBrand.website ?? null, note: requestedBrand.note?.trim() || null };
    }
    if (brandId && brandId !== existing?.brand_id) {
      const brand = await this.repo.getBrand(brandId);
      if (!brand) throw invalid('brandId', 'Brand not found');
      const ownRequest = brand.status === 'under_review' && owner.type === 'seller' && brand.requested_by_seller_id === owner.sellerId;
      if (brand.status !== 'active' && !ownRequest) throw brandNotActive(brand);
    }
    const categoryId = keep(body.categoryId, existing?.category_id ?? null) ?? null;
    const tax = await this.taxonomy();
    if (categoryId && !tax.byId.has(categoryId)) throw invalid('categoryId', 'Category not found');

    // variants: replaced as a set; ids are kept for unchanged options
    const productId = existing?.id ?? newId();
    const currentVariants = existing ? await this.repo.variantsOf([existing.id]) : [];
    let variants: VariantRow[] = currentVariants;
    const currency = this.ctx.config.market.currency;
    if (body.variants !== undefined) {
      const list = body.variants ?? [];
      const gtins = new Map<string, number>();
      variants = list.map((v, i) => {
        const options = Object.fromEntries(
          Object.entries(v.options ?? {})
            .map(([k, x]) => [k.trim(), String(x ?? '').trim()])
            .filter(([k, x]) => k && x),
        );
        const gtin = v.gtin?.replace(/\s+/g, '') || null;
        if (gtin) {
          if (gtins.has(gtin)) throw invalid(`variants[${i}].gtin`, 'Two variants have the same GTIN');
          gtins.set(gtin, i);
        }
        const twin = list.findIndex((o, j) => j < i && sameOptions(stringMap(o.options), options));
        if (twin >= 0) throw invalid(`variants[${i}].options`, 'Two variants have the same options');
        const imgs = v.imageIds ?? [];
        const same = currentVariants.find((c) => sameOptions(stringMap(c.options), options));
        // list price (MSRP) is a staff field: sellers can't set it, and saving their draft keeps what staff set
        if (owner.type === 'seller' && v.listPrice != null) throw invalid(`variants[${i}].listPrice`, 'The list price is set by Marketly staff');
        const listPrice = owner.type === 'seller' || v.listPrice === undefined ? currentListPrice(same) : checkListPrice(v.listPrice, `variants[${i}].listPrice`, currency);
        return {
          id: same?.id ?? newId(),
          product_id: productId,
          options: options as never,
          gtin,
          media_ids: imgs as never,
          position: i,
          ...parcelColumns(v, same, `variants[${i}]`),
          list_price_amount: listPrice?.amount ?? null,
          list_price_currency: listPrice?.currency ?? null,
        };
      });
      if (existing?.review_state === 'approved') {
        const dropped = currentVariants.filter((c) => !variants.some((v) => v.id === c.id));
        if (dropped.length) throw invalid('variants', 'Variants of an approved product cannot be removed; existing offers use them');
      }
      const owners = await this.repo.gtinOwners([...gtins.keys()]);
      for (const o of owners) {
        if (o.product_id === productId) continue;
        const other = await this.repo.getProduct(o.product_id);
        throw invalid(`variants[${gtins.get(o.gtin)}].gtin`, `GTIN ${o.gtin} is already used by ${other?.ref ?? 'another product'}; add an offer to that product instead`, { productId: o.product_id });
      }
    }

    const now = this.now();
    const row: ProductRow = {
      id: productId,
      ref: existing?.ref ?? (await this.ctx.refs.next('PRD', { daily: false })),
      title,
      slug: slugify(title, { fallback: 'item' }),
      brand_id: brandId,
      category_id: categoryId,
      description,
      key_features: keyFeatures as never,
      specs: specs as never,
      included_items: includedItems as never,
      media_ids: imageIds as never,
      video_media_id: videoId,
      model_number: (keep(body.modelNumber, existing?.model_number ?? null) ?? '').trim() || null,
      mpn: (keep(body.manufacturerPartNumber, existing?.mpn ?? null) ?? '').trim() || null,
      no_gtin: keep(body.noGtin, existing?.no_gtin ?? false) ?? false,
      requested_brand: requestedBrand as never,
      content_score: 0,
      owner_type: owner.type,
      owner_seller_id: owner.sellerId,
      review_state: existing?.review_state ?? productReviewMachine.initial,
      publication: existing?.publication ?? publicationMachine.initial,
      version: (existing?.version ?? 0) + 1,
      merged_into_id: null,
      search: null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      listed_at: existing?.listed_at ?? null,
      // images still to re-crop: those the product keeps (a replaced image is gone from the list)
      recrop_media_ids: keptRecrops(existing, [...imageIds, ...variants.flatMap((v) => stringList(v.media_ids))]) as never,
    };
    row.content_score = (await this.completenessOf([row], variants, tax)).get(row.id)!.score;

    // files: attach what is new, detach what was dropped once the product is saved
    const mediaOwner = this.mediaOwner(owner);
    const usage = { refId: productId, refLabel: title };
    const swaps = [];
    try {
      swaps.push(await this.swapMedia(existing ? stringList(existing.media_ids) : [], imageIds, 'product_image', 'imageIds', usage, mediaOwner));
      swaps.push(await this.swapMedia([existing?.video_media_id ?? null], [videoId], 'product_video', 'videoId', usage, mediaOwner));
      swaps.push(await this.swapMedia(currentVariants.flatMap((v) => stringList(v.media_ids)), variants.flatMap((v) => stringList(v.media_ids)), 'variant_image', 'variants.imageIds', usage, mediaOwner));
    } catch (err) {
      for (const s of swaps) await s.undo();
      throw err;
    }

    let saved: ProductRow;
    try {
      saved = await this.repo.transaction(async (tx) => {
        let out: ProductRow;
        if (existing) {
          const locked = await tx.getProduct(existing.id, { forUpdate: true });
          if (!locked || locked.version !== existing.version) throw new AppError('CONFLICT', 'The product changed while you were editing; reload and try again');
          const { id: _i, ref: _r, created_at: _c, owner_type: _o, owner_seller_id: _s, ...patch } = row;
          out = await tx.updateProduct(existing.id, patch);
        } else {
          out = await tx.insertProduct(row);
        }
        if (body.variants !== undefined) {
          const keepIds = new Set(variants.map((v) => v.id));
          const removed = currentVariants.filter((c) => !keepIds.has(c.id));
          // a GTIN moving between variants: clear it first (gtin is unique)
          for (const c of currentVariants) if (c.gtin && keepIds.has(c.id)) await tx.updateVariant(c.id, { gtin: null });
          await tx.deleteVariants(removed.map((r) => r.id));
          for (const v of variants) {
            if (currentVariants.some((c) => c.id === v.id)) {
              await tx.updateVariant(v.id, {
                options: v.options,
                gtin: v.gtin,
                media_ids: v.media_ids,
                position: v.position,
                weight_grams: v.weight_grams,
                length_cm: v.length_cm,
                width_cm: v.width_cm,
                height_cm: v.height_cm,
                list_price_amount: v.list_price_amount,
                list_price_currency: v.list_price_currency,
              });
            }
            else await tx.insertVariant(v);
          }
        }
        const latest = (await tx.latestSubmissions([productId]))[0];
        if (latest) await tx.updateSubmission(latest.id, { last_saved_at: now, last_saved_by: by.actor as never });
        return out;
      });
    } catch (err) {
      for (const s of swaps) await s.undo();
      if (isAppError(err)) throw err;
      if (err instanceof GtinTakenError) throw invalid('variants', 'A GTIN is already used by another product');
      throw err;
    }
    for (const s of swaps) await s.commit();
    if (saved.listed_at) this.ctx.events.publish('catalog.product.updated', { productId: saved.id, version: saved.version, title: saved.title }, { actor: by.actor, requestId: by.requestId });
    return saved;
  }

  /* ================================================================ submission */

  async submitOwn(sellerId: string, id: string, note: string | null | undefined, by: By) {
    const row = await this.ownProduct(sellerId, id);
    const after = await this.submit(row, { note: note ?? null, by });
    return this.adminView(after, { kind: 'seller', sellerId });
  }

  /**
   * The seller takes a submission back before review (G52a): only a product never listed. The open submission is
   * marked withdrawn and its review work item closes; the product is a draft again.
   */
  async withdrawOwn(sellerId: string, id: string, reason: string | null | undefined, by: By) {
    const row = await this.ownProduct(sellerId, id);
    if (row.listed_at) throw new AppError('ILLEGAL_TRANSITION', 'A listed product changes through correction suggestions.', { from: row.review_state, event: 'withdraw' });
    productReviewMachine.next(row.review_state as never, 'withdraw');
    const note = reason?.trim() || null;
    const now = this.now();
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.getProduct(id, { forUpdate: true });
      if (!locked) throw notFound();
      const state = productReviewMachine.next(locked.review_state as never, 'withdraw');
      const open = await tx.openSubmission(id, { forUpdate: true });
      if (open) {
        await tx.updateSubmission(open.id, { state: 'withdrawn', decided_at: now });
        await tx.deleteDrafts(open.id);
      }
      await tx.insertLog({ id: newId(), product_id: id, action: 'withdrawn', reason: note, fields: {} as never, actor_kind: by.actor.kind, actor_id: by.actor.id ?? null, at: now });
      return tx.updateProduct(id, { review_state: state, updated_at: now });
    });
    // the product_review work item opened by catalog.product.submitted (workqueues, optional)
    const workqueues = this.ctx.tryUse('workqueues');
    if (workqueues) {
      await workqueues
        .resolveBySource(`product_review:${id}`, { note: 'Submission withdrawn by the seller', by: by.actor })
        .catch((err) => this.ctx.log.warn({ err, productId: id }, 'catalog: review work item not closed'));
    }
    return this.adminView(after, { kind: 'seller', sellerId });
  }

  /**
   * The seller deletes a draft (G52a): a draft or a product with changes requested that was never listed and has
   * no open submission. Its rows go and its files are released.
   */
  async deleteOwnDraft(sellerId: string, id: string, by: By): Promise<void> {
    const row = await this.ownProduct(sellerId, id);
    const refuse = (message: string) => new AppError('ILLEGAL_TRANSITION', message, { from: row.review_state, event: 'delete' });
    if (row.listed_at || !['draft', 'changes_requested'].includes(row.review_state)) throw refuse('Only drafts that were never listed can be deleted.');
    if (await this.repo.openSubmission(id)) throw refuse('Withdraw the submission before deleting the draft.');
    const variants = await this.repo.variantsOf([id]);
    await this.repo.transaction((tx) => tx.deleteDraftProduct(id));
    await this.detachAll(
      [
        ...stringList(row.media_ids).map((assetId) => ({ assetId, kind: 'product_image' })),
        ...(row.video_media_id ? [{ assetId: row.video_media_id, kind: 'product_video' }] : []),
        ...variants.flatMap((v) => stringList(v.media_ids)).map((assetId) => ({ assetId, kind: 'variant_image' })),
      ],
      id,
    );
    this.ctx.log.info({ productId: id, sellerId, by: by.actor.id }, 'catalog: seller deleted a draft product');
  }

  async submitOfficial(id: string, by: By) {
    const row = await this.officialProduct(id);
    const after = await this.submit(row, { note: null, by });
    return this.adminView(after, this.staffViewer(by));
  }

  private async submit(row: ProductRow, opts: { note: string | null; by: By }): Promise<ProductRow> {
    const { by } = opts;
    productReviewMachine.next(row.review_state as never, 'submit');
    if (row.owner_seller_id) await this.assertMaySubmit(row.owner_seller_id, row.category_id);
    const tax = await this.taxonomy();
    const variants = await this.repo.variantsOf([row.id]);
    const c = (await this.completenessOf([row], variants, tax)).get(row.id)!;
    if (c.missing.length) throw new AppError('VALIDATION_FAILED', 'Add the missing information before submitting', { missing: c.missing, issues: c.issues });
    if (row.brand_id) {
      const brand = await this.repo.getBrand(row.brand_id);
      if (brand?.status === 'blocked') throw brandNotActive(brand);
    }
    // a requested brand becomes an under_review brand linked to this submission (or the listed one with that name)
    const requested = !row.brand_id && row.requested_brand ? (row.requested_brand as unknown as RequestedBrand) : null;
    let existingBrand: BrandRow | undefined;
    if (requested) {
      existingBrand = await this.repo.findBrandByName(requested.name);
      if (existingBrand?.status === 'blocked') throw brandNotActive(existingBrand);
    }
    const note = opts.note?.trim() || null;
    const now = this.now();
    const ref = await this.submissionRef();
    const clock = await this.reviewClock();
    const result = await this.repo.transaction(async (tx) => {
      const locked = await tx.getProduct(row.id, { forUpdate: true });
      if (!locked) throw notFound();
      const state = productReviewMachine.next(locked.review_state as never, 'submit');
      let brandId = locked.brand_id;
      let createdBrand: BrandRow | null = null;
      if (requested && !brandId) {
        if (existingBrand) brandId = existingBrand.id;
        else {
          createdBrand = await tx.insertBrand({
            id: newId(),
            name: requested.name,
            slug: await this.freeBrandSlug(tx, requested.name),
            logo_media_id: null,
            description: requested.note ?? null,
            banner_media_id: null,
            status: 'under_review',
            status_reason: requested.website ? `Requested with a product submission · ${requested.website}` : 'Requested with a product submission',
            flag_note: null,
            trust_report_id: null,
            selling_policy: 'open',
            requested_by_seller_id: locked.owner_seller_id,
            requested_for_product_id: locked.id,
            requested_change_request_id: null,
            created_at: now,
            updated_at: now,
          });
          brandId = createdBrand.id;
        }
      }
      const kind: SubmissionRow['kind'] = locked.review_state === 'changes_requested' || (await tx.submissionCount(locked.id)) > 0 ? 'resubmitted' : 'new';
      const submission = await this.insertSubmissionTx(tx, locked, kind, by, note, now, ref, clock);
      const product = await tx.updateProduct(locked.id, { review_state: state, brand_id: brandId, updated_at: now });
      await tx.insertLog({ id: newId(), product_id: locked.id, action: 'submitted', reason: note, fields: {} as never, actor_kind: by.actor.kind, actor_id: by.actor.id ?? null, at: now });
      return { product, submission, createdBrand };
    });
    await this.afterSubmit(result.product, result.submission, by, result.createdBrand);
    return result.product;
  }

  private async freeBrandSlug(tx: CatalogRepository, name: string) {
    const root = slugify(name, { fallback: 'item' });
    for (let i = 1; ; i++) {
      const slug = i === 1 ? root : `${root}-${i}`;
      if (!(await tx.brandSlugTaken(slug))) return slug;
    }
  }

  /** SUB-YYMMDD-NNNN, taken before the transaction (references use their own connection) */
  protected submissionRef() {
    return this.ctx.refs.next('SUB', { digits: 4 });
  }

  /** `clock`: review target and business calendar, read before the transaction (reviewClock) */
  protected async insertSubmissionTx(tx: CatalogRepository, product: ProductRow, kind: SubmissionRow['kind'], by: By, note: string | null, now: Date, ref: string, clock: ReviewClock) {
    return tx.insertSubmission({
      id: newId(),
      ref,
      product_id: product.id,
      kind,
      state: 'open',
      product_version: product.version,
      submitted_at: now,
      submitted_by: by.actor as never,
      last_saved_at: null,
      last_saved_by: null,
      expected_review_by: clock.addBusinessDays(now, clock.targetDays + EXPECTED_REVIEW_MARGIN_BUSINESS_DAYS),
      review_due_at: clock.addBusinessDays(now, clock.targetDays),
      paused_at: null,
      assignee_staff_id: null,
      assignee_name: null,
      decided_at: null,
      note,
    });
  }

  /** approved → submitted (reopen): an accepted correction or an Official Store edit changed what the product is */
  protected async reopenTx(tx: CatalogRepository, locked: ProductRow, by: By, note: string | null, ref: string, clock: ReviewClock) {
    const now = this.now();
    const state = productReviewMachine.next(locked.review_state as never, 'reopen');
    const submission = await this.insertSubmissionTx(tx, locked, 'content_change', by, note, now, ref, clock);
    const product = await tx.updateProduct(locked.id, { review_state: state, updated_at: now });
    await tx.insertLog({ id: newId(), product_id: locked.id, action: 'submitted', reason: note, fields: {} as never, actor_kind: by.actor.kind, actor_id: by.actor.id ?? null, at: now });
    return { product, submission };
  }

  /** After the commit: automated checks, then the events */
  protected async afterSubmit(product: ProductRow, submission: SubmissionRow, by: By, createdBrand: BrandRow | null) {
    await this.runChecks(product, submission);
    const meta = { actor: by.actor, requestId: by.requestId };
    if (createdBrand && product.owner_seller_id) {
      this.ctx.events.publish('catalog.brand.requested', { brandId: createdBrand.id, name: createdBrand.name, sellerId: product.owner_seller_id, productId: product.id }, meta);
    }
    this.ctx.events.publish(
      'catalog.product.submitted',
      {
        productId: product.id,
        ownerSellerId: product.owner_seller_id,
        submissionId: submission.id,
        ref: submission.ref,
        kind: submission.kind,
        title: product.title,
        reviewDueAt: (submission.review_due_at ?? submission.expected_review_by ?? submission.submitted_at).toISOString(),
      },
      meta,
    );
  }

  /* ================================================================ automated checks (advisory) */

  protected async runChecks(product: ProductRow, submission: SubmissionRow) {
    // the category tree is read once for the checks that need it (a failed read fails only those checks)
    const tax = this.taxonomy();
    tax.catch(() => undefined);
    const variants = await this.repo.variantsOf([product.id]);
    const checks: [ProductCheck['kind'], () => Promise<CheckResult>][] = [
      ['duplicate', () => this.duplicateCheck(product, variants)],
      ['image_standard', () => this.imageCheck(product, tax)],
      ['category_fit', () => this.categoryFitCheck(product, variants, tax)],
      ['prohibited_claim', async () => this.claimCheck(product)],
      ['brand_authorization', () => this.brandCheck(product)],
      ['restricted_item', async () => this.restrictedCheck(product)],
      ['identifier', async () => this.identifierCheck(product, variants)],
    ];
    const ranAt = this.now();
    // the checks only read: they run at once, and their rows keep the order above
    const results = await Promise.all(
      checks.map(async ([kind, run]): Promise<CheckResult> => {
        try {
          return await run();
        } catch (err) {
          this.ctx.log.warn({ err, kind, productId: product.id }, 'catalog: submission check could not run');
          return { kind, result: 'warn', message: 'This check could not run; review manually', details: [], evidence: [] };
        }
      }),
    );
    const rows: CheckRow[] = [];
    for (const [i, [kind]] of checks.entries()) {
      const r = results[i]!;
      rows.push({
        id: newId(),
        submission_id: submission.id,
        kind,
        result: r.result,
        message: r.message,
        details: r.details as never,
        evidence: r.evidence as never,
        ran_at: ranAt,
        dismissed_at: null,
        dismissed_by: null,
        dismiss_reason: null,
        dismissed_matched_product_id: null,
      });
    }
    await this.repo.insertChecks(rows);
  }

  private async duplicateCheck(p: ProductRow, variants: VariantRow[]): Promise<CheckResult> {
    const gtins = variants.flatMap((v) => (v.gtin ? [v.gtin] : []));
    const titleWords = [...words(p.title)].sort((a, b) => b.length - a.length).slice(0, 3);
    const candidates = await this.repo.duplicateCandidates({ productId: p.id, modelNumber: p.model_number, gtins, titleWords });
    const otherVariants = await this.repo.variantsOf(candidates.map((c) => c.id));
    const evidence: ProductCheckEvidence[] = [];
    let gtinHit = false;
    for (const c of candidates) {
      const sharedGtin = otherVariants.find((v) => v.product_id === c.id && v.gtin && gtins.includes(v.gtin));
      const sameModel = Boolean(p.model_number && normalizeModel(c.model_number) === normalizeModel(p.model_number));
      const sim = titleSimilarity(p.title, c.title);
      const sameBrand = Boolean(p.brand_id && p.brand_id === c.brand_id);
      if (sharedGtin) {
        gtinHit = true;
        evidence.push({ label: 'Matched product', field: 'gtin', text: sharedGtin.gtin, score: 1, matchedProductId: c.id });
      } else if (sameModel) evidence.push({ label: 'Matched product', field: 'modelNumber', text: c.model_number, score: sameBrand ? 0.95 : 0.8, matchedProductId: c.id });
      else if (sim >= 0.6 && (sameBrand || !p.brand_id)) evidence.push({ label: 'Matched product', field: 'title', text: c.title, score: Math.round(sim * 100) / 100, matchedProductId: c.id });
    }
    if (!evidence.length) return { kind: 'duplicate', result: 'pass', message: 'No likely duplicates found', details: [], evidence: [] };
    const n = evidence.length;
    return {
      kind: 'duplicate',
      result: gtinHit ? 'fail' : 'warn',
      message: `${n} possible duplicate${n === 1 ? '' : 's'}${gtinHit ? ' with the same GTIN' : evidence.some((e) => e.field === 'modelNumber') ? ' with the same model number' : ' with a similar title'}`,
      details: candidates.filter((c) => evidence.some((e) => e.matchedProductId === c.id)).map((c) => `${c.ref} · ${c.title}`),
      evidence,
    };
  }

  private async imageCheck(p: ProductRow, taxonomy: Promise<Taxonomy>): Promise<CheckResult> {
    const tax = await taxonomy;
    const standards = await this.repo.imageStandardsOf(tax.path(p.category_id).map((c) => c.id));
    const standard = this.imageStandardFor(p.category_id, tax, standards);
    const ruleList = standard ? imageRulesOfRow(standard.rules) : [];
    const blocking = imageRulesOf(ruleList, 'blocking');
    const warning = imageRulesOf(ruleList, 'warning');
    const images = stringList(p.media_ids);
    const minCount = Math.max(standard?.min_count ?? 1, blocking?.minCount ?? 1);
    const details: string[] = [];
    const evidence: ProductCheckEvidence[] = [];
    let result: CheckResult['result'] = 'pass';
    if (images.length < minCount) {
      result = 'fail';
      details.push(`${images.length} image${images.length === 1 ? '' : 's'}; this category needs at least ${minCount}`);
    }
    const source = tax.path(p.category_id).map((c) => c.name).join(' › ');
    const passes = [
      [blocking, 'fail'],
      [warning, 'warn'],
    ] as const;
    // every image against both rule sets at once; the findings keep the image and rule order
    // (the product image spec's ratio, media.productImage, applies to every category: category ratios are ignored)
    const checked = await Promise.all(images.map((id) => Promise.all(passes.map(([rules]) => (rules ? this.media.checkImage(id, { ...rules.rules, aspectRatios: [] }) : null)))));
    for (const [i, id] of images.entries()) {
      for (const [j, [rules, severity]] of passes.entries()) {
        if (!rules) continue;
        const r = checked[i]![j]!;
        const issues = r.issues.filter((x) => (severity === 'fail' ? x.severity === 'blocking' : true));
        if (!issues.length) continue;
        if (severity === 'fail' || result === 'pass') result = severity === 'fail' ? 'fail' : result === 'fail' ? 'fail' : 'warn';
        for (const issue of issues) {
          details.push(`Image ${i + 1}: ${issue.message}`);
          evidence.push({ label: `Image ${i + 1}`, field: 'images', text: issue.message, mediaId: id });
        }
      }
    }
    const message =
      result === 'pass' ? (blocking || warning ? `Images meet the ${source || 'category'} standard` : 'No image standard for this category') : result === 'fail' ? 'Images do not meet the category standard' : 'Images have advisory issues';
    return { kind: 'image_standard', result, message, details, evidence };
  }

  private async categoryFitCheck(p: ProductRow, variants: VariantRow[], taxonomy: Promise<Taxonomy>): Promise<CheckResult> {
    if (!p.category_id) return { kind: 'category_fit', result: 'warn', message: 'No category chosen', details: [], evidence: [] };
    const tax = await taxonomy;
    const attrs = (await this.effectiveAttributes(p.category_id, tax)).map((a) => a.attribute);
    const specs = stringMap(p.specs);
    const opts = variants.map((v) => ({ options: stringMap(v.options) }));
    const filled = attrs.filter((a) => attributeFilled(a, specs, opts)).length;
    const pathIds = new Set(tax.path(p.category_id).map((c) => c.id));
    const title = normalize(p.title);
    const suggestion = tax.rows.find((c) => !pathIds.has(c.id) && !tax.children(c.id).length && normalize(c.name).length > 3 && new RegExp(`\\b${normalize(c.name)}\\b`).test(title));
    const evidence: ProductCheckEvidence[] = [];
    const details: string[] = [];
    let result: CheckResult['result'] = 'pass';
    if (attrs.length && filled / attrs.length < 0.5) {
      result = 'warn';
      details.push(`${filled} of ${attrs.length} category attributes filled`);
    }
    if (suggestion) {
      result = 'warn';
      details.push(`The title mentions ${suggestion.name}`);
      evidence.push({ label: 'Suggested category', field: 'categoryId', text: suggestion.name, score: 0.6, suggestedCategoryId: suggestion.id });
    }
    return { kind: 'category_fit', result, message: result === 'pass' ? 'Title and attributes fit the category' : 'The category may not fit', details, evidence };
  }

  private claimCheck(p: ProductRow): CheckResult {
    const hits = findClaims({ title: p.title, keyFeatures: stringList(p.key_features), description: p.description });
    if (!hits.length) return { kind: 'prohibited_claim', result: 'pass', message: 'No prohibited claims found', details: [], evidence: [] };
    const medical = hits.some((h) => h.kind === 'medical');
    const label: Record<string, string> = { title: 'title', keyFeatures: 'key features', description: 'description' };
    return {
      kind: 'prohibited_claim',
      result: medical ? 'fail' : 'warn',
      message: `${hits.length} ${medical ? 'medical' : hits[0]!.kind} claim${hits.length === 1 ? '' : 's'} found`,
      details: hits.map((h) => `"${h.text}" in the ${label[h.field] ?? h.field}`),
      evidence: hits.map((h) => ({ label: `Claim in ${label[h.field] ?? h.field}`, field: h.field, text: h.text })),
    };
  }

  protected async brandCheck(p: ProductRow): Promise<CheckResult> {
    const out = (result: CheckResult['result'], message: string, details: string[] = []): CheckResult => ({ kind: 'brand_authorization', result, message, details, evidence: [] });
    if (!p.brand_id) return out('warn', 'No brand chosen');
    const brand = await this.repo.getBrand(p.brand_id);
    if (!brand) return out('warn', 'Brand not found');
    if (brand.status === 'blocked') return out('fail', `${brand.name} is blocked`, [brand.status_reason ?? '']);
    if (brand.status === 'under_review') return out('warn', `Brand not verified: ${brand.name} is under review`, ['Activate or block the brand before deciding the product']);
    if (p.owner_type === 'official') return out('pass', 'Official Store product');
    if (brand.selling_policy === 'official_only') return out('fail', `${brand.name} is sold by the Official Store only`);
    if (brand.selling_policy === 'authorized_list') {
      const list = await this.repo.authorizedSellers([brand.id]);
      if (!list.some((a) => a.seller_id === p.owner_seller_id)) return out('fail', `The seller is not on the ${brand.name} authorized list`);
      return out('pass', `The seller is authorized for ${brand.name}`);
    }
    return out('pass', `${brand.name} is open to all sellers`);
  }

  private restrictedCheck(p: ProductRow): CheckResult {
    const hits = findRestricted({ title: p.title, description: p.description });
    if (!hits.length) return { kind: 'restricted_item', result: 'pass', message: 'No restricted items found', details: [], evidence: [] };
    return {
      kind: 'restricted_item',
      result: 'warn',
      message: 'Possible restricted item',
      details: hits.map((h) => `"${h.text}" in the ${h.field}`),
      evidence: hits.map((h) => ({ label: `Keyword in ${h.field}`, field: h.field, text: h.text })),
    };
  }

  private identifierCheck(p: ProductRow, variants: VariantRow[]): CheckResult {
    const bad = variants.filter((v) => v.gtin && !gtinValid(v.gtin));
    if (bad.length) {
      return {
        kind: 'identifier',
        result: 'fail',
        message: `${bad.length} GTIN${bad.length === 1 ? '' : 's'} with an invalid format or check digit`,
        details: bad.map((v) => `${v.gtin} (${Object.values(stringMap(v.options)).join(' / ') || 'variant'})`),
        evidence: bad.map((v) => ({ label: 'Invalid GTIN', field: 'gtin', text: v.gtin })),
      };
    }
    if (p.no_gtin) return { kind: 'identifier', result: 'warn', message: 'The submitter confirmed the product has no GTIN', details: ['Ask for proof if the brand normally assigns GTINs'], evidence: [] };
    return { kind: 'identifier', result: 'pass', message: 'GTINs are valid and not used by other products', details: [], evidence: [] };
  }
}

/* ---------------------------------------------------------------- variant parcel data and list price */

/** A whole number above zero (grams or centimetres), null to clear */
export function checkParcelValue(v: unknown, field: (typeof PARCEL_FIELDS)[number], path: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw invalid(path, field === 'weightGrams' ? 'Enter the weight in whole grams, above zero' : 'Enter the size in whole centimetres, above zero');
  if (v > MAX_PARCEL_VALUE[field]) throw invalid(path, `At most ${MAX_PARCEL_VALUE[field]}`);
  return v;
}

/** Weight and packaged dimensions of a variant: given values replace, omitted ones keep the current variant's */
function parcelColumns(v: VariantInput, current: VariantRow | undefined, path: string) {
  const out: Pick<VariantRow, 'weight_grams' | 'length_cm' | 'width_cm' | 'height_cm'> = {
    weight_grams: current?.weight_grams ?? null,
    length_cm: current?.length_cm ?? null,
    width_cm: current?.width_cm ?? null,
    height_cm: current?.height_cm ?? null,
  };
  for (const field of PARCEL_FIELDS) {
    if (v[field] !== undefined) out[PARCEL_COLUMNS[field]] = checkParcelValue(v[field], field, `${path}.${field}`);
  }
  return out;
}

export function currentListPrice(v: VariantRow | undefined): common.Money | null {
  return v && v.list_price_amount !== null && v.list_price_currency ? { amount: Number(v.list_price_amount), currency: v.list_price_currency.trim() } : null;
}

/** The images still to re-crop: the product's flagged images that it (or a variant) still uses */
function keptRecrops(existing: ProductRow | null, used: string[]): string[] {
  return stringList(existing?.recrop_media_ids).filter((id) => used.includes(id));
}

/** Staff list price: whole minor units above zero in the market currency; null clears it */
export function checkListPrice(m: common.Money | null | undefined, path: string, currency: string): common.Money | null {
  if (m == null) return null;
  if (!Number.isInteger(m.amount) || m.amount <= 0) throw invalid(path, 'Enter a list price above zero');
  if (m.currency !== currency) throw invalid(path, `Enter the list price in ${currency}`);
  return { amount: m.amount, currency: m.currency };
}
