/**
 * Pure rules of the fulfillment service (no I/O): size tiers and storage limits, volumes, stock groups of the
 * ownership ledger, unit ageing, fee rates and amounts, and small encodings for text columns.
 */
import type * as common from '../../../spec/common.js';
import type { Dimensions, FeeRate, OwnedStock, SkuEnrollment } from '../../../spec/fulfillment-service.js';
import type { Balances, LedgerRec, Levels, StockGroup } from '../ports.js';

export const SYSTEM: common.Actor = { kind: 'system', id: null, name: 'Marketly' };

/* ---------------------------------------------------------------- the example fee schedule */

const usd = (amount: number): common.Money => ({ amount, currency: 'USD' });

/** In force until staff publish a real schedule (seeded on boot by domain/seed.ts; example values) */
export const EXAMPLE_SCHEDULE = {
  id: '01890000-0000-7000-8000-00000000f5e1',
  version: 'FS-EXAMPLE-2026',
  effectiveAt: '2026-01-01T00:00:00.000Z',
  rates: [
    { type: 'receiving_per_unit', sizeTier: 'any', rate: usd(25), note: 'Example value' },
    { type: 'label_per_unit', sizeTier: 'any', rate: usd(55), note: 'Units sent without a scannable barcode' },
    { type: 'storage_per_cubic_foot_month', sizeTier: 'any', rate: usd(87), note: 'Average daily volume over the month' },
    { type: 'long_term_storage_per_cubic_foot_month', sizeTier: 'any', rate: usd(690), note: 'Units older than the long-term storage age' },
    { type: 'pick_pack_per_unit', sizeTier: 'small', rate: usd(300) },
    { type: 'pick_pack_per_unit', sizeTier: 'standard', rate: usd(350) },
    { type: 'pick_pack_per_unit', sizeTier: 'large', rate: usd(500) },
    { type: 'pick_pack_per_unit', sizeTier: 'oversize', rate: usd(1000) },
    { type: 'order_handling', sizeTier: 'any', rate: usd(100) },
    { type: 'returns_processing_per_unit', sizeTier: 'any', rate: usd(250) },
    { type: 'removal_per_unit', sizeTier: 'any', rate: usd(97) },
    { type: 'disposal_per_unit', sizeTier: 'any', rate: usd(50) },
  ] satisfies FeeRate[],
};

export const FEE_TYPES: FeeRate['type'][] = [
  'receiving_per_unit',
  'storage_per_cubic_foot_month',
  'long_term_storage_per_cubic_foot_month',
  'pick_pack_per_unit',
  'order_handling',
  'returns_processing_per_unit',
  'removal_per_unit',
  'disposal_per_unit',
  'label_per_unit',
];

/** Fee charge types (FeeCharge.type): the rate types without the unit suffix, plus reimbursements */
export const CHARGE_TYPE: Record<FeeRate['type'], string> = {
  receiving_per_unit: 'receiving',
  storage_per_cubic_foot_month: 'storage',
  long_term_storage_per_cubic_foot_month: 'long_term_storage',
  pick_pack_per_unit: 'pick_pack',
  order_handling: 'order_handling',
  returns_processing_per_unit: 'returns_processing',
  removal_per_unit: 'removal',
  disposal_per_unit: 'disposal',
  label_per_unit: 'labelling',
};
export const REIMBURSEMENT = 'reimbursement';

export const CHARGE_LABEL: Record<string, string> = {
  receiving: 'Receiving',
  storage: 'Monthly storage',
  long_term_storage: 'Long-term storage',
  pick_pack: 'Pick and pack',
  order_handling: 'Order handling',
  returns_processing: 'Returns processing',
  removal: 'Removal',
  disposal: 'Disposal',
  labelling: 'Labelling',
  reimbursement: 'Reimbursement',
};

/** The rate of a type for a size tier, else the 'any' rate; null when the schedule has none */
export function rateFor(rates: readonly FeeRate[], type: FeeRate['type'], tier: string): common.Money | null {
  return rates.find((r) => r.type === type && r.sizeTier === tier)?.rate ?? rates.find((r) => r.type === type && r.sizeTier === 'any')?.rate ?? null;
}

/** units × rate, rounded half away from zero to a whole minor unit */
export function feeAmount(units: number, rate: number): number {
  const exact = units * rate;
  return Math.sign(exact) * Math.round(Math.abs(exact));
}

