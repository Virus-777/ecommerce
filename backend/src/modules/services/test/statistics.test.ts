import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, MORNINGS, newId, type Kit } from './helpers.js';

/**
 * GET /api/store/services/statistics: the customer's requests in a period, the trend and the breakdowns.
 * These services are paid at the provider, so the report counts requests; `estimated` adds up the price list for
 * the requests that have a fixed price per request and leaves out the ones charged by the hour.
 */
let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const cents = (amount: number) => ({ amount, currency: 'USD' });
const usd = (amount: number) => ({ amount, currency: 'USD' });
const contact = { name: 'Dana Ross', phone: '503-555-0101' };
/** Noon in the market zone on `day` */
const at = (day: string) => k.clock.set(new Date(`${day}T20:00:00Z`));
let seq = 0;

async function provider(over: Record<string, unknown> = {}) {
  const res = await k.admin('POST', '/providers', { name: `Provider ${++seq}`, hours: MORNINGS, ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
async function service(providerId: string, over: Record<string, unknown> = {}) {
  const res = await k.admin('POST', '/services', { area: 'welfare', title: `Service ${++seq}`, providerId, fromPrice: cents(2500), ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
const stats = (me: Record<string, string>, query = '') => k.store('GET', `/statistics${query}`, undefined, me);

describe('services statistics', () => {
  it('counts requests, estimates only what has a fixed price, and breaks the period down', async () => {
    const care = await provider({ name: 'Brightside Care Co.' });
    // by the hour, with a price list: Overnight is a fixed price per request, Weekly is a rate, Assessment is free
    const elder = await service(care.id, {
      title: 'In-home elder care',
      priceUnit: 'hour',
      fromPrice: cents(2400),
      handover: [{ mode: 'at_home' }],
      priceTable: [
        { label: 'Weekly', detail: '3+ visits a week', price: '$24/hr' },
        { label: 'Overnight', detail: '9 pm – 7 am', price: '$190/night' },
        { label: 'Assessment', detail: 'Before first visit', price: 'Free' },
      ],
    });
    // a fixed price per visit, no price list
    const check = await service(care.id, { title: 'Home health check', priceUnit: 'visit', fromPrice: cents(4500), handover: [{ mode: 'at_home' }] });

    const customer = newId();
    const me = () => k.customer(customer);
    // each request gets its own minute, so no two share a timestamp
    let minute = 0;
    const ask = async (day: string, serviceId: string, plan?: string) => {
      at(day);
      k.clock.advance(++minute * 60_000);
      const res = await k.store('POST', '/requests', { serviceId, contact, details: { careFor: 'My mother, 78', handover: 'at_home', ...(plan ? { plan } : {}) } }, { ...me(), 'idempotency-key': newId() });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body;
    };

    // Mon 2030-01-07: an overnight stay → $190 by the price list
    const overnight = await ask('2030-01-07', elder.id, 'Overnight');
    // Tue 2030-01-08: a weekly plan, charged by the hour → no estimate
    const weekly = await ask('2030-01-08', elder.id, 'Weekly');
    // Tue 2030-01-08: the free assessment → $0
    await ask('2030-01-08', elder.id, 'Assessment');
    // Wed 2030-01-09: two health checks at $45 each
    const firstCheck = await ask('2030-01-09', check.id);
    await ask('2030-01-09', check.id);

    // the provider finishes the overnight stay two days on, and the customer rates it
    at('2030-01-09');
    expect((await k.admin('PATCH', `/requests/${overnight.id}`, { status: 'confirmed' })).status).toBe(200);
    expect((await k.admin('PATCH', `/requests/${overnight.id}`, { status: 'completed' })).status).toBe(200);
    const rated = await k.store('POST', `/requests/${overnight.id}/review`, { rating: 5, text: 'Kind and on time' }, me());
    expect(rated.status, JSON.stringify(rated.body)).toBe(201);
    // one is cancelled, one declined
    expect((await k.store('POST', `/requests/${weekly.id}/cancel`, {}, me())).status).toBe(200);
    expect((await k.admin('PATCH', `/requests/${firstCheck.id}`, { status: 'declined', providerNote: 'No nurse free' })).status).toBe(200);

    at('2030-01-10');
    const { status, body } = await stats(me(), '?area=welfare&range=last_30_days&grain=day');
    expect(status, JSON.stringify(body)).toBe(200);

    expect(body).toMatchObject({ area: 'welfare', grain: 'day', currency: 'USD' });
    expect(body.totals).toMatchObject({
      requests: 5,
      completed: 1,
      underWay: 2, // the assessment and the second health check are still waiting
      cancelled: 1,
      declined: 1,
      services: 2,
      providers: 1,
      // $190 overnight + $0 assessment + $45 + $45 — the hourly Weekly plan is left out
      estimated: usd(19_000 + 0 + 4500 + 4500),
      estimatedFrom: 4,
      reviews: 1,
      averageRating: 5,
    });
    expect(body.totals.topProvider).toMatchObject({ providerId: care.id, name: 'Brightside Care Co.', requests: 5 });
    expect(body.totals.averageDays).toBe(2);

    expect(body.byService.map((r: any) => [r.label, r.count, r.sharePct])).toEqual([
      ['In-home elder care', 3, 60],
      ['Home health check', 2, 40],
    ]);
    expect(body.byProvider.map((r: any) => [r.label, r.count])).toEqual([['Brightside Care Co.', 5]]);
    // biggest first; the three rows tied at one request keep the order they were asked in
    expect(body.byPlan[0]).toMatchObject({ label: 'No plan chosen', count: 2, amount: usd(9000) });
    expect(Object.fromEntries(body.byPlan.map((r: any) => [r.label, [r.count, r.amount.amount]]))).toEqual({
      'No plan chosen': [2, 9000],
      Overnight: [1, 19_000],
      Weekly: [1, 0],
      Assessment: [1, 0],
    });
    expect(Object.fromEntries(body.byStatus.map((r: any) => [r.key, r.count]))).toEqual({ requested: 2, completed: 1, cancelled: 1, declined: 1 });
    // Mon one, Tue two, Wed two
    expect(body.byWeekday.filter((d: any) => d.count > 0).map((d: any) => [d.weekday, d.count])).toEqual([
      ['mon', 1],
      ['tue', 2],
      ['wed', 2],
    ]);
    expect(body.series.filter((p: any) => p.count > 0).map((p: any) => [p.start, p.count, p.amount.amount])).toEqual([
      ['2030-01-07', 1, 19_000],
      ['2030-01-08', 2, 0],
      ['2030-01-09', 2, 9000],
    ]);
    expect(body.topServices.map((s: any) => [s.title, s.requests, s.provider])).toEqual([
      ['In-home elder care', 3, 'Brightside Care Co.'],
      ['Home health check', 2, 'Brightside Care Co.'],
    ]);
  });

  it('counts one area at a time, and every area when none is named', async () => {
    const p = await provider();
    const welfare = await service(p.id, { area: 'welfare', title: 'Home help', priceUnit: 'visit', fromPrice: cents(3000) });
    const phone = await service(p.id, { area: 'post_sale', title: 'Battery replacement', priceUnit: 'fixed', fromPrice: cents(8900) });
    const customer = newId();
    const me = () => k.customer(customer);
    at('2030-01-10');
    for (const id of [welfare.id, phone.id]) {
      const res = await k.store('POST', '/requests', { serviceId: id, contact }, { ...me(), 'idempotency-key': newId() });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    expect((await stats(me(), '?area=welfare&range=last_30_days')).body.totals).toMatchObject({ requests: 1, estimated: usd(3000) });
    expect((await stats(me(), '?area=post_sale&range=last_30_days')).body.totals).toMatchObject({ requests: 1, estimated: usd(8900) });
    const every = (await stats(me(), '?range=last_30_days')).body;
    expect(every.area).toBeNull();
    expect(every.totals).toMatchObject({ requests: 2, estimated: usd(11_900), services: 2 });
  });

  it('answers an empty report, refuses a bad period and needs a customer', async () => {
    at('2030-01-10');
    const me = k.customer(newId());
    const { body } = await stats(me, '?area=welfare&range=last_30_days');
    expect(body.totals).toMatchObject({ requests: 0, completed: 0, estimated: usd(0), estimatedFrom: 0, averageDays: null, averageRating: null, topProvider: null });
    expect(body.byService).toEqual([]);
    expect(body.topServices).toEqual([]);
    expect(body.previous).toMatchObject({ count: 0, changePct: null });
    expect((await stats(me, '?from=2030-01-01')).status).toBe(400);
    expect((await stats(me, '?from=2020-01-01&to=2030-01-01')).status).toBe(400);
    expect((await k.store('GET', '/statistics')).status).toBe(401);
  });
});
