/**
 * Shipping prices: rate tiers per profile method, free-shipping thresholds and free-shipping rules.
 * Money is integer minor units (kernel/lib/money).
 */
import { format, money } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { ProfileMethod, RateTier } from '../../../spec/shipping.js';

export const formatShort = (m: common.Money) => format(m).replace(/\.00$/, '');

const byWeight = (a: RateTier, b: RateTier) => (a.upToGrams ?? Infinity) - (b.upToGrams ?? Infinity);
const byValue = (a: RateTier, b: RateTier) => (a.upToOrderValue?.amount ?? Infinity) - (b.upToOrderValue?.amount ?? Infinity);

/** The method can carry a package of this weight (unknown weight: yes) */
export function fitsWeight(pm: Pick<ProfileMethod, 'minWeightGrams' | 'maxWeightGrams' | 'rateType' | 'tiers'>, weightGrams: number | null): boolean {
  if (weightGrams == null || weightGrams <= 0) return true;
  if (pm.minWeightGrams != null && weightGrams < pm.minWeightGrams) return false;
  if (pm.maxWeightGrams != null && weightGrams > pm.maxWeightGrams) return false;
  if (pm.rateType === 'by_weight') {
    const tiers = [...pm.tiers].sort(byWeight);
    if (tiers.length && !tiers.some((t) => t.upToGrams == null || weightGrams <= t.upToGrams)) return false;
  }
  return true;
}

/**
 * Price of one package with this method: the weight tier (by_weight), the flat rate (flat_per_package), the order
 * value tier of the package subtotal (by_order_value) or zero (free). Null when the method cannot carry it.
 * Unknown weight or value takes the first tier.
 */
export function methodPrice(pm: Pick<ProfileMethod, 'rateType' | 'tiers' | 'minWeightGrams' | 'maxWeightGrams'>, weightGrams: number | null, subtotal: common.Money | null, currency: string): common.Money | null {
  if (!fitsWeight(pm, weightGrams)) return null;
  const tiers = pm.tiers ?? [];
  switch (pm.rateType) {
    case 'free':
      return money(0, currency);
    case 'flat_per_package':
      return tiers[0] ? money(tiers[0].price.amount, tiers[0].price.currency) : money(0, currency);
    case 'by_weight': {
      const sorted = [...tiers].sort(byWeight);
      const t = weightGrams == null || weightGrams <= 0 ? sorted[0] : sorted.find((x) => x.upToGrams == null || weightGrams <= x.upToGrams);
      return t ? money(t.price.amount, t.price.currency) : null;
    }
    case 'by_order_value': {
      const sorted = [...tiers].sort(byValue);
      const t = !subtotal ? sorted[0] : sorted.find((x) => x.upToOrderValue == null || subtotal.amount <= x.upToOrderValue.amount);
      return t ? money(t.price.amount, t.price.currency) : sorted.length ? null : money(0, currency);
    }
  }
}

export interface FreeRuleLike {
  name: string;
  scope: string;
  min_order_value: number | null;
  method_code: string;
  funded_by: string;
  starts_on: string | null;
  ends_on: string | null;
  status: string;
}

export interface FreeOutcome {
  free: boolean;
  fundedBy: 'customer' | 'seller' | 'company' | 'platform';
  reason: string | null;
}

/**
 * Whether the package ships free with this method: a free rate, the method's freeOver, the profile threshold
 * (on its free-shipping method) or a free-shipping rule in its window. Unknown subtotal: only a free rate or a
 * rule without a minimum counts.
 */
export function freeOutcome(o: {
  ownerType: 'official' | 'seller';
  methodCode: string;
  pm: Pick<ProfileMethod, 'rateType' | 'freeOver'>;
  threshold: common.Money | null;
  thresholdMethodCode: string | null;
  subtotal: common.Money | null;
  rules: readonly FreeRuleLike[];
  today: string;
}): FreeOutcome {
  const ownerFunded = o.ownerType === 'official' ? 'company' : 'seller';
  if (o.pm.rateType === 'free') return { free: true, fundedBy: ownerFunded, reason: 'Free shipping' };
  const reached = (m: common.Money | null | undefined) => Boolean(m && o.subtotal && o.subtotal.amount >= m.amount);
  if (o.pm.freeOver && reached(o.pm.freeOver)) return { free: true, fundedBy: ownerFunded, reason: `Free over ${formatShort(o.pm.freeOver)}` };
  if (o.threshold && (o.thresholdMethodCode ?? 'standard') === o.methodCode && reached(o.threshold)) return { free: true, fundedBy: ownerFunded, reason: `Free over ${formatShort(o.threshold)}` };
  const scope = o.ownerType === 'official' ? 'official_store' : 'seller_offers';
  for (const r of o.rules) {
    if (r.status !== 'active' || r.scope !== scope || r.method_code !== o.methodCode) continue;
    if (r.starts_on && o.today < r.starts_on) continue;
    if (r.ends_on && o.today > r.ends_on) continue;
    if (r.min_order_value != null && !(o.subtotal && o.subtotal.amount >= r.min_order_value)) continue;
    const currency = o.subtotal?.currency ?? 'USD';
    return { free: true, fundedBy: r.funded_by === 'seller' ? 'seller' : 'company', reason: r.min_order_value != null ? `Free over ${formatShort(money(r.min_order_value, currency))}` : r.name };
  }
  return { free: false, fundedBy: 'customer', reason: null };
}

