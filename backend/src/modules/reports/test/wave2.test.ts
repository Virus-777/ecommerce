/**
 * Wave 2 (BACKEND-REQUESTS): the seller return rate and its comparison (G48a), product sales rows with SKU, image and
 * live-discount flag (G47b), and the report library grown toward the design's 23 reports (G74).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { REPORTS } from '../domain/catalogue.js';
import { harness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const kpi = (body: any, key: string) => body.kpis.find((k: any) => k.metricKey === key);
const sellerReport = (sellerId: string, key: string, query: Record<string, unknown> = {}) => h.call('POST', `/api/seller/reports/reports/${key}/query`, h.tokens.seller(sellerId), query);
const staffReport = (key: string, query: Record<string, unknown> = {}) => h.call('POST', `/api/admin/reports/reports/${key}/query`, h.tokens.staff(), query);

describe('seller product sales (G47b, G48a)', () => {
  it('rows carry the SKUs sold, the main image, a live-discount flag, returns and the return rate; the KPI compares periods', async () => {
    const sellerId = newId();
    const productId = newId();
    const plainProduct = newId();
    const [teal, sand, plain] = [newId(), newId(), newId()];
    h.products.set(productId, { title: 'Halden Pocket Speaker', imageUrl: 'https://files.marketly.test/speaker.jpg' });
    h.products.set(plainProduct, { title: 'Cable' });
    for (const [offer, product, sku] of [[teal, productId, 'HAL-PKT-TEAL'], [sand, productId, 'HAL-PKT-SND'], [plain, plainProduct, 'CBL-1']] as const) {
      h.offerProducts.set(offer, product);
      h.offerSkus.set(offer, sku);
    }
    h.discountedOffers.add(teal);
    const o = h.order({ sellerId, items: [{ productId, offerId: teal, quantity: 3, unit: 5000 }, { productId, offerId: sand, quantity: 1, unit: 5000 }, { productId: plainProduct, offerId: plain, quantity: 4, unit: 1000 }] });
    h.placed(o);
    await h.drain();
    const tealItem = o.groups[0]!.items[0]!;
    h.publish('returns', 'returns.return.requested', { returnId: newId(), ref: 'RT-2', orderId: o.id, orderRef: o.ref, ownerType: 'seller', sellerId, fulfilledBy: 'seller', orderItemIds: [tealItem.id], reason: 'defective', responseDueAt: h.clock.now().toISOString() });
    await h.drain();

    const r = await sellerReport(sellerId, 'seller.product_sales', { preset: 'today', compare: 'previous_period' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const speaker = r.body.table.rows.find((x: any) => x.productId === productId);
    expect(speaker).toMatchObject({
      product: 'Halden Pocket Speaker',
      image: { url: 'https://files.marketly.test/speaker.jpg' },
      sku: 'HAL-PKT-TEAL / HAL-PKT-SND',
      skus: ['HAL-PKT-TEAL', 'HAL-PKT-SND'],
      liveDiscount: true,
      units: 4,
      averagePrice: { amount: 5000 },
      returnedUnits: 3,
      returnRate: 75,
    });
    expect(r.body.table.rows.find((x: any) => x.productId === plainProduct)).toMatchObject({ image: null, sku: 'CBL-1', liveDiscount: false, returnedUnits: 0, returnRate: 0 });
    // 3 of 8 units returned; the previous period sold nothing
    expect(kpi(r.body, 'service.return_rate')).toMatchObject({ value: 37.5, display: '37.5%', note: '3 of 8 units', delta: { value: 37.5, unit: 'pts', direction: 'up', good: false } });
    expect(r.body.definitions.map((d: any) => d.key)).toContain('service.return_rate');
    expect(r.body.table.columns.map((c: any) => c.key)).toEqual(expect.arrayContaining(['sku', 'averagePrice', 'returnedUnits', 'returnRate']));

    const reasons = await sellerReport(sellerId, 'seller.returns_by_reason', { preset: 'today' });
    expect(kpi(reasons.body, 'service.return_rate')).toMatchObject({ value: 37.5, delta: null });
  });
});

describe('report library (G74)', () => {
  const ADDED = ['commerce.orders', 'marketplace.discount_funding', 'marketplace.owed_to_sellers', 'marketplace.payouts', 'discovery.stockouts', 'service.dispatch', 'service.delivery_issues', 'service.cancellations', 'service.cases', 'ads.performance'];

  it('lists 20 staff reports in the six areas', async () => {
    expect(REPORTS.filter((r) => r.audience === 'staff')).toHaveLength(20);
    const groups = await h.call('GET', '/api/admin/reports/catalogue', h.tokens.staff());
    expect(groups.status, JSON.stringify(groups.body)).toBe(200);
    const keys = JSON.stringify(groups.body);
    for (const k of ADDED) expect(keys).toContain(k);
  });

  it.each(ADDED)('%s runs with its KPIs and states its definitions', async (key) => {
    const sellerId = newId();
    const o = h.order({ sellerId, items: [{ quantity: 2, unit: 3000, discount: { amount: 500, fundedBy: 'platform' } }] });
    h.placed(o);
    await h.drain();
    const r = await staffReport(key, { preset: 'today', compare: 'previous_period' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const def = REPORTS.find((x) => x.key === key)!;
    for (const m of def.metrics) if (!r.body.unavailable.includes(m)) expect(kpi(r.body, m), `${key} ${m}`).toBeDefined();
    expect(r.body.definitions.map((d: any) => d.key).sort()).toEqual([...def.metrics].sort());
    expect(r.body.meta.reportKey).toBe(key);
  });

  it('discount funding splits platform- and seller-funded discounts by seller', async () => {
    const sellerId = newId();
    h.placed(h.order({ sellerId, items: [{ quantity: 1, unit: 10000, discount: { amount: 1500, fundedBy: 'platform' } }, { quantity: 1, unit: 10000, discount: { amount: 700, fundedBy: 'seller' } }] }));
    await h.drain();
    const r = await staffReport('marketplace.discount_funding', { preset: 'today', sellerId });
    expect(kpi(r.body, 'marketplace.discount_funding').value).toBe(1500);
    expect(r.body.table.rows[0]).toMatchObject({ sellerId, platformDiscount: { amount: 1500 }, sellerDiscount: { amount: 700 } });
  });

  it('amounts owed to sellers lists the balances of sellers active in the range', async () => {
    const sellerId = newId();
    h.placed(h.order({ sellerId }));
    await h.drain();
    const r = await staffReport('marketplace.owed_to_sellers', { preset: 'today', sellerId });
    expect(r.body.table.rows).toEqual([expect.objectContaining({ sellerId, pending: { amount: 1000, currency: 'USD' }, available: { amount: 2500, currency: 'USD' }, total: { amount: 3500, currency: 'USD' } })]);
    expect(kpi(r.body, 'marketplace.seller_balances').value).toBe(3500);
  });

  it('the cases report says response times are not collected yet', async () => {
    const r = await staffReport('service.cases', { preset: 'today' });
    expect(r.body.unavailable).toContain('service.response_time');
    expect(r.body.callouts.map((c: any) => c.title)).toContain('Response times are not collected yet');
  });
});
