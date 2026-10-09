/**
 * Staff credit: goodwill within approval limits and the per-customer 30-day limit, approvals decided in access,
 * reversal of unused goodwill, balance corrections, and the admin views.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, idem, USD, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.authority = {};
  h.finance.value = false;
});

const ADMIN = '/api/admin/wallet';
const STAFF_ID = newId();
const agent = () => h.staff(['wallet.goodwill.grant', 'wallet.credit.view']);
const finance = () => h.staff(['wallet.credit.correct', 'wallet.credit.view']);
const goodwill = (customerId: string, amount: number, extra: Record<string, unknown> = {}) => ({ customerId, amount: USD(amount), reason: 'Parcel arrived a week late', reasonCode: 'late_delivery', chargedTo: 'platform', ...extra });

describe('goodwill credit', () => {
  it('grants within the staff limit at once: lot with expiry, ledger entry, event for finance, audit entry', async () => {
    const c = h.customer();
    const sellerId = newId();
    const orderId = newId();
    h.orderRefs.set(orderId, 'MK-261009-40004');
    const key = idem();
    const res = await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 2500, { chargedTo: 'seller', sellerId, orderId, expiresInDays: 90 }), key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ customerId: c.id, customerName: 'Ana Lopez', amount: USD(2500), state: 'granted', chargedTo: 'seller', sellerId, orderRef: 'MK-261009-40004', approval: null, requestedBy: { kind: 'staff' }, decidedBy: { kind: 'staff' } });
    expect(res.body.grantedAt).toBeTruthy();
    // a retry with the same key is the same grant
    const again = await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 2500, { chargedTo: 'seller', sellerId, orderId, expiresInDays: 90 }), key);
    expect(again.body.id).toBe(res.body.id);
    expect(h.named('wallet.credit.granted').filter((e) => e.customerId === c.id)).toEqual([{ customerId: c.id, entryId: res.body.ledgerEntryId, kind: 'goodwill', amount: USD(2500), chargedTo: 'seller', sellerId, caseId: null, orderId }]);
    expect(h.audits.find((a) => a.action === 'wallet.goodwill.grant' && a.target.id === res.body.id)).toMatchObject({ category: 'financial', reason: 'Parcel arrived a week late', approvalNote: 'Within your $50.00 limit' });
    const w = await h.call('GET', `/api/store/wallet/credit`, c.token);
    expect(w.body.lots[0]).toMatchObject({ source: 'goodwill', remaining: USD(2500), reference: 'order MK-261009-40004' });
    expect(new Date(w.body.lots[0].expiresAt).getTime()).toBeGreaterThan(h.clock.now().getTime() + 89 * 86_400_000);
    expect(w.body.recent[0].label).toBe('Goodwill credit · order MK-261009-40004, late delivery');
  });

  it('a price adjustment is its own kind of credit', async () => {
    const c = h.customer();
    const res = await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 700, { reasonCode: 'price_adjustment', reason: 'Price dropped two days after purchase' }), idem());
    expect(res.status).toBe(201);
    const entries = await h.call('GET', `${ADMIN}/customers/${c.id}/entries`, agent());
    expect(entries.body.items[0]).toMatchObject({ kind: 'price_adjustment', amount: USD(700), label: 'Price adjustment', actor: { kind: 'staff' }, reason: 'Price dropped two days after purchase' });
  });

  it('above the staff limit waits for approval (APPROVAL_REQUIRED), then access decides', async () => {
    const c = h.customer();
    h.authority['wallet.goodwill.grant'] = 'approval_required';
    const res = await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 8000), idem());
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { approvalRequestId: expect.any(String), grantId: expect.any(String) } });
    const { approvalRequestId, grantId } = res.body.error.details;
    expect(h.approvals.find((a) => a.id === approvalRequestId)).toMatchObject({ action: 'wallet.goodwill.grant', target: { type: 'goodwill_grant', id: grantId }, amount: USD(8000) });
    expect((await h.service.getBalance(c.id)).available).toEqual(USD(0));

    const view = await h.call('GET', `${ADMIN}/customers/${c.id}`, agent());
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ goodwillLast30Days: USD(8000), goodwillLimitPerCustomer: USD(10000), pendingGrants: [{ id: grantId, state: 'pending_approval', approval: { approvalRequestId, required: true } }] });
    const pending = await h.call('GET', `${ADMIN}/goodwill?state=pending_approval`, agent());
    expect(pending.body.items.map((g: { id: string }) => g.id)).toContain(grantId);

    await h.decide(approvalRequestId, 'approved');
    await h.decide(approvalRequestId, 'approved'); // delivered twice: credited once
    expect((await h.service.getBalance(c.id)).available).toEqual(USD(8000));
    const granted = await h.call('GET', `${ADMIN}/goodwill?state=granted`, agent());
    expect(granted.body.items.find((g: { id: string }) => g.id === grantId)).toMatchObject({ decidedBy: { name: 'Fiona Finance' }, ledgerEntryId: expect.any(String) });
    expect(h.named('wallet.credit.granted').filter((e) => e.customerId === c.id)).toEqual([expect.objectContaining({ kind: 'goodwill', chargedTo: 'platform' })]);
    // support learns the decision of a grant that waited (once, even though access delivered twice)
    expect(h.named('wallet.goodwill.decided').filter((e) => e.customerId === c.id)).toEqual([{ grantId, customerId: c.id, status: 'granted', amount: USD(8000), caseId: null }]);
  });

  it('in-process (support) keeps the pending grant instead of an error; a rejection closes it', async () => {
    const c = h.customer();
    h.authority['wallet.goodwill.grant'] = 'approval_required';
    const caseId = newId();
    const grant = await h.service.grantGoodwill({ customerId: c.id, amount: USD(6000), reason: 'Case decision', reasonCode: 'service_failure', caseId, chargedTo: 'platform' }, { kind: 'staff', id: STAFF_ID }, `case:${caseId}:goodwill:0:6000`);
    expect(grant).toMatchObject({ state: 'pending_approval', approval: { required: true } });
    const same = await h.service.grantGoodwill({ customerId: c.id, amount: USD(6000), reason: 'Case decision', reasonCode: 'service_failure', caseId, chargedTo: 'platform' }, { kind: 'staff', id: STAFF_ID }, `case:${caseId}:goodwill:0:6000`);
    expect(same.id).toBe(grant.id);
    await h.decide(grant.approval!.approvalRequestId!, 'rejected');
    await h.decide(grant.approval!.approvalRequestId!, 'rejected'); // delivered twice
    const list = await h.call('GET', `${ADMIN}/goodwill?state=rejected`, agent());
    expect(list.body.items.find((g: { id: string }) => g.id === grant.id)).toMatchObject({ state: 'rejected' });
    expect((await h.service.getBalance(c.id)).available).toEqual(USD(0));
    expect(h.named('wallet.goodwill.decided').filter((e) => e.grantId === grant.id)).toEqual([{ grantId: grant.id, customerId: c.id, status: 'rejected', amount: USD(6000), caseId }]);
    expect(h.named('wallet.credit.granted').filter((e) => e.customerId === c.id)).toEqual([]);
  });

  it("keeps each customer's goodwill within 30-day limit; only Finance may grant beyond it", async () => {
    const c = h.customer();
    expect((await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 9000), idem())).status).toBe(201);
    const over = await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 1500), idem());
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({ code: 'GOODWILL_LIMIT_EXCEEDED', details: { goodwillLast30Days: USD(9000), limit: USD(10000), remaining: USD(1000) } });
    h.finance.value = true;
    expect((await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 1500), idem())).status).toBe(201);
    // the window moves on
    h.finance.value = false;
    h.clock.advance(31 * 86_400_000);
    expect((await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 1500), idem())).status).toBe(201);
  });

  it('refuses callers without authority, unknown customers and incomplete grants', async () => {
    const c = h.customer();
    h.authority['wallet.goodwill.grant'] = 'denied';
    const denied = await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 100), idem());
    expect(denied.status).toBe(403);
    expect(denied.body.error.details).toEqual({ action: 'wallet.goodwill.grant' });
    h.authority = {};
    expect((await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(newId(), 100), idem())).status).toBe(404);
    const bad = await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 0, { chargedTo: 'seller', reason: ' ' }), idem());
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect(bad.body.error.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(['amount', 'reason', 'sellerId']);
    expect((await h.call('POST', `${ADMIN}/goodwill`, h.staff(['wallet.credit.view']), goodwill(c.id, 100), idem())).status).toBe(403);
  });
});

describe('reversing goodwill', () => {
  it('reverses unused goodwill; used or pending goodwill cannot be reversed', async () => {
    const c = h.customer();
    const g = (await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 1200), idem())).body;
    const reversed = await h.call('POST', `${ADMIN}/goodwill/${g.id}/reverse`, finance(), { reason: 'Granted to the wrong customer' }, idem());
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(reversed.body.state).toBe('reversed');
    expect((await h.service.getBalance(c.id)).available).toEqual(USD(0));
    expect(h.named('wallet.credit.reversed')).toContainEqual({ customerId: c.id, grantId: g.id, amount: USD(1200), reason: 'Granted to the wrong customer' });
    expect(h.audits.find((a) => a.action === 'wallet.goodwill.reverse' && a.target.id === g.id)).toBeTruthy();
    const twice = await h.call('POST', `${ADMIN}/goodwill/${g.id}/reverse`, finance(), { reason: 'Again' }, idem());
    expect(twice.body.error.code).toBe('ILLEGAL_TRANSITION');

    const used = (await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 1000), idem())).body;
    await h.service.holdCredit(c.id, newId(), USD(300), newId());
    const refused = await h.call('POST', `${ADMIN}/goodwill/${used.id}/reverse`, finance(), { reason: 'Mistake' }, idem());
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'CREDIT_ALREADY_USED', details: { used: USD(300) } });

    h.authority['wallet.goodwill.grant'] = 'approval_required';
    const pending = (await h.call('POST', `${ADMIN}/goodwill`, agent(), goodwill(c.id, 500), idem())).body.error.details.grantId;
    expect((await h.call('POST', `${ADMIN}/goodwill/${pending}/reverse`, finance(), { reason: 'x' }, idem())).body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await h.call('POST', `${ADMIN}/goodwill/${newId()}/reverse`, finance(), { reason: 'x' }, idem())).status).toBe(404);
    expect((await h.call('POST', `${ADMIN}/goodwill/${used.id}/reverse`, agent(), { reason: 'x' }, idem())).status).toBe(403);
  });
});

describe('balance corrections', () => {
  it('corrects up and down with a reason; never below zero', async () => {
    const c = h.customer();
    const up = await h.call('POST', `${ADMIN}/customers/${c.id}/corrections`, finance(), { amount: USD(1500), reason: 'Missed refund', reference: 'RC-1042' }, idem());
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).toMatchObject({ kind: 'correction', amount: USD(1500), balanceAfter: USD(1500), label: 'Balance correction', reason: 'Missed refund' });
    const down = await h.call('POST', `${ADMIN}/customers/${c.id}/corrections`, finance(), { amount: USD(-400), reason: 'Duplicate credit', reference: null }, idem());
    expect(down.status).toBe(201);
    expect(down.body).toMatchObject({ amount: USD(-400), balanceAfter: USD(1100) });
    const below = await h.call('POST', `${ADMIN}/customers/${c.id}/corrections`, finance(), { amount: USD(-1101), reason: 'Too much' }, idem());
    expect(below.body.error).toMatchObject({ code: 'INSUFFICIENT_CREDIT', details: { available: USD(1100) } });
    expect(h.named('wallet.credit.corrected').filter((e) => e.customerId === c.id).map((e) => e.amount)).toEqual([USD(1500), USD(-400)]);
    expect(h.audits.filter((a) => a.action === 'wallet.credit.correct' && a.target.id === c.id)).toHaveLength(2);
    expect((await h.call('POST', `${ADMIN}/customers/${c.id}/corrections`, finance(), { amount: USD(0), reason: 'x' }, idem())).body.error.code).toBe('VALIDATION_FAILED');
    expect((await h.call('POST', `${ADMIN}/customers/${newId()}/corrections`, finance(), { amount: USD(10), reason: 'x' }, idem())).status).toBe(404);
  });

  it('above the adjustment limit a second reviewer approves; the correction is applied on approval', async () => {
    const c = h.customer();
    h.authority['wallet.credit.correct'] = 'approval_required';
    const key = idem();
    const res = await h.call('POST', `${ADMIN}/customers/${c.id}/corrections`, finance(), { amount: USD(50000), reason: 'Migrated balance', reference: 'LEGACY-7' }, key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('APPROVAL_REQUIRED');
    expect((await h.service.getBalance(c.id)).available).toEqual(USD(0));
    await h.decide(res.body.error.details.approvalRequestId, 'approved');
    await h.decide(res.body.error.details.approvalRequestId, 'approved');
    expect((await h.service.getBalance(c.id)).available).toEqual(USD(50000));
    // the original request, retried after approval, answers with the applied entry
    h.authority = {};
    const retried = await h.call('POST', `${ADMIN}/customers/${c.id}/corrections`, finance(), { amount: USD(50000), reason: 'Migrated balance', reference: 'LEGACY-7' }, key);
    expect(retried.status).toBe(201);
    expect((await h.service.getBalance(c.id)).available).toEqual(USD(50000));
  });
});

describe('admin views', () => {
  it("shows a customer's wallet and ledger; unknown customers are not found", async () => {
    const c = h.customer();
    await h.give(c.id, 900);
    const w = await h.call('GET', `${ADMIN}/customers/${c.id}`, agent());
    expect(w.body).toMatchObject({ balance: { available: USD(900) }, lots: [expect.objectContaining({ source: 'refund' })], goodwillLast30Days: USD(0), pendingGrants: [] });
    expect((await h.call('GET', `${ADMIN}/customers/${newId()}`, agent())).status).toBe(404);
    expect((await h.call('GET', `${ADMIN}/customers/${newId()}/entries`, agent())).status).toBe(404);
    const refunds = await h.call('GET', `${ADMIN}/customers/${c.id}/entries?kind=refund_to_credit`, agent());
    expect(refunds.body.items).toHaveLength(1);
    expect((await h.call('GET', `${ADMIN}/customers/${c.id}/entries?kind=goodwill`, agent())).body.items).toHaveLength(0);
  });

  it('filters goodwill grants by state, dates and requester', async () => {
    const c = h.customer();
    const requester = newId();
    const token = h.staff(['wallet.goodwill.grant', 'wallet.credit.view']);
    await h.service.grantGoodwill(goodwill(c.id, 300) as never, { kind: 'staff', id: requester }, newId());
    const mine = await h.call('GET', `${ADMIN}/goodwill?requestedBy=${requester}`, token);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ requestedBy: { kind: 'staff', id: requester }, customerName: 'Ana Lopez' });
    const today = h.clock.now().toISOString().slice(0, 10);
    const dated = await h.call('GET', `${ADMIN}/goodwill?from=${today}&to=${today}&requestedBy=${requester}`, token);
    expect(dated.body.items).toHaveLength(1);
    expect((await h.call('GET', `${ADMIN}/goodwill?to=2020-01-01`, token)).body.items).toHaveLength(0);
  });
});