/**
 * The lowest order value at which freeOutcome makes this method free (the method's freeOver, the profile threshold
 * on its free-shipping method, an active free-shipping rule's minimum). Null when there is none, or when the method
 * is free whatever the order value.
 */
export function freeThreshold(o: Omit<Parameters<typeof freeOutcome>[0], 'subtotal'> & { currency: string }): common.Money | null {
  if (o.pm.rateType === 'free') return null;
  const scope = o.ownerType === 'official' ? 'official_store' : 'seller_offers';
  const amounts: number[] = [];
  if (o.pm.freeOver) amounts.push(o.pm.freeOver.amount);
  if (o.threshold && (o.thresholdMethodCode ?? 'standard') === o.methodCode) amounts.push(o.threshold.amount);
  for (const r of o.rules) {
    if (r.status !== 'active' || r.scope !== scope || r.method_code !== o.methodCode) continue;
    if (r.starts_on && o.today < r.starts_on) continue;
    if (r.ends_on && o.today > r.ends_on) continue;
    if (r.min_order_value == null) return null;
    amounts.push(r.min_order_value);
  }
  return amounts.length ? money(Math.min(...amounts), o.currency) : null;
}

/** A rule's status on a day: its window decides scheduled, active and ended */
export function ruleStatus(r: Pick<FreeRuleLike, 'status' | 'starts_on' | 'ends_on'>, today: string): 'scheduled' | 'active' | 'ended' | 'inactive' {
  if (r.status === 'inactive') return 'inactive';
  if (r.ends_on && r.ends_on < today) return 'ended';
  if (r.starts_on && r.starts_on > today) return 'scheduled';
  return 'active';
}

/** '$5.99', 'Free', 'From $4.99' for the storefront methods list */
export function priceLabel(pm: Pick<ProfileMethod, 'rateType' | 'tiers' | 'freeOver'>, threshold: common.Money | null): string {
  if (pm.rateType === 'free') return 'Free';
  const prices = pm.tiers.map((t) => t.price.amount);
  if (!prices.length) return 'Free';
  const min = Math.min(...prices);
  const cur = pm.tiers[0]!.price.currency;
  const base = pm.rateType === 'flat_per_package' || new Set(prices).size === 1 ? formatShort(money(min, cur)) : `From ${formatShort(money(min, cur))}`;
  const over = pm.freeOver ?? threshold;
  return over ? `${base} or free over ${formatShort(over)}` : base;
}

/** Profile method problems (VALIDATION_FAILED issues) */
export function methodIssues(m: { rateType: string; tiers: RateTier[]; minWeightGrams?: number | null; maxWeightGrams?: number | null }, path: string, currency: string): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (m.rateType !== 'free' && !m.tiers.length) issues.push({ path: `${path}.tiers`, message: 'Add at least one rate' });
  m.tiers.forEach((t, i) => {
    if (t.price.amount < 0) issues.push({ path: `${path}.tiers.${i}.price`, message: 'Prices cannot be negative' });
    if (t.price.currency !== currency) issues.push({ path: `${path}.tiers.${i}.price`, message: `Prices are in ${currency}` });
    if (m.rateType === 'by_weight' && t.upToGrams != null && t.upToGrams <= 0) issues.push({ path: `${path}.tiers.${i}.upToGrams`, message: 'Weight limits must be positive' });
  });
  if (m.minWeightGrams != null && m.maxWeightGrams != null && m.minWeightGrams > m.maxWeightGrams) issues.push({ path: `${path}.maxWeightGrams`, message: 'Maximum weight is below the minimum' });
  return issues;
}
