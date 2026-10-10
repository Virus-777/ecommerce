/**
 * Pure offer rules (no I/O): condition labels and groups, dispatch / return / warranty wording,
 * price-change maths, was-price checks, restriction scope, eligibility reasons and the featured-offer ranking.
 */
import type * as common from '../../../spec/common.js';
import type { FeaturedRuleParameters, IneligibilityReason, ReturnTerms, WarrantyInput, WarrantyTerms } from '../../../spec/offers.js';

export type Condition = 'new' | 'used_like_new' | 'used_good' | 'used_acceptable' | 'refurbished';
export type ConditionGroup = 'new' | 'used' | 'refurbished';
export type OfferStatus = 'draft' | 'active' | 'paused' | 'out_of_stock' | 'ineligible' | 'removed';
export type IneligibilityCode = IneligibilityReason['code'];

export const CONDITIONS: readonly Condition[] = ['new', 'used_like_new', 'used_good', 'used_acceptable', 'refurbished'];

export const CONDITION_LABEL: Record<Condition, string> = {
  new: 'New',
  used_like_new: 'Used – Like new',
  used_good: 'Used – Good',
  used_acceptable: 'Used – Acceptable',
  refurbished: 'Refurbished',
};

export const conditionLabel = (c: string) => CONDITION_LABEL[c as Condition] ?? c;

export function conditionGroup(c: string): ConditionGroup {
  if (c === 'new') return 'new';
  if (c === 'refurbished') return 'refurbished';
  return 'used';
}

/** Used and refurbished offers must describe their condition */
export const needsConditionNotes = (c: string) => c !== 'new';

/** Statuses customers can buy from (out of stock shows but cannot be bought) */
export const SELLING: readonly OfferStatus[] = ['active'];
/** Statuses that are listed on the store (all-offers page) */
export const LISTED: readonly OfferStatus[] = ['active', 'out_of_stock', 'ineligible'];

/* ------------------------------------------------------------------ wording */

export function dispatchLabel(businessDays: number): string {
  if (businessDays <= 0) return 'Ships today';
  if (businessDays === 1) return 'Ships in 1 business day';
  return `Ships in ${businessDays} business days`;
}

export function returnSummary(windowDays: number, freeReturnShipping: boolean): string {
  return freeReturnShipping ? `${windowDays}-day returns. Free return shipping.` : `${windowDays}-day returns. You pay return shipping unless the item is faulty.`;
}

export function warrantyTerms(input: WarrantyInput, ownerType: 'official' | 'seller'): WarrantyTerms {
  if (input.kind === 'none') return { kind: 'none', months: null, handledBy: null, summary: 'No warranty' };
  const months = input.months ?? null;
  const span = months === null ? '' : months % 12 === 0 ? `${months / 12}-year ` : `${months}-month `;
  if (input.kind === 'manufacturer') return { kind: 'manufacturer', months, handledBy: 'manufacturer', summary: `${span}manufacturer warranty`.replace(/^./, (c) => c.toUpperCase()) };
  const handledBy = ownerType === 'official' ? 'official_store' : 'seller';
  return { kind: 'seller', months, handledBy, summary: `${span}${ownerType === 'official' ? 'Official Store' : 'seller'} warranty`.replace(/^./, (c) => c.toUpperCase()) };
}

export function returnTermsOf(input: { kind: 'baseline' | 'extended'; windowDays: number; freeReturnShipping: boolean; categoryException?: string | null; policyVersion?: string | null }): ReturnTerms {
  return {
    kind: input.kind,
    windowDays: input.windowDays,
    freeReturnShipping: input.freeReturnShipping,
    categoryException: input.categoryException ?? null,
    summary: returnSummary(input.windowDays, input.freeReturnShipping),
    policyVersion: input.policyVersion ?? null,
  };
}

/* ------------------------------------------------------------------ prices */

/** Signed percentage change, 2 decimals (numeric(6,2)) */
export function changePct(from: number, to: number): number {
  if (from <= 0) return 0;
  const pct = Math.round(((to - from) / from) * 10000) / 100;
  return Math.max(-9999.99, Math.min(9999.99, pct));
}

export const discountPct = (was: number, now: number) => (was > now && was > 0 ? Math.round(((was - now) / was) * 100) : null);

export function formatMoney(m: common.Money): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency }).format(m.amount / 100);
  } catch {
    return `${(m.amount / 100).toFixed(2)} ${m.currency}`;
  }
}

/** Price history row in force at some point of a window */
export interface PriceSpan {
  price: number;
  from: Date;
  to: Date | null;
}

/** Lowest price in force during [start, end) */
export function lowestInWindow(spans: readonly PriceSpan[], start: Date, end: Date): number | null {
  let low: number | null = null;
  for (const s of spans) {
    if (s.from >= end) continue;
    if (s.to && s.to <= start) continue;
    if (low === null || s.price < low) low = s.price;
  }
  return low;
}

/**
 * Was-price check for the lowest_30_days basis: the offer must have had a price on record for the whole
 * look-back window before the sale starts, and the was-price may not be above the lowest price charged in it.
 */
