import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, usd, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const kpi = (body: any, key: string) => body.kpis.find((k: any) => k.metricKey === key);
const sellerReport = (sellerId: string, key: string, query: Record<string, unknown> = {}) => h.call('POST', `/api/seller/reports/reports/${key}/query`, h.tokens.seller(sellerId), query);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(h.clock.now());

describe('order facts from events (idempotent, order-tolerant)', () => {
  it('an accepted order counts once, however often its events arrive; a pending order waits for acceptance', async () => {
    const sellerId = newId();
    const productId = newId();
    const o = h.order({ sellerId, items: [{ productId, quantity: 2, unit: 5000, discount: { amount: 1000, fundedBy: 'platform' } }] });
    h.placed(o);
    h.placed(o); // redelivery
    await h.drain();
    const r = await sellerReport(sellerId, 'seller.order_trend');
    expect(r.status).toBe(200);
    expect(kpi(r.body, 'commerce.orders').value).toBe(1);
    expect(kpi(r.body, 'commerce.gross_sales')).toMatchObject({ value: 9000, money: { amount: 9000, currency: 'USD' }, display: '$90.00' });
    expect(r.body.meta).toMatchObject({ reportKey: 'seller.order_trend', dateBasis: 'placement', currency: 'USD', timeZone: 'America/Los_Angeles', taxIncluded: false, scope: 'seller', definitionsVersion: { 'commerce.orders': 1 } });

    const pending = h.order({ sellerId, pending: true });
    h.placed(pending, 'pending_check');
    await h.drain();
    expect(kpi((await sellerReport(sellerId, 'seller.order_trend')).body, 'commerce.orders').value).toBe(1);
    (pending as any).acceptedAt = h.clock.now().toISOString();
    (pending as any).lifecycle = 'open';
    h.publish('orders', 'orders.order.accepted', { orderId: pending.id, ref: pending.ref, customerId: null, contactEmail: 'ben@example.com', total: usd(1), groups: [], items: [], acceptedAt: h.clock.now().toISOString() });
    await h.drain();
    expect(kpi((await sellerReport(sellerId, 'seller.order_trend')).body, 'commerce.orders').value).toBe(2);
  });

  it('consumers claim their keys in the inbox (not read_model_checkpoints); the category comes from the order item', async () => {
    const categoryId = newId();
    const o = h.order({ items: [{ categoryId }] });
    h.placed(o);
    h.placed(o);
    await h.drain();
    const core = h.service.core;
    expect(await core.ctx.inbox.seen(core.ctx.db, `order_items:${o.id}`)).toBe(true);
    const facts = await core.repo.getOrderItems(o.id);
    expect(facts.map((f) => f.category_id)).toEqual([categoryId]);
    const seenRows = await (core.ctx.db as any).selectFrom('read_model_checkpoints').select('key').where('key', 'like', 'seen:%').execute();
    expect(seenRows).toEqual([]);
  });

  it('a later event that arrives first loads the order; payment, shipment, delivery and completion dates fill the date bases', async () => {
    const sellerId = newId();
    const o = h.order({ sellerId, items: [{ quantity: 1, unit: 12000 }] });
    const item = o.groups[0]!.items[0]!;
    const groupId = o.groups[0]!.id;
    const now = h.clock.now().toISOString();
    // dispatched before reports saw the placement
    const shipment = { shipmentId: newId(), kind: 'outbound', orderId: o.id, groupId, ownerType: 'seller', sellerId, lines: [{ orderItemId: item.id, title: 'Lamp', variantLabel: 'Silver', quantity: 1 }], shippedAt: now, dispatchDueAt: now, onTime: true, trackingValid: true };
    h.publish('shipping', 'shipping.shipment.dispatched', shipment);
    h.publish('shipping', 'shipping.shipment.dispatched', shipment);
    await h.drain();
    h.placed(o);
    h.publish('payments', 'payments.payment.captured', { intentId: newId(), captureId: newId(), orderId: o.id, groupId, amount: usd(12900), allocations: [{ groupId, ownerType: 'seller', sellerId, amount: usd(12900) }], capturedAt: now });
    h.publish('orders', 'orders.item.delivered', { orderId: o.id, groupId, ownerType: 'seller', sellerId, itemId: item.id, quantity: 1, deliveredAt: now, returnWindowEndsAt: now });
    h.publish('orders', 'orders.order.completed', { orderId: o.id, ref: o.ref, completedAt: now });
    await h.drain();

    for (const basis of ['placement', 'payment', 'shipment', 'completion']) {
      const r = await h.call('POST', '/api/admin/reports/reports/commerce.sales/query', h.tokens.staff(), { preset: 'today', dateBasis: basis, sellerId });
      expect(r.status).toBe(200);
      expect(kpi(r.body, 'commerce.gross_sales').value, basis).toBe(12000);
      expect(r.body.meta.dateBasis).toBe(basis);
    }
    const service = await sellerReport(sellerId, 'seller.service_performance', { preset: 'today' });
    expect(kpi(service.body, 'service.on_time_dispatch')).toMatchObject({ value: 100, display: '100.0%' });
    expect(kpi(service.body, 'service.on_time_dispatch').note).toBe('1 of 1 packages');
  });

  it('cancellations and refunds: sales after cancellations and refunds, refunds counted once and only when sent', async () => {
    const sellerId = newId();
    const o = h.order({ sellerId, items: [{ quantity: 1, unit: 10000 }, { quantity: 1, unit: 4000 }] });
    const [a, b] = o.groups[0]!.items;
    const groupId = o.groups[0]!.id;
    h.placed(o);
    await h.drain();
    const cancel = { orderId: o.id, ref: o.ref, groupId, ownerType: 'seller', sellerId, itemId: b!.id, offerId: b!.offer.offerId, stockItemId: newId(), quantity: 1, cancellationId: newId(), initiatedBy: 'seller', reasonCode: 'out_of_stock', beforeDispatch: true, countsAgainstSeller: true, refund: { itemAmount: usd(4000), discountShare: usd(0), shippingRefund: usd(500), taxRefund: usd(400), total: usd(4900) }, paymentIntentId: newId() };
    h.publish('orders', 'orders.item.cancelled', cancel);
    h.publish('orders', 'orders.item.cancelled', cancel);
    const refund = { refundId: newId(), ref: 'RF-1', orderId: o.id, origin: 'return', originId: null, amount: usd(3000), items: [{ orderItemId: a!.id, title: 'Lamp', groupId, sellerId, amount: usd(3000) }], destination: 'card', sentAt: h.clock.now().toISOString() };
    h.publish('payments', 'payments.refund.sent', refund);
    h.publish('payments', 'payments.refund.sent', refund);
    await h.drain();

    const sales = await h.call('POST', '/api/admin/reports/reports/commerce.sales/query', h.tokens.staff(), { preset: 'today', sellerId, compare: 'previous_period' });
    expect(kpi(sales.body, 'commerce.gross_sales').value).toBe(14000);
    expect(kpi(sales.body, 'commerce.net_sales').value).toBe(14000 - 4000 - 3000);
    expect(sales.body.meta.compareRange).toBeDefined();
    expect(sales.body.callouts.map((c: any) => c.title)).toContain('Marketplace sales are not marketplace fee income');
    expect(sales.body.definitions.map((d: any) => d.key)).toContain('commerce.net_sales');

    const refunds = await h.call('POST', '/api/admin/reports/reports/commerce.refunds/query', h.tokens.staff(), { preset: 'today', sellerId });
    expect(kpi(refunds.body, 'commerce.refunds')).toMatchObject({ value: 3000, note: '1 refunds sent' });
    expect(kpi(refunds.body, 'commerce.cancelled_sales').value).toBe(4000);
    expect(refunds.body.breakdowns[1].rows).toContainEqual(expect.objectContaining({ key: 'seller', items: 1 }));
    const service = await sellerReport(sellerId, 'seller.service_performance', { preset: 'today' });
    expect(kpi(service.body, 'service.seller_cancellations').value).toBe(1);
  });

  it('returns by reason with inspection outcome; sellers see only their own', async () => {
    const sellerId = newId();
    const o = h.order({ sellerId });
    h.placed(o);
    await h.drain();
    const returnId = newId();
    h.publish('returns', 'returns.return.requested', { returnId, ref: 'RT-1', orderId: o.id, ownerType: 'seller', sellerId, orderItemIds: [o.groups[0]!.items[0]!.id], reason: 'damaged', responseDueAt: h.clock.now().toISOString() });
    await h.drain();
    h.publish('returns', 'returns.return.inspected', { returnId, ownerType: 'seller', sellerId, conditionOutcome: 'damaged_in_transit', proposedStockOutcome: 'damaged', orderItemId: o.groups[0]!.items[0]!.id, variantId: newId(), stockItemId: null, quantity: 1 });
    await h.drain();
    const mine = await sellerReport(sellerId, 'seller.returns_by_reason', { preset: 'today' });
    expect(kpi(mine.body, 'service.return_requests').value).toBe(1);
    expect(mine.body.breakdowns[0].rows[0]).toMatchObject({ key: 'damaged', requests: 1 });
    expect(mine.body.breakdowns[1].rows[0]).toMatchObject({ key: 'damaged_in_transit' });
    expect(kpi((await sellerReport(newId(), 'seller.returns_by_reason', { preset: 'today' })).body, 'service.return_requests').value).toBe(0);
  });
});

