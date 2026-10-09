/**
 * Development SMS provider (phase 2): messages are recorded in devOutbox.sms. Deterministic outcomes
 * by the last digits of the number: ...0000 permanent failure (invalid number), ...0001 temporary
 * failure; anything else accepted and delivered.
 */
import type { OutboundSms, ProviderResult, SmsProvider } from '../../ports.js';
import { devMessageId, devOutbox, record } from '../dev-outbox.js';

export function createDevSmsProvider(): SmsProvider {
  return {
    name: 'dev-sms',
    async send(message: OutboundSms): Promise<ProviderResult> {
      const digits = message.to.replace(/\D/g, '');
      if (digits.endsWith('0000')) return { ok: false, temporary: false, error: 'Simulated invalid number' };
      if (digits.endsWith('0001')) return { ok: false, temporary: true, error: 'Simulated carrier timeout' };
      const providerMessageId = devMessageId('dev-sms');
      record(devOutbox.sms, providerMessageId, message);
      return { ok: true, providerMessageId, events: [{ type: 'delivered' }] };
    },
  };
}
