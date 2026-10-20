import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { checkout, group, harness, line, product, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const URL = '/api/store/orders/orders/spending';

/**
 * One order of three items: Pixel & Port 2 × $50 − $10 + $6 shipping + $8 tax = $104; Casa Verde Home $100 + $5 +
 * $9 = $114, then $10 refunded; the Official Store's $40 + $3 tax cancelled by staff.
 */
async function spendingOrder(customerId: string) {
  const sellerA = newId();
  const sellerB = newId();
  const pa = product(h, { title: 'Pocket Speaker', price: 5000, sellerId: sellerA, sellerName: 'Pixel & Port' });
  const pb = product(h, { title: 'Duvet', price: 10000, sellerId: sellerB });
  const po = product(h, { title: 'Skillet', price: 4000, ownerType: 'official' });
  const order = await h.service.createOrder(
    checkout(
      [
        group(h, [line(pa, 2, { discount: 1000, shipping: 600, tax: 800 })], { sellerId: sellerA }),
        group(h, [line(pb, 1, { shipping: 500, tax: 900 })], { sellerId: sellerB }),
        group(h, [line(po, 1, { tax: 300 })], { ownerType: 'official' }),
      ],
      { customerId },
    ),
  );
  await h.app.kernel.events.drain();
  const official = order.groups[2]!.items[0]!;
  await h.service.cancellations.staffCancel(
    order.id,
    { items: [{ itemId: official.id, quantity: 1 }], reasonCode: 'seller_cannot_fulfill', reason: 'No stock', notifyCustomer: false },
    { actor: { kind: 'staff', id: newId() }, idempotencyKey: newId() },
  );
  const duvet = order.groups[1]!.items[0]!;
  await h.publish('payments', 'payments.refund.sent', {
    refundId: newId(),
    ref: 'RF-SPEND-1',
    orderId: order.id,
    origin: 'return',
    originId: null,
    amount: USD(1000),
    items: [{ orderItemId: duvet.id, title: 'Duvet', groupId: order.groups[1]!.id, sellerId: sellerB, amount: USD(1000) }],
    destination: 'Visa •••• 4417',
    sentAt: h.clock.now().toISOString(),
  });
  return { order, pa, pb };
}

describe('store: spending statistics', () => {
  it('totals what was paid for kept items minus refunds, with trend and breakdowns', async () => {
    const customerId = newId();
    const { order, pb } = await spendingOrder(customerId);
    // waiting for payment: left out
    const sellerC = newId();
    const lamp = product(h, { title: 'Lamp', price: 2000, sellerId: sellerC });
    await h.service.createOrder(checkout([group(h, [line(lamp, 1)], { sellerId: sellerC })], { customerId, paymentState: 'pending_check' }));

    const res = await h.call('GET', `${URL}?range=last_30_days`, tokens.customer(customerId));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = res.body;
    expect(s).toMatchObject({ grain: 'day', currency: 'USD' });
    expect(s.totals).toEqual({
      spent: USD(20800),
      refunded: USD(1000),
      cancelled: USD(4300),
      savings: USD(1000),
      shipping: USD(1100),
      tax: USD(1700),
      orders: 1,
      units: 3,
      averageOrder: USD(20800),
      largestOrder: { orderId: order.id, ref: order.ref, placedAt: expect.any(String), amount: USD(20800) },
    });
    expect(s.previous).toMatchObject({ spent: USD(0), orders: 0, changePct: null });

    // 30 daily points, today's holds the order
    expect(s.series).toHaveLength(30);
    expect(s.series[0].start).toBe(s.from);
    expect(s.series.at(-1)).toMatchObject({ start: s.to, spent: USD(20800), refunded: USD(1000), orders: 1 });
    expect(s.series.slice(0, -1).every((p: any) => p.spent.amount === 0 && p.orders === 0)).toBe(true);

    expect(s.byCategory).toEqual([{ key: expect.any(String), label: 'Home', amount: USD(20800), sharePct: 100, orders: 1, units: 3 }]);
    expect(s.bySeller).toHaveLength(2);
    expect(s.bySeller).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Pixel & Port', amount: USD(10400), sharePct: 50, units: 2 }),
        expect.objectContaining({ label: 'Casa Verde Home', amount: USD(10400), sharePct: 50, units: 1 }),
      ]),
    );
    expect(s.byPaymentMethod).toEqual([{ key: 'Visa •••• 4417', label: 'Visa •••• 4417', amount: USD(20800), sharePct: 100, orders: 1, units: 3 }]);
    expect(s.byWeekday).toHaveLength(7);
    expect(s.byWeekday.reduce((t: number, w: any) => t + w.amount.amount, 0)).toBe(20800);
    // the cancelled Skillet is not a top product
    expect(s.topProducts).toHaveLength(2);
    expect(s.topProducts.map((p: any) => [p.title, p.units, p.amount.amount])).toEqual(expect.arrayContaining([['Duvet', 1, 10400], ['Pocket Speaker', 2, 10400]]));
    expect(s.topProducts.find((p: any) => p.productId === pb.productId)).toMatchObject({ productSlug: 'duvet', image: { url: expect.any(String) } });
  });

  it('only counts the caller’s orders, and picks the grain from the period', async () => {
    const res = await h.call('GET', `${URL}?range=last_12_months`, tokens.customer(newId()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ grain: 'month', totals: { spent: USD(0), orders: 0, largestOrder: null }, byCategory: [], topProducts: [] });
    expect(res.body.series.length).toBeGreaterThanOrEqual(12);
    expect(res.body.series.length).toBeLessThanOrEqual(13);

    const weeks = await h.call('GET', `${URL}?from=2026-01-01&to=2026-03-01`, tokens.customer(newId()));
    expect(weeks.body).toMatchObject({ from: '2026-01-01', to: '2026-03-01', grain: 'week' });
    expect(weeks.body.series[0]).toMatchObject({ start: '2026-01-01', label: 'Week of Jan 1' });
    expect(weeks.body.series[1]).toMatchObject({ start: '2026-01-05', label: 'Week of Jan 5' }); // Mondays after the first
  });

  it('range all starts at the first order; previous is null', async () => {
    const customerId = newId();
    await spendingOrder(customerId);
    const res = await h.call('GET', `${URL}?range=all`, tokens.customer(customerId));
    expect(res.body).toMatchObject({ from: res.body.to, previous: null, totals: { orders: 1, spent: USD(20800) } });
  });

  it('rejects half a custom period and periods over 3 years', async () => {
    const me = tokens.customer(newId());
    expect((await h.call('GET', `${URL}?from=2026-01-01`, me)).status).toBe(400);
    expect((await h.call('GET', `${URL}?from=2026-03-01&to=2026-01-01`, me)).status).toBe(400);
    expect((await h.call('GET', `${URL}?from=2020-01-01&to=2026-01-01`, me)).status).toBe(400);
  });
});
