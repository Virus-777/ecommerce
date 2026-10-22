/**
 * Pure software rules: prices (sales, packs), sizes, slugs, references, ratings, rails and labels the app shows.
 * No I/O.
 */
import { format as formatMoney, type Money } from '../../../kernel/lib/money.js';
import { slugify } from '../../../kernel/lib/text.js';
import type { AppPrice, RatingSummary, SoftwarePurchase } from '../../../spec/software.js';

export const PLATFORMS = ['android', 'ios', 'windows', 'macos', 'linux', 'web'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const APP_STATUSES = ['draft', 'in_review', 'published', 'hidden'] as const;
export type AppStatus = (typeof APP_STATUSES)[number];
export const RAIL_SOURCES = ['manual', 'newest', 'category', 'platform', 'top_rated'] as const;
export const RAIL_STYLES = ['carousel', 'list'] as const;
export type PurchaseStatus = SoftwarePurchase['status'];

export const LIMITS = {
  title: 80,
  brief: 60,
  name: 80,
  company: 80,
  subcategory: 60,
  description: 4000,
  listItems: 20,
  listItem: 200,
  screenshots: 10,
  databases: 10,
  versions: 30,
  versionNotes: 1000,
  permissions: 20,
  platformLabels: 12,
  short: 120,
  notice: 600,
  reviewText: 1000,
  railTitle: 60,
  rails: 20,
  packApps: 20,
} as const;

/** Rails show 3 to 20 apps */
export const RAIL_LIMIT = { min: 3, max: 20 } as const;
/** top_rated rails take apps with at least this many visible ratings */
export const TOP_RATED_MIN_REVIEWS = 3;
/** requires_action purchases older than this are abandoned (software.abandon-stale) */
export const ABANDON_AFTER_MS = 30 * 60_000;

/* ------------------------------------------------------------------ slugs */

export const SLUG_MAX = 80;
export const isValidSlug = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= SLUG_MAX;
export const slugOf = (given: string | null | undefined, from: string) => slugify(given?.trim() || from, { max: SLUG_MAX });
export const isIconName = (s: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);

/* ------------------------------------------------------------------ sizes */

/**
 * Sizes in 1,000-based units: bytes, KB and MB as whole numbers, GB and above with one decimal ("46 MB", "1.2 GB").
 */
export function sizeLabel(bytes: number): string {
  const b = Math.max(0, Math.floor(bytes || 0));
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9 || Math.round(b / 1e6) >= 1000) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6 || Math.round(b / 1e3) >= 1000) return `${Math.round(b / 1e6)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${b} B`;
}

/* ------------------------------------------------------------------ prices */

export const moneyLabel = (m: Money) => formatMoney(m);

/** A sale runs while it has a price below the regular one and its end is in the future */
export function saleRuns(a: { free: boolean; price: number | null; sale_price: number | null; sale_ends_at: Date | null }, now: Date): boolean {
  return !a.free && a.price != null && a.sale_price != null && a.sale_price < a.price && a.sale_ends_at != null && a.sale_ends_at > now;
}

/** Whole percent off: 24.99 → 12.49 is 50 */
export const percentOff = (regular: number, now: number) => (regular > 0 ? Math.max(0, Math.round((1 - now / regular) * 100)) : 0);

/**
 * The price as the app shows it. Store views (`stored` false) show the sale only while it runs; staff (`stored`
 * true) also see a sale that is set but not running (saleAmount, saleEndsAt).
 */
export function appPrice(a: { free: boolean; price: number | null; sale_price: number | null; sale_ends_at: Date | null; currency: string }, now: Date, stored = false): AppPrice {
  if (a.free) return { free: true, amount: null, saleAmount: null, saleEndsAt: null, current: null, label: 'Free', wasLabel: null, offPercent: null };
  // a paid app without a price yet (a draft: publishing needs one)
  if (a.price == null) return { free: false, amount: null, saleAmount: null, saleEndsAt: null, current: null, label: 'No price yet', wasLabel: null, offPercent: null };
  const m = (amount: number): Money => ({ amount, currency: a.currency });
  const running = saleRuns(a, now);
  const current = running ? m(a.sale_price!) : m(a.price);
  const showSale = running || (stored && a.sale_price != null);
  return {
    free: false,
    amount: m(a.price),
    saleAmount: showSale && a.sale_price != null ? m(a.sale_price) : null,
    saleEndsAt: showSale && a.sale_ends_at ? a.sale_ends_at.toISOString() : null,
    current,
    label: moneyLabel(current),
    wasLabel: running ? moneyLabel(m(a.price)) : null,
    offPercent: running ? percentOff(a.price, a.sale_price!) : null,
  };
}

/** What the customer pays now; null when free */
export const currentAmount = (a: { free: boolean; price: number | null; sale_price: number | null; sale_ends_at: Date | null }, now: Date): number | null =>
  a.free || a.price == null ? null : saleRuns(a, now) ? a.sale_price! : a.price;

/** "Prices valid until Oct 31" in the market's time zone */
export function validUntilLabel(at: Date, tz: string): string {
  return `Prices valid until ${new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(at)}`;
}