export function verifyLowestBasis(spans: readonly PriceSpan[], wasAmount: number, saleStart: Date, lookbackDays: number): { verified: boolean; lowest: number | null; reason?: string } {
  const start = new Date(saleStart.getTime() - lookbackDays * 86_400_000);
  const first = spans.reduce<Date | null>((min, s) => (min === null || s.from < min ? s.from : min), null);
  if (!first || first > start) return { verified: false, lowest: null, reason: `The offer has no price history covering the ${lookbackDays} days before the sale` };
  const lowest = lowestInWindow(spans, start, saleStart);
  if (lowest === null) return { verified: false, lowest: null, reason: `No price was charged in the ${lookbackDays} days before the sale` };
  if (wasAmount > lowest) return { verified: false, lowest, reason: `The was-price is above the lowest price charged in the ${lookbackDays} days before the sale` };
  return { verified: true, lowest };
}

/** A list price on file in the product specs (e.g. "List price": "$249.00" or "MSRP": "249") */
export function listPriceOnFile(specs: Record<string, string> | null | undefined): number | null {
  if (!specs) return null;
  for (const [k, v] of Object.entries(specs)) {
    if (!/^(list price|msrp|rrp|manufacturer list price)$/i.test(k.trim())) continue;
    const n = Number(String(v).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100);
  }
  return null;
}

export function compareAtExplanation(basis: 'lowest_30_days' | 'list_price', owner: string, lookbackDays: number): string {
  return basis === 'list_price'
    ? 'Was price is the manufacturer list price on file.'
    : `Was price is ${owner}'s lowest price in the ${lookbackDays} days before the sale.`;
}

/* ------------------------------------------------------------------ restrictions */

export interface ScopeLike {
  categoryIds?: string[] | null;
  conditions?: string[] | null;
  offerIds?: string[] | null;
  productIds?: string[] | null;
}

export const wholeAccount = (s: ScopeLike | null | undefined) => !s || (!s.categoryIds?.length && !s.conditions?.length && !s.offerIds?.length && !s.productIds?.length);

/** Every dimension the scope names must match the offer (empty scope = whole account) */
export function inScope(scope: ScopeLike | null | undefined, offer: { id: string; product_id: string; condition: string }, categoryId: string | null | undefined): boolean {
  if (wholeAccount(scope)) return true;
  const s = scope!;
  const dims: boolean[] = [];
  if (s.categoryIds?.length) dims.push(Boolean(categoryId && s.categoryIds.includes(categoryId)));
  if (s.conditions?.length) dims.push(s.conditions.includes(offer.condition));
  if (s.offerIds?.length) dims.push(s.offerIds.includes(offer.id));
  if (s.productIds?.length) dims.push(s.productIds.includes(offer.product_id));
  return dims.every(Boolean);
}

const ACTIVITY_LABEL: Record<string, string> = {
  new_listings: 'new listings',
  product_submissions: 'product submissions',
  new_offers: 'new offers',
  offer_reactivation: 'offer reactivation',
  sales: 'sales',
  advertising: 'advertising',
  promotions: 'promotions',
  payout_schedule: 'payout schedule',
};

