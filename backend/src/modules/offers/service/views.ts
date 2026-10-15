/**
 * Seller Center and Admin Center reads: offer summaries, lists with their filters and tab counts,
 * offer details, the offer-form preview, Official Store rows, exports and content-gap copies.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { pageOf, toPageRequest, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type {
  Offer,
  OfferAdminDetail,
  OfferAdminRow,
  OfferInput,
  OfferPreview,
  OfferSummary,
  OfficialOfferRow,
  SellerOfferDetail,
  SellerOfferRow,
  StockCue,
} from '../../../spec/offers.js';
import type * as reports from '../../../spec/reports.js';
import { CONDITIONS, dispatchLabel, reason } from '../domain/rules.js';
import { compareAtOf, FULFILLMENT_NOTE, money, OFFICIAL_NAME, pricePoint, statusEntry, variantLabel } from '../mappers.js';
import type { OfferListFilter, OfferRec } from '../ports.js';
import { invalidField, notFound, Part, type By, type ProductCache } from './core.js';

export const SELLER_DATASET = 'offers.seller.offers';
export const ADMIN_DATASET = 'offers.admin.offers';
const EXPORT_PAGE = 500;
const SCAN_LIMIT = 5000;

type StockMap = Map<string, StockCue>;

export interface SellerListQuery {
  q?: string;
  status?: string;
  condition?: string;
  categoryId?: string;
  stockState?: 'in_stock' | 'low_stock' | 'out_of_stock';
  productReviewState?: string;
  featured?: boolean;
  hiddenOrSuspended?: boolean;
  missingContent?: 'images' | 'identifiers';
}

const EMPTY_STOCK: StockCue = { available: 0, reserved: 0, incoming: 0, lowStockThreshold: null, state: 'out_of_stock' };

export class ViewsPart extends Part {
  #datasets?: Promise<void>;

  /* ================================================================ building blocks */

  async summaries(rows: readonly OfferRec[], cache: ProductCache = new Map()): Promise<Map<string, OfferSummary>> {
    const [products, elig, featured, lookback, names] = await Promise.all([
      this.core.products(rows.map((r) => r.product_id), cache),
      this.repo.getEligibility(rows.map((r) => r.id)),
      this.repo.featuredOfferIds(rows.map((r) => r.id)),
      this.core.lookbackDays(),
      this.core.sellerNames(rows),
    ]);
    const e = new Map(elig.map((x) => [x.offer_id, x]));
    const out = new Map<string, OfferSummary>();
    for (const r of rows) {
      const p = products.get(r.product_id)?.product;
      const v = p?.variants.find((x) => x.id === r.variant_id);
      const compareAt = compareAtOf(r, this.core.nameOf(r, names), lookback);
      out.set(r.id, {
        id: r.id,
        productId: r.product_id,
        variantId: r.variant_id,
        productTitle: p?.title ?? 'Unknown product',
        variantLabel: variantLabel(v?.options),
        image: v?.images[0] ?? p?.images[0] ?? null,
        ownerType: r.owner_type,
        condition: r.condition as OfferSummary['condition'],
        sellerSku: r.seller_sku,
        price: money(r.price_amount, r.currency),
        compareAt: compareAt?.amount ?? null,
        status: r.status as OfferSummary['status'],
        statusReason: (r.status_reason as OfferSummary['statusReason']) ?? null,
        featured: featured.has(r.id) && r.status === 'active',
        featuredEligible: e.get(r.id)?.eligible ?? r.status === 'active',
      });
    }
    return out;
  }

  async stock(rows: readonly OfferRec[], sellerId?: string): Promise<StockMap> {
    const out: StockMap = new Map();
    if (!rows.length) return out;
    const items = (await this.core.soft('inventory.getStockForOffers', () => this.ctx.use('inventory').getStockForOffers(rows.map((r) => r.id), sellerId ? { sellerId } : {}))) ?? {};
    for (const r of rows) {
      const s = items[r.id];
      out.set(r.id, s ? { available: s.quantities.available, reserved: s.quantities.reserved, incoming: s.quantities.incoming, lowStockThreshold: s.lowStockThreshold ?? null, state: s.state } : EMPTY_STOCK);
    }
    return out;
  }

  private productSummary(p: catalog.ProductAdmin | undefined, productId: string): catalog.ProductSummary {
    if (!p) return { id: productId, ref: '', title: 'Unknown product', slug: '', brand: null, categoryId: null, image: null, variantCount: 0 };
    const x = p.product;
    return { id: x.id, ref: x.ref, title: x.title, slug: x.slug, brand: x.brand ?? null, categoryId: x.categoryId ?? null, image: x.images[0] ?? null, variantCount: x.variants.length };
  }

  /** Lowest active New price and the Official Store price for a variant (offer form context) */
  async priceContext(variantId: string, exceptId?: string) {
    const rows = (await this.repo.find('offers', { variant_id: variantId, status: 'active' })).filter((r) => r.id !== exceptId);
    const news = rows.filter((r) => r.condition === 'new');
    const low = news.length ? news.reduce((m, r) => (r.price_amount < m.price_amount ? r : m)) : null;
    const official = news.find((r) => r.owner_type === 'official');
    return {
      lowestNewPrice: low ? money(low.price_amount, low.currency) : null,
      officialStorePrice: official ? money(official.price_amount, official.currency) : null,
      otherOfferCount: rows.length,
    };
  }

  /* ================================================================ seller area */

  private async sellerRows(rows: readonly OfferRec[], sellerId: string, cache: ProductCache): Promise<SellerOfferRow[]> {
    const [summaries, stock, products] = await Promise.all([this.summaries(rows, cache), this.stock(rows, sellerId), this.sellerProducts(sellerId, rows.map((r) => r.product_id), cache)]);
    return rows.map((r) => {
      const p = products.get(r.product_id);
      const changes = p?.reviewState === 'changes_requested' ? [...(p.reviewLog ?? [])].reverse().find((l) => l.action === 'changes_requested') : undefined;
      return {
        offer: summaries.get(r.id)!,
        productReviewState: p?.reviewState ?? 'approved',
        productPublication: p?.publication ?? 'active',
        reviewNote: changes?.reason ?? null,
        stock: stock.get(r.id) ?? EMPTY_STOCK,
        contentGaps: (r.content_gaps ?? []).filter((g): g is 'images' | 'identifiers' => g === 'images' || g === 'identifiers'),
      };
    });
  }

  /** The products as this seller may see them (their own submissions with review state) */
  private async sellerProducts(sellerId: string, ids: readonly string[], cache: ProductCache): Promise<Map<string, catalog.ProductAdmin>> {
    const out = new Map<string, catalog.ProductAdmin>();
    for (const id of new Set(ids)) {
      const key = `seller:${sellerId}:${id}`;
      let p = cache.get(key);
      if (!p) {
        p = this.core.soft('catalog.getProductForSeller', () => this.ctx.use('catalog').getProductForSeller(sellerId, id)).then((x) => x?.product ?? null);
        cache.set(key, p);
      }
      const v = await p;
      if (v) out.set(id, v);
    }
    return out;
  }

  private needsScan(q: SellerListQuery) {
    return Boolean(q.q?.trim() || q.categoryId || q.stockState || q.productReviewState || q.featured !== undefined || q.hiddenOrSuspended !== undefined);
  }

  async listOwn(sellerId: string, q: SellerListQuery, page: PageRequest): Promise<common.Page<SellerOfferRow>> {
    if (q.condition && !CONDITIONS.includes(q.condition as never) && !['used'].includes(q.condition)) throw invalidField('condition', `Condition is one of ${CONDITIONS.join(', ')}`);
    const base: OfferListFilter = {
      ownerType: 'seller',
      sellerId,
      ...(q.status ? { statuses: [q.status] } : {}),
      ...(q.condition ? { conditions: q.condition === 'used' ? ['used_like_new', 'used_good', 'used_acceptable'] : [q.condition] } : {}),
      ...(q.missingContent ? { contentGap: q.missingContent } : {}),
    };
    const cache: ProductCache = new Map();
    if (!this.needsScan(q)) {
      const p = await this.repo.listOffers(base, page);
      return { ...p, items: await this.sellerRows(p.items, sellerId, cache) };
    }
    const all = await this.repo.allOffers(base, SCAN_LIMIT);
    const rows = await this.sellerRows(all, sellerId, cache);
    const products = await this.sellerProducts(sellerId, all.map((r) => r.product_id), cache);
    const term = q.q?.trim().toLowerCase();
    const filtered = rows.filter((row, i) => {
      const r = all[i]!;
      const p = products.get(r.product_id);
      if (term) {
        const v = p?.product.variants.find((x) => x.id === r.variant_id);
        const hay = [r.seller_sku, p?.product.title, p?.product.modelNumber, v?.gtin, r.id].filter(Boolean).map((s) => String(s).toLowerCase());
        if (!hay.some((h) => h.includes(term))) return false;
      }
      if (q.categoryId && p?.product.categoryId !== q.categoryId) return false;
      if (q.stockState && row.stock.state !== q.stockState) return false;
      if (q.productReviewState && row.productReviewState !== q.productReviewState) return false;
      if (q.featured !== undefined && row.offer.featured !== q.featured) return false;
      if (q.hiddenOrSuspended !== undefined) {
        const hidden = r.status === 'paused' || r.status === 'ineligible' || row.productPublication !== 'active';
        if (hidden !== q.hiddenOrSuspended) return false;
      }
      return true;
    });
    return pageOf(filtered, page);
  }

  async countOwn(sellerId: string) {
    const byStatus = await this.repo.countByStatus({ ownerType: 'seller', sellerId });
    const rows = await this.repo.allOffers({ ownerType: 'seller', sellerId, excludeStatuses: ['removed'] }, SCAN_LIMIT);
    const products = await this.sellerProducts(sellerId, rows.map((r) => r.product_id), new Map());
    const n = (s: string) => byStatus[s] ?? 0;
    const review = (state: string) => rows.filter((r) => products.get(r.product_id)?.reviewState === state).length;
    return {
      all: Object.values(byStatus).reduce((a, b) => a + b, 0) - n('removed'),
      active: n('active'),
      draft: n('draft'),
      paused: n('paused'),
      outOfStock: n('out_of_stock'),
      ineligible: n('ineligible'),
      removed: n('removed'),
      productSubmitted: review('submitted'),
      productChangesRequested: review('changes_requested'),
      productRejected: review('rejected'),
      hiddenOrSuspended: rows.filter((r) => r.status === 'paused' || r.status === 'ineligible' || (products.get(r.product_id)?.publication ?? 'active') !== 'active').length,
      productCount: new Set(rows.map((r) => r.product_id)).size,
    };
  }

  async sellerDetail(row: OfferRec): Promise<SellerOfferDetail> {
    const cache: ProductCache = new Map();
    const [offer, product, stock, history, log, context] = await Promise.all([
      this.core.toOffer(row),
      row.seller_id ? this.sellerProducts(row.seller_id, [row.product_id], cache).then((m) => m.get(row.product_id)) : this.core.productAdmin(row.product_id, cache).then((p) => p ?? undefined),
      this.stock([row], row.seller_id ?? undefined),
      this.repo.find('offer_price_history', { offer_id: row.id }, { orderBy: [['valid_from', 'desc']], limit: 50 }),
      this.repo.find('offer_status_log', { offer_id: row.id }, { orderBy: [['at', 'desc']], limit: 50 }),
      this.priceContext(row.variant_id, row.id),
    ]);
    const variant = product?.product.variants.find((v) => v.id === row.variant_id) ?? { id: row.variant_id, options: {}, gtin: null, images: [] };
    return {
      offer,
      product: this.productSummary(product, row.product_id),
      variant,
      productIncludedItems: product?.product.includedItems ?? [],
      productReviewState: product?.reviewState ?? 'approved',
      productPublication: product?.publication ?? 'active',
      stock: stock.get(row.id) ?? EMPTY_STOCK,
      priceHistory: history.map((h) => pricePoint(h, row.currency)),
      statusLog: log.map(statusEntry),
      otherOfferCount: context.otherOfferCount,
      lowestNewPrice: context.lowestNewPrice,
      officialStorePrice: context.officialStorePrice,
      // dispatch and shipping profile edits are saved but have no customer effect while Marketly fulfils the offer
      fulfillmentNote: row.fulfilled_by === 'marketly_service' ? FULFILLMENT_NOTE : null,
    };
  }

  /** POST /offers/preview: what a customer would see and what the form still needs */
  async preview(sellerId: string, input: OfferInput): Promise<OfferPreview> {
    const m = this.parts.manage;
    const res = await m.resolveProduct(input.productId, input.variantId, sellerId);
    const warnings: string[] = [];
    const b = await m.baseline(sellerId, res.categoryId, input.condition);
    const origin = await m.origin(sellerId);
    const delivery = await this.parts.storefront.deliveryFor(
      { profileId: input.shippingProfileId, businessDays: input.dispatchBusinessDays, sameDayCutoff: origin.sameDayCutoff, shipsFrom: origin.shipsFrom, label: dispatchLabel(input.dispatchBusinessDays) },
      this.parts.storefront.deliverTo(undefined),
    );
    const context = await this.priceContext(input.variantId);
    let compareAtCheck: OfferPreview['compareAtCheck'] = null;
    if (input.compareAt) {
      try {
        const v = await m.compareAtForNew(input.compareAt, input.price, res.product, input.variantId);
        compareAtCheck = v ? { amount: v.amount, basis: v.basis, verified: true, explanation: 'Was-price matches the list price on file.' } : null;
      } catch (err) {
        compareAtCheck = { amount: input.compareAt.amount, basis: input.compareAt.basis, verified: false, explanation: (err as Error).message };
        warnings.push(`Was-price not verified: ${(err as Error).message}. It will not be shown.`);
      }
    }
    if (input.returnTerms?.kind === 'extended' && (input.returnTerms.windowDays ?? 0) < b.windowDays) warnings.push(`Returns must allow at least ${b.windowDays} days for this category.`);
    if (input.condition !== 'new' && !input.conditionNotes?.trim()) warnings.push('Describe the condition: used and refurbished offers need condition notes.');
    if (!res.purchasable) warnings.push('The product is still in catalog review: the offer is saved as a draft and can publish when the product is approved.');
    if (context.lowestNewPrice && input.condition === 'new' && input.price.amount > context.lowestNewPrice.amount * 1.2) warnings.push(`Your price is more than 20% above the lowest New offer (${(context.lowestNewPrice.amount / 100).toFixed(2)}).`);
    if (!delivery.shipsToLocation) warnings.push('This shipping profile does not deliver to the market default location.');
    const snap = (await this.core.sellerSnapshots([sellerId])).get(sellerId);
    if (snap && !snap.launchReady) warnings.push('Your launch review has not passed yet: published offers wait in draft until it does.');
    const rule = await this.parts.featured.currentRule();
    const standing = (await this.core.sellerStanding([sellerId], rule.parameters.minOnTimeDispatchPct)).get(sellerId);
    const reasons = [...(res.purchasable ? [] : [reason('product_not_purchasable')]), ...(standing?.reasons ?? [])];
    if (!rule.parameters.competingConditions.includes(input.condition)) reasons.push(reason('condition_not_competing'));
    return {
      delivery,
      lowestNewPrice: context.lowestNewPrice,
      officialStorePrice: context.officialStorePrice,
      compareAtCheck,
      returnBaseline: m.baselineTerms(b),
      featuredEligibility: { eligible: reasons.length === 0, reasons, evaluatedAt: this.now().toISOString() },
      warnings,
    };
  }

  async searchOwn(sellerId: string, q: string, limit: number): Promise<{ items: OfferSummary[]; more: boolean }> {
    const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const term = q?.trim();
    if (!term) return { items: [], more: false };
    const page = await this.listOwn(sellerId, { q: term }, { mode: 'page', page: 1, limit: n });
    return { items: page.items.map((r) => r.offer), more: (page.total ?? 0) > n };
  }

  /* ================================================================ admin */

  async adminList(q: { q?: string; ownerType?: 'official' | 'seller'; sellerId?: string; productId?: string; status?: string; condition?: string; featuredEligible?: boolean; ineligibleReason?: string; shippingProfileId?: string }, page: PageRequest): Promise<common.Page<OfferAdminRow>> {
    const p = await this.repo.listOffers(
      {
        ...(q.ownerType ? { ownerType: q.ownerType } : {}),
        ...(q.sellerId ? { sellerId: q.sellerId } : {}),
        ...(q.productId ? { productId: q.productId } : {}),
        ...(q.status ? { statuses: [q.status] } : {}),
        ...(q.condition ? { conditions: [q.condition] } : {}),
        ...(q.featuredEligible !== undefined ? { featuredEligible: q.featuredEligible } : {}),
        ...(q.ineligibleReason ? { ineligibilityCode: q.ineligibleReason } : {}),
        ...(q.shippingProfileId ? { shippingProfileId: q.shippingProfileId } : {}),
        ...(q.q ? { q: q.q } : {}),
      },
      page,
    );
    const [summaries, cues, snaps, elig] = await Promise.all([
      this.summaries(p.items),
      this.parts.storefront.sellerCues(p.items),
      this.core.sellerSnapshots(p.items.map((r) => r.seller_id)),
      this.repo.getEligibility(p.items.map((r) => r.id)),
    ]);
    const e = new Map(elig.map((x) => [x.offer_id, x]));
    return {
      ...p,
      items: p.items.map((r) => ({
        offer: summaries.get(r.id)!,
        seller: cues.get(r.id)!,
        sellerStatus: r.seller_id ? (snaps.get(r.seller_id)?.status ?? null) : null,
        ineligibleReasons: ((e.get(r.id)?.reasons ?? []) as { message: string }[]).map((x) => x.message),
      })),
    };
  }

  async adminDetail(row: OfferRec): Promise<OfferAdminDetail> {
    const [offer, product, cues, stock, log, history, changes] = await Promise.all([
      this.core.toOffer(row),
      this.core.productAdmin(row.product_id),
      this.parts.storefront.sellerCues([row]),
      this.stock([row]),
      this.repo.find('offer_status_log', { offer_id: row.id }, { orderBy: [['at', 'desc']], limit: 100 }),
      this.repo.find('offer_price_history', { offer_id: row.id }, { orderBy: [['valid_from', 'desc']], limit: 100 }),
      this.parts.pricing.changesFor(row.id),
    ]);
    return {
      offer,
      product: this.productSummary(product ?? undefined, row.product_id),
      seller: cues.get(row.id)!,
      stock: stock.get(row.id) ?? EMPTY_STOCK,
      statusLog: log.map(statusEntry),
      priceHistory: history.map((h) => pricePoint(h, row.currency)),
      priceChanges: changes,
    };
  }

  async officialList(q: { q?: string; status?: string; stockState?: string; categoryId?: string }, page: PageRequest): Promise<common.Page<OfficialOfferRow>> {
    const base: OfferListFilter = { ownerType: 'official', ...(q.status ? { statuses: [q.status] } : {}) };
    const cache: ProductCache = new Map();
    let rows: OfferRec[];
    let p: common.Page<OfferRec> | null = null;
    if (q.q?.trim() || q.stockState || q.categoryId) {
      rows = await this.repo.allOffers(base, SCAN_LIMIT);
    } else {
      p = await this.repo.listOffers(base, page);
      rows = p.items;
    }
    const [summaries, stock, products] = await Promise.all([this.summaries(rows, cache), this.stock(rows), this.core.products(rows.map((r) => r.product_id), cache)]);
    const pendingRows = rows.length ? await this.repo.find('price_changes', { offer_id: rows.map((r) => r.id), state: ['scheduled', 'pending_approval'] }) : [];
    const pendingViews = new Map((await this.parts.pricing.toPriceChanges(pendingRows)).map((c) => [c.offerId, c]));
    const out: OfficialOfferRow[] = [];
    const term = q.q?.trim().toLowerCase();
    for (const r of rows) {
      const prod = products.get(r.product_id);
      const s = stock.get(r.id) ?? EMPTY_STOCK;
      if (term && ![r.seller_sku, prod?.product.title].some((x) => x?.toLowerCase().includes(term))) continue;
      if (q.stockState && s.state !== q.stockState) continue;
      if (q.categoryId && prod?.product.categoryId !== q.categoryId) continue;
      const cost = await this.core.soft('inventory.getUnitCost', () => this.ctx.use('inventory').getUnitCost(r.stock_item_id));
      const margin = cost && r.price_amount > 0 ? Math.round(((r.price_amount - cost.amount) / r.price_amount) * 1000) / 10 : null;
      const note = prod?.reviewState === 'changes_requested' ? 'Product changes requested' : s.incoming > 0 ? `Incoming ${s.incoming}` : null;
      out.push({ offer: summaries.get(r.id)!, unitCost: cost ?? null, marginPct: margin, stock: s, note, pendingPriceChange: pendingViews.get(r.id) ?? null });
    }
    return p ? { ...p, items: out } : pageOf(out, page);
  }

  /* ================================================================ content gaps */

  /** Copies the product's missing images / identifiers onto its offers (seller list filter) */
  async refreshContentGaps(productId: string): Promise<void> {
    const p = await this.core.productAdmin(productId);
    if (!p) return;
    const gaps: string[] = [];
    const missing = p.missing.map((m) => m.toLowerCase());
    if (missing.some((m) => m.includes('image') || m.includes('photo'))) gaps.push('images');
    if (missing.some((m) => /gtin|upc|ean|identifier|model|brand/.test(m)) || (!p.product.noGtin && p.product.variants.some((v) => !v.gtin) && !p.product.modelNumber)) gaps.push('identifiers');
    await this.repo.updateWhere('offers', { product_id: productId }, { content_gaps: gaps });
  }

  /* ================================================================ exports */

  async registerDatasets(): Promise<void> {
    const api = this.ctx.tryUse('reports');
    if (!api) return;
    this.#datasets ??= (async () => {
      const columns = [
        ['product', 'Product'],
        ['variant', 'Variant'],
        ['sellerSku', 'Seller SKU'],
        ['condition', 'Condition'],
        ['price', 'Price'],
        ['compareAt', 'Compare-at price'],
        ['available', 'Available'],
        ['reviewState', 'Review state'],
        ['publication', 'Publication'],
        ['status', 'Status'],
        ['updatedAt', 'Updated at'],
      ].map(([key, label]) => ({ key, label }));
      await api.registerDataset({ key: SELLER_DATASET, owner: 'offers', title: 'Offers', permission: 'offers.offers.export', audience: 'seller', screens: ['seller/products'], available: true, phase: 1, columns });
      await api.registerDataset({
        key: ADMIN_DATASET,
        owner: 'offers',
        title: 'Offers',
        permission: 'offers.offers.view',
        audience: 'staff',
        screens: ['admin/catalog'],
        available: true,
        phase: 1,
        columns: [...columns, { key: 'seller', label: 'Seller' }, { key: 'featuredEligible', label: 'Featured eligible' }],
      });
    })().catch((err) => {
      this.#datasets = undefined;
      if ((err as { code?: string }).code !== 'NOT_IMPLEMENTED') throw err;
    });
    return this.#datasets;
  }

  private exportFilters(raw: unknown): SellerListQuery {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw invalidField('filters', 'Filters are the list filters (q, status, condition, …)');
    const f = raw as Record<string, unknown>;
    const out: SellerListQuery = {};
    for (const k of ['q', 'status', 'condition', 'categoryId', 'stockState', 'productReviewState', 'missingContent'] as const) {
      if (f[k] === undefined || f[k] === null) continue;
      if (typeof f[k] !== 'string') throw invalidField(`filters.${k}`, 'Must be text');
      (out as Record<string, unknown>)[k] = f[k];
    }
    for (const k of ['featured', 'hiddenOrSuspended'] as const) {
      if (f[k] === undefined || f[k] === null) continue;
      if (typeof f[k] !== 'boolean') throw invalidField(`filters.${k}`, 'Must be true or false');
      out[k] = f[k] as boolean;
    }
    return out;
  }

  async exportOwn(sellerId: string, body: { offerIds?: string[] | null; filters?: unknown; format?: 'csv' | 'xlsx' | null }, by: By & { principal: identity.Principal }): Promise<reports.ExportJob> {
    const filters: Record<string, unknown> = { ...this.exportFilters(body.filters) };
    if (body.offerIds?.length) {
      const own = await this.repo.find('offers', { id: [...new Set(body.offerIds)], owner_type: 'seller', seller_id: sellerId });
      if (own.length !== new Set(body.offerIds).size) throw invalidField('offerIds', 'Some selected rows are not your offers');
      filters.offerIds = [...new Set(body.offerIds)];
    }
    const api = this.ctx.tryUse('reports');
    if (!api) throw new AppError('SERVICE_UNAVAILABLE', 'Exports are unavailable right now');
    await this.registerDatasets();
    const job = await api.requestExport({ dataset: SELLER_DATASET, filters, format: body.format ?? 'csv', principal: by.principal, sellerId });
    await this.core.audit(
      { action: 'offers.offers.export', actionLabel: 'Exported offers', category: 'other', target: { type: 'export', id: job.id, ref: job.ref, label: 'Offer export', sellerId, screen: 'seller/products' }, after: { filters, format: job.format }, visibleToSeller: true },
      by,
    );
    return job;
  }

  async getOwnExport(sellerId: string, id: string, principal: identity.Principal): Promise<reports.ExportJob> {
    const api = this.ctx.tryUse('reports');
    if (!api || !isUuid(id)) throw notFound('Export');
    const job = await api.getExport(id, principal);
    if (!job || job.dataset !== SELLER_DATASET || (job.sellerId && job.sellerId !== sellerId)) throw notFound('Export');
    if (job.requestedBy?.id && principal.accountId && job.requestedBy.id !== principal.accountId) throw new AppError('FORBIDDEN', 'Only the member who requested this export can download it');
    return job;
  }

  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    const offset = cursor ? Math.max(0, Number(cursor) || 0) : 0;
    let all: OfferRec[];
    let sellerId: string | undefined;
    if (dataset === SELLER_DATASET) {
      sellerId = principal.sellerId ?? undefined;
      if (!sellerId) throw new AppError('FORBIDDEN', 'Seller exports need the seller session');
      const f = (filters ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(f.offerIds) ? (f.offerIds as string[]) : null;
      if (ids) all = await this.repo.find('offers', { id: ids, owner_type: 'seller', seller_id: sellerId });
      else {
        const listed = (await this.listOwn(sellerId, this.exportFilters(filters), { mode: 'page', page: 1, limit: SCAN_LIMIT })).items.map((r) => r.offer.id);
        const byId = new Map((await this.repo.getMany('offers', listed)).map((r) => [r.id, r]));
        all = listed.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      }
    } else if (dataset === ADMIN_DATASET) {
      if (principal.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
      const f = (filters ?? {}) as Record<string, unknown>;
      all = await this.repo.allOffers(
        {
          ...(typeof f.ownerType === 'string' ? { ownerType: f.ownerType as 'official' | 'seller' } : {}),
          ...(typeof f.sellerId === 'string' ? { sellerId: f.sellerId } : {}),
          ...(typeof f.productId === 'string' ? { productId: f.productId } : {}),
          ...(typeof f.status === 'string' ? { statuses: [f.status] } : {}),
          ...(typeof f.q === 'string' ? { q: f.q } : {}),
        },
        50_000,
      );
    } else throw invalidField('dataset', `Offers has no dataset ${dataset}`);
    const slice = all.slice(offset, offset + EXPORT_PAGE);
    const cache: ProductCache = new Map();
    const [summaries, stock, products, names, elig] = await Promise.all([
      this.summaries(slice, cache),
      this.stock(slice, sellerId),
      this.core.products(slice.map((r) => r.product_id), cache),
      this.core.sellerNames(slice),
      this.repo.getEligibility(slice.map((r) => r.id)),
    ]);
    const e = new Map(elig.map((x) => [x.offer_id, x]));
    return {
      rows: slice.map((r) => {
        const s = summaries.get(r.id)!;
        const p = products.get(r.product_id);
        return {
          product: s.productTitle,
          variant: s.variantLabel,
          sellerSku: r.seller_sku,
          condition: r.condition,
          price: r.price_amount,
          compareAt: s.compareAt?.amount ?? null,
          available: stock.get(r.id)?.available ?? 0,
          reviewState: p?.reviewState ?? null,
          publication: p?.publication ?? null,
          status: r.status,
          updatedAt: r.updated_at.toISOString(),
          ...(dataset === ADMIN_DATASET ? { seller: r.owner_type === 'official' ? OFFICIAL_NAME : (names.get(r.seller_id ?? '') ?? ''), featuredEligible: e.get(r.id)?.eligible ?? false } : {}),
        };
      }),
      ...(all.length > offset + EXPORT_PAGE ? { nextCursor: String(offset + EXPORT_PAGE) } : {}),
    };
  }

  /* ================================================================ public lookups */

  async listOwnForProducts(sellerId: string, productIds: string[]): Promise<Record<string, Offer[]>> {
    const ids = [...new Set(productIds.filter(isUuid))];
    const rows = ids.length && isUuid(sellerId) ? await this.repo.allOffers({ ownerType: 'seller', sellerId, productIds: ids }, SCAN_LIMIT) : [];
    const offers = await this.core.toOffers(rows);
    const out: Record<string, Offer[]> = Object.fromEntries(productIds.map((id) => [id, [] as Offer[]]));
    for (const o of offers) out[o.productId]?.push(o);
    return out;
  }

  async listAdmin(filter: { sellerId?: string; official?: boolean; productId?: string; status?: string[]; featuredEligible?: boolean; ineligibilityCode?: string; q?: string }, page: common.PageInput): Promise<common.Page<Offer>> {
    const p = await this.repo.listOffers(
      {
        ...(filter.sellerId ? { sellerId: filter.sellerId } : {}),
        ...(filter.official !== undefined ? { ownerType: filter.official ? 'official' : 'seller' } : {}),
        ...(filter.productId ? { productId: filter.productId } : {}),
        ...(filter.status?.length ? { statuses: filter.status } : {}),
        ...(filter.featuredEligible !== undefined ? { featuredEligible: filter.featuredEligible } : {}),
        ...(filter.ineligibilityCode ? { ineligibilityCode: filter.ineligibilityCode } : {}),
        ...(filter.q ? { q: filter.q } : {}),
      },
      toPageRequest(page),
    );
    return { ...p, items: await this.core.toOffers(p.items) };
  }
}
