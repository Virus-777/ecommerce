import { sql, type Kysely } from 'kysely';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import type { TrustDb } from '../../../../spec/trust.js';
import type { ReportFilter, Table, TrustRepository } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<Table, readonly string[]> = {
  reports: ['risk_factors', 'risk_override', 'resolution', 'assessment'],
  report_subjects: [],
  evidence: ['media_ids'],
  evidence_requests: ['answer_media_ids'],
  recommendations: ['targets', 'params'],
  enforcements: ['targets', 'params', 'effects'],
  enforcement_targets: [],
  appeals: ['evidence_media_ids', 'decision'],
  report_notes: [],
  report_events: ['detail'],
  detection_rules: ['thresholds'],
  risk_signals: ['features'],
};

const KEY: Partial<Record<Table, string>> = { detection_rules: 'key' };
const keyOf = (t: Table) => KEY[t] ?? 'id';
const ACTIVE = ['open', 'under_review', 'escalated'];

function encode(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols.includes(k) ? (v === null ? null : JSON.stringify(v)) : v;
  }
  return out;
}

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

function applyWhere(q: any, where: Record<string, unknown>): any {
  for (const [col, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) q = q.where(col, 'is', null);
    else if (Array.isArray(v)) q = v.length ? q.where(col, 'in', v) : q.where(sql<boolean>`false`);
    else if (isOp(v)) {
      if (v.op === 'not in') q = Array.isArray(v.value) && v.value.length ? q.where(col, 'not in', v.value) : q;
      else q = q.where(col, v.op, v.value);
    } else q = q.where(col, '=', v);
  }
  return q;
}

