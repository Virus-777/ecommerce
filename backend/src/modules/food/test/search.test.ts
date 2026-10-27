/** Food delivery's part of the integrated search (search calls searchFood): restaurants, dishes and categories. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as common from '../../../spec/common.js';
import type { FoodService } from '../service.js';
import { pizzeria } from './fixtures.js';
import { boot, type Kit } from './helpers.js';

let k: Kit;
let svc: FoodService;
beforeAll(async () => {
  k = await boot();
  svc = k.app.kernel.boot.apis.get('food') as FoodService;
  await pizzeria(k, { name: 'Napoli Pizza', cuisine: 'Pizza · Italian' });
  await pizzeria(k, { name: 'Golden Wok', cuisine: 'Asian · Noodles' });
});
afterAll(async () => {
  await k?.app.close();
});

const ask = (q: string, over: Partial<common.DeptSearchRequest> = {}) => svc.searchFood({ q, limit: 10, ...over });
const titles = (r: common.DeptSearchResult, kind: string) => r.groups.find((g) => g.kind === kind)?.items.map((i) => i.title) ?? [];

describe('searchFood', () => {
  it('finds a restaurant by name and a dish by name, with the store path each one opens', async () => {
    const res = await ask('napoli');
    // the restaurant's own dishes match it too, on their restaurant name: a secondary field, so they score lower
    expect(res.groups.map((g) => g.kind)).toEqual(['restaurant', 'dish']);
    expect(res.groups[1]!.items.every((i) => i.score === 35)).toBe(true);
    const hit = res.groups[0]!.items[0]!;
    expect(hit).toMatchObject({ kind: 'restaurant', title: 'Napoli Pizza', score: 85 });
    expect(hit.path).toMatch(/^\/food\/restaurants\/[a-z0-9-]+$/);
    expect(hit.meta).toContain('Pizza · Italian');

    const dish = await ask('margherita');
    expect(titles(dish, 'dish')).toEqual(['Margherita pizza 12"', 'Margherita pizza 12"']);
    expect(dish.groups.find((g) => g.kind === 'dish')!.items[0]!.path).toMatch(/^\/food\/items\//);
  });

  it('finds a restaurant by its cuisine, and scores that lower than its name', async () => {
    const res = await ask('asian');
    const restaurants = res.groups.find((g) => g.kind === 'restaurant')!;
    expect(restaurants.items.map((i) => i.title)).toEqual(['Golden Wok']);
    expect(restaurants.items[0]!.score).toBeLessThan(55);
  });

  it('answers the kinds it was asked for, at most the limit, with a cursor for the rest', async () => {
    const one = await ask('pizza', { limit: 1, kinds: ['dish'] });
    expect(one.groups.map((g) => g.kind)).toEqual(['dish']);
    const group = one.groups[0]!;
    expect(group.items).toHaveLength(1);
    expect(group.total).toBeGreaterThan(1);
    expect(group.nextCursor).toBeTruthy();
    const next = await ask('pizza', { limit: 1, kinds: ['dish'], cursor: group.nextCursor! });
    expect(next.groups[0]!.items[0]!.id).not.toBe(group.items[0]!.id);
  });

  it('answers nothing for a text no record matches, and nothing at all for an empty query', async () => {
    expect((await ask('sushi')).groups).toEqual([]);
    expect((await ask('   ')).groups).toEqual([]);
  });
});
