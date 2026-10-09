/**
 * Development push provider (Firebase Cloud Messaging stand-in, phase 3): messages are recorded in
 * devOutbox.push. Tokens starting with "invalid" are reported as unregistered (the device is dropped);
 * tokens starting with "unavailable" fail temporarily.
 */
import type { OutboundPush, ProviderResult, PushProvider } from '../../ports.js';
import { devMessageId, devOutbox, record } from '../dev-outbox.js';

export function createDevPushProvider(): PushProvider {
  return {
    name: 'dev-push',
    async send(message: OutboundPush): Promise<ProviderResult> {
      if (message.token.startsWith('invalid')) return { ok: false, temporary: false, error: 'Simulated UNREGISTERED token', invalidToken: true };
      if (message.token.startsWith('unavailable')) return { ok: false, temporary: true, error: 'Simulated FCM unavailable' };
      const providerMessageId = devMessageId('dev-push');
      record(devOutbox.push, providerMessageId, message);
      return { ok: true, providerMessageId, events: [{ type: 'delivered' }] };
    },
  };
}
