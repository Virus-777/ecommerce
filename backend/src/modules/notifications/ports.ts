/**
 * What the notifications service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; providers (email, SMS, push) live in infra/<provider>/.
 */
import type { NotificationsDb } from '../../spec/notifications.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { Page } from '../../spec/common.js';
import type { Inbox } from '../../kernel/events/inbox.js';

export type TopicRow = NotificationsDb['topics'];
export type TemplateRow = NotificationsDb['templates'];
export type VersionRow = NotificationsDb['template_versions'];
export type NoticeRow = NotificationsDb['notices'];
export type RecipientRow = NotificationsDb['notice_recipients'];
export type ScheduledRow = NotificationsDb['scheduled_notifications'];
export type DeliveryRow = NotificationsDb['deliveries'];
export type DeliveryEventRow = NotificationsDb['delivery_events'];
export type MemberPrefRow = NotificationsDb['member_preferences'];
export type StaffPrefRow = NotificationsDb['staff_preferences'];
export type PushDeviceRow = NotificationsDb['push_devices'];
export type SuppressionRow = NotificationsDb['suppressions'];
export type BroadcastRow = NotificationsDb['broadcasts'];

/** A notice as one person sees it (with their read state) */
export type InboxRow = NoticeRow & { read_at: Date | null; reason: string | null; covering_for: string | null };

/** Which notices a person's inbox holds */
export type InboxOwner =
  | { kind: 'customer'; accountId: string }
  | { kind: 'seller'; sellerId: string; accountId: string; topicKeys: string[] }
  | { kind: 'staff'; accountId: string };

export interface InboxFilter {
  group?: string;
  unreadOnly?: boolean;
  actionRequired?: boolean;
  topicKeys?: string[];
  /** Staff: open action notices (needs my action) */
  openActionOnly?: boolean;
  /** Staff: notices where my recipient reason is mention */
  mentionsOnly?: boolean;
}

export interface DeliveryFilter {
  channel?: string;
  status?: string;
  topicKey?: string;
  accountId?: string;
  addressHash?: string;
  linkedRef?: string;
  from?: Date;
  to?: Date;
}

export interface SuppressionFilter {
  channel?: string;
  reason?: string;
  accountId?: string;
  addressHash?: string;
  active?: boolean;
}

/** Notice subjects kept in link.subjects, used to find who an order, return or case belongs to */
export type SubjectKey = 'orderId' | 'returnId' | 'caseId' | 'conversationId' | 'groupId';

/** Persistence for this module's own tables: notifications.topics, notifications.templates, notifications.template_versions, notifications.notices, notifications.notice_recipients, notifications.scheduled_notifications, notifications.deliveries, notifications.delivery_events, notifications.member_preferences, notifications.staff_preferences, notifications.push_devices, notifications.suppressions, notifications.broadcasts. */
export interface NotificationsRepository {
  transaction<T>(fn: (repo: NotificationsRepository) => Promise<T>): Promise<T>;
  /** Claims a consumed event's inbox key on this repository's connection (inside transaction(): together with the effects) */
  claim(inbox: Inbox, key: string): Promise<boolean>;

  /* topics and templates */
  listTopics(): Promise<TopicRow[]>;
  upsertTopics(rows: TopicRow[]): Promise<void>;
  updateTopicChannels(key: string, channels: Record<string, boolean>, by: string, at: Date): Promise<TopicRow | undefined>;
  listTemplates(): Promise<TemplateRow[]>;
  getTemplate(id: string): Promise<TemplateRow | undefined>;
  templateFor(topicKey: string, channel: string, language: string): Promise<TemplateRow | undefined>;
  /** Insert templates that do not exist yet (with their first, published version); returns how many were added */
  seedTemplates(items: { template: TemplateRow; version: VersionRow }[]): Promise<number>;
  versionsOf(templateIds: string[]): Promise<VersionRow[]>;
  getVersion(id: string, opts?: { forUpdate?: boolean }): Promise<VersionRow | undefined>;
  insertVersion(row: VersionRow): Promise<VersionRow>;
  updateVersion(id: string, patch: Partial<VersionRow>): Promise<VersionRow>;
  updateTemplate(id: string, patch: Partial<TemplateRow>): Promise<void>;
  liveVersions(): Promise<{ topic_key: string; channel: string; version: VersionRow }[]>;

