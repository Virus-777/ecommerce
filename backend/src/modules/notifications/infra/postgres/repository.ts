import { sql, type Kysely, type Transaction } from 'kysely';
import { paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { NotificationsDb } from '../../../../spec/notifications.js';
import type {
  BroadcastRow,
  DeliveryEventRow,
  DeliveryFilter,
  DeliveryRow,
  InboxFilter,
  InboxOwner,
  InboxRow,
  MemberPrefRow,
  NoticeRow,
  NotificationsRepository,
  PushDeviceRow,
  RecipientRow,
  ScheduledRow,
  StaffPrefRow,
  SubjectKey,
  SuppressionFilter,
  SuppressionRow,
  TemplateRow,
  TopicRow,
  VersionRow,
} from '../../ports.js';

type Db = Kysely<NotificationsDb> | Transaction<NotificationsDb>;

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSONB: Record<string, readonly string[]> = {
  topics: ['triggers', 'channels', 'staff_role_keys', 'variables'],
  template_versions: ['content'],
  notices: ['link'],
  scheduled_notifications: ['input'],
  member_preferences: ['groups'],
  staff_preferences: ['email_by_area'],
  broadcasts: ['segment', 'stats'],
};

function enc<T extends object>(table: string, row: T): T {
  const cols = JSONB[table];
  if (!cols) return row;
  const out = { ...row } as Record<string, unknown>;
  for (const c of cols) if (c in out && out[c] !== undefined && typeof out[c] !== 'string') out[c] = JSON.stringify(out[c]);
  return out as T;
}

const SUBJECT_KEYS = new Set<SubjectKey>(['orderId', 'returnId', 'caseId', 'conversationId', 'groupId']);
const subjectKey = (k: SubjectKey) => {
  if (!SUBJECT_KEYS.has(k)) throw new Error(`unknown subject key ${k}`);
  return k;
};

/** Postgres adapter for NotificationsRepository. `db` is scoped to the `notifications` schema. */
export function createPostgresNotificationsRepository(db: Kysely<NotificationsDb>): NotificationsRepository {
  return repo(db, false);
}

function repo(db: Db, inTx: boolean): NotificationsRepository {
  const inboxBase = (owner: InboxOwner) => {
    if (owner.kind === 'staff') {
      return db
        .selectFrom('notices as n')
        .innerJoin('notice_recipients as r', (j) => j.onRef('r.notice_id', '=', 'n.id').on('r.account_id', '=', owner.accountId))
        .where('n.address_kind', 'in', ['role', 'staff']);
    }
    const q = db.selectFrom('notices as n').leftJoin('notice_recipients as r', (j) => j.onRef('r.notice_id', '=', 'n.id').on('r.account_id', '=', owner.accountId));
    if (owner.kind === 'customer') return q.where('n.address_kind', '=', 'customer').where('n.address_id', '=', owner.accountId);
    const direct = `${owner.sellerId}/${owner.accountId}`;
    return q
      .where('n.address_kind', '=', 'seller')
      .where('n.seller_id', '=', owner.sellerId)
      .where((eb) =>
        eb.or([
          eb.and([eb('n.address_id', '=', owner.sellerId), owner.topicKeys.length ? eb('n.topic_key', 'in', owner.topicKeys) : sql<boolean>`false`]),
          eb('n.address_id', '=', direct),
        ]),
      );
  };

  const filtered = (owner: InboxOwner, f: InboxFilter) => {
    let q = inboxBase(owner).selectAll('n').select(['r.read_at', 'r.reason', 'r.covering_for']);
    if (f.group) q = q.where('n.group_key', '=', f.group);
    if (f.unreadOnly) q = q.where('r.read_at', 'is', null);
    if (f.actionRequired === true || f.openActionOnly) q = q.where('n.action_required', '=', true).where('n.resolved_at', 'is', null).where('n.expired_at', 'is', null);
    if (f.actionRequired === false) q = q.where('n.action_required', '=', false);
    if (f.topicKeys) q = f.topicKeys.length ? q.where('n.topic_key', 'in', f.topicKeys) : q.where(sql<boolean>`false`);
    if (f.mentionsOnly) q = q.where('r.reason', '=', 'mention');
    return q;
  };

  const self: NotificationsRepository = {
    async transaction(fn) {
      if (inTx) return fn(self);
      return (db as Kysely<NotificationsDb>).transaction().execute((trx) => fn(repo(trx, true)));
    },
    claim: (inbox, key) => inbox.claim(db, key),

    /* ---------------------------------------------------------------- topics and templates */
    listTopics: () => db.selectFrom('topics').selectAll().execute(),
    async upsertTopics(rows) {
      if (!rows.length) return;
      await db
        .insertInto('topics')
        .values(rows.map((r) => enc('topics', r)))
        .onConflict((oc) =>
          oc.column('key').doUpdateSet((eb) => ({
            audience: eb.ref('excluded.audience'),
            category: eb.ref('excluded.category'),
            group_key: eb.ref('excluded.group_key'),
            label: eb.ref('excluded.label'),
            description: eb.ref('excluded.description'),
            triggers: eb.ref('excluded.triggers'),
            opens: eb.ref('excluded.opens'),
            action_required: eb.ref('excluded.action_required'),
            staff_role_keys: eb.ref('excluded.staff_role_keys'),
            seller_permission: eb.ref('excluded.seller_permission'),
            owner_only: eb.ref('excluded.owner_only'),
            frequency_label: eb.ref('excluded.frequency_label'),
            variables: eb.ref('excluded.variables'),
            phase: eb.ref('excluded.phase'),
          })),
        )
        .execute();
    },
    updateTopicChannels: (key, channels, by, at) =>
      db.updateTable('topics').set({ channels: JSON.stringify(channels), updated_by: by, updated_at: at }).where('key', '=', key).returningAll().executeTakeFirst(),
    listTemplates: () => db.selectFrom('templates').selectAll().orderBy('topic_key').orderBy('channel').execute(),
    getTemplate: (id) => db.selectFrom('templates').selectAll().where('id', '=', id).executeTakeFirst(),
    templateFor: (topicKey, channel, language) =>
      db.selectFrom('templates').selectAll().where('topic_key', '=', topicKey).where('channel', '=', channel).where('language', '=', language).executeTakeFirst(),
    async seedTemplates(items) {
      if (!items.length) return 0;
      return self.transaction(async (tx) => {
        const d = txDb(tx) ?? db;
        const inserted = await d
          .insertInto('templates')
          .values(items.map((i) => ({ ...i.template, live_version_id: null })))
          .onConflict((oc) => oc.columns(['topic_key', 'channel', 'language']).doNothing())
          .returning('id')
          .execute();
        const ids = new Set(inserted.map((x) => x.id));
        const fresh = items.filter((i) => ids.has(i.template.id));
        if (!fresh.length) return 0;
        await d.insertInto('template_versions').values(fresh.map((i) => enc('template_versions', i.version))).execute();
        for (const i of fresh) await d.updateTable('templates').set({ live_version_id: i.version.id }).where('id', '=', i.template.id).execute();
        return fresh.length;
      });
    },
    versionsOf: (ids) => (ids.length ? db.selectFrom('template_versions').selectAll().where('template_id', 'in', ids).orderBy('version', 'desc').execute() : Promise.resolve([])),
    getVersion: (id, opts) => {
      const q = db.selectFrom('template_versions').selectAll().where('id', '=', id);
      return (opts?.forUpdate ? q.forUpdate() : q).executeTakeFirst();
    },
    insertVersion: (row) => db.insertInto('template_versions').values(enc('template_versions', row)).returningAll().executeTakeFirstOrThrow(),
    updateVersion: (id, patch) => db.updateTable('template_versions').set(enc('template_versions', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow(),
    async updateTemplate(id, patch) {
      await db.updateTable('templates').set(patch).where('id', '=', id).execute();
    },
    async liveVersions() {
      const rows = await db
        .selectFrom('templates as t')
        .innerJoin('template_versions as v', 'v.id', 't.live_version_id')
        .select(['t.topic_key', 't.channel'])
        .selectAll('v')
        .execute();
      return rows.map(({ topic_key, channel, ...v }) => ({ topic_key, channel, version: v as unknown as VersionRow }));
    },

    /* ---------------------------------------------------------------- notices */
    async insertNotice(row) {
      await db.insertInto('notices').values(enc('notices', row)).execute();
    },
    async insertRecipients(rows) {
      if (!rows.length) return;
      await db.insertInto('notice_recipients').values(rows).onConflict((oc) => oc.columns(['notice_id', 'account_id']).doNothing()).execute();
    },
    async noticeExists(q) {
      const row = await db
        .selectFrom('notices')
        .select('id')
        .where('dedupe_key', '=', q.dedupeKey)
        .where('topic_key', '=', q.topicKey)
        .where('address_kind', '=', q.addressKind as NoticeRow['address_kind'])
        .where('address_id', '=', q.addressId)
        .where('created_at', '>=', q.since)
        .executeTakeFirst();
      return Boolean(row);
    },
    async listInbox(owner, f, page) {
      const result = await paginate(filtered(owner, f), page, { column: 'n.created_at', direction: 'desc', id: 'n.id' });
      return result as never;
    },
    async inboxRows(owner, f, limit = 200) {
      return (await filtered(owner, f).orderBy('n.created_at', 'desc').limit(limit).execute()) as InboxRow[];
    },
    async inboxCounts(owner) {
      const rows = await inboxBase(owner)
        .select([
          'n.group_key as group',
          sql<number>`count(*)::int`.as('total'),
          sql<number>`(count(*) filter (where r.read_at is null))::int`.as('unread'),
          sql<number>`(count(*) filter (where n.action_required and n.resolved_at is null and n.expired_at is null))::int`.as('openActions'),
          sql<number>`(count(*) filter (where r.reason = 'mention' and r.read_at is null))::int`.as('mentionsUnread'),
        ])
        .groupBy('n.group_key')
        .execute();
      return rows as { group: string; total: number; unread: number; openActions: number; mentionsUnread: number }[];
    },
    async getInboxNotice(owner, noticeId) {
      return (await filtered(owner, {}).where('n.id', '=', noticeId).executeTakeFirst()) as InboxRow | undefined;
    },
    async markRead(owner, ids, at, f = {}) {
      if (ids !== 'all' && !ids.length) return 0;
      if (owner.kind === 'staff') {
        let sub = inboxBase(owner).select('n.id');
        if (ids !== 'all') sub = sub.where('n.id', 'in', ids);
        if (f.group) sub = sub.where('n.group_key', '=', f.group);
        const r = await db
          .updateTable('notice_recipients')
          .set({ read_at: at })
          .where('account_id', '=', owner.accountId)
          .where('read_at', 'is', null)
          .where('notice_id', 'in', sub)
          .executeTakeFirst();
        return Number(r.numUpdatedRows);
      }
      let sel = inboxBase(owner).select([
        'n.id as notice_id',
        sql<string>`${owner.accountId}::uuid`.as('account_id'),
        sql<string>`${owner.kind === 'seller' ? 'member' : 'direct'}`.as('reason'),
        sql<string | null>`null`.as('covering_for'),
        sql<Date>`${at}::timestamptz`.as('read_at'),
        sql<Date>`${at}::timestamptz`.as('created_at'),
      ]);
      if (ids !== 'all') sel = sel.where('n.id', 'in', ids);
      if (f.group) sel = sel.where('n.group_key', '=', f.group);
      sel = sel.where('r.read_at', 'is', null);
      const r = await db
        .insertInto('notice_recipients')
        .columns(['notice_id', 'account_id', 'reason', 'covering_for', 'read_at', 'created_at'])
        .expression(sel as never)
        .onConflict((oc) => oc.columns(['notice_id', 'account_id']).doUpdateSet({ read_at: at }).where('notice_recipients.read_at', 'is', null))
        .executeTakeFirst();
      return Number(r.numInsertedOrUpdatedRows ?? 0);
    },
    recipientsOf: (ids) => (ids.length ? db.selectFrom('notice_recipients').selectAll().where('notice_id', 'in', ids).orderBy('created_at').execute() : Promise.resolve([])),
    async resolveNotices(dedupeKey, note, at) {
      const r = await db
        .updateTable('notices')
        .set({ resolved_at: at, resolve_note: note })
        .where('dedupe_key', '=', dedupeKey)
        .where('action_required', '=', true)
        .where('resolved_at', 'is', null)
        .where('expired_at', 'is', null)
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    },
    async addresseeOf(audience, key, value) {
      const row = await db
        .selectFrom('notices')
        .select(['address_id', 'seller_id', sql<Record<string, string> | null>`link->'subjects'`.as('subjects')])
        .where('address_kind', '=', audience)
        .where(sql<boolean>`link->'subjects'->>${subjectKey(key)} = ${value}`)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row ? { addressId: row.address_id, sellerId: row.seller_id, subjects: row.subjects ?? {} } : undefined;
    },
    async subjectsWith(key, value) {
      const rows = await db
        .selectFrom('notices')
        .select(sql<Record<string, string> | null>`link->'subjects'`.as('subjects'))
        .where(sql<boolean>`link->'subjects'->>${subjectKey(key)} = ${value}`)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute();
      const out: Record<string, string> = {};
      for (const r of rows.reverse()) Object.assign(out, r.subjects ?? {});
      return out;
    },
    openRoleNotices: (roleKey) =>
      db.selectFrom('notices').selectAll().where('address_kind', '=', 'role').where('address_id', '=', roleKey).where('action_required', '=', true).where('resolved_at', 'is', null).where('expired_at', 'is', null).execute(),
    recentRoleNotices: (roleKeys, since) =>
      roleKeys.length
        ? db.selectFrom('notices').selectAll().where('address_kind', '=', 'role').where('address_id', 'in', roleKeys).where('created_at', '>=', since).execute()
        : Promise.resolve([]),
    findNotice: (id) => db.selectFrom('notices').selectAll().where('id', '=', id).executeTakeFirst(),
    async latestNotice(q) {
      let s = db.selectFrom('notices').selectAll();
      if (q.linkedRef) s = s.where('linked_ref', '=', q.linkedRef);
      if (q.topicKey) s = s.where('topic_key', '=', q.topicKey);
      if (q.subject) s = s.where(sql<boolean>`link->'subjects'->>${subjectKey(q.subject.key)} = ${q.subject.value}`);
      return s.orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    },
    async purgeNotices(before) {
      const old = db.selectFrom('notices').select('id').where('expires_at', '<', before);
      await db.updateTable('deliveries').set({ notice_id: null }).where('notice_id', 'in', old).execute();
      await db.deleteFrom('notice_recipients').where('notice_id', 'in', old).execute();
      const r = await db.deleteFrom('notices').where('expires_at', '<', before).executeTakeFirst();
      return Number(r.numDeletedRows);
    },
    async expireActionNotices(deadlineBefore, at) {
      const r = await db
        .updateTable('notices')
        // expired, never resolved: shown as "No longer needed"
        .set({ expired_at: at })
        .where('action_required', '=', true)
        .where('resolved_at', 'is', null)
        .where('expired_at', 'is', null)
        .where('deadline_at', '<', deadlineBefore)
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    },
    unreadSince: (accountId, since) =>
      db
        .selectFrom('notices as n')
        .innerJoin('notice_recipients as r', (j) => j.onRef('r.notice_id', '=', 'n.id').on('r.account_id', '=', accountId))
        .selectAll('n')
        .where('n.address_kind', 'in', ['role', 'staff'])
        .where('r.read_at', 'is', null)
        .where('n.created_at', '>=', since)
        .orderBy('n.created_at', 'desc')
        .limit(50)
        .execute(),

    /* ---------------------------------------------------------------- scheduled */
    async insertScheduled(row) {
      await db.insertInto('scheduled_notifications').values(enc('scheduled_notifications', row)).execute();
    },
    async cancelScheduled(key) {
      const r = await db.updateTable('scheduled_notifications').set({ status: 'cancelled' }).where('dedupe_key', '=', key).where('status', '=', 'pending').executeTakeFirst();
      return Number(r.numUpdatedRows);
    },
    async hasPendingScheduled(key) {
      return Boolean(await db.selectFrom('scheduled_notifications').select('id').where('dedupe_key', '=', key).where('status', '=', 'pending').executeTakeFirst());
    },
    dueScheduled: (now, limit) =>
      db.selectFrom('scheduled_notifications').selectAll().where('status', '=', 'pending').where('send_at', '<=', now).orderBy('send_at').limit(limit).execute(),
    async markScheduled(id, status) {
      const r = await db.updateTable('scheduled_notifications').set({ status }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
      return Number(r.numUpdatedRows) > 0;
    },

    /* ---------------------------------------------------------------- deliveries */
    async insertDeliveries(rows) {
      if (rows.length) await db.insertInto('deliveries').values(rows).execute();
    },
    async linkedRefOf(dedupeKey) {
      const row = await db.selectFrom('deliveries').select('linked_ref').where('dedupe_key', '=', dedupeKey).where('linked_ref', 'is not', null).limit(1).executeTakeFirst();
      return row?.linked_ref ?? null;
    },
    async deliveryExists(q) {
      const row = await db
        .selectFrom('deliveries')
        .select('id')
        .where('dedupe_key', '=', q.dedupeKey)
        .where('topic_key', '=', q.topicKey)
        .where('address_hash', '=', q.addressHash)
        .where('channel', '=', q.channel)
        .where('status', '!=', 'skipped')
        .where('created_at', '>=', q.since)
        .executeTakeFirst();
      return Boolean(row);
    },
    getDelivery: (id) => db.selectFrom('deliveries').selectAll().where('id', '=', id).executeTakeFirst(),
    transitionDelivery: (id, from, patch) => db.updateTable('deliveries').set(patch).where('id', '=', id).where('status', 'in', from).returningAll().executeTakeFirst(),
    deliveryByProviderMessage: (pid) => db.selectFrom('deliveries').selectAll().where('provider_message_id', '=', pid).orderBy('created_at', 'desc').limit(1).executeTakeFirst(),
    latestDeliveryTo: (hash) => db.selectFrom('deliveries').selectAll().where('address_hash', '=', hash).orderBy('created_at', 'desc').limit(1).executeTakeFirst(),
    async listDeliveries(f, page) {
      let q = db.selectFrom('deliveries').selectAll();
      if (f.channel) q = q.where('channel', '=', f.channel);
      if (f.status) q = q.where('status', '=', f.status);
      if (f.topicKey) q = q.where('topic_key', '=', f.topicKey);
      if (f.accountId) q = q.where('account_id', '=', f.accountId);
      if (f.addressHash) q = q.where('address_hash', '=', f.addressHash);
      if (f.linkedRef) q = q.where('linked_ref', '=', f.linkedRef);
      if (f.from) q = q.where('created_at', '>=', f.from);
      if (f.to) q = q.where('created_at', '<=', f.to);
      return paginate(q, page, { column: 'created_at', direction: 'desc' });
    },
    dueDeliveries: (statuses, now, limit) =>
      db
        .selectFrom('deliveries')
        .selectAll()
        .where('status', 'in', statuses)
        .where((eb) => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now)]))
        .orderBy('created_at')
        .limit(limit)
        .execute(),
    async skipQueuedFor(accountId, reason, topicKeys) {
      if (!topicKeys.length) return 0;
      const r = await db
        .updateTable('deliveries')
        .set({ status: 'skipped', skip_reason: reason, next_attempt_at: null })
        .where('account_id', '=', accountId)
        .where('status', 'in', ['queued'])
        .where('topic_key', 'in', topicKeys)
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    },
    async insertDeliveryEvent(row) {
      const r = await db.insertInto('delivery_events').values(row).onConflict((oc) => oc.column('provider_event_id').doNothing()).executeTakeFirst();
      return Number(r.numInsertedOrUpdatedRows ?? 0) > 0;
    },
    deliveryEvents: (id) => db.selectFrom('delivery_events').selectAll().where('delivery_id', '=', id).orderBy('at').execute(),
    async deliveryCounts(q) {
      let s = db
        .selectFrom('deliveries')
        .select(['status', 'broadcast_id', sql<number>`count(*)::int`.as('n')])
        .where('created_at', '>=', q.from)
        .where('created_at', '<', q.to);
      if (q.channel) s = s.where('channel', '=', q.channel);
      if (q.broadcastIds) s = q.broadcastIds.length ? s.where('broadcast_id', 'in', q.broadcastIds) : s.where(sql<boolean>`false`);
      return s.groupBy(['status', 'broadcast_id']).execute();
    },
    async countDeliveries(q) {
      let s = db.selectFrom('deliveries').select(sql<number>`count(*)::int`.as('n')).where('status', 'in', q.statuses);
      if (q.from) s = s.where('created_at', '>=', q.from);
      return (await s.executeTakeFirst())?.n ?? 0;
    },
    async purgeDeliveries(before) {
      const old = db.selectFrom('deliveries').select('id').where('created_at', '<', before);
      await db.deleteFrom('delivery_events').where('delivery_id', 'in', old).execute();
      const r = await db.deleteFrom('deliveries').where('created_at', '<', before).executeTakeFirst();
      return Number(r.numDeletedRows);
    },

    /* ---------------------------------------------------------------- suppressions */
    activeSuppression: (channel, hash) =>
      db.selectFrom('suppressions').selectAll().where('channel', '=', channel).where('address_hash', '=', hash).where('removed_at', 'is', null).executeTakeFirst(),
    activeSuppressions: (channel, hashes) =>
      hashes.length
        ? db.selectFrom('suppressions').selectAll().where('channel', '=', channel).where('address_hash', 'in', hashes).where('removed_at', 'is', null).execute()
        : Promise.resolve([]),
    insertSuppression: (row) =>
      db
        .insertInto('suppressions')
        .values(row)
        .onConflict((oc) => oc.columns(['channel', 'address_hash']).where('removed_at', 'is', null).doNothing())
        .returningAll()
        .executeTakeFirst(),
    getSuppression: (id) => db.selectFrom('suppressions').selectAll().where('id', '=', id).executeTakeFirst(),
    updateSuppression: (id, patch) => db.updateTable('suppressions').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow(),
    async listSuppressions(f, page) {
      let q = db.selectFrom('suppressions').selectAll();
      if (f.channel) q = q.where('channel', '=', f.channel);
      if (f.reason) q = q.where('reason', '=', f.reason);
      if (f.accountId) q = q.where('account_id', '=', f.accountId);
      if (f.addressHash) q = q.where('address_hash', '=', f.addressHash);
      if (f.active === true) q = q.where('removed_at', 'is', null);
      if (f.active === false) q = q.where('removed_at', 'is not', null);
      return paginate(q, page, { column: 'created_at', direction: 'desc' });
    },
    async countActiveSuppressions() {
      return (await db.selectFrom('suppressions').select(sql<number>`count(*)::int`.as('n')).where('removed_at', 'is', null).executeTakeFirst())?.n ?? 0;
    },

    /* ---------------------------------------------------------------- preferences */
    memberPreferences: (sellerId) => db.selectFrom('member_preferences').selectAll().where('seller_id', '=', sellerId).orderBy('updated_at').execute(),
    memberPreference: (sellerId, memberId) => db.selectFrom('member_preferences').selectAll().where('seller_id', '=', sellerId).where('member_id', '=', memberId).executeTakeFirst(),
    async ensureMemberPreference(row) {
      const inserted = await db
        .insertInto('member_preferences')
        .values(enc('member_preferences', row))
        .onConflict((oc) => oc.columns(['seller_id', 'member_id']).doNothing())
        .returningAll()
        .executeTakeFirst();
      return inserted ?? (await self.memberPreference(row.seller_id, row.member_id))!;
    },
    upsertMemberPreference: (row) =>
      db
        .insertInto('member_preferences')
        .values(enc('member_preferences', row))
        .onConflict((oc) =>
          oc.columns(['seller_id', 'member_id']).doUpdateSet((eb) => ({
            account_id: eb.ref('excluded.account_id'),
            groups: eb.ref('excluded.groups'),
            channel: eb.ref('excluded.channel'),
            updated_by: eb.ref('excluded.updated_by'),
            updated_at: eb.ref('excluded.updated_at'),
          })),
        )
        .returningAll()
        .executeTakeFirstOrThrow(),
    promotionsMembers: () => db.selectFrom('member_preferences').selectAll().where(sql<boolean>`(groups->>'promotions')::boolean is true`).execute(),
    staffPreference: (accountId) => db.selectFrom('staff_preferences').selectAll().where('account_id', '=', accountId).executeTakeFirst(),
    staffPreferences: (ids) => (ids.length ? db.selectFrom('staff_preferences').selectAll().where('account_id', 'in', ids).execute() : Promise.resolve([])),
    upsertStaffPreference: (row) =>
      db
        .insertInto('staff_preferences')
        .values(enc('staff_preferences', row))
        .onConflict((oc) =>
          oc.column('account_id').doUpdateSet((eb) => ({
            email_by_area: eb.ref('excluded.email_by_area'),
            email_for_mentions: eb.ref('excluded.email_for_mentions'),
            daily_digest: eb.ref('excluded.daily_digest'),
            updated_at: eb.ref('excluded.updated_at'),
          })),
        )
        .returningAll()
        .executeTakeFirstOrThrow(),
    digestSubscribers: () => db.selectFrom('staff_preferences').selectAll().where('daily_digest', '=', true).execute(),

    /* ---------------------------------------------------------------- push devices */
    pushDevices(q) {
      if (!q.accountIds.length) return Promise.resolve([]);
      let s = db.selectFrom('push_devices').selectAll().where('account_id', 'in', q.accountIds).where('audience', '=', q.audience);
      if (q.sellerId) s = s.where('seller_id', '=', q.sellerId);
      if (q.activeOnly) s = s.where('invalidated_at', 'is', null).where('enabled', '=', true);
      else s = s.where('invalidated_at', 'is', null);
      return s.orderBy('created_at').execute();
    },
    pushDeviceByHash: (hash) => db.selectFrom('push_devices').selectAll().where('token_hash', '=', hash).executeTakeFirst(),
    pushDeviceByInstallation: (accountId, audience, installationId) =>
      db
        .selectFrom('push_devices')
        .selectAll()
        .where('account_id', '=', accountId)
        .where('audience', '=', audience as PushDeviceRow['audience'])
        .where('installation_id', '=', installationId)
        .where('invalidated_at', 'is', null)
        .executeTakeFirst(),
    getPushDevice: (id) => db.selectFrom('push_devices').selectAll().where('id', '=', id).executeTakeFirst(),
    insertPushDevice: (row) => db.insertInto('push_devices').values(row).returningAll().executeTakeFirstOrThrow(),
    updatePushDevice: (id, patch) => db.updateTable('push_devices').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow(),
    async setPushEnabled(accountId, audience, enabled) {
      const r = await db
        .updateTable('push_devices')
        .set({ enabled })
        .where('account_id', '=', accountId)
        .where('audience', '=', audience as PushDeviceRow['audience'])
        .where('invalidated_at', 'is', null)
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    },
    async invalidatePushDevices(accountId, at) {
      const r = await db.updateTable('push_devices').set({ invalidated_at: at, enabled: false }).where('account_id', '=', accountId).where('invalidated_at', 'is', null).executeTakeFirst();
      return Number(r.numUpdatedRows);
    },

    /* ---------------------------------------------------------------- broadcasts */
    insertBroadcast: (row) => db.insertInto('broadcasts').values(enc('broadcasts', row)).returningAll().executeTakeFirstOrThrow(),
    getBroadcast: (id, opts) => {
      const q = db.selectFrom('broadcasts').selectAll().where('id', '=', id);
      return (opts?.forUpdate ? q.forUpdate() : q).executeTakeFirst();
    },
    updateBroadcast: (id, patch) => db.updateTable('broadcasts').set(enc('broadcasts', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow(),
    async listBroadcasts(f, page) {
      let q = db.selectFrom('broadcasts').selectAll();
      if (f.status) q = q.where('status', '=', f.status);
      if (f.audience) q = q.where('audience', '=', f.audience);
      return paginate(q, page, { column: 'created_at', direction: 'desc' });
    },
    dueBroadcasts: (now, limit) =>
      db.selectFrom('broadcasts').selectAll().where('status', '=', 'scheduled').where('scheduled_at', '<=', now).orderBy('scheduled_at').limit(limit).execute(),
  };
  txDbs.set(self, db);
  return self;
}

/** The query builder behind a repository (transactions hand out bound repositories) */
const txDbs = new WeakMap<NotificationsRepository, Db>();
const txDb = (r: NotificationsRepository) => txDbs.get(r);
