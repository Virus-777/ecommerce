import { weekdayDate } from '@marketly/web-shared/lib/dates';
import { ApiError, type components } from '@marketly/web-shared/api';

// API types and helpers for the Marketing screen (promotions: seller discounts and platform campaign
// invitations; advertising: sponsored campaigns). Also used by the Ad request screen (dates, phase-3 checks).

type S = components['schemas'];
export type SellerDiscount = S['promotions.SellerDiscount'];
export type DiscountRule = S['promotions.DiscountRule'];
export type SellerDiscountInput = S['promotions.SellerDiscountInput'];
export type Invitation = S['promotions.Invitation'];
export type ParticipationOffer = S['promotions.ParticipationOffer'];
export type SellerAdCampaign = S['advertising.SellerAdCampaign'];
export type Money = S['Money'];

export const MARKET_TZ = 'America/Los_Angeles';


/* ------------------------------------------------------------------ errors */

/** The endpoint belongs to a later launch phase (501 NOT_IMPLEMENTED, details.reason later_phase / not_built). */
export const isLaterPhase = (e: unknown): boolean => e instanceof ApiError && e.code === 'NOT_IMPLEMENTED';

/** Query retry that doesn't retry a later-phase endpoint (the default retries 5xx). */
export const retryUnlessLater = (count: number, e: unknown): boolean => !isLaterPhase(e) && count < 2 && (!(e instanceof ApiError) || e.status >= 500 || e.status === 429);

/* ------------------------------------------------------------------ money and numbers */

export const fromDollars = (dollarsValue: number, currency = 'USD'): Money => ({ amount: Math.round(dollarsValue * 100), currency });

/** 1500 → "15%", 3333 → "33.33%" */
/** Basis points as a percent: 1500 → "15%" */
export const bpsPercent = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;

/** "12.50" → true (positive amount with at most two decimals) */
export const isAmount = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim()) && Number(v) > 0;

/* ------------------------------------------------------------------ dates (Pacific Time) */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Offset of a time zone from UTC at an instant, in ms. */
function tzOffset(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall time in the zone → ISO instant. */
function zonedToIso(y: number, mo: number, d: number, h: number, mi: number, tz = MARKET_TZ): string | null {
  const guess = Date.UTC(y, mo, d, h, mi);
  if (Number.isNaN(guess)) return null;
  const check = new Date(guess);
  if (check.getUTCMonth() !== mo || check.getUTCDate() !== d) return null;
  let utc = guess - tzOffset(guess, tz);
  utc = guess - tzOffset(utc, tz);
  return new Date(utc).toISOString();
}

/**
 * Parses the design's date-time text in Pacific Time: "Nov 20, 2026, 12:00 AM", "Nov 20, 2026" (midnight,
 * or 11:59 PM with endOfDay) or "2026-11-20 14:30". Returns an ISO instant or null.
 */
export function parsePT(text: string, o: { endOfDay?: boolean } = {}): string | null {
  const s = text.trim();
  let m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})(?:,?\s*(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(s);
  if (m) {
    const mo = MONTHS.findIndex((x) => x.toLowerCase() === m![1].toLowerCase());
    if (mo < 0) return null;
    let h = m[4] ? Number(m[4]) : o.endOfDay ? 23 : 0;
    const mi = m[5] ? Number(m[5]) : m[4] ? 0 : o.endOfDay ? 59 : 0;
    if (m[6]) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0);
    }
    if (h > 23 || mi > 59) return null;
    return zonedToIso(Number(m[3]), mo, Number(m[2]), h, mi);
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(s);
  if (m) return zonedToIso(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : o.endOfDay ? 23 : 0, m[5] ? Number(m[5]) : o.endOfDay ? 59 : 0);
  return null;
}

const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: MARKET_TZ, ...o });

/** ISO → "Sat, Oct 10" */
export const weekdayPT = (iso?: string | null): string => (iso ? weekdayDate(iso) : '');