  /* notices */
  insertNotice(row: NoticeRow): Promise<void>;
  insertRecipients(rows: RecipientRow[]): Promise<void>;
  noticeExists(q: { dedupeKey: string; topicKey: string; addressKind: string; addressId: string; since: Date }): Promise<boolean>;
  listInbox(owner: InboxOwner, filter: InboxFilter, page: PageRequest): Promise<Page<InboxRow>>;
  inboxRows(owner: InboxOwner, filter: InboxFilter, limit?: number): Promise<InboxRow[]>;
  inboxCounts(owner: InboxOwner): Promise<{ group: string; total: number; unread: number; openActions: number; mentionsUnread: number }[]>;
  getInboxNotice(owner: InboxOwner, noticeId: string): Promise<InboxRow | undefined>;
  markRead(owner: InboxOwner, noticeIds: string[] | 'all', at: Date, filter?: { group?: string }): Promise<number>;
  recipientsOf(noticeIds: string[]): Promise<RecipientRow[]>;
  resolveNotices(dedupeKey: string, note: string | null, at: Date): Promise<number>;
  /** Most recent addressee of a notice about a subject (who an order or case belongs to) */
  addresseeOf(audience: 'customer' | 'seller', key: SubjectKey, value: string): Promise<{ addressId: string; sellerId: string | null; subjects: Record<string, string> } | undefined>;
  /** Subjects known together with one subject (e.g. the order of a return) */
  subjectsWith(key: SubjectKey, value: string): Promise<Record<string, string>>;
  openRoleNotices(roleKey: string): Promise<NoticeRow[]>;
  recentRoleNotices(roleKeys: string[], since: Date): Promise<NoticeRow[]>;
  findNotice(id: string): Promise<NoticeRow | undefined>;
  latestNotice(q: { linkedRef?: string; topicKey?: string; subject?: { key: SubjectKey; value: string } }): Promise<NoticeRow | undefined>;
  purgeNotices(before: Date): Promise<number>;
  expireActionNotices(deadlineBefore: Date, at: Date): Promise<number>;
  unreadSince(accountId: string, since: Date): Promise<NoticeRow[]>;

  /* scheduled */
  insertScheduled(row: ScheduledRow): Promise<void>;
  cancelScheduled(dedupeKey: string): Promise<number>;
  hasPendingScheduled(dedupeKey: string): Promise<boolean>;
  dueScheduled(now: Date, limit: number): Promise<ScheduledRow[]>;
  markScheduled(id: string, status: ScheduledRow['status']): Promise<boolean>;

  /* deliveries */
  insertDeliveries(rows: DeliveryRow[]): Promise<void>;
  deliveryExists(q: { dedupeKey: string; topicKey: string; addressHash: string; channel: string; since: Date }): Promise<boolean>;
  /** Reference of the record an earlier delivery with this dedupe key linked to (guests have no notices to correlate) */
  linkedRefOf(dedupeKey: string): Promise<string | null>;
  getDelivery(id: string): Promise<DeliveryRow | undefined>;
  /** Moves a delivery from one of `from` to a new status atomically; undefined when it was not in `from` */
  transitionDelivery(id: string, from: string[], patch: Partial<DeliveryRow>): Promise<DeliveryRow | undefined>;
  deliveryByProviderMessage(providerMessageId: string): Promise<DeliveryRow | undefined>;
  latestDeliveryTo(addressHash: string): Promise<DeliveryRow | undefined>;
  listDeliveries(filter: DeliveryFilter, page: PageRequest): Promise<Page<DeliveryRow>>;
  dueDeliveries(statuses: string[], now: Date, limit: number): Promise<DeliveryRow[]>;
  skipQueuedFor(accountId: string, reason: string, promotionalTopicKeys: string[]): Promise<number>;
  /** Records a delivery event; false when the provider event was already recorded */
  insertDeliveryEvent(row: DeliveryEventRow): Promise<boolean>;
  deliveryEvents(deliveryId: string): Promise<DeliveryEventRow[]>;
  deliveryCounts(q: { channel?: string; from: Date; to: Date; broadcastIds?: string[] }): Promise<{ status: string; broadcast_id: string | null; n: number }[]>;
  countDeliveries(q: { statuses: string[]; from?: Date }): Promise<number>;
  purgeDeliveries(before: Date): Promise<number>;

