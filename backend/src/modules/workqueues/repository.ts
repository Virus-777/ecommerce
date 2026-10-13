import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import { isUuid } from '../../kernel/lib/ids.js';
import { decodeCursor, encodeCursor, type PageRequest } from '../../kernel/lib/pagination.js';
import type { Page } from '../../spec/common.js';
import { ACTIVE_STATES, CLOSED_STATES } from './domain/catalog.js';
import type {
  DailyCountRow,
  DayEndReviewRow,
  IntakeRuleRow,
  ItemEventRow,
  ItemNoteRow,
  ItemQuery,
  ItemRow,
  ItemSort,
  OldestRow,
  QueueCountRow,
  QueueRow,
  RoutineCheckRow,
  RoutineTemplateRow,
  SavedFilterRow,
  WorkqueuesRepository,
} from './ports.js';

const ACTIVE = [...ACTIVE_STATES] as string[];
const CLOSED = [...CLOSED_STATES] as string[];
const NOTHING: Filter = { id: { $in: [] } };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** ILIKE '%x%' */
const contains = (x: string) => ({ $regex: escapeRegExp(x), $options: 'i' });

function found<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`workqueues: ${what} not found`);
  return row;
}

/** related_subjects @> [{ type, id }] */
const relatedHas = (type: string, id: string): Filter => ({ related_subjects: { $elemMatch: { type, id } } });

/** The item filter of a query */
function conditions(q: ItemQuery): Filter {
  const c: Filter[] = [];
  const v = q.visibility;
  if (v) {
    const or: Filter[] = [{ assignee_staff_id: v.staffId }, { escalated_to: `staff:${v.staffId}` }];
    if (v.queueKeys.length) or.push({ queue_key: { $in: v.queueKeys } });
    if (v.roles.length) {
      or.push({ owner_role: { $in: v.roles } });
      or.push({ escalated_to: { $in: v.roles.map((r) => `role:${r}`) } });
    }
    c.push({ $or: or });
  }
  if (q.queueKeys) c.push({ queue_key: { $in: q.queueKeys } });
  if (q.kinds?.length) c.push({ kind: { $in: q.kinds } });
  if (q.states?.length) c.push({ state: { $in: q.states } });
  if (q.deadlineStates?.length) {
    // deadline state from due_at (the stored state may lag the sweep by a minute)
    const now = q.now ?? new Date();
    const or: Filter[] = [];
    if (q.deadlineStates.includes('overdue')) or.push({ due_at: { $lte: now } });
    if (q.deadlineStates.includes('due_soon')) or.push({ due_at: { $gt: now }, deadline_state: { $ne: 'on_time' } });
    if (q.deadlineStates.includes('on_time')) or.push({ due_at: { $gt: now }, deadline_state: 'on_time' });
    c.push(or.length ? { $or: or } : NOTHING);
  }
  if (q.overdueOverMinutes !== undefined) c.push({ due_at: { $lt: new Date((q.now ?? new Date()).getTime() - q.overdueOverMinutes * 60_000) } });
  if (q.assignee?.kind === 'unassigned') c.push({ assignee_staff_id: null });
  if (q.assignee?.kind === 'staff') c.push({ assignee_staff_id: q.assignee.id });
  if (q.sellerId) c.push({ seller_id: q.sellerId });
  if (q.sellerKind === 'official') c.push({ seller_id: null });
  if (q.sellerKind === 'marketplace') c.push({ seller_id: { $ne: null } });
  if (q.subjectRef) c.push({ $or: [{ subject_ref: q.subjectRef }, { ref: q.subjectRef }, { 'related_subjects.ref': q.subjectRef }] });
  if (q.visibleToSeller !== undefined) c.push({ visible_to_seller: q.visibleToSeller });
  if (q.archived === true) c.push({ archived_at: { $ne: null } });
  if (q.archived === false) c.push({ archived_at: null });
  if (q.search?.trim()) {
    const x = contains(q.search.trim());
    c.push({ $or: [{ title: x }, { ref: x }, { subject_ref: x }, { subject_label: x }, { seller_name: x }, { summary: x }] });
  }
  return c.length ? { $and: c } : {};
}

