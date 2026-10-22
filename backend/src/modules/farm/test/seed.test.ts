import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FARM_DEALERS, seedFarm } from '../../../../tools/simulate/farm-data.js';
import { boot, newId, PORTLAND, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

describe('sample dealers (tools/simulate/farm-data.ts)', () => {
  it('passes the admin API as it is and adds nothing the second time', async () => {
    const admin = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => {
      const res = await k.call(method, `/api${path}`, body);
      if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };
    expect(await seedFarm(admin)).toEqual({ dealers: FARM_DEALERS.length });
    expect(await seedFarm(admin)).toEqual({ dealers: 0 });
    const dealers = (await k.admin('GET', '/dealers')).body;
    expect(dealers.map((d: any) => [d.name, d.address.city, d.pinned, d.active])).toEqual([
      ['Greenfield Agri Equipment', 'Canby', true, true],
      ['Tualatin Valley Tractor', 'Hillsboro', true, true],
      ['Willamette Farm Supply', 'Salem', true, true],
    ]);
    // visitors see the market default; a downtown Portland customer the nearest one with its distance
    expect((await k.store('GET', '/dealers/nearest')).body).toMatchObject({ basis: 'market_default', dealer: { name: 'Greenfield Agri Equipment', metaLabel: '26685 S Hwy 99E, Canby', hours: 'Mon–Sat 7:00–18:00' } });
    const accountId = newId();
    k.locations.set(accountId, PORTLAND);
    expect((await k.store('GET', '/dealers/nearest', undefined, k.customer(accountId))).body).toMatchObject({ basis: 'your_address', dealer: { name: 'Tualatin Valley Tractor', distanceLabel: '13 mi' } });
  });
});
