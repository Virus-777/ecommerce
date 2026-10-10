/**
 * Gap pass 4: SearchQuery, SearchFilters, SearchMatch and SponsoredSlot are spec types. Filters in those types are
 * nullable (GraphQL sends null for unset arguments): null means "not set", never a value.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, newId, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});

describe('runSearch with spec-typed queries', () => {
  it('treats null filters as unset and answers SearchMatch items', async () => {
    const cat = k.world.category(`Cat ${newId().slice(-6)}`);
    const p = k.world.product({ title: 'Walnut serving tray', categoryId: cat.id });
    k.world.offer(p.id, { price: 3900, sellerId: null });
    await k.index(p.id);

    const res = await k.svc.runSearch({ q: 'walnut tray', sort: null, filters: { priceMin: null, priceMax: null, minRating: null, listedWithinDays: null, arrivesBy: null, conditions: null, attributes: null } }, { limit: 10 });
    expect(res.items.map((i) => i.productId)).toContain(p.id);
    const hit = res.items.find((i) => i.productId === p.id)!;
    expect(hit.match).toMatchObject({ position: expect.any(Number), priceIsFrom: expect.any(Boolean), badges: expect.any(Array) });
    expect(res.page).toMatchObject({ nextCursor: null });
  });
});
