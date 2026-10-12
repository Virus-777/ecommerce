import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter, Sort, Table as MongoTable } from '../../../../kernel/mongo/table.js';
import type { Recs, ReportFilter, ReportRec, Table, TrustRepository } from '../../ports.js';

const ACTIVE = ['open', 'under_review', 'escalated'];
/** status <> 'merged' (SQL skips nulls) */
const NOT_MERGED = { $nin: ['merged', null] };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

/** A column condition (ports Cond) as a MongoDB condition, with SQL's meaning (`<>` and NOT IN skip nulls) */
function cond(v: unknown): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) return { $in: v };
  if (isOp(v)) {
    switch (v.op) {
      case '<':
        return { $lt: v.value };
      case '<=':
        return { $lte: v.value };
      case '>':
        return { $gt: v.value };
      case '>=':
        return { $gte: v.value };
      case '<>':
        return { $nin: [v.value, null] };
      case 'is not':
        return { $ne: v.value };
      case 'not in':
        // an empty list leaves the column unfiltered (as before)
        return Array.isArray(v.value) && v.value.length ? { $nin: [...v.value, null] } : undefined;
      default:
        throw new Error(`trust: unknown operator ${v.op}`);
    }
  }
  return v;
}

function where(w: Record<string, unknown>): Filter {
  const out: Filter = {};
  for (const [k, v] of Object.entries(w)) {
    if (v === undefined) continue;
    const c = cond(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

const sortOf = (orderBy: [string, 'asc' | 'desc'][] | undefined): Sort | undefined =>
  orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) : undefined;

const defined = (patch: Record<string, unknown>) => Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));

/** The unique key insertIgnore skips on (on conflict do nothing); default the primary key */
const UNIQUE: Partial<Record<Table, string[]>> = {
  report_subjects: ['report_id', 'subject_type', 'subject_id'],
};