describe('seller reports', () => {
  it('always the caller’s own seller: sellerId and soldBy are refused, other reports 404, ranges validated', async () => {
    const sellerId = newId();
    const other = newId();
    h.placed(h.order({ sellerId: other, items: [{ unit: 99900 }] }));
    await h.drain();
    const mine = await sellerReport(sellerId, 'seller.product_sales', { preset: 'today' });
    expect(kpi(mine.body, 'commerce.gross_sales').value).toBe(0);
    expect((await sellerReport(sellerId, 'seller.product_sales', { sellerId: other })).status).toBe(400);
    expect((await sellerReport(sellerId, 'seller.product_sales', { soldBy: 'all' })).status).toBe(400);
    expect((await sellerReport(sellerId, 'commerce.sales')).status).toBe(404);
    expect((await sellerReport(sellerId, 'seller.order_trend', { preset: 'custom' })).status).toBe(400);
    const tooLong = await sellerReport(sellerId, 'seller.order_trend', { range: { from: '2024-01-01', to: '2026-01-01' } });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.code).toBe('RANGE_TOO_LARGE');
    expect((await sellerReport(sellerId, 'seller.order_trend', { currency: 'EUR' })).status).toBe(400);
    const perm = await h.call('POST', '/api/seller/reports/reports/seller.order_trend/query', h.tokens.seller(sellerId, []), {});
    expect(perm.status).toBe(403);
  });
});

