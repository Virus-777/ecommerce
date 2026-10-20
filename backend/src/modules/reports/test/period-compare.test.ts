/**
 * Period options of every report (docs/09 §3.3): the presets quarter_to_date, year_to_date and last_12_months, the
 * comparison with the same period last year (29 February → 28 February) and the <key>:compare twin of every series,
 * drawn on the current period's x values, on staff and seller reports.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type { OrderItemFact } from '../ports.js';
import { lastYearRange, presetRange, sameDayLastYear } from '../domain/rules.js';
import { harness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const SELLER = newId();
const ADMIN_Q = (key: string) => `/api/admin/reports/reports/${key}/query`;
const SELLER_Q = (key: string) => `/api/seller/reports/reports/${key}/query`;

function fact(over: Partial<OrderItemFact> & { placed_at: Date }): OrderItemFact {
  return {
    order_item_id: newId(), order_id: newId(), owner_type: 'seller', seller_id: SELLER, customer_key: 'c-x', category_id: null, product_id: newId(), offer_id: newId(),
    quantity: 1, item_minor: 1000, shipping_minor: 0, discount_platform_minor: 0, discount_seller_minor: 0, tax_minor: 0, currency: 'USD',
    paid_at: null, shipped_at: null, delivered_at: null, completed_at: null, cancelled_at: null, cancelled_by: null, cancelled_minor: 0, refunded_minor: 0, last_refund_at: null,
    buying_cost_minor: null, accepted_at: over.placed_at, group_id: null, fulfilled_by: 'seller',
    ...over,
  } as OrderItemFact;
}
/** Noon market time (Los Angeles) of a day */
const noon = (day: string) => new Date(`${day}T19:00:00Z`);

