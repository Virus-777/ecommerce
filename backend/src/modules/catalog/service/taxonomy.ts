/** Categories, attributes, image standards and brands (staff taxonomy work, store and seller brand lists). */
import { slugify } from '../../../kernel/lib/text.js';
import { SYSTEM_ACTOR } from '../../../kernel/auth/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Attribute, AttributeAdmin, AttributeInput, Brand, BrandAdmin, Category, ImageRule } from '../../../spec/catalog.js';
import { brandStatusMachine } from '../domain/state-machines.js';
import { attributeFilled, imageRulesOf, normalize } from '../domain/rules.js';
import { stringMap, toAttribute } from '../mappers.js';
import type { AttributeRow, BrandRow, CategoryRow, ProductRow } from '../ports.js';
import { invalid, notFound, requireReason, type By, type Taxonomy } from './base.js';
import { CatalogViews } from './views.js';

const PLATFORM = { kind: 'platform' as const };
const KINDS = ['text', 'number', 'enum', 'bool'];

export interface CategoryInput {
  name?: string | null;
  parentId?: string | null;
  position?: number | null;
  visible?: boolean | null;
  comingSoon?: boolean | null;
  imageId?: string | null;
}

export interface BrandInput {
  name?: string | null;
  logoId?: string | null;
  description?: string | null;
  bannerId?: string | null;
  sellingPolicy?: BrandRow['selling_policy'] | null;
  authorizedSellerIds?: string[] | null;
  reason?: string | null;
}

export class CatalogTaxonomy extends CatalogViews {
  /* ================================================================ categories */

  protected async categoryNode(id: string, admin: boolean): Promise<Category> {
    const node = (await this.categoryNodes(admin)).get(id);
    if (!node) throw notFound('Category');
    return node;
  }

  /** Every node of the full tree (hidden ones included) by id, from one build of the tree */
  protected async categoryNodes(admin: boolean, tax?: Taxonomy): Promise<Map<string, Category>> {
    const out = new Map<string, Category>();
    const walk = (list: Category[]) => {
      for (const c of list) {
        out.set(c.id, c);
        walk(c.children);
      }
    };
    walk(await this.categoryTree({ includeHidden: true, admin, tax }));
    return out;
  }

  private async uniqueSlug(base: string, taken: (slug: string) => Promise<boolean>) {
    const root = slugify(base, { fallback: 'item' });
    for (let i = 1; ; i++) {
      const slug = i === 1 ? root : `${root}-${i}`;
      if (!(await taken(slug))) return slug;
    }
  }

  async createCategory(body: CategoryInput, by: By): Promise<Category> {
    const name = body.name?.trim();
    if (!name) throw invalid('name', 'A category name is required');
    if (name.length > 80) throw invalid('name', 'The name is too long (80 characters at most)');
    const tax = await this.taxonomy();
    if (body.parentId && !tax.byId.has(body.parentId)) throw invalid('parentId', 'Parent category not found');
    const siblings = tax.children(body.parentId ?? null);
    const id = newId();
    const undo = body.imageId ? await this.attachAll([{ assetId: body.imageId, kind: 'category_image', path: 'imageId' }], { refId: id, refLabel: name }, PLATFORM) : null;
    let row: CategoryRow;
    try {
      row = await this.repo.insertCategory({
        id,
        parent_id: body.parentId ?? null,
        name,
        slug: await this.uniqueSlug(name, (s) => this.repo.categorySlugTaken(s)),
        position: body.position ?? (siblings.length ? Math.max(...siblings.map((s) => s.position)) + 1 : 0),
        visible: body.visible ?? true,
        coming_soon: body.comingSoon ?? false,
        image_media_id: body.imageId ?? null,
      });
    } catch (err) {
      await undo?.();
      throw err;
    }
    this.ctx.events.publish('catalog.category.changed', { categoryId: id, change: 'created' }, { actor: by.actor, requestId: by.requestId });
    await this.audit({ action: 'catalog.category.create', actionLabel: 'Created category', category: 'catalog', target: { type: 'category', id, label: name, screen: 'admin/catalog' }, after: row }, by);
    return this.categoryNode(id, true);
  }

