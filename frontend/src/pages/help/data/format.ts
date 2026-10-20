import { humanize } from '@marketly/web-shared/lib/format';

// Date formatting for the help, policy and seller-application screens: API dates are ISO UTC and are shown
// in the market time zone (America/Los_Angeles, docs: API-INTEGRATION-BRIEF §4.5).

const TZ = 'America/Los_Angeles';

const fmt = (iso: string | null | undefined, o: Intl.DateTimeFormatOptions) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { timeZone: TZ, ...o });
};

/** "Oct 6, 2026" */
export const dateLong = (iso?: string | null) => fmt(iso, { month: 'short', day: 'numeric', year: 'numeric' });
/** "Oct 6" */
export const dateShort = (iso?: string | null) => fmt(iso, { month: 'short', day: 'numeric' });
/** "Tue, Oct 6" */
export const dayDate = (iso?: string | null) => fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' });
/** "Tue, Oct 6, 2026" */
export const dayDateYear = (iso?: string | null) => fmt(iso, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
/** "Tue, Oct 6, 4:10 PM" */
export const dayDateTime = (iso?: string | null) => fmt(iso, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** "Oct 6, 4:10 PM" */
export const dateTime = (iso?: string | null) => fmt(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** "2:14 PM PT" */
export const timePT = (iso?: string | null) => (iso ? `${fmt(iso, { hour: 'numeric', minute: '2-digit' })} PT` : '');

/** Whole days from now until a date (negative when past). */
export const daysUntil = (iso?: string | null) => (iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000) : 0);

/** "snake_case_value" → "Snake case value" (fallback labels for enums the API sends without a label). */
export { humanize };
