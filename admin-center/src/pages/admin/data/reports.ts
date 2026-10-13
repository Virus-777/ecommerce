// Report library (admin/reports, design: pages/admin/admin-reports.html) and report definitions for
// admin/report (designed in React; blueprint: reports/Best ecommerce site UX patterns.md, "Report detail
// and export flows"). Every report in the library has a key (its slugified name) and a definition.
// Sample numbers come from a deterministic generator at the finest grain (one day × one seller), so the
// KPIs, the chart, the table and every export add up to the same totals. Replaced by the reports API later.
import type { IconName } from '@marketly/web-shared/ui';

export interface LibGroup { name: string; icon: IconName; owner: string; reports: string[] }
export const LIBRARY: LibGroup[] = [
  { name: 'Commerce', icon: 'shopping-bag', owner: 'Mei Lin, Reports Analyst', reports: ['Sales', 'Orders and average order value', 'Cancellations and refunds'] },
  { name: 'Company trading', icon: 'badge-check', owner: 'Dana Ortiz, Official Store Manager', reports: ['Product sales and margin', 'Purchasing cost', 'Discounts and shipping expense', 'Returns cost'] },
  { name: 'Marketplace finance', icon: 'landmark', owner: 'Priya Nair, Finance Manager', reports: ['Seller sales and earned fees', 'Discount funding', 'Amounts owed to sellers', 'Holds and completed payouts'] },
  { name: 'Products and discovery', icon: 'package', owner: 'Omar Haddad, Catalog Manager', reports: ['Views, cart additions, purchases', 'Searches with no available result', 'Stockouts', 'Product return reasons'] },
  { name: 'Service and sellers', icon: 'store', owner: 'Grace Kim, Seller Manager', reports: ['On-time dispatch', 'Delivery issues', 'Seller cancellations', 'Response time and case backlog', 'Complaint patterns'] },
  { name: 'Customers, marketing and ads', icon: 'megaphone', owner: 'Jamie Brooks, Marketing and Advertising', reports: ['Returning buyers and repeat purchases', 'Campaign results', 'Ad displays, clicks, dismissals and spend'] },
];

/** "Views, cart additions, purchases" → "views-cart-additions-purchases". */
export const reportKey = (name: string) => name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------------- Metrics ---------------- */

export type Fmt = 'money' | 'count' | 'percent' | 'hours';

export interface MetricDef { meaning: string; formula: string; includes: string; excludes: string; owner: string; version: string }

interface MetricBase {
  key: string;
  label: string;
  fmt: Fmt;
  /** Higher is better (drives the delta colour). */
  up: boolean;
  def?: Partial<MetricDef>;
}
export type Metric =
  /** Daily total for every unit in the report at the reference date (Oct 2026). */
  | (MetricBase & { kind: 'base'; base: number })
  /** A share of another metric at the same grain; byUnit overrides the rate per seller. */
  | (MetricBase & { kind: 'rate'; of: string; rate: number; byUnit?: Record<string, number> })
  | (MetricBase & { kind: 'calc'; from: string[]; calc: (...v: number[]) => number })
  /** Aggregate-only: num ÷ den (× 100 for percent). */
  | (MetricBase & { kind: 'ratio'; num: string; den: string });

export type ScopeSet = 'all' | 'sellers' | 'official';

export interface ReportDef {
  key: string;
  name: string;
  group: string;
  icon: IconName;
  owner: string;
  description: string;
  chart: 'line' | 'bar';
  /** Metric keys the chart can show (first is the default). */
  chartMetrics: string[];
  /** Four KPI metric keys. */
  kpis: string[];
  metrics: Metric[];
  /** Which units the report covers: Official Store and sellers, sellers only, or the Official Store only. */
  scopes: ScopeSet;
  /** Share of volume from the Official Store when scopes = 'all'. */
  officialShare: number;
  freshness: { ago: string; at: string };
  definitionsVersion: string;
  note?: { title: string; body: string };
  target?: string;
}

/* ---------------- Units (seller scope) ---------------- */

