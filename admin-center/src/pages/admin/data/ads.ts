// Shared advertising helpers for the Admin Center ad screens (Ads, AdCampaign, AdAssets, AdPlacements):
// API types from the OpenAPI schema, status labels, placement icons and small formatters.
import type { components } from '@marketly/web-shared/api';
import type { IconName } from '@marketly/web-shared/ui';

type S = components['schemas'];
export type AdCampaignSummary = S['advertising.AdCampaignSummary'];
export type AdCampaign = S['advertising.AdCampaign'];
export type AdCampaignInput = S['advertising.AdCampaignInput'];
export type AdsDashboard = S['advertising.AdsDashboard'];
export type Placement = S['advertising.Placement'];
export type PlacementPatch = S['advertising.PlacementPatch'];
export type GlobalRules = S['advertising.GlobalRules'];
export type Creative = S['advertising.Creative'];
export type CreativeSummary = S['advertising.CreativeSummary'];
export type ReviewCheck = S['advertising.ReviewCheck'];
export type AdPreview = S['advertising.AdPreview'];
export type AdImpression = S['advertising.AdImpression'];
export type CampaignCheckResult = S['advertising.CampaignCheckResult'];
export type Page<T> = { items: T[]; nextCursor?: string | null; total?: number | null; totalPages?: number | null };

export type CampaignStatus = AdCampaignSummary['status'];

export const CAMPAIGN_STATUS: Record<CampaignStatus, string> = {
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
export const statusLabel = (s: string | null | undefined) => CAMPAIGN_STATUS[s as CampaignStatus] ?? (s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ') : '');

export type CreativeStatus = Creative['status'];
export const CREATIVE_STATUS: Record<CreativeStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** Design icons per placement key. */
export const PLACEMENT_ICON: Record<string, IconName> = {
  opening_fullscreen: 'app-window',
  home_banner: 'rectangle-horizontal',
  category_banner: 'rectangle-horizontal',
  campaign_banner: 'rectangle-horizontal',
  popup: 'message-square',
  sponsored_product: 'package',
  sponsored_store: 'store',
  floating: 'panel-bottom',
  interstitial: 'layers',
  video: 'video',
};
export const placementIcon = (key: string): IconName => PLACEMENT_ICON[key] ?? 'megaphone';

export const AVAILABILITY: Record<Placement['availability'], { label: 'Launch' | 'Pilot' | 'Later'; tone: 'brand' | 'info' | '' }> = {
  launch: { label: 'Launch', tone: 'brand' },
  pilot: { label: 'Pilot', tone: 'info' },
  later: { label: 'Later', tone: '' },
};

/** Page types (advertising notes) with the labels the screens use. */
export const PAGE_LABEL: Record<string, string> = {
  home: 'Home page',
  category: 'Category pages',
  search: 'Search results',
  product: 'Product pages',
  campaign: 'Campaign pages',
  collection: 'Collections',
  deals: 'Deals',
  brand: 'Brand pages',
  seller_store: 'Seller stores',
  official_store: 'Official Store',
  cart: 'Cart',
  account: 'Account',
  help: 'Help',
};
export const pageLabel = (p: string) => PAGE_LABEL[p] ?? p;

export const isOwn = (a: { kind: string; paid?: boolean }) => a.kind === 'platform' || a.kind === 'official_store';

export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US');
/** Check tone of a ReviewCheck/LinkCheck state in the design's check lists. */
export const checkTone = (s: string): 'ok' | 'warn' | 'info' => (s === 'ok' ? 'ok' : s === 'warn' || s === 'fail' ? 'warn' : 'info');

/** A local datetime-input value (YYYY-MM-DDTHH:mm) in Pacific Time for an ISO instant. */
export function toPacificInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** A datetime-input value read as wall time in the given time zone → ISO instant. */
export function fromZonedInput(v: string, timeZone = 'America/Los_Angeles'): string | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Offset of the zone at that moment (two passes cover DST edges).
  const offset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = asUtc - offset(asUtc);
  t = asUtc - offset(t);
  return new Date(t).toISOString();
}

export type ReviewRole = 'advertising' | 'content' | 'marketing';
const ROLE_STEP: Record<string, ReviewRole> = { advertising_manager: 'advertising', content_manager: 'content', marketing_manager: 'marketing' };
/** The review steps the staff member's roles cover (advertising core: Business Owner covers all). */
export function reviewRolesOf(roleKeys: string[]): ReviewRole[] {
  const mine = new Set<ReviewRole>();
  for (const k of roleKeys) {
    if (k === 'business_owner') (['advertising', 'content', 'marketing'] as const).forEach((r) => mine.add(r));
    if (ROLE_STEP[k]) mine.add(ROLE_STEP[k]);
  }
  return [...mine];
}
export const REVIEW_ROLE_LABEL: Record<ReviewRole, string> = { advertising: 'Advertising', content: 'Content', marketing: 'Marketing' };
