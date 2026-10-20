import { orThrow } from '../../kernel/lib/or-throw.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { Filter, ModuleStore } from '../../kernel/mongo/index.js';
import type { Page } from '../../spec/common.js';
import type { AnnouncementRow, BroadcastRow, DeliveryEventRow, DeliveryFilter, DeliveryRow, InboxFilter, InboxOwner, InboxRow, InvitedMemberRow, MemberPrefRow, NoticeRow, PushDeviceRow, RecipientRow, ScheduledRow, StaffPrefRow, SubjectKey, SuppressionFilter, SuppressionRow, TemplateRow, TopicRow, VersionRow } from './ports.js';

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...values] });

const SUBJECT_KEYS = new Set<SubjectKey>(['orderId', 'returnId', 'caseId', 'conversationId', 'groupId']);
/** The dotted path of a notice subject (link.subjects.<key>) */
const subjectPath = (k: SubjectKey) => {
  if (!SUBJECT_KEYS.has(k)) throw new Error(`unknown subject key ${k}`);
  return `link.subjects.${k}`;
};

/** Rows deleted per round by the purge job (an id list per round, never every old row at once) */
const PURGE_BATCH = 1000;

/** Deletes the rows matching `filter` a batch of ids at a time (`remove` deletes one batch and says how many went) */
async function purgeInBatches<R extends { id: string }>(table: { find(f: Filter, o: { limit: number }): Promise<R[]> }, filter: Filter, remove: (ids: string[]) => Promise<number>): Promise<number> {
  let removed = 0;
  for (;;) {
    const ids = (await table.find(filter, { limit: PURGE_BATCH })).map((r) => r.id);
    if (!ids.length) return removed;
    const n = await remove(ids);
    removed += n;
    if (ids.length < PURGE_BATCH || !n) return removed;
  }
}

/** An open action notice: needs action, neither resolved nor expired */
const OPEN_ACTION: Filter = { action_required: true, resolved_at: null, expired_at: null };

