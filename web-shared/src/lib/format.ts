/** $1,234.50: prices are USD at launch (plan ch. 21). */
export const money = (n: number) =>
  '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1,234 */
export const num = (n: number) => Number(n).toLocaleString('en-US');

/** Percent off between a sale price and a was price, rounded. */
export const percentOff = (price: number, was?: number | null) =>
  was && was > price ? Math.round((1 - price / was) * 100) : 0;

/** "Jordan Lee" -> "JL" */
export const initials = (name: string) =>
  String(name).split(' ').map((w) => w[0]).slice(0, 2).join('');

/** A money value as the API sends it: an integer amount in minor units (cents) plus the currency. */
export interface MoneyValue {
  amount: number;
  currency: string;
}

/** Formats an API money value: { amount: 18900, currency: 'USD' } -> "$189.00". Empty for null. */
export const formatMoney = (m?: MoneyValue | null): string => (m ? money(m.amount / 100) : '');

/** Dollars of an API money value (for arithmetic in the UI). */
export const dollars = (m?: MoneyValue | null): number => (m ? m.amount / 100 : 0);

const PT_INSTANT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Server sentences sometimes carry raw ISO instants ("Respond by 2026-10-15T16:58:28.953Z", "next pickup
 * 2026-10-15T23:00:00.000Z"): shows them as market time, "Thu, Oct 15, 4:58 PM PT". Other text is unchanged.
 */
export const isoInText = (text?: string | null): string =>
  (text ?? '').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g, (m) => {
    const d = new Date(m);
    return Number.isNaN(d.getTime()) ? m : `${PT_INSTANT.format(d)} PT`;
  });

/**
 * Money typed in a field → integer cents: "$1,234.50", "12.5" and "12" are read; more than two decimals, a minus sign
 * or anything else is not money (null). Every money field in the three apps reads input this way.
 */
export function parseCents(text: string | null | undefined): number | null {
  const t = (text ?? '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t) && !/^\.\d{1,2}$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/**
 * A URL slug, the same rule the backend saves (kernel slugify): accents dropped, "&" read as "and", anything else not
 * a letter or digit becomes one hyphen, at most 80 characters. Text with no letters or digits gives `fallback`.
 */
export function slugify(text: string, fallback = ''): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** An API key as words: "PARTLY_DELIVERED" and "partly_delivered" → "Partly delivered"; "order.manager" → "Order manager" */
export function humanize(key?: string | null): string {
  const t = (key ?? '').replace(/[_.-]+/g, ' ').trim().toLowerCase();
  return t ? t[0]!.toUpperCase() + t.slice(1) : '';
}
