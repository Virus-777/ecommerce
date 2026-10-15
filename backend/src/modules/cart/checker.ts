/**
 * The change check behind every cart read: re-reads offers, stock, promotion prices, product
 * purchasability and shipping coverage for all lines (batched), reconciles the per-line notices,
 * previews coupons and builds the CartView grouped by package.
 */
import { isAppError, isNotImplemented } from '../../kernel/errors/index.js';
import { newId } from '../../kernel/lib/ids.js';
import { money, type Money } from '../../kernel/lib/money.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import { OFFICIAL_STORE_ID } from '../../spec/common.js';
import type {
  CartDestination,
  CartItem,
  CartNotice,
  CartPackage,
  CartView,
  CouponPreview,
  DiscountLine,
  PackageDelivery,
  PackageShippingLine,
} from '../../spec/cart.js';
import type * as offers from '../../spec/offers.js';
import type * as shipping from '../../spec/shipping.js';
import { evaluateLine, type LineEval, type OfferFacts, type ProductFacts } from './domain/check.js';
import { couponNotCovered } from './domain/coupons.js';
import {
  addDays,
  desired,
  lineState,
  noticeActions,
  noticeMessage,
  planNotices,
  plural,
  storedCoupons,
  type DesiredNotice,
  type JsonObject,
  type LineState,
  type NoticeKind,
  type NoticePlan,
  type StoredCoupon,
} from './domain/rules.js';
import type { CartRow, ItemRow, NoticeRow } from './ports.js';
import type { CartRepository } from './repository.js';

/** Shipping has no parcel weight per offer yet: every unit is quoted at this weight */
export const DEFAULT_UNIT_WEIGHT_GRAMS = 1000;

export interface CheckOptions {
  /** Deliver-to override for this read only */
  postalCode?: string;
  /** A shopper is looking: info notices in this view count as shown, and the cart's idle clock restarts */
  shopperRead: boolean;
  customerId?: string | null;
  guestSessionId?: string | null;
}

export interface CheckedLine {
  eval: LineEval;
  state: LineState;
  open: NoticeRow[];
  item: CartItem;
}

export interface CheckResult {
  cart: CartRow;
  view: CartView;
  lines: CheckedLine[];
}

interface Facts {
  offers: Map<string, OfferFacts>;
  products: Map<string, ProductFacts>;
}

interface PackageQuote {
  delivery: PackageDelivery | null;
  notShippable: Set<string>;
  allNotShippable: boolean;
}

const EMPTY_FACTS: OfferFacts = { offer: null, quote: null, promo: null, available: null, stockState: null, lowStockThreshold: null, changes: [] };
const EMPTY_PRODUCT: ProductFacts = { product: null, purchasable: null };

