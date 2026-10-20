import { dayKey } from '@marketly/web-shared/lib/dates';

// Dates for the account screens, shown in the market time zone (America/Los_Angeles, API.md 4.5).

const TZ = 'America/Los_Angeles';

const fmt = (iso: string | Date, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('en-US', { timeZone: TZ, ...o });

/** YYYY-MM-DD in the market time zone. */
export { dayKey };

/** Whole days between the market-day of `iso` and today (0 = today, 1 = yesterday). */
export const daysAgo = (iso: string | Date) => Math.round((Date.parse(dayKey(new Date())) - Date.parse(dayKey(iso))) / 86_400_000);

const sameYear = (iso: string | Date) => fmt(iso, { year: 'numeric' }) === fmt(new Date(), { year: 'numeric' });

/** "9:20 AM" */
export const time = (iso: string | Date) => fmt(iso, { hour: 'numeric', minute: '2-digit' });

/** "Oct 5" (adds the year when it isn't this year). */
export const date = (iso: string | Date) => fmt(iso, { month: 'short', day: 'numeric', ...(sameYear(iso) ? {} : { year: 'numeric' }) });

/** "Oct 5, 2026" */
export const dateLong = (iso: string | Date) => fmt(iso, { month: 'short', day: 'numeric', year: 'numeric' });

/** "Oct 6, 9:12 AM" */
export const dateTime = (iso: string | Date) => `${date(iso)}, ${time(iso)}`;

/** "Mon, Oct 5" */
export const weekdayDate = (iso: string | Date) => fmt(iso, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear(iso) ? {} : { year: 'numeric' }) });

/** List time: "9:20 AM" today, "Yesterday", "Wed" this week, else "Oct 6". */
export function listTime(iso: string | Date): string {
  const d = daysAgo(iso);
  if (d <= 0) return time(iso);
  if (d === 1) return 'Yesterday';
  if (d < 7) return fmt(iso, { weekday: 'short' });
  return date(iso);
}

/** Day separator in a conversation: "Today", "Yesterday" or "Mon, Oct 5". */
export function daySeparator(iso: string | Date): string {
  const d = daysAgo(iso);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  return weekdayDate(iso);
}

/** Inbox section: "Today", "This week" (last 7 days) or "Earlier". */
export function ageGroup(iso: string | Date): 'Today' | 'This week' | 'Earlier' {
  const d = daysAgo(iso);
  return d <= 0 ? 'Today' : d < 7 ? 'This week' : 'Earlier';
}

/** "12/29" from a card's expiry month and year. */
export const cardExpiry = (m: number, y: number) => `${String(m).padStart(2, '0')}/${String(y % 100).padStart(2, '0')}`;

/** A URL-safe slug for product links (product routes carry the id; the slug is cosmetic, gap G1). */
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'product';
