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

export interface SummaryCounts {
  total: number;
  pendingSecondReview: number;
  financial: number;
  sellerEnforcement: number;
  settings: number;
  byActor: { name: string; n: number }[];
}

/** Persistence for this module's own tables: audit.entries, audit.entry_targets, audit.approval_states, audit.retention, audit.integrity_checks. */
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
  /** Removes entries with seq < `beforeSeq` (or all when null) and their related targets */
  purgeEntries(beforeSeq: number | null): Promise<{ removed: number; last: { seq: number; hash: Uint8Array; at: Date } | null }>;

  /* ---- integrity checks */
  lastIntegrityCheck(): Promise<IntegrityCheckRow | null>;
  lastOkIntegrityCheck(): Promise<IntegrityCheckRow | null>;
  saveIntegrityCheck(row: IntegrityCheckRow): Promise<void>;
}
