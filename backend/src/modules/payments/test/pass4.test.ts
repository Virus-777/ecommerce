/**
 * Gap pass 4: intents.next_action, the dispute log and the concession columns, refunds without an order (orphan
 * payments) with their checkout session, webhook events linked to their payment and refund, the 0003 backfill,
 * and the customer data export hook.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { devWebhook } from '../infra/card-processor/dev.js';
import { m0003Pass4 } from '../infra/postgres/migrations/0003_pass4.js';
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
    const cs = (await repo().get('intents', cap.intentId))!.checkout_session_id;
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

describe('migration 0003', () => {
  it('backfills next_action, the dispute log and concession columns, refund sessions and webhook links', async () => {
    const challenged = await h.service.authorize(authorizeInput({ amount: 2100, token: 'tok_3ds' }), newId());
    const placed = await placeOrder(h, { products: [[{ price: 9000 }]] });
    const intent = (await repo().get('intents', placed.intentId))!;
    const caseId = `dp_${newId()}`;
    await h.webhook(devWebhook('dispute.created', { caseId, paymentRef: intent.provider_ref, amount: 9000, currency: 'USD', reasonCode: '13.1', reason: 'Not received' }));
    const dispute = (await repo().find('disputes', { provider_case_id: caseId }))[0]!;
    const orphan = await h.service.authorize(authorizeInput({ amount: 7107 }), newId());
    const cs = (await repo().get('intents', orphan.intentId))!.checkout_session_id;
    h.sessions.set(cs, { orderId: null, status: 'expired', customerId: null });
    h.clock.advance(31_000);
    await h.run('payments.check-uncertain');
    h.clock.advance(16 * 60_000);
    await h.run('payments.detect-orphans');
    const [orphanRefund] = await repo().find('refunds', { intent_id: orphan.intentId });
    const approvalId = newId();
    const db = h.app.kernel.database;

    // the state before 0003: the challenge in method, history and concession in evidence, orphan refunds keyed
    // by the checkout session, no webhook links
    await db.exec(`update payments.refunds set order_id = checkout_session_id where order_id is null;
      drop table payments.dispute_log;
      alter table payments.intents drop column next_action;
      alter table payments.disputes drop column due_soon_flagged_at, drop column approval_request_id, drop column concession_reason;
      alter table payments.refunds drop column checkout_session_id;
      alter table payments.webhook_events drop column intent_id, drop column refund_id`);
    await sql`update payments.intents set method = method || ${JSON.stringify({ pendingAction: { kind: 'three_ds_challenge', url: 'https://processor.example/3ds/x', clientSecret: 's' } })}::jsonb where id = ${challenged.intentId}`.execute(db.kysely);
    const evidence = {
      history: [
        { at: '2026-09-01T10:00:00.000Z', label: 'Chargeback opened', detail: 'Not received', actor: { kind: 'system', id: null } },
        { at: '2026-09-02T10:00:00.000Z', label: 'Evidence due within 48 hours', detail: null, actor: { kind: 'system', id: null } },
      ],
      pendingConcession: { approvalRequestId: approvalId, reason: 'Customer is right', requestedBy: { kind: 'staff', id: null }, at: '2026-09-02T11:00:00.000Z' },
      dueSoonFlagged: true,
    };
    await sql`update payments.disputes set evidence = evidence || ${JSON.stringify(evidence)}::jsonb where id = ${dispute.id}`.execute(db.kysely);
    await db.exec(`alter table payments.refunds alter column order_id set not null`);

    await db.exec(m0003Pass4.sql);

    const i = (await repo().get('intents', challenged.intentId))!;
    expect(i.next_action).toMatchObject({ kind: 'three_ds_challenge' });
    expect(i.method).not.toHaveProperty('pendingAction');
    const d = (await repo().get('disputes', dispute.id))!;
    expect(d).toMatchObject({ approval_request_id: approvalId, concession_reason: 'Customer is right', due_soon_flagged_at: new Date('2026-09-02T10:00:00.000Z') });
    expect(d.evidence).not.toHaveProperty('history');
    expect(d.evidence).not.toHaveProperty('pendingConcession');
    expect((await repo().find('dispute_log', { dispute_id: dispute.id }, { orderBy: [['at', 'asc']] })).map((l) => l.label)).toEqual(['Chargeback opened', 'Evidence due within 48 hours']);
    expect(await repo().get('refunds', orphanRefund!.id)).toMatchObject({ order_id: null, checkout_session_id: cs });
    const placedRefundless = await repo().find('webhook_events', { intent_id: placed.intentId });
    expect(placedRefundless.map((e) => e.type)).toContain('dispute.created');
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