  async updateCategory(id: string, body: CategoryInput, by: By): Promise<Category> {
    const tax = await this.taxonomy();
    const before = tax.byId.get(id);
    if (!before) throw notFound('Category');
    const patch: Partial<CategoryRow> = {};
    if (body.name !== undefined && body.name !== null) {
      const name = body.name.trim();
      if (!name) throw invalid('name', 'A category name is required');
      if (name.length > 80) throw invalid('name', 'The name is too long (80 characters at most)');
      if (name !== before.name) {
        patch.name = name;
        patch.slug = await this.uniqueSlug(name, (s) => this.repo.categorySlugTaken(s, id));
      }
    }
    if (body.parentId !== undefined && body.parentId !== before.parent_id) {
      if (body.parentId !== null) {
        if (!tax.byId.has(body.parentId)) throw invalid('parentId', 'Parent category not found');
        if (tax.subtree(id).includes(body.parentId)) throw invalid('parentId', 'A category cannot move under itself or one of its subcategories');
      }
      patch.parent_id = body.parentId;
    }
    if (body.position != null) patch.position = body.position;
    if (body.visible != null) patch.visible = body.visible;
    if (body.comingSoon != null) patch.coming_soon = body.comingSoon;
    let swap: Awaited<ReturnType<typeof this.swapMedia>> | null = null;
    if (body.imageId !== undefined && body.imageId !== before.image_media_id) {
      swap = await this.swapMedia([before.image_media_id], [body.imageId], 'category_image', 'imageId', { refId: id, refLabel: patch.name ?? before.name }, PLATFORM, ['content_block']);
      patch.image_media_id = body.imageId;
    }
    let after: CategoryRow;
    try {
      after = await this.repo.updateCategory(id, patch);
    } catch (err) {
      await swap?.undo();
      throw err;
    }
    await swap?.commit();
    if (Object.keys(patch).length) {
      this.ctx.events.publish('catalog.category.changed', { categoryId: id, change: 'updated' }, { actor: by.actor, requestId: by.requestId });
      await this.audit({ action: 'catalog.category.update', actionLabel: 'Changed category', category: 'catalog', target: { type: 'category', id, label: after.name, screen: 'admin/catalog' }, before, after }, by);
    }
    return this.categoryNode(id, true);
  }

  /* ================================================================ attributes and image standards */

  /** Seller submission form: own and inherited attributes, and the image standard in force */
  async categoryAttributes(categoryId: string): Promise<{ attributes: Attribute[]; imageRules: ImageRule[] }> {
    const tax = await this.taxonomy();
    if (!tax.byId.has(categoryId)) throw notFound('Category');
    return { attributes: (await this.effectiveAttributes(categoryId, tax)).map((a) => a.attribute), imageRules: await this.imageRulesFor(categoryId, tax) };
  }

  async categoryAttributesAdmin(categoryId: string): Promise<{ attributes: AttributeAdmin[]; imageRules: ImageRule[] }> {
    const tax = await this.taxonomy();
    if (!tax.byId.has(categoryId)) throw notFound('Category');
    const attrs = await this.effectiveAttributes(categoryId, tax);
    const products = await this.repo.productsInCategories(tax.subtree(categoryId), ['approved', 'submitted']);
    const variants = await this.repo.variantsOf(products.map((p) => p.id));
    const fill = (a: Attribute) =>
      products.filter((p) =>
        attributeFilled(
          a,
          stringMap(p.specs),
          variants.filter((v) => v.product_id === p.id).map((v) => ({ options: stringMap(v.options) })),
        ),
      ).length;
    return {
      attributes: attrs.map((a) => ({
        attribute: a.attribute,
        inheritedFrom: a.origin ? { categoryId: a.origin.id, name: a.origin.name } : null,
        filledCount: fill(a.attribute),
        productCount: products.length,
      })),
      imageRules: await this.imageRulesFor(categoryId, tax),
    };
  }

