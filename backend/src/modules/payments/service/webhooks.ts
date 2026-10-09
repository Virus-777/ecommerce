/**
 * Provider webhooks. The middleware verified the signature and answers replays of a known X-Event-Id itself;
 * here every event is stored once per (provider, event id) and applied idempotently. Payment and refund
 * events only trigger a retrieve from the provider, so out-of-order or replayed events can never move a
 * record backwards. Dispute events carry the case and are applied through the dispute state machine.
 */
import { createHash } from 'node:crypto';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { WebhookRec } from '../ports.js';
import { PROVIDER_ACTOR, notFound, type By, type Core } from './core.js';
import type { Disputes } from './disputes.js';
import type { Intents } from './intents.js';
import type { Methods } from './methods.js';
import type { Refunds } from './refunds.js';

const BY: By = { actor: PROVIDER_ACTOR };
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

export class Webhooks {
  constructor(
    private readonly core: Core,
    private readonly intents: Intents,
    private readonly refunds: Refunds,
    private readonly disputes: Disputes,
    private readonly methods: Methods,
  ) {}

  async receive(provider: string, body: unknown, eventId: string | undefined): Promise<{ received: boolean }> {
    if (provider !== this.core.provider.code) throw notFound('Payment provider');
    const event = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as { id?: unknown; type?: unknown; data?: unknown };
    const type = str(event.type) ?? 'unknown';
    // the provider event id: from the signed body when it has one, else the X-Event-Id header
    const externalId = str(event.id) ?? eventId ??`sha256:${createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex').slice(0, 40)}`;
    const row: WebhookRec = { id: newId(), provider, external_id: externalId, type, payload: body ?? null, received_at: this.core.now(), processed_at: null, outcome: null };
    let stored = await this.core.repo.insertWebhookIfNew(row);
    if (!stored) {
      const known = (await this.core.repo.find('webhook_events', { provider, external_id: externalId }))[0];
      if (!known || known.processed_at) return { received: true }; // replay of an applied event
      stored = known; // an earlier delivery stopped half-way: apply again (every step is idempotent)
    }
    let outcome: string;
    try {
      outcome = await this.apply(provider, type, (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>);
    } catch (err) {
      await this.core.repo.update('webhook_events', stored.id, { outcome: `error: ${(err as Error).message}`.slice(0, 200) });
      if (err instanceof AppError && err.status < 500) return { received: true }; // nothing to retry
      throw err; // the provider retries the delivery
    }
    await this.core.repo.update('webhook_events', stored.id, { processed_at: this.core.now(), outcome });
    return { received: true };
  }

  private async apply(provider: string, type: string, data: Record<string, unknown>): Promise<string> {
    const [kind] = type.split('.');
    switch (kind) {
      case 'payment': {
        const intentId = str(data.intentId);
        const ref = str(data.paymentRef);
        const intent = (intentId ? await this.core.repo.get('intents', intentId).catch(() => undefined) : undefined) ?? (ref ? (await this.core.repo.find('intents', { provider, provider_ref: ref }))[0] : undefined);
        if (!intent) return 'unknown_payment';
        const after = await this.intents.reconcile(intent.id, BY);
        return `payment ${after.status}`;
      }
      case 'refund': {
        const refundId = str(data.refundId);
        const ref = str(data.refundRef);
        const refund = (refundId ? await this.core.repo.get('refunds', refundId).catch(() => undefined) : undefined) ?? (ref ? (await this.core.repo.find('refunds', { provider_ref: ref }))[0] : undefined);
        if (!refund) return 'unknown_refund';
        const after = await this.refunds.check(refund.id, BY);
        return `refund ${after.status}`;
      }
      case 'dispute': {
        const caseId = str(data.caseId);
        if (!caseId) return 'ignored: no case id';
        if (type === 'dispute.created') {
          const paymentRef = str(data.paymentRef);
          if (!paymentRef) return 'ignored: no payment reference';
          return `dispute ${await this.disputes.open(provider, { caseId, paymentRef, kind: str(data.kind), amount: num(data.amount), currency: str(data.currency), reasonCode: str(data.reasonCode), reason: str(data.reason), evidenceDueBy: str(data.evidenceDueBy) })}`;
        }
        return `dispute ${await this.disputes.providerUpdate(provider, caseId, { status: str(data.status), outcome: type === 'dispute.closed' ? str(data.outcome) : null })}`;
      }
      case 'method': {
        const methodId = str(data.methodRef);
        const expMonth = num(data.expMonth);
        const expYear = num(data.expYear);
        if (!methodId || expMonth === null || expYear === null) return 'ignored: incomplete card update';
        return (await this.methods.applyCardUpdate(provider, { methodId, expMonth, expYear, last4: str(data.last4) })) ? 'card updated' : 'unknown_method';
      }
      default:
        return 'ignored';
    }
  }
}
