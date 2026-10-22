import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOOD_CATEGORIES, RESTAURANTS, seedFood } from '../../../../tools/simulate/food-data.js';
import { boot, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

describe('sample restaurants (tools/simulate/food-data.ts)', () => {
  it('passes the admin API as it is and adds nothing the second time', async () => {
    const admin = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => {
      const res = await k.call(method, `/api${path}`, body);
      if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const sections = RESTAURANTS.reduce((n, r) => n + Object.keys(r.menu).length, 0);
    const items = RESTAURANTS.reduce((n, r) => n + Object.values(r.menu).flat().length, 0);
    expect(await seedFood(admin)).toEqual({ categories: FOOD_CATEGORIES.length, restaurants: RESTAURANTS.length, sections, items });
    expect(await seedFood(admin)).toEqual({ categories: 0, restaurants: 0, sections: 0, items: 0 });

    // Wednesday noon: Tokyo Ramen House opens at 5 PM
    const list = (await k.store('GET', '/restaurants')).body.items;
    expect(list.map((r: any) => r.name)).toEqual(['Napoli Corner', 'Green Bowl Kitchen', 'Harbor Grill', 'Tokyo Ramen House']);
    expect(list[0]).toMatchObject({ cuisine: 'Pizza · Italian', deliveryLabel: '20–30 min', feeLabel: '$1.99 delivery', promoBadge: 'Free delivery', openLabel: 'Open until 11 PM', rating: null, ratingCount: 0 });
    expect(list[3]).toMatchObject({ open: false, openLabel: 'Closed · opens 5 PM', feeLabel: '$2.99 delivery' });
    const napoli = (await k.store('GET', '/restaurants/napoli-corner')).body;
    expect(napoli.sections.map((s: any) => s.name)).toEqual(['Popular', 'Pizza', 'Sides', 'Drinks', 'Desserts']);
    expect(napoli).toMatchObject({ address: '118 Bay Rd', minOrderLabel: 'Min. order $12.00', promoText: 'Free delivery on orders over $25 this week' });
    const recommended = (await k.store('GET', '/items?recommended=true')).body.items;
    expect(recommended.map((i: any) => i.name)).toEqual(['Margherita pizza 12"', 'Chicken avocado bowl', 'Tonkotsu ramen', 'Double smash burger']);
    expect(recommended[1]).toMatchObject({ priceLabel: '$11.90', wasLabel: '$14.00' });
    const margherita = (await k.store('GET', `/items/${recommended[0].id}`)).body;
    expect(margherita.optionGroups.map((g: any) => `${g.name} ${g.min}-${g.max}`)).toEqual(['Size 1-1', 'Extras 0-4']);
    expect((await k.store('GET', '/categories')).body.map((c: any) => c.icon)).toEqual(['pizza', 'hamburger', 'soup', 'salad', 'coffee', 'cake-slice']);
  });
});
