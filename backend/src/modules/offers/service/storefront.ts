/**
 * What customers see: quotes (price, delivery, availability, comparable total) per delivery location,
 * the all-offers comparison, the purchase box, featured offers, cart revalidation (scenario 2: report,
 * never substitute) and the frozen snapshot for order items.
 */
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type {
  Availability,
  DeliverTo,
  DeliveryEstimate,
  Offer,
  OfferChange,
  OfferComparison,
  OfferSnapshot,
  OfferSummary,
  OfferView,
  PromotionCue,
  PurchaseBox,
  SellerCue,
  VariantAvailability,
} from '../../../spec/offers.js';
import { CONDITION_LABEL, conditionGroup, discountPct, dispatchLabel, formatMoney, TAX_NOTE, type ConditionGroup } from '../domain/rules.js';
import { compareAtOf, dispatchOf, isoReq, money, OFFICIAL_NAME, returnTermsOf, strings, variantLabel, warrantyOf } from '../mappers.js';
import type { EligibilityRec, OfferRec } from '../ports.js';
import { notFound, Part } from './core.js';
import { DEFAULT_PARCEL, MARKET_DEFAULT_POSTAL } from './manage.js';

/** Location-dependent numbers for one offer */
export interface Facts {
  row: OfferRec;
  /** Price the customer pays now per unit (campaign price when one applies) */
  unitPrice: common.Money;
  regularPrice: common.Money | null;
  promotion: PromotionCue | null;
  delivery: DeliveryEstimate;
  total: common.Money;
  availability: Availability & { expectedRestockDate: string | null };
}

const LISTED = ['active', 'out_of_stock', 'ineligible'];
const MAX_COMPARED = 100;

export class StorefrontPart extends Part {
  /* ================================================================ locations */

  /** postalCode argument, else the market default (customer addresses: customers is not a dependency) */
  deliverTo(postalCode: string | null | undefined): DeliverTo {
    const p = postalCode?.trim();
    if (p && /^[A-Za-z0-9][A-Za-z0-9 -]{2,9}$/.test(p)) return { postalCode: p.toUpperCase(), label: p.toUpperCase(), source: 'entered' };
    return { postalCode: MARKET_DEFAULT_POSTAL, label: `Portland ${MARKET_DEFAULT_POSTAL}`, source: 'market_default' };
  }

  /* ================================================================ facts and views */

  async facts(rows: readonly OfferRec[], deliverTo: DeliverTo, quantity: number): Promise<Map<string, Facts>> {
    const out = new Map<string, Facts>();
    if (!rows.length) return out;
    const qty = Math.max(1, Math.floor(quantity) || 1);
    const [avail, promos] = await Promise.all([
      this.core.soft('inventory.getOfferAvailability', () =>
        this.ctx.use('inventory').getOfferAvailability(rows.map((r) => ({ offerId: r.id, stockItemId: r.stock_item_id, ...(r.purchase_limit ? { purchaseLimit: r.purchase_limit } : {}) }))),
      ),
      this.core.optional('promotions', 'priceOffers', (p) => p.priceOffers(rows.map((r) => r.id), { at: isoReq(this.now()) })),
    ]);
    const promoBy = new Map((promos ?? []).map((p) => [p.offerId, p]));
    const deliveries = await Promise.all(rows.map((r) => this.deliveryFor({ profileId: r.shipping_profile_id, ...dispatchOf(r) }, deliverTo)));
    rows.forEach((r, i) => {
      const regular = money(r.price_amount, r.currency);
      const promo = promoBy.get(r.id);
      const campaign = promo && promo.price.currency === r.currency && promo.price.amount < regular.amount ? promo.price : null;
      const unit = campaign ?? regular;
      const delivery = deliveries[i]!;
      const ship = delivery.shippingCost?.amount ?? 0;
      const a = avail?.[r.id];
      const availability = a
        ? { state: a.state as Availability['state'], quantity: a.quantity, maxPerOrder: a.maxPerOrder, purchaseLimit: a.purchaseLimit, label: a.label, expectedRestockDate: a.expectedRestockDate }
        : { state: 'out_of_stock' as const, quantity: null, maxPerOrder: 0, purchaseLimit: r.purchase_limit, label: 'Out of stock', expectedRestockDate: null };
      out.set(r.id, {
        row: r,
        unitPrice: unit,
        regularPrice: campaign ? regular : null,
        promotion: promo && (campaign || promo.badges.length)
          ? {
              campaignId: promo.campaignId ?? null,
              label: promo.badges[0]?.label ?? (promo.flash ? 'Flash sale' : 'Deal'),
              endsAt: promo.flash?.endsAt ?? null,
              badges: promo.badges.map((b) => b.label),
              purchaseLimit: promo.purchaseLimit ?? null,
              wasPriceRule: promo.wasPriceRule ?? null,
            }
          : null,
        delivery,
        total: money(unit.amount * qty + ship, r.currency),
        availability,
      });
    });
    return out;
  }

