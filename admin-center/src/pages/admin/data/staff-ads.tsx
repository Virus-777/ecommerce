import type { components } from '@marketly/web-shared/api';
import { ApiError } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Badge, type IconName, type Tone } from '@marketly/web-shared/ui';
import { actorLabel, dateTime, shortDate } from '@/app/parts';

// Staff ads (Admin › Marketing and content › Advertisements; designed from the Marketly canvas: AdminAds, AdminAdEdit,
// AdminAdReview). One ad = one image in one slot (placement) that opens one picked destination. API:
// /api/admin/advertising/ads (list by slot, create, edit, submit, review, pause, resume, end, duplicate, delete, order)
// and /ads/destinations (the pickers). Slots, sizes and copy are the approved plan's.

type S = components['schemas'];
export type StaffAd = S['advertising.StaffAd'];
export type StaffAdsPage = S['advertising.StaffAdsPage'];
export type AdImage = S['advertising.AdImage'];
export type AdDestination = S['advertising.AdDestination'];
export type AdDestinationOption = S['advertising.AdDestinationOption'];
export type AdReview = S['advertising.AdReview'];
export type AdReviewStep = S['advertising.AdReviewStep'];
export type StaffAdChange = S['advertising.StaffAdChange'];
export type StaffAdInput = S['advertising.StaffAdInput'];
export type StaffAdPatch = S['advertising.StaffAdPatch'];
export type DestKind = AdDestination['kind'];
export type AdStatus = StaffAd['status'];

export const ADS_KEY = ['advertising', 'staff-ads'];
export const ADS_LIST = href('admin/ads');
export const adHref = (id: string, query?: Record<string, string>) => href('admin/ad', '', { id }, query);
export const adReviewHref = (id: string) => href('admin/ad-review', '', { id });

/* ---------------- Slots ---------------- */

export type SlotTab = 'fullscreen' | 'home' | 'departments' | 'deals' | 'other';
export type SlotKey = 'opening_fullscreen' | 'home_banner' | 'software_top' | 'food_top' | 'companies_top' | 'play_top' | 'deals_top' | 'category_banner' | 'popup';
export type Size = { width: number; height: number };
export interface Slot {
  key: SlotKey;
  tab: SlotTab;
  /** The slot's name on the list (slot card) */
  name: string;
  where: string;
  phone: Size;
  /** opening_fullscreen only: the optional website image */
  web?: Size;
  icon: IconName;
  /** How the ads of the slot take turns */
  rotation: string;
  /** The slot card's add button */
  add: string;
  /** Department carousels: the department's name */
  dept?: string;
  /** The Preview card's subtitle */
  previewSub: string;
  /** What the preview's top bar shows */
  bar: string;
}

