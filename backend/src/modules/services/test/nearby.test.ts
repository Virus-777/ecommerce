import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addressParts, isValidImei, matchPriceRow, openLabel, rowModels } from '../domain/rules.js';
import { boot, MORNINGS, newId, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const cents = (amount: number) => ({ amount, currency: 'USD' });
let seq = 0;
async function provider(over: Record<string, unknown> = {}) {
  const res = await k.admin('POST', '/providers', { name: `Nearby ${++seq}`, hours: MORNINGS, ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
async function service(providerId: string, over: Record<string, unknown> = {}) {
  const res = await k.admin('POST', '/services', { area: 'welfare', title: `Nearby service ${++seq}`, providerId, fromPrice: cents(2400), priceUnit: 'hour', ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
/** A signed-in customer with a default address in downtown Portland */
function locatedCustomer() {
  const id = newId();
  k.locations.set(id, { point: { lat: 45.5152, lng: -122.6784 }, city: 'Portland', region: 'OR', addressId: newId(), label: '1120 SW 5th Ave' });
  return { id, headers: k.customer(id) };
}

describe('rules', () => {
  it('checks IMEIs with Luhn, matches price rows to models and reads addresses', () => {
    expect(isValidImei('490154203237518')).toBe(true);
    expect(isValidImei('490154203237519')).toBe(false);
    expect(isValidImei('49015420323751')).toBe(false);
    expect(rowModels('Galaxy S25 / S25+')).toEqual(['Galaxy S25', 'Galaxy S25+']);
    expect(rowModels('Pixel 10 / 10 Pro')).toEqual(['Pixel 10', 'Pixel 10 Pro']);
    const rows = [{ label: 'Galaxy S26 Ultra' }, { label: 'Galaxy S25 / S25+' }, { label: 'iPhone 17 / 17 Pro' }];
    expect(matchPriceRow(rows, 'Samsung', 'Galaxy S26 Ultra')).toBe(0);
    expect(matchPriceRow(rows, 'Samsung', 'Samsung Galaxy S25+')).toBe(1);
    expect(matchPriceRow(rows, 'Apple', 'iPhone 17 Pro')).toBe(2);
    expect(matchPriceRow(rows, 'Google', 'Pixel 10')).toBe(-1);
    expect(addressParts('412 SE Morrison St, Portland, OR 97214', 'Portland, OR')).toEqual({ line1: '412 SE Morrison St', city: 'Portland', region: 'OR', postalCode: '97214' });
    expect(addressParts(null, 'Millbrook')).toEqual({ city: 'Millbrook', region: '' });
    expect(addressParts(null, null)).toBeNull();
    const days = MORNINGS.days.map((d) => ({ weekday: d.weekday, open: d.open, from: d.open ? '09:00' : null, to: d.open ? '20:00' : null })) as never;
    // Monday 2030-01-07 in Los Angeles
    expect(openLabel(days, new Date('2030-01-07T16:00:00Z'), 'America/Los_Angeles')).toBe('Opens at 9 am');
    expect(openLabel(days, new Date('2030-01-07T20:00:00Z'), 'America/Los_Angeles')).toBe('Open until 8 pm');
    expect(openLabel(days, new Date('2030-01-08T05:00:00Z'), 'America/Los_Angeles')).toBe('Closed now');
    expect(openLabel(days, new Date('2030-01-05T20:00:00Z'), 'America/Los_Angeles')).toBe('Closed today');
  });
});

describe('provider points and distances', () => {
  it('geocodes a provider without a pin from its address, and keeps a pin as it is', async () => {
    k.geocoded.set('97232', { lat: 45.5351, lng: -122.6497 });
    const geo = await provider({ city: 'Portland, OR', contacts: { address: '1520 NE Broadway, Portland, OR 97232' } });
    expect(k.geocodeCalls.at(-1)).toEqual({ line1: '1520 NE Broadway', city: 'Portland', region: 'OR', postalCode: '97232' });
    expect(geo).toMatchObject({ location: null, point: { lat: 45.5351, lng: -122.6497 }, pointSource: 'address' });
    const calls = k.geocodeCalls.length;
    // the same address keeps its point without asking again
    const again = (await k.admin('PATCH', `/providers/${geo.id}`, { name: geo.name, city: 'Portland, OR', contacts: { address: '1520 NE Broadway, Portland, OR 97232' } })).body;
    expect(again.pointSource).toBe('address');
    expect(k.geocodeCalls.length).toBe(calls);
    const pinned = await provider({ city: 'Portland, OR', location: { lat: 45.5, lng: -122.6 }, contacts: { address: '1 Main St, Portland, OR 97204' } });
    expect(pinned).toMatchObject({ point: { lat: 45.5, lng: -122.6 }, pointSource: 'pin' });
    const nowhere = await provider({ city: 'Atlantis' });
    expect(nowhere).toMatchObject({ point: null, pointSource: null });
  });

  it('shows distances and the customer area to a located customer, sorts by nearest, and nothing to visitors', async () => {
    const cat = (await k.admin('POST', '/categories', { area: 'welfare', name: 'Nearby care' })).body;
    const far = await provider({ name: 'Far Care', location: { lat: 45.4871, lng: -122.8037 }, contacts: { address: '18 Elm Street, Millbrook' } });
    const near = await provider({ name: 'Near Care', location: { lat: 45.5172, lng: -122.6603 } });
    await service(far.id, { title: 'Far elder care', categoryId: cat.id, position: 1 });
    await service(near.id, { title: 'Near elder care', categoryId: cat.id, position: 2 });
    const me = locatedCustomer();

    expect((await k.store('GET', '/area')).body).toEqual({ located: false, city: null, region: null, addressLabel: null });
    expect((await k.store('GET', '/area', undefined, me.headers)).body).toEqual({ located: true, city: 'Portland', region: 'OR', addressLabel: '1120 SW 5th Ave' });

    const visitor = (await k.store('GET', '/services?area=welfare&category=nearby-care&sort=nearest')).body;
    expect(visitor.items.map((s: any) => s.title)).toEqual(['Far elder care', 'Near elder care']);
    expect(visitor.items[0].distance).toBeNull();

    const mine = (await k.store('GET', '/services?area=welfare&category=nearby-care&sort=nearest', undefined, me.headers)).body;
    expect(mine.total).toBe(2);
    expect(mine.items.map((s: any) => [s.title, s.distance])).toEqual([
      ['Near elder care', '0.9 mi'],
      ['Far elder care', '6.4 mi'],
    ]);
    const detail = (await k.store('GET', `/services/${mine.items[1].slug}`, undefined, me.headers)).body;
    expect(detail.provider).toMatchObject({ name: 'Far Care', address: '18 Elm Street, Millbrook', distance: '6.4 mi', location: { lat: 45.4871, lng: -122.8037 }, openLabel: 'Opens at 9 am', saved: false });
    const page = (await k.store('GET', `/providers/${far.slug}?area=welfare`, undefined, me.headers)).body;
    expect(page).toMatchObject({ name: 'Far Care', distance: '6.4 mi', address: '18 Elm Street, Millbrook', services: [{ title: 'Far elder care', distance: '6.4 mi' }] });
  });
});

describe('saved providers', () => {
  it('saves and unsaves idempotently, flags saved providers and lists them', async () => {
    const cat = (await k.admin('POST', '/categories', { area: 'booking', name: 'Saved beauty' })).body;
    const salon = await provider({ name: 'Saved Salon', categoryId: cat.id, location: { lat: 45.5876, lng: -122.6913 } });
    await service(salon.id, { area: 'booking', title: 'Saved cut', priceUnit: 'fixed', slotMinutes: 30 });
    const me = locatedCustomer();
    expect((await k.store('PUT', `/saved-providers/${salon.id}`)).status).toBe(401);
    expect((await k.store('PUT', `/saved-providers/${newId()}`, undefined, me.headers)).status).toBe(404);
    expect((await k.store('PUT', `/saved-providers/${salon.id}`, undefined, me.headers)).body).toEqual({ providerId: salon.id, saved: true });
    expect((await k.store('PUT', `/saved-providers/${salon.id}`, undefined, me.headers)).body).toEqual({ providerId: salon.id, saved: true });

    const list = (await k.store('GET', '/providers?area=booking&category=saved-beauty&sort=nearest', undefined, me.headers)).body.items;
    expect(list[0]).toMatchObject({ name: 'Saved Salon', saved: true, location: { lat: 45.5876, lng: -122.6913 } });
    expect(list[0].distance).toMatch(/ mi$/);
    expect((await k.store('GET', '/providers?area=booking&category=saved-beauty')).body.items[0].saved).toBe(false);
    expect((await k.store('GET', `/providers/${salon.slug}`, undefined, me.headers)).body.saved).toBe(true);
    const saved = (await k.store('GET', '/saved-providers', undefined, me.headers)).body;
    expect(saved.items.map((p: any) => p.name)).toEqual(['Saved Salon']);
    expect((await k.store('GET', '/saved-providers?area=welfare', undefined, me.headers)).body.items).toEqual([]);

    expect((await k.store('DELETE', `/saved-providers/${salon.id}`, undefined, me.headers)).body).toEqual({ providerId: salon.id, saved: false });
    expect((await k.store('DELETE', `/saved-providers/${salon.id}`, undefined, me.headers)).body).toEqual({ providerId: salon.id, saved: false });
    expect((await k.store('GET', '/saved-providers', undefined, me.headers)).body.items).toEqual([]);
  });
});

describe('full terms', () => {
  it('keeps full terms per service and returns them on the detail; only post-sale services can be covered by the warranty', async () => {
    const p = await provider();
    expect((await k.admin('POST', '/services', { area: 'welfare', title: 'Not covered', providerId: p.id, coveredByWarranty: true })).body.error.details.issues[0].path).toBe('coveredByWarranty');
    const s = await service(p.id, { area: 'post_sale', title: 'Terms repair', fullTerms: 'Repairs are covered for 6 months.\n\nWater damage is not covered.', coveredByWarranty: true });
    expect(s).toMatchObject({ coveredByWarranty: true, fullTerms: 'Repairs are covered for 6 months.\n\nWater damage is not covered.' });
    // an edit that doesn't send the new fields keeps them
    const edited = (await k.admin('PATCH', `/services/${s.id}`, { area: 'post_sale', title: 'Terms repair', providerId: p.id })).body;
    expect(edited).toMatchObject({ coveredByWarranty: true, fullTerms: 'Repairs are covered for 6 months.\n\nWater damage is not covered.' });
    const detail = (await k.store('GET', `/services/${s.slug}`)).body;
    expect(detail).toMatchObject({ coveredByWarranty: true, fullTerms: 'Repairs are covered for 6 months.\n\nWater damage is not covered.', yourDevice: null });
  });
});