export function validateRates(rates: readonly FeeRate[]): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const seen = new Set<string>();
  rates.forEach((r, i) => {
    if (!Number.isSafeInteger(r.rate.amount) || r.rate.amount < 0) issues.push({ path: `rates[${i}].rate`, message: 'Rates are whole minor units, 0 or more' });
    const key = `${r.type}:${r.sizeTier}`;
    if (seen.has(key)) issues.push({ path: `rates[${i}]`, message: `${r.type} for ${r.sizeTier} appears twice` });
    seen.add(key);
  });
  if (!rates.length) issues.push({ path: 'rates', message: 'A fee schedule needs its rates' });
  const currencies = new Set(rates.map((r) => r.rate.currency));
  if (currencies.size > 1) issues.push({ path: 'rates', message: 'All rates use one currency' });
  return issues;
}

/* ---------------------------------------------------------------- size, volume and storage limits */

const CM3_PER_CUBIC_FOOT = 28_316.846_592;

/** Largest item we store: longest side and weight (beyond: SKU_RESTRICTED) */
export const MAX_LONGEST_CM = 274;
export const MAX_WEIGHT_GRAMS = 68_000;

export const cubicFeet = (d: Dimensions) => round4((d.length * d.width * d.height) / CM3_PER_CUBIC_FOOT);
export const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function dimensionIssues(d: Dimensions, weightGrams: number): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  for (const k of ['length', 'width', 'height'] as const) if (!(Number.isFinite(d[k]) && d[k] > 0)) issues.push({ path: `dimensionsCm.${k}`, message: 'Enter the packed size in centimetres, above 0' });
  if (!Number.isInteger(weightGrams) || weightGrams <= 0) issues.push({ path: 'weightGrams', message: 'Enter the packed weight in grams, above 0' });
  return issues;
}

/** Why the item can't be stored, or null */
export function restriction(d: Dimensions, weightGrams: number, hazmat: boolean): string | null {
  if (hazmat) return 'Hazardous materials are not stored by Marketly';
  if (Math.max(d.length, d.width, d.height) > MAX_LONGEST_CM) return `Items longer than ${MAX_LONGEST_CM} cm are not stored by Marketly`;
  if (weightGrams > MAX_WEIGHT_GRAMS) return `Items heavier than ${MAX_WEIGHT_GRAMS / 1000} kg are not stored by Marketly`;
  return null;
}

/** Size tier from the packed dimensions and weight (example thresholds) */
export function sizeTier(d: Dimensions, weightGrams: number): SkuEnrollment['sizeTier'] {
  const [s, m, l] = [d.length, d.width, d.height].sort((a, b) => a - b) as [number, number, number];
  if (l <= 38 && m <= 30 && s <= 5 && weightGrams <= 1_000) return 'small';
  if (l <= 46 && m <= 36 && s <= 20 && weightGrams <= 9_000) return 'standard';
  if (l <= 152 && weightGrams <= 23_000) return 'large';
  return 'oversize';
}

/* ---------------------------------------------------------------- stock groups */

/** Groups whose units are in our warehouse */
export const PHYSICAL: StockGroup[] = ['receiving', 'available', 'reserved', 'unsellable', 'returned', 'removal_pending'];

export const qty = (b: Balances, skuId: string, g: StockGroup) => Math.max(0, b.get(skuId)?.[g] ?? 0);

/** Rows by key, in their order (Map.groupBy, which the ES2023 lib does not type yet) */
export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}
export const physicalUnits = (b: Balances, skuId: string) => PHYSICAL.reduce((n, g) => n + qty(b, skuId, g), 0);

export const AGE_BUCKETS = [
  { key: '0-90', max: 90 },
  { key: '91-180', max: 180 },
  { key: '181-365', max: 365 },
  { key: '365+', max: Infinity },
] as const;

/**
 * Ages of the units on hand: units leave first in, first out, so the units still here are the latest arrivals.
 * `inflows` newest first. Returns the arrival time of each unit block still on hand.
 */
export function onHandBlocks(onHand: number, inflows: readonly Pick<LedgerRec, 'quantity' | 'at'>[]): { at: Date; units: number }[] {
  const out: { at: Date; units: number }[] = [];
  let left = onHand;
  for (const f of inflows) {
    if (left <= 0) break;
    const take = Math.min(left, f.quantity);
    if (take > 0) out.push({ at: f.at, units: take });
    left -= take;
  }
  // units with no recorded arrival (adjustments before the ledger) count as arriving at the oldest known time
  if (left > 0) out.push({ at: out.at(-1)?.at ?? new Date(0), units: left });
  return out;
}

