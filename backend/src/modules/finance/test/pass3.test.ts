/**
 * Gap pass 3: store credit (wallet reversals, expiries and corrections; the daily store_credit check against
 * wallet.getLiabilityTotal; differences wallet reports with recordExternalDifference), credit-only captures in
 * the payments check, and seller credits read back and withdrawn by the module that asked for them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import { addDays, dayStart, detId } from '../domain/rules.js';
import { ADMIN, boot, expectLedgerMatches, USD, type Kit } from './helpers.js';

const DAY = 86_400_000;
const MODULES = withDependencies(['finance', 'audit', 'media', 'promotions', 'workqueues', 'reports', 'wallet']);

/** wallet.getLiabilityTotal answers what the test sets, and records the asOf it was asked for */
const walletTotals = { available: 0, held: 0, accounts: 0, asked: [] as (string | undefined)[] };

let k: Kit;
beforeAll(async () => {
  k = await boot({
    modules: MODULES,
    apiStubs: {
      wallet: {
        getLiabilityTotal: async (asOf?: string) => {
          walletTotals.asked.push(asOf);
          return { available: USD(walletTotals.available), held: USD(walletTotals.held), accounts: walletTotals.accounts };
        },
      },
    },
  });
});
afterAll(async () => {
  await k?.close();
});

const sumTrading = (refKind: string, refIds: string[]) => k.svc.core.repo.sum('trading_entries', 'amount', { ref_kind: refKind, ref_id: refIds });

describe('store credit from wallet events', () => {
  it('a reversed seller-charged goodwill grant credits the seller back exactly the charge, once, and lowers the liability', async () => {
    const S = newId();
    const grantEntryId = newId();
    const entryId = newId();
    const caseId = newId();
    const orderId = newId();
    await k.emit('wallet.credit.granted', { customerId: newId(), entryId: grantEntryId, kind: 'goodwill', amount: USD(1_750), chargedTo: 'seller', sellerId: S, caseId, orderId });
    expect(await expectLedgerMatches(k, S)).toMatchObject({ total: -1_750 });

    const reversed = { customerId: newId(), entryId, grantId: newId(), grantEntryId, amount: USD(1_750), chargedTo: 'seller', sellerId: S, caseId, orderId, reason: 'Seller was not at fault' };
    await k.emit('wallet.credit.reversed', reversed);
    await k.emit('wallet.credit.reversed', reversed); // redelivered
    expect(await expectLedgerMatches(k, S)).toMatchObject({ total: 0 });
    const adjustments = await k.svc.core.repo.find('adjustments', { seller_id: S }, { orderBy: [['created_at', 'asc']] });
    expect(adjustments.map((a) => [a.direction, a.amount, a.reason_code])).toEqual([
      ['debit', 1_750, 'goodwill'],
      ['credit', 1_750, 'goodwill'],
    ]);
    expect(k.of('finance.adjustment.recorded').filter((e) => e.sellerId === S).map((e) => [e.direction, e.amount])).toEqual([
      ['debit', USD(1_750)],
      ['credit', USD(1_750)],
    ]);
    // liability: +1,750 granted, −1,750 reversed; no platform goodwill cost for seller-funded credit
    expect(await sumTrading('wallet_liability', [grantEntryId, entryId])).toBe(0);
    expect(await sumTrading('wallet_credit', [grantEntryId, entryId])).toBe(0);
  });

  it('never credits the seller back more than was charged for the grant', async () => {
    const S = newId();
    const grantEntryId = newId();
    await k.emit('wallet.credit.granted', { customerId: newId(), entryId: grantEntryId, kind: 'goodwill', amount: USD(1_000), chargedTo: 'seller', sellerId: S, caseId: null, orderId: null });
    await k.emit('wallet.credit.reversed', { customerId: newId(), entryId: newId(), grantId: newId(), grantEntryId, amount: USD(1_200), chargedTo: 'seller', sellerId: S, caseId: null, orderId: null, reason: 'Mistake' });
    expect(await expectLedgerMatches(k, S)).toMatchObject({ total: 0 });
    // a reversal whose grant finance never charged credits nothing
    const T = newId();
    await k.emit('wallet.credit.reversed', { customerId: newId(), entryId: newId(), grantId: newId(), grantEntryId: newId(), amount: USD(900), chargedTo: 'seller', sellerId: T, caseId: null, orderId: null, reason: 'Mistake' });
    expect(await k.svc.core.repo.count('adjustments', { seller_id: T })).toBe(0);
  });

  it('a reversed platform grant lowers both the liability and the platform goodwill cost', async () => {
    const grantEntryId = newId();
    const entryId = newId();
    await k.emit('wallet.credit.granted', { customerId: newId(), entryId: grantEntryId, kind: 'goodwill', amount: USD(2_500), chargedTo: 'platform', sellerId: null, caseId: null, orderId: null });
    expect(await sumTrading('wallet_credit', [grantEntryId])).toBe(2_500);
    const reversed = { customerId: newId(), entryId, grantId: newId(), grantEntryId, amount: USD(2_500), chargedTo: 'platform', sellerId: null, caseId: null, orderId: null, reason: 'Wrong customer' };
    await k.emit('wallet.credit.reversed', reversed);
    await k.emit('wallet.credit.reversed', reversed);
    expect(await sumTrading('wallet_credit', [grantEntryId, entryId])).toBe(0);
    expect(await sumTrading('wallet_liability', [grantEntryId, entryId])).toBe(0);
  });

  it('expired credit lowers the liability and is platform breakage; corrections raise or lower it (each once)', async () => {
    const expiry = { customerId: newId(), entryId: newId(), lotId: newId(), source: 'goodwill', amount: USD(1_300) };
    await k.emit('wallet.credit.expired', expiry);
    await k.emit('wallet.credit.expired', expiry);
    expect(await sumTrading('wallet_liability', [expiry.entryId])).toBe(-1_300);
    expect(await sumTrading('wallet_breakage', [expiry.entryId])).toBe(-1_300);

    const up = { customerId: newId(), entryId: newId(), amount: USD(300), reason: 'Missed refund' };
    const down = { customerId: newId(), entryId: newId(), amount: USD(-200), reason: 'Duplicate credit' };
    for (const e of [up, up, down, down]) await k.emit('wallet.credit.corrected', e);
    expect(await sumTrading('wallet_liability', [up.entryId, down.entryId])).toBe(100);
    expect(await sumTrading('wallet_correction', [up.entryId, down.entryId])).toBe(100);
    // breakage and corrections are platform money, never Official Store trading
    const trading = await k.call('GET', `${ADMIN}/trading?from=${k.svc.core.today()}&to=${k.svc.core.today()}`, k.staff);
    expect(trading.status).toBe(200);
    expect(trading.body.productSales.amount).toBe(0);
  });
});

