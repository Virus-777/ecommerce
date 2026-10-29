/**
 * The reads of this module that are not the same question in both databases (docs/10 §10.5e).
 *
 * Everything else lives in repository.ts, written once against `ctx.store`. What is here needs a **join**:
 * "does this asset have an active usage" is a condition on `media.usages` while the rows being paged are
 * assets. MongoDB asks it with `$lookup` and `$elemMatch`; MySQL asks it with `EXISTS`, which is the same
 * question and not the same sentence, so each store gets its own implementation of this small interface and
 * the service never knows which one it has.
 *
 * Why named queries rather than a general combinator: three of these four mix an asset condition with a
 * usage condition *inside an OR* (the sweep job), and a vocabulary able to say that is a query language.
 * Four names are cheaper, and at the cutover `queries.mongo.ts` is deleted whole (Y4).
 *
 * All four are reads outside a transaction, which is why nothing here takes one. A query inside a
 * transaction would have to be bound to its connection, and none of these is: the two job selections claim
 * their rows afterwards, each in its own transaction.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type { Page } from '../../spec/common.js';
import type { AssetRow } from './ports.js';

/** Whether the assets wanted are the ones with an active usage, or the ones with none */
export type UsageState = 'active' | 'none';

/** The id, hash and age of a near-duplicate candidate: the whole row is never needed for the comparison */
export interface PhashCandidate {
  id: string;
  phash: number;
  created_at: Date;
}

export interface MediaQueries {
  /** A page of assets matching `where` that have an active usage, or that have none. Newest first */
  pageByUsage(where: WhereWithOr<AssetRow>, usage: UsageState, req: PageRequest): Promise<Page<AssetRow>>;

  /**
   * The sweep job's selection, oldest first: ready or rejected assets past their retention that were either
   * never attached to anything (after the grace period) or are marked for deletion and no longer in use.
   */
  orphans(f: { cutoff: Date; now: Date; excludePurposes: readonly string[]; limit: number }): Promise<AssetRow[]>;

  /** Generated files of these purposes whose expiry has passed and that have no active usage, oldest expiry first */
  expiredGenerated(f: { now: Date; purposes: readonly string[]; limit: number }): Promise<AssetRow[]>;

  /**
   * Ready public images with a perceptual hash, other than `excludeId`, narrowed to an owner and to assets
   * with an active usage of one of `usageKinds` where those are given. The hashes are compared in the
   * repository: neither database can measure a Hamming distance in a query (MongoDB 6.0 has no bitwise
   * operators in a pipeline, and a bit count per row on MySQL would read every row anyway).
   */
  phashCandidates(f: { excludeId: string; ownerKind?: string; ownerId?: string; usageKinds?: readonly string[] }): Promise<PhashCandidate[]>;
}
