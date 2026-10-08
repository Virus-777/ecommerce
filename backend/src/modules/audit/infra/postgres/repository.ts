import { sql, type ExpressionBuilder, type Kysely, type SelectQueryBuilder } from 'kysely';
import type { AuditDb } from '../../../../spec/audit.js';
import type { Page, TimelineEvent } from '../../../../spec/common.js';
import { paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { ChainRow, ChainTarget } from '../../domain/chain.js';
import { PURGE_ACTION, type ApprovalProjection } from '../../domain/rules.js';
import type { AuditRepository, EntryQuery, IntegrityCheckRow, NewChainRow, RetentionRow, SummaryCounts } from '../../ports.js';

type Db = Kysely<AuditDb>;
type EntriesQuery = SelectQueryBuilder<AuditDb, 'entries', any>;

/** pg_advisory_xact_lock key that serializes chain appends ("audit" in ASCII) */
const CHAIN_LOCK = 0x6175646974;
/** Rows per INSERT (30 parameters each) */
const INSERT_CHUNK = 500;

const ENTRY_COLUMNS = [
  'entries.id',
  'entries.seq',
  'entries.at',
  'entries.actor_kind',
  'entries.actor_id',
  'entries.actor_name',
  'entries.actor_roles',
  'entries.action',
  'entries.action_label',
  'entries.module',
  'entries.category',
  'entries.target_type',
  'entries.target_id',
  'entries.target_ref',
  'entries.target_label',
  'entries.target_screen',
  'entries.seller_id',
  'entries.reason',
  'entries.before',
  'entries.after',
  'entries.before_text',
  'entries.after_text',
  'entries.evidence',
  'entries.approval_request_id',
  'entries.approval_note',
  'entries.request_id',
  'entries.ip',
  'entries.visible_to_seller',
  'entries.prev_hash',
  'entries.hash',
] as const;

type EntryDbRow = Omit<AuditDb['entries'], 'search' | 'seq'> & { seq: number };

const bytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(Buffer.from(v as string)));
const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function toChainRow(r: EntryDbRow, related: ChainTarget[]): ChainRow {
  return {
    id: r.id,
    seq: Number(r.seq),
    at: r.at instanceof Date ? r.at : new Date(r.at as unknown as string),
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

function toRetention(r: AuditDb['retention']): RetentionRow {
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

function toProjection(r: AuditDb['approval_states']): ApprovalProjection {
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

function toCheck(r: AuditDb['integrity_checks']): IntegrityCheckRow {
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

/** Entries where the record is the target, or (includeRelated) one of the related targets. */
const touches = (eb: ExpressionBuilder<AuditDb, 'entries'>, type: string, id: string, includeRelated: boolean) => {
  const own = eb.and([eb('entries.target_type', '=', type), eb('entries.target_id', '=', id)]);
  if (!includeRelated) return own;
  return eb.or([
    own,
    eb('entries.id', 'in', eb.selectFrom('entry_targets').select('entry_targets.entry_id').where('entry_targets.target_type', '=', type).where('entry_targets.target_id', '=', id)),
  ]);
};

function applyFilters(qb: EntriesQuery, q: EntryQuery | null): EntriesQuery {
  if (!q) return qb;
  if (q.actorId) qb = qb.where('entries.actor_id', '=', q.actorId);
  if (q.roleKey) qb = qb.where(sql<boolean>`entries.actor_roles @> ${JSON.stringify([{ key: q.roleKey }])}::jsonb`);
  if (q.module) qb = qb.where('entries.module', '=', q.module);
  if (q.category) qb = qb.where('entries.category', '=', q.category);
  if (q.action) qb = qb.where('entries.action', '=', q.action);
  if (q.sellerId) qb = qb.where('entries.seller_id', '=', q.sellerId.toLowerCase());
  if (q.targetType && q.targetId) qb = qb.where((eb) => touches(eb, q.targetType!, q.targetId!, true));
  else if (q.targetType) qb = qb.where('entries.target_type', '=', q.targetType);
  else if (q.targetId) qb = qb.where('entries.target_id', '=', q.targetId);
  if (q.from) qb = qb.where('entries.at', '>=', q.from);
  if (q.to) qb = qb.where('entries.at', q.toExclusive ? '<' : '<=', q.to);
  if (q.approvalState) {
    const state = q.approvalState;
    if (state === 'not_required') qb = qb.where('entries.approval_request_id', 'is', null);
    else if (state === 'pending')
      qb = qb
        .where('entries.approval_request_id', 'is not', null)
        .where((eb) =>
          eb.not(eb.exists(eb.selectFrom('approval_states').select(sql.lit(1).as('one')).whereRef('approval_states.approval_request_id', '=', 'entries.approval_request_id').where('approval_states.state', '<>', 'pending'))),
        );
    else
      qb = qb.where((eb) =>
        eb.exists(eb.selectFrom('approval_states').select(sql.lit(1).as('one')).whereRef('approval_states.approval_request_id', '=', 'entries.approval_request_id').where('approval_states.state', '=', state)),
      );
  }
  if (q.q?.trim()) {
    const text = q.q.trim();
    const prefix = `${likeEscape(text)}%`;
    qb = qb.where((eb) =>
      eb.or([
        sql<boolean>`entries.search @@ plainto_tsquery('simple', ${text})`,
        eb('entries.target_ref', 'ilike', prefix),
        eb('entries.target_id', '=', text),
        eb('entries.actor_name', 'ilike', `%${likeEscape(text)}%`),
      ]),
    );
  }
  return qb;
}

/** Postgres adapter for AuditRepository. `db` is scoped to the `audit` schema. */
export function createPostgresAuditRepository(db: Db, inTransaction = false): AuditRepository {
  const entries = () => db.selectFrom('entries').select(ENTRY_COLUMNS);

  async function relatedOf(ids: readonly string[]): Promise<Map<string, ChainTarget[]>> {
    const out = new Map<string, ChainTarget[]>();
    if (!ids.length) return out;
    const rows = await db.selectFrom('entry_targets').select(['entry_id', 'target_type', 'target_id']).where('entry_id', 'in', [...ids]).execute();
    for (const r of rows) out.set(r.entry_id, [...(out.get(r.entry_id) ?? []), { type: r.target_type, id: r.target_id }]);
    return out;
  }

  async function withRelated(rows: readonly EntryDbRow[]): Promise<ChainRow[]> {
    const related = await relatedOf(rows.map((r) => r.id));
    return rows.map((r) => toChainRow(r, related.get(r.id) ?? []));
  }

  async function pageOfRows(qb: EntriesQuery, page: PageRequest): Promise<Page<ChainRow>> {
    const p = await paginate(qb, page, { column: 'entries.at', direction: 'desc', id: 'entries.id' });
    return { ...p, items: await withRelated(p.items as EntryDbRow[]) };
  }

  async function insertChunk(rows: readonly NewChainRow[]): Promise<{ id: string; seq: number }[]> {
    const inserted = await db
      .insertInto('entries')
      .values(
        rows.map((r) => ({
          id: r.id,
          at: r.at,
          actor_kind: r.actorKind,
          actor_id: r.actorId,
          actor_name: r.actorName,
          actor_roles: json(r.actorRoles) ?? '[]',
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
          before: json(r.before),
          after: json(r.after),
          before_text: r.beforeText,
          after_text: r.afterText,
          evidence: json(r.evidence) ?? '[]',
          approval_request_id: r.approvalRequestId,
          approval_note: r.approvalNote,
          request_id: r.requestId,
          ip: r.ip,
          visible_to_seller: r.visibleToSeller,
          search: sql<string>`to_tsvector('simple', ${r.searchText})`,
          prev_hash: r.prevHash,
          hash: r.hash,
        })),
      )
      .returning(['id', 'seq'])
      .execute();
    const targets = rows.flatMap((r) => r.relatedTargets.map((t) => ({ entry_id: r.id, target_type: t.type, target_id: t.id, at: r.at })));
    if (targets.length) await db.insertInto('entry_targets').values(targets).execute();
    return inserted.map((x) => ({ id: x.id, seq: Number(x.seq) }));
  }

  const repo: AuditRepository = {
    async transaction(fn) {
      if (inTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresAuditRepository(trx, true)));
    },

    /* ---------------------------------------------------------------- chain */

    async lockChain() {
      await sql`select pg_advisory_xact_lock(${CHAIN_LOCK}::bigint)`.execute(db);
    },

    async chainHead() {
      const r = await db.selectFrom('entries').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
      return r ? { seq: Number(r.seq), hash: bytes(r.hash) } : null;
    },

    async normalizeIps(ips) {
      const r = await sql<{ ip: string | null }>`
        select host(t.x::inet) as ip from jsonb_array_elements_text(${JSON.stringify(ips)}::jsonb) with ordinality as t(x, i) order by t.i`.execute(db);
      return r.rows.map((x) => x.ip);
    },

    async insertEntries(all) {
      const out: { id: string; seq: number }[] = [];
      // chunks keep each statement under PostgreSQL's 65,535 parameters; order (and so seq) is kept
      for (let i = 0; i < all.length; i += INSERT_CHUNK) out.push(...(await insertChunk(all.slice(i, i + INSERT_CHUNK))));
      return out;
    },

    /* ---------------------------------------------------------------- reads */

    async getEntry(id) {
      const r = await entries().where('entries.id', '=', id).executeTakeFirst();
      return r ? (await withRelated([r as EntryDbRow]))[0]! : null;
    },

    searchEntries: (q, page) => pageOfRows(applyFilters(entries(), q), page),

    async countEntries(q) {
      const r = await applyFilters(db.selectFrom('entries').select(sql<number>`count(*)::int`.as('n')), q).executeTakeFirst();
      return Number(r?.n ?? 0);
    },

    targetHistory(type, id, opts, page) {
      let qb = entries().where((eb) => touches(eb, type, id, opts.includeRelated));
      if (opts.category) qb = qb.where('entries.category', '=', opts.category);
      return pageOfRows(qb, page);
    },

    sellerEntries(sellerId, q, page) {
      let qb = entries().where('entries.seller_id', '=', sellerId).where('entries.visible_to_seller', '=', true);
      if (q.from) qb = qb.where('entries.at', '>=', q.from);
      if (q.to) qb = qb.where('entries.at', '<', q.to);
      if (q.targetType) qb = qb.where('entries.target_type', '=', q.targetType);
      return pageOfRows(qb, page);
    },

    async entriesBySeq(q, afterSeq, limit, maxSeq) {
      let qb = applyFilters(entries(), q);
      if (afterSeq !== null) qb = qb.where('entries.seq', '>', afterSeq);
      if (maxSeq !== undefined) qb = qb.where('entries.seq', '<=', maxSeq);
      const rows = await qb.orderBy('entries.seq', 'asc').limit(limit).execute();
      return withRelated(rows as EntryDbRow[]);
    },

    async entryBySeq(seq) {
      const r = await entries().where('entries.seq', '=', seq).executeTakeFirst();
      return r ? (await withRelated([r as EntryDbRow]))[0]! : null;
    },

    async maxSeq() {
      const r = await db.selectFrom('entries').select(sql<number | null>`max(seq)`.as('m')).executeTakeFirst();
      return r?.m === null || r?.m === undefined ? null : Number(r.m);
    },

    async summary(from, to) {
      const r = await sql<Omit<SummaryCounts, 'byActor'>>`
        select count(*)::int as total,
          count(*) filter (where e.approval_request_id is not null and not exists (
            select 1 from audit.approval_states s where s.approval_request_id = e.approval_request_id and s.state not in ('pending', 'partially_approved')))::int as "pendingSecondReview",
          count(*) filter (where e.category = 'financial')::int as financial,
          count(*) filter (where e.category = 'seller_enforcement')::int as "sellerEnforcement",
          count(*) filter (where e.category = 'settings')::int as settings
        from audit.entries e where e.at >= ${from} and e.at < ${to}`.execute(db);
      const byActor = await sql<{ name: string; n: number }>`
        select coalesce(e.actor_name, e.actor_id, 'Unknown staff') as name, count(*)::int as n
        from audit.entries e where e.actor_kind = 'staff' and e.at >= ${from} and e.at < ${to}
        group by 1 order by 2 desc, 1 asc limit 10`.execute(db);
      const c = r.rows[0]!;
      return { total: c.total, pendingSecondReview: c.pendingSecondReview, financial: c.financial, sellerEnforcement: c.sellerEnforcement, settings: c.settings, byActor: byActor.rows };
    },

    async oldestEntryAt() {
      const r = await db.selectFrom('entries').select(sql<Date | null>`min(at)`.as('m')).executeTakeFirst();
      return r?.m ? new Date(r.m) : null;
    },

    async latestEntryFor(approvalRequestId, action) {
      const r = await entries().where('entries.approval_request_id', '=', approvalRequestId).where('entries.action', '=', action).orderBy('entries.seq', 'desc').limit(1).executeTakeFirst();
      return r ? (await withRelated([r as EntryDbRow]))[0]! : null;
    },

    async purgeCheckpoints() {
      const rows = await db.selectFrom('entries').select(['after']).where('action', '=', PURGE_ACTION).where('module', '=', 'audit').orderBy('seq', 'asc').execute();
      return rows.flatMap((r) => {
        const cp = (r.after as { checkpoint?: { seq?: unknown; hash?: unknown } } | null)?.checkpoint;
        return cp && typeof cp.seq === 'number' && typeof cp.hash === 'string' ? [{ seq: cp.seq, hash: cp.hash }] : [];
      });
    },

    /* ---------------------------------------------------------------- approval projection */

    async approvalStates(ids) {
      const out = new Map<string, ApprovalProjection>();
      const unique = [...new Set(ids)];
      if (!unique.length) return out;
      const rows = await db.selectFrom('approval_states').selectAll().where('approval_request_id', 'in', unique).execute();
      for (const r of rows) out.set(r.approval_request_id, toProjection(r));
      return out;
    },

    async getApprovalState(id, opts) {
      let q = db.selectFrom('approval_states').selectAll().where('approval_request_id', '=', id);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toProjection(r) : null;
    },

    async saveApprovalState(p) {
      const values = {
        approval_request_id: p.approvalRequestId,
        state: p.state,
        approvers: JSON.stringify(p.approvers),
        steps: JSON.stringify(p.steps),
        awaiting: p.awaiting,
        decided_at: p.decidedAt,
        updated_at: p.updatedAt,
      };
      const { approval_request_id: _id, ...update } = values;
      await db
        .insertInto('approval_states')
        .values(values)
        .onConflict((oc) => oc.column('approval_request_id').doUpdateSet(update))
        .execute();
    },

    /* ---------------------------------------------------------------- retention */

    async retention(defaultYears, opts) {
      await db.insertInto('retention').values({ id: 1, retain_years: defaultYears }).onConflict((oc) => oc.column('id').doNothing()).execute();
      let q = db.selectFrom('retention').selectAll().where('id', '=', 1);
      if (opts?.forUpdate) q = q.forUpdate();
      return toRetention((await q.executeTakeFirstOrThrow()) as AuditDb['retention']);
    },

    async updateRetention(patch) {
      const set: Partial<AuditDb['retention']> = {};
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
      const r = await db.updateTable('retention').set(set).where('id', '=', 1).returningAll().executeTakeFirstOrThrow();
      return toRetention(r as AuditDb['retention']);
    },

    async firstSeqAtOrAfter(cutoff) {
      const r = await db.selectFrom('entries').select(sql<number | null>`min(seq)`.as('m')).where('at', '>=', cutoff).executeTakeFirst();
      return r?.m === null || r?.m === undefined ? null : Number(r.m);
    },

    async purgeEntries(beforeSeq) {
      await sql`select set_config('audit.purging', 'on', true)`.execute(db);
      let lastQ = db.selectFrom('entries').select(['seq', 'hash', 'at']).orderBy('seq', 'desc').limit(1);
      if (beforeSeq !== null) lastQ = lastQ.where('seq', '<', beforeSeq);
      const last = await lastQ.executeTakeFirst();
      if (!last) return { removed: 0, last: null };
      let doomed = db.selectFrom('entries').select('id');
      if (beforeSeq !== null) doomed = doomed.where('seq', '<', beforeSeq);
      await db.deleteFrom('entry_targets').where('entry_id', 'in', doomed).execute();
      let del = db.deleteFrom('entries');
      if (beforeSeq !== null) del = del.where('seq', '<', beforeSeq);
      const res = await del.executeTakeFirst();
      await sql`select set_config('audit.purging', 'off', true)`.execute(db);
      return { removed: Number(res.numDeletedRows), last: { seq: Number(last.seq), hash: bytes(last.hash), at: last.at } };
    },

    /* ---------------------------------------------------------------- integrity checks */

    async lastIntegrityCheck() {
      const r = await db.selectFrom('integrity_checks').selectAll().orderBy('started_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
      return r ? toCheck(r) : null;
    },

    async lastOkIntegrityCheck() {
      const r = await db.selectFrom('integrity_checks').selectAll().where('ok', '=', true).orderBy('started_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
      return r ? toCheck(r) : null;
    },

    async saveIntegrityCheck(c) {
      const values = { id: c.id, started_at: c.startedAt, finished_at: c.finishedAt, from_seq: c.fromSeq, to_seq: c.toSeq, ok: c.ok, broken_at_seq: c.brokenAtSeq };
      const { id: _id, ...update } = values;
      await db
        .insertInto('integrity_checks')
        .values(values)
        .onConflict((oc) => oc.column('id').doUpdateSet(update))
        .execute();
    },
  };
  return repo;
}
