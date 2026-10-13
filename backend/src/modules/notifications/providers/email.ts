/**
 * Development email provider: nothing leaves the machine. Messages are recorded in devOutbox.email.
 * Deterministic outcomes by recipient domain:
 *   *@bounce.test     accepted, then a hard bounce (adds a suppression)
 *   *@softbounce.test accepted, then a soft bounce (no suppression)
 *   *@complaint.test  accepted, delivered, then a complaint (adds a suppression)
 *   *@tempfail.test   temporary failure (the delivery retries with backoff)
 *   *@reject.test     permanent failure
 *   anything else     accepted and delivered
 */
import type { EmailProvider, OutboundEmail, ProviderResult } from '../ports.js';
import { devMessageId, devOutbox, record } from './dev-outbox.js';

export function createDevEmailProvider(): EmailProvider {
  return {
    name: 'dev-email',
    async send(message: OutboundEmail): Promise<ProviderResult> {
      const domain = message.to.split('@')[1]?.toLowerCase() ?? '';
      if (domain === 'tempfail.test') return { ok: false, temporary: true, error: 'Simulated temporary failure (421 try again later)' };
      if (domain === 'reject.test') return { ok: false, temporary: false, error: 'Simulated permanent failure (550 mailbox unavailable)' };
      const providerMessageId = devMessageId('dev-email');
      record(devOutbox.email, providerMessageId, message);
      if (domain === 'bounce.test') return { ok: true, providerMessageId, events: [{ type: 'bounced', bounceType: 'hard', detail: 'Simulated hard bounce (550 no such user)' }] };
      if (domain === 'softbounce.test') return { ok: true, providerMessageId, events: [{ type: 'bounced', bounceType: 'soft', detail: 'Simulated soft bounce (mailbox full)' }] };
      if (domain === 'complaint.test') return { ok: true, providerMessageId, events: [{ type: 'delivered' }, { type: 'complained', detail: 'Simulated spam complaint' }] };
      return { ok: true, providerMessageId, events: [{ type: 'delivered' }] };
    },
    /** Inbound attachments: data: URLs are decoded; any other URL gives a small text file naming it (no network) */
    async fetchAttachment(downloadUrl: string, opts: { maxBytes: number }): Promise<Uint8Array> {
      const data = /^data:[^,]*?(;base64)?,(.*)$/s.exec(downloadUrl);
      const bytes = data ? (data[1] ? Buffer.from(data[2]!, 'base64') : Buffer.from(decodeURIComponent(data[2]!), 'utf8')) : Buffer.from(`Development attachment from ${downloadUrl}\n`, 'utf8');
      if (bytes.length > opts.maxBytes) throw new Error(`Attachment is larger than ${opts.maxBytes} bytes`);
      return new Uint8Array(bytes);
    },
  };
}
