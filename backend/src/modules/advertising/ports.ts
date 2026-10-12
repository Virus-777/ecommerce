/**
 * What the advertising service needs from the outside world, database-agnostic.
 * The MongoDB adapter lives in infra/mongo/.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type { AdvertisingDb } from '../../spec/advertising.js';
import type { FrequencyRow } from './domain/rules.js';

export type Db = AdvertisingDb;
export type Table = keyof Db & string;
/** Tables keyed by `id` */
export type IdTable = 'placements' | 'campaigns' | 'approval_steps' | 'creatives' | 'creative_reviews' | 'campaign_log' | 'ad_events' | 'attributions' | 'ad_charges';

export type PlacementRec = Db['placements'];
export type RulesRec = Db['global_rules'];
export type CampaignRec = Db['campaigns'];
export type ItemRec = Db['campaign_items'];
export type CampaignCreativeRec = Db['campaign_creatives'];
export type StepRec = Db['approval_steps'];
export type CreativeRec = Db['creatives'];
export type ReviewRec = Db['creative_reviews'];
export type LogRec = Db['campaign_log'];
export type EventRec = Db['ad_events'];
export type AttributionRec = Db['attributions'];
export type StatRec = Db['daily_stats'];
export type ChargeRec = Db['ad_charges'];

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

export interface AdvertisingRepository {
  transaction<R>(fn: (tx: AdvertisingRepository) => Promise<R>): Promise<R>;
  /** Inbox (ctx.inbox): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean>;

  /* generic table access */
  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined>;
  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]>;
  find<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]>;
  findOne<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined>;
  count<T extends Table>(table: T, where: Where<Db[T]>): Promise<number>;
  insert<T extends Table>(table: T, row: Db[T]): Promise<Db[T]>;
  /** Insert unless a unique key exists; true when inserted */
  insertIgnore<T extends Table>(table: T, row: Db[T]): Promise<boolean>;
  update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]>;
  updateWhere<T extends Table>(table: T, where: Where<Db[T]>, patch: Partial<Db[T]>): Promise<number>;
  removeWhere<T extends Table>(table: T, where: Where<Db[T]>): Promise<number>;
  page<T extends Table>(table: T, where: Where<Db[T]>, page: PageRequest, order: { column: keyof Db[T] & string; direction: 'asc' | 'desc'; id?: string }): Promise<common.Page<Db[T]>>;

  /* global rules */
  maxRulesVersion(): Promise<number>;

  /* campaigns and creatives */
  listCampaigns(filter: CampaignListFilter, page: PageRequest): Promise<common.Page<CampaignRec>>;
  listCreatives(filter: CreativeListFilter, page: PageRequest): Promise<common.Page<CreativeRec>>;
  creativeCounts(filter: CreativeListFilter): Promise<Record<string, number>>;
  /** Live campaigns whose period covers `at` */
  liveCampaigns(at: Date): Promise<CampaignRec[]>;
  /** Latest log row per campaign for the given actions */
  lastLogs(campaignIds: readonly string[], actions: readonly string[]): Promise<Map<string, LogRec>>;
  /** Campaign ids promoting any of the targets (campaign_items) */
  campaignsPromoting(kinds: readonly string[], targetIds: readonly string[]): Promise<ItemRec[]>;

  /* serving: frequency and suppression */
  frequencyRows(visitorKeys: readonly string[], campaignIds: readonly string[]): Promise<(FrequencyRow & { visitor_key: string })[]>;
  /** Any counter for these visitor keys (returning visitor) */
  hasHistory(visitorKeys: readonly string[]): Promise<boolean>;
  /** Display counters: session (reset when the session changes) and window (restarted when the window has passed) */
  /** Counts a display on every key: session, window, the market day (day.day, starting at day.start) and the campaign total */
  recordDisplay(visitorKeys: readonly string[], campaignId: string, sessionId: string, now: Date, windowDays: number | null, day: { day: string; start: Date }): Promise<void>;
  recordDismissal(visitorKeys: readonly string[], campaignId: string, sessionId: string, until: Date, now: Date): Promise<void>;
  /** Tracked displays per campaign for the visitor keys since `since` (all time when null) */
  displayCounts(visitorKeys: readonly string[], campaignIds: readonly string[], since: Date | null): Promise<Map<string, number>>;
  /** Deletes stale rows (and every row of ended campaigns), keeping rows of keepCampaignIds (running campaigns with a total cap) */
  expireFrequency(now: Date, oldestWindowStart: Date, endedCampaignIds: readonly string[], keepCampaignIds?: readonly string[]): Promise<number>;

  /* spend */
  /**
   * Charges one click atomically: campaigns.spent within the total limit, then the day's spend within the
   * daily limit; parallel clicks can never overspend. Sets ad_events.cost on success.
   */
  chargeClick(eventId: string, campaignId: string, day: string): Promise<ClickCharge>;
  /** Day spend per campaign */
  spendOn(campaignIds: readonly string[], day: string): Promise<Map<string, number>>;
  /** Adds (or with a negative delta gives back) spend on a campaign and its day, never below zero */
  addSpend(campaignId: string, day: string, delta: number): Promise<void>;
  /** Billable clicks and their cost between two instants */
  clickBilling(campaignId: string, span: Span): Promise<{ units: number; amount: number }>;
  displaysIn(campaignId: string, span: Span): Promise<number>;

  listCharges(filter: { sellerId?: string; campaignId?: string; state?: string; from?: string; to?: string }, page: PageRequest): Promise<common.Page<ChargeRec>>;

  /* read models */
  /** Recomputes displays, clicks, dismissals and attributions per campaign and market day (spend is kept as charged) */
  rollup(span: Span, timeZone: string): Promise<number>;
  totals(campaignIds: readonly string[] | null, days?: { from: string; to: string }): Promise<Map<string, StatTotals>>;
  statsInRange(days: { from: string; to: string }, campaignIds?: readonly string[] | null): Promise<StatRec[]>;
  /** Distinct visitors that saw ads on a placement since `since` */
  reach(placementKey: string, since: Date): Promise<number>;
  /** The visitor's latest click within the window (by customer id) */
  lastClick(customerId: string, since: Date): Promise<EventRec | undefined>;
  /** Last click stored under a visitor key (guests who allowed personalization) */
  lastClickByVisitor(visitorKey: string, since: Date): Promise<EventRec | undefined>;
  /** Creatives revoked and campaigns rejected with this marker in their reason (trust enforcement id) */
  enforcementTargets(marker: string): Promise<{ creativeIds: string[]; campaignIds: string[] }>;
}
