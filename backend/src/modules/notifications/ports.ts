/**
 * Row types and filter shapes the notifications repository and service share, and the provider ports
 * (email, SMS, push) whose development implementations live in providers/.
 */
import type { NotificationsDb } from '../../spec/notifications.js';

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

/**
 * The template variables a message was rendered from (codes, links, names). Only the development
 * providers keep them (the dev outbox, GET /api/dev/outbox); a real provider must never send them.
 */
export type TemplateData = Record<string, unknown>;

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
  templateData?: TemplateData;
}

export interface OutboundSms {
  to: string;
  text: string;
  tags: { deliveryId: string; topicKey: string };
  templateData?: TemplateData;
}

export interface OutboundPush {
  token: string;
  title: string;
  body: string;
  /** Only the NoticeLink and notice id: never personal details beyond the order reference */
  data: Record<string, string>;
  tags: { deliveryId: string; topicKey: string };
  templateData?: TemplateData;
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