/** A pack against its apps' regular prices: the total and the whole percent saved (0 when it saves nothing) */
export function packSaving(packPrice: number, regularPrices: number[]): { total: number; savePercent: number } {
  const total = regularPrices.reduce((s, p) => s + p, 0);
  return { total, savePercent: total > packPrice ? percentOff(total, packPrice) : 0 };
}

/* ------------------------------------------------------------------ text */

/** Text the search box matches: title, company, brief, category and subcategory, lowercased */
export function searchTextOf(a: { title: string; company: string; brief: string; category?: string | null; subcategory?: string | null }): string {
  return [a.title, a.company, a.brief, a.category, a.subcategory]
    .filter(Boolean)
    .join(' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ references */

export const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** SW- plus five characters from the unambiguous alphabet */
export function makeRef(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += REF_ALPHABET[Math.floor(random() * REF_ALPHABET.length)];
  return `SW-${s}`;
}

export const PURCHASE_STATUS_LABEL: Record<PurchaseStatus, string> = {
  pending_payment: 'Waiting for payment',
  requires_action: 'Confirm with your bank',
  paid: 'Paid',
  failed: 'Payment failed',
  cancelled: 'Cancelled',
};

/* ------------------------------------------------------------------ ratings */

/** Stars stored as [5★, 4★, 3★, 2★, 1★] counts */
export const starsOf = (v: unknown): number[] => {
  const a = Array.isArray(v) ? v.map((n) => (typeof n === 'number' && n >= 0 ? Math.floor(n) : 0)) : [];
  return [0, 1, 2, 3, 4].map((i) => a[i] ?? 0);
};
export function ratingOf(sum: number, count: number, stars: unknown): RatingSummary {
  return { average: count > 0 ? Math.round((sum / count) * 10) / 10 : null, count, stars: starsOf(stars) };
}
/** The stars array after adding (+1) or taking away (−1) one rating */
export function withRating(stars: unknown, rating: number, delta: 1 | -1): number[] {
  const s = starsOf(stars);
  const i = 5 - rating;
  s[i] = Math.max(0, (s[i] ?? 0) + delta);
  return s;
}

/** How a review is signed: first name and last initial ("Dana Ross" → "Dana R."); Customer when unknown */
export function shortName(displayName: string | null | undefined): string {
  const parts = String(displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  const [first, ...rest] = parts;
  const last = rest.at(-1);
  return last ? `${first} ${last[0]!.toUpperCase()}.` : first!;
}

/* ------------------------------------------------------------------ rails */

export interface DefaultRail {
  key: string;
  title: string;
  source: (typeof RAIL_SOURCES)[number];
  style: (typeof RAIL_STYLES)[number];
  categorySlug?: string;
  platform?: Platform;
  limit: number;
}

/** The Recommended tab's rails before staff change them (spec notes, Rails) */
export const DEFAULT_RAILS: readonly DefaultRail[] = [
  { key: 'recommended', title: 'Recommended for you', source: 'manual', style: 'carousel', limit: 10 },
  { key: 'new-apps', title: 'New apps', source: 'newest', style: 'list', limit: 3 },
  { key: 'games', title: 'Games', source: 'category', style: 'carousel', categorySlug: 'games', limit: 10 },
  { key: 'browsers', title: 'Browsers', source: 'category', style: 'list', categorySlug: 'browsers', limit: 3 },
  { key: 'pc-apps', title: 'PC apps', source: 'platform', style: 'carousel', platform: 'windows', limit: 10 },
];

/* ------------------------------------------------------------------ licence keys */

/** XXXXX-XXXXX-XXXXX-XXXXX from the unambiguous alphabet (no 0/O, 1/I/L) */
export const LICENCE_KEY_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}(-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}){3}$/;
export const LICENCE_DEVICES_MAX = 100;

/** A new licence key: four groups of five characters, drawn from a cryptographic source by default */
export function makeLicenceKey(randomBytes: (n: number) => Uint8Array): string {
  // 32 characters divide 256 evenly, so a byte modulo 32 is uniform
  const bytes = randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) {
    if (i && i % 5 === 0) s += '-';
    s += REF_ALPHABET[bytes[i]! % REF_ALPHABET.length];
  }
  return s;
}

/** A licence key as a customer may type it: upper case, spaces and dashes in any place (null when it is not one) */
export function normaliseLicenceKey(text: string): string | null {
  const raw = text.toUpperCase().replace(/[\s-]+/g, '');
  if (raw.length !== 20) return null;
  const key = raw.match(/.{5}/g)!.join('-');
  return LICENCE_KEY_PATTERN.test(key) ? key : null;
}

/** The devices one key unlocks, read from a licence label written before licenceDevices existed ("One-time purchase · 2 devices") */
export function devicesFromLabel(label: string | null | undefined): number | null {
  const m = /\b(\d{1,3})\s*devices?\b/i.exec(label ?? '');
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= LICENCE_DEVICES_MAX ? n : null;
}

/** "Use on up to 2 devices", "Use on 1 device", "Use on any number of devices" */
export function devicesLabel(devices: number | null | undefined): string {
  if (!devices) return 'Use on any number of devices';
  return devices === 1 ? 'Use on 1 device' : `Use on up to ${devices} devices`;
}

/** The last five characters of a key, for the action history */
export const keyTail = (key: string | null | undefined) => (key ? `…${key.slice(-5)}` : null);
