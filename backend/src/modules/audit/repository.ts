import type { PageRequest } from '../../kernel/lib/pagination.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import type { Store, Where, WhereWithOr } from '../../kernel/store/index.js';
import type { AuditDb, AuditFilters } from '../../spec/audit.js';
import type { Page, TimelineEvent } from '../../spec/common.js';
import type { ChainRow, ChainTarget } from './domain/chain.js';
import { PURGE_ACTION, RETENTION_TARGET, type ApprovalProjection } from './domain/rules.js';
import type { AuditQueries } from './queries.js';
import { searchWords } from './text.js';

/** Filters as the repository applies them (dates already resolved to instants). */
export interface EntryQuery extends Omit<AuditFilters, 'from' | 'to'> {
  from?: Date;
  to?: Date;
  /** `to` is exclusive (whole market days) rather than inclusive (a datetime filter) */
  toExclusive?: boolean;
}

/** A row to append: everything but seq, which the repository numbers. */
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

type EntryRow = AuditDb['entries'];
type TargetRow = AuditDb['entry_targets'];
type ApprovalRow = AuditDb['approval_states'];
type RetentionDbRow = AuditDb['retention'];
type CheckpointDbRow = AuditDb['checkpoints'];
type CheckDbRow = AuditDb['integrity_checks'];

/** A filter on entries, in the one vocabulary both stores read (kernel/store/index.ts, docs/10 §10.5a) */
type EntryFilter = WhereWithOr<EntryRow>;

/** Name of the transaction lock that serializes chain appends (kernel.locks) */
const CHAIN_LOCK = 'chain';
/** Rows per insert round trip; order (and so seq) is kept */
const INSERT_CHUNK = 500;
/** Approval states that are no longer waiting for a second review */
const OPEN_APPROVAL = ['pending', 'partially_approved'];

const bytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(Buffer.from(v as string)));
const buffer = (v: Uint8Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
/**
 * JSON values as they are stored: what JSON.stringify keeps (undefined members dropped, dates as ISO text). The
 * hash is computed over the value as given, so the stored value must read back as the same canonical JSON.
 */
const json = (v: unknown): unknown => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));

function toChainRow(r: EntryRow, related: ChainTarget[]): ChainRow {
  return {
    id: r.id,
    seq: Number(r.seq),
    at: r.at,
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    actorName: r.actor_name,
    actorRoles: r.actor_roles,
    action: r.action,
    actionLabel: r.action_label,
    module: r.module,
    category: r.category,
    targetType: r.target_type,
    targetId: r.target_id,
    targetRef: r.target_ref,
    targetLabel: r.target_label,
    targetScreen: r.target_screen,
    sellerId: r.seller_id,
    reason: r.reason,
    before: r.before ?? null,
    after: r.after ?? null,
    beforeText: r.before_text,
    afterText: r.after_text,
    evidence: r.evidence,
    approvalRequestId: r.approval_request_id,
    approvalNote: r.approval_note,
    requestId: r.request_id,
    ip: r.ip,
    visibleToSeller: r.visible_to_seller,
    relatedTargets: related,
    prevHash: bytes(r.prev_hash),
    hash: bytes(r.hash),
  };
}

function toRetention(r: RetentionDbRow): RetentionRow {
  return {
    retainYears: r.retain_years,
    pendingYears: r.pending_years,
    pendingReason: r.pending_reason,
    pendingApprovalRequestId: r.pending_approval_request_id,
    pendingRequestedBy: r.pending_requested_by,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    lastPurgeAt: r.last_purge_at,
    lastPurgeRemoved: r.last_purge_removed === null ? null : Number(r.last_purge_removed),
    lastPurgeThrough: r.last_purge_through,
  };
}

function toProjection(r: ApprovalRow): ApprovalProjection {
  return {
    approvalRequestId: r.approval_request_id,
    state: r.state,
    approvers: Array.isArray(r.approvers) ? (r.approvers as string[]) : [],
    steps: Array.isArray(r.steps) ? (r.steps as unknown as TimelineEvent[]) : [],
    awaiting: r.awaiting,
    decidedAt: r.decided_at,
    updatedAt: r.updated_at,
  };
}

