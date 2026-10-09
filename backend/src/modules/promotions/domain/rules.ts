/**
 * Pure promotion rules (no I/O): money labels, funding split, scope matching, eligibility, earnings,
 * validation of campaign and discount input. Money is integer minor units throughout.
 */
import type * as common from '../../../spec/common.js';
import type { DiscountRule, EarningsImpact, Eligibility, Funding, Limits, ParticipationSettings, DealsPlacement, Scope, StackingRules, TargetRef } from '../../../spec/promotions.js';

export type Kind = DiscountRule['kind'];
export type Status = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'scheduled' | 'live' | 'paused' | 'ended' | 'cancelled';

export const PRICE_KINDS: readonly Kind[] = ['markdown', 'flash_sale'];
export const COUPON_KINDS: readonly Kind[] = ['percent_coupon', 'fixed_coupon', 'min_spend'];
export const SHIPPING_KINDS: readonly Kind[] = ['free_shipping'];
/** Kinds that need the phase-3 feature (launch phase 3 or later) */
export const PHASE3_KINDS: readonly Kind[] = ['bundle', 'quantity_deal'];
export const SELLER_KINDS: readonly Kind[] = ['markdown', 'percent_coupon', 'fixed_coupon', 'min_spend', 'free_shipping'];

/** A campaign decoded from its row and targets: what the rules work on */
export interface CampaignModel {
  id: string;
  ref: string;
  name: string;
  description: string | null;
  ownerKind: 'platform' | 'seller';
  sellerId: string | null;
  kind: Kind;
  discount: DiscountRule;
  code: string | null;
  autoApply: boolean;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  scope: Scope;
  eligibility: Eligibility;
  limits: Limits;
  funding: Funding;
  stacking: StackingRules;
  participation: ParticipationSettings | null;
  deals: DealsPlacement | null;
  terms: string | null;
  status: Status;
  budgetUsed: number;
  usageCount: number;
  currency: string;
  /** Unique codes exist (generated for support or partners) */
  hasUniqueCodes?: boolean;
}

/** What scope rules need to know about an offer (cart line or catalog offer) */
export interface OfferAttrs {
  offerId: string;
  productId: string;
  sellerId: string | null;
  official: boolean;
  /** The product's category and all its ancestors */
  categoryIds: readonly string[];
  brandId: string | null;
}

/* ------------------------------------------------------------------ money and labels */

export const m = (amount: number, currency = 'USD'): common.Money => ({ amount, currency });

/** $10 for whole amounts, $10.50 otherwise */
export function moneyLabel(amount: number, currency = 'USD'): string {
  const whole = amount % 100 === 0;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(amount / 100);
}

/** $100.00 */
export const moneyFull = (amount: number, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);

/** 2000 → 20%, 1250 → 12.5% */
export const bpsLabel = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** Percentage of a minor-unit amount, rounded half up to a whole minor unit */
export const pctOf = (amount: number, bps: number) => Math.round((amount * bps) / 10000);

export function discountLabel(rule: DiscountRule, currency = 'USD'): string {
  const value = rule.percentOffBps ? `${bpsLabel(rule.percentOffBps)} off` : rule.amountOff ? `${moneyLabel(rule.amountOff.amount, currency)} off` : '';
  const cap = rule.maxDiscountPerOrder ? ` (up to ${moneyLabel(rule.maxDiscountPerOrder.amount, currency)})` : '';
  const over = rule.minSpend ? ` over ${moneyLabel(rule.minSpend.amount, currency)}` : '';
  switch (rule.kind) {
    case 'markdown':
      return rule.percentOffBps ? value : rule.amountOff ? `${moneyLabel(rule.amountOff.amount, currency)} off each` : 'Markdown';
    case 'percent_coupon':
    case 'fixed_coupon':
      return `${value}${cap}${over ? ` on orders${over}` : ''}`.trim() || 'Coupon';
    case 'min_spend':
      if (!value && rule.freeShipping) return `Free shipping${over}`;
      return `${value} orders${over}${cap}${rule.freeShipping ? ' + free shipping' : ''}`.trim();
    case 'free_shipping':
      return `Free shipping${over}`;
    case 'flash_sale':
      return 'Flash deal';
    case 'bundle':
      return rule.percentOffBps ? `Bundle: ${value}` : 'Bundle deal';
    case 'quantity_deal':
      return 'Quantity deal';
  }
}

