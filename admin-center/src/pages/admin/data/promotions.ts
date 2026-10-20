// Labels and helpers for admin/promotions and admin/promotion-new, mapping the promotions API
// (GET /api/admin/promotions/dashboard, /campaigns, /campaigns/{id}) onto the design.
import type { components } from '@marketly/web-shared/api';
import type { Tone } from '@marketly/web-shared/ui';

type S = components['schemas'];
export type CampaignRow = S['promotions.CampaignSummary'];
export type Campaign = S['promotions.Campaign'];
export type CampaignInput = S['promotions.CampaignInput'];
export type PromotionsDashboard = S['promotions.PromotionsDashboard'];

/** Campaign kinds (API) with the design's type labels. */
export const PROMO_KINDS: Array<{ value: string; label: string }> = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'percent_coupon', label: '% coupon' },
  { value: 'fixed_coupon', label: 'Fixed coupon' },
  { value: 'min_spend', label: 'Min-spend' },
  { value: 'free_shipping', label: 'Free shipping' },
  { value: 'flash_sale', label: 'Flash sale' },
];
export const kindLabel = (k: string) => PROMO_KINDS.find((x) => x.value === k)?.label ?? k.replace(/_/g, ' ');

/** Campaign status as the design's StatusBadge labels. */
export const STATUS_LABEL: Record<string, string> = {
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

export type TabKey = 'all' | 'live' | 'scheduled' | 'finance' | 'ended' | 'drafts';
export const TABS: Array<{ value: TabKey; label: string; statuses?: string[] }> = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live', statuses: ['live', 'paused'] },
  { value: 'scheduled', label: 'Scheduled', statuses: ['scheduled', 'approved'] },
  { value: 'finance', label: 'Waiting for Finance', statuses: ['in_review'] },
  { value: 'ended', label: 'Ended', statuses: ['ended', 'cancelled'] },
  { value: 'drafts', label: 'Drafts', statuses: ['draft', 'changes_requested'] },
];

export const FUND_TONE: Record<string, Tone> = { platform: 'brand', seller: 'info', shared: 'outline' };