  /* suppressions */
  activeSuppression(channel: string, addressHash: string): Promise<SuppressionRow | undefined>;
  activeSuppressions(channel: string, addressHashes: string[]): Promise<SuppressionRow[]>;
  /** Adds a suppression unless one is active; returns the new row or undefined */
  insertSuppression(row: SuppressionRow): Promise<SuppressionRow | undefined>;
  getSuppression(id: string): Promise<SuppressionRow | undefined>;
  updateSuppression(id: string, patch: Partial<SuppressionRow>): Promise<SuppressionRow>;
  listSuppressions(filter: SuppressionFilter, page: PageRequest): Promise<Page<SuppressionRow>>;
  countActiveSuppressions(): Promise<number>;

  /* preferences */
  memberPreferences(sellerId: string): Promise<MemberPrefRow[]>;
  memberPreference(sellerId: string, memberId: string): Promise<MemberPrefRow | undefined>;
  /** Creates the default row for a member the first time they are seen */
  ensureMemberPreference(row: MemberPrefRow): Promise<MemberPrefRow>;
  upsertMemberPreference(row: MemberPrefRow): Promise<MemberPrefRow>;
  promotionsMembers(): Promise<MemberPrefRow[]>;
  staffPreference(accountId: string): Promise<StaffPrefRow | undefined>;
  staffPreferences(accountIds: string[]): Promise<StaffPrefRow[]>;
  upsertStaffPreference(row: StaffPrefRow): Promise<StaffPrefRow>;
  digestSubscribers(): Promise<StaffPrefRow[]>;

  /* push devices */
  pushDevices(q: { accountIds: string[]; audience: 'customer' | 'seller'; sellerId?: string | null; activeOnly?: boolean }): Promise<PushDeviceRow[]>;
  pushDeviceByHash(tokenHash: string): Promise<PushDeviceRow | undefined>;
  pushDeviceByInstallation(accountId: string, audience: string, installationId: string): Promise<PushDeviceRow | undefined>;
  getPushDevice(id: string): Promise<PushDeviceRow | undefined>;
  insertPushDevice(row: PushDeviceRow): Promise<PushDeviceRow>;
  updatePushDevice(id: string, patch: Partial<PushDeviceRow>): Promise<PushDeviceRow>;
  setPushEnabled(accountId: string, audience: string, enabled: boolean): Promise<number>;
  invalidatePushDevices(accountId: string, at: Date): Promise<number>;

  /* broadcasts */
  insertBroadcast(row: BroadcastRow): Promise<BroadcastRow>;
  getBroadcast(id: string, opts?: { forUpdate?: boolean }): Promise<BroadcastRow | undefined>;
  updateBroadcast(id: string, patch: Partial<BroadcastRow>): Promise<BroadcastRow>;
  listBroadcasts(filter: { status?: string; audience?: string }, page: PageRequest): Promise<Page<BroadcastRow>>;
  dueBroadcasts(now: Date, limit: number): Promise<BroadcastRow[]>;
}

/* ------------------------------------------------------------------ providers */

/** Events a provider reports right away (dev adapters simulate bounces and complaints this way) */
export interface ProviderSyncEvent {
  type: 'delivered' | 'bounced' | 'complained' | 'opened' | 'deferred' | 'rejected';
  bounceType?: 'hard' | 'soft';
  detail?: string;
}

export type ProviderResult =
  | { ok: true; providerMessageId: string; events?: ProviderSyncEvent[] }
  | { ok: false; temporary: boolean; error: string; invalidToken?: boolean };

export interface OutboundEmail {
  to: string;
  from: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  /** Delivery id and topic, sent as provider tags */
  tags: { deliveryId: string; topicKey: string };
}

export interface OutboundSms {
  to: string;
  text: string;
  tags: { deliveryId: string; topicKey: string };
}

export interface OutboundPush {
  token: string;
  title: string;
  body: string;
  /** Only the NoticeLink and notice id: never personal details beyond the order reference */
  data: Record<string, string>;
  tags: { deliveryId: string; topicKey: string };
}

export interface EmailProvider {
  readonly name: string;
  send(message: OutboundEmail): Promise<ProviderResult>;
  /** The bytes of an inbound email attachment (InboundAttachment.downloadUrl, authenticated with the provider); fails above maxBytes */
  fetchAttachment?(downloadUrl: string, opts: { maxBytes: number }): Promise<Uint8Array>;
}

export interface SmsProvider {
  readonly name: string;
  send(message: OutboundSms): Promise<ProviderResult>;
}

export interface PushProvider {
  readonly name: string;
  send(message: OutboundPush): Promise<ProviderResult>;
}

export interface Providers {
  email: EmailProvider;
  sms: SmsProvider;
  push: PushProvider;
}