  /** Replaces the category's own attributes and image standard; inherited ones are edited on their category */
  async putAttributes(categoryId: string, body: { attributes: AttributeInput[]; imageRules: ImageRule[] }, by: By): Promise<Attribute[]> {
    const tax = await this.taxonomy();
    const category = tax.byId.get(categoryId);
    if (!category) throw notFound('Category');
    const inherited = (await this.effectiveAttributes(categoryId, tax)).filter((a) => a.origin);
    const own = await this.repo.attributesOf([categoryId]);
    const ownIds = new Set(own.map((a) => a.id));
    const seen = new Set<string>();
    const rows: AttributeRow[] = body.attributes.map((a, i) => {
      const name = a.name?.trim();
      if (!name) throw invalid(`attributes[${i}].name`, 'Every attribute needs a name');
      const key = normalize(name);
      if (seen.has(key)) throw invalid(`attributes[${i}].name`, `${name} is listed twice`);
      seen.add(key);
      const parent = inherited.find((x) => normalize(x.attribute.name) === key);
      if (parent) throw invalid(`attributes[${i}].name`, `${name} is inherited from ${parent.origin!.name}; edit it there`);
      if (!KINDS.includes(a.kind)) throw invalid(`attributes[${i}].kind`, 'Kind is text, number, enum or bool');
      const options = [...new Set((a.options ?? []).map((o) => o.trim()).filter(Boolean))];
      if (a.kind === 'enum' && !options.length) throw invalid(`attributes[${i}].options`, `${name} needs the values to choose from`);
      return {
        id: a.id && ownIds.has(a.id) ? a.id : newId(),
        category_id: categoryId,
        name,
        kind: a.kind,
        unit: a.unit?.trim() || null,
        options: options as never,
        required: Boolean(a.required),
        filterable: Boolean(a.filterable),
        variant_defining: Boolean(a.variantDefining),
        position: i,
      };
    });
    const rules = (body.imageRules ?? []).map((r, i) => {
      if (!r.text?.trim()) throw invalid(`imageRules[${i}].text`, 'Describe the rule for sellers');
      return { text: r.text.trim(), severity: r.severity === 'warning' ? 'warning' : 'blocking', check: r.check ?? null } as ImageRule;
    });
    const merged = imageRulesOf(rules);
    await this.repo.transaction(async (tx) => {
      await tx.replaceAttributes(categoryId, rows);
      await tx.saveImageStandard(categoryId, rules.length ? { category_id: categoryId, min_width: merged?.minWidth ?? 0, min_count: merged?.minCount ?? 1, rules: rules as never } : null);
    });
    // required attributes and image standards change what products are missing
    await this.recomputeScores(await this.repo.productsInCategories(tax.subtree(categoryId), []));
    this.ctx.events.publish('catalog.category.changed', { categoryId, change: 'attributes' }, { actor: by.actor, requestId: by.requestId });
    await this.audit(
      {
        action: 'catalog.category.attributes',
        actionLabel: 'Changed category attributes',
        category: 'catalog',
        target: { type: 'category', id: categoryId, label: category.name, screen: 'admin/catalog' },
        before: { attributes: own.map(toAttribute) },
        after: { attributes: rows.map(toAttribute), imageRules: rules },
      },
      by,
    );
    return rows.map(toAttribute);
  }

  /** Content scores recomputed (attribute or image standard changes) */
  protected async recomputeScores(rows: ProductRow[]) {
    if (!rows.length) return;
    const tax = await this.taxonomy();
    const scores = await this.completenessOf(rows, await this.repo.variantsOf(rows.map((r) => r.id)), tax);
    for (const r of rows) {
      const score = scores.get(r.id)!.score;
      if (score !== r.content_score) await this.repo.updateProduct(r.id, { content_score: score });
    }
  }

  /* ================================================================ brands: reads */