/** Coupon card value: amount and unit, e.g. ($10, off), (15%, off), (Free, shipping) */
export function amountAndUnit(rule: DiscountRule, currency = 'USD'): { amountLabel: string; unitLabel: string } {
  if (rule.percentOffBps) return { amountLabel: bpsLabel(rule.percentOffBps), unitLabel: 'off' };
  if (rule.amountOff) return { amountLabel: moneyLabel(rule.amountOff.amount, currency), unitLabel: 'off' };
  if (rule.kind === 'free_shipping' || rule.freeShipping) return { amountLabel: 'Free', unitLabel: 'shipping' };
  return { amountLabel: 'Deal', unitLabel: 'off' };
}

export function fundingLabel(f: Pick<Funding, 'owner' | 'platformShareBps'>): string {
  if (f.owner === 'platform') return 'Platform funded';
  if (f.owner === 'seller') return 'Seller funded';
  const p = f.platformShareBps ?? 5000;
  return `Shared ${Number((p / 100).toFixed(1))}/${Number(((10000 - p) / 100).toFixed(1))}`;
}

const tzName = (at: Date, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortGeneric' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
  } catch {
    return timeZone;
  }
};

/** e.g. Oct 16 – Oct 25, 2026 PT (the end date is the last day the campaign runs) */
export function periodDisplay(startsAt: Date, endsAt: Date, timeZone: string): string {
  const last = new Date(Math.max(startsAt.getTime(), endsAt.getTime() - 1));
  const part = (d: Date, year: boolean) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  };
  const year = (d: Date) => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(d);
    } catch {
      return String(d.getUTCFullYear());
    }
  };
  const sameYear = year(startsAt) === year(last);
  return `${part(startsAt, !sameYear)} – ${part(last, true)} ${tzName(startsAt, timeZone)}`;
}

