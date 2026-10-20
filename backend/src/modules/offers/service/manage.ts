/**
 * Creating and editing offers (seller and Official Store) and their lifecycle: publish, pause, resume,
 * end, delete drafts, and the staff actions remove, hold, release and reinstate.
 */
import { stringList } from '../../../kernel/lib/text.js';
import { isIsoDate } from '../../../kernel/lib/dates.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type { CompareAtInput, HoldOfferRequest, OfferInput, OfferUpdate, OfficialOfferInput, RemoveOfferRequest, ReturnTerms, ReturnTermsInput, StatusReason, WarrantyInput } from '../../../spec/offers.js';
import { activityLabel, conditionLabel, needsConditionNotes, returnTermsOf, warrantyTerms, type Condition } from '../domain/rules.js';
import { money, offerTitle, variantLabel } from '../mappers.js';
import type { OfferRec } from '../ports.js';
import { invalidField, notFound, Part, SYSTEM, type By } from './core.js';

/** Parcel used for profile checks and quotes: catalog variants carry no dimensions yet (spec gap) */
export const DEFAULT_PARCEL = { weightGrams: 1000 };


const DEFAULT_RETURN_DAYS = 30;

export interface Baseline {
  windowDays: number;
  freeReturnShipping: boolean;
  categoryException: string | null;
  policyVersion: string | null;
  summary: string;
}

/** Everything resolved about the product and the owner's terms for an offer form */
export interface Resolved {
  product: catalog.ProductAdmin;
  variant: catalog.Variant;
  categoryId: string | null;
  purchasable: boolean;
}

export class ManagePart extends Part {
  /* ================================================================ shared validation */

  /** Product and variant for an offer; the seller sees only products catalog shows them */
  async resolveProduct(productId: string, variantId: string, sellerId: string | null): Promise<Resolved> {
    let product: catalog.ProductAdmin | null = null;
    if (isUuid(productId)) {
      if (sellerId) {
        const r = await this.core.soft('catalog.getProductForSeller', () => this.ctx.use('catalog').getProductForSeller(sellerId, productId));
        product = r?.product ?? null;
      } else product = await this.core.productAdmin(productId);
    }
    if (!product) throw invalidField('productId', 'Choose a product from the catalog');
    const variant = product.product.variants.find((v) => v.id === variantId);
    if (!variant) throw this.core.error('VARIANT_NOT_IN_PRODUCT', 'This variant does not belong to the product', { productId, variantId });
    const purchasable = product.reviewState === 'approved' && product.publication === 'active';
    if (product.reviewState === 'rejected' || (product.reviewState === 'approved' && product.publication !== 'active')) {
      throw this.core.error('PRODUCT_NOT_PURCHASABLE', product.reviewState === 'rejected' ? 'This product was rejected in catalog review' : 'This product is hidden or suspended in the catalog', { productId, reviewState: product.reviewState, publication: product.publication });
    }
    return { product, variant, categoryId: product.product.categoryId ?? null, purchasable };
  }

  /** Category baseline from returns (30 days when returns is off) */
  async baseline(sellerId: string | null, categoryId: string | null, condition: string): Promise<Baseline> {
    const t = await this.core.optional('returns', 'resolveTerms', (r) => r.resolveTerms(sellerId, categoryId, condition));
    if (!t) return { windowDays: DEFAULT_RETURN_DAYS, freeReturnShipping: false, categoryException: null, policyVersion: null, summary: `${DEFAULT_RETURN_DAYS}-day returns` };
    return {
      windowDays: t.windowDays,
      freeReturnShipping: false,
      categoryException: t.source === 'category_exception' ? t.summary : null,
      policyVersion: t.policyVersion || null,
      summary: t.summary,
    };
  }

  baselineTerms(b: Baseline): ReturnTerms {
    return returnTermsOf({ kind: 'baseline', windowDays: b.windowDays, freeReturnShipping: b.freeReturnShipping, categoryException: b.categoryException, policyVersion: b.policyVersion });
  }

  returnTerms(input: ReturnTermsInput, b: Baseline): { kind: 'baseline' | 'extended'; windowDays: number; freeReturnShipping: boolean; policyVersion: string | null; categoryException: string | null } {
    const free = input.freeReturnShipping ?? b.freeReturnShipping;
    if (input.kind === 'extended') {
      if (input.windowDays === undefined || input.windowDays === null) throw invalidField('returnTerms.windowDays', 'Enter the return window for extended terms');
    }
    const days = input.windowDays ?? b.windowDays;
    if (!Number.isInteger(days) || days < 0 || days > 365) throw invalidField('returnTerms.windowDays', 'The return window is 0 to 365 days');
    if (days < b.windowDays || (!free && b.freeReturnShipping)) {
      throw this.core.error('RETURN_TERMS_BELOW_BASELINE', `Returns must allow at least ${b.windowDays} days for this category`, { baseline: this.baselineTerms(b) });
    }
    const kind = input.kind === 'extended' || days > b.windowDays || (free && !b.freeReturnShipping) ? 'extended' : 'baseline';
    return { kind, windowDays: days, freeReturnShipping: free, policyVersion: b.policyVersion, categoryException: b.categoryException };
  }

  warranty(input: WarrantyInput) {
    if (input.kind !== 'none' && input.months !== undefined && input.months !== null && (!Number.isInteger(input.months) || input.months < 1 || input.months > 240)) {
      throw invalidField('warranty.months', 'Warranty length is 1 to 240 months');
    }
    if (input.kind === 'seller' && !input.months) throw invalidField('warranty.months', 'Enter how many months your warranty lasts');
    return input;
  }

