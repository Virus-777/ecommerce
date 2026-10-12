/**
 * What the offers service needs from the outside world, database-agnostic.
 * The MongoDB adapter lives in infra/mongo/; the bulk file reader (media download) in infra/files/.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { OffersDb } from '../../spec/offers.js';

export type Db = OffersDb;
export type Table = keyof Db & string;
/** Tables keyed by `id` */
export type IdTable = 'offers' | 'offer_price_history' | 'price_changes' | 'offer_status_log' | 'bulk_update_jobs';

export type OfferRec = Db['offers'];
export type PriceHistoryRec = Db['offer_price_history'];
export type PriceChangeRec = Db['price_changes'];
export type StatusLogRec = Db['offer_status_log'];
export type EligibilityRec = Db['offer_eligibility'];
export type FeaturedRec = Db['featured_offers'];
export type RuleRec = Db['featured_rules'];
export type BulkJobRec = Db['bulk_update_jobs'];
export type BulkRowRec = Db['bulk_update_rows'];

/** A column condition: a value (=), a list (in), null (is null) or an operator */
export type Cond<V> = V | readonly V[] | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not' | 'not in'; value: V | readonly V[] | null };
export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

export interface OfferListFilter {
  ownerType?: 'official' | 'seller';
  sellerId?: string;
  productId?: string;
  productIds?: string[];
  variantIds?: string[];
  ids?: string[];
  statuses?: string[];
  excludeStatuses?: string[];
  conditions?: string[];
  /** offer title (substring or trigram match), seller SKU or offer id */
  q?: string;
  contentGap?: string;
  shippingProfileId?: string;
  featuredEligible?: boolean;
  ineligibilityCode?: string;
}

export interface OffersRepository {
  transaction<R>(fn: (tx: OffersRepository) => Promise<R>): Promise<R>;
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
  update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]>;
  updateWhere<T extends Table>(table: T, where: Where<Db[T]>, patch: Partial<Db[T]>): Promise<number>;
  deleteWhere<T extends Table>(table: T, where: Where<Db[T]>): Promise<void>;

  /* offers */
  listOffers(filter: OfferListFilter, page: PageRequest, order?: { column: 'created_at' | 'updated_at'; direction: 'asc' | 'desc' }): Promise<common.Page<OfferRec>>;
  allOffers(filter: OfferListFilter, limit: number): Promise<OfferRec[]>;
  countByStatus(filter: OfferListFilter): Promise<Record<string, number>>;
  /** Offers that are or were featured in any zone */
  featuredOfferIds(offerIds: readonly string[]): Promise<Set<string>>;

  /* price changes */
  listPriceChanges(filter: { states?: string[]; offerId?: string; ownerType?: 'official' | 'seller'; sellerId?: string }, page: PageRequest): Promise<common.Page<PriceChangeRec>>;

  /* eligibility */
  getEligibility(offerIds: readonly string[]): Promise<EligibilityRec[]>;
  upsertEligibility(row: EligibilityRec): Promise<void>;

  /* featured decisions */
  getFeatured(variantId: string, group: string, zoneKey: string): Promise<FeaturedRec | undefined>;
  upsertFeatured(row: FeaturedRec): Promise<void>;
  markFeaturedDirty(where: { variantIds?: readonly string[]; productIds?: readonly string[]; all?: boolean; olderThan?: Date; ruleVersionNot?: number }): Promise<number>;
  dirtyFeatured(limit: number): Promise<FeaturedRec[]>;

  /* rules */
  rules(): Promise<RuleRec[]>;

  /* bulk */
  listBulkJobs(filter: { ownerType: 'official' | 'seller'; sellerId?: string }, page: PageRequest): Promise<common.Page<BulkJobRec>>;
  bulkRows(jobId: string, result: string | undefined, page: PageRequest): Promise<common.Page<BulkRowRec>>;
  updateBulkRow(jobId: string, rowNo: number, patch: Partial<BulkRowRec>): Promise<void>;
}

/** Reads an uploaded bulk file (media) as text */
export interface BulkFileReader {
  read(fileId: string, principal: identity.Principal): Promise<{ fileName: string; text: string; owner: { kind: string; id?: string | null } } | null>;
}
