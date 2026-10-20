/** Read models: category tree, brands, products, admin products and what blocks a submission. */
import { stringList } from '../../../kernel/lib/text.js';
import type * as common from '../../../spec/common.js';
import type { Attribute, Brand, BrandAdmin, Category, ImageRule, Product, ProductAdmin, ProductSummary, RequestedBrand, Variant } from '../../../spec/catalog.js';
import { completeness, imageRulesOf, type Completeness } from '../domain/rules.js';
import { evidenceOf, groupBy, imageRulesOfRow, iso, LOG_ACTIONS, stringMap, toAttribute, toBrand, toBrandAdmin, toCheck, toLogEntry, toReviewDraft, toSubmission } from '../mappers.js';
import type { AttributeRow, BrandRow, CategoryRow, ImageStandardRow, ProductRow, SubmissionRow, VariantRow } from '../ports.js';
import { CatalogBase, type Taxonomy, type Viewer } from './base.js';

export interface EffectiveAttribute {
  attribute: Attribute;
  /** Set when defined on an ancestor */
  origin: CategoryRow | null;
}

export class CatalogViews extends CatalogBase {
  /* ================================================================ categories and attributes */

  protected async categoryTree(opts: { includeHidden: boolean; admin: boolean; tax?: Taxonomy }): Promise<Category[]> {
    const [tax, statRows] = await Promise.all([opts.tax ?? this.taxonomy(), this.repo.categoryStats()]);
    const stats = new Map(statRows.map((s) => [s.category_id, s]));
    const refs = await this.refsMap(tax.rows.map((r) => r.image_media_id));
    // shoppers see a visible category while it has eligible stock (in it or below it), or while it says coming soon
    const shown = (c: CategoryRow) => opts.includeHidden || (c.visible && (c.coming_soon || (stats.get(c.id)?.product_count ?? 0) > 0));
    const node = (r: CategoryRow): Category => ({
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      slug: r.slug,
      position: r.position,
      visible: r.visible,
      comingSoon: r.coming_soon,
      productCount: r.coming_soon && !opts.admin ? 0 : (stats.get(r.id)?.product_count ?? 0),
      offerCount: opts.admin ? (stats.get(r.id)?.offer_count ?? 0) : null,
      image: (r.image_media_id && refs.get(r.image_media_id)) || null,
      children: tax.children(r.id).filter(shown).map(node),
    });
    return tax.children(null).filter(shown).map(node);
  }

  /** Attributes of a category and its ancestors (ancestors first) */
  protected async effectiveAttributes(categoryId: string, tax: Taxonomy, preloaded?: AttributeRow[]): Promise<EffectiveAttribute[]> {
    const path = tax.path(categoryId);
    const rows = preloaded ?? (await this.repo.attributesOf(path.map((c) => c.id)));
    return path.flatMap((c) =>
      rows
        .filter((a) => a.category_id === c.id)
        .sort((a, b) => a.position - b.position)
        .map((a) => ({ attribute: toAttribute(a), origin: c.id === categoryId ? null : c })),
    );
  }

  /** The image standard in force: the category's own, else the nearest ancestor's */
  protected imageStandardFor(categoryId: string | null, tax: Taxonomy, standards: ImageStandardRow[]): ImageStandardRow | null {
    const path = tax.path(categoryId);
    for (let i = path.length - 1; i >= 0; i--) {
      const s = standards.find((x) => x.category_id === path[i]!.id);
      if (s) return s;
    }
    return null;
  }

  protected async imageRulesFor(categoryId: string, tax: Taxonomy): Promise<ImageRule[]> {
    const standards = await this.repo.imageStandardsOf(tax.path(categoryId).map((c) => c.id));
    const s = this.imageStandardFor(categoryId, tax, standards);
    return s ? imageRulesOfRow(s.rules) : [];
  }

  /* ================================================================ brands */

  /** `refs`: media refs that already cover the brands' logos and banners (read with other images in one call) */
  protected async brandViews(rows: BrandRow[], refs?: Promise<Map<string, common.MediaRef>>): Promise<Map<string, Brand>> {
    const [stats, media] = await Promise.all([this.repo.brandStats(rows.map((r) => r.id), null), refs ?? this.refsMap(rows.flatMap((r) => [r.logo_media_id, r.banner_media_id]))]);
    const statsBy = new Map(stats.map((s) => [s.brand_id, s]));
    return new Map(rows.map((r) => [r.id, toBrand(r, statsBy.get(r.id)?.product_count ?? 0, media)]));
  }

  protected async brandAdmins(rows: BrandRow[]): Promise<BrandAdmin[]> {
    const ids = rows.map((r) => r.id);
    const [views, authorized, stats, counts] = await Promise.all([this.brandViews(rows), this.repo.authorizedSellers(ids), this.repo.brandStats(ids, null), this.repo.productCountsByBrand(ids)]);
    const statsBy = new Map(stats.map((s) => [s.brand_id, s]));
    return rows.map((r) =>
      toBrandAdmin(r, {
        brand: views.get(r.id)!,
        authorized: authorized.filter((a) => a.brand_id === r.id),
        productCount: counts.get(r.id) ?? 0,
        offerCount: statsBy.get(r.id)?.offer_count ?? 0,
        sellerCount: statsBy.get(r.id)?.seller_count ?? 0,
        liveProducts: statsBy.get(r.id)?.product_count ?? 0,
      }),
    );
  }