export const OFFICIAL = { id: 'official', name: 'Official Store' };
export const SELLERS = [
  { id: 'northwind-audio', name: 'Northwind Audio', w: 0.2 },
  { id: 'pixel-and-port', name: 'Pixel & Port', w: 0.16 },
  { id: 'casa-verde-home', name: 'Casa Verde Home', w: 0.14 },
  { id: 'trailhead-outfitters', name: 'Trailhead Outfitters', w: 0.13 },
  { id: 'gadget-grove', name: 'Gadget Grove', w: 0.1 },
  { id: 'bayside-prints', name: 'Bayside Prints', w: 0.08 },
  { id: 'moss-and-mill', name: 'Moss & Mill', w: 0.07 },
  { id: 'rowan-leather-co', name: 'Rowan Leather Co.', w: 0.06 },
  { id: 'brightfield-supply-co', name: 'Brightfield Supply Co.', w: 0.06 },
];
export const unitName = (id: string) => (id === OFFICIAL.id ? OFFICIAL.name : (SELLERS.find((s) => s.id === id)?.name ?? id));

export function unitsOf(r: ReportDef): string[] {
  if (r.scopes === 'official') return [OFFICIAL.id];
  const s = SELLERS.map((x) => x.id);
  return r.scopes === 'all' ? [OFFICIAL.id, ...s] : s;
}

function unitWeight(r: ReportDef, u: string) {
  if (r.scopes === 'official') return 1;
  const sellersShare = r.scopes === 'all' ? 1 - r.officialShare : 1;
  if (u === OFFICIAL.id) return r.officialShare;
  return sellersShare * (SELLERS.find((s) => s.id === u)?.w ?? 0);
}