describe('presets and last-year dates', () => {
  it('quarter_to_date starts on the first day of the calendar quarter', () => {
    expect(presetRange('quarter_to_date', '2026-11-15')).toEqual({ from: '2026-10-01', to: '2026-11-15' });
    expect(presetRange('quarter_to_date', '2026-03-31')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(presetRange('quarter_to_date', '2026-06-01')).toEqual({ from: '2026-04-01', to: '2026-06-01' });
  });

  it('year_to_date starts on 1 January; last_12_months starts the day after the same date last year', () => {
    expect(presetRange('year_to_date', '2026-10-21')).toEqual({ from: '2026-01-01', to: '2026-10-21' });
    expect(presetRange('last_12_months', '2026-10-21')).toEqual({ from: '2025-10-22', to: '2026-10-21' });
    expect(presetRange('last_12_months', '2028-02-29')).toEqual({ from: '2027-03-01', to: '2028-02-29' });
  });

  it('the same period last year keeps the calendar dates; 29 February becomes 28 February', () => {
    expect(sameDayLastYear('2026-10-21')).toBe('2025-10-21');
    expect(sameDayLastYear('2028-02-29')).toBe('2027-02-28');
    expect(lastYearRange({ from: '2028-02-01', to: '2028-02-29' })).toEqual({ from: '2027-02-01', to: '2027-02-28' });
  });

  it('a preset query states its range; the presets stay within the 400-day limit', async () => {
    const res = await h.call('POST', ADMIN_Q('commerce.sales'), h.tokens.staff(), { preset: 'year_to_date' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const today = res.body.meta.range.to as string;
    expect(res.body.meta.range.from).toBe(`${today.slice(0, 4)}-01-01`);
    const year = await h.call('POST', ADMIN_Q('commerce.sales'), h.tokens.staff(), { preset: 'last_12_months' });
    expect(year.status).toBe(200);
    expect(year.body.meta.granularity).toBe('month');
    const bad = await h.call('POST', ADMIN_Q('commerce.sales'), h.tokens.staff(), { preset: 'last_decade' });
    expect(bad.status).toBe(400);
  });
});

describe('comparison twins', () => {
  // this year: 3 + 5 on Mar 2 and Mar 3; last year: 7 on Mar 2
  beforeAll(async () => {
    await h.service.core.repo.insertOrderItems([
      fact({ placed_at: noon('2026-03-02'), item_minor: 3000 }),
      fact({ placed_at: noon('2026-03-03'), item_minor: 5000 }),
      fact({ placed_at: noon('2025-03-02'), item_minor: 7000 }),
      fact({ placed_at: noon('2026-02-28'), item_minor: 2000 }), // the previous period of Mar 1-3
    ]);
  });

  it('same_period_last_year: every series has a <key>:compare twin on the current x values', async () => {
    const res = await h.call('POST', ADMIN_Q('commerce.sales'), h.tokens.staff(), { range: { from: '2026-03-01', to: '2026-03-03' }, granularity: 'day', compare: 'same_period_last_year', sellerId: SELLER });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { meta, series, kpis } = res.body;
    expect(meta).toMatchObject({ compare: 'same_period_last_year', compareRange: { from: '2025-03-01', to: '2025-03-03' } });
    const keys = series.map((s: { key: string }) => s.key);
    expect(keys).toEqual(['gross_sales', 'net_sales', 'gross_sales:compare', 'net_sales:compare']);
    const gross = series.find((s: { key: string }) => s.key === 'gross_sales');
    const twin = series.find((s: { key: string }) => s.key === 'gross_sales:compare');
    expect(gross.points.map((p: { y: number }) => p.y)).toEqual([0, 3000, 5000]);
    expect(twin.points).toEqual([
      { x: '2026-03-01', y: 0, label: 'Mar 1', compareX: '2025-03-01' },
      { x: '2026-03-02', y: 7000, label: 'Mar 2', compareX: '2025-03-02' },
      { x: '2026-03-03', y: 0, label: 'Mar 3', compareX: '2025-03-03' },
    ]);
    // KPI deltas compare with the same dates last year
    expect(kpis.find((k: { metricKey: string }) => k.metricKey === 'commerce.gross_sales').delta).toMatchObject({ value: 14.3, direction: 'up' });
  });

  it('previous_period twins hold the days just before the range; no comparison, no twins', async () => {
    const res = await h.call('POST', ADMIN_Q('commerce.orders'), h.tokens.staff(), { range: { from: '2026-03-01', to: '2026-03-03' }, granularity: 'day', compare: 'previous_period', sellerId: SELLER });
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ compare: 'previous_period', compareRange: { from: '2026-02-26', to: '2026-02-28' } });
    const twin = res.body.series.find((s: { key: string }) => s.key === 'gross_sales:compare');
    expect(twin.points.map((p: { x: string; y: number; compareX: string }) => [p.x, p.y, p.compareX])).toEqual([
      ['2026-03-01', 0, '2026-02-26'],
      ['2026-03-02', 0, '2026-02-27'],
      ['2026-03-03', 2000, '2026-02-28'],
    ]);
    const plain = await h.call('POST', ADMIN_Q('commerce.orders'), h.tokens.staff(), { range: { from: '2026-03-01', to: '2026-03-03' }, compare: 'none' });
    expect(plain.body.series.some((s: { key: string }) => s.key.endsWith(':compare'))).toBe(false);
    expect(plain.body.meta.compareRange).toBeUndefined();
  });

  it('a seller report gets the same twins, from its own sales only', async () => {
    const res = await h.call('POST', SELLER_Q('seller.order_trend'), h.tokens.seller(SELLER), { range: { from: '2026-03-01', to: '2026-03-03' }, granularity: 'day', compare: 'same_period_last_year' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.series.map((s: { key: string }) => s.key)).toEqual(['gross_sales', 'orders', 'gross_sales:compare', 'orders:compare']);
    expect(res.body.series.find((s: { key: string }) => s.key === 'gross_sales:compare').points[1].y).toBe(7000);
    const other = await h.call('POST', SELLER_Q('seller.order_trend'), h.tokens.seller(newId()), { range: { from: '2026-03-01', to: '2026-03-03' }, granularity: 'day', compare: 'same_period_last_year' });
    expect(other.body.series.find((s: { key: string }) => s.key === 'gross_sales:compare').points.map((p: { y: number }) => p.y)).toEqual([0, 0, 0]);
  });

  it('weeks: twin points follow the current buckets; a comparison bucket beyond them is left out', async () => {
    // Mon 2 Mar - Sun 15 Mar 2026 is two weeks; the same dates in 2025 run Sun 2 Mar - Sat 15 Mar: three weeks
    const res = await h.call('POST', ADMIN_Q('commerce.sales'), h.tokens.staff(), { range: { from: '2026-03-02', to: '2026-03-15' }, granularity: 'week', compare: 'same_period_last_year', sellerId: SELLER });
    const twin = res.body.series.find((s: { key: string }) => s.key === 'gross_sales:compare');
    expect(twin.points.map((p: { x: string }) => p.x)).toEqual(['2026-03-02', '2026-03-09']);
    expect(twin.points[0]).toMatchObject({ compareX: '2025-02-24', y: 7000 });
  });
});