  /** Delivery estimate from shipping.quote; without shipping only the dispatch label is known */
  async deliveryFor(d: { profileId: string; businessDays: number; sameDayCutoff?: string | null; shipsFrom: string; label: string }, deliverTo: DeliverTo): Promise<DeliveryEstimate> {
    const shipping = this.ctx.tryUse('shipping');
    const plain: DeliveryEstimate = { shipsToLocation: true, arrivesFrom: null, arrivesTo: null, label: d.label, shippingCost: null, free: false, freeOver: null, carrier: null, service: null, shipsFrom: d.shipsFrom, dispatchLabel: d.label, orderWithinMinutes: null, serviceNotice: null };
    if (!shipping) return plain;
    const q = await this.core.soft('shipping.quote', () => shipping.quote(d.profileId, deliverTo.postalCode, DEFAULT_PARCEL, { businessDays: d.businessDays, sameDayCutoff: d.sameDayCutoff ?? null, shipsFrom: d.shipsFrom }));
    if (!q) return plain;
    if (!q.shipsToLocation) return { ...plain, shipsToLocation: false, label: q.reason ?? 'Does not ship to this location' };
    const o = q.default ?? q.options[0];
    if (!o) return plain;
    const minutes = o.cutoffAt ? Math.max(0, Math.round((new Date(o.cutoffAt).getTime() - this.now().getTime()) / 60_000)) : null;
    return {
      shipsToLocation: true,
      arrivesFrom: o.arrival.from.slice(0, 10),
      arrivesTo: o.arrival.to.slice(0, 10),
      label: o.free ? `Free delivery ${o.arrivalLabel.replace(/^Arrives /, '')}` : o.arrivalLabel,
      shippingCost: o.price,
      free: o.free,
      freeOver: null,
      carrier: o.carrierService ?? null,
      service: o.methodName,
      shipsFrom: d.shipsFrom,
      dispatchLabel: o.dispatchLabel || d.label,
      orderWithinMinutes: minutes,
      serviceNotice: o.notices[0] ?? null,
    };
  }

  async sellerCues(rows: readonly OfferRec[]): Promise<Map<string, SellerCue>> {
    const ids = [...new Set(rows.map((r) => r.seller_id).filter((x): x is string => Boolean(x)))];
    const cards = ids.length ? ((await this.core.soft('sellers.getStorefrontCard', () => this.ctx.use('sellers').getStorefrontCard(ids))) ?? []) : [];
    const byId = new Map(cards.map((c) => [c.id, c]));
    const names = ids.length && cards.length < ids.length ? await this.core.sellerNames(rows) : new Map<string, string>();
    const elig = new Map((await this.repo.getEligibility(rows.map((r) => r.id))).map((e) => [e.offer_id, e]));
    const out = new Map<string, SellerCue>();
    for (const r of rows) {
      if (r.owner_type === 'official') {
        out.set(r.id, { sellerId: null, name: OFFICIAL_NAME, official: true, verified: true, storeSlug: null, positivePct: null, ratingCount: null, onTimeDispatchPct: null, location: r.ships_from || null });
        continue;
      }
      const c = byId.get(r.seller_id!);
      const pct = elig.get(r.id)?.seller_on_time_pct;
      out.set(r.id, {
        sellerId: r.seller_id,
        name: c?.storeName ?? names.get(r.seller_id!) ?? 'Seller',
        official: false,
        verified: c?.verified ?? false,
        storeSlug: c?.slug ?? null,
        positivePct: c?.positivePct ?? null,
        ratingCount: c?.ratingCount ?? null,
        onTimeDispatchPct: pct !== null && pct !== undefined ? Math.round(Number(pct)) : null,
        location: c?.location ?? (r.ships_from || null),
      });
    }
    return out;
  }

