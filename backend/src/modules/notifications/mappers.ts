/** Row (snake_case) → API type (camelCase), one place per type. */
import type { Broadcast, BroadcastStats, Delivery, PushDevice, Suppression, Template, TemplateContent, TemplateVersion, TemplateVersionSummary } from '../../spec/notifications.js';
import { topicDef, type Channel } from './domain/catalog.js';
import { validateContent } from './domain/templates.js';
import { actorOfText } from './app/core.js';
import type { BroadcastRow, DeliveryRow, PushDeviceRow, SuppressionRow, TemplateRow, VersionRow } from './ports.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function deliveryOf(r: DeliveryRow): Delivery {
  return {
    id: r.id,
    noticeId: r.notice_id,
    topicKey: r.topic_key,
    channel: r.channel as Delivery['channel'],
    // Delivery.recipientKind has no external_email: suppliers, rights owners and report addresses show as bare addresses
    recipientKind: (r.recipient_kind === 'external_email' ? 'guest_email' : r.recipient_kind) as Delivery['recipientKind'],
    accountId: r.account_id,
    addressMasked: r.address_masked,
    status: r.status as Delivery['status'],
    skipReason: r.skip_reason,
    attempts: r.attempts,
    lastError: r.last_error,
    providerMessageId: r.provider_message_id,
    templateVersionId: r.template_version_id,
    linkedRef: r.linked_ref,
    createdAt: r.created_at.toISOString(),
    sentAt: iso(r.sent_at),
    deliveredAt: iso(r.delivered_at),
    nextAttemptAt: iso(r.next_attempt_at),
  };
}

export function suppressionOf(r: SuppressionRow): Suppression {
  const reason = (['hard_bounce', 'complaint', 'invalid', 'manual'].includes(r.reason) ? r.reason : 'manual') as Suppression['reason'];
  return {
    id: r.id,
    channel: r.channel as Suppression['channel'],
    addressMasked: r.address_masked,
    accountId: r.account_id,
    reason,
    source: r.source,
    createdAt: r.created_at.toISOString(),
    removedAt: iso(r.removed_at),
    removedBy: r.removed_by ? actorOfText(r.removed_by) : null,
  };
}

export function versionSummaryOf(v: VersionRow): TemplateVersionSummary {
  return {
    id: v.id,
    version: v.version,
    status: v.status as TemplateVersionSummary['status'],
    by: actorOfText(v.published_by ?? v.created_by),
    at: (v.published_at ?? v.created_at).toISOString(),
    note: v.note,
  };
}

export function versionOf(v: VersionRow, t: TemplateRow): TemplateVersion {
  const topic = topicDef(t.topic_key);
  const content = v.content as unknown as TemplateContent;
  return {
    id: v.id,
    templateId: v.template_id,
    version: v.version,
    status: v.status as TemplateVersion['status'],
    content,
    note: v.note,
    validation: topic ? validateContent(topic, t.channel as Channel, content) : { ok: false, issues: [{ severity: 'blocking', field: null, message: 'Unknown topic' }] },
    createdBy: actorOfText(v.created_by),
    createdAt: v.created_at.toISOString(),
    publishedBy: v.published_by ? actorOfText(v.published_by) : null,
    publishedAt: iso(v.published_at),
  };
}

export function templateOf(t: TemplateRow, versions: VersionRow[]): Template {
  const live = versions.find((v) => v.id === t.live_version_id);
  const draft = versions.find((v) => v.template_id === t.id && v.status === 'draft');
  return {
    id: t.id,
    topicKey: t.topic_key,
    // Template.audience has no external: staff manage the supplier and rights-owner emails
    audience: ((a) => (a === 'external' ? 'staff' : a))(topicDef(t.topic_key)?.audience ?? 'customer'),
    channel: t.channel as Template['channel'],
    language: t.language,
    live: live ? versionSummaryOf(live) : null,
    draft: draft ? versionSummaryOf(draft) : null,
    updatedAt: t.updated_at.toISOString(),
  };
}

export const emptyStats = (): BroadcastStats => ({ recipients: 0, sent: 0, delivered: 0, bounced: 0, unsubscribed: 0 });

export function broadcastOf(b: BroadcastRow, stats?: BroadcastStats): Broadcast {
  const stored = (b.stats ?? {}) as Partial<BroadcastStats>;
  return {
    id: b.id,
    name: b.name,
    audience: b.audience as Broadcast['audience'],
    topicKey: b.topic_key,
    templateVersionId: b.template_version_id,
    segment: b.segment as unknown as Broadcast['segment'],
    status: b.status as Broadcast['status'],
    scheduledAt: iso(b.scheduled_at),
    sentAt: iso(b.sent_at),
    recipientEstimate: b.recipient_estimate,
    stats: stats ?? { ...emptyStats(), ...stored },
    campaignId: b.campaign_id,
    createdBy: actorOfText(b.created_by),
    createdAt: b.created_at.toISOString(),
  };
}

export function pushDeviceOf(d: PushDeviceRow, token: string | null): PushDevice {
  return {
    id: d.id,
    platform: 'android',
    tokenSuffix: token ? token.slice(-6) : '',
    appVersion: d.app_version,
    installationId: d.installation_id,
    createdAt: d.created_at.toISOString(),
    lastSeenAt: d.last_seen_at.toISOString(),
    enabled: d.enabled,
  };
}
