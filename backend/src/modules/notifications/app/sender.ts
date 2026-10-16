/**
 * The sending pipeline: who receives a topic (customers, guests, seller members by permission and
 * preference, staff by role through access), the in-app notice and per-person read rows, the
 * delivery rows per channel (queued, skipped, suppressed), dispatch through the providers with
 * retries and backoff, provider events (delivered, bounced, complained) and the suppression list.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { NoticeLink } from '../../../spec/notifications.js';
import { topicDef, type Audience, type DeliveryChannel, type TopicDef } from '../domain/catalog.js';
import { backoffMs, effectiveGroups, hashAddress, maskAddress, memberEmails, memberReceives, quietHoursEnd, defaultMemberChannel, addMonths } from '../domain/rules.js';
import { deliveryMachine } from '../domain/state-machines.js';
import { redact, render } from '../domain/templates.js';
import type { DeliveryRow, NoticeRow, ProviderResult, ProviderSyncEvent, RecipientRow, TemplateData } from '../ports.js';
import { actorText, Core, groupBy, SYSTEM } from './core.js';

import type { RecipientKind, RecipientReason, Target } from '../domain/routing.js';

export type { RecipientKind, RecipientReason, Target };
export type SkipReason = 'no_consent' | 'preference_off' | 'account_closed' | 'duplicate';

export interface SendInput {
  topic: string;
  targets: Target[];
  link: NoticeLink;
  context?: Record<string, unknown>;
  /** Ids this notice is about (kept in link.subjects to find who an order, return or case belongs to) */
  subjects?: Record<string, string>;
  dedupeKey?: string | null;
  actionRequired?: boolean | null;
  deadline?: string | Date | null;
  sellerId?: string | null;
  /** Inbox group override (e.g. the staff work area of a queue) */
  group?: string;
  /** Case and message emails carry a signed reply-to address */
  replyTo?: { module: 'support' | 'messaging'; refId: string } | null;
  broadcastId?: string | null;
  /** Template version to render on the restricted channels (broadcasts) */
  templateVersionId?: string | null;
  /** Only these delivery channels (broadcasts go out on their consent channel only) */
  only?: DeliveryChannel[];
  /** Inbox key of the consumed event (ctx.mongo.claim): claimed with the notice and deliveries, so a redelivered event sends nothing */
  claimKey?: string | null;
}

interface DeliveryPlan {
  channel: DeliveryChannel;
  recipientKind: RecipientKind;
  accountId: string | null;
  address: string | null;
  name?: string | null;
  skip?: SkipReason;
  error?: string;
  unsubscribe?: { audience: 'customer' | 'seller'; accountId: string | null; topicGroup: string };
  deferUntil?: Date | null;
}

interface NoticePlan {
  addressKind: NoticeRow['address_kind'];
  addressId: string;
  sellerId: string | null;
  recipients: { accountId: string; reason: RecipientReason; coveringFor: string | null }[];
}

interface Addressee {
  notice?: NoticePlan;
  name?: string | null;
  deliveries: DeliveryPlan[];
}

/** A rendered message waiting for its provider (bodies are never stored) */
export interface Pending {
  to: string;
  from: string;
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  title: string;
  headers: Record<string, string>;
  data: Record<string, string>;
  /** The variables it was rendered from (kept only by the development providers) */
  templateData?: TemplateData;
}

const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] ?? '';

export class Sender {
  readonly #pending = new Map<string, Pending>();

  constructor(private readonly core: Core) {}

  /* ---------------------------------------------------------------- send */

