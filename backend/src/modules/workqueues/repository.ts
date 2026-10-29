import { orThrow } from '../../kernel/lib/or-throw.js';
import { isUuid } from '../../kernel/lib/ids.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { Store, StoreTable, WhereWithOr } from '../../kernel/store/index.js';
import type { Page } from '../../spec/common.js';
import { ACTIVE_STATES, CLOSED_STATES } from './domain/catalog.js';
import type { DailyCountRow, DayEndReviewRow, IntakeRuleRow, ItemEventRow, ItemNoteRow, ItemQuery, ItemRow, ItemSort, Match, OldestRow, QueueCountRow, QueueRow, RoutineCheckRow, RoutineTemplateRow, SavedFilterRow } from './ports.js';
import type { WorkqueuesQueries } from './queries.js';

const ACTIVE = [...ACTIVE_STATES];
const CLOSED = [...CLOSED_STATES];

type ItemWhere = WhereWithOr<ItemRow>;

/**
 * A condition no row meets: a list of no values is "one of nothing" on both stores.
 *
 * No test covers it, and none can: the only branch that reaches it is a `deadlineStates` holding none of the
 * three words, and every caller either validates them against that list or passes `['overdue']` itself.
 */
const NOTHING: ItemWhere = { id: [] };

/**
 * `related_subjects @> [{ type, id }]`: "it has a related subject with **this** type and **this** id", which was
 * one `$elemMatch`.
 *
 * An object on a `[]` path is the vocabulary's "some one element holds these fields" (kernel/mongo/filters.ts):
 * `$elemMatch` on MongoDB, `JSON_CONTAINS` on MySQL, the fields matched as a subset of the element either way.
 * Two separate paths would not do — `related_subjects[].type` and `related_subjects[].id` can be satisfied by
 * two different elements, which is a wider question than this one.
 */
const relatedHas = (type: string, id: string): ItemWhere => ({ 'related_subjects[]': { type, id } });

/** The item filter of a query */
function conditions(q: ItemQuery): ItemWhere {
  const c: ItemWhere[] = [];
  const v = q.visibility;
  if (v) {
    const or: ItemWhere[] = [{ assignee_staff_id: v.staffId }, { escalated_to: `staff:${v.staffId}` }];
    if (v.queueKeys.length) or.push({ queue_key: [...v.queueKeys] });
    if (v.roles.length) {
      or.push({ owner_role: [...v.roles] });
      or.push({ escalated_to: v.roles.map((r) => `role:${r}`) });
    }
    c.push({ or });
  }
  if (q.queueKeys) c.push({ queue_key: [...q.queueKeys] });
  if (q.kinds?.length) c.push({ kind: [...q.kinds] });
  if (q.states?.length) c.push({ state: q.states as ItemRow['state'][] });
  if (q.deadlineStates?.length) {
    // deadline state from due_at (the stored state may lag the sweep by a minute)
    const now = q.now ?? new Date();
    const or: ItemWhere[] = [];
    if (q.deadlineStates.includes('overdue')) or.push({ due_at: { op: '<=', value: now } });
    // deadline_state is NOT NULL with a CHECK of three words, so `<>` and `is not` answer the same rows on this
    // column and no test can tell them apart. `<>` is the spec's reading of a <> condition, so it is what is written
    if (q.deadlineStates.includes('due_soon')) or.push({ due_at: { op: '>', value: now }, deadline_state: { op: '<>', value: 'on_time' } });
    if (q.deadlineStates.includes('on_time')) or.push({ due_at: { op: '>', value: now }, deadline_state: 'on_time' });
    c.push(or.length ? { or } : NOTHING);
  }
  if (q.overdueOverMinutes !== undefined) c.push({ due_at: { op: '<', value: new Date((q.now ?? new Date()).getTime() - q.overdueOverMinutes * 60_000) } });
  if (q.assignee?.kind === 'unassigned') c.push({ assignee_staff_id: null });
  if (q.assignee?.kind === 'staff') c.push({ assignee_staff_id: q.assignee.id });
  if (q.sellerId) c.push({ seller_id: q.sellerId });
  if (q.sellerKind === 'official') c.push({ seller_id: null });
  // "it has a seller", which is `is not` null on both stores (a `<>` null matches nothing)
  if (q.sellerKind === 'marketplace') c.push({ seller_id: { op: 'is not', value: null } });
  if (q.subjectRef) c.push({ or: [{ subject_ref: q.subjectRef }, { ref: q.subjectRef }, { 'related_subjects[].ref': q.subjectRef }] });
  if (q.visibleToSeller !== undefined) c.push({ visible_to_seller: q.visibleToSeller });
  if (q.archived === true) c.push({ archived_at: { op: 'is not', value: null } });
  if (q.archived === false) c.push({ archived_at: null });
  if (q.search?.trim()) {
    const x = { op: 'contains', value: q.search } as const;
    c.push({ or: [{ title: x }, { ref: x }, { subject_ref: x }, { subject_label: x }, { seller_name: x }, { summary: x }] });
  }
  return c.length ? { and: c } : {};
}

