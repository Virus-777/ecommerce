import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, MORNINGS, newId, type Kit } from './helpers.js';

let k: Kit;
const deviceEvents: { name: string; payload: any }[] = [];
beforeAll(async () => {
  k = await boot();
  for (const name of ['services.device.verified', 'services.device.rejected']) k.app.kernel.events.subscribe('test-devices', name, (e) => void deviceEvents.push({ name, payload: e.payload }));
});
afterAll(async () => {
  await k?.app.close();
});

/** A valid IMEI: 14 digits and their Luhn check digit */
let serial = 35_000_000_000_000;
function imei(): string {
  const body = String(serial++).padStart(14, '0');
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(body[13 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}
const contact = { name: 'Dana Ross', phone: '503-555-0101' };
const cents = (amount: number) => ({ amount, currency: 'USD' });

describe('registered devices', () => {
  it('registers a device with a Luhn-checked IMEI, masks it to the customer and refuses duplicates', async () => {
    const me = k.customer(newId());
    const bad = await k.store('POST', '/devices', { brand: 'Samsung', model: 'Galaxy S26 Ultra', imei: '490154203237519', purchaseDate: '2029-10-02' }, me);
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues[0].path).toBe('imei');
    expect((await k.store('POST', '/devices', { brand: 'Samsung', model: 'X', imei: imei(), purchaseDate: '2031-01-01' }, me)).body.error.details.issues[0].path).toBe('purchaseDate');
    expect((await k.store('POST', '/devices', { brand: 'Samsung', model: 'X', imei: imei(), purchaseDate: '2029-01-01' })).status).toBe(401);

    const number = imei();
    const res = await k.store('POST', '/devices', { brand: 'Samsung', model: 'Galaxy S26 Ultra', storage: '256 GB', imei: `${number.slice(0, 8)} ${number.slice(8)}`, purchaseDate: '2029-10-02', orderRef: 'mk-48213' }, me);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ label: 'Galaxy S26 Ultra · 256 GB', imeiLast4: number.slice(-4), imeiLabel: `IMEI ending ${number.slice(-4)}`, purchaseLabel: 'Bought Oct 2, 2029', orderRef: 'MK-48213', status: 'pending', statusLabel: 'Waiting for verification', covered: false, coverageLabel: null, canEdit: true });
    expect(JSON.stringify(res.body)).not.toContain(number);
    expect((await k.store('GET', '/devices', undefined, me)).body.map((d: any) => d.id)).toEqual([res.body.id]);

    // someone else can't register the same phone, nor see this one
    const other = k.customer(newId());
    expect((await k.store('POST', '/devices', { brand: 'Samsung', model: 'Galaxy S26 Ultra', imei: number, purchaseDate: '2029-10-02' }, other)).body.error.code).toBe('IMEI_TAKEN');
    expect((await k.store('GET', `/devices/${res.body.id}`, undefined, other)).status).toBe(404);
  });

  it('lets staff verify with a default cover of 12 months, reject, and correct a device; only managers see the IMEI', async () => {
    const owner = newId();
    k.names.set(owner, 'Dana Ross');
    const me = k.customer(owner);
    const number = imei();
    const d = (await k.store('POST', '/devices', { brand: 'Google', model: 'Pixel 10', imei: number, purchaseDate: '2029-03-31' }, me)).body;

    const list = (await k.admin('GET', '/devices?status=pending&q=' + number.slice(-6))).body.items;
    expect(list.map((x: any) => x.id)).toEqual([d.id]);
    expect(list[0]).toMatchObject({ customerId: owner, customerName: 'Dana Ross', imei: number, suggestedCoveredUntil: '2030-03-31', requestCount: 0 });
    expect((await k.admin('GET', `/devices/${d.id}`, undefined, k.staff(['services.view']))).body.imei).toBeNull();
    expect((await k.admin('POST', `/devices/${d.id}/verify`, {}, k.staff(['services.view']))).status).toBe(403);

    const rejected = (await k.admin('POST', `/devices/${d.id}/reject`, { reason: 'The IMEI does not match the receipt' })).body;
    expect(rejected).toMatchObject({ status: 'rejected', rejectReason: 'The IMEI does not match the receipt' });
    expect(deviceEvents.at(-1)).toEqual({ name: 'services.device.rejected', payload: { deviceId: d.id, customerId: owner, label: 'Pixel 10', reason: 'The IMEI does not match the receipt' } });
    expect((await k.store('GET', `/devices/${d.id}`, undefined, me)).body).toMatchObject({ status: 'rejected', statusLabel: 'Not verified', rejectReason: 'The IMEI does not match the receipt', canEdit: true });

    // changing a rejected device sends it back to staff
    const resent = (await k.store('PATCH', `/devices/${d.id}`, { brand: 'Google', model: 'Pixel 10 Pro', imei: number, purchaseDate: '2029-03-31' }, me)).body;
    expect(resent).toMatchObject({ status: 'pending', model: 'Pixel 10 Pro', rejectReason: null });

    const verified = (await k.admin('POST', `/devices/${d.id}/verify`, {})).body;
    expect(verified).toMatchObject({ status: 'verified', coveredUntil: '2030-03-31', covered: true });
    expect(verified.verifiedBy).toMatch(/^staff:/);
    expect(verified.history.map((h: any) => h.status)).toEqual(['pending', 'rejected', 'pending', 'verified']);
    expect(deviceEvents.at(-1)).toEqual({ name: 'services.device.verified', payload: { deviceId: d.id, customerId: owner, label: 'Pixel 10 Pro', coveredUntil: '2030-03-31' } });
    expect(k.audits.at(-1)).toMatchObject({ action: 'services.device.verify' });
    expect((await k.store('GET', `/devices/${d.id}`, undefined, me)).body).toMatchObject({ statusLabel: 'Covered to Mar 2030', coverageLabel: 'Covered to Mar 2030', canEdit: false });
    expect((await k.store('PATCH', `/devices/${d.id}`, { brand: 'Google', model: 'Pixel 10', imei: number, purchaseDate: '2029-03-31' }, me)).body.error.code).toBe('DEVICE_LOCKED');
    expect((await k.admin('POST', `/devices/${d.id}/verify`, {})).body.error.code).toBe('ILLEGAL_TRANSITION');

    // staff shorten the cover: it ended, so the device is no longer covered
    expect((await k.admin('PATCH', `/devices/${d.id}`, { coveredUntil: '2029-01-01' })).body.error.details.issues[0].path).toBe('coveredUntil');
    const ended = (await k.admin('PATCH', `/devices/${d.id}`, { coveredUntil: '2029-12-31', staffNote: 'Checked the receipt' })).body;
    expect(ended).toMatchObject({ coveredUntil: '2029-12-31', covered: false, staffNote: 'Checked the receipt' });
    expect((await k.store('GET', `/devices/${d.id}`, undefined, me)).body).toMatchObject({ statusLabel: 'Cover ended Dec 2029', covered: false });

    expect((await k.store('DELETE', `/devices/${d.id}`, undefined, me)).status).toBe(204);
    expect((await k.store('GET', '/devices', undefined, me)).body).toEqual([]);
  });

  it('prices a covered-by-warranty service $0 for a covered device, and records the device on the request', async () => {
    const p = (await k.admin('POST', '/providers', { name: 'FixPoint Test', hours: MORNINGS, location: { lat: 45.5351, lng: -122.6497 } })).body;
    const screen = (
      await k.admin('POST', '/services', {
        area: 'post_sale',
        title: 'Covered screen replacement',
        providerId: p.id,
        fromPrice: cents(8900),
        coveredByWarranty: true,
        priceTableTitle: 'Price by model',
        priceTable: [{ label: 'Galaxy S26 Ultra', price: '$229' }, { label: 'Galaxy S25 / S25+', price: '$179' }],
      })
    ).body;
    const battery = (await k.admin('POST', '/services', { area: 'post_sale', title: 'Uncovered battery', providerId: p.id, fromPrice: cents(5900) })).body;
    const owner = newId();
    const me = k.customer(owner);
    const phone = (await k.store('POST', '/devices', { brand: 'Samsung', model: 'Galaxy S26 Ultra', storage: '256 GB', imei: imei(), purchaseDate: '2029-10-02' }, me)).body;

    // pending devices aren't covered yet
    expect((await k.store('GET', `/services/${screen.slug}`, undefined, me)).body.yourDevice).toBeNull();
    await k.admin('POST', `/devices/${phone.id}/verify`, {});

    const detail = (await k.store('GET', `/services/${screen.slug}`, undefined, me)).body;
    expect(detail.yourDevice).toEqual({ deviceId: phone.id, label: 'Galaxy S26 Ultra', priceRowLabel: 'Galaxy S26 Ultra', normalPrice: '$229', price: cents(0), priceText: '$0', barLabel: 'Galaxy S26 Ultra · warranty', coveredUntil: '2030-10-02', coverageLabel: 'Covered to Oct 2030' });
    expect((await k.store('GET', `/services/${screen.slug}`)).body.yourDevice).toBeNull();
    expect((await k.store('GET', `/services/${battery.slug}`, undefined, me)).body.yourDevice).toBeNull();
    expect((await k.store('GET', '/services?area=post_sale', undefined, me)).body.items.find((s: any) => s.id === screen.id).coveredByWarranty).toBe(true);

    const covered = await k.store('POST', '/requests', { serviceId: screen.id, deviceId: phone.id, contact }, me);
    expect(covered.status, JSON.stringify(covered.body)).toBe(201);
    expect(covered.body).toMatchObject({ priceLabel: '$0 · covered by your warranty', device: { id: phone.id, label: 'Galaxy S26 Ultra · 256 GB', imeiLast4: phone.imeiLast4, covered: true }, details: { deviceModel: 'Galaxy S26 Ultra' } });
    const normal = (await k.store('POST', '/requests', { serviceId: battery.id, deviceId: phone.id, contact }, me)).body;
    expect(normal).toMatchObject({ priceLabel: 'from $59 · pay at the provider', device: { covered: false } });
    expect((await k.admin('GET', `/requests/${covered.body.id}`)).body.device).toMatchObject({ id: phone.id, covered: true });
    expect((await k.admin('GET', `/devices/${phone.id}`)).body.requestCount).toBe(2);

    // another customer's device can't be used
    expect((await k.store('POST', '/requests', { serviceId: screen.id, deviceId: phone.id, contact }, k.customer(newId()))).body.error.details.issues[0].path).toBe('deviceId');
    // a device without a matching row shows the from price struck through
    const pixel = (await k.store('POST', '/devices', { brand: 'Google', model: 'Pixel 9', imei: imei(), purchaseDate: '2029-11-02' }, k.customer(owner))).body;
    await k.admin('POST', `/devices/${pixel.id}/verify`, {});
    await k.store('DELETE', `/devices/${phone.id}`, undefined, me);
    expect((await k.store('GET', `/services/${screen.slug}`, undefined, me)).body.yourDevice).toMatchObject({ deviceId: pixel.id, priceRowLabel: null, normalPrice: '$89', barLabel: 'Pixel 9 · warranty' });
    // the request made before keeps its device
    expect((await k.store('GET', `/requests/${covered.body.id}`, undefined, me)).body.device).toMatchObject({ id: phone.id, covered: true });
  });
});

