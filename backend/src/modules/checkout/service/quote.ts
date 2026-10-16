/**
 * The quote: line facts (offers, product, return terms), shippability per line, delivery options per
 * package (shipping), discounts and coupons (promotions), store credit (wallet), tax and totals.
 * Every change that can move the total goes through requote(), which bumps quoteVersion when the
 * quote's fingerprint changes.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import type * as offers from '../../../spec/offers.js';
import type * as promotions from '../../../spec/promotions.js';
import type * as shipping from '../../../spec/shipping.js';
import type { CouponResult, DiscountLine, DiscountShare, PackageTotals, QuoteTotals } from '../../../spec/checkout.js';
import {
  CONDITION_LABEL,
  OFFICIAL_SELLER,
  m,
  packageKey,
  shippingOf,
  stableHash,
  type LineInfo,
  type Shippability,
  type StoredCredit,
  type StoredQuote,
} from '../domain/rules.js';
import { couponNotCovered } from '../../cart/contract.js';
import type { LineRow, PackageRow, SessionRow, TaxProvider } from '../ports.js';
import type { Core } from './core.js';

/** Parcel weight per unit until catalog dimensions reach checkout */
const UNIT_WEIGHT_GRAMS = 1000;

export interface Draft {
  session: SessionRow;
  address: common.Address | null;
  lines: LineRow[];
  packages: Map<string, PackageRow>;
  quote: StoredQuote;
  couponCodes: string[];
  credit: StoredCredit | null;
}

export interface OfferFacts {
  offer: offers.Offer | null;
  info: LineInfo | null;
  /** Active offers for the same variant (alternatives), from offers.compareOffers */
  variantOffers: offers.OfferView[];
}

const fundingOf = (a: { platformPart: common.Money; sellerPart: common.Money }): DiscountShare['fundedBy'] =>
  a.platformPart.amount > 0 && a.sellerPart.amount > 0 ? 'shared' : a.sellerPart.amount > 0 ? 'seller' : 'platform';

const FUNDING_NOTE: Record<DiscountShare['fundedBy'], string> = {
  platform: 'Funded by Marketly, so sellers receive their full price.',
  seller: 'Funded by the seller.',
  shared: 'Shared by Marketly and the seller.',
};