describe('credit-only captures in the payments check', () => {
  it('a capture of 0 on the card with the whole order paid by store credit matches the order total', async () => {
    const ord = k.order(newId(), [{ title: 'Lamp', quantity: 1, price: 4_500, shipping: 500 }]);
    const captureId = newId();
    await k.emit('payments.payment.captured', { intentId: newId(), captureId, orderId: ord.id, groupId: null, amount: USD(0), creditAmount: USD(5_000), allocations: [], providerRef: null, capturedAt: k.clock.now().toISOString() });
    const item = (await k.svc.core.repo.get('recon_items', detId(`capture:${captureId}`)))!;
    expect(item).toMatchObject({ check: 'payments_vs_orders', expected: 0, actual: 0, difference: 0, status: 'matched' });
    expect(k.of('finance.reconciliation.mismatch_found').filter((e) => e.itemId === item.id)).toEqual([]);

    // a group paid entirely by credit in a mixed order: card 0 for that group
    const mixed = k.order(newId(), [{ title: 'Chair', quantity: 2, price: 3_000 }]);
    const groupCapture = newId();
    await k.emit('payments.payment.captured', { intentId: newId(), captureId: groupCapture, orderId: mixed.id, groupId: mixed.groups[0]!.id, amount: USD(0), creditAmount: USD(6_000), allocations: [], providerRef: null, capturedAt: k.clock.now().toISOString() });
    expect(await k.svc.core.repo.get('recon_items', detId(`capture:${groupCapture}`))).toMatchObject({ expected: 0, actual: 0, difference: 0, status: 'matched' });

    // credit short of the total is still a mismatch of the exact difference
    const short = k.order(newId(), [{ title: 'Desk', quantity: 1, price: 8_000 }]);
    const shortCapture = newId();
    await k.emit('payments.payment.captured', { intentId: newId(), captureId: shortCapture, orderId: short.id, groupId: null, amount: USD(0), creditAmount: USD(7_500), allocations: [], providerRef: null, capturedAt: k.clock.now().toISOString() });
    expect(await k.svc.core.repo.get('recon_items', detId(`capture:${shortCapture}`))).toMatchObject({ expected: 500, actual: 0, difference: -500, status: 'open' });
  });
});