/** ISO → "Thu, Oct 8, 11:05 AM" */
export const stampPT = (iso?: string | null): string => (iso ? dtf({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '');

/** "2026-10-01" → "Oct 1" */
export const shortDay = (ymd: string): string => {
  const [y, mo, d] = ymd.split('-').map(Number);
  return y && mo && d ? `${MONTHS[mo - 1]} ${d}` : ymd;
};

/** "Oct 13 – Oct 19, 2026 PT" → "Oct 13 – Oct 19" (the column header says PT) */
export const periodShort = (display: string) => display.replace(/,\s*\d{4}/g, '').replace(/\s*PT$/, '');

/* ------------------------------------------------------------------ status labels */

const DISCOUNT_STATUS: Record<SellerDiscount['campaign']['status'], string> = {
  draft: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  scheduled: 'Scheduled',
  live: 'Live',
  paused: 'Paused',
  ended: 'Finished',
  cancelled: 'Cancelled',
};
export const discountStatus = (s: SellerDiscount['campaign']['status']) => DISCOUNT_STATUS[s] ?? s;

const PARTICIPATION_STATE: Record<Invitation['participation']['state'], string> = {
  invited: 'Invited',
  accepted: 'Joined',
  declined: 'Declined',
  withdrawal_requested: 'Leave requested',
  withdrawn: 'Left',
  removed: 'Removed',
  expired: 'Expired',
};
export const participationState = (s: Invitation['participation']['state']) => PARTICIPATION_STATE[s] ?? s;
export const PARTICIPATION_TONE: Record<string, 'success' | 'warning' | 'info' | 'danger' | ''> = { Invited: 'info', Joined: 'success', 'Leave requested': 'warning', Removed: 'danger' };

const AD_STATUS: Record<SellerAdCampaign['campaign']['status'], string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  live: 'Live',
  paused: 'Paused',
  finished: 'Finished',
  archived: 'Archived',
  rejected: 'Rejected',
};
export const adStatus = (s: SellerAdCampaign['campaign']['status']) => AD_STATUS[s] ?? s;

/* ------------------------------------------------------------------ discounts */

export const DISCOUNT_TYPES = ['Percentage off', 'Fixed amount off', 'Minimum spend', 'Free shipping'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export interface DiscountDraft {
  name: string;
  type: DiscountType;
  amt: string;
  /** Minimum order for the "Minimum spend" type */
  min: string;
  limit: string;
  offerId: string;
  start: string;
  end: string;
  stack: boolean;
}

export const EMPTY_DISCOUNT: DiscountDraft = { name: '', type: 'Percentage off', amt: '', min: '', limit: '', offerId: '', start: '', end: '', stack: true };

/** The API rule for a draft (amounts already validated), or null when the amount isn't usable yet. */
export function discountRule(d: Pick<DiscountDraft, 'type' | 'amt' | 'min'>, currency = 'USD'): { kind: SellerDiscountInput['kind']; discount: DiscountRule } | null {
  const a = Number(d.amt);
  const ok = isAmount(d.amt);
  switch (d.type) {
    case 'Percentage off':
      return ok ? { kind: 'markdown', discount: { kind: 'markdown', percentOffBps: Math.round(a * 100) } } : null;
    case 'Fixed amount off':
      return ok ? { kind: 'markdown', discount: { kind: 'markdown', amountOff: fromDollars(a, currency) } } : null;
    case 'Minimum spend':
      return ok && isAmount(d.min) ? { kind: 'min_spend', discount: { kind: 'min_spend', amountOff: fromDollars(a, currency), minSpend: fromDollars(Number(d.min), currency), minSpendScope: 'seller_package' } } : null;
    case 'Free shipping':
      return ok ? { kind: 'free_shipping', discount: { kind: 'free_shipping', freeShipping: true, minSpend: fromDollars(a, currency) } } : null;
  }
}

/** Offers covered by a discount, grouped by product: "Duvet Cover (2 offers), Sheet Set" */
export function offersLabel(offers: ParticipationOffer[]): string {
  const byProduct = new Map<string, { title: string; n: number }>();
  for (const o of offers) {
    const g = byProduct.get(o.productId);
    if (g) g.n += 1;
    else byProduct.set(o.productId, { title: o.title, n: 1 });
  }
  return [...byProduct.values()].map((g) => (g.n > 1 ? `${g.title} (${g.n} offers)` : g.title)).join(', ') || '—';
}

/** Seller-side actions per discount status (promotions status flow). */
export function discountActions(s: SellerDiscount['campaign']['status']): Array<'schedule' | 'pause' | 'resume' | 'end'> {
  switch (s) {
    case 'draft':
      return ['schedule', 'end'];
    case 'scheduled':
      return ['pause', 'end'];
    case 'live':
      return ['pause', 'end'];
    case 'paused':
      return ['resume', 'end'];
    default:
      return [];
  }
}

/** Open invitations come first on the Platform campaigns tab; the rest are past participation. */
export const isOpenInvitation = (i: Invitation) => ['invited', 'accepted', 'withdrawal_requested'].includes(i.participation.state) && new Date(i.campaign.period.endsAt).getTime() > Date.now();
