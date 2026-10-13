import { contains, type Filter, type ModuleStore } from '../../kernel/mongo/index.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import { isUuid } from '../../kernel/lib/ids.js';
import { decodeCursor, encodeCursor, type PageRequest } from '../../kernel/lib/pagination.js';
import type { Page } from '../../spec/common.js';
import { ACTIVE_STATES, CLOSED_STATES } from './domain/catalog.js';
import type { DailyCountRow, DayEndReviewRow, IntakeRuleRow, ItemEventRow, ItemNoteRow, ItemQuery, ItemRow, ItemSort, Match, OldestRow, QueueCountRow, QueueRow, RoutineCheckRow, RoutineTemplateRow, SavedFilterRow } from './ports.js';

const ACTIVE = [...ACTIVE_STATES] as string[];
const CLOSED = [...CLOSED_STATES] as string[];
const NOTHING: Filter = { id: { $in: [] } };

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
    const x = contains(q.search);
    c.push({ $or: [{ title: x }, { ref: x }, { subject_ref: x }, { subject_label: x }, { seller_name: x }, { summary: x }] });
  }
  return c.length ? { $and: c } : {};
}

/** Computed sort values (priority_rank, amount_sort) */
const PRIORITY_RANK = { $switch: { branches: [{ case: { $eq: ['$priority', 'urgent'] }, then: 3 }, { case: { $eq: ['$priority', 'high'] }, then: 2 }, { case: { $eq: ['$priority', 'normal'] }, then: 1 }], default: 0 } };
const AMOUNT_SORT = { $ifNull: ['$amount_minor', -1] };
const priorityRank = (p: string) => (p === 'urgent' ? 3 : p === 'high' ? 2 : p === 'normal' ? 1 : 0);

