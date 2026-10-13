/**
 * What the promotions service needs from the outside world, database-agnostic.
 * The MongoDB adapter is repository.ts.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
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
export type ParticipationOfferRec = Db['participation_offers'];
export type FlashItemRec = Db['flash_items'];
export type CodeRec = Db['coupon_codes'];
export type ClipRec = Db['coupon_clips'];
export type EvaluationRec = Db['evaluations'];
export type RedemptionRec = Db['redemptions'];
export type RedemptionLineRec = Db['redemption_lines'];
export type UsageRec = Db['usage_counters'];
export type ReminderRec = Db['event_reminders'];
export type LogRec = Db['campaign_log'];
export type ResultRec = Db['campaign_results_daily'];

/** A column condition: a value (=), a list (in), null (is null) or an operator */
export type Cond<V> = V | readonly V[] | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not'; value: V | null };
export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

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

export interface PromotionsRepository {
  transaction<R>(fn: (tx: PromotionsRepository) => Promise<R>): Promise<R>;
  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; inside a transaction it commits with the effects */
  claim(key: string): Promise<boolean>;

  /* generic table access */
  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined>;
  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]>;
  find<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]>;
  findOne<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined>;
  count<T extends Table>(table: T, where: Where<Db[T]>): Promise<number>;
  insert<T extends Table>(table: T, row: Db[T]): Promise<Db[T]>;
  insertMany<T extends Table>(table: T, rows: Db[T][]): Promise<void>;
  /** Insert unless the unique key exists; true when inserted */
  insertIgnore<T extends Table>(table: T, row: Db[T]): Promise<boolean>;
  update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]>;
  updateWhere<T extends Table>(table: T, where: Where<Db[T]>, patch: Partial<Db[T]>): Promise<number>;
  removeWhere<T extends Table>(table: T, where: Where<Db[T]>): Promise<number>;
  page<T extends Table>(table: T, where: Where<Db[T]>, page: PageRequest, order: { column: keyof Db[T] & string; direction: 'asc' | 'desc'; id?: string }): Promise<common.Page<Db[T]>>;

  /* campaigns */
  listCampaigns(filter: CampaignListFilter, page: PageRequest): Promise<common.Page<CampaignRec>>;
  /** Campaigns that may apply at `at`: scheduled or live with the period covering `at` */
  runningCampaigns(at: Date, o?: { kinds?: string[]; ownerKind?: 'platform' | 'seller'; sellerIds?: string[] }): Promise<CampaignRec[]>;
  /** Campaign ids among `campaignIds` whose eligible offers include each offer */
  eligibleFor(offerIds: readonly string[], campaignIds: readonly string[]): Promise<EligibleRec[]>;
  /** Active code rows by case-insensitive code */
  activeCodes(codes: readonly string[]): Promise<CodeRec[]>;
  /** Latest code rows by case-insensitive code, active or not */
  anyCodes(codes: readonly string[]): Promise<CodeRec[]>;
  codeTaken(code: string, exceptCampaignId: string | null): Promise<boolean>;
  costTotals(campaignIds: readonly string[]): Promise<Map<string, CostTotals>>;
  /** Discount still held by open reservations per campaign */
  heldAmounts(campaignIds: readonly string[]): Promise<Map<string, number>>;

  /* atomic counters (row-level conditional updates: safe under parallel checkouts) */
  /** budget_used += amount, usage_count += uses, only when the budget and usage cap allow it */
  addCampaignUsage(campaignId: string, amount: number, uses: number): Promise<CounterResult>;
  /** Gives budget and/or uses back (never below zero) */
  subtractCampaignUsage(campaignId: string, amount: number, uses: number): Promise<void>;
  /** Per-customer uses and units, created on first use; refused above the limits */
  addCustomerUsage(campaignId: string, customerKey: string, uses: number, units: number, limits: { perCustomer: number | null; perCustomerUnits: number | null }): Promise<'ok' | 'uses' | 'units'>;
  subtractCustomerUsage(campaignId: string, customerKey: string, uses: number, units: number): Promise<void>;
  addCodeRedemption(codeId: string): Promise<boolean>;
  subtractCodeRedemption(codeId: string): Promise<void>;
  /** reserved += qty when deal stock allows; returns the row after the change */
  reserveDealStock(campaignId: string, offerId: string, qty: number): Promise<FlashItemRec | undefined>;
  /** reserved -= qty (release) */
  releaseDealStock(campaignId: string, offerId: string, qty: number): Promise<FlashItemRec | undefined>;
  /** reserved -= qty, claimed += qty (commit) */
  claimDealStock(campaignId: string, offerId: string, qty: number): Promise<FlashItemRec | undefined>;
  /** claimed -= qty (cancelled before dispatch) */
  unclaimDealStock(campaignId: string, offerId: string, qty: number): Promise<FlashItemRec | undefined>;

  /* jobs and read models */
  expiredReservations(now: Date, limit: number): Promise<string[]>;
  deleteStaleEvaluations(before: Date, limit: number): Promise<number>;
  /** Committed redemption lines of a campaign with the evaluation line they came from, for the results roll-up */
  resultFacts(campaignId: string): Promise<{ redemption: RedemptionRec; lines: RedemptionLineRec[]; evaluation: unknown }[]>;
  resultsInRange(from: string, to: string, campaignIds?: readonly string[]): Promise<ResultRec[]>;
  upsertResult(row: ResultRec): Promise<void>;
}