/** Date in words in a zone, e.g. Oct 12 */
export function dayLabel(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/* ------------------------------------------------------------------ lifecycle */

/** A campaign applies at `at` when published (scheduled or live) and the period covers `at`. Countdowns use the exact period. */
export const isRunning = (c: Pick<CampaignModel, 'status' | 'startsAt' | 'endsAt'>, at: Date) =>
  (c.status === 'scheduled' || c.status === 'live') && c.startsAt.getTime() <= at.getTime() && at.getTime() < c.endsAt.getTime();

/** Platform campaigns need the seller's consent before seller offers are included, unless the platform funds everything and sellers are not invited */
export const needsConsent = (c: Pick<CampaignModel, 'ownerKind' | 'funding' | 'participation'>) =>
  c.ownerKind === 'platform' && (c.funding.owner !== 'platform' || Boolean(c.participation?.inviteSellers));

/** Platform share in basis points for seller lines of a campaign */
export function platformShareBps(c: Pick<CampaignModel, 'ownerKind' | 'funding'>): number {
  if (c.ownerKind === 'seller') return 0;
  if (c.funding.owner === 'platform') return 10000;
  if (c.funding.owner === 'seller') return 0;
  return clampBps(c.funding.platformShareBps ?? 5000);
}

export const clampBps = (n: number) => Math.min(10000, Math.max(0, Math.round(n)));

/**
 * Who pays a discount allocation. Official Store items: the whole discount is a company cost.
 * Seller discounts: the seller. Platform campaigns: by the funding owner, or the consented share.
 */
export function splitFunding(amount: number, c: Pick<CampaignModel, 'ownerKind' | 'funding'>, line: { official: boolean }, consentedPlatformBps?: number | null): { platform: number; seller: number } {
  if (line.official) return { platform: amount, seller: 0 };
  const bps = c.ownerKind === 'seller' ? 0 : (consentedPlatformBps ?? platformShareBps(c));
  const platform = pctOf(amount, clampBps(bps));
  return { platform, seller: amount - platform };
}

/* ------------------------------------------------------------------ scope */

export function targetMatches(t: TargetRef, a: OfferAttrs): boolean {
  switch (t.kind) {
    case 'category':
      return a.categoryIds.includes(t.id);
    case 'product':
      return a.productId === t.id;
    case 'offer':
      return a.offerId === t.id;
    case 'seller':
      return a.sellerId === t.id;
    case 'brand':
      return a.brandId === t.id;
    case 'official_store':
      return a.official;
  }
}

/** In scope, or the reason it is not */
export function scopeCheck(c: Pick<CampaignModel, 'scope' | 'ownerKind' | 'sellerId'>, a: OfferAttrs): { ok: true } | { ok: false; reason: string; excluded: boolean } {
  if (c.ownerKind === 'seller' && a.sellerId !== c.sellerId) return { ok: false, reason: "Not this seller's offer", excluded: false };
  const inc = c.scope.include ?? [];
  const included = c.scope.mode === 'sitewide' ? !inc.length || inc.some((t) => targetMatches(t, a)) : inc.some((t) => targetMatches(t, a));
  if (!included) return { ok: false, reason: 'Outside the campaign scope', excluded: false };
  const ex = (c.scope.exclude ?? []).find((t) => targetMatches(t, a));
  if (ex) return { ok: false, reason: `Excluded: ${ex.label ?? ex.kind.replace('_', ' ')}`, excluded: true };
  return { ok: true };
}

/** Plain description of what a campaign covers, from its target labels */
export function scopeLabel(scope: Scope): string | null {
  if (scope.mode === 'sitewide' && !scope.include.length) return 'Sitewide';
  const labels = scope.include.map((t) => t.label).filter((l): l is string => Boolean(l));
  return labels.length ? labels.slice(0, 3).join(', ') + (labels.length > 3 ? ` and ${labels.length - 3} more` : '') : null;
}

/* ------------------------------------------------------------------ eligibility of the customer */

export type CustomerReason = 'sign_in_required' | 'customer_not_eligible' | 'region';

export function customerCheck(e: Eligibility, who: { signedIn: boolean; isNewCustomer: boolean | null; region: string | null }): { ok: true } | { ok: false; reason: CustomerReason; message: string } {
  switch (e.audience) {
    case 'everyone':
      return { ok: true };
    case 'signed_in':
      return who.signedIn ? { ok: true } : { ok: false, reason: 'sign_in_required', message: 'Sign in to use this coupon.' };
    case 'new_customers':
      if (!who.signedIn) return { ok: false, reason: 'sign_in_required', message: 'Sign in to use this coupon. It is for new customers.' };
      return who.isNewCustomer === false ? { ok: false, reason: 'customer_not_eligible', message: e.newCustomerRule ? `Only for new customers (${e.newCustomerRule}).` : 'Only for new customers.' } : { ok: true };
    case 'regions': {
      const regions = (e.regions ?? []).map((r) => r.toUpperCase());
      if (who.region && regions.includes(who.region.toUpperCase())) return { ok: true };
      return { ok: false, reason: 'region', message: `Only for delivery to ${regions.join(', ') || 'selected regions'}.` };
    }
  }
}

/* ------------------------------------------------------------------ markdowns */

/** Discount per unit of a markdown at a regular unit price (never more than the price) */
export function markdownOff(rule: DiscountRule, regular: number): number {
  const off = rule.percentOffBps ? pctOf(regular, rule.percentOffBps) : (rule.amountOff?.amount ?? 0);
  return Math.max(0, Math.min(regular, off));
}

/* ------------------------------------------------------------------ allocation */

/**
 * Splits `amount` across lines in proportion to their value (largest remainder, ties by line order) so the
 * parts sum exactly to the amount and no line gets more than its value. `amount` must not exceed the total value.
 */
export function allocateByValue(amount: number, values: readonly number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (amount <= 0 || total <= 0) return values.map(() => 0);
  const capped = Math.min(amount, total);
  const raw = values.map((v) => (capped * v) / total);
  const parts = raw.map((r) => Math.floor(r));
  let rest = capped - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    if (parts[i]! < values[i]!) {
      parts[i]! += 1;
      rest -= 1;
    }
  }
  // any remainder left (only when fractions sat on capped lines) goes to lines with room, in order
  for (let i = 0; rest > 0 && i < parts.length; i++) {
    const room = values[i]! - parts[i]!;
    const add = Math.min(room, rest);
    parts[i]! += add;
    rest -= add;
  }
  return parts;
}

/* ------------------------------------------------------------------ earnings */

export interface EarningsInput {
  basePrice: number;
  discount: number;
  /** Seller share of the discount in basis points */
  sellerShareBps: number;
  feeRateBps: number;
  currency: string;
  isExample: boolean;
  fundingWords: string;
  /** Fee at a price after the seller-funded part (finance), default feeRateBps of it */
  feeAt?: (feeBasis: number) => number;
}