function toCheck(r: CheckDbRow): IntegrityCheckRow {
  return {
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    fromSeq: Number(r.from_seq),
    toSeq: Number(r.to_seq),
    ok: r.ok,
    brokenAtSeq: r.broken_at_seq === null ? null : Number(r.broken_at_seq),
  };
}

/** All of these conditions: `and` is what one filter object cannot say twice of the same column */
const all = (parts: readonly EntryFilter[]): EntryFilter => (parts.length === 0 ? {} : parts.length === 1 ? parts[0]! : { and: parts });

/**
 * One alternative of an `or` that is itself an `and` — the search box's "every one of these words". Both stores
 * already recurse into a nested `and` with exactly this meaning (`whereFilter` in kernel/mongo/filters.ts,
 * `whereSql` in kernel/mysql/where.ts); only the type of `or` is narrower than what they read, which is why the
 * branch says so here. Reported to the kernel as a one-word widening of `WhereWithOr.or`.
 */
const branch = (w: EntryFilter): Where<EntryRow> => w as Where<EntryRow>;

/**
 * audit.entries, audit.entry_targets, audit.approval_states, audit.retention, audit.integrity_checks,
 * audit.checkpoints — in MySQL or in MongoDB, whichever `MYSQL_MODULES` put this module's data in (docs/10
 * §10.5a, BUILDING-MODULES §5c). Append-only is this repository's rule: entries and entry_targets are only
 * inserted, and deleted only by purgeEntries (the retention purge); nothing here updates them.
 *
 * The one read that is not the same question in both databases — the summary's actors, each named by their
 * newest entry — is the queries port (queries.ts).
 */
export class AuditRepository {
  readonly #t;

