/**
 * Manual money actions on the payments admin API (capture, void, returning an orphan payment, retrying and
 * cancelling a refund) are held to limits through access (approval action payments.payments.correct): within the
 * caller's limit done now, above stepUpAbove only with the password again (reauthToken), above the limit an
 * approval request and 409 APPROVAL_REQUIRED, carried out by payments once access approves it; no authority: 403.
 */
import { newId } from '../../../kernel/lib/ids.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartRefundInput } from '../../../spec/payments.js';
import { authorizeInput, harness, idem, placeOrder, REAUTH, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
const staff = () => tokens.staff();
const ACTION = 'payments.payments.correct';

beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.access.decision = 'allowed';
  h.access.stepUp = false;
  h.audits.length = 0;
});

const refundInput = (orderId: string, orderItemId: string, amount: number): StartRefundInput => ({
  orderId,
  origin: 'return',
  originId: newId(),
  originRef: 'RT-261009-0001',
  items: [{ orderItemId, amount: USD(amount) }],
  destination: 'original_method',
  reason: 'Return',
  requestedBy: { kind: 'staff', id: newId() },
});

/** A refund that failed once with a retryable processing error (provider: amounts ending …14) */
async function failedRefund() {
  const placed = await placeOrder(h, { products: [[{ price: 10000 }]] });
  const r = await h.service.startRefund(refundInput(placed.order.id, placed.items[0]!, 1014), newId());
  await h.run('payments.process-refunds');
  expect(await h.service.getRefund(r.id)).toMatchObject({ status: 'failed' });
  return r;
}

/** The access.approval.decided access publishes once the request is approved */
async function approve(requestId: string, target: { type: string; id: string }) {
  await h.publish('access', 'access.approval.decided', { requestId, ref: 'AP-261009-0001', actionKey: ACTION, module: 'payments', target, outcome: 'approved', decidedBy: { kind: 'staff', id: newId(), name: 'Olivia Owner' }, reason: null, amount: null, approverIds: [], requestedById: newId() });
}

describe('step-up within the limit', () => {
  it('capture above stepUpAbove needs the password again; nothing is captured without it', async () => {
    const placed = await placeOrder(h, { products: [[{ price: 9922 }]] }); // the automatic capture fails (…22)
    h.access.stepUp = true;
    const missing = await h.call('POST', `/api/admin/payments/payments/${placed.intentId}/capture`, staff(), { reason: 'Retry capture' }, idem());
    expect(missing.status).toBe(403);
    expect(missing.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { kind: 'reauth', purpose: 'approval' } });
    expect((await h.service.getPaymentForOrder(placed.order.id))!.capturedAmount).toEqual(USD(0));
    const wrong = await h.call('POST', `/api/admin/payments/payments/${placed.intentId}/capture`, staff(), { reason: 'Retry capture', reauthToken: 'ra.-.not-issued' }, idem());
    expect(wrong.body.error.code).toBe('STEP_UP_REQUIRED');
    const ok = await h.call('POST', `/api/admin/payments/payments/${placed.intentId}/capture`, staff(), { amount: USD(9900), reason: 'Retry capture', reauthToken: REAUTH }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ capturedAmount: USD(9900) });
  });

  it('void, orphan refund, refund retry and refund cancel ask for it too', async () => {
    h.access.stepUp = true;
    const auth = await h.service.authorize(authorizeInput({ amount: 6000 }), newId());
    expect((await h.call('POST', `/api/admin/payments/payments/${auth.intentId}/void`, staff(), { reason: 'Customer called' }, idem())).body.error.code).toBe('STEP_UP_REQUIRED');
    const voided = await h.call('POST', `/api/admin/payments/payments/${auth.intentId}/void`, staff(), { reason: 'Customer called', reauthToken: REAUTH }, idem());
    expect(voided.body.status).toBe('voided');

    const orphan = await h.service.authorize(authorizeInput({ amount: 6101 }), newId());
    await h.service.core.repo.update('intents', orphan.intentId, { orphan: true });
    expect((await h.call('POST', `/api/admin/payments/payments/${orphan.intentId}/resolve-orphan`, staff(), { action: 'refund', reason: 'No order' }, idem())).body.error.code).toBe('STEP_UP_REQUIRED');
    const returned = await h.call('POST', `/api/admin/payments/payments/${orphan.intentId}/resolve-orphan`, staff(), { action: 'refund', reason: 'No order', reauthToken: REAUTH }, idem());
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(returned.body.status).toBe('voided');

    const r = await failedRefund();
    expect((await h.call('POST', `/api/admin/payments/refunds/${r.id}/retry`, staff(), { reason: 'Again' }, idem())).body.error.code).toBe('STEP_UP_REQUIRED');
    expect((await h.call('POST', `/api/admin/payments/refunds/${r.id}/cancel`, staff(), { reason: 'Settled' })).body.error.code).toBe('STEP_UP_REQUIRED');
    expect(await h.service.getRefund(r.id)).toMatchObject({ status: 'failed' });
    const retried = await h.call('POST', `/api/admin/payments/refunds/${r.id}/retry`, staff(), { reason: 'Again', reauthToken: REAUTH }, idem());
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.status).toBe('sent');

    const c = await failedRefund();
    const cancelled = await h.call('POST', `/api/admin/payments/refunds/${c.id}/cancel`, staff(), { reason: 'Settled', reauthToken: REAUTH });
    expect(cancelled.body.status).toBe('cancelled');
  });

  it('within the limit and below stepUpAbove no password is asked, and the amount is what access weighs', async () => {
    const auth = await h.service.authorize(authorizeInput({ amount: 6200 }), newId());
    const res = await h.call('POST', `/api/admin/payments/payments/${auth.intentId}/void`, staff(), { reason: 'Customer called' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('voided');
  });
});

