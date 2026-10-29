/**
 * The reads of the sellers module that are not the same sentence in both databases (docs/10 §10.5e).
 * Everything else lives in repository.ts, written once against `ctx.store` in the neutral vocabulary.
 *
 * Why each of these is here:
 *
 *   - **a window function.** The latest snapshot of every seller, and the latest N of each — §13.1's "latest
 *     rows per key", which is `$setWindowFields` / `$group $first` on one side and
 *     `ROW_NUMBER() OVER (PARTITION BY seller_id ORDER BY computed_at DESC)` on the other.
 *   - **a `GROUP BY` with more than a count.** `performanceFactsByKind` counts *and* totals
 *     `performance_events.value`, which is `DECIMAL(14,4)`: `table.sum` refuses a DECIMAL column by name on
 *     both stores, because one return type would mean rounding money on its way through a total.
 *   - **three things the neutral vocabulary cannot say**, each reported rather than worked around in the
 *     repository (BUILDING-MODULES §5c):
 *       1. `contains` / `equals ignoring case` on a path into a JSON **object**. `Cond` has them, and
 *          `kernel/mysql/where.ts` `objectPathSql` does not — it takes a value, a list, `null`, `<>`,
 *          `is not`, the four comparisons, `between` and `like` (case-sensitive, `utf8mb4_0900_bin`). The
 *          admin seller list searches `sellers.contact.email`, the application queue searches
 *          `account.storeName`, `business.legalName` and `account.contactName`, and `applicationsMatching`
 *          compares `lower(account.workEmail)` and `lower(…address.line1)`. All five are search-box text.
 *       2. an **array nested inside a JSON object**. `applications.business.categoryIds` is a list of ids
 *          inside the `business` document; `business.categoryIds[]` is read as the `[]` path of a column
 *          called `business.categoryIds`, which no table has.
 *     (The third, `$nor`, needed no port: it is De Morgan's law in `listApplications`.)
 *
 * `module.ts` picks one line — `ctx.mysql ? mysqlSellersQueries(ctx.mysql) : mongoSellersQueries(ctx.mongo)` —
 * the repository passes the port down to its transaction clone, and at the cutover `queries.mongo.ts` is
 * deleted whole rather than edited (Y4).
 *
 * All of these are reads outside a transaction, which is why none of them takes one: they serve the two admin
 * lists, the duplicate-application check at submission, and the performance job's per-seller facts.
 */
import type { KeysetOrder, PageRequest } from '../../kernel/lib/pagination.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type * as common from '../../spec/common.js';
import type { ApplicationRec, PerformanceFacts, SellerRec, SnapshotRec } from './ports.js';

/** What `applicationsMatching` compares a submission against (the repository answers an empty ask itself) */
export interface ApplicationSignals {
  emails: string[];
  tokens: string[];
  addresses: { line1: string; postalCode: string }[];
  taxIdHashes?: string[];
}

export interface SellersQueries {
  /**
   * A page of sellers matching `where` whose **store name, legal name, contact email or reference** contains
   * `term` (trimmed, ignoring case). `contact.email` is a path inside a JSON document, which is why the whole
   * search is here; the repository reads the list itself when nothing was typed.
   */
  pageSellersMatching(where: WhereWithOr<SellerRec>, term: string, req: PageRequest, order: KeysetOrder): Promise<common.Page<SellerRec>>;

  /** The same filter as `pageSellersMatching`, unpaged: at most `limit` sellers, newest first */
  findSellersMatching(where: WhereWithOr<SellerRec>, term: string, limit: number): Promise<SellerRec[]>;

  /** Ids of the applications whose business lists `categoryId` (`business.categoryIds` holds it) */
  applicationIdsInCategory(categoryId: string): Promise<string[]>;

  /**
   * Ids of the sellers whose **latest** performance snapshot has a dispatch reliability value that is a
   * number and is below `value`. A seller with no snapshot, or whose latest one has no value for the metric,
   * is not below it — which is why the type is part of the question and not an afterthought: a JSON null
   * sorts below every number in MySQL, and MongoDB's `$lt` would not have matched it at all.
   */
  sellerIdsWithDispatchValueBelow(value: number): Promise<string[]>;

  /** Ids of the sellers whose **latest** performance snapshot has a dispatch reliability status in `statuses` */
  sellerIdsWithDispatchStatusIn(statuses: readonly string[]): Promise<string[]>;

  /**
   * A page of applications matching `where` whose **reference, store name, legal name or contact name**
   * contains `term`, oldest decision target first. Three of the four are paths inside JSON documents.
   */
  pageApplicationsMatching(where: WhereWithOr<ApplicationRec>, term: string, req: PageRequest): Promise<common.Page<ApplicationRec>>;

  /**
   * Other applications (any state, so closed sellers too, and never `excludeId`) sharing a work email, a
   * payout destination token, a business or return address, or a tax id hash with the submission. At most 20.
   *
   * The work email and the address line are compared ignoring case: `lower(x) = lower(y)` on MongoDB, the
   * `as_ci` collation on MySQL (§5.2 — the same rule, since both ignore case and not accents).
   */
  applicationsMatching(s: ApplicationSignals, excludeId: string): Promise<ApplicationRec[]>;

  /**
   * How many performance events of each kind a seller has since `since`, and the exact total of their
   * `value`, for the kinds given (all of them when `kinds` is left out). Kinds with no event are left out,
   * as `$group` leaves them out.
   */
  performanceFactsByKind(sellerId: string, since: Date, kinds?: readonly string[]): Promise<PerformanceFacts[]>;

  /**
   * The newest `perSeller` snapshots of each of `sellerIds`, by seller and newest first within each.
   * `sellerIds` is never empty: the repository answers an empty ask without a query.
   */
  latestSnapshots(sellerIds: readonly string[], perSeller: number): Promise<SnapshotRec[]>;
}
