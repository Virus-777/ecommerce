/**
 * Pure rules of the simple staff Advertisements page (owner decision 2026-10-23): the slots it manages, the status a
 * staff member sees, destination kinds and the ten department pages, submit checks and the carousel order. No I/O.
 */
import type { StaffAd } from '../../../spec/advertising.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import { linkState } from './rules.js';

export { isStaffSlot, STAFF_AD_SLOTS } from './rules.js';

export type StaffStatus = StaffAd['status'];

/** The campaign status as the Advertisements page shows it */
export function staffStatus(campaignStatus: string, latestStepStates: readonly string[]): StaffStatus {
  switch (campaignStatus) {
    case 'draft':
      return latestStepStates.includes('changes_requested') ? 'changes_requested' : 'draft';
    case 'in_review':
    case 'approved':
      return 'in_review';
    case 'scheduled':
    case 'live':
    case 'paused':
    case 'rejected':
      return campaignStatus;
    default:
      return 'ended';
  }
}

/** List order: live and scheduled by position, then paused, in review, changes requested, drafts, ended and rejected */
const STATUS_RANK: Record<string, number> = { live: 0, scheduled: 0, paused: 1, in_review: 2, changes_requested: 3, draft: 4, ended: 5, rejected: 6 };
export const statusRank = (s: string) => STATUS_RANK[s] ?? 9;

export const DESTINATION_KINDS = ['product', 'category', 'department', 'restaurant', 'deal', 'collection', 'seller_store', 'brand', 'phone', 'url'] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];
export const isDestinationKind = (k: unknown): k is DestinationKind => typeof k === 'string' && (DESTINATION_KINDS as readonly string[]).includes(k);

/** The ten department pages and the app paths that open them (core/nav/Links.kt, res/navigation) */
export const DEPARTMENTS: readonly { key: string; label: string; path: string }[] = [
  { key: 'phones', label: 'Phones', path: '/phones' },
  { key: 'farm', label: 'Farm machines', path: '/farm-machines' },
  { key: 'software', label: 'Softwares', path: '/software' },
  { key: 'welfare', label: 'Welfare services', path: '/welfare' },
  { key: 'food', label: 'Food delivery', path: '/food' },
  { key: 'booking', label: 'Booking', path: '/booking' },
  { key: 'blogs', label: 'Blogs', path: '/blogs' },
  { key: 'companies', label: 'Companies', path: '/companies' },
  { key: 'play', label: 'Play center', path: '/play' },
  { key: 'rewards', label: 'Daily rewards', path: '/rewards' },
];

/** Department paths the app routes, plus the website's old Softwares path */
const DEPARTMENT_BY_PATH = new Map<string, string>([...DEPARTMENTS.map((d) => [d.path, d.key] as [string, string]), ['/softwares', 'software']]);

/** The Deals tab: kind deal without a campaign (targetId DEALS_TAB) */
export const DEALS_TAB = 'tab';

/**
 * A destination read from a store path (links typed before the pickers, and wizard destinations): the picked kind
 * with its id when the path carries one, or the URL slug to look up, and the canonical path the app opens. An https
 * address or an unknown store path stays kind url.
 */
