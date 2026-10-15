/** Wave 2 (web team requests): seller slugs and the new-listing flag on cards (G18, G25e), price presets with counts (G22b). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, shop, STORE, type Kit } from './helpers.js';

let k: Kit;
let s: Awaited<ReturnType<typeof shop>>;
beforeAll(async () => {
  k = await boot();
  s = await shop(k);
});
afterAll(async () => {
  await k?.close();
});

describe('product cards', () => {
  it('carry the storefront slug of a marketplace seller (null for the Official Store) and isNewListing', async () => {
    const r = await k.call('GET', `${STORE}/products?q=headphones`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const cards = r.body.items.map((h: any) => h.product);
    const earphones = cards.find((c: any) => c.productId === s.earphones.id);
    const wireless = cards.find((c: any) => c.productId === s.wireless.id);
    expect(earphones).toMatchObject({ sellerId: s.grove.id, sellerSlug: 'gadget-grove' });
    expect(wireless).toMatchObject({ official: true, sellerSlug: null });
    for (const c of cards) expect(c.isNewListing).toBe(c.badges.includes('New listing'));
  });
});

describe('price presets (G22b)', () => {
  it('each preset says how many results it gives with the other filters kept', async () => {
    const r = await k.call('GET', `${STORE}/facets?category=electronics`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const price = r.body.facets.find((f: any) => f.key === 'price');
    expect(price.values.length).toBeGreaterThan(0);
    for (const v of price.values) {
      expect(v.label).toMatch(/^(Under \$\d+|\$\d+ to \$\d+|\$\d+ and above)$/);
      expect(v.count).toBeGreaterThan(0);
      const qs = [v.priceMin != null ? `priceMin=${v.priceMin}` : '', v.priceMax != null ? `priceMax=${v.priceMax}` : ''].filter(Boolean).join('&');
      const applied = await k.call('GET', `${STORE}/facets?category=electronics&${qs}`);
      expect(applied.body.total).toBe(v.count);
      expect(applied.body.facets.find((f: any) => f.key === 'price').values.find((x: any) => x.value === v.value).selected).toBe(true);
    }
  });
});