describe('admin reports from the other read models', () => {
  it('service: dispatch, overdue, delivery issues, messages and the case backlog', async () => {
    const sellerId = newId();
    h.publish('shipping', 'shipping.dispatch.overdue', { orderId: newId(), orderRef: 'MK-1', groupId: newId(), ownerType: 'seller', sellerId, orderItemIds: [newId()], dueAt: h.clock.now().toISOString(), exceptionId: newId() });
    const ex = { exceptionId: newId(), kind: 'lost_or_damaged', orderId: newId(), groupId: newId(), sellerId, orderItemIds: [newId()], dueAt: h.clock.now().toISOString() };
    h.publish('shipping', 'shipping.shipment.exception', ex);
    h.publish('shipping', 'shipping.shipment.exception', ex);
    h.publish('messaging', 'messaging.message.sent', { messageId: newId(), conversationId: newId(), authorKind: 'customer', recipientKinds: ['seller'], sellerId });
    const caseA = newId();
    h.publish('support', 'support.case.opened', { caseId: caseA, ref: 'CS-1', kind: 'order_problem', category: 'damaged_item', priority: 'normal', sellerId, orderItemIds: [], handler: 'seller' });
    h.publish('support', 'support.case.opened', { caseId: newId(), ref: 'CS-2', kind: 'order_problem', category: 'late', priority: 'normal', sellerId, orderItemIds: [], handler: 'seller' });
    await h.drain();
    h.publish('support', 'support.case.resolved', { caseId: caseA, ref: 'CS-1', sellerId, resolvedAt: h.clock.now().toISOString() });
    h.publish('support', 'support.case.resolved', { caseId: caseA, ref: 'CS-1', sellerId, resolvedAt: h.clock.now().toISOString() });
    await h.drain();
    const r = await h.call('POST', '/api/admin/reports/reports/service.sellers/query', h.tokens.staff(), { preset: 'today', sellerId });
    expect(r.status).toBe(200);
    expect(kpi(r.body, 'service.overdue_dispatch').value).toBe(1);
    expect(kpi(r.body, 'service.delivery_exceptions').value).toBe(1);
    expect(kpi(r.body, 'service.messages_received').value).toBe(1);
    expect(kpi(r.body, 'service.cases_opened').value).toBe(2);
    expect(kpi(r.body, 'service.case_backlog').value).toBe(1);
    expect(r.body.table.rows).toHaveLength(1);
  });

  it('marketplace finance: fee income pulled daily next to seller sales, holds, payouts, amounts owed and ad charges', async () => {
    const sellerId = newId();
    h.placed(h.order({ sellerId, items: [{ unit: 20000, discount: { amount: 2000, fundedBy: 'platform' } }] }));
    await h.drain();
    const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(h.clock.now().getTime() - 86_400_000));
    h.income.push({ date: yesterday, sellerId, netFeeIncome: usd(1800) });
    await h.app.kernel.jobs.runNow('reports.pull-daily');
    const holdId = newId();
    h.publish('finance', 'finance.hold.placed', { holdId, sellerId, amount: usd(5000), reasonCode: 'risk', reason: 'Review', reviewDate: today() });
    h.publish('finance', 'finance.hold.released', { holdId, sellerId, amount: usd(2000), reason: 'Partly cleared' });
    h.publish('finance', 'finance.payout.paid', { payoutId: newId(), ref: 'PO-1', sellerId, amount: usd(7000), paidAt: h.clock.now().toISOString() });
    h.publish('finance', 'finance.payout.failed', { payoutId: newId(), ref: 'PO-2', sellerId, amount: usd(100), failureReason: 'Closed account' });
    h.publish('finance', 'finance.amount_owed.created', { amountOwedId: newId(), sellerId, amount: usd(900) });
    const chargeId = newId();
    const campaignId = newId();
    h.publish('advertising', 'advertising.charge.posted', { chargeId, sellerId, campaignId, day: today(), amount: usd(1500) });
    h.publish('advertising', 'advertising.charge.posted', { chargeId, sellerId, campaignId, day: today(), amount: usd(1500) });
    await h.drain();
    h.publish('advertising', 'advertising.charge.credited', { chargeId, sellerId, amount: usd(500), reason: 'Invalid clicks' });
    await h.drain();

    const r = await h.call('POST', '/api/admin/reports/reports/marketplace.fees/query', h.tokens.staff(), { preset: 'last_7_days', sellerId });
    expect(r.status).toBe(200);
    expect(kpi(r.body, 'marketplace.seller_sales').value).toBe(18000);
    expect(kpi(r.body, 'marketplace.fee_income')).toMatchObject({ value: 1800, note: 'on $180.00 seller sales' });
    expect(kpi(r.body, 'marketplace.discount_funding').value).toBe(2000);
    expect(kpi(r.body, 'marketplace.held').value).toBe(3000);
    expect(kpi(r.body, 'marketplace.payouts_paid')).toMatchObject({ value: 7000, note: '1 failed' });
    expect(kpi(r.body, 'marketplace.amounts_owed').value).toBe(900);
    expect(kpi(r.body, 'marketplace.ad_income').value).toBe(1000);
    expect(r.body.callouts[0].title).toBe('Marketplace sales are not marketplace fee income');
    expect(r.body.callouts[1].body).toContain(yesterday);
    expect(r.body.unavailable).toEqual([]);

    const campaigns = await h.call('POST', '/api/admin/reports/reports/marketing.campaigns/query', h.tokens.staff(), { preset: 'today' });
    expect(campaigns.body.table.rows).toContainEqual(expect.objectContaining({ kind: 'ad', campaignId, spend: usd(1000) }));
  });

  it('campaigns: coupon redemptions with funding, reversals on cancellation; ads displays from the daily pull', async () => {
    const campaignId = newId();
    const redemptionId = newId();
    const o = h.order({ sellerId: null, items: [{ unit: 8000 }] });
    h.placed(o);
    await h.drain();
    const redeemed = { redemptionId, campaignId, orderId: o.id, amount: usd(800), platformPart: usd(500), sellerPart: usd(300) };
    h.publish('promotions', 'promotions.coupon.redeemed', redeemed);
    h.publish('promotions', 'promotions.coupon.redeemed', redeemed);
    await h.drain();
    h.publish('promotions', 'promotions.redemption.reversed', { redemptionId, orderItemId: o.groups[0]!.items[0]!.id, amount: usd(200), platformPart: usd(100), sellerPart: usd(100) });
    await h.drain();
    const adCampaign = newId();
    const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(h.clock.now().getTime() - 86_400_000));
    h.adPerf.push({ date: yesterday, campaignId: adCampaign, displays: 1000, clicks: 25, dismissals: 40, attributedOrders: 2 });
    await h.app.kernel.jobs.runNow('reports.pull-daily');
    const r = await h.call('POST', '/api/admin/reports/reports/marketing.campaigns/query', h.tokens.staff(), { preset: 'last_7_days' });
    const row = r.body.table.rows.find((x: any) => x.campaignId === campaignId);
    expect(row).toMatchObject({ kind: 'promotion', discountCost: usd(600), redemptions: 1, sales: usd(8000) });
    expect(r.body.table.rows.find((x: any) => x.campaignId === adCampaign)).toMatchObject({ displays: 1000, clicks: 25, attributedPurchases: 2 });
    expect(kpi(r.body, 'ads.displays').value).toBeGreaterThanOrEqual(1000);
  });

  it('discovery: product views from the store, cart additions, units ordered and out-of-stock hours; unavailable searches', async () => {
    const productId = newId();
    const offerId = newId();
    h.offerProducts.set(offerId, productId);
    const views = await h.call('POST', '/api/store/reports/signals', h.tokens.visitor(), { signals: [{ kind: 'product_view', productId, at: h.clock.now().toISOString() }, { kind: 'product_view', productId }, { kind: 'other', productId }] });
    expect(views.status).toBe(202);
    expect((await h.call('POST', '/api/store/reports/signals', h.tokens.visitor(), { signals: Array.from({ length: 51 }, () => ({ kind: 'product_view', productId })) })).status).toBe(400);
    const env = { id: newId(), at: h.clock.now().toISOString() };
    const added = { cartId: newId(), itemId: newId(), offerId, productId, quantity: 1, unitPrice: usd(100), ownerKind: 'seller' };
    await h.service.onItemAddedFromCart(added, env);
    await h.service.onItemAddedFromCart(added, env); // the same event again
    h.placed(h.order({ items: [{ productId, quantity: 3 }] }));
    const stock = { stockItemId: newId(), offerId, ownerType: 'seller', variantId: newId(), available: 0, reserved: 0, previousAvailable: 2, cause: 'order' };
    h.publish('inventory', 'inventory.stock.changed', { ...stock, state: 'out_of_stock' });
    await h.drain();
    h.clock.advance(90 * 60_000);
    h.publish('inventory', 'inventory.stock.changed', { ...stock, available: 10, previousAvailable: 0, state: 'in_stock', cause: 'restock' });
    await h.drain();
    h.zeroResults.push({ query: 'Blue Kettle', normalized: 'blue kettle', count: 7 });
    await h.app.kernel.jobs.runNow('reports.pull-daily');

    const r = await h.call('POST', '/api/admin/reports/reports/discovery.products/query', h.tokens.staff(), { preset: 'last_7_days', productId });
    expect(kpi(r.body, 'discovery.product_views').value).toBe(2);
    expect(kpi(r.body, 'discovery.cart_adds').value).toBe(1);
    expect(kpi(r.body, 'discovery.view_to_order').note).toBe('3 units ordered');
    expect(kpi(r.body, 'discovery.stockout_hours').value).toBe(1.5);
    const searches = await h.call('POST', '/api/admin/reports/reports/discovery.searches/query', h.tokens.staff(), { preset: 'last_7_days' });
    expect(searches.body.table.rows).toContainEqual({ query: 'blue kettle', count: 7 });
  });

  it('buyers: new, returning and repeat purchase; Official Store margin from inventory costs', async () => {
    const customerId = newId();
    const stockItemId = newId();
    h.unitCosts.set(stockItemId, 3000);
    const o = h.order({ sellerId: null, customerId, items: [{ unit: 5000, quantity: 2, stockItemId }] });
    h.placed(o, 'accepted', customerId);
    await h.drain();
    h.placed(h.order({ sellerId: null, customerId }), 'accepted', customerId);
    await h.drain();
    const buyers = await h.call('POST', '/api/admin/reports/reports/customers.buyers/query', h.tokens.staff(), { preset: 'today' });
    expect(kpi(buyers.body, 'customers.buyers').value).toBeGreaterThanOrEqual(1);
    expect(kpi(buyers.body, 'customers.repeat_rate').value).toBeGreaterThan(0);
    const margin = await h.call('POST', '/api/admin/reports/reports/trading.margin/query', h.tokens.staff(), { preset: 'today', productId: o.groups[0]!.items[0]!.product.productId });
    expect(kpi(margin.body, 'trading.official_sales').value).toBe(10000);
    expect(kpi(margin.body, 'trading.buying_cost').value).toBe(6000);
    expect(kpi(margin.body, 'trading.gross_margin').value).toBe(4000);
    expect(kpi(margin.body, 'trading.gross_margin_pct').value).toBe(40);
  });

  it('a report needs its group permission; bad filters are refused', async () => {
    const r = await h.call('POST', '/api/admin/reports/reports/trading.margin/query', h.tokens.staff(['reports.library.view', 'reports.commerce.view']), {});
    expect(r.status).toBe(403);
    expect((await h.call('POST', '/api/admin/reports/reports/commerce.sales/query', h.tokens.staff(), { timeZone: 'Mars/Olympus' })).status).toBe(400);
    expect((await h.call('POST', '/api/admin/reports/reports/commerce.sales/query', h.tokens.staff(), { range: { from: '2026-10-09', to: '2026-10-01' } })).status).toBe(400);
    expect((await h.call('POST', '/api/admin/reports/reports/nope/query', h.tokens.staff(), {})).status).toBe(404);
    const week = await h.call('POST', '/api/admin/reports/reports/commerce.sales/query', h.tokens.staff(), { preset: 'last_90_days' });
    expect(week.body.meta.granularity).toBe('week');
    expect(week.body.split.map((s: any) => s.key)).toEqual(['official', 'marketplace']);
  });
});

