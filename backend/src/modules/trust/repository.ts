import { orThrow } from '../../kernel/lib/or-throw.js';
import { contains, whereFilter, type Filter, type ModuleStore, type Table, type Where } from '../../kernel/mongo/index.js';
import type { EventRec, Recs, ReportFilter, ReportRec, SubjectRec, TableName } from './ports.js';

/** Sort, paging and lock options of the generic find */
export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  offset?: number;
  forUpdate?: boolean;
}

const ACTIVE = ['open', 'under_review', 'escalated'];
/** status <> 'merged' (SQL skips nulls) */
const NOT_MERGED = { $nin: ['merged', null] };

const defined = (patch: Record<string, unknown>) => Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));

/** The unique key insertManyIfAbsent skips on (on conflict do nothing); default every unique key of the table */
const UNIQUE: Partial<Record<TableName, string[]>> = {
  report_subjects: ['report_id', 'subject_type', 'subject_id'],
};

/**
 * trust.reports, report_subjects, evidence, evidence_requests, recommendations, enforcements, enforcement_targets,
 * appeals, report_notes, report_events, detection_rules and risk_signals (MongoDB, docs/04-mongodb-migration.md).
 */
export class TrustRepository {
  readonly #reports: Table<ReportRec>;
  readonly #subjects: Table<SubjectRec>;

  constructor(
    private readonly store: ModuleStore,
    /** Bound to a transaction: its session takes one operation at a time, so reads never run together */
    readonly inTransaction = false,
  ) {
    this.#reports = this.#t('reports');
    this.#subjects = this.#t('report_subjects');
  }

