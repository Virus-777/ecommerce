/**
 * Services' part of the integrated search (search calls searchServices): the services, providers and categories of
 * each area, every group carrying the area so search can lay it out under the right department.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as common from '../../../spec/common.js';
import type { ServicesService } from '../service.js';
import { boot, MORNINGS, type Kit } from './helpers.js';

let k: Kit;
let svc: ServicesService;
beforeAll(async () => {
  k = await boot();
  svc = k.app.kernel.boot.apis.get('services') as ServicesService;
  const salon = await k.admin('POST', '/providers', { name: 'Rose City Hair', kind: 'Hair salon', hours: MORNINGS, status: 'published' });
  const tech = await k.admin('POST', '/providers', { name: 'Pixel Clinic', kind: 'Phone repair shop', hours: MORNINGS, status: 'published' });
  const care = await k.admin('POST', '/providers', { name: 'Evergreen Care', kind: 'Licensed home care agency', hours: MORNINGS, status: 'published' });
  expect([salon.status, tech.status, care.status]).toEqual([201, 201, 201]);
  await k.admin('POST', '/services', { area: 'booking', title: 'Haircut and styling', providerId: salon.body.id, fromPrice: { amount: 4500, currency: 'USD' }, slotMinutes: 45, status: 'published' });
  await k.admin('POST', '/services', { area: 'post_sale', title: 'Screen replacement', providerId: tech.body.id, fromPrice: { amount: 12900, currency: 'USD' }, supportedLabel: 'Samsung, Pixel', status: 'published' });
  await k.admin('POST', '/services', { area: 'os_install', title: 'Android 16 install', providerId: tech.body.id, fromPrice: { amount: 2900, currency: 'USD' }, status: 'published' });
  await k.admin('POST', '/services', { area: 'welfare', title: 'Daily home visit', providerId: care.body.id, fromPrice: { amount: 6000, currency: 'USD' }, priceUnit: 'visit', status: 'published' });
  await k.admin('POST', '/categories', { area: 'welfare', name: 'Home care' });
});
afterAll(async () => {
  await k?.app.close();
});

const ask = (q: string, over: Partial<common.DeptSearchRequest> = {}) => svc.searchServices({ q, limit: 10, ...over });
const group = (r: common.DeptSearchResult, kind: string) => r.groups.find((g) => g.kind === kind);

describe('searchServices', () => {
  it('answers a booking service and its provider, each group carrying its area', async () => {
    const res = await ask('haircut');
    const service = group(res, 'booking_service')!;
    expect(service.area).toBe('booking');
    expect(service.items[0]).toMatchObject({ kind: 'booking_service', title: 'Haircut and styling', score: 85 });
    expect(service.items[0]!.path).toMatch(/^\/booking\/[a-z0-9-]+$/);
    expect(service.items[0]!.priceLabel).toBe('$45.00');

    const salon = group(await ask('rose city'), 'booking_provider')!;
    expect(salon.items[0]).toMatchObject({ title: 'Rose City Hair', score: 85 });
    expect(salon.items[0]!.path).toMatch(/^\/providers\/[a-z0-9-]+\?area=booking$/);
  });

  it('puts the Phones department areas in their own groups, with the paths of its tabs', async () => {
    const repair = group(await ask('screen'), 'post_sale_service')!;
    expect(repair).toMatchObject({ area: 'post_sale' });
    expect(repair.items[0]!.path).toMatch(/^\/phones\/post-sale\//);
    const install = group(await ask('android'), 'os_install_service')!;
    expect(install).toMatchObject({ area: 'os_install' });
    expect(install.items[0]!.path).toMatch(/^\/phones\/os-install\//);
  });

  it('prices a welfare service by its unit and finds its category', async () => {
    const visit = group(await ask('daily home'), 'welfare_service')!;
    expect(visit.items[0]!.priceLabel).toBe('$60.00/visit');
    const category = group(await ask('home care'), 'welfare_category')!;
    expect(category.items[0]).toMatchObject({ title: 'Home care', path: '/welfare?category=home-care' });
  });

  it('answers only the sections it was asked for', async () => {
    const booking = await ask('rose city', { sections: ['booking'] });
    // the salon's own services match it too, on their provider name
    expect(booking.groups.map((g) => g.kind)).toEqual(['booking_service', 'booking_provider']);
    const phones = await ask('rose city', { sections: ['phones'] });
    expect(phones.groups).toEqual([]);
  });

  it('answers nothing for an empty query', async () => {
    expect((await ask('   ')).groups).toEqual([]);
  });
});