describe('dashboards', () => {
  it('admin: gross sales, orders with AOV, fee income, refunds and the 14-day Official Store / marketplace split', async () => {
    h.placed(h.order({ sellerId: null, items: [{ unit: 30000 }] }));
    h.placed(h.order({ sellerId: newId(), items: [{ unit: 10000 }] }));
    await h.drain();
    const r = await h.call('GET', '/api/admin/reports/dashboard?period=today', h.tokens.staff());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ period: 'today', dateBasis: 'Gross sales by order placement date', unavailable: [] });
    expect(r.body.kpis.map((k: any) => k.metricKey)).toEqual(['commerce.gross_sales', 'commerce.orders', 'marketplace.fee_income', 'commerce.refunds']);
    expect(kpi(r.body, 'commerce.orders').note).toMatch(/^avg \$/);
    expect(kpi(r.body, 'commerce.refunds').note).toMatch(/% of gross$/);
    expect(r.body.salesSplit.series.map((s: any) => s.key)).toEqual(['official', 'marketplace']);
    expect(r.body.salesSplit.series[0].points).toHaveLength(14);
    expect(r.body.salesSplit.official.amount + r.body.salesSplit.marketplace.amount).toBe(kpi(r.body, 'commerce.gross_sales').value);
    expect(r.body.definitions.map((d: any) => d.key)).toContain('marketplace.fee_income');

    const g = await h.gql('admin', h.tokens.staff(), '{ adminDashboard(period: TODAY) { scope period dateBasis currency timeZone taxIncluded kpis { metricKey unit display money { formatted } delta { direction } definition { key ownerName } } series { key points { date label value } total { display } } split { key sharePct amount { formatted } } definitions { key group unit defaultDateBasis } unavailable } }');
    expect(g.errors).toBeUndefined();
    expect(g.data.adminDashboard).toMatchObject({ scope: 'PLATFORM', period: 'TODAY', dateBasis: 'PLACEMENT', currency: 'USD', timeZone: 'America/Los_Angeles', taxIncluded: false });
    expect(g.data.adminDashboard.kpis[0]).toMatchObject({ metricKey: 'commerce.gross_sales', unit: 'MONEY' });
    expect(g.data.adminDashboard.definitions[0].group).toBe('COMMERCE');
  });

  it('seller: work tiles, sales by order date, payouts and performance; only the caller’s own figures', async () => {
    const sellerId = newId();
    h.sellerCounts.set(sellerId, { new: 3, preparing: 1, shipped: 0, completed: 0, cancellationRequests: 0, overdue: 1, dueToday: 2 });
    h.placed(h.order({ sellerId, items: [{ unit: 4500, quantity: 2 }] }));
    await h.drain();
    const r = await h.call('GET', '/api/seller/reports/dashboard', h.tokens.seller(sellerId));
    expect(r.status).toBe(200);
    expect(r.body.workToday.find((t: any) => t.key === 'overdue_dispatch')).toMatchObject({ count: 1, tone: 'danger', screen: 'seller/orders' });
    expect(r.body.workToday.find((t: any) => t.key === 'low_stock')).toMatchObject({ count: 2, tone: 'danger' });
    expect(r.body.sales).toMatchObject({ gross: usd(9000), orders: 1, todayOrders: 1, basis: 'item sales before fees, by order date' });
    expect(r.body.sales.series[0].points).toHaveLength(14);
    expect(r.body.payouts).toMatchObject({ available: usd(2500), nextPayout: { destinationLabel: 'Bank •••• 6620' } });
    expect(r.body.performance).toMatchObject({ overall: 'good' });
    expect(r.body.unavailable).toEqual(expect.arrayContaining(['announcements']));
    // another seller sees nothing of it
    expect((await h.call('GET', '/api/seller/reports/dashboard', h.tokens.seller(newId()))).body.sales.orders).toBe(0);
    // a member without finance permission gets no payouts
    expect((await h.call('GET', '/api/seller/reports/dashboard', h.tokens.seller(sellerId, ['reports.seller.view']))).body.payouts).toBeNull();

    const g = await h.gql('seller', h.tokens.seller(sellerId), '{ sellerDashboard { scope period kpis { metricKey label value } workToday { key count tone } split { key } series { key points { value } } } }');
    expect(g.errors).toBeUndefined();
    expect(g.data.sellerDashboard).toMatchObject({ scope: 'SELLER', period: 'LAST_14_DAYS', split: [] });
    expect(g.data.sellerDashboard.workToday).toContainEqual({ key: 'OVERDUE_DISPATCH', count: 1, tone: 'DANGER' });
    expect(g.data.sellerDashboard.kpis[0]).toMatchObject({ metricKey: 'commerce.gross_sales', value: 9000 });
  });
});