const like = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`));

function reportQuery(d: any, f: ReportFilter): any {
  let q = d.selectFrom('reports');
  if (f.statuses) q = f.statuses.length ? q.where('status', 'in', f.statuses) : q.where(sql<boolean>`false`);
  if (f.ids) q = f.ids.length ? q.where('id', 'in', f.ids) : q.where(sql<boolean>`false`);
  if (f.type) q = q.where('type', '=', f.type);
  if (f.source) q = q.where('source', '=', f.source);
  if (f.assigneeId) q = q.where('assignee_staff_id', '=', f.assigneeId);
  if (f.minScore !== undefined) q = q.where('risk_score', '>=', f.minScore);
  if (f.maxScore !== undefined) q = q.where('risk_score', '<', f.maxScore);
  if (f.reporter) q = f.reporter.ids.length ? q.where('reporter_kind', '=', f.reporter.kind).where('reporter_id', 'in', f.reporter.ids) : q.where(sql<boolean>`false`);
  if (f.subjectType || f.subjectId) {
    const t = f.subjectType ?? null;
    const id = f.subjectId ?? null;
    q = q.where(
      sql<boolean>`exists (select 1 from trust.report_subjects s where s.report_id = reports.id ${t ? sql`and s.subject_type = ${t}` : sql``} ${id ? sql`and s.subject_id = ${id}` : sql``})`,
    );
  }
  if (f.about) {
    q = f.about.types.length
      ? q.where(sql<boolean>`exists (select 1 from trust.report_subjects s where s.report_id = reports.id and s.subject_type in (${list(f.about.types)}) and s.subject_id = ${f.about.id})`)
      : q.where(sql<boolean>`false`);
  }
  if (f.q?.trim()) {
    const term = like(f.q);
    q = q.where(sql<boolean>`(lower(ref) like ${term} or lower(title) like ${term} or exists (select 1 from trust.report_subjects s where s.report_id = reports.id and (lower(s.label) like ${term} or lower(coalesce(s.ref, '')) like ${term})))`);
  }
  return q;
}

/** Postgres adapter for TrustRepository. `db` is scoped to the `trust` schema. */
export function createPostgresTrustRepository(db: Kysely<TrustDb>, inbox: Inbox): TrustRepository {
  // generic table access: the row types are checked at the TrustRepository boundary
  const d: any = db;

  const repo: TrustRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresTrustRepository(trx, inbox)));
    },
    claim(key) {
      return inbox.claim(db, key);
    },

    async get(table, id, o) {
      let q = d.selectFrom(table).selectAll().where(keyOf(table), '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async find(table, where, o) {
      let q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      for (const [c, dir] of o?.orderBy ?? []) q = q.orderBy(c, dir);
      if (o?.limit) q = q.limit(o.limit);
      if (o?.offset) q = q.offset(o.offset);
      if (o?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async count(table, where) {
      const r = await applyWhere(d.selectFrom(table).select(sql<number>`count(*)::int`.as('n')), where as Record<string, unknown>).executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
    async insert(table, row) {
      return d.insertInto(table).values(encode(table, row as Record<string, unknown>)).returningAll().executeTakeFirstOrThrow();
    },
    async insertIgnore(table, rows) {
      if (!rows.length) return 0;
      const r = await d
        .insertInto(table)
        .values(rows.map((x) => encode(table, x as Record<string, unknown>)))
        .onConflict((oc: any) => oc.doNothing())
        .executeTakeFirst();
      return Number(r?.numInsertedOrUpdatedRows ?? 0);
    },
    async update(table, id, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return (await repo.get(table, id))!;
      return d.updateTable(table).set(values).where(keyOf(table), '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async updateWhere(table, where, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return 0;
      const r = await applyWhere(d.updateTable(table).set(values), where as Record<string, unknown>).executeTakeFirst();
      return Number(r?.numUpdatedRows ?? 0);
    },

    async listReports(f, page) {
      const base = reportQuery(d, f);
      let q = base.selectAll();
      switch (f.sort ?? 'risk') {
        case 'newest':
          q = q.orderBy('created_at', 'desc').orderBy('id', 'desc');
          break;
        case 'oldest':
          q = q.orderBy('created_at', 'asc').orderBy('id', 'asc');
          break;
        case 'deadline':
          q = q.orderBy(sql`due_at asc nulls last`).orderBy('risk_score', 'desc').orderBy('id', 'asc');
          break;
        default:
          q = q.orderBy('risk_score', 'desc').orderBy('created_at', 'desc').orderBy('id', 'desc');
      }
      const [items, total] = await Promise.all([q.limit(page.limit).offset(page.offset).execute(), repo.countReports(f)]);
      return { items, total };
    },
    async countReports(f) {
      const r = await reportQuery(d, f).select(sql<number>`count(*)::int`.as('n')).executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
    async subjectIdsAbout(type, o) {
      let q = d
        .selectFrom('report_subjects as s')
        .innerJoin('reports as r', 'r.id', 's.report_id')
        .select('s.subject_id as id')
        .distinct()
        .where('s.subject_type', '=', type)
        .where('r.status', '<>', 'merged');
      if (o.statuses) q = q.where('r.status', 'in', o.statuses);
      if (o.ids) q = q.where('s.subject_id', 'in', o.ids);
      return (await q.execute()).map((r: { id: string }) => r.id);
    },
    async reporterIdsFiling(kind, o) {
      let q = d.selectFrom('reports').select('reporter_id as id').distinct().where('reporter_kind', '=', kind).where('reporter_id', 'is not', null).where('status', '<>', 'merged');
      if (o.statuses) q = q.where('status', 'in', o.statuses);
      if (o.ids) q = q.where('reporter_id', 'in', o.ids);
      return (await q.execute()).map((r: { id: string }) => r.id);
    },
    async reportIdsAbout(types, id) {
      if (!types.length) return [];
      const rows = await d.selectFrom('report_subjects').select('report_id').where('subject_type', 'in', types).where('subject_id', '=', id).execute();
      return [...new Set<string>(rows.map((r: { report_id: string }) => r.report_id))];
    },
    async enforcementIdsFor(targets) {
      if (!targets.length) return [];
      const rows = await d
        .selectFrom('enforcement_targets')
        .select('enforcement_id')
        .where((eb: any) => eb.or(targets.map((t) => eb.and([eb('target_type', '=', t.type), eb('target_id', '=', t.id)]))))
        .execute();
      return [...new Set<string>(rows.map((r: { enforcement_id: string }) => r.enforcement_id))];
    },
    async eventsByKey(key) {
      return d.selectFrom('report_events').selectAll().where(sql<boolean>`detail->>'key' = ${key}`).execute();
    },
    async eventsFor(field, value, kinds) {
      let q = d.selectFrom('report_events').selectAll().where(sql<boolean>`detail->>${field} = ${value}`);
      if (kinds.length) q = q.where('kind', 'in', kinds);
      return q.orderBy('at', 'asc').execute();
    },
    async signalsAbout(subjects, since) {
      if (!subjects.length) return 0;
      const r = await d
        .selectFrom('risk_signals')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('at', '>=', since)
        .where((eb: any) => eb.or(subjects.map((s) => eb.and([eb('subject_type', '=', s.type), eb('subject_id', '=', s.id)]))))
        .executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
    async overview(highFrom) {
      const rows: { type: string; n: number; high: number }[] = await d
        .selectFrom('reports')
        .select(['type', sql<number>`count(*)::int`.as('n'), sql<number>`count(*) filter (where risk_score >= ${highFrom})::int`.as('high')])
        .where('status', 'in', ACTIVE)
        .groupBy('type')
        .execute();
      const orders = await d
        .selectFrom('report_subjects as s')
        .innerJoin('reports as r', 'r.id', 's.report_id')
        .select(sql<number>`count(distinct s.subject_id)::int`.as('n'))
        .where('r.status', 'in', ACTIVE)
        .where('r.type', '=', 'suspicious_orders')
        .where('s.subject_type', '=', 'order')
        .executeTakeFirst();
      const byType: Record<string, number> = {};
      const highByType: Record<string, number> = {};
      for (const r of rows) {
        byType[r.type] = r.n;
        highByType[r.type] = r.high;
      }
      return { open: rows.reduce((n, r) => n + r.n, 0), highRisk: rows.reduce((n, r) => n + r.high, 0), byType, highByType, ordersInSuspicious: (orders as { n: number } | undefined)?.n ?? 0 };
    },
  };
  return repo;
}