describe('above the limit and without authority', () => {
  it('capture above the limit: approval request and 409 APPROVAL_REQUIRED; captured once access approves', async () => {
    const placed = await placeOrder(h, { products: [[{ price: 9922 }]] });
    h.access.decision = 'approval_required';
    const res = await h.call('POST', `/api/admin/payments/payments/${placed.intentId}/capture`, staff(), { amount: USD(9900), reason: 'Retry capture' }, idem());
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { approvalRequestId: expect.any(String), approval: { required: true } } });
    const request = h.access.requests.at(-1)!;
    expect(request).toMatchObject({ action: ACTION, amount: USD(9900), target: { type: 'payment_capture', id: placed.intentId, screen: 'admin/finance' }, details: { amount: USD(9900), groupId: null, reason: 'Retry capture' } });
    expect((await h.service.getPaymentForOrder(placed.order.id))!.capturedAmount).toEqual(USD(0));

    await approve(res.body.error.details.approvalRequestId, request.target);
    expect((await h.service.getPaymentForOrder(placed.order.id))!.capturedAmount).toEqual(USD(9900));
    expect(h.audits.find((a) => a.action === 'payments.payment.capture')).toMatchObject({ approvalRequestId: res.body.error.details.approvalRequestId, actor: { name: 'Olivia Owner' } });
  });

  it('void, orphan refund, retry and cancel above the limit wait for approval, then run', async () => {
    h.access.decision = 'approval_required';
    const auth = await h.service.authorize(authorizeInput({ amount: 6300 }), newId());
    const v = await h.call('POST', `/api/admin/payments/payments/${auth.intentId}/void`, staff(), { reason: 'Customer called' }, idem());
    expect(v.body.error.code).toBe('APPROVAL_REQUIRED');
    expect(h.access.requests.at(-1)).toMatchObject({ amount: USD(6300), target: { type: 'payment_void' } });
    await approve(v.body.error.details.approvalRequestId, h.access.requests.at(-1)!.target);
    expect((await h.service.core.repo.get('intents', auth.intentId))!.status).toBe('voided');

    const orphan = await h.service.authorize(authorizeInput({ amount: 6400 }), newId());
    await h.service.core.repo.update('intents', orphan.intentId, { orphan: true });
    const o = await h.call('POST', `/api/admin/payments/payments/${orphan.intentId}/resolve-orphan`, staff(), { action: 'refund', reason: 'No order' }, idem());
    expect(o.body.error.code).toBe('APPROVAL_REQUIRED');
    await approve(o.body.error.details.approvalRequestId, h.access.requests.at(-1)!.target);
    expect((await h.service.core.repo.get('intents', orphan.intentId))!.status).toBe('voided');
    // linking an orphan to its order moves no money: no limit
    const placed = await placeOrder(h, {});
    await h.service.core.repo.update('intents', placed.intentId, { order_id: null, orphan: true });
    const linked = await h.call('POST', `/api/admin/payments/payments/${placed.intentId}/resolve-orphan`, staff(), { action: 'link_to_order', orderId: placed.order.id, reason: 'Found it' }, idem());
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);

    const r = await failedRefund();
    const retry = await h.call('POST', `/api/admin/payments/refunds/${r.id}/retry`, staff(), { reason: 'Again' }, idem());
    expect(retry.body.error.code).toBe('APPROVAL_REQUIRED');
    expect(h.access.requests.at(-1)).toMatchObject({ amount: USD(1014), target: { type: 'refund_retry', id: r.id } });
    await approve(retry.body.error.details.approvalRequestId, h.access.requests.at(-1)!.target);
    expect(await h.service.getRefund(r.id)).toMatchObject({ status: 'sent' });

    const c = await failedRefund();
    const cancel = await h.call('POST', `/api/admin/payments/refunds/${c.id}/cancel`, staff(), { reason: 'Settled' });
    expect(cancel.body.error.code).toBe('APPROVAL_REQUIRED');
    await approve(cancel.body.error.details.approvalRequestId, h.access.requests.at(-1)!.target);
    expect(await h.service.getRefund(c.id)).toMatchObject({ status: 'cancelled' });
  });

  it('a rejected request changes nothing', async () => {
    h.access.decision = 'approval_required';
    const auth = await h.service.authorize(authorizeInput({ amount: 6500 }), newId());
    const v = await h.call('POST', `/api/admin/payments/payments/${auth.intentId}/void`, staff(), { reason: 'Customer called' }, idem());
    const target = h.access.requests.at(-1)!.target;
    await h.publish('access', 'access.approval.decided', { requestId: v.body.error.details.approvalRequestId, ref: 'AP-1', actionKey: ACTION, module: 'payments', target, outcome: 'rejected', decidedBy: { kind: 'staff', id: newId() }, reason: 'No', amount: null, approverIds: [], requestedById: newId() });
    expect((await h.service.core.repo.get('intents', auth.intentId))!.status).toBe('authorized');
  });

  it('no authority at all: 403, nothing asked', async () => {
    h.access.decision = 'denied';
    const before = h.access.requests.length;
    const auth = await h.service.authorize(authorizeInput({ amount: 6600 }), newId());
    const v = await h.call('POST', `/api/admin/payments/payments/${auth.intentId}/void`, staff(), { reason: 'Customer called' }, idem());
    expect(v.status).toBe(403);
    expect(v.body.error.code).toBe('FORBIDDEN');
    const r = await failedRefund();
    expect((await h.call('POST', `/api/admin/payments/refunds/${r.id}/retry`, staff(), { reason: 'Again' }, idem())).status).toBe(403);
    expect(h.access.requests.length).toBe(before);
  });
});