  async send(input: SendInput): Promise<{ noticeIds: string[]; deliveryIds: string[] }> {
    const core = this.core;
    const t = topicDef(input.topic);
    if (!t) throw new AppError('VALIDATION_FAILED', `Unknown notification topic ${input.topic}`, { issues: [{ path: 'topic', message: 'not in the topic catalogue' }] });
    if (t.phase > core.launchPhase) return { noticeIds: [], deliveryIds: [] };
    await core.ensureSeeded();
    const now = core.now();
    const since = new Date(now.getTime() - Number(await core.setting('dedupeWindowMinutes')) * 60_000);
    const retention = Number(await core.setting('noticeRetentionMonths'));
    const dedupeKey = input.dedupeKey ?? null;
    const deadline = input.deadline ? new Date(input.deadline) : null;
    const linkUrl = core.linkUrl(t.audience, input.link);
    const given = input.context ?? {};
    const baseCtx: Record<string, unknown> = { ...given, ...(t.derive?.(given) ?? {}), link: { url: linkUrl, ref: input.link.ref ?? '', label: input.link.label ?? '' } };

    const addressees = mergeAddressees((await Promise.all(input.targets.map((target) => this.#resolve(t, target)))).flat());
    if (input.only) for (const a of addressees) a.deliveries = a.deliveries.filter((d) => input.only!.includes(d.channel));
    const inApp = (await core.live(t, 'in_app')) ? await core.liveTemplate(t, 'in_app') : null;
    const inAppText = inApp ? render(t, 'in_app', inApp.content, baseCtx) : null;

    const notices: NoticeRow[] = [];
    const recipients: RecipientRow[] = [];
    const deliveries: DeliveryRow[] = [];
    const messages = new Map<string, Pending>();
    const link = { ...input.link, url: input.link.url ?? null, ...(input.subjects ? { subjects: compact(input.subjects) } : {}) };

    for (const a of addressees) {
      let noticeId: string | null = null;
      let duplicate = false;
      if (a.notice && inAppText) {
        if (dedupeKey && (await core.repo.noticeExists({ dedupeKey, topicKey: t.key, addressKind: a.notice.addressKind, addressId: a.notice.addressId, since }))) {
          duplicate = true;
        } else {
          noticeId = newId(now.getTime());
          notices.push({
            id: noticeId,
            topic_key: t.key,
            audience: t.audience,
            address_kind: a.notice.addressKind,
            address_id: a.notice.addressId,
            seller_id: a.notice.sellerId,
            group_key: input.group ?? t.group,
            title: inAppText.title ?? t.label,
            body: inAppText.text,
            icon: t.icon,
            tone: t.tone,
            link: link as never,
            linked_ref: input.link.ref ?? null,
            action_required: Boolean(input.actionRequired ?? t.actionRequired),
            deadline_at: deadline,
            dedupe_key: dedupeKey,
            resolved_at: null,
            resolve_note: null,
            expired_at: null,
            created_at: now,
            expires_at: addMonths(now, retention),
          });
          for (const r of a.notice.recipients) recipients.push({ notice_id: noticeId, account_id: r.accountId, reason: r.reason, covering_for: r.coveringFor, read_at: null, archived_at: null, created_at: now });
        }
      }
      for (const p of a.deliveries) {
        const row = await this.#deliveryRow(t, p, { dedupeKey, since, duplicate, noticeId, input, now });
        deliveries.push(row);
        if (row.status === 'queued') {
          const msg = await this.#message(t, p, { ...baseCtx, recipient: { name: firstName(p.name ?? a.name) } }, row, input);
          messages.set(row.id, msg);
          row.subject = t.sensitive ? redact((await core.liveTemplate(t, p.channel)).content.subject ?? t.label) : msg.subject || null;
        }
      }
    }

    const fresh = await core.repo.transaction(async (tx) => {
      if (input.claimKey && !(await tx.claim(input.claimKey))) return false; // this event was already handled
      for (const n of notices) await tx.insertNotice(n);
      await tx.insertRecipients(recipients);
      await tx.insertDeliveries(deliveries);
      for (const d of deliveries) await tx.insertDeliveryEvent({ id: newId(), delivery_id: d.id, type: d.status, provider_event_id: null, detail: d.skip_reason ?? d.last_error ?? null, at: now });
      return true;
    });
    if (!fresh) return { noticeIds: [], deliveryIds: [] };

    for (const [id, m] of messages) this.#pending.set(id, m);
    for (const d of deliveries) {
      if (d.status === 'failed') this.#publishFailed(d, d.last_error ?? 'failed');
    }
    for (const d of deliveries) {
      if (d.status !== 'queued' || d.next_attempt_at) continue;
      try {
        await this.dispatch(d.id);
      } catch (err) {
        core.log.error({ err, deliveryId: d.id }, 'notification dispatch failed');
      }
    }
    return { noticeIds: notices.map((n) => n.id), deliveryIds: deliveries.map((d) => d.id) };
  }

  async #deliveryRow(t: TopicDef, p: DeliveryPlan, o: { dedupeKey: string | null; since: Date; duplicate: boolean; noticeId: string | null; input: SendInput; now: Date }): Promise<DeliveryRow> {
    const repo = this.core.repo;
    const hash = p.address ? hashAddress(p.channel, p.address) : `unknown:${p.accountId ?? 'none'}`;
    let skip: SkipReason | null = p.skip ?? null;
    if (!skip && o.duplicate) skip = 'duplicate';
    if (!skip && !p.error && o.dedupeKey && p.address && (await repo.deliveryExists({ dedupeKey: o.dedupeKey, topicKey: t.key, addressHash: hash, channel: p.channel, since: o.since }))) skip = 'duplicate';
    let status = 'queued';
    if (p.error) status = 'failed';
    else if (skip) status = 'skipped';
    else if (p.address && (await repo.activeSuppression(p.channel, hash))) status = 'suppressed';
    const tpl = status === 'queued' ? await this.core.liveTemplate(t, p.channel) : null;
    return {
      id: newId(o.now.getTime()),
      notice_id: o.noticeId,
      topic_key: t.key,
      channel: p.channel,
      recipient_kind: p.recipientKind,
      account_id: p.accountId,
      address_hash: hash,
      address_masked: p.address ? maskAddress(p.channel, p.address) : 'unknown',
      status,
      skip_reason: status === 'skipped' ? skip : null,
      attempts: 0,
      last_error: p.error ?? null,
      provider_message_id: null,
      template_version_id: o.input.templateVersionId ?? tpl?.versionId ?? null,
      subject: null,
      linked_ref: o.input.link.ref ?? null,
      dedupe_key: o.dedupeKey,
      broadcast_id: o.input.broadcastId ?? null,
      created_at: o.now,
      sent_at: null,
      delivered_at: null,
      next_attempt_at: status === 'queued' && p.deferUntil ? p.deferUntil : null,
    };
  }

  async #message(t: TopicDef, p: DeliveryPlan, ctx: Record<string, unknown>, row: DeliveryRow, input: SendInput): Promise<Pending> {
    const core = this.core;
    const full: Record<string, unknown> = { ...ctx };
    if (p.unsubscribe && p.address) {
      const token = core.sign({ k: 'u', aud: p.unsubscribe.audience, a: p.unsubscribe.accountId, e: p.address, c: p.channel, g: p.unsubscribe.topicGroup });
      full.unsubscribe = { url: p.unsubscribe.audience === 'customer' ? `${core.linkUrl('customer', { kind: 'account', id: 'unsubscribe', screen: 'unsubscribe' })}?token=${token}` : `${core.appUrl('seller')}/seller/notifications/preferences?token=${token}` };
    }
    const tpl = input.templateVersionId ? await this.#versionContent(input.templateVersionId, t, p.channel) : (await core.liveTemplate(t, p.channel)).content;
    const m = render(t, p.channel, tpl, full);
    const senders = (await core.setting('senders')) as Record<string, string>;
    const headers: Record<string, string> = {};
    if (p.unsubscribe && full.unsubscribe) {
      const url = (full.unsubscribe as { url: string }).url;
      headers['List-Unsubscribe'] = `<${url}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    let replyTo: string | null = null;
    if (input.replyTo && p.channel === 'email' && p.address) {
      const domain = String(await core.setting('replyDomain'));
      replyTo = `reply+${core.replyToken(input.replyTo.module, input.replyTo.refId, p.address)}@${domain}`;
    }
    return {
      to: p.address ?? '',
      from: m.sender ?? senders[t.family] ?? senders.account ?? 'Marketly <no-reply@marketly.example>',
      replyTo,
      subject: m.subject ?? m.title ?? t.label,
      text: m.text,
      html: m.html ?? m.text,
      title: m.title ?? t.label,
      headers,
      data: { noticeId: row.notice_id ?? '', topic: t.key, kind: input.link.kind, id: input.link.id, screen: input.link.screen, ...(input.link.ref ? { ref: input.link.ref } : {}) },
      templateData: full,
    };
  }

  async #versionContent(versionId: string, t: TopicDef, channel: DeliveryChannel) {
    const v = await this.core.repo.getVersion(versionId);
    return v ? (v.content as never) : (await this.core.liveTemplate(t, channel)).content;
  }

  /* ---------------------------------------------------------------- recipients */

  async #resolve(t: TopicDef, target: Target): Promise<Addressee[]> {
    switch (target.kind) {
      case 'customer':
        return this.#customer(t, target);
      case 'guest':
        if (!(await this.core.live(t, 'email'))) return [];
        return [{ deliveries: [{ channel: 'email', recipientKind: 'guest_email', accountId: null, address: target.email, ...(t.category === 'promotional' ? { skip: 'no_consent' as const } : {}) }] }];
      case 'email':
        if (!(await this.core.live(t, 'email'))) return [];
        return [{ deliveries: [{ channel: 'email', recipientKind: target.recipientKind ?? 'guest_email', accountId: target.accountId ?? null, address: target.email }] }];
      case 'external':
        // people outside Marketly: essential topics only, by email, never an inbox notice
        if (t.category !== 'essential') {
          this.core.log.warn({ topic: t.key }, 'external recipients only receive essential topics; skipped');
          return [];
        }
        if (!(await this.core.live(t, 'email'))) return [];
        return [{ name: target.name ?? null, deliveries: [{ channel: 'email', recipientKind: 'external_email', accountId: null, address: target.email, name: target.name ?? null }] }];
      case 'phone':
        if (!(await this.core.live(t, 'sms'))) return [];
        return [{ deliveries: [{ channel: 'sms', recipientKind: target.accountId ? 'customer' : 'guest_email', accountId: target.accountId ?? null, address: target.phone }] }];
      case 'seller':
        return this.#seller(t, target);
      case 'role':
        return this.#role(t, target.roleKey);
      case 'staff':
        return this.#staff(t, [{ accountId: target.accountId, reason: target.reason ?? 'direct' }]);
    }
  }

  async #customer(t: TopicDef, target: { accountId?: string | null; customerId?: string | null }): Promise<Addressee[]> {
    const core = this.core;
    let accountId = target.accountId ?? null;
    let snap = null;
    if (target.customerId) {
      snap = await core.customer(target.customerId);
      accountId ??= snap?.userId ?? null;
    } else if (accountId) snap = await core.customerByAccount(accountId);
    if (!accountId) {
      core.log.debug({ topic: t.key, customerId: target.customerId }, 'customer not found for notice');
      return [];
    }
    const acct = snap?.email ? null : await core.account(accountId);
    const email = snap?.email ?? acct?.email ?? null;
    const name = snap?.displayName ?? acct?.displayName ?? null;
    const closed = snap?.accountStatus === 'closed' || acct?.status === 'closed';
    const promo = t.category === 'promotional';
    const consent = promo && snap ? await core.consent(snap.id) : null;
    const consentFor = (channel: 'in_app' | DeliveryChannel) => {
      if (!promo) return true;
      if (!consent) return false;
      if (t.key === 'customer.wishlist.alert') return consent.wishlistAlerts;
      return channel === 'email' ? consent.emailPromotions : channel === 'sms' ? consent.smsPromotions : channel === 'push' ? consent.pushPromotions : false;
    };
    const skipFor = (channel: DeliveryChannel): SkipReason | undefined => (closed && t.category !== 'essential' ? 'account_closed' : !consentFor(channel) ? 'no_consent' : undefined);
    const unsubscribe = promo ? { audience: 'customer' as const, accountId, topicGroup: t.key === 'customer.wishlist.alert' ? 'wishlist_alerts' : 'promotions' } : undefined;
    const quiet = promo ? await this.#quietUntil() : null;
    const deliveries: DeliveryPlan[] = [];
    if (await core.live(t, 'email')) {
      deliveries.push(email ? { channel: 'email', recipientKind: 'customer', accountId, address: email, name, skip: skipFor('email'), unsubscribe } : { channel: 'email', recipientKind: 'customer', accountId, address: null, error: 'No email address known for this account' });
    }
    if (await core.live(t, 'sms')) {
      const phone = promo ? (consent?.smsNumber ?? null) : (snap?.phone ?? null);
      if (phone) deliveries.push({ channel: 'sms', recipientKind: 'customer', accountId, address: phone, name, skip: skipFor('sms'), unsubscribe, deferUntil: quiet });
    }
    if (await core.live(t, 'push')) {
      for (const d of await core.repo.pushDevices({ accountIds: [accountId], audience: 'customer', activeOnly: true })) {
        const token = core.decryptToken(d.token_encrypted);
        if (token) deliveries.push({ channel: 'push', recipientKind: 'customer', accountId, address: token, name, skip: skipFor('push'), deferUntil: quiet });
      }
    }
    const showNotice = !(promo && (closed || !consentFor('in_app')));
    return [{ name, deliveries, ...(showNotice ? { notice: { addressKind: 'customer', addressId: accountId, sellerId: null, recipients: [{ accountId, reason: 'direct', coveringFor: null }] } } : {}) }];
  }

  async #seller(t: TopicDef, target: { sellerId: string; accountId?: string | null; memberId?: string | null }): Promise<Addressee[]> {
    const core = this.core;
    const { sellerId } = target;
    const direct = Boolean(target.accountId || target.memberId);
    // stored preferences plus the members sellers lists who never opened Seller Center (owner-only topics: the owner)
    let members = await core.sellerMembers(sellerId, !direct && t.ownerOnly);
    if (direct) {
      members = members.filter((m) => (target.memberId && m.member_id === target.memberId) || (target.accountId && m.account_id === target.accountId));
      if (!members.length && target.accountId) {
        members = [{ seller_id: sellerId, member_id: target.memberId ?? target.accountId, account_id: target.accountId, groups: {}, channel: defaultMemberChannel(false), updated_by: actorText(SYSTEM), updated_at: core.now() }];
      }
    }
    const directAccount = direct ? (target.accountId ?? members[0]?.account_id ?? null) : null;
    const promo = t.category === 'promotional';
    const quiet = promo ? await this.#quietUntil() : null;
    const emailLive = await core.live(t, 'email');
    const pushLive = await core.live(t, 'push');
    const accounts = emailLive ? await core.accounts(members.map((m) => m.account_id)) : new Map();
    // every member's push devices in one read (the loop below picks each member's)
    const devices = pushLive ? groupBy(await core.repo.pushDevices({ accountIds: members.map((m) => m.account_id), audience: 'seller', sellerId, activeOnly: true }), (d) => d.account_id) : new Map<string, never[]>();
    const deliveries: DeliveryPlan[] = [];
    for (const m of members) {
      const acc = await core.memberAccess(sellerId, m.account_id);
      if (!acc) continue; // not (or no longer) a member, or sellers is off: in-app only
      const groups = effectiveGroups(m.groups as Record<string, unknown>, acc.isOwner);
      const allOn = Object.fromEntries(Object.keys(groups).map((k) => [k, true]));
      if (!memberReceives(t, acc, allOn)) continue;
      const receives = memberReceives(t, acc, groups);
      const skip: SkipReason | undefined = receives ? undefined : promo ? 'no_consent' : 'preference_off';
      const name = accounts.get(m.account_id)?.displayName ?? null;
      if (emailLive && (memberEmails(t, acc, m.channel as never) || !receives)) {
        const email = accounts.get(m.account_id)?.email ?? null;
        deliveries.push(
          email
            ? { channel: 'email', recipientKind: 'seller_member', accountId: m.account_id, address: email, name, skip, ...(promo ? { unsubscribe: { audience: 'seller' as const, accountId: m.account_id, topicGroup: 'promotions' } } : {}) }
            : { channel: 'email', recipientKind: 'seller_member', accountId: m.account_id, address: null, error: 'No email address known for this member' },
        );
      }
      if (pushLive && receives) {
        for (const d of devices.get(m.account_id) ?? []) {
          const token = core.decryptToken(d.token_encrypted);
          if (token) deliveries.push({ channel: 'push', recipientKind: 'seller_member', accountId: m.account_id, address: token, name, deferUntil: quiet });
        }
      }
    }
    const notice: NoticePlan | undefined =
      direct && !directAccount
        ? undefined
        : {
            addressKind: 'seller',
            addressId: directAccount ? `${sellerId}/${directAccount}` : sellerId,
            sellerId,
            recipients: directAccount ? [{ accountId: directAccount, reason: 'direct', coveringFor: null }] : [],
          };
    return [{ deliveries, ...(notice ? { notice } : {}) }];
  }

  async #role(t: TopicDef, roleKey: string): Promise<Addressee[]> {
    const core = this.core;
    const res = await core.resolveRole(roleKey);
    if (!res) core.log.debug({ roleKey, topic: t.key }, 'access is off: role notice without recipients');
    const acting = [...new Set(res?.accountIds ?? [])];
    const cc = [...new Set(res?.ccAccountIds ?? [])].filter((id) => !acting.includes(id));
    const lead = res?.leadAccountId ?? null;
    const names = await core.accounts([...acting, ...cc, lead]);
    const leadName = lead ? (names.get(lead)?.displayName ?? null) : null;
    const recipients = [
      ...acting.map((id) => ({ accountId: id, reason: (id === lead ? 'lead' : res?.viaBackup ? 'backup' : 'member') as RecipientReason, coveringFor: res?.viaBackup && id !== lead ? leadName : null })),
      ...cc.map((id) => ({ accountId: id, reason: 'lead' as RecipientReason, coveringFor: null })),
    ];
    // the away lead sees the copy on return; email goes to the people acting now
    const deliveries = await this.#staffEmails(t, recipients.filter((r) => acting.includes(r.accountId)), names);
    return [{ notice: { addressKind: 'role', addressId: roleKey, sellerId: null, recipients }, deliveries }];
  }

  async #staff(t: TopicDef, people: { accountId: string; reason: RecipientReason }[]): Promise<Addressee[]> {
    const names = await this.core.accounts(people.map((p) => p.accountId));
    const out: Addressee[] = [];
    for (const p of people) {
      out.push({
        notice: { addressKind: 'staff', addressId: p.accountId, sellerId: null, recipients: [{ accountId: p.accountId, reason: p.reason, coveringFor: null }] },
        name: names.get(p.accountId)?.displayName ?? null,
        deliveries: await this.#staffEmails(t, [p], names),
      });
    }
    return out;
  }

  async #staffEmails(t: TopicDef, people: { accountId: string; reason: RecipientReason }[], names: Map<string, { email: string; displayName: string }>): Promise<DeliveryPlan[]> {
    if (!people.length || !(await this.core.live(t, 'email'))) return [];
    const prefs = new Map((await this.core.repo.staffPreferences(people.map((p) => p.accountId))).map((p) => [p.account_id, p]));
    const out: DeliveryPlan[] = [];
    for (const p of people) {
      const pref = prefs.get(p.accountId);
      let email: boolean;
      if (t.urgent || t.sensitive || !t.supports.includes('in_app')) email = true;
      else if (p.reason === 'mention') email = pref?.email_for_mentions ?? true;
      else if (pref?.daily_digest) email = false;
      else email = ((pref?.email_by_area ?? {}) as Record<string, boolean>)[t.group] ?? true;
      if (!email) continue;
      const a = names.get(p.accountId);
      out.push(a?.email ? { channel: 'email', recipientKind: 'staff_member', accountId: p.accountId, address: a.email, name: a.displayName } : { channel: 'email', recipientKind: 'staff_member', accountId: p.accountId, address: null, error: 'No email address known for this staff member' });
    }
    return out;
  }

  async #quietUntil(): Promise<Date | null> {
    const window = (await this.core.setting('promotionalQuietHours')) as { from: string; to: string };
    return quietHoursEnd(this.core.now(), window, this.core.timeZone);
  }

  /* ---------------------------------------------------------------- dispatch */

  /** Sends one queued or retrying delivery now (claimed atomically, so it is never sent twice) */
  async dispatch(id: string): Promise<DeliveryRow | undefined> {
    const core = this.core;
    const repo = core.repo;
    const row = await repo.getDelivery(id);
    if (!row || (row.status !== 'queued' && row.status !== 'retrying')) return row;
    const now = core.now();
    const max = Number(await core.setting('maxDeliveryAttempts'));
    const msg = this.#pending.get(id) ?? (await this.#rebuild(row));
    deliveryMachine.next(row.status as 'queued' | 'retrying', 'send');
    const claimed = await repo.transitionDelivery(id, [row.status], { status: 'sending', attempts: row.attempts + 1, next_attempt_at: null });
    if (!claimed) return repo.getDelivery(id);
    if (!msg) return this.#fail(claimed, 'The content is no longer available (sensitive or expired); the person must request it again');

    let result: ProviderResult;
    try {
      result = await this.#provider(claimed, msg);
    } catch (err) {
      result = { ok: false, temporary: true, error: (err as Error).message || 'Provider error' };
    }
    if (result.ok) {
      const sent = await repo.transitionDelivery(id, ['sending'], { status: deliveryMachine.next('sending', 'accept'), provider_message_id: result.providerMessageId, sent_at: now, last_error: null });
      await repo.insertDeliveryEvent({ id: newId(), delivery_id: id, type: 'sent', provider_event_id: null, detail: `Accepted by ${this.#providerName(claimed.channel)}`, at: now });
      this.#pending.delete(id);
      let current = sent;
      for (const ev of result.events ?? []) if (current) current = (await this.applyEvent(current, { ...ev, at: now, providerEventId: null })) ?? current;
      return current ?? repo.getDelivery(id);
    }
    if (result.invalidToken && claimed.channel === 'push') {
      const device = await repo.pushDeviceByHash(claimed.address_hash);
      if (device) await repo.updatePushDevice(device.id, { invalidated_at: now, enabled: false });
    }
    if (result.temporary && claimed.attempts < max) {
      const backoff = (await core.setting('retryBackoffMinutes')) as readonly number[];
      const next = new Date(now.getTime() + backoffMs(claimed.attempts, backoff));
      const retrying = await repo.transitionDelivery(id, ['sending'], { status: deliveryMachine.next('sending', 'temporaryFailure'), last_error: result.error, next_attempt_at: next });
      await repo.insertDeliveryEvent({ id: newId(), delivery_id: id, type: 'retrying', provider_event_id: null, detail: `${result.error}; next attempt ${next.toISOString()}`, at: now });
      return retrying;
    }
    return this.#fail(claimed, result.error);
  }

  async #fail(row: DeliveryRow, error: string): Promise<DeliveryRow | undefined> {
    const repo = this.core.repo;
    const now = this.core.now();
    const failed = await repo.transitionDelivery(row.id, ['sending'], { status: deliveryMachine.next('sending', 'permanentFailure'), last_error: error, next_attempt_at: null });
    await repo.insertDeliveryEvent({ id: newId(), delivery_id: row.id, type: 'failed', provider_event_id: null, detail: error, at: now });
    this.#pending.delete(row.id);
    if (failed) this.#publishFailed(failed, error);
    return failed;
  }

  /** Records and sends one prepared message (template test sends) */
  async sendPrepared(row: DeliveryRow, msg: Pending): Promise<DeliveryRow | undefined> {
    const repo = this.core.repo;
    await repo.transaction(async (tx) => {
      await tx.insertDeliveries([row]);
      await tx.insertDeliveryEvent({ id: newId(), delivery_id: row.id, type: row.status, provider_event_id: null, detail: row.skip_reason ?? null, at: this.core.now() });
    });
    if (row.status !== 'queued') return row;
    this.#pending.set(row.id, msg);
    return this.dispatch(row.id);
  }

  /** retrying → failed once maxDeliveryAttempts is reached */
  async giveUp(row: DeliveryRow): Promise<void> {
    const repo = this.core.repo;
    const error = row.last_error ?? 'Too many failed attempts';
    const failed = await repo.transitionDelivery(row.id, ['retrying'], { status: deliveryMachine.next('retrying', 'giveUp'), next_attempt_at: null });
    if (!failed) return;
    await repo.insertDeliveryEvent({ id: newId(), delivery_id: row.id, type: 'failed', provider_event_id: null, detail: `Gave up after ${row.attempts} attempts: ${error}`, at: this.core.now() });
    this.#pending.delete(row.id);
    this.#publishFailed(failed, error);
  }

  #publishFailed(d: DeliveryRow, error: string) {
    this.core.ctx.events.publish('notifications.delivery.failed', {
      deliveryId: d.id,
      topicKey: d.topic_key,
      channel: d.channel,
      recipientKind: d.recipient_kind,
      accountId: d.account_id,
      linkedRef: d.linked_ref,
      error,
    });
  }

  #providerName(channel: string) {
    return channel === 'email' ? this.core.providers.email.name : channel === 'sms' ? this.core.providers.sms.name : this.core.providers.push.name;
  }

