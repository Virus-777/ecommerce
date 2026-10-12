/**
 * Gap pass 3: the expiry sweep walks every live authorization (keyset pages, a failed expiry capture retried with a
 * new key, one failing intent never stops the walk); orphan amounts are card money only, with the store credit
 * apart; a payment pending check keeps its store-credit hold alive (wallet.extendHold, real wallet).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type { WalletPublicApi } from '../../../spec/wallet.js';
import { ProviderError, type PaymentProvider, type ProviderCapture } from '../ports.js';
import { Intents } from '../service/intents.js';
import { authorizeInput, harness, placeOrder, USD, type Harness } from './helpers.js';

const DAY = 86_400_000;
let h: Harness;
let wallet: WalletPublicApi;
let provider: PaymentProvider;
let capture: PaymentProvider['capture'];

beforeAll(async () => {
  h = await harness({ modules: ['wallet'] });
  wallet = h.app.kernel.boot.apis.get('wallet') as WalletPublicApi;
  provider = h.service.core.provider as PaymentProvider;
  capture = provider.capture.bind(provider);
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  provider.capture = capture;
  h.service.intents.expiryPageSize = 200;
  delete h.settings['payments.captureMode'];
});

const intent = (id: string) => h.service.core.repo.get('intents', id);

describe('payments.expire-authorizations walks every live authorization', () => {
  it('voids every authorization near expiry, however many pages of them there are (not only the oldest 50 or 200)', async () => {
    const loose: string[] = [];
    for (let n = 0; n < 55; n++) loose.push((await h.service.authorize(authorizeInput({ amount: 1_000 + n * 100 }), newId())).intentId);
    h.service.intents.expiryPageSize = 20;
    h.clock.advance(6.5 * DAY);
    await h.run('payments.expire-authorizations');
    const statuses = await Promise.all(loose.map(async (id) => (await intent(id))!.status));
    expect(statuses.filter((s) => s === 'voided')).toHaveLength(55);
    expect(h.named('payments.payment.voided').filter((e) => loose.includes(e.intentId))).toHaveLength(55);
  });

  it('retries a failed expiry capture on the next run with a new key (intent + expiry + attempt)', async () => {
    h.settings['payments.captureMode'] = 'per_group_on_dispatch';
    const placed = await placeOrder(h, { products: [[{ price: 6_000 }, { price: 1_500 }]] });
    let refuse = true;
    provider.capture = async (o): Promise<ProviderCapture> => {
      if (refuse) {
        refuse = false;
        return { status: 'failed', message: 'Refused once' };
      }
      return capture(o);
    };
    h.clock.advance(6.5 * DAY);
    await h.run('payments.expire-authorizations');
    expect((await intent(placed.intentId))!).toMatchObject({ status: 'authorized', captured_amount: 0 });
    h.clock.advance(60 * 60_000);
    await h.run('payments.expire-authorizations');
    expect((await intent(placed.intentId))!).toMatchObject({ status: 'captured', captured_amount: 7_500 });
    const rows = await h.service.core.repo.find('captures', { intent_id: placed.intentId }, { orderBy: [['at', 'asc']] });
    expect(rows.map((c) => [c.idempotency_key, c.status, c.amount])).toEqual([
      [`${placed.intentId}:capture:expiry:1`, 'failed', 7_500],
      [`${placed.intentId}:capture:expiry:2`, 'succeeded', 7_500],
    ]);
    expect(h.named('payments.payment.captured').filter((e) => e.intentId === placed.intentId).map((e) => e.amount)).toEqual([USD(7_500)]);
    // an attempt still in flight keeps its key: the check job resolves it, the sweep never sends another
    expect(await h.service.intents.expiryCaptureKey(placed.intentId)).toBe(`${placed.intentId}:capture:expiry:2`);
  });

  it('goes on with the walk when one intent fails', async () => {
    h.settings['payments.captureMode'] = 'per_group_on_dispatch';
    const first = await placeOrder(h, { products: [[{ price: 4_000 }]] });
    const second = await placeOrder(h, { products: [[{ price: 2_500 }]] });
    const broken = (await intent(first.intentId))!.provider_ref;
    provider.capture = async (o) => {
      if (o.providerRef === broken) throw new Error('adapter bug');
      return capture(o);
    };
    h.clock.advance(6.5 * DAY);
    const result = await h.service.intents.expireAuthorizations();
    expect(result.failed).toBe(1);
    expect((await intent(first.intentId))!.status).toBe('authorized');
    expect((await intent(second.intentId))!).toMatchObject({ status: 'captured', captured_amount: 2_500 });
  });
});

describe('orphan payments', () => {
  it('reports the card money that moved and the store credit held apart, never the intent amount with its credit', async () => {
    const customerId = newId();
    await wallet.creditRefund({ customerId, refundId: newId(), orderId: newId(), amount: USD(5_000), reason: 'Earlier refund' }, newId());
    const checkoutSessionId = newId();
    const hold = await wallet.holdCredit(customerId, checkoutSessionId, USD(2_000), newId());
    const auth = await h.service.authorize({ ...authorizeInput({ checkoutSessionId, customerId, amount: 9_000 }), creditHoldId: hold.id, creditAmount: USD(2_000) }, newId());
    expect(auth.state).toBe('accepted');
    expect((await intent(auth.intentId))!).toMatchObject({ amount: 9_000, authorized_amount: 7_000 });
    h.sessions.set(checkoutSessionId, { orderId: null, status: 'abandoned', customerId });
    h.clock.advance(2 * 60 * 60_000);
    await h.run('payments.detect-orphans');
    expect(h.named('payments.payment.orphaned').filter((e) => e.intentId === auth.intentId)).toEqual([
      { intentId: auth.intentId, checkoutSessionId, amount: USD(7_000), creditAmount: USD(2_000), captured: false, action: 'voided' },
    ]);
    // the checkout's credit hold was never used: it is released with the void
    expect((await wallet.getBalance(customerId)).available).toEqual(USD(5_000));
  });
});

describe('a payment pending check keeps its store-credit hold alive', () => {
  it('extends the wallet hold past holdTtlMinutes to the next check plus a margin, so the stale-hold job leaves it held', async () => {
    const customerId = newId();
    await wallet.creditRefund({ customerId, refundId: newId(), orderId: newId(), amount: USD(5_000), reason: 'Earlier refund' }, newId());
    const checkoutSessionId = newId();
    const hold = await wallet.holdCredit(customerId, checkoutSessionId, USD(1_500), newId());
    // the card part (…03) times out: the payment is pending check
    const auth = await h.service.authorize({ ...authorizeInput({ checkoutSessionId, customerId, amount: 6_503 }), creditHoldId: hold.id, creditAmount: USD(1_500) }, newId());
    expect(auth.state).toBe('pending_check');
    const retrieve = provider.retrievePayment;
    provider.retrievePayment = async () => {
      throw new ProviderError('down', true);
    };
    try {
      h.clock.advance(40 * 60_000); // past the hold's 30 minutes
      await h.run('payments.check-uncertain');
    } finally {
      provider.retrievePayment = retrieve;
    }
    const i = (await intent(auth.intentId))!;
    expect(i.status).toBe('pending_check');
    const holds = h.app.kernel.mongo.db.collection<{ _id: string; state: string; expires_at: Date }>('wallet.holds');
    const row = (await holds.findOne({ _id: hold.id }))!;
    expect(row.state).toBe('held');
    expect(row.expires_at.getTime()).toBe(i.next_check_at!.getTime() + Intents.HOLD_MARGIN_MS);
    await h.run('wallet.release-stale-holds');
    expect((await holds.findOne({ _id: hold.id }))!.state).toBe('held');
    expect((await wallet.getBalance(customerId)).held).toEqual(USD(1_500));
  });
});
