/**
 * The seller ledger replayed end to end: sales with seller- and platform-funded discounts (funding split from
 * promotions), a cancellation before dispatch (plan scenario 4), delivery and the hold window, a payout run,
 * a refund after payout that makes the balance negative and becomes an amount owed (scenario 6), and later
 * earnings that offset it. After every step the balances equal the sum of the ledger entries, and replaying
 * every event changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { signWebhook } from '../../../testing/app.js';
import { ADMIN, boot, expectLedgerMatches, SELLER, USD, type FakeOrder, type Kit } from './helpers.js';

const DAY = 86_400_000;
let k: Kit;
const S = newId();
const OTHER = newId();
const sellerTokenOf = () => k.sellerToken(S);
let orderA: FakeOrder;
let orderB: FakeOrder;
let run1: any;

async function verifiedDestination(k: Kit, sellerId: string, token: string) {
  const providerDestinationId = `dest_${sellerId.slice(0, 8)}`;
  await k.emit('sellers.payout_account.changed', { sellerId, changeId: newId(), providerDestinationId, label: 'Pacific Coast Credit Union •••• 6620', accountHolderName: 'Northwind LLC', accountType: 'business_checking', previousLabel: null, isInitial: true, requestedBy: { kind: 'seller', id: newId() } });
  const [a, b] = k.provider.testDepositsFor(providerDestinationId);
  const ok = await k.call('POST', `${SELLER}/payout-destination/confirm-deposits`, token, { amounts: [USD(a), USD(b)] });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  expect(ok.body.destination.status).toBe('verified');
}

async function paid(k: Kit, providerPayoutId: string, event: 'paid' | 'failed' | 'returned' = 'paid', extra: Record<string, unknown> = {}) {
  const raw = JSON.stringify({ providerPayoutId, event, at: k.clock.now().toISOString(), ...extra });
  const res = await k.app.inject({ method: 'POST', url: '/webhooks/finance/payouts', headers: { 'content-type': 'application/json', 'x-event-id': newId(), ...signWebhook('dev-webhook-secret', raw, Math.floor(k.clock.now().getTime() / 1000)) }, payload: raw });
  await k.app.kernel.events.drain();
  return res.statusCode;
}

beforeAll(async () => {
  k = await boot();
  await verifiedDestination(k, S, sellerTokenOf());
});
afterAll(async () => {
  await k?.close();
});

describe('sales at order acceptance', () => {
  it('books each seller item as a pending lot: sale, seller-funded discount, shipping charged and the fee on the right basis', async () => {
    orderA = k.order(S, [
      { title: 'Pocket speaker', quantity: 2, price: 5900, sellerDiscount: 1180, platformDiscount: 500, shipping: 699 },
      { title: 'Cable kit', quantity: 1, price: 2400 },
    ]);
    await k.accept(orderA);
    const t = await expectLedgerMatches(k, S);
    // item 1: 11800 − 1180 + 699 = 11319 proceeds, fee 10% of 10620 (after the seller's discount; the platform-funded 500 is not deducted) = 1062
    // item 2: 2400 proceeds, fee 240
    expect(t).toEqual({ total: 11319 - 1062 + 2400 - 240, pending: 12417, held: 0, available: 0 });
    const ledger = await k.call('GET', `${SELLER}/ledger?types=marketplace_fee`, sellerTokenOf());
    expect(ledger.status).toBe(200);
    expect(ledger.body.items.map((e: any) => e.amount.amount).sort()).toEqual([-1062, -240]);
    expect(ledger.body.items.find((e: any) => e.amount.amount === -1062).description).toContain('10% of $106.20');
  });

  it('never posts the same sale twice (event redelivery)', async () => {
    await k.accept(orderA);
    const t = await expectLedgerMatches(k, S);
    expect(t.pending).toBe(12417);
  });

  it('keeps Official Store sales in company trading, never in a seller ledger', async () => {
    const official = k.order(null, [{ title: 'Marketly kettle', quantity: 1, price: 4500, shipping: 500 }]);
    await k.accept(official);
    const trading = await k.call('GET', `${ADMIN}/trading?from=${k.svc.core.today()}&to=${k.svc.core.today()}`, k.staff);
    expect(trading.status).toBe(200);
    expect(trading.body.productSales.amount).toBe(4500);
    expect(await k.svc.core.repo.count('ledger_entries', { ref_id: official.id })).toBe(0);
  });
});

describe('a cancellation before dispatch (scenario 4: only the selected item changes)', () => {
  it('reverses the cancelled item and returns its fee; the other item is untouched', async () => {
    const item = orderA.groups[0]!.items[1]!;
    const cancel = { orderId: orderA.id, ref: orderA.ref, groupId: orderA.groups[0]!.id, ownerType: 'seller', sellerId: S, fulfilledBy: 'seller', itemId: item.id, offerId: newId(), stockItemId: newId(), quantity: 1, cancellationId: newId(), initiatedBy: 'customer', reasonCode: 'changed_mind', beforeDispatch: true, countsAgainstSeller: false, refund: { itemAmount: USD(2400), discountShare: USD(0), shippingRefund: USD(0), taxRefund: USD(0), total: USD(2400) }, paymentIntentId: newId(), trustReportId: null, notifyCustomer: true };
    await k.emit('orders.item.cancelled', cancel);
    await k.emit('orders.item.cancelled', cancel); // redelivered
    const t = await expectLedgerMatches(k, S);
    expect(t.pending).toBe(11319 - 1062);
    const lot = await k.svc.core.repo.findOne('earnings_lots', { order_item_id: item.id });
    expect(lot?.state).toBe('reversed');
    const charge = await k.svc.core.repo.findOne('fee_charges', { order_item_id: item.id });
    expect(charge).toMatchObject({ refunded_fee: 240, status: 'reversed' });
  });
});

describe('delivery, the hold window and the payout run', () => {
  it('makes earnings available only after delivery plus availableAfterDeliveryDays', async () => {
    await k.deliver(orderA, [orderA.groups[0]!.items[0]!.id]);
    await k.app.kernel.jobs.runNow('finance.release-pending');
    expect((await expectLedgerMatches(k, S)).available).toBe(0);
    k.clock.advance(8 * DAY);
    await k.app.kernel.jobs.runNow('finance.release-pending');
    const t = await expectLedgerMatches(k, S);
    expect(t).toMatchObject({ pending: 0, available: 10257 });
    const bal = await k.call('GET', `${SELLER}/balances`, sellerTokenOf());
    expect(bal.status).toBe(200);
    expect(bal.body).toMatchObject({ pending: USD(0), available: USD(10257), held: USD(0), negative: false });
    expect(bal.body.nextPayout.estimatedAmount).toEqual(USD(10257));
  });

  it('issues the statement at the cutoff and pays exactly what it reconciles to', async () => {
    const res = await k.call('POST', `${ADMIN}/payout-runs`, k.staff, { cutoffAt: k.clock.now().toISOString(), scheduledRelease: new Date(k.clock.now().getTime() + 3_600_000).toISOString() }, { 'idempotency-key': newId() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    run1 = res.body;
    expect(run1).toMatchObject({ status: 'draft', total: USD(10257), payingNow: USD(10257) });
    expect(k.of('finance.statement.issued').some((e) => e.sellerId === S)).toBe(true);
    const again = await k.call('POST', `${ADMIN}/payout-runs`, k.staff, { cutoffAt: run1.cutoffAt, scheduledRelease: run1.scheduledRelease }, { 'idempotency-key': newId() });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'RUN_ALREADY_EXISTS', details: { runId: run1.id } });

    const statements = await k.call('GET', `${ADMIN}/payout-runs/${run1.id}/statements`, k.staff);
    expect(statements.body.items).toHaveLength(1);
    const st = await k.call('GET', `${SELLER}/statements/${statements.body.items[0].statementId}`, sellerTokenOf());
    expect(st.status).toBe(200);
    const sections = Object.fromEntries(st.body.sections.map((s: any) => [s.key, s.total.amount]));
    expect(sections).toEqual({ sales: 11800 - 1180 + 699 + 2400 - 2400, fees: -1062 - 240 + 240, refunds: 0, holds: 0, adjustments: 0, ads: 0 });
    expect(st.body.reconciliation).toMatchObject({ openingAvailable: USD(0), payout: USD(10257), closingAvailable: USD(0) });
    expect(st.body.sections.find((s: any) => s.key === 'fees').lines.find((l: any) => l.amount.amount === -1062).basis).toEqual(USD(10620));
    // another seller never sees it
    expect((await k.call('GET', `${SELLER}/statements/${st.body.id}`, k.sellerToken(OTHER))).status).toBe(404);
  });

  it('submits, approves and releases the run; the payout is paid only when the provider confirms', async () => {
    expect((await k.call('POST', `${ADMIN}/payout-runs/${run1.id}/submit`, k.staff)).body.status).toBe('pending_approval');
    const approved = await k.call('POST', `${ADMIN}/payout-runs/${run1.id}/approve`, k.staff, { confirmedReview: true, note: 'Checked' }, { 'idempotency-key': newId() });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(k.of('finance.payout_run.approved')).toHaveLength(1);
    const released = await k.call('POST', `${ADMIN}/payout-runs/${run1.id}/release`, k.staff, undefined, { 'idempotency-key': newId() });
    expect(released.body.status).toBe('releasing');
    expect(k.of('finance.payout.processing')).toHaveLength(1);
    expect((await expectLedgerMatches(k, S)).available).toBe(0);
    const payout = (await k.svc.core.repo.find('payouts', { run_id: run1.id }))[0]!;
    expect(payout.status).toBe('processing');
    expect(await paid(k, payout.provider_payout_id!)).toBe(204);
    expect(await paid(k, payout.provider_payout_id!)).toBe(204); // duplicate delivery
    const after = await k.call('GET', `${SELLER}/payouts/${payout.id}`, sellerTokenOf());
    expect(after.body).toMatchObject({ status: 'paid', amount: USD(10257) });
    expect(k.of('finance.payout.paid')).toHaveLength(1);
    expect((await k.call('GET', `${ADMIN}/payout-runs/${run1.id}`, k.staff)).body.status).toBe('completed');
    expect((await k.svc.core.repo.findOne('earnings_lots', { order_item_id: orderA.groups[0]!.items[0]!.id }))?.state).toBe('paid_out');
  });
});

describe('a refund after payout (scenario 6)', () => {
  it('deducts the refund (with the funding split and the fee returned pro rata) from later earnings', async () => {
    const item = orderA.groups[0]!.items[0]!;
    const refundRequestId = newId();
    await k.emit('returns.refund.approved', { refundRequestId, returnId: newId(), caseId: null, orderId: orderA.id, orderItemIds: [item.id], items: [{ orderItemId: item.id, quantity: 1 }], ownerType: 'seller', sellerId: S, source: 'return', trustReportId: null, total: USD(5560), breakdown: { itemAmount: USD(5900), discountShare: USD(340), shippingRefund: USD(0), returnShippingDeduction: USD(0), deductions: [], total: USD(5560), maxRefundable: USD(11319), destination: 'Visa •••• 4417', isEstimate: false }, fundedBy: 'shared', sellerShare: USD(5310), platformShare: USD(250), approvedBy: { kind: 'staff', id: newId() } });
    const sent = { refundId: newId(), ref: 'RT-261020-0533', orderId: orderA.id, origin: 'return', originId: refundRequestId, amount: USD(5560), items: [{ orderItemId: item.id, title: 'Pocket speaker', groupId: orderA.groups[0]!.id, sellerId: S, amount: USD(5560) }], destination: 'Visa •••• 4417', sentAt: k.clock.now().toISOString() };
    expect(await k.svc.bookedRefundImpact(sent.refundId, [item.id])).toBeNull(); // not booked yet: returns shows a preview
    await k.emit('payments.refund.sent', sent);
    await k.emit('payments.refund.sent', sent); // redelivered
    const t = await expectLedgerMatches(k, S);
    expect(t.available).toBe(-5310 + 531);
    // the earnings card after booking: the posted amounts, not a new preview
    expect(await k.svc.bookedRefundImpact(sent.refundId, [item.id])).toMatchObject({ sellerEarningsChange: USD(-5310), feeReturned: USD(531), afterPayout: true });
    const entries = await k.call('GET', `${SELLER}/ledger?type=refunds`, sellerTokenOf());
    expect(entries.body.items[0]).toMatchObject({ type: 'refund_after_payout', amount: USD(-5310) });
    expect(entries.body.items[0].description).toContain('after payout');
    expect(k.of('finance.balance.negative')).toEqual([expect.objectContaining({ sellerId: S, available: USD(-4779) })]);
    const bal = await k.call('GET', `${SELLER}/balances`, sellerTokenOf());
    expect(bal.body).toMatchObject({ negative: true, available: USD(-4779) });
    // the sellers header totals count this seller's negative balance and include its balance
    const totals = await k.svc.sellerBalanceTotals();
    expect(totals.negativeCount).toBeGreaterThanOrEqual(1);
    const all = await k.svc.core.repo.find('seller_accounts', {});
    expect(totals.total).toEqual(USD(all.reduce((s, a) => s + a.pending + a.available + a.held, 0)));
    expect(totals.held).toEqual(USD(all.reduce((s, a) => s + a.held, 0)));
  });

  it('turns a negative balance not covered in time into an amount owed, offset by new earnings first', async () => {
    k.clock.advance(31 * DAY);
    await k.svc.negativeBalanceAge();
    await k.app.kernel.events.drain();
    await k.app.kernel.jobs.runNow('finance.negative-balance.age'); // once only
    expect(k.of('finance.amount_owed.created')).toEqual([expect.objectContaining({ sellerId: S, amount: USD(4779) })]);
    const owed = await k.call('GET', `${ADMIN}/amounts-owed?sellerId=${S}`, k.staff);
    expect(owed.body.items).toEqual([expect.objectContaining({ amount: USD(4779), remaining: USD(4779), status: 'open' })]);
    expect((await k.call('GET', `${SELLER}/balances`, sellerTokenOf())).body.amountOwed).toEqual(USD(4779));

    orderB = k.order(S, [{ title: 'Studio headphones', quantity: 1, price: 10000 }]);
    await k.accept(orderB);
    await k.deliver(orderB);
    k.clock.advance(8 * DAY);
    await k.app.kernel.jobs.runNow('finance.release-pending');
    const t = await expectLedgerMatches(k, S);
    expect(t.available).toBe(-4779 + 9000);
    const settled = await k.call('GET', `${ADMIN}/amounts-owed?sellerId=${S}`, k.staff);
    expect(settled.body.items[0]).toMatchObject({ remaining: USD(0), status: 'settled' });
  });

  it('shows the deduction with its payout reference on the next statement, which reconciles to the next payout', async () => {
    const res = await k.call('POST', `${ADMIN}/payout-runs`, k.staff, { cutoffAt: k.clock.now().toISOString(), scheduledRelease: new Date(k.clock.now().getTime() + 3_600_000).toISOString() }, { 'idempotency-key': newId() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.total).toEqual(USD(4221));
    const rows = await k.call('GET', `${ADMIN}/payout-runs/${res.body.id}/statements`, k.staff);
    const st = await k.call('GET', `${SELLER}/statements/${rows.body.items[0].statementId}`, sellerTokenOf());
    const refunds = st.body.sections.find((s: any) => s.key === 'refunds');
    expect(refunds.total).toEqual(USD(-5310));
    expect(refunds.lines[0].description).toMatch(/after payout \(paid out in PO-/);
    expect(st.body.afterPayoutNotices[0]).toContain('RT-261020-0533');
    expect(st.body.reconciliation).toMatchObject({ openingAvailable: USD(0), payout: USD(4221), closingAvailable: USD(0) });
    const total = st.body.reconciliation.lines.reduce((s: number, l: any) => s + l.amount.amount, 0);
    expect(st.body.reconciliation.openingAvailable.amount + total - st.body.reconciliation.payout.amount).toBe(st.body.reconciliation.closingAvailable.amount);
    const list = await k.call('GET', `${SELLER}/statements`, sellerTokenOf());
    expect(list.body.items.filter((s: any) => s.status === 'issued')).toHaveLength(2);
    await expectLedgerMatches(k, S);
  });

  it('lists the seller ledger with a running balance and a statement reference (own seller only)', async () => {
    const page = await k.call('GET', `${SELLER}/ledger?limit=100`, sellerTokenOf());
    expect(page.status).toBe(200);
    const items = page.body.items as any[];
    expect(items[0].balanceAfter.amount).toBe((await expectLedgerMatches(k, S)).total);
    expect(items.some((e) => e.statementRef?.startsWith('ST-'))).toBe(true);
    const other = await k.call('GET', `${SELLER}/ledger`, k.sellerToken(OTHER));
    expect(other.body.items).toEqual([]);
    expect((await k.call('GET', `${SELLER}/payouts/${(await k.svc.core.repo.find('payouts', { seller_id: S }))[0]!.id}`, k.sellerToken(OTHER))).status).toBe(404);
  });
});

describe('the spec correctness pass, replayed on the ledger', () => {
  const S3 = newId();
  const CATEGORY = newId();
  const repo = () => k.svc.core.repo;
  const today = () => k.svc.core.today();

  it('charges the category fee rate of the category the order item was bought in', async () => {
    const rule = await k.svc.core.activeRule();
    await repo().insert('fee_category_rates', { rule_set_id: rule.id, category_id: CATEGORY, category_name: 'Electronics', rate_bps: 1500 });
    const ord = k.order(S3, [
      { title: 'Espresso machine', quantity: 1, price: 20_000, categoryId: CATEGORY },
      { title: 'Milk jug', quantity: 1, price: 2_000 },
    ]);
    await k.accept(ord);
    const t = await expectLedgerMatches(k, S3);
    expect(t.pending).toBe(20_000 - 3_000 + 2_000 - 200);
    expect(await repo().findOne('fee_charges', { order_item_id: ord.groups[0]!.items[0]!.id })).toMatchObject({ rate_bps: 1500, fee: 3_000 });
    expect(await repo().findOne('fee_charges', { order_item_id: ord.groups[0]!.items[1]!.id })).toMatchObject({ rate_bps: 1000, fee: 200 });
  });

  it('posts a fulfillment-service fee once per key and credits it back, never more than the fee', async () => {
    const before = await expectLedgerMatches(k, S3);
    const input = { sellerId: S3, amount: USD(1_200), kind: 'storage', reference: { kind: 'fulfillment_service' as const, id: newId(), ref: 'FS-2610-STORAGE' }, description: 'Storage, October', idempotencyKey: 'fs-storage-2610' };
    const fee = await k.svc.recordServiceFee(input);
    expect(fee).toMatchObject({ type: 'service_fee', amount: USD(-1_200), reference: { kind: 'fulfillment_service', ref: 'FS-2610-STORAGE' } });
    expect((await k.svc.recordServiceFee(input)).id).toBe(fee.id);
    expect((await expectLedgerMatches(k, S3)).available).toBe(before.available - 1_200);

    const credit = { sellerId: S3, amount: USD(500), originalEntryId: fee.id, reason: 'Storage overcharged', idempotencyKey: 'fs-credit-1' };
    const c1 = await k.svc.creditSellerCharge(credit);
    expect(c1).toMatchObject({ type: 'charge_credit', amount: USD(500), reference: { kind: 'fulfillment_service', ref: 'FS-2610-STORAGE' } });
    expect((await k.svc.creditSellerCharge(credit)).id).toBe(c1.id); // same key: the first entry
    await expect(k.svc.creditSellerCharge({ ...credit, amount: USD(701), idempotencyKey: 'fs-credit-2' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await k.svc.creditSellerCharge({ ...credit, amount: USD(700), idempotencyKey: 'fs-credit-3' });
    await expect(k.svc.creditSellerCharge({ ...credit, amount: USD(1), idempotencyKey: 'fs-credit-4' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(k.svc.creditSellerCharge({ ...credit, sellerId: newId(), idempotencyKey: 'fs-credit-5' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const sale = (await repo().findOne('ledger_entries', { seller_id: S3, type: 'sale' }))!;
    await expect(k.svc.creditSellerCharge({ ...credit, originalEntryId: sale.id, idempotencyKey: 'fs-credit-6' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await expectLedgerMatches(k, S3)).available).toBe(before.available);

    // ad charges are credited back the same way (ad income is net of the credit)
    const ad = await k.svc.recordAdCharge({ sellerId: S3, campaignId: newId(), campaignRef: 'AD-77', period: { from: today(), to: today() }, amount: USD(900), description: 'Sponsored listings' });
    await k.svc.creditSellerCharge({ sellerId: S3, amount: USD(300), originalEntryId: ad.id, reason: 'Invalid clicks', idempotencyKey: 'ad-credit-1' });
    const adj = await k.call('GET', `${SELLER}/ledger?type=adjustments`, k.sellerToken(S3));
    expect(adj.body.items.map((e: any) => e.amount.amount).sort((a: number, b: number) => a - b)).toEqual([-1_200, 300, 500, 700]);
    expect((await expectLedgerMatches(k, S3)).available).toBe(before.available - 600);
    const inc = await k.svc.marketplaceIncomeByDay({ from: today(), to: today() }, S3);
    expect(inc[0]!.adIncome).toEqual(USD(600));
  });

  it('marks the funding split of a failed refund, posts nothing until it is sent and lists a final failure in the daily checks', async () => {
    const ord = k.order(S3, [{ title: 'Grinder', quantity: 1, price: 8_000 }]);
    await k.accept(ord);
    const before = await expectLedgerMatches(k, S3);
    const item = ord.groups[0]!.items[0]!;
    const refundRequestId = newId();
    await k.emit('returns.refund.approved', { refundRequestId, returnId: newId(), caseId: null, orderId: ord.id, orderItemIds: [item.id], items: [{ orderItemId: item.id, quantity: 1 }], ownerType: 'seller', sellerId: S3, source: 'return', trustReportId: null, total: USD(8_000), breakdown: { itemAmount: USD(8_000), discountShare: USD(0), shippingRefund: USD(0), returnShippingDeduction: USD(0), deductions: [], total: USD(8_000), maxRefundable: USD(8_000), destination: 'Visa •••• 4417', isEstimate: false }, fundedBy: 'seller', sellerShare: USD(8_000), platformShare: USD(0), approvedBy: { kind: 'staff', id: newId() } });
    const refundId = newId();
    const failed = { refundId, ref: 'RF-261010-0001', orderId: ord.id, customerId: newId(), contactEmail: 'ana@example.com', origin: 'return', originId: refundRequestId, amount: USD(8_000), reason: 'The card was closed', attempts: 1, finalAttempt: false };
    await k.emit('payments.refund.failed', failed);
    expect(await expectLedgerMatches(k, S3)).toEqual(before);
    const alloc = (await repo().findOne('refund_allocations', { refund_request_id: refundRequestId }))!;
    expect(alloc).toMatchObject({ payment_refund_id: refundId, applied_at: null });
    expect((alloc.breakdown as any).failure).toMatchObject({ refundId, attempts: 1, finalAttempt: false });
    expect(await repo().find('recon_items', { ref_kind: 'refund', ref_id: refundId })).toEqual([]);

    const final = { ...failed, attempts: 3, finalAttempt: true };
    const eventId = newId();
    await k.svc.onRefundFailedFromPayments(final, eventId);
    await k.svc.onRefundFailedFromPayments(final, eventId); // redelivered: claimed once
    await k.app.kernel.events.drain();
    const items = await repo().find('recon_items', { ref_kind: 'refund', ref_id: refundId });
    expect(items).toEqual([expect.objectContaining({ check: 'payments_vs_orders', status: 'open', expected: 8_000, actual: 0, difference: -8_000 })]);
    expect(k.of('finance.reconciliation.mismatch_found').filter((e) => e.itemId === items[0]!.id)).toHaveLength(1);
    expect(((await repo().findOne('refund_allocations', { refund_request_id: refundRequestId }))!.breakdown as any).failure).toMatchObject({ attempts: 3, finalAttempt: true });
    expect((await k.call('GET', `${ADMIN}/overview?from=${today()}&to=${today()}`, k.staff)).body.refundsFailing).toBeGreaterThanOrEqual(1);
    expect(await expectLedgerMatches(k, S3)).toEqual(before);

    // sent after all (the customer chose a new card): the refund posts and the check item matches
    await k.emit('payments.refund.sent', { refundId, ref: failed.ref, orderId: ord.id, customerId: failed.customerId, contactEmail: failed.contactEmail, origin: 'return', originId: refundRequestId, amount: USD(8_000), items: [{ orderItemId: item.id, title: 'Grinder', groupId: ord.groups[0]!.id, sellerId: S3, amount: USD(8_000) }], destination: 'new_method', sentAt: k.clock.now().toISOString() });
    const after = await expectLedgerMatches(k, S3);
    expect(after.total).toBe(before.total - 8_000 + 800); // the refund, and the fee returned
    expect((await repo().get('recon_items', items[0]!.id))!.status).toBe('matched');
  });

  it('reverses discount funding once per reversal event', async () => {
    const redemptionId = newId();
    const orderId = newId();
    const orderItemId = newId();
    await k.emit('promotions.coupon.redeemed', { redemptionId, campaignId: newId(), orderId, amount: USD(1_500), platformPart: USD(1_000), sellerPart: USD(500) });
    const part = { redemptionId, orderItemId, amount: USD(600), platformPart: USD(400), sellerPart: USD(200) };
    const eventId = newId();
    await k.svc.onRedemptionReversedFromPromotions(part, eventId);
    await k.svc.onRedemptionReversedFromPromotions(part, eventId); // redelivered
    const rows = async () => repo().find('discount_funding', { redemption_id: redemptionId });
    const net = async (by: string) => (await rows()).filter((r) => r.funded_by === by).reduce((s, r) => s + r.amount, 0);
    expect([await net('platform'), await net('seller')]).toEqual([600, 300]);
    expect((await rows()).find((r) => r.amount === -400)).toMatchObject({ kind: 'reversed', order_id: orderId, order_item_id: orderItemId });
    await k.emit('promotions.redemption.reversed', { redemptionId, orderItemId, amount: USD(900), platformPart: USD(600), sellerPart: USD(300) });
    expect([await net('platform'), await net('seller')]).toEqual([0, 0]);
    // marketplace facts never land in Official Store trading
    expect(await repo().find('trading_entries', { ref_id: redemptionId })).toEqual([]);
  });

  it('books only platform-funded goodwill as a cost; seller-charged goodwill comes out of the seller earnings', async () => {
    const before = await expectLedgerMatches(k, S3);
    const ids = { platform: newId(), seller: newId(), refund: newId(), gift: newId() };
    const base = { customerId: newId(), caseId: newId(), orderId: newId() };
    await k.emit('wallet.credit.granted', { ...base, entryId: ids.platform, kind: 'goodwill', amount: USD(1_000), chargedTo: 'platform', sellerId: null });
    const seller = { ...base, entryId: ids.seller, kind: 'goodwill', amount: USD(700), chargedTo: 'seller', sellerId: S3 };
    await k.emit('wallet.credit.granted', seller);
    await k.emit('wallet.credit.granted', seller); // redelivered
    await k.emit('wallet.credit.granted', { ...base, entryId: ids.refund, kind: 'refund_to_credit', amount: USD(2_500), chargedTo: null, sellerId: null, caseId: null });
    await k.emit('wallet.credit.granted', { customerId: base.customerId, entryId: ids.gift, kind: 'gift_card_redeemed', amount: USD(5_000), chargedTo: null, sellerId: null, caseId: null, orderId: null });
    const costs = await repo().find('platform_costs', { kind: 'goodwill_credit', ref_id: Object.values(ids) });
    expect(costs.map((c) => [c.ref_id, c.amount])).toEqual([[ids.platform, 1_000]]);
    const liability = await repo().find('store_credit_liability', { wallet_entry_id: Object.values(ids) });
    expect(liability.every((r) => r.kind === 'granted')).toBe(true);
    expect(liability.reduce((s, r) => s + r.amount, 0)).toBe(1_000 + 700 + 2_500 + 5_000);
    expect((await expectLedgerMatches(k, S3)).total).toBe(before.total - 700);
    const adj = await k.call('GET', `${ADMIN}/adjustments?sellerId=${S3}`, k.staff);
    expect(adj.body.items).toEqual([expect.objectContaining({ reasonCode: 'goodwill', direction: 'debit', amount: USD(700) })]);
  });
});

describe('seller credits without an original charge (creditSeller), replayed on the ledger', () => {
  const S4 = newId();
  const repo = () => k.svc.core.repo;
  const lostUnit = (n: string) => ({ kind: 'fulfillment_service' as const, id: newId(), ref: `FS-CLAIM-${n}` });
  const claim1 = lostUnit('1');

  it('posts a credit up to creditSecondReviewerThreshold at once, once per key', async () => {
    const before = await expectLedgerMatches(k, S4);
    const input = { sellerId: S4, amount: USD(50_000), reason: 'Unit lost in the warehouse', reference: claim1, idempotencyKey: 'fs-lost-1' };
    const credit = await k.svc.creditSeller(input);
    expect(credit).toMatchObject({ sellerId: S4, status: 'posted', amount: USD(50_000), reference: claim1, approvalRequestId: null, requestedBy: { kind: 'system' }, ledgerEntry: { type: 'seller_credit', typeLabel: 'Credit from Marketly', amount: USD(50_000), bucket: 'available', reference: { kind: 'fulfillment_service', ref: 'FS-CLAIM-1' } } });
    expect(credit.decidedAt).toBeTruthy();
    const again = await k.svc.creditSeller({ ...input, amount: USD(1) }); // same key: the first credit
    expect(again).toMatchObject({ id: credit.id, amount: USD(50_000), ledgerEntry: { id: credit.ledgerEntry!.id } });
    expect((await expectLedgerMatches(k, S4)).available).toBe(before.available + 50_000);
    expect(k.of('finance.seller_credit.decided').filter((e) => e.creditId === credit.id)).toEqual([]); // nothing waited for approval
    expect(k.audits).toContainEqual(expect.objectContaining({ action: 'finance.seller_credit.post', target: expect.objectContaining({ type: 'seller_credit', id: credit.id, sellerId: S4 }) }));
    // the seller sees it with the adjustments
    const adj = await k.call('GET', `${SELLER}/ledger?type=adjustments`, k.sellerToken(S4));
    expect(adj.body.items).toEqual([expect.objectContaining({ type: 'seller_credit', amount: USD(50_000) })]);
  });

  it('rejects invalid credits', async () => {
    const base = { sellerId: S4, amount: USD(100), reason: 'Goodwill', reference: lostUnit('x'), idempotencyKey: newId() };
    await expect(k.svc.creditSeller({ ...base, sellerId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const bad of [{ amount: USD(0) }, { amount: USD(-5) }, { amount: { amount: 100, currency: 'EUR' } }, { reason: ' ' }, { idempotencyKey: '' }, { reference: { kind: 'nonsense', id: 'x' } }]) {
      await expect(k.svc.creditSeller({ ...base, ...(bad as object) } as never)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(await repo().count('seller_credits', { seller_id: S4 })).toBe(1);
  });

  it('waits for a Finance reviewer above the threshold, then posts once on approval', async () => {
    const before = await expectLedgerMatches(k, S4);
    const input = { sellerId: S4, amount: USD(50_001), reason: 'Pallet damaged on receipt', reference: lostUnit('2'), idempotencyKey: 'fs-lost-2' };
    const pending = await k.svc.creditSeller(input);
    expect(pending).toMatchObject({ status: 'pending_approval', ledgerEntry: null, decidedAt: null });
    expect(pending.approvalRequestId).toBeTruthy();
    expect(k.approvals.get(pending.approvalRequestId!)).toMatchObject({ action: 'finance.credits.issue', target: { type: 'seller_credit', id: pending.id, sellerId: S4 }, amount: USD(50_001) });
    expect((await k.svc.creditSeller(input)).id).toBe(pending.id);
    expect(await expectLedgerMatches(k, S4)).toEqual(before); // nothing posted yet

    await k.decide(pending.approvalRequestId!, 'approved');
    await k.decide(pending.approvalRequestId!, 'approved'); // redelivered
    const posted = (await repo().get('seller_credits', pending.id))!;
    expect(posted).toMatchObject({ status: 'posted' });
    expect(posted.ledger_entry_id).toBeTruthy();
    expect((await expectLedgerMatches(k, S4)).available).toBe(before.available + 50_001);
    const decided = k.of('finance.seller_credit.decided').filter((e) => e.creditId === pending.id);
    expect(decided).toEqual([{ creditId: pending.id, sellerId: S4, reference: input.reference, idempotencyKey: 'fs-lost-2', amount: USD(50_001), outcome: 'posted', ledgerEntryId: posted.ledger_entry_id }]);
    expect(await k.svc.creditSeller(input)).toMatchObject({ id: pending.id, status: 'posted', ledgerEntry: { id: posted.ledger_entry_id, recordedBy: { kind: 'staff' } } });
  });

  it('posts nothing when the credit is rejected', async () => {
    const before = await expectLedgerMatches(k, S4);
    const claim3 = lostUnit('3');
    const pending = await k.svc.creditSeller({ sellerId: S4, amount: USD(90_000), reason: 'Claimed lost units', reference: claim3, idempotencyKey: 'fs-lost-3' });
    await k.decide(pending.approvalRequestId!, 'rejected');
    expect(await k.svc.creditSeller({ sellerId: S4, amount: USD(90_000), reason: 'again', reference: claim3, idempotencyKey: 'fs-lost-3' })).toMatchObject({ id: pending.id, status: 'rejected', ledgerEntry: null });
    expect(k.of('finance.seller_credit.decided').filter((e) => e.creditId === pending.id)).toEqual([expect.objectContaining({ outcome: 'rejected', ledgerEntryId: null, amount: USD(90_000) })]);
    expect(await expectLedgerMatches(k, S4)).toEqual(before);
    // a later decision of the same request changes nothing
    await k.decide(pending.approvalRequestId!, 'approved');
    expect((await repo().get('seller_credits', pending.id))!.status).toBe('rejected');
    expect(await expectLedgerMatches(k, S4)).toEqual(before);
  });

  it('keeps the balances equal to the ledger entries through immediate and approved credits', async () => {
    const t = await expectLedgerMatches(k, S4);
    expect(t).toEqual({ total: 100_001, pending: 0, held: 0, available: 100_001 });
    const entries = await repo().find('ledger_entries', { seller_id: S4, type: 'seller_credit' });
    expect(entries.map((e) => e.amount).sort((a, b) => a - b)).toEqual([50_000, 50_001]);
    // the daily check finds no difference between the seller's balances and the ledger
    k.clock.advance(DAY);
    await k.app.kernel.jobs.runNow('finance.reconcile.daily');
    await k.app.kernel.events.drain();
    expect(await repo().count('recon_items', { check: 'seller_amounts', ref_id: S4 })).toBe(0);
  });
});
