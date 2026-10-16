/**
 * Holds, adjustments, amounts owed and write-offs: authority comes from access (allowed, approval required,
 * denied), approval-required records stay pending and finish on access.approval.decided; chargebacks, dispute
 * cases, suspensions and the new-seller rule place and settle holds by themselves.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, expectLedgerMatches, SELLER, USD, type Kit } from './helpers.js';

const DAY = 86_400_000;
let k: Kit;
const today = () => k.svc.core.today();
const plusDays = (n: number) => new Date(Date.parse(`${today()}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const idem = () => ({ 'idempotency-key': newId() });

async function credit(sellerId: string, amount: number) {
  const r = await k.call('POST', `${ADMIN}/adjustments`, k.staff, { sellerId, direction: 'credit', amount: USD(amount), reasonCode: 'goodwill', reason: 'Opening balance for the test' }, idem());
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});
beforeEach(() => {
  k.authority.clear();
});

describe('holds', () => {
  const S = newId();
  let holdId: string;

  it('places a hold within the caller limit: available moves to held, the balance stays the same', async () => {
    await credit(S, 50_000);
    const res = await k.call('POST', `${ADMIN}/holds`, k.staff, { sellerId: S, amount: USD(17_259), reasonCode: 'delivery_unconfirmed', reason: 'Carrier shows no delivery scan', reviewDate: plusDays(4), reference: { kind: 'order', id: newId(), ref: 'MK-261003-07712' } }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    holdId = res.body.id;
    expect(res.body).toMatchObject({ status: 'active', amount: USD(17_259), releasedAmount: USD(0), reasonCode: 'delivery_unconfirmed' });
    expect(await expectLedgerMatches(k, S)).toEqual({ total: 50_000, pending: 0, held: 17_259, available: 32_741 });
    expect(k.of('finance.hold.placed').at(-1)).toMatchObject({ holdId, sellerId: S, amount: USD(17_259), reviewDate: plusDays(4) });
    expect(k.audits.some((a) => a.action === 'finance.hold.place' && a.target.id === holdId)).toBe(true);
    const bal = await k.call('GET', `${SELLER}/balances`, k.sellerToken(S));
    expect(bal.body.holds).toEqual([expect.objectContaining({ id: holdId, reason: 'Carrier shows no delivery scan', reviewDate: plusDays(4) })]);
  });

  it('refuses a review date in the past and an unknown hold', async () => {
    const res = await k.call('POST', `${ADMIN}/holds`, k.staff, { sellerId: S, amount: USD(100), reasonCode: 'other', reason: 'x', reviewDate: plusDays(-3) }, idem());
    expect(res.status).toBe(400);
    expect((await k.call('POST', `${ADMIN}/holds/${newId()}/release`, k.staff, { reason: 'x' }, idem())).status).toBe(404);
  });

  it('extends, releases in part and then in full; a released hold cannot change', async () => {
    const ext = await k.call('POST', `${ADMIN}/holds/${holdId}/extend`, k.staff, { reviewDate: plusDays(10), reason: 'Waiting for the carrier' });
    expect(ext.body.reviewDate).toBe(plusDays(10));
    const part = await k.call('POST', `${ADMIN}/holds/${holdId}/release`, k.staff, { amount: USD(7_259), reason: 'Part delivered' }, idem());
    expect(part.body).toMatchObject({ status: 'active', releasedAmount: USD(7_259) });
    expect((await expectLedgerMatches(k, S)).held).toBe(10_000);
    const rest = await k.call('POST', `${ADMIN}/holds/${holdId}/release`, k.staff, { reason: 'Delivery confirmed' }, idem());
    expect(rest.body).toMatchObject({ status: 'released', releasedAmount: USD(17_259), releaseReason: 'Delivery confirmed' });
    expect(k.of('finance.hold.released').filter((e) => e.holdId === holdId).map((e) => e.amount.amount)).toEqual([7_259, 10_000]);
    expect(await expectLedgerMatches(k, S)).toMatchObject({ held: 0, available: 50_000 });
    const again = await k.call('POST', `${ADMIN}/holds/${holdId}/release`, k.staff, { reason: 'again' }, idem());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await k.call('POST', `${ADMIN}/holds/${holdId}/extend`, k.staff, { reviewDate: plusDays(20), reason: 'x' })).status).toBe(409);
  });

  it('applies a hold as a deduction with a reason (released rest goes back to available)', async () => {
    const h = await k.call('POST', `${ADMIN}/holds`, k.staff, { sellerId: S, amount: USD(5_000), reasonCode: 'risk_review', reason: 'Risk review', reviewDate: plusDays(7) }, idem());
    const applied = await k.call('POST', `${ADMIN}/holds/${h.body.id}/apply`, k.staff, { amount: USD(3_000), reason: 'Confirmed duplicate shipment' }, idem());
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ status: 'applied', releasedAmount: USD(2_000) });
    expect(await expectLedgerMatches(k, S)).toEqual({ total: 47_000, pending: 0, held: 0, available: 47_000 });
    expect(k.of('finance.adjustment.recorded').some((e) => e.sellerId === S && e.direction === 'debit' && e.amount.amount === 3_000)).toBe(true);
  });

  it('above the hold limit: the hold waits for approval and holds nothing until it is approved', async () => {
    k.authority.set('finance.holds.place', 'approval_required');
    const res = await k.call('POST', `${ADMIN}/holds`, k.staff, { sellerId: S, amount: USD(40_000), reasonCode: 'unusual_refund_rate', reason: 'Refund rate above 12%', reviewDate: plusDays(14) }, idem());
    // saved waiting for approval: 201 with approval in the body (FORMAT.md, Approval responses)
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ amount: USD(40_000), approval: { required: true, approvalRequestId: expect.any(String) } });
    const { id: pendingId, approval: { approvalRequestId } } = res.body;
    expect((await expectLedgerMatches(k, S)).held).toBe(0);
    const listed = await k.call('GET', `${ADMIN}/holds?sellerId=${S}&status=active`, k.staff);
    expect(listed.body.items.find((h: any) => h.id === pendingId).approval).toMatchObject({ required: true, approvalRequestId });
    await k.decide(approvalRequestId, 'approved');
    expect((await expectLedgerMatches(k, S)).held).toBe(40_000);
    expect(k.of('finance.hold.placed').some((e) => e.holdId === pendingId)).toBe(true);

    k.authority.set('finance.holds.release', 'approval_required');
    const rel = await k.call('POST', `${ADMIN}/holds/${pendingId}/release`, k.staff, { amount: USD(15_000), reason: 'Rate back to normal' }, idem());
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    expect(rel.body.approval).toMatchObject({ required: true, approvalRequestId: expect.any(String) });
    expect((await expectLedgerMatches(k, S)).held).toBe(40_000);
    await k.decide(rel.body.approval.approvalRequestId, 'approved');
    expect((await expectLedgerMatches(k, S)).held).toBe(25_000);
  });

  it('a rejected hold request never holds money', async () => {
    k.authority.set('finance.holds.place', 'approval_required');
    const res = await k.call('POST', `${ADMIN}/holds`, k.staff, { sellerId: S, amount: USD(1_000), reasonCode: 'other', reason: 'Check', reviewDate: plusDays(2) }, idem());
    await k.decide(res.body.approval.approvalRequestId, 'rejected');
    const h = await k.svc.core.repo.get('holds', res.body.id);
    expect(h?.status).toBe('released');
    expect((await expectLedgerMatches(k, S)).held).toBe(25_000);
  });

  it('a trust hold waiting for approval keeps its trust report: finance.hold.placed carries trustReportId once approved', async () => {
    const T = newId();
    await credit(T, 9_000);
    const trustReportId = newId();
    k.authority.set('finance.holds.place', 'approval_required');
    const res = await k.call('POST', `${ADMIN}/holds`, k.staff, { sellerId: T, amount: USD(7_500), reasonCode: 'risk_review', reason: 'Trust recommendation', reviewDate: plusDays(10), trustReportId }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await k.svc.core.repo.get('holds', res.body.id))?.trust_report_id).toBe(trustReportId);
    expect(k.of('finance.hold.placed').filter((e) => e.holdId === res.body.id)).toEqual([]);
    await k.decide(res.body.approval.approvalRequestId, 'approved');
    expect(k.of('finance.hold.placed').filter((e) => e.holdId === res.body.id)).toEqual([
      { holdId: res.body.id, sellerId: T, amount: USD(7_500), reasonCode: 'risk_review', reason: 'Trust recommendation', reviewDate: plusDays(10), trustReportId },
    ]);
    expect(await expectLedgerMatches(k, T)).toMatchObject({ total: 9_000, held: 7_500, available: 1_500 });
    k.authority.delete('finance.holds.place');
  });

  it('access is not financial authority: a denied caller cannot hold money', async () => {
    k.authority.set('finance.holds.place', 'denied');
    const res = await k.call('POST', `${ADMIN}/holds`, k.staff, { sellerId: S, amount: USD(1_000), reasonCode: 'other', reason: 'x', reviewDate: plusDays(2) }, idem());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('staff need finance.holds.manage; sellers only see their own holds', async () => {
    const { callers } = await import('../../../testing/app.js');
    expect((await k.call('POST', `${ADMIN}/holds`, callers.staff(['finance.ledger.view']), { sellerId: S, amount: USD(1), reasonCode: 'other', reason: 'x', reviewDate: plusDays(2) }, idem())).status).toBe(403);
    const other = await k.call('GET', `${SELLER}/balances`, k.sellerToken(newId()));
    expect(other.body.holds).toEqual([]);
  });
});

describe('adjustments', () => {
  const S = newId();

  it('records within the limit at once and posts it to the ledger', async () => {
    const res = await credit(S, 2_000);
    expect(res).toMatchObject({ status: 'recorded', direction: 'credit', amount: USD(2_000), reasonCode: 'goodwill' });
    expect(res.ref).toMatch(/^ADJ-\d{6}-\d{4}$/);
    const debit = await k.call('POST', `${ADMIN}/adjustments`, k.staff, { sellerId: S, direction: 'debit', amount: USD(500), reasonCode: 'late_dispatch_penalty', reason: 'Dispatched 2 days late' }, idem());
    expect(debit.status).toBe(201);
    expect(await expectLedgerMatches(k, S)).toMatchObject({ total: 1_500, available: 1_500 });
    expect(k.of('finance.adjustment.recorded').filter((e) => e.sellerId === S)).toHaveLength(2);
  });

  it('above the threshold waits for a second Finance reviewer and posts only when approved', async () => {
    k.authority.set('finance.adjustments.record', 'approval_required');
    const res = await k.call('POST', `${ADMIN}/adjustments`, k.staff, { sellerId: S, direction: 'credit', amount: USD(80_000), reasonCode: 'carrier_claim', reason: 'Pallet lost by the carrier' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending_approval', amount: USD(80_000), approval: { required: true, approvalRequestId: expect.any(String) } });
    const list = await k.call('GET', `${ADMIN}/adjustments?sellerId=${S}`, k.staff);
    expect(list.body.items[0]).toMatchObject({ status: 'pending_approval', approval: { required: true } });
    expect((await expectLedgerMatches(k, S)).total).toBe(1_500);
    await k.decide(res.body.approval.approvalRequestId, 'approved');
    expect((await expectLedgerMatches(k, S)).total).toBe(81_500);
    const second = await k.call('POST', `${ADMIN}/adjustments`, k.staff, { sellerId: S, direction: 'debit', amount: USD(90_000), reasonCode: 'other', reason: 'Too much' }, idem());
    await k.decide(second.body.approval.approvalRequestId, 'rejected');
    const rejected = await k.svc.core.repo.get('adjustments', second.body.id);
    expect(rejected?.status).toBe('rejected');
    expect((await expectLedgerMatches(k, S)).total).toBe(81_500);
  });

  it('replays the same Idempotency-Key without posting twice', async () => {
    const key = newId();
    const body = { sellerId: S, direction: 'credit', amount: USD(100), reasonCode: 'duplicate_charge', reason: 'Label billed twice' };
    const a = await k.call('POST', `${ADMIN}/adjustments`, k.staff, body, { 'idempotency-key': key });
    const b = await k.call('POST', `${ADMIN}/adjustments`, k.staff, body, { 'idempotency-key': key });
    expect(b.body.id).toBe(a.body.id);
    expect((await expectLedgerMatches(k, S)).total).toBe(81_600);
  });
});

describe('amounts owed and write-offs', () => {
  const S = newId();

  it('settles a payment from the seller and writes off the rest with a second reviewer', async () => {
    await credit(S, 1_000);
    const debit = await k.call('POST', `${ADMIN}/adjustments`, k.staff, { sellerId: S, direction: 'debit', amount: USD(9_000), reasonCode: 'other', reason: 'Refunds after payout' }, idem());
    expect(debit.status).toBe(201);
    k.clock.advance(31 * DAY);
    await k.svc.negativeBalanceAge();
    await k.app.kernel.events.drain();
    const owed = (await k.call('GET', `${ADMIN}/amounts-owed?sellerId=${S}&status=open`, k.staff)).body.items[0];
    expect(owed).toMatchObject({ amount: USD(8_000), remaining: USD(8_000) });
    const paid = await k.call('POST', `${ADMIN}/amounts-owed/${owed.id}/settle`, k.staff, { method: 'seller_paid', amount: USD(3_000), reason: 'Bank transfer received' }, idem());
    expect(paid.body).toMatchObject({ status: 'open', remaining: USD(5_000) });
    expect((await expectLedgerMatches(k, S)).available).toBe(-5_000);
    k.authority.set('finance.writeoffs.approve', 'approval_required');
    const wo = await k.call('POST', `${ADMIN}/amounts-owed/${owed.id}/settle`, k.staff, { method: 'written_off', amount: USD(5_000), reason: 'Seller closed, not recoverable' }, idem());
    // saved pending on the record: 200 with the approval (FORMAT.md, Approval responses)
    expect(wo.status, JSON.stringify(wo.body)).toBe(200);
    expect(wo.body).toMatchObject({ status: 'open', remaining: USD(5_000), pendingWriteOff: USD(5_000), approval: { required: true, approvalRequestId: expect.any(String) } });
    // a second write-off while one waits is refused; nothing else changed
    const again = await k.call('POST', `${ADMIN}/amounts-owed/${owed.id}/settle`, k.staff, { method: 'written_off', amount: USD(1_000), reason: 'Again' }, idem());
    expect(again.body.error?.code).toBe('CONFLICT');
    await k.decide(wo.body.approval.approvalRequestId, 'approved');
    const after = await k.call('GET', `${ADMIN}/amounts-owed?sellerId=${S}`, k.staff);
    expect(after.body.items[0]).toMatchObject({ status: 'written_off', remaining: USD(0), pendingWriteOff: null, approval: null });
    // a seller's debt written off is a platform cost, never Official Store trading
    expect(await k.svc.core.repo.find('platform_costs', { kind: 'write_off', ref_id: owed.id })).toEqual([expect.objectContaining({ amount: 5_000, ref_kind: 'amount_owed' })]);
    expect(await k.svc.core.repo.find('trading_entries', { ref_id: owed.id })).toEqual([]);
    expect(await expectLedgerMatches(k, S)).toMatchObject({ available: 0 });
    const tooMuch = await k.call('POST', `${ADMIN}/amounts-owed/${owed.id}/settle`, k.staff, { method: 'seller_paid', amount: USD(1), reason: 'x' }, idem());
    expect(tooMuch.status).toBe(409);
  });
});

describe('rule-based holds', () => {
  it('holds a seller amount while a chargeback is open, keeps the fee, and applies it when the dispute is lost', async () => {
    const S = newId();
    const ord = k.order(S, [{ title: 'Speaker', quantity: 1, price: 20_000 }]);
    await k.accept(ord);
    await credit(S, 30_000);
    const disputeId = newId();
    const opened = { disputeId, ref: 'CB-261009-0001', kind: 'chargeback', orderId: ord.id, groupId: ord.groups[0]!.id, sellerId: S, amount: USD(20_000), evidenceDueAt: new Date(k.clock.now().getTime() + 10 * DAY).toISOString() };
    await k.emit('payments.chargeback.opened', opened);
    await k.emit('payments.chargeback.opened', opened);
    expect((await expectLedgerMatches(k, S)).held).toBe(20_000);
    expect((await k.svc.core.repo.findOne('fee_charges', { order_item_id: ord.groups[0]!.items[0]!.id }))?.status).toBe('kept_disputed');
    const holds = await k.svc.holdsForReference([{ kind: 'chargeback', id: disputeId }]);
    expect(holds).toEqual([expect.objectContaining({ reasonCode: 'chargeback', status: 'active' })]);
    await k.emit('payments.chargeback.decided', { disputeId, orderId: ord.id, sellerId: S, outcome: 'lost', amount: USD(20_000) });
    const t = await expectLedgerMatches(k, S);
    expect(t.held).toBe(0);
    expect((await k.svc.core.repo.findOne('ledger_entries', { seller_id: S, type: 'chargeback' }))?.amount).toBe(-20_000);
  });

  it('releases the chargeback hold when the dispute is won', async () => {
    const S = newId();
    await credit(S, 10_000);
    const disputeId = newId();
    await k.emit('payments.chargeback.opened', { disputeId, ref: 'CB-2', kind: 'chargeback', orderId: newId(), groupId: null, sellerId: S, amount: USD(4_000), evidenceDueAt: null });
    await k.emit('payments.chargeback.decided', { disputeId, orderId: newId(), sellerId: S, outcome: 'won', amount: USD(4_000) });
    expect(await expectLedgerMatches(k, S)).toMatchObject({ held: 0, available: 10_000 });
  });

  it('records a lost Official Store chargeback as a company trading loss', async () => {
    await k.emit('payments.chargeback.decided', { disputeId: newId(), orderId: newId(), sellerId: null, outcome: 'lost', amount: USD(7_700) });
    const tr = await k.call('GET', `${ADMIN}/trading?from=${today()}&to=${today()}`, k.staff);
    expect(tr.body.chargebackLosses.amount).toBeGreaterThanOrEqual(7_700);
  });

  it('settles dispute holds of a case when the case is finally decided', async () => {
    const S = newId();
    await credit(S, 10_000);
    const caseId = newId();
    const res = await k.call('POST', `${ADMIN}/holds`, k.staff, { sellerId: S, amount: USD(6_000), reasonCode: 'dispute', reason: 'Item not as described', reviewDate: plusDays(5), reference: { kind: 'case', id: caseId, ref: 'CS-1' } }, idem());
    expect(res.status).toBe(201);
    await k.emit('support.case.decided', { caseId, ref: 'CS-1', outcome: 'customer_favored', orderId: newId(), returnId: null, sellerId: S, remedies: [{ id: newId(), kind: 'goodwill_credit', amount: USD(1_500), chargedTo: 'seller', orderItemIds: [], status: 'approved', statusLabel: 'Approved', track: [] }], appealDeadline: null, final: true, notified: true });
    const h = await k.svc.core.repo.get('holds', res.body.id);
    expect(h).toMatchObject({ status: 'applied', released_amount: 4_500 });
    expect(await expectLedgerMatches(k, S)).toMatchObject({ held: 0, total: 8_500 });
  });

  it('suspension puts pending payouts and the available balance on hold with reason restriction', async () => {
    const S = newId();
    await credit(S, 12_000);
    await k.emit('sellers.seller.suspended', { sellerId: S, suspensionId: newId(), reasonCode: 'counterfeit', reason: 'Counterfeit listings', reviewDate: plusDays(30), openOrders: 'seller_keeps_fulfilling', appealDeadline: new Date(k.clock.now().getTime() + 14 * DAY).toISOString(), trustReportId: null });
    expect(await expectLedgerMatches(k, S)).toMatchObject({ held: 12_000, available: 0 });
    const block = await k.svc.hasPayoutBlock(S);
    expect(block.blocked).toBe(true);
    expect(block.reasons.join(' ')).toContain('Account suspended');
  });

  it('applies the new-seller rule: earnings become available later during the first days', async () => {
    const S = newId();
    await k.emit('sellers.seller.approved', { sellerId: S, applicationId: newId(), storeName: 'New Store', ownerAccountId: newId(), categoryIds: [], returnAddress: { name: 'New Store', line1: '1 Main St', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US' }, returnContact: 'Ana', recommendedHoldDays: null });
    const ord = k.order(S, [{ title: 'Lamp', quantity: 1, price: 5_000 }]);
    await k.accept(ord);
    await k.deliver(ord);
    const lot = await k.svc.core.repo.findOne('earnings_lots', { order_item_id: ord.groups[0]!.items[0]!.id });
    expect(Math.round((lot!.available_at!.getTime() - lot!.delivered_at!.getTime()) / DAY)).toBe(7 + 14);
    // the period is on the seller account and in the settlement rules, not a zero-amount hold
    expect((await k.call('GET', `${ADMIN}/holds?sellerId=${S}`, k.staff)).body.items).toEqual([]);
    const acct = await k.svc.core.repo.findOne('seller_accounts', { seller_id: S });
    expect(acct).toMatchObject({ new_seller_until: plusDays(30), new_seller_extra_days: 14 });
    const balances = await k.svc.getSellerBalances(S);
    expect(balances.settlementRules).toMatchObject({ newSellerHoldDays: 14, newSellerUntil: acct!.new_seller_until });
    // the first statement is open from approval
    expect(await k.svc.core.repo.findOne('statements', { seller_id: S, status: 'open' })).toBeTruthy();
    // after the period, deliveries use the normal window and the rules no longer show it
    k.clock.advance(31 * DAY);
    const later = k.order(S, [{ title: 'Lamp', quantity: 1, price: 5_000 }]);
    await k.accept(later);
    await k.deliver(later);
    const lot2 = await k.svc.core.repo.findOne('earnings_lots', { order_item_id: later.groups[0]!.items[0]!.id });
    expect(Math.round((lot2!.available_at!.getTime() - lot2!.delivered_at!.getTime()) / DAY)).toBe(7);
    expect((await k.svc.getSellerBalances(S)).settlementRules).toMatchObject({ newSellerHoldDays: null, newSellerUntil: null });
  });

  it('balancesForSellers answers every seller as getSellerBalances does, in one batch', async () => {
    // B owes money (a debit past its balance, aged into an amount owed)
    const [A, B, C, D] = [newId(), newId(), newId(), newId()];
    await credit(B, 1_000);
    expect((await k.call('POST', `${ADMIN}/adjustments`, k.staff, { sellerId: B, direction: 'debit', amount: USD(9_000), reasonCode: 'other', reason: 'Refunds after payout' }, idem())).status).toBe(201);
    k.clock.advance(31 * DAY);
    await k.svc.negativeBalanceAge();
    await k.app.kernel.events.drain();
    // A: a delivered sale this period, a credit and a hold; C: nothing at all; D: closed, so its final statement is issued
    const ord = k.order(A, [{ title: 'Lamp', quantity: 2, price: 5_000 }]);
    await k.accept(ord);
    await k.deliver(ord);
    await credit(A, 3_000);
    expect((await k.call('POST', `${ADMIN}/holds`, k.staff, { sellerId: A, amount: USD(1_000), reasonCode: 'other', reason: 'Checking a claim', reviewDate: plusDays(5) }, idem())).status).toBe(201);
    await credit(D, 2_000);
    await k.emit('sellers.seller.closed', { sellerId: D, reasonCode: 'seller_request', closedBy: { kind: 'system', id: null } });
    expect(await k.svc.core.repo.findOne('statements', { seller_id: D, status: 'issued' })).toBeTruthy();

    const batch = await k.svc.balancesForSellers([A, B, C, D, 'not-a-seller', A]);
    expect([...batch.keys()]).toEqual([A, B, C, D]);
    // asOf is the time of each answer (the test clock runs on)
    for (const id of [A, B, C, D]) expect({ ...batch.get(id), asOf: null }).toEqual({ ...(await k.svc.getSellerBalances(id)), asOf: null });
    expect(batch.get(A)).toMatchObject({ salesProceeds: USD(10_000), held: USD(1_000), holds: [expect.objectContaining({ reason: 'Checking a claim' })] });
    expect(batch.get(B)).toMatchObject({ negative: true, amountOwed: USD(8_000) });
    expect(batch.get(C)).toMatchObject({ salesProceeds: USD(0), pending: USD(0), available: USD(0), held: USD(0), holds: [], amountOwed: null, nextPayout: null });
    expect(await k.svc.balancesForSellers([])).toEqual(new Map());
  });

  it('lists holds due for review in Finance\'s queue', async () => {
    k.clock.advance(40 * DAY);
    await k.app.kernel.jobs.runNow('finance.holds.review-due');
    const overdue = await k.call('GET', `${ADMIN}/holds?reviewDue=overdue&status=active`, k.staff);
    expect(overdue.status).toBe(200);
    expect(overdue.body.items.every((h: any) => h.reviewDate < today())).toBe(true);
  });
});
