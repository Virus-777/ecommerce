import { newId } from '../../../kernel/lib/ids.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolvers } from '../graphql/resolvers.js';
import { devWebhook } from '../providers/card-processor.js';
import { harness, idem, placeOrder, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
const staff = () => tokens.staff();

beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.events.length = 0;
  h.audits.length = 0;
  h.access.decision = 'allowed';
  h.access.requests.length = 0;
  for (const k of Object.keys(h.settings)) delete h.settings[k];
});

async function openDispute(o: { products?: { price: number }[][]; amount?: number; kind?: string; dueInDays?: number } = {}) {
  const placed = await placeOrder(h, { products: o.products ?? [[{ price: 12000 }], [{ price: 48000 }]] });
  const intent = (await h.service.core.repo.get('intents', placed.intentId))!;
  const caseId = `dp_${newId()}`;
  const res = await h.webhook(
    devWebhook('dispute.created', {
      caseId,
      paymentRef: intent.provider_ref,
      kind: o.kind ?? 'chargeback',
      amount: o.amount ?? 48000,
      currency: 'USD',
      reasonCode: '13.1',
      reason: 'Item not received (card issuer)',
      evidenceDueBy: new Date(h.clock.now().getTime() + (o.dueInDays ?? 7) * 86_400_000).toISOString(),
    }),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const d = (await h.service.core.repo.find('disputes', { provider_case_id: caseId }))[0]!;
  return { placed, caseId, dispute: d };
}

describe('disputes', () => {
  it('opens a chargeback from the provider once, linked to the seller group whose share it matches', async () => {
    const { placed, caseId, dispute } = await openDispute();
    const sellerGroup = placed.order.groups[1]!;
    expect(dispute).toMatchObject({ kind: 'chargeback', status: 'opened', amount: 48000, group_id: sellerGroup.id, seller_id: sellerGroup.seller.id });
    expect(dispute.ref).toMatch(/^CB-\d{6}-\d{4}$/);
    expect(h.named('payments.chargeback.opened')).toEqual([expect.objectContaining({ disputeId: dispute.id, ref: dispute.ref, kind: 'chargeback', orderId: placed.order.id, groupId: sellerGroup.id, amount: USD(48000) })]);
    // the same case again (another event id) is not a second dispute
    const intent = (await h.service.core.repo.get('intents', placed.intentId))!;
    await h.webhook(devWebhook('dispute.created', { caseId, paymentRef: intent.provider_ref, amount: 48000 }));
    expect(await h.service.core.repo.find('disputes', { provider_case_id: caseId })).toHaveLength(1);

    const res = await h.call('GET', `/api/admin/payments/disputes/${dispute.id}`, staff());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ orderRef: placed.order.ref, sellerName: 'Casa Verde Home', customerName: 'gia@example.com', sellerBalanceEffect: 'Held $480.00', statusLabel: 'Opened: evidence needed', evidenceDue: { state: 'on_time' } });
    const inquiry = await openDispute({ kind: 'inquiry', amount: 1000 });
    expect(inquiry.dispute.ref).toMatch(/^DP-/);
    expect(inquiry.dispute.group_id).toBeNull();
    const orderDisputes = await h.service.listDisputesForOrder(placed.order.id);
    expect(orderDisputes.map((d) => d.id)).toEqual([dispute.id]);
    const payment = await h.call('GET', '/api/admin/payments/payments?flag=chargeback', staff());
    expect(payment.body.items.map((x: any) => x.id)).toContain(placed.intentId);
  });

  it('lists disputes with evidence due first', async () => {
    const late = await openDispute({ dueInDays: 9 });
    const soon = await openDispute({ dueInDays: 1 });
    const res = await h.call('GET', '/api/admin/payments/disputes?status=opened', staff());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = res.body.items.map((d: any) => d.id);
    expect(ids.indexOf(soon.dispute.id)).toBeLessThan(ids.indexOf(late.dispute.id));
    expect(res.body.items.find((d: any) => d.id === soon.dispute.id).evidenceDue.state).toBe('due_soon');
    const page = await h.call('GET', '/api/admin/payments/disputes?limit=1', staff());
    expect(page.body.items).toHaveLength(1);
    const next = await h.call('GET', `/api/admin/payments/disputes?limit=1&cursor=${page.body.nextCursor}`, staff());
    expect(next.status).toBe(200);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
  });

  it('assigns an owner, saves and submits evidence, then the provider decides', async () => {
    const { dispute, caseId } = await openDispute();
    const ownerId = newId();
    h.access.staff.set(ownerId, 'Fiona Finance');
    expect((await h.call('POST', `/api/admin/payments/disputes/${dispute.id}/assign`, staff(), { ownerStaffId: newId() })).status).toBe(400);
    const assigned = await h.call('POST', `/api/admin/payments/disputes/${dispute.id}/assign`, staff(), { ownerStaffId: ownerId });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body.owner).toBe('Fiona Finance');

    const fileId = newId();
    h.files.add(fileId);
    const saved = await h.call('POST', `/api/admin/payments/disputes/${dispute.id}/evidence`, staff(), { text: 'Delivered, signed by S. Rivera', fileIds: [fileId], submit: false });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ status: 'opened', evidence: { text: 'Delivered, signed by S. Rivera', files: [expect.objectContaining({ id: fileId })], submittedAt: null } });
    // the evidence file is attached to the dispute, so the media orphan sweep keeps it
    expect(h.attached.filter((a) => a.assetId === fileId)).toEqual([{ assetId: fileId, usage: { module: 'payments', kind: 'dispute_evidence', refId: dispute.id, refLabel: dispute.ref }, owner: { kind: 'staff', id: 'staff-1' } }]);
    const submitted = await h.call('POST', `/api/admin/payments/disputes/${dispute.id}/evidence`, staff(), { text: 'Delivered, signed by S. Rivera', submit: true });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    // the provider call is logged against the dispute's payment
    const row = (await h.service.core.repo.get('disputes', dispute.id))!;
    expect((await h.service.core.repo.find('provider_calls', { intent_id: row.intent_id, operation: 'dispute_evidence' })).map((c) => [c.outcome, c.provider_ref])).toEqual([['ok', caseId]]);
    expect(submitted.body.status).toBe('under_review');
    expect(submitted.body.evidence.submittedAt).toBeTruthy();
    expect(h.named('payments.chargeback.status_changed')).toEqual([{ disputeId: dispute.id, status: 'under_review' }]);
    expect(h.audits.map((a) => a.action)).toEqual(expect.arrayContaining(['payments.dispute.assign', 'payments.dispute.save_evidence', 'payments.dispute.submit_evidence']));
    expect((await h.call('POST', `/api/admin/payments/disputes/${dispute.id}/evidence`, staff(), { text: 'more', submit: true })).body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await h.call('POST', `/api/admin/payments/disputes/${dispute.id}/accept`, staff(), { reason: 'x' })).body.error.code).toBe('ILLEGAL_TRANSITION');

    await h.webhook(devWebhook('dispute.closed', { caseId, outcome: 'won' }));
    await h.webhook(devWebhook('dispute.closed', { caseId, outcome: 'won' }));
    const decided = await h.call('GET', `/api/admin/payments/disputes/${dispute.id}`, staff());
    expect(decided.body).toMatchObject({ status: 'won', sellerBalanceEffect: 'Hold of $480.00 released' });
    expect(h.named('payments.chargeback.decided')).toEqual([expect.objectContaining({ disputeId: dispute.id, outcome: 'won', amount: USD(48000) })]);
  });

  it('closes the evidence window at the deadline and marks the case lost', async () => {
    const { dispute } = await openDispute({ dueInDays: 1 });
    await h.run('payments.dispute-deadlines');
    let d = await h.service.disputes.get(dispute.id);
    expect(d.due_soon_flagged_at).not.toBeNull();
    expect(d.status).toBe('opened');
    h.clock.advance(2 * 86_400_000);
    const closed = await h.call('POST', `/api/admin/payments/disputes/${dispute.id}/evidence`, staff(), { text: 'Late', submit: true });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('EVIDENCE_WINDOW_CLOSED');
    await h.run('payments.dispute-deadlines');
    d = await h.service.disputes.get(dispute.id);
    expect(d.status).toBe('lost');
    expect(h.named('payments.chargeback.decided').filter((e) => e.disputeId === dispute.id)).toEqual([expect.objectContaining({ outcome: 'lost', amount: USD(48000) })]);
  });

  it('concedes within the limit, asks for approval above it and finishes on the decision', async () => {
    const within = await openDispute();
    const ok = await h.call('POST', `/api/admin/payments/disputes/${within.dispute.id}/accept`, staff(), { reason: 'Customer is right' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('lost');
    const conceded = (await h.service.core.repo.get('disputes', within.dispute.id))!;
    expect((await h.service.core.repo.find('provider_calls', { intent_id: conceded.intent_id, operation: 'dispute_accept' })).map((c) => [c.outcome, c.provider_ref])).toEqual([['ok', within.caseId]]);
    expect(h.named('payments.chargeback.decided')).toEqual([expect.objectContaining({ disputeId: within.dispute.id, outcome: 'lost' })]);
    expect(h.audits.find((a) => a.action === 'payments.dispute.accept')).toMatchObject({ reason: 'Customer is right', category: 'financial' });

    h.access.decision = 'denied';
    const denied = await openDispute();
    expect((await h.call('POST', `/api/admin/payments/disputes/${denied.dispute.id}/accept`, staff(), { reason: 'x' })).status).toBe(403);

    h.access.decision = 'approval_required';
    const above = await openDispute();
    const res = await h.call('POST', `/api/admin/payments/disputes/${above.dispute.id}/accept`, staff(), { reason: 'Not worth contesting' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('APPROVAL_REQUIRED');
    const approvalId = res.body.error.details.approvalRequestId;
    expect(h.access.requests).toEqual([expect.objectContaining({ action: 'payments.disputes.accept', amount: USD(48000), target: expect.objectContaining({ type: 'payment_dispute', id: above.dispute.id }) })]);
    expect((await h.service.disputes.get(above.dispute.id)).status).toBe('opened');
    const pending = await h.call('GET', `/api/admin/payments/disputes/${above.dispute.id}`, staff());
    expect(pending.body.statusLabel).toBe('Concession waiting for approval');

    const decided = (outcome: string, requestId = approvalId) => ({
      requestId,
      ref: 'AP-261009-0001',
      actionKey: 'payments.disputes.accept',
      module: 'payments',
      target: { type: 'payment_dispute', id: above.dispute.id },
      outcome,
      decidedBy: { kind: 'staff', id: newId(), name: 'Max Manager' },
      approverIds: [],
      requestedById: newId(),
    });
    await h.publish('access', 'access.approval.decided', decided('approved', newId())); // another request: ignored
    expect((await h.service.disputes.get(above.dispute.id)).status).toBe('opened');
    await h.publish('access', 'access.approval.decided', decided('approved'));
    expect((await h.service.disputes.get(above.dispute.id)).status).toBe('lost');
    expect(h.named('payments.chargeback.decided').map((e) => e.disputeId)).toContain(above.dispute.id);

    const rejected = await openDispute();
    await h.call('POST', `/api/admin/payments/disputes/${rejected.dispute.id}/accept`, staff(), { reason: 'r' });
    const req = h.access.requests.at(-1)!;
    void req;
    const reqId = (await h.service.disputes.get(rejected.dispute.id)).approval_request_id!;
    await h.publish('access', 'access.approval.decided', { ...decided('rejected', reqId), target: { type: 'payment_dispute', id: rejected.dispute.id } });
    const after = await h.service.disputes.get(rejected.dispute.id);
    expect(after.status).toBe('opened');
    expect(after.approval_request_id).toBeNull();
  });
});

describe('saved payment methods', () => {
  it('saves cards from a provider setup (tokens only), keeps one default and removes them', async () => {
    const customerId = newId();
    const me = tokens.customer(customerId);
    const setup = await h.call('POST', '/api/store/payments/methods/setup', me);
    expect(setup.status, JSON.stringify(setup.body)).toBe(201);
    expect(setup.body).toMatchObject({ provider: 'card-processor', publishableKey: 'pk_dev_marketly' });

    const bad = await h.call('POST', '/api/store/payments/methods', me, { setupToken: 'seti_nope' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('PAYMENT_METHOD_INVALID');
    expect((await h.call('POST', '/api/store/payments/methods', me, { setupToken: 'seti_unionpay_1234' })).body.error.code).toBe('PAYMENT_METHOD_INVALID');
    expect((await h.call('POST', '/api/store/payments/methods', me, { setupToken: 'seti_unavailable' })).status).toBe(503);

    const billing = { name: 'Sam Rivera', line1: '1 Main St', city: 'Portland', region: 'OR', postalCode: '97205', country: 'US' };
    const first = await h.call('POST', '/api/store/payments/methods', me, { setupToken: 'seti_visa_4417', billingAddress: billing });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ kind: 'card', brand: 'visa', last4: '4417', label: 'Visa •••• 4417', isDefault: true, expired: false, billingSummary: 'Portland 97205' });
    const second = await h.call('POST', '/api/store/payments/methods', me, { setupToken: 'seti_mastercard_5100', label: 'Work Mastercard', makeDefault: true });
    expect(second.body).toMatchObject({ label: 'Work Mastercard', isDefault: true, billingSummary: 'No billing address' });
    expect(h.named('payments.method.saved')).toEqual([
      { customerId, methodId: first.body.id, brand: 'visa' },
      { customerId, methodId: second.body.id, brand: 'mastercard' },
    ]);
    const stored = await h.service.core.repo.get('saved_methods', first.body.id);
    expect(stored!.provider_method_id).toMatch(/^pm_/);
    expect(JSON.stringify(stored)).not.toMatch(/\d{12,}/);

    let list = await h.call('GET', '/api/store/payments/methods', me);
    expect(list.body.map((m: any) => [m.id, m.isDefault])).toEqual([
      [second.body.id, true],
      [first.body.id, false],
    ]);
    const def = await h.call('POST', `/api/store/payments/methods/${first.body.id}/make-default`, me);
    expect(def.body.isDefault).toBe(true);
    const updated = await h.call('PATCH', `/api/store/payments/methods/${first.body.id}`, me, { label: 'Personal Visa', expMonth: 11, expYear: 2031 });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({ label: 'Personal Visa', expMonth: 11, expYear: 2031 });
    expect((await h.call('PATCH', `/api/store/payments/methods/${first.body.id}`, me, { expMonth: 13 })).body.error.code).toBe('PAYMENT_METHOD_INVALID');

    // another customer never sees or changes them
    const other = tokens.customer(newId());
    expect((await h.call('GET', '/api/store/payments/methods', other)).body).toEqual([]);
    expect((await h.call('PATCH', `/api/store/payments/methods/${first.body.id}`, other, { label: 'Mine' })).status).toBe(404);
    expect((await h.call('DELETE', `/api/store/payments/methods/${first.body.id}`, other)).status).toBe(404);

    // pay with the saved card, then remove it: the payment keeps its label
    const pay = await h.service.authorize(
      { checkoutSessionId: newId(), attemptNo: 1, customerId, amount: USD(2500), method: { kind: 'saved_card', savedMethodId: first.body.id }, description: 'Order', returnUrl: 'https://store.example/return' },
      newId(),
    );
    expect(pay).toMatchObject({ state: 'accepted', methodLabel: 'Visa •••• 4417' });
    await expect(
      h.service.authorize({ checkoutSessionId: newId(), attemptNo: 1, customerId: newId(), amount: USD(2500), method: { kind: 'saved_card', savedMethodId: first.body.id }, description: 'Order', returnUrl: 'https://store.example/return' }, newId()),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_INVALID' });
    const removed = await h.call('DELETE', `/api/store/payments/methods/${first.body.id}`, me);
    expect(removed.status).toBe(204);
    expect(h.named('payments.method.removed')).toEqual([{ customerId, methodId: first.body.id }]);
    expect(await h.service.methodLabel(pay.intentId)).toBe('Visa •••• 4417');
    list = await h.call('GET', '/api/store/payments/methods', me);
    expect(list.body.map((m: any) => [m.id, m.isDefault])).toEqual([[second.body.id, true]]);
  });

  it('refuses expired cards as default and at checkout; the card updater renews them', async () => {
    const customerId = newId();
    const me = tokens.customer(customerId);
    const valid = await h.call('POST', '/api/store/payments/methods', me, { setupToken: 'seti_visa_1111' });
    const old = await h.call('POST', '/api/store/payments/methods', me, { setupToken: 'seti_amex_0005_0120_renew' });
    expect(old.body).toMatchObject({ expired: true, isDefault: false });
    const def = await h.call('POST', `/api/store/payments/methods/${old.body.id}/make-default`, me);
    expect(def.status).toBe(422);
    expect(def.body.error.code).toBe('PAYMENT_METHOD_EXPIRED');
    await expect(
      h.service.authorize({ checkoutSessionId: newId(), attemptNo: 1, customerId, amount: USD(2500), method: { kind: 'saved_card', savedMethodId: old.body.id }, description: 'Order', returnUrl: 'https://store.example/return' }, newId()),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_EXPIRED' });
    await h.run('payments.card-expiry');
    const list = await h.call('GET', '/api/store/payments/methods', me);
    expect(list.body.find((m: any) => m.id === old.body.id)).toMatchObject({ expired: false });
    expect(list.body.find((m: any) => m.id === valid.body.id)).toMatchObject({ isDefault: true });
    const options = await h.call('GET', '/api/store/payments/options?amount=100&currency=USD', me);
    expect(options.body.savedMethods).toHaveLength(2);
  });

  it('saves a card for later when the customer ticks it at checkout', async () => {
    const customerId = newId();
    const r = await h.service.authorize(
      { checkoutSessionId: newId(), attemptNo: 1, customerId, amount: USD(2500), method: { kind: 'new_card', providerToken: 'tok_discover', saveForLater: true, label: 'Travel card' }, description: 'Order', returnUrl: 'https://store.example/return' },
      newId(),
    );
    expect(r.state).toBe('accepted');
    const methods = await h.service.listSavedMethods(customerId);
    expect(methods).toEqual([expect.objectContaining({ brand: 'discover', label: 'Travel card', isDefault: true })]);
  });
});

describe('GraphQL', () => {
  it('resolves Order.payment, refunds, refundable and paymentDisputes for staff, and the customer view in the store', async () => {
    const customerId = newId();
    const { placed } = await openDispute({ products: [[{ price: 12000 }], [{ price: 48000 }]] });
    await h.service.startRefund(
      { orderId: placed.order.id, origin: 'return', originId: newId(), items: [{ orderItemId: placed.items[0]!, amount: USD(2000) }], destination: 'original_method', reason: 'Returned', requestedBy: { kind: 'staff', id: newId() } },
      newId(),
    );
    const query = `{ orderAdmin(ref: "${placed.order.ref}") { id payment { state stateLabel methodLabel status ref amount { amount formatted } refundsInFlight { amount } captures { status amount { amount } } attempts { attemptNo status statusLabel } providerCalls { operation outcome } method { kind brand label } }
      refunds { status origin steps currentStep amount { formatted } items { title } history { label actor { kind } } }
      refundable { captured { amount } inFlight { amount } remaining { amount } items { sellerName remaining { amount } } }
      paymentDisputes { ref kind status evidenceDue { state } sellerName } } }`;
    const res = await h.app.inject({ method: 'POST', url: '/graphql/admin', headers: { authorization: `Bearer ${staff()}`, 'content-type': 'application/json' }, payload: { query } });
    const body = res.json();
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
    const o = body.data.orderAdmin;
    expect(o.payment).toMatchObject({ state: 'ACCEPTED', stateLabel: 'Accepted', status: 'CAPTURED', amount: { amount: 60000, formatted: '$600.00' }, refundsInFlight: { amount: 2000 }, method: { kind: 'CARD', brand: 'visa' } });
    expect(o.payment.captures).toEqual([{ status: 'SUCCEEDED', amount: { amount: 60000 } }]);
    expect(o.payment.attempts).toEqual([{ attemptNo: 1, status: 'CAPTURED', statusLabel: 'Captured' }]);
    expect(o.refunds[0]).toMatchObject({ status: 'REQUESTED', origin: 'RETURN', steps: ['Requested', 'Processing', 'Sent'], currentStep: 0, amount: { formatted: '$20.00' } });
    expect(o.refundable).toMatchObject({ captured: { amount: 60000 }, inFlight: { amount: 2000 }, remaining: { amount: 58000 } });
    expect(o.paymentDisputes).toEqual([expect.objectContaining({ kind: 'CHARGEBACK', status: 'OPENED', evidenceDue: { state: 'ON_TIME' }, sellerName: 'Casa Verde Home' })]);

    // Customer.paymentMethods: only the signed-in customer's own record (resolver called with a store context)
    await h.call('POST', '/api/store/payments/methods', tokens.customer(customerId), { setupToken: 'seti_visa_4242' });
    const field = resolvers(h.service).Customer!.paymentMethods!;
    const ctx = (accountId: string) => ({ principal: { kind: 'customer', accountId }, customerId: async () => accountId }) as never;
    expect(await field({ id: customerId }, {}, ctx(customerId), {} as never)).toEqual([expect.objectContaining({ kind: 'CARD', label: 'Visa •••• 4242', isDefault: true })]);
    expect(await field({ id: customerId }, {}, ctx(newId()), {} as never)).toEqual([]);
  });
});

void idem;