/**
 * What the customer pays and what the seller earns per unit. The fee is charged on the price after the
 * seller-funded part only; the platform-funded part is credited to seller proceeds (plan ch. 14–15).
 */
export function earningsImpact(i: EarningsInput): EarningsImpact {
  const discount = Math.max(0, Math.min(i.basePrice, i.discount));
  const sellerFunds = pctOf(discount, clampBps(i.sellerShareBps));
  const platformFunds = discount - sellerFunds;
  const feeBasis = i.basePrice - sellerFunds;
  const feeOf = i.feeAt ?? ((b: number) => pctOf(b, i.feeRateBps));
  const fee = feeOf(feeBasis);
  const regularFee = feeOf(i.basePrice);
  const sellerEarns = i.basePrice - sellerFunds - fee;
  const regularSellerEarns = i.basePrice - regularFee;
  const c = i.currency;
  const pct = i.basePrice ? bpsLabel(Math.round((discount * 10000) / i.basePrice)) : '0%';
  const explanation =
    `On a ${moneyFull(i.basePrice, c)} sale at ${pct} off with ${i.fundingWords}: the customer pays ${moneyFull(i.basePrice - discount, c)}, ` +
    `you fund ${moneyFull(sellerFunds, c)} and Marketly funds ${moneyFull(platformFunds, c)}. ` +
    `The fee is charged on ${moneyFull(feeBasis, c)}, so you earn ${moneyFull(sellerEarns, c)} instead of ${moneyFull(regularSellerEarns, c)}.`;
  return {
    basePrice: m(i.basePrice, c),
    customerPays: m(i.basePrice - discount, c),
    sellerFunds: m(sellerFunds, c),
    platformFunds: m(platformFunds, c),
    feeBasis: m(feeBasis, c),
    feeRateBps: i.feeRateBps,
    fee: m(fee, c),
    sellerEarns: m(sellerEarns, c),
    regularSellerEarns: m(regularSellerEarns, c),
    explanation,
    isExample: i.isExample,
  };
}

/** Customer discount per unit for a rule at a price (coupons are shown as if the whole unit qualifies) */
export function unitDiscount(rule: DiscountRule, price: number): number {
  if (rule.percentOffBps) {
    const off = pctOf(price, rule.percentOffBps);
    return Math.min(price, rule.maxDiscountPerOrder ? Math.min(off, rule.maxDiscountPerOrder.amount) : off);
  }
  if (rule.amountOff) return Math.min(price, rule.amountOff.amount);
  return 0;
}

/* ------------------------------------------------------------------ validation */

export interface Issue {
  path: string;
  message: string;
}

export function discountIssues(rule: DiscountRule, o: { phase3: boolean; path?: string }): Issue[] {
  const p = o.path ?? 'discount';
  const issues: Issue[] = [];
  if (PHASE3_KINDS.includes(rule.kind) && !o.phase3) issues.push({ path: `${p}.kind`, message: 'Bundles and quantity deals are not available yet' });
  if (rule.percentOffBps != null && (rule.percentOffBps <= 0 || rule.percentOffBps > 9000)) issues.push({ path: `${p}.percentOffBps`, message: 'Percentage must be between 0.01% and 90%' });
  if (rule.amountOff && rule.amountOff.amount <= 0) issues.push({ path: `${p}.amountOff`, message: 'Amount off must be more than zero' });
  if (rule.minSpend && rule.minSpend.amount <= 0) issues.push({ path: `${p}.minSpend`, message: 'Minimum spend must be more than zero' });
  if (rule.maxDiscountPerOrder && rule.maxDiscountPerOrder.amount <= 0) issues.push({ path: `${p}.maxDiscountPerOrder`, message: 'Maximum discount must be more than zero' });
  if (rule.percentOffBps && rule.amountOff) issues.push({ path: p, message: 'Use a percentage or an amount off, not both' });
  switch (rule.kind) {
    case 'markdown':
    case 'percent_coupon':
      if (!rule.percentOffBps && !(rule.kind === 'markdown' && rule.amountOff)) issues.push({ path: `${p}.percentOffBps`, message: 'Set the percentage off' });
      break;
    case 'fixed_coupon':
      if (!rule.amountOff) issues.push({ path: `${p}.amountOff`, message: 'Set the amount off' });
      break;
    case 'min_spend':
      if (!rule.minSpend) issues.push({ path: `${p}.minSpend`, message: 'Set the minimum spend' });
      if (!rule.percentOffBps && !rule.amountOff && !rule.freeShipping) issues.push({ path: p, message: 'Set the discount for orders over the minimum spend' });
      break;
    case 'free_shipping':
      break;
    case 'flash_sale':
      break;
    case 'bundle':
      if (!rule.bundle?.components?.length) issues.push({ path: `${p}.bundle`, message: 'List the bundle items' });
      break;
    case 'quantity_deal':
      if (!rule.quantityTiers?.length) issues.push({ path: `${p}.quantityTiers`, message: 'Add at least one quantity tier' });
      break;
  }
  return issues;
}

