/**
 * Store credit across a declined payment, with the real wallet (phase 3, enabled here): payments releases the
 * credit hold with the declined intent, checkout forgets it and the retry reserves the credit afresh, so the
 * accepted order captures a live hold (no late re-capture of a released one). Also: the order is created with
 * the checkout's stock hold as its reservation.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { STORE, USD, key, placeBody, readyCheckout, world, type World } from './helpers.js';

let w: World;

beforeAll(async () => {
  w = await world({ wallet: true });
}, 120_000);
afterAll(async () => {
  await w?.app.close();
});

const wallet = () => w.api('wallet');
const balance = async (customerId: string) => (await wallet().getBalance(customerId)).available.amount as number;
const holdsOf = async (sessionId: string) => (await sql<{ id: string; state: string; idempotency_key: string; order_id: string | null }>`select id, state, idempotency_key, order_id from wallet.holds where quote_id = ${sessionId} order by expires_at`.execute(w.service.core.ctx.db)).rows;

describe('store credit and a declined card', () => {
  it('drops the released credit hold on decline and holds the credit again on the retry', async () => {
    const ivy = await w.customer('ivy@example.com');
    await wallet().creditRefund({ customerId: ivy.customerId, refundId: newId(), orderId: newId(), amount: USD(1000), reason: 'Refund to store credit' }, `fund-${newId()}`);
    expect(await balance(ivy.customerId)).toBe(1000);

    const v = await readyCheckout(w, ivy.token, { source: 'buy_now', offerId: w.offers.white, quantity: 2 }, { card: 'tok_decline' });
    const withCredit = await w.call('PUT', `${STORE}/sessions/${v.id}/credit`, ivy.token, { use: true });
    expect(withCredit.status, JSON.stringify(withCredit.body)).toBe(200);
    expect(withCredit.body.totals.creditApplied.amount).toBe(1000);

    const failed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, ivy.token, placeBody(withCredit.body), { 'idempotency-key': key() });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body.outcome).toBe('payment_failed');
    const first = w.pay.calls.authorize.filter((a) => a.input.checkoutSessionId === v.id)[0]!;
    expect(first.input.creditHoldId).toEqual(expect.any(String));
    expect(first.input.creditAmount).toEqual(USD(1000));
    // the declined intent's hold is released and checkout no longer points at it
    expect((await w.service.core.repo.getSession(v.id))!.credit_hold_id).toBeNull();
    expect(await balance(ivy.customerId)).toBe(1000);
    expect((await holdsOf(v.id)).map((h) => h.state)).toEqual(['released']);

    const retried = await w.call(
      'POST',
      `${STORE}/sessions/${v.id}/retry-payment`,
      ivy.token,
      { method: { kind: 'new_card', providerToken: 'tok_mc', label: 'Mastercard •••• 4444' }, quoteVersion: failed.body.checkout.quoteVersion, expectedTotal: failed.body.checkout.totals.total, returnUrl: 'https://store.marketly.test/r' },
      { 'idempotency-key': key() },
    );
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.outcome).toBe('accepted');
    const second = w.pay.calls.authorize.filter((a) => a.input.checkoutSessionId === v.id)[1]!;
    expect(second.input.creditHoldId).toEqual(expect.any(String));
    expect(second.input.creditHoldId).not.toBe(first.input.creditHoldId);
    expect(second.input.creditAmount).toEqual(USD(1000));

    // the fresh hold is the one captured for the order; no re-capture of the released one was needed
    const holds = await holdsOf(v.id);
    expect(holds.map((h) => [h.id, h.state])).toEqual([
      [first.input.creditHoldId, 'released'],
      [second.input.creditHoldId, 'captured'],
    ]);
    expect(holds.some((h) => h.idempotency_key.startsWith('recapture:'))).toBe(false);
    expect(holds[1]!.order_id).toBe(retried.body.orderId);
    expect(await balance(ivy.customerId)).toBe(0);
  });
});

describe('the order and the stock hold', () => {
  it('creates the order with the checkout stock hold as its reservation', async () => {
    const jo = await w.customer('jo@example.com');
    const v = await readyCheckout(w, jo.token, { source: 'buy_now', offerId: w.offers.black, quantity: 1 });
    const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, jo.token, placeBody(v), { 'idempotency-key': key() });
    expect(placed.body.outcome, JSON.stringify(placed.body)).toBe('accepted');
    const holdId = (await sql<{ stock_reservation_id: string | null }>`select stock_reservation_id from checkout.sessions where id = ${v.id}`.execute(w.service.core.ctx.db)).rows[0]!.stock_reservation_id;
    expect(holdId).toEqual(expect.any(String));
    expect(w.named('orders.order.accepted').find((e) => e.orderId === placed.body.orderId)).toMatchObject({ reservationId: holdId });
    expect(w.named('inventory.reservation.allocated').filter((e) => e.orderId === placed.body.orderId)).toHaveLength(1);
  });
});
