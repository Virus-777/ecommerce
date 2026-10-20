/** Row types and shapes the advertising repository and service share. */
import type { AdvertisingDb } from '../../spec/advertising.js';

export type Db = AdvertisingDb;
export type Table = keyof Db & string;
/** Tables keyed by `id` */
export type IdTable = 'placements' | 'campaigns' | 'approval_steps' | 'creatives' | 'creative_reviews' | 'campaign_log' | 'ad_events' | 'attributions' | 'ad_charges';

export type PlacementRec = Db['placements'];
export type RulesRec = Db['global_rules'];
export type CampaignRec = Db['campaigns'];
export type ItemRec = Db['campaign_items'];
export type StepRec = Db['approval_steps'];
export type CreativeRec = Db['creatives'];
export type LogRec = Db['campaign_log'];
export type EventRec = Db['ad_events'];
export type StatRec = Db['daily_stats'];
export type ChargeRec = Db['ad_charges'];

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  offset?: number;
  forUpdate?: boolean;
}

export interface CampaignListFilter {
  q?: string;
  advertiserKinds?: string[];
  placementId?: string;
  statuses?: string[];
  linkedPromotionId?: string;
  sellerId?: string;
  origin?: 'staff' | 'seller_request';
}

export interface CreativeListFilter {
  q?: string;
  status?: string;
  advertiserKinds?: string[];
  placementKey?: string;
  kind?: string;
  linkCheck?: string;
  sellerId?: string;
}

export interface StatTotals {
  displays: number;
  clicks: number;
  dismissals: number;
  spend: number;
  attributedOrders: number;
  attributedSales: number;
}

/** Instants bounding a range of market days: [from, to) */
export interface Span {
  from: Date;
  to: Date;
}

export type ClickCharge = { charged: true; amount: number; exhausted: 'daily' | 'total' | null } | { charged: false; limit: 'daily' | 'total' | 'missing' };
