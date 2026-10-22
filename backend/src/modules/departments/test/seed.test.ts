import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOG_POSTS, COMPANIES, DEPARTMENT_REVIEWS, DEV_CUSTOMER_EMAIL, GAMES, PLAY_CUSTOMERS, seedDepartmentActivity, seedDepartments } from '../../../../tools/simulate/departments-data.js';
import { auth, boot, callers, newId, type Kit } from './helpers.js';

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
    const tractor = k.card({ title: 'Kubota L2502' });
    k.cards.set(phone.productId, phone).set(tractor.productId, tractor);
    // catalog and search are not booted here: the category tree and the listing answer as a small store would
    const admin = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => {
      if (path.startsWith('/admin/catalog/categories')) return [{ name: 'Electronics', slug: 'electronics', children: [{ name: 'Phones', slug: 'phones', children: [] }] }];
      const res = await k.call(method, `/api${path}`, body);
      if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const row = (productId: string) => ({ items: [{ position: 1, kind: 'organic', product: { productId } }] });
    const store = async (path: string) => (path.startsWith('/store/search/products?category=phones') ? row(phone.productId) : path.startsWith('/store/search/products?q=tractor') ? row(tractor.productId) : { items: [] });
    const added = await seedDepartments(admin, store);
    expect(added).toEqual({ topics: 6, authors: 3, posts: BLOG_POSTS.length, industries: 6, companies: COMPANIES.length, games: GAMES.length, rankings: GAMES.length * 3, phones: 1, farmMachines: 1 });
    expect(await seedDepartments(admin, store)).toEqual({ topics: 0, authors: 0, posts: 0, industries: 0, companies: 0, games: 0, rankings: 0, phones: 0, farmMachines: 0 });

    const posts = await k.store('GET', '/blogs/posts?limit=50');
    expect(posts.body.items).toHaveLength(BLOG_POSTS.length);
    expect((await k.store('GET', '/companies?limit=50')).body.items).toHaveLength(COMPANIES.length);
    const week = await k.store('GET', '/play/rankings?game=block-drop&period=week');
    expect(week.body.entries).toHaveLength(10);
    expect(week.body.entries[0].score).toBeGreaterThan(week.body.entries[9].score);
    expect((await k.store('GET', '/phones')).body.products.map((p: any) => p.title)).toEqual(['Pixel 9']);
    const farm = (await k.store('GET', '/farm')).body;
    expect(farm.types.map((t: any) => t.name)).toEqual(['Tractors', 'Harvesters', 'Tillers', 'Seeders', 'Sprayers', 'Irrigation']);
    expect(farm.machines.map((m: any) => m.product.title)).toEqual(['Kubota L2502']);
  });
});

describe('sample reviews and scores (seedDepartmentActivity)', () => {
  it('writes the reviews, makes a key and posts scores for the players, once', async () => {
    // identity is not booted here: the sample customers sign in as test customers
    const accounts = new Map(PLAY_CUSTOMERS.map((p) => [p.email, newId()]));
    for (const p of PLAY_CUSTOMERS) k.names.set(accounts.get(p.email)!, `${p.firstName} ${p.lastName}`);
    const dev = newId();
    k.names.set(dev, 'Android Dev');
    k.emails.set(dev, DEV_CUSTOMER_EMAIL);
    const api = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, token?: string, headers?: Record<string, string>) => {
      if (path === '/api/public/identity/sessions') return { status: 'signed_in', tokens: { accessToken: callers.customer({ accountId: accounts.get((body as { email: string }).email)! }) } };
      const res = await k.app.inject({ method, url: path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers ?? {}) }, ...(body !== undefined ? { payload: body as never } : {}) });
      await k.app.kernel.events.drain();
      if (res.statusCode >= 300) throw new Error(`${method} ${path} → ${res.statusCode} ${res.body}`);
      return res.body ? res.json() : null;
    };
    const admin = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, b?: unknown) => {
      const res = await k.call(method, `/api${path}`, b);
      if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const visitor = async () => auth(callers.visitor()).authorization!.replace('Bearer ', '');
    const first = await seedDepartmentActivity(admin, api, visitor);
    expect(first).toMatchObject({ reviews: DEPARTMENT_REVIEWS.length, gameKeys: 2, players: 4, devCustomer: true, skipped: [] });
    expect(first.scores).toBe(2 * (4 * 2 + 2));
    expect(await seedDepartmentActivity(admin, api, visitor)).toMatchObject({ reviews: 0, gameKeys: 0, scores: 0 });

    const northwind = (await k.store('GET', '/companies/northwind-tools')).body;
    expect(northwind).toMatchObject({ rating: 4.5, ratingCount: 2 });
    const week = (await k.store('GET', '/play/rankings?game=block-drop&period=week')).body;
    expect(week).toMatchObject({ source: 'scores', playerCount: 4 });
    expect(week.entries.map((e: any) => e.name)).toEqual(['Kofi B.', 'Lina W.', 'Omar H.', 'Android D.']);
    expect(week.entries[0].score).toBe(21305);
  });
});
