/**
 * Pure advertising rules: page types and the pages ads never cover, the launch placements and global
 * rules, labels shown on lists, frequency caps and dismissal suppression, rotation, creative formats
 * and the actions a campaign offers in each status. No I/O.
 */
import { format as moneyFormat } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type { AdBudget, AdvertiserRef, Audience, CreativeFormat, DismissalRule, FrequencyCap, GlobalRules, Placement, PopupTrigger, RotationRule } from '../../../spec/advertising.js';

/* ------------------------------------------------------------------ pages */

export const PAGE_TYPES = ['home', 'category', 'search', 'product', 'campaign', 'collection', 'deals', 'brand', 'seller_store', 'official_store', 'cart', 'checkout', 'payment_result', 'order_tracking', 'returns', 'account', 'help'] as const;
export type PageTypeName = (typeof PAGE_TYPES)[number];
export const isPageType = (p: unknown): p is PageTypeName => typeof p === 'string' && (PAGE_TYPES as readonly string[]).includes(p);

/** Ads never cover these pages; the global rules can add pages but never remove these four */
const BASE_BLOCKED: readonly PageTypeName[] = ['checkout', 'payment_result', 'order_tracking', 'returns'];

const PAGE_LABEL: Record<string, string> = {
  home: 'Home',
  category: 'Category',
  search: 'Search',
  product: 'Product',
  campaign: 'Campaign pages',
  collection: 'Collections',
  deals: 'Deals',
  brand: 'Brand',
  seller_store: 'Seller stores',
  official_store: 'Official Store',
  cart: 'Cart',
  checkout: 'Checkout',
  payment_result: 'Payment result',
  order_tracking: 'Order tracking',
  returns: 'Returns',
  account: 'Account',
  help: 'Help',
};

export const pagesLabel = (pages: readonly string[]): string => (pages.length ? pages.map((p) => PAGE_LABEL[p] ?? p).join(', ') : 'No pages');

/* ------------------------------------------------------------------ placements */

export type PlacementKey = Placement['key'];
export const OVERLAY_KEYS: readonly string[] = ['opening_fullscreen', 'popup', 'interstitial'];
/** Overlays and floating panels have no place in a page layout (content shows layout positions only, plus the opening ad) */
const NOT_A_POSITION: readonly string[] = ['popup', 'interstitial', 'floating', 'sponsored_product'];
export const isLayoutPosition = (key: string) => !NOT_A_POSITION.includes(key);

const IMG = ['image/jpeg', 'image/png', 'image/webp'];
const MB = 1024 * 1024;
const fmt = (device: CreativeFormat['device'], width: number, height: number, maxBytes = MB, mimeTypes = IMG): CreativeFormat => ({
  device,
  width,
  height,
  maxBytes,
  mimeTypes,
  label: `${device === 'desktop' ? 'Desktop' : device === 'phone' ? 'Phone' : 'Any device'} ${width} × ${height}`,
});
const rotation = (mode: RotationRule['mode'], o: Partial<RotationRule> = {}): RotationRule => ({ mode, carouselSeconds: null, maxInRotation: null, pauseOnHoverAndFocus: false, ...o, label: o.label ?? rotationLabel({ mode, ...o } as RotationRule) });

export interface PlacementSeed {
  id: string;
  key: PlacementKey;
  name: string;
  description: string;
  kind: Placement['kind'];
  enabled: boolean;
  availability: Placement['availability'];
  eligiblePages: PageTypeName[];
  formats: CreativeFormat[];
  frequencyCap: FrequencyCap | null;
  trigger: PopupTrigger | null;
  rotation: RotationRule;
  dismissal: DismissalRule;
  maxPerPage: number | null;
  positions: number[] | null;
  label: 'Ad' | 'Sponsored';
}

/**
 * Plan ch. 16/20: launch = opening full-screen, banners and pop-ups; sponsored product is a pilot; the rest ship off.
 * These are the install seed (domain/seed.ts, inserted on boot when absent): changing them here does not reach
 * existing installs; change placements through PATCH /placements or a data migration (mongoMigrations).
 */