  conditionAndItems(condition: string, notes: string | null | undefined, missing: readonly string[] | null | undefined, product: catalog.ProductAdmin) {
    const n = notes?.trim() || null;
    if (needsConditionNotes(condition) && !n) {
      throw this.core.error('MISSING_ITEMS_REQUIRED', `${conditionLabel(condition)} offers need condition notes`, { issues: [{ path: 'conditionNotes', message: 'Describe the condition' }] });
    }
    const box = product.product.includedItems;
    const list = [...new Set((missing ?? []).map((m) => m.trim()).filter(Boolean))];
    const unknown = list.filter((m) => !box.some((b) => b.toLowerCase() === m.toLowerCase()));
    if (unknown.length) {
      throw this.core.error('MISSING_ITEMS_REQUIRED', `Missing items must be items from the product's box: ${box.join(', ') || 'none listed'}`, { issues: unknown.map((m) => ({ path: 'missingItems', message: `${m} is not in the product's box` })) });
    }
    const canonical = list.map((m) => box.find((b) => b.toLowerCase() === m.toLowerCase())!);
    const included = box.filter((b) => !canonical.includes(b));
    return { notes: n, missing: canonical, included };
  }

  async checkPrice(price: common.Money, categoryId: string | null, path = 'price') {
    if (price.currency !== this.core.currency) throw invalidField(`${path}.currency`, `Prices are in ${this.core.currency}`);
    if (!Number.isInteger(price.amount) || price.amount <= 0) throw invalidField(`${path}.amount`, 'Enter a price above zero');
    const mins = ((await this.core.setting('minimumPriceByCategory')) ?? {}) as Record<string, number>;
    const min = categoryId ? Number(mins[categoryId] ?? 0) : 0;
    if (min > 0 && price.amount < min) throw this.core.error('PRICE_BELOW_MINIMUM', `The minimum price in this category is ${formatMoney(this.core.money(min))}`, { minimum: this.core.money(min) });
  }

  async checkPurchaseLimit(limit: number | null | undefined) {
    if (limit === undefined || limit === null) return;
    if (!Number.isInteger(limit) || limit < 1) throw invalidField('purchaseLimit', 'The purchase limit is at least 1');
    const cap = await this.core.setting('maxPurchaseLimit');
    if (typeof cap === 'number' && limit > cap) throw invalidField('purchaseLimit', `The purchase limit can be at most ${cap}`);
  }

  checkDispatch(days: number) {
    if (!Number.isInteger(days) || days < 0 || days > 30) throw invalidField('dispatchBusinessDays', 'Dispatch time is 0 to 30 business days');
  }

  checkSaleEnd(at: string | null | undefined) {
    if (at && new Date(at).getTime() <= this.now().getTime()) throw invalidField('saleEndsAt', 'The sale end must be in the future');
  }

  /**
   * Official Store ships-from (decision O3): the inventory default location as 'City, Region' (its name when it has
   * no address), never empty: the market default location label when inventory has none.
   */
  async officialShipsFrom(): Promise<string> {
    const loc = await this.core.soft('inventory.getDefaultLocation', () => this.ctx.use('inventory').getDefaultLocation());
    const a = loc?.address;
    const label = a?.city ? [a.city, a.region].filter(Boolean).join(', ') : (loc?.name ?? '');
    return label.trim() || this.ctx.config.market.defaultLocation.label;
  }

  /** Ships-from and same-day cutoff for the owner (shipping, then the seller's storefront location) */
  async origin(sellerId: string | null): Promise<{ shipsFrom: string; sameDayCutoff: string | null }> {
    if (!sellerId) return { shipsFrom: await this.officialShipsFrom(), sameDayCutoff: null };
    const s = await this.core.optional('shipping', 'getSellerShippingSummaries', (sh) => sh.getSellerShippingSummaries([sellerId]));
    const summary = s?.[sellerId];
    if (summary?.shipsFrom) return { shipsFrom: summary.shipsFrom, sameDayCutoff: summary.sameDayCutoff ?? null };
    const card = (await this.core.soft('sellers.getStorefrontCard', () => this.ctx.use('sellers').getStorefrontCard([sellerId])))?.[0];
    return { shipsFrom: card?.location ?? '', sameDayCutoff: null };
  }

  /**
   * The profile must belong to the offer's owner (shipping.getProfileOwners: the seller's own profile, or an
   * Official Store profile for Official Store offers) and quote for the market. Shipping off: accepted as given.
   */
  async checkShippingProfile(profileId: string, dispatch: { businessDays: number; sameDayCutoff: string | null; shipsFrom: string }, owner: { ownerType: 'official' | 'seller'; sellerId: string | null }) {
    const shipping = this.ctx.tryUse('shipping');
    if (!shipping) return;
    const invalidProfile = (reason: string) => this.core.error('SHIPPING_PROFILE_INVALID', owner.ownerType === 'official' ? 'Choose an Official Store shipping profile' : 'Choose one of your shipping profiles', { shippingProfileId: profileId, reason });
    if (!isUuid(profileId)) throw invalidProfile('unknown_profile');
    const owners = await shipping.getProfileOwners([profileId]);
    const o = owners[profileId];
    if (!o) throw invalidProfile('unknown_profile');
    if (o.ownerType !== owner.ownerType || (owner.ownerType === 'seller' && o.sellerId !== owner.sellerId)) throw invalidProfile('not_your_profile');
    try {
      await shipping.quote(profileId, this.ctx.config.market.defaultLocation.postalCode, DEFAULT_PARCEL, dispatch);
    } catch (err) {
      if (isAppError(err) && err.code === 'NOT_IMPLEMENTED') return;
      if (isAppError(err) && err.status < 500) throw this.core.error('SHIPPING_PROFILE_INVALID', 'Choose one of your shipping profiles', { shippingProfileId: profileId, reason: err.message });
      throw err;
    }
  }

  /** compareAt on a new offer: only a list price on file can back it (no price history yet) */
  async compareAtForNew(c: CompareAtInput | null | undefined, price: common.Money, product: catalog.ProductAdmin, variantId: string) {
    if (!c) return null;
    return this.parts.pricing.verifyCompareAt(c, price, { product, variantId, history: [], saleStart: this.now() });
  }

  async checkSeller(sellerId: string, activity: 'new_offers' | 'new_listings' | 'sales' | 'offer_reactivation', o: { categoryId?: string | null; condition?: string; offerId?: string }) {
    const r = await this.ctx.use('sellers').canSell(sellerId, { activity, ...(o.categoryId ? { categoryId: o.categoryId } : {}), ...(o.condition ? { condition: o.condition } : {}), ...(o.offerId ? { offerId: o.offerId } : {}) });
    if (!r.allowed) {
      throw this.core.error('SELLER_RESTRICTED', r.reason ?? 'Your account cannot do this right now', { reason: r.reason ?? null, affectedActivity: activityLabel([activity]), appealRoute: r.appealRoute ?? null, restrictionId: r.restrictionId ?? null });
    }
  }

