import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { item, pizzeria, regular, section } from './fixtures.js';
import { ADDRESS_ID, boot, newId, usd, type Kit } from './helpers.js';

/**
 * GET /api/store/food/statistics: what the customer spent on food in a period, the trend and the breakdowns.
 * The card is charged on delivery, so only delivered orders count in spent; a cancelled or declined order is
 * counted apart, and one still on its way counts in neither but shows in byStatus.
 */
let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const RETURN = 'https://app.marketly.example/food/return';
const card = (token = 'tok_visa') => ({ kind: 'new_card', providerToken: token });
/** Noon in the market zone on `day` */
const at = (day: string) => k.clock.set(new Date(`${day}T20:00:00Z`));
const move = (id: string, action: string, over: Record<string, unknown> = {}) => k.admin('POST', `/orders/${id}/status`, { action, ...over });
const stats = (me: Record<string, string>, query = '') => k.store('GET', `/statistics${query}`, undefined, me);

describe('food statistics', () => {
  it('counts delivered orders, splits the menu sections and the hour of day, and keeps what never arrived apart', async () => {
    // Napoli Corner: a Margherita ($14.50) and a Lemonade ($3.50) in "Pizza", a Tiramisu ($6.50) in "Desserts"
    const shop = await pizzeria(k, { name: 'Napoli Corner' });
    const sweets = await section(k, shop.r.id, 'Desserts');
    const tiramisu = await item(k, shop.r.id, sweets.id, { name: 'Tiramisu', price: usd(650) });
    const grill = await pizzeria(k, { name: 'Harbor Grill', cuisine: 'Burgers · American', deliveryFee: usd(299) });

    const accountId = newId();
    const me = () => k.customer(accountId);

    /** Fills the basket and places an order; answers the order */
    async function order(day: string, lines: { itemId: string; quantity: number; options?: unknown }[], total: number) {
      at(day);
      for (const l of lines) {
        const added = await k.store('POST', '/basket/lines', { itemId: l.itemId, quantity: l.quantity, ...(l.options ? { options: l.options } : {}) }, me());
        // 201 opens a basket, 200 adds to one already open
        expect([200, 201], JSON.stringify(added.body)).toContain(added.status);
      }
      const res = await k.store('POST', '/orders', { addressId: ADDRESS_ID, expectedTotal: usd(total), method: card(), returnUrl: RETURN }, { ...me(), 'idempotency-key': newId() });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body;
    }

    // Fri 2030-01-11, 12:00 → the 12 pm block: pizza + lemonade + tiramisu = $24.50 + $1.99 = $26.49, delivered
    const first = await order('2030-01-11', [
      { itemId: shop.pizza.id, quantity: 1, options: regular },
      { itemId: shop.drink.id, quantity: 1 },
      { itemId: tiramisu.id, quantity: 1 },
    ], 2649);
    for (const a of ['accept', 'send']) expect((await move(first.id, a)).status, a).toBe(200);
    k.clock.advance(34 * 60_000); // 34 minutes to the door
    expect((await move(first.id, 'deliver')).status).toBe(200);
    // rated while it is fresh, so the review counts in the period
    const rated = await k.store('POST', `/orders/${first.id}/review`, { stars: 5, text: 'Hot and quick' }, me());
    expect(rated.status, JSON.stringify(rated.body)).toBe(200);

    // Sat 2030-01-12: two burgers from Harbor Grill = $29.00 + $2.99 = $31.99, delivered
    const second = await order('2030-01-12', [{ itemId: grill.pizza.id, quantity: 2, options: regular }], 3199);
    for (const a of ['accept', 'send']) expect((await move(second.id, a)).status, a).toBe(200);
    k.clock.advance(26 * 60_000);
    expect((await move(second.id, 'deliver')).status).toBe(200);

    // Sun 2030-01-13: cancelled before the restaurant accepted — never charged
    const dropped = await order('2030-01-13', [{ itemId: shop.drink.id, quantity: 1 }], 549);
    expect((await k.store('POST', `/orders/${dropped.id}/cancel`, { reason: 'Changed my mind' }, me())).status).toBe(200);

    // Mon 2030-01-14: still on its way at the time of the report
    const underWay = await order('2030-01-14', [{ itemId: shop.drink.id, quantity: 2 }], 899);
    await move(underWay.id, 'accept');

    at('2030-01-15');
    const { status, body } = await stats(me(), '?range=last_30_days&grain=day');
    expect(status, JSON.stringify(body)).toBe(200);

    expect(body.totals).toMatchObject({
      spent: usd(2649 + 3199),
      delivery: usd(199 + 299),
      dishesTotal: usd(2450 + 2900),
      notDelivered: usd(549),
      orders: 2,
      dishes: 5, // 1 pizza + 1 lemonade + 1 tiramisu + 2 burgers
      restaurants: 2,
      averageOrder: usd(2924),
      reviews: 1,
      averageRating: 5,
    });
    expect(body.totals.largestOrder).toMatchObject({ ref: second.ref, restaurant: 'Harbor Grill', amount: usd(3199) });
    expect(body.totals.averageDeliveryMinutes).toBe(30);

    expect(body.byRestaurant.map((r: any) => [r.label, r.amount.amount, r.units])).toEqual([
      ['Harbor Grill', 3199, 2],
      ['Napoli Corner', 2649, 3],
    ]);
    // the menu sections the dishes came from, over the dishes total
    expect(body.byMenuSection.map((r: any) => [r.label, r.amount.amount, r.units])).toEqual([
      ['Pizza', 4700, 4],
      ['Desserts', 650, 1],
    ]);
    // biggest first; the two rows tied at one keep the order the orders were placed in
    expect(body.byStatus[0]).toMatchObject({ key: 'delivered', count: 2, amount: usd(2649 + 3199) });
    expect(Object.fromEntries(body.byStatus.map((r: any) => [r.key, r.count]))).toEqual({ delivered: 2, cancelled: 1, accepted: 1 });
    // every order went in at noon
    expect(body.byHour.map((h: any) => [h.label, h.count])).toEqual([
      ['12 am', 0],
      ['4 am', 0],
      ['8 am', 0],
      ['12 pm', 2],
      ['4 pm', 0],
      ['8 pm', 0],
    ]);
    expect(body.byWeekday.filter((d: any) => d.count > 0).map((d: any) => [d.weekday, d.amount.amount])).toEqual([
      ['fri', 2649],
      ['sat', 3199],
    ]);
    expect(body.series.filter((p: any) => p.amount.amount > 0).map((p: any) => [p.start, p.amount.amount, p.count])).toEqual([
      ['2030-01-11', 2649, 1],
      ['2030-01-12', 3199, 1],
    ]);
    // what never arrived rides the second series
    expect(body.series.filter((p: any) => p.secondary.amount > 0).map((p: any) => [p.start, p.secondary.amount])).toEqual([['2030-01-13', 549]]);
    expect(body.topDishes.map((d: any) => [d.name, d.units, d.amount.amount, d.restaurant])).toEqual([
      ['Margherita pizza 12"', 2, 2900, 'Harbor Grill'],
      ['Margherita pizza 12"', 1, 1450, 'Napoli Corner'],
      ['Tiramisu', 1, 650, 'Napoli Corner'],
      ['Lemonade', 1, 350, 'Napoli Corner'],
    ]);
  });

  it('answers an empty report for a customer who has never ordered', async () => {
    at('2030-01-15');
    const me = k.customer(newId());
    const { body } = await stats(me, '?range=last_30_days');
    expect(body.totals).toMatchObject({ spent: usd(0), orders: 0, dishes: 0, restaurants: 0, averageOrder: usd(0), averageDeliveryMinutes: null, averageRating: null, largestOrder: null });
    expect(body.byRestaurant).toEqual([]);
    expect(body.topDishes).toEqual([]);
    expect(body.byHour).toHaveLength(6);
    expect(body.previous).toMatchObject({ amount: usd(0), count: 0, changePct: null });
  });

  it('refuses a half-given or over-long custom period, and needs a customer', async () => {
    at('2030-01-15');
    const me = k.customer(newId());
    expect((await stats(me, '?from=2030-01-01')).status).toBe(400);
    expect((await stats(me, '?from=2020-01-01&to=2030-01-01')).status).toBe(400);
    expect((await k.store('GET', '/statistics')).status).toBe(401);
  });
});
