/** Purchase intents (software purchases, food orders; spec note "Purchase intents", 2026-10-22) */
import { newId } from '../../../kernel/lib/ids.js';
import type { PurchaseAuthorizeInput } from '../../../spec/payments.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authorizeInput, harness, tokens, USD, type Harness } from './helpers.js';

let h: Harness;

const PURCHASE_EVENTS = ['payments.purchase.authorized', 'payments.purchase.failed', 'payments.purchase.captured', 'payments.purchase.voided'];
const CHECKOUT_EVENTS = ['payments.payment.authorized', 'payments.payment.failed', 'payments.payment.pending_check', 'payments.payment.captured', 'payments.payment.voided', 'payments.payment.orphaned'];

beforeAll(async () => {
  h = await harness();
  for (const name of PURCHASE_EVENTS) h.app.kernel.events.subscribe('test-purchases', name, (e) => void h.events.push({ name: e.name, payload: e.payload }));
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.events.length = 0;
});

const purchase = (o: { token?: string; amount?: number; refId?: string; customerId?: string; module?: 'software' | 'food' } = {}): PurchaseAuthorizeInput => ({
  module: o.module ?? 'software',
  refId: o.refId ?? newId(),
  ref: 'SW-4K7Q2',
  customerId: o.customerId ?? newId(),
  amount: USD(o.amount ?? 1249),
  method: { kind: 'new_card', providerToken: o.token ?? 'tok_visa' },
  description: 'PixelCraft Studio',
  returnUrl: 'https://store.example/software/purchases/return',
});
const intent = (id: string) => h.service.core.repo.get('intents', id);
const checkoutEvents = () => h.events.filter((e) => CHECKOUT_EVENTS.includes(e.name));

