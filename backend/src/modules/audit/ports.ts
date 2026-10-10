/**
 * What the audit service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */
import type { Page } from '../../spec/common.js';
import type { AuditFilters } from '../../spec/audit.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { ChainRow, ChainTarget } from './domain/chain.js';
import type { ApprovalProjection } from './domain/rules.js';

export type { ChainRow, ChainTarget, ApprovalProjection };

/** Filters as the repository applies them (dates already resolved to instants). */
export interface EntryQuery extends Omit<AuditFilters, 'from' | 'to'> {
  from?: Date;
  to?: Date;
  /** `to` is exclusive (whole market days) rather than inclusive (a datetime filter) */
  toExclusive?: boolean;
}

/** A row to append: everything but the identity-generated seq. */
export type NewChainRow = Omit<ChainRow, 'seq'> & { searchText: string };

export interface RetentionRow {
  retainYears: number;
  pendingYears: number | null;
  pendingReason: string | null;
  pendingApprovalRequestId: string | null;
  /** JSON of the requesting Actor */
  pendingRequestedBy: string | null;
  /** JSON of the Actor who last changed it */
  updatedBy: string | null;
  updatedAt: Date | null;
  lastPurgeAt: Date | null;
  lastPurgeRemoved: number | null;
  lastPurgeThrough: Date | null;
}

export interface IntegrityCheckRow {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  fromSeq: number;
  toSeq: number;
  ok: boolean | null;
  brokenAtSeq: number | null;
}

/** A signed chain checkpoint (audit.checkpoints) */
export interface CheckpointRow {
  id: string;
  seq: number;
  hash: Uint8Array;
  /** hex HMAC-SHA256 over seq and hash */
  mac: string;
  keyId: string;
  kind: 'verified' | 'purge';
  createdAt: Date;
}

export interface SummaryCounts {
  total: number;
  pendingSecondReview: number;
  financial: number;
  sellerEnforcement: number;
  settings: number;
  byActor: { name: string; n: number }[];
}

/** Persistence for this module's own tables: audit.entries, audit.entry_targets (and their month partitions, audit.entry_partitions), audit.approval_states, audit.retention, audit.integrity_checks, audit.checkpoints. */
export interface AuditRepository {
  /** Runs fn with a repository bound to one transaction. */
  transaction<T>(fn: (tx: AuditRepository) => Promise<T>): Promise<T>;

  /* ---- the chain (call inside a transaction) */
  /** Serializes appends: held until the transaction ends. */
  lockChain(): Promise<void>;
  chainHead(): Promise<{ seq: number; hash: Uint8Array } | null>;
  /** IP addresses in the form the database returns them (so the hash recomputes) */
  normalizeIps(ips: readonly (string | null)[]): Promise<(string | null)[]>;
  insertEntries(rows: readonly NewChainRow[]): Promise<{ id: string; seq: number }[]>;

  /* ---- reads */
  getEntry(id: string): Promise<ChainRow | null>;
  searchEntries(q: EntryQuery, page: PageRequest): Promise<Page<ChainRow>>;
  countEntries(q: EntryQuery): Promise<number>;
  targetHistory(targetType: string, targetId: string, opts: { includeRelated: boolean; category?: string }, page: PageRequest): Promise<Page<ChainRow>>;
  sellerEntries(sellerId: string, q: { from?: Date; to?: Date; targetType?: string }, page: PageRequest): Promise<Page<ChainRow>>;
  /** Oldest first by seq, after `afterSeq` (exports, verification) */
  entriesBySeq(q: EntryQuery | null, afterSeq: number | null, limit: number, maxSeq?: number): Promise<ChainRow[]>;
  entryBySeq(seq: number): Promise<ChainRow | null>;
  maxSeq(): Promise<number | null>;
  summary(from: Date, to: Date): Promise<SummaryCounts>;
  oldestEntryAt(): Promise<Date | null>;
  latestEntryFor(approvalRequestId: string, action: string): Promise<ChainRow | null>;
  /** Purge checkpoints recorded in purge entries (after.checkpoint) */
  purgeCheckpoints(): Promise<{ seq: number; hash: string }[]>;

  /* ---- approval projection */
  approvalStates(ids: readonly string[]): Promise<Map<string, ApprovalProjection>>;
  getApprovalState(id: string, opts?: { forUpdate?: boolean }): Promise<ApprovalProjection | null>;
  saveApprovalState(p: ApprovalProjection): Promise<void>;

  /* ---- retention */
  /** The single row, created with `defaultYears` when missing */
  retention(defaultYears: number, opts?: { forUpdate?: boolean }): Promise<RetentionRow>;
  updateRetention(patch: Partial<RetentionRow>): Promise<RetentionRow>;
  /** First seq that is kept when entries before `cutoff` are purged; null when every entry is older */
  firstSeqAtOrAfter(cutoff: Date): Promise<number | null>;
  /** The last entry with seq < `beforeSeq` (the newest when null): where a purge up to `beforeSeq` stops */
  lastEntryBefore(beforeSeq: number | null): Promise<{ seq: number; hash: Uint8Array; at: Date } | null>;
  /**
   * Removes entries with seq < `beforeSeq` (or all when null; all of them are before `cutoff`) and their
   * related targets: month partitions entirely before `cutoff` holding only such entries are dropped whole,
   * the rest of them are deleted row by row.
   */
  purgeEntries(beforeSeq: number | null, cutoff: Date): Promise<{ removed: number; droppedPartitions: number }>;

  /* ---- month partitions (call inside a transaction holding the chain lock) */
  /** Creates the market-month partitions of the month of `from` and the `monthsAhead` after it; the number created */
  preparePartitions(from: Date, monthsAhead: number): Promise<number>;
  /** The month partitions, oldest first */
  partitions(): Promise<{ name: string; from: Date; to: Date }[]>;

  /* ---- integrity checks */
  lastIntegrityCheck(): Promise<IntegrityCheckRow | null>;
  lastOkIntegrityCheck(): Promise<IntegrityCheckRow | null>;
  saveIntegrityCheck(row: IntegrityCheckRow): Promise<void>;

  /* ---- signed checkpoints */
  /** The checkpoint with the highest seq */
  latestCheckpoint(): Promise<CheckpointRow | null>;
  /** One checkpoint per seq: a second one at the same seq is ignored */
  insertCheckpoint(row: CheckpointRow): Promise<void>;
}