  /** The product's brand lets this seller (null: the Official Store) sell it: on create, publish and resume */
  async checkBrand(productId: string, sellerId: string | null) {
    const r = await this.parts.enforcement.brandVerdict({ product_id: productId, seller_id: sellerId });
    if (r && !r.allowed) throw this.core.error('BRAND_NOT_AUTHORIZED', r.reason ?? 'This brand cannot be sold by this seller', { brandId: r.brandId });
  }

  /** A second New offer for the variant, or a SKU in use (sku null: only the New check) */
  async duplicateCheck(o: { ownerType: 'official' | 'seller'; sellerId: string | null; variantId: string; condition: string; sku: string | null; exceptId?: string }) {
    if (o.condition === 'new') {
      const same = (await this.repo.find('offers', { owner_type: o.ownerType, seller_id: o.sellerId, variant_id: o.variantId, condition: 'new', status: { op: '<>', value: 'removed' } })).filter((r) => r.id !== o.exceptId);
      if (same[0]) throw this.core.error('DUPLICATE_OFFER', 'You already have a New offer for this variant', { offerId: same[0].id });
    }
    if (o.sku === null) return;
    const sku = (await this.repo.find('offers', { owner_type: o.ownerType, seller_id: o.sellerId, seller_sku: o.sku })).filter((r) => r.id !== o.exceptId);
    if (sku[0]) throw this.core.error('DUPLICATE_OFFER', `SKU ${o.sku} is already used by another offer`, { offerId: sku[0].id });
  }

  sku(raw: string | null | undefined, path = 'sellerSku') {
    const s = (raw ?? '').trim();
    if (!s || s.length > 64) throw invalidField(path, 'Enter a SKU of up to 64 characters');
    return s;
  }

  /* ================================================================ create */

  async createSellerOffer(sellerId: string, input: OfferInput, by: By): Promise<OfferRec> {
    const sku = this.sku(input.sellerSku);
    if (!Number.isInteger(input.quantity) || input.quantity < 0) throw invalidField('quantity', 'Quantity is a whole number, 0 or more');
    if (input.lowStockThreshold !== undefined && input.lowStockThreshold !== null && (!Number.isInteger(input.lowStockThreshold) || input.lowStockThreshold < 0)) throw invalidField('lowStockThreshold', 'The low-stock alert is 0 or more');
    this.checkDispatch(input.dispatchBusinessDays);
    await this.checkPurchaseLimit(input.purchaseLimit);
    this.checkSaleEnd(input.saleEndsAt);
    const res = await this.resolveProduct(input.productId, input.variantId, sellerId);
    await this.checkSeller(sellerId, 'new_offers', { categoryId: res.categoryId, condition: input.condition });
    await this.checkBrand(input.productId, sellerId);
    await this.duplicateCheck({ ownerType: 'seller', sellerId, variantId: input.variantId, condition: input.condition, sku });
    const items = this.conditionAndItems(input.condition, input.conditionNotes, input.missingItems, res.product);
    const b = await this.baseline(sellerId, res.categoryId, input.condition);
    const returns = this.returnTerms(input.returnTerms, b);
    const warranty = this.warranty(input.warranty);
    await this.checkPrice(input.price, res.categoryId);
    const compareAt = await this.compareAtForNew(input.compareAt, input.price, res.product, input.variantId);
    const origin = await this.origin(sellerId);
    await this.checkShippingProfile(input.shippingProfileId, { businessDays: input.dispatchBusinessDays, ...origin }, { ownerType: 'seller', sellerId });

    const id = newId();
    const stock = await this.stockItem(() =>
      this.ctx.use('inventory').createStockItem({
        ownerType: 'seller',
        sellerId,
        offerId: id,
        sku,
        productId: input.productId,
        variantId: input.variantId,
        condition: input.condition,
        label: `${res.product.product.title}, ${variantLabel(res.variant.options)}`,
        initialAvailable: input.quantity,
        ...(input.lowStockThreshold !== undefined && input.lowStockThreshold !== null ? { lowStockThreshold: input.lowStockThreshold } : {}),
      }),
    );
    const row = await this.insertOffer({
      id,
      ownerType: 'seller',
      sellerId,
      input: { ...input, compareAt: compareAt ? { amount: input.compareAt!.amount, basis: input.compareAt!.basis } : null },
      sku,
      title: offerTitle(res.product.product.title, res.variant.options),
      stockItemId: stock.id,
      items,
      returns,
      warranty: warrantyTerms(warranty, 'seller'),
      origin,
      publishOnApproval: input.publishOnApproval ?? Boolean(input.publish),
      by,
    });
    await this.afterCreate(row, by);
    if (input.publish) return this.publishSeller(row, by, { auto: true });
    return row;
  }

