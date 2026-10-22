/**
 * Gap pass 4: intents.next_action, the dispute log and the concession columns, refunds without an order (orphan
 * payments) with their checkout session, webhook events linked to their payment and refund,
 * and the customer data export hook.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { devWebhook } from '../providers/card-processor.js';
import { authorizeInput, harness, placeOrder, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const staff = () => tokens.staff();
const repo = () => h.service.core.repo;

describe('columns', () => {
  it('keeps the bank challenge in intents.next_action and clears it when the challenge ends', async () => {
    const r = await h.service.authorize(authorizeInput({ amount: 2000, token: 'tok_3ds' }), newId());
    expect(r).toMatchObject({ state: 'requires_action', nextAction: { kind: 'three_ds_challenge' } });
    const row = (await repo().get('intents', r.intentId))!;
    expect(row.next_action).toMatchObject({ kind: 'three_ds_challenge' });
    expect(row.method).not.toHaveProperty('pendingAction');
    expect((await h.service.getIntentStatus(r.intentId)).nextAction).toMatchObject({ kind: 'three_ds_challenge' });
    await h.service.voidIntent(r.intentId, 'abandoned');
    expect((await repo().get('intents', r.intentId))!.next_action).toBeNull();
  });

  it('writes the dispute history to dispute_log and links webhook events to their payment', async () => {
    const placed = await placeOrder(h, { products: [[{ price: 12000 }]] });
    const intent = (await repo().get('intents', placed.intentId))!;
    const caseId = `dp_${newId()}`;
    const res = await h.webhook(devWebhook('dispute.created', { caseId, paymentRef: intent.provider_ref, amount: 12000, currency: 'USD', reasonCode: '13.1', reason: 'Not received' }));
    expect(res.status).toBe(200);
    const d = (await repo().find('disputes', { provider_case_id: caseId }))[0]!;
    expect(d.evidence).not.toHaveProperty('history');
    expect(await repo().find('dispute_log', { dispute_id: d.id })).toEqual([expect.objectContaining({ label: 'Chargeback opened' })]);
    const api = await h.call('GET', `/api/admin/payments/disputes/${d.id}`, staff());
    expect(api.body.history).toEqual([expect.objectContaining({ label: 'Chargeback opened' })]);
    const events = await repo().find('webhook_events', { intent_id: placed.intentId });
    expect(events.map((e) => e.type)).toContain('dispute.created');
    const detail = await h.call('GET', `/api/admin/payments/payments/${placed.intentId}`, staff());
    expect(detail.body.webhooks.map((w: { type: string }) => w.type)).toContain('dispute.created');
  });

  it('an orphan payment refund has no order: order_id null, the checkout session kept and shown as orderId', async () => {
    const cap = await h.service.authorize(authorizeInput({ amount: 7007 }), newId());
    const cs = (await repo().get('intents', cap.intentId))!.checkout_session_id!;
    h.sessions.set(cs, { orderId: null, status: 'expired', customerId: null });
    h.clock.advance(31_000);
    await h.run('payments.check-uncertain');
    h.clock.advance(16 * 60_000);
    await h.run('payments.detect-orphans');
    const [r] = await repo().find('refunds', { intent_id: cap.intentId });
    expect(r).toMatchObject({ origin: 'orphan_payment', order_id: null, checkout_session_id: cs });
    expect(h.named('payments.refund.status_changed').find((e) => e.refundId === r!.id)).toMatchObject({ orderId: cs });
    const api = await h.call('GET', `/api/admin/payments/refunds/${r!.id}`, staff());
    expect(api.body).toMatchObject({ orderId: cs, checkoutSessionId: cs });
    const listed = await h.call('GET', `/api/admin/payments/refunds?orderId=${cs}`, staff());
    expect(listed.body.items.map((x: { id: string }) => x.id)).toEqual([r!.id]);
  });
});

describe('exportCustomerData', () => {
  it('exports saved methods masked, payments and refunds of the customer only', async () => {
    const customerId = newId();
    await placeOrder(h, { customerId, products: [[{ price: 4000 }]] });
    await placeOrder(h, { products: [[{ price: 5000 }]] });
    const sections = await h.service.exportCustomerData({ customerId, accountId: newId() });
    expect(sections.map((s) => s.key)).toEqual(['payment_methods', 'payments', 'refunds']);
    const payments = sections.find((s) => s.key === 'payments')!.records as { amount: { amount: number }; method: string }[];
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amount.amount).toBe(4000);
    expect(JSON.stringify(sections)).not.toMatch(/provider|tok_/);
  });
});