export const PLACEMENT_SEEDS: readonly PlacementSeed[] = [
  {
    id: '0ad0a000-0000-4000-8000-000000000001',
    key: 'opening_fullscreen',
    name: 'Opening full-screen ad',
    description: 'Appears when a visitor opens the site. Close or skip always visible.',
    kind: 'overlay',
    enabled: true,
    availability: 'launch',
    eligiblePages: ['home', 'category', 'campaign', 'collection', 'deals'],
    formats: [fmt('desktop', 1600, 900), fmt('phone', 1080, 1920)],
    frequencyCap: { perSession: 1, perWindow: { count: 3, days: 7 }, label: 'Once per session · max 3 per visitor per 7 days' },
    trigger: null,
    rotation: rotation('priority_then_even'),
    dismissal: { mode: 'session', label: 'Closing hides it for the rest of the visit' },
    maxPerPage: 1,
    positions: null,
    label: 'Ad',
  },
  {
    id: '0ad0a000-0000-4000-8000-000000000002',
    key: 'home_banner',
    name: 'Sponsored brand banner',
    description: 'A wide banner between homepage sections, rotating with other campaigns.',
    kind: 'inline',
    enabled: true,
    availability: 'launch',
    eligiblePages: ['home'],
    formats: [fmt('desktop', 1200, 300), fmt('phone', 750, 400)],
    frequencyCap: null,
    trigger: null,
    // every live ad is in the carousel (owner decision 2026-10-18); staff can still set a limit per placement
    rotation: rotation('carousel', { carouselSeconds: 6, pauseOnHoverAndFocus: true }),
    dismissal: { mode: 'not_dismissible', label: 'Banners cannot be closed' },
    maxPerPage: null,
    positions: null,
    label: 'Ad',
  },
  {
    id: '0ad0a000-0000-4000-8000-000000000003',
    key: 'category_banner',
    name: 'Category banner',
    description: 'A banner at the top of category pages, matched to the category.',
    kind: 'inline',
    enabled: true,
    availability: 'launch',
    eligiblePages: ['category'],
    formats: [fmt('desktop', 1200, 200), fmt('phone', 750, 300)],
    frequencyCap: null,
    trigger: null,
    rotation: rotation('category_match_then_priority', { maxInRotation: 2 }),
    dismissal: { mode: 'not_dismissible', label: 'Banners cannot be closed' },
    maxPerPage: 1,
    positions: null,
    label: 'Ad',
  },
  {
    id: '0ad0a000-0000-4000-8000-000000000004',
    key: 'campaign_banner',
    name: 'Campaign page banner',
    description: 'A banner on campaign pages, collections and Deals.',
    kind: 'inline',
    enabled: true,
    availability: 'launch',
    eligiblePages: ['campaign', 'collection', 'deals'],
    formats: [fmt('desktop', 1600, 400), fmt('phone', 750, 500)],
    frequencyCap: null,
    trigger: null,
    rotation: rotation('priority_then_even', { maxInRotation: 2 }),
    dismissal: { mode: 'not_dismissible', label: 'Banners cannot be closed' },
    maxPerPage: 1,
    positions: null,
    label: 'Ad',
  },
  {
    id: '0ad0a000-0000-4000-8000-000000000005',
    key: 'popup',
    name: 'Promotional pop-up',
    description: 'A small pop-up after some time or scrolling. Never in a visit where an opening ad showed.',
    kind: 'overlay',
    enabled: true,
    availability: 'launch',
    eligiblePages: ['home', 'category', 'search', 'product', 'campaign', 'collection', 'deals'],
    formats: [fmt('desktop', 600, 600), fmt('phone', 600, 600)],
    frequencyCap: { perSession: 1, perDay: 1, label: 'Once per session · once a day' },
    trigger: { afterSeconds: 8, scrollPct: 40, skipIfOverlayShownThisSession: true },
    rotation: rotation('priority_then_even'),
    dismissal: { mode: 'days', days: 7, label: 'Closing hides that campaign for 7 days' },
    maxPerPage: 1,
    positions: null,
    label: 'Ad',
  },
  {
    id: '0ad0a000-0000-4000-8000-000000000006',
    key: 'sponsored_product',
    name: 'Sponsored product',
    description: 'A labelled product card in search results, category listings and related products.',
    kind: 'card',
    enabled: true,
    availability: 'pilot',
    eligiblePages: ['search', 'category', 'product', 'home'],
    formats: [fmt('any', 600, 600, 5 * MB)],
    frequencyCap: null,
    trigger: null,
    rotation: rotation('relevance_then_priority'),
    dismissal: { mode: 'not_dismissible', label: 'Sponsored cards cannot be closed' },
    maxPerPage: 2,
    positions: [3, 8],
    label: 'Sponsored',
  },
  {
    id: '0ad0a000-0000-4000-8000-000000000007',
    key: 'sponsored_store',
    name: 'Sponsored store or brand',
    description: 'A store or brand card above results with its logo and products.',
    kind: 'card',
    enabled: false,
    availability: 'later',
    eligiblePages: ['search', 'category', 'home'],
    formats: [fmt('any', 1200, 300, 5 * MB)],
    frequencyCap: null,
    trigger: null,
    rotation: rotation('relevance_then_priority'),
    dismissal: { mode: 'not_dismissible', label: 'Sponsored cards cannot be closed' },
    maxPerPage: 1,
    positions: [1],
    label: 'Sponsored',
  },
  {
    id: '0ad0a000-0000-4000-8000-000000000008',
    key: 'floating',
    name: 'Floating panel',
    description: 'A small sticky panel at the bottom of the page.',
    kind: 'strip',
    enabled: false,
    availability: 'later',
    eligiblePages: ['home', 'category', 'product'],
    formats: [fmt('desktop', 728, 90), fmt('phone', 320, 100)],
    frequencyCap: { perSession: 1, label: 'Once per session' },
    trigger: null,
    rotation: rotation('priority_then_even'),
    dismissal: { mode: 'session', label: 'Closing hides it for the rest of the visit' },
    maxPerPage: 1,
    positions: null,
    label: 'Ad',
  },
  {
    id: '0ad0a000-0000-4000-8000-000000000009',
    key: 'interstitial',
    name: 'Interstitial',
    description: 'A full-screen ad between two pages.',
    kind: 'overlay',
    enabled: false,
    availability: 'later',
    eligiblePages: ['product', 'category'],
    formats: [fmt('desktop', 1600, 900), fmt('phone', 1080, 1920)],
    frequencyCap: { perDay: 1, label: 'Once a day' },
    trigger: null,
    rotation: rotation('priority_then_even'),
    dismissal: { mode: 'days', days: 1, label: 'Closing hides it until tomorrow' },
    maxPerPage: 1,
    positions: null,
    label: 'Ad',
  },
  {
    id: '0ad0a000-0000-4000-8000-00000000000a',
    key: 'video',
    name: 'Video ad',
    description: 'A short video in campaign pages (later phase).',
    kind: 'inline',
    enabled: false,
    availability: 'later',
    eligiblePages: ['campaign', 'collection'],
    formats: [fmt('any', 1920, 1080, 100 * MB, ['video/mp4', 'video/quicktime'])],
    frequencyCap: null,
    trigger: null,
    rotation: rotation('priority_then_even'),
    dismissal: { mode: 'not_dismissible', label: 'Videos cannot be closed' },
    maxPerPage: 1,
    positions: null,
    label: 'Ad',
  },
];

