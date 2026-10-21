import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOG_POSTS, COMPANIES, GAMES, seedDepartments } from '../../../../tools/simulate/departments-data.js';
import { boot, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

describe('sample content (tools/simulate/departments-data.ts)', () => {
  it('passes the admin API as it is and adds nothing the second time', async () => {
    const phone = k.card({ title: 'Pixel 9' });
    k.cards.set(phone.productId, phone);
    // catalog and search are not booted here: the category tree and the listing answer as a small store would
    const admin = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => {
      if (path.startsWith('/admin/catalog/categories')) return [{ name: 'Electronics', slug: 'electronics', children: [{ name: 'Phones', slug: 'phones', children: [] }] }];
      const res = await k.call(method, `/api${path}`, body);
      if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const store = async (path: string) => (path.startsWith('/store/search/products?category=phones') ? { items: [{ position: 1, kind: 'organic', product: { productId: phone.productId } }] } : { items: [] });
    const added = await seedDepartments(admin, store);
    expect(added).toEqual({ topics: 6, authors: 3, posts: BLOG_POSTS.length, industries: 6, companies: COMPANIES.length, games: GAMES.length, rankings: GAMES.length * 3, phones: 1 });
    expect(await seedDepartments(admin, store)).toEqual({ topics: 0, authors: 0, posts: 0, industries: 0, companies: 0, games: 0, rankings: 0, phones: 0 });

    const posts = await k.store('GET', '/blogs/posts?limit=50');
    expect(posts.body.items).toHaveLength(BLOG_POSTS.length);
    expect((await k.store('GET', '/companies?limit=50')).body.items).toHaveLength(COMPANIES.length);
    const week = await k.store('GET', '/play/rankings?game=block-drop&period=week');
    expect(week.body.entries).toHaveLength(10);
    expect(week.body.entries[0].score).toBeGreaterThan(week.body.entries[9].score);
    expect((await k.store('GET', '/phones')).body.products.map((p: any) => p.title)).toEqual(['Pixel 9']);
  });
});