  async #provider(d: DeliveryRow, m: Pending): Promise<ProviderResult> {
    const tags = { deliveryId: d.id, topicKey: d.topic_key };
    const p = this.core.providers;
    const templateData = m.templateData;
    if (d.channel === 'email') return p.email.send({ to: m.to, from: m.from, replyTo: m.replyTo, subject: m.subject, text: m.text, html: m.html, headers: m.headers, tags, templateData });
    if (d.channel === 'sms') return p.sms.send({ to: m.to, text: m.text, tags, templateData });
    return p.push.send({ token: m.to, title: m.title, body: m.text, data: m.data, tags, templateData });
  }

  /** Whether a delivery's message can still be sent (kept in memory, or rebuilt from its notice) */
  async canResend(row: DeliveryRow): Promise<boolean> {
    return this.#pending.has(row.id) || Boolean(await this.#rebuild(row, true));
  }

  /**
   * Rebuilds a message whose rendered copy is gone (process restart): from the in-app notice or the
   * broadcast template, to the account's current address. Sensitive topics are never rebuilt.
   */
  async #rebuild(row: DeliveryRow, probe = false): Promise<Pending | null> {
    const core = this.core;
    const t = topicDef(row.topic_key);
    if (!t || t.sensitive) return null;
    let to: string | null = null;
    if (row.channel === 'email' && row.account_id) {
      const acct = await core.account(row.account_id);
      if (acct?.email && hashAddress('email', acct.email) === row.address_hash) to = acct.email;
    } else if (row.channel === 'push') {
      const device = await core.repo.pushDeviceByHash(row.address_hash);
      to = device && !device.invalidated_at ? core.decryptToken(device.token_encrypted) : null;
    }
    if (!to) return null;
    const notice = row.notice_id ? await core.repo.findNotice(row.notice_id) : undefined;
    if (!notice && !row.broadcast_id) return null;
    if (probe) return { to } as Pending;
    const link = (notice?.link ?? { kind: 'account', id: 'notifications', screen: 'account/notifications' }) as unknown as NoticeLink;
    const ctx: Record<string, unknown> = { link: { url: core.linkUrl(t.audience, link), ref: link.ref ?? '', label: link.label ?? '' } };
    const content = row.template_version_id ? await this.#versionContent(row.template_version_id, t, row.channel as DeliveryChannel) : (await core.liveTemplate(t, row.channel as DeliveryChannel)).content;
    const m = notice
      ? { subject: row.subject ?? notice.title, title: notice.title, text: `${notice.body}\n\n${core.linkUrl(t.audience, link)}`, html: render(t, 'email', { ...content, title: notice.title, body: notice.body }, ctx).html }
      : { subject: row.subject ?? t.label, title: t.label, ...(() => { const r = render(t, row.channel as DeliveryChannel, content, ctx); return { text: r.text, html: r.html }; })() };
    const senders = (await core.setting('senders')) as Record<string, string>;
    return { to, from: senders[t.family] ?? senders.account ?? 'Marketly <no-reply@marketly.example>', replyTo: null, subject: m.subject, text: m.text, html: m.html ?? m.text, title: m.title, headers: {}, data: { noticeId: row.notice_id ?? '', topic: t.key }, templateData: ctx };
  }

  /* ---------------------------------------------------------------- provider events */

  /**
   * One provider event for a delivery (webhook or synchronous dev adapter). Idempotent per provider
   * event id. Hard bounces and complaints add a suppression.
   */
  async applyEvent(d: DeliveryRow, ev: ProviderSyncEvent & { at: Date; providerEventId: string | null }): Promise<DeliveryRow | undefined> {
    const repo = this.core.repo;
    const type = ev.type === 'bounced' && ev.bounceType ? `bounced_${ev.bounceType}` : ev.type;
    const fresh = await repo.insertDeliveryEvent({ id: newId(), delivery_id: d.id, type, provider_event_id: ev.providerEventId, detail: ev.detail ?? null, at: ev.at });
    if (!fresh) return d;
    let row: DeliveryRow | undefined = d;
    const move = async (event: 'deliver' | 'bounce' | 'complain', patch: Partial<DeliveryRow> = {}) => {
      if (!row || !deliveryMachine.can(row.status as never, event)) return;
      row = (await repo.transitionDelivery(row.id, [row.status], { status: deliveryMachine.next(row.status as never, event), ...patch })) ?? row;
    };
    switch (ev.type) {
      case 'delivered':
        await move('deliver', { delivered_at: ev.at });
        break;
      case 'bounced':
        if (ev.bounceType !== 'soft') {
          await move('bounce', { last_error: ev.detail ?? 'Hard bounce' });
          await this.suppress({ channel: d.channel as DeliveryChannel, addressHash: d.address_hash, addressMasked: d.address_masked, accountId: d.account_id, reason: 'hard_bounce', source: `provider bounce (${this.#providerName(d.channel)})` });
          if (row) this.#publishFailed(row, ev.detail ?? 'Hard bounce');
        }
        break;
      case 'rejected':
        await move('bounce', { last_error: ev.detail ?? 'Rejected by the provider' });
        if (row) this.#publishFailed(row, ev.detail ?? 'Rejected by the provider');
        break;
      case 'complained':
        if (row.status === 'sent') await move('deliver', { delivered_at: ev.at });
        await move('complain');
        await this.suppress({ channel: d.channel as DeliveryChannel, addressHash: d.address_hash, addressMasked: d.address_masked, accountId: d.account_id, reason: 'complaint', source: `spam complaint (${this.#providerName(d.channel)})` });
        break;
      default:
        break; // opened, deferred: recorded only
    }
    return row;
  }

  /** Adds the address to the suppression list (once) and announces it */
  async suppress(s: { channel: DeliveryChannel; addressHash: string; addressMasked: string; accountId: string | null; reason: 'hard_bounce' | 'complaint' | 'invalid' | 'manual'; source: string; eventReason?: 'stop' }): Promise<boolean> {
    if (s.addressHash.startsWith('unknown:')) return false;
    const row = await this.core.repo.insertSuppression({
      id: newId(),
      channel: s.channel,
      address_hash: s.addressHash,
      address_masked: s.addressMasked,
      account_id: s.accountId,
      reason: s.reason,
      source: s.source,
      created_at: this.core.now(),
      removed_at: null,
      removed_by: null,
      remove_reason: null,
    });
    if (!row) return false;
    this.core.ctx.events.publish('notifications.address.suppressed', { channel: s.channel, accountId: s.accountId, addressMasked: s.addressMasked, reason: s.eventReason ?? s.reason });
    return true;
  }

  /** Audience of a topic key, for links */
  audienceOf(key: string): Audience {
    return topicDef(key)?.audience ?? 'customer';
  }
}

/** One addressee per notice address (the same staff member listed twice gets one notice) */
function mergeAddressees(list: Addressee[]): Addressee[] {
  const out: Addressee[] = [];
  const byAddress = new Map<string, Addressee>();
  const seenDelivery = new Set<string>();
  for (const a of list) {
    const deliveries = a.deliveries.filter((d) => {
      const k = `${d.channel}|${d.address ?? `acct:${d.accountId}`}`;
      if (seenDelivery.has(k)) return false;
      seenDelivery.add(k);
      return true;
    });
    if (!a.notice) {
      out.push({ ...a, deliveries });
      continue;
    }
    const key = `${a.notice.addressKind}|${a.notice.addressId}`;
    const prev = byAddress.get(key);
    if (prev) {
      prev.deliveries.push(...deliveries);
      for (const r of a.notice.recipients) if (!prev.notice!.recipients.some((x) => x.accountId === r.accountId)) prev.notice!.recipients.push(r);
      continue;
    }
    const merged = { ...a, deliveries };
    byAddress.set(key, merged);
    out.push(merged);
  }
  return out;
}

const compact = (o: Record<string, string | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string' && v));
