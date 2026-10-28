/** Softwares' part of the integrated search (search calls searchSoftware): apps, packs and categories. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as common from '../../../spec/common.js';
import type { SoftwareService } from '../service.js';
import { boot, usd, type Kit } from './helpers.js';

let k: Kit;
let svc: SoftwareService;
beforeAll(async () => {
  k = await boot();
  svc = k.app.kernel.boot.apis.get('software') as SoftwareService;
  // makeApp puts its apps in a category it makes once, named Utilities
  await k.makeApp({ title: 'Smart Switch', company: { name: 'Samsung Electronics' }, brief: 'Move everything from your old phone' });
  await k.makeApp({ title: 'DiskCare', company: { name: 'Northwind Tools' }, brief: 'Finds duplicates and frees up space' });
});
afterAll(async () => {
  await k?.app.close();
});

const ask = (q: string, over: Partial<common.DeptSearchRequest> = {}) => svc.searchSoftware({ q, limit: 10, ...over });
const group = (r: common.DeptSearchResult, kind: string) => r.groups.find((g) => g.kind === kind);

describe('searchSoftware', () => {
  it('finds an app by its title, with its price, rating line and the page it opens', async () => {
    const res = await ask('smart switch');
    const hit = group(res, 'app')!.items[0]!;
    expect(hit).toMatchObject({ kind: 'app', title: 'Smart Switch', score: 100 });
    expect(hit.path).toMatch(/^\/software\/app\/[a-z0-9-]+$/);
    expect(hit.priceLabel).toBeTruthy();
    expect(hit.meta).toContain('Utilities');
  });

  it('finds an app by its company and its brief, scored lower than its title', async () => {
    const byCompany = group(await ask('samsung'), 'app')!;
    expect(byCompany.items.map((i) => i.title)).toEqual(['Smart Switch']);
    expect(byCompany.items[0]!.score).toBe(35);
    const byBrief = group(await ask('duplicates'), 'app')!;
    expect(byBrief.items.map((i) => i.title)).toEqual(['DiskCare']);
  });

  it('finds a category by name, with the apps it holds', async () => {
    const res = await ask('utilities');
    expect(group(res, 'software_category')!.items[0]).toMatchObject({ title: 'Utilities', path: '/software/apps?category=utilities' });
    expect(group(res, 'software_category')!.items[0]!.meta).toBe('2 apps');
  });

  it('finds a pack by its name', async () => {
    const one = await k.makeApp({ title: 'Studio Pro', free: false, price: usd(2499) });
    const two = await k.makeApp({ title: 'Studio Sheets', free: false, price: usd(1499) });
    const pack = await k.admin('POST', '/packs', { name: 'Creator bundle', appIds: [one.id, two.id], price: usd(1999) });
    expect(pack.status, JSON.stringify(pack.body)).toBe(201);
    const res = await ask('creator');
    expect(group(res, 'pack')!.items[0]).toMatchObject({ kind: 'pack', title: 'Creator bundle', path: '/software?tab=deals', score: 85 });
  });

  it('answers only the kinds it was asked for, and nothing for an empty query', async () => {
    expect((await ask('utilities', { kinds: ['app'] })).groups.map((g) => g.kind)).toEqual(['app']);
    expect((await ask('  ')).groups).toEqual([]);
  });
});
