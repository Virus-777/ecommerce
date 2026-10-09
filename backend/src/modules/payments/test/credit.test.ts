/**
 * Orders paid partly with store credit (phase 3), with the real wallet: refunds to the original method give the
 * store-credit part back first through wallet and send only the rest to the card; an order cancelled before its
 * card was charged gets its credit back; items cancelled before the capture come off the card, not the credit.
 * Also: the customer-facing payment events name the customer and the contact email.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type { WalletPublicApi } from '../../../spec/wallet.js';
import type { PaymentProvider } from '../ports.js';
import { authorizeInput, group, harness, line, orderInput, product, totalOf, USD, type Harness } from './helpers.js';

let h: Harness;
let wallet: WalletPublicApi;
/** Amounts the card processor was asked to refund, in order */
const toCard: number[] = [];

beforeAll(async () => {
  h = await harness({ modules: ['wallet'] });
  wallet = h.app.kernel.boot.apis.get('wallet') as WalletPublicApi;
  const provider = h.service.core.provider as PaymentProvider;
  const refund = provider.refund.bind(provider);
  provider.refund = async (o) => {
    toCard.push(o.amount.amount);
    return refund(o);
  };
});
afterAll(async () => {
  await h?.app.close();
});

const balance = async (customerId: string) => (await wallet.getBalance(customerId)).available.amount;
const walletEntries = async (customerId: string) => ((await (h.app.kernel.boot.apis.get('wallet') as any).ledger.recent(customerId, 50, { staff: true })) as { kind: string; amount: { amount: number } }[]).map((e) => [e.kind, e.amount.amount]);
const intent = (id: string) => h.service.core.repo.get('intents', id);

/**
 * Checkout's part: the customer holds `credit` of their store credit for the checkout, the payment is authorized for
 * the whole order with the credit as a second tender, and the order is placed (wallet uses the credit, orders
 * accepts the order and payments captures the card's part).
 */
async function mixedOrder(credit: number, prices: number[], o: { captureMode?: string } = {}) {
  if (o.captureMode) h.settings['payments.captureMode'] = o.captureMode;
  else delete h.settings['payments.captureMode'];
  const customerId = newId();
  await wallet.creditRefund({ customerId, refundId: newId(), orderId: newId(), amount: USD(10_000), reason: 'Earlier refund to store credit' }, newId());
  const checkoutSessionId = newId();
  const sellerId = newId();
  const ps = prices.map((price) => product(h, { title: `Item ${price}`, price, ownerType: 'seller', sellerId }));
  const groups = [group(h, ps[0]!, ps.map((p) => line(p)))];
  const total = totalOf(groups);
  const hold = await wallet.holdCredit(customerId, checkoutSessionId, USD(credit), newId());
  const auth = await h.service.authorize({ ...authorizeInput({ checkoutSessionId, customerId, amount: total }), creditHoldId: hold.id, creditAmount: USD(credit) }, newId());
  expect(auth.state).toBe('accepted');
  h.sessions.set(checkoutSessionId, { orderId: null, status: 'placing', customerId });
  const order = await h.orders.createOrder(orderInput(groups, { checkoutSessionId, paymentIntentId: auth.intentId, customerId, paymentState: 'accepted' }));
  h.sessions.set(checkoutSessionId, { orderId: order.id, status: 'completed', customerId });
  await h.app.kernel.events.drain();
  return { customerId, order, checkoutSessionId, intentId: auth.intentId, total, items: order.groups.flatMap((g) => g.items.map((i) => i.id)) };
}

const refundOf = (orderId: string, items: { orderItemId: string; amount: number }[]) => ({
  orderId,
  origin: 'return' as const,
  originId: newId(),
  originRef: 'RT-261010-0001',
  items: items.map((i) => ({ orderItemId: i.orderItemId, amount: USD(i.amount) })),
  destination: 'original_method' as const,
  reason: 'Item returned',
  requestedBy: { kind: 'staff' as const, id: newId() },
});