export const ageDays = (at: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000));

export function ageBuckets(blocks: readonly { at: Date; units: number }[], now: Date): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0]));
  for (const b of blocks) {
    const days = ageDays(b.at, now);
    const bucket = AGE_BUCKETS.find((x) => days <= x.max)!;
    out[bucket.key]! += b.units;
  }
  return out;
}

export const unitsOlderThan = (blocks: readonly { at: Date; units: number }[], now: Date, days: number) => blocks.filter((b) => ageDays(b.at, now) > days).reduce((n, b) => n + b.units, 0);

export function emptyStock(): OwnedStock {
  return { available: 0, reserved: 0, inbound: 0, receiving: 0, unsellable: 0, returned: 0, removalPending: 0, volumeCubicFeet: 0, agedDays: Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0])) };
}

export function sumStock(items: readonly OwnedStock[]): OwnedStock {
  const out = emptyStock();
  for (const s of items) {
    out.available += s.available;
    out.reserved += s.reserved;
    out.inbound += s.inbound;
    out.receiving += s.receiving;
    out.unsellable += s.unsellable;
    out.returned += s.returned;
    out.removalPending += s.removalPending;
    out.volumeCubicFeet = round4(out.volumeCubicFeet + s.volumeCubicFeet);
    for (const [k, v] of Object.entries(s.agedDays)) out.agedDays[k] = (out.agedDays[k] ?? 0) + v;
  }
  return out;
}

/* ---------------------------------------------------------------- dates and periods */

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM of a market date */
export const monthOf = (date: string) => date.slice(0, 7);

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/* ---------------------------------------------------------------- text encodings */

/** Actor stored in a text column (accepted_by, reviewer_id, decided_by) */
export const actorText = (a: common.Actor | null | undefined) => (a ? JSON.stringify({ kind: a.kind, id: a.id ?? null, name: a.name ?? null }) : null);

export function actorOf(text: string | null | undefined): common.Actor | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as common.Actor;
    if (v && typeof v === 'object' && typeof v.kind === 'string') return v;
  } catch {
    /* a plain id */
  }
  return { kind: 'staff', id: text, name: null };
}

/** 'City, Region' of the service location (its name when the address has neither) */
export function shipsFromOf(address: common.Address, name: string): string {
  const text = [address.city, address.region].filter((s) => s?.trim()).join(', ');
  return text || name;
}

/* ---------------------------------------------------------------- the ledger against inventory */

/**
 * Ledger groups mapped to inventory's groups at the service location: inbound + receiving ↔ incoming,
 * available ↔ available, reserved ↔ reserved, unsellable + removal_pending ↔ damagedHeld, returned ↔ returned.
 */
export function ledgerLevels(b: Balances, skuId: string): Levels {
  return {
    incoming: qty(b, skuId, 'inbound') + qty(b, skuId, 'receiving'),
    available: qty(b, skuId, 'available'),
    reserved: qty(b, skuId, 'reserved'),
    damagedHeld: qty(b, skuId, 'unsellable') + qty(b, skuId, 'removal_pending'),
    returned: qty(b, skuId, 'returned'),
  };
}

export const LEVEL_KEYS = ['incoming', 'available', 'reserved', 'damagedHeld', 'returned'] as const;

export const levelsDiffer = (a: Levels, b: Levels) => LEVEL_KEYS.some((k) => a[k] !== b[k]);

/** The ledger group an inventory group moves (the first group when two ledger groups map to one) */
export const LEDGER_GROUP: Record<(typeof LEVEL_KEYS)[number], StockGroup> = { incoming: 'receiving', available: 'available', reserved: 'reserved', damagedHeld: 'unsellable', returned: 'returned' };

/** Inventory's group names (adjustment.recorded fromGroup / toGroup) → ledger group; outside → null */
export function ledgerGroupOf(inventoryGroup: string): StockGroup | null | undefined {
  switch (inventoryGroup) {
    case 'available':
      return 'available';
    case 'reserved':
      return 'reserved';
    case 'incoming':
      return 'receiving';
    case 'damaged_held':
      return 'unsellable';
    case 'returned':
      return 'returned';
    case 'outside':
      return null;
    default:
      return undefined;
  }
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
