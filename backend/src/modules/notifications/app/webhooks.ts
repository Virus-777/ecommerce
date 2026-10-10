/**
 * Provider webhooks (signature verified by the middleware): email delivery events, SMS receipts and
 * STOP/START replies, and inbound replies to case and message emails. Idempotent per provider event id.
 */
import { isAppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as media from '../../../spec/media.js';
import type { InboundEmail, ProviderEmailEvent } from '../../../spec/notifications.js';
import type { DeliveryRow } from '../ports.js';
import { emailDomain, hashAddress, maskAddress, normalizeEmail } from '../domain/rules.js';
import { actorText, Core } from './core.js';
import type { Sender } from './sender.js';

export interface SmsEvent {
  providerEventId: string;
  providerMessageId?: string | null;
  type: 'delivered' | 'failed' | 'stop' | 'start';
  phone: string;
  at: string;
}

/** Strips quoted history and signatures from an email reply */
export function replyText(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim()) || /^From:\s/.test(line.trim())) break;
    if (line.trim() === '--') break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim() || text.trim();
}

export class Webhooks {
  constructor(
    private readonly core: Core,
    private readonly sender: Sender,
  ) {}

  async emailEvents(events: ProviderEmailEvent[]): Promise<void> {
    const repo = this.core.repo;
    for (const ev of events) {
      const at = new Date(ev.at);
      const d = await repo.deliveryByProviderMessage(ev.providerMessageId);
      if (d) {
        await this.sender.applyEvent(d, { type: ev.type, bounceType: ev.bounceType ?? undefined, detail: ev.detail ?? undefined, at, providerEventId: ev.providerEventId });
        continue;
      }
      // unknown message (sent before the log was purged): still honour hard bounces and complaints
      if ((ev.type === 'bounced' && ev.bounceType !== 'soft') || ev.type === 'complained') {
        await this.sender.suppress({
          channel: 'email',
          addressHash: hashAddress('email', ev.recipient),
          addressMasked: maskAddress('email', ev.recipient),
          accountId: null,
          reason: ev.type === 'complained' ? 'complaint' : 'hard_bounce',
          source: `provider ${ev.type} (${this.core.providers.email.name})`,
        });
      } else this.core.log.debug({ providerMessageId: ev.providerMessageId }, 'email event for an unknown message ignored');
    }
  }

  async smsEvent(ev: SmsEvent): Promise<void> {
    const core = this.core;
    const repo = core.repo;
    const hash = hashAddress('sms', ev.phone);
    const at = new Date(ev.at);
    const d = (ev.providerMessageId ? await repo.deliveryByProviderMessage(ev.providerMessageId) : undefined) ?? (ev.type === 'stop' || ev.type === 'start' ? await repo.latestDeliveryTo(hash) : undefined);
    switch (ev.type) {
      case 'delivered':
        if (d) await this.sender.applyEvent(d, { type: 'delivered', at, providerEventId: ev.providerEventId });
        return;
      case 'failed':
        if (d) await this.sender.applyEvent(d, { type: 'rejected', detail: 'The carrier could not deliver the text', at, providerEventId: ev.providerEventId });
        return;
      case 'stop': {
        if (d && !(await repo.insertDeliveryEvent({ id: newId(), delivery_id: d.id, type: 'stop', provider_event_id: ev.providerEventId, detail: 'STOP reply', at }))) return;
        await this.sender.suppress({ channel: 'sms', addressHash: hash, addressMasked: maskAddress('sms', ev.phone), accountId: d?.account_id ?? null, reason: 'manual', source: 'sms_stop', eventReason: 'stop' });
        return;
      }
      case 'start': {
        if (d && !(await repo.insertDeliveryEvent({ id: newId(), delivery_id: d.id, type: 'start', provider_event_id: ev.providerEventId, detail: 'START reply', at }))) return;
        const s = await repo.activeSuppression('sms', hash);
        if (!s || s.source !== 'sms_stop') return;
        await repo.updateSuppression(s.id, { removed_at: core.now(), removed_by: actorText({ kind: 'provider', name: core.providers.sms.name }), remove_reason: 'START reply' });
        core.ctx.events.publish('notifications.suppression.removed', { suppressionId: s.id, accountId: s.account_id, channel: 'sms' });
        return;
      }
    }
  }

