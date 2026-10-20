/**
 * The finance facts (docs/09 §3.3) from the real finance module: reports.pull-finance-recent fills
 * fact_order_items.fee_minor, the ledger columns of fact_marketplace_finance_daily (fee income the same day),
 * fact_company_daily and fact_seller_balances_daily; running it again changes nothing; a rebuild restores them; the
 * data migration gives older finance rows the new columns.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/reports.js';
import type * as orders from '../../../spec/orders.js';
import { financeDailyLedgerColumns } from '../migrations.js';
import { schemas } from '../schema.js';
import { harness, usd, type Harness } from './harness.js';

let h: Harness;
const S = newId();
let today: string;
let sellerOrder: orders.OrderDetail;
let officialOrder: orders.OrderDetail;
const table = (name: string) => h.app.kernel.mongo.module('reports', spec.collections, schemas).table<any>(name);
const pullRecent = async () => {
  await h.app.kernel.jobs.runNow('reports.pull-finance-recent');
  await h.drain();
};

beforeAll(async () => {
  h = await harness();
  today = await h.service.core.today();
  sellerOrder = h.order({ sellerId: S, items: [{ unit: 10_000, shipping: 500, tax: 0 }] });
  officialOrder = h.order({ sellerId: null, items: [{ unit: 4_000, shipping: 300, tax: 0 }] });
  h.accepted(sellerOrder);
  h.accepted(officialOrder);
  await h.drain();
});
afterAll(async () => {
  await h?.app.close();
});

describe('reports.pull-finance-recent', () => {
  it('fills the fee of each seller item, the ledger columns, company money and end-of-day balances', async () => {
    await pullRecent();
    const item = await table('fact_order_items').findOne({ order_item_id: sellerOrder.groups[0]!.items[0]!.id });
    expect(item).toMatchObject({ fee_minor: 1_000, owner_type: 'seller' });
    expect((await table('fact_order_items').findOne({ order_item_id: officialOrder.groups[0]!.items[0]!.id }))?.fee_minor).toBeNull();
    const daily = await table('fact_marketplace_finance_daily').findOne({ seller_id: S, day: today });
    expect(daily).toMatchObject({ fee_gross_minor: 1_000, fee_refunds_minor: 0, fee_income_minor: 1_000, shipping_charged_minor: 500, refunds_minor: 0, adjustments_minor: 0 });
    const company = await table('fact_company_daily').find({ day: today, source: 'trading' });
    expect(Object.fromEntries(company.map((c: { kind: string; amount_minor: number }) => [c.kind, c.amount_minor]))).toMatchObject({ sale: 4_000, shipping_expense: -300 });
    expect(await table('fact_seller_balances_daily').findOne({ seller_id: S, day: today })).toMatchObject({ pending_minor: 9_500, available_minor: 0, held_minor: 0, owed_minor: 0 });
    expect((await h.service.core.repo.getCheckpoint('pull:finance_recent'))?.last_event_at).toBeInstanceOf(Date);
  });

  it('is safe to run twice: values are set, never added', async () => {
    await pullRecent();
    await pullRecent();
    expect(await table('fact_marketplace_finance_daily').findOne({ seller_id: S, day: today })).toMatchObject({ fee_gross_minor: 1_000, shipping_charged_minor: 500, fee_income_minor: 1_000 });
    expect(await table('fact_company_daily').count({ day: today, source: 'trading', kind: 'sale' })).toBe(1);
    expect((await table('fact_company_daily').findOne({ day: today, source: 'trading', kind: 'sale' })).amount_minor).toBe(4_000);
    expect(await table('fact_seller_balances_daily').count({ seller_id: S, day: today })).toBe(1);
  });

  it('picks up a later fee refund and a credit; the fee pull reads only what changed since', async () => {
    const item = sellerOrder.groups[0]!.items[0]!;
    h.publish('orders', 'orders.item.cancelled', { orderId: sellerOrder.id, ref: sellerOrder.ref, groupId: sellerOrder.groups[0]!.id, ownerType: 'seller', sellerId: S, fulfilledBy: 'seller', itemId: item.id, offerId: item.offer.offerId, stockItemId: item.stockItemId, quantity: 1, cancellationId: newId(), initiatedBy: 'customer', reasonCode: 'changed_mind', beforeDispatch: true, countsAgainstSeller: false, refund: { itemAmount: usd(10_000), discountShare: usd(0), shippingRefund: usd(500), taxRefund: usd(0), total: usd(10_500) }, paymentIntentId: newId(), trustReportId: null, notifyCustomer: true });
    await h.drain();
    const finance = h.app.kernel.boot.apis.get('finance') as any;
    await finance.creditSeller({ sellerId: S, amount: usd(250), reason: 'Goodwill', reference: { kind: 'seller', id: S }, idempotencyKey: newId() });
    await pullRecent();
    expect((await table('fact_order_items').findOne({ order_item_id: item.id })).fee_minor).toBe(0);
    expect(await table('fact_marketplace_finance_daily').findOne({ seller_id: S, day: today })).toMatchObject({ fee_gross_minor: 1_000, fee_refunds_minor: 1_000, fee_income_minor: 0, adjustments_minor: 250 });
    // the item is cancelled: its lot is reversed and what it kept (the 5.00 shipping, as the order still shows the
    // package as not cancelled) moved to available with the credit
    expect(await table('fact_seller_balances_daily').findOne({ seller_id: S, day: today })).toMatchObject({ pending_minor: 0, available_minor: 750 });
    const cursor = await h.service.core.repo.getCheckpoint('cursor:item_fees');
    expect(cursor?.last_event_id).toMatch(/\|/);
  });

  it('a rebuild pulls the finance facts again', async () => {
    await table('fact_company_daily').deleteMany({});
    await table('fact_seller_balances_daily').deleteMany({});
    await h.service.core.repo.updateOrderItems({ orderId: sellerOrder.id }, { fee_minor: null });
    const token = h.tokens.staff();
    for (const key of ['company_finance', 'seller_balances', 'order_items']) {
      const res = await h.call('POST', `/api/admin/reports/read-models/${key}/rebuild`, token, { reason: 'Test rebuild' });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
    }
    await h.app.kernel.jobs.runNow('reports.check-lag'); // runs the rebuilds
    expect((await table('fact_company_daily').findOne({ day: today, source: 'trading', kind: 'sale' })).amount_minor).toBe(4_000);
    expect(await table('fact_seller_balances_daily').findOne({ seller_id: S, day: today })).toMatchObject({ available_minor: 750 });
    expect((await table('fact_order_items').findOne({ order_item_id: sellerOrder.groups[0]!.items[0]!.id })).fee_minor).toBe(0);
    const status = await h.call('GET', '/api/admin/reports/read-models', token);
    const keys = status.body.map((m: { key: string }) => m.key);
    expect(keys).toEqual(expect.arrayContaining(['company_finance', 'seller_balances']));
    expect(status.body.find((m: { key: string }) => m.key === 'seller_balances')).toMatchObject({ state: 'live', rebuildable: true });
  });
});

describe('migration of the finance daily facts', () => {
  it('gives rows written before the ledger columns zeros, and is safe to run again', async () => {
    const db = h.app.kernel.mongo.db;
    const seller = newId();
    // a row as the collection held it before (bypassing the validator, as the old one allowed it)
    await db.collection('reports.fact_marketplace_finance_daily').insertOne({ seller_id: seller, day: '2026-01-05', seller_sales_minor: 100, fee_income_minor: 10, platform_discount_minor: 0, seller_discount_minor: 0, held_minor: 0, payouts_paid_minor: 0, payouts_failed: 0, owed_minor: 0, ad_charges_minor: 0, service_fees_minor: 0 }, { bypassDocumentValidation: true });
    await financeDailyLedgerColumns.up(db);
    await financeDailyLedgerColumns.up(db);
    expect(await db.collection('reports.fact_marketplace_finance_daily').findOne({ seller_id: seller })).toMatchObject({ fee_income_minor: 10, fee_gross_minor: 0, fee_refunds_minor: 0, refunds_minor: 0, shipping_charged_minor: 0, label_charges_minor: 0, adjustments_minor: 0, chargebacks_minor: 0 });
    // the row now passes the validator on an update (an event adding a payout)
    await h.service.core.repo.bumpDaily('fact_marketplace_finance_daily', { seller_id: seller, day: '2026-01-05' }, { payouts_paid_minor: 500 });
    expect((await db.collection('reports.fact_marketplace_finance_daily').findOne({ seller_id: seller }))?.payouts_paid_minor).toBe(500);
  });
});