export const included = (l: LineRow) => l.status === 'included';
export const byLineOrder = (a: LineRow, b: LineRow) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class Quoter {
  constructor(
    private readonly core: Core,
    private readonly tax: TaxProvider,
  ) {}

  private get ctx() {
    return this.core.ctx;
  }

  async draftOf(session: SessionRow): Promise<Draft> {
    const [lines, packages] = await Promise.all([this.core.repo.listLines(session.id), this.core.repo.listPackages(session.id)]);
    return {
      session,
      address: this.core.address(session),
      lines: lines.sort(byLineOrder),
      packages: new Map(packages.map((p) => [p.package_key, p])),
      quote: this.core.quote(session),
      couponCodes: this.core.couponCodes(session),
      credit: this.core.credit(session),
    };
  }

  /* ================================================================ facts */

  /** Offer, product and return-term facts per offer (batched per product variant) */
  async facts(items: { offerId: string }[]): Promise<Map<string, OfferFacts>> {
    const offersApi = this.ctx.use('offers');
    const ids = [...new Set(items.map((i) => i.offerId))];
    const found = ids.length ? await offersApi.getOffers(ids) : {};
    const out = new Map<string, OfferFacts>();
    const variants = new Map<string, Promise<offers.OfferComparison | null>>();
    const compare = (o: offers.Offer) => {
      const key = `${o.productId}:${o.variantId}`;
      if (!variants.has(key)) {
        variants.set(
          key,
          offersApi.compareOffers(o.productId, { variantId: o.variantId, condition: 'all', postalCode: undefined }).catch((err) => {
            this.ctx.log.debug({ err, productId: o.productId }, 'checkout: product facts unavailable');
            return null;
          }),
        );
      }
      return variants.get(key)!;
    };
    const returnsApi = this.ctx.tryUse('returns');
    const catalogApi = this.ctx.tryUse('catalog');
    await Promise.all(
      ids.map(async (id) => {
        const offer = found[id] ?? null;
        if (!offer) return out.set(id, { offer: null, info: null, variantOffers: [] });
        const cmp = await compare(offer);
        const view = cmp?.offers.find((v) => v.offerId === offer.id) ?? null;
        // decision D-C1: catalog (optional) fills the category when the offer comparison has none
        const categoryId = cmp?.product.categoryId ?? (catalogApi ? ((await this.core.optional('catalog.getProduct', () => catalogApi.getProduct(offer.productId)))?.categoryId ?? null) : null);
        const terms = returnsApi ? await this.core.optional('returns.resolveTerms', () => returnsApi.resolveTerms(offer.ownerType === 'official' ? null : (offer.sellerId ?? null), categoryId, offer.condition)) : undefined;
        const seller =
          offer.ownerType === 'official'
            ? { ...OFFICIAL_SELLER, name: offer.sellerName || OFFICIAL_SELLER.name }
            : {
                ownerType: 'seller' as const,
                id: offer.sellerId ?? null,
                name: view?.seller.name ?? offer.sellerName,
                slug: view?.seller.storeSlug ?? '',
                official: false,
                verified: view?.seller.verified ?? false,
                logo: null,
              };
        const variant = cmp?.variant;
        const shipping = shippingOf(offer);
        const info: LineInfo = {
          title: cmp?.product.title ?? 'Item',
          productSlug: cmp?.product.slug ?? null,
          variantLabel: Object.values(variant?.options ?? {}).join(' · '),
          condition: view?.conditionLabel ?? CONDITION_LABEL[offer.condition] ?? offer.condition,
          image: variant?.images?.[0] ?? cmp?.product.image ?? null,
          seller,
          categoryId,
          brandId: cmp?.product.brand?.id ?? null,
          purchaseLimit: offer.purchaseLimit ?? null,
          returnTerms: {
            summary: terms?.summary ?? offer.returnTerms.summary,
            windowDays: terms?.windowDays ?? offer.returnTerms.windowDays,
            returnShippingPaidBy: offer.returnTerms.freeReturnShipping ? 'seller' : 'depends_on_reason',
            policyVersionId: null,
          },
          responseTargetDays: terms?.responseTargetBusinessDays ?? null,
          // the effective terms (Offer.shipping): Marketly's dispatch and ships-from for a Marketly-fulfilled offer
          dispatch: { businessDays: shipping.dispatch.businessDays, sameDayCutoff: shipping.dispatch.sameDayCutoff ?? null, shipsFrom: shipping.dispatch.shipsFrom },
        };
        out.set(id, { offer, info, variantOffers: (cmp?.offers ?? []).filter((v) => v.status === 'active') });
      }),
    );
    return out;
  }

  /** A new session line for an offer at its current price, with its effective fulfilment (Offer.shipping) */
  lineFrom(sessionId: string, offer: offers.Offer, quantity: number, cartItemId: string | null): LineRow {
    const shipping = shippingOf(offer);
    const sellerId = offer.ownerType === 'official' ? null : (offer.sellerId ?? null);
    return {
      id: newId(),
      session_id: sessionId,
      cart_item_id: cartItemId,
      offer_id: offer.id,
      owner_type: offer.ownerType,
      seller_id: sellerId,
      product_id: offer.productId,
      variant_id: offer.variantId,
      stock_item_id: offer.stockItemId,
      profile_id: shipping.profileId,
      fulfilled_by: shipping.fulfilledBy,
      package_key: packageKey(offer.ownerType, sellerId, shipping.fulfilledBy, shipping.dispatch.shipsFrom),
      quantity,
      unit_price: offer.price.amount,
      terms_version: offer.termsVersion,
      discounts: [],
      tax: 0,
      status: 'included',
    };
  }

  /* ================================================================ shippability and delivery options */

  /** shipping.checkCoverage per line profile: not-shippable lines leave the order (they stay in the cart) */
  async coverage(d: Draft): Promise<void> {
    if (!d.address) return;
    const candidates = d.lines.filter((l) => l.status === 'included' || l.status === 'not_shippable');
    const profiles = [...new Set(candidates.map((l) => l.profile_id))];
    const checks = profiles.length ? await this.ctx.use('shipping').checkCoverage(profiles, d.address) : [];
    const byProfile = new Map(checks.map((c) => [c.profileId, c]));
    for (const l of candidates) {
      const c = byProfile.get(l.profile_id);
      const s: Shippability = c ? { shippable: c.shippable, reason: c.reason ?? null, message: c.message ?? null } : { shippable: true, reason: null, message: null };
      d.quote.shippability[l.id] = s;
      l.status = s.shippable ? 'included' : 'not_shippable';
    }
  }

  /** shipping.quoteOptions per package of included lines; the customer's choice is kept while it is offered */
  async shipping(d: Draft): Promise<void> {
    const groups = new Map<string, LineRow[]>();
    for (const l of d.lines.filter(included)) {
      const group = groups.get(l.package_key);
      if (group) group.push(l);
      else groups.set(l.package_key, [l]);
    }
    const api = this.ctx.use('shipping');
    // packages are quoted at the same time (each touches only its own lines); kept in their first line's order
    const rows = await Promise.all([...groups].map(([key, lines]) => this.quotePackage(d, api, key, lines)));
    d.packages = new Map(rows.filter((r): r is PackageRow => r !== null).map((r) => [r.package_key, r]));
  }

  /** One package's row with its delivery options; null when none of its lines ships to the address */
  private async quotePackage(d: Draft, api: shipping.ShippingPublicApi, key: string, lines: LineRow[]): Promise<PackageRow | null> {
    const first = lines[0]!;
    const info = d.quote.lineInfo[first.id];
    const prev = d.packages.get(key);
    const shipsFrom = info?.dispatch.shipsFrom ?? prev?.ships_from ?? key.split(':').slice(3).join(':');
    const row: PackageRow = {
      session_id: d.session.id,
      package_key: key,
      owner_type: first.owner_type,
      seller_id: first.seller_id,
      fulfilled_by: first.fulfilled_by,
      ships_from: shipsFrom,
      options: [],
      selected_option_id: null,
      selected_option: null,
      return_terms: [...new Set(lines.map((l) => d.quote.lineInfo[l.id]?.returnTerms.summary).filter(Boolean))].join(' ') || 'Returns follow the Marketly return policy.',
    };
    if (d.address) {
      const q: shipping.PackageQuote = await api.quoteOptions({
        ownerType: first.owner_type as 'official' | 'seller',
        sellerId: first.seller_id,
        // marketly_service: Official settings, closures and cutoffs; origin the service location
        fulfilledBy: first.fulfilled_by,
        shipsFrom,
        items: lines.map((l) => {
          const i = d.quote.lineInfo[l.id];
          return {
            lineId: l.id,
            profileId: l.profile_id,
            parcel: { weightGrams: UNIT_WEIGHT_GRAMS },
            quantity: l.quantity,
            value: m(l.unit_price * l.quantity, d.session.currency),
            dispatch: { businessDays: i?.dispatch.businessDays ?? 1, sameDayCutoff: i?.dispatch.sameDayCutoff ?? null, shipsFrom },
          };
        }),
        destination: { postalCode: d.address.postalCode, country: d.address.country, region: d.address.region, address: d.address },
        at: this.core.now().toISOString(),
      });
      const notShippable = new Set(q.shipsToLocation ? q.notShippableLineIds : lines.map((l) => l.id));
      for (const l of lines) {
        if (!notShippable.has(l.id)) continue;
        l.status = 'not_shippable';
        d.quote.shippability[l.id] = { shippable: false, reason: d.quote.shippability[l.id]?.reason ?? 'outside_seller_coverage', message: q.reason ?? d.quote.shippability[l.id]?.message ?? "The seller doesn't ship this item to your address." };
      }
      if (lines.every((l) => notShippable.has(l.id))) return null;
      row.options = q.options as never;
      const keep = prev?.selected_option_id ? q.options.find((o) => o.id === prev.selected_option_id) : undefined;
      const chosen = keep ?? q.default ?? q.options.find((o) => o.isDefault) ?? q.options[0] ?? null;
      row.selected_option_id = chosen?.id ?? null;
      row.selected_option = (chosen ?? null) as never;
    }
    return row;
  }

  /** Keeps package rows in line with the included lines without asking shipping again */
  syncPackages(d: Draft) {
    const keys = new Set(d.lines.filter(included).map((l) => l.package_key));
    for (const k of [...d.packages.keys()]) if (!keys.has(k)) d.packages.delete(k);
  }

  /* ================================================================ pricing */

  async price(d: Draft): Promise<StoredQuote> {
    const cur = d.session.currency;
    const lines = d.lines.filter(included);
    const pkgOrder = [...new Set(lines.map((l) => l.package_key))];
    const quote = d.quote;

    // promotions: markdowns, coupons and free shipping for the included lines
    const promo = this.ctx.tryUse('promotions');
    const shippingByKey = new Map<string, number>();
    for (const k of pkgOrder) {
      const opt = d.packages.get(k)?.selected_option as shipping.DeliveryOption | null | undefined;
      if (opt) shippingByKey.set(k, opt.free ? 0 : opt.price.amount);
    }
    const ev =
      promo && lines.length
        ? await this.core.optional('promotions.evaluateCart', () =>
            promo.evaluateCart({
              customerId: d.session.customer_id,
              guestSessionId: d.session.customer_id ? null : d.session.guest_session_id,
              // guests: per-customer limits and new-customer eligibility key on the contact email
              contactEmail: d.session.customer_id ? null : (this.core.account(d.session).email ?? null),
              region: d.address?.region ?? null,
              lines: lines.map((l) => {
                const info = quote.lineInfo[l.id];
                return {
                  lineId: l.id,
                  offerId: l.offer_id,
                  productId: l.product_id,
                  variantId: l.variant_id,
                  // Official Store lines carry OFFICIAL_STORE_ID (redemption lines need a seller id), never ''
                  sellerId: l.owner_type === 'official' ? OFFICIAL_STORE_ID : (l.seller_id ?? OFFICIAL_STORE_ID),
                  officialStore: l.owner_type === 'official',
                  categoryId: info?.categoryId || null,
                  brandId: info?.brandId ?? null,
                  quantity: l.quantity,
                  unitPrice: m(l.unit_price, cur),
                  packageId: l.package_key,
                };
              }),
              codes: d.couponCodes,
              shipping: Object.fromEntries([...shippingByKey].map(([k, a]) => [k, m(a, cur)])),
              at: this.core.now().toISOString(),
            }),
          )
        : undefined;

    const allocations: Record<string, promotions.DiscountAllocation[]> = {};
    const lineDiscount = new Map<string, number>();
    const evaluatedLines = new Map(ev?.lines.map((x) => [x.lineId, x]));
    for (const l of lines) {
      const allocs = (evaluatedLines.get(l.id)?.allocations ?? []).filter((a) => a.amount.amount > 0);
      allocations[l.id] = allocs;
      const total = Math.min(l.unit_price * l.quantity, allocs.reduce((s, a) => s + a.amount.amount, 0));
      lineDiscount.set(l.id, total);
      l.discounts = allocs.map((a) => ({ code: a.code ?? null, label: a.label, amount: a.amount, fundedBy: fundingOf(a) })) as never;
    }
    for (const l of d.lines.filter((x) => !included(x))) {
      l.discounts = [] as never;
      l.tax = 0;
    }
    const shippingDiscounts: Record<string, number> = {};
    for (const p of ev?.packages ?? []) shippingDiscounts[p.packageId] = Math.min(shippingByKey.get(p.packageId) ?? 0, p.freeShipping ? (shippingByKey.get(p.packageId) ?? 0) : p.shippingDiscount.amount);

    // coupons the customer entered (and clipped ones that applied)
    const coupons: CouponResult[] = [];
    const titleOf = (lineId: string) => quote.lineInfo[lineId]?.title ?? 'Item';
    const appliedCodes = (ev?.applied ?? []).filter((a) => a.code);
    const resultFor = (a: promotions.AppliedPromotion): CouponResult => {
      const parts = lines.flatMap((l) => (allocations[l.id] ?? []).filter((x) => x.campaignId === a.campaignId).map((x) => ({ l, x })));
      const pkgAlloc = (ev?.packages ?? []).filter((p) => p.campaignId === a.campaignId && p.allocation).map((p) => p.allocation!);
      const all = [...parts.map((p) => p.x), ...pkgAlloc];
      const platform = all.reduce((s, x) => s + x.platformPart.amount, 0);
      const seller = all.reduce((s, x) => s + x.sellerPart.amount, 0);
      const fundedBy: DiscountShare['fundedBy'] = platform > 0 && seller > 0 ? 'shared' : seller > 0 ? 'seller' : 'platform';
      const covered = new Set(a.coversLineIds);
      return {
        code: a.code!,
        status: 'applied',
        amount: a.amount,
        label: a.label,
        fundedBy,
        fundingNote: FUNDING_NOTE[fundedBy],
        rejectionCode: null,
        reason: null,
        coverage: lines
          .filter((l) => covered.has(l.id))
          .map((l) => ({ lineId: l.id, title: titleOf(l.id), amount: m(parts.filter((p) => p.l.id === l.id).reduce((s, p) => s + p.x.amount.amount, 0), cur) })),
        notCovered: couponNotCovered(a.coversLineIds, lines.map((l) => ({ lineId: l.id, title: titleOf(l.id) })), ev ?? { lines: [] }),
        otherDiscountsNote: appliedCodes.length > 1 ? 'Your other discount is unchanged.' : null,
      };
    };
    for (const code of d.couponCodes) {
      const applied = appliedCodes.find((a) => a.code!.toUpperCase() === code.toUpperCase());
      if (applied) {
        coupons.push(resultFor(applied));
        continue;
      }
      const rejected = ev?.rejected.find((r) => r.code.toUpperCase() === code.toUpperCase());
      coupons.push({
        code,
        status: rejected?.reason === 'sign_in_required' ? 'needs_sign_in' : 'rejected',
        amount: null,
        label: code,
        fundedBy: null,
        fundingNote: null,
        rejectionCode: rejected?.reason ?? null,
        reason: rejected ? [rejected.message, ...rejected.details].join(' ') : ev ? 'This code does not apply to your order.' : !lines.length ? 'Add an item that can be checked out to use this code.' : "Coupons can't be checked right now. Try again in a moment.",
        coverage: [],
        notCovered: [],
        otherDiscountsNote: appliedCodes.length ? 'Your other discount is unchanged.' : null,
      });
    }
    for (const a of appliedCodes) if (a.source === 'clipped' && !d.couponCodes.some((c) => c.toUpperCase() === a.code!.toUpperCase())) coupons.push(resultFor(a));

    // tax on items after discounts, by destination state
    const calc = await this.tax.calculate({
      destination: d.address,
      currency: cur,
      lines: lines.map((l) => ({ lineId: l.id, amount: Math.max(0, l.unit_price * l.quantity - (lineDiscount.get(l.id) ?? 0)), quantity: l.quantity, offerId: l.offer_id, categoryId: quote.lineInfo[l.id]?.categoryId ?? null })),
    });
    const taxByLine = new Map((calc?.lines ?? []).map((t) => [t.lineId, t.amount]));
    for (const l of lines) l.tax = Math.max(0, taxByLine.get(l.id) ?? 0);
    const tax = calc ? { jurisdiction: calc.jurisdiction, label: calc.label, rate: calc.rate } : null;

    // totals per package and for the order
    const perPackage: PackageTotals[] = [];
    const shippingByPackage: QuoteTotals['shippingByPackage'] = [];
    for (const k of pkgOrder) {
      const pl = lines.filter((l) => l.package_key === k);
      const items = pl.reduce((s, l) => s + l.unit_price * l.quantity, 0);
      const discounts = pl.reduce((s, l) => s + (lineDiscount.get(l.id) ?? 0), 0);
      const ship = Math.max(0, (shippingByKey.get(k) ?? 0) - (shippingDiscounts[k] ?? 0));
      const t = pl.reduce((s, l) => s + l.tax, 0);
      perPackage.push({ items: m(items, cur), discounts: m(discounts, cur), shipping: m(ship, cur), tax: m(t, cur), total: m(items - discounts + ship + t, cur) });
      const opt = d.packages.get(k)?.selected_option as shipping.DeliveryOption | null | undefined;
      shippingByPackage.push({ packageKey: k, sellerName: quote.lineInfo[pl[0]!.id]?.seller.name ?? '', amount: m(ship, cur), free: Boolean(opt) && ship === 0, pending: !opt });
    }
    const sumOf = (f: (p: PackageTotals) => common.Money) => perPackage.reduce((s, p) => s + f(p).amount, 0);
    const beforeCredit = sumOf((p) => p.total);

    // store credit (phase 3): the balance seen now, never more than the total
    let creditApplied = 0;
    const credit = d.credit;
    if (credit?.use && d.session.customer_id) {
      const wallet = this.ctx.tryUse('wallet');
      const bal = wallet ? await this.core.optional('wallet.getBalance', () => wallet.getBalance(d.session.customer_id!)) : undefined;
      credit.available = bal?.available.amount ?? credit.available;
      creditApplied = Math.max(0, Math.min(credit.amount ?? credit.available, credit.available, beforeCredit));
    }

    const discountsByCampaign = new Map<string, DiscountLine>();
    for (const l of lines)
      for (const a of allocations[l.id] ?? []) {
        const prev = discountsByCampaign.get(a.campaignId);
        discountsByCampaign.set(a.campaignId, { code: a.code ?? null, label: a.label, amount: m((prev?.amount.amount ?? 0) + a.amount.amount, cur), fundedBy: prev && prev.fundedBy !== fundingOf(a) ? 'shared' : fundingOf(a) });
      }
    const taxTotal = sumOf((p) => p.tax);
    const totals: QuoteTotals = {
      itemCount: lines.reduce((s, l) => s + l.quantity, 0),
      items: m(sumOf((p) => p.items), cur),
      discounts: [...discountsByCampaign.values()],
      discountTotal: m(sumOf((p) => p.discounts), cur),
      shippingByPackage,
      shippingTotal: m(sumOf((p) => p.shipping), cur),
      tax: tax ? [{ jurisdiction: tax.jurisdiction, label: tax.label, rate: tax.rate, amount: m(taxTotal, cur) }] : [],
      taxTotal: m(taxTotal, cur),
      taxNote: tax ? null : 'Tax is calculated once you enter a delivery address.',
      creditApplied: m(creditApplied, cur),
      total: m(beforeCredit - creditApplied, cur),
      perPackage,
    };

    const next: StoredQuote = {
      ...quote,
      lineAllocations: allocations,
      shippingDiscounts,
      coupons,
      discounts: totals.discounts,
      tax,
      totals,
      evaluation: ev ? { id: ev.evaluationId, validUntil: ev.validUntil } : null,
      fingerprint: '',
    };
    next.fingerprint = stableHash({
      lines: d.lines.map((l) => [l.id, l.offer_id, l.quantity, l.unit_price, l.status, l.package_key]),
      packages: pkgOrder.map((k) => [k, d.packages.get(k)?.selected_option_id ?? null, shippingByKey.get(k) ?? null]),
      address: d.address ? [d.address.line1, d.address.postalCode, d.address.region, d.address.country] : null,
      coupons: coupons.map((c) => [c.code, c.status, c.amount?.amount ?? null]),
      totals: [totals.items.amount, totals.discountTotal.amount, totals.shippingTotal.amount, totals.taxTotal.amount, totals.creditApplied.amount, totals.total.amount],
    });
    return next;
  }

  /* ================================================================ save */

  /**
   * Prices the draft and saves lines, packages and quote in one transaction. quoteVersion moves when
   * anything that changes the total changed. `allowed`: statuses the session must still be in.
   */
  async requote(d: Draft, o: { coverage?: boolean; shipping?: boolean; allowed: string[]; patch?: Partial<SessionRow> }): Promise<SessionRow> {
    if (o.coverage) await this.coverage(d);
    if (o.shipping) await this.shipping(d);
    else this.syncPackages(d);
    const quote = await this.price(d);
    return this.save(d, quote, o.allowed, o.patch ?? {});
  }

  async save(d: Draft, quote: StoredQuote, allowed: string[], patch: Partial<SessionRow>): Promise<SessionRow> {
    const id = d.session.id;
    const now = this.core.now();
    const expires = await this.core.idleExpiry();
    const saved = await this.core.repo.transaction(async (tx) => {
      const locked = await tx.getSession(id, { forUpdate: true });
      if (!locked) throw this.core.notFound();
      if (!allowed.includes(locked.status)) {
        throw new AppError('ILLEGAL_TRANSITION', 'This checkout changed in the meantime. Reload it and try again.', { machine: 'Checkout session', from: locked.status });
      }
      const changed = quote.fingerprint !== this.core.quote(locked).fingerprint;
      await tx.replaceLinesAndPackages(id, d.lines, [...d.packages.values()]);
      return tx.updateSession(id, {
        address: d.address as never,
        coupon_codes: d.couponCodes as never,
        credit: d.credit as never,
        promotion_evaluation_id: quote.evaluation?.id ?? null,
        ...patch,
        ...this.core.quotePatch(quote),
        quote_version: locked.quote_version + (changed ? 1 : 0),
        expires_at: ['open', 'changes_pending'].includes(patch.status ?? locked.status) ? expires : locked.expires_at,
        updated_at: now,
      });
    });
    d.session = saved;
    d.quote = quote;
    return saved;
  }
}