describe('purchase intents', () => {
  it('authorizes, captures the whole amount and publishes payments.purchase.* only', async () => {
    const input = purchase();
    const r = await h.service.authorizePurchase(input, newId());
    expect(r).toMatchObject({ state: 'accepted', methodLabel: 'Visa •••• 4242', decline: null });
    expect(await intent(r.intentId)).toMatchObject({ purpose: 'purchase', purchase_module: 'software', purchase_ref_id: input.refId, purchase_ref: 'SW-4K7Q2', checkout_session_id: null, order_id: null, customer_id: input.customerId, status: 'authorized', authorized_amount: 1249 });
    expect(h.named('payments.purchase.authorized')).toEqual([{ intentId: r.intentId, module: 'software', refId: input.refId, customerId: input.customerId, amount: USD(1249), methodLabel: 'Visa •••• 4242', at: expect.any(String) }]);
    expect(await h.service.getPurchaseStatus(r.intentId)).toMatchObject({ intentId: r.intentId, module: 'software', refId: input.refId, state: 'accepted', amount: USD(1249), retryAllowed: false });

    await h.service.capturePurchase(r.intentId);
    expect(await intent(r.intentId)).toMatchObject({ status: 'captured', captured_amount: 1249 });
    expect(h.named('payments.purchase.captured')).toEqual([{ intentId: r.intentId, module: 'software', refId: input.refId, customerId: input.customerId, amount: USD(1249), providerRef: expect.any(String), capturedAt: expect.any(String) }]);
    expect(await h.service.getPurchaseStatus(r.intentId)).toMatchObject({ state: 'captured', title: 'Payment received' });
    // capturing again changes nothing
    await h.service.capturePurchase(r.intentId);
    expect(await h.calls(r.intentId, 'capture')).toHaveLength(1);
    expect(h.named('payments.purchase.captured')).toHaveLength(1);
    expect(checkoutEvents()).toEqual([]);
  });

  it('answers the same key with the first result and never authorizes a purchase twice', async () => {
    const input = purchase();
    const key = newId();
    const r = await h.service.authorizePurchase(input, key);
    expect(await h.service.authorizePurchase(input, key)).toEqual(r);
    expect((await h.service.authorizePurchase(input, newId())).intentId).toBe(r.intentId);
    expect(await h.calls(r.intentId, 'authorize')).toHaveLength(1);
    // the same purchase id in another module is another purchase
    expect((await h.service.authorizePurchase({ ...input, module: 'food' }, newId())).intentId).not.toBe(r.intentId);
  });

  it('declines with payments.purchase.failed and lets the module retry (a new intent, the next attempt)', async () => {
    const input = purchase({ token: 'tok_declined' });
    const declined = await h.service.authorizePurchase(input, newId());
    expect(declined).toMatchObject({ state: 'failed', decline: { code: '05', category: 'card_declined', message: 'Your bank declined Visa •••• 0002. Nothing was charged.' } });
    expect(h.named('payments.purchase.failed')).toEqual([{ intentId: declined.intentId, module: 'software', refId: input.refId, customerId: input.customerId, declineCategory: 'card_declined', afterPendingCheck: false, at: expect.any(String) }]);
    expect(await h.service.getPurchaseStatus(declined.intentId)).toMatchObject({ state: 'failed', retryAllowed: true, decline: { code: '05' } });

    const retry = await h.service.authorizePurchase({ ...input, method: { kind: 'new_card', providerToken: 'tok_mastercard' } }, newId());
    expect(retry).toMatchObject({ state: 'accepted', methodLabel: 'Mastercard •••• 4444' });
    expect(retry.intentId).not.toBe(declined.intentId);
    expect((await intent(retry.intentId))?.attempt_no).toBe(2);
    expect(checkoutEvents()).toEqual([]);
  });

  it('finishes a bank challenge (tok_3ds) with completeAction', async () => {
    const input = purchase({ token: 'tok_3ds' });
    const r = await h.service.authorizePurchase(input, newId());
    expect(r).toMatchObject({ state: 'requires_action', nextAction: { kind: 'three_ds_challenge' } });
    expect(await h.service.getPurchaseStatus(r.intentId)).toMatchObject({ state: 'requires_action', nextAction: { kind: 'three_ds_challenge' } });
    expect(h.named('payments.purchase.authorized')).toEqual([]);
    expect(await h.service.completeAction(r.intentId, '3ds_ok', newId())).toMatchObject({ state: 'accepted' });
    expect(h.named('payments.purchase.authorized')).toEqual([expect.objectContaining({ intentId: r.intentId, refId: input.refId })]);

    const failed = await h.service.authorizePurchase(purchase({ token: 'tok_3ds' }), newId());
    expect(await h.service.completeAction(failed.intentId, 'nope', newId())).toMatchObject({ state: 'failed', decline: { category: 'authentication_failed' } });
    expect(h.named('payments.purchase.failed')).toEqual([expect.objectContaining({ intentId: failed.intentId, declineCategory: 'authentication_failed' })]);
    expect(checkoutEvents()).toEqual([]);
  });

  it('keeps an unanswered payment (tok_pending) pending until the status-check job resolves it', async () => {
    const input = purchase({ token: 'tok_pending' });
    const r = await h.service.authorizePurchase(input, newId());
    expect(r.state).toBe('pending_check');
    expect(await h.service.getPurchaseStatus(r.intentId, true)).toMatchObject({ state: 'pending', retryAllowed: false });
    expect(checkoutEvents()).toEqual([]); // no payments.payment.pending_check for purchases

    const held = (await intent(r.intentId))!;
    expect(await h.service.core.provider.devSettle!({ providerRef: held.provider_ref, idempotencyKey: `${held.id}:authorize` }, 'authorized')).toBe(true);
    h.clock.advance(60_000);
    await h.run('payments.check-uncertain');
    expect(h.named('payments.purchase.authorized')).toEqual([expect.objectContaining({ intentId: r.intentId, module: 'software', refId: input.refId })]);
    expect((await intent(r.intentId))?.status).toBe('authorized');

    const declined = await h.service.authorizePurchase(purchase({ token: 'tok_pending' }), newId());
    const row = (await intent(declined.intentId))!;
    await h.service.core.provider.devSettle!({ providerRef: row.provider_ref, idempotencyKey: `${row.id}:authorize` }, 'declined');
    h.clock.advance(60_000);
    await h.run('payments.check-uncertain');
    expect(h.named('payments.purchase.failed')).toEqual([expect.objectContaining({ intentId: declined.intentId, afterPendingCheck: true })]);
    expect(checkoutEvents()).toEqual([]);
  });

  it('voids an authorization with payments.purchase.voided', async () => {
    const input = purchase({ module: 'food' });
    const r = await h.service.authorizePurchase(input, newId());
    await h.service.voidIntent(r.intentId, 'Order declined by the restaurant');
    expect((await intent(r.intentId))?.status).toBe('voided');
    expect(h.named('payments.purchase.voided')).toEqual([{ intentId: r.intentId, module: 'food', refId: input.refId, reason: 'Order declined by the restaurant' }]);
    expect(await h.service.getPurchaseStatus(r.intentId)).toMatchObject({ state: 'voided' });
    await expect(h.service.capturePurchase(r.intentId)).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    // a new authorization for the same order is allowed once the first one ended
    expect((await h.service.authorizePurchase(input, newId())).state).toBe('accepted');
    expect(checkoutEvents()).toEqual([]);
  });

  it('is left alone by the orphan sweep and order events, and kept out of the checkout payment views', async () => {
    const r = await h.service.authorizePurchase(purchase(), newId());
    h.clock.advance(60 * 60_000);
    await h.run('payments.detect-orphans');
    expect(await intent(r.intentId)).toMatchObject({ status: 'authorized', orphan: false, order_id: null });
    expect(checkoutEvents()).toEqual([]);

    // a checkout payment is not a purchase, and a purchase is not a checkout payment
    const checkout = await h.service.authorize(authorizeInput({ amount: 3000 }), newId());
    await expect(h.service.capturePurchase(checkout.intentId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.service.getPurchaseStatus(checkout.intentId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.service.linkOrder(r.intentId, newId(), [])).rejects.toMatchObject({ code: 'CONFLICT' });
    const staff = tokens.staff();
    expect((await h.call('GET', `/api/admin/payments/payments/${r.intentId}`, staff)).status).toBe(404);
    const list = await h.call('GET', '/api/admin/payments/payments?limit=100', staff);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(r.intentId);
    const owner = (await intent(r.intentId))!.customer_id!;
    expect((await h.call('GET', `/api/store/payments/intents/${r.intentId}`, tokens.customer(owner))).status).toBe(404);
    const exported = await h.service.exportCustomerData({ customerId: owner, accountId: owner });
    expect(exported.find((s) => s.key === 'payments')?.records).toEqual([]);
  });
});