/** The workqueues module's tables, in whichever database holds this module's data (docs/10 §10.5, §5c). */
export class WorkqueuesRepository {
  readonly #t: {
    queues: StoreTable<QueueRow>;
    rules: StoreTable<IntakeRuleRow>;
    items: StoreTable<ItemRow>;
    events: StoreTable<ItemEventRow>;
    notes: StoreTable<ItemNoteRow>;
    filters: StoreTable<SavedFilterRow>;
    reviews: StoreTable<DayEndReviewRow>;
    templates: StoreTable<RoutineTemplateRow>;
    checks: StoreTable<RoutineCheckRow>;
    counts: StoreTable<DailyCountRow>;
  };

  constructor(
    private readonly store: Store,
    private readonly queries: WorkqueuesQueries,
  ) {
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
    return this.store.transaction((tx) => fn(new WorkqueuesRepository(tx, this.queries)));
  }

  /** Inbox (store.claim): true the first time this key is claimed; commits with the transaction it runs in */
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

  /**
   * Rules the intake table no longer produces (an event re-routed to another queue) stop being active; returns how
   * many. A `not in` of no values leaves the column unfiltered, which is what "keep none of them" means, so the
   * branch the MongoDB filter needed has gone; `id` is NOT NULL, so `not in` skipping nulls changes nothing.
   */
  deactivateIntakeRulesExcept(ids: string[]): Promise<number> {
    return this.#t.rules.updateMany({ active: true, id: { op: 'not in', value: ids } }, { active: false });
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
    return (await this.#t.items.findOne({ dedupe_key: dedupeKey, state: ACTIVE }, opts)) ?? null;
  }

  async latestClosedByDedupe(dedupeKey: string, opts?: { forUpdate?: boolean }): Promise<ItemRow | null> {
    return (await this.#t.items.findOne({ dedupe_key: dedupeKey, state: CLOSED }, { sort: { resolved_at: -1, opened_at: -1 }, ...opts })) ?? null;
  }

  insertItem(row: ItemRow): Promise<ItemRow> {
    return this.#t.items.insert(row);
  }

  async updateItem(id: string, patch: Partial<ItemRow>): Promise<ItemRow> {
    return orThrow(await this.#t.items.update(id, patch), `item ${id}`);
  }

  listItems(query: ItemQuery, page: PageRequest, sort: ItemSort): Promise<Page<ItemRow>> {
    const f = conditions(query);
    // priority and amount order by a value neither store keeps, which is the queries port (queries.ts)
    if (sort === 'priority' || sort === 'amount') return this.queries.pageByComputed(f, sort, page);
    return this.#t.items.page(f, page, sort === 'oldest' ? { column: 'opened_at', direction: 'asc' } : { column: 'due_at', direction: 'asc' });
  }

  /** Rows for exports: keyset on (opened_at, id) */
  scanItems(query: ItemQuery, after: { openedAt: string; id: string } | null, limit: number): Promise<ItemRow[]> {
    const f = conditions(query);
    if (!after) return this.#t.items.find(f, { sort: { opened_at: 1, id: 1 }, limit });
    const at = new Date(after.openedAt);
    const keyset: ItemWhere = { or: [{ opened_at: { op: '>', value: at } }, { opened_at: at, id: { op: '>', value: after.id } }] };
    return this.#t.items.find({ and: [f, keyset] }, { sort: { opened_at: 1, id: 1 }, limit });
  }

  countItems(query: ItemQuery): Promise<number> {
    return this.#t.items.count(conditions(query));
  }

  /**
   * Active items of these kinds whose subject or a related subject is one of `matches`.
   *
   * The rows are locked because the caller closes them in the same transaction (§11.2 rule 1), which is also why
   * this read is not in the queries port: a port query runs on its own connection, where it can neither see this
   * transaction nor lock a row for it. It does not need to be — the whole filter is one neutral Where.
   */
  activeMatching(kinds: string[], matches: Match[]): Promise<ItemRow[]> {
    if (!kinds.length || !matches.length) return Promise.resolve([]);
    return this.#t.items.find(
      { state: ACTIVE, kind: [...kinds], or: matches.flatMap((m) => [{ subject_type: m.type, subject_id: m.id }, relatedHas(m.type, m.id)]) },
      { forUpdate: true },
    );
  }

  /** Items about a subject (subject or related subject; for sellers also seller_id) */
  itemsAbout(type: string, id: string, opts: { activeOnly: boolean }): Promise<ItemRow[]> {
    const or: ItemWhere[] = [{ subject_type: type, subject_id: id }, relatedHas(type, id)];
    if (type === 'seller' && isUuid(id)) or.push({ seller_id: id });
    if (type === 'customer' && isUuid(id)) or.push({ customer_id: id });
    return this.#t.items.find({ or, ...(opts.activeOnly ? { state: ACTIVE } : {}) }, { sort: { due_at: 1, id: 1 }, limit: 200 });
  }

  /** Active items with due_at at or before `until`, or whose stored deadline state is no longer on_time, oldest deadline first */
  sweepBatch(until: Date, afterDue: { dueAt: Date; id: string } | null, limit: number): Promise<ItemRow[]> {
    const base: ItemWhere = { state: ACTIVE, due_at: { op: '<=', value: until } };
    if (!afterDue) return this.#t.items.find(base, { sort: { due_at: 1, id: 1 }, limit });
    const keyset: ItemWhere = { or: [{ due_at: { op: '>', value: afterDue.dueAt } }, { due_at: afterDue.dueAt, id: { op: '>', value: afterDue.id } }] };
    return this.#t.items.find({ and: [base, keyset] }, { sort: { due_at: 1, id: 1 }, limit });
  }

  /** Active items marked due_soon/overdue whose deadline moved past `until` */
  staleDeadlineStates(until: Date): Promise<ItemRow[]> {
    // `<>` rather than `is not`, for the reason conditions() gives: deadline_state is NOT NULL, so the two cannot
    // be told apart on this column, and `<>` is the spec's reading
    return this.#t.items.find({ state: ACTIVE, deadline_state: { op: '<>', value: 'on_time' }, due_at: { op: '>', value: until } }, { limit: 1000 });
  }

  /** Sets the stored deadline state of these items */
  async setDeadlineState(ids: string[], state: string): Promise<void> {
    if (ids.length) await this.#t.items.updateMany({ id: ids }, { deadline_state: state as ItemRow['deadline_state'] });
  }

  /** Open / overdue / due soon per queue: one GROUP BY with three measures, so the queries port (queries.ts) */
  queueCounts(now: Date, dueSoonMinutes: number): Promise<QueueCountRow[]> {
    return this.queries.queueCounts({ states: ACTIVE, now, soon: new Date(now.getTime() + dueSoonMinutes * 60_000) });
  }

  /** The oldest open item of each queue: the first row per key, so the queries port (queries.ts) */
  oldestOpen(): Promise<OldestRow[]> {
    return this.queries.oldestOpen({ states: ACTIVE });
  }

  /** Active items assigned to the staff member, per queue */
  assignedCounts(staffId: string): Promise<{ queue_key: string; n: number }[]> {
    return this.#t.items.countBy(['queue_key'], { state: ACTIVE, assignee_staff_id: staffId });
  }

  async sellerTaskCounts(sellerId: string): Promise<{ kind: string; n: number }[]> {
    if (!isUuid(sellerId)) return [];
    return this.#t.items.countBy(['kind'], { state: ACTIVE, visible_to_seller: true, seller_id: sellerId });
  }

  /** Items opened / resolved in a time range, per queue (daily counts) */
  openedBetween(from: Date, to: Date): Promise<{ queue_key: string; n: number }[]> {
    return this.#t.items.countBy(['queue_key'], { and: [{ opened_at: { op: '>=', value: from } }, { opened_at: { op: '<', value: to } }] });
  }

  async resolvedBetween(from: Date, to: Date): Promise<{ queue_key: string; opened_at: Date; resolved_at: Date }[]> {
    const rows = await this.#t.items.find({ state: 'resolved', and: [{ resolved_at: { op: '>=', value: from } }, { resolved_at: { op: '<', value: to } }] });
    return rows.map((r) => ({ queue_key: r.queue_key, opened_at: r.opened_at, resolved_at: r.resolved_at! }));
  }

  /** Mark closed items resolved before `before` archived (archived_at = at); rows, notes and history stay. Returns how many (at most `limit`) */
  async archiveClosedBefore(before: Date, at: Date, limit: number): Promise<number> {
    const open: ItemWhere = { state: CLOSED, archived_at: null, resolved_at: { op: '<', value: before } };
    const ids = (await this.#t.items.find(open, { sort: { resolved_at: 1, id: 1 }, limit })).map((r) => r.id);
    if (!ids.length) return 0;
    return this.#t.items.updateMany({ ...open, id: ids }, { archived_at: at });
  }

  /* ---------------------------------------------------------------- history and notes */
  async insertEvent(row: ItemEventRow): Promise<void> {
    await this.#t.events.insert(row);
  }

  eventsOf(itemId: string): Promise<ItemEventRow[]> {
    return this.#t.events.find({ item_id: itemId }, { sort: { at: 1, id: 1 } });
  }

  async eventsOfItems(itemIds: string[]): Promise<ItemEventRow[]> {
    return itemIds.length ? this.#t.events.find({ item_id: itemIds }, { sort: { at: 1, id: 1 } }) : [];
  }

  /** The items among itemIds with a history entry of this kind */
  async itemsWithEvent(itemIds: string[], kind: string): Promise<Set<string>> {
    return new Set(itemIds.length ? await this.#t.events.distinct<string>('item_id', { item_id: itemIds, kind }) : []);
  }

  async insertNote(row: ItemNoteRow): Promise<void> {
    await this.#t.notes.insert(row);
  }

  notesOf(itemId: string): Promise<ItemNoteRow[]> {
    return this.#t.notes.find({ item_id: itemId }, { sort: { at: 1, id: 1 } });
  }

  async notesOfItems(itemIds: string[]): Promise<ItemNoteRow[]> {
    return itemIds.length ? this.#t.notes.find({ item_id: itemIds }, { sort: { at: 1, id: 1 } }) : [];
  }

  /* ---------------------------------------------------------------- saved filters */
  async getSavedFilter(id: string): Promise<SavedFilterRow | null> {
    if (!isUuid(id)) return null;
    return (await this.#t.filters.get(id)) ?? null;
  }

  listSavedFilters(staffId: string): Promise<SavedFilterRow[]> {
    return this.#t.filters.find({ or: [{ owner_staff_id: staffId }, { shared: true }] }, { sort: { created_at: 1, id: 1 } });
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

  /**
   * Insert unless the date exists; returns the row for the date.
   *
   * `(date)` is a unique key of the table on both stores, so naming it is the question meant: "unless this day
   * already has a review". No test can tell it from naming no key, because nothing races two reviews for one
   * date — the id is fresh, so the primary key is never the one that refuses it.
   */
  async insertReview(row: DayEndReviewRow): Promise<DayEndReviewRow> {
    await this.#t.reviews.insertIfAbsent(row, ['date']);
    return orThrow(await this.#t.reviews.findOne({ date: row.date }), `day-end review ${row.date}`);
  }

  async updateReview(id: string, patch: Partial<DayEndReviewRow>): Promise<DayEndReviewRow> {
    return orThrow(await this.#t.reviews.update(id, patch), `day-end review ${id}`);
  }

  listReviews(filter: { from?: string; to?: string; state?: string }, page: PageRequest): Promise<Page<DayEndReviewRow>> {
    // two conditions on `date`, which one object cannot hold twice (§10.5a's `and`)
    const date: WhereWithOr<DayEndReviewRow>[] = [];
    if (filter.from) date.push({ date: { op: '>=', value: filter.from } });
    if (filter.to) date.push({ date: { op: '<=', value: filter.to } });
    return this.#t.reviews.page({ and: date, ...(filter.state ? { state: filter.state } : {}) }, page, { column: 'date', direction: 'desc' });
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

  /** A `not in` of no values leaves `id` unfiltered, which is "deactivate every one of them" */
  async deactivateTemplatesExcept(ids: string[]): Promise<void> {
    await this.#t.templates.updateMany({ id: { op: 'not in', value: ids } }, { active: false });
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
    const or: WhereWithOr<RoutineCheckRow>[] = [];
    if (opts.beforeDate) or.push({ date: { op: '<', value: opts.beforeDate } });
    if (opts.dueBefore) or.push({ due_at: { op: '<', value: opts.dueBefore } });
    return this.#t.checks.updateMany({ state: ['not_done', 'in_progress'], or }, { state: 'late' });
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
}