  #t<T extends TableName>(name: T): Table<Recs[T]> {
    return this.store.table<Recs[T]>(name);
  }

  /** Runs fn in one transaction (nested calls join the outer one) */
  transaction<T>(fn: (tx: TrustRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new TrustRepository(tx, true)));
  }

  /** Independent reads: together outside a transaction, one after another inside one */
  async reads<T extends unknown[]>(...fns: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> {
    if (!this.inTransaction) return (await Promise.all(fns.map((f) => f()))) as T;
    const out: unknown[] = [];
    for (const f of fns) out.push(await f());
    return out as T;
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- generic table access */

  get<T extends TableName>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined> {
    return this.#t(table).get(id, o);
  }

  find<T extends TableName>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]> {
    const sort = o?.orderBy?.length ? Object.fromEntries(o.orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1] as const)) : undefined;
    return this.#t(table).find(whereFilter(where), { sort, limit: o?.limit, skip: o?.offset, forUpdate: o?.forUpdate });
  }

  count<T extends TableName>(table: T, where: Where<Recs[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(where));
  }

  insert<T extends TableName>(table: T, row: Recs[T]): Promise<Recs[T]> {
    return this.#t(table).insert(defined(row as Record<string, unknown>));
  }

  /** Inserts rows, skipping those that hit a unique key (on conflict do nothing); how many were inserted */
  insertManyIfAbsent<T extends TableName>(table: T, rows: Recs[T][]): Promise<number> {
    return this.#t(table).insertManyIfAbsent(
      rows.map((r) => defined(r as Record<string, unknown>)),
      UNIQUE[table],
    );
  }

  /** Sets the defined fields of patch; the row after (an empty patch reads it) */
  async update<T extends TableName>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]> {
    const values = defined(patch as Record<string, unknown>);
    const row = Object.keys(values).length ? await this.#t(table).update(id, values) : await this.#t(table).get(id);
    return orThrow(row, `trust: ${table} ${id}`);
  }

  async updateWhere<T extends TableName>(table: T, where: Where<Recs[T]>, patch: Partial<Recs[T]>): Promise<number> {
    const values = defined(patch as Record<string, unknown>);
    if (!Object.keys(values).length) return 0;
    return this.#t(table).updateMany(whereFilter(where), values);
  }

  /* ---------------------------------------------------------------- queue and lookups */

  /** Admin queue: offset paging over the filtered reports */
  async listReports(f: ReportFilter, page: { offset: number; limit: number }): Promise<{ items: ReportRec[]; total: number }> {
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
        // due_at asc nulls last, by hand: the filter is an aggregation (subject lookups), which find's nullsLast does not take
        extra.push({ $addFields: { _due_null: { $cond: [{ $eq: [{ $ifNull: ['$due_at', null] }, null] }, 1, 0] } } });
        sort = { _due_null: 1, due_at: 1, risk_score: -1, _id: 1 };
        break;
      default:
        sort = { risk_score: -1, created_at: -1, _id: -1 };
    }
    const docs = await this.#reports.aggregate<Record<string, unknown>>([...this.#reportStages(f), ...extra, { $sort: sort }, { $skip: page.offset }, { $limit: page.limit }, { $project: { _due_null: 0 } }]);
    return { items: docs.map((d) => this.#reports.fromDoc(d)), total: await this.countReports(f) };
  }

  async countReports(f: ReportFilter): Promise<number> {
    const [r] = await this.#reports.aggregate<{ n: number }>([...this.#reportStages(f), { $count: 'n' }]);
    return r?.n ?? 0;
  }

  /** Distinct subject ids of a type named by reports (not merged), optionally only in these statuses / among these ids */
  async subjectIdsAbout(type: string, o: { statuses?: string[]; ids?: string[] }): Promise<string[]> {
    const rows = await this.#subjects.aggregate<{ _id: string }>([
      { $match: { subject_type: type, ...(o.ids ? { subject_id: { $in: o.ids } } : {}) } },
      {
        $lookup: {
          from: this.#reports.name,
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
  }

  /** Distinct reporter ids of a kind with reports filed (not merged), optionally only in these statuses / among these ids */
  reporterIdsFiling(kind: string, o: { statuses?: string[]; ids?: string[] }): Promise<string[]> {
    return this.#reports.distinct<string>('reporter_id', {
      reporter_kind: kind,
      $and: [{ reporter_id: { $ne: null } }, ...(o.ids ? [{ reporter_id: { $in: o.ids } }] : []), { status: NOT_MERGED }, ...(o.statuses ? [{ status: { $in: o.statuses } }] : [])],
    });
  }

  /** Report ids that name any of the subjects */
  async reportIdsAbout(types: string[], id: string): Promise<string[]> {
    if (!types.length) return [];
    return this.#subjects.distinct<string>('report_id', { subject_type: { $in: types }, subject_id: id });
  }

  /** Enforcement ids recorded against any of these targets (lookup table) */
  async enforcementIdsFor(targets: { type: string; id: string }[]): Promise<string[]> {
    if (!targets.length) return [];
    return this.#t('enforcement_targets').distinct<string>('enforcement_id', { $or: targets.map((x) => ({ target_type: x.type, target_id: x.id })) });
  }

  /** Timeline entries with detail.key = key (consumer idempotency) */
  eventsByKey(key: string): Promise<EventRec[]> {
    return this.#t('report_events').find({ 'detail.key': key });
  }

  /** Timeline entries of these kinds whose detail names the record (recommendation, enforcement, appeal) */
  eventsFor(field: string, value: string, kinds: string[]): Promise<EventRec[]> {
    return this.#t('report_events').find({ [`detail.${field}`]: value, ...(kinds.length ? { kind: { $in: kinds } } : {}) }, { sort: { at: 1 } });
  }

  /** Raw signals about any of the subjects since a time */
  async signalsAbout(subjects: { type: string; id: string }[], since: Date): Promise<number> {
    if (!subjects.length) return 0;
    return this.#t('risk_signals').count({ at: { $gte: since }, $or: subjects.map((s) => ({ subject_type: s.type, subject_id: s.id })) });
  }

  /** Open reports by type, high-risk count, and the counts behind the overview */
  async overview(highFrom: number): Promise<{ open: number; highRisk: number; byType: Record<string, number>; highByType: Record<string, number>; ordersInSuspicious: number }> {
    const rows = await this.#reports.aggregate<{ _id: string; n: number; high: number }>([
      { $match: { status: { $in: ACTIVE } } },
      { $group: { _id: '$type', n: { $sum: 1 }, high: { $sum: { $cond: [{ $gte: ['$risk_score', highFrom] }, 1, 0] } } } },
    ]);
    const suspicious = await this.#reports.distinct<string>('id', { status: { $in: ACTIVE }, type: 'suspicious_orders' });
    const orders = suspicious.length ? await this.#subjects.distinct<string>('subject_id', { report_id: { $in: suspicious }, subject_type: 'order' }) : [];
    const byType: Record<string, number> = {};
    const highByType: Record<string, number> = {};
    for (const r of rows) {
      byType[r._id] = r.n;
      highByType[r._id] = r.high;
    }
    return { open: rows.reduce((n, r) => n + r.n, 0), highRisk: rows.reduce((n, r) => n + r.high, 0), byType, highByType, ordersInSuspicious: orders.length };
  }

  /** The admin-queue filter as pipeline stages on reports (subject conditions through a $lookup of report_subjects) */
  #reportStages(f: ReportFilter): object[] {
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
    const stages: object[] = [{ $match: this.#reports.filter(and.length ? { $and: and } : {}) }];

    const onSubjects: Filter[] = [];
    if (f.subjectType || f.subjectId) onSubjects.push({ _s: { $elemMatch: { ...(f.subjectType ? { subject_type: f.subjectType } : {}), ...(f.subjectId ? { subject_id: f.subjectId } : {}) } } });
    if (f.about?.types.length) onSubjects.push({ _s: { $elemMatch: { subject_type: { $in: f.about.types }, subject_id: f.about.id } } });
    if (f.q?.trim()) {
      const term = contains(f.q);
      onSubjects.push({ $or: [{ ref: term }, { title: term }, { _s: { $elemMatch: { $or: [{ label: term }, { ref: term }] } } }] });
    }
    if (onSubjects.length) {
      stages.push(
        { $lookup: { from: this.#subjects.name, localField: '_id', foreignField: 'report_id', pipeline: [{ $project: { subject_type: 1, subject_id: 1, label: 1, ref: 1 } }], as: '_s' } },
        { $match: { $and: onSubjects } },
        { $project: { _s: 0 } },
      );
    }
    return stages;
  }
}