describe('refunds of an order paid partly with store credit', () => {
  it('gives the store-credit part back first through wallet and sends only the rest to the card', async () => {
    const m = await mixedOrder(3_000, [6_000, 4_000]);
    const [a, b] = m.items as [string, string];
    expect(await balance(m.customerId)).toBe(7_000); // the credit was used when the order was placed
    expect((await intent(m.intentId))!).toMatchObject({ status: 'captured', captured_amount: 7_000 }); // the card pays the rest
    expect(await h.service.remainingRefundable(m.order.id)).toMatchObject({ captured: USD(10_000), remaining: USD(10_000) });

    const first = await h.service.startRefund(refundOf(m.order.id, [{ orderItemId: a, amount: 6_000 }]), newId());
    toCard.length = 0;
    await h.run('payments.process-refunds');
    expect((await h.service.getRefund(first.id))!.status).toBe('sent');
    expect(toCard).toEqual([3_000]); // 6 000 − the 3 000 of store credit
    expect(await balance(m.customerId)).toBe(10_000);
    expect(await walletEntries(m.customerId)).toContainEqual(['order_refund_returned', 3_000]);
    expect(h.named('payments.refund.sent').find((e) => e.refundId === first.id)).toMatchObject({ amount: USD(6_000), customerId: m.customerId, contactEmail: 'sam@example.com' });

    // the credit is back already: the next refund goes to the card in full
    const second = await h.service.startRefund(refundOf(m.order.id, [{ orderItemId: b, amount: 4_000 }]), newId());
    await h.run('payments.process-refunds');
    expect((await h.service.getRefund(second.id))!.status).toBe('sent');
    expect(toCard).toEqual([3_000, 4_000]); // the card got back exactly what it paid
    expect(await balance(m.customerId)).toBe(10_000);
    expect(await h.service.remainingRefundable(m.order.id)).toMatchObject({ refunded: USD(10_000), remaining: USD(0) });
    await expect(h.service.startRefund(refundOf(m.order.id, [{ orderItemId: b, amount: 1 }]), newId())).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_REFUNDABLE' });
  });

  it('sends nothing to the card when the store credit covers the refund, and a retry sends the same split', async () => {
    const m = await mixedOrder(5_000, [8_000]);
    const [a] = m.items as [string];
    const r = await h.service.startRefund(refundOf(m.order.id, [{ orderItemId: a, amount: 2_000 }]), newId());
    toCard.length = 0;
    await h.run('payments.process-refunds');
    expect((await h.service.getRefund(r.id))!.status).toBe('sent');
    expect(toCard).toEqual([]);
    expect(await balance(m.customerId)).toBe(5_000 + 2_000);

    // 3 000 of credit left: a 4 014 refund sends 1 014 to the card, which fails once (…14) after the credit went back
    const r2 = await h.service.startRefund(refundOf(m.order.id, [{ orderItemId: a, amount: 4_014 }]), newId());
    await h.run('payments.process-refunds');
    expect((await h.service.getRefund(r2.id))!.status).toBe('failed');
    expect(await balance(m.customerId)).toBe(5_000 + 2_000 + 3_000);
    h.clock.advance(3_600_000);
    await h.run('payments.process-refunds'); // the retry: the card part again, never the credit twice
    expect((await h.service.getRefund(r2.id))!.status).toBe('sent');
    expect(toCard).toEqual([1_014, 1_014]);
    expect(await balance(m.customerId)).toBe(5_000 + 2_000 + 3_000);
    expect((await walletEntries(m.customerId)).filter(([k]) => k === 'order_refund_returned').map(([, v]) => v).sort()).toEqual([2_000, 3_000]);
  });
});

