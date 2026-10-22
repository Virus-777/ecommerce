import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOFTWARE_APPS, SOFTWARE_CATEGORIES, SOFTWARE_PACKS, seedSoftware, type Uploader } from '../../../../tools/simulate/software-data.js';
import { boot, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
  k.clock.set(new Date('2026-10-22T17:00:00Z'));
});
afterAll(async () => {
  await k?.app.close();
});

describe('sample Softwares (tools/simulate/software-data.ts)', () => {
  it('passes the admin API as it is, matches the canvas and adds nothing the second time', async () => {
    const admin = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => {
      const res = await k.call(method, `/api${path}`, body);
      if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const upload: Uploader = (f) => k.upload(f.purpose, f.fileName, f.contentType, f.body);
    const first = await seedSoftware(admin, upload);
    expect(first).toMatchObject({ categories: SOFTWARE_CATEGORIES.length, apps: SOFTWARE_APPS.length, appsUpdated: 0, files: SOFTWARE_APPS.length * 2 + 1, packs: SOFTWARE_PACKS.length, rails: 1, granted: 0 });
    expect(await seedSoftware(admin, upload)).toMatchObject({ categories: 0, apps: 0, appsUpdated: SOFTWARE_APPS.length, files: 0, packs: 0, packsUpdated: SOFTWARE_PACKS.length, rails: 0 });

    const deals = (await k.store('GET', '/deals')).body;
    expect(deals.packs.map((p: any) => [p.name, p.priceLabel, p.totalLabel, p.savePercent])).toEqual([
      ['Office Pro pack', '$59.99', '$99.97', 40],
      ['Creator pack', '$84.99', '$129.96', 35],
    ]);
    expect(deals.discounts.map((a: any) => [a.title, a.price.label, a.price.wasLabel, a.price.offPercent])).toEqual([
      ['PixelCraft Studio', '$12.49', '$24.99', 50],
      ['Kingdom Tactics', '$3.49', '$6.99', 50],
      ['DiskCare', '$9.99', '$19.99', 50],
      ['VaultGuard VPN', '$2.99', '$4.99', 40],
      ['Ledgerly', '$6.99', '$9.99', 30],
    ]);
    expect(deals.discountsUntilLabel).toBe('Prices valid until Oct 31');

    const home = (await k.store('GET', '/home')).body;
    expect(home.rails.map((r: any) => [r.key, r.apps.length])).toEqual([
      ['recommended', 5],
      ['new-apps', 3],
      ['games', 3],
      ['browsers', 3],
      ['pc-apps', 10],
    ]);
    expect(home.rails[1].apps.map((a: any) => a.title)).toEqual(['Scribe AI Assistant', 'Habit Garden', 'TaxEasy 2026']);
    expect(home.featuredPack.name).toBe('Office Pro pack');

    const pixel = (await k.store('GET', '/apps/pixelcraft-studio')).body;
    expect(pixel).toMatchObject({ company: { name: 'Northlight Labs' }, subcategory: 'Photo editing', version: '3.4.1', releasedAt: '2026-10-14', platformLabels: ['Windows 10+', 'macOS 13+', 'Android 10+', 'iOS 16+'], licenceLabel: 'One-time purchase · 2 devices', licenceDevices: 2, ratings: { average: null, count: 0 } });
    expect(pixel.files.databasesSizeLabel).toBe(pixel.files.databases[0].sizeLabel);
    expect((await k.store('GET', '/apps/noteflow')).body.licenceDevices).toBeNull();
    expect(pixel.permissions.map((p: any) => p.name)).toEqual(['Storage', 'Network', 'Camera']);
    expect(pixel.files.databases).toHaveLength(1);
    expect(pixel.files.package.name).toBe('PixelCraft-Studio-3.4.1.zip');
    expect((await k.store('GET', '/categories')).body.map((c: any) => c.name)).toEqual(SOFTWARE_CATEGORIES.map((c) => c.name));
  });
});