  /* ================================================================ products */

  protected async productViews(rows: ProductRow[], loaded?: { variants?: VariantRow[]; tax?: Taxonomy }): Promise<Map<string, Product>> {
    if (!rows.length) return new Map();
    const [tax, variants, brandRows] = await Promise.all([
      loaded?.tax ?? this.taxonomy(),
      loaded?.variants ?? this.repo.variantsOf(rows.map((r) => r.id)),
      this.repo.getBrands(rows.flatMap((r) => (r.brand_id ? [r.brand_id] : []))),
    ]);
    // one media read for product, variant and brand images
    const refsRead = this.refsMap([
      ...rows.flatMap((r) => [...stringList(r.media_ids), r.video_media_id]),
      ...variants.flatMap((v) => stringList(v.media_ids)),
      ...brandRows.flatMap((b) => [b.logo_media_id, b.banner_media_id]),
    ]);
    const [refs, brands] = await Promise.all([refsRead, this.brandViews(brandRows, refsRead)]);
    const variantsBy = groupBy(variants, (v) => v.product_id);
    const pick = (ids: string[]) => ids.flatMap((id) => (refs.has(id) ? [refs.get(id)!] : []));
    return new Map(
      rows.map((r) => {
        const vs: Variant[] = (variantsBy.get(r.id) ?? []).map((v) => ({
            id: v.id,
            options: stringMap(v.options),
            gtin: v.gtin,
            images: pick(stringList(v.media_ids)),
            weightGrams: v.weight_grams ?? null,
            lengthCm: v.length_cm ?? null,
            widthCm: v.width_cm ?? null,
            heightCm: v.height_cm ?? null,
            listPrice: v.list_price_amount !== null && v.list_price_amount !== undefined && v.list_price_currency ? { amount: Number(v.list_price_amount), currency: v.list_price_currency.trim() } : null,
          }));
        const product: Product = {
          id: r.id,
          ref: r.ref,
          title: r.title,
          slug: r.slug,
          brand: (r.brand_id && brands.get(r.brand_id)) || null,
          categoryId: r.category_id,
          categoryPath: tax.path(r.category_id).map((c) => c.name),
          description: r.description,
          keyFeatures: stringList(r.key_features),
          specs: stringMap(r.specs),
          includedItems: stringList(r.included_items),
          images: pick(stringList(r.media_ids)),
          video: (r.video_media_id && refs.get(r.video_media_id)) || null,
          modelNumber: r.model_number,
          manufacturerPartNumber: r.mpn,
          noGtin: r.no_gtin,
          variants: vs,
          updatedAt: r.updated_at.toISOString(),
          listedAt: iso(r.listed_at),
        };
        return [r.id, product];
      }),
    );
  }

  protected async summaries(rows: ProductRow[]): Promise<Map<string, ProductSummary>> {
    const views = await this.productViews(rows);
    return new Map(
      [...views.values()].map((p) => [p.id, { id: p.id, ref: p.ref, title: p.title, slug: p.slug, brand: p.brand ?? null, categoryId: p.categoryId ?? null, image: p.images[0] ?? null, variantCount: p.variants.length }]),
    );
  }

  /** What blocks submission and the content score, from the product as it is now */
  protected async completenessOf(rows: ProductRow[], variants: VariantRow[], tax: Taxonomy): Promise<Map<string, Completeness>> {
    const catIds = [...new Set(rows.flatMap((r) => tax.path(r.category_id).map((c) => c.id)))];
    const [attrs, standards, minDescription] = await Promise.all([this.repo.attributesOf(catIds), this.repo.imageStandardsOf(catIds), this.ctx.settings.get('minDescriptionLength')]);
    const variantsBy = groupBy(variants, (v) => v.product_id);
    // required attributes per category, worked out once for all its products
    const requiredBy = new Map<string, Attribute[]>();
    const requiredOf = async (categoryId: string) => {
      let required = requiredBy.get(categoryId);
      if (!required) {
        required = (await this.effectiveAttributes(categoryId, tax, attrs)).filter((a) => a.attribute.required).map((a) => a.attribute);
        requiredBy.set(categoryId, required);
      }
      return required;
    };
    const out = new Map<string, Completeness>();
    for (const r of rows) {
      const required = r.category_id ? await requiredOf(r.category_id) : [];
      const standard = this.imageStandardFor(r.category_id, tax, standards);
      const minImages = Math.max(standard?.min_count ?? 1, imageRulesOf(standard ? imageRulesOfRow(standard.rules) : [])?.minCount ?? 1);
      out.set(
        r.id,
        completeness(
          {
            title: r.title,
            brandId: r.brand_id,
            requestedBrand: r.requested_brand,
            categoryId: r.category_id,
            description: r.description,
            keyFeatures: stringList(r.key_features),
            specs: stringMap(r.specs),
            imageCount: stringList(r.media_ids).length,
            modelNumber: r.model_number,
            mpn: r.mpn,
            noGtin: r.no_gtin,
            variants: (variantsBy.get(r.id) ?? []).map((v) => ({ options: stringMap(v.options), gtin: v.gtin })),
          },
          { requiredAttributes: required, minDescription, minImages },
        ),
      );
    }
    return out;
  }