  constructor(
    private readonly store: Store,
    private readonly queries: AuditQueries,
  ) {
    this.#t = {
      entries: store.table<EntryRow>('entries'),
      targets: store.table<TargetRow>('entry_targets'),
      approvals: store.table<ApprovalRow>('approval_states'),
      retention: store.table<RetentionDbRow>('retention'),
      checkpoints: store.table<CheckpointDbRow>('checkpoints'),
      checks: store.table<CheckDbRow>('integrity_checks'),
    };
  }

  /** Runs fn with a repository bound to one transaction. */
  transaction<T>(fn: (tx: AuditRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new AuditRepository(tx, this.queries)));
  }

  /** Entries where the record is the target, or (includeRelated) one of the related targets (a join is two reads) */
  async #touches(type: string, id: string, includeRelated: boolean): Promise<EntryFilter> {
    const own = { target_type: type, target_id: id };
    if (!includeRelated) return own;
    const related = await this.#t.targets.distinct<string>('entry_id', { target_type: type, target_id: id });
    return related.length ? { or: [own, { id: related }] } : own;
  }

  async #filterOf(q: EntryQuery | null): Promise<EntryFilter[]> {
    const and: EntryFilter[] = [];
    if (!q) return and;
    if (q.actorId) and.push({ actor_id: q.actorId });
    if (q.roleKey) and.push({ 'actor_roles[].key': q.roleKey }); // any of the actor's roles has this key ([]: an array column, §10.5a)
    if (q.module) and.push({ module: q.module });
    if (q.category) and.push({ category: q.category });
    if (q.action) and.push({ action: q.action });
    if (q.sellerId) and.push({ seller_id: q.sellerId.toLowerCase() });
    if (q.targetType && q.targetId) and.push(await this.#touches(q.targetType, q.targetId, true));
    else if (q.targetType) and.push({ target_type: q.targetType });
    else if (q.targetId) and.push({ target_id: q.targetId });
    if (q.from) and.push({ at: { op: '>=', value: q.from } });
    if (q.to) and.push({ at: { op: q.toExclusive ? '<' : '<=', value: q.to } });
    if (q.approvalState) {
      const state = q.approvalState;
      if (state === 'not_required') and.push({ approval_request_id: null });
      else if (state === 'pending') {
        // referenced and not (yet) projected in any other state. `<>` and not `is not`: state is NOT NULL, so
        // the two read alike here, and `<>` is the reading the spec's conditions are written with
        const moved = await this.#t.approvals.distinct<string>('approval_request_id', { state: { op: '<>', value: 'pending' } });
        // $nin: [null, …] was two conditions on one column, so it is two entries here. `not in` of an empty list
        // filters nothing, which is why "has an approval at all" is pushed separately and not folded into it
        and.push({ approval_request_id: { op: 'is not', value: null } });
        and.push({ approval_request_id: { op: 'not in', value: moved } });
      } else and.push({ approval_request_id: await this.#t.approvals.distinct<string>('approval_request_id', { state }) });
    }
    const text = q.q?.trim();
    if (text) {
      const words = searchWords(text);
      and.push({
        or: [
          // every word of the query, one condition on the array column each (no words: no match). $all has no
          // single neutral spelling and needs none: "all of these" is an `and` of "is an element of" (§10.5a)
          ...(words.length ? [branch({ and: words.map((w) => ({ 'search_words[]': w })) })] : []),
          { target_ref: { op: 'starts with', value: text } },
          { target_id: text },
          { actor_name: { op: 'contains', value: text } },
        ],
      });
    }
    return and;
  }

  async #relatedOf(ids: readonly string[]): Promise<Map<string, ChainTarget[]>> {
    const out = new Map<string, ChainTarget[]>();
    if (!ids.length) return out;
    for (const r of await this.#t.targets.find({ entry_id: [...ids] })) {
      const t = { type: r.target_type, id: r.target_id };
      const list = out.get(r.entry_id);
      if (list) list.push(t);
      else out.set(r.entry_id, [t]);
    }
    return out;
  }

  async #withRelated(rows: readonly EntryRow[]): Promise<ChainRow[]> {
    const related = await this.#relatedOf(rows.map((r) => r.id));
    return rows.map((r) => toChainRow(r, related.get(r.id) ?? []));
  }

  async #pageOfRows(filter: EntryFilter, page: PageRequest): Promise<Page<ChainRow>> {
    const p = await this.#t.entries.page(filter, page, { column: 'at', direction: 'desc' });
    return { ...p, items: await this.#withRelated(p.items) };
  }

  async #one(filter: EntryFilter, sort: Record<string, 1 | -1> = { seq: -1 }): Promise<ChainRow | null> {
    const r = await this.#t.entries.findOne(filter, { sort });
    return r ? (await this.#withRelated([r]))[0]! : null;
  }

  /* ---------------------------------------------------------------- the chain (call inside a transaction) */

  /** Serializes appends: held until the transaction ends. */
  lockChain(): Promise<void> {
    return this.store.lock(CHAIN_LOCK);
  }

  async chainHead(): Promise<{ seq: number; hash: Uint8Array } | null> {
    const r = await this.#t.entries.findOne({}, { sort: { seq: -1 } });
    return r ? { seq: Number(r.seq), hash: bytes(r.hash) } : null;
  }

  async insertEntries(rows: readonly NewChainRow[]): Promise<void> {
    // One chunk at a time, in order: `seq` is this table's identity column and the **store** numbers it, in the
    // order the rows are inserted (a counter on MongoDB, AUTO_INCREMENT on MySQL, §11.2). It is not part of the
    // hash (domain/chain.ts) and nothing reads the numbers back, so there is nothing to number them for.
    //
    // Taking them here instead cost a *second* connection inside the append's transaction, because a counter is
    // read on its own connection (§11.2, so its row lock lasts microseconds). Twenty-five concurrent appends then
    // held every connection in the pool while the one holding `lock('audit:chain')` waited for one more, and the
    // waiters died on the lock timeout rather than the chain being wrong. MongoDB never showed it: its sessions
    // are not a pool of eight.
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const docs: Partial<EntryRow>[] = chunk.map((r) => ({
        id: r.id,
        at: r.at,
        actor_kind: r.actorKind,
        actor_id: r.actorId,
        actor_name: r.actorName,
        actor_roles: (json(r.actorRoles) ?? []) as EntryRow['actor_roles'],
        action: r.action,
        action_label: r.actionLabel,
        module: r.module,
        category: r.category,
        target_type: r.targetType,
        target_id: r.targetId,
        target_ref: r.targetRef,
        target_label: r.targetLabel,
        target_screen: r.targetScreen,
        seller_id: r.sellerId,
        reason: r.reason,
        before: json(r.before) as EntryRow['before'],
        after: json(r.after) as EntryRow['after'],
        before_text: r.beforeText,
        after_text: r.afterText,
        evidence: (json(r.evidence) ?? []) as EntryRow['evidence'],
        approval_request_id: r.approvalRequestId,
        approval_note: r.approvalNote,
        request_id: r.requestId,
        ip: r.ip,
        visible_to_seller: r.visibleToSeller,
        search_words: searchWords(r.searchText),
        prev_hash: buffer(r.prevHash),
        hash: buffer(r.hash),
      }));
      await this.#t.entries.insertMany(docs);
      const targets = chunk.flatMap((r) => r.relatedTargets.map((x) => ({ entry_id: r.id, target_type: x.type, target_id: x.id, at: r.at })));
      await this.#t.targets.insertMany(targets);
    }
  }

  /* ---------------------------------------------------------------- reads */

  getEntry(id: string): Promise<ChainRow | null> {
    return this.#one({ id });
  }

  async searchEntries(q: EntryQuery, page: PageRequest): Promise<Page<ChainRow>> {
    return this.#pageOfRows(all(await this.#filterOf(q)), page);
  }

  async countEntries(q: EntryQuery): Promise<number> {
    return this.#t.entries.count(all(await this.#filterOf(q)));
  }

  async targetHistory(type: string, id: string, opts: { includeRelated: boolean; category?: string }, page: PageRequest): Promise<Page<ChainRow>> {
    const and = [await this.#touches(type, id, opts.includeRelated)];
    if (opts.category) and.push({ category: opts.category });
    return this.#pageOfRows(all(and), page);
  }

  sellerEntries(sellerId: string, q: { from?: Date; to?: Date; targetType?: string }, page: PageRequest): Promise<Page<ChainRow>> {
    const and: EntryFilter[] = [{ seller_id: sellerId, visible_to_seller: true }];
    if (q.from) and.push({ at: { op: '>=', value: q.from } });
    if (q.to) and.push({ at: { op: '<', value: q.to } });
    if (q.targetType) and.push({ target_type: q.targetType });
    return this.#pageOfRows(all(and), page);
  }

  /** Oldest first by seq, after `afterSeq` (exports, verification) */
  async entriesBySeq(q: EntryQuery | null, afterSeq: number | null, limit: number, maxSeq?: number): Promise<ChainRow[]> {
    const and = await this.#filterOf(q);
    if (afterSeq !== null) and.push({ seq: { op: '>', value: afterSeq } });
    if (maxSeq !== undefined) and.push({ seq: { op: '<=', value: maxSeq } });
    return this.#withRelated(await this.#t.entries.find(all(and), { sort: { seq: 1 }, limit }));
  }

  entryBySeq(seq: number): Promise<ChainRow | null> {
    return this.#one({ seq });
  }

  async maxSeq(): Promise<number | null> {
    const r = await this.#t.entries.findOne({}, { sort: { seq: -1 } });
    return r ? Number(r.seq) : null;
  }

  async summary(from: Date, to: Date): Promise<SummaryCounts> {
    // two conditions on one column, which a filter object cannot hold: the range is the two of them, ANDed
    const range: EntryFilter[] = [{ at: { op: '>=', value: from } }, { at: { op: '<', value: to } }];
    // how many rows per key: the one `$group` both stores answer identically, so the seam carries it (§10.5e)
    const byCategory = new Map((await this.#t.entries.countBy(['category'], { and: range })).map((r) => [r.category, r.n]));
    const total = [...byCategory.values()].reduce((a, b) => a + b, 0);
    // entries with an approval that is not decided yet (or not projected yet): two reads instead of not exists.
    // `is not null` here only keeps the list clean and skips the second read when no entry has an approval: a
    // null in the list is ignored by both stores anyway, which is why no test can tell it was dropped
    const referenced = await this.#t.entries.distinct<string>('approval_request_id', { and: [...range, { approval_request_id: { op: 'is not', value: null } }] });
    const decided = referenced.length ? await this.#t.approvals.distinct<string>('approval_request_id', { approval_request_id: referenced, state: { op: 'not in', value: OPEN_APPROVAL } }) : [];
    const pendingSecondReview = await this.#t.entries.count({
      and: [...range, { approval_request_id: { op: 'is not', value: null } }, { approval_request_id: { op: 'not in', value: decided } }],
    });
    // one row per person (actor kind + id), named by their latest entry (a renamed person counts once): a window
    // function on SQL and a sorted group on MongoDB, which is why it is the queries port and not the seam
    const actors = await this.queries.topActors({ from, to, limit: 10 });
    // the summary is keyed by name: two people with the same name stay apart
    const byActor: { name: string; n: number }[] = [];
    for (const a of actors) {
      const name = a.name ?? a.id ?? 'Unknown staff';
      byActor.push({ name: byActor.some((b) => b.name === name) ? `${name} (${a.id ?? 'unknown'})` : name, n: a.n });
    }
    return {
      total,
      pendingSecondReview,
      financial: byCategory.get('financial') ?? 0,
      sellerEnforcement: byCategory.get('seller_enforcement') ?? 0,
      settings: byCategory.get('settings') ?? 0,
      byActor,
    };
  }

  async oldestEntryAt(): Promise<Date | null> {
    return (await this.#t.entries.findOne({}, { sort: { at: 1 } }))?.at ?? null;
  }

  latestEntryFor(approvalRequestId: string, action: string): Promise<ChainRow | null> {
    return this.#one({ approval_request_id: approvalRequestId, action });
  }

  /** Purge checkpoints recorded in purge entries (after.checkpoint) */
  async purgeCheckpoints(): Promise<{ seq: number; hash: string }[]> {
    // purge entries are written against the retention record: its target index finds them without a scan of every entry
    const rows = await this.#t.entries.find({ target_type: RETENTION_TARGET.type, target_id: RETENTION_TARGET.id, action: PURGE_ACTION, module: 'audit' }, { sort: { seq: 1 } });
    return rows.flatMap((r) => {
      const cp = (r.after as { checkpoint?: { seq?: unknown; hash?: unknown } } | null)?.checkpoint;
      return cp && typeof cp.seq === 'number' && typeof cp.hash === 'string' ? [{ seq: cp.seq, hash: cp.hash }] : [];
    });
  }

  /* ---------------------------------------------------------------- approval projection */

  async approvalStates(ids: readonly string[]): Promise<Map<string, ApprovalProjection>> {
    const out = new Map<string, ApprovalProjection>();
    for (const r of await this.#t.approvals.getMany([...new Set(ids)])) out.set(r.approval_request_id, toProjection(r));
    return out;
  }

  async getApprovalState(id: string, opts?: { forUpdate?: boolean }): Promise<ApprovalProjection | null> {
    const r = await this.#t.approvals.get(id, { forUpdate: opts?.forUpdate });
    return r ? toProjection(r) : null;
  }

  async saveApprovalState(p: ApprovalProjection): Promise<void> {
    await this.#t.approvals.upsert({
      approval_request_id: p.approvalRequestId,
      state: p.state,
      approvers: json(p.approvers) as ApprovalRow['approvers'],
      steps: json(p.steps) as ApprovalRow['steps'],
      awaiting: p.awaiting,
      decided_at: p.decidedAt,
      updated_at: p.updatedAt,
    });
  }

  /* ---------------------------------------------------------------- retention */

  /** The single row, created with `defaultYears` when missing */
  async retention(defaultYears: number, opts?: { forUpdate?: boolean }): Promise<RetentionRow> {
    await this.#t.retention.insertIfAbsent({ id: 1, retain_years: defaultYears });
    return toRetention(orThrow(await this.#t.retention.get(1, { forUpdate: opts?.forUpdate }), 'audit: retention row'));
  }

  async updateRetention(patch: Partial<RetentionRow>): Promise<RetentionRow> {
    const set: Partial<RetentionDbRow> = {};
    if (patch.retainYears !== undefined) set.retain_years = patch.retainYears;
    if (patch.pendingYears !== undefined) set.pending_years = patch.pendingYears;
    if (patch.pendingReason !== undefined) set.pending_reason = patch.pendingReason;
    if (patch.pendingApprovalRequestId !== undefined) set.pending_approval_request_id = patch.pendingApprovalRequestId;
    if (patch.pendingRequestedBy !== undefined) set.pending_requested_by = patch.pendingRequestedBy;
    if (patch.updatedBy !== undefined) set.updated_by = patch.updatedBy;
    if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt;
    if (patch.lastPurgeAt !== undefined) set.last_purge_at = patch.lastPurgeAt;
    if (patch.lastPurgeRemoved !== undefined) set.last_purge_removed = patch.lastPurgeRemoved;
    if (patch.lastPurgeThrough !== undefined) set.last_purge_through = patch.lastPurgeThrough;
    return toRetention(orThrow(await this.#t.retention.update(1, set), 'audit: retention row'));
  }

  /** First seq that is kept when entries before `cutoff` are purged; null when every entry is older */
  async firstSeqAtOrAfter(cutoff: Date): Promise<number | null> {
    const r = await this.#t.entries.findOne({ at: { op: '>=', value: cutoff } }, { sort: { seq: 1 } });
    return r ? Number(r.seq) : null;
  }

  /** The last entry with seq < `beforeSeq` (the newest when null): where a purge up to `beforeSeq` stops */
  async lastEntryBefore(beforeSeq: number | null): Promise<{ seq: number; hash: Uint8Array; at: Date } | null> {
    const r = await this.#t.entries.findOne(beforeSeq !== null ? { seq: { op: '<', value: beforeSeq } } : {}, { sort: { seq: -1 } });
    return r ? { seq: Number(r.seq), hash: bytes(r.hash), at: r.at } : null;
  }

  /**
   * Removes the entries before `cutoff` with seq < `beforeSeq` (every entry before `cutoff` when null) and their
   * related targets: the only delete of entries (they are append-only otherwise).
   */
  async purgeEntries(beforeSeq: number | null, cutoff: Date): Promise<{ removed: number }> {
    // the only delete of entries: those before the cut-off (indexed at) that come before every kept entry in the chain
    const before = { at: { op: '<' as const, value: cutoff } };
    const doomed: EntryFilter = beforeSeq === null ? before : { ...before, seq: { op: '<', value: beforeSeq } };
    // their related targets carry the entry's at: every target before the cut-off but those of kept (backdated) entries
    const keptBefore = beforeSeq === null ? [] : await this.#t.entries.distinct<string>('id', { ...before, seq: { op: '>=', value: beforeSeq } });
    // entry_id is never null, so `not in` — which skips nulls, as SQL does — is the same set $nin named.
    // Both deletes go through the port: these two tables are append-only, and on MySQL a delete from one is
    // refused unless the session says it is the purge (queries.ts, docs/10 §6.3)
    await this.queries.purgeRows<TargetRow>(this.store, 'entry_targets', { ...before, ...(keptBefore.length ? { entry_id: { op: 'not in', value: keptBefore } } : {}) });
    return { removed: await this.queries.purgeRows<EntryRow>(this.store, 'entries', doomed) };
  }

  /* ---------------------------------------------------------------- integrity checks */

  async lastIntegrityCheck(): Promise<IntegrityCheckRow | null> {
    const r = await this.#t.checks.findOne({}, { sort: { started_at: -1, id: -1 } });
    return r ? toCheck(r) : null;
  }

  async lastOkIntegrityCheck(): Promise<IntegrityCheckRow | null> {
    const r = await this.#t.checks.findOne({ ok: true }, { sort: { started_at: -1, id: -1 } });
    return r ? toCheck(r) : null;
  }

  async saveIntegrityCheck(c: IntegrityCheckRow): Promise<void> {
    await this.#t.checks.upsert({ id: c.id, started_at: c.startedAt, finished_at: c.finishedAt, from_seq: c.fromSeq, to_seq: c.toSeq, ok: c.ok, broken_at_seq: c.brokenAtSeq });
  }

  /* ---------------------------------------------------------------- signed checkpoints */

  /** The checkpoint with the highest seq */
  async latestCheckpoint(): Promise<CheckpointRow | null> {
    const r = await this.#t.checkpoints.findOne({}, { sort: { seq: -1 } });
    return r ? { id: r.id, seq: Number(r.seq), hash: bytes(r.hash), mac: r.mac, keyId: r.key_id, kind: r.kind as CheckpointRow['kind'], createdAt: r.created_at } : null;
  }

  /** One checkpoint per seq: a second one at the same seq is ignored */
  async insertCheckpoint(c: CheckpointRow): Promise<void> {
    await this.#t.checkpoints.insertIfAbsent({ id: c.id, seq: c.seq, hash: buffer(c.hash), mac: c.mac, key_id: c.keyId, kind: c.kind, created_at: c.createdAt }, ['seq']);
  }
}
