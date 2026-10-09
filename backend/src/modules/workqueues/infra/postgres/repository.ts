import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool, type Transaction } from 'kysely';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import { isUuid } from '../../../../kernel/lib/ids.js';
import { paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { WorkqueuesDb } from '../../../../spec/workqueues.js';
import { ACTIVE_STATES, CLOSED_STATES } from '../../domain/catalog.js';
import { dateText } from '../../domain/rules.js';
import type { DailyCountRow, DayEndReviewRow, ItemQuery, ItemRow, ItemSort, RoutineCheckRow, WorkqueuesRepository } from '../../ports.js';

type Db = Kysely<WorkqueuesDb> | Transaction<WorkqueuesDb>;

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSONB: Record<string, readonly string[]> = {
  queues: ['escalation_route'],
  intake_rules: ['resolves_on'],
  items: ['related_subjects', 'links', 'resolution'],
  item_events: ['detail'],
  saved_filters: ['filters'],
  day_end_reviews: ['shared_with_roles', 'items', 'summary_sent_to'],
  routine_templates: ['owner_roles', 'weekdays'],
  routine_checks: ['check_ins'],
};

function enc<T extends object>(table: string, row: T): T {
  const cols = JSONB[table];
  if (!cols) return row;
  const out = { ...row } as Record<string, unknown>;
  for (const c of cols) if (c in out && out[c] !== undefined && out[c] !== null) out[c] = JSON.stringify(out[c]);
  return out as T;
}

/** bigint arrives as text; date columns as Date or text */
const item = (r: ItemRow): ItemRow => ({ ...r, amount_minor: r.amount_minor === null || r.amount_minor === undefined ? null : Number(r.amount_minor) });
const review = (r: DayEndReviewRow): DayEndReviewRow => ({ ...r, date: dateText(r.date) });
const check = (r: RoutineCheckRow): RoutineCheckRow => ({ ...r, date: dateText(r.date) });
const counts = (r: DailyCountRow): DailyCountRow => ({ ...r, date: dateText(r.date) });

const ACTIVE = [...ACTIVE_STATES] as string[];
const CLOSED = [...CLOSED_STATES] as string[];

type ItemsEb = ExpressionBuilder<WorkqueuesDb, 'items'>;

const relatedHas = (type: string, id: string) => sql<SqlBool>`related_subjects @> ${JSON.stringify([{ type, id }])}::jsonb`;

function conditions(eb: ItemsEb, q: ItemQuery): Expression<SqlBool>[] {
  const c: Expression<SqlBool>[] = [];
  const v = q.visibility;
  if (v) {
    const or: Expression<SqlBool>[] = [eb('assignee_staff_id', '=', v.staffId), eb('escalated_to', '=', `staff:${v.staffId}`)];
    if (v.queueKeys.length) or.push(eb('queue_key', 'in', v.queueKeys));
    if (v.roles.length) {
      or.push(eb('owner_role', 'in', v.roles));
      or.push(eb('escalated_to', 'in', v.roles.map((r) => `role:${r}`)));
    }
    c.push(eb.or(or));
  }
  if (q.queueKeys) c.push(q.queueKeys.length ? eb('queue_key', 'in', q.queueKeys) : sql<SqlBool>`false`);
  if (q.kinds?.length) c.push(eb('kind', 'in', q.kinds));
  if (q.states?.length) c.push(eb('state', 'in', q.states));
  if (q.deadlineStates?.length) {
    // deadline state from due_at (the stored state may lag the sweep by a minute)
    const now = q.now ?? new Date();
    const or: Expression<SqlBool>[] = [];
    if (q.deadlineStates.includes('overdue')) or.push(eb('due_at', '<=', now));
    if (q.deadlineStates.includes('due_soon')) or.push(eb.and([eb('due_at', '>', now), eb('deadline_state', '!=', 'on_time')]));
    if (q.deadlineStates.includes('on_time')) or.push(eb.and([eb('due_at', '>', now), eb('deadline_state', '=', 'on_time')]));
    c.push(eb.or(or));
  }
  if (q.overdueOverMinutes !== undefined) c.push(eb('due_at', '<', new Date((q.now ?? new Date()).getTime() - q.overdueOverMinutes * 60_000)));
  if (q.assignee?.kind === 'unassigned') c.push(eb('assignee_staff_id', 'is', null));
  if (q.assignee?.kind === 'staff') c.push(eb('assignee_staff_id', '=', q.assignee.id));
  if (q.sellerId) c.push(eb('seller_id', '=', q.sellerId));
  if (q.sellerKind === 'official') c.push(eb('seller_id', 'is', null));
  if (q.sellerKind === 'marketplace') c.push(eb('seller_id', 'is not', null));
  if (q.subjectRef) c.push(eb.or([eb('subject_ref', '=', q.subjectRef), eb('ref', '=', q.subjectRef), relatedRef(q.subjectRef)]));
  if (q.visibleToSeller !== undefined) c.push(eb('visible_to_seller', '=', q.visibleToSeller));
  if (q.search?.trim()) {
    const like = `%${q.search.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    c.push(eb.or([eb('title', 'ilike', like), eb('ref', 'ilike', like), eb('subject_ref', 'ilike', like), eb('subject_label', 'ilike', like), eb('seller_name', 'ilike', like), eb('summary', 'ilike', like)]));
  }
  return c;
}

const relatedRef = (ref: string) => sql<SqlBool>`related_subjects @> ${JSON.stringify([{ ref }])}::jsonb`;

/** Postgres adapter for WorkqueuesRepository. `db` is scoped to the `workqueues` schema. */
export function createPostgresWorkqueuesRepository(db: Kysely<WorkqueuesDb>, inbox: Inbox): WorkqueuesRepository {
  return repo(db, false, inbox);
}

function repo(db: Db, inTx: boolean, inbox: Inbox): WorkqueuesRepository {
  const filtered = (q: ItemQuery) => db.selectFrom('items').where((eb) => eb.and(conditions(eb, q)));

  const self: WorkqueuesRepository = {
    async transaction(fn) {
      if (inTx) return fn(self);
      return (db as Kysely<WorkqueuesDb>).transaction().execute((trx) => fn(repo(trx, true, inbox)));
    },
    claim(key) {
      return inbox.claim(db, key);
    },

    /* ---------------------------------------------------------------- queues */
    listQueues: () => db.selectFrom('queues').selectAll().orderBy('area').orderBy('name').execute(),
    async getQueue(key, opts) {
      let q = db.selectFrom('queues').selectAll().where('key', '=', key);
      if (opts?.forUpdate) q = q.forUpdate();
      return (await q.executeTakeFirst()) ?? null;
    },
    async insertQueue(row) {
      const r = await db.insertInto('queues').values(enc('queues', row)).onConflict((oc) => oc.column('key').doNothing()).executeTakeFirst();
      return Number(r.numInsertedOrUpdatedRows ?? 0) > 0;
    },
    async updateQueue(key, patch) {
      return db.updateTable('queues').set(enc('queues', patch)).where('key', '=', key).returningAll().executeTakeFirstOrThrow();
    },

    /* ---------------------------------------------------------------- intake rules */
    async upsertIntakeRules(rows) {
      if (!rows.length) return;
      await db
        .insertInto('intake_rules')
        .values(rows.map((r) => enc('intake_rules', r)))
        .onConflict((oc) =>
          oc.column('id').doUpdateSet((eb) => ({
            event: eb.ref('excluded.event'),
            queue_key: eb.ref('excluded.queue_key'),
            kind: eb.ref('excluded.kind'),
            title_template: eb.ref('excluded.title_template'),
            dedupe_key_template: eb.ref('excluded.dedupe_key_template'),
            deadline_rule: eb.ref('excluded.deadline_rule'),
            priority: eb.ref('excluded.priority'),
            resolves_on: eb.ref('excluded.resolves_on'),
            active: eb.ref('excluded.active'),
          })),
        )
        .execute();
    },
    async deactivateIntakeRulesExcept(ids) {
      let q = db.updateTable('intake_rules').set({ active: false }).where('active', '=', true);
      if (ids.length) q = q.where('id', 'not in', ids);
      const r = await q.executeTakeFirst();
      return Number(r.numUpdatedRows ?? 0);
    },
    async listIntakeRules(filter) {
      let q = db.selectFrom('intake_rules').selectAll().orderBy('queue_key').orderBy('event');
      if (filter?.queueKey) q = q.where('queue_key', '=', filter.queueKey);
      return q.execute();
    },

    /* ---------------------------------------------------------------- items */
    async getItem(id, opts) {
      if (!isUuid(id)) return null;
      let q = db.selectFrom('items').selectAll().where('id', '=', id);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? item(r) : null;
    },
    async activeByDedupe(dedupeKey, opts) {
      let q = db.selectFrom('items').selectAll().where('dedupe_key', '=', dedupeKey).where('state', 'in', ACTIVE);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? item(r) : null;
    },
    async latestClosedByDedupe(dedupeKey) {
      const r = await db.selectFrom('items').selectAll().where('dedupe_key', '=', dedupeKey).where('state', 'in', CLOSED).orderBy('resolved_at', 'desc').orderBy('opened_at', 'desc').executeTakeFirst();
      return r ? item(r) : null;
    },
    async insertItem(row) {
      return item(await db.insertInto('items').values(enc('items', row)).returningAll().executeTakeFirstOrThrow());
    },
    async updateItem(id, patch) {
      return item(await db.updateTable('items').set(enc('items', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow());
    },
    async listItems(query, page: PageRequest, sort: ItemSort) {
      const base = filtered(query)
        .selectAll()
        .select([
          sql<number>`case priority when 'urgent' then 3 when 'high' then 2 when 'normal' then 1 else 0 end`.as('priority_rank'),
          sql<number>`coalesce(amount_minor, -1)`.as('amount_sort'),
        ]);
      const q = db.selectFrom(base.as('i')).selectAll();
      const order =
        sort === 'oldest'
          ? { column: 'opened_at', direction: 'asc' as const }
          : sort === 'priority'
            ? { column: 'priority_rank', direction: 'desc' as const }
            : sort === 'amount'
              ? { column: 'amount_sort', direction: 'desc' as const }
              : { column: 'due_at', direction: 'asc' as const };
      const res = await paginate(q, page, order);
      return { ...res, items: res.items.map((r) => item(r as unknown as ItemRow)) };
    },
    async scanItems(query, after, limit) {
      let q = filtered(query).selectAll().orderBy('opened_at').orderBy('id').limit(limit);
      if (after) q = q.where(sql<SqlBool>`(opened_at, id) > (${new Date(after.openedAt)}, ${after.id})`);
      return (await q.execute()).map(item);
    },
    async countItems(query) {
      const r = await filtered(query).select(sql<number>`count(*)::int`.as('n')).executeTakeFirst();
      return r?.n ?? 0;
    },
    async activeMatching(kinds, matches) {
      if (!kinds.length || !matches.length) return [];
      const rows = await db
        .selectFrom('items')
        .selectAll()
        .where('state', 'in', ACTIVE)
        .where('kind', 'in', kinds)
        .where((eb) => eb.or(matches.flatMap((m) => [eb.and([eb('subject_type', '=', m.type), eb('subject_id', '=', m.id)]), relatedHas(m.type, m.id)])))
        .forUpdate()
        .execute();
      return rows.map(item);
    },
    async itemsAbout(type, id, opts) {
      let q = db
        .selectFrom('items')
        .selectAll()
        .where((eb) => {
          const or: Expression<SqlBool>[] = [eb.and([eb('subject_type', '=', type), eb('subject_id', '=', id)]), relatedHas(type, id)];
          if (type === 'seller' && isUuid(id)) or.push(eb('seller_id', '=', id));
          if (type === 'customer' && isUuid(id)) or.push(eb('customer_id', '=', id));
          return eb.or(or);
        })
        .orderBy('due_at')
        .limit(200);
      if (opts.activeOnly) q = q.where('state', 'in', ACTIVE);
      return (await q.execute()).map(item);
    },
    async sweepBatch(until, afterDue, limit) {
      let q = db.selectFrom('items').selectAll().where('state', 'in', ACTIVE).where('due_at', '<=', until).orderBy('due_at').orderBy('id').limit(limit);
      if (afterDue) q = q.where(sql<SqlBool>`(due_at, id) > (${afterDue.dueAt}, ${afterDue.id})`);
      return (await q.execute()).map(item);
    },
    async staleDeadlineStates(until) {
      const rows = await db.selectFrom('items').selectAll().where('state', 'in', ACTIVE).where('deadline_state', '!=', 'on_time').where('due_at', '>', until).limit(1000).execute();
      return rows.map(item);
    },
    async queueCounts(now, dueSoonMinutes) {
      const soon = new Date(now.getTime() + dueSoonMinutes * 60_000);
      return db
        .selectFrom('items')
        .where('state', 'in', ACTIVE)
        .select([
          'queue_key',
          sql<number>`count(*)::int`.as('open'),
          sql<number>`(count(*) filter (where due_at <= ${now}))::int`.as('overdue'),
          sql<number>`(count(*) filter (where due_at > ${now} and due_at <= ${soon}))::int`.as('due_soon'),
        ])
        .groupBy('queue_key')
        .execute();
    },
    async oldestOpen() {
      return db.selectFrom('items').where('state', 'in', ACTIVE).distinctOn('queue_key').select(['queue_key', 'id', 'ref', 'subject_ref', 'opened_at']).orderBy('queue_key').orderBy('opened_at').execute();
    },
    async assignedCounts(staffId) {
      return db.selectFrom('items').where('state', 'in', ACTIVE).where('assignee_staff_id', '=', staffId).select(['queue_key', sql<number>`count(*)::int`.as('n')]).groupBy('queue_key').execute();
    },
    async sellerTaskCounts(sellerId) {
      if (!isUuid(sellerId)) return [];
      return db.selectFrom('items').where('state', 'in', ACTIVE).where('visible_to_seller', '=', true).where('seller_id', '=', sellerId).select(['kind', sql<number>`count(*)::int`.as('n')]).groupBy('kind').execute();
    },
    async openedBetween(from, to) {
      return db.selectFrom('items').where('opened_at', '>=', from).where('opened_at', '<', to).select(['queue_key', sql<number>`count(*)::int`.as('n')]).groupBy('queue_key').execute();
    },
    async resolvedBetween(from, to) {
      const rows = await db.selectFrom('items').where('state', '=', 'resolved').where('resolved_at', '>=', from).where('resolved_at', '<', to).select(['queue_key', 'opened_at', 'resolved_at']).execute();
      return rows.map((r) => ({ queue_key: r.queue_key, opened_at: r.opened_at, resolved_at: r.resolved_at! }));
    },
    async closedBefore(before, limit) {
      return (await db.selectFrom('items').selectAll().where('state', 'in', CLOSED).where('resolved_at', '<', before).orderBy('resolved_at').limit(limit).execute()).map(item);
    },
    async deleteItems(ids) {
      if (!ids.length) return;
      await db.deleteFrom('item_events').where('item_id', 'in', ids).execute();
      await db.deleteFrom('item_notes').where('item_id', 'in', ids).execute();
      await db.deleteFrom('items').where('id', 'in', ids).execute();
    },

    /* ---------------------------------------------------------------- history and notes */
    async insertEvent(row) {
      await db.insertInto('item_events').values(enc('item_events', row)).execute();
    },
    eventsOf: (itemId) => db.selectFrom('item_events').selectAll().where('item_id', '=', itemId).orderBy('at').orderBy('id').execute(),
    async eventsOfItems(itemIds) {
      if (!itemIds.length) return [];
      return db.selectFrom('item_events').selectAll().where('item_id', 'in', itemIds).orderBy('at').orderBy('id').execute();
    },
    async hasEvent(itemId, kind) {
      return Boolean(await db.selectFrom('item_events').select('id').where('item_id', '=', itemId).where('kind', '=', kind).executeTakeFirst());
    },
    async insertNote(row) {
      await db.insertInto('item_notes').values(row).execute();
    },
    notesOf: (itemId) => db.selectFrom('item_notes').selectAll().where('item_id', '=', itemId).orderBy('at').orderBy('id').execute(),
    async notesOfItems(itemIds) {
      if (!itemIds.length) return [];
      return db.selectFrom('item_notes').selectAll().where('item_id', 'in', itemIds).orderBy('at').orderBy('id').execute();
    },

    /* ---------------------------------------------------------------- saved filters */
    async getSavedFilter(id) {
      if (!isUuid(id)) return null;
      return (await db.selectFrom('saved_filters').selectAll().where('id', '=', id).executeTakeFirst()) ?? null;
    },
    listSavedFilters: (staffId) =>
      db
        .selectFrom('saved_filters')
        .selectAll()
        .where((eb) => eb.or([eb('owner_staff_id', '=', staffId), eb('shared', '=', true)]))
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    async insertSavedFilter(row) {
      await db.insertInto('saved_filters').values(enc('saved_filters', row)).execute();
    },
    async updateSavedFilter(id, patch) {
      return db.updateTable('saved_filters').set(enc('saved_filters', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async deleteSavedFilter(id) {
      await db.deleteFrom('saved_filters').where('id', '=', id).execute();
    },

    /* ---------------------------------------------------------------- day-end reviews */
    async reviewByDate(date, opts) {
      let q = db.selectFrom('day_end_reviews').selectAll().where('date', '=', date);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? review(r) : null;
    },
    async getReview(id, opts) {
      if (!isUuid(id)) return null;
      let q = db.selectFrom('day_end_reviews').selectAll().where('id', '=', id);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? review(r) : null;
    },
    async insertReview(row) {
      await db.insertInto('day_end_reviews').values(enc('day_end_reviews', row)).onConflict((oc) => oc.column('date').doNothing()).execute();
      return review(await db.selectFrom('day_end_reviews').selectAll().where('date', '=', row.date).executeTakeFirstOrThrow());
    },
    async updateReview(id, patch) {
      return review(await db.updateTable('day_end_reviews').set(enc('day_end_reviews', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow());
    },
    async listReviews(filter, page) {
      let q = db.selectFrom('day_end_reviews').selectAll();
      if (filter.from) q = q.where('date', '>=', filter.from);
      if (filter.to) q = q.where('date', '<=', filter.to);
      if (filter.state) q = q.where('state', '=', filter.state);
      const res = await paginate(q, page, { column: 'date', direction: 'desc' });
      return { ...res, items: res.items.map(review) };
    },

    /* ---------------------------------------------------------------- routines */
    async listTemplates(opts) {
      let q = db.selectFrom('routine_templates').selectAll().orderBy('due_time').orderBy('title');
      if (opts?.activeOnly) q = q.where('active', '=', true);
      return q.execute();
    },
    async countTemplates() {
      const r = await db.selectFrom('routine_templates').select(sql<number>`count(*)::int`.as('n')).executeTakeFirst();
      return r?.n ?? 0;
    },
    async upsertTemplate(row) {
      const v = enc('routine_templates', row);
      await db
        .insertInto('routine_templates')
        .values(v)
        .onConflict((oc) => oc.column('id').doUpdateSet({ title: v.title, area_label: v.area_label, owner_roles: v.owner_roles, due_time: v.due_time, weekdays: v.weekdays, active: v.active }))
        .execute();
    },
    async deactivateTemplatesExcept(ids) {
      let q = db.updateTable('routine_templates').set({ active: false });
      if (ids.length) q = q.where('id', 'not in', ids);
      await q.execute();
    },
    async checksOn(date) {
      return (await db.selectFrom('routine_checks').selectAll().where('date', '=', date).orderBy('due_at').orderBy('id').execute()).map(check);
    },
    async getCheck(id, opts) {
      if (!isUuid(id)) return null;
      let q = db.selectFrom('routine_checks').selectAll().where('id', '=', id);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? check(r) : null;
    },
    async insertCheck(row) {
      await db
        .insertInto('routine_checks')
        .values(enc('routine_checks', row))
        .onConflict((oc) => oc.columns(['template_id', 'date']).doNothing())
        .execute();
    },
    async updateCheck(id, patch) {
      return check(await db.updateTable('routine_checks').set(enc('routine_checks', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow());
    },
    async markChecksLate(opts) {
      if (!opts.beforeDate && !opts.dueBefore) return 0;
      const r = await db
        .updateTable('routine_checks')
        .set({ state: 'late' })
        .where('state', 'in', ['not_done', 'in_progress'])
        .where((eb) => {
          const or: Expression<SqlBool>[] = [];
          if (opts.beforeDate) or.push(eb('date', '<', opts.beforeDate));
          if (opts.dueBefore) or.push(eb('due_at', '<', opts.dueBefore));
          return eb.or(or);
        })
        .executeTakeFirst();
      return Number(r.numUpdatedRows ?? 0);
    },

    /* ---------------------------------------------------------------- daily counts */
    async upsertDailyCounts(rows) {
      if (!rows.length) return;
      await db
        .insertInto('daily_counts')
        .values(rows)
        .onConflict((oc) =>
          oc.columns(['queue_key', 'date']).doUpdateSet((eb) => ({
            open: eb.ref('excluded.open'),
            overdue: eb.ref('excluded.overdue'),
            opened: eb.ref('excluded.opened'),
            resolved: eb.ref('excluded.resolved'),
            median_resolve_minutes: eb.ref('excluded.median_resolve_minutes'),
          })),
        )
        .execute();
    },
    async dailyCounts(date) {
      return (await db.selectFrom('daily_counts').selectAll().where('date', '=', date).execute()).map(counts);
    },
  };
  return self;
}
