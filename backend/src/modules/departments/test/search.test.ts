/**
 * The departments this module owns in the integrated search (search calls searchDepartments): phones, farm
 * machines, blog posts, authors and topics, companies and industries, games and genres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as common from '../../../spec/common.js';
import type { DepartmentsService } from '../service.js';
import { boot, type Kit } from './helpers.js';

let k: Kit;
let svc: DepartmentsService;
const usd = (amount: number) => ({ amount, currency: 'USD' });
const body = (words: number) => `<p>${Array.from({ length: words }, (_, i) => `word${i}`).join(' ')}</p>`;

beforeAll(async () => {
  k = await boot();
  svc = k.app.kernel.boot.apis.get('departments') as DepartmentsService;
  const photo = await k.uploadImage({ width: 1440, height: 1920 });

  // Phones
  await k.admin('POST', '/phones', {
    brand: 'Samsung',
    name: 'Samsung Galaxy S26 Ultra 5G',
    overview: 'A 200 MP camera and a built-in S Pen in a titanium frame.',
    storage: [{ size: '256 GB', price: usd(119900), was: usd(134900) }],
    colors: [{ name: 'Titanium Gray', short: 'Gray', hex: '#8c918f' }],
    photos: [{ id: photo.id, alt: 'Front and back' }],
  });

  // Blogs
  const topic = (await k.admin('POST', '/blogs/topics', { name: 'Phones' })).body;
  const author = (await k.admin('POST', '/blogs/authors', { name: 'Mina Park', email: 'mina@example.com', bio: 'Writes about phones.' })).body;
  await k.admin('POST', '/blogs/posts', { title: 'Galaxy S26 Ultra, two weeks in', body: body(60), authorId: author.id, topicId: topic.id, status: 'published' });

  // Companies
  const industry = (await k.admin('POST', '/industries', { name: 'Consumer electronics' })).body;
  await k.admin('POST', '/companies', { name: 'Samsung Electronics America', industryId: industry.id, city: 'Ridgefield Park, NJ', status: 'published' });

  // Play center
  await k.admin('POST', '/play/games', { title: 'Block Drop', genre: 'Puzzle' });
});
afterAll(async () => {
  await k?.app.close();
});

const ask = (q: string, over: Partial<common.DeptSearchRequest> = {}) => svc.searchDepartments({ q, limit: 10, ...over });
const group = (r: common.DeptSearchResult, kind: string) => r.groups.find((g) => g.kind === kind);

describe('searchDepartments', () => {
  it('finds a phone by brand and name, with its price, deal and page', async () => {
    const hit = group(await ask('galaxy s26'), 'phone')!.items[0]!;
    expect(hit).toMatchObject({ kind: 'phone', title: 'Samsung Galaxy S26 Ultra 5G', priceLabel: '$1,199.00', wasLabel: '$1,349.00', badge: '−11%' });
    expect(hit.path).toMatch(/^\/phones\/[a-z0-9-]+$/);
    expect(hit.meta).toContain('256 GB');
  });

  it('finds a blog post by title, its topic and its author, each in its own group', async () => {
    const res = await ask('galaxy');
    expect(group(res, 'post')!.items[0]).toMatchObject({ kind: 'post', title: 'Galaxy S26 Ultra, two weeks in' });
    expect(group(res, 'post')!.items[0]!.path).toMatch(/^\/blogs\/[a-z0-9-]+$/);
    expect(group(await ask('mina'), 'author')!.items[0]).toMatchObject({ title: 'Mina Park', path: '/blogs/authors/mina-park' });
    expect(group(await ask('phones'), 'topic')!.items[0]).toMatchObject({ title: 'Phones', path: '/blogs?topic=phones', meta: '1 post' });
  });

  it('finds a company and an industry', async () => {
    const company = group(await ask('samsung electronics'), 'company')!.items[0]!;
    expect(company).toMatchObject({ kind: 'company', title: 'Samsung Electronics America', score: 85 });
    expect(company.meta).toContain('Consumer electronics');
    expect(group(await ask('consumer electronics'), 'industry')!.items[0]).toMatchObject({ title: 'Consumer electronics', path: '/companies?industry=consumer-electronics' });
  });

  it('finds a game by title and its genre', async () => {
    expect(group(await ask('block drop'), 'game')!.items[0]).toMatchObject({ kind: 'game', title: 'Block Drop', score: 100 });
    expect(group(await ask('puzzle'), 'genre')!.items[0]).toMatchObject({ title: 'Puzzle', path: '/play', meta: '1 game' });
  });

  it('answers only the sections and kinds it was asked for', async () => {
    expect((await ask('samsung', { sections: ['companies'] })).groups.map((g) => g.kind)).toEqual(['company']);
    expect((await ask('samsung', { sections: ['phones', 'companies'], kinds: ['phone'] })).groups.map((g) => g.kind)).toEqual(['phone']);
    expect((await ask('  ')).groups).toEqual([]);
  });
});
