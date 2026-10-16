/**
 * Wave 3: the company trading cost reports (finance.companyCostsByDay), Complaint patterns (support.caseStatsByDay)
 * and the response times in Response time and case backlog (support and messaging), read when the report runs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { REPORTS } from '../domain/catalogue.js';
import { harness, usd, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.companyCosts.length = 0;
  h.caseStats.length = 0;
  h.replyStats.length = 0;
  h.responseApis.off = false;
});

const kpi = (body: any, key: string) => body.kpis.find((k: any) => k.metricKey === key);
const staffReport = (key: string, query: Record<string, unknown> = {}) => h.call('POST', `/api/admin/reports/reports/${key}/query`, h.tokens.staff(), query);
const today = () => dateInZone(h.clock.now(), 'America/Los_Angeles');
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const cost = (date: string, kind: string, amount: number) => h.companyCosts.push({ date, kind: kind as never, amount: usd(amount), entries: 1 });
const cases = (o: { date: string; sellerId?: string | null; key: string; label: string; opened: number; replied?: number; minutes?: number; onTime?: number; audience?: 'customer' | 'seller' }) =>
  h.caseStats.push({
    date: o.date,
    sellerId: o.sellerId ?? null,
    categoryKey: o.key,
    categoryLabel: o.label,
    group: 'delivery',
    audience: o.audience ?? 'customer',
    opened: o.opened,
    firstReplied: o.replied ?? 0,
    firstReplyMinutesTotal: o.minutes ?? 0,
    firstReplyWithinTarget: o.onTime ?? 0,
    sellerReplied: 0,
    sellerReplyMinutesTotal: 0,
  });

describe('company trading cost reports', () => {
  it('Returns cost sums return losses, write-offs and chargebacks per day, with the previous period', async () => {
    const d = today();
    cost(d, 'return_loss', 4_000);
    cost(d, 'return_loss', 1_000);
    cost(d, 'write_off', 2_500);
    cost(shift(d, -1), 'return_loss', 2_000); // the previous period of "today"
    const r = await staffReport('trading.returns_cost', { preset: 'today', compare: 'previous_period' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(kpi(r.body, 'trading.return_losses')).toMatchObject({ value: 5_000, money: { amount: 5_000 } });
    expect(kpi(r.body, 'trading.return_losses').delta).toMatchObject({ direction: 'up', good: false });
    expect(kpi(r.body, 'trading.write_offs').value).toBe(2_500);
    expect(kpi(r.body, 'trading.chargeback_losses').value).toBe(0);
    expect(r.body.table.totals).toMatchObject({ return_losses: { amount: 5_000 }, write_offs: { amount: 2_500 } });
    expect(r.body.series.map((s: any) => s.key)).toEqual(['return_losses', 'write_offs', 'chargeback_losses']);
    expect(r.body.unavailable).toEqual([]);
  });

  it('Purchasing cost shows the buying cost of units sold next to booked costs and supplier credits', async () => {
    const d = today();
    cost(d, 'buying_cost', 12_000);
    cost(d, 'supplier_credit', 800);
    const r = await staffReport('trading.purchasing', { preset: 'today' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.kpis.map((k: any) => k.metricKey)).toEqual(['trading.buying_cost', 'trading.purchasing_booked', 'trading.supplier_credits']);
    expect(kpi(r.body, 'trading.purchasing_booked').value).toBe(12_000);
    expect(kpi(r.body, 'trading.supplier_credits').value).toBe(800);
    expect(r.body.table.columns.map((c: any) => c.key)).toEqual(['period', 'buying_cost', 'purchasing_booked', 'supplier_credits']);
  });

  it('Discounts and shipping expense states their share of Official Store sales', async () => {
    const o = h.order({ sellerId: null, items: [{ quantity: 1, unit: 10_000 }] });
    h.placed(o);
    await h.drain();
    cost(today(), 'discount', 500);
    cost(today(), 'shipping_expense', 700);
    const r = await staffReport('trading.discounts_shipping', { preset: 'today' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(kpi(r.body, 'trading.discounts').value).toBe(500);
    expect(kpi(r.body, 'trading.shipping_expense').value).toBe(700);
    expect(kpi(r.body, 'trading.official_sales').value).toBeGreaterThan(0);
    expect(r.body.callouts.map((c: any) => c.title)).toContain('Share of Official Store sales');
  });
});

describe('Complaint patterns', () => {
  it('counts customer complaints by reason and seller and names the reason that grew', async () => {
    const d = today();
    const a = newId();
    const b = newId();
    cases({ date: d, sellerId: a, key: 'delivery_late', label: 'Delivery, late item', opened: 3, replied: 2, minutes: 240 });
    cases({ date: d, sellerId: b, key: 'delivery_late', label: 'Delivery, late item', opened: 1 });
    cases({ date: d, sellerId: a, key: 'item_damaged', label: 'Damaged item', opened: 1 });
    cases({ date: d, sellerId: a, key: 'fees_payouts', label: 'Fees and payouts', opened: 5, audience: 'seller' }); // not a complaint
    cases({ date: shift(d, -1), sellerId: a, key: 'delivery_late', label: 'Delivery, late item', opened: 1 });
    const r = await staffReport('service.complaints', { preset: 'today', compare: 'previous_period' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(kpi(r.body, 'service.complaints')).toMatchObject({ value: 5, note: 'Most often: Delivery, late item (80%)' });
    expect(kpi(r.body, 'service.response_time').value).toBe(2); // 240 minutes over 2 replies
    expect(r.body.breakdowns[0].rows[0]).toMatchObject({ key: 'delivery_late', count: 4, sharePct: 80, previous: 1, change: 3 });
    expect(r.body.table.rows[0]).toMatchObject({ sellerId: a, complaints: 4, topReason: 'Delivery, late item' });
    expect(r.body.callouts[0].title).toBe('Delivery, late item is growing');
    // one seller
    const one = await staffReport('service.complaints', { preset: 'today', sellerId: b });
    expect(kpi(one.body, 'service.complaints').value).toBe(1);
  });

  it('is unavailable without support', async () => {
    h.responseApis.off = true;
    const r = await staffReport('service.complaints', { preset: 'today' });
    expect(r.status).toBe(200);
    expect(r.body.unavailable).toEqual(['service.complaints', 'service.response_time']);
  });
});

describe('Response time and case backlog', () => {
  it('adds case first replies and seller message replies, in total and per seller', async () => {
    const d = today();
    const a = newId();
    cases({ date: d, sellerId: a, key: 'delivery_late', label: 'Delivery, late item', opened: 4, replied: 3, minutes: 540, onTime: 2 });
    h.replyStats.push({ date: d, sellerId: a, waiting: 5, replied: 4, replyMinutesTotal: 480, repliedWithinTarget: 4, targetHours: 24 });
    const r = await staffReport('service.cases', { preset: 'today' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(REPORTS.find((x) => x.key === 'service.cases')!.title).toBe('Response time and case backlog');
    expect(kpi(r.body, 'service.response_time')).toMatchObject({ value: 3, note: '3 of 4 cases answered' });
    expect(kpi(r.body, 'service.first_reply_on_time').value).toBe(50);
    expect(kpi(r.body, 'service.message_reply_time')).toMatchObject({ value: 2, note: '4 of 5 messages answered' });
    expect(r.body.unavailable).toEqual([]);
    expect(r.body.table.rows.find((x: any) => x.sellerId === a)).toMatchObject({ firstReplyHours: 3, messageReplyHours: 2 });
  });
});
