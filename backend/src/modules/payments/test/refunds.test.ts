import { newId } from '../../../kernel/lib/ids.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartRefundInput } from '../../../spec/payments.js';
import { harness, idem, placeOrder, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
const staff = () => tokens.staff();
const returnsActor = { kind: 'staff' as const, id: newId(), name: 'Rita Returns' };

beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.events.length = 0;
  h.audits.length = 0;
  for (const k of Object.keys(h.settings)) delete h.settings[k];
});

const refundInput = (orderId: string, items: { orderItemId: string; amount: number }[], o: Partial<StartRefundInput> = {}): StartRefundInput => ({
  orderId,
  origin: 'return',
  originId: newId(),
  originRef: 'RT-261009-0001',
  items: items.map((i) => ({ orderItemId: i.orderItemId, amount: USD(i.amount) })),
  destination: 'original_method',
  reason: 'Item returned',
  requestedBy: returnsActor,
  ...o,
});

describe('refundable amounts and hand-over', () => {
  it('caps refunds per item and per payment, returns the existing refund for the same key or origin', async () => {
    const customerId = newId();
    const placed = await placeOrder(h, { customerId, products: [[{ price: 12000 }], [{ price: 8000 }]] });
    const [a, b] = placed.items as [string, string];
    let cap = await h.service.remainingRefundable(placed.order.id);
    expect(cap).toMatchObject({ captured: USD(20000), refunded: USD(0), inFlight: USD(0), remaining: USD(20000) });
    expect(cap.items.find((i) => i.orderItemId === a)).toMatchObject({ paid: USD(12000), remaining: USD(12000), sellerName: 'Marketly Official Store' });

    const input = refundInput(placed.order.id, [{ orderItemId: a, amount: 5000 }], { requestRef: 'RT-261009-0193' });
    const key = newId();
    const r = await h.service.startRefund(input, key);
    expect(r).toMatchObject({ ref: 'RT-261009-0193', status: 'requested', statusLabel: 'Requested', amount: USD(5000), destination: 'original_method', destinationLabel: 'Visa •••• 4242', origin: 'return', customerName: 'Sam Rivera', attempts: 0, maxAttempts: 3 });
    expect(r.items).toEqual([expect.objectContaining({ orderItemId: a, amount: USD(5000) })]);
    expect(h.named('payments.refund.status_changed')).toEqual([expect.objectContaining({ refundId: r.id, from: null, to: 'requested', amount: USD(5000) })]);

    expect((await h.service.startRefund(input, key)).id).toBe(r.id);
    expect((await h.service.startRefund(input, newId())).id).toBe(r.id); // same origin, same content
    await expect(h.service.startRefund({ ...input, items: [{ orderItemId: a, amount: USD(4000) }] }, newId())).rejects.toMatchObject({ code: 'DUPLICATE_REFUND', status: 409, details: { refundId: r.id } });

    cap = await h.service.remainingRefundable(placed.order.id, [a]);
    expect(cap.items[0]).toMatchObject({ inFlight: USD(5000), remaining: USD(7000) });
    await expect(h.service.startRefund(refundInput(placed.order.id, [{ orderItemId: a, amount: 7001 }]), newId())).rejects.toMatchObject({
      code: 'REFUND_EXCEEDS_REFUNDABLE',
      status: 422,
      details: { items: [expect.objectContaining({ orderItemId: a, remaining: USD(7000) })] },
    });
    await expect(h.service.startRefund(refundInput(placed.order.id, [{ orderItemId: newId(), amount: 100 }]), newId())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(h.service.startRefund(refundInput(placed.order.id, [{ orderItemId: b, amount: 100 }], { destination: 'store_credit' }), newId())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const admin = await h.call('GET', `/api/admin/payments/orders/${placed.order.id}/refundable`, staff());
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    expect(admin.body).toMatchObject({ captured: USD(20000), inFlight: USD(5000), remaining: USD(15000) });
  });

  it('never lets concurrent refunds take the remainder below zero', async () => {
    const placed = await placeOrder(h, { products: [[{ price: 10000 }]] });
    const item = placed.items[0]!;
    const attempts = Array.from({ length: 8 }, () => h.service.startRefund(refundInput(placed.order.id, [{ orderItemId: item, amount: 3000 }]), newId()));
    const results = await Promise.allSettled(attempts);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(3);
    expect(refused.every((r) => (r.reason as { code: string }).code === 'REFUND_EXCEEDS_REFUNDABLE')).toBe(true);
    const cap = await h.service.remainingRefundable(placed.order.id);
    expect(cap).toMatchObject({ inFlight: USD(9000), remaining: USD(1000) });
    await h.run('payments.process-refunds');
    const after = await h.service.remainingRefundable(placed.order.id);
    expect(after).toMatchObject({ refunded: USD(9000), inFlight: USD(0), remaining: USD(1000) });
    expect((await h.service.core.repo.get('intents', placed.intentId))!.refunded_amount).toBe(9000);
  });

  it('refuses a refund when nothing was charged yet', async () => {
    h.settings['payments.captureMode'] = 'per_group_on_dispatch';
    const placed = await placeOrder(h, {});
    await expect(h.service.startRefund(refundInput(placed.order.id, [{ orderItemId: placed.items[0]!, amount: 100 }]), newId())).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_REFUNDABLE' });
    const cap = await h.service.remainingRefundable(placed.order.id);
    expect(cap.items[0]).toMatchObject({ remaining: USD(0), blockedReason: expect.stringContaining('Not charged yet') });
  });
});

describe('execution', () => {
  it('sends a requested refund, publishes sent and shows Partly refunded', async () => {
    const customerId = newId();
    const placed = await placeOrder(h, { customerId, products: [[{ price: 12000 }], [{ price: 8000 }]] });
    const r = await h.service.startRefund(refundInput(placed.order.id, [{ orderItemId: placed.items[1]!, amount: 8000 }]), newId());
    await h.run('payments.process-refunds');
    const sent = await h.service.getRefund(r.id);
    expect(sent).toMatchObject({ status: 'sent', attempts: 1, outcomeUnknown: false });
    expect(sent!.sentAt).toBeTruthy();
    expect(sent!.history.map((x) => x.label)).toEqual(['Requested', 'Processing', 'Sent']);
    expect(h.named('payments.refund.status_changed').filter((e) => e.refundId === r.id).map((e) => `${e.from}>${e.to}`)).toEqual(['null>requested', 'requested>processing', 'processing>sent']);
    expect(h.named('payments.refund.sent')).toEqual([expect.objectContaining({ refundId: r.id, orderId: placed.order.id, amount: USD(8000), destination: 'original_method' })]);
    expect(await h.service.getPaymentForOrder(placed.order.id)).toMatchObject({ customerState: 'partly_refunded', refundedAmount: USD(8000) });
    // orders mirrors the refund on the item (real orders consumer)
    const order = await h.orders.getOrder(placed.order.id);
    expect(order!.totals.refundedSoFar).toEqual(USD(8000));

    // the customer sees it, another customer does not
    const mine = await h.call('GET', '/api/store/payments/refunds', tokens.customer(customerId));
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.items).toEqual([expect.objectContaining({ id: r.id, status: 'sent', steps: ['Requested', 'Processing', 'Sent'], currentStep: 2, arrivalNote: 'Card refunds usually arrive 3–5 business days after we send them.' })]);
    expect((await h.call('GET', `/api/store/payments/refunds/${r.id}`, tokens.customer(customerId))).status).toBe(200);
    expect((await h.call('GET', `/api/store/payments/refunds/${r.id}`, tokens.customer(newId()))).status).toBe(404);
    expect((await h.call('GET', '/api/store/payments/refunds', tokens.customer(newId()))).body.items).toEqual([]);
    // a second run does nothing more
    await h.run('payments.process-refunds');
    expect(h.named('payments.refund.sent')).toHaveLength(1);
  });

  it('retries a retryable failure after a provider check, without ever sending twice', async () => {
    const placed = await placeOrder(h, { products: [[{ price: 10000 }]] });
    const r = await h.service.startRefund(refundInput(placed.order.id, [{ orderItemId: placed.items[0]!, amount: 3014 }]), newId());
    await h.run('payments.process-refunds');
    expect(await h.service.getRefund(r.id)).toMatchObject({ status: 'failed', failureCode: 'processing_error', attempts: 1 });
    expect(h.named('payments.refund.failed')).toEqual([expect.objectContaining({ refundId: r.id, attempts: 1, finalAttempt: false })]);
    const view = await h.service.refunds.view(await h.service.refunds.get(r.id));
    expect(view.failure).toMatchObject({ action: 'wait_for_retry' });
    await h.run('payments.process-refunds'); // not due yet
    expect((await h.service.getRefund(r.id))!.status).toBe('failed');
    h.clock.advance(6 * 60_000); // backoff after attempt 1: 5 minutes
    await h.run('payments.process-refunds');
    expect(await h.service.getRefund(r.id)).toMatchObject({ status: 'sent', attempts: 2 });
    const refundCalls = await h.service.core.repo.find('provider_calls', { refund_id: r.id, operation: 'refund' });
    expect(refundCalls.map((c) => c.outcome)).toEqual(['declined', 'ok']);
    expect((await h.service.core.repo.get('intents', placed.intentId))!.refunded_amount).toBe(3014);
  });

  it('treats a refund without an answer as unknown: checked, never resent', async () => {
    const placed = await placeOrder(h, { products: [[{ price: 10000 }]] });
    const r = await h.service.startRefund(refundInput(placed.order.id, [{ orderItemId: placed.items[0]!, amount: 2013 }]), newId());
    await h.run('payments.process-refunds');
    expect(await h.service.getRefund(r.id)).toMatchObject({ status: 'processing', outcomeUnknown: true, statusLabel: 'Processing (checking with the bank)' });
    const retry = await h.call('POST', `/api/admin/payments/refunds/${r.id}/retry`, staff(), { reason: 'Customer waiting' }, idem());
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('REFUND_OUTCOME_UNKNOWN');
    const failing = await h.call('GET', '/api/admin/payments/refunds?failing=true', staff());
    expect(failing.body.items.map((x: any) => x.id)).toContain(r.id);
    const check = await h.call('POST', `/api/admin/payments/refunds/${r.id}/check`, staff());
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body).toMatchObject({ status: 'sent', outcomeUnknown: false });
    expect((await h.service.core.repo.find('provider_calls', { refund_id: r.id, operation: 'refund' })).length).toBe(1);
  });

  it('asks the customer for a new destination after a final failure and sends it there', async () => {
    const customerId = newId();
    const placed = await placeOrder(h, { customerId, products: [[{ price: 10000 }]], token: 'tok_closed' });
    const r = await h.service.startRefund(refundInput(placed.order.id, [{ orderItemId: placed.items[0]!, amount: 4000 }]), newId());
    await h.run('payments.process-refunds');
    expect(await h.service.getRefund(r.id)).toMatchObject({ status: 'failed', failureCode: 'card_closed', failureReason: 'Card closed by the issuer' });
    expect(h.named('payments.refund.failed')).toEqual([expect.objectContaining({ refundId: r.id, finalAttempt: true })]);

    const asked = await h.call('POST', `/api/admin/payments/refunds/${r.id}/request-destination`, staff(), { message: 'Your card was closed' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(h.named('payments.refund.destination_requested')).toEqual([{ refundId: r.id, orderId: placed.order.id, amount: USD(4000) }]);
    expect(h.audits.find((a) => a.action === 'payments.refund.request_destination')).toBeTruthy();

    const owner = tokens.customer(customerId);
    const view = await h.call('GET', `/api/store/payments/refunds/${r.id}`, owner);
    expect(view.body).toMatchObject({ status: 'failed', failure: { action: 'choose_new_destination' }, steps: ['Requested', 'Processing', 'Failed'] });
    expect((await h.call('POST', `/api/store/payments/refunds/${r.id}/destination`, tokens.customer(newId()), { providerToken: 'tok_mastercard' }, idem())).status).toBe(404);
    expect((await h.call('POST', `/api/store/payments/refunds/${r.id}/destination`, owner, { providerToken: 'not-a-token' }, idem())).body.error.code).toBe('PAYMENT_METHOD_INVALID');
    expect((await h.call('POST', `/api/store/payments/refunds/${r.id}/destination`, owner, { storeCredit: true }, idem())).body.error.code).toBe('PAYMENT_METHOD_INVALID');
    const chosen = await h.call('POST', `/api/store/payments/refunds/${r.id}/destination`, owner, { providerToken: 'tok_mastercard' }, idem());
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(chosen.body).toMatchObject({ status: 'sent', destinationLabel: 'Mastercard •••• 4444' });
    expect(await h.service.getRefund(r.id)).toMatchObject({ destination: 'new_method', status: 'sent' });
    const again = await h.call('POST', `/api/store/payments/refunds/${r.id}/destination`, owner, { providerToken: 'tok_mastercard' }, idem());
    expect(again.status).toBe(409);
  });

  it('cancels a requested refund (releasing the cap) and refuses to cancel a sent one', async () => {
    const placed = await placeOrder(h, { products: [[{ price: 10000 }]] });
    const item = placed.items[0]!;
    const r = await h.service.startRefund(refundInput(placed.order.id, [{ orderItemId: item, amount: 10000 }]), newId());
    expect((await h.service.remainingRefundable(placed.order.id)).remaining).toEqual(USD(0));
    const noReason = await h.call('POST', `/api/admin/payments/refunds/${r.id}/cancel`, staff(), { reason: ' ' });
    expect(noReason.status).toBe(400);
    const c = await h.call('POST', `/api/admin/payments/refunds/${r.id}/cancel`, staff(), { reason: 'Settled with a replacement' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ status: 'cancelled' });
    expect((await h.service.remainingRefundable(placed.order.id)).remaining).toEqual(USD(10000));
    expect(h.audits.find((a) => a.action === 'payments.refund.cancel')).toMatchObject({ reason: 'Settled with a replacement' });
    // the origin is free again
    const again = await h.service.startRefund(refundInput(placed.order.id, [{ orderItemId: item, amount: 2000 }], { originId: r.originId! }), newId());
    await h.run('payments.process-refunds');
    expect((await h.call('POST', `/api/admin/payments/refunds/${again.id}/cancel`, staff(), { reason: 'x' })).status).toBe(409);
    const retrySent = await h.call('POST', `/api/admin/payments/refunds/${again.id}/retry`, staff(), { reason: 'x' }, idem());
    expect(retrySent.body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('caps admin retries at refundMaxAttempts', async () => {
    h.settings['payments.refundMaxAttempts'] = 1;
    const placed = await placeOrder(h, { products: [[{ price: 10000 }]] });
    const r = await h.service.startRefund(refundInput(placed.order.id, [{ orderItemId: placed.items[0]!, amount: 1014 }]), newId());
    await h.run('payments.process-refunds');
    expect(await h.service.getRefund(r.id)).toMatchObject({ status: 'failed', maxAttempts: 1 });
    const res = await h.call('POST', `/api/admin/payments/refunds/${r.id}/retry`, staff(), { reason: 'Try again' }, idem());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REFUND_RETRY_LIMIT');
    h.settings['payments.refundMaxAttempts'] = 3;
    const ok = await h.call('POST', `/api/admin/payments/refunds/${r.id}/retry`, staff(), { reason: 'Try again' }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'sent', attempts: 2 });
    expect(h.audits.find((a) => a.action === 'payments.refund.retry')).toBeTruthy();
  });
});

describe('cancellations from orders', () => {
  const cancelled = (placed: Awaited<ReturnType<typeof placeOrder>>, itemId: string, cancellationId: string, total: number) => ({
    orderId: placed.order.id,
    ref: placed.order.ref,
    groupId: placed.order.groups.find((g) => g.items.some((i) => i.id === itemId))!.id,
    ownerType: 'official',
    sellerId: null,
    itemId,
    offerId: newId(),
    stockItemId: newId(),
    quantity: 1,
    cancellationId,
    initiatedBy: 'customer',
    reasonCode: 'changed_mind',
    beforeDispatch: true,
    countsAgainstSeller: false,
    refund: { itemAmount: USD(total), discountShare: USD(0), shippingRefund: USD(0), taxRefund: USD(0), total: USD(total) },
    paymentIntentId: placed.intentId,
    trustReportId: null,
  });

  it('starts one cancellation refund for every item of a cancellation, once', async () => {
    const placed = await placeOrder(h, { products: [[{ price: 12000 }, { price: 3000 }]] });
    const [a, b] = placed.items as [string, string];
    const cancellationId = newId();
    await h.publish('orders', 'orders.item.cancelled', cancelled(placed, a, cancellationId, 12000));
    await h.publish('orders', 'orders.item.cancelled', cancelled(placed, b, cancellationId, 3000));
    await h.publish('orders', 'orders.item.cancelled', cancelled(placed, b, cancellationId, 3000)); // replay
    const refunds = await h.service.listRefundsForOrder(placed.order.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ origin: 'cancellation', originId: cancellationId, amount: USD(15000), status: 'requested' });
    expect(refunds[0]!.items.map((i) => i.orderItemId).sort()).toEqual([a, b].sort());
    expect(refunds[0]!.requestedBy.kind).toBe('customer');
  });

  it('reduces the uncaptured authorization instead when the group was not charged yet', async () => {
    h.settings['payments.captureMode'] = 'per_group_on_dispatch';
    const placed = await placeOrder(h, { products: [[{ price: 12000 }, { price: 3000 }]] });
    await h.publish('orders', 'orders.item.cancelled', cancelled(placed, placed.items[1]!, newId(), 3000));
    expect(await h.service.listRefundsForOrder(placed.order.id)).toEqual([]);
  });
});