describe('cancelling an order paid partly with store credit', () => {
  it('voids the card authorization and gives the store credit back when the order is cancelled before capture', async () => {
    const m = await mixedOrder(2_500, [5_000], { captureMode: 'per_group_on_dispatch' });
    expect(await balance(m.customerId)).toBe(7_500);
    expect((await intent(m.intentId))!).toMatchObject({ status: 'authorized', captured_amount: 0 });
    const cancelled = { orderId: m.order.id, ref: m.order.ref, reason: 'all_items_cancelled', checkoutSessionId: m.checkoutSessionId };
    await h.publish('orders', 'orders.order.cancelled', cancelled);
    expect((await intent(m.intentId))!.status).toBe('voided');
    expect(await balance(m.customerId)).toBe(10_000);
    await h.publish('orders', 'orders.order.cancelled', cancelled); // redelivered: nothing more
    expect(await balance(m.customerId)).toBe(10_000);
    expect((await walletEntries(m.customerId)).filter(([k]) => k === 'order_refund_returned')).toEqual([['order_refund_returned', 2_500]]);
  });

  // items cancelled before the capture shrink the order's allocation (payments.refreshAllocations); set it directly here
  const captureWhole = (intentId: string) => h.service.intents.capture(intentId, { key: `${intentId}:capture:order`, final: true, by: { actor: { kind: 'system', id: null } } });

  it('charges the card only for what the credit did not pay when items were cancelled before the capture', async () => {
    const m = await mixedOrder(2_000, [6_000, 3_000], { captureMode: 'per_group_on_dispatch' });
    await h.service.core.repo.updateWhere('allocations', { intent_id: m.intentId }, { amount: 6_000 }); // the 3 000 item was cancelled
    await captureWhole(m.intentId);
    expect((await intent(m.intentId))!).toMatchObject({ status: 'captured', captured_amount: 4_000 }); // 6 000 − 2 000 of credit
    expect(await balance(m.customerId)).toBe(8_000); // the credit stays used for the order
    await captureWhole(m.intentId); // replayed: nothing more
    expect((await intent(m.intentId))!.captured_amount).toBe(4_000);
  });

  it('gives back the credit beyond what is left of the order when more was cancelled than the card paid', async () => {
    const m = await mixedOrder(4_000, [5_000, 1_000], { captureMode: 'per_group_on_dispatch' });
    await h.service.core.repo.updateWhere('allocations', { intent_id: m.intentId }, { amount: 1_000 }); // the 5 000 item was cancelled
    await captureWhole(m.intentId);
    expect((await intent(m.intentId))!.captured_amount).toBe(0); // nothing left to charge on the card
    expect(await balance(m.customerId)).toBe(6_000 + 3_000); // 3 000 of the 4 000 credit came back
    await captureWhole(m.intentId); // replayed: the credit comes back once
    expect(await balance(m.customerId)).toBe(9_000);
    // the payment now counts the 1 000 of credit still used for the order
    expect((await h.service.remainingRefundable(m.order.id)).captured).toEqual(USD(1_000));
  });
});

describe('who the payment events are about', () => {
  it('names the customer and the contact email on captured, failed, pending_check, refund sent and failed events', async () => {
    const m = await mixedOrder(1_000, [3_000]);
    expect(h.named('payments.payment.captured').find((e) => e.intentId === m.intentId)).toMatchObject({ customerId: m.customerId, contactEmail: 'sam@example.com' });
    const declined = await h.service.authorize(authorizeInput({ amount: 1_002, guestEmail: 'gia@example.com' }), newId()); // …02 declines
    expect(h.named('payments.payment.failed').find((e) => e.intentId === declined.intentId)).toMatchObject({ customerId: null, contactEmail: 'gia@example.com' });
    const uncertain = await h.service.authorize(authorizeInput({ amount: 1_003, guestEmail: 'gia@example.com' }), newId()); // …03 times out
    expect(h.named('payments.payment.pending_check').find((e) => e.intentId === uncertain.intentId)).toMatchObject({ customerId: null, contactEmail: 'gia@example.com' });
    const r = await h.service.startRefund(refundOf(m.order.id, [{ orderItemId: m.items[0]!, amount: 2_012 }]), newId()); // …12: card closed
    await h.run('payments.process-refunds');
    expect(h.named('payments.refund.failed').find((e) => e.refundId === r.id)).toMatchObject({ customerId: m.customerId, contactEmail: 'sam@example.com', finalAttempt: true });
  });
});
