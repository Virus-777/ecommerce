/**
 * Cart evaluation (pure): markdowns and flash prices set the unit price; then coupons per seller package
 * (couponsPerSellerPackage) honouring stacking flags and exclusive groups; then free shipping per package.
 * Every allocation is split into platformPart and sellerPart. Deterministic for the same input.
 */
import type * as common from '../../../spec/common.js';
import type { AppliedPromotion, CartLineInput, DiscountAllocation, LineDiscount, PackageDiscount, RejectedCode, SkippedPromotion } from '../../../spec/promotions.js';
import {
  allocateByValue,
  COUPON_KINDS,
  customerCheck,
  discountLabel,
  isRunning,
  m,
  markdownOff,
  moneyLabel,
  needsConsent,
  pctOf,
  scopeCheck,
  scopeLabel,
  splitFunding,
  type CampaignModel,
  type OfferAttrs,
} from './rules.js';

export type Reason = RejectedCode['reason'];

export interface EvalLine extends CartLineInput {
  attrs: OfferAttrs;
}

export interface FlashState {
  dealPrice: number;
  dealStock: number;
  claimed: number;
  reserved: number;
  purchaseLimit: number;
  state: string;
}

/** A markdown or flash campaign that covers a line (scope, eligible offers and consent already checked) */
export interface PriceOption {
  campaign: CampaignModel;
  flash?: FlashState | null;
  consentBps?: number | null;
}

export interface CodeInfo {
  id: string;
  code: string;
  kind: 'shared' | 'unique';
  maxRedemptions: number | null;
  redemptions: number;
  active: boolean;
  assignedCustomerId: string | null;
}

export interface CouponCandidate {
  campaign: CampaignModel;
  source: 'automatic' | 'code' | 'clipped';
  /** The code as the customer typed it (code source) or the shared/assigned code */
  code: string | null;
  codeInfo: CodeInfo | null;
}

/** Accepted sellers of a consent-based platform campaign: seller id → consented platform share and offers */
export type ConsentMap = Map<string, Map<string, { platformBps: number; offerIds: ReadonlySet<string> }>>;

export interface EvalInput {
  at: Date;
  currency: string;
  customerId: string | null;
  /** Whose usage counts for per-customer limits: the customer id, or a guest's email (or session) key */
  customerKey?: string | null;
  signedIn: boolean;
  /** A guest gave a contact email (new-customer offers can be checked for guests only then) */
  guestEmail?: boolean;
  isNewCustomer: boolean | null;
  region: string | null;
  couponsPerPackage: number;
  lines: EvalLine[];
  /** packageId → shipping charge (minor units) */
  shipping: Record<string, number> | null;
  priceOptions: Map<string, PriceOption[]>;
  coupons: CouponCandidate[];
  /** Codes refused before evaluation (unknown codes) */
  rejected: RejectedCode[];
  /** This customer's uses and units per campaign */
  usage: Map<string, { uses: number; units: number }>;
  consents: ConsentMap;
}

export interface HoldLine {
  lineId: string;
  offerId: string;
  sellerId: string;
  quantity: number;
  amount: number;
  platform: number;
  seller: number;
}

/** What a reservation must hold per campaign */
export interface Hold {
  campaignId: string;
  kind: string;
  codeId: string | null;
  code: string | null;
  amount: number;
  platform: number;
  seller: number;
  units: number;
  lines: HoldLine[];
  flash: { offerId: string; qty: number }[];
  perCustomer: number | null;
  perCustomerUnits: number | null;
}

export interface EvalOutput {
  lines: LineDiscount[];
  packages: PackageDiscount[];
  applied: AppliedPromotion[];
  rejected: RejectedCode[];
  skipped: SkippedPromotion[];
  totals: { total: common.Money; platform: common.Money; seller: common.Money };
  holds: Hold[];
}

const SOURCE_RANK = { code: 0, clipped: 1, automatic: 2 } as const;