  async createOfficialOffer(input: OfficialOfferInput, by: By): Promise<OfferRec> {
    const sku = this.sku(input.sku, 'sku');
    this.checkDispatch(input.dispatchBusinessDays);
    await this.checkPurchaseLimit(input.purchaseLimit);
    const res = await this.resolveProduct(input.productId, input.variantId, null);
    await this.checkBrand(input.productId, null);
    await this.duplicateCheck({ ownerType: 'official', sellerId: null, variantId: input.variantId, condition: input.condition, sku });
    const items = this.conditionAndItems(input.condition, input.conditionNotes, input.missingItems, res.product);
    const b = await this.baseline(null, res.categoryId, input.condition);
    const returns = this.returnTerms(input.returnTerms, b);
    const warranty = this.warranty(input.warranty);
    await this.checkPrice(input.price, res.categoryId);
    const compareAt = await this.compareAtForNew(input.compareAt, input.price, res.product, input.variantId);
    const origin = await this.origin(null);
    await this.checkShippingProfile(input.shippingProfileId, { businessDays: input.dispatchBusinessDays, ...origin }, { ownerType: 'official', sellerId: null });

    const id = newId();
    let stockItemId: string;
    if (input.stockItemId) {
      const known = await this.ctx.use('inventory').getAvailability([input.stockItemId]);
      if (!known[input.stockItemId]) throw invalidField('stockItemId', 'Unknown company stock item');
      const taken = await this.repo.findOne('offers', { stock_item_id: input.stockItemId, status: { op: '<>', value: 'removed' } });
      if (taken) throw this.core.error('DUPLICATE_OFFER', 'Another offer already sells this stock item', { offerId: taken.id });
      stockItemId = input.stockItemId;
    } else {
      const item = await this.stockItem(() =>
        this.ctx.use('inventory').createStockItem({
          ownerType: 'official',
          offerId: id,
          sku,
          productId: input.productId,
          variantId: input.variantId,
          condition: input.condition,
          label: `${res.product.product.title}, ${variantLabel(res.variant.options)}${input.condition === 'new' ? '' : ` (${conditionLabel(input.condition)})`}`,
          initialAvailable: 0,
        }),
      );
      stockItemId = item.id;
    }
    const row = await this.insertOffer({
      id,
      ownerType: 'official',
      sellerId: null,
      input: { ...input, saleEndsAt: null, compareAt: compareAt ? { amount: input.compareAt!.amount, basis: input.compareAt!.basis } : null },
      sku,
      title: offerTitle(res.product.product.title, res.variant.options),
      stockItemId,
      items,
      returns,
      warranty: warrantyTerms(warranty, 'official'),
      origin,
      publishOnApproval: false,
      by,
    });
    await this.afterCreate(row, by);
    await this.core.audit(
      {
        action: 'offers.official.create',
        actionLabel: 'Created an Official Store offer',
        category: 'catalog',
        target: this.target(row, res.product.product.title),
        after: { sku, price: input.price, condition: input.condition, stockItemId },
      },
      by,
    );
    if (input.publish) {
      if (!res.purchasable) throw this.core.error('PRODUCT_NOT_PURCHASABLE', 'The product is not approved and active yet; the offer was saved as a draft', { offerId: row.id });
      return this.publishOfficial(row.id, by, { audit: false });
    }
    return row;
  }

