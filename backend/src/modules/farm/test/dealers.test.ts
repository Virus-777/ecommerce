import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, CANBY, dealer, HILLSBORO, newId, PORTLAND, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

describe('dealers', () => {
  it('has no dealer to show before staff add one', async () => {
    expect((await k.store('GET', '/dealers/nearest')).body).toEqual({ dealer: null, basis: 'market_default' });
  });

  it('geocodes the address unless staff pin the dealer, and checks the form', async () => {
    const canby = await dealer(k);
    expect(canby).toMatchObject({ name: 'Greenfield Agri Equipment', address: { line1: 'Route 9', city: 'Canby', region: 'OR', postalCode: '97013', country: 'US' }, point: CANBY, pinned: false, hours: 'Mon–Sat 7:00–18:00', active: true, position: 1, openOrders: 0, orderCount: 0, leadDays: null });
    expect(k.audits.at(-1)).toMatchObject({ action: 'farm.dealer.create', module: 'farm' });

    const pin = { lat: 45.53, lng: -122.99 };
    const hillsboro = await dealer(k, { name: 'Tualatin Valley Tractor', address: { line1: '2200 NW Cornell Rd', city: 'Hillsboro', region: 'OR', postalCode: '97123' }, point: pin, messagePhone: null, messageEmail: 'sales@tvtractor.example', leadDays: 5 });
    expect(hillsboro).toMatchObject({ point: pin, pinned: true, position: 2, leadDays: 5, messageEmail: 'sales@tvtractor.example' });

    // an unknown ZIP leaves the dealer without a point
    const unknown = await dealer(k, { name: 'Coast Range Equipment', address: { line1: '1 Main St', city: 'Tillamook', region: 'OR', postalCode: '97141' }, active: false });
    expect(unknown).toMatchObject({ point: null, pinned: false, active: false });

    const bad = async (over: Record<string, unknown>) => (await k.admin('POST', '/dealers', { name: 'X', address: { line1: 'A', city: 'B', region: 'OR' }, hours: 'Daily', phone: '503-555-0100', ...over })).body.error;
    expect(await bad({ phone: 'call us' })).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'phone' }] } });
    expect(await bad({ messageEmail: 'nope' })).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await bad({ leadDays: 61 })).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'leadDays' }] } });
    expect(await bad({ point: { lat: 120, lng: 0 } })).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'point' }] } });
    expect(await bad({ hours: ' ' })).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'hours' }] } });
    expect((await k.admin('POST', '/dealers', { name: 'X' }, k.staff(['farm.view']))).status).toBe(403);

    const list = (await k.admin('GET', '/dealers')).body;
    expect(list.map((d: any) => d.name)).toEqual(['Greenfield Agri Equipment', 'Tualatin Valley Tractor', 'Coast Range Equipment']);
    expect((await k.admin('GET', '/dealers?active=false')).body.map((d: any) => d.id)).toEqual([unknown.id]);
    expect((await k.admin('GET', '/dealers?q=hills')).body.map((d: any) => d.id)).toEqual([hillsboro.id]);
  });

  it('shows the nearest active dealer from the customer address, else the market default without a distance', async () => {
    // visitors: the first active dealer, no distance
    const visitor = (await k.store('GET', '/dealers/nearest')).body;
    expect(visitor).toMatchObject({ basis: 'market_default', dealer: { name: 'Greenfield Agri Equipment', addressLabel: 'Route 9, Canby', metaLabel: 'Route 9, Canby', distanceLabel: null, hours: 'Mon–Sat 7:00–18:00', phone: '(503) 555-0142', message: { kind: 'sms', to: '(503) 555-0143' } } });

    // a customer in downtown Portland: Canby is ~17 mi, the Hillsboro pin ~15 mi
    const accountId = newId();
    k.locations.set(accountId, PORTLAND);
    const near = (await k.store('GET', '/dealers/nearest', undefined, k.customer(accountId))).body;
    expect(near.basis).toBe('your_address');
    expect(near.dealer).toMatchObject({ name: 'Tualatin Valley Tractor', distanceLabel: '15 mi', metaLabel: '2200 NW Cornell Rd, Hillsboro · 15 mi away', message: { kind: 'email', to: 'sales@tvtractor.example' } });

    // a customer without a geocoded default address
    const nowhere = (await k.store('GET', '/dealers/nearest', undefined, k.customer(newId()))).body;
    expect(nowhere).toMatchObject({ basis: 'market_default', dealer: { name: 'Greenfield Agri Equipment', distanceLabel: null } });
    void HILLSBORO;
  });

  it('changes, switches off and deletes dealers', async () => {
    const list = (await k.admin('GET', '/dealers')).body;
    const hillsboro = list.find((d: any) => d.name === 'Tualatin Valley Tractor');
    // dropping the pin geocodes the address again
    const moved = (await k.admin('PATCH', `/dealers/${hillsboro.id}`, { name: hillsboro.name, address: hillsboro.address, hours: 'Mon–Fri 8:00–17:00', phone: hillsboro.phone, messageEmail: hillsboro.messageEmail, point: null, active: false })).body;
    expect(moved).toMatchObject({ point: HILLSBORO, pinned: false, hours: 'Mon–Fri 8:00–17:00', active: false, position: 2 });
    expect(k.audits.at(-1)).toMatchObject({ action: 'farm.dealer.update' });
    const accountId = newId();
    k.locations.set(accountId, PORTLAND);
    expect((await k.store('GET', '/dealers/nearest', undefined, k.customer(accountId))).body.dealer.name).toBe('Greenfield Agri Equipment');

    expect((await k.admin('DELETE', `/dealers/${hillsboro.id}`)).status).toBe(204);
    expect((await k.admin('GET', `/dealers/${hillsboro.id}`)).status).toBe(404);
    expect((await k.admin('DELETE', `/dealers/${newId()}`)).status).toBe(404);
  });
});