describe('read model health', () => {
  it('lists every read model with rows and state; rebuilds run in the check-lag job; one rebuild at a time', async () => {
    const list = await h.call('GET', '/api/admin/reports/read-models', h.tokens.staff());
    expect(list.status).toBe(200);
    expect(list.body.map((m: any) => m.key)).toEqual(['order_items', 'refunds', 'returns', 'marketplace_finance', 'service', 'discovery', 'search_misses', 'customers', 'campaigns']);
    const items = list.body.find((m: any) => m.key === 'order_items');
    expect(items.rows).toBeGreaterThan(0);
    expect(items.state).toBe('live');
    expect(items.lastEventAt).toBeTruthy();

    const started = await h.call('POST', '/api/admin/reports/read-models/customers/rebuild', h.tokens.staff(), { reason: 'Buyer keys changed' });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ key: 'customers', state: 'rebuilding', rebuildProgressPct: 0 });
    expect((await h.call('POST', '/api/admin/reports/read-models/customers/rebuild', h.tokens.staff(), { reason: 'again' })).status).toBe(409);
    expect((await h.call('POST', '/api/admin/reports/read-models/nope/rebuild', h.tokens.staff(), { reason: 'x' })).status).toBe(404);
    const before = (await h.call('GET', '/api/admin/reports/read-models', h.tokens.staff())).body.find((m: any) => m.key === 'customers').rows;
    await h.app.kernel.jobs.runNow('reports.check-lag');
    const after = (await h.call('GET', '/api/admin/reports/read-models', h.tokens.staff())).body.find((m: any) => m.key === 'customers');
    expect(after).toMatchObject({ state: 'live', rebuildProgressPct: null, rows: before });
    expect(h.audits.some((a) => a.action === 'reports.read_model.rebuild' && a.reason === 'Buyer keys changed')).toBe(true);

    await h.call('POST', '/api/admin/reports/read-models/order_items/rebuild', h.tokens.staff(), { reason: 'Refresh delivery dates' });
    await h.app.kernel.jobs.runNow('reports.check-lag');
    expect((await h.call('GET', '/api/admin/reports/read-models', h.tokens.staff())).body.find((m: any) => m.key === 'order_items').state).toBe('live');
  });

  it('metric definitions for other modules’ tooltips', async () => {
    expect(await h.service.metric('marketplace.fee_income')).toMatchObject({ key: 'marketplace.fee_income', status: 'published', group: 'marketplace_finance' });
    expect(await h.service.metric('nope')).toBeNull();
  });
});
