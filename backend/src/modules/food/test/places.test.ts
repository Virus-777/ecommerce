/** Restaurant points, distance labels, saved restaurants and the reviews screen (store/food-reviews) */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { distanceMiles, milesLabel } from '../../../kernel/lib/geo.js';
import { restaurantPoints } from '../migrations.js';
import { pizzeria, regular, restaurant } from './fixtures.js';
import { ADDRESS_ID, boot, DOWNTOWN, newId, PEARL, usd, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const base = { cuisine: 'Pizza · Italian', deliveryMinMinutes: 20, deliveryMaxMinutes: 30, deliveryFee: usd(199) };
const tagged = () => `t${newId().slice(-8)}`;
/** A customer whose default delivery address is in the Pearl District */
const pearlCustomer = () => {
  const accountId = newId();
  k.locations.set(accountId, PEARL);
  return { accountId, me: k.customer(accountId) };
};
const PEARL_TO_DOWNTOWN = milesLabel(distanceMiles(PEARL, DOWNTOWN));

describe('restaurant points', () => {
  it('geocodes the address on create, reading "Portland, OR" as city and state', async () => {
    k.geocodes.length = 0;
    const r = await restaurant(k, { address: '118 Bay Rd', city: 'Portland, OR' });
    expect(k.geocodes).toEqual([{ line1: '118 Bay Rd', city: 'Portland', region: 'OR' }]);
    expect(r).toMatchObject({ point: DOWNTOWN, pointSource: 'geocoded', region: null, postalCode: null });
    // region and postal code are used when given: the ZIP is the better point
    const z = await restaurant(k, { address: '1001 NW Lovejoy St', city: 'Portland', region: 'OR', postalCode: '97209' });
    expect(z).toMatchObject({ point: PEARL, pointSource: 'geocoded', region: 'OR', postalCode: '97209' });
  });

  it('keeps a staff pin until staff drop it, and re-geocodes only when the address changes', async () => {
    const pin = { lat: 45.52, lng: -122.67 };
    const r = await restaurant(k, { address: '27 Couch St', city: 'Portland, OR', point: pin });
    expect(r).toMatchObject({ point: pin, pointSource: 'staff' });
    const patch = (over: Record<string, unknown>) => k.admin('PATCH', `/restaurants/${r.id}`, { name: r.name, ...base, ...over });
    k.geocodes.length = 0;
    // a new address keeps the pin
    expect((await patch({ address: '30 Couch St' })).body).toMatchObject({ point: pin, pointSource: 'staff' });
    expect(k.geocodes).toEqual([]);
    // null drops the pin: the address is geocoded again
    expect((await patch({ point: null })).body).toMatchObject({ point: DOWNTOWN, pointSource: 'geocoded' });
    expect(k.geocodes).toHaveLength(1);
    // an unchanged address with a point is not geocoded again; a changed one is
    await patch({ phone: '503-555-0100' });
    expect(k.geocodes).toHaveLength(1);
    expect((await patch({ postalCode: '97209' })).body).toMatchObject({ point: PEARL, pointSource: 'geocoded' });
    expect(k.geocodes).toHaveLength(2);
    // a pin out of range is refused
    expect((await patch({ point: { lat: 95, lng: 0 } })).body.error.details.issues[0].path).toBe('point');
  });

  it('saves without a point when the geocoder cannot place the address or fails, and the backfill places it later', async () => {
    const unknown = await restaurant(k, { address: '1 Main St', city: 'Nowhere', region: 'OR' });
    expect(unknown).toMatchObject({ point: null, pointSource: null });
    k.geocoderDown = true;
    const down = await restaurant(k, { address: '2 Main St', city: 'Portland, OR' });
    k.geocoderDown = false;
    expect(down).toMatchObject({ point: null, pointSource: null });

    k.places.set('Nowhere, OR', PEARL);
    const food = k.app.kernel.boot.apis.get('food') as unknown as { geocodeRestaurants(): Promise<void> };
    await food.geocodeRestaurants();
    expect((await k.admin('GET', `/restaurants/${unknown.id}`)).body).toMatchObject({ point: PEARL, pointSource: 'geocoded' });
    expect((await k.admin('GET', `/restaurants/${down.id}`)).body).toMatchObject({ point: DOWNTOWN, pointSource: 'geocoded' });
    k.places.delete('Nowhere, OR');
  });

  it('migration: fills the new fields of restaurants saved before points existed', async () => {
    const calls: [unknown, unknown][] = [];
    const db = { collection: (name: string) => ({ updateMany: async (f: unknown, u: unknown) => void calls.push([f, u]), name }) };
    await restaurantPoints.up(db as never);
    expect(calls).toEqual(['region', 'postal_code', 'lat', 'lng', 'point_source'].map((c) => [{ [c]: { $exists: false } }, { $set: { [c]: null } }]));
  });
});

describe('distance labels', () => {
  it('shows the distance from the customer’s default address on cards and the restaurant, and the city to everyone else', async () => {
    const tag = tagged();
    const near = await restaurant(k, { name: `Near ${tag}`, address: '1001 NW Lovejoy St', city: 'Portland', region: 'OR', postalCode: '97209', position: 2 });
    const far = await restaurant(k, { name: `Far ${tag}`, address: '118 Bay Rd', city: 'Portland, OR', position: 1 });
    const nowhere = await restaurant(k, { name: `Unplaced ${tag}`, city: 'Nowhere, OR', position: 0 });
    const { me } = pearlCustomer();

    const visitor = (await k.store('GET', `/restaurants?q=${tag}`)).body.items;
    expect(visitor.map((c: any) => [c.distanceLabel, c.saved])).toEqual([[null, false], [null, false], [null, false]]);
    expect(visitor.find((c: any) => c.id === far.id).city).toBe('Portland, OR');

    const mine = (await k.store('GET', `/restaurants?q=${tag}`, undefined, me)).body.items;
    const label = new Map(mine.map((c: any) => [c.id, c.distanceLabel]));
    expect(label.get(near.id)).toBe('0.1 mi');
    expect(label.get(far.id)).toBe(PEARL_TO_DOWNTOWN);
    expect(label.get(nowhere.id)).toBeNull();
    // nearest first, restaurants without a point last; visitors get the recommended order
    expect((await k.store('GET', `/restaurants?q=${tag}&sort=nearest`, undefined, me)).body.items.map((c: any) => c.id)).toEqual([near.id, far.id, nowhere.id]);
    expect((await k.store('GET', `/restaurants?q=${tag}&sort=nearest`)).body.items.map((c: any) => c.id)).toEqual([nowhere.id, far.id, near.id]);

    // the restaurant's meta line and the item page's card
    expect((await k.store('GET', `/restaurants/${far.slug}`, undefined, me)).body).toMatchObject({ address: '118 Bay Rd', distanceLabel: PEARL_TO_DOWNTOWN, saved: false });
    expect((await k.store('GET', `/restaurants/${far.slug}`)).body).toMatchObject({ distanceLabel: null, saved: false });
    // a customer without a geocoded default address sees the city
    expect((await k.store('GET', `/restaurants/${far.slug}`, undefined, k.customer(newId()))).body.distanceLabel).toBeNull();
  });

  it('labels the restaurant on the item page and in the basket', async () => {
    const shop = await pizzeria(k, { address: '118 Bay Rd', city: 'Portland, OR' });
    const { me } = pearlCustomer();
    expect((await k.store('GET', `/items/${shop.pizza.id}`, undefined, me)).body.restaurant).toMatchObject({ distanceLabel: PEARL_TO_DOWNTOWN, saved: false });
    const basket = (await k.store('POST', '/basket/lines', { itemId: shop.pizza.id, quantity: 1, options: regular }, me)).body;
    expect(basket.restaurant).toMatchObject({ id: shop.r.id, distanceLabel: PEARL_TO_DOWNTOWN });
  });
});

describe('saved restaurants', () => {
  it('saves and removes a restaurant, both safe to repeat, with the heart on cards and the restaurant', async () => {
    const tag = tagged();
    const a = await restaurant(k, { name: `Alpha ${tag}`, city: 'Portland, OR' });
    const b = await restaurant(k, { name: `Beta ${tag}` });
    const { me, accountId } = pearlCustomer();
    expect((await k.store('PUT', `/saved-restaurants/${a.slug}`, undefined, me)).status).toBe(204);
    expect((await k.store('PUT', `/saved-restaurants/${a.slug}`, undefined, me)).status).toBe(204);
    k.clock.advance(60_000);
    expect((await k.store('PUT', `/saved-restaurants/${b.slug}`, undefined, me)).status).toBe(204);

    const saved = (await k.store('GET', '/saved-restaurants', undefined, me)).body;
    expect(saved.items.map((c: any) => c.id)).toEqual([b.id, a.id]);
    expect(saved.items[1]).toMatchObject({ saved: true, distanceLabel: PEARL_TO_DOWNTOWN });
    expect((await k.store('GET', `/restaurants/${a.slug}`, undefined, me)).body.saved).toBe(true);
    expect((await k.store('GET', `/restaurants?q=${tag}`, undefined, me)).body.items.every((c: any) => c.saved)).toBe(true);
    // someone else's heart is not mine
    expect((await k.store('GET', `/restaurants/${a.slug}`, undefined, k.customer(newId()))).body.saved).toBe(false);

    expect((await k.store('DELETE', `/saved-restaurants/${a.slug}`, undefined, me)).status).toBe(204);
    expect((await k.store('DELETE', `/saved-restaurants/${a.slug}`, undefined, me)).status).toBe(204);
    expect((await k.store('DELETE', '/saved-restaurants/no-such-place', undefined, me)).status).toBe(204);
    expect((await k.store('PUT', '/saved-restaurants/no-such-place', undefined, me)).status).toBe(404);
    expect((await k.store('GET', `/restaurants/${a.slug}`, undefined, me)).body.saved).toBe(false);

    // a restaurant staff hide leaves the list and comes back when published again
    const patch = (status: string) => k.admin('PATCH', `/restaurants/${b.id}`, { name: b.name, ...base, status });
    await patch('hidden');
    expect((await k.store('GET', '/saved-restaurants', undefined, me)).body.items).toEqual([]);
    await patch('published');
    expect((await k.store('GET', '/saved-restaurants', undefined, me)).body.items.map((c: any) => c.id)).toEqual([b.id]);

    // visitors can't save; the data export lists saved restaurants
    expect((await k.store('PUT', `/saved-restaurants/${a.slug}`)).status).toBe(401);
    const food = k.app.kernel.boot.apis.get('food') as { exportCustomerData(i: { customerId: string; accountId: string }): Promise<any[]> };
    const sections = await food.exportCustomerData({ customerId: accountId, accountId });
    expect(sections.find((s) => s.key === 'food_saved_restaurants')?.records).toEqual([{ restaurant: b.name, savedAt: expect.any(String) }]);
  });
});

describe('restaurant reviews', () => {
  const card = (token: string) => ({ kind: 'new_card', providerToken: token });
  const move = (id: string, action: string) => k.admin('POST', `/orders/${id}/status`, { action });

  /** A delivered order of `lines` from the shop, rated by a new customer called `name` */
  async function rated(shopItems: { itemId: string; quantity: number; options?: unknown }[], name: string, stars: number, text?: string) {
    const accountId = newId();
    const me = k.customer(accountId);
    let basket: any;
    for (const l of shopItems) basket = (await k.store('POST', '/basket/lines', l, me)).body;
    const o = (await k.store('POST', '/orders', { addressId: ADDRESS_ID, expectedTotal: basket.total, method: card('tok_visa'), returnUrl: 'https://app.marketly.example/food/return' }, { ...me, 'idempotency-key': newId() })).body;
    for (const a of ['accept', 'send', 'deliver']) expect((await move(o.id, a)).status).toBe(200);
    k.names.set(accountId, name);
    const res = await k.store('POST', `/orders/${o.id}/review`, { stars, ...(text ? { text } : {}) }, me);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    k.clock.advance(60_000);
    return o;
  }

  it('lists visible reviews newest first with what was ordered, and the rating summary', async () => {
    const shop = await pizzeria(k);
    await rated([{ itemId: shop.pizza.id, quantity: 2, options: regular }, { itemId: shop.drink.id, quantity: 1 }], 'Maya Reyes', 5, 'Best crust in town');
    await rated([{ itemId: shop.drink.id, quantity: 1 }, { itemId: shop.pizza.id, quantity: 1, options: regular }], 'Owen Park', 3);
    await rated([{ itemId: shop.pizza.id, quantity: 1, options: regular }], 'Lena Fox', 4, 'Good, a bit late');

    const page = (await k.store('GET', `/restaurants/${shop.r.slug}/reviews`)).body;
    expect(page.items.map((v: any) => [v.name, v.stars])).toEqual([['Lena F.', 4], ['Owen P.', 3], ['Maya R.', 5]]);
    expect(page.items[2]).toMatchObject({ text: 'Best crust in town', items: ['2 × Margherita pizza 12"', 'Lemonade'], date: expect.any(String) });
    expect(page.items[1]).toMatchObject({ text: null, items: ['Lemonade', 'Margherita pizza 12"'] });
    // paging and the stars filter
    const first = (await k.store('GET', `/restaurants/${shop.r.slug}/reviews?limit=2`)).body;
    expect(first.items).toHaveLength(2);
    const rest = (await k.store('GET', `/restaurants/${shop.r.slug}/reviews?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).body;
    expect(rest.items.map((v: any) => v.name)).toEqual(['Maya R.']);
    expect((await k.store('GET', `/restaurants/${shop.r.slug}/reviews?stars=5`)).body.items.map((v: any) => v.name)).toEqual(['Maya R.']);
    expect((await k.store('GET', `/restaurants/${shop.r.slug}/reviews?stars=9`)).status).toBe(400);

    expect((await k.store('GET', `/restaurants/${shop.r.slug}/ratings`)).body).toEqual({ restaurantId: shop.r.id, slug: shop.r.slug, name: shop.r.name, ratings: { average: 4, count: 3, stars: [1, 1, 1, 0, 0] } });

    // a hidden review leaves the list and the summary
    const hidden = (await k.admin('GET', `/reviews?restaurantId=${shop.r.id}&stars=3`)).body.items[0];
    await k.admin('POST', `/reviews/${hidden.id}/moderate`, { hidden: true, reason: 'Off topic' });
    expect((await k.store('GET', `/restaurants/${shop.r.slug}/reviews`)).body.items.map((v: any) => v.name)).toEqual(['Lena F.', 'Maya R.']);
    expect((await k.store('GET', `/restaurants/${shop.r.slug}/ratings`)).body.ratings).toEqual({ average: 4.5, count: 2, stars: [1, 1, 0, 0, 0] });

    // drafts and unknown slugs are not found
    const draft = await restaurant(k, { status: 'draft' });
    expect((await k.store('GET', `/restaurants/${draft.slug}/reviews`)).status).toBe(404);
    expect((await k.store('GET', '/restaurants/no-such-place/ratings')).status).toBe(404);
  });
});