const obj = (j: unknown): JsonObject => (j && typeof j === 'object' && !Array.isArray(j) ? (j as JsonObject) : {});
const iso = (d: Date) => d.toISOString();
const isoOrNull = (s: unknown) => {
  if (typeof s !== 'string') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export class CartChecker {
  constructor(
    private readonly ctx: ModuleContext<'cart'>,
    private readonly repo: CartRepository,
  ) {}

  private now() {
    return this.ctx.clock.now();
  }

  /** An optional module's answer; when the module is off or not built yet the cart works without it */
  async optional<T>(what: string, call: (() => Promise<T>) | undefined): Promise<T | undefined> {
    if (!call) return undefined;
    try {
      return await call();
    } catch (err) {
      if (isNotImplemented(err)) this.ctx.log.debug({ what }, 'cart: optional module not built yet');
      else this.ctx.log.warn({ err, what }, 'cart: optional module failed; continuing without it');
      return undefined;
    }
  }

  async retentionDays(ownerKind: 'customer' | 'guest') {
    return ownerKind === 'guest' ? this.ctx.settings.get('guestCartRetentionDays') : this.ctx.settings.get('customerCartRetentionDays');
  }

  async retentionNote(ownerKind: 'customer' | 'guest') {
    return `Items stay in your cart for ${plural(await this.retentionDays(ownerKind), 'day')}. Prices and stock are checked again at checkout.`;
  }

  /* ================================================================ facts */

  /** Offer, stock, promotion price, revalidation and product facts for a set of lines (batched) */
  async gather(items: Pick<ItemRow, 'offer_id' | 'product_id' | 'stock_item_id' | 'quantity' | 'accepted_terms_version' | 'accepted_price' | 'currency'>[], postalCode: string | undefined, customerId: string | null | undefined): Promise<Facts> {
    const offersApi = this.ctx.use('offers');
    const offerIds = [...new Set(items.map((i) => i.offer_id))];
    const productIds = [...new Set(items.map((i) => i.product_id))];
    const result: Facts = { offers: new Map(), products: new Map() };
    if (!items.length) return result;

    // one batch read of every line's offer, any status
    const found = await offersApi.getOffers(offerIds);
    const byId = new Map(offerIds.map((id) => [id, found[id] ?? null]));
    const qty = new Map<string, number>();
    for (const i of items) qty.set(i.offer_id, (qty.get(i.offer_id) ?? 0) + i.quantity);
    const stockOf = (id: string) => byId.get(id)?.stockItemId ?? items.find((i) => i.offer_id === id)!.stock_item_id;
    const stockIds = [...new Set(offerIds.map(stockOf))];

    const promoApi = this.ctx.tryUse('promotions');
    const catalogApi = this.ctx.tryUse('catalog');
    const live = offerIds.filter((id) => byId.get(id));
    const [availability, quotes, promos, revalidation, products] = await Promise.all([
      this.ctx.use('inventory').getAvailability(stockIds),
      Promise.all(
        offerIds.map(async (id) => {
          const o = byId.get(id);
          if (!o || (o.status !== 'active' && o.status !== 'out_of_stock')) return null;
          try {
            return await offersApi.quoteOffer(id, Math.max(qty.get(id) ?? 1, 1), postalCode);
          } catch (err) {
            if (isNotImplemented(err) || !isAppError(err)) throw err;
            return null;
          }
        }),
      ),
      this.optional('promotions.priceOffers', promoApi && (() => promoApi.priceOffers(live, { customerId: customerId ?? undefined, at: iso(this.now()) }))),
      live.length
        ? offersApi.revalidate(
            items.filter((i) => byId.get(i.offer_id)).map((i) => ({ offerId: i.offer_id, quantity: i.quantity, termsVersion: i.accepted_terms_version, price: money(i.accepted_price, i.currency) })),
            postalCode || this.ctx.config.market.defaultLocation.postalCode,
          )
        : Promise.resolve({ ok: true, changes: [] as offers.OfferChange[] }),
      Promise.all(
        productIds.map(async (id) => {
          if (!catalogApi) return EMPTY_PRODUCT;
          const [product, purchasable] = await Promise.all([
            this.optional('catalog.getProduct', () => catalogApi.getProduct(id)),
            this.optional('catalog.isPurchasable', () => catalogApi.isPurchasable(id)),
          ]);
          return { product: product ?? null, purchasable: purchasable ?? null } satisfies ProductFacts;
        }),
      ),
    ]);
    const promoBy = new Map((promos ?? []).map((p) => [p.offerId, p]));
    offerIds.forEach((id, i) => {
      const a = availability[stockOf(id)];
      result.offers.set(id, {
        offer: byId.get(id) ?? null,
        quote: quotes[i] ?? null,
        promo: promoBy.get(id) ?? null,
        available: a ? a.available : null,
        stockState: a?.state ?? null,
        lowStockThreshold: a?.lowStockThreshold ?? null,
        changes: (revalidation?.changes ?? []).filter((c) => c.offerId === id),
      });
    });
    productIds.forEach((id, i) => result.products.set(id, products[i]!));
    return result;
  }

  /* ================================================================ shipping */

  private deliveryFromOption(o: shipping.DeliveryOption, basis: CartDestination['source']): PackageDelivery {
    return {
      methodName: o.methodName,
      arrival: o.arrival,
      arrivalLabel: o.arrivalLabel,
      shipping: o.price,
      free: o.free,
      freeShippingNote: o.freeReason ?? null,
      amountToFreeShipping: null,
      estimateBasis: basis,
      serviceNotices: o.notices ?? [],
    };
  }

  /** Delivery from offers' per-offer estimates when shipping is off or no location is known */
  private deliveryFromEstimates(lines: LineEval[], basis: CartDestination['source'], currency: string): PackageQuote {
    const notShippable = new Set<string>();
    const est: offers.DeliveryEstimate[] = [];
    for (const l of lines) {
      const d = l.facts.quote?.delivery;
      if (!d) continue;
      if (!d.shipsToLocation) notShippable.add(l.item.id);
      else est.push(d);
    }
    const dated = est.filter((d) => d.arrivesFrom && d.arrivesTo);
    if (!dated.length) return { delivery: null, notShippable, allNotShippable: lines.length > 0 && notShippable.size === lines.length };
    const from = dated.map((d) => d.arrivesFrom!).sort().at(-1)!;
    const to = dated.map((d) => d.arrivesTo!).sort().at(-1)!;
    const latest = dated.find((d) => d.arrivesTo === to)!;
    const cost = Math.max(0, ...est.map((d) => (d.free ? 0 : (d.shippingCost?.amount ?? 0))));
    const freeOver = est.find((d) => d.freeOver)?.freeOver ?? null;
    const value = lines.filter((l) => !notShippable.has(l.item.id)).reduce((a, l) => a + l.unitPrice.amount * l.item.quantity, 0);
    // free at package level: each estimate is per line, so lines each below a free-shipping threshold can
    // together reach it (the package ships as one)
    const free = est.every((d) => d.free || (d.freeOver !== null && d.freeOver !== undefined && value >= d.freeOver.amount));
    return {
      delivery: {
        methodName: latest.service ?? 'Standard',
        arrival: { from, to },
        arrivalLabel: latest.label,
        shipping: money(free ? 0 : cost, currency),
        free,
        freeShippingNote: freeOver ? `Free over ${formatShort(freeOver)}` : null,
        amountToFreeShipping: freeOver && !free && freeOver.amount > value ? money(freeOver.amount - value, freeOver.currency) : null,
        estimateBasis: basis,
        serviceNotices: [...new Set(est.map((d) => d.serviceNotice).filter((s): s is string => !!s))],
      },
      notShippable,
      allNotShippable: lines.length > 0 && notShippable.size === lines.length,
    };
  }

  private async quotePackage(lines: LineEval[], dest: CartDestination | null, currency: string): Promise<PackageQuote> {
    const basis = dest?.source ?? 'default_region';
    const quotable = lines.filter((l) => !l.blocked && l.offer);
    if (!quotable.length) return { delivery: null, notShippable: new Set(), allNotShippable: false };
    const shippingApi = this.ctx.tryUse('shipping');
    if (shippingApi && dest) {
      const first = quotable[0]!;
      const q = await this.optional('shipping.quoteOptions', () =>
        shippingApi.quoteOptions({
          ownerType: first.item.owner_type,
          sellerId: first.item.seller_id,
          fulfilledBy: first.fulfilledBy,
          shipsFrom: first.shipsFrom,
          items: quotable.map((l) => ({
            lineId: l.item.id,
            profileId: l.shipping!.profileId,
            parcel: { weightGrams: DEFAULT_UNIT_WEIGHT_GRAMS },
            quantity: l.item.quantity,
            value: money(l.unitPrice.amount * l.item.quantity, l.unitPrice.currency),
            dispatch: { businessDays: l.shipping!.dispatch.businessDays, sameDayCutoff: l.shipping!.dispatch.sameDayCutoff ?? null, shipsFrom: l.shipsFrom },
          })),
          destination: { postalCode: dest.postalCode, country: dest.country, region: dest.region ?? null },
          at: iso(this.now()),
        }),
      );
      if (q) {
        const notShippable = new Set(q.shipsToLocation ? q.notShippableLineIds : quotable.map((l) => l.item.id));
        const option = q.default ?? q.options.find((o) => o.isDefault) ?? q.options[0];
        const allNot = notShippable.size >= quotable.length;
        return { delivery: option && !allNot ? this.deliveryFromOption(option, basis) : null, notShippable, allNotShippable: allNot };
      }
    }
    return this.deliveryFromEstimates(quotable, basis, currency);
  }

  /* ================================================================ the check */

  destinationOf(cart: CartRow | null, postalOverride?: string): CartDestination | null {
    if (postalOverride?.trim()) return { postalCode: postalOverride.trim(), country: 'US', region: null, city: null, addressId: null, source: 'postal_code' };
    const d = obj(cart?.destination);
    if (typeof d.postalCode !== 'string' || !d.postalCode) return null;
    return {
      postalCode: d.postalCode,
      country: typeof d.country === 'string' ? d.country : 'US',
      region: typeof d.region === 'string' ? d.region : null,
      city: typeof d.city === 'string' ? d.city : null,
      addressId: typeof d.addressId === 'string' ? d.addressId : null,
      source: d.source === 'address' ? 'address' : 'postal_code',
    };
  }

  async run(cart: CartRow, o: CheckOptions): Promise<CheckResult> {
    const now = this.now();
    const currency = cart.currency;
    const items = await this.repo.listItems(cart.id);
    const storedNotices = await this.repo.listNotices(items.map((i) => i.id));
    const dest = this.destinationOf(cart, o.postalCode);
    const facts = await this.gather(items, dest?.postalCode, o.customerId);
    const settings = {
      maxQuantityPerLine: await this.ctx.settings.get('maxQuantityPerLine'),
      showPriceDecreaseNotices: await this.ctx.settings.get('showPriceDecreaseNotices'),
    };
    const evals = items.map((i) => evaluateLine(i, facts.offers.get(i.offer_id) ?? EMPTY_FACTS, facts.products.get(i.product_id) ?? EMPTY_PRODUCT, settings));

    // packages, in the order their first line was added
    const groups = new Map<string, LineEval[]>();
    for (const e of evals) groups.set(e.packageKey, [...(groups.get(e.packageKey) ?? []), e]);
    const quotes = new Map<string, PackageQuote>();
    await Promise.all([...groups].map(async ([key, lines]) => quotes.set(key, await this.quotePackage(lines, dest, currency))));

    // coverage and delivery changes complete the detected notices
    const detected = new Map<string, DesiredNotice[]>();
    for (const e of evals) {
      const q = quotes.get(e.packageKey)!;
      const list = [...e.notices];
      if (q.notShippable.has(e.item.id)) list.push(desired('not_shippable', {}, { postalCode: dest?.postalCode ?? null }));
      else if (e.deliveryChange && !e.blocked) list.push(desired('delivery_estimate_changed', {}, { message: e.deliveryChange }));
      detected.set(e.item.id, list);
    }
    await this.hintAlternatives(evals.filter((e) => !e.alternatives && (e.blocked || quotes.get(e.packageKey)!.notShippable.has(e.item.id))));
    const storedFor = (rows: NoticeRow[], id: string) => rows.filter((n) => n.item_id === id);
    const preState = new Map(evals.map((e) => [e.item.id, lineState(planNotices(e.item.id, storedFor(storedNotices, e.item.id), detected.get(e.item.id)!, now, newId).open)]));

    // coupons and discounts for the eligible lines
    const eligible = evals.filter((e) => preState.get(e.item.id) === 'ok');
    const coupons = storedCoupons(cart.coupon_codes);
    const promo = await this.evaluatePromotions(cart, eligible, quotes, coupons, dest, o);
    for (const [itemId, code] of promo.uncovered) detected.get(itemId)?.push(desired('coupon_no_longer_applies', {}, { code }));

    // persist: notices, accepted-price moves, refreshed line facts, check time
    const consumeInfo = o.shopperRead;
    // settings before the transaction: inside it only this module's repository may be touched
    const retention = await this.retentionDays(cart.owner_kind);
    const { plans, cartRow } = await this.repo.transaction(async (tx) => {
      const locked = (await tx.getCart(cart.id, { forUpdate: true })) ?? cart;
      const present = new Set((await tx.listItems(cart.id)).map((i) => i.id));
      const fresh = await tx.listNotices([...present]);
      const plans = new Map<string, NoticePlan>();
      const inserts: NoticeRow[] = [];
      const resolves: string[] = [];
      for (const e of evals) {
        if (!present.has(e.item.id)) continue;
        const plan = planNotices(e.item.id, storedFor(fresh, e.item.id), detected.get(e.item.id)!, now, newId);
        plans.set(e.item.id, plan);
        inserts.push(...plan.insert);
        resolves.push(...plan.resolve);
        const patch: Partial<ItemRow> = { last_checked_at: now };
        if (e.newAcceptedPrice !== null) {
          patch.accepted_price = e.newAcceptedPrice;
          // the price drop is accepted automatically: its terms version too, so it is not shown again as terms_changed
          if (e.offer) patch.accepted_terms_version = e.offer.termsVersion;
        }
        if (e.offer) {
          if (e.shipsFrom !== e.item.ships_from) patch.ships_from = e.shipsFrom;
          if (e.fulfilledBy !== e.item.fulfilled_by) patch.fulfilled_by = e.fulfilledBy;
          if (e.offer.condition !== e.item.condition) patch.condition = e.offer.condition;
          if (e.offer.stockItemId !== e.item.stock_item_id) patch.stock_item_id = e.offer.stockItemId;
        }
        await tx.updateItem(e.item.id, patch);
      }
      await tx.insertNotices(inserts);
      await tx.resolveNotices(resolves, now);
      if (consumeInfo) {
        const shown = [...plans.values()].flatMap((p) => p.open.filter((n) => n.severity === 'info').map((n) => n.id));
        await tx.resolveNotices(shown, now);
      }
      const cartPatch: Partial<CartRow> = { checked_at: now };
      if (promo.couponsChanged) cartPatch.coupon_codes = promo.nextCoupons as never;
      if (consumeInfo && locked.status === 'active') cartPatch.expires_at = addDays(now, retention);
      const cartRow = await tx.updateCart(cart.id, cartPatch);
      return { plans, cartRow };
    });

    // the view
    const timeZone = this.ctx.config.market.timeZone;
    const wishlist = this.ctx.modules.includes('wishlist' as never);
    const saveForLater = this.ctx.config.launchPhase >= 3;
    const lines: CheckedLine[] = [];
    for (const e of evals) {
      const plan = plans.get(e.item.id);
      if (!plan) continue;
      const open = plan.open;
      const state = lineState(open);
      const quantity = e.item.quantity;
      const product = e.product.product;
      const variant = product?.variants.find((v) => v.id === e.item.variant_id) ?? null;
      const options = variant?.options ?? {};
      const alt = e.alternatives;
      const notices: CartNotice[] = open.map((n) => {
        const p = obj(n.previous);
        const c = obj(n.current);
        const stored = obj(c.alternatives);
        const hint = alt ?? (typeof stored.count === 'number' && stored.count > 0 ? { count: stored.count, lowestPrice: (stored.lowestPrice as Money | null) ?? null } : null);
        const kind = n.kind as NoticeKind;
        return {
          id: n.id,
          kind,
          severity: n.severity as CartNotice['severity'],
          message: noticeMessage(kind, n.previous, n.current, { sellerName: e.seller.name, currency, timeZone, quantity }),
          previousPrice: typeof p.price === 'number' ? money(p.price, typeof p.currency === 'string' ? p.currency : currency) : null,
          currentPrice: typeof c.price === 'number' ? money(c.price, typeof c.currency === 'string' ? c.currency : currency) : null,
          previousQuantity: typeof p.quantity === 'number' ? p.quantity : null,
          availableQuantity: typeof c.available === 'number' ? c.available : null,
          changedBy: typeof c.changedBy === 'string' ? c.changedBy : null,
          changedAt: isoOrNull(c.changedAt),
          alternatives: hint ? { count: hint.count, lowestPrice: hint.lowestPrice, productId: e.item.product_id, variantId: e.item.variant_id, condition: e.condition } : null,
          actions: noticeActions(kind, { alternatives: !!hint, saveForLater, notifyMe: wishlist }),
          detectedAt: iso(n.detected_at),
        };
      });
      const image = variant?.images[0] ?? product?.images[0] ?? null;
      const item: CartItem = {
        id: e.item.id,
        offerId: e.item.offer_id,
        productId: e.item.product_id,
        productSlug: product?.slug ?? null,
        variantId: e.item.variant_id,
        seller: e.seller,
        title: product?.title ?? 'Item',
        variantLabel: Object.values(options).join(' · '),
        options,
        condition: e.condition,
        conditionNote: e.conditionNote,
        sku: null,
        image,
        quantity,
        maxQuantity: e.maxQuantity,
        purchaseLimit: e.purchaseLimit,
        availableQuantity: e.shownAvailable,
        unitPrice: e.unitPrice,
        compareAtPrice: e.compareAt,
        acceptedUnitPrice: money(e.newAcceptedPrice ?? e.item.accepted_price, currency),
        acceptedTermsVersion: e.item.accepted_terms_version,
        lineTotal: money(e.unitPrice.amount * quantity, e.unitPrice.currency),
        state,
        includedInCheckout: state === 'ok',
        notices,
        addedAt: iso(e.item.added_at),
      };
      lines.push({ eval: e, state, open, item });
    }

    const view = await this.buildView(cartRow, lines, groups, quotes, dest, promo);
    return { cart: cartRow, view, lines };
  }

  /** Other active offers for the same variant and condition (count and lowest price), for blocked lines offers gave none for */
  private async hintAlternatives(lines: LineEval[]) {
    if (!lines.length) return;
    const offersApi = this.ctx.use('offers');
    const groups = new Map<string, LineEval[]>();
    for (const l of lines) {
      const key = `${l.item.product_id}:${l.item.variant_id}:${l.condition}`;
      groups.set(key, [...(groups.get(key) ?? []), l]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        const first = group[0]!;
        const condition = first.condition === 'new' ? 'new' : first.condition === 'refurbished' ? 'refurbished' : 'used';
        try {
          const cmp = await offersApi.compareOffers(first.item.product_id, { variantId: first.item.variant_id, condition, postalCode: undefined });
          for (const l of group) {
            const others = (cmp.offers ?? []).filter((o) => o.offerId !== l.item.offer_id && o.status === 'active' && o.condition === l.condition);
            if (others.length) l.alternatives = { count: others.length, lowestPrice: others.reduce((m, o) => (o.price.amount < m.amount ? o.price : m), others[0]!.price) };
          }
        } catch (err) {
          if (!isNotImplemented(err)) this.ctx.log.debug({ err }, 'cart: alternatives hint unavailable');
        }
      }),
    );
  }

  /* ================================================================ promotions */

  private async evaluatePromotions(
    cart: CartRow,
    eligible: LineEval[],
    quotes: Map<string, PackageQuote>,
    coupons: StoredCoupon[],
    dest: CartDestination | null,
    o: CheckOptions,
  ): Promise<PromoOutcome> {
    const out: PromoOutcome = { previews: [], discounts: [], shippingDiscount: new Map(), freeShipping: new Set(), uncovered: [], couponsChanged: false, nextCoupons: coupons };
    const api = this.ctx.tryUse('promotions');
    const currency = cart.currency;
    const titleOf = (e: LineEval) => e.product.product?.title ?? 'Item';
    const ev =
      api && eligible.length
        ? await this.optional('promotions.evaluateCart', () =>
            api.evaluateCart({
              customerId: o.customerId ?? null,
              guestSessionId: o.guestSessionId ?? null,
              region: dest?.region ?? null,
              lines: eligible.map((e) => ({
                lineId: e.item.id,
                offerId: e.item.offer_id,
                productId: e.item.product_id,
                variantId: e.item.variant_id,
                // never '' or null: Official Store lines carry the Official Store's seller id
                sellerId: e.item.owner_type === 'official' || !e.item.seller_id ? OFFICIAL_STORE_ID : e.item.seller_id,
                officialStore: e.item.owner_type === 'official',
                categoryId: e.product.product?.categoryId ?? null,
                brandId: e.product.product?.brand?.id ?? null,
                quantity: e.item.quantity,
                unitPrice: e.regularPrice,
                packageId: e.packageKey,
              })),
              codes: coupons.map((c) => c.code),
              shipping: Object.fromEntries([...quotes].filter(([, q]) => q.delivery).map(([k, q]) => [k, q.delivery!.shipping])),
              at: iso(this.now()),
            }),
          )
        : undefined;
    if (!ev) {
      out.previews = coupons.map((c) => ({
        code: c.code,
        status: 'rejected',
        amount: null,
        label: c.code,
        fundedBy: null,
        reason: eligible.length ? "Coupons can't be checked right now. We'll check again at checkout." : 'Add an item that can be checked out to use this code.',
        coverage: [],
        notCovered: [],
      }));
      return out;
    }
    const markdowns = new Set(eligible.map((e) => e.facts.promo?.campaignId).filter((x): x is string => !!x));
    const fundingOf = (campaignId: string) => {
      let platform = 0;
      let seller = 0;
      for (const l of ev.lines) for (const a of l.allocations) if (a.campaignId === campaignId) {
        platform += a.platformPart.amount;
        seller += a.sellerPart.amount;
      }
      return platform > 0 && seller > 0 ? 'shared' : seller > 0 ? 'seller' : 'platform';
    };
    for (const a of ev.applied) {
      if (markdowns.has(a.campaignId)) continue;
      out.discounts.push({ code: a.code ?? null, label: a.label, amount: a.amount, fundedBy: fundingOf(a.campaignId) });
    }
    for (const p of ev.packages) {
      out.shippingDiscount.set(p.packageId, p.shippingDiscount.amount);
      if (p.freeShipping) out.freeShipping.add(p.packageId);
    }
    const next: StoredCoupon[] = [];
    for (const c of coupons) {
      const applied = ev.applied.find((a) => a.code && a.code.toUpperCase() === c.code.toUpperCase());
      const rejected = ev.rejected.find((r) => r.code.toUpperCase() === c.code.toUpperCase());
      if (applied) {
        const coverage = applied.coversLineIds
          .map((id) => {
            const e = eligible.find((x) => x.item.id === id);
            if (!e) return null;
            const amount = ev.lines.find((l) => l.lineId === id)?.allocations.filter((x) => x.campaignId === applied.campaignId || (x.code && x.code.toUpperCase() === c.code.toUpperCase())).reduce((s, x) => s + x.amount.amount, 0) ?? 0;
            return { itemId: id, title: titleOf(e), amount: money(amount, currency) };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
        const notCovered = couponNotCovered(applied.coversLineIds, eligible.map((e) => ({ lineId: e.item.id, title: titleOf(e) })), ev).map((x) => ({ itemId: x.lineId, title: x.title, reason: x.reason }));
        out.previews.push({ code: c.code, status: 'applied', amount: applied.amount, label: applied.label, fundedBy: fundingOf(applied.campaignId), reason: null, coverage, notCovered });
        for (const id of c.covered) if (!applied.coversLineIds.includes(id) && eligible.some((e) => e.item.id === id)) out.uncovered.push([id, c.code]);
        next.push({ code: c.code, covered: [...applied.coversLineIds].sort() });
      } else {
        const signIn = rejected?.reason === 'sign_in_required';
        out.previews.push({
          code: c.code,
          status: signIn ? 'needs_sign_in' : 'rejected',
          amount: null,
          label: c.code,
          fundedBy: null,
          reason: rejected?.message ?? "This code can't be used on your cart.",
          coverage: [],
          notCovered: [],
        });
        for (const id of c.covered) if (eligible.some((e) => e.item.id === id)) out.uncovered.push([id, c.code]);
        next.push({ code: c.code, covered: [] });
      }
    }
    out.couponsChanged = JSON.stringify(next) !== JSON.stringify(coupons);
    out.nextCoupons = next;
    return out;
  }

  /* ================================================================ the view */

  private async buildView(cart: CartRow, lines: CheckedLine[], groups: Map<string, LineEval[]>, quotes: Map<string, PackageQuote>, dest: CartDestination | null, promo: PromoOutcome): Promise<CartView> {
    const currency = cart.currency;
    const ownerKind = cart.owner_kind;
    const byItem = new Map(lines.map((l) => [l.item.id, l]));
    const packages: CartPackage[] = [];
    const shippingLines: PackageShippingLine[] = [];
    const keys = [...groups.keys()].filter((k) => groups.get(k)!.some((e) => byItem.has(e.item.id)));
    keys.forEach((key, idx) => {
      const pkgLines = groups.get(key)!.map((e) => byItem.get(e.item.id)).filter((l): l is CheckedLine => !!l);
      const q = quotes.get(key)!;
      const eligible = pkgLines.filter((l) => l.state === 'ok');
      const itemsValue = eligible.reduce((s, l) => s + l.item.lineTotal.amount, 0);
      let delivery = pkgLines.every((l) => l.state === 'unavailable') ? null : q.delivery;
      if (delivery && (promo.freeShipping.has(key) || promo.shippingDiscount.get(key))) {
        const off = promo.freeShipping.has(key) ? delivery.shipping.amount : Math.min(promo.shippingDiscount.get(key) ?? 0, delivery.shipping.amount);
        const amount = delivery.shipping.amount - off;
        delivery = { ...delivery, shipping: money(amount, delivery.shipping.currency), free: amount === 0, amountToFreeShipping: amount === 0 ? null : delivery.amountToFreeShipping };
      }
      const shippingAmount = delivery && eligible.length ? delivery.shipping.amount : 0;
      const first = pkgLines[0]!;
      if (delivery && eligible.length) shippingLines.push({ packageKey: key, sellerName: first.item.seller.name, amount: money(shippingAmount, currency), free: delivery.free });
      packages.push({
        key,
        label: `Package ${idx + 1} of ${keys.length}`,
        seller: first.item.seller,
        fulfilledBy: first.eval.fulfilledBy,
        shipsFrom: first.eval.shipsFrom,
        items: pkgLines.map((l) => l.item),
        delivery,
        returnTerms: [...new Set(pkgLines.map((l) => l.eval.returnTerms).filter(Boolean))].join(' ') || 'Return terms are shown at checkout.',
        subtotal: money(itemsValue + shippingAmount, currency),
        notShippable: q.allNotShippable,
      });
    });

    const all = lines.map((l) => l.item);
    const eligible = all.filter((i) => i.includedInCheckout);
    const attentionLines = all.filter((i) => i.state !== 'ok');
    const needsAttention = all.filter((i) => i.state === 'needs_attention');
    const itemsSubtotal = eligible.reduce((s, i) => s + i.lineTotal.amount, 0);
    const discountTotal = promo.discounts.reduce((s, d) => s + d.amount.amount, 0);
    const shippingTotal = shippingLines.reduce((s, l) => s + l.amount.amount, 0);
    const blockers: string[] = [];
    if (!all.length) blockers.push('Your cart is empty.');
    else if (!eligible.length) blockers.push("None of the items in your cart can be checked out right now.");
    if (needsAttention.length) blockers.push(`${plural(needsAttention.length, 'item')} changed since you added ${needsAttention.length === 1 ? 'it' : 'them'}. Review the ${needsAttention.length === 1 ? 'change' : 'changes'} to continue.`);
    const sellers = new Set(all.map((i) => `${i.seller.ownerType}:${i.seller.id ?? ''}`));
    const owner = cart.owner_kind === 'customer' ? { kind: 'customer' as const, customerId: cart.customer_id! } : { kind: 'guest' as const, guestSessionId: cart.guest_session_id! };
    return {
      id: cart.id,
      owner: ownerKind,
      currency,
      itemCount: all.reduce((s, i) => s + i.quantity, 0),
      sellerCount: sellers.size,
      packageCount: packages.length,
      destination: dest,
      packages,
      attention: attentionLines.length
        ? {
            count: attentionLines.length,
            title: `${plural(attentionLines.length, 'item')} ${attentionLines.length === 1 ? 'needs' : 'need'} your attention`,
            message: 'Prices or availability changed since you added them. Review each item below; nothing else in your cart has changed.',
          }
        : null,
      coupons: promo.previews,
      totals: {
        itemCount: eligible.reduce((s, i) => s + i.quantity, 0),
        itemsSubtotal: money(itemsSubtotal, currency),
        discounts: promo.discounts,
        shippingByPackage: shippingLines,
        shippingTotal: money(shippingTotal, currency),
        taxNote: dest ? 'Tax is calculated at checkout.' : 'Calculated after you enter an address. Shipping and tax depend on your address.',
        total: money(Math.max(0, itemsSubtotal - discountTotal + shippingTotal), currency),
        excludedItemCount: all.length - eligible.length,
      },
      checkoutReady: eligible.length > 0 && needsAttention.length === 0,
      checkoutBlockers: blockers,
      retentionNote: await this.retentionNote(ownerKind),
      savedForLaterCount: await this.repo.countSaved(owner),
      checkedAt: iso(cart.checked_at ?? this.now()),
    };
  }

  /** The view of an owner without a cart: nothing is created */
  async emptyView(ownerKind: 'customer' | 'guest', savedForLaterCount: number, dest: CartDestination | null = null): Promise<CartView> {
    const currency = this.ctx.config.market.currency;
    const zero = money(0, currency);
    return {
      id: null,
      owner: ownerKind,
      currency,
      itemCount: 0,
      sellerCount: 0,
      packageCount: 0,
      destination: dest,
      packages: [],
      attention: null,
      coupons: [],
      totals: { itemCount: 0, itemsSubtotal: zero, discounts: [], shippingByPackage: [], shippingTotal: zero, taxNote: 'Calculated after you enter an address. Shipping and tax depend on your address.', total: zero, excludedItemCount: 0 },
      checkoutReady: false,
      checkoutBlockers: ['Your cart is empty.'],
      retentionNote: await this.retentionNote(ownerKind),
      savedForLaterCount,
      checkedAt: iso(this.now()),
    };
  }
}

interface PromoOutcome {
  previews: CouponPreview[];
  discounts: DiscountLine[];
  shippingDiscount: Map<string, number>;
  freeShipping: Set<string>;
  /** [itemId, code]: a code that covered the line before and no longer does */
  uncovered: [string, string][];
  couponsChanged: boolean;
  nextCoupons: StoredCoupon[];
}

/** '$35' for whole amounts, '$34.50' otherwise */
function formatShort(m: Money) {
  const whole = m.amount % 100 === 0;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(m.amount / 100);
}
