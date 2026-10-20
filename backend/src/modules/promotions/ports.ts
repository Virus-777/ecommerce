/** Row types and shapes the promotions repository and service share. */
import type { PromotionsDb } from '../../spec/promotions.js';

export type Db = PromotionsDb;
export type Table = keyof Db & string;
/** Tables keyed by `id` */
export type IdTable = 'campaigns' | 'funding_reviews' | 'participations' | 'flash_items' | 'coupon_codes' | 'evaluations' | 'redemptions' | 'campaign_log';

export type CampaignRec = Db['campaigns'];
export type TargetRec = Db['campaign_targets'];
export type EligibleRec = Db['eligible_offers'];
export type FundingReviewRec = Db['funding_reviews'];
export type ParticipationRec = Db['participations'];
export type FlashItemRec = Db['flash_items'];
export type CodeRec = Db['coupon_codes'];
export type RedemptionRec = Db['redemptions'];
export type RedemptionLineRec = Db['redemption_lines'];
export type LogRec = Db['campaign_log'];
export type ResultRec = Db['campaign_results_daily'];

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  offset?: number;
  forUpdate?: boolean;
}

export interface CampaignListFilter {
  q?: string;
  statuses?: string[];
  kind?: string;
  fundingOwner?: string;
  ownerKind?: 'platform' | 'seller';
  sellerId?: string;
}

/** Outcome of an atomic counter change: 'ok' or which limit refused it */
export type CounterResult = 'ok' | 'budget' | 'usage' | 'missing';

/** Net discount cost of a campaign (committed redemptions, reversals deducted) */
export interface CostTotals {
  total: number;
  platform: number;
  seller: number;
  redemptions: number;
  orders: number;
}