const CAROUSEL = 'each ad shows 6 s, in this order · up to 10 live';
export const SLOTS: Slot[] = [
  { key: 'opening_fullscreen', tab: 'fullscreen', name: 'Full-screen', where: 'After the splash, when the app opens', phone: { width: 1080, height: 1920 }, web: { width: 1600, height: 900 }, icon: 'maximize', rotation: 'one ad each time the app opens, in this order', add: 'Add full-screen ad', previewSub: 'When the app opens, after the splash', bar: '' },
  { key: 'home_banner', tab: 'home', name: 'Home carousel', where: 'Top of the app’s Home', phone: { width: 750, height: 400 }, icon: 'rectangle-horizontal', rotation: CAROUSEL, add: 'Add home ad', previewSub: 'Home, top of the page', bar: 'Home' },
  { key: 'software_top', tab: 'departments', name: 'Softwares carousel', dept: 'Softwares', where: 'Top of the Softwares department page', phone: { width: 750, height: 400 }, icon: 'app-window', rotation: CAROUSEL, add: 'Add Softwares ad', previewSub: 'Softwares, top of the page', bar: '← Softwares' },
  { key: 'food_top', tab: 'departments', name: 'Food delivery carousel', dept: 'Food delivery', where: 'Top of the Food delivery department page', phone: { width: 750, height: 400 }, icon: 'utensils', rotation: CAROUSEL, add: 'Add Food delivery ad', previewSub: 'Food delivery, top of the page', bar: '← Food delivery' },
  { key: 'companies_top', tab: 'departments', name: 'Companies carousel', dept: 'Companies', where: 'Top of the Companies department page', phone: { width: 750, height: 400 }, icon: 'building-2', rotation: CAROUSEL, add: 'Add Companies ad', previewSub: 'Companies, top of the page', bar: '← Companies' },
  { key: 'play_top', tab: 'departments', name: 'Play center carousel', dept: 'Play center', where: 'Top of the Play center department page', phone: { width: 750, height: 400 }, icon: 'gamepad-2', rotation: CAROUSEL, add: 'Add Play center ad', previewSub: 'Play center, top of the page', bar: '← Play center' },
  { key: 'deals_top', tab: 'deals', name: 'Deals carousel', where: 'Top of the app’s Deals tab', phone: { width: 750, height: 150 }, icon: 'badge-percent', rotation: CAROUSEL, add: 'Add deals ad', previewSub: 'Deals tab, top of the page', bar: 'Deals' },
  { key: 'category_banner', tab: 'other', name: 'Category banner', where: 'Top of category pages', phone: { width: 750, height: 300 }, icon: 'panel-top-open', rotation: 'shown above the products, in this order', add: 'Add category banner', previewSub: 'A category page, above the products', bar: '← Category' },
  { key: 'popup', tab: 'other', name: 'Pop-up', where: 'Over Home, search and product pages', phone: { width: 600, height: 600 }, icon: 'layers', rotation: 'shown over the page, in this order', add: 'Add pop-up', previewSub: 'Over the page the customer is on', bar: 'Home' },
];
export const slotOf = (key?: string | null) => SLOTS.find((s) => s.key === key);
export const sizeText = (s: Size) => `${s.width} × ${s.height}`;

export const TABS: Array<{ value: SlotTab; label: string; slot: string }> = [
  { value: 'fullscreen', label: 'Full-screen', slot: 'full-screen' },
  { value: 'home', label: 'Home carousel', slot: 'home carousel' },
  { value: 'departments', label: 'Departments', slot: 'department carousels' },
  { value: 'deals', label: 'Deals', slot: 'Deals carousel' },
  { value: 'other', label: 'Other', slot: 'category banner and pop-up' },
];
export const slotsOfTab = (tab: SlotTab) => SLOTS.filter((s) => s.tab === tab);

/* ---------------- Destinations ---------------- */

export const KINDS: Array<{ value: DestKind; label: string; chip: string; icon: IconName; search: string }> = [
  { value: 'product', label: 'Product', chip: 'Product', icon: 'package', search: 'Search products' },
  { value: 'category', label: 'Category', chip: 'Category', icon: 'folder', search: 'Search categories' },
  { value: 'department', label: 'Department', chip: 'Department', icon: 'layout-grid', search: 'Search department pages' },
  { value: 'restaurant', label: 'Restaurant', chip: 'Restaurant', icon: 'utensils', search: 'Search restaurants' },
  { value: 'deal', label: 'Deal', chip: 'Deal', icon: 'badge-percent', search: 'Search live and scheduled deals' },
  { value: 'collection', label: 'Page or collection', chip: 'Collection', icon: 'layers', search: 'Search store pages and collections' },
  { value: 'seller_store', label: 'Seller store', chip: 'Seller store', icon: 'store', search: 'Search seller stores' },
  { value: 'brand', label: 'Brand', chip: 'Brand', icon: 'tag', search: 'Search brands' },
  { value: 'phone', label: 'Phone', chip: 'Phone', icon: 'smartphone', search: 'Search Phone tab phones' },
  { value: 'url', label: 'Web address', chip: 'Web', icon: 'globe', search: '' },
];
export const kindOf = (k?: DestKind | null) => KINDS.find((x) => x.value === k) ?? KINDS[0]!;
/** The kind word on an Opens chip: content pages are Page, collections Collection (the meta says which) */
export const kindChip = (d: Pick<AdDestination, 'kind' | 'meta'>) => (d.kind === 'collection' && /^page\b/i.test(d.meta ?? '') ? 'Page' : kindOf(d.kind).chip);

