/**
 * Admin Center: the topic matrix and channel switches, templates (drafts, preview, test sends,
 * publishing), the delivery log with retries, delivery stats, the suppression list and promotional
 * broadcasts under consent.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type { Actor, Page, TimelineEvent } from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type {
  Broadcast,
  BroadcastInput,
  BroadcastStats,
  ChannelSetting,
  Delivery,
  DeliveryDetail,
  DeliveryStats,
  RenderPreview,
  Suppression,
  Template,
  TemplateContent,
  TemplateDetail,
  TemplateVersion,
  Topic,
  TopicMatrix,
} from '../../../spec/notifications.js';
import { CHANNEL_PHASE, CHANNELS, sampleContext, setPath, TOPICS, topicDef, type Channel, type DeliveryChannel, type TopicDef } from '../domain/catalog.js';
import { channelSettings, emailDomain, hashAddress, maskAddress, normalizeEmail, topicView } from '../domain/rules.js';
import { broadcastMachine, deliveryMachine, templateVersionMachine } from '../domain/state-machines.js';
import { render, validateContent } from '../domain/templates.js';
import { broadcastOf, deliveryOf, emptyStats, suppressionOf, templateOf, versionOf, versionSummaryOf } from '../mappers.js';
import type { BroadcastRow, DeliveryRow, TemplateRow, VersionRow } from '../ports.js';
import { actorText, Core, SYSTEM } from './core.js';
import { linkOf } from './inbox.js';
import type { Sender, Target } from './sender.js';

export interface By {
  actor: Actor;
  requestId?: string;
}

const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
const illegal = (machine: string, from: string, event: string, why: string) => new AppError('ILLEGAL_TRANSITION', `${machine}: ${why}`, { machine, from, event });

const EVENT_LABELS: Record<string, string> = {
  queued: 'Queued',
  skipped: 'Skipped',
  suppressed: 'Not sent: address suppressed',
  sent: 'Sent to the provider',
  retrying: 'Temporary failure, will retry',
  failed: 'Failed',
  delivered: 'Delivered',
  bounced_hard: 'Hard bounce',
  bounced_soft: 'Soft bounce',
  bounced: 'Bounced',
  complained: 'Marked as spam',
  opened: 'Opened',
  deferred: 'Deferred by the receiving server',
  rejected: 'Rejected',
  retry_requested: 'Retry requested',
};

function merge(into: Record<string, unknown>, from: unknown) {
  if (!from || typeof from !== 'object' || Array.isArray(from)) return into;
  for (const [k, v] of Object.entries(from as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object') merge(into[k] as Record<string, unknown>, v);
    else into[k] = v;
  }
  return into;
}

export class Admin {
  constructor(
    private readonly core: Core,
    private readonly sender: Sender,
  ) {}

  /* ---------------------------------------------------------------- topics */

  async topicMatrix(): Promise<TopicMatrix> {
    const channels = await this.core.channelMap();
    const views = TOPICS.map((t) => ({ t, v: topicView(t, channels.get(t.key) ?? {}, this.core.launchPhase) }));
    const pick = (f: (t: TopicDef) => boolean) => views.filter((x) => f(x.t)).map((x) => x.v);
    return {
      customer: pick((t) => t.audience === 'customer' && t.category !== 'promotional'),
      seller: pick((t) => t.audience === 'seller' && t.category !== 'promotional'),
      staff: pick((t) => t.audience === 'staff'),
      promotional: pick((t) => t.category === 'promotional'),
      external: pick((t) => t.audience === 'external'),
      stats: await this.stats(7),
    };
  }

  async updateTopicChannels(key: string, body: { channels: ChannelSetting[]; reason: string }, by: By): Promise<Topic> {
    const t = topicDef(key);
    if (!t) throw notFound('Topic');
    const phase = this.core.launchPhase;
    const before = await this.core.channelsOf(key);
    const current = channelSettings(t, before, phase);
    const next: Record<Channel, boolean> = Object.fromEntries(current.map((c) => [c.channel, c.enabled])) as Record<Channel, boolean>;
    for (const s of body.channels) {
      const cur = current.find((c) => c.channel === s.channel)!;
      if (s.enabled === cur.enabled) continue;
      if (cur.locked) {
        throw new AppError('CHANNEL_LOCKED', s.channel === 'in_app' && t.category === 'essential' ? 'In-app cannot be turned off for essential topics.' : `This topic has no ${s.channel} channel.`, { channel: s.channel });
      }
      if (s.enabled && !cur.available) throw new AppError('CHANNEL_NOT_AVAILABLE', `${s.channel} arrives in launch phase ${CHANNEL_PHASE[s.channel]}.`, { channel: s.channel, phase: Math.max(CHANNEL_PHASE[s.channel], t.phase) });
      next[s.channel] = s.enabled;
    }
    const row = await this.core.repo.updateTopicChannels(key, next, actorText(by.actor), this.core.now());
    if (!row) throw notFound('Topic');
    this.core.invalidateTopics();
    const view = topicView(t, next, phase);
    this.core.ctx.events.publish('notifications.topic.changed', { topicKey: key, channels: view.channels, by: by.actor }, by);
    await this.core.audit(
      {
        action: 'notifications.topic.channels',
        actionLabel: 'Changed notification channels',
        category: 'settings',
        target: { type: 'notification_topic', id: key, label: t.label } as never,
        before: channelSettings(t, before, phase),
        after: view.channels,
        reason: body.reason,
      },
      by,
    );
    return view;
  }

  /* ---------------------------------------------------------------- templates */

  async #templates(): Promise<{ templates: TemplateRow[]; versions: VersionRow[] }> {
    await this.core.ensureSeeded();
    const templates = await this.core.repo.listTemplates();
    const versions = await this.core.repo.versionsOf(templates.map((t) => t.id));
    return { templates, versions };
  }

  async listTemplates(q: { topicKey?: string; audience?: string; channel?: string; hasDraft?: boolean; q?: string }, page: PageRequest): Promise<Page<Template>> {
    const { templates, versions } = await this.#templates();
    const needle = q.q?.trim().toLowerCase();
    const items = templates
      .map((t) => templateOf(t, versions.filter((v) => v.template_id === t.id)))
      .filter((t) => {
        if (q.topicKey && t.topicKey !== q.topicKey) return false;
        if (q.audience && t.audience !== q.audience) return false;
        if (q.channel && t.channel !== q.channel) return false;
        if (q.hasDraft !== undefined && Boolean(t.draft) !== q.hasDraft) return false;
        if (needle) {
          const topic = topicDef(t.topicKey);
          if (!`${t.topicKey} ${topic?.label ?? ''} ${topic?.description ?? ''}`.toLowerCase().includes(needle)) return false;
        }
        return true;
      });
    return pageOf(items, page);
  }

  async #template(id: string) {
    await this.core.ensureSeeded();
    const t = await this.core.repo.getTemplate(id);
    if (!t) throw notFound('Template');
    const topic = topicDef(t.topic_key);
    if (!topic) throw notFound('Template');
    return { t, topic };
  }

  async #version(templateId: string, versionId: string, opts: { forUpdate?: boolean } = {}) {
    const v = await this.core.repo.getVersion(versionId, opts);
    if (!v || v.template_id !== templateId) throw notFound('Template version');
    return v;
  }

  async getTemplate(id: string): Promise<TemplateDetail> {
    const { t, topic } = await this.#template(id);
    const { templates, versions } = await this.#templates();
    const own = versions.filter((v) => v.template_id === t.id);
    const live = own.find((v) => v.id === t.live_version_id);
    const draft = own.find((v) => v.status === 'draft');
    return {
      template: templateOf(t, own),
      topic: topicView(topic, await this.core.channelsOf(topic.key), this.core.launchPhase),
      live: live ? versionOf(live, t) : null,
      draft: draft ? versionOf(draft, t) : null,
      versions: own.map(versionSummaryOf),
      otherChannels: templates.filter((x) => x.topic_key === t.topic_key && x.id !== t.id).map((x) => templateOf(x, versions.filter((v) => v.template_id === x.id))),
    };
  }

  async createDraft(templateId: string, body: { fromVersionId?: string | null }, by: By): Promise<TemplateVersion> {
    const { t } = await this.#template(templateId);
    const v = await this.core.repo.transaction(async (tx) => {
      const versions = await tx.versionsOf([t.id]);
      const existing = versions.find((x) => x.status === 'draft');
      if (existing) throw new AppError('DRAFT_EXISTS', 'This template already has a draft.', { versionId: existing.id });
      const source = body.fromVersionId ? versions.find((x) => x.id === body.fromVersionId) : versions.find((x) => x.id === t.live_version_id) ?? versions[0];
      if (body.fromVersionId && !source) throw notFound('Template version');
      const now = this.core.now();
      return tx.insertVersion({
        id: newId(),
        template_id: t.id,
        version: Math.max(0, ...versions.map((x) => x.version)) + 1,
        status: templateVersionMachine.initial,
        content: (source?.content ?? { body: '', allowPromotionalContent: false }) as never,
        note: body.fromVersionId && source ? `Restored from version ${source.version}` : null,
        created_by: actorText(by.actor),
        created_at: now,
        published_by: null,
        published_at: null,
      });
    });
    await this.core.repo.updateTemplate(t.id, { updated_at: this.core.now() });
    return versionOf(v, t);
  }

  async updateDraft(templateId: string, versionId: string, body: { content: TemplateContent; note?: string | null }): Promise<TemplateVersion> {
    const { t } = await this.#template(templateId);
    const v = await this.#version(templateId, versionId);
    if (v.status !== 'draft') throw illegal('Template version', v.status, 'edit', `only drafts can be edited (this version is ${v.status})`);
    const updated = await this.core.repo.updateVersion(v.id, { content: body.content as never, ...(body.note !== undefined ? { note: body.note } : {}) });
    await this.core.repo.updateTemplate(t.id, { updated_at: this.core.now() });
    return versionOf(updated, t);
  }

  async #contextFor(topic: TopicDef, sample: unknown, linkedRef?: string | null): Promise<Record<string, unknown>> {
    const ctx = merge(sampleContext(topic), sample);
    if (linkedRef) {
      const notice = await this.core.repo.latestNotice({ linkedRef });
      if (notice) {
        const link = linkOf(notice.link);
        setPath(ctx, 'link.url', this.core.linkUrl(topic.audience, link));
        setPath(ctx, 'link.ref', link.ref ?? linkedRef);
        if (link.label) setPath(ctx, 'link.label', link.label);
      } else setPath(ctx, 'link.ref', linkedRef);
    }
    return ctx;
  }

  async preview(templateId: string, versionId: string, body: { device?: 'desktop' | 'phone' | null; sampleContext?: unknown; linkedRef?: string | null }): Promise<RenderPreview> {
    const { t, topic } = await this.#template(templateId);
    const v = await this.#version(templateId, versionId);
    const channel = t.channel as Channel;
    const device = body.device ?? 'desktop';
    const content = v.content as unknown as TemplateContent;
    const ctx = await this.#contextFor(topic, body.sampleContext, body.linkedRef);
    const m = render(topic, channel, content, ctx, device);
    return {
      channel: channel,
      device,
      subject: m.subject,
      preheader: m.preheader,
      html: m.html,
      text: m.text,
      title: m.title,
      footer: m.footer,
      sampleContext: ctx,
      validation: validateContent(topic, channel, content),
    };
  }

  async testSend(templateId: string, versionId: string, body: { to?: string | null; sampleContext?: unknown }, principal: identity.Principal, by: By): Promise<Delivery> {
    const { t, topic } = await this.#template(templateId);
    const v = await this.#version(templateId, versionId);
    const to = body.to ?? (principal.accountId ? (await this.core.account(principal.accountId))?.email : null);
    if (!to) throw new AppError('VALIDATION_FAILED', 'Give an address to send the test to', { issues: [{ path: 'to', message: 'no email address known for your account' }] });
    const allowed = ((await this.core.setting('testSendDomains')) as readonly string[]).map((d) => d.toLowerCase());
    const domain = emailDomain(to);
    if (!allowed.some((d) => domain === d || domain.endsWith(`.${d}`))) throw new AppError('TEST_RECIPIENT_NOT_ALLOWED', `Test sends only go to staff addresses (${allowed.join(', ')}).`, { allowed });
    const content = v.content as unknown as TemplateContent;
    const ctx = await this.#contextFor(topic, body.sampleContext);
    const m = render(topic, 'email', { ...content, subject: content.subject ?? content.title ?? topic.label }, ctx);
    const now = this.core.now();
    const hash = hashAddress('email', to);
    const suppressed = await this.core.repo.activeSuppression('email', hash);
    const row: DeliveryRow = {
      id: newId(),
      notice_id: null,
      topic_key: topic.key,
      channel: 'email',
      recipient_kind: 'staff_member',
      account_id: principal.accountId ?? null,
      address_hash: hash,
      address_masked: maskAddress('email', to),
      status: suppressed ? 'suppressed' : 'queued',
      skip_reason: null,
      attempts: 0,
      last_error: null,
      provider_message_id: null,
      template_version_id: v.id,
      subject: `[Test] ${m.subject ?? topic.label}`,
      linked_ref: null,
      dedupe_key: null,
      broadcast_id: null,
      created_at: now,
      sent_at: null,
      delivered_at: null,
      next_attempt_at: null,
    };
    const senders = (await this.core.setting('senders')) as Record<string, string>;
    const sent = await this.sender.sendPrepared(row, {
      to,
      from: m.sender ?? senders[topic.family] ?? senders.account ?? 'Marketly <no-reply@marketly.example>',
      replyTo: null,
      subject: row.subject!,
      text: m.text,
      html: m.html ?? m.text,
      title: m.title ?? topic.label,
      headers: { 'X-Marketly-Test': `${t.channel} v${v.version}` },
      data: {},
      templateData: ctx,
    });
    void by;
    return deliveryOf(sent ?? row);
  }

  async publish(templateId: string, versionId: string, body: { note?: string | null }, by: By): Promise<TemplateVersion> {
    const { t, topic } = await this.#template(templateId);
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const v = await tx.getVersion(versionId, { forUpdate: true });
      if (!v || v.template_id !== templateId) throw notFound('Template version');
      const status = templateVersionMachine.next(v.status as 'draft', 'publish');
      const validation = validateContent(topic, t.channel as Channel, v.content as unknown as TemplateContent);
      if (!validation.ok) throw new AppError('TEMPLATE_INVALID', 'Fix the blocking issues before publishing.', { issues: validation.issues.filter((i) => i.severity === 'blocking') });
      const now = this.core.now();
      const template = (await tx.getTemplate(templateId))!;
      const previous = template.live_version_id ? await tx.getVersion(template.live_version_id, { forUpdate: true }) : undefined;
      if (previous && previous.status === 'published') await tx.updateVersion(previous.id, { status: templateVersionMachine.next('published', 'supersede') });
      const published = await tx.updateVersion(v.id, { status, published_by: actorText(by.actor), published_at: now, ...(body.note ? { note: body.note } : {}) });
      await tx.updateTemplate(templateId, { live_version_id: v.id, updated_at: now });
      return { before: previous, after: published };
    });
    this.core.invalidateTemplates();
    this.core.ctx.events.publish('notifications.template.published', { templateId, topicKey: topic.key, channel: t.channel, version: after.version, by: by.actor }, by);
    await this.core.audit(
      {
        action: 'notifications.template.publish',
        actionLabel: 'Published notification template',
        category: 'content',
        target: { type: 'notification_template', id: templateId, label: `${topic.label} (${t.channel})` } as never,
        before: before ? { version: before.version, content: before.content } : null,
        after: { version: after.version, content: after.content },
        reason: body.note ?? null,
      },
      by,
    );
    return versionOf(after, t);
  }

  async discard(templateId: string, versionId: string): Promise<TemplateVersion> {
    const { t } = await this.#template(templateId);
    const v = await this.#version(templateId, versionId);
    const status = templateVersionMachine.next(v.status as 'draft', 'discard');
    const updated = await this.core.repo.updateVersion(v.id, { status });
    await this.core.repo.updateTemplate(t.id, { updated_at: this.core.now() });
    return versionOf(updated, t);
  }

  /* ---------------------------------------------------------------- deliveries */

  #addressHash(channel: string | undefined, address: string | undefined) {
    if (!address) return undefined;
    const ch = (channel ?? (address.includes('@') ? 'email' : 'sms')) as DeliveryChannel;
    return hashAddress(ch, ch === 'email' ? normalizeEmail(address) : address);
  }

  async listDeliveries(q: { channel?: string; status?: string; topicKey?: string; accountId?: string; address?: string; linkedRef?: string; from?: string; to?: string }, page: PageRequest): Promise<Page<Delivery>> {
    const res = await this.core.repo.listDeliveries(
      {
        channel: q.channel,
        status: q.status,
        topicKey: q.topicKey,
        accountId: q.accountId,
        addressHash: this.#addressHash(q.channel, q.address),
        linkedRef: q.linkedRef,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
      },
      page,
    );
    return { ...res, items: res.items.map(deliveryOf) };
  }

  async getDelivery(id: string): Promise<DeliveryDetail> {
    const d = await this.core.repo.getDelivery(id);
    if (!d) throw notFound('Delivery');
    const events = await this.core.repo.deliveryEvents(id);
    const timeline: TimelineEvent[] = events.map((e) => ({ at: e.at.toISOString(), label: EVENT_LABELS[e.type] ?? e.type, detail: e.detail }));
    return { delivery: deliveryOf(d), subject: d.subject, events: timeline };
  }

  async retryDelivery(id: string, body: { reason: string }, by: By): Promise<Delivery> {
    const repo = this.core.repo;
    const d = await repo.getDelivery(id);
    if (!d) throw notFound('Delivery');
    deliveryMachine.next(d.status as 'failed', 'retryManually');
    const t = topicDef(d.topic_key);
    if (!t || t.sensitive) throw new AppError('NOT_RETRYABLE', 'This message contained a code or a link that has expired; the person must request a new one.');
    if (await repo.activeSuppression(d.channel, d.address_hash)) throw new AppError('ADDRESS_SUPPRESSED', 'The address is suppressed; remove the suppression first.');
    if (!(await this.sender.canResend(d))) throw new AppError('NOT_RETRYABLE', 'The message can no longer be rebuilt for this address.');
    const queued = await repo.transitionDelivery(id, ['failed'], { status: 'queued', attempts: 0, next_attempt_at: null, last_error: null });
    if (!queued) throw illegal('Delivery', d.status, 'retryManually', 'the delivery changed meanwhile');
    await repo.insertDeliveryEvent({ id: newId(), delivery_id: id, type: 'retry_requested', provider_event_id: null, detail: body.reason, at: this.core.now() });
    const after = (await this.sender.dispatch(id)) ?? queued;
    await this.core.audit(
      {
        action: 'notifications.delivery.retry',
        actionLabel: 'Retried a failed notification',
        category: 'other',
        target: { type: 'notification_delivery', id, ref: d.linked_ref, label: `${t.label} to ${d.address_masked}` } as never,
        before: { status: d.status, lastError: d.last_error },
        after: { status: after.status },
        reason: body.reason,
      },
      by,
    );
    return deliveryOf(after);
  }

  async stats(days = 7): Promise<DeliveryStats> {
    const repo = this.core.repo;
    const now = this.core.now();
    const span = Math.max(1, Math.min(days, 365)) * 86_400_000;
    const rate = async (from: Date, to: Date) => {
      const rows = await repo.deliveryCounts({ channel: 'email', from, to });
      const n = (s: string) => rows.filter((r) => r.status === s).reduce((a, r) => a + r.n, 0);
      const attempted = n('sent') + n('delivered') + n('bounced') + n('complained') + n('failed');
      return attempted ? { rate: (n('delivered') + n('complained')) / attempted, attempted } : { rate: 1, attempted: 0 };
    };
    const current = await rate(new Date(now.getTime() - span), now);
    const previous = await rate(new Date(now.getTime() - 2 * span), new Date(now.getTime() - span));
    return {
      essentialTopics: TOPICS.filter((t) => t.category === 'essential').length,
      channelsLive: CHANNELS.filter((c) => CHANNEL_PHASE[c] <= this.core.launchPhase),
      emailDeliveryRate7d: Math.round(current.rate * 10_000) / 10_000,
      emailDeliveryRateDelta: current.attempted && previous.attempted ? Math.round((current.rate - previous.rate) * 10_000) / 10_000 : null,
      bouncedOrBlocked: await repo.countActiveSuppressions(),
      failedLast24h: await repo.countDeliveries({ statuses: ['failed', 'bounced'], from: new Date(now.getTime() - 86_400_000) }),
      queued: await repo.countDeliveries({ statuses: ['queued', 'sending', 'retrying'] }),
    };
  }

  /* ---------------------------------------------------------------- suppressions */

  async listSuppressions(q: { channel?: string; reason?: string; accountId?: string; address?: string; active?: boolean }, page: PageRequest): Promise<Page<Suppression>> {
    const res = await this.core.repo.listSuppressions({ channel: q.channel, reason: q.reason, accountId: q.accountId, addressHash: this.#addressHash(q.channel, q.address), active: q.active }, page);
    return { ...res, items: res.items.map(suppressionOf) };
  }

  async removeSuppression(id: string, body: { reason: string }, by: By): Promise<Suppression> {
    const s = await this.core.repo.getSuppression(id);
    if (!s) throw notFound('Suppression');
    if (s.removed_at) throw illegal('Suppression', 'removed', 'remove', 'this suppression was already removed');
    const after = await this.core.repo.updateSuppression(id, { removed_at: this.core.now(), removed_by: actorText(by.actor), remove_reason: body.reason });
    this.core.ctx.events.publish('notifications.suppression.removed', { suppressionId: id, accountId: s.account_id, channel: s.channel }, by);
    await this.core.audit(
      {
        action: 'notifications.suppression.remove',
        actionLabel: 'Allowed sending to a suppressed address',
        category: 'customers',
        target: { type: 'notification_suppression', id, label: s.address_masked } as never,
        before: { reason: s.reason, active: true },
        after: { active: false },
        reason: body.reason,
      },
      by,
    );
    return suppressionOf(after);
  }

  /* ---------------------------------------------------------------- broadcasts */

  async #broadcastStats(rows: BroadcastRow[]): Promise<Map<string, BroadcastStats>> {
    const ids = rows.filter((b) => b.status === 'sending' || b.status === 'sent').map((b) => b.id);
    const out = new Map<string, BroadcastStats>();
    if (!ids.length) return out;
    const counts = await this.core.repo.deliveryCounts({ from: new Date('2000-01-01T00:00:00Z'), to: new Date('9999-12-31T00:00:00Z'), broadcastIds: ids });
    for (const id of ids) {
      const n = (s: string[]) => counts.filter((c) => c.broadcast_id === id && s.includes(c.status)).reduce((a, c) => a + c.n, 0);
      const stored = (rows.find((b) => b.id === id)?.stats ?? {}) as Partial<BroadcastStats>;
      out.set(id, {
        recipients: Math.max(stored.recipients ?? 0, n(['queued', 'sending', 'sent', 'delivered', 'retrying', 'failed', 'bounced', 'complained', 'suppressed', 'skipped'])),
        sent: n(['sent', 'delivered', 'bounced', 'complained']),
        delivered: n(['delivered', 'complained']),
        bounced: n(['bounced']),
        unsubscribed: stored.unsubscribed ?? 0,
      });
    }
    return out;
  }

  async broadcastView(rows: BroadcastRow[]): Promise<Broadcast[]> {
    const stats = await this.#broadcastStats(rows);
    return rows.map((b) => broadcastOf(b, stats.get(b.id)));
  }

  async listBroadcasts(q: { status?: string; audience?: string }, page: PageRequest): Promise<Page<Broadcast>> {
    const res = await this.core.repo.listBroadcasts(q, page);
    return { ...res, items: await this.broadcastView(res.items) };
  }

  /** Who a broadcast reaches now: consenting customers or opted-in seller members, minus suppressions */
  async broadcastTargets(audience: 'customers' | 'sellers', channel: DeliveryChannel): Promise<Target[]> {
    const core = this.core;
    if (audience === 'sellers') {
      const rows = await core.repo.promotionsMembers();
      const out: Target[] = [];
      for (const m of rows) {
        const acc = await core.memberAccess(m.seller_id, m.account_id);
        if (acc) out.push({ kind: 'seller', sellerId: m.seller_id, accountId: m.account_id, memberId: m.member_id });
      }
      return out;
    }
    const api = core.customers;
    if (!api) return [];
    const out: Target[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const page = await api.searchCustomers({ statuses: ['active'] }, { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const c of page.items) {
        const consent = await core.consent(c.id);
        const ok = channel === 'email' ? consent?.emailPromotions : channel === 'sms' ? consent?.smsPromotions && consent.smsNumber : consent?.pushPromotions;
        if (!ok) continue;
        if (channel === 'email' && (await core.repo.activeSuppression('email', hashAddress('email', c.email)))) continue;
        out.push({ kind: 'customer', accountId: c.userId, customerId: c.id });
      }
      if (!page.nextCursor || !page.items.length) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  async createBroadcast(input: BroadcastInput, by: By): Promise<Broadcast> {
    const topic = topicDef(input.topicKey);
    if (!topic) throw new AppError('VALIDATION_FAILED', 'Unknown topic', { issues: [{ path: 'topicKey', message: 'not in the topic catalogue' }] });
    if (topic.category !== 'promotional') throw new AppError('TOPIC_NOT_PROMOTIONAL', 'Broadcasts can only use promotional topics.', { topicKey: topic.key });
    const expected = input.audience === 'customers' ? 'customer' : 'seller';
    if (topic.audience !== expected) throw new AppError('VALIDATION_FAILED', `${topic.key} is not a ${expected} topic`, { issues: [{ path: 'topicKey', message: `use a promotional ${expected} topic` }] });
    if (!topic.supports.includes(input.segment.consentChannel)) throw new AppError('VALIDATION_FAILED', `${topic.label} has no ${input.segment.consentChannel} channel`, { issues: [{ path: 'segment.consentChannel', message: 'not a channel of this topic' }] });
    const v = await this.core.repo.getVersion(input.templateVersionId);
    if (!v) throw notFound('Template version');
    const tpl = await this.core.repo.getTemplate(v.template_id);
    if (!tpl || tpl.topic_key !== topic.key) throw new AppError('VALIDATION_FAILED', 'The template version belongs to another topic', { issues: [{ path: 'templateVersionId', message: `not a template of ${topic.key}` }] });
    if (tpl.channel !== input.segment.consentChannel) throw new AppError('VALIDATION_FAILED', `Pick the ${input.segment.consentChannel} template of the topic`, { issues: [{ path: 'templateVersionId', message: `this is the ${tpl.channel} template` }] });
    if (v.status === 'discarded') throw new AppError('VALIDATION_FAILED', 'The template version was discarded', { issues: [{ path: 'templateVersionId', message: 'discarded' }] });
    const validation = validateContent(topic, tpl.channel as Channel, v.content as unknown as TemplateContent);
    if (!validation.ok) throw new AppError('TEMPLATE_INVALID', 'Fix the blocking issues of the template first.', { issues: validation.issues.filter((i) => i.severity === 'blocking') });
    const estimate = (await this.broadcastTargets(input.audience, input.segment.consentChannel)).length;
    const row = await this.core.repo.insertBroadcast({
      id: newId(),
      name: input.name,
      audience: input.audience,
      topic_key: topic.key,
      template_version_id: v.id,
      segment: { consentChannel: input.segment.consentChannel, filters: input.segment.filters ?? {} } as never,
      status: broadcastMachine.initial,
      scheduled_at: null,
      sent_at: null,
      recipient_estimate: estimate,
      stats: emptyStats() as never,
      campaign_id: input.campaignId ?? null,
      created_by: actorText(by.actor),
      created_at: this.core.now(),
    });
    return broadcastOf(row);
  }

  async scheduleBroadcast(id: string, body: { scheduledAt: string }, by: By): Promise<Broadcast> {
    const at = new Date(body.scheduledAt);
    if (at.getTime() < this.core.now().getTime() - 60_000) throw new AppError('VALIDATION_FAILED', 'Pick a time in the future', { issues: [{ path: 'scheduledAt', message: 'in the past' }] });
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const b = await tx.getBroadcast(id, { forUpdate: true });
      if (!b) throw notFound('Broadcast');
      const status = broadcastMachine.next(b.status as 'draft', 'schedule');
      return { before: b, after: await tx.updateBroadcast(id, { status, scheduled_at: at }) };
    });
    this.core.ctx.events.publish('notifications.broadcast.scheduled', { broadcastId: id, audience: after.audience, scheduledAt: at.toISOString(), campaignId: after.campaign_id }, by);
    await this.core.audit(
      { action: 'notifications.broadcast.schedule', actionLabel: 'Scheduled a promotional broadcast', category: 'other', target: { type: 'notification_broadcast', id, label: after.name } as never, before: { status: before.status }, after: { status: after.status, scheduledAt: at.toISOString() } },
      by,
    );
    return (await this.broadcastView([after]))[0]!;
  }

  async cancelBroadcast(id: string, body: { reason: string }, by: By): Promise<Broadcast> {
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const b = await tx.getBroadcast(id, { forUpdate: true });
      if (!b) throw notFound('Broadcast');
      const status = broadcastMachine.next(b.status as 'draft', 'cancel');
      return { before: b, after: await tx.updateBroadcast(id, { status }) };
    });
    await this.core.audit(
      { action: 'notifications.broadcast.cancel', actionLabel: 'Cancelled a promotional broadcast', category: 'other', target: { type: 'notification_broadcast', id, label: after.name } as never, before: { status: before.status }, after: { status: after.status }, reason: body.reason },
      by,
    );
    return (await this.broadcastView([after]))[0]!;
  }

  /** Job: start scheduled broadcasts, send to consenting recipients (quiet hours for SMS and push) */
  async sendDueBroadcasts(): Promise<void> {
    const core = this.core;
    for (const due of await core.repo.dueBroadcasts(core.now(), 10)) {
      const started = await core.repo.transaction(async (tx) => {
        const b = await tx.getBroadcast(due.id, { forUpdate: true });
        if (!b || b.status !== 'scheduled') return null;
        return tx.updateBroadcast(b.id, { status: broadcastMachine.next('scheduled', 'start') });
      });
      if (!started) continue;
      const segment = started.segment as unknown as { consentChannel: DeliveryChannel };
      const channel = segment.consentChannel;
      const targets = await this.broadcastTargets(started.audience as 'customers' | 'sellers', channel);
      const link = { kind: 'campaign', id: started.campaign_id ?? started.id, screen: started.audience === 'customers' ? 'store/deals' : 'seller/marketing', label: 'See more' };
      for (let i = 0; i < targets.length; i += 50) {
        await this.sender.send({
          topic: started.topic_key,
          targets: targets.slice(i, i + 50),
          link,
          dedupeKey: `broadcast:${started.id}`,
          broadcastId: started.id,
          templateVersionId: started.template_version_id,
          only: [channel],
        });
      }
      const stats = (await this.#broadcastStats([{ ...started, status: 'sending' }])).get(started.id) ?? emptyStats();
      stats.recipients = Math.max(stats.recipients, targets.length);
      const sent = await core.repo.updateBroadcast(started.id, { status: broadcastMachine.next('sending', 'finish'), sent_at: core.now(), stats: stats as never });
      core.ctx.events.publish('notifications.broadcast.sent', { broadcastId: sent.id, stats, campaignId: sent.campaign_id }, { actor: SYSTEM });
    }
  }
}