  async listBrandsStore(query: { q?: string; categorySlug?: string; sort?: 'name' | 'popular' }, page: PageRequest): Promise<common.Page<Brand>> {
    const filter = { q: query.q, statuses: ['active'] };
    if (query.categorySlug) {
      const tax = await this.taxonomy();
      const cat = tax.rows.find((c) => c.slug === query.categorySlug);
      if (!cat || !tax.visible(cat.id)) return pageOf([], page);
      if (!cat.parent_id && query.sort !== 'name') {
        const p = await this.repo.listPopularBrands(filter, cat.id, page);
        const counts = new Map((await this.repo.brandStats(p.items.map((b) => b.id), cat.id)).map((s) => [s.brand_id, s.product_count]));
        const views = await this.brandViews(p.items);
        return { ...p, items: p.items.map((b) => ({ ...views.get(b.id)!, productCount: counts.get(b.id) ?? 0 })) };
      }
      // subcategories (and name order): counts for the category and its subcategories, computed now
      const counts = await this.repo.liveProductCountsByBrandIn(tax.subtree(cat.id));
      const brands = (await this.repo.getBrands([...counts.keys()])).filter((b) => b.status === 'active' && (!query.q || normalize(b.name).includes(normalize(query.q))));
      const views = await this.brandViews(brands);
      const items = brands.map((b) => ({ ...views.get(b.id)!, productCount: counts.get(b.id) ?? 0 }));
      items.sort((a, b) => (query.sort === 'name' ? a.name.localeCompare(b.name) : b.productCount - a.productCount || a.name.localeCompare(b.name)));
      return pageOf(items, page);
    }
    const p = query.sort === 'popular' ? await this.repo.listPopularBrands(filter, null, page) : await this.repo.listBrands(filter, page);
    const views = await this.brandViews(p.items);
    return { ...p, items: p.items.map((b) => views.get(b.id)!) };
  }

  async getBrandBySlug(slug: string): Promise<Brand | null> {
    const row = await this.repo.getBrandBySlug(slug);
    if (!row || row.status !== 'active') return null;
    return (await this.brandViews([row])).get(row.id)!;
  }

  /** Submission form: active brands plus the seller's own requests still under review */
  async listBrandsForSeller(sellerId: string, q: string | undefined, page: PageRequest): Promise<common.Page<Brand>> {
    const p = await this.repo.listBrands({ q, activeOrRequestedBy: sellerId }, page);
    const views = await this.brandViews(p.items);
    return { ...p, items: p.items.map((b) => views.get(b.id)!) };
  }

  async listBrandsAdmin(query: { q?: string; status?: BrandRow['status']; sellingPolicy?: string; requested?: boolean }, page: PageRequest): Promise<common.Page<BrandAdmin>> {
    const p = await this.repo.listBrands({ q: query.q, statuses: query.status ? [query.status] : undefined, sellingPolicy: query.sellingPolicy, requested: query.requested }, page);
    return { ...p, items: await this.brandAdmins(p.items) };
  }

  protected async brandAdmin(row: BrandRow): Promise<BrandAdmin> {
    return (await this.brandAdmins([row]))[0]!;
  }

  /* ================================================================ brands: writes */

  private async checkBrandName(name: string | undefined | null, exceptId?: string) {
    const n = name?.trim();
    if (!n) throw invalid('name', 'A brand name is required');
    if (n.length > 100) throw invalid('name', 'The name is too long (100 characters at most)');
    const same = await this.repo.findBrandByName(n);
    if (same && same.id !== exceptId) throw invalid('name', `A brand named ${same.name} already exists`, { brandId: same.id });
    return n;
  }

  private publishBrand(row: BrandRow, change: 'created' | 'updated' | 'status', by: By) {
    this.ctx.events.publish('catalog.brand.changed', { brandId: row.id, change, status: row.status, sellingPolicy: row.selling_policy }, { actor: by.actor, requestId: by.requestId });
  }

  protected brandTarget(row: BrandRow) {
    return { type: 'brand', id: row.id, label: row.name, screen: 'admin/catalog' };
  }

