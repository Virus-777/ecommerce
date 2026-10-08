/**
 * Provider webhooks (signature verified by the middleware): email delivery events, SMS receipts and
 * STOP/START replies, and inbound replies to case and message emails. Idempotent per provider event id.
 */
import { newId } from '../../../kernel/lib/ids.js';
import type { InboundEmail, ProviderEmailEvent } from '../../../spec/notifications.js';
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
      core.ctx.events.publish('notifications.email_reply.received', {
        module: parsed.module,
        refId: parsed.refId,
        fromEmail: normalizeEmail(mail.from),
        accountId: last?.account_id ?? null,
        text: replyText(mail.text),
        // attachments: media has no import-from-URL function yet (spec gap); the text is forwarded
        attachmentAssetIds: [],
        receivedAt: new Date(mail.receivedAt).toISOString(),
      });
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
}