/** MongoDB adapter for TrustRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoTrustRepository(store: ModuleStore): TrustRepository {
  const t = <T extends Table>(name: T) => store.table<Recs[T]>(name) as MongoTable<Recs[T]>;
  const reports = t('reports');
  const subjects = t('report_subjects');

  /** The admin-queue filter as pipeline stages on reports (subject conditions through a $lookup of report_subjects) */
  function reportStages(f: ReportFilter): object[] {
    const and: Filter[] = [];
    if (f.statuses) and.push({ status: { $in: f.statuses } });
    if (f.ids) and.push({ id: { $in: f.ids } });
    if (f.type) and.push({ type: f.type });
    if (f.source) and.push({ source: f.source });
    if (f.assigneeId) and.push({ assignee_staff_id: f.assigneeId });
    if (f.minScore !== undefined) and.push({ risk_score: { $gte: f.minScore } });
    if (f.maxScore !== undefined) and.push({ risk_score: { $lt: f.maxScore } });
    if (f.reporter) and.push(f.reporter.ids.length ? { reporter_kind: f.reporter.kind, reporter_id: { $in: f.reporter.ids } } : { id: { $in: [] } });
    if (f.about && !f.about.types.length) and.push({ id: { $in: [] } });
    const stages: object[] = [{ $match: reports.filter(and.length ? { $and: and } : {}) }];

    const onSubjects: Filter[] = [];
    if (f.subjectType || f.subjectId) onSubjects.push({ _s: { $elemMatch: { ...(f.subjectType ? { subject_type: f.subjectType } : {}), ...(f.subjectId ? { subject_id: f.subjectId } : {}) } } });
    if (f.about?.types.length) onSubjects.push({ _s: { $elemMatch: { subject_type: { $in: f.about.types }, subject_id: f.about.id } } });
    if (f.q?.trim()) {
      const term = { $regex: escapeRegExp(f.q.trim()), $options: 'i' };
      onSubjects.push({ $or: [{ ref: term }, { title: term }, { _s: { $elemMatch: { $or: [{ label: term }, { ref: term }] } } }] });
    }
    if (onSubjects.length) {
      stages.push(
        { $lookup: { from: 'trust.report_subjects', localField: '_id', foreignField: 'report_id', pipeline: [{ $project: { subject_type: 1, subject_id: 1, label: 1, ref: 1 } }], as: '_s' } },
        { $match: { $and: onSubjects } },
        { $project: { _s: 0 } },
      );
    }
    return stages;
  }

  const repo: TrustRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoTrustRepository(tx))),
    claim: (key) => store.claim(key),

    get: (table, id, o) => t(table).get(id, o),
    find: (table, w, o) =>
      t(table).find(where(w as Record<string, unknown>), { sort: sortOf(o?.orderBy as [string, 'asc' | 'desc'][]), limit: o?.limit, skip: o?.offset, forUpdate: o?.forUpdate }),
    count: (table, w) => t(table).count(where(w as Record<string, unknown>)),
    insert: (table, row) => t(table).insert(defined(row as Record<string, unknown>)),
    insertIgnore: (table, rows) => t(table).insertManyIfAbsent(rows.map((r) => defined(r as Record<string, unknown>)), UNIQUE[table]),
    async update(table, id, patch) {
      const values = defined(patch as Record<string, unknown>);
      const row = Object.keys(values).length ? await t(table).update(id, values) : await t(table).get(id);
      if (!row) throw new Error(`trust: ${table} ${id} not found`);
      return row;
    },
    async updateWhere(table, w, patch) {
      const values = defined(patch as Record<string, unknown>);
      if (!Object.keys(values).length) return 0;
      return t(table).updateMany(where(w as Record<string, unknown>), values);
    },

    async listReports(f, page) {
      let sort: Record<string, 1 | -1>;
      const extra: object[] = [];
      switch (f.sort ?? 'risk') {
        case 'newest':
          sort = { created_at: -1, _id: -1 };
          break;
        case 'oldest':
          sort = { created_at: 1, _id: 1 };
          break;
        case 'deadline':
          // due_at asc nulls last (MongoDB sorts nulls first)
          extra.push({ $addFields: { _due_null: { $cond: [{ $eq: [{ $ifNull: ['$due_at', null] }, null] }, 1, 0] } } });
          sort = { _due_null: 1, due_at: 1, risk_score: -1, _id: 1 };
          break;
        default:
          sort = { risk_score: -1, created_at: -1, _id: -1 };
      }
      const docs = await reports.aggregate<Record<string, unknown>>([...reportStages(f), ...extra, { $sort: sort }, { $skip: page.offset }, { $limit: page.limit }, { $project: { _due_null: 0 } }]);
      return { items: docs.map((d) => reports.fromDoc(d) as ReportRec), total: await repo.countReports(f) };
    },
    async countReports(f) {
      const [r] = await reports.aggregate<{ n: number }>([...reportStages(f), { $count: 'n' }]);
      return r?.n ?? 0;
    },
    async subjectIdsAbout(type, o) {
      const rows = await subjects.aggregate<{ _id: string }>([
        { $match: { subject_type: type, ...(o.ids ? { subject_id: { $in: o.ids } } : {}) } },
        {
          $lookup: {
            from: 'trust.reports',
            localField: 'report_id',
            foreignField: '_id',
            pipeline: [{ $match: { $and: [{ status: NOT_MERGED }, ...(o.statuses ? [{ status: { $in: o.statuses } }] : [])] } }, { $project: { _id: 1 } }],
            as: '_r',
          },
        },
        { $match: { '_r.0': { $exists: true } } },
        { $group: { _id: '$subject_id' } },
      ]);
      return rows.map((r) => r._id);
    },
    reporterIdsFiling: (kind, o) =>
      reports.distinct<string>('reporter_id', {
        reporter_kind: kind,
        $and: [{ reporter_id: { $ne: null } }, ...(o.ids ? [{ reporter_id: { $in: o.ids } }] : []), { status: NOT_MERGED }, ...(o.statuses ? [{ status: { $in: o.statuses } }] : [])],
      }),
    async reportIdsAbout(types, id) {
      if (!types.length) return [];
      return subjects.distinct<string>('report_id', { subject_type: { $in: types }, subject_id: id });
    },
    async enforcementIdsFor(targets) {
      if (!targets.length) return [];
      return t('enforcement_targets').distinct<string>('enforcement_id', { $or: targets.map((x) => ({ target_type: x.type, target_id: x.id })) });
    },
    eventsByKey: (key) => t('report_events').find({ 'detail.key': key }),
    eventsFor: (field, value, kinds) => t('report_events').find({ [`detail.${field}`]: value, ...(kinds.length ? { kind: { $in: kinds } } : {}) }, { sort: { at: 1 } }),
    async signalsAbout(about, since) {
      if (!about.length) return 0;
      return t('risk_signals').count({ at: { $gte: since }, $or: about.map((s) => ({ subject_type: s.type, subject_id: s.id })) });
    },
    async overview(highFrom) {
      const rows = await reports.aggregate<{ _id: string; n: number; high: number }>([
        { $match: { status: { $in: ACTIVE } } },
        { $group: { _id: '$type', n: { $sum: 1 }, high: { $sum: { $cond: [{ $gte: ['$risk_score', highFrom] }, 1, 0] } } } },
      ]);
      const suspicious = await reports.distinct<string>('id', { status: { $in: ACTIVE }, type: 'suspicious_orders' });
      const orders = suspicious.length ? await subjects.distinct<string>('subject_id', { report_id: { $in: suspicious }, subject_type: 'order' }) : [];
      const byType: Record<string, number> = {};
      const highByType: Record<string, number> = {};
      for (const r of rows) {
        byType[r._id] = r.n;
        highByType[r._id] = r.high;
      }
      return { open: rows.reduce((n, r) => n + r.n, 0), highRisk: rows.reduce((n, r) => n + r.high, 0), byType, highByType, ordersInSuspicious: orders.length };
    },
  };
  return repo;
}