/** Computed sort values (priority_rank, amount_sort) */
const PRIORITY_RANK = { $switch: { branches: [{ case: { $eq: ['$priority', 'urgent'] }, then: 3 }, { case: { $eq: ['$priority', 'high'] }, then: 2 }, { case: { $eq: ['$priority', 'normal'] }, then: 1 }], default: 0 } };
const AMOUNT_SORT = { $ifNull: ['$amount_minor', -1] };
const priorityRank = (p: string) => (p === 'urgent' ? 3 : p === 'high' ? 2 : p === 'normal' ? 1 : 0);

/** MongoDB adapter for WorkqueuesRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoWorkqueuesRepository(store: ModuleStore): WorkqueuesRepository {
  const t = {
    queues: store.table<QueueRow>('queues'),
    rules: store.table<IntakeRuleRow>('intake_rules'),
    items: store.table<ItemRow>('items'),
    events: store.table<ItemEventRow>('item_events'),
    notes: store.table<ItemNoteRow>('item_notes'),
    filters: store.table<SavedFilterRow>('saved_filters'),
    reviews: store.table<DayEndReviewRow>('day_end_reviews'),
    templates: store.table<RoutineTemplateRow>('routine_templates'),
    checks: store.table<RoutineCheckRow>('routine_checks'),
    counts: store.table<DailyCountRow>('daily_counts'),
  };

  /** A page of items sorted by a computed value (descending), then id: keyset on (value, id) */
  async function pageByComputed(filter: Filter, req: PageRequest, expr: unknown, valueOf: (row: ItemRow) => number): Promise<Page<ItemRow>> {
    const match = t.items.filter(filter);
    const cursorOf = (row: ItemRow) => encodeCursor([valueOf(row), row.id]);
    const run = async (extra: Record<string, unknown>[]) => {
      const docs = await t.items.aggregate<Record<string, unknown>>([{ $match: match }, { $addFields: { _sort: expr } }, ...extra]);
      return docs.map(({ _sort: _s, ...doc }) => t.items.fromDoc(doc));
    };
    const sort = { $sort: { _sort: -1, _id: -1 } };
    if (req.mode === 'page') {
      const [total, items] = await Promise.all([t.items.count(filter), run([sort, { $skip: (req.page - 1) * req.limit }, { $limit: req.limit }])]);
      const totalPages = Math.max(1, Math.ceil(total / req.limit));
      const last = items.at(-1);
      return { items, nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
    }
    const after: Record<string, unknown>[] = [];
    if (req.cursor) {
      const [v, id] = decodeCursor(req.cursor);
      const n = Number(v);
      after.push({ $match: { $or: [{ _sort: { $lt: n } }, { _sort: n, _id: { $lt: id } }] } });
    }
    const rows = await run([...after, sort, { $limit: req.limit + 1 }]);
    const items = rows.slice(0, req.limit);
    return { items, nextCursor: rows.length > req.limit ? cursorOf(items.at(-1)!) : null };
  }

  const countBy = async <K extends string>(match: Filter, field: string, as: K) =>
    (await t.items.aggregate<{ _id: string; n: number }>([{ $match: t.items.filter(match) }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }])).map(
      (r) => ({ [as]: r._id, n: r.n }) as { [P in K]: string } & { n: number },
    );

  const self: WorkqueuesRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoWorkqueuesRepository(tx))),
    claim: (key) => store.claim(key),

    /* ---------------------------------------------------------------- queues */
    listQueues: () => t.queues.find({}, { sort: { area: 1, name: 1 } }),
    getQueue: async (key, opts) => (await t.queues.get(key, opts)) ?? null,
    insertQueue: async (row) => Boolean(await t.queues.insertIfAbsent(row)),
    updateQueue: async (key, patch) => found(await t.queues.update(key, patch), `queue ${key}`),

    /* ---------------------------------------------------------------- intake rules */
    async upsertIntakeRules(rows) {
      await t.rules.upsertMany(rows, {
        update: (r) => ({
          event: r.event,
          queue_key: r.queue_key,
          kind: r.kind,
          title_template: r.title_template,
          dedupe_key_template: r.dedupe_key_template,
          deadline_rule: r.deadline_rule,
          priority: r.priority,
          resolves_on: r.resolves_on,
          active: r.active,
        }),
      });
    },
    deactivateIntakeRulesExcept: (ids) => t.rules.updateMany({ active: true, ...(ids.length ? { id: { $nin: ids } } : {}) }, { active: false }),
    listIntakeRules: (filter) => t.rules.find(filter?.queueKey ? { queue_key: filter.queueKey } : {}, { sort: { queue_key: 1, event: 1 } }),

    /* ---------------------------------------------------------------- items */
    async getItem(id, opts) {
      if (!isUuid(id)) return null;
      return (await t.items.get(id, opts)) ?? null;
    },
    activeByDedupe: async (dedupeKey, opts) => (await t.items.findOne({ dedupe_key: dedupeKey, state: { $in: ACTIVE } }, opts)) ?? null,
    latestClosedByDedupe: async (dedupeKey) => (await t.items.findOne({ dedupe_key: dedupeKey, state: { $in: CLOSED } }, { sort: { resolved_at: -1, opened_at: -1 } })) ?? null,
    insertItem: (row) => t.items.insert(row),
    updateItem: async (id, patch) => found(await t.items.update(id, patch), `item ${id}`),
    listItems(query, page, sort: ItemSort) {
      const f = conditions(query);
      if (sort === 'priority') return pageByComputed(f, page, PRIORITY_RANK, (r) => priorityRank(r.priority));
      if (sort === 'amount') return pageByComputed(f, page, AMOUNT_SORT, (r) => r.amount_minor ?? -1);
      return t.items.page(f, page, sort === 'oldest' ? { column: 'opened_at', direction: 'asc' } : { column: 'due_at', direction: 'asc' });
    },
    scanItems(query, after, limit) {
      const f = conditions(query);
      const at = after && new Date(after.openedAt);
      return t.items.find(after ? { $and: [f, { $or: [{ opened_at: { $gt: at } }, { opened_at: at, id: { $gt: after.id } }] }] } : f, { sort: { opened_at: 1, id: 1 }, limit });
    },
    countItems: (query) => t.items.count(conditions(query)),
    async activeMatching(kinds, matches) {
      if (!kinds.length || !matches.length) return [];
      return t.items.find(
        { state: { $in: ACTIVE }, kind: { $in: kinds }, $or: matches.flatMap((m) => [{ subject_type: m.type, subject_id: m.id }, relatedHas(m.type, m.id)]) },
        { forUpdate: true },
      );
    },
    itemsAbout(type, id, opts) {
      const or: Filter[] = [{ subject_type: type, subject_id: id }, relatedHas(type, id)];
      if (type === 'seller' && isUuid(id)) or.push({ seller_id: id });
      if (type === 'customer' && isUuid(id)) or.push({ customer_id: id });
      return t.items.find({ $or: or, ...(opts.activeOnly ? { state: { $in: ACTIVE } } : {}) }, { sort: { due_at: 1, id: 1 }, limit: 200 });
    },
    sweepBatch(until, afterDue, limit) {
      const base: Filter = { state: { $in: ACTIVE }, due_at: { $lte: until } };
      const f = afterDue ? { $and: [base, { $or: [{ due_at: { $gt: afterDue.dueAt } }, { due_at: afterDue.dueAt, id: { $gt: afterDue.id } }] }] } : base;
      return t.items.find(f, { sort: { due_at: 1, id: 1 }, limit });
    },
    staleDeadlineStates: (until) => t.items.find({ state: { $in: ACTIVE }, deadline_state: { $ne: 'on_time' }, due_at: { $gt: until } }, { limit: 1000 }),
    async queueCounts(now, dueSoonMinutes) {
      const soon = new Date(now.getTime() + dueSoonMinutes * 60_000);
      const rows = await t.items.aggregate<{ _id: string; open: number; overdue: number; due_soon: number }>([
        { $match: t.items.filter({ state: { $in: ACTIVE } }) },
        {
          $group: {
            _id: '$queue_key',
            open: { $sum: 1 },
            overdue: { $sum: { $cond: [{ $lte: ['$due_at', now] }, 1, 0] } },
            due_soon: { $sum: { $cond: [{ $and: [{ $gt: ['$due_at', now] }, { $lte: ['$due_at', soon] }] }, 1, 0] } },
          },
        },
      ]);
      return rows.map((r): QueueCountRow => ({ queue_key: r._id, open: r.open, overdue: r.overdue, due_soon: r.due_soon }));
    },
    async oldestOpen() {
      const rows = await t.items.aggregate<{ _id: string; first: { _id: string; ref: string; subject_ref?: string | null; opened_at: Date } }>([
        { $match: t.items.filter({ state: { $in: ACTIVE } }) },
        { $sort: { queue_key: 1, opened_at: 1, _id: 1 } },
        { $group: { _id: '$queue_key', first: { $first: { _id: '$_id', ref: '$ref', subject_ref: '$subject_ref', opened_at: '$opened_at' } } } },
        { $sort: { _id: 1 } },
      ]);
      return rows.map((r): OldestRow => ({ queue_key: r._id, id: r.first._id, ref: r.first.ref, subject_ref: r.first.subject_ref ?? null, opened_at: r.first.opened_at }));
    },
    assignedCounts: (staffId) => countBy({ state: { $in: ACTIVE }, assignee_staff_id: staffId }, 'queue_key', 'queue_key'),
    async sellerTaskCounts(sellerId) {
      if (!isUuid(sellerId)) return [];
      return countBy({ state: { $in: ACTIVE }, visible_to_seller: true, seller_id: sellerId }, 'kind', 'kind');
    },
    openedBetween: (from, to) => countBy({ opened_at: { $gte: from, $lt: to } }, 'queue_key', 'queue_key'),
    async resolvedBetween(from, to) {
      const rows = await t.items.find({ state: 'resolved', resolved_at: { $gte: from, $lt: to } });
      return rows.map((r) => ({ queue_key: r.queue_key, opened_at: r.opened_at, resolved_at: r.resolved_at! }));
    },
    async archiveClosedBefore(before, at, limit) {
      const open: Filter = { state: { $in: CLOSED }, archived_at: null, resolved_at: { $lt: before } };
      const ids = (await t.items.find(open, { sort: { resolved_at: 1, id: 1 }, limit })).map((r) => r.id);
      if (!ids.length) return 0;
      return t.items.updateMany({ ...open, id: { $in: ids } }, { archived_at: at });
    },

    /* ---------------------------------------------------------------- history and notes */
    async insertEvent(row) {
      await t.events.insert(row);
    },
    eventsOf: (itemId) => t.events.find({ item_id: itemId }, { sort: { at: 1, id: 1 } }),
    eventsOfItems: async (itemIds) => (itemIds.length ? t.events.find({ item_id: { $in: itemIds } }, { sort: { at: 1, id: 1 } }) : []),
    hasEvent: (itemId, kind) => t.events.exists({ item_id: itemId, kind }),
    async insertNote(row) {
      await t.notes.insert(row);
    },
    notesOf: (itemId) => t.notes.find({ item_id: itemId }, { sort: { at: 1, id: 1 } }),
    notesOfItems: async (itemIds) => (itemIds.length ? t.notes.find({ item_id: { $in: itemIds } }, { sort: { at: 1, id: 1 } }) : []),

    /* ---------------------------------------------------------------- saved filters */
    async getSavedFilter(id) {
      if (!isUuid(id)) return null;
      return (await t.filters.get(id)) ?? null;
    },
    listSavedFilters: (staffId) => t.filters.find({ $or: [{ owner_staff_id: staffId }, { shared: true }] }, { sort: { created_at: 1, id: 1 } }),
    async insertSavedFilter(row) {
      await t.filters.insert(row);
    },
    updateSavedFilter: async (id, patch) => found(await t.filters.update(id, patch), `saved filter ${id}`),
    async deleteSavedFilter(id) {
      await t.filters.delete(id);
    },

    /* ---------------------------------------------------------------- day-end reviews */
    reviewByDate: async (date, opts) => (await t.reviews.findOne({ date }, opts)) ?? null,
    async getReview(id, opts) {
      if (!isUuid(id)) return null;
      return (await t.reviews.get(id, opts)) ?? null;
    },
    async insertReview(row) {
      await t.reviews.insertIfAbsent(row, ['date']);
      return found(await t.reviews.findOne({ date: row.date }), `day-end review ${row.date}`);
    },
    updateReview: async (id, patch) => found(await t.reviews.update(id, patch), `day-end review ${id}`),
    listReviews(filter, page) {
      const date: Record<string, string> = {};
      if (filter.from) date.$gte = filter.from;
      if (filter.to) date.$lte = filter.to;
      return t.reviews.page({ ...(filter.from || filter.to ? { date } : {}), ...(filter.state ? { state: filter.state } : {}) }, page, { column: 'date', direction: 'desc' });
    },

    /* ---------------------------------------------------------------- routines */
    listTemplates: (opts) => t.templates.find(opts?.activeOnly ? { active: true } : {}, { sort: { due_time: 1, title: 1 } }),
    countTemplates: () => t.templates.count(),
    async upsertTemplate(row) {
      await t.templates.upsert(row, {
        update: { title: row.title, area_label: row.area_label, owner_roles: row.owner_roles, due_time: row.due_time, weekdays: row.weekdays, active: row.active },
      });
    },
    async deactivateTemplatesExcept(ids) {
      await t.templates.updateMany(ids.length ? { id: { $nin: ids } } : {}, { active: false });
    },
    checksOn: (date) => t.checks.find({ date }, { sort: { due_at: 1, id: 1 } }),
    async getCheck(id, opts) {
      if (!isUuid(id)) return null;
      return (await t.checks.get(id, opts)) ?? null;
    },
    async insertCheck(row) {
      await t.checks.insertIfAbsent(row, ['template_id', 'date']);
    },
    updateCheck: async (id, patch) => found(await t.checks.update(id, patch), `routine check ${id}`),
    async markChecksLate(opts) {
      if (!opts.beforeDate && !opts.dueBefore) return 0;
      const or: Filter[] = [];
      if (opts.beforeDate) or.push({ date: { $lt: opts.beforeDate } });
      if (opts.dueBefore) or.push({ due_at: { $lt: opts.dueBefore } });
      return t.checks.updateMany({ state: { $in: ['not_done', 'in_progress'] }, $or: or }, { state: 'late' });
    },

    /* ---------------------------------------------------------------- daily counts */
    async upsertDailyCounts(rows) {
      await t.counts.upsertMany(rows, {
        key: ['queue_key', 'date'],
        update: (r) => ({ open: r.open, overdue: r.overdue, opened: r.opened, resolved: r.resolved, median_resolve_minutes: r.median_resolve_minutes }),
      });
    },
    dailyCounts: (date) => t.counts.find({ date }),
  };
  return self;
}
