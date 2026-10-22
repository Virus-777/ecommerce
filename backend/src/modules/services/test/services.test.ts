import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, MONDAY, MORNINGS, newId, type Kit } from './helpers.js';

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
  const res = await k.admin('POST', '/providers', { name: `Provider ${++seq}`, hours: MORNINGS, ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
async function service(providerId: string, over: Record<string, unknown> = {}) {
  const res = await k.admin('POST', '/services', { area: 'booking', title: `Service ${++seq}`, providerId, fromPrice: cents(2500), ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
const contact = { name: 'Dana Ross', phone: '503-555-0101' };

describe('catalog', () => {
  it('keeps categories per area with slugs unique inside an area, and refuses to delete one in use', async () => {
    const a = await k.admin('POST', '/categories', { area: 'post_sale', name: 'Screen repair' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ area: 'post_sale', slug: 'screen-repair', visible: true });
    expect((await k.admin('POST', '/categories', { area: 'post_sale', name: 'Screen Repair' })).body.error.code).toBe('SLUG_TAKEN');
    expect((await k.admin('POST', '/categories', { area: 'welfare', name: 'Screen repair' })).status).toBe(201);
    const p = await provider();
    await service(p.id, { area: 'post_sale', categoryId: a.body.id });
    expect((await k.admin('DELETE', `/categories/${a.body.id}`)).body.error.code).toBe('IN_USE');
    // a category of another area can't be used
    const w = (await k.admin('GET', '/categories?area=welfare')).body[0];
    expect((await k.admin('POST', '/services', { area: 'post_sale', title: 'X', providerId: p.id, categoryId: w.id })).body.error.details.issues[0].path).toBe('categoryId');
  });

  it('validates providers and services, and shows the store only published ones', async () => {
    expect((await k.admin('POST', '/providers', { name: 'Bad hours', hours: { days: [{ weekday: 'mon', open: true, from: '12:00', to: '09:00' }], timeZone: 'America/Los_Angeles' } })).body.error.details.issues[0].path).toBe('hours.days[0].to');
    const p = await provider({ name: 'Brightsmile Dental', kind: 'Dental clinic', staff: [{ id: 'lena', name: 'Dr. Lena Ortiz', role: 'Dentist' }] });
    expect(p.staff[0]).toMatchObject({ name: 'Dr. Lena Ortiz' });
    expect(p.hours.days).toHaveLength(7);
    expect((await k.admin('POST', '/services', { area: 'booking', title: 'Too short', providerId: p.id, slotMinutes: 5 })).body.error.details.issues[0].path).toBe('slotMinutes');
    const cleaning = await service(p.id, { title: 'Check-up & cleaning', slotMinutes: 45, fromPrice: cents(9000) });
    const hidden = await service(p.id, { title: 'Whitening', status: 'hidden' });
    expect((await k.admin('POST', '/services', { area: 'booking', title: 'Check-up & cleaning', providerId: p.id })).body.error.code).toBe('SLUG_TAKEN');

    const list = (await k.store('GET', '/services?area=booking')).body.items.map((s: any) => s.slug);
    expect(list).toContain(cleaning.slug);
    expect(list).not.toContain(hidden.slug);
    const detail = (await k.store('GET', `/services/${cleaning.slug}`)).body;
    expect(detail.provider).toMatchObject({ name: 'Brightsmile Dental', fromPrice: cents(9000) });
    expect(detail.firstAvailable).toMatch(/^First available Mon, Jan 7 · 9:00 AM$/);
    expect((await k.store('GET', `/services/${hidden.slug}`)).status).toBe(404);

    // hiding the provider hides its services
    await k.admin('PATCH', `/providers/${p.id}`, { name: p.name, status: 'hidden' });
    expect((await k.store('GET', `/services/${cleaning.slug}`)).status).toBe(404);
    await k.admin('PATCH', `/providers/${p.id}`, { name: p.name, status: 'published' });
    const prov = (await k.store('GET', `/providers/${p.slug}`)).body;
    expect(prov.services.map((s: any) => s.slug)).toEqual([cleaning.slug]);
    expect(prov.hours.todayLabel).toBe('Open today 9:00 AM – 12:00 PM');
  });

  it('needs services.manage to change providers', async () => {
    expect((await k.admin('POST', '/providers', { name: 'Nope' }, k.staff(['services.view']))).status).toBe(403);
    expect((await k.admin('GET', '/providers', undefined, k.staff(['services.view']))).status).toBe(200);
  });
});

describe('availability and booking', () => {
  it('cuts the hours into slots, takes one booking per slot without staff, and frees it when cancelled', async () => {
    const p = await provider();
    const s = await service(p.id, { slotMinutes: 60 });
    const days = (await k.store('GET', `/services/${s.id}/availability?days=7`)).body;
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({ date: MONDAY, weekdayLabel: 'Mon', open: true });
    expect(days[0].slots.map((x: any) => x.label)).toEqual(['9:00 AM', '10:00 AM', '11:00 AM']);
    expect(days[5]).toMatchObject({ weekdayLabel: 'Sat', open: false, slots: [] });

    const slotStart = days[0].slots[1].start;
    // 10:00 is two hours away: inside the default cut-off, so allow cancelling up to an hour before for this test
    k.settingsValues['services.cancelCutoffMinutes'] = 60;
    const customer = newId();
    expect((await k.store('POST', '/requests', { serviceId: s.id, contact }, k.customer(customer))).body.error.code).toBe('SLOT_REQUIRED');
    const booked = await k.store('POST', '/requests', { serviceId: s.id, slotStart, contact }, k.customer(customer));
    expect(booked.status).toBe(201);
    expect(booked.body).toMatchObject({ status: 'requested', statusLabel: `Waiting for ${p.name} to confirm`, whenLabel: 'Mon, Jan 7 · 10:00 AM', canCancel: true, canReview: false, priceLabel: 'from $25 · pay at the provider' });
    expect(booked.body.ref).toMatch(/^SR-[2-9A-HJ-NP-Z]{5}$/);

    const after = (await k.store('GET', `/services/${s.id}/availability?days=1`)).body[0].slots.map((x: any) => x.available);
    expect(after).toEqual([true, false, true]);
    expect((await k.store('POST', '/requests', { serviceId: s.id, slotStart, contact }, k.customer(newId()))).body.error.code).toBe('SLOT_TAKEN');
    expect((await k.store('POST', '/requests', { serviceId: s.id, slotStart: '2030-01-07T17:20:00Z', contact }, k.customer(newId()))).body.error.details.issues[0].path).toBe('slotStart');

    const cancelled = await k.store('POST', `/requests/${booked.body.id}/cancel`, { reason: 'Plans changed' }, k.customer(customer));
    expect(cancelled.body.status).toBe('cancelled');
    delete k.settingsValues['services.cancelCutoffMinutes'];
    expect((await k.store('GET', `/services/${s.id}/availability?days=1`)).body[0].slots[1].available).toBe(true);
    // someone else's request is not found
    expect((await k.store('GET', `/requests/${booked.body.id}`, undefined, k.customer(newId()))).status).toBe(404);
  });

  it('books a free staff member, keeps the slot open until everyone is taken, and honours a chosen person', async () => {
    const p = await provider({ staff: [{ id: 'maya', name: 'Maya' }, { id: 'jonas', name: 'Jonas' }] });
    const [maya, jonas] = p.staff;
    const cut = await service(p.id, { slotMinutes: 30 });
    const beard = await service(p.id, { slotMinutes: 30 });
    const at = (await k.store('GET', `/services/${cut.id}/availability?days=1`)).body[0].slots[0].start;
    const one = (await k.store('POST', '/requests', { serviceId: cut.id, slotStart: at, staffId: jonas.id, contact }, k.customer(newId())))!.body;
    expect(one.staff).toMatchObject({ id: jonas.id, name: 'Jonas' });
    // Jonas is busy for every service of the provider at that time; Maya is not
    const forJonas = (await k.store('GET', `/services/${beard.id}/availability?days=1&staffId=${jonas.id}`)).body[0].slots[0].available;
    const forMaya = (await k.store('GET', `/services/${beard.id}/availability?days=1&staffId=${maya.id}`)).body[0].slots[0].available;
    expect([forJonas, forMaya]).toEqual([false, true]);
    const two = (await k.store('POST', '/requests', { serviceId: beard.id, slotStart: at, contact }, k.customer(newId()))).body;
    expect(two.staff.id).toBe(maya.id);
    expect((await k.store('GET', `/services/${cut.id}/availability?days=1`)).body[0].slots[0].available).toBe(false);
    expect((await k.store('POST', '/requests', { serviceId: cut.id, slotStart: at, contact }, k.customer(newId()))).body.error.code).toBe('SLOT_TAKEN');
  });

  it('takes a request once per Idempotency-Key, and requests without a time for services that have none', async () => {
    const p = await provider();
    const s = await service(p.id, { area: 'welfare', title: 'In-home elder care', priceUnit: 'hour', fromPrice: cents(2400), handover: [{ mode: 'at_home' }] });
    const customer = newId();
    const key = newId();
    const body = { serviceId: s.id, contact, details: { careFor: 'My mother, 78', handover: 'at_home', preferredDate: '2030-01-09', plan: 'Weekly' } };
    const a = await k.store('POST', '/requests', body, { ...k.customer(customer), 'idempotency-key': key });
    const b = await k.store('POST', '/requests', body, { ...k.customer(customer), 'idempotency-key': key });
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(a.body).toMatchObject({ slotStart: null, whenLabel: null, priceLabel: '$24/hr · pay at the provider', details: { careFor: 'My mother, 78', plan: 'Weekly' } });
    expect((await k.store('POST', '/requests', { ...body, details: { handover: 'pickup' } }, k.customer(customer))).body.error.details.issues[0].path).toBe('details.handover');
    const mine = (await k.store('GET', '/requests?state=open', undefined, k.customer(customer))).body.items;
    expect(mine.map((r: any) => r.id)).toEqual([a.body.id]);
  });

  it('refuses to cancel a booking inside the cut-off', async () => {
    const p = await provider();
    const s = await service(p.id, { slotMinutes: 60 });
    const first = (await k.store('GET', `/services/${s.id}/availability?days=1`)).body[0].slots[0].start; // 9:00, one hour away
    const customer = newId();
    const r = (await k.store('POST', '/requests', { serviceId: s.id, slotStart: first, contact }, k.customer(customer))).body;
    expect(r.canCancel).toBe(false);
    expect((await k.store('POST', `/requests/${r.id}/cancel`, {}, k.customer(customer))).body.error.code).toBe('TOO_LATE_TO_CANCEL');
  });
});

describe('handling requests and reviews', () => {
  it('moves requests through the state machine, publishes each change, and lets the customer rate once', async () => {
    const p = await provider();
    const s = await service(p.id, { area: 'os_install', title: 'Android clean reinstall', osVersions: ['Android 17', 'Android 16'] });
    const customer = newId();
    k.names.set(customer, 'Dana Ross');
    const r = (await k.store('POST', '/requests', { serviceId: s.id, contact, details: { deviceModel: 'Pixel 9', osVersion: 'Android 17' } }, k.customer(customer))).body;
    expect((await k.store('POST', `/requests/${r.id}/review`, { rating: 5 }, k.customer(customer))).body.error.code).toBe('ILLEGAL_TRANSITION');

    const confirmed = await k.admin('PATCH', `/requests/${r.id}`, { status: 'confirmed', providerNote: 'Bring your charger' });
    expect(confirmed.body).toMatchObject({ status: 'confirmed', providerNote: 'Bring your charger' });
    expect(k.events.filter((e) => e.payload.requestId === r.id).map((e) => e.payload.status)).toEqual(['requested', 'confirmed']);
    expect((await k.admin('PATCH', `/requests/${r.id}`, { status: 'completed' })).body.status).toBe('completed');
    expect((await k.admin('PATCH', `/requests/${r.id}`, { status: 'confirmed' })).body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await k.admin('PATCH', `/requests/${r.id}`, { status: 'declined' }, k.staff(['services.view']))).status).toBe(403);

    const reviewed = await k.store('POST', `/requests/${r.id}/review`, { rating: 4, text: 'Quick and careful.' }, k.customer(customer));
    expect(reviewed.status).toBe(201);
    expect(reviewed.body.canReview).toBe(false);
    expect((await k.store('POST', `/requests/${r.id}/review`, { rating: 5 }, k.customer(customer))).body.error.code).toBe('ALREADY_REVIEWED');
    const detail = (await k.store('GET', `/services/${s.slug}`)).body;
    expect(detail.rating).toEqual({ average: 4, count: 1, stars: [0, 1, 0, 0, 0] });
    expect(detail.reviews[0]).toMatchObject({ authorName: 'Dana R.', rating: 4, text: 'Quick and careful.' });

    // hiding the review takes it out of the rating
    const reviewId = (await k.admin('GET', `/reviews?serviceId=${s.id}`)).body.items[0].id;
    await k.admin('PATCH', `/reviews/${reviewId}`, { status: 'hidden' });
    expect((await k.store('GET', `/services/${s.slug}`)).body.rating).toEqual({ average: null, count: 0, stars: [0, 0, 0, 0, 0] });
    expect((await k.admin('GET', `/requests?q=${r.ref}`)).body.items.map((x: any) => x.id)).toEqual([r.id]);
  });

  it('moves a booking to another free slot and keeps services with requests from being deleted', async () => {
    const p = await provider();
    const s = await service(p.id, { slotMinutes: 60 });
    const slots = (await k.store('GET', `/services/${s.id}/availability?days=1`)).body[0].slots;
    const r = (await k.store('POST', '/requests', { serviceId: s.id, slotStart: slots[1].start, contact }, k.customer(newId()))).body;
    const moved = await k.admin('PATCH', `/requests/${r.id}`, { slotStart: slots[2].start });
    expect(moved.body.slotStart).toBe(slots[2].start);
    expect((await k.store('GET', `/services/${s.id}/availability?days=1`)).body[0].slots.map((x: any) => x.available)).toEqual([true, true, false]);
    expect((await k.admin('DELETE', `/services/${s.id}`)).body.error.code).toBe('IN_USE');
    expect((await k.admin('DELETE', `/providers/${p.id}`)).body.error.code).toBe('IN_USE');
  });
});
