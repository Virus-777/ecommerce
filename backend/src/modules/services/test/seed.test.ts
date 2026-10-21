import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROVIDERS, SERVICE_CATEGORIES, SERVICES, seedServices } from '../../../../tools/simulate/services-data.js';
import { boot, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

describe('sample services (tools/simulate/services-data.ts)', () => {
  it('passes the admin API as it is and adds nothing the second time', async () => {
    const admin = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => {
      const res = await k.call(method, `/api${path}`, body);
      if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const categories = Object.values(SERVICE_CATEGORIES).flat().length;
    expect(await seedServices(admin)).toEqual({ categories, providers: PROVIDERS.length, services: SERVICES.length });
    expect(await seedServices(admin)).toEqual({ categories: 0, providers: 0, services: 0 });

    const booking = (await k.store('GET', '/providers?area=booking')).body.items;
    const studio = booking.find((p: any) => p.name === 'Studio Nine Hair');
    expect(studio).toMatchObject({ kind: 'Hair salon', category: { name: 'Beauty' }, fromPrice: { amount: 2500, currency: 'USD' } });
    expect(studio.nextFree).toMatch(/^Next free: Today 9:00 AM$/);
    const welfare = (await k.store('GET', '/services/in-home-elder-care')).body;
    expect(welfare.priceTable).toHaveLength(4);
    expect(welfare.requirements[0]).toBe('Adults 65+ or with a care plan from a doctor');
    expect((await k.store('GET', '/categories?area=post_sale')).body.map((c: any) => c.name)).toEqual(['Screen repair', 'Battery', 'Warranty', 'Data recovery', 'Trade-in']);
  });
});
