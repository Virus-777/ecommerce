/**
 * Fee rule versions (Business Owner approval, scheduled activation), the fee calculator and published
 * schedule, company trading kept apart from marketplace income, the daily finance checks, the remaining
 * event consumers (labels, claims, coupons, wallet), ad charges, previews, exports and the GraphQL read layer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, callers } from '../../../testing/app.js';
import { ADMIN, boot, expectLedgerMatches, SELLER, USD, type Kit } from './helpers.js';

const DAY = 86_400_000;
let k: Kit;
const idem = () => ({ 'idempotency-key': newId() });
const today = () => k.svc.core.today();
const ELECTRONICS = newId();

beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});
beforeEach(() => {
  k.authority.clear();
});

describe('fee rules', () => {
  let proposedId: string;
  const ruleInput = (effectiveFrom: string) => ({
    basis: 'after_seller_discounts',
    includeShipping: false,
    platformDiscountsReduceFee: false,
    defaultRateBps: 1200,
    categoryRates: [{ categoryId: ELECTRONICS, categoryName: 'Electronics', rateBps: 800 }],
    treatment: { cancellationBeforeDispatch: 'no_fee', returns: 'fee_returned_pro_rata', paymentDisputes: 'fee_kept_returned_if_won', text: 'Plain rules' },
    agreementVersion: '2026-11',
    effectiveFrom,
    reason: 'Category rates for launch',
  });

  it('starts from the launch rules: 10% after seller discounts, shipping excluded', async () => {
    const res = await k.call('GET', `${ADMIN}/fee-rules`, k.staff);
    expect(res.status).toBe(200);
    expect(res.body.active).toMatchObject({ status: 'active', defaultRateBps: 1000, basis: 'after_seller_discounts', includeShipping: false });
    const pub = await k.call('GET', '/api/public/finance/fee-schedule', callers.visitor());
    expect(pub.status).toBe(200);
    expect(pub.body.illustration).toBe('$100.00 sale with a 10% fee: $10.00 fee income, $90.00 seller earnings');
  });

  it('refuses invalid rates', async () => {
    const res = await k.call('POST', `${ADMIN}/fee-rules`, k.staff, { ...ruleInput(new Date().toISOString()), defaultRateBps: 20_000 });
    expect(res.status).toBe(400);
  });

  it('a proposal waits for the Business Owner, then is scheduled and activated at its effective time', async () => {
    const res = await k.call('POST', `${ADMIN}/fee-rules`, k.staff, ruleInput(new Date(k.clock.now().getTime() + 2 * 3_600_000).toISOString()));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    proposedId = res.body.id;
    expect(res.body).toMatchObject({ status: 'pending_approval', version: 'v2', categoryRates: [{ categoryId: ELECTRONICS, categoryName: 'Electronics', rateBps: 800 }] });
    expect(k.of('finance.fee_rules.proposed')).toEqual([expect.objectContaining({ ruleSetId: proposedId })]);
    const approval = [...k.approvals.entries()].find(([, a]) => a.action === 'finance.fees.change')!;
    expect((await k.call('POST', `${ADMIN}/fee-rules/${proposedId}/withdraw`, k.staff, { reason: 'x' })).status).toBe(409);
    await k.decide(approval[0], 'approved');
    expect((await k.svc.core.repo.get('fee_rule_sets', proposedId))?.status).toBe('scheduled');
    const sched = await k.call('GET', `${SELLER}/fee-schedule`, k.sellerToken(newId()));
    expect(sched.body.scheduled).toMatchObject({ id: proposedId });
    await k.app.kernel.jobs.runNow('finance.fee-rules.activate');
    expect((await k.svc.core.repo.get('fee_rule_sets', proposedId))?.status).toBe('scheduled');
    k.clock.advance(3 * 3_600_000);
    await k.app.kernel.jobs.runNow('finance.fee-rules.activate');
    await k.app.kernel.events.drain();
    const admin = (await k.call('GET', `${ADMIN}/fee-rules`, k.staff)).body;
    expect(admin.active.id).toBe(proposedId);
    expect(admin.history.map((h: any) => h.status)).toContain('superseded');
    expect(k.of('finance.fee_rules.changed')).toEqual([expect.objectContaining({ ruleSetId: proposedId, version: 'v2' })]);
  });

  it('calculates fees with the category rate and explains the basis', async () => {
    const res = await k.call('POST', `${ADMIN}/fee-rules/calculate`, k.staff, { input: { categoryId: ELECTRONICS, itemPrice: USD(18_400), sellerDiscount: USD(400), shippingCharged: USD(699) } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ feeBasis: USD(18_000), rateBps: 800, fee: USD(1_440), sellerEarnings: USD(18_400 - 400 + 699 - 1_440), ruleVersion: 'v2' });
    const plain = await k.svc.calculateFee({ itemPrice: USD(10_000) });
    expect(plain).toMatchObject({ rateBps: 1200, fee: USD(1_200) });
    const preview = await k.svc.previewOfferEarnings([{ offerId: 'o1', sellerId: newId(), categoryId: ELECTRONICS, price: USD(18_400) }]);
    expect(preview.o1).toMatchObject({ fee: USD(1_472), earnings: USD(16_928) });
    expect(preview.o1!.exampleLabel).toBe('Example: at $184.00 you earn $169.28 after a $14.72 fee');
  });

  it('withdraws a draft returned by the Business Owner', async () => {
    const res = await k.call('POST', `${ADMIN}/fee-rules`, k.staff, ruleInput(new Date(k.clock.now().getTime() + DAY).toISOString()));
    const approval = [...k.approvals.entries()].find(([, a]) => a.action === 'finance.fees.change' && a.target.id === res.body.id)!;
    await k.decide(approval[0], 'rejected');
    expect((await k.svc.core.repo.get('fee_rule_sets', res.body.id))?.status).toBe('draft');
    const w = await k.call('POST', `${ADMIN}/fee-rules/${res.body.id}/withdraw`, k.staff, { reason: 'Not this quarter' });
    expect(w.body.status).toBe('withdrawn');
  });

  it('charges new sales under the active version', async () => {
    const S = newId();
    const ord = k.order(S, [{ title: 'Router', quantity: 1, price: 10_000 }]);
    await k.accept(ord);
    const charge = await k.svc.core.repo.findOne('fee_charges', { order_item_id: ord.groups[0]!.items[0]!.id });
    expect(charge).toMatchObject({ rule_set_id: proposedId, rate_bps: 1200, fee: 1200 });
  });
});

describe('company trading and marketplace income stay apart', () => {
  it('reports Official Store sales, costs, returns and targets as company trading', async () => {
    const official = k.order(null, [{ title: 'Marketly kettle', quantity: 2, price: 4_500, platformDiscount: 500 }]);
    await k.accept(official);
    await k.svc.recordCompanyCost({ kind: 'buying_cost', amount: USD(5_000), reference: { kind: 'order', id: official.id, ref: official.ref }, at: k.clock.now().toISOString() });
    await k.emit('payments.refund.sent', { refundId: newId(), ref: 'RF-1', orderId: official.id, origin: 'return', originId: null, amount: USD(4_000), items: [{ orderItemId: official.groups[0]!.items[0]!.id, title: 'Marketly kettle', groupId: official.groups[0]!.id, sellerId: null, amount: USD(4_000) }], destination: 'Visa', sentAt: k.clock.now().toISOString() });
    const period = today().slice(0, 7);
    const target = await k.call('PUT', `${ADMIN}/trading-targets/${period}`, k.staff, { salesTarget: USD(3_000_000), marginTargetPct: 30, note: 'Holiday push' });
    expect(target.status, JSON.stringify(target.body)).toBe(200);
    expect((await k.call('PUT', `${ADMIN}/trading-targets/2026-13`, k.staff, { salesTarget: USD(1) })).status).toBe(400);
    const again = await k.call('PUT', `${ADMIN}/trading-targets/${period}`, k.staff, { salesTarget: USD(3_100_000), marginTargetPct: 30 });
    expect(again.body.id).toBe(target.body.id);
    const list = await k.call('GET', `${ADMIN}/trading-targets?from=${period}&to=${period}`, k.staff);
    expect(list.body.items).toHaveLength(1);
    const tr = await k.call('GET', `${ADMIN}/trading?from=${today()}&to=${today()}`, k.staff);
    expect(tr.status).toBe(200);
    expect(tr.body).toMatchObject({ productSales: USD(9_000), buyingCost: USD(5_000), grossMargin: USD(4_000), discounts: USD(500), returnsCost: USD(4_000), netMargin: USD(4_000 - 500 - 4_000) });
    expect(tr.body.target.salesTarget.amount).toBeGreaterThan(0);
    expect(tr.body.daily).toEqual([{ date: today(), sales: USD(9_000), margin: USD(4_000) }]);
  });

  it('counts only fees and ad charges as marketplace income, never seller sales', async () => {
    const S = newId();
    await k.accept(k.order(S, [{ title: 'Headphones', quantity: 1, price: 20_000 }]));
    await k.svc.recordAdCharge({ sellerId: S, campaignId: newId(), campaignRef: 'AD-1', period: { from: today(), to: today() }, amount: USD(330), description: 'Search boost · 33 clicks' });
    await k.emit('promotions.coupon.redeemed', { redemptionId: newId(), campaignId: newId(), orderId: newId(), amount: USD(1_000), platformPart: USD(1_000), sellerPart: USD(0) });
    const inc = await k.call('GET', `${ADMIN}/marketplace-income?from=${today()}&to=${today()}`, k.staff);
    expect(inc.status).toBe(200);
    expect(inc.body.adIncome).toEqual(USD(330));
    expect(inc.body.feeIncome.amount).toBeGreaterThanOrEqual(2_400);
    expect(inc.body.platformDiscountCost).toEqual(USD(1_000));
    const byDay = await k.svc.marketplaceIncomeByDay({ from: today(), to: today() }, S);
    expect(byDay).toEqual([{ date: today(), sellerId: S, feeIncome: USD(2_400), feeRefunds: USD(0), netFeeIncome: USD(2_400), adIncome: USD(330) }]);
    const ov = await k.call('GET', `${ADMIN}/overview?from=${today()}&to=${today()}`, k.staff);
    expect(ov.status).toBe(200);
    expect(ov.body.companySales).toEqual(USD(9_000));
    expect(ov.body.discountFunding.platformCoupons.amount).toBeGreaterThanOrEqual(1_000);
    await expectLedgerMatches(k, S);
  });
});

describe('labels, claims, wallet and previews', () => {
  const S = newId();

  it('charges seller-paid labels, reverses voided ones and books company labels as shipping expense', async () => {
    const labelId = newId();
    const orderId = newId();
    await k.emit('shipping.label.purchased', { labelId, shipmentId: null, orderId, groupId: newId(), sellerId: S, billedTo: 'seller', cost: USD(845), kind: 'outbound', returnId: null });
    await k.emit('shipping.label.purchased', { labelId, shipmentId: null, orderId, groupId: newId(), sellerId: S, billedTo: 'seller', cost: USD(845), kind: 'outbound', returnId: null });
    expect((await expectLedgerMatches(k, S)).total).toBe(-845);
    await k.emit('shipping.label.voided', { labelId, shipmentId: null, orderId, kind: 'outbound', returnId: null, sellerId: S, billedTo: 'seller', cost: USD(845) });
    expect((await expectLedgerMatches(k, S)).total).toBe(0);
    await k.emit('shipping.label.purchased', { labelId: newId(), shipmentId: null, orderId, groupId: newId(), sellerId: S, billedTo: 'seller', cost: USD(500), kind: 'return', returnId: newId() });
    expect((await expectLedgerMatches(k, S)).total).toBe(0); // return labels come from returns
    await k.emit('returns.label.created', { returnId: newId(), ref: 'RT-261010-0001', orderRef: 'MK-261010-00001', ownerType: 'seller', sellerId: S, labelId: newId(), orderId, cost: USD(650), paidBy: 'seller' });
    await k.emit('returns.label.created', { returnId: newId(), ref: 'RT-261010-0001', orderRef: 'MK-261010-00001', ownerType: 'seller', sellerId: S, labelId: newId(), orderId, cost: USD(650), paidBy: 'customer' });
    expect((await expectLedgerMatches(k, S)).total).toBe(-650);
    const before = (await k.call('GET', `${ADMIN}/trading?from=${today()}&to=${today()}`, k.staff)).body.shippingExpense.amount;
    await k.emit('shipping.label.purchased', { labelId: newId(), shipmentId: null, orderId, groupId: newId(), sellerId: null, billedTo: 'company', cost: USD(700), kind: 'outbound', returnId: null });
    expect((await k.call('GET', `${ADMIN}/trading?from=${today()}&to=${today()}`, k.staff)).body.shippingExpense.amount).toBe(before + 700);
  });

  it('credits a paid carrier claim to the seller who bore the loss', async () => {
    await k.emit('shipping.claim.status_changed', { claimId: newId(), orderId: newId(), sellerId: S, filedBy: 'seller', status: 'submitted', amount: USD(4_500), paidAmount: null });
    const claimId = newId();
    await k.emit('shipping.claim.status_changed', { claimId, orderId: newId(), sellerId: S, filedBy: 'seller', status: 'paid', amount: USD(4_500), paidAmount: USD(4_500) });
    await k.emit('shipping.claim.status_changed', { claimId, orderId: newId(), sellerId: S, filedBy: 'seller', status: 'paid', amount: USD(4_500), paidAmount: USD(4_500) });
    expect((await expectLedgerMatches(k, S)).total).toBe(-650 + 4_500);
    const adj = await k.call('GET', `${ADMIN}/adjustments?sellerId=${S}`, k.staff);
    expect(adj.body.items).toEqual([expect.objectContaining({ reasonCode: 'carrier_claim', status: 'recorded', direction: 'credit' })]);
  });

  it('records store-credit liability (wallet) without touching seller money', async () => {
    await k.emit('wallet.credit.granted', { customerId: newId(), entryId: newId(), kind: 'goodwill', amount: USD(1_000), chargedTo: 'platform', sellerId: null, caseId: null, orderId: null });
    await k.emit('wallet.credit.used', { customerId: newId(), orderId: newId(), amount: USD(400) });
    expect((await expectLedgerMatches(k, S)).total).toBe(3_850);
  });

  it('previews the effect of a refund before it is decided', async () => {
    const S2 = newId();
    const ord = k.order(S2, [{ title: 'Desk lamp', quantity: 2, price: 5_000 }]);
    await k.accept(ord);
    const p = await k.svc.previewRefundImpactForOrder(ord.ref, null, null, 'seller');
    expect(p).toMatchObject({ orderRef: ord.ref, refund: USD(10_000), fundedBy: 'seller', sellerEarningsChange: USD(-10_000), feeReturned: USD(1_200), afterPayout: false, platformShare: USD(0) });
    const shared = await k.svc.previewRefundImpact([ord.groups[0]!.items[0]!.id], USD(5_000), 'shared');
    expect(shared).toMatchObject({ sellerEarningsChange: USD(-2_500), feeReturned: USD(600), afterPayout: false });
    await expect(k.svc.previewRefundImpactForOrder('MK-000000-0', null, null, 'seller')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('exports the ledger through reports, scoped to the seller', async () => {
    const res = await k.call('POST', `${SELLER}/ledger/exports`, k.sellerToken(S), { from: today(), to: today() });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.dataset).toBe('finance.seller.ledger');
    const rows = await k.svc.exportRows('finance.seller.ledger', { from: today(), to: today() }, { kind: 'seller', sellerId: S, accountId: newId() }, undefined);
    expect(rows.rows.length).toBeGreaterThan(0);
    await expect(k.svc.exportRows('finance.admin.ledger', {}, { kind: 'seller', sellerId: S }, undefined)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('continues a ledger export after the cursor row, within the date range', async () => {
    const staff = { kind: 'staff', accountId: newId() } as never;
    const range = { from: today(), to: today() };
    const all = (await k.svc.exportRows('finance.admin.ledger', range, staff, undefined)).rows as { description: string; amount: string }[];
    expect(all.length).toBeGreaterThan(2);
    // the cursor names the (at, id) of the last row written: the export goes on with the rows after it
    const entries = await k.svc.core.repo.find('ledger_entries', {}, { orderBy: [['at', 'asc'], ['id', 'asc']] });
    const mid = entries[1]!;
    const rest = (await k.svc.exportRows('finance.admin.ledger', range, staff, `${mid.at.toISOString()}|${mid.id}`)).rows;
    expect(rest).toEqual(all.slice(2));
    // nothing after the range: no rows and no cursor
    const later = await k.svc.exportRows('finance.admin.ledger', { from: '2099-01-01', to: '2099-01-02' }, staff, undefined);
    expect(later).toEqual({ rows: [] });
  });
});

describe('daily finance checks', () => {
  let mismatchId: string;
  let orphanId: string;

  it('records captures against orders: matches quietly, flags differences and unexplained money', async () => {
    const ord = k.order(newId(), [{ title: 'Tent', quantity: 1, price: 12_000 }]);
    await k.emit('payments.payment.captured', { intentId: newId(), captureId: newId(), orderId: ord.id, groupId: null, amount: USD(12_000), allocations: [], providerRef: 'ch_1', capturedAt: k.clock.now().toISOString() });
    await k.emit('payments.payment.captured', { intentId: newId(), captureId: newId(), orderId: ord.id, groupId: null, amount: USD(12_200), allocations: [], providerRef: 'ch_2', capturedAt: k.clock.now().toISOString() });
    await k.emit('payments.payment.captured', { intentId: newId(), captureId: newId(), orderId: newId(), groupId: null, amount: USD(999), allocations: [], providerRef: 'ch_3', capturedAt: k.clock.now().toISOString() });
    const items = await k.call('GET', `${ADMIN}/reconciliation/items?date=${today()}`, k.staff);
    expect(items.status).toBe(200);
    expect(items.body.items.map((i: any) => [i.check, i.difference.amount, i.status]).sort()).toEqual([
      ['payments_vs_orders', 200, 'open'],
      ['unexplained_amount', 999, 'open'],
    ]);
    mismatchId = items.body.items.find((i: any) => i.check === 'payments_vs_orders').id;
    orphanId = items.body.items.find((i: any) => i.check === 'unexplained_amount').id;
    expect(k.of('finance.reconciliation.mismatch_found').map((e) => e.itemId).sort()).toEqual([mismatchId, orphanId].sort());
    const day = await k.call('GET', `${ADMIN}/reconciliation/days/${today()}`, k.staff);
    expect(day.body).toMatchObject({ status: 'open', openMismatches: 2, unexplained: USD(999) });
    expect(day.body.checklist.find((c: any) => c.key === 'payments_matched').state).not.toBe('done');
  });

  it('cannot sign off a day with open mismatches', async () => {
    const res = await k.call('POST', `${ADMIN}/reconciliation/days/${today()}/complete`, k.staff, { note: 'Done' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'RECON_DAY_INCOMPLETE', details: { openItems: expect.arrayContaining([mismatchId, orphanId]) } });
  });

  it("assigns, explains and corrects (a second reviewer above the caller's correction limit), then signs off", async () => {
    const owner = newId();
    const a = await k.call('POST', `${ADMIN}/reconciliation/items/${orphanId}/assign`, k.staff, { ownerId: owner });
    expect(a.body).toMatchObject({ owner: { kind: 'staff', id: owner, name: 'Fran Finance' }, ownerRole: 'Finance Specialist' });
    const e = await k.call('POST', `${ADMIN}/reconciliation/items/${orphanId}/explain`, k.staff, { reasonCode: 'timing', note: 'Order created after the capture' });
    expect(e.body.status).toBe('explained');
    expect((await k.call('POST', `${ADMIN}/reconciliation/items/${orphanId}/explain`, k.staff, { reasonCode: 'timing', note: 'again' })).status).toBe(409);
    k.authority.set('finance.reconciliation.correct', 'approval_required');
    const c = await k.call('POST', `${ADMIN}/reconciliation/items/${mismatchId}/correct`, k.staff, { type: 'refund_duplicate_capture', amount: USD(200), reasonCode: 'duplicate_capture', note: 'Captured twice by the provider' }, idem());
    // saved pending approval: the item answers with the correction and its approval (FORMAT.md, Approval responses)
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ id: mismatchId, status: 'correction_pending', correction: { status: 'pending_approval', amount: USD(200), approval: { required: true, approvalRequestId: expect.any(String) } } });
    const pending = await k.call('GET', `${ADMIN}/reconciliation/items?status=correction_pending`, k.staff);
    expect(pending.body.items[0]).toMatchObject({ id: mismatchId, correction: { status: 'pending_approval', approval: { required: true } } });
    await k.decide(c.body.correction.approval.approvalRequestId, 'approved');
    expect(k.refunds).toEqual([expect.objectContaining({ origin: 'correction', originId: mismatchId, items: [expect.objectContaining({ amount: USD(200) })] })]);
    const done = await k.call('GET', `${ADMIN}/reconciliation/items?status=corrected`, k.staff);
    expect(done.body.items[0]).toMatchObject({ id: mismatchId, correction: { status: 'applied', resultReference: { kind: 'refund' } } });
    // closing an item tells workqueues: explained, then corrected once the approved correction was applied
    expect(k.of('finance.reconciliation.item_closed').filter((x) => [orphanId, mismatchId].includes(x.itemId))).toEqual([
      { itemId: orphanId, check: 'unexplained_amount', date: today(), outcome: 'explained' },
      { itemId: mismatchId, check: 'payments_vs_orders', date: today(), outcome: 'corrected' },
    ]);
    const signed = await k.call('POST', `${ADMIN}/reconciliation/days/${today()}/complete`, k.staff, { note: 'All explained' });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body).toMatchObject({ status: 'completed', openMismatches: 0 });
    expect((await k.call('POST', `${ADMIN}/reconciliation/days/${today()}/complete`, k.staff, {})).status).toBe(409);
  });

  it('builds yesterday\'s checks: provider deposit against captures and seller balances against the ledger', async () => {
    const day = today();
    k.provider.setDeposit(day, USD(12_000 + 12_200 + 999 - 50));
    k.clock.advance(DAY);
    await k.app.kernel.jobs.runNow('finance.reconcile.daily');
    const items = await k.call('GET', `${ADMIN}/reconciliation/items?date=${day}&check=provider_deposit`, k.staff);
    expect(items.body.items).toEqual([expect.objectContaining({ check: 'provider_deposit', difference: USD(-50), status: 'open' })]);
    expect((await k.call('GET', `${ADMIN}/reconciliation/items?check=seller_amounts`, k.staff)).body.items).toEqual([]);

    // the provider corrects its report: the same day's check run again now matches and the item is closed
    k.provider.setDeposit(day, USD(12_000 + 12_200 + 999));
    await k.app.kernel.jobs.runNow('finance.reconcile.daily');
    await k.app.kernel.events.drain();
    const deposit = (await k.call('GET', `${ADMIN}/reconciliation/items?date=${day}&check=provider_deposit&status=matched`, k.staff)).body.items;
    expect(deposit).toEqual([expect.objectContaining({ status: 'matched', difference: USD(0) })]);
    expect(k.of('finance.reconciliation.item_closed').filter((x) => x.itemId === deposit[0].id)).toEqual([{ itemId: deposit[0].id, check: 'provider_deposit', date: day, outcome: 'matched' }]);
    await k.app.kernel.jobs.runNow('finance.reconcile.daily'); // nothing more to close
    await k.app.kernel.events.drain();
    expect(k.of('finance.reconciliation.item_closed').filter((x) => x.itemId === deposit[0].id)).toHaveLength(1);
  });

  it('compares card captures plus store credit with the total less the items cancelled before the capture', async () => {
    const S = newId();
    const captured = (orderId: string, o: { card: number; credit?: number; groupId?: string }) => {
      const captureId = newId();
      return {
        captureId,
        emit: () => k.emit('payments.payment.captured', { intentId: newId(), captureId, orderId, groupId: o.groupId ?? null, amount: USD(o.card), creditAmount: o.credit === undefined ? null : USD(o.credit), allocations: [], providerRef: `ch_${captureId.slice(0, 6)}`, capturedAt: k.clock.now().toISOString() }),
      };
    };
    const itemOf = async (captureId: string) => (await k.svc.core.repo.findOne('recon_items', { ref_kind: 'capture', ref_id: captureId }))!;

    // a mixed payment: 7 000 on the card and 3 000 of store credit for a 10 000 order is no mismatch
    const mixed = k.order(S, [{ title: 'Lamp', quantity: 1, price: 6_000 }, { title: 'Shade', quantity: 1, price: 4_000 }]);
    const c1 = captured(mixed.id, { card: 7_000, credit: 3_000 });
    await c1.emit();
    expect(await itemOf(c1.captureId)).toMatchObject({ check: 'payments_vs_orders', status: 'matched', expected: 10_000, actual: 7_000, credit: 3_000, difference: 0 });
    expect((await itemOf(c1.captureId)).description).toContain('plus store credit $30.00');

    // per package with an item cancelled before it was charged: the package total less that item
    const split = k.order(S, [{ title: 'Desk', quantity: 1, price: 9_000 }, { title: 'Chair', quantity: 1, price: 5_000, state: 'cancelled' }]);
    const group = split.groups[0]!;
    const c2 = captured(split.id, { card: 6_000, credit: 3_000, groupId: group.id });
    await c2.emit();
    expect(await itemOf(c2.captureId)).toMatchObject({ status: 'matched', expected: 9_000, actual: 6_000, credit: 3_000, difference: 0 });
    expect((await itemOf(c2.captureId)).description).toContain('less $50.00 of cancelled items');

    // an item cancelled after the capture was refunded, not left out of the capture
    const after = k.order(S, [{ title: 'Rug', quantity: 1, price: 8_000, state: 'cancelled', refunded: true }]);
    const c3 = captured(after.id, { card: 8_000 });
    await c3.emit();
    expect(await itemOf(c3.captureId)).toMatchObject({ status: 'matched', difference: 0 });

    // a real difference is still a mismatch: card plus credit 100 more than the order
    const over = k.order(S, [{ title: 'Vase', quantity: 1, price: 5_000 }]);
    const c4 = captured(over.id, { card: 2_100, credit: 3_000 });
    await c4.emit();
    const mismatch = await itemOf(c4.captureId);
    expect(mismatch).toMatchObject({ status: 'open', expected: 5_000, actual: 2_100, credit: 3_000, difference: 100 });
    expect(k.of('finance.reconciliation.mismatch_found')).toContainEqual({ itemId: mismatch.id, check: 'payments_vs_orders', difference: USD(100) });
    await c4.emit(); // redelivered: nothing new
    expect(k.of('finance.reconciliation.mismatch_found').filter((x) => x.itemId === mismatch.id)).toHaveLength(1);
    const ids = await Promise.all([c1, c2, c3, c4].map(async (c) => (await itemOf(c.captureId)).id));
    expect(k.of('finance.reconciliation.item_closed').filter((x) => ids.includes(x.itemId))).toEqual([]); // items matched at once never opened

    // the provider deposit is card money only
    const day = k.svc.core.today();
    k.provider.setDeposit(day, USD(7_000 + 6_000 + 8_000 + 2_100));
    k.clock.advance(DAY);
    await k.app.kernel.jobs.runNow('finance.reconcile.daily');
    await k.app.kernel.events.drain();
    expect((await k.call('GET', `${ADMIN}/reconciliation/items?date=${day}&check=provider_deposit&status=matched`, k.staff)).body.items).toEqual([expect.objectContaining({ difference: USD(0) })]);
  });

  it('closes an earlier seller balance mismatch once the balance matches the ledger again', async () => {
    const S = newId();
    await k.accept(k.order(S, [{ title: 'Kettle', quantity: 1, price: 3_000 }]));
    const repo = k.svc.core.repo;
    const acct = (await repo.findOne('seller_accounts', { seller_id: S }))!;
    await repo.updateWhere('seller_accounts', { seller_id: S }, { available: acct.available + 5 });
    const first = k.svc.core.today();
    k.clock.advance(DAY);
    await k.app.kernel.jobs.runNow('finance.reconcile.daily');
    await k.app.kernel.events.drain();
    const open = await repo.find('recon_items', { check: 'seller_amounts', ref_id: S });
    expect(open).toEqual([expect.objectContaining({ status: 'open', difference: 5, date: first })]);
    await repo.updateWhere('seller_accounts', { seller_id: S }, { available: acct.available });
    k.clock.advance(DAY);
    await k.app.kernel.jobs.runNow('finance.reconcile.daily');
    await k.app.kernel.events.drain();
    expect(await repo.get('recon_items', open[0]!.id)).toMatchObject({ status: 'matched', difference: 0 });
    expect(k.of('finance.reconciliation.item_closed').filter((x) => x.itemId === open[0]!.id)).toEqual([{ itemId: open[0]!.id, check: 'seller_amounts', date: first, outcome: 'matched' }]);
  });
});

describe('GraphQL read layer', () => {
  it('serves the seller its own money and staff the payout runs', async () => {
    const S = newId();
    await k.accept(k.order(S, [{ title: 'Speaker', quantity: 1, price: 5_000 }]));
    const query = '{ sellerFinance { sellerId balance { pending { amount } available { amount } destination { status } } ledger(types: [SALE, MARKETPLACE_FEE]) { items { type amount { amount } bucket reference { kind ref } } } feeRuleVersion } }';
    const res = await k.app.inject({ method: 'POST', url: '/graphql/seller', headers: auth(k.sellerToken(S)), payload: { query } });
    const body = res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.sellerFinance.balance).toMatchObject({ pending: { amount: 4_400 }, available: { amount: 0 }, destination: { status: 'MISSING' } });
    expect(body.data.sellerFinance.ledger.items.map((i: any) => i.type).sort()).toEqual(['MARKETPLACE_FEE', 'SALE']);
    expect(body.data.sellerFinance.ledger.items[0].reference.kind).toBe('ORDER');
    const admin = await k.app.inject({ method: 'POST', url: '/graphql/admin', headers: auth(k.staff), payload: { query: '{ payoutRuns { items { ref status } } nextPayoutRun { ref } }' } });
    expect(admin.json().errors).toBeUndefined();
  });
});