  async inbound(mail: InboundEmail): Promise<void> {
    const core = this.core;
    const domain = String(await core.setting('replyDomain')).toLowerCase();
    const to = mail.to.trim().replace(/^.*<([^>]+)>.*$/, '$1');
    const m = /^reply\+([^@]+)@(.+)$/i.exec(to);
    const parsed = m && m[2]!.toLowerCase() === domain ? core.parseReply(m[1]!, mail.from) : null;
    if (parsed) {
      const last = await core.repo.latestDeliveryTo(hashAddress('email', mail.from));
      const owner = await this.#ownerOf(last);
      const { ids, refused } = await this.#storeAttachments(mail, parsed.module === 'messaging' ? 'message_attachment' : 'case_evidence', owner);
      core.ctx.events.publish('notifications.email_reply.received', {
        module: parsed.module,
        refId: parsed.refId,
        fromEmail: normalizeEmail(mail.from),
        accountId: last?.account_id ?? null,
        text: replyText(mail.text),
        attachmentAssetIds: ids,
        receivedAt: new Date(mail.receivedAt).toISOString(),
      });
      // the reply went through; files media refused are named in an automatic answer
      if (refused.length) {
        await this.sender.send({
          topic: 'customer.account.reply_attachments_refused',
          targets: [{ kind: 'guest', email: mail.from }],
          link: { kind: 'account', id: 'messages', screen: parsed.module === 'messaging' ? 'account/messages' : 'help/case', label: 'Open my account' },
          context: { attachments: { refused: refused.join('; ') } },
          dedupeKey: `inbound:${mail.providerEventId}:refused`,
        });
      }
      return;
    }
    // never answer our own addresses (mail loops)
    const from = emailDomain(mail.from);
    if (from === domain || from.endsWith('marketly.example')) return;
    await this.sender.send({
      topic: 'customer.account.reply_not_delivered',
      targets: [{ kind: 'guest', email: mail.from }],
      link: { kind: 'account', id: 'messages', screen: 'account/messages', label: 'Open my account' },
      dedupeKey: `inbound:${mail.providerEventId}`,
    });
  }

  /** Who owns files that came with a reply: the customer or seller the last email to that address went to, else a guest */
  async #ownerOf(last: DeliveryRow | undefined): Promise<media.MediaOwner> {
    if (!last?.account_id) return { kind: 'guest', id: null };
    if (last.recipient_kind === 'seller_member') {
      const notice = last.notice_id ? await this.core.repo.findNotice(last.notice_id) : undefined;
      if (notice?.seller_id) return { kind: 'seller', id: notice.seller_id };
    }
    if (last.recipient_kind === 'customer') return { kind: 'customer', id: last.account_id };
    return { kind: 'guest', id: null };
  }

  /**
   * Inbound attachments through media.storeInboundFile (scanned and processed like uploads). Files media refuses
   * (type or size) and files that cannot be fetched are returned by name for the automatic answer.
   */
  async #storeAttachments(mail: InboundEmail, purpose: 'message_attachment' | 'case_evidence', owner: media.MediaOwner): Promise<{ ids: string[]; refused: string[] }> {
    const ids: string[] = [];
    const refused: string[] = [];
    const list = mail.attachments ?? [];
    if (!list.length) return { ids, refused };
    const core = this.core;
    const api = core.ctx.tryUse('media');
    const fetcher = core.providers.email.fetchAttachment?.bind(core.providers.email);
    for (const a of list) {
      const name = a.fileName?.trim() || 'attachment';
      if (!api || !fetcher) {
        refused.push(`${name} (attachments by email are not accepted right now; add it in your account)`);
        continue;
      }
      if (a.sizeBytes > MAX_INBOUND_BYTES) {
        refused.push(`${name} (too large)`);
        continue;
      }
      try {
        const body = await fetcher(a.downloadUrl, { maxBytes: MAX_INBOUND_BYTES });
        const asset = await api.storeInboundFile({ owner, purpose, fileName: name, contentType: a.contentType || 'application/octet-stream', body, source: `inbound-email:${mail.providerEventId}` });
        ids.push(asset.id);
      } catch (err) {
        const code = isAppError(err) ? err.code : null;
        if (code === 'FILE_TYPE_NOT_ALLOWED') refused.push(`${name} (this file type is not accepted)`);
        else if (code === 'FILE_TOO_LARGE') refused.push(`${name} (too large)`);
        else {
          core.log.warn({ err, providerEventId: mail.providerEventId, fileName: name }, 'inbound attachment could not be stored');
          refused.push(`${name} (could not be received)`);
        }
      }
    }
    return { ids, refused };
  }
}

/** Inbound attachments larger than this are refused before fetching (media applies the purpose's own limit) */
const MAX_INBOUND_BYTES = 25 * 1024 * 1024;
