import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter } from '../../../../kernel/mongo/table.js';
import type {
  BroadcastRow,
  DeliveryEventRow,
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
  SuppressionRow,
  TemplateRow,
  TopicRow,
  VersionRow,
} from '../../ports.js';

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...values] });
/** Matches no row (SQL `where false`) */
const NONE: Filter = { id: { $in: [] } };

const SUBJECT_KEYS = new Set<SubjectKey>(['orderId', 'returnId', 'caseId', 'conversationId', 'groupId']);
/** The dotted path of a notice subject (link.subjects.<key>) */
const subjectPath = (k: SubjectKey) => {
  if (!SUBJECT_KEYS.has(k)) throw new Error(`unknown subject key ${k}`);
  return `link.subjects.${k}`;
};

function found<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`notifications: ${what} not found`);
  return row;
}

/** An open action notice: needs action, neither resolved nor expired */
const OPEN_ACTION: Filter = { action_required: true, resolved_at: null, expired_at: null };

/** MongoDB adapter for NotificationsRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoNotificationsRepository(store: ModuleStore): NotificationsRepository {
  const t = {
    topics: store.table<TopicRow>('topics'),
    templates: store.table<TemplateRow>('templates'),
    versions: store.table<VersionRow>('template_versions'),
    notices: store.table<NoticeRow>('notices'),
    recipients: store.table<RecipientRow>('notice_recipients'),
    scheduled: store.table<ScheduledRow>('scheduled_notifications'),
    deliveries: store.table<DeliveryRow>('deliveries'),
    deliveryEvents: store.table<DeliveryEventRow>('delivery_events'),
    memberPrefs: store.table<MemberPrefRow>('member_preferences'),
    staffPrefs: store.table<StaffPrefRow>('staff_preferences'),
    pushDevices: store.table<PushDeviceRow>('push_devices'),
    suppressions: store.table<SuppressionRow>('suppressions'),
    broadcasts: store.table<BroadcastRow>('broadcasts'),
  };

  /* ---------------------------------------------------------------- inboxes (a join is two reads) */

  /**
   * The notices of an owner's inbox. Staff see notices they are a recipient of (inner join); customers and sellers
   * see the notices addressed to them, with or without a recipient row of their own (left join: the row holds the
   * read state once they read it).
   */
  async function inboxBase(owner: InboxOwner): Promise<Filter> {
    if (owner.kind === 'staff') {
      const ids = await t.recipients.distinct<string>('notice_id', { account_id: owner.accountId });
      return { address_kind: oneOf(['role', 'staff']), id: oneOf(ids) };
    }
    if (owner.kind === 'customer') return { address_kind: 'customer', address_id: owner.accountId };
    return {
      address_kind: 'seller',
      seller_id: owner.sellerId,
      $or: [{ address_id: owner.sellerId, topic_key: oneOf(owner.topicKeys) }, { address_id: `${owner.sellerId}/${owner.accountId}` }],
    };
  }

  /** The inbox filter: notice fields directly, recipient fields (read state, reason) through the owner's recipient rows */
  async function inboxFilter(owner: InboxOwner, f: InboxFilter): Promise<Filter> {
    const and: Filter[] = [await inboxBase(owner)];
    if (f.group) and.push({ group_key: f.group });
    if (f.actionRequired === true || f.openActionOnly) and.push(OPEN_ACTION);
    if (f.actionRequired === false) and.push({ action_required: false });
    if (f.topicKeys) and.push({ topic_key: oneOf(f.topicKeys) });
    if (f.unreadOnly) {
      // r.read_at is null: no recipient row (left join) or one not read yet
      if (owner.kind === 'staff') and.push({ id: oneOf(await t.recipients.distinct<string>('notice_id', { account_id: owner.accountId, read_at: null })) });
      else and.push({ id: { $nin: await t.recipients.distinct<string>('notice_id', { account_id: owner.accountId, read_at: { $ne: null } }) } });
    }
    if (f.mentionsOnly) and.push({ id: oneOf(await t.recipients.distinct<string>('notice_id', { account_id: owner.accountId, reason: 'mention' })) });
    return and.length === 1 ? and[0]! : { $and: and };
  }

  /** Notices with the owner's read state, reason and cover */
  async function withReadState(accountId: string, notices: NoticeRow[]): Promise<InboxRow[]> {
    if (!notices.length) return [];
    const rows = await t.recipients.find({ account_id: accountId, notice_id: oneOf(notices.map((n) => n.id)) });
    const byNotice = new Map(rows.map((r) => [r.notice_id, r]));
    return notices.map((n) => {
      const r = byNotice.get(n.id);
      return { ...n, read_at: r?.read_at ?? null, reason: r?.reason ?? null, covering_for: r?.covering_for ?? null };
    });
  }

  const self: NotificationsRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoNotificationsRepository(tx))),
    claim: (key) => store.claim(key),

    /* ---------------------------------------------------------------- topics and templates */
    listTopics: () => t.topics.find(),
    async upsertTopics(rows) {
      // the catalogue refreshes every field from code; channels and who changed them stay as staff set them
      await t.topics.upsertMany(rows, {
        update: (r) => ({
          audience: r.audience,
          category: r.category,
          group_key: r.group_key,
          label: r.label,
          description: r.description,
          triggers: r.triggers,
          opens: r.opens,
          action_required: r.action_required,
          staff_role_keys: r.staff_role_keys,
          seller_permission: r.seller_permission,
          owner_only: r.owner_only,
          frequency_label: r.frequency_label,
          variables: r.variables,
          phase: r.phase,
        }),
      });
    },
    updateTopicChannels: (key, channels, by, at) => t.topics.update(key, { $set: { channels, updated_by: by, updated_at: at } }),
    listTemplates: () => t.templates.find({}, { sort: { topic_key: 1, channel: 1 } }),
    getTemplate: (id) => t.templates.get(id),
    templateFor: (topicKey, channel, language) => t.templates.findOne({ topic_key: topicKey, channel, language }),
    async seedTemplates(items) {
      if (!items.length) return 0;
      return store.transaction(async (tx) => {
        const txt = createTables(tx);
        const fresh: typeof items = [];
        for (const i of items) {
          if (await txt.templates.insertIfAbsent({ ...i.template, live_version_id: null }, ['topic_key', 'channel', 'language'])) fresh.push(i);
        }
        if (!fresh.length) return 0;
        await txt.versions.insertMany(fresh.map((i) => i.version));
        for (const i of fresh) await txt.templates.update(i.template.id, { live_version_id: i.version.id });
        return fresh.length;
      });
    },
    versionsOf: async (ids) => (ids.length ? t.versions.find({ template_id: oneOf(ids) }, { sort: { version: -1 } }) : []),
    getVersion: (id, opts) => t.versions.get(id, opts),
    insertVersion: (row) => t.versions.insert(row),
    updateVersion: async (id, patch) => found(await t.versions.update(id, patch), `template version ${id}`),
    async updateTemplate(id, patch) {
      await t.templates.update(id, patch);
    },
    async liveVersions() {
      const templates = await t.templates.find({ live_version_id: { $ne: null } });
      const versions = new Map((await t.versions.getMany(templates.map((x) => x.live_version_id))).map((v) => [v.id, v]));
      return templates.flatMap((x) => {
        const version = versions.get(x.live_version_id!);
        return version ? [{ topic_key: x.topic_key, channel: x.channel, version }] : [];
      });
    },

    /* ---------------------------------------------------------------- notices */
    async insertNotice(row) {
      await t.notices.insert(row);
    },
    async insertRecipients(rows) {
      await t.recipients.insertManyIfAbsent(rows, ['notice_id', 'account_id']);
    },
    noticeExists: (q) =>
      t.notices.exists({ dedupe_key: q.dedupeKey, topic_key: q.topicKey, address_kind: q.addressKind, address_id: q.addressId, created_at: { $gte: q.since } }),
    async listInbox(owner, f, page) {
      const result = await t.notices.page(await inboxFilter(owner, f), page, { column: 'created_at', direction: 'desc' });
      return { ...result, items: await withReadState(owner.accountId, result.items) };
    },
    async inboxRows(owner, f, limit = 200) {
      return withReadState(owner.accountId, await t.notices.find(await inboxFilter(owner, f), { sort: { created_at: -1, id: -1 }, limit }));
    },
    async inboxCounts(owner) {
      const isNull = (path: string) => ({ $eq: [{ $ifNull: [path, null] }, null] });
      const rows = await t.notices.aggregate<{ _id: string; total: number; unread: number; openActions: number; mentionsUnread: number }>([
        { $match: t.notices.filter(await inboxBase(owner)) },
        {
          $lookup: {
            from: `${store.module}.notice_recipients`,
            let: { nid: '$_id' },
            pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$notice_id', '$$nid'] }, { $eq: ['$account_id', owner.accountId] }] } } }, { $limit: 1 }],
            as: 'r',
          },
        },
        { $set: { r: { $first: '$r' } } },
        {
          $group: {
            _id: '$group_key',
            total: { $sum: 1 },
            unread: { $sum: { $cond: [isNull('$r.read_at'), 1, 0] } },
            openActions: { $sum: { $cond: [{ $and: [{ $eq: ['$action_required', true] }, isNull('$resolved_at'), isNull('$expired_at')] }, 1, 0] } },
            mentionsUnread: { $sum: { $cond: [{ $and: [{ $eq: ['$r.reason', 'mention'] }, isNull('$r.read_at')] }, 1, 0] } },
          },
        },
      ]);
      return rows.map(({ _id, ...counts }) => ({ group: _id, ...counts }));
    },
    async getInboxNotice(owner, noticeId) {
      const notice = await t.notices.findOne({ $and: [await inboxFilter(owner, {}), { id: noticeId }] });
      return notice ? (await withReadState(owner.accountId, [notice]))[0] : undefined;
    },
    async markRead(owner, ids, at, f = {}) {
      if (ids !== 'all' && !ids.length) return 0;
      const and: Filter[] = [await inboxBase(owner)];
      if (ids !== 'all') and.push({ id: oneOf(ids) });
      if (f.group) and.push({ group_key: f.group });
      const noticeIds = await t.notices.distinct<string>('id', { $and: and });
      if (!noticeIds.length) return 0;
      // rows already there and unread are marked read
      const updated = await t.recipients.updateMany({ account_id: owner.accountId, read_at: null, notice_id: oneOf(noticeIds) }, { read_at: at });
      if (owner.kind === 'staff') return updated;
      // customers and sellers get a recipient row the first time they read a notice addressed to their workspace
      const have = new Set(await t.recipients.distinct<string>('notice_id', { account_id: owner.accountId, notice_id: oneOf(noticeIds) }));
      const reason = owner.kind === 'seller' ? 'member' : 'direct';
      const inserted = await t.recipients.insertManyIfAbsent(
        noticeIds.filter((id) => !have.has(id)).map((id) => ({ notice_id: id, account_id: owner.accountId, reason, covering_for: null, read_at: at, created_at: at })),
        ['notice_id', 'account_id'],
      );
      return updated + inserted;
    },
    recipientsOf: async (ids) => (ids.length ? t.recipients.find({ notice_id: oneOf(ids) }, { sort: { created_at: 1 } }) : []),
    resolveNotices: (dedupeKey, note, at) => t.notices.updateMany({ dedupe_key: dedupeKey, ...OPEN_ACTION }, { resolved_at: at, resolve_note: note }),
    async addresseeOf(audience, key, value) {
      const row = await t.notices.findOne({ address_kind: audience, [subjectPath(key)]: value }, { sort: { created_at: -1 } });
      return row ? { addressId: row.address_id, sellerId: row.seller_id, subjects: subjectsOf(row) } : undefined;
    },
    async subjectsWith(key, value) {
      const rows = await t.notices.find({ [subjectPath(key)]: value }, { sort: { created_at: -1 }, limit: 20 });
      const out: Record<string, string> = {};
      for (const r of rows.reverse()) Object.assign(out, subjectsOf(r));
      return out;
    },
    openRoleNotices: (roleKey) => t.notices.find({ address_kind: 'role', address_id: roleKey, ...OPEN_ACTION }),
    recentRoleNotices: async (roleKeys, since) => (roleKeys.length ? t.notices.find({ address_kind: 'role', address_id: oneOf(roleKeys), created_at: { $gte: since } }) : []),
    findNotice: (id) => t.notices.get(id),
    latestNotice: (q) =>
      t.notices.findOne(
        {
          ...(q.linkedRef ? { linked_ref: q.linkedRef } : {}),
          ...(q.topicKey ? { topic_key: q.topicKey } : {}),
          ...(q.subject ? { [subjectPath(q.subject.key)]: q.subject.value } : {}),
        },
        { sort: { created_at: -1 } },
      ),
    async purgeNotices(before) {
      const old = await t.notices.distinct<string>('id', { expires_at: { $lt: before } });
      if (!old.length) return 0;
      await t.deliveries.updateMany({ notice_id: oneOf(old) }, { notice_id: null });
      await t.recipients.deleteMany({ notice_id: oneOf(old) });
      return t.notices.deleteMany({ id: oneOf(old) });
    },
    expireActionNotices: (cutoff, at) =>
      // expired, never resolved: shown as "No longer needed"
      t.notices.updateMany({ ...OPEN_ACTION, $or: [{ deadline_at: { $lt: cutoff } }, { deadline_at: null, created_at: { $lt: cutoff } }] }, { expired_at: at }),
    async unreadSince(accountId, since) {
      const ids = await t.recipients.distinct<string>('notice_id', { account_id: accountId, read_at: null });
      if (!ids.length) return [];
      return t.notices.find({ id: oneOf(ids), address_kind: oneOf(['role', 'staff']), created_at: { $gte: since } }, { sort: { created_at: -1 }, limit: 50 });
    },

    /* ---------------------------------------------------------------- scheduled */
    async insertScheduled(row) {
      await t.scheduled.insert(row);
    },
    cancelScheduled: (key) => t.scheduled.updateMany({ dedupe_key: key, status: 'pending' }, { status: 'cancelled' }),
    hasPendingScheduled: (key) => t.scheduled.exists({ dedupe_key: key, status: 'pending' }),
    dueScheduled: (now, limit) => t.scheduled.find({ status: 'pending', send_at: { $lte: now } }, { sort: { send_at: 1 }, limit }),
    async markScheduled(id, status) {
      return Boolean(await t.scheduled.updateOne({ id, status: 'pending' }, { status }));
    },

    /* ---------------------------------------------------------------- deliveries */
    async insertDeliveries(rows) {
      await t.deliveries.insertMany(rows);
    },
    async linkedRefOf(dedupeKey) {
      return (await t.deliveries.findOne({ dedupe_key: dedupeKey, linked_ref: { $ne: null } }))?.linked_ref ?? null;
    },
    deliveryExists: (q) =>
      t.deliveries.exists({ dedupe_key: q.dedupeKey, topic_key: q.topicKey, address_hash: q.addressHash, channel: q.channel, status: { $ne: 'skipped' }, created_at: { $gte: q.since } }),
    getDelivery: (id) => t.deliveries.get(id),
    transitionDelivery: (id, from, patch) => t.deliveries.updateOne({ id, status: oneOf(from) }, patch),
    deliveryByProviderMessage: (pid) => t.deliveries.findOne({ provider_message_id: pid }, { sort: { created_at: -1 } }),
    latestDeliveryTo: (hash) => t.deliveries.findOne({ address_hash: hash }, { sort: { created_at: -1 } }),
    listDeliveries: (f, page) =>
      t.deliveries.page(
        {
          ...(f.channel ? { channel: f.channel } : {}),
          ...(f.status ? { status: f.status } : {}),
          ...(f.topicKey ? { topic_key: f.topicKey } : {}),
          ...(f.accountId ? { account_id: f.accountId } : {}),
          ...(f.addressHash ? { address_hash: f.addressHash } : {}),
          ...(f.linkedRef ? { linked_ref: f.linkedRef } : {}),
          ...(f.from || f.to ? { created_at: { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) } } : {}),
        },
        page,
        { column: 'created_at', direction: 'desc' },
      ),
    dueDeliveries: (statuses, now, limit) =>
      t.deliveries.find({ status: oneOf(statuses), $or: [{ next_attempt_at: null }, { next_attempt_at: { $lte: now } }] }, { sort: { created_at: 1 }, limit }),
    async skipQueuedFor(accountId, reason, topicKeys) {
      if (!topicKeys.length) return 0;
      return t.deliveries.updateMany({ account_id: accountId, status: 'queued', topic_key: oneOf(topicKeys) }, { status: 'skipped', skip_reason: reason, next_attempt_at: null });
    },
    async insertDeliveryEvent(row) {
      // unique provider event id; events of our own (no provider id) are always recorded, as nulls never conflict
      if (row.provider_event_id == null) {
        await t.deliveryEvents.insert(row);
        return true;
      }
      return Boolean(await t.deliveryEvents.insertIfAbsent(row, ['provider_event_id']));
    },
    deliveryEvents: (id) => t.deliveryEvents.find({ delivery_id: id }, { sort: { at: 1 } }),
    async deliveryCounts(q) {
      if (q.broadcastIds && !q.broadcastIds.length) return [];
      const rows = await t.deliveries.aggregate<{ _id: { status: string; broadcast_id?: string | null }; n: number }>([
        {
          $match: t.deliveries.filter({
            created_at: { $gte: q.from, $lt: q.to },
            ...(q.channel ? { channel: q.channel } : {}),
            ...(q.broadcastIds ? { broadcast_id: oneOf(q.broadcastIds) } : {}),
          }),
        },
        { $group: { _id: { status: '$status', broadcast_id: '$broadcast_id' }, n: { $sum: 1 } } },
      ]);
      return rows.map((r) => ({ status: r._id.status, broadcast_id: r._id.broadcast_id ?? null, n: r.n }));
    },
    countDeliveries: (q) => t.deliveries.count({ status: oneOf(q.statuses), ...(q.from ? { created_at: { $gte: q.from } } : {}) }),
    async purgeDeliveries(before) {
      const old = await t.deliveries.distinct<string>('id', { created_at: { $lt: before } });
      if (!old.length) return 0;
      await t.deliveryEvents.deleteMany({ delivery_id: oneOf(old) });
      return t.deliveries.deleteMany({ id: oneOf(old) });
    },

    /* ---------------------------------------------------------------- suppressions */
    activeSuppression: (channel, hash) => t.suppressions.findOne({ channel, address_hash: hash, removed_at: null }),
    activeSuppressions: async (channel, hashes) => (hashes.length ? t.suppressions.find({ channel, address_hash: oneOf(hashes), removed_at: null }) : []),
    // unique (channel, address_hash) among active rows: inserted unless one is active
    insertSuppression: (row) => t.suppressions.insertIfAbsent({ ...row, removed_at: null }, ['channel', 'address_hash', 'removed_at']),
    getSuppression: (id) => t.suppressions.get(id),
    updateSuppression: async (id, patch) => found(await t.suppressions.update(id, patch), `suppression ${id}`),
    listSuppressions: (f, page) =>
      t.suppressions.page(
        {
          ...(f.channel ? { channel: f.channel } : {}),
          ...(f.reason ? { reason: f.reason } : {}),
          ...(f.accountId ? { account_id: f.accountId } : {}),
          ...(f.addressHash ? { address_hash: f.addressHash } : {}),
          ...(f.active === true ? { removed_at: null } : f.active === false ? { removed_at: { $ne: null } } : {}),
        },
        page,
        { column: 'created_at', direction: 'desc' },
      ),
    countActiveSuppressions: () => t.suppressions.count({ removed_at: null }),

    /* ---------------------------------------------------------------- preferences */
    memberPreferences: (sellerId) => t.memberPrefs.find({ seller_id: sellerId }, { sort: { updated_at: 1 } }),
    memberPreference: (sellerId, memberId) => t.memberPrefs.findOne({ seller_id: sellerId, member_id: memberId }),
    async ensureMemberPreference(row) {
      return (await t.memberPrefs.insertIfAbsent(row, ['seller_id', 'member_id'])) ?? found(await self.memberPreference(row.seller_id, row.member_id), 'member preference');
    },
    upsertMemberPreference: (row) =>
      t.memberPrefs.upsert(row, {
        key: ['seller_id', 'member_id'],
        update: { account_id: row.account_id, groups: row.groups, channel: row.channel, updated_by: row.updated_by, updated_at: row.updated_at },
      }),
    promotionsMembers: () => t.memberPrefs.find({ 'groups.promotions': true }),
    staffPreference: (accountId) => t.staffPrefs.get(accountId),
    staffPreferences: async (ids) => (ids.length ? t.staffPrefs.getMany(ids) : []),
    upsertStaffPreference: (row) =>
      t.staffPrefs.upsert(row, { update: { email_by_area: row.email_by_area, email_for_mentions: row.email_for_mentions, daily_digest: row.daily_digest, updated_at: row.updated_at } }),
    digestSubscribers: () => t.staffPrefs.find({ daily_digest: true }),

    /* ---------------------------------------------------------------- push devices */
    pushDevices: async (q) =>
      q.accountIds.length
        ? t.pushDevices.find(
            {
              account_id: oneOf(q.accountIds),
              audience: q.audience,
              invalidated_at: null,
              ...(q.sellerId ? { seller_id: q.sellerId } : {}),
              ...(q.activeOnly ? { enabled: true } : {}),
            },
            { sort: { created_at: 1 } },
          )
        : [],
    pushDeviceByHash: (hash) => t.pushDevices.findOne({ token_hash: hash }),
    pushDeviceByInstallation: (accountId, audience, installationId) =>
      t.pushDevices.findOne({ account_id: accountId, audience, installation_id: installationId, invalidated_at: null }),
    getPushDevice: (id) => t.pushDevices.get(id),
    insertPushDevice: (row) => t.pushDevices.insert(row),
    updatePushDevice: async (id, patch) => found(await t.pushDevices.update(id, patch), `push device ${id}`),
    setPushEnabled: (accountId, audience, enabled) => t.pushDevices.updateMany({ account_id: accountId, audience, invalidated_at: null }, { enabled }),
    invalidatePushDevices: (accountId, at) => t.pushDevices.updateMany({ account_id: accountId, invalidated_at: null }, { invalidated_at: at, enabled: false }),

    /* ---------------------------------------------------------------- broadcasts */
    insertBroadcast: (row) => t.broadcasts.insert(row),
    getBroadcast: (id, opts) => t.broadcasts.get(id, opts),
    updateBroadcast: async (id, patch) => found(await t.broadcasts.update(id, patch), `broadcast ${id}`),
    listBroadcasts: (f, page) =>
      t.broadcasts.page({ ...(f.status ? { status: f.status } : {}), ...(f.audience ? { audience: f.audience } : {}) }, page, { column: 'created_at', direction: 'desc' }),
    dueBroadcasts: (now, limit) => t.broadcasts.find({ status: 'scheduled', scheduled_at: { $lte: now } }, { sort: { scheduled_at: 1 }, limit }),
  };
  return self;
}

/** Tables of a store bound to a transaction (seedTemplates writes templates and versions together) */
function createTables(store: ModuleStore) {
  return { templates: store.table<TemplateRow>('templates'), versions: store.table<VersionRow>('template_versions') };
}

/** link.subjects of a notice */
const subjectsOf = (row: NoticeRow): Record<string, string> => ((row.link as { subjects?: Record<string, string> } | null)?.subjects ?? {}) as Record<string, string>;