  /** Inventory's SKU_TAKEN is a duplicate SKU here */
  async stockItem<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isAppError(err) && err.code === 'SKU_TAKEN') throw this.core.error('DUPLICATE_OFFER', err.message, { reason: 'sku_in_use' });
      throw err;
    }
  }

  private async insertOffer(o: {
    id: string;
    ownerType: 'official' | 'seller';
    sellerId: string | null;
    input: Pick<OfferInput, 'productId' | 'variantId' | 'condition' | 'price' | 'purchaseLimit' | 'dispatchBusinessDays' | 'shippingProfileId' | 'saleEndsAt'> & { compareAt?: CompareAtInput | null };
    sku: string;
    title: string;
    stockItemId: string;
    items: { notes: string | null; missing: string[]; included: string[] };
    returns: { kind: string; windowDays: number; freeReturnShipping: boolean; policyVersion: string | null; categoryException: string | null };
    warranty: { kind: string; months?: number | null; handledBy?: string | null };
    origin: { shipsFrom: string; sameDayCutoff: string | null };
    publishOnApproval: boolean;
    by: By;
  }): Promise<OfferRec> {
    const now = this.now();
    const i = o.input;
    // a unique index (SKU, live New offer per variant, live offer per stock item) lost a race: DUPLICATE_OFFER
    return this.core.unique(() =>
      this.repo.transaction(async (tx) => {
        const row = await tx.insert('offers', {
          id: o.id,
          owner_type: o.ownerType,
          seller_id: o.sellerId,
          product_id: i.productId,
          variant_id: i.variantId,
          title: o.title,
          condition: i.condition,
          condition_notes: o.items.notes,
          included_items: o.items.included as never,
          missing_items: o.items.missing as never,
          missing_items_stale: false,
          seller_sku: o.sku,
          stock_item_id: o.stockItemId,
          price_amount: i.price.amount,
          currency: this.core.currency,
          compare_at_amount: i.compareAt ? i.compareAt.amount.amount : null,
          compare_at_basis: i.compareAt ? i.compareAt.basis : null,
          compare_at_verified: Boolean(i.compareAt),
          sale_ends_at: i.saleEndsAt ? new Date(i.saleEndsAt) : null,
          purchase_limit: i.purchaseLimit ?? null,
          dispatch_business_days: i.dispatchBusinessDays,
          same_day_cutoff: o.origin.sameDayCutoff,
          ships_from: o.origin.shipsFrom,
          shipping_profile_id: i.shippingProfileId,
          // a new offer ships from its owner; fulfillment-service.offer.service_changed moves it to marketly_service
          fulfilled_by: o.ownerType === 'official' ? 'official_warehouse' : 'seller',
          return_kind: o.returns.kind,
          return_window_days: o.returns.windowDays,
          free_return_shipping: o.returns.freeReturnShipping,
          return_policy_version: o.returns.policyVersion,
          return_category_exception: o.returns.categoryException,
          warranty_kind: o.warranty.kind,
          warranty_months: o.warranty.months ?? null,
          warranty_handled_by: o.warranty.handledBy ?? null,
          status: 'draft',
          status_before_ineligible: null,
          ineligible_source: null,
          status_reason: null,
          publish_on_approval: o.publishOnApproval,
          content_gaps: [],
          terms_version: 1,
          published_at: null,
          removed_at: null,
          created_at: now,
          updated_at: now,
        });
        await tx.insert('offer_price_history', {
          id: newId(),
          offer_id: o.id,
          price_amount: i.price.amount,
          compare_at_amount: row.compare_at_amount,
          valid_from: now,
          valid_to: null,
          price_change_id: null,
          actor_kind: o.by.actor.kind,
          actor_id: o.by.actor.id ?? null,
        });
        await tx.insert('offer_status_log', {
          id: newId(),
          offer_id: o.id,
          from_status: null,
          to_status: 'draft',
          event: 'create',
          reason_code: null,
          reason: null,
          affected_activity: null,
          appeal_route: null,
          review_date: null,
          actor_kind: o.by.actor.kind,
          actor_id: o.by.actor.id ?? null,
          at: now,
        });
        return row;
      }),
    );
  }

  private async afterCreate(row: OfferRec, by: By) {
    this.core.publish(
      'offers.offer.created',
      { offerId: row.id, productId: row.product_id, variantId: row.variant_id, ownerType: row.owner_type, sellerId: row.seller_id, condition: row.condition, stockItemId: row.stock_item_id, price: money(row.price_amount, row.currency) },
      by,
    );
    const rule = await this.parts.featured.currentRule();
    const standing = row.seller_id ? await this.core.sellerStanding([row.seller_id], rule.parameters.minOnTimeDispatchPct) : undefined;
    await this.core.refreshEligibility([row], standing);
    await this.parts.views.refreshContentGaps(row.product_id);
  }

  target(r: OfferRec, label?: string | null): { type: string; id: string; ref: string; label: string | null; sellerId: string | null; screen: string } {
    return { type: 'offer', id: r.id, ref: r.seller_sku, label: label ?? r.seller_sku, sellerId: r.seller_id, screen: r.owner_type === 'official' ? 'admin/official' : 'admin/catalog' };
  }

  /* ================================================================ publish */

  /** Seller publish: product must be purchasable; before the launch review passes the offer waits in draft */
  async publishSeller(row: OfferRec, by: By, o: { auto?: boolean } = {}): Promise<OfferRec> {
    if (row.status !== 'draft') return (await this.core.transition(row.id, { event: 'publish', by })).after; // ILLEGAL_TRANSITION
    const product = await this.core.productAdmin(row.product_id);
    const purchasable = Boolean(product && product.reviewState === 'approved' && product.publication === 'active');
    if (!purchasable) {
      if (o.auto) return this.markWaiting(row, { publishOnApproval: true });
      throw this.core.error('PRODUCT_NOT_PURCHASABLE', 'The product is not approved and active yet. Keep the offer as a draft that publishes on approval.', { productId: row.product_id });
    }
    const sellerId = row.seller_id!;
    const ctx = { categoryId: product!.product.categoryId ?? null, condition: row.condition, offerId: row.id };
    await this.checkSeller(sellerId, 'new_offers', ctx);
    await this.checkSeller(sellerId, 'new_listings', ctx);
    const snap = (await this.core.sellerSnapshots([sellerId])).get(sellerId);
    if (!snap?.launchReady) {
      return this.markWaiting(row, { publishOnApproval: true, reason: this.core.statusReason('awaiting_launch_review', 'Publishes automatically when your launch review passes', by) });
    }
    await this.checkSeller(sellerId, 'sales', ctx);
    return this.publishNow(row, by);
  }

  /** Draft kept for automatic publishing */
  private async markWaiting(row: OfferRec, o: { publishOnApproval: boolean; reason?: StatusReason }): Promise<OfferRec> {
    return this.repo.update('offers', row.id, { publish_on_approval: o.publishOnApproval, ...(o.reason ? { status_reason: o.reason as never } : {}), updated_at: this.now() });
  }

  async publishNow(row: OfferRec, by: By): Promise<OfferRec> {
    await this.checkBrand(row.product_id, row.seller_id ?? null);
    const available = (await this.core.available([row.stock_item_id])).get(row.stock_item_id) ?? 0;
    const t = await this.core.move(row.id, {
      event: 'publish',
      by,
      available,
      reason: null,
      patch: { publish_on_approval: false },
      guard: (r) => {
        if (r.status !== 'draft') throw new AppError('ILLEGAL_TRANSITION', 'Only draft offers can be published', { from: r.status, event: 'publish' });
      },
    });
    return t.after;
  }

  async publishOfficial(id: string, by: By, o: { audit?: boolean } = {}): Promise<OfferRec> {
    const row = await this.core.officialRow(id);
    if (row.status !== 'draft') return (await this.core.transition(row.id, { event: 'publish', by })).after;
    if (!(await this.ctx.use('catalog').isPurchasable(row.product_id))) throw this.core.error('PRODUCT_NOT_PURCHASABLE', 'The product is not approved and active yet', { productId: row.product_id });
    const after = await this.publishNow(row, by);
    if (o.audit !== false) await this.core.audit({ action: 'offers.official.publish', actionLabel: 'Published an Official Store offer', category: 'catalog', target: this.target(after), before: { status: row.status }, after: { status: after.status } }, by);
    return after;
  }

  /** Drafts waiting with publish_on_approval go live when nothing stops them any more (system) */
  async publishWaiting(rows: readonly OfferRec[], why: string): Promise<number> {
    let n = 0;
    for (const row of rows) {
      if (row.status !== 'draft' || !row.publish_on_approval) continue;
      try {
        const by: By = { actor: SYSTEM };
        const after = row.owner_type === 'official' ? await this.publishOfficial(row.id, by) : await this.publishSeller(row, by, { auto: true });
        if (after.status !== 'draft') n++;
      } catch (err) {
        if (!isAppError(err) || err.status >= 500) throw err;
        this.ctx.log.info({ offerId: row.id, code: err.code, why }, 'offers: waiting draft not published');
      }
    }
    return n;
  }

  /* ================================================================ pause, resume, end, delete */

  async pause(row: OfferRec, reasonText: string | null, by: By): Promise<OfferRec> {
    const t = await this.core.move(row.id, { event: 'pause', by, log: { reason: reasonText }, reason: null });
    return t.after;
  }

  async resumeSeller(row: OfferRec, by: By): Promise<OfferRec> {
    if (row.status !== 'paused') return (await this.core.transition(row.id, { event: 'resume', by })).after; // ILLEGAL_TRANSITION
    const product = await this.core.productAdmin(row.product_id);
    await this.checkSeller(row.seller_id!, 'offer_reactivation', { categoryId: product?.product.categoryId ?? null, condition: row.condition, offerId: row.id });
    return this.resume(row, by);
  }

  async resume(row: OfferRec, by: By): Promise<OfferRec> {
    await this.checkBrand(row.product_id, row.seller_id ?? null);
    const available = (await this.core.available([row.stock_item_id])).get(row.stock_item_id) ?? 0;
    return (await this.core.move(row.id, { event: 'resume', by, available, reason: null })).after;
  }

  async end(row: OfferRec, reasonText: string | null, by: By): Promise<OfferRec> {
    const reason = this.core.statusReason('ended_by_seller', reasonText ?? 'Ended by the seller', by);
    return (await this.core.move(row.id, { event: 'remove', by, reason, log: { reasonCode: 'ended_by_seller', reason: reasonText } })).after;
  }

  async deleteDraft(sellerId: string, id: string, by: By): Promise<void> {
    const row = await this.core.ownRow(sellerId, id);
    if (row.status !== 'draft' || row.published_at) throw new AppError('ILLEGAL_TRANSITION', 'Only drafts that were never published can be deleted; end the offer instead', { from: row.status, event: 'delete' });
    await this.repo.transaction(async (tx) => {
      const locked = await this.core.ownRow(sellerId, id, tx, true);
      if (locked.status !== 'draft' || locked.published_at) throw new AppError('ILLEGAL_TRANSITION', 'Only drafts that were never published can be deleted', { from: locked.status, event: 'delete' });
      await tx.deleteWhere('offer_price_history', { offer_id: id });
      await tx.deleteWhere('price_changes', { offer_id: id });
      await tx.deleteWhere('offer_status_log', { offer_id: id });
      await tx.deleteWhere('offer_eligibility', { offer_id: id });
      await tx.deleteWhere('offers', { id });
    });
    // inventory archives the offer's stock item on removal
    this.core.publish(
      'offers.offer.status_changed',
      { offerId: row.id, productId: row.product_id, variantId: row.variant_id, sellerId: row.seller_id, ownerType: row.owner_type, from: 'draft', to: 'removed', reasonCode: 'ended_by_seller', reason: 'Draft deleted', stockItemId: row.stock_item_id, trustEnforcementId: null },
      by,
    );
  }

  /** Each item succeeds or fails on its own */
  async bulkPause(sellerId: string, offerIds: readonly string[], reasonText: string | null, by: By) {
    const ids = [...new Set(offerIds)];
    if (!ids.length) throw invalidField('offerIds', 'Choose at least one offer');
    if (ids.length > 100) throw invalidField('offerIds', 'Hide up to 100 offers at a time');
    const results: { offerId: string; ok: boolean; status?: string; error?: { code: string; message: string } }[] = [];
    for (const id of ids) {
      try {
        const row = await this.core.ownRow(sellerId, id);
        const after = await this.pause(row, reasonText, by);
        results.push({ offerId: id, ok: true, status: after.status });
      } catch (err) {
        if (!isAppError(err) || err.status >= 500) throw err;
        results.push({ offerId: id, ok: false, error: { code: err.code, message: err.message } });
      }
    }
    return { results };
  }

  /* ================================================================ edit */

  async update(row: OfferRec, body: OfferUpdate, by: By, o: { official: boolean }): Promise<OfferRec> {
    if (row.status === 'removed') throw new AppError('ILLEGAL_TRANSITION', 'Removed offers cannot be edited', { from: 'removed', event: 'update' });
    const draft = row.status === 'draft' && !row.published_at;
    if ((body.variantId && body.variantId !== row.variant_id) || (body.condition && body.condition !== row.condition)) {
      if (!draft) throw new AppError('ILLEGAL_TRANSITION', 'Variant and condition can only change on a draft; end the offer and create a new one', { from: row.status, event: 'update' });
    }
    if (o.official && body.price) throw invalidField('price', 'Change Official Store prices through a price change');
    if (o.official && body.sellerSku && body.sellerSku.trim() !== row.seller_sku) throw invalidField('sellerSku', 'The company SKU is fixed by the stock item');

    const variantId = body.variantId ?? row.variant_id;
    const condition = (body.condition ?? row.condition) as Condition;
    const res = await this.resolveProduct(row.product_id, variantId, row.seller_id).catch((err) => {
      // an offer on a product that has since been hidden can still have its terms edited
      if (isAppError(err) && err.code === 'PRODUCT_NOT_PURCHASABLE') return null;
      throw err;
    });
    const product = res?.product ?? (await this.core.productAdmin(row.product_id));
    if (!product) throw notFound('Product');
    const categoryId = product.product.categoryId ?? null;
    const patch: Partial<OfferRec> = {};
    const fields: string[] = [];
    const set = <K extends keyof OfferRec>(k: K, v: OfferRec[K], field: string) => {
      if (JSON.stringify(row[k]) === JSON.stringify(v)) return;
      patch[k] = v;
      if (!fields.includes(field)) fields.push(field);
    };

    // a price change above largeSellerPriceChangePct needs confirmLargeChange in the same body; nothing is saved without it
    if (body.price && !o.official && !body.confirmLargeChange) await this.parts.pricing.assertLargeChangeConfirmed(row, body.price);

    if (body.variantId !== undefined && body.variantId !== null) {
      set('variant_id', variantId, 'variantId');
      const v = product.product.variants.find((x) => x.id === variantId);
      if (variantId !== row.variant_id && v) patch.title = offerTitle(product.product.title, v.options);
    }
    if (body.condition) set('condition', condition, 'condition');
    if (body.conditionNotes !== undefined || body.missingItems !== undefined || body.condition) {
      const items = this.conditionAndItems(condition, body.conditionNotes !== undefined ? body.conditionNotes : row.condition_notes, body.missingItems !== undefined ? body.missingItems : (row.missing_items as string[]), product);
      set('condition_notes', items.notes, 'conditionNotes');
      set('missing_items', items.missing as never, 'missingItems');
      set('included_items', items.included as never, 'missingItems');
    }
    // the seller saved missingItems again: the box review is done
    if (body.missingItems !== undefined && row.missing_items_stale) patch.missing_items_stale = false;
    if (body.purchaseLimit !== undefined) {
      await this.checkPurchaseLimit(body.purchaseLimit);
      set('purchase_limit', body.purchaseLimit ?? null, 'purchaseLimit');
    }
    if (body.sellerSku !== undefined && body.sellerSku !== null && !o.official) {
      const sku = this.sku(body.sellerSku);
      if (sku !== row.seller_sku) {
        await this.duplicateCheck({ ownerType: row.owner_type, sellerId: row.seller_id, variantId, condition: '', sku, exceptId: row.id });
        patch.seller_sku = sku; // not customer-visible
      }
    }
    if (body.condition === 'new' || (body.variantId && condition === 'new')) await this.duplicateCheck({ ownerType: row.owner_type, sellerId: row.seller_id, variantId, condition: 'new', sku: null, exceptId: row.id });
    if (body.dispatchBusinessDays !== undefined && body.dispatchBusinessDays !== null) {
      this.checkDispatch(body.dispatchBusinessDays);
      set('dispatch_business_days', body.dispatchBusinessDays, 'dispatch');
    }
    if (body.shippingProfileId) {
      if (body.shippingProfileId !== row.shipping_profile_id) {
        await this.checkShippingProfile(body.shippingProfileId, { businessDays: patch.dispatch_business_days ?? row.dispatch_business_days, sameDayCutoff: row.same_day_cutoff?.slice(0, 5) ?? null, shipsFrom: row.ships_from }, { ownerType: row.owner_type, sellerId: row.seller_id });
      }
      set('shipping_profile_id', body.shippingProfileId, 'shippingProfileId');
    }
    if (body.returnTerms) {
      const b = await this.baseline(row.seller_id, categoryId, condition);
      const r = this.returnTerms(body.returnTerms, b);
      set('return_kind', r.kind, 'returnTerms');
      set('return_window_days', r.windowDays, 'returnTerms');
      set('free_return_shipping', r.freeReturnShipping, 'returnTerms');
      set('return_policy_version', r.policyVersion, 'returnTerms');
      set('return_category_exception', r.categoryException, 'returnTerms');
    }
    if (body.warranty) {
      const w = warrantyTerms(this.warranty(body.warranty), row.owner_type);
      set('warranty_kind', w.kind, 'warranty');
      set('warranty_months', w.months ?? null, 'warranty');
      set('warranty_handled_by', w.handledBy ?? null, 'warranty');
    }
    if (body.publishOnApproval !== undefined && body.publishOnApproval !== null) patch.publish_on_approval = body.publishOnApproval;
    if (body.saleEndsAt !== undefined && !body.price) {
      this.checkSaleEnd(body.saleEndsAt);
      set('sale_ends_at', body.saleEndsAt ? new Date(body.saleEndsAt) : null, 'saleEndsAt');
    }
    // compareAt without a price change: checked against the history before now
    if (body.compareAt !== undefined && !body.price) {
      if (body.compareAt === null) {
        set('compare_at_amount', null, 'compareAt');
        set('compare_at_basis', null, 'compareAt');
        set('compare_at_verified', false, 'compareAt');
      } else {
        const history = await this.parts.pricing.history(row.id);
        await this.parts.pricing.verifyCompareAt(body.compareAt, this.core.money(row.price_amount), { product, variantId, history, saleStart: this.parts.pricing.saleStartOf(row, history) });
        set('compare_at_amount', body.compareAt.amount.amount, 'compareAt');
        set('compare_at_basis', body.compareAt.basis, 'compareAt');
        set('compare_at_verified', true, 'compareAt');
      }
    }

    // while Marketly fulfils the offer, the seller's dispatch and shipping profile are saved but customers see Marketly's
    if (row.fulfilled_by === 'marketly_service') fields.splice(0, fields.length, ...fields.filter((f) => f !== 'dispatch' && f !== 'shippingProfileId'));
    let after = row;
    if (Object.keys(patch).length) {
      const visible = fields.length > 0 && Boolean(row.published_at);
      after = await this.core.unique(() =>
        this.repo.transaction(async (tx) => {
          const locked = await this.core.offerRow(row.id, { repo: tx, forUpdate: true });
          if (locked.status === 'removed') throw new AppError('ILLEGAL_TRANSITION', 'Removed offers cannot be edited', { from: 'removed', event: 'update' });
          return tx.update('offers', row.id, { ...patch, ...(visible ? { terms_version: locked.terms_version + 1 } : {}), updated_at: this.now() });
        }),
      );
      if (visible) this.core.publish('offers.offer.updated', { offerId: after.id, productId: after.product_id, termsVersion: after.terms_version, fields }, by);
      // the box review is done (changed list or the same one confirmed): notifications resolves the review notice
      if (patch.missing_items_stale === false) {
        this.core.publish(
          'offers.offer.missing_items_reviewed',
          { offerId: after.id, productId: after.product_id, ownerType: after.owner_type as 'official' | 'seller', sellerId: after.seller_id, missingItems: stringList(after.missing_items), changed: JSON.stringify(stringList(after.missing_items)) !== JSON.stringify(stringList(row.missing_items)), reviewedBy: by.actor },
          by,
        );
      }
      if (fields.some((f) => ['dispatch', 'shippingProfileId', 'compareAt', 'condition', 'variantId'].includes(f))) await this.core.markDirty([row.variant_id, after.variant_id]);
      // the stock item follows a draft's new variant or condition (no stock left on the old variant)
      if (after.variant_id !== row.variant_id || after.condition !== row.condition) {
        await this.ctx.use('inventory').updateStockItem(after.stock_item_id, { productId: after.product_id, variantId: after.variant_id, condition: after.condition }, by.actor);
      }
    }
    if (body.price && !o.official) {
      after = (await this.parts.pricing.changeSellerPrice(after, { price: body.price, compareAt: body.compareAt, saleEndsAt: body.saleEndsAt }, by, { confirmLarge: Boolean(body.confirmLargeChange), source: 'seller', product })).offer;
    }
    return after;
  }

  /* ================================================================ staff actions */

  async remove(id: string, body: RemoveOfferRequest, by: By): Promise<OfferRec> {
    const row = await this.core.offerRow(id);
    if (!body.reason?.trim()) throw invalidField('reason', 'Give the reason the seller will see');
    let appealRoute = body.appealRoute ?? null;
    if (!appealRoute && row.seller_id) appealRoute = 'Appeal from Seller Center > Account health within 14 days';
    const reason = this.core.statusReason('removed_by_staff', body.reason.trim(), by, { appealRoute });
    const t = await this.core.move(row.id, { event: 'remove', by, reason, log: { reasonCode: body.reasonCode, reason: body.reason.trim(), appealRoute } });
    await this.core.audit(
      {
        action: 'offers.offer.remove',
        actionLabel: 'Removed an offer',
        category: 'catalog',
        target: this.target(t.after),
        reason: body.reason,
        before: { status: t.before.status },
        after: { status: t.after.status, reasonCode: body.reasonCode, notifySeller: body.notifySeller ?? true },
        visibleToSeller: Boolean(row.seller_id),
      },
      by,
    );
    return t.after;
  }

  async hold(id: string, body: HoldOfferRequest, by: By): Promise<OfferRec> {
    if (!body.reason?.trim()) throw invalidField('reason', 'Give the reason for the hold');
    if (!isIsoDate(body.reviewDate) || body.reviewDate < this.core.today()) throw invalidField('reviewDate', 'The review date is today or later');
    const text = body.reference ? `${body.reason.trim()} (${body.reference})` : body.reason.trim();
    const reason = this.core.statusReason('staff_hold', text, by, { reviewDate: body.reviewDate, appealRoute: null });
    const t = await this.core.move(id, { event: 'makeIneligible', by, reason, source: { kind: 'staff', id: by.actor.id ?? null }, log: { reasonCode: 'staff_hold', reason: text, reviewDate: body.reviewDate } });
    await this.core.audit(
      { action: 'offers.offer.hold', actionLabel: 'Held an offer for review', category: 'catalog', target: this.target(t.after), reason: body.reason, before: { status: t.before.status }, after: { status: t.after.status, reviewDate: body.reviewDate, reference: body.reference ?? null }, visibleToSeller: Boolean(t.after.seller_id) },
      by,
    );
    return t.after;
  }

  async releaseHold(id: string, reasonText: string, by: By): Promise<OfferRec> {
    if (!reasonText?.trim()) throw invalidField('reason', 'Give the reason for releasing the hold');
    const row = await this.core.offerRow(id);
    const src = (row.ineligible_source ?? {}) as { kind?: string };
    if (row.status !== 'ineligible' || (src.kind !== 'staff' && src.kind !== 'enforcement')) throw new AppError('ILLEGAL_TRANSITION', 'This offer is not on a staff hold', { from: row.status, event: 'releaseHold' });
    const after = await this.parts.enforcement.restoreOrSwitch(row, { by, log: { reasonCode: 'hold_released', reason: reasonText.trim() }, force: false });
    await this.core.audit({ action: 'offers.offer.release_hold', actionLabel: 'Released a hold on an offer', category: 'catalog', target: this.target(after), reason: reasonText, before: { status: row.status }, after: { status: after.status }, visibleToSeller: Boolean(row.seller_id) }, by);
    return after;
  }

  /** A removed offer can come back only while nobody took its stock item or New-variant slot (DUPLICATE_OFFER) */
  async assertReinstatable(r: OfferRec) {
    if (r.status !== 'removed') return; // the transition refuses it
    const taken = (await this.repo.find('offers', { stock_item_id: r.stock_item_id, status: { op: '<>', value: 'removed' } })).find((x) => x.id !== r.id);
    if (taken) throw this.core.error('DUPLICATE_OFFER', 'Another live offer now sells this stock item', { offerId: taken.id, reason: 'stock_item_in_use' });
    if (r.condition === 'new') await this.duplicateCheck({ ownerType: r.owner_type, sellerId: r.seller_id, variantId: r.variant_id, condition: 'new', sku: null, exceptId: r.id });
  }

  async reinstate(id: string, reasonText: string, by: By, o: { trustEnforcementId?: string | null } = {}): Promise<OfferRec> {
    if (!reasonText?.trim()) throw invalidField('reason', 'Give the reason for reinstating the offer');
    await this.assertReinstatable(await this.core.offerRow(id));
    // inventory unarchives the stock item on offers.offer.status_changed with from = removed
    const t = await this.core.move(id, { event: 'reinstate', by, reason: null, log: { reasonCode: 'reinstated', reason: reasonText.trim(), trustEnforcementId: o.trustEnforcementId ?? null } });
    await this.core.audit({ action: 'offers.offer.reinstate', actionLabel: 'Reinstated an offer', category: 'catalog', target: this.target(t.after), reason: reasonText, before: { status: t.before.status }, after: { status: t.after.status }, visibleToSeller: Boolean(t.after.seller_id) }, by);
    return t.after;
  }

  /** Official pause / resume with audit */
  async officialStatus(id: string, event: 'pause' | 'resume', reasonText: string | null, by: By): Promise<OfferRec> {
    const row = await this.core.officialRow(id);
    if (event === 'pause' && !reasonText?.trim()) throw invalidField('reason', 'Give the reason for hiding the offer');
    const after = event === 'pause' ? await this.pause(row, reasonText, by) : row.status === 'paused' ? await this.resume(row, by) : (await this.core.transition(row.id, { event: 'resume', by })).after;
    await this.core.audit(
      { action: `offers.official.${event}`, actionLabel: event === 'pause' ? 'Hid an Official Store offer' : 'Showed an Official Store offer again', category: 'catalog', target: this.target(after), reason: reasonText, before: { status: row.status }, after: { status: after.status } },
      by,
    );
    return after;
  }

  /** Official edit with audit */
  async updateOfficial(id: string, body: OfferUpdate, by: By): Promise<OfferRec> {
    const row = await this.core.officialRow(id);
    const after = await this.update(row, body, by, { official: true });
    await this.core.audit({ action: 'offers.official.update', actionLabel: 'Edited Official Store offer terms', category: 'catalog', target: this.target(after), before: termsOf(row), after: termsOf(after) }, by);
    return after;
  }

}

const termsOf = (r: OfferRec) => ({
  conditionNotes: r.condition_notes,
  missingItems: r.missing_items,
  purchaseLimit: r.purchase_limit,
  dispatchBusinessDays: r.dispatch_business_days,
  shippingProfileId: r.shipping_profile_id,
  returns: { kind: r.return_kind, windowDays: r.return_window_days, free: r.free_return_shipping },
  warranty: { kind: r.warranty_kind, months: r.warranty_months },
  termsVersion: r.terms_version,
});