export function activityLabel(activities: readonly string[], scope?: ScopeLike | null): string {
  const acts = activities.map((a) => ACTIVITY_LABEL[a] ?? a.replace(/_/g, ' '));
  const list = acts.length > 1 ? `${acts.slice(0, -1).join(', ')} and ${acts.at(-1)}` : (acts[0] ?? 'selling');
  const prefix = scope?.conditions?.length ? `${scope.conditions.map(conditionLabel).join(', ')} offers: ` : '';
  return `${prefix}${list}`.replace(/^./, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ featured-offer eligibility */

export const REASON: Record<IneligibilityCode, { message: string; howToFix: string | null }> = {
  offer_not_active: { message: 'Not eligible for featured offer: offer is not active', howToFix: 'Publish or resume the offer.' },
  out_of_stock: { message: 'Not eligible for featured offer: out of stock', howToFix: 'Add stock to make the offer available again.' },
  seller_restricted: { message: 'Not eligible for featured offer: seller account restricted', howToFix: 'See the restriction in Seller Center for what to fix and how to appeal.' },
  seller_suspended: { message: 'Not eligible for featured offer: seller account suspended', howToFix: 'See the suspension notice in Seller Center for how to appeal.' },
  delivery_performance_under_review: { message: 'Not eligible for featured offer: delivery performance under review', howToFix: 'Dispatch on time with valid tracking; eligibility is checked again every hour.' },
  on_time_dispatch_below_standard: { message: 'Not eligible for featured offer: on-time dispatch below standard', howToFix: 'Raise on-time dispatch to the published standard over the performance window.' },
  product_not_purchasable: { message: 'Not eligible for featured offer: product not available', howToFix: 'The product is hidden or suspended in the catalog; see the product page in Seller Center.' },
  does_not_ship_to_location: { message: 'Does not ship to this location', howToFix: 'Add this area to the shipping profile coverage.' },
  condition_not_competing: { message: 'Shown in its condition filter; only New offers compete for the featured offer', howToFix: null },
  staff_hold: { message: 'Not eligible for featured offer: under review', howToFix: 'Marketly staff are reviewing this offer; you will be told the outcome by the review date.' },
};

export const reason = (code: IneligibilityCode, message?: string): IneligibilityReason => ({ code, message: message ?? REASON[code].message, howToFix: REASON[code].howToFix });

/* ------------------------------------------------------------------ featured-offer rule */

export const DEFAULT_RULE = {
  version: 1,
  text:
    'We feature one offer for each product variant and delivery location. Only eligible offers can be featured: the offer is active, the seller is in good standing with no open restriction, ' +
    'dispatches on time at or above the published standard and is not under delivery review, and the product can be bought. The offer must be in stock and ship to your location. ' +
    'Among eligible New offers we compare the total price (item + shipping − automatic discounts), adding a small amount for each business day an offer arrives later than the fastest one. ' +
    'The lowest adjusted total is featured; ties go to the better on-time dispatch record, then the earlier listing. Advertising never affects the featured offer.',
  steps: [
    'Eligible: offer active, seller in good standing, on-time dispatch at or above the standard, not under delivery review, product purchasable',
    'Available: in stock and ships to your delivery location',
    'Delivery: each business day slower than the fastest eligible offer adds 1% of the item price to the ranking total',
    'Total price: item + shipping − automatic discounts; the lowest adjusted total is featured',
  ],
  parameters: {
    minOnTimeDispatchPct: 90,
    performanceWindowDays: 90,
    deliveryDayAdjustmentPct: 1,
    competingConditions: ['new'],
    tieBreakers: ['on_time_dispatch', 'earliest_publication'],
  } satisfies FeaturedRuleParameters,
  reason: 'Initial featured-offer rule',
};

export const RULE_NOTES = [
  'Used and refurbished offers compete only within their condition filter.',
  'Advertising never affects the featured offer.',
  'Totals include shipping; sales tax is added at checkout.',
];

export const TAX_NOTE = 'Totals include shipping; sales tax is added at checkout.';

/** Delivery zone used to cache featured decisions */
export function zoneKey(postalCode: string, granularity: string): string {
  const digits = postalCode.replace(/\s+/g, '').toUpperCase();
  const m = /^postal(\d+)$/.exec(granularity);
  const n = m ? Number(m[1]) : 3;
  return digits.slice(0, Math.max(1, n)) || 'none';
}

/** Weekdays from a to b (dates YYYY-MM-DD), negative when b is before a */
export function businessDaysBetween(a: string, b: string): number {
  if (a === b) return 0;
  const sign = a < b ? 1 : -1;
  const [from, to] = sign > 0 ? [a, b] : [b, a];
  let d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  let n = 0;
  while (d < end) {
    d = new Date(d.getTime() + 86_400_000);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return sign * n;
}

export interface RankInput {
  offerId: string;
  eligible: boolean;
  /** item price × 1 + shipping − automatic discount, minor units */
  total: number;
  itemPrice: number;
  /** arrival (latest date) or null when unknown */
  arrivesTo: string | null;
  /** dispatch business days, used when no arrival date is known */
  dispatchDays: number;
  onTimePct: number | null;
  publishedAt: Date | null;
}

export interface Ranked extends RankInput {
  adjustedTotal: number;
  rank: number | null;
}

/** Ranks eligible candidates by adjusted total; ineligible ones keep rank null */
export function rankCandidates(cands: readonly RankInput[], params: Pick<FeaturedRuleParameters, 'deliveryDayAdjustmentPct'>): Ranked[] {
  const eligible = cands.filter((c) => c.eligible);
  const dates = eligible.map((c) => c.arrivesTo).filter((d): d is string => Boolean(d));
  const fastestDate = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;
  const fastestDispatch = eligible.length ? Math.min(...eligible.map((c) => c.dispatchDays)) : 0;
  const out: Ranked[] = cands.map((c) => {
    const slower = c.arrivesTo && fastestDate ? Math.max(0, businessDaysBetween(fastestDate, c.arrivesTo)) : Math.max(0, c.dispatchDays - fastestDispatch);
    const adjust = Math.round((c.itemPrice * params.deliveryDayAdjustmentPct * slower) / 100);
    return { ...c, adjustedTotal: c.total + adjust, rank: null };
  });
  const ranked = out
    .filter((c) => c.eligible)
    .sort(
      (a, b) =>
        a.adjustedTotal - b.adjustedTotal ||
        (b.onTimePct ?? 0) - (a.onTimePct ?? 0) ||
        (a.publishedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.publishedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
        a.offerId.localeCompare(b.offerId),
    );
  ranked.forEach((c, i) => (c.rank = i + 1));
  return out.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.adjustedTotal - b.adjustedTotal);
}

/* ------------------------------------------------------------------ bulk files */

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (rows: readonly (readonly unknown[])[]) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

/** "24.00", "$24", "24" → 2400; null when not a number */
export function parsePrice(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}