describe('recordExternalDifference (wallet balance check)', () => {
  it('opens one store_credit item per key, returns it again for the same key, and matches it when expected = actual', async () => {
    const key = `${newId()}:2026-10-10`;
    const input = { check: 'store_credit' as const, subject: 'Store credit account C1', description: 'Store credit balance $8.25 differs from its ledger sum $8.00', expected: USD(800), actual: USD(825), key };
    const item = await k.svc.recordExternalDifference(input);
    expect(item).toMatchObject({ check: 'store_credit', subject: 'Store credit account C1', expected: USD(800), actual: USD(825), difference: USD(25), status: 'open', date: k.svc.core.today() });
    const again = await k.svc.recordExternalDifference(input);
    expect(again.id).toBe(item.id);
    await k.app.kernel.events.drain();
    expect(k.of('finance.reconciliation.mismatch_found').filter((e) => e.itemId === item.id)).toEqual([{ itemId: item.id, check: 'store_credit', difference: USD(25) }]);

    const listed = await k.call('GET', `${ADMIN}/reconciliation/items?check=store_credit`, k.staff);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((i: { id: string }) => i.id)).toContain(item.id);
    const day = await k.call('GET', `${ADMIN}/reconciliation/days/${k.svc.core.today()}`, k.staff);
    expect(day.body.checklist.find((c: { key: string }) => c.key === 'store_credit_matched')).toMatchObject({ label: 'Store credit balances match the liability', note: expect.stringContaining('open') });
    expect(day.body.checklist.find((c: { key: string }) => c.key === 'store_credit_matched').state).not.toBe('done');

    const fixed = await k.svc.recordExternalDifference({ ...input, actual: USD(800) });
    expect(fixed).toMatchObject({ id: item.id, status: 'matched', difference: USD(0) });
    await k.app.kernel.events.drain();
    expect(k.of('finance.reconciliation.item_closed').filter((e) => e.itemId === item.id)).toEqual([{ itemId: item.id, check: 'store_credit', date: item.date, outcome: 'matched' }]);

    await expect(k.svc.recordExternalDifference({ ...input, key: '' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(k.svc.recordExternalDifference({ ...input, key: newId(), expected: { amount: 1, currency: 'EUR' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('seller credits read back and withdrawn (fulfillment-service)', () => {
  it('a pending credit is withdrawn (approval cancelled, nothing posted); a decision after it posts nothing; a posted credit cannot be withdrawn', async () => {
    const S = newId();
    const key = `fs-claim-${newId()}`;
    const pending = await k.svc.creditSeller({ sellerId: S, amount: USD(60_000), reason: 'Units lost in the warehouse', reference: { kind: 'fulfillment_service', id: newId(), ref: 'FS-CLAIM-9' }, idempotencyKey: key });
    expect(pending).toMatchObject({ status: 'pending_approval', amount: USD(60_000) });
    expect(await k.svc.getSellerCredit({ idempotencyKey: key })).toMatchObject({ id: pending.id, status: 'pending_approval' });
    expect(await k.svc.getSellerCredit({ creditId: pending.id })).toMatchObject({ id: pending.id });
    expect(await k.svc.getSellerCredit({ creditId: newId() })).toBeNull();

    const withdrawn = await k.svc.withdrawSellerCredit({ idempotencyKey: key, reason: 'The reimbursement was reversed' });
    expect(withdrawn).toMatchObject({ id: pending.id, status: 'withdrawn', ledgerEntry: null, decidedAt: expect.any(String) });
    expect(k.approvals.get(pending.approvalRequestId!)?.status).toBe('cancelled');
    expect(await k.svc.withdrawSellerCredit({ creditId: pending.id, reason: 'again' })).toMatchObject({ status: 'withdrawn' });

    await k.decide(pending.approvalRequestId!, 'approved');
    expect((await k.svc.getSellerCredit({ creditId: pending.id }))?.status).toBe('withdrawn');
    expect(await expectLedgerMatches(k, S)).toMatchObject({ total: 0 });
    expect(k.of('finance.seller_credit.decided').filter((e) => e.creditId === pending.id)).toEqual([]);

    const posted = await k.svc.creditSeller({ sellerId: S, amount: USD(10_000), reason: 'Damaged unit', reference: { kind: 'fulfillment_service', id: newId(), ref: 'FS-CLAIM-10' }, idempotencyKey: `fs-claim-${newId()}` });
    expect(posted.status).toBe('posted');
    await expect(k.svc.withdrawSellerCredit({ creditId: posted.id, reason: 'Too late' })).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect(await expectLedgerMatches(k, S)).toMatchObject({ total: 10_000 });
    await expect(k.svc.withdrawSellerCredit({ creditId: newId(), reason: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(k.svc.withdrawSellerCredit({ creditId: posted.id, reason: ' ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('daily store_credit check against wallet.getLiabilityTotal', () => {
  let d: Kit;
  const totals = { available: 0, held: 0, asked: [] as (string | undefined)[] };
  beforeAll(async () => {
    d = await boot({
      modules: MODULES,
      apiStubs: {
        wallet: {
          getLiabilityTotal: async (asOf?: string) => {
            totals.asked.push(asOf);
            return { available: USD(totals.available), held: USD(totals.held), accounts: 3 };
          },
        },
      },
    });
  });
  afterAll(async () => {
    await d?.close();
  });

  it('compares the liability booked up to the end of the day with wallet balances then; a difference is an open item of the exact amount', async () => {
    const tz = d.svc.core.tz();
    await d.emit('wallet.credit.granted', { customerId: newId(), entryId: newId(), kind: 'refund_to_credit', amount: USD(5_000), chargedTo: null, sellerId: null, caseId: null, orderId: newId() });
    await d.emit('wallet.credit.used', { customerId: newId(), orderId: newId(), amount: USD(1_200) });
    await d.emit('wallet.credit.expired', { customerId: newId(), entryId: newId(), lotId: newId(), source: 'refund', amount: USD(300) });
    await d.emit('wallet.credit.corrected', { customerId: newId(), entryId: newId(), amount: USD(100), reason: 'Missed refund' });
    const day1 = d.svc.core.today();
    // liability 5,000 − 1,200 − 300 + 100 = 3,600; wallet holds 3,000 available + 600 held
    totals.available = 3_000;
    totals.held = 600;
    d.clock.advance(DAY);
    await d.app.kernel.jobs.runNow('finance.reconcile.daily');
    await d.app.kernel.events.drain();
    expect(totals.asked.at(-1)).toBe(dayStart(addDays(day1, 1), tz).toISOString());
    expect(await d.svc.core.repo.get('recon_items', detId(`store_credit:${day1}`))).toMatchObject({ check: 'store_credit', expected: 3_600, actual: 3_600, difference: 0, status: 'matched' });

    // later credit (today) is not part of yesterday's check; the next day it is, and wallet shows 150 more
    await d.emit('wallet.credit.granted', { customerId: newId(), entryId: newId(), kind: 'gift_card_redeemed', amount: USD(1_000), chargedTo: null, sellerId: null, caseId: null, orderId: null });
    const day2 = d.svc.core.today();
    totals.available = 4_000;
    totals.held = 750;
    d.clock.advance(DAY);
    await d.app.kernel.jobs.runNow('finance.reconcile.daily');
    await d.app.kernel.events.drain();
    const item = (await d.svc.core.repo.get('recon_items', detId(`store_credit:${day2}`)))!;
    expect(item).toMatchObject({ check: 'store_credit', expected: 4_600, actual: 4_750, difference: 150, status: 'open' });
    expect(d.of('finance.reconciliation.mismatch_found').filter((e) => e.itemId === item.id)).toEqual([{ itemId: item.id, check: 'store_credit', difference: USD(150) }]);
    const view = await d.call('GET', `${ADMIN}/reconciliation/days/${day2}`, d.staff);
    expect(view.body.checklist.find((c: { key: string }) => c.key === 'store_credit_matched').state).not.toBe('done');
  });
});