describe('personal data export', () => {
  it('exports requests and reviews by the account id, and saved providers and devices (full IMEI) by the customers-module id', async () => {
    const accountId = newId();
    const customerId = newId();
    k.names.set(accountId, 'Robin Lee');
    k.customerIds.set(accountId, customerId);
    const me = k.customer(accountId);
    const p = (await k.admin('POST', '/providers', { name: 'Export Repairs', hours: MORNINGS })).body;
    const s = (await k.admin('POST', '/services', { area: 'post_sale', title: 'Export repair', providerId: p.id, fromPrice: cents(5000) })).body;
    const number = imei();
    const phone = (await k.store('POST', '/devices', { brand: 'Samsung', model: 'Galaxy S25', imei: number, purchaseDate: '2029-06-01' }, me)).body;
    expect((await k.store('PUT', `/saved-providers/${p.id}`, undefined, me)).status).toBe(200);
    const req = (await k.store('POST', '/requests', { serviceId: s.id, deviceId: phone.id, contact, details: { notes: 'Cracked corner' } }, me)).body;
    await k.admin('PATCH', `/requests/${req.id}`, { status: 'confirmed' });
    await k.admin('PATCH', `/requests/${req.id}`, { status: 'completed', staffNote: 'Internal only' });
    expect((await k.store('POST', `/requests/${req.id}/review`, { rating: 5, text: 'Quick and tidy' }, me)).status).toBe(201);

    const services = k.app.kernel.boot.apis.get('services') as { exportCustomerData(i: { customerId: string; accountId: string }): Promise<any[]> };
    const sections = await services.exportCustomerData({ customerId, accountId });
    expect(sections.map((x) => x.key)).toEqual(['services_requests', 'services_reviews', 'services_saved_providers', 'services_devices']);
    const [requests, reviews, saved, devices] = sections;
    expect(requests.records).toEqual([
      expect.objectContaining({ reference: req.ref, service: 'Export repair', provider: 'Export Repairs', contact: { ...contact, email: null }, details: expect.objectContaining({ notes: 'Cracked corner', deviceModel: 'Galaxy S25' }), device: { label: 'Galaxy S25', imeiLast4: number.slice(-4), coveredByWarranty: false }, status: 'completed' }),
    ]);
    expect(JSON.stringify(requests.records)).not.toContain('Internal only');
    expect(requests.records[0].history.map((h: any) => Object.keys(h))).toEqual([['status', 'at'], ['status', 'at'], ['status', 'at']]);
    expect(reviews.records).toEqual([expect.objectContaining({ request: req.ref, service: 'Export repair', stars: 5, text: 'Quick and tidy', shownAs: 'Robin L.', hidden: false })]);
    expect(saved.records).toEqual([expect.objectContaining({ provider: 'Export Repairs' })]);
    expect(devices.records).toEqual([expect.objectContaining({ brand: 'Samsung', model: 'Galaxy S25', imei: number, purchaseDate: '2029-06-01', status: 'pending' })]);

    // someone else's export has none of it
    expect(await services.exportCustomerData({ customerId: newId(), accountId: newId() })).toEqual([]);
  });
});