/* ------------------------------------------------------------------ global rules */

export type RuleValues = Omit<GlobalRules, 'version' | 'effectiveAt' | 'updatedBy' | 'approval'>;

export const DEFAULT_RULES: RuleValues = {
  blockedPages: [...BASE_BLOCKED],
  overlaysPerPageView: 1,
  labelRequired: true,
  closeControlMinPx: 44,
  removeUnavailable: true,
  sellerNamedOnPromotedOffers: true,
  dismissStopsForSession: true,
  paidSellerAdsEnabled: false,
  attributionDays: 7,
  attributionBasis: 'click',
};

/** blockedPages always contain the four base pages */
export const blockedPagesOf = (extra: readonly string[] | null | undefined): string[] => [...new Set([...BASE_BLOCKED, ...(extra ?? []).filter(isPageType)])];

/* ------------------------------------------------------------------ labels */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

export function frequencyLabel(cap: Omit<FrequencyCap, 'label'> | null | undefined): string {
  if (!cap) return 'No cap';
  const parts: string[] = [];
  if (cap.perSession) parts.push(`${cap.perSession === 1 ? 'Once' : `${cap.perSession} times`} per session`);
  if (cap.perDay) parts.push(`${times(cap.perDay)} a day`);
  if (cap.perWindow) parts.push(`max ${cap.perWindow.count} per visitor per ${plural(cap.perWindow.days, 'day')}`);
  if (cap.perCampaign) parts.push(`max ${cap.perCampaign} per visitor in total`);
  if (!parts.length) return 'No cap';
  const s = parts.join(' · ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function dismissalLabel(d: Omit<DismissalRule, 'label'>): string {
  switch (d.mode) {
    case 'not_dismissible':
      return 'Cannot be closed';
    case 'session':
      return 'Closing hides it for the rest of the visit';
    case 'days':
      return `Closing hides that campaign for ${plural(d.days ?? 1, 'day')}`;
    case 'campaign':
      return 'Closing hides that campaign until it ends';
  }
}

export function rotationLabel(r: Pick<RotationRule, 'mode' | 'carouselSeconds' | 'maxInRotation'>): string {
  switch (r.mode) {
    case 'priority_then_even':
      return 'Higher priority first; equal priority rotates evenly';
    case 'relevance_then_priority':
      return 'Most relevant first, then priority';
    case 'category_match_then_priority':
      return 'Matching category first, then priority';
    case 'carousel':
      return `Carousel${r.maxInRotation ? ` of up to ${r.maxInRotation}` : ''}${r.carouselSeconds ? `, ${r.carouselSeconds} s each` : ''}`;
  }
}

export const shortDate = (at: Date, timeZone: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(at);
const dateTime = (at: Date, timeZone: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(at);
export const formatMoney = (amount: number, currency: string) => moneyFormat({ amount, currency });
const moneyShort = (amount: number, currency: string) => {
  const s = formatMoney(amount, currency);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
};

export function periodLabel(startsAt: Date | null, endsAt: Date | null, status: string, now: Date, timeZone: string): string {
  if (!startsAt || !endsAt) return 'No dates';
  if (status === 'finished' || status === 'archived') return `ended ${shortDate(endsAt, timeZone)}`;
  if (startsAt.getTime() > now.getTime()) return `starts ${shortDate(startsAt, timeZone)}; ends ${shortDate(endsAt, timeZone)}`;
  return `ends ${shortDate(endsAt, timeZone)}`;
}

export function budgetLabel(b: { billing: string; spent: number; totalLimit: number | null; dailyLimit: number | null; currency: string; paid: boolean }): string {
  if (!b.paid || b.billing === 'none') return 'Internal';
  const parts: string[] = [];
  parts.push(b.totalLimit !== null ? `${moneyShort(b.spent, b.currency)} of ${moneyShort(b.totalLimit, b.currency)}` : `${moneyShort(b.spent, b.currency)} spent`);
  if (b.dailyLimit !== null) parts.push(`${moneyShort(b.dailyLimit, b.currency)} a day`);
  return parts.join(', ');
}

export function deliveryLabel(cap: FrequencyCap, audience: Audience): string {
  const who: string[] = [];
  if (audience.mode === 'selected') {
    if (audience.visitors !== 'all') who.push(`${audience.visitors} visitors`);
    if (audience.signIn === 'signed_in') who.push('signed-in');
    if (audience.regions.length) who.push(audience.regions.join(', '));
    if (audience.categoryIds.length) who.push(`${plural(audience.categoryIds.length, 'interest')}`);
  }
  const capLabel = cap.label || frequencyLabel(cap);
  return `${capLabel.charAt(0).toLowerCase()}${capLabel.slice(1)} · ${who.length ? who.join(', ') : 'everyone'}`;
}

export const billingLabel = (billing: string, rate: number | null, currency: string, isExample = true): string => {
  const r = rate === null ? '' : `, ${formatMoney(rate, currency)}${isExample ? ' (example rate)' : ''}`;
  switch (billing) {
    case 'cpc':
      return `Per click${r}`;
    case 'cpm':
      return `Per 1,000 displays${r}`;
    case 'fixed_daily':
      return `Fixed daily fee${r}`;
    default:
      return 'No charge (own promotion)';
  }
};

export const footnoteFor = (key: string, endsAt: Date | null, cap: FrequencyCap, timeZone: string): string | null => {
  if (!OVERLAY_KEYS.includes(key)) return null;
  const parts: string[] = [];
  if (endsAt) parts.push(`Offers end ${dateTime(endsAt, timeZone)}.`);
  if (cap.perSession === 1) parts.push('Shown once per visit.');
  return parts.join(' ') || null;
};

/* ------------------------------------------------------------------ advertisers */

export const advertiserIsOwn = (kind: string) => kind === 'platform' || kind === 'official_store';
export const isPaid = (kind: string, billing: string) => !advertiserIsOwn(kind) && billing !== 'none';
export const ownAdvertiserName = (kind: string) => (kind === 'official_store' ? OFFICIAL_STORE_NAME : 'Marketly');

export const sourceKinds = (source: string | null | undefined): string[] | undefined => {
  switch (source) {
    case 'own':
      return ['platform', 'official_store'];
    case 'seller':
      return ['seller'];
    case 'brand':
      return ['brand'];
    default:
      return undefined;
  }
};

export function advertiserRef(kind: string, sellerId: string | null, brandId: string | null, billing: string, names: { seller?: string | null; brand?: string | null }): AdvertiserRef {
  const name = advertiserIsOwn(kind) ? ownAdvertiserName(kind) : kind === 'seller' ? (names.seller ?? 'Seller') : (names.brand ?? 'Brand');
  return { kind: kind as AdvertiserRef['kind'], sellerId, brandId, name, paid: isPaid(kind, billing) };
}

/* ------------------------------------------------------------------ approvals */

export type ReviewRole = 'advertising' | 'content' | 'marketing';
export const STEP_SCOPE: Record<string, string> = {
  advertising: 'Placement, schedule and limits',
  content: 'Creative, claims and links',
  marketing: 'Creative, claims and links',
};

/**
 * Required review steps per submission. Own promotions: Advertising plus Content or Marketing; seller and
 * brand ads: Advertising, and Content for claims. The second step is filled by Content, or by Marketing for own promotions.
 */
export const requiredSteps = (_advertiserKind: string): ReviewRole[] => ['advertising', 'content'];

/** The step a reviewer's role takes: Marketing stands in for Content on own promotions */
export function stepFor(role: ReviewRole, advertiserKind: string): 'advertising' | 'content' | null {
  if (role === 'advertising') return 'advertising';
  if (role === 'content') return 'content';
  return advertiserIsOwn(advertiserKind) ? 'content' : null;
}

/* ------------------------------------------------------------------ status actions */


export function allowedActions(status: string, o: { origin: string; area: 'admin' | 'seller'; pausedBySeller?: boolean; endingSoon?: boolean }): string[] {
  if (o.area === 'seller') {
    switch (status) {
      case 'draft':
        return ['edit', 'submit'];
      case 'in_review':
        return ['edit', 'withdraw'];
      case 'approved':
        return ['edit'];
      case 'scheduled':
      case 'live':
        return ['pause'];
      case 'paused':
        return o.pausedBySeller ? ['resume'] : [];
      default:
        return [];
    }
  }
  switch (status) {
    case 'draft':
      return o.origin === 'staff' ? ['edit', 'check', 'submit', 'delete'] : ['edit', 'check', 'submit'];
    case 'in_review':
      return ['review', 'approve', 'request_changes', 'reject'];
    case 'approved':
      return ['schedule', 'activate', 'edit'];
    case 'scheduled':
      return ['pause', 'finish', 'renew'];
    case 'live':
      return o.endingSoon ? ['pause', 'finish', 'renew'] : ['pause', 'finish'];
    case 'paused':
      return ['resume', 'finish', 'renew'];
    case 'finished':
      return ['archive', 'renew'];
    case 'rejected':
      return ['archive'];
    case 'archived':
      return ['renew'];
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ frequency caps and suppression */

export interface FrequencyRow {
  campaign_id: string;
  session_id: string | null;
  session_displays: number;
  window_displays: number;
  window_started_at: Date;
  display_day?: string | null;
  day_displays?: number;
  total_displays?: number;
  last_display_at: Date | null;
  suppressed_until: Date | null;
}

const DAY_MS = 86_400_000;
/** The counting window of a cap: perWindow, else one day for perDay */
export const windowDaysOf = (cap: FrequencyCap | null | undefined): number | null => cap?.perWindow?.days ?? (cap?.perDay ? 1 : null);
const windowCountOf = (cap: FrequencyCap): number | null => cap.perWindow?.count ?? cap.perDay ?? null;

/** Why a campaign may not show to this visitor now (null = it may). Rows from every key the visitor has (visitor and customer). */
export function frequencyBlock(rows: readonly FrequencyRow[], cap: FrequencyCap, dismissal: DismissalRule, sessionId: string, now: Date, extra: { displaysToday?: number; displaysTotal?: number } = {}): 'suppressed' | 'capped' | null {
  const t = now.getTime();
  for (const r of rows) {
    if (r.suppressed_until && r.suppressed_until.getTime() > t) {
      // session suppression only holds in the session that dismissed it
      const sessionOnly = dismissal.mode === 'session' || dismissal.mode === 'not_dismissible';
      if (!sessionOnly || r.session_id === sessionId) return 'suppressed';
    }
    if (cap.perSession && r.session_id === sessionId && r.session_displays >= cap.perSession) return 'capped';
    const days = windowDaysOf(cap);
    const count = windowCountOf(cap);
    if (days && count && r.window_started_at.getTime() + days * DAY_MS > t && r.window_displays >= count) return 'capped';
  }
  if (cap.perDay && cap.perWindow && (extra.displaysToday ?? 0) >= cap.perDay) return 'capped';
  if (cap.perCampaign && (extra.displaysTotal ?? 0) >= cap.perCampaign) return 'capped';
  return null;
}

/** How long a dismissal hides the campaign (null: it doesn't) */
export function suppressionUntil(dismissal: DismissalRule, endsAt: Date | null, now: Date, dismissStopsForSession: boolean): Date | null {
  const t = now.getTime();
  switch (dismissal.mode) {
    case 'days':
      return new Date(t + Math.max(dismissal.days ?? 1, 1) * DAY_MS);
    case 'campaign':
      return endsAt && endsAt.getTime() > t ? endsAt : new Date(t + 30 * DAY_MS);
    case 'session':
      return new Date(t + DAY_MS);
    case 'not_dismissible':
      return dismissStopsForSession ? new Date(t + DAY_MS) : null;
  }
}

/* ------------------------------------------------------------------ rotation */

export interface Rankable {
  id: string;
  priority: number;
  relevance?: number;
}

/**
 * Order candidates: relevance (when the rule uses it), then priority; equal ranks rotate evenly
 * (the rotation counter moves the start of each tied group by one per page view).
 */
export function rank<T extends Rankable>(items: readonly T[], mode: RotationRule['mode'], turn: number): T[] {
  const useRelevance = mode === 'relevance_then_priority' || mode === 'category_match_then_priority';
  const key = (x: T) => `${useRelevance ? String(9 - Math.min(x.relevance ?? 0, 9)) : '0'}${String(9 - Math.min(Math.max(x.priority, 0), 9))}`;
  const groups = new Map<string, T[]>();
  for (const x of [...items].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const k = key(x);
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const out: T[] = [];
  for (const k of [...groups.keys()].sort()) {
    const g = groups.get(k)!;
    const shift = g.length ? turn % g.length : 0;
    out.push(...g.slice(shift), ...g.slice(0, shift));
  }
  return out;
}

/* ------------------------------------------------------------------ creative formats */

export interface CreativeFacts {
  kind: 'image' | 'text' | 'video';
  device: 'desktop' | 'phone' | 'any';
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
  contentType?: string | null;
  headline?: string | null;
  body?: string | null;
  buttonText?: string | null;
}

export interface FormatIssue {
  path: string;
  message: string;
}

/** Size, dimensions, file type and text length against the placement's formats */
export function formatIssues(c: CreativeFacts, formats: readonly CreativeFormat[], limits: { maxImageBytes: number; headlineMax: number }): FormatIssue[] {
  const issues: FormatIssue[] = [];
  if (c.headline && c.headline.length > limits.headlineMax) issues.push({ path: 'headline', message: `Headline is ${c.headline.length} characters; ${limits.headlineMax} at most` });
  if (c.body && c.body.length > 180) issues.push({ path: 'body', message: 'Ad text is 180 characters at most' });
  if (c.buttonText && c.buttonText.length > 24) issues.push({ path: 'buttonText', message: 'Button text is 24 characters at most' });
  if (c.kind === 'text') {
    if (!c.headline?.trim()) issues.push({ path: 'headline', message: 'A text ad needs a headline' });
    return issues;
  }
  const fitting = formats.filter((f) => c.device === 'any' || f.device === 'any' || f.device === c.device);
  if (!fitting.length) {
    issues.push({ path: 'device', message: `This placement has no ${c.device} format` });
    return issues;
  }
  const w = c.width ?? 0;
  const h = c.height ?? 0;
  const typeOk = (f: CreativeFormat) => !c.contentType || f.mimeTypes.includes(c.contentType);
  const sizeOk = (f: CreativeFormat) => (c.bytes ?? 0) <= (c.kind === 'image' ? Math.min(f.maxBytes, limits.maxImageBytes) : f.maxBytes);
  const dimsOk = (f: CreativeFormat) => w >= f.width && h >= f.height && Math.abs(w / Math.max(h, 1) - f.width / f.height) <= 0.02 * (f.width / f.height);
  if (fitting.some((f) => typeOk(f) && sizeOk(f) && dimsOk(f))) return issues;
  if (!fitting.some(typeOk)) issues.push({ path: 'mediaId', message: `File type ${c.contentType ?? 'unknown'} is not accepted; use ${[...new Set(fitting.flatMap((f) => f.mimeTypes))].join(', ')}` });
  else if (!fitting.some((f) => typeOk(f) && sizeOk(f))) issues.push({ path: 'mediaId', message: `File is too large (${Math.ceil((c.bytes ?? 0) / 1024)} KB)` });
  else issues.push({ path: 'mediaId', message: `Image is ${w} × ${h}; expected ${fitting.map((f) => `${f.width} × ${f.height}`).join(' or ')} (same shape, at least that size)` });
  return issues;
}

/**
 * Devices a campaign needs an image for: each separate format (an "any" format alone: any). Desktop is left out
 * while the website is not served (Settings › Serve the website); its format stays available.
 */
export function requiredDevices(formats: readonly CreativeFormat[], websiteServed = true): string[] {
  const devices = [...new Set(formats.map((f) => f.device))];
  const separate = devices.filter((d) => d !== 'any');
  if (!separate.length) return devices.length ? ['any'] : [];
  return separate.filter((d) => websiteServed || d !== 'desktop');
}

/** Placements with separate desktop and phone formats need a creative for each (an "any" creative covers both) */
export function missingDevices(formats: readonly CreativeFormat[], devices: readonly string[], websiteServed = true): string[] {
  if (devices.includes('any')) return [];
  return requiredDevices(formats, websiteServed).filter((d) => d !== 'any' && !devices.includes(d));
}

/** A link is internal (/path) or https; anything else fails */
export function linkState(link: string | null | undefined): { state: 'ok' | 'warn' | 'fail' | 'info'; detail: string } {
  if (!link?.trim()) return { state: 'info', detail: 'No link; the campaign destination is used' };
  const l = link.trim();
  if (l.startsWith('/') && !l.startsWith('//')) return { state: 'ok', detail: 'Store page link' };
  try {
    const u = new URL(l);
    if (u.protocol !== 'https:') return { state: 'fail', detail: 'Links must use https' };
    return { state: 'warn', detail: `External link to ${u.hostname}` };
  } catch {
    return { state: 'fail', detail: 'Not a valid link' };
  }
}

/** Ids of products and offers a store link points at (/product/{id}, ?offer={id}) */
export function idsInLink(link: string | null | undefined): string[] {
  return [...(link ?? '').matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map((m) => m[0].toLowerCase());
}

/** A discount claim in ad text (e.g. 20% off, save $15) */
export const hasDiscountClaim = (text: string | null | undefined) => /\d+\s*%|save\s+\$?\d|\$\d+\s*off/i.test(text ?? '');

/* ------------------------------------------------------------------ budgets */

export function budgetOf(row: { billing: string; rate: number | null; daily_limit: number | null; total_limit: number | null; delivery_cap: number | null; spent: number; currency: string }): AdBudget {
  const m = (amount: number): common.Money => ({ amount, currency: row.currency });
  return {
    billing: row.billing as AdBudget['billing'],
    rate: row.rate === null ? null : m(row.rate),
    dailyLimit: row.daily_limit === null ? null : m(row.daily_limit),
    totalLimit: row.total_limit === null ? null : m(row.total_limit),
    deliveryCap: row.delivery_cap,
    spent: m(row.spent),
    remaining: row.total_limit === null ? null : m(Math.max(row.total_limit - row.spent, 0)),
  };
}

/** Example rates until the advertising terms confirm them */
export const EXAMPLE_RATES: Record<string, { cpc: number; fixed_daily: number; cpm: number }> = {
  sponsored_product: { cpc: 35, fixed_daily: 1500, cpm: 400 },
  sponsored_store: { cpc: 60, fixed_daily: 2500, cpm: 400 },
};

export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 100 : 0);