  /**
   * ProductAdmin for staff (everything), a seller (own submissions: no automated checks, reviewer drafts
   * or assignee) or the public API (no caller-specific review draft).
   */
  protected async adminViews(rows: ProductRow[], viewer: Viewer): Promise<ProductAdmin[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [tax, variants] = await Promise.all([this.taxonomy(), this.repo.variantsOf(ids)]);
    const [views, logs, subs, listing, complete] = await Promise.all([
      this.productViews(rows, { variants, tax }),
      this.repo.logsOf(ids),
      this.repo.latestSubmissions(ids),
      this.repo.listingStats(ids),
      this.completenessOf(rows, variants, tax),
    ]);
    const staff = viewer.kind === 'staff' || viewer.kind === 'system';
    const subBy = new Map<string, SubmissionRow>(subs.map((s) => [s.product_id, s]));
    // checks are read for every viewer (duplicateSuspected), but only staff see them
    const [checks, drafts] = await Promise.all([
      this.repo.checksOf(subs.map((s) => s.id)),
      viewer.kind === 'staff' && viewer.staffId ? this.repo.draftsOf(subs.filter((s) => s.state === 'open').map((s) => s.id), viewer.staffId) : [],
    ]);
    const dismissals = await this.repo.dismissalsOf(checks.filter((c) => c.kind === 'duplicate').map((c) => c.id));
    const checksBy = groupBy(checks, (c) => c.submission_id);
    const draftBy = new Map(drafts.map((d) => [d.submission_id, d]));
    const logsBy = groupBy(logs, (g) => g.product_id);
    const listingBy = new Map(listing.map((l) => [l.product_id, l]));
    const dismissed = new Set(dismissals.map((d) => `${d.check_id}|${d.matched_product_id}`));

    // duplicate candidates: matched products of the latest duplicate check that are still open
    const candidateIds = new Map<string, string[]>();
    for (const s of subs) {
      const c = checksBy.get(s.id)?.find((x) => x.kind === 'duplicate');
      if (!c || c.result === 'pass' || (c.dismissed_at && !c.dismissed_matched_product_id)) continue;
      candidateIds.set(s.product_id, [
        ...new Set(
          evidenceOf(c.evidence)
            .filter((e) => e.matchedProductId && !dismissed.has(`${c.id}|${e.matchedProductId}`))
            .map((e) => e.matchedProductId!),
        ),
      ]);
    }
    const candidateSummaries = staff ? await this.summaries(await this.repo.getProducts([...candidateIds.values()].flat())) : new Map<string, ProductSummary>();
    const now = this.now();

    return rows.map((r) => {
      const sub = subBy.get(r.id) ?? null;
      const subChecks = sub ? (checksBy.get(sub.id) ?? []) : [];
      const dupIds = candidateIds.get(r.id) ?? [];
      const draft = sub ? draftBy.get(sub.id) : undefined;
      const l = listingBy.get(r.id);
      const c = complete.get(r.id)!;
      return {
        product: views.get(r.id)!,
        owner: r.owner_type,
        ownerSellerId: r.owner_seller_id,
        reviewState: r.review_state as ProductAdmin['reviewState'],
        publication: r.publication as ProductAdmin['publication'],
        version: r.version,
        missing: c.missing,
        reviewLog: (logsBy.get(r.id) ?? []).filter((g) => (LOG_ACTIONS as readonly string[]).includes(g.action)).map(toLogEntry),
        duplicateCandidates: staff ? dupIds.flatMap((id) => (candidateSummaries.has(id) ? [candidateSummaries.get(id)!] : [])) : [],
        submission: sub ? toSubmission(sub, now, { staff }) : null,
        checks: staff ? subChecks.map((c) => toCheck(c, dismissals)) : [],
        requestedBrand: (r.requested_brand as RequestedBrand | null) ?? null,
        contentScore: r.content_score,
        duplicateSuspected: staff && dupIds.length > 0,
        offerCount: l?.offer_count ?? 0,
        liveOfferCount: l?.live_offer_count ?? 0,
        bestPrice: (l?.best_price as common.Money | null) ?? null,
        offerNote: l?.offer_note ?? null,
        reviewDraft: draft && viewer.kind === 'staff' ? toReviewDraft(draft, { kind: 'staff', id: draft.staff_id }) : null,
        imagesToRecrop: stringList(r.recrop_media_ids),
      };
    });
  }

  protected async adminView(row: ProductRow, viewer: Viewer): Promise<ProductAdmin> {
    return (await this.adminViews([row], viewer))[0]!;
  }
}
