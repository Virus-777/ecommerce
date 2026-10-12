import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter } from '../../../../kernel/mongo/table.js';
import type { PageRequest } from '../../../../kernel/lib/pagination.js';
import type { AuditDb } from '../../../../spec/audit.js';
import type { Page, TimelineEvent } from '../../../../spec/common.js';
import type { ChainRow, ChainTarget } from '../../domain/chain.js';
import { PURGE_ACTION, type ApprovalProjection } from '../../domain/rules.js';
import type { AuditRepository, CheckpointRow, EntryQuery, IntegrityCheckRow, NewChainRow, RetentionRow } from '../../ports.js';
import { normalizeIp, searchWords } from './text.js';

type EntryRow = AuditDb['entries'];
type TargetRow = AuditDb['entry_targets'];
type ApprovalRow = AuditDb['approval_states'];
type RetentionDbRow = AuditDb['retention'];
type CheckpointDbRow = AuditDb['checkpoints'];
type CheckDbRow = AuditDb['integrity_checks'];

/** Name of the transaction lock that serializes chain appends (kernel.locks) */
const CHAIN_LOCK = 'chain';
/** Rows per insert round trip; order (and so seq) is kept */
const INSERT_CHUNK = 500;
/** Approval states that are no longer waiting for a second review */
const OPEN_APPROVAL = ['pending', 'partially_approved'];

const bytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(Buffer.from(v as string)));
const buffer = (v: Uint8Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
/**
 * JSON values as jsonb stored them: what JSON.stringify keeps (undefined members dropped, dates as ISO text). The
 * hash is computed over the value as given, so the stored value must read back as the same canonical JSON.
 */
const json = (v: unknown): unknown => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

const all = (parts: Filter[]): Filter => (parts.length === 0 ? {} : parts.length === 1 ? parts[0]! : { $and: parts });

/**
 * MongoDB adapter for AuditRepository (docs/04-mongodb-migration.md §4): one collection per spec table, no month
 * partitions. Append-only is this repository's rule: entries and entry_targets are only inserted, and deleted only by
 * purgeEntries (the retention purge); nothing here updates them.
 */
export function createMongoAuditRepository(store: ModuleStore): AuditRepository {
  const t = {
    entries: store.table<EntryRow>('entries'),
    targets: store.table<TargetRow>('entry_targets'),
    approvals: store.table<ApprovalRow>('approval_states'),
    retention: store.table<RetentionDbRow>('retention'),
    checkpoints: store.table<CheckpointDbRow>('checkpoints'),
    checks: store.table<CheckDbRow>('integrity_checks'),
  };

  /** Entries where the record is the target, or (includeRelated) one of the related targets (a join is two reads) */
  async function touches(type: string, id: string, includeRelated: boolean): Promise<Filter> {
    const own = { target_type: type, target_id: id };
    if (!includeRelated) return own;
    const related = await t.targets.distinct<string>('entry_id', { target_type: type, target_id: id });
    return related.length ? { $or: [own, { id: { $in: related } }] } : own;
  }

  async function filterOf(q: EntryQuery | null): Promise<Filter[]> {
    const and: Filter[] = [];
    if (!q) return and;
    if (q.actorId) and.push({ actor_id: q.actorId });
    if (q.roleKey) and.push({ 'actor_roles.key': q.roleKey }); // jsonb containment of [{ key }]
    if (q.module) and.push({ module: q.module });
    if (q.category) and.push({ category: q.category });
    if (q.action) and.push({ action: q.action });
    if (q.sellerId) and.push({ seller_id: q.sellerId.toLowerCase() });
    if (q.targetType && q.targetId) and.push(await touches(q.targetType, q.targetId, true));
    else if (q.targetType) and.push({ target_type: q.targetType });
    else if (q.targetId) and.push({ target_id: q.targetId });
    if (q.from) and.push({ at: { $gte: q.from } });
    if (q.to) and.push({ at: { [q.toExclusive ? '$lt' : '$lte']: q.to } });
    if (q.approvalState) {
      const state = q.approvalState;
      if (state === 'not_required') and.push({ approval_request_id: null });
      else if (state === 'pending') {
        // referenced and not (yet) projected in any other state
        const moved = await t.approvals.distinct<string>('approval_request_id', { state: { $ne: 'pending' } });
        and.push({ approval_request_id: { $nin: [null, ...moved] } });
      } else and.push({ approval_request_id: { $in: await t.approvals.distinct<string>('approval_request_id', { state }) } });
    }
    const text = q.q?.trim();
    if (text) {
      const words = searchWords(text);
      and.push({
        $or: [
          // plainto_tsquery: every word of the query (no words: no match)
          ...(words.length ? [{ search_words: { $all: words } }] : []),
          { target_ref: { $regex: `^${escapeRegExp(text)}`, $options: 'i' } },
          { target_id: text },
          { actor_name: { $regex: escapeRegExp(text), $options: 'i' } },
        ],
      });
    }
    return and;
  }

  async function relatedOf(ids: readonly string[]): Promise<Map<string, ChainTarget[]>> {
    const out = new Map<string, ChainTarget[]>();
    if (!ids.length) return out;
    for (const r of await t.targets.find({ entry_id: { $in: [...ids] } })) out.set(r.entry_id, [...(out.get(r.entry_id) ?? []), { type: r.target_type, id: r.target_id }]);
    return out;
  }

  async function withRelated(rows: readonly EntryRow[]): Promise<ChainRow[]> {
    const related = await relatedOf(rows.map((r) => r.id));
    return rows.map((r) => toChainRow(r, related.get(r.id) ?? []));
  }

  async function pageOfRows(filter: Filter, page: PageRequest): Promise<Page<ChainRow>> {
    const p = await t.entries.page(filter, page, { column: 'at', direction: 'desc' });
    return { ...p, items: await withRelated(p.items) };
  }

  async function one(filter: Filter, sort: Record<string, 1 | -1> = { seq: -1 }): Promise<ChainRow | null> {
    const r = await t.entries.findOne(filter, { sort });
    return r ? (await withRelated([r]))[0]! : null;
  }

  const repo: AuditRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoAuditRepository(tx))),

    /* ---------------------------------------------------------------- chain */

    lockChain: () => store.lock(CHAIN_LOCK),

    async chainHead() {
      const r = await t.entries.findOne({}, { sort: { seq: -1 } });
      return r ? { seq: Number(r.seq), hash: bytes(r.hash) } : null;
    },

    normalizeIps: async (ips) => ips.map((ip) => (ip === null ? null : normalizeIp(ip))),

    async insertEntries(rows) {
      const out: { id: string; seq: number }[] = [];
      // one after another (seq is numbered in this order); each chunk is one round trip
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        const chunk = rows.slice(i, i + INSERT_CHUNK);
        const docs: Partial<EntryRow>[] = [];
        for (const r of chunk) {
          docs.push({
            id: r.id,
            seq: await store.nextValue('entries.seq'),
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
          });
        }
        await t.entries.insertMany(docs);
        const targets = chunk.flatMap((r) => r.relatedTargets.map((x) => ({ entry_id: r.id, target_type: x.type, target_id: x.id, at: r.at })));
        await t.targets.insertMany(targets);
        out.push(...docs.map((d) => ({ id: d.id!, seq: d.seq! })));
      }
      return out;
    },

    /* ---------------------------------------------------------------- reads */

    getEntry: (id) => one({ id }),

    searchEntries: async (q, page) => pageOfRows(all(await filterOf(q)), page),

    countEntries: async (q) => t.entries.count(all(await filterOf(q))),

    async targetHistory(type, id, opts, page) {
      const and = [await touches(type, id, opts.includeRelated)];
      if (opts.category) and.push({ category: opts.category });
      return pageOfRows(all(and), page);
    },

    sellerEntries(sellerId, q, page) {
      const and: Filter[] = [{ seller_id: sellerId, visible_to_seller: true }];
      if (q.from) and.push({ at: { $gte: q.from } });
      if (q.to) and.push({ at: { $lt: q.to } });
      if (q.targetType) and.push({ target_type: q.targetType });
      return pageOfRows(all(and), page);
    },

    async entriesBySeq(q, afterSeq, limit, maxSeq) {
      const and = await filterOf(q);
      if (afterSeq !== null) and.push({ seq: { $gt: afterSeq } });
      if (maxSeq !== undefined) and.push({ seq: { $lte: maxSeq } });
      return withRelated(await t.entries.find(all(and), { sort: { seq: 1 }, limit }));
    },

    entryBySeq: (seq) => one({ seq }),

    async maxSeq() {
      const r = await t.entries.findOne({}, { sort: { seq: -1 } });
      return r ? Number(r.seq) : null;
    },

    async summary(from, to) {
      const range = { at: { $gte: from, $lt: to } };
      const byCategory = new Map(
        (await t.entries.aggregate<{ _id: string; n: number }>([{ $match: range }, { $group: { _id: '$category', n: { $sum: 1 } } }])).map((r) => [r._id, r.n]),
      );
      const total = [...byCategory.values()].reduce((a, b) => a + b, 0);
      // entries with an approval that is not decided yet (or not projected yet): two reads instead of not exists
      const referenced = await t.entries.distinct<string>('approval_request_id', { ...range, approval_request_id: { $ne: null } });
      const decided = referenced.length ? await t.approvals.distinct<string>('approval_request_id', { approval_request_id: { $in: referenced }, state: { $nin: OPEN_APPROVAL } }) : [];
      const pendingSecondReview = await t.entries.count({ ...range, approval_request_id: { $nin: [null, ...decided] } });
      const byActor = await t.entries.aggregate<{ name: string; n: number }>([
        { $match: { ...range, actor_kind: 'staff' } },
        { $group: { _id: { $ifNull: ['$actor_name', '$actor_id', 'Unknown staff'] }, n: { $sum: 1 } } },
        { $sort: { n: -1, _id: 1 } },
        { $limit: 10 },
        { $project: { _id: 0, name: '$_id', n: 1 } },
      ]);
      return {
        total,
        pendingSecondReview,
        financial: byCategory.get('financial') ?? 0,
        sellerEnforcement: byCategory.get('seller_enforcement') ?? 0,
        settings: byCategory.get('settings') ?? 0,
        byActor,
      };
    },

    async oldestEntryAt() {
      return (await t.entries.findOne({}, { sort: { at: 1 } }))?.at ?? null;
    },

    latestEntryFor: (approvalRequestId, action) => one({ approval_request_id: approvalRequestId, action }),

    async purgeCheckpoints() {
      const rows = await t.entries.find({ action: PURGE_ACTION, module: 'audit' }, { sort: { seq: 1 } });
      return rows.flatMap((r) => {
        const cp = (r.after as { checkpoint?: { seq?: unknown; hash?: unknown } } | null)?.checkpoint;
        return cp && typeof cp.seq === 'number' && typeof cp.hash === 'string' ? [{ seq: cp.seq, hash: cp.hash }] : [];
      });
    },

    /* ---------------------------------------------------------------- approval projection */

    async approvalStates(ids) {
      const out = new Map<string, ApprovalProjection>();
      for (const r of await t.approvals.getMany([...new Set(ids)])) out.set(r.approval_request_id, toProjection(r));
      return out;
    },

    async getApprovalState(id, opts) {
      const r = await t.approvals.get(id, { forUpdate: opts?.forUpdate });
      return r ? toProjection(r) : null;
    },

    async saveApprovalState(p) {
      await t.approvals.upsert({
        approval_request_id: p.approvalRequestId,
        state: p.state,
        approvers: json(p.approvers) as ApprovalRow['approvers'],
        steps: json(p.steps) as ApprovalRow['steps'],
        awaiting: p.awaiting,
        decided_at: p.decidedAt,
        updated_at: p.updatedAt,
      });
    },

    /* ---------------------------------------------------------------- retention */

    async retention(defaultYears, opts) {
      await t.retention.insertIfAbsent({ id: 1, retain_years: defaultYears });
      const r = await t.retention.get(1, { forUpdate: opts?.forUpdate });
      if (!r) throw new Error('audit: retention row missing');
      return toRetention(r);
    },

    async updateRetention(patch) {
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
      const r = await t.retention.update(1, set);
      if (!r) throw new Error('audit: retention row missing');
      return toRetention(r);
    },

    async firstSeqAtOrAfter(cutoff) {
      const r = await t.entries.findOne({ at: { $gte: cutoff } }, { sort: { seq: 1 } });
      return r ? Number(r.seq) : null;
    },

    async lastEntryBefore(beforeSeq) {
      const r = await t.entries.findOne(beforeSeq !== null ? { seq: { $lt: beforeSeq } } : {}, { sort: { seq: -1 } });
      return r ? { seq: Number(r.seq), hash: bytes(r.hash), at: r.at } : null;
    },

    async purgeEntries(beforeSeq, cutoff) {
      // the only delete of entries: those before the cut-off (indexed at) that come before every kept entry in the chain
      const doomed: Filter = beforeSeq === null ? { at: { $lt: cutoff } } : { at: { $lt: cutoff }, seq: { $lt: beforeSeq } };
      // their related targets carry the entry's at: every target before the cut-off but those of kept (backdated) entries
      const keptBefore = beforeSeq === null ? [] : await t.entries.distinct<string>('id', { at: { $lt: cutoff }, seq: { $gte: beforeSeq } });
      await t.targets.deleteMany({ at: { $lt: cutoff }, ...(keptBefore.length ? { entry_id: { $nin: keptBefore } } : {}) });
      return { removed: await t.entries.deleteMany(doomed) };
    },

    /* ---------------------------------------------------------------- integrity checks */

    async lastIntegrityCheck() {
      const r = await t.checks.findOne({}, { sort: { started_at: -1, id: -1 } });
      return r ? toCheck(r) : null;
    },

    async lastOkIntegrityCheck() {
      const r = await t.checks.findOne({ ok: true }, { sort: { started_at: -1, id: -1 } });
      return r ? toCheck(r) : null;
    },

    async saveIntegrityCheck(c) {
      await t.checks.upsert({ id: c.id, started_at: c.startedAt, finished_at: c.finishedAt, from_seq: c.fromSeq, to_seq: c.toSeq, ok: c.ok, broken_at_seq: c.brokenAtSeq });
    },

    /* ---------------------------------------------------------------- signed checkpoints */

    async latestCheckpoint() {
      const r = await t.checkpoints.findOne({}, { sort: { seq: -1 } });
      return r ? { id: r.id, seq: Number(r.seq), hash: bytes(r.hash), mac: r.mac, keyId: r.key_id, kind: r.kind as CheckpointRow['kind'], createdAt: r.created_at } : null;
    },

    async insertCheckpoint(c) {
      // one per seq (unique index): a second one at the same seq is ignored
      await t.checkpoints.insertIfAbsent({ id: c.id, seq: c.seq, hash: buffer(c.hash), mac: c.mac, key_id: c.keyId, kind: c.kind, created_at: c.createdAt }, ['seq']);
    },
  };
  return repo;
}