/** The notifications module's collections (MongoDB, docs/04-mongodb-migration.md): one per spec table. */
export class NotificationsRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      topics: this.store.table<TopicRow>('topics'),
      templates: this.store.table<TemplateRow>('templates'),
      versions: this.store.table<VersionRow>('template_versions'),
      notices: this.store.table<NoticeRow>('notices'),
      recipients: this.store.table<RecipientRow>('notice_recipients'),
      scheduled: this.store.table<ScheduledRow>('scheduled_notifications'),
      deliveries: this.store.table<DeliveryRow>('deliveries'),
      deliveryEvents: this.store.table<DeliveryEventRow>('delivery_events'),
      memberPrefs: this.store.table<MemberPrefRow>('member_preferences'),
      staffPrefs: this.store.table<StaffPrefRow>('staff_preferences'),
      pushDevices: this.store.table<PushDeviceRow>('push_devices'),
      suppressions: this.store.table<SuppressionRow>('suppressions'),
      broadcasts: this.store.table<BroadcastRow>('broadcasts'),
      announcements: this.store.table<AnnouncementRow>('announcements'),
      invited: this.store.table<InvitedMemberRow>('invited_members'),
    };
  }

  transaction<T>(fn: (tx: NotificationsRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new NotificationsRepository(tx)));
  }

  /** Claims a consumed event's inbox key (inside transaction(): together with the effects) */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- topics and templates */
  listTopics(): Promise<TopicRow[]> {
    return this.#t.topics.find();
  }

  async upsertTopics(rows: TopicRow[]): Promise<void> {
    // the catalogue refreshes every field from code; channels and who changed them stay as staff set them
    await this.#t.topics.upsertMany(rows, {
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
  }

  updateTopicChannels(key: string, channels: Record<string, boolean>, by: string, at: Date): Promise<TopicRow | undefined> {
    return this.#t.topics.update(key, { $set: { channels, updated_by: by, updated_at: at } });
  }

  listTemplates(): Promise<TemplateRow[]> {
    return this.#t.templates.find({}, { sort: { topic_key: 1, channel: 1 } });
  }

  getTemplate(id: string): Promise<TemplateRow | undefined> {
    return this.#t.templates.get(id);
  }

  templateFor(topicKey: string, channel: string, language: string): Promise<TemplateRow | undefined> {
    return this.#t.templates.findOne({ topic_key: topicKey, channel, language });
  }

  /** Insert templates that do not exist yet (with their first, published version); returns how many were added */
  async seedTemplates(items: { template: TemplateRow; version: VersionRow }[]): Promise<number> {
    if (!items.length) return 0;
    return this.store.transaction(async (tx) => {
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
  }

  async versionsOf(ids: string[]): Promise<VersionRow[]> {
    return (ids.length ? this.#t.versions.find({ template_id: oneOf(ids) }, { sort: { version: -1 } }) : []);
  }

  getVersion(id: string, opts?: { forUpdate?: boolean }): Promise<VersionRow | undefined> {
    return this.#t.versions.get(id, opts);
  }

  insertVersion(row: VersionRow): Promise<VersionRow> {
    return this.#t.versions.insert(row);
  }

  async updateVersion(id: string, patch: Partial<VersionRow>): Promise<VersionRow> {
    return orThrow(await this.#t.versions.update(id, patch), `template version ${id}`);
  }

  async updateTemplate(id: string, patch: Partial<TemplateRow>): Promise<void> {
    await this.#t.templates.update(id, patch);
  }

  async liveVersions(): Promise<{ topic_key: string; channel: string; version: VersionRow }[]> {
    const templates = await this.#t.templates.find({ live_version_id: { $ne: null } });
    const versions = new Map((await this.#t.versions.getMany(templates.map((x) => x.live_version_id))).map((v) => [v.id, v]));
    return templates.flatMap((x) => {
      const version = versions.get(x.live_version_id!);
      return version ? [{ topic_key: x.topic_key, channel: x.channel, version }] : [];
    });
  }

  /* ---------------------------------------------------------------- notices */
  async insertNotice(row: NoticeRow): Promise<void> {
    await this.#t.notices.insert(row);
  }

  async insertRecipients(rows: RecipientRow[]): Promise<void> {
    await this.#t.recipients.insertManyIfAbsent(rows, ['notice_id', 'account_id']);
  }

  noticeExists(q: { dedupeKey: string; topicKey: string; addressKind: string; addressId: string; since: Date }): Promise<boolean> {
    return this.#t.notices.exists({ dedupe_key: q.dedupeKey, topic_key: q.topicKey, address_kind: q.addressKind, address_id: q.addressId, created_at: { $gte: q.since } });
  }

  /** Was this topic ever sent with this dedupe key (a notice, or an email when the in-app channel is off)? RouteSend.once */
  async everSent(dedupeKey: string, topicKey: string): Promise<boolean> {
    return (await this.#t.notices.exists({ dedupe_key: dedupeKey, topic_key: topicKey })) || this.#t.deliveries.exists({ dedupe_key: dedupeKey, topic_key: topicKey });
  }

  async listInbox(owner: InboxOwner, f: InboxFilter, page: PageRequest): Promise<Page<InboxRow>> {
    const result = await this.#t.notices.page(await this.#inboxFilter(owner, f), page, { column: 'created_at', direction: 'desc' });
    return { ...result, items: await this.#withReadState(owner.accountId, result.items) };
  }

  async inboxRows(owner: InboxOwner, f: InboxFilter, limit: number = 200): Promise<InboxRow[]> {
    return this.#withReadState(owner.accountId, await this.#t.notices.find(await this.#inboxFilter(owner, f), { sort: { created_at: -1, id: -1 }, limit }));
  }

  async inboxCounts(owner: InboxOwner): Promise<{ group: string; total: number; unread: number; openActions: number; mentionsUnread: number }[]> {
    const isNull = (path: string) => ({ $eq: [{ $ifNull: [path, null] }, null] });
    const rows = await this.#t.notices.aggregate<{ _id: string; total: number; unread: number; openActions: number; mentionsUnread: number }>([
      { $match: this.#t.notices.filter(await this.#inboxBase(owner)) },
      {
        $lookup: {
          from: `${this.store.module}.notice_recipients`,
          let: { nid: '$_id' },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$notice_id', '$$nid'] }, { $eq: ['$account_id', owner.accountId] }] } } }, { $limit: 1 }],
          as: 'r',
        },
      },
      { $set: { r: { $first: '$r' } } },
      // archived notices leave the inbox and its counts
      { $match: { 'r.archived_at': null } },
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
  }

  async getInboxNotice(owner: InboxOwner, noticeId: string): Promise<InboxRow | undefined> {
    // archived or not: the notice can still be opened, read and archived
    const notice = await this.#t.notices.findOne({ $and: [await this.#inboxBase(owner), { id: noticeId }] });
    return notice ? (await this.#withReadState(owner.accountId, [notice]))[0] : undefined;
  }

  /**
   * Live stream catch-up (Last-Event-ID): the inbox's notices created after the notice `afterId`, none older than
   * `since`, the newest `limit` of them, oldest first. Nothing when `afterId` is not a notice of this inbox.
   */
  async inboxAfter(owner: InboxOwner, afterId: string, since: Date, limit: number): Promise<InboxRow[]> {
    const anchor = await this.#t.notices.findOne({ $and: [await this.#inboxBase(owner), { id: afterId }] });
    if (!anchor) return [];
    // after the anchor in inbox order (created_at, then id: one send creates several notices at the same time)
    const after = { $or: [{ created_at: { $gt: anchor.created_at } }, { created_at: anchor.created_at, id: { $gt: anchor.id } }] };
    const rows = await this.#t.notices.find({ $and: [await this.#inboxFilter(owner, {}), after, { created_at: { $gte: since } }] }, { sort: { created_at: -1, id: -1 }, limit });
    return (await this.#withReadState(owner.accountId, rows)).reverse();
  }

  /** My recipient row's read state back to unread */
  async markUnread(owner: InboxOwner, noticeId: string): Promise<number> {
    return this.#t.recipients.updateMany({ account_id: owner.accountId, notice_id: noticeId, read_at: { $ne: null } }, { read_at: null });
  }

  /**
   * Archives notices for the owner (never open action notices): sets archived_at on the owner's recipient rows;
   * customers and sellers get a row (unread) the first time they archive a notice addressed to their workspace.
   */
  async archive(owner: InboxOwner, ids: string[] | 'all', at: Date, f: { group?: string; readOnly?: boolean } = {}): Promise<number> {
    if (ids !== 'all' && !ids.length) return 0;
    const and: Filter[] = [await this.#inboxBase(owner), { $nor: [OPEN_ACTION] }];
    if (ids !== 'all') and.push({ id: oneOf(ids) });
    if (f.group) and.push({ group_key: f.group });
    if (f.readOnly) and.push({ id: oneOf(await this.#t.recipients.distinct<string>('notice_id', { account_id: owner.accountId, read_at: { $ne: null } })) });
    const noticeIds = await this.#t.notices.distinct<string>('id', { $and: and });
    if (!noticeIds.length) return 0;
    const updated = await this.#t.recipients.updateMany({ account_id: owner.accountId, archived_at: null, notice_id: oneOf(noticeIds) }, { archived_at: at });
    if (owner.kind === 'staff') return updated;
    const have = new Set(await this.#t.recipients.distinct<string>('notice_id', { account_id: owner.accountId, notice_id: oneOf(noticeIds) }));
    const reason = owner.kind === 'seller' ? 'member' : 'direct';
    const inserted = await this.#t.recipients.insertManyIfAbsent(
      noticeIds.filter((id) => !have.has(id)).map((id) => ({ notice_id: id, account_id: owner.accountId, reason, covering_for: null, read_at: null, archived_at: at, created_at: at })),
      ['notice_id', 'account_id'],
    );
    return updated + inserted;
  }

  async markRead(owner: InboxOwner, ids: string[] | 'all', at: Date, f: { group?: string } = {}): Promise<number> {
    if (ids !== 'all' && !ids.length) return 0;
    const and: Filter[] = [await this.#inboxBase(owner)];
    if (ids !== 'all') and.push({ id: oneOf(ids) });
    if (f.group) and.push({ group_key: f.group });
    const noticeIds = await this.#t.notices.distinct<string>('id', { $and: and });
    if (!noticeIds.length) return 0;
    // rows already there and unread are marked read
    const updated = await this.#t.recipients.updateMany({ account_id: owner.accountId, read_at: null, notice_id: oneOf(noticeIds) }, { read_at: at });
    if (owner.kind === 'staff') return updated;
    // customers and sellers get a recipient row the first time they read a notice addressed to their workspace
    const have = new Set(await this.#t.recipients.distinct<string>('notice_id', { account_id: owner.accountId, notice_id: oneOf(noticeIds) }));
    const reason = owner.kind === 'seller' ? 'member' : 'direct';
    const inserted = await this.#t.recipients.insertManyIfAbsent(
      noticeIds.filter((id) => !have.has(id)).map((id) => ({ notice_id: id, account_id: owner.accountId, reason, covering_for: null, read_at: at, created_at: at })),
      ['notice_id', 'account_id'],
    );
    return updated + inserted;
  }

  async recipientsOf(ids: string[]): Promise<RecipientRow[]> {
    return (ids.length ? this.#t.recipients.find({ notice_id: oneOf(ids) }, { sort: { created_at: 1 } }) : []);
  }

  resolveNotices(dedupeKey: string, note: string | null, at: Date): Promise<number> {
    return this.#t.notices.updateMany({ dedupe_key: dedupeKey, ...OPEN_ACTION }, { resolved_at: at, resolve_note: note });
  }

  /** Most recent addressee of a notice about a subject (who an order or case belongs to) */
  async addresseeOf(audience: 'customer' | 'seller', key: SubjectKey, value: string): Promise<{ addressId: string; sellerId: string | null; subjects: Record<string, string> } | undefined> {
    const row = await this.#t.notices.findOne({ address_kind: audience, [subjectPath(key)]: value }, { sort: { created_at: -1 } });
    return row ? { addressId: row.address_id, sellerId: row.seller_id, subjects: subjectsOf(row) } : undefined;
  }

  /** Subjects known together with one subject (e.g. the order of a return) */
  async subjectsWith(key: SubjectKey, value: string): Promise<Record<string, string>> {
    const rows = await this.#t.notices.find({ [subjectPath(key)]: value }, { sort: { created_at: -1 }, limit: 20 });
    const out: Record<string, string> = {};
    for (const r of rows.reverse()) Object.assign(out, subjectsOf(r));
    return out;
  }

  openRoleNotices(roleKey: string): Promise<NoticeRow[]> {
    return this.#t.notices.find({ address_kind: 'role', address_id: roleKey, ...OPEN_ACTION });
  }

  async recentRoleNotices(roleKeys: string[], since: Date): Promise<NoticeRow[]> {
    return (roleKeys.length ? this.#t.notices.find({ address_kind: 'role', address_id: oneOf(roleKeys), created_at: { $gte: since } }) : []);
  }

  findNotice(id: string): Promise<NoticeRow | undefined> {
    return this.#t.notices.get(id);
  }

  latestNotice(q: { linkedRef?: string; topicKey?: string; subject?: { key: SubjectKey; value: string } }): Promise<NoticeRow | undefined> {
    return this.#t.notices.findOne(
      {
        ...(q.linkedRef ? { linked_ref: q.linkedRef } : {}),
        ...(q.topicKey ? { topic_key: q.topicKey } : {}),
        ...(q.subject ? { [subjectPath(q.subject.key)]: q.subject.value } : {}),
      },
      { sort: { created_at: -1 } },
    );
  }

  /** Notices past their retention, with their read rows (deliveries keep their row without the notice), in bounded batches */
  async purgeNotices(before: Date): Promise<number> {
    return purgeInBatches(this.#t.notices, { expires_at: { $lt: before } }, async (old) => {
      await this.#t.deliveries.updateMany({ notice_id: oneOf(old) }, { notice_id: null });
      await this.#t.recipients.deleteMany({ notice_id: oneOf(old) });
      return this.#t.notices.deleteMany({ id: oneOf(old) });
    });
  }

  /** Open action notices whose deadline is before `cutoff`, or that have no deadline and were created before it, become expired */
  expireActionNotices(cutoff: Date, at: Date): Promise<number> {
    return this.#t.notices.updateMany({ ...OPEN_ACTION, $or: [{ deadline_at: { $lt: cutoff } }, { deadline_at: null, created_at: { $lt: cutoff } }] }, { expired_at: at });
  }

  async unreadSince(accountId: string, since: Date): Promise<NoticeRow[]> {
    const ids = await this.#t.recipients.distinct<string>('notice_id', { account_id: accountId, read_at: null });
    if (!ids.length) return [];
    return this.#t.notices.find({ id: oneOf(ids), address_kind: oneOf(['role', 'staff']), created_at: { $gte: since } }, { sort: { created_at: -1 }, limit: 50 });
  }

  /* ---------------------------------------------------------------- scheduled */
  async insertScheduled(row: ScheduledRow): Promise<void> {
    await this.#t.scheduled.insert(row);
  }

  cancelScheduled(key: string): Promise<number> {
    return this.#t.scheduled.updateMany({ dedupe_key: key, status: 'pending' }, { status: 'cancelled' });
  }

  hasPendingScheduled(key: string): Promise<boolean> {
    return this.#t.scheduled.exists({ dedupe_key: key, status: 'pending' });
  }

  dueScheduled(now: Date, limit: number): Promise<ScheduledRow[]> {
    return this.#t.scheduled.find({ status: 'pending', send_at: { $lte: now } }, { sort: { send_at: 1 }, limit });
  }

  async markScheduled(id: string, status: ScheduledRow['status']): Promise<boolean> {
    return Boolean(await this.#t.scheduled.updateOne({ id, status: 'pending' }, { status }));
  }

  /* ---------------------------------------------------------------- deliveries */
  async insertDeliveries(rows: DeliveryRow[]): Promise<void> {
    await this.#t.deliveries.insertMany(rows);
  }

  /** Reference of the record an earlier delivery with this dedupe key linked to (guests have no notices to correlate) */
  async linkedRefOf(dedupeKey: string): Promise<string | null> {
    return (await this.#t.deliveries.findOne({ dedupe_key: dedupeKey, linked_ref: { $ne: null } }))?.linked_ref ?? null;
  }

  deliveryExists(q: { dedupeKey: string; topicKey: string; addressHash: string; channel: string; since: Date }): Promise<boolean> {
    return this.#t.deliveries.exists({ dedupe_key: q.dedupeKey, topic_key: q.topicKey, address_hash: q.addressHash, channel: q.channel, status: { $ne: 'skipped' }, created_at: { $gte: q.since } });
  }

  getDelivery(id: string): Promise<DeliveryRow | undefined> {
    return this.#t.deliveries.get(id);
  }

  /** Moves a delivery from one of `from` to a new status atomically; undefined when it was not in `from` */
  transitionDelivery(id: string, from: string[], patch: Partial<DeliveryRow>): Promise<DeliveryRow | undefined> {
    return this.#t.deliveries.updateOne({ id, status: oneOf(from) }, patch);
  }

  deliveryByProviderMessage(pid: string): Promise<DeliveryRow | undefined> {
    return this.#t.deliveries.findOne({ provider_message_id: pid }, { sort: { created_at: -1 } });
  }

  latestDeliveryTo(hash: string): Promise<DeliveryRow | undefined> {
    return this.#t.deliveries.findOne({ address_hash: hash }, { sort: { created_at: -1 } });
  }

  listDeliveries(f: DeliveryFilter, page: PageRequest): Promise<Page<DeliveryRow>> {
    return this.#t.deliveries.page(
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
    );
  }

  dueDeliveries(statuses: string[], now: Date, limit: number): Promise<DeliveryRow[]> {
    return this.#t.deliveries.find({ status: oneOf(statuses), $or: [{ next_attempt_at: null }, { next_attempt_at: { $lte: now } }] }, { sort: { created_at: 1 }, limit });
  }

  async skipQueuedFor(accountId: string, reason: string, topicKeys: string[]): Promise<number> {
    if (!topicKeys.length) return 0;
    return this.#t.deliveries.updateMany({ account_id: accountId, status: 'queued', topic_key: oneOf(topicKeys) }, { status: 'skipped', skip_reason: reason, next_attempt_at: null });
  }

  /** Records a delivery event; false when the provider event was already recorded */
  async insertDeliveryEvent(row: DeliveryEventRow): Promise<boolean> {
    // unique provider event id; events of our own (no provider id) are always recorded, as nulls never conflict
    if (row.provider_event_id == null) {
      await this.#t.deliveryEvents.insert(row);
      return true;
    }
    return Boolean(await this.#t.deliveryEvents.insertIfAbsent(row, ['provider_event_id']));
  }

  deliveryEvents(id: string): Promise<DeliveryEventRow[]> {
    return this.#t.deliveryEvents.find({ delivery_id: id }, { sort: { at: 1 } });
  }

  async deliveryCounts(q: { channel?: string; from: Date; to: Date; broadcastIds?: string[] }): Promise<{ status: string; broadcast_id: string | null; n: number }[]> {
    if (q.broadcastIds && !q.broadcastIds.length) return [];
    const rows = await this.#t.deliveries.aggregate<{ _id: { status: string; broadcast_id?: string | null }; n: number }>([
      {
        $match: this.#t.deliveries.filter({
          created_at: { $gte: q.from, $lt: q.to },
          ...(q.channel ? { channel: q.channel } : {}),
          ...(q.broadcastIds ? { broadcast_id: oneOf(q.broadcastIds) } : {}),
        }),
      },
      { $group: { _id: { status: '$status', broadcast_id: '$broadcast_id' }, n: { $sum: 1 } } },
    ]);
    return rows.map((r) => ({ status: r._id.status, broadcast_id: r._id.broadcast_id ?? null, n: r.n }));
  }

  countDeliveries(q: { statuses: string[]; from?: Date }): Promise<number> {
    return this.#t.deliveries.count({ status: oneOf(q.statuses), ...(q.from ? { created_at: { $gte: q.from } } : {}) });
  }

  /** Delivery rows past the log retention, with their events, in bounded batches */
  async purgeDeliveries(before: Date): Promise<number> {
    return purgeInBatches(this.#t.deliveries, { created_at: { $lt: before } }, async (old) => {
      await this.#t.deliveryEvents.deleteMany({ delivery_id: oneOf(old) });
      return this.#t.deliveries.deleteMany({ id: oneOf(old) });
    });
  }

  /* ---------------------------------------------------------------- suppressions */
  activeSuppression(channel: string, hash: string): Promise<SuppressionRow | undefined> {
    return this.#t.suppressions.findOne({ channel, address_hash: hash, removed_at: null });
  }

  async activeSuppressions(channel: string, hashes: string[]): Promise<SuppressionRow[]> {
    return (hashes.length ? this.#t.suppressions.find({ channel, address_hash: oneOf(hashes), removed_at: null }) : []);
  }

  // unique (channel, address_hash) among active rows: inserted unless one is active
  /** Adds a suppression unless one is active; returns the new row or undefined */
  insertSuppression(row: SuppressionRow): Promise<SuppressionRow | undefined> {
    return this.#t.suppressions.insertIfAbsent({ ...row, removed_at: null }, ['channel', 'address_hash', 'removed_at']);
  }

  getSuppression(id: string): Promise<SuppressionRow | undefined> {
    return this.#t.suppressions.get(id);
  }

  async updateSuppression(id: string, patch: Partial<SuppressionRow>): Promise<SuppressionRow> {
    return orThrow(await this.#t.suppressions.update(id, patch), `suppression ${id}`);
  }

  listSuppressions(f: SuppressionFilter, page: PageRequest): Promise<Page<SuppressionRow>> {
    return this.#t.suppressions.page(
      {
        ...(f.channel ? { channel: f.channel } : {}),
        ...(f.reason ? { reason: f.reason } : {}),
        ...(f.accountId ? { account_id: f.accountId } : {}),
        ...(f.addressHash ? { address_hash: f.addressHash } : {}),
        ...(f.active === true ? { removed_at: null } : f.active === false ? { removed_at: { $ne: null } } : {}),
      },
      page,
      { column: 'created_at', direction: 'desc' },
    );
  }

  countActiveSuppressions(): Promise<number> {
    return this.#t.suppressions.count({ removed_at: null });
  }

  /* ---------------------------------------------------------------- preferences */
  memberPreferences(sellerId: string): Promise<MemberPrefRow[]> {
    return this.#t.memberPrefs.find({ seller_id: sellerId }, { sort: { updated_at: 1 } });
  }

  memberPreference(sellerId: string, memberId: string): Promise<MemberPrefRow | undefined> {
    return this.#t.memberPrefs.findOne({ seller_id: sellerId, member_id: memberId });
  }

  /** Creates the default row for a member the first time they are seen */
  async ensureMemberPreference(row: MemberPrefRow): Promise<MemberPrefRow> {
    return (await this.#t.memberPrefs.insertIfAbsent(row, ['seller_id', 'member_id'])) ?? orThrow(await this.memberPreference(row.seller_id, row.member_id), 'member preference');
  }

  /* invited seller members (sellers.member.invited until joined or removed) */

  async rememberInvited(row: InvitedMemberRow): Promise<void> {
    await this.#t.invited.upsert(row, { key: ['seller_id', 'member_id'], update: { email: row.email, invited_at: row.invited_at } });
  }

  async forgetInvited(sellerId: string, memberId: string): Promise<void> {
    await this.#t.invited.deleteMany({ seller_id: sellerId, member_id: memberId });
  }

  invitedMember(sellerId: string, memberId: string): Promise<InvitedMemberRow | undefined> {
    return this.#t.invited.findOne({ seller_id: sellerId, member_id: memberId });
  }

  upsertMemberPreference(row: MemberPrefRow): Promise<MemberPrefRow> {
    return this.#t.memberPrefs.upsert(row, {
      key: ['seller_id', 'member_id'],
      update: { account_id: row.account_id, groups: row.groups, channel: row.channel, updated_by: row.updated_by, updated_at: row.updated_at },
    });
  }

  promotionsMembers(): Promise<MemberPrefRow[]> {
    return this.#t.memberPrefs.find({ 'groups.promotions': true });
  }

  staffPreference(accountId: string): Promise<StaffPrefRow | undefined> {
    return this.#t.staffPrefs.get(accountId);
  }

  async staffPreferences(ids: string[]): Promise<StaffPrefRow[]> {
    return (ids.length ? this.#t.staffPrefs.getMany(ids) : []);
  }

  upsertStaffPreference(row: StaffPrefRow): Promise<StaffPrefRow> {
    return this.#t.staffPrefs.upsert(row, { update: { email_by_area: row.email_by_area, email_for_mentions: row.email_for_mentions, daily_digest: row.daily_digest, updated_at: row.updated_at } });
  }

  digestSubscribers(): Promise<StaffPrefRow[]> {
    return this.#t.staffPrefs.find({ daily_digest: true });
  }

  /* ---------------------------------------------------------------- push devices */
  async pushDevices(q: { accountIds: string[]; audience: 'customer' | 'seller'; sellerId?: string | null; activeOnly?: boolean }): Promise<PushDeviceRow[]> {
    return q.accountIds.length
      ? this.#t.pushDevices.find(
          {
            account_id: oneOf(q.accountIds),
            audience: q.audience,
            invalidated_at: null,
            ...(q.sellerId ? { seller_id: q.sellerId } : {}),
            ...(q.activeOnly ? { enabled: true } : {}),
          },
          { sort: { created_at: 1 } },
        )
      : [];
  }

  pushDeviceByHash(hash: string): Promise<PushDeviceRow | undefined> {
    return this.#t.pushDevices.findOne({ token_hash: hash });
  }

  pushDeviceByInstallation(accountId: string, audience: string, installationId: string): Promise<PushDeviceRow | undefined> {
    return this.#t.pushDevices.findOne({ account_id: accountId, audience, installation_id: installationId, invalidated_at: null });
  }

  getPushDevice(id: string): Promise<PushDeviceRow | undefined> {
    return this.#t.pushDevices.get(id);
  }

  insertPushDevice(row: PushDeviceRow): Promise<PushDeviceRow> {
    return this.#t.pushDevices.insert(row);
  }

  async updatePushDevice(id: string, patch: Partial<PushDeviceRow>): Promise<PushDeviceRow> {
    return orThrow(await this.#t.pushDevices.update(id, patch), `push device ${id}`);
  }

  setPushEnabled(accountId: string, audience: string, enabled: boolean): Promise<number> {
    return this.#t.pushDevices.updateMany({ account_id: accountId, audience, invalidated_at: null }, { enabled });
  }

  invalidatePushDevices(accountId: string, at: Date): Promise<number> {
    return this.#t.pushDevices.updateMany({ account_id: accountId, invalidated_at: null }, { invalidated_at: at, enabled: false });
  }

  /* ---------------------------------------------------------------- broadcasts */
  insertBroadcast(row: BroadcastRow): Promise<BroadcastRow> {
    return this.#t.broadcasts.insert(row);
  }

  getBroadcast(id: string, opts?: { forUpdate?: boolean }): Promise<BroadcastRow | undefined> {
    return this.#t.broadcasts.get(id, opts);
  }

  async updateBroadcast(id: string, patch: Partial<BroadcastRow>): Promise<BroadcastRow> {
    return orThrow(await this.#t.broadcasts.update(id, patch), `broadcast ${id}`);
  }

  listBroadcasts(f: { status?: string; audience?: string }, page: PageRequest): Promise<Page<BroadcastRow>> {
    return this.#t.broadcasts.page({ ...(f.status ? { status: f.status } : {}), ...(f.audience ? { audience: f.audience } : {}) }, page, { column: 'created_at', direction: 'desc' });
  }

  dueBroadcasts(now: Date, limit: number): Promise<BroadcastRow[]> {
    return this.#t.broadcasts.find({ status: 'scheduled', scheduled_at: { $lte: now } }, { sort: { scheduled_at: 1 }, limit });
  }

  /* ---------------------------------------------------------------- announcements to sellers */
  insertAnnouncement(row: AnnouncementRow): Promise<AnnouncementRow> {
    return this.#t.announcements.insert(row);
  }

  async updateAnnouncement(id: string, patch: Partial<AnnouncementRow>): Promise<AnnouncementRow> {
    return orThrow(await this.#t.announcements.update(id, patch), `announcement ${id}`);
  }

  /** Newest first */
  listAnnouncements(page: PageRequest): Promise<Page<AnnouncementRow>> {
    return this.#t.announcements.page({}, page, { column: 'sent_at', direction: 'desc' });
  }

  /* ---------------------------------------------------------------- inboxes (a join is two reads) */
  /**
   * The notices of an owner's inbox. Staff see notices they are a recipient of (inner join); customers and sellers
   * see the notices addressed to them, with or without a recipient row of their own (left join: the row holds the
   * read state once they read it).
   */
  async #inboxBase(owner: InboxOwner): Promise<Filter> {
    if (owner.kind === 'staff') {
      const ids = await this.#t.recipients.distinct<string>('notice_id', { account_id: owner.accountId });
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
  async #inboxFilter(owner: InboxOwner, f: InboxFilter): Promise<Filter> {
    const and: Filter[] = [await this.#inboxBase(owner)];
    if (f.group) and.push({ group_key: f.group });
    if (f.actionRequired === true || f.openActionOnly) and.push(OPEN_ACTION);
    if (f.actionRequired === false) and.push({ action_required: false });
    if (f.topicKeys) and.push({ topic_key: oneOf(f.topicKeys) });
    if (f.unreadOnly) {
      // r.read_at is null: no recipient row (left join) or one not read yet
      if (owner.kind === 'staff') and.push({ id: oneOf(await this.#t.recipients.distinct<string>('notice_id', { account_id: owner.accountId, read_at: null })) });
      else and.push({ id: { $nin: await this.#t.recipients.distinct<string>('notice_id', { account_id: owner.accountId, read_at: { $ne: null } }) } });
    }
    if (f.mentionsOnly) and.push({ id: oneOf(await this.#t.recipients.distinct<string>('notice_id', { account_id: owner.accountId, reason: 'mention' })) });
    const archivedIds = await this.#t.recipients.distinct<string>('notice_id', { account_id: owner.accountId, archived_at: { $ne: null } });
    and.push(f.archived ? { id: oneOf(archivedIds) } : { id: { $nin: archivedIds } });
    return and.length === 1 ? and[0]! : { $and: and };
  }

  /** Notices with the owner's read state, reason and cover */
  async #withReadState(accountId: string, notices: NoticeRow[]): Promise<InboxRow[]> {
    if (!notices.length) return [];
    const rows = await this.#t.recipients.find({ account_id: accountId, notice_id: oneOf(notices.map((n) => n.id)) });
    const byNotice = new Map(rows.map((r) => [r.notice_id, r]));
    return notices.map((n) => {
      const r = byNotice.get(n.id);
      return { ...n, read_at: r?.read_at ?? null, archived_at: r?.archived_at ?? null, reason: r?.reason ?? null, covering_for: r?.covering_for ?? null };
    });
  }
}

/** Tables of a store bound to a transaction (seedTemplates writes templates and versions together) */
function createTables(store: ModuleStore) {
  return { templates: store.table<TemplateRow>('templates'), versions: store.table<VersionRow>('template_versions') };
}

/** link.subjects of a notice */
const subjectsOf = (row: NoticeRow): Record<string, string> => ((row.link as { subjects?: Record<string, string> } | null)?.subjects ?? {}) as Record<string, string>;