  async createBrand(body: BrandInput, by: By): Promise<BrandAdmin> {
    const name = await this.checkBrandName(body.name);
    const id = newId();
    const now = this.now();
    const media = [
      ...(body.logoId ? [{ assetId: body.logoId, kind: 'brand_logo' as const, path: 'logoId' }] : []),
      ...(body.bannerId ? [{ assetId: body.bannerId, kind: 'brand_banner' as const, path: 'bannerId' }] : []),
    ];
    const undo = await this.attachAll(media, { refId: id, refLabel: name }, PLATFORM);
    let row: BrandRow;
    try {
      row = await this.repo.transaction(async (tx) => {
        const r = await tx.insertBrand({
          id,
          name,
          slug: await this.uniqueSlug(name, (s) => tx.brandSlugTaken(s)),
          logo_media_id: body.logoId ?? null,
          description: body.description?.trim() || null,
          banner_media_id: body.bannerId ?? null,
          status: brandStatusMachine.initial as BrandRow['status'],
          status_reason: null,
          flag_note: null,
          trust_report_id: null,
          selling_policy: body.sellingPolicy ?? 'open',
          requested_by_seller_id: null,
          requested_for_product_id: null,
          requested_change_request_id: null,
          created_at: now,
          updated_at: now,
        });
        if (body.authorizedSellerIds?.length) await tx.replaceStaffAuthorizedSellers(id, body.authorizedSellerIds, by.actor, now);
        return r;
      });
    } catch (err) {
      await undo();
      throw err;
    }
    this.publishBrand(row, 'created', by);
    await this.audit({ action: 'catalog.brand.create', actionLabel: 'Created brand', category: 'catalog', target: this.brandTarget(row), after: { ...row, authorizedSellerIds: body.authorizedSellerIds ?? [] } }, by);
    return this.brandAdmin(row);
  }

  async updateBrand(id: string, body: BrandInput, by: By): Promise<BrandAdmin> {
    const before = await this.repo.getBrand(id);
    if (!before) throw notFound('Brand');
    const beforeAuthorized = (await this.repo.authorizedSellers([id])).map((a) => a.seller_id);
    const patch: Partial<BrandRow> = {};
    if (body.name != null && body.name.trim() !== before.name) {
      patch.name = await this.checkBrandName(body.name, id);
      patch.slug = await this.uniqueSlug(patch.name, (s) => this.repo.brandSlugTaken(s, id));
    }
    if (body.description !== undefined) patch.description = body.description?.trim() || null;
    if (body.sellingPolicy != null) patch.selling_policy = body.sellingPolicy;
    const label = { refId: id, refLabel: patch.name ?? before.name };
    const swaps = [];
    if (body.logoId !== undefined && body.logoId !== before.logo_media_id) {
      swaps.push(await this.swapMedia([before.logo_media_id], [body.logoId], 'brand_logo', 'logoId', label, PLATFORM));
      patch.logo_media_id = body.logoId;
    }
    if (body.bannerId !== undefined && body.bannerId !== before.banner_media_id) {
      try {
        swaps.push(await this.swapMedia([before.banner_media_id], [body.bannerId], 'brand_banner', 'bannerId', label, PLATFORM, ['content_block']));
      } catch (err) {
        for (const s of swaps) await s.undo();
        throw err;
      }
      patch.banner_media_id = body.bannerId;
    }
    let after: BrandRow;
    try {
      after = await this.repo.transaction(async (tx) => {
        if (body.authorizedSellerIds) await tx.replaceStaffAuthorizedSellers(id, body.authorizedSellerIds, by.actor, this.now());
        return tx.updateBrand(id, { ...patch, updated_at: this.now() });
      });
    } catch (err) {
      for (const s of swaps) await s.undo();
      throw err;
    }
    for (const s of swaps) await s.commit();
    this.publishBrand(after, 'updated', by);
    await this.audit(
      {
        action: 'catalog.brand.update',
        actionLabel: 'Changed brand',
        category: 'catalog',
        target: this.brandTarget(after),
        reason: body.reason?.trim() || null,
        before: { ...before, authorizedSellerIds: beforeAuthorized },
        after: { ...after, authorizedSellerIds: (await this.repo.authorizedSellers([id])).map((a) => a.seller_id) },
      },
      by,
    );
    return this.brandAdmin(after);
  }

