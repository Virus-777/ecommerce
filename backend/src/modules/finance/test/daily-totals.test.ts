/**
 * Daily totals for the reports finance facts (docs/09 §3.2): ledger totals per seller, day and type; company money
 * per day (trading, platform costs, marketplace discount funding); fee charges changed since an instant; end-of-day
 * seller balances rebuilt from the ledger; and the data migration that fills fee_charges.changed_at.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { feeChargesChangedAt } from '../migrations.js';
import { ADMIN, boot, expectLedgerMatches, SELLER, USD, type FakeOrder, type Kit } from './helpers.js';

const DAY = 86_400_000;
let k: Kit;
const S = newId();
let d0: string;
let order: FakeOrder;
let official: FakeOrder;
const idem = () => ({ 'idempotency-key': newId() });

beforeAll(async () => {
  k = await boot();
  d0 = k.svc.core.today();
  // a seller order of two items (10% fee, shipping not in the fee basis) and an Official Store order
  order = k.order(S, [
    { title: 'Lamp', quantity: 1, price: 10_000, shipping: 500 },
    { title: 'Shade', quantity: 2, price: 1_500 },
  ]);
  official = k.order(null, [{ title: 'Kettle', quantity: 1, price: 4_000, shipping: 300, platformDiscount: 400 }]);
  await k.accept(order);
  await k.accept(official);
});
afterAll(async () => {
  await k?.close();
});

describe('ledgerDailyTotals', () => {
  it('sums the ledger per seller, market day and type, signed as in the ledger, with counts', async () => {
    const rows = await k.svc.ledgerDailyTotals({ from: d0, to: d0 });
    const mine = rows.filter((r) => r.sellerId === S);
    expect(mine).toEqual(
      expect.arrayContaining([
        { sellerId: S, day: d0, type: 'sale', amount: USD(13_000), count: 2 },
        { sellerId: S, day: d0, type: 'shipping_charge', amount: USD(500), count: 1 },
        { sellerId: S, day: d0, type: 'marketplace_fee', amount: USD(-1_300), count: 2 },
      ]),
    );
    expect(mine).toHaveLength(3);
  });

  it('filters one seller and refuses a backwards range', async () => {
    expect((await k.svc.ledgerDailyTotals({ from: d0, to: d0, sellerId: newId() }))).toEqual([]);
    expect((await k.svc.ledgerDailyTotals({ from: d0, to: d0, sellerId: S })).every((r) => r.sellerId === S)).toBe(true);
    await expect(k.svc.ledgerDailyTotals({ from: d0, to: '2020-01-01' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('companyDailyTotals', () => {
  it('gives trading by kind, platform costs by kind and discount funding on marketplace items only', async () => {
    const repo = k.svc.core.repo;
    const at = k.clock.now();
    await k.svc.recordCompanyCost({ kind: 'buying_cost', amount: USD(2_500), reference: { kind: 'order', id: official.id }, at: at.toISOString() });
    await repo.insert('platform_costs', { id: newId(), at, kind: 'label', amount: 700, currency: 'USD', order_id: order.id, order_item_id: null, ref_kind: 'label', ref_id: newId() });
    const funding = (orderItemId: string | null, fundedBy: 'platform' | 'seller', amount: number) => repo.insert('discount_funding', { id: newId(), at, redemption_id: newId(), funded_by: fundedBy, kind: 'redeemed', amount, currency: 'USD', order_id: null, order_item_id: orderItemId });
    await funding(order.groups[0]!.items[0]!.id, 'platform', 200); // a seller item: counted
    await funding(official.groups[0]!.items[0]!.id, 'platform', 400); // an Official Store item: in the trading discount already
    await funding(null, 'seller', 100); // no item: counted
    const rows = await k.svc.companyDailyTotals({ from: d0, to: d0 });
    const get = (source: string, kind: string) => rows.find((r) => r.source === source && r.kind === kind)?.amount.amount;
    expect(get('trading', 'sale')).toBe(4_000);
    expect(get('trading', 'discount')).toBe(400);
    expect(get('trading', 'shipping_expense')).toBe(-300);
    expect(get('trading', 'buying_cost')).toBe(2_500);
    expect(get('platform_cost', 'label')).toBe(700);
    expect(get('discount_funding', 'platform')).toBe(200);
    expect(get('discount_funding', 'seller')).toBe(100);
    expect(rows.every((r) => r.day === d0)).toBe(true);
  });
});

describe('itemFeesChangedSince', () => {
  it('pages fee charges by change time and shows a later fee refund after the last cursor', async () => {
    const since = new Date(k.clock.now().getTime() - DAY).toISOString();
    const first = await k.svc.itemFeesChangedSince({ since, limit: 1 });
    expect(first).toHaveLength(1);
    const rest = await k.svc.itemFeesChangedSince({ since, after: first[0]!.cursor, limit: 10 });
    const all = [...first, ...rest];
    expect(all.map((r) => r.orderItemId).sort()).toEqual(order.groups[0]!.items.map((i) => i.id).sort());
    expect(all.find((r) => r.orderItemId === order.groups[0]!.items[0]!.id)).toMatchObject({ sellerId: S, fee: USD(1_000), refundedFee: USD(0) });
    const cursor = all.at(-1)!.cursor;
    expect(await k.svc.itemFeesChangedSince({ since, after: cursor, limit: 10 })).toEqual([]);

    // the second item is cancelled before dispatch: its fee is refunded and it shows up again after the cursor
    k.clock.advance(60_000);
    const item = order.groups[0]!.items[1]!;
    await k.emit('orders.item.cancelled', { orderId: order.id, ref: order.ref, groupId: order.groups[0]!.id, ownerType: 'seller', sellerId: S, fulfilledBy: 'seller', itemId: item.id, offerId: newId(), stockItemId: newId(), quantity: 2, cancellationId: newId(), initiatedBy: 'customer', reasonCode: 'changed_mind', beforeDispatch: true, countsAgainstSeller: false, refund: { itemAmount: USD(3_000), discountShare: USD(0), shippingRefund: USD(0), taxRefund: USD(0), total: USD(3_000) }, paymentIntentId: newId(), trustReportId: null, notifyCustomer: true });
    const changed = await k.svc.itemFeesChangedSince({ since, after: cursor, limit: 10 });
    expect(changed).toEqual([expect.objectContaining({ orderItemId: item.id, fee: USD(300), refundedFee: USD(300) })]);
  });

  it('refuses a cursor it did not write', async () => {
    await expect(k.svc.itemFeesChangedSince({ since: new Date().toISOString(), after: 'not-a-cursor', limit: 5 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('sellerBalancesByDay', () => {
  it('rebuilds each end of day from the ledger: pending until the lot is released, then available and held', async () => {
    // day 1: delivered; earnings become available after the hold window, on the day the job runs
    k.clock.advance(DAY);
    await k.deliver(order, [order.groups[0]!.items[0]!.id]);
    k.clock.advance(8 * DAY);
    await k.app.kernel.jobs.runNow('finance.release-pending');
    const d9 = k.svc.core.today();
    const credit = await k.call('POST', `${ADMIN}/adjustments`, k.staff, { sellerId: S, direction: 'credit', amount: USD(300), reasonCode: 'goodwill', reason: 'Late carrier pickup' }, idem());
    expect(credit.status, JSON.stringify(credit.body)).toBe(201);
    const hold = await k.call('POST', `${ADMIN}/holds`, k.staff, { sellerId: S, amount: USD(1_000), reasonCode: 'delivery_unconfirmed', reason: 'Carrier shows no scan', reviewDate: d9 }, idem());
    expect(hold.status, JSON.stringify(hold.body)).toBe(201);

    const live = await expectLedgerMatches(k, S);
    expect(live).toMatchObject({ pending: 0, held: 1_000, available: 9_500 + 300 - 1_000 });
    const rows = (await k.svc.sellerBalancesByDay({ from: d0, to: d9 })).filter((r) => r.sellerId === S);
    // every day from the order day to the day before the release: the lot was pending (the cancelled item left nothing).
    // The clock moved 9 x 24 h, which is nine market days only when no DST change falls in the span: in the week
    // before one, 9 x 24 h started just after local midnight lands at 23:00 the day before. Count what d0..d9 holds.
    const spanDays = Math.round((Date.parse(`${d9}T00:00:00Z`) - Date.parse(`${d0}T00:00:00Z`)) / DAY) + 1;
    expect(rows).toHaveLength(spanDays);
    for (const r of rows.slice(0, -1)) expect(r).toMatchObject({ pending: USD(9_500), available: USD(0), held: USD(0), owed: USD(0) });
    // today: the live balances
    expect(rows.at(-1)).toEqual({ day: d9, sellerId: S, pending: USD(live.pending), available: USD(live.available), held: USD(live.held), owed: USD(0) });
    const bal = await k.call('GET', `${SELLER}/balances`, k.sellerToken(S));
    expect(bal.body).toMatchObject({ pending: USD(0), available: USD(live.available), held: USD(1_000) });
  });

  it('leaves out days after today and days before the seller had money', async () => {
    const today = k.svc.core.today();
    const rows = await k.svc.sellerBalancesByDay({ from: today, to: '2099-01-01' });
    expect(rows.every((r) => r.day === today)).toBe(true);
    const before = await k.svc.sellerBalancesByDay({ from: '2020-01-01', to: '2020-01-05' });
    expect(before.filter((r) => r.sellerId === S)).toEqual([]);
  });

  it('owed is a negative available balance as a positive amount', async () => {
    const T = newId();
    const debit = await k.call('POST', `${ADMIN}/adjustments`, k.staff, { sellerId: T, direction: 'debit', amount: USD(450), reasonCode: 'other', reason: 'Return label' }, idem());
    expect(debit.status, JSON.stringify(debit.body)).toBe(201);
    const today = k.svc.core.today();
    const [row] = (await k.svc.sellerBalancesByDay({ from: today, to: today })).filter((r) => r.sellerId === T);
    expect(row).toMatchObject({ available: USD(-450), owed: USD(450) });
  });
});

describe('fee_charges.changed_at migration', () => {
  it('fills changed_at from created_at on charges written before it existed, and is safe to run again', async () => {
    const db = k.app.kernel.mongo.db;
    const id = newId();
    const created = new Date('2026-09-01T10:00:00Z');
    await db.collection('finance.fee_charges').insertOne({ _id: id as never, order_item_id: newId(), seller_id: S, rule_set_id: newId(), basis_amount: 100, rate_bps: 1000, fee: 10, refunded_fee: 0, status: 'charged', created_at: created });
    await feeChargesChangedAt.up(db);
    await feeChargesChangedAt.up(db);
    expect((await db.collection('finance.fee_charges').findOne({ _id: id as never }))?.changed_at).toEqual(created);
    const rows = await k.svc.itemFeesChangedSince({ since: '2026-08-31T00:00:00Z', limit: 1 });
    expect(rows[0]).toMatchObject({ changedAt: created.toISOString() });
  });
});
