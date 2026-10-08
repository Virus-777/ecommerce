/**
 * Webhook signatures (docs/03-auth-middleware.md §0: the provider's signature is its token).
 *
 * Marketly's provider adapters sign with HMAC-SHA256 over `<timestamp>.<raw body>`:
 *   X-Signature: sha256=<hex>    X-Timestamp: <unix seconds>    X-Event-Id: <provider event id> (optional)
 * Secrets come from WEBHOOK_SECRETS per provider (config.webhookSecrets; development and tests use
 * "dev-webhook-secret"). A provider with its own scheme (e.g. Stripe-Signature) gets its own verifier
 * in the module's infra; the middleware only needs the WebhookVerifier contract.
 */
import type { FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config/index.js';
import type { WebhookVerifier } from '../auth/chain.js';

export function signWebhook(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return { 'x-signature': `sha256=${mac}`, 'x-timestamp': String(timestamp) };
}

/**
 * A verifier for this module's webhooks. `provider` names the secret (default: the URL's
 * {provider} / {carrier} parameter, else the module name).
 */
export function hmacWebhookVerifier(config: Config, module: string, opts: { provider?: string } = {}): WebhookVerifier {
  return (request: FastifyRequest, urlProvider: string | undefined) => {
    const provider = opts.provider ?? urlProvider ?? module;
    const secret = config.webhookSecrets[provider] ?? config.webhookSecrets['*'];
    const signature = header(request, 'x-signature');
    const ts = Number(header(request, 'x-timestamp'));
    if (!secret || !signature?.startsWith('sha256=') || !Number.isFinite(ts)) return false;
    const expected = Buffer.from(signWebhook(secret, request.rawBody ?? '', ts)['x-signature']!);
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    return { provider, eventId: header(request, 'x-event-id'), timestamp: new Date(ts * 1000) };
  };
}

const header = (request: FastifyRequest, name: string): string | undefined => {
  const v = request.headers[name];
  return typeof v === 'string' && v ? v : undefined;
};