export function periodIssues(startsAt: Date, endsAt: Date, timeZone: string, now: Date | null): Issue[] {
  const issues: Issue[] = [];
  if (Number.isNaN(startsAt.getTime())) issues.push({ path: 'startsAt', message: 'Start time is not a date' });
  if (Number.isNaN(endsAt.getTime())) issues.push({ path: 'endsAt', message: 'End time is not a date' });
  if (endsAt.getTime() <= startsAt.getTime()) issues.push({ path: 'endsAt', message: 'The campaign must end after it starts' });
  if (now && endsAt.getTime() <= now.getTime()) issues.push({ path: 'endsAt', message: 'The end time has already passed' });
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    issues.push({ path: 'timeZone', message: 'Unknown time zone' });
  }
  return issues;
}

export function limitIssues(l: Limits): Issue[] {
  const issues: Issue[] = [];
  if (l.budget && l.budget.amount <= 0) issues.push({ path: 'limits.budget', message: 'Budget must be more than zero' });
  for (const k of ['usageCap', 'perCustomer', 'perOrder', 'perCustomerUnits'] as const) {
    const v = l[k];
    if (v != null && v < 1) issues.push({ path: `limits.${k}`, message: 'Must be at least 1' });
  }
  return issues;
}

export function fundingIssues(f: Funding, participation: ParticipationSettings | null | undefined): Issue[] {
  const issues: Issue[] = [];
  if (f.owner === 'shared' && (f.platformShareBps == null || f.platformShareBps <= 0 || f.platformShareBps >= 10000)) {
    issues.push({ path: 'funding.platformShareBps', message: 'Shared funding needs a platform share between 0% and 100%' });
  }
  if (f.owner !== 'platform' && !participation?.inviteSellers) {
    issues.push({ path: 'participation.inviteSellers', message: 'Seller-funded parts need each seller’s consent: invite sellers to join' });
  }
  return issues;
}

export const normalizeCode = (code: string | null | undefined) => {
  const c = code?.trim();
  return c ? c.toUpperCase() : null;
};

export function codeIssues(code: string | null | undefined, path = 'code'): Issue[] {
  const c = normalizeCode(code);
  if (code != null && code.trim() && !c) return [{ path, message: 'Enter a code' }];
  if (c && !/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(c)) return [{ path, message: 'Codes are 3–32 letters, digits, - or _' }];
  return [];
}

/* ------------------------------------------------------------------ edits */

const COSMETIC = new Set(['name', 'description', 'internalNote', 'terms', 'deals', 'version']);

/** Changed fields of a patch that are material (discount, scope, budget, funding, period and the other cost rules) */
export function materialFields(patch: Record<string, unknown>, current: Record<string, unknown>): string[] {
  return Object.entries(patch)
    .filter(([k, v]) => v !== undefined && v !== null && !COSMETIC.has(k) && JSON.stringify(v) !== JSON.stringify(current[k]))
    .map(([k]) => k);
}

/* ------------------------------------------------------------------ consent */

export const CONSENT_TEXT_VERSION = '2026-10';

export function consentText(o: { campaignName: string; period: string; discount: string; offerCount: number; sellerShareBps: number; platformShareBps: number; version: string }): string {
  return (
    `I agree to join ${o.campaignName} (${o.period}) with ${o.offerCount} offer${o.offerCount === 1 ? '' : 's'} at ${o.discount}. ` +
    `My store funds ${bpsLabel(o.sellerShareBps)} of each discount and Marketly funds ${bpsLabel(o.platformShareBps)}. ` +
    `Marketly's share does not reduce my proceeds; the fee is charged on the price after my share. ` +
    `I will not raise these offers' prices during the campaign. (Terms version ${o.version})`
  );
}