/* ---------------- Status and review ---------------- */

export const STATUS: Record<AdStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'outline' },
  in_review: { label: 'Waiting for review', tone: 'warning' },
  changes_requested: { label: 'Changes requested', tone: 'warning' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  live: { label: 'Live', tone: 'success' },
  paused: { label: 'Paused', tone: '' },
  ended: { label: 'Ended', tone: '' },
  rejected: { label: 'Rejected', tone: 'danger' },
};
export const STEP_LABEL: Record<AdReviewStep['step'], string> = { advertising: 'Advertising review', content: 'Content review' };
export const RUNNING: AdStatus[] = ['scheduled', 'live', 'paused'];
export const isRunning = (a: Pick<StaffAd, 'status'>) => RUNNING.includes(a.status);
export const doneSteps = (r: AdReview) => r.steps.filter((s) => s.state === 'approved').length;
export const statusText = (a: StaffAd) => (a.status === 'in_review' ? `${STATUS.in_review.label} · ${doneSteps(a.review)} of 2` : STATUS[a.status].label);

/** The status badge, and under it the pending edit of a running ad */
export function AdStatusBadges({ ad }: { ad: StaffAd }) {
  const pc = ad.pendingChange;
  return (
    <span className="stack gap-1" style={{ alignItems: 'flex-start' }}>
      <Badge tone={STATUS[ad.status].tone}>{statusText(ad)}</Badge>
      {pc && <Badge tone="warning">{pc.state === 'in_review' ? 'Edit waiting for review' : pc.state === 'changes_requested' ? 'Edit: changes requested' : 'Edit saved, not submitted'}</Badge>}
    </span>
  );
}

/** Oct 20 – Nov 2 · From approval – Dec 31 · Ended Oct 1 */
export function scheduleText(a: Pick<StaffAd, 'status' | 'startsAt' | 'endsAt'>): string {
  if (a.status === 'ended' && a.endsAt) return `Ended ${shortDate(a.endsAt)}`;
  const from = a.startsAt ? shortDate(a.startsAt) : 'From approval';
  return a.endsAt ? `${from} – ${shortDate(a.endsAt)}` : a.startsAt ? `From ${from}` : 'Dates not set';
}

/** "Advertising review by Jordan Lee: approved Oct 23, 10:05 AM" */
export function stepLine(s: AdReviewStep): string {
  const what = s.state === 'approved' ? 'approved' : s.state === 'changes_requested' ? 'asked for changes' : s.state === 'rejected' ? 'rejected' : 'waiting';
  return s.state === 'waiting' ? `${STEP_LABEL[s.step]}: waiting` : `${STEP_LABEL[s.step]} by ${actorLabel(s.by) || 'a reviewer'}: ${what}${s.at ? ` ${dateTime(s.at)}` : ''}`;
}

/** The submit checks of a CHECKS_FAILED answer (details.checks), as sentences */
export function failedChecks(e: unknown): string[] {
  if (!(e instanceof ApiError) || e.code !== 'CHECKS_FAILED') return [];
  const checks = (e.details as { checks?: unknown } | undefined)?.checks;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((c) => !(c && typeof c === 'object' && 'state' in c && (c as { state?: string }).state === 'ok'))
    .map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' ? [(c as { label?: string }).label, (c as { detail?: string; message?: string }).detail ?? (c as { message?: string }).message].filter(Boolean).join(': ') : ''))
    .filter(Boolean);
}