/** The workqueues module's collections (MongoDB, docs/04-mongodb-migration.md): one per spec table. */
export class WorkqueuesRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      queues: this.store.table<QueueRow>('queues'),
      rules: this.store.table<IntakeRuleRow>('intake_rules'),
      items: this.store.table<ItemRow>('items'),
      events: this.store.table<ItemEventRow>('item_events'),
      notes: this.store.table<ItemNoteRow>('item_notes'),
      filters: this.store.table<SavedFilterRow>('saved_filters'),
      reviews: this.store.table<DayEndReviewRow>('day_end_reviews'),
      templates: this.store.table<RoutineTemplateRow>('routine_templates'),
      checks: this.store.table<RoutineCheckRow>('routine_checks'),
      counts: this.store.table<DailyCountRow>('daily_counts'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: WorkqueuesRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new WorkqueuesRepository(tx)));
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- queues */
  listQueues(): Promise<QueueRow[]> {
    return this.#t.queues.find({}, { sort: { area: 1, name: 1 } });
  }

  async getQueue(key: string, opts?: { forUpdate?: boolean }): Promise<QueueRow | null> {
    return (await this.#t.queues.get(key, opts)) ?? null;
  }

  /** Insert unless the key exists; true when inserted */
  async insertQueue(row: QueueRow): Promise<boolean> {
    return Boolean(await this.#t.queues.insertIfAbsent(row));
  }

  async updateQueue(key: string, patch: Partial<QueueRow>): Promise<QueueRow> {
    return orThrow(await this.#t.queues.update(key, patch), `queue ${key}`);
  }

  /* ---------------------------------------------------------------- intake rules */
  async upsertIntakeRules(rows: IntakeRuleRow[]): Promise<void> {
    await this.#t.rules.upsertMany(rows, {
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
  }

  /** Rules the intake table no longer produces (an event re-routed to another queue) stop being active; returns how many */
  deactivateIntakeRulesExcept(ids: string[]): Promise<number> {
    return this.#t.rules.updateMany({ active: true, ...(ids.length ? { id: { $nin: ids } } : {}) }, { active: false });
  }

  listIntakeRules(filter?: { queueKey?: string }): Promise<IntakeRuleRow[]> {
    return this.#t.rules.find(filter?.queueKey ? { queue_key: filter.queueKey } : {}, { sort: { queue_key: 1, event: 1 } });
  }

  /* ---------------------------------------------------------------- items */
  async getItem(id: string, opts?: { forUpdate?: boolean }): Promise<ItemRow | null> {
    if (!isUuid(id)) return null;
    return (await this.#t.items.get(id, opts)) ?? null;
  }

  async activeByDedupe(dedupeKey: string, opts?: { forUpdate?: boolean }): Promise<ItemRow | null> {
    return (await this.#t.items.findOne({ dedupe_key: dedupeKey, state: { $in: ACTIVE } }, opts)) ?? null;
  }

  async latestClosedByDedupe(dedupeKey: string): Promise<ItemRow | null> {
    return (await this.#t.items.findOne({ dedupe_key: dedupeKey, state: { $in: CLOSED } }, { sort: { resolved_at: -1, opened_at: -1 } })) ?? null;
  }

  insertItem(row: ItemRow): Promise<ItemRow> {
    return this.#t.items.insert(row);
  }

  async updateItem(id: string, patch: Partial<ItemRow>): Promise<ItemRow> {
    return orThrow(await this.#t.items.update(id, patch), `item ${id}`);
  }

  listItems(query: ItemQuery, page: PageRequest, sort: ItemSort): Promise<Page<ItemRow>> {
    const f = conditions(query);
    if (sort === 'priority') return this.#pageByComputed(f, page, PRIORITY_RANK, (r) => priorityRank(r.priority));
    if (sort === 'amount') return this.#pageByComputed(f, page, AMOUNT_SORT, (r) => r.amount_minor ?? -1);
    return this.#t.items.page(f, page, sort === 'oldest' ? { column: 'opened_at', direction: 'asc' } : { column: 'due_at', direction: 'asc' });
  }

  /** Rows for exports: keyset on (opened_at, id) */
  scanItems(query: ItemQuery, after: { openedAt: string; id: string } | null, limit: number): Promise<ItemRow[]> {
    const f = conditions(query);
    const at = after && new Date(after.openedAt);
    return this.#t.items.find(after ? { $and: [f, { $or: [{ opened_at: { $gt: at } }, { opened_at: at, id: { $gt: after.id } }] }] } : f, { sort: { opened_at: 1, id: 1 }, limit });
  }

  countItems(query: ItemQuery): Promise<number> {
    return this.#t.items.count(conditions(query));
  }

  /** Active items of these kinds whose subject or a related subject is one of `matches` */
  async activeMatching(kinds: string[], matches: Match[]): Promise<ItemRow[]> {
    if (!kinds.length || !matches.length) return [];
    return this.#t.items.find(
      { state: { $in: ACTIVE }, kind: { $in: kinds }, $or: matches.flatMap((m) => [{ subject_type: m.type, subject_id: m.id }, relatedHas(m.type, m.id)]) },
      { forUpdate: true },
    );
  }

  /** Items about a subject (subject or related subject; for sellers also seller_id) */
  itemsAbout(type: string, id: string, opts: { activeOnly: boolean }): Promise<ItemRow[]> {
    const or: Filter[] = [{ subject_type: type, subject_id: id }, relatedHas(type, id)];
    if (type === 'seller' && isUuid(id)) or.push({ seller_id: id });
    if (type === 'customer' && isUuid(id)) or.push({ customer_id: id });
    return this.#t.items.find({ $or: or, ...(opts.activeOnly ? { state: { $in: ACTIVE } } : {}) }, { sort: { due_at: 1, id: 1 }, limit: 200 });
  }

  /** Active items with due_at at or before `until`, or whose stored deadline state is no longer on_time, oldest deadline first */
  sweepBatch(until: Date, afterDue: { dueAt: Date; id: string } | null, limit: number): Promise<ItemRow[]> {
    const base: Filter = { state: { $in: ACTIVE }, due_at: { $lte: until } };
    const f = afterDue ? { $and: [base, { $or: [{ due_at: { $gt: afterDue.dueAt } }, { due_at: afterDue.dueAt, id: { $gt: afterDue.id } }] }] } : base;
    return this.#t.items.find(f, { sort: { due_at: 1, id: 1 }, limit });
  }

  /** Active items marked due_soon/overdue whose deadline moved past `until` */
  staleDeadlineStates(until: Date): Promise<ItemRow[]> {
    return this.#t.items.find({ state: { $in: ACTIVE }, deadline_state: { $ne: 'on_time' }, due_at: { $gt: until } }, { limit: 1000 });
  }

  async queueCounts(now: Date, dueSoonMinutes: number): Promise<QueueCountRow[]> {
    const soon = new Date(now.getTime() + dueSoonMinutes * 60_000);
    const rows = await this.#t.items.aggregate<{ _id: string; open: number; overdue: number; due_soon: number }>([
      { $match: this.#t.items.filter({ state: { $in: ACTIVE } }) },
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
  }

  async oldestOpen(): Promise<OldestRow[]> {
    const rows = await this.#t.items.aggregate<{ _id: string; first: { _id: string; ref: string; subject_ref?: string | null; opened_at: Date } }>([
      { $match: this.#t.items.filter({ state: { $in: ACTIVE } }) },
      { $sort: { queue_key: 1, opened_at: 1, _id: 1 } },
      { $group: { _id: '$queue_key', first: { $first: { _id: '$_id', ref: '$ref', subject_ref: '$subject_ref', opened_at: '$opened_at' } } } },
      { $sort: { _id: 1 } },
    ]);
    return rows.map((r): OldestRow => ({ queue_key: r._id, id: r.first._id, ref: r.first.ref, subject_ref: r.first.subject_ref ?? null, opened_at: r.first.opened_at }));
  }

  /** Active items assigned to the staff member, per queue */
  assignedCounts(staffId: string): Promise<{ queue_key: string; n: number }[]> {
    return this.#countBy({ state: { $in: ACTIVE }, assignee_staff_id: staffId }, 'queue_key', 'queue_key');
  }

  async sellerTaskCounts(sellerId: string): Promise<{ kind: string; n: number }[]> {
    if (!isUuid(sellerId)) return [];
    return this.#countBy({ state: { $in: ACTIVE }, visible_to_seller: true, seller_id: sellerId }, 'kind', 'kind');
  }

  /** Items opened / resolved in a time range, per queue (daily counts) */
  openedBetween(from: Date, to: Date): Promise<{ queue_key: string; n: number }[]> {
    return this.#countBy({ opened_at: { $gte: from, $lt: to } }, 'queue_key', 'queue_key');
  }

  async resolvedBetween(from: Date, to: Date): Promise<{ queue_key: string; opened_at: Date; resolved_at: Date }[]> {
    const rows = await this.#t.items.find({ state: 'resolved', resolved_at: { $gte: from, $lt: to } });
    return rows.map((r) => ({ queue_key: r.queue_key, opened_at: r.opened_at, resolved_at: r.resolved_at! }));
  }

  /** Mark closed items resolved before `before` archived (archived_at = at); rows, notes and history stay. Returns how many (at most `limit`) */
  async archiveClosedBefore(before: Date, at: Date, limit: number): Promise<number> {
    const open: Filter = { state: { $in: CLOSED }, archived_at: null, resolved_at: { $lt: before } };
    const ids = (await this.#t.items.find(open, { sort: { resolved_at: 1, id: 1 }, limit })).map((r) => r.id);
    if (!ids.length) return 0;
    return this.#t.items.updateMany({ ...open, id: { $in: ids } }, { archived_at: at });
  }

  /* ---------------------------------------------------------------- history and notes */
  async insertEvent(row: ItemEventRow): Promise<void> {
    await this.#t.events.insert(row);
  }

  eventsOf(itemId: string): Promise<ItemEventRow[]> {
    return this.#t.events.find({ item_id: itemId }, { sort: { at: 1, id: 1 } });
  }

  async eventsOfItems(itemIds: string[]): Promise<ItemEventRow[]> {
    return (itemIds.length ? this.#t.events.find({ item_id: { $in: itemIds } }, { sort: { at: 1, id: 1 } }) : []);
  }

  hasEvent(itemId: string, kind: string): Promise<boolean> {
    return this.#t.events.exists({ item_id: itemId, kind });
  }

  async insertNote(row: ItemNoteRow): Promise<void> {
    await this.#t.notes.insert(row);
  }

  notesOf(itemId: string): Promise<ItemNoteRow[]> {
    return this.#t.notes.find({ item_id: itemId }, { sort: { at: 1, id: 1 } });
  }

  async notesOfItems(itemIds: string[]): Promise<ItemNoteRow[]> {
    return (itemIds.length ? this.#t.notes.find({ item_id: { $in: itemIds } }, { sort: { at: 1, id: 1 } }) : []);
  }

  /* ---------------------------------------------------------------- saved filters */
  async getSavedFilter(id: string): Promise<SavedFilterRow | null> {
    if (!isUuid(id)) return null;
    return (await this.#t.filters.get(id)) ?? null;
  }

  listSavedFilters(staffId: string): Promise<SavedFilterRow[]> {
    return this.#t.filters.find({ $or: [{ owner_staff_id: staffId }, { shared: true }] }, { sort: { created_at: 1, id: 1 } });
  }

  async insertSavedFilter(row: SavedFilterRow): Promise<void> {
    await this.#t.filters.insert(row);
  }

  async updateSavedFilter(id: string, patch: Partial<SavedFilterRow>): Promise<SavedFilterRow> {
    return orThrow(await this.#t.filters.update(id, patch), `saved filter ${id}`);
  }

  async deleteSavedFilter(id: string): Promise<void> {
    await this.#t.filters.delete(id);
  }

  /* ---------------------------------------------------------------- day-end reviews */
  async reviewByDate(date: string, opts?: { forUpdate?: boolean }): Promise<DayEndReviewRow | null> {
    return (await this.#t.reviews.findOne({ date }, opts)) ?? null;
  }

  async getReview(id: string, opts?: { forUpdate?: boolean }): Promise<DayEndReviewRow | null> {
    if (!isUuid(id)) return null;
    return (await this.#t.reviews.get(id, opts)) ?? null;
  }

  /** Insert unless the date exists; returns the row for the date */
  async insertReview(row: DayEndReviewRow): Promise<DayEndReviewRow> {
    await this.#t.reviews.insertIfAbsent(row, ['date']);
    return orThrow(await this.#t.reviews.findOne({ date: row.date }), `day-end review ${row.date}`);
  }

  async updateReview(id: string, patch: Partial<DayEndReviewRow>): Promise<DayEndReviewRow> {
    return orThrow(await this.#t.reviews.update(id, patch), `day-end review ${id}`);
  }

  listReviews(filter: { from?: string; to?: string; state?: string }, page: PageRequest): Promise<Page<DayEndReviewRow>> {
    const date: Record<string, string> = {};
    if (filter.from) date.$gte = filter.from;
    if (filter.to) date.$lte = filter.to;
    return this.#t.reviews.page({ ...(filter.from || filter.to ? { date } : {}), ...(filter.state ? { state: filter.state } : {}) }, page, { column: 'date', direction: 'desc' });
  }

  /* ---------------------------------------------------------------- routines */
  listTemplates(opts?: { activeOnly?: boolean }): Promise<RoutineTemplateRow[]> {
    return this.#t.templates.find(opts?.activeOnly ? { active: true } : {}, { sort: { due_time: 1, title: 1 } });
  }

  countTemplates(): Promise<number> {
    return this.#t.templates.count();
  }

  async upsertTemplate(row: RoutineTemplateRow): Promise<void> {
    await this.#t.templates.upsert(row, {
      update: { title: row.title, area_label: row.area_label, owner_roles: row.owner_roles, due_time: row.due_time, weekdays: row.weekdays, active: row.active },
    });
  }

  async deactivateTemplatesExcept(ids: string[]): Promise<void> {
    await this.#t.templates.updateMany(ids.length ? { id: { $nin: ids } } : {}, { active: false });
  }

  checksOn(date: string): Promise<RoutineCheckRow[]> {
    return this.#t.checks.find({ date }, { sort: { due_at: 1, id: 1 } });
  }

  async getCheck(id: string, opts?: { forUpdate?: boolean }): Promise<RoutineCheckRow | null> {
    if (!isUuid(id)) return null;
    return (await this.#t.checks.get(id, opts)) ?? null;
  }

  /** Insert unless (template, date) exists */
  async insertCheck(row: RoutineCheckRow): Promise<void> {
    await this.#t.checks.insertIfAbsent(row, ['template_id', 'date']);
  }

  async updateCheck(id: string, patch: Partial<RoutineCheckRow>): Promise<RoutineCheckRow> {
    return orThrow(await this.#t.checks.update(id, patch), `routine check ${id}`);
  }

  /** not_done/in_progress checks of earlier dates, or due before `dueBefore` → late; returns how many */
  async markChecksLate(opts: { beforeDate?: string; dueBefore?: Date }): Promise<number> {
    if (!opts.beforeDate && !opts.dueBefore) return 0;
    const or: Filter[] = [];
    if (opts.beforeDate) or.push({ date: { $lt: opts.beforeDate } });
    if (opts.dueBefore) or.push({ due_at: { $lt: opts.dueBefore } });
    return this.#t.checks.updateMany({ state: { $in: ['not_done', 'in_progress'] }, $or: or }, { state: 'late' });
  }

  /* ---------------------------------------------------------------- daily counts */
  async upsertDailyCounts(rows: DailyCountRow[]): Promise<void> {
    await this.#t.counts.upsertMany(rows, {
      key: ['queue_key', 'date'],
      update: (r) => ({ open: r.open, overdue: r.overdue, opened: r.opened, resolved: r.resolved, median_resolve_minutes: r.median_resolve_minutes }),
    });
  }

  dailyCounts(date: string): Promise<DailyCountRow[]> {
    return this.#t.counts.find({ date });
  }

  /** A page of items sorted by a computed value (descending), then id: keyset on (value, id) */
  async #pageByComputed(filter: Filter, req: PageRequest, expr: unknown, valueOf: (row: ItemRow) => number): Promise<Page<ItemRow>> {
    const match = this.#t.items.filter(filter);
    const cursorOf = (row: ItemRow) => encodeCursor([valueOf(row), row.id]);
    const run = async (extra: Record<string, unknown>[]) => {
      const docs = await this.#t.items.aggregate<Record<string, unknown>>([{ $match: match }, { $addFields: { _sort: expr } }, ...extra]);
      return docs.map(({ _sort: _s, ...doc }) => this.#t.items.fromDoc(doc));
    };
    const sort = { $sort: { _sort: -1, _id: -1 } };
    if (req.mode === 'page') {
      const [total, items] = await Promise.all([this.#t.items.count(filter), run([sort, { $skip: (req.page - 1) * req.limit }, { $limit: req.limit }])]);
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

  async #countBy<K extends string>(match: Filter, field: string, as: K) {
    return (await this.#t.items.aggregate<{ _id: string; n: number }>([{ $match: this.#t.items.filter(match) }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }])).map(
      (r) => ({ [as]: r._id, n: r.n }) as { [P in K]: string } & { n: number },
    );
  }
}