/* ---------------- Dates (UTC day numbers; days are PT calendar days) ---------------- */

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86400000;
const date = (t: number) => new Date(t * 86400000);
export const dayLabel = (t: number, year = false) => {
  const d = date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year ? `, ${d.getUTCFullYear()}` : ''}`;
};
export const isoDay = (t: number) => date(t).toISOString().slice(0, 10);
const minusYear = (t: number) => {
  const d = date(t);
  return D(d.getUTCFullYear() - 1, d.getUTCMonth() + 1, d.getUTCDate());
};
export function rangeLabel([a, b]: [number, number]) {
  const da = date(a), db = date(b);
  if (a === b) return dayLabel(a, true);
  if (da.getUTCFullYear() !== db.getUTCFullYear()) return `${dayLabel(a, true)} – ${dayLabel(b, true)}`;
  return `${dayLabel(a)} – ${dayLabel(b, true)}`;
}

export interface Preset { value: string; label: string; range: [number, number]; prev?: [number, number] }
/** "Today" in the sample data is Oct 8, 2026; complete days run to Oct 7. Dates are inclusive. */
export const PRESETS: Preset[] = [
  { value: 'last-month', label: 'Last month', range: [D(2026, 9, 1), D(2026, 9, 30)], prev: [D(2026, 8, 1), D(2026, 8, 31)] },
  { value: 'last-7', label: 'Last 7 days', range: [D(2026, 10, 1), D(2026, 10, 7)] },
  { value: 'last-30', label: 'Last 30 days', range: [D(2026, 9, 8), D(2026, 10, 7)] },
  { value: 'last-quarter', label: 'Last quarter', range: [D(2026, 7, 1), D(2026, 9, 30)], prev: [D(2026, 4, 1), D(2026, 6, 30)] },
  { value: 'last-12', label: 'Last 12 months', range: [D(2025, 10, 1), D(2026, 9, 30)], prev: [D(2024, 10, 1), D(2025, 9, 30)] },
];

export type Compare = 'previous' | 'last-year' | 'none';
export function compareRange(p: Preset, c: Compare): [number, number] | null {
  if (c === 'none') return null;
  const [a, b] = p.range;
  if (c === 'last-year') return [minusYear(a), minusYear(b)];
  return p.prev ?? [a - (b - a + 1), a - 1];
}

export interface Bucket { label: string; full: string; days: number[] }
export function bucketsOf([a, b]: [number, number]): { unit: 'Day' | 'Week' | 'Month'; list: Bucket[] } {
  const n = b - a + 1;
  const days = (x: number, y: number) => Array.from({ length: y - x + 1 }, (_, i) => x + i);
  if (n <= 14) return { unit: 'Day', list: days(a, b).map((t) => ({ label: dayLabel(t), full: dayLabel(t, true), days: [t] })) };
  if (n <= 92) {
    const list: Bucket[] = [];
    for (let s = a; s <= b; s += 7) {
      const e = Math.min(s + 6, b);
      const same = date(s).getUTCMonth() === date(e).getUTCMonth();
      const short = s === e ? dayLabel(s) : same ? `${dayLabel(s)}–${date(e).getUTCDate()}` : `${dayLabel(s)}–${dayLabel(e)}`;
      list.push({ label: short, full: `${short}, ${date(e).getUTCFullYear()}`, days: days(s, e) });
    }
    return { unit: 'Week', list };
  }
  const list: Bucket[] = [];
  let s = a;
  while (s <= b) {
    const d = date(s);
    const e = Math.min(D(d.getUTCFullYear(), d.getUTCMonth() + 2, 1) - 1, b);
    list.push({ label: `${MONTHS[d.getUTCMonth()]} ’${String(d.getUTCFullYear()).slice(2)}`, full: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, days: days(s, e) });
    s = e + 1;
  }
  return { unit: 'Month', list };
}

/* ---------------- Generator ---------------- */

const SEASON = [1.12, 0.92, 0.9, 0.93, 0.97, 1.05, 1.15]; // Sun..Sat
const T0 = D(2026, 10, 1);

function rand(seed: string, t: number) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h = Math.imul(h ^ t, 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const round = (v: number, f: Fmt) => (f === 'count' ? Math.round(v) : f === 'hours' ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);
/** Counts at the finest grain are small, so they are rounded stochastically (unbiased) instead of to the nearest integer. */
const roundGrain = (v: number, f: Fmt, jitter: number) => (f === 'count' ? Math.floor(v + jitter) : round(v, f));

const cache = new Map<string, Record<string, number>>();
/** Every non-ratio metric for one unit on one day. */
export function grain(r: ReportDef, u: string, t: number): Record<string, number> {
  const ck = `${r.key}|${u}|${t}`;
  const hit = cache.get(ck);
  if (hit) return hit;
  const out: Record<string, number> = {};
  const dow = date(t).getUTCDay();
  const trend = 1 + (0.12 * (t - T0)) / 365;
  for (const m of r.metrics) {
    if (m.kind === 'ratio') continue;
    let v: number;
    if (m.kind === 'base') v = m.base * unitWeight(r, u) * SEASON[dow] * trend * (1 + (rand(r.key + m.key + u, t) - 0.5) * 0.18);
    else if (m.kind === 'rate') {
      const rate = m.byUnit?.[u] ?? m.rate;
      v = out[m.of] * rate * (1 + (rand(r.key + m.key + u, t) - 0.5) * 0.06);
      if (rate <= 1) v = Math.min(v, out[m.of]);
    } else v = m.calc(...m.from.map((k) => out[k]));
    out[m.key] = roundGrain(v, m.fmt, rand(r.key + m.key + u + 'r', t));
  }
  cache.set(ck, out);
  return out;
}

/** Totals (and ratios) over a set of units and days. */
export function aggregate(r: ReportDef, units: string[], days: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of r.metrics) if (m.kind !== 'ratio') out[m.key] = 0;
  for (const u of units) for (const t of days) {
    const g = grain(r, u, t);
    for (const k in g) out[k] += g[k];
  }
  for (const m of r.metrics) {
    if (m.kind === 'ratio') out[m.key] = out[m.den] ? (out[m.num] / out[m.den]) * (m.fmt === 'percent' ? 100 : 1) : 0;
    else out[m.key] = round(out[m.key], m.fmt);
  }
  return out;
}

/* ---------------- Definitions ---------------- */

const base = (key: string, label: string, fmt: Fmt, b: number, up = true, def?: Partial<MetricDef>): Metric => ({ kind: 'base', key, label, fmt, base: b, up, def });
const rate = (key: string, label: string, fmt: Fmt, of: string, r: number, up = true, def?: Partial<MetricDef>, byUnit?: Record<string, number>): Metric => ({ kind: 'rate', key, label, fmt, of, rate: r, up, def, byUnit });
const calc = (key: string, label: string, fmt: Fmt, from: string[], c: (...v: number[]) => number, up = true, def?: Partial<MetricDef>): Metric => ({ kind: 'calc', key, label, fmt, from, calc: c, up, def });
const ratio = (key: string, label: string, fmt: Fmt, num: string, den: string, up = true, def?: Partial<MetricDef>): Metric => ({ kind: 'ratio', key, label, fmt, num, den, up, def });

const FRESH = { ago: '2 h ago', at: 'Oct 8, 7:40 AM PT' };
const FRESH_FIN = { ago: '9 h ago', at: 'Oct 8, 12:40 AM PT (nightly balance run)' };

type Spec = Omit<ReportDef, 'key' | 'name' | 'group' | 'icon' | 'owner' | 'freshness' | 'definitionsVersion'> & { freshness?: ReportDef['freshness']; definitionsVersion?: string };

const SPECS: Record<string, Spec> = {
  /* ---- Full samples ---- */
  Sales: {
    description: 'Gross and net sales, split between the Official Store and marketplace sellers',
    chart: 'line', chartMetrics: ['gross', 'net', 'orders'], kpis: ['gross', 'net', 'orders', 'aov'], scopes: 'all', officialShare: 0.58, definitionsVersion: 'Version 3 · reviewed Oct 1, 2026',
    metrics: [
      base('gross', 'Gross sales', 'money', 34000, true, { meaning: 'What customers paid for items and shipping, after customer discounts, before cancellations and refunds.', formula: 'Item price × quantity + shipping charged − customer discounts', includes: 'Official Store and marketplace seller sales; orders counted on the day they were placed (PT).', excludes: 'Tax, gift card purchases, test orders.' }),
      rate('canc', 'Cancellations', 'money', 'gross', 0.027, false, { meaning: 'Value of items cancelled before dispatch, by customers, sellers or Marketly.', formula: 'Sum of cancelled item value, on the order placement date', includes: 'Full and partial cancellations.', excludes: 'Refunds after dispatch (see Refunds).' }),
      rate('refunds', 'Refunds', 'money', 'gross', 0.035, false, { meaning: 'Money sent back to customers after dispatch: returns, lost parcels and goodwill refunds.', formula: 'Sum of refunds with status Sent', includes: 'Refunds charged to sellers and to Marketly.', excludes: 'Refunds still Processing; store credit.' }),
      calc('net', 'Sales after cancellations and refunds', 'money', ['gross', 'canc', 'refunds'], (g, c, f) => g - c - f, true, { meaning: 'Gross sales minus cancellations and refunds sent. The figure to compare against targets.', formula: 'Gross sales − Cancellations − Refunds', includes: 'Same scope as Gross sales.', excludes: 'Tax.' }),
      base('orders', 'Orders', 'count', 470, true, { meaning: 'Accepted checkouts.', formula: 'Count of checkouts with an accepted payment', includes: 'One checkout with items from three sellers counts once.', excludes: 'Failed payments, test orders.' }),
      ratio('aov', 'Average order value', 'money', 'gross', 'orders', true, { meaning: 'What one checkout is worth on average.', formula: 'Gross sales ÷ Orders', includes: 'Same scope as Gross sales.', excludes: 'Tax.' }),
    ],
  },
  'Seller sales and earned fees': {
    description: 'What marketplace sellers sold, the fees Marketly earned on those sales, and what sellers keep',
    chart: 'line', chartMetrics: ['sellerSales', 'netFees', 'sellerEarnings'], kpis: ['sellerSales', 'netFees', 'feeRate', 'sellerEarnings'], scopes: 'sellers', officialShare: 0, freshness: FRESH_FIN, definitionsVersion: 'Version 5 · reviewed Sep 28, 2026',
    note: { title: 'Seller sales are not Marketly income', body: 'Customers paid the seller sales amount; Marketly earns only the net fees. The Official Store pays no marketplace fees, so it is not in this report.' },
    metrics: [
      base('sellerSales', 'Seller sales', 'money', 14800, true, { meaning: 'What customers paid marketplace sellers for items and shipping, after seller-funded discounts.', formula: 'Item price × quantity + shipping − seller-funded discounts', includes: 'Marketplace sellers only; orders counted on the day they were placed (PT).', excludes: 'Official Store sales, tax, platform-funded discounts (Marketly pays those).' }),
      rate('fees', 'Fees earned', 'money', 'sellerSales', 0.096, true, { meaning: 'Marketplace fees charged on seller sales: category commission plus the per-order fee.', formula: 'Seller sales × category rate + $0.30 per seller order', includes: 'Commission and per-order fees.', excludes: 'Advertising spend (see Ad displays, clicks, dismissals and spend).' }, { 'northwind-audio': 0.085, 'pixel-and-port': 0.088, 'casa-verde-home': 0.112, 'trailhead-outfitters': 0.1, 'gadget-grove': 0.098, 'bayside-prints': 0.12, 'moss-and-mill': 0.112, 'rowan-leather-co': 0.115, 'brightfield-supply-co': 0.1 }),
      rate('feesReturned', 'Fees returned on refunds', 'money', 'fees', 0.045, false, { meaning: 'Fees given back to sellers when an order is refunded.', formula: 'Fees earned on refunded items', includes: 'Full and partial refunds sent in the period.', excludes: 'The $0.30 per-order fee, which is not returned.' }),
      calc('netFees', 'Net earned fees', 'money', ['fees', 'feesReturned'], (f, r) => f - r, true, { meaning: 'Marketplace fee income Marketly keeps.', formula: 'Fees earned − Fees returned on refunds', includes: 'All marketplace sellers in scope.', excludes: 'Advertising income, Official Store margin.' }),
      calc('sellerEarnings', 'Seller earnings', 'money', ['sellerSales', 'netFees'], (s, f) => s - f, true, { meaning: 'What sellers earn before refunds, holds and payout timing.', formula: 'Seller sales − Net earned fees', includes: 'All marketplace sellers in scope.', excludes: 'Refund deductions and holds, shown in Holds and completed payouts.' }),
      ratio('feeRate', 'Effective fee rate', 'percent', 'netFees', 'sellerSales', true, { meaning: 'Net earned fees as a share of seller sales.', formula: 'Net earned fees ÷ Seller sales × 100', includes: 'All marketplace sellers in scope.', excludes: '—' }),
    ],
  },
  'On-time dispatch': {
    description: 'Packages handed to the carrier by the dispatch deadline, for the Official Store and each seller',
    chart: 'bar', chartMetrics: ['rate', 'late'], kpis: ['rate', 'due', 'late', 'cancelledLate'], scopes: 'all', officialShare: 0.45, definitionsVersion: 'Version 2 · reviewed Sep 15, 2026', target: 'Target 96% · sellers below 92% for 30 days get a performance review',
    metrics: [
      base('due', 'Packages due', 'count', 640, true, { meaning: 'Packages whose dispatch deadline fell in the period.', formula: 'Count of packages by dispatch deadline date (PT)', includes: 'Official Store and seller packages.', excludes: 'Packages cancelled before the deadline.' }),
      rate('onTime', 'Dispatched on time', 'count', 'due', 0.96, true, { meaning: 'Packages with a carrier scan by the dispatch deadline.', formula: 'Count of due packages with a first carrier scan ≤ deadline', includes: 'Scans from any carrier we track.', excludes: 'Label created without a scan.' }, { official: 0.985, 'northwind-audio': 0.972, 'pixel-and-port': 0.958, 'casa-verde-home': 0.91, 'trailhead-outfitters': 0.966, 'gadget-grove': 0.89, 'bayside-prints': 0.95, 'moss-and-mill': 0.944, 'rowan-leather-co': 0.93, 'brightfield-supply-co': 0.962 }),
      calc('late', 'Late or not dispatched', 'count', ['due', 'onTime'], (d, o) => d - o, false, { meaning: 'Due packages without a carrier scan by the deadline.', formula: 'Packages due − Dispatched on time', includes: 'Packages dispatched late and packages still waiting.', excludes: '—' }),
      rate('cancelledLate', 'Cancelled for late dispatch', 'count', 'late', 0.12, false, { meaning: 'Late packages that were cancelled and refunded.', formula: 'Count of late packages cancelled by the customer, seller or Marketly', includes: 'Cancellations after the dispatch deadline.', excludes: 'Cancellations before the deadline.' }),
      ratio('rate', 'On-time dispatch rate', 'percent', 'onTime', 'due', true, { meaning: 'Share of due packages dispatched by the deadline.', formula: 'Dispatched on time ÷ Packages due × 100', includes: 'Same scope as Packages due.', excludes: '—' }),
    ],
  },
  /* ---- Generic samples ---- */
  'Orders and average order value': { description: 'Accepted checkouts and what each one is worth', chart: 'line', chartMetrics: ['orders', 'gross'], kpis: ['orders', 'gross', 'aov', 'units'], scopes: 'all', officialShare: 0.6, metrics: [base('orders', 'Orders', 'count', 470), base('gross', 'Gross sales', 'money', 34000), base('units', 'Units sold', 'count', 1460), ratio('aov', 'Average order value', 'money', 'gross', 'orders')] },
  'Cancellations and refunds': { description: 'Cancelled items and refunds sent, by value and rate', chart: 'bar', chartMetrics: ['refunds', 'cancelled'], kpis: ['cancelled', 'refunds', 'cancelRate', 'orders'], scopes: 'all', officialShare: 0.55, metrics: [base('orders', 'Orders', 'count', 830), rate('cancelled', 'Cancelled orders', 'count', 'orders', 0.026, false), base('refunds', 'Refunds sent', 'money', 1190, false), ratio('cancelRate', 'Cancellation rate', 'percent', 'cancelled', 'orders', false)] },
  'Product sales and margin': { description: 'Official Store sales, landed cost and margin', chart: 'line', chartMetrics: ['sales', 'margin'], kpis: ['sales', 'cost', 'margin', 'marginRate'], scopes: 'official', officialShare: 1, metrics: [base('sales', 'Official Store sales', 'money', 19800), rate('cost', 'Landed cost', 'money', 'sales', 0.62, false), calc('margin', 'Gross margin', 'money', ['sales', 'cost'], (s, c) => s - c), ratio('marginRate', 'Margin rate', 'percent', 'margin', 'sales')] },
  'Purchasing cost': { description: 'Purchase order cost and units received for the Official Store', chart: 'bar', chartMetrics: ['poCost', 'units'], kpis: ['poCost', 'units', 'unitCost', 'freight'], scopes: 'official', officialShare: 1, metrics: [base('poCost', 'Purchase cost', 'money', 9400, false), base('units', 'Units received', 'count', 610), rate('freight', 'Inbound freight', 'money', 'poCost', 0.045, false), ratio('unitCost', 'Average unit cost', 'money', 'poCost', 'units', false)] },
  'Discounts and shipping expense': { description: 'Company-funded discounts and shipping costs against Official Store sales', chart: 'line', chartMetrics: ['discounts', 'shipping'], kpis: ['discounts', 'shipping', 'expense', 'share'], scopes: 'official', officialShare: 1, metrics: [base('sales', 'Official Store sales', 'money', 19800), base('discounts', 'Discounts funded', 'money', 1450, false), base('shipping', 'Shipping expense', 'money', 2100, false), calc('expense', 'Total expense', 'money', ['discounts', 'shipping'], (a, b) => a + b, false), ratio('share', 'Expense share of sales', 'percent', 'expense', 'sales', false)] },
  'Returns cost': { description: 'What Official Store returns cost: shipping, refurbishing and write-offs', chart: 'bar', chartMetrics: ['returnsCost', 'returned'], kpis: ['returnsCost', 'returned', 'perReturn', 'writeOff'], scopes: 'official', officialShare: 1, metrics: [base('returned', 'Units returned', 'count', 38, false), base('returnsCost', 'Returns cost', 'money', 640, false), rate('writeOff', 'Written off', 'money', 'returnsCost', 0.3, false), ratio('perReturn', 'Cost per return', 'money', 'returnsCost', 'returned', false)] },
  'Discount funding': { description: 'Who paid for discounts on marketplace orders: sellers or Marketly', chart: 'line', chartMetrics: ['sellerFunded', 'platformFunded'], kpis: ['sellerFunded', 'platformFunded', 'total', 'platformShare'], scopes: 'sellers', officialShare: 0, freshness: FRESH_FIN, metrics: [base('sellerFunded', 'Seller-funded discounts', 'money', 820), base('platformFunded', 'Marketly-funded discounts', 'money', 540, false), calc('total', 'All discounts', 'money', ['sellerFunded', 'platformFunded'], (a, b) => a + b), ratio('platformShare', 'Marketly share', 'percent', 'platformFunded', 'total', false)] },
  'Amounts owed to sellers': { description: 'Earnings added to seller balances, deductions and amounts paid out', chart: 'bar', chartMetrics: ['added', 'paidOut'], kpis: ['added', 'deductions', 'paidOut', 'owed'], scopes: 'sellers', officialShare: 0, freshness: FRESH_FIN, metrics: [base('added', 'Earnings added', 'money', 13400), rate('deductions', 'Refund deductions', 'money', 'added', 0.04, false), rate('paidOut', 'Paid out', 'money', 'added', 0.93), calc('owed', 'Change in amount owed', 'money', ['added', 'deductions', 'paidOut'], (a, d, p) => a - d - p)] },
  'Holds and completed payouts': { description: 'Payouts sent to sellers and money held for review', chart: 'bar', chartMetrics: ['paid', 'held'], kpis: ['payouts', 'paid', 'held', 'heldShare'], scopes: 'sellers', officialShare: 0, freshness: FRESH_FIN, metrics: [base('payouts', 'Payouts completed', 'count', 38), base('paid', 'Amount paid', 'money', 13600), base('held', 'Amount held', 'money', 1900, false), calc('total', 'Paid and held', 'money', ['paid', 'held'], (a, b) => a + b), ratio('heldShare', 'Held share', 'percent', 'held', 'total', false)] },
  'Views, cart additions, purchases': { description: 'Product page views and how many turn into cart additions and purchases', chart: 'line', chartMetrics: ['views', 'carts', 'purchases'], kpis: ['views', 'carts', 'purchases', 'conversion'], scopes: 'all', officialShare: 0.55, metrics: [base('views', 'Product views', 'count', 182000), rate('carts', 'Cart additions', 'count', 'views', 0.062), rate('purchases', 'Purchases', 'count', 'carts', 0.29), ratio('conversion', 'View-to-purchase rate', 'percent', 'purchases', 'views')] },
  'Searches with no available result': { description: 'Searches that found nothing in stock, so customers saw no offer to buy', chart: 'line', chartMetrics: ['noResult', 'searches'], kpis: ['searches', 'noResult', 'noResultRate', 'refined'], scopes: 'all', officialShare: 0.5, metrics: [base('searches', 'Searches', 'count', 41000), rate('noResult', 'No available result', 'count', 'searches', 0.037, false), rate('refined', 'Searched again', 'count', 'noResult', 0.46), ratio('noResultRate', 'No-result rate', 'percent', 'noResult', 'searches', false)] },
  Stockouts: { description: 'Offers that ran out of stock and the sales likely lost', chart: 'bar', chartMetrics: ['stockouts', 'lostSales'], kpis: ['stockouts', 'lostSales', 'hours', 'perStockout'], scopes: 'all', officialShare: 0.4, metrics: [base('stockouts', 'Stockouts', 'count', 64, false), base('lostSales', 'Estimated lost sales', 'money', 2300, false), base('hours', 'Hours out of stock', 'hours', 1380, false), ratio('perStockout', 'Hours per stockout', 'hours', 'hours', 'stockouts', false)] },
  'Product return reasons': { description: 'Why customers return products', chart: 'bar', chartMetrics: ['returns', 'nad'], kpis: ['returns', 'nad', 'damaged', 'nadRate'], scopes: 'all', officialShare: 0.5, metrics: [base('returns', 'Returns', 'count', 52, false), rate('nad', 'Not as described', 'count', 'returns', 0.31, false), rate('damaged', 'Damaged on arrival', 'count', 'returns', 0.18, false), ratio('nadRate', 'Not-as-described share', 'percent', 'nad', 'returns', false)] },
  'Delivery issues': { description: 'Shipments with a delivery exception: late, lost or damaged', chart: 'bar', chartMetrics: ['issues', 'shipments'], kpis: ['shipments', 'issues', 'issueRate', 'lost'], scopes: 'all', officialShare: 0.45, metrics: [base('shipments', 'Shipments', 'count', 900), rate('issues', 'Delivery issues', 'count', 'shipments', 0.028, false), rate('lost', 'Lost by carrier', 'count', 'issues', 0.15, false), ratio('issueRate', 'Issue rate', 'percent', 'issues', 'shipments', false)] },
  'Seller cancellations': { description: 'Orders cancelled by sellers, usually for stock problems', chart: 'bar', chartMetrics: ['cancels', 'orders'], kpis: ['orders', 'cancels', 'rate', 'stock'], scopes: 'sellers', officialShare: 0, metrics: [base('orders', 'Seller orders', 'count', 360), rate('cancels', 'Cancelled by seller', 'count', 'orders', 0.018, false), rate('stock', 'Out of stock reason', 'count', 'cancels', 0.7, false), ratio('rate', 'Seller cancellation rate', 'percent', 'cancels', 'orders', false)] },
  'Response time and case backlog': { description: 'New cases, cases resolved and how fast customers get a first reply', chart: 'line', chartMetrics: ['newCases', 'resolved'], kpis: ['newCases', 'resolved', 'avgReply', 'replyHours'], scopes: 'all', officialShare: 0.5, metrics: [base('newCases', 'New cases', 'count', 46, false), rate('resolved', 'Cases resolved', 'count', 'newCases', 1.02), rate('replyHours', 'Hours to first reply (total)', 'hours', 'newCases', 3.1, false), ratio('avgReply', 'Average first reply', 'hours', 'replyHours', 'newCases', false)] },
  'Complaint patterns': { description: 'Complaints by customers and how many repeat for the same seller or product', chart: 'bar', chartMetrics: ['complaints', 'repeat'], kpis: ['complaints', 'repeat', 'repeatRate', 'escalated'], scopes: 'all', officialShare: 0.4, metrics: [base('complaints', 'Complaints', 'count', 31, false), rate('repeat', 'Repeat complaints', 'count', 'complaints', 0.22, false), rate('escalated', 'Escalated to dispute', 'count', 'complaints', 0.12, false), ratio('repeatRate', 'Repeat share', 'percent', 'repeat', 'complaints', false)] },
  'Returning buyers and repeat purchases': { description: 'Buyers who ordered before and how often they come back', chart: 'line', chartMetrics: ['buyers', 'returning'], kpis: ['buyers', 'returning', 'repeatRate', 'newBuyers'], scopes: 'all', officialShare: 0.58, metrics: [base('buyers', 'Buyers', 'count', 760), rate('returning', 'Returning buyers', 'count', 'buyers', 0.41), calc('newBuyers', 'New buyers', 'count', ['buyers', 'returning'], (b, r) => b - r), ratio('repeatRate', 'Returning share', 'percent', 'returning', 'buyers')] },
  'Campaign results': { description: 'Sales during campaigns and what the discounts cost', chart: 'line', chartMetrics: ['campaignSales', 'discountCost'], kpis: ['campaignSales', 'discountCost', 'costShare', 'campaignOrders'], scopes: 'all', officialShare: 0.62, metrics: [base('campaignSales', 'Campaign sales', 'money', 6200), rate('discountCost', 'Discount cost', 'money', 'campaignSales', 0.14, false), base('campaignOrders', 'Campaign orders', 'count', 150), ratio('costShare', 'Cost share of sales', 'percent', 'discountCost', 'campaignSales', false)] },
  'Ad displays, clicks, dismissals and spend': { description: 'Sponsored placements: displays, clicks, dismissals and what sellers spent', chart: 'line', chartMetrics: ['clicks', 'spend'], kpis: ['displays', 'clicks', 'ctr', 'spend'], scopes: 'sellers', officialShare: 0, metrics: [base('displays', 'Ad displays', 'count', 240000), rate('clicks', 'Clicks', 'count', 'displays', 0.011), rate('dismissals', 'Dismissals', 'count', 'displays', 0.004, false), base('spend', 'Ad spend', 'money', 1800), ratio('ctr', 'Click-through rate', 'percent', 'clicks', 'displays')] },
};

export const REPORT_DEFS: ReportDef[] = LIBRARY.flatMap((g) =>
  g.reports.map((name) => {
    const s = SPECS[name];
    const owner = g.owner;
    return {
      ...s,
      key: reportKey(name),
      name,
      group: g.name,
      icon: g.icon,
      owner,
      freshness: s.freshness ?? FRESH,
      definitionsVersion: s.definitionsVersion ?? 'Version 1 · reviewed Oct 1, 2026',
      metrics: s.metrics.map((m) => ({ ...m, def: { ...genericDef(m, s.metrics), owner, version: s.definitionsVersion?.split(' · ')[0] ?? 'Version 1', ...m.def } })),
    } as ReportDef;
  }),
);

function genericDef(m: Metric, all: Metric[]): MetricDef {
  const lab = (k: string) => all.find((x) => x.key === k)?.label ?? k;
  const formula = m.kind === 'ratio' ? `${lab(m.num)} ÷ ${lab(m.den)}${m.fmt === 'percent' ? ' × 100' : ''}` : m.kind === 'rate' ? `Counted per ${lab(m.of).toLowerCase()} record` : m.kind === 'calc' ? m.from.map(lab).join(' and ') : 'Sum of daily values';
  return { meaning: `${m.label} in the selected period and seller scope, by Pacific Time day.`, formula, includes: 'Every record in the selected seller scope.', excludes: 'Test orders and records created by staff for training.', owner: '', version: 'Version 1' };
}

export const findReport = (key: string | undefined) => REPORT_DEFS.find((r) => r.key === key);

/* ---------------- Formatting ---------------- */

export function fmtValue(v: number, f: Fmt, compact = false): string {
  if (f === 'percent') return `${v.toFixed(1)}%`;
  if (f === 'hours') return `${v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
  if (f === 'count') return compact && v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : compact && v >= 100000 ? `${(v / 1000).toFixed(0)}k` : Math.round(v).toLocaleString('en-US');
  if (compact && Math.abs(v) >= 1e6) return `${v < 0 ? '−' : ''}${(Math.abs(v) / 1e6).toFixed(2)}M`;
  if (compact && Math.abs(v) >= 10000) return `${v < 0 ? '−' : ''}$${(Math.abs(v) / 1000).toFixed(1)}k`;
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Plain number for CSV cells. */
export const csvNumber = (v: number, f: Fmt) => (f === 'count' ? String(Math.round(v)) : f === 'money' ? v.toFixed(2) : v.toFixed(1));