  /** Customer views of offers at a location; featured ids per variant come from the default decision */
  async views(rows: readonly OfferRec[], deliverTo: DeliverTo, quantity: number, o: { facts?: Map<string, Facts>; featured?: Map<string, string | null> } = {}): Promise<OfferView[]> {
    if (!rows.length) return [];
    const facts = o.facts ?? (await this.facts(rows, deliverTo, quantity));
    const [cues, eligRows, lookback] = await Promise.all([this.sellerCues(rows), this.repo.getEligibility(rows.map((r) => r.id)), this.core.lookbackDays()]);
    const elig = new Map(eligRows.map((e) => [e.offer_id, e]));
    const featured = new Map(o.featured ?? []);
    for (const v of new Set(rows.map((r) => r.variant_id))) {
      if (!featured.has(v)) featured.set(v, (await this.parts.featured.decision(v, 'new', deliverTo)).winnerOfferId ?? null);
    }
    return rows.map((r) => this.view(r, facts.get(r.id)!, cues.get(r.id)!, elig.get(r.id), featured.get(r.variant_id) === r.id, lookback));
  }

  private view(r: OfferRec, f: Facts, seller: SellerCue, e: EligibilityRec | undefined, featured: boolean, lookback: number): OfferView {
    const now = this.now();
    const saleOver = r.sale_ends_at && r.sale_ends_at <= now;
    const compareAt = saleOver ? null : compareAtOf(r, seller.name, lookback);
    const reasons = (Array.isArray(e?.reasons) ? e!.reasons : this.core.statusReasons(r)) as { code: string; message: string }[];
    const eligible = reasons.length === 0 && f.delivery.shipsToLocation && r.status === 'active';
    const note = !eligible ? (reasons[0]?.message ?? (!f.delivery.shipsToLocation ? 'Does not ship to this location' : null)) : null;
    const missing = strings(r.missing_items);
    const { expectedRestockDate: _restock, ...availability } = f.availability;
    return {
      offerId: r.id,
      seller,
      condition: r.condition as OfferView['condition'],
      conditionLabel: CONDITION_LABEL[r.condition as keyof typeof CONDITION_LABEL] ?? r.condition,
      conditionNotes: r.condition_notes,
      missingItems: missing,
      complete: missing.length === 0,
      price: f.unitPrice,
      regularPrice: f.regularPrice,
      compareAt,
      discountPct: compareAt ? discountPct(compareAt.amount.amount, f.unitPrice.amount) : f.regularPrice ? discountPct(f.regularPrice.amount, f.unitPrice.amount) : null,
      saleEndsAt: compareAt && r.sale_ends_at ? isoReq(r.sale_ends_at) : (f.promotion?.endsAt ?? null),
      promotion: f.promotion,
      automaticDiscount: null,
      delivery: f.delivery,
      total: f.total,
      availability,
      returns: returnTermsOf(r),
      warranty: warrantyOf(r),
      featured,
      featuredEligible: eligible,
      ineligibleNote: note,
      status: r.status as OfferView['status'],
      termsVersion: r.terms_version,
    };
  }

  /* ================================================================ public reads */

  async quoteOffer(offerId: string, quantity: number, postalCode?: string): Promise<OfferView> {
    const row = isUuid(offerId) ? await this.repo.get('offers', offerId) : undefined;
    if (!row || row.status === 'draft') throw notFound();
    const q = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
    return (await this.views([row], this.deliverTo(postalCode), q))[0]!;
  }

  async getFeaturedOffer(variantId: string, postalCode?: string): Promise<OfferView | null> {
    if (!isUuid(variantId)) return null;
    const deliverTo = this.deliverTo(postalCode);
    const d = await this.parts.featured.decision(variantId, 'new', deliverTo);
    if (!d.winnerOfferId) return null;
    const row = await this.repo.get('offers', d.winnerOfferId);
    if (!row || row.status !== 'active') return null;
    return (await this.views([row], deliverTo, 1, { featured: new Map([[variantId, row.id]]) }))[0]!;
  }