export interface InferredDest {
  kind: DestinationKind;
  targetId: string | null;
  slug: string | null;
  path: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function inferDestination(url: string | null | undefined): InferredDest {
  const raw = (url ?? '').trim();
  const asUrl: InferredDest = { kind: 'url', targetId: null, slug: null, path: raw };
  if (!raw.startsWith('/') || raw.startsWith('//')) return asUrl;
  const q = raw.indexOf('?');
  const pathOnly = (q < 0 ? raw : raw.slice(0, q)).replace(/#.*$/, '').replace(/\/+$/, '') || '/';
  const query = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
  const seg = pathOnly.split('/').slice(1).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const qs = q < 0 ? '' : raw.slice(q);
  const by = (kind: DestinationKind, slug: string, path: string): InferredDest => ({ kind, targetId: null, slug, path });
  if (seg[0] === 'p' && seg.length === 3 && UUID.test(seg[2]!)) return { kind: 'product', targetId: seg[2]!.toLowerCase(), slug: null, path: raw };
  if (seg[0] === 'product' && seg.length === 2 && UUID.test(seg[1]!)) return { kind: 'product', targetId: seg[1]!.toLowerCase(), slug: null, path: `/p/item/${seg[1]!.toLowerCase()}${qs}` };
  if (seg[0] === 'c' && seg.length === 2) return by('category', seg[1]!, `/c/${seg[1]}`);
  if ((seg[0] === 'pages' || seg[0] === 'collections' || seg[0] === 'collection') && seg.length === 2) return by('collection', seg[1]!, `/collection/${seg[1]}`);
  if (pathOnly === '/deals') {
    const campaign = query.get('campaign');
    return campaign && UUID.test(campaign) ? { kind: 'deal', targetId: campaign.toLowerCase(), slug: null, path: `/deals?campaign=${campaign.toLowerCase()}` } : { kind: 'deal', targetId: DEALS_TAB, slug: null, path: '/deals' };
  }
  const dept = DEPARTMENT_BY_PATH.get(pathOnly);
  if (dept) return { kind: 'department', targetId: dept, slug: null, path: DEPARTMENTS.find((d) => d.key === dept)!.path };
  if (seg[0] === 'phones' && seg.length === 2) return by('phone', seg[1]!, `/phones/${seg[1]}`);
  if (seg[0] === 'food' && seg[1] === 'restaurants' && seg.length === 3) return by('restaurant', seg[2]!, `/food/restaurants/${seg[2]}`);
  if (seg[0] === 'shop' && seg.length === 2) return by('seller_store', seg[1]!, `/shop/${seg[1]}`);
  if (pathOnly === '/official') return { kind: 'seller_store', targetId: OFFICIAL_STORE_ID, slug: null, path: '/official' };
  if (seg[0] === 'brand' && seg.length === 2) return by('brand', seg[1]!, `/brand/${seg[1]}`);
  return asUrl;
}

/** The store path a slug of a kind opens (what linkTargets answers as path) */
export const slugPath = (kind: string, slug: string): string | null =>
  ({ category: `/c/${slug}`, collection: `/collection/${slug}`, phone: `/phones/${slug}`, restaurant: `/food/restaurants/${slug}`, seller_store: `/shop/${slug}`, brand: `/brand/${slug}` })[kind] ?? null;

/** Which owning module answers each picked kind (linkTargets) */
export const KIND_MODULE: Record<string, 'catalog' | 'food' | 'promotions' | 'content' | 'sellers' | 'departments'> = {
  product: 'catalog',
  category: 'catalog',
  brand: 'catalog',
  restaurant: 'food',
  deal: 'promotions',
  collection: 'content',
  seller_store: 'sellers',
  phone: 'departments',
};

export const KIND_LABEL: Record<string, string> = {
  product: 'Product',
  category: 'Category',
  department: 'Department',
  restaurant: 'Restaurant',
  deal: 'Deal',
  collection: 'Collection',
  seller_store: 'Store',
  brand: 'Brand',
  phone: 'Phone',
  url: 'Link',
};

/** A typed link: https, or a store path */
export function urlIssue(url: string | null | undefined): string | null {
  const s = url?.trim();
  if (!s) return 'Enter the link';
  const st = linkState(s);
  return st.state === 'fail' ? st.detail : null;
}

/** The longest an ad may run (owner decision 2026-10-23) */
export const MAX_RUN_DAYS = 90;
const DAY_MS = 86_400_000;

export interface SubmitFacts {
  hasImage: boolean;
  imageIssue: string | null;
  webImageIssue: string | null;
  alt: string | null;
  destination: { available: boolean; label: string } | null;
  startsAt: Date | null;
  endsAt: Date | null;
  placementEnabled: boolean;
  placementName: string;
}

/** What blocks sending an ad (or its change) for review: empty when it may be submitted */
export function submitIssues(f: SubmitFacts, now: Date): { label: string; detail: string }[] {
  const out: { label: string; detail: string }[] = [];
  if (!f.placementEnabled) out.push({ label: 'Placement', detail: `${f.placementName} is turned off` });
  if (!f.hasImage) out.push({ label: 'Image', detail: 'Add the phone image' });
  else if (f.imageIssue) out.push({ label: 'Image', detail: f.imageIssue });
  if (f.webImageIssue) out.push({ label: 'Website image', detail: f.webImageIssue });
  if (!f.alt?.trim()) out.push({ label: 'Description', detail: 'Describe the image for screen readers' });
  if (!f.destination) out.push({ label: 'Destination', detail: 'Choose what the ad opens' });
  else if (!f.destination.available) out.push({ label: 'Destination', detail: `${f.destination.label} is not available in the store` });
  const start = f.startsAt && f.startsAt.getTime() > now.getTime() ? f.startsAt : now;
  if (!f.endsAt) out.push({ label: 'End date', detail: 'Choose when the ad ends' });
  else if (f.endsAt.getTime() <= now.getTime()) out.push({ label: 'End date', detail: 'The end is in the past' });
  else if (f.startsAt && f.endsAt.getTime() <= f.startsAt.getTime()) out.push({ label: 'End date', detail: 'The end must be after the start' });
  else if (f.endsAt.getTime() - start.getTime() > MAX_RUN_DAYS * DAY_MS) out.push({ label: 'End date', detail: `An ad runs at most ${MAX_RUN_DAYS} days` });
  return out;
}

/** Carousel order: position (1 first, ads without one last), then creation */
export function byPosition<T extends { position?: number | null; created_at: Date; id: string }>(a: T, b: T): number {
  const pa = a.position ?? Number.MAX_SAFE_INTEGER;
  const pb = b.position ?? Number.MAX_SAFE_INTEGER;
  return pa - pb || a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : 1);
}

/** Fields a pending change compares with the live version */
export const CHANGE_FIELDS = ['name', 'image', 'webImage', 'alt', 'destination', 'startsAt', 'deal'] as const;