interface LineState {
  line: EvalLine;
  regular: number;
  unit: number;
  value: number;
  /** value left for coupons */
  remaining: number;
  allocations: DiscountAllocation[];
  hasFlash: boolean;
  hasSellerMarkdown: boolean;
  purchaseLimit: number | null;
  limitExceeded: boolean;
  /** Units at the deal price (the rest of the line stays at the regular price) */
  discounted: number;
}

interface Accepted {
  campaign: CampaignModel;
  lineIds: string[];
  packages: Set<string>;
}

export function evaluate(input: EvalInput): EvalOutput {
  const cur = input.currency;
  const who = { signedIn: input.signedIn, guestEmail: input.guestEmail ?? false, isNewCustomer: input.isNewCustomer, region: input.region };
  /** Per-customer limits count for this key (customer, or guest email / session) */
  const limitedKey = input.customerKey ?? input.customerId;
  const skippedMap = new Map<string, SkippedPromotion>();
  const skip = (c: CampaignModel, reason: SkippedPromotion['reason'], message: string) => {
    if (!skippedMap.has(c.id)) skippedMap.set(c.id, { campaignId: c.id, label: c.name, reason, message });
  };
  const budgetReason = (c: CampaignModel): 'budget_insufficient' | 'budget_exhausted' => (budgetLeft(c) > 0 ? 'budget_insufficient' : 'budget_exhausted');
  const holds = new Map<string, Hold>();
  const pendingBudget = new Map<string, number>();
  const pendingUnits = new Map<string, number>();
  const pendingDeal = new Map<string, number>();
  const usageOf = (id: string) => input.usage.get(id) ?? { uses: 0, units: 0 };
  const budgetLeft = (c: CampaignModel) => (c.limits.budget ? c.limits.budget.amount - c.budgetUsed - (pendingBudget.get(c.id) ?? 0) : Infinity);
  const holdOf = (c: CampaignModel, codeId: string | null, code: string | null): Hold => {
    let h = holds.get(c.id);
    if (!h) {
      h = { campaignId: c.id, kind: c.kind, codeId, code, amount: 0, platform: 0, seller: 0, units: 0, lines: [], flash: [], perCustomer: c.limits.perCustomer ?? null, perCustomerUnits: c.limits.perCustomerUnits ?? null };
      holds.set(c.id, h);
    }
    return h;
  };
  const addToHold = (h: Hold, hl: HoldLine) => {
    h.amount += hl.amount;
    h.platform += hl.platform;
    h.seller += hl.seller;
    h.lines.push(hl);
    pendingBudget.set(h.campaignId, (pendingBudget.get(h.campaignId) ?? 0) + hl.amount);
  };
  const appliedMap = new Map<string, AppliedPromotion>();
  const apply = (c: CampaignModel, source: AppliedPromotion['source'], code: string | null, label: string, amount: number, lineIds: string[]) => {
    const a = appliedMap.get(c.id) ?? { campaignId: c.id, code, label, amount: m(0, cur), coversLineIds: [], source };
    a.amount = m(a.amount.amount + amount, cur);
    for (const id of lineIds) if (!a.coversLineIds.includes(id)) a.coversLineIds.push(id);
    appliedMap.set(c.id, a);
  };
  const consentFor = (c: CampaignModel, a: OfferAttrs): { ok: boolean; bps: number | null } => {
    if (a.official || !needsConsent(c)) return { ok: true, bps: null };
    const s = a.sellerId ? input.consents.get(c.id)?.get(a.sellerId) : undefined;
    return s && s.offerIds.has(a.offerId) ? { ok: true, bps: s.platformBps } : { ok: false, bps: null };
  };

  /* ---------------------------------------------------------------- 1. unit prices: markdowns and flash */
  const states: LineState[] = [];
  for (const line of input.lines) {
    const regular = line.unitPrice.amount;
    const qty = line.quantity;
    const st: LineState = { line, regular, unit: regular, value: regular * qty, remaining: regular * qty, allocations: [], hasFlash: false, hasSellerMarkdown: false, purchaseLimit: null, limitExceeded: false, discounted: Math.max(qty, 0) };
    states.push(st);
    if (qty <= 0) continue;
    let limitHit: number | null = null;
    // units: how many of the line's units get this price (decision P2: the rest stays at the regular price)
    const cands: { opt: PriceOption; perUnit: number; limit: number | null; units: number }[] = [];
    for (const opt of input.priceOptions.get(line.lineId) ?? []) {
      const c = opt.campaign;
      if (!isRunning(c, input.at) || !customerCheck(c.eligibility, who).ok) continue;
      if (c.limits.usageCap != null && c.usageCount >= c.limits.usageCap) {
        skip(c, 'usage_limit', `${c.name} has been fully used. The regular price applies.`);
        continue;
      }
      if (c.limits.perCustomer != null && limitedKey && usageOf(c.id).uses >= c.limits.perCustomer) {
        skip(c, 'usage_limit', `You've already used ${c.name} the maximum number of times. The regular price applies.`);
        continue;
      }
      // flash purchase limits count per item (campaign:offer), markdown unit limits per campaign
      const unitKey = c.kind === 'flash_sale' ? `${c.id}:${line.offerId}` : c.id;
      const usedUnits = (input.usage.get(unitKey)?.units ?? 0) + (pendingUnits.get(unitKey) ?? 0);
      let perUnit: number;
      let limit: number | null;
      let units = qty;
      if (c.kind === 'flash_sale') {
        const f = opt.flash;
        if (!f || (f.state !== 'active' && f.state !== 'sold_out')) continue;
        const left = f.dealStock - f.claimed - f.reserved - (pendingDeal.get(unitKey) ?? 0);
        if (f.state === 'sold_out' || left <= 0) {
          skip(c, 'deal_sold_out', `The flash deal ${c.name} is sold out. The regular price applies.`);
          continue;
        }
        units = Math.min(units, left);
        limit = f.purchaseLimit;
        perUnit = Math.max(0, regular - f.dealPrice);
      } else {
        limit = c.limits.perCustomerUnits ?? null;
        perUnit = markdownOff(c.discount, regular);
      }
      if (perUnit <= 0) continue;
      if (limit != null && usedUnits + units > limit) {
        limitHit = limitHit === null ? limit : Math.min(limitHit, limit);
        units = Math.max(0, limit - usedUnits);
      }
      if (units <= 0) {
        skip(c, 'purchase_limit', `${c.name} is limited to ${limit} per customer at the deal price. The regular price applies.`);
        continue;
      }
      // all or nothing (decision P3): never a partial discount on the budget that is left
      if (perUnit * units > budgetLeft(c)) {
        skip(c, budgetReason(c), budgetReason(c) === 'budget_exhausted' ? `${c.name} has run out. The regular price applies.` : `${c.name} doesn't have enough budget left for your cart. The regular price applies.`);
        continue;
      }
      cands.push({ opt, perUnit, limit, units });
    }
    cands.sort(
      (a, b) =>
        b.perUnit * b.units - a.perUnit * a.units ||
        Number(b.opt.campaign.kind === 'flash_sale') - Number(a.opt.campaign.kind === 'flash_sale') ||
        a.opt.campaign.endsAt.getTime() - b.opt.campaign.endsAt.getTime() ||
        a.opt.campaign.id.localeCompare(b.opt.campaign.id),
    );
    let chosen = cands.slice(0, 1);
    // a platform markdown that combines with seller markdowns applies on top of the seller's price
    const sellerMd = cands.find((x) => x.opt.campaign.kind === 'markdown' && x.opt.campaign.ownerKind === 'seller');
    const platMd = cands.find((x) => x.opt.campaign.kind === 'markdown' && x.opt.campaign.ownerKind === 'platform' && x.opt.campaign.stacking.withSellerMarkdowns);
    if (sellerMd && platMd && sellerMd.units === platMd.units) {
      const second = markdownOff(platMd.opt.campaign.discount, regular - sellerMd.perUnit);
      const best = chosen[0] ? chosen[0].perUnit * chosen[0].units : 0;
      if ((sellerMd.perUnit + second) * sellerMd.units > best && second > 0) chosen = [sellerMd, { ...platMd, perUnit: second }];
    }
    if (!chosen.length) {
      if (limitHit !== null) {
        st.purchaseLimit = limitHit;
        st.limitExceeded = true;
        st.discounted = 0;
      }
      continue;
    }
    const units = chosen[0]!.units;
    for (const ch of chosen) {
      const c = ch.opt.campaign;
      const amount = ch.perUnit * units;
      const split = splitFunding(amount, c, line.attrs, ch.opt.consentBps);
      st.unit -= ch.perUnit;
      st.allocations.push({ campaignId: c.id, code: null, label: c.kind === 'flash_sale' ? `Flash deal: ${c.name}` : c.name, amount: m(amount, cur), platformPart: m(split.platform, cur), sellerPart: m(split.seller, cur) });
      if (ch.limit != null) st.purchaseLimit = st.purchaseLimit === null ? ch.limit : Math.min(st.purchaseLimit, ch.limit);
      if (c.kind === 'flash_sale') st.hasFlash = true;
      if (c.kind === 'markdown' && c.ownerKind === 'seller') st.hasSellerMarkdown = true;
      const h = holdOf(c, null, null);
      h.units += units;
      const unitKey = c.kind === 'flash_sale' ? `${c.id}:${line.offerId}` : c.id;
      pendingUnits.set(unitKey, (pendingUnits.get(unitKey) ?? 0) + units);
      if (c.kind === 'flash_sale') {
        h.flash.push({ offerId: line.offerId, qty: units });
        pendingDeal.set(unitKey, (pendingDeal.get(unitKey) ?? 0) + units);
      }
      addToHold(h, { lineId: line.lineId, offerId: line.offerId, sellerId: line.sellerId, quantity: units, amount, platform: split.platform, seller: split.seller });
      apply(c, 'automatic', null, c.kind === 'flash_sale' ? `Flash deal: ${c.name}` : c.name, amount, [line.lineId]);
    }
    st.discounted = units;
    st.limitExceeded = units < qty;
    st.value = st.unit * units + regular * (qty - units);
    st.remaining = st.value;
  }
  const orderValue = states.reduce((a, s) => a + s.value, 0);
  const packageValue = (pkg: string) => states.filter((s) => s.line.packageId === pkg).reduce((a, s) => a + s.value, 0);

  /* ---------------------------------------------------------------- 2. coupons */
  const rejected: RejectedCode[] = [...input.rejected];
  const reject = (cand: CouponCandidate, reason: Reason, message: string, details: string[] = []) => {
    if (cand.source !== 'code' || !cand.code) {
      // an automatic or clipped campaign that matched the cart but could not be applied says why
      if (reason === 'budget_insufficient' || reason === 'budget_exhausted' || reason === 'usage_limit') skip(cand.campaign, reason, message);
      return;
    }
    if (rejected.some((r) => r.code.toUpperCase() === cand.code!.toUpperCase())) return;
    rejected.push({ code: cand.code, reason, message, details });
  };

  // one candidate per campaign: the strongest source wins; extra codes of an applied campaign are per-order rejections
  const sorted = [...input.coupons].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.campaign.id.localeCompare(b.campaign.id));
  const perCampaign = new Map<string, CouponCandidate>();
  for (const cand of sorted) {
    if (perCampaign.has(cand.campaign.id)) {
      reject(cand, 'per_order_limit', 'Only one code of this coupon can be used per order.');
      continue;
    }
    perCampaign.set(cand.campaign.id, cand);
  }

  /** Checks that do not depend on the cart contents */
  const standalone = (cand: CouponCandidate): { ok: true } | { ok: false; reason: Reason; message: string } => {
    const c = cand.campaign;
    const info = cand.codeInfo;
    if (info && !info.active) return { ok: false, reason: 'expired', message: 'This code is no longer active.' };
    if (info?.assignedCustomerId && info.assignedCustomerId !== input.customerId) {
      return input.customerId ? { ok: false, reason: 'customer_not_eligible', message: 'This code belongs to another account.' } : { ok: false, reason: 'sign_in_required', message: 'Sign in to use this code.' };
    }
    if (['draft', 'in_review', 'changes_requested', 'approved'].includes(c.status)) return { ok: false, reason: 'not_found', message: "We couldn't find this code." };
    if (c.status === 'ended' || c.status === 'cancelled' || input.at.getTime() >= c.endsAt.getTime()) return { ok: false, reason: 'expired', message: 'This coupon has ended.' };
    if (c.status === 'paused') return { ok: false, reason: 'expired', message: "This coupon isn't available right now." };
    if (input.at.getTime() < c.startsAt.getTime()) return { ok: false, reason: 'not_started', message: `This coupon starts on ${c.startsAt.toISOString().slice(0, 10)}.` };
    const who2 = customerCheck(c.eligibility, who);
    if (!who2.ok) return { ok: false, reason: who2.reason, message: who2.message };
    if (c.limits.usageCap != null && c.usageCount >= c.limits.usageCap) return { ok: false, reason: 'usage_limit', message: 'This coupon has been fully used.' };
    if (info?.maxRedemptions != null && info.redemptions >= info.maxRedemptions) return { ok: false, reason: 'usage_limit', message: 'This code has already been used.' };
    if (c.limits.perCustomer != null && limitedKey && usageOf(c.id).uses >= c.limits.perCustomer) {
      return { ok: false, reason: 'usage_limit', message: c.limits.perCustomer === 1 ? "You've already used this coupon." : `You've used this coupon ${c.limits.perCustomer} times, the limit per customer.` };
    }
    if (c.limits.budget && c.budgetUsed >= c.limits.budget.amount) return { ok: false, reason: 'budget_exhausted', message: 'This coupon has run out.' };
    return { ok: true };
  };

  /** Lines a coupon covers, and the lines excluded only by stacking rules */
  const coverage = (c: CampaignModel) => {
    const covered: LineState[] = [];
    const stackBlocked: LineState[] = [];
    for (const s of states) {
      if (s.line.quantity <= 0 || s.value <= 0) continue;
      if (!scopeCheck(c, s.line.attrs).ok || !consentFor(c, s.line.attrs).ok) continue;
      const platformCoupon = c.ownerKind === 'platform';
      if ((s.hasFlash && !c.stacking.withFlashSalePrices) || (platformCoupon && s.hasSellerMarkdown && !c.stacking.withSellerMarkdowns)) stackBlocked.push(s);
      else covered.push(s);
    }
    return { covered, stackBlocked };
  };

  const isFreeShippingOnly = (c: CampaignModel) => c.kind === 'free_shipping' || (c.kind === 'min_spend' && c.discount.freeShipping && !c.discount.percentOffBps && !c.discount.amountOff);
  const couponCands: CouponCandidate[] = [];
  const shippingCands: CouponCandidate[] = [];
  for (const cand of perCampaign.values()) {
    const s = standalone(cand);
    if (!s.ok) {
      // automatic and clipped campaigns are only reported when they match something in the cart
      if (cand.source === 'code' || coverage(cand.campaign).covered.length) reject(cand, s.reason, s.message);
      continue;
    }
    if (isFreeShippingOnly(cand.campaign)) shippingCands.push(cand);
    else if (COUPON_KINDS.includes(cand.campaign.kind)) couponCands.push(cand);
    else reject(cand, 'not_found', "This code can't be used in the cart.");
  }

  const minSpendBase = (c: CampaignModel, lines: LineState[], fallback: 'eligible_items' | 'seller_package') => {
    const scope = c.discount.minSpendScope ?? fallback;
    if (scope === 'order') return orderValue;
    if (scope === 'seller_package') return [...new Set(lines.map((l) => l.line.packageId))].reduce((a, p) => a + packageValue(p), 0);
    return lines.reduce((a, l) => a + l.value, 0);
  };
  const couponAmount = (c: CampaignModel, base: number) => {
    let amount = c.discount.percentOffBps ? pctOf(base, c.discount.percentOffBps) : (c.discount.amountOff?.amount ?? 0);
    if (c.discount.maxDiscountPerOrder) amount = Math.min(amount, c.discount.maxDiscountPerOrder.amount);
    return Math.max(0, Math.min(amount, base));
  };

  const provisional = couponCands.map((cand) => {
    const { covered } = coverage(cand.campaign);
    return { cand, value: couponAmount(cand.campaign, covered.reduce((a, l) => a + l.remaining, 0)) };
  });
  provisional.sort((a, b) => b.value - a.value || SOURCE_RANK[a.cand.source] - SOURCE_RANK[b.cand.source] || a.cand.campaign.id.localeCompare(b.cand.campaign.id));

  const accepted: Accepted[] = [];
  const packageCount = new Map<string, number>();
  const conflict = (c: CampaignModel): CampaignModel | undefined =>
    accepted.find((a) => {
      const o = a.campaign;
      if (c.stacking.exclusiveGroup && c.stacking.exclusiveGroup === o.stacking.exclusiveGroup) return true;
      // a platform coupon that doesn't combine excludes every other coupon; a seller's only excludes platform coupons
      const blocks = (x: CampaignModel, y: CampaignModel) => !x.stacking.withOtherCoupons && (x.ownerKind === 'platform' || y.ownerKind === 'platform');
      return blocks(c, o) || blocks(o, c);
    })?.campaign;

  for (const { cand } of provisional) {
    const c = cand.campaign;
    const { covered, stackBlocked } = coverage(c);
    if (!covered.length) {
      if (stackBlocked.length) {
        reject(cand, 'not_combinable', stackBlocked.some((s) => s.hasFlash) ? "This coupon can't be combined with flash sale prices." : "This coupon can't be combined with the seller's markdown on these items.", stackBlocked.map((s) => s.line.lineId));
      } else {
        const what = scopeLabel(c.scope);
        reject(cand, 'no_eligible_items', `${what && what !== 'Sitewide' ? `Applies only to ${what}.` : 'Applies only to selected items.'} None in your cart qualify.`);
      }
      continue;
    }
    const other = conflict(c);
    if (other) {
      reject(cand, 'not_combinable', `Can't be combined with ${other.name}.`);
      continue;
    }
    const lines = covered.filter((l) => (packageCount.get(l.line.packageId) ?? 0) < input.couponsPerPackage && l.remaining > 0);
    if (!lines.length) {
      reject(cand, 'per_order_limit', input.couponsPerPackage === 1 ? 'One coupon per seller per order. Another coupon already applies to these items.' : `Up to ${input.couponsPerPackage} coupons per seller package.`, covered.map((l) => l.line.lineId));
      continue;
    }
    if (c.discount.minSpend) {
      const base = minSpendBase(c, lines, 'eligible_items');
      if (base < c.discount.minSpend.amount) {
        reject(cand, 'min_spend_not_met', `Spend ${moneyLabel(c.discount.minSpend.amount - base, cur)} more on eligible items to use this coupon (minimum ${moneyLabel(c.discount.minSpend.amount, cur)}).`, lines.map((l) => l.line.lineId));
        continue;
      }
    }
    const amount = couponAmount(c, lines.reduce((a, l) => a + l.remaining, 0));
    if (amount <= 0) {
      reject(cand, 'no_eligible_items', 'Nothing left to discount on the eligible items.');
      continue;
    }
    if (amount > budgetLeft(c)) {
      // all or nothing (decision P3): never a partial discount
      const reason = budgetReason(c);
      reject(cand, reason, reason === 'budget_exhausted' ? 'This coupon has run out.' : `This coupon doesn't have enough budget left to cover your cart (${moneyLabel(amount, cur)}). Nothing was applied.`);
      continue;
    }
    const parts = allocateByValue(amount, lines.map((l) => l.remaining));
    const h = holdOf(c, cand.codeInfo?.id ?? null, cand.code ?? c.code);
    const label = cand.code ? `Coupon ${cand.code.toUpperCase()}` : c.name;
    const coveredIds: string[] = [];
    lines.forEach((l, i) => {
      const part = parts[i]!;
      if (part <= 0) return;
      const split = splitFunding(part, c, l.line.attrs, consentFor(c, l.line.attrs).bps);
      l.remaining -= part;
      l.allocations.push({ campaignId: c.id, code: cand.code ? cand.code.toUpperCase() : null, label, amount: m(part, cur), platformPart: m(split.platform, cur), sellerPart: m(split.seller, cur) });
      addToHold(h, { lineId: l.line.lineId, offerId: l.line.offerId, sellerId: l.line.sellerId, quantity: l.line.quantity, amount: part, platform: split.platform, seller: split.seller });
      coveredIds.push(l.line.lineId);
    });
    const pkgs = new Set(lines.map((l) => l.line.packageId));
    for (const p of pkgs) packageCount.set(p, (packageCount.get(p) ?? 0) + 1);
    accepted.push({ campaign: c, lineIds: coveredIds, packages: pkgs });
    apply(c, cand.source, cand.code ? cand.code.toUpperCase() : null, label, amount, coveredIds);
    // a minimum-spend offer that also gives free shipping does so on the packages it covers
    if (c.discount.freeShipping) shippingCands.push(cand);
  }

  /* ---------------------------------------------------------------- 3. free shipping per package */
  const packagesInCart = [...new Set(states.map((s) => s.line.packageId))].sort();
  const packages: PackageDiscount[] = [];
  const fsFail = new Map<string, { reason: Reason; message: string }>();
  const fsApplied = new Set<string>();
  shippingCands.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || Number(a.campaign.ownerKind !== 'platform') - Number(b.campaign.ownerKind !== 'platform') || a.campaign.id.localeCompare(b.campaign.id));
  for (const pkg of packagesInCart) {
    const pkgLines = states.filter((s) => s.line.packageId === pkg);
    const sellerId = pkgLines[0]!.line.sellerId;
    const charge = input.shipping?.[pkg] ?? null;
    const out: PackageDiscount = { packageId: pkg, sellerId, shippingDiscount: m(0, cur), freeShipping: false, campaignId: null, allocation: null };
    packages.push(out);
    for (const cand of shippingCands) {
      const c = cand.campaign;
      const viaCoupon = accepted.find((a) => a.campaign.id === c.id);
      const lines = viaCoupon ? pkgLines.filter((l) => viaCoupon.lineIds.includes(l.line.lineId)) : pkgLines.filter((l) => l.line.quantity > 0 && scopeCheck(c, l.line.attrs).ok && consentFor(c, l.line.attrs).ok);
      const fail = (reason: Reason, message: string) => {
        if (!fsFail.has(c.id)) fsFail.set(c.id, { reason, message });
      };
      if (!lines.length) {
        fail('no_eligible_items', 'Free shipping applies only to selected items. None in your cart qualify.');
        continue;
      }
      const blocker = accepted.find((a) => a.packages.has(pkg) && a.campaign.id !== c.id && (!a.campaign.stacking.withFreeShipping || !c.stacking.withOtherCoupons));
      if (blocker) {
        fail('not_combinable', `Free shipping can't be combined with ${blocker.campaign.name}.`);
        continue;
      }
      if (!viaCoupon && c.discount.minSpend) {
        const base = minSpendBase(c, lines, 'seller_package');
        if (base < c.discount.minSpend.amount) {
          fail('min_spend_not_met', `Spend ${moneyLabel(c.discount.minSpend.amount - base, cur)} more to get free shipping (minimum ${moneyLabel(c.discount.minSpend.amount, cur)}).`);
          continue;
        }
      }
      if (charge === null) {
        // shipping not chosen yet: the offer qualifies; the amount is known once delivery is chosen
        fsApplied.add(c.id);
        if (!viaCoupon) apply(c, cand.source, cand.code ? cand.code.toUpperCase() : null, `Free shipping: ${c.name}`, 0, lines.map((l) => l.line.lineId));
        out.freeShipping = true;
        out.campaignId = c.id;
        break;
      }
      if (charge > budgetLeft(c)) {
        const reason = budgetReason(c);
        fail(reason, reason === 'budget_exhausted' ? 'This free-shipping offer has run out.' : "This free-shipping offer doesn't have enough budget left for this package.");
        continue;
      }
      const official = lines.every((l) => l.line.attrs.official);
      const split = splitFunding(charge, c, { official }, consentFor(c, lines[0]!.line.attrs).bps);
      const code = cand.code ? cand.code.toUpperCase() : null;
      const label = `Free shipping: ${c.name}`;
      out.shippingDiscount = m(charge, cur);
      out.freeShipping = true;
      out.campaignId = c.id;
      out.allocation = { campaignId: c.id, code, label, amount: m(charge, cur), platformPart: m(split.platform, cur), sellerPart: m(split.seller, cur) };
      if (charge > 0) {
        const h = holdOf(c, cand.codeInfo?.id ?? null, cand.code ?? c.code);
        addToHold(h, { lineId: `package:${pkg}`, offerId: lines[0]!.line.offerId, sellerId, quantity: 0, amount: charge, platform: split.platform, seller: split.seller });
      } else holdOf(c, cand.codeInfo?.id ?? null, cand.code ?? c.code);
      fsApplied.add(c.id);
      apply(c, cand.source, code, viaCoupon ? (appliedMap.get(c.id)?.label ?? label) : label, charge, lines.map((l) => l.line.lineId));
      break;
    }
  }
  for (const cand of shippingCands) {
    if (fsApplied.has(cand.campaign.id) || accepted.some((a) => a.campaign.id === cand.campaign.id)) continue;
    const f = fsFail.get(cand.campaign.id) ?? { reason: 'no_eligible_items' as Reason, message: 'Free shipping applies only to selected items. None in your cart qualify.' };
    reject(cand, f.reason, f.message);
  }

  /* ---------------------------------------------------------------- results */
  const lines: LineDiscount[] = states.map((s) => ({
    lineId: s.line.lineId,
    regularUnitPrice: m(s.regular, cur),
    unitPrice: m(s.unit, cur),
    allocations: s.allocations,
    lineDiscount: m(
      s.allocations.reduce((a, x) => a + x.amount.amount, 0),
      cur,
    ),
    purchaseLimit: s.purchaseLimit,
    limitExceeded: s.limitExceeded,
    discountedQuantity: s.discounted,
  }));
  let total = 0;
  let platform = 0;
  for (const s of states) for (const a of s.allocations) ((total += a.amount.amount), (platform += a.platformPart.amount));
  for (const p of packages) if (p.allocation) ((total += p.allocation.amount.amount), (platform += p.allocation.platformPart.amount));
  const applied = [...appliedMap.values()];
  // keep the label of a coupon's own discount
  for (const a of applied) {
    const c = [...perCampaign.values()].find((x) => x.campaign.id === a.campaignId)?.campaign;
    if (c && !a.label) a.label = discountLabel(c.discount, cur);
  }
  return {
    lines,
    packages,
    applied,
    rejected,
    skipped: [...skippedMap.values()].filter((s) => !appliedMap.has(s.campaignId)),
    totals: { total: m(total, cur), platform: m(platform, cur), seller: m(total - platform, cur) },
    holds: [...holds.values()].filter((h) => h.amount > 0 || h.lines.length || h.flash.length || fsApplied.has(h.campaignId)),
  };
}

