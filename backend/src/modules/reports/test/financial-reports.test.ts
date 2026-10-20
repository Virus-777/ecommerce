/**
 * The financial statistics reports (docs/09 §3.3) on the real finance module: Earnings and profit and Profit by
 * product (seller), Platform income, Seller balances and payouts and Official Store profit and loss (staff).
 * Reconciliations: a seller's net earnings equal its ledger entries for the period's orders and charges (payouts
 * excluded); trading.pnl gives the same figures as GET /api/admin/finance/trading. Audience: a seller only ever sees
 * its own figures, the seller reports need finance.balances.view, and seller unit costs never reach a staff report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type * as orders from '../../../spec/orders.js';
import type { FinanceService } from '../../finance/service.js';
import { harness, usd, type Harness } from './harness.js';

let h: Harness;
let finance: FinanceService;
let today: string;
const S = newId(); // the seller of the reconciliation
const T = newId(); // another seller
const CATEGORY = newId();
const PRODUCT_A = newId();
const PRODUCT_B = newId();
const OFFER_A = newId();
const OFFER_B = newId();
let o1: orders.OrderDetail;
let o2: orders.OrderDetail;
let other: orders.OrderDetail;
let official: orders.OrderDetail;

const SELLER_Q = (key: string) => `/api/seller/reports/reports/${key}/query`;
const ADMIN_Q = (key: string) => `/api/admin/reports/reports/${key}/query`;
const kpi = (body: any, key: string) => body.kpis.find((k: { metricKey: string }) => k.metricKey === key);
const pull = async () => {
  await h.drain();
  await h.app.kernel.jobs.runNow('reports.pull-finance-recent');
  await h.drain();
};
const delivered = (d: orders.OrderDetail) => {
  const g = d.groups[0]!;
  for (const i of g.items) h.publish('orders', 'orders.item.delivered', { orderId: d.id, groupId: g.id, ownerType: g.seller.ownerType, sellerId: g.seller.id ?? null, itemId: i.id, quantity: i.quantity, deliveredAt: h.clock.now().toISOString(), returnWindowEndsAt: new Date(h.clock.now().getTime() + 30 * 86_400_000).toISOString() });
};

beforeAll(async () => {
  h = await harness();
  finance = h.app.kernel.boot.apis.get('finance') as unknown as FinanceService;
  today = await h.service.core.today();
  h.products.set(PRODUCT_A, { title: 'Brass lamp' });
  h.products.set(PRODUCT_B, { title: 'Linen shade' });
  // S: two orders, a seller-funded discount on one and a Marketly-funded discount on the other, both delivered
  o1 = h.order({ sellerId: S, items: [{ productId: PRODUCT_A, offerId: OFFER_A, unit: 10_000, shipping: 500, tax: 0, categoryId: CATEGORY, discount: { amount: 1_000, fundedBy: 'seller' } }] });
  o2 = h.order({ sellerId: S, items: [{ productId: PRODUCT_B, offerId: OFFER_B, unit: 4_000, quantity: 2, shipping: 0, tax: 0, categoryId: CATEGORY, discount: { amount: 500, fundedBy: 'platform' } }] });
  other = h.order({ sellerId: T, items: [{ unit: 3_000, shipping: 0, tax: 0 }] });
  official = h.order({ sellerId: null, items: [{ unit: 6_000, shipping: 400, tax: 0, discount: { amount: 600, fundedBy: 'platform' } }] });
  for (const d of [o1, o2, other, official]) h.accepted(d);
  await h.drain();
  for (const d of [o1, o2]) delivered(d);
  // S's charges: an ad charge, a Fulfilled by Marketly fee, a shipping label and a credit from Marketly
  const campaignId = newId();
  await finance.recordAdCharge({ sellerId: S, campaignId, campaignRef: 'AD-7', period: { from: today, to: today }, amount: usd(1_200), description: 'Ads' });
  h.publish('advertising', 'advertising.charge.posted', { chargeId: newId(), sellerId: S, campaignId, day: today, amount: usd(1_200) });
  await finance.recordServiceFee({ sellerId: S, amount: usd(300), kind: 'storage', reference: { kind: 'seller', id: S }, description: 'Storage', idempotencyKey: newId() });
  h.publish('fulfillment-service', 'fulfillment-service.fee.charged', { chargeId: newId(), sellerId: S, type: 'storage', amount: usd(300), reference: null, period: null });
  h.publish('shipping', 'shipping.label.purchased', { labelId: newId(), shipmentId: null, orderId: o1.id, groupId: o1.groups[0]!.id, sellerId: S, billedTo: 'seller', cost: usd(650), kind: 'outbound', returnId: null });
  await finance.creditSeller({ sellerId: S, amount: usd(250), reason: 'Late pickup', reference: { kind: 'seller', id: S }, idempotencyKey: newId() });
  // platform money: a label Marketly pays and Marketly-funded coupon money on S's item
  h.publish('shipping', 'shipping.label.purchased', { labelId: newId(), shipmentId: null, orderId: other.id, groupId: other.groups[0]!.id, sellerId: T, billedTo: 'platform', cost: usd(700), kind: 'outbound', returnId: null });
  await h.drain();
  await finance.core.repo.insert('discount_funding', { id: newId(), at: h.clock.now(), redemption_id: newId(), funded_by: 'platform', kind: 'redeemed', amount: 500, currency: 'USD', order_id: o2.id, order_item_id: o2.groups[0]!.items[0]!.id });
  // Official Store costs
  await finance.recordCompanyCost({ kind: 'buying_cost', amount: usd(3_100), reference: { kind: 'order', id: official.id }, at: h.clock.now().toISOString() });
  await finance.recordCompanyCost({ kind: 'write_off', amount: usd(200), reference: { kind: 'order', id: official.id }, at: h.clock.now().toISOString() });
  await finance.recordCompanyCost({ kind: 'supplier_credit', amount: usd(150), reference: { kind: 'order', id: official.id }, at: h.clock.now().toISOString() });
  // S has a unit cost on offer A only (2,000 per unit): its seller costs, private to S
  await h.service.core.repo.updateOrderItems({ itemIds: [o1.groups[0]!.items[0]!.id] }, { buying_cost_minor: 2_000 });
  await pull();
});
afterAll(async () => {
  await h?.app.close();
});

describe('seller.earnings', () => {
  it('reconciles: net earnings equal the seller ledger for the period orders and charges (payouts excluded)', async () => {
    const res = await h.call('POST', SELLER_Q('seller.earnings'), h.tokens.seller(S), { preset: 'today' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const entries = await finance.core.repo.find('ledger_entries', { seller_id: S });
    const notEarnings = new Set(['payout', 'payout_returned', 'hold', 'hold_release', 'owed_offset']);
    const ledger = entries.filter((e) => !notEarnings.has(e.type)).reduce((n, e) => n + e.amount, 0);
    expect(ledger).toBe(9_000 + 500 - 900 + 8_000 - 800 - 1_200 - 300 - 650 + 250);
    expect(kpi(res.body, 'seller.net_earnings').value).toBe(ledger);
    expect(kpi(res.body, 'seller.item_sales').value).toBe(9_000 + 7_500 + 500); // Marketly-funded discount paid to the seller
    expect(kpi(res.body, 'seller.shipping_charged').value).toBe(500);
    expect(kpi(res.body, 'seller.fees').value).toBe(1_700);
    expect(kpi(res.body, 'seller.ad_spend').value).toBe(1_200);
    expect(kpi(res.body, 'seller.service_fees').value).toBe(300);
    expect(kpi(res.body, 'seller.label_charges').value).toBe(650);
    expect(kpi(res.body, 'seller.adjustments').value).toBe(250);
  });

  it('profit, margin and cost coverage count the sales that have a cost', async () => {
    const res = await h.call('POST', SELLER_Q('seller.earnings'), h.tokens.seller(S), { preset: 'today' });
    const net = kpi(res.body, 'seller.net_earnings').value;
    expect(kpi(res.body, 'seller.product_cost').value).toBe(2_000);
    expect(kpi(res.body, 'seller.profit').value).toBe(net - 2_000);
    expect(kpi(res.body, 'seller.margin_pct').value).toBe(Math.round(((net - 2_000) / 9_000) * 1000) / 10);
    expect(kpi(res.body, 'seller.cost_coverage_pct').value).toBe(Math.round((9_000 / 17_000) * 1000) / 10);
    expect(res.body.callouts.map((c: { title: string }) => c.title)).toEqual(['Two dates', 'Some sales have no unit cost']);
  });

  it('has every series, the waterfall, fees by type and a period table; a comparison adds the twins', async () => {
    const res = await h.call('POST', SELLER_Q('seller.earnings'), h.tokens.seller(S), { preset: 'last_7_days', compare: 'previous_period' });
    const keys = ['seller.item_sales', 'seller.shipping_charged', 'seller.refunds', 'seller.fees', 'seller.ad_spend', 'seller.service_fees', 'seller.label_charges', 'seller.adjustments', 'seller.net_earnings', 'seller.product_cost', 'seller.profit', 'seller.margin_pct', 'seller.paid_out'];
    expect(res.body.series.map((s: { key: string }) => s.key)).toEqual([...keys, ...keys.map((k) => `${k}:compare`)]);
    expect(res.body.kpis.map((k: { metricKey: string }) => k.metricKey)).toEqual([...keys, 'seller.cost_coverage_pct']);
    const waterfall = res.body.breakdowns.find((b: { key: string }) => b.key === 'waterfall').rows;
    expect(waterfall.map((r: { key: string; step: string }) => `${r.key}:${r.step}`)).toEqual([
      'seller.item_sales:start', 'seller.shipping_charged:plus', 'seller.refunds:plus', 'seller.fees:minus', 'seller.ad_spend:minus', 'seller.service_fees:minus', 'seller.label_charges:minus', 'seller.adjustments:plus', 'seller.net_earnings:total', 'seller.product_cost:minus', 'seller.profit:total',
    ]);
    // the steps add up to the totals
    const value = (r: { amount: { amount: number }; step: string }) => (r.step === 'minus' ? -r.amount.amount : r.amount.amount);
    expect(waterfall.slice(0, 8).reduce((n: number, r: any) => n + value(r), 0)).toBe(waterfall[8].amount.amount);
    expect(waterfall[8].amount.amount + value(waterfall[9])).toBe(waterfall[10].amount.amount);
    expect(res.body.breakdowns.find((b: { key: string }) => b.key === 'fees_by_type').rows.map((r: { key: string }) => r.key)).toEqual(['seller.fees', 'seller.ad_spend', 'seller.service_fees', 'seller.label_charges']);
    expect(res.body.table.columns.map((c: { key: string }) => c.key)).toEqual(['period', ...keys.map((k) => k.slice(7))]);
    expect(res.body.table.rows).toHaveLength(7);
    expect(res.body.table.totals.net_earnings.amount).toBe(kpi(res.body, 'seller.net_earnings').value);
  });
});

describe('seller.profit_by_product', () => {
  it('lists each product with its profit when it has a cost, and counts the products without one', async () => {
    const res = await h.call('POST', SELLER_Q('seller.profit_by_product'), h.tokens.seller(S), { preset: 'today' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body.table.rows;
    const a = rows.find((r: { offerId: string }) => r.offerId === OFFER_A);
    const b = rows.find((r: { offerId: string }) => r.offerId === OFFER_B);
    expect(a).toMatchObject({ productId: PRODUCT_A, product: 'Brass lamp', units: 1, itemSales: usd(9_000), refunds: usd(0), fees: usd(900), productCost: usd(2_000), profit: usd(6_100), marginPct: 67.8, costSet: true });
    expect(b).toMatchObject({ productId: PRODUCT_B, product: 'Linen shade', units: 2, itemSales: usd(8_000), fees: usd(800), profit: null, marginPct: null, costSet: false });
    expect(kpi(res.body, 'seller.profit').value).toBe(6_100);
    expect(kpi(res.body, 'seller.products_without_cost').value).toBe(1);
    expect(kpi(res.body, 'seller.sales_without_cost').value).toBe(8_000);
    expect(res.body.breakdowns.map((x: { key: string }) => x.key)).toEqual(['top_profit', 'lowest_profit']);
    expect(res.body.breakdowns[0].rows).toEqual([expect.objectContaining({ key: OFFER_A, label: 'Brass lamp', amount: usd(6_100) })]);
    expect(res.body.callouts.map((c: { title: string }) => c.title)).toContain('Products without a cost');
  });

  it('filters by product', async () => {
    const res = await h.call('POST', SELLER_Q('seller.profit_by_product'), h.tokens.seller(S), { preset: 'today', productId: PRODUCT_B });
    expect(res.body.table.rows.map((r: { offerId: string }) => r.offerId)).toEqual([OFFER_B]);
  });
});

describe('who sees what', () => {
  it('the seller reports need finance.balances.view and the catalogue leaves them out without it', async () => {
    const limited = h.tokens.seller(S, ['reports.seller.view']);
    expect((await h.call('POST', SELLER_Q('seller.earnings'), limited, { preset: 'today' })).status).toBe(403);
    expect((await h.call('POST', SELLER_Q('seller.profit_by_product'), limited, { preset: 'today' })).status).toBe(403);
    const keys = (await h.call('GET', '/api/seller/reports/catalogue', limited)).body.map((r: { key: string }) => r.key);
    expect(keys).not.toContain('seller.earnings');
    // finance.balances.view is owner-only (finance spec): the store owner has it
    const allowed = h.tokens.seller(S);
    expect((await h.call('POST', SELLER_Q('seller.earnings'), allowed, { preset: 'today' })).status).toBe(200);
    expect((await h.call('GET', '/api/seller/reports/catalogue', allowed)).body.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['seller.earnings', 'seller.profit_by_product']));
  });

  it('a seller only ever sees its own figures', async () => {
    const theirs = await h.call('POST', SELLER_Q('seller.earnings'), h.tokens.seller(T), { preset: 'today' });
    expect(kpi(theirs.body, 'seller.item_sales').value).toBe(3_000);
    expect(kpi(theirs.body, 'seller.product_cost').value).toBe(0);
    expect(kpi(theirs.body, 'seller.ad_spend').value).toBe(0);
    const products = await h.call('POST', SELLER_Q('seller.profit_by_product'), h.tokens.seller(T), { preset: 'today' });
    expect(products.body.table.rows.map((r: { offerId: string }) => r.offerId)).not.toContain(OFFER_A);
    // no seller id is taken from the request
    expect((await h.call('POST', SELLER_Q('seller.earnings'), h.tokens.seller(T), { preset: 'today', sellerId: S })).status).toBe(400);
  });

  it('staff and seller reports stay apart', async () => {
    expect((await h.call('POST', ADMIN_Q('seller.earnings'), h.tokens.staff(), { preset: 'today' })).status).toBe(404);
    expect((await h.call('POST', SELLER_Q('finance.platform_income'), h.tokens.seller(S), { preset: 'today' })).status).toBe(404);
    expect((await h.call('POST', ADMIN_Q('finance.platform_income'), h.tokens.staff(['reports.library.view']), { preset: 'today' })).status).toBe(403);
    expect((await h.call('POST', ADMIN_Q('trading.pnl'), h.tokens.staff(['reports.library.view', 'reports.marketplace-finance.view']), { preset: 'today' })).status).toBe(403);
  });

  it('seller unit costs never appear in a staff report', async () => {
    // a distinctive seller cost on T's item
    await h.service.core.repo.updateOrderItems({ itemIds: [other.groups[0]!.items[0]!.id] }, { buying_cost_minor: 777_777 });
    const staff = h.tokens.staff();
    for (const key of ['commerce.sales', 'commerce.orders', 'trading.margin', 'trading.purchasing', 'marketplace.fees', 'marketplace.discount_funding', 'marketplace.owed_to_sellers', 'finance.platform_income', 'finance.seller_money', 'trading.pnl']) {
      const res = await h.call('POST', ADMIN_Q(key), staff, { preset: 'today', compare: 'previous_period' });
      expect(res.status, `${key}: ${JSON.stringify(res.body)}`).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text, key).not.toContain('777777');
      expect(text, key).not.toContain('779777'); // 777,777 + S's 2,000
    }
    // the Official Store margin counts Official Store costs only
    const margin = await h.call('POST', ADMIN_Q('trading.margin'), staff, { preset: 'today' });
    expect(kpi(margin.body, 'trading.buying_cost').value).toBe(0);
  });
});

describe('finance.platform_income', () => {
  it('is the marketplace income statement by booking day, with the Official Store net margin and the company result', async () => {
    const res = await h.call('POST', ADMIN_Q('finance.platform_income'), h.tokens.staff(), { preset: 'today' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const v = (k: string) => kpi(res.body, k).value;
    expect(v('platform.fee_income_gross')).toBe(900 + 800 + 300);
    expect(v('platform.fee_refunds')).toBe(0);
    expect(v('platform.fee_income_net')).toBe(2_000);
    expect(v('platform.ad_income')).toBe(1_200);
    expect(v('platform.service_fees')).toBe(300);
    expect(v('platform.label_income')).toBe(650);
    expect(v('platform.discount_funding')).toBe(-500);
    expect(v('platform.costs')).toBe(700);
    expect(v('platform.net_income')).toBe(2_000 + 1_200 + 300 + 650 - 500 - 700);
    // Official Store: sale 6,000 − buying 3,100 − discount 600 − shipping (−400 recovered) − write-off 200 + supplier credit 150
    expect(v('platform.official_net_margin')).toBe(6_000 - 3_100 - 600 + 400 - 200 + 150);
    expect(v('platform.company_result')).toBe(v('platform.net_income') + v('platform.official_net_margin'));
    expect(res.body.meta.freshAsOf).toBe((await h.service.core.repo.getCheckpoint('pull:finance_recent'))!.last_event_at!.toISOString());
    const breakdowns = Object.fromEntries(res.body.breakdowns.map((b: { key: string; rows: unknown[] }) => [b.key, b.rows]));
    expect(Object.keys(breakdowns)).toEqual(['waterfall', 'costs_by_kind', 'fee_income_by_category', 'fee_income_by_seller']);
    expect(breakdowns.waterfall.map((r: { key: string }) => r.key)).toEqual(['platform.fee_income_gross', 'platform.fee_refunds', 'platform.ad_income', 'platform.service_fees', 'platform.label_income', 'platform.discount_funding', 'platform.costs', 'platform.net_income', 'platform.official_net_margin', 'platform.company_result']);
    expect(breakdowns.costs_by_kind).toEqual([expect.objectContaining({ key: 'label', amount: usd(700), sharePct: 100 })]);
    expect(breakdowns.fee_income_by_category).toEqual(expect.arrayContaining([expect.objectContaining({ key: CATEGORY, amount: usd(1_700), label: `Home › Category ${CATEGORY.slice(0, 4)}` })]));
    expect(breakdowns.fee_income_by_seller[0]).toMatchObject({ key: S, amount: usd(1_700) });
    expect(res.body.series.map((s: { key: string }) => s.key)).toContain('platform.company_result');
  });
});

describe('finance.seller_money', () => {
  it('shows end-of-day balances, payouts and the top sellers by fee income', async () => {
    const res = await h.call('POST', ADMIN_Q('finance.seller_money'), h.tokens.staff(), { preset: 'today', sellerId: S });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const account = (await finance.core.repo.findOne('seller_accounts', { seller_id: S }))!;
    // the sales are pending (15,800); the charges took the available balance below zero (-1,900)
    expect(account).toMatchObject({ pending: 15_800, available: -1_900, held: 0 });
    const live = account.pending + account.available;
    expect(kpi(res.body, 'sellers.owed').value).toBe(13_900);
    expect(kpi(res.body, 'sellers.held').value).toBe(0);
    expect(kpi(res.body, 'sellers.negative').value).toBe(1_900);
    expect(kpi(res.body, 'sellers.negative_count').value).toBe(1);
    expect(kpi(res.body, 'sellers.payouts_paid').value).toBe(0);
    expect(res.body.series.map((s: { key: string }) => s.key)).toEqual(['sellers.owed', 'sellers.held', 'sellers.negative', 'sellers.negative_count', 'sellers.payouts_paid', 'sellers.payouts_failed']);
    expect(res.body.table.rows).toEqual([expect.objectContaining({ sellerId: S, itemSales: usd(16_500), feeIncome: usd(1_700), balanceToday: usd(live), heldToday: usd(0) })]);
  });

  it('counts a seller below zero', async () => {
    const U = newId();
    await finance.recordServiceFee({ sellerId: U, amount: usd(400), kind: 'removal', reference: { kind: 'seller', id: U }, description: 'Removal', idempotencyKey: newId() });
    await pull();
    const res = await h.call('POST', ADMIN_Q('finance.seller_money'), h.tokens.staff(), { preset: 'today', sellerId: U });
    expect(kpi(res.body, 'sellers.negative').value).toBe(400);
    expect(kpi(res.body, 'sellers.negative_count').value).toBe(1);
  });
});

describe('trading.pnl', () => {
  it('gives the same figures as GET /api/admin/finance/trading for the same range', async () => {
    const res = await h.call('POST', ADMIN_Q('trading.pnl'), h.tokens.staff(), { preset: 'today' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const t = await h.call('GET', `/api/admin/finance/trading?from=${today}&to=${today}`, h.tokens.staff());
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const v = (k: string) => kpi(res.body, k).value;
    expect(v('trading.official_sales')).toBe(t.body.productSales.amount);
    expect(v('trading.buying_cost')).toBe(t.body.buyingCost.amount);
    expect(v('trading.gross_margin')).toBe(t.body.grossMargin.amount);
    expect(v('trading.discounts')).toBe(t.body.discounts.amount);
    expect(v('trading.shipping_expense')).toBe(t.body.shippingExpense.amount);
    expect(v('trading.returns_cost')).toBe(t.body.returnsCost.amount);
    expect(v('trading.write_offs')).toBe(t.body.writeOffs.amount);
    expect(v('trading.chargeback_losses')).toBe(t.body.chargebackLosses.amount);
    expect(v('trading.net_margin')).toBe(t.body.netMargin.amount);
    expect(v('trading.net_margin')).toBe(6_000 - 3_100 - 600 + 400 - 200 + 150);
    const waterfall = res.body.breakdowns.find((b: { key: string }) => b.key === 'waterfall').rows;
    expect(waterfall.at(-1)).toMatchObject({ key: 'trading.net_margin', step: 'total', amount: usd(v('trading.net_margin')) });
    expect(res.body.table.columns.map((c: { key: string }) => c.key)).toContain('supplier_credits');
  });
});