  async setBrandStatus(id: string, body: { status: BrandRow['status']; reason: string; trustReportId?: string | null }, by: By): Promise<BrandAdmin> {
    const reason = requireReason(body.reason);
    const event = body.status === 'active' ? 'activate' : body.status === 'blocked' ? 'block' : 'flag';
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.getBrand(id, { forUpdate: true });
      if (!before) throw notFound('Brand');
      const status = brandStatusMachine.next(before.status, event) as BrandRow['status'];
      const after = await tx.updateBrand(id, {
        status,
        status_reason: reason,
        trust_report_id: body.trustReportId ?? (status === 'active' ? null : before.trust_report_id),
        flag_note: status === 'active' ? null : body.trustReportId ? `Trust and Risk report ${body.trustReportId} · ${reason}` : before.flag_note,
        updated_at: this.now(),
      });
      return { before, after };
    });
    this.publishBrand(after, 'status', by);
    await this.audit(
      { action: `catalog.brand.${event}`, actionLabel: `${event === 'activate' ? 'Activated' : event === 'block' ? 'Blocked' : 'Flagged'} brand`, category: 'catalog', target: this.brandTarget(after), reason, before, after },
      by,
    );
    if (after.status === 'blocked') await this.returnSubmissionsForBlockedBrand(after, reason, by);
    return this.brandAdmin(after);
  }

  /** Blocking a requested brand returns its waiting submissions with changes requested (products layer) */
  protected async returnSubmissionsForBlockedBrand(_brand: BrandRow, _reason: string, _by: By): Promise<void> {}

  /**
   * sellers.change_request.decided: an approved brand_request becomes an active brand (or activates the
   * requested one).
   *
   * The read below is a fast path only: `kernel/events` delivers a handler's events concurrently, so two
   * deliveries of the same approval can both pass it, and the **insert** is what decides which one adds the
   * brand (Appendix C, found on 2026-10-28). The loser answers "already handled", exactly as the fast path
   * does. This closes the race only once `brands.requested_change_request_id` is a unique key — a spec change
   * that is not this conversion's to make (`insertBrandIfAbsent` says what it can and cannot do today).
   */
  protected async brandFromChangeRequest(input: { changeRequestId: string; sellerId: string; brandName: string }) {
    const by: By = { actor: SYSTEM_ACTOR };
    if (await this.repo.findBrandByChangeRequest(input.changeRequestId)) return; // already handled
    const name = input.brandName.trim();
    if (!name) return;
    const now = this.now();
    const same = await this.repo.findBrandByName(name);
    if (same) {
      if (same.status !== 'under_review') {
        this.ctx.log.info({ brandId: same.id, status: same.status }, 'catalog: approved brand request for a brand that is not under review; nothing to do');
        return;
      }
      const after = await this.repo.updateBrand(same.id, {
        status: brandStatusMachine.next(same.status, 'activate') as BrandRow['status'],
        status_reason: 'Brand request approved in Seller Manager',
        requested_by_seller_id: same.requested_by_seller_id ?? input.sellerId,
        requested_change_request_id: input.changeRequestId,
        updated_at: now,
      });
      this.publishBrand(after, 'status', by);
      await this.audit({ action: 'catalog.brand.activate', actionLabel: 'Activated requested brand', category: 'catalog', target: this.brandTarget(after), reason: 'Brand request approved', before: same, after }, by);
      return;
    }
    const row = await this.repo.insertBrandIfAbsent({
      id: newId(),
      name,
      slug: await this.uniqueSlug(name, (s) => this.repo.brandSlugTaken(s)),
      logo_media_id: null,
      description: null,
      banner_media_id: null,
      status: 'active',
      status_reason: 'Brand request approved in Seller Manager',
      flag_note: null,
      trust_report_id: null,
      selling_policy: 'open',
      requested_by_seller_id: input.sellerId,
      requested_for_product_id: null,
      requested_change_request_id: input.changeRequestId,
      created_at: now,
      updated_at: now,
    });
    if (!row) {
      // another delivery of the same approval inserted it first (or took the slug): nothing more to do, and
      // no event and no audit entry, because this call added nothing
      this.ctx.log.info({ changeRequestId: input.changeRequestId }, 'catalog: brand from an approved brand request was already added by another delivery');
      return;
    }
    this.publishBrand(row, 'created', by);
    await this.audit({ action: 'catalog.brand.create', actionLabel: 'Added brand from an approved brand request', category: 'catalog', target: this.brandTarget(row), after: row }, by);
  }
}
