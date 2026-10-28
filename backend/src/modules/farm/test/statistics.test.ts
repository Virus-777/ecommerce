import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, dealer, newId, tractor, usd, type Kit } from './helpers.js';

/**
 * GET /api/store/farm/statistics: what the customer's machines cost in a period, the trend and the breakdowns.
 * The clock starts Wednesday 2030-01-09; the orders below are placed on days the test moves it to.
 */
let k: Kit;
let canby: any;
let salem: any;
beforeAll(async () => {
  k = await boot();
  canby = await dealer(k);
  salem = await dealer(k, { name: 'Willamette Farm Supply', address: { line1: '3050 Silverton Rd NE', city: 'Salem', region: 'OR', postalCode: '97301' }, phone: '503-555-0190', messagePhone: null, messageEmail: 'orders@willamette.example', leadDays: 7 });
});
afterAll(async () => {
  await k?.app.close();
});

const RETURN = 'https://app.marketly.example/farm/return';
const farm = { address: { name: 'Hollow Creek Farm', line1: '4410 County Rd 12', city: 'Canby', region: 'OR', postalCode: '97013' } };
const stats = (me: Record<string, string>, query = '') => k.store('GET', `/statistics${query}`, undefined, me);

/** Places an order on `day` (noon in the market zone) and answers it */
async function place(me: Record<string, string>, day: string, body: Record<string, unknown>) {
  k.clock.set(new Date(`${day}T20:00:00Z`));
  const res = await k.store('POST', '/orders', { location: farm, contactName: 'Daniel Moore', contactPhone: '(555) 014-2280', returnUrl: RETURN, ...body }, { ...me, 'idempotency-key': newId() });
  if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

describe('farm statistics', () => {
  it('counts what the machines cost, splits the deposit from the balance and breaks the period down', async () => {
    const accountId = newId();
    const me = k.customer(accountId);
    const t = tractor(k); // Kubota tractor $18,900, front loader $3,200 — typeId "tractors"
    const harvester = tractor(k, { price: 3_840_000 });
    harvester.machine.typeId = 'harvesters';

    // Tue 2030-01-15: pay in full, machine + loader = $22,100
    const full = await place(me, '2030-01-15', {
      productId: t.product.productId,
      attachmentIds: [t.loader.productId],
      deliveryDate: '2030-01-25',
      paymentOption: 'pay_in_full',
      expectedTotal: usd(2_210_000),
      method: { kind: 'new_card', providerToken: 'tok_visa' },
    });
    // Fri 2030-01-18: pay on delivery, harvester $38,400 → 10% deposit $3,840, balance $34,560
    const onDelivery = await place(me, '2030-01-18', {
      productId: harvester.product.productId,
      deliveryDate: '2030-01-28',
      paymentOption: 'pay_on_delivery',
      expectedTotal: usd(3_840_000),
      method: { kind: 'new_card', providerToken: 'tok_visa' },
    });
    // Mon 2030-01-21: installments, tractor alone $18,900 — then cancelled, so it counts apart
    const dropped = await place(me, '2030-01-21', {
      productId: t.product.productId,
      deliveryDate: '2030-02-01',
      paymentOption: 'installments',
      expectedTotal: usd(1_890_000),
    });
    await k.store('POST', `/orders/${dropped.id}/cancel`, { reason: 'Found one locally' }, me);

    // the dealer confirms the pay-on-delivery order, so its deposit is charged
    k.clock.set(new Date('2030-01-22T20:00:00Z'));
    const confirmed = await k.admin('POST', `/orders/${onDelivery.id}/status`, { action: 'confirm' });
    expect(confirmed.status).toBe(200);

    k.clock.set(new Date('2030-01-31T20:00:00Z'));
    const { status, body } = await stats(me, '?range=last_30_days&grain=day');
    expect(status).toBe(200);

    expect(body.totals).toMatchObject({
      spent: usd(2_210_000 + 3_840_000),
      cancelled: usd(1_890_000),
      delivery: usd(0),
      attachments: usd(320_000),
      depositsPaid: usd(384_000),
      dueOnDelivery: usd(3_456_000),
      orders: 2,
      machines: 2,
      attachmentCount: 1,
      averageOrder: usd(3_025_000),
    });
    expect(body.totals.largestOrder).toMatchObject({ ref: onDelivery.ref, amount: usd(3_840_000) });
    // nothing delivered yet
    expect(body.totals.averageDeliveryDays).toBeNull();

    expect(body).toMatchObject({ from: '2030-01-02', to: '2030-01-31', grain: 'day', currency: 'USD' });
    expect(body.series).toHaveLength(30);
    const spentDays = body.series.filter((p: any) => p.amount.amount > 0).map((p: any) => [p.start, p.amount.amount, p.count]);
    expect(spentDays).toEqual([
      ['2030-01-15', 2_210_000, 1],
      ['2030-01-18', 3_840_000, 1],
    ]);
    // the cancelled order rides the second series, never the first
    expect(body.series.filter((p: any) => p.secondary.amount > 0).map((p: any) => [p.start, p.secondary.amount])).toEqual([['2030-01-21', 1_890_000]]);

    expect(body.byMachineType.map((r: any) => [r.label, r.amount.amount, r.sharePct])).toEqual([
      ['Harvesters', 3_840_000, 63.5],
      ['Tractors', 2_210_000, 36.5],
    ]);
    expect(body.byDealer.map((r: any) => [r.label, r.count])).toEqual([['Greenfield Agri Equipment', 2]]);
    expect(body.byPaymentOption.map((r: any) => [r.key, r.label, r.amount.amount])).toEqual([
      ['pay_on_delivery', 'Pay on delivery', 3_840_000],
      ['pay_in_full', 'Pay in full', 2_210_000],
    ]);
    // Tue the 15th and Fri the 18th
    expect(body.byWeekday.filter((d: any) => d.count > 0).map((d: any) => [d.weekday, d.amount.amount])).toEqual([
      ['tue', 2_210_000],
      ['fri', 3_840_000],
    ]);
    expect(body.topMachines.map((m: any) => [m.title, m.orders, m.amount.amount])).toEqual([
      ['Kubota L2502 compact tractor', 1, 3_840_000],
      ['Kubota L2502 compact tractor', 1, 1_890_000],
    ]);
    expect(body.byDealer.some((r: any) => r.label === salem.name)).toBe(false);
    expect(canby.name).toBe('Greenfield Agri Equipment');
    expect(full.paymentOption).toBe('pay_in_full');
  });

  it('answers an empty report for a period with no orders, and compares with the period before', async () => {
    const me = k.customer(newId());
    k.clock.set(new Date('2030-01-31T20:00:00Z'));
    const empty = (await stats(me, '?range=last_30_days')).body;
    expect(empty.totals).toMatchObject({ spent: usd(0), orders: 0, machines: 0, averageOrder: usd(0), largestOrder: null });
    expect(empty.byMachineType).toEqual([]);
    expect(empty.topMachines).toEqual([]);
    expect(empty.series.every((p: any) => p.amount.amount === 0 && p.count === 0)).toBe(true);
    // every weekday is there, zeroed, so the chart has seven bars
    expect(empty.byWeekday.map((d: any) => d.weekday)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    expect(empty.previous).toMatchObject({ from: '2029-12-03', to: '2030-01-01', amount: usd(0), count: 0, changePct: null });
  });

  it('refuses a half-given or over-long custom period', async () => {
    const me = k.customer(newId());
    expect((await stats(me, '?from=2030-01-01')).status).toBe(400);
    expect((await stats(me, '?from=2030-01-02&to=2030-01-01')).status).toBe(400);
    expect((await stats(me, '?from=2020-01-01&to=2030-01-01')).status).toBe(400);
    expect((await stats(me, '?from=2030-01-01&to=2030-01-31')).status).toBe(200);
  });

  it('needs a customer', async () => {
    expect((await k.store('GET', '/statistics')).status).toBe(401);
  });
});
