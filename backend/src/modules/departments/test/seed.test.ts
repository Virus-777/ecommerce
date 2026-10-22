import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONES } from '../../../../tools/simulate/phones-data.js';
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
    const tractor = k.card({ title: 'Kubota L2502' });
    k.cards.set(tractor.productId, tractor);
    // search is not booted here: the listing answers as a small store would
    const admin = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => {
      const res = await k.call(method, `/api${path}`, body);
      if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const row = (productId: string) => ({ items: [{ position: 1, kind: 'organic', product: { productId } }] });
    const store = async (path: string) => (path.startsWith('/store/search/products?q=tractor') ? row(tractor.productId) : { items: [] });
    const added = await seedDepartments(admin, store, k.uploadFile);
    expect(added).toEqual({ topics: 6, authors: 3, posts: BLOG_POSTS.length, industries: 6, companies: COMPANIES.length, games: GAMES.length, rankings: GAMES.length * 3, phones: PHONES.length, phoneAds: 0, farmMachines: 1 });
    expect(await seedDepartments(admin, store, k.uploadFile)).toEqual({ topics: 0, authors: 0, posts: 0, industries: 0, companies: 0, games: 0, rankings: 0, phones: 0, phoneAds: 0, farmMachines: 0 });

    const posts = await k.store('GET', '/blogs/posts?limit=50');
    expect(posts.body.items).toHaveLength(BLOG_POSTS.length);
    expect((await k.store('GET', '/companies?limit=50')).body.items).toHaveLength(COMPANIES.length);
    const week = await k.store('GET', '/play/rankings?game=block-drop&period=week');
    expect(week.body.entries).toHaveLength(10);
    expect(week.body.entries[0].score).toBeGreaterThan(week.body.entries[9].score);
    const phones = (await k.store('GET', '/phones')).body;
    expect(phones.phones.map((p: any) => p.name)).toEqual(PHONES.filter((p) => p.status !== 'hidden').map((p) => p.name));
    expect(phones.phones[0]).toMatchObject({ meta: '256 GB · Titanium Gray', price: { amount: 109999, currency: 'USD' }, was: { amount: 129999, currency: 'USD' }, dealPercent: 15 });
    const s26 = (await k.store('GET', '/phones/samsung-galaxy-s26-ultra-5g')).body;
    expect(s26.photos).toHaveLength(8);
    expect(s26.adImages.map((a: any) => a.alt)).toEqual(['Galaxy S26 Ultra Titanium, lighter than ever', '200 MP. Every detail. Main camera with 5× optical zoom', 'Built-in S Pen Write, sketch and edit', 'All day. Then some. 5,000 mAh battery, 45 W charging']);
    expect(s26.adImages.some((a: any) => s26.photos.some((p: any) => p.id === a.id))).toBe(false);
    // a sample phone saved before advertisement images gets them, the rest kept as it is
    const before = (await k.admin('GET', `/phones/${s26.id}`)).body;
    const { id: _id, position: _p, createdAt: _c, updatedAt: _u, updatedBy: _b, adImages: _a, photos, ...rest } = before;
    await k.admin('PATCH', `/phones/${s26.id}`, { ...rest, photos: photos.map((p: any) => ({ id: p.id, alt: p.alt })), adImages: [] });
    expect((await seedDepartments(admin, store, k.uploadFile)).phoneAds).toBe(1);
    const after = (await k.admin('GET', `/phones/${s26.id}`)).body;
    expect(after.adImages).toHaveLength(4);
    expect({ ...after, adImages: [], updatedAt: null, updatedBy: null }).toEqual({ ...before, adImages: [], updatedAt: null, updatedBy: null });
    expect((await seedDepartments(admin, store, k.uploadFile)).phoneAds).toBe(0);
    expect(s26.specGroups.map((g: any) => g.name)).toEqual(['Display', 'Performance', 'Camera', 'Battery', 'Connectivity', 'Build', 'Software']);
    expect((await k.store('GET', '/phones/samsung-galaxy-a57-5g')).status).toBe(404);
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