  /** The store product (approved, not merged) or 404 */
  async storeProduct(productId: string): Promise<catalog.ProductAdmin> {
    const p = await this.core.productAdmin(productId);
    if (!p || p.reviewState !== 'approved') throw notFound('Product');
    return p;
  }

  private summaryOf(p: catalog.ProductAdmin): catalog.ProductSummary {
    const x = p.product;
    return { id: x.id, ref: x.ref, title: x.title, slug: x.slug, brand: x.brand ?? null, categoryId: x.categoryId ?? null, image: x.images[0] ?? null, variantCount: x.variants.length };
  }

  private listedRows(variantId: string) {
    return this.repo.find('offers', { variant_id: variantId, status: LISTED }, { orderBy: [['price_amount', 'asc']], limit: MAX_COMPARED });
  }

  async compareOffers(productId: string, opts: { variantId?: string; condition?: 'all' | 'new' | 'used' | 'refurbished'; postalCode?: string; sort?: 'total_cost' | 'fastest_delivery' }): Promise<OfferComparison> {
    const product = await this.storeProduct(productId);
    const variant = opts.variantId ? product.product.variants.find((v) => v.id === opts.variantId) : product.product.variants[0];
    if (!variant) throw notFound('Variant');
    const deliverTo = this.deliverTo(opts.postalCode);
    const sort = opts.sort ?? 'total_cost';
    const listed = await this.listedRows(variant.id);
    const counts = { all: listed.length, new: 0, used: 0, refurbished: 0 };
    for (const r of listed) counts[conditionGroup(r.condition)]++;
    const filter = opts.condition && opts.condition !== 'all' ? (opts.condition as ConditionGroup) : null;
    const rows = filter ? listed.filter((r) => conditionGroup(r.condition) === filter) : listed;
    const facts = await this.facts(rows, deliverTo, 1);
    const decision = await this.parts.featured.decision(variant.id, filter && filter !== 'new' ? filter : 'new', deliverTo, { facts, productId });
    const featuredDefault = filter && filter !== 'new' ? (await this.parts.featured.decision(variant.id, 'new', deliverTo, { productId })).winnerOfferId ?? null : (decision.winnerOfferId ?? null);
    const views = await this.views(rows, deliverTo, 1, { facts, featured: new Map([[variant.id, featuredDefault]]) });
    const rank = (v: OfferView) => (v.status === 'active' && v.delivery.shipsToLocation ? 0 : 1);
    views.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (sort === 'fastest_delivery') {
        const da = a.delivery.arrivesTo ?? '9999';
        const db = b.delivery.arrivesTo ?? '9999';
        if (da !== db) return da < db ? -1 : 1;
      }
      return a.total.amount - b.total.amount;
    });
    const rule = await this.parts.featured.currentRule();
    return {
      product: this.summaryOf(product),
      variant,
      deliverTo,
      sort,
      featuredOfferId: decision.winnerOfferId ?? null,
      offers: views,
      conditionCounts: counts,
      rule: this.parts.featured.summary(rule),
      taxNote: TAX_NOTE,
    };
  }

  async purchaseBox(productId: string, q: { variantId?: string; offerId?: string; postalCode?: string }): Promise<PurchaseBox> {
    const product = await this.storeProduct(productId);
    const chosenRow = q.offerId && isUuid(q.offerId) ? await this.repo.get('offers', q.offerId) : undefined;
    const chosen = chosenRow && chosenRow.product_id === productId && chosenRow.status !== 'draft' && chosenRow.status !== 'removed' ? chosenRow : undefined;
    const variantId = q.variantId ?? chosen?.variant_id ?? product.product.variants[0]?.id;
    const variant = product.product.variants.find((v) => v.id === variantId);
    if (!variant) throw notFound('Variant');
    const deliverTo = this.deliverTo(q.postalCode);
    const listed = await this.listedRows(variant.id);
    const choice = chosen && chosen.variant_id === variant.id ? chosen : undefined;
    const rows = choice && !listed.some((r) => r.id === choice.id) ? [...listed, choice] : listed;
    const facts = await this.facts(rows, deliverTo, 1);
    const decision = await this.parts.featured.decision(variant.id, 'new', deliverTo, { facts, productId });
    const featuredId = decision.winnerOfferId ?? null;
    const views = await this.views(rows, deliverTo, 1, { facts, featured: new Map([[variant.id, featuredId]]) });
    const byId = new Map(views.map((v) => [v.offerId, v]));
    const buyable = views.filter((v) => v.status === 'active' && v.availability.maxPerOrder > 0 && v.delivery.shipsToLocation);

    let selected: OfferView | null = null;
    let selectedBy: PurchaseBox['selectedBy'] = 'featured';
    if (choice) {
      selected = byId.get(choice.id) ?? null;
      selectedBy = 'customer_choice';
    } else if (featuredId && byId.get(featuredId)) {
      selected = byId.get(featuredId)!;
      selectedBy = listed.length === 1 ? 'only_offer' : 'featured';
    } else if (buyable.length === 1) {
      selected = buyable[0]!;
      selectedBy = 'only_offer';
    }
    const featuredView = selectedBy === 'customer_choice' && featuredId && featuredId !== selected?.offerId ? (byId.get(featuredId) ?? null) : null;
    const others = views.filter((v) => v.offerId !== selected?.offerId && v.status === 'active');
    const lowestPrice = others.length ? others.reduce((m, v) => (v.price.amount < m.amount ? v.price : m), others[0]!.price) : null;
    const lowestTotal = others.length ? others.reduce((m, v) => (v.total.amount < m.amount ? v.total : m), others[0]!.total) : null;

    const selectable = selected && selected.status === 'active' && selected.availability.maxPerOrder > 0 && selected.delivery.shipsToLocation;
    let unavailable: PurchaseBox['unavailable'] = null;
    if (!selectable) {
      const alternatives = buyable.filter((v) => v.offerId !== selected?.offerId).slice(0, 5);
      const purchasable = product.publication === 'active';
      const anyOut = views.some((v) => v.availability.state === 'out_of_stock' || v.status === 'out_of_stock');
      const notShippable = views.length > 0 && views.every((v) => !v.delivery.shipsToLocation);
      const who = selected?.seller.name ?? (views.length === 1 ? views[0]!.seller.name : null);
      const restock = selected ? (facts.get(selected.offerId)?.availability.expectedRestockDate ?? null) : null;
      if (!purchasable) unavailable = { reason: 'product_unavailable', title: 'Currently unavailable', message: 'This product cannot be bought right now.', expectedRestockDate: null, alternatives: [] };
      else if (!views.length) unavailable = { reason: 'no_offers', title: 'No offers right now', message: 'No seller is offering this variant at the moment.', expectedRestockDate: null, alternatives: [] };
      else if (notShippable) unavailable = { reason: 'not_shippable', title: `Does not ship to ${deliverTo.label}`, message: 'No offer for this variant ships to your delivery location.', expectedRestockDate: null, alternatives: [] };
      else if (anyOut || selected) unavailable = { reason: 'out_of_stock', title: who ? `Out of stock at ${who === OFFICIAL_NAME ? 'the Official Store' : who}` : 'Out of stock', message: restock ? `Expected back around ${restock} (estimate).` : 'This offer is out of stock.', expectedRestockDate: restock, alternatives };
      else if (!selected && buyable.length > 1) unavailable = null; // several non-competing offers: the customer chooses
    }
    const max = selectable ? Math.min(selected!.availability.maxPerOrder, 10) : 0;
    const variants = Object.values(await this.variantSummaries(product.product.variants.map((v) => ({ id: v.id, options: v.options }))));
    return {
      product: this.summaryOf(product),
      variantId: variant.id,
      deliverTo,
      selected,
      selectedBy,
      featured: featuredView,
      otherOffers: {
        count: others.length,
        lowestPrice,
        lowestTotal,
        label: others.length ? `${others.length} other offer${others.length === 1 ? '' : 's'} from ${formatMoney(lowestPrice!)}` : 'No other offers',
      },
      variants,
      quantityOptions: Array.from({ length: max }, (_, i) => i + 1),
      unavailable,
    };
  }

  /** Variant chooser cues from the active offers of each variant */
  async variantSummaries(variants: readonly { id: string; options: Record<string, string> }[]): Promise<Record<string, VariantAvailability>> {
    const ids = variants.map((v) => v.id).filter(isUuid);
    const rows = ids.length ? await this.repo.allOffers({ variantIds: ids, statuses: ['active', 'out_of_stock'] }, 2000) : [];
    const out: Record<string, VariantAvailability> = {};
    for (const v of variants) {
      const mine = rows.filter((r) => r.variant_id === v.id);
      const active = mine.filter((r) => r.status === 'active');
      const lowest = active.length ? active.reduce((m, r) => (r.price_amount < m.price_amount ? r : m)) : null;
      const lowestPrice = lowest ? money(lowest.price_amount, lowest.currency) : null;
      const summary = active.length === 0 ? (mine.length ? 'Out of stock' : 'Unavailable') : active.length === 1 ? `${formatMoney(lowestPrice!)} · In stock` : `${active.length} offers from ${formatMoney(lowestPrice!)}`;
      out[v.id] = { variantId: v.id, options: v.options, label: variantLabel(v.options), offerCount: active.length, lowestPrice, inStock: active.length > 0, summary };
    }
    return out;
  }

  async getVariantOfferSummaries(variantIds: string[], _postalCode?: string): Promise<Record<string, VariantAvailability>> {
    const ids = [...new Set(variantIds.filter(isUuid))];
    const rows = ids.length ? await this.repo.allOffers({ variantIds: ids }, 2000) : [];
    const products = await this.core.products(rows.map((r) => r.product_id));
    const options = new Map<string, Record<string, string>>();
    for (const p of products.values()) for (const v of p.product.variants) options.set(v.id, v.options);
    return this.variantSummaries(ids.map((id) => ({ id, options: options.get(id) ?? {} })));
  }

  /* ================================================================ batched reads for product cards */

  private async defaultVariants(productIds: readonly string[]): Promise<Map<string, string>> {
    const products = await this.core.products(productIds);
    return new Map([...products].flatMap(([id, p]) => (p.product.variants[0] ? [[id, p.product.variants[0].id] as [string, string]] : [])));
  }

  async getFeaturedOfferForProduct(items: { productId: string; variantId?: string }[], postalCode?: string): Promise<Record<string, Offer | null>> {
    const deliverTo = this.deliverTo(postalCode);
    const defaults = await this.defaultVariants(items.filter((i) => !i.variantId).map((i) => i.productId));
    const out: Record<string, Offer | null> = {};
    for (const i of items) {
      const variantId = i.variantId ?? defaults.get(i.productId);
      out[i.productId] = null;
      if (!variantId || !isUuid(variantId)) continue;
      const d = await this.parts.featured.decision(variantId, 'new', deliverTo, { productId: i.productId });
      if (!d.winnerOfferId) continue;
      const row = await this.repo.get('offers', d.winnerOfferId);
      if (row && row.status === 'active' && row.product_id === i.productId) out[i.productId] = await this.core.toOffer(row);
    }
    return out;
  }

  async getPurchaseBoxOffer(items: { productId: string; offerId?: string; variantId?: string }[], postalCode?: string): Promise<Record<string, Offer | null>> {
    const out: Record<string, Offer | null> = {};
    const fallback: { productId: string; variantId?: string }[] = [];
    const requested = await this.repo.getMany('offers', items.map((i) => i.offerId).filter((x): x is string => isUuid(x)));
    const byId = new Map(requested.map((r) => [r.id, r]));
    for (const i of items) {
      const r = i.offerId ? byId.get(i.offerId) : undefined;
      if (r && r.product_id === i.productId && r.status === 'active') out[i.productId] = await this.core.toOffer(r);
      else fallback.push({ productId: i.productId, ...(i.variantId ? { variantId: i.variantId } : r && r.product_id === i.productId ? { variantId: r.variant_id } : {}) });
    }
    if (fallback.length) Object.assign(out, await this.getFeaturedOfferForProduct(fallback, postalCode));
    return out;
  }

  async getOfferStats(productIds: string[], opts?: { condition?: 'all' | 'new' | 'used' | 'refurbished' }) {
    const ids = [...new Set(productIds.filter(isUuid))];
    const rows = ids.length ? await this.repo.allOffers({ productIds: ids, statuses: ['active'] }, 5000) : [];
    const cond = opts?.condition && opts.condition !== 'all' ? opts.condition : null;
    const elig = new Map((await this.repo.getEligibility(rows.map((r) => r.id))).map((e) => [e.offer_id, e]));
    const names = await this.core.sellerNames(rows);
    const out: Record<string, { count: number; lowest: common.Money; highest: common.Money; lowestOfferId: string; lowestSellerName: string } | null> = {};
    for (const id of productIds) {
      const mine = rows.filter((r) => r.product_id === id && (!cond || conditionGroup(r.condition) === cond));
      if (!mine.length) {
        out[id] = null;
        continue;
      }
      const eligible = mine.filter((r) => elig.get(r.id)?.eligible ?? true);
      const pool = eligible.length ? eligible : mine;
      const low = pool.reduce((m, r) => (r.price_amount < m.price_amount ? r : m));
      const high = mine.reduce((m, r) => (r.price_amount > m.price_amount ? r : m));
      out[id] = { count: mine.length, lowest: money(low.price_amount, low.currency), highest: money(high.price_amount, high.currency), lowestOfferId: low.id, lowestSellerName: this.core.nameOf(low, names) };
    }
    return out;
  }

  async listActiveOffersByIds(offerIds: string[], limit?: number): Promise<Offer[]> {
    const rows = new Map((await this.repo.getMany('offers', offerIds.filter(isUuid))).map((r) => [r.id, r]));
    const ordered = offerIds.map((id) => rows.get(id)).filter((r): r is OfferRec => Boolean(r && r.status === 'active'));
    return this.core.toOffers(limit && limit > 0 ? ordered.slice(0, limit) : ordered);
  }

  async listActiveOffersForProduct(productId: string): Promise<OfferSummary[]> {
    if (!isUuid(productId)) return [];
    const rows = await this.repo.find('offers', { product_id: productId, status: 'active' }, { orderBy: [['price_amount', 'asc']], limit: 200 });
    const s = await this.parts.views.summaries(rows);
    return rows.map((r) => s.get(r.id)!);
  }

  /** Active, in stock and featured-eligible (sponsored products may only promote these) */
  async isPromotable(offerId: string): Promise<boolean> {
    const row = isUuid(offerId) ? await this.repo.get('offers', offerId) : undefined;
    if (!row || row.status !== 'active') return false;
    const e = (await this.repo.getEligibility([row.id]))[0];
    if (e && !e.eligible) return false;
    return ((await this.core.available([row.stock_item_id])).get(row.stock_item_id) ?? 0) > 0;
  }

  /* ================================================================ cart and orders */

  /** Scenario 2: what changed since each cart line was added. Reports only; never swaps the seller. */
  async revalidate(lines: { offerId: string; quantity: number; termsVersion: number; price: common.Money }[], postalCode: string): Promise<{ ok: boolean; changes: OfferChange[] }> {
    const deliverTo = this.deliverTo(postalCode);
    const rows = new Map((await this.repo.getMany('offers', lines.map((l) => l.offerId).filter(isUuid))).map((r) => [r.id, r]));
    const live = [...rows.values()].filter((r) => r.status !== 'draft');
    const views = new Map((await this.views(live, deliverTo, 1)).map((v) => [v.offerId, v]));
    const altCache = new Map<string, OfferView[]>();
    const alternatives = async (r: OfferRec) => {
      if (!altCache.has(r.variant_id)) {
        const others = (await this.repo.find('offers', { variant_id: r.variant_id, status: 'active' }, { orderBy: [['price_amount', 'asc']], limit: 6 })).filter((o) => o.id !== r.id);
        altCache.set(r.variant_id, (await this.views(others, deliverTo, 1)).filter((v) => v.availability.maxPerOrder > 0 && v.delivery.shipsToLocation).slice(0, 3));
      }
      return altCache.get(r.variant_id)!;
    };
    const changes: OfferChange[] = [];
    for (const l of lines) {
      const r = rows.get(l.offerId);
      const v = r ? views.get(r.id) : undefined;
      if (!r || !v || r.status === 'removed') {
        changes.push({ offerId: l.offerId, kind: 'removed', before: null, after: null, message: 'This offer is no longer available. Choose another offer if you still want the item.', alternatives: r ? await alternatives(r) : [] });
        continue;
      }
      const src = (r.ineligible_source ?? {}) as { kind?: string };
      if (r.status === 'ineligible' && (src.kind === 'restriction' || src.kind === 'suspension')) {
        changes.push({ offerId: r.id, kind: 'seller_restricted', before: null, after: null, message: `${v.seller.name} can't sell this item right now. Choose another offer if you still want it.`, alternatives: await alternatives(r) });
        continue;
      }
      if (r.status !== 'active' || v.availability.maxPerOrder < l.quantity) {
        const left = r.status === 'active' ? v.availability.maxPerOrder : 0;
        changes.push({
          offerId: r.id,
          kind: 'availability',
          before: String(l.quantity),
          after: String(left),
          message: left > 0 ? `Only ${left} can be bought from ${v.seller.name} now.` : `This item is no longer available from ${v.seller.name}.`,
          alternatives: await alternatives(r),
        });
        continue;
      }
      if (!v.delivery.shipsToLocation) {
        changes.push({ offerId: r.id, kind: 'delivery', before: null, after: deliverTo.label, message: `${v.seller.name} does not deliver to ${deliverTo.label}.`, alternatives: await alternatives(r) });
        continue;
      }
      if (l.price.amount !== v.price.amount || l.price.currency !== v.price.currency) {
        changes.push({ offerId: r.id, kind: 'price', before: formatMoney(l.price), after: formatMoney(v.price), message: `The price changed from ${formatMoney(l.price)} to ${formatMoney(v.price)}.`, alternatives: [] });
        continue;
      }
      if (l.termsVersion !== r.terms_version) {
        changes.push({ offerId: r.id, kind: 'terms', before: `v${l.termsVersion}`, after: `v${r.terms_version}`, message: `${v.seller.name} updated the delivery, return or warranty terms of this offer. Review them before you buy.`, alternatives: [] });
      }
    }
    return { ok: changes.length === 0, changes };
  }

  /** Frozen terms for an order item (plan ch. 8). Only an active offer can be bought. */
  async snapshotForOrder(offerId: string): Promise<OfferSnapshot> {
    const r = isUuid(offerId) ? await this.repo.get('offers', offerId) : undefined;
    if (!r || r.status === 'draft') throw notFound();
    if (r.status !== 'active') {
      const others = await this.repo.find('offers', { variant_id: r.variant_id, status: 'active' }, { orderBy: [['price_amount', 'asc']], limit: 5 });
      throw this.core.error('OFFER_UNAVAILABLE', 'This offer can no longer be bought', { status: r.status, alternatives: others.filter((o) => o.id !== r.id).map((o) => ({ offerId: o.id, price: money(o.price_amount, o.currency) })) });
    }
    const names = await this.core.sellerNames([r]);
    const lookback = await this.core.lookbackDays();
    const compareAt = compareAtOf(r, this.core.nameOf(r, names), lookback);
    return {
      offerId: r.id,
      termsVersion: r.terms_version,
      ownerType: r.owner_type,
      sellerId: r.seller_id,
      sellerName: this.core.nameOf(r, names),
      condition: r.condition,
      conditionNotes: r.condition_notes,
      missingItems: strings(r.missing_items),
      price: money(r.price_amount, r.currency),
      compareAt: compareAt?.amount ?? null,
      dispatch: { ...dispatchOf(r), label: dispatchLabel(r.dispatch_business_days) },
      returnTerms: returnTermsOf(r),
      warranty: warrantyOf(r),
      stockItemId: r.stock_item_id,
      takenAt: isoReq(this.now()),
    };
  }

  /** GET /offers/{id} (store): drafts do not exist for customers */
  async offerView(id: string, q: { postalCode?: string; quantity?: number }): Promise<OfferView> {
    return this.quoteOffer(id, q.quantity ?? 1, q.postalCode);
  }
}
