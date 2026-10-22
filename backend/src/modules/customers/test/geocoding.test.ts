import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { distanceMiles } from '../../../kernel/lib/geo.js';
import { CITY_CENTROIDS, ZIP_CENTROIDS, zipState } from '../providers/geocoder-data.js';
import { cityKey, devGeocoder, lookupCentroid, unconfiguredGeocoder } from '../providers/geocoder.js';
import { address, boot, STORE, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(() => kit.app.close());

const addresses = () => (kit.app.kernel as any).mongo.db.collection('customers.addresses');
const PIONEER_SQUARE = { lat: 45.5189, lng: -122.6793 };

describe('dev geocoder (built-in centroids)', () => {
  it('places a ZIP at its centroid, falls back to the city, and knows nothing else', () => {
    const zip = lookupCentroid({ city: 'Portland', region: 'OR', postalCode: '97204-1234' });
    expect(zip?.precision).toBe('zip');
    expect(distanceMiles(zip!.point, PIONEER_SQUARE)).toBeLessThan(1);
    // a ZIP that is not listed, or not in the address's state: the city's centroid
    expect(lookupCentroid({ city: 'Salem', region: 'OR', postalCode: '97399' })).toEqual({ point: { lat: 44.9429, lng: -123.0351 }, precision: 'city' });
    expect(lookupCentroid({ city: 'Vancouver', region: 'WA', postalCode: '97204' })?.precision).toBe('city');
    expect(lookupCentroid({ city: 'St. Helens', region: 'Oregon', postalCode: null })?.precision).toBe('city');
    expect(lookupCentroid({ city: 'Portland, OR', region: 'OR' })?.precision).toBe('city');
    expect(lookupCentroid({ city: 'Redmond', region: 'WA' })!.point.lat).toBeGreaterThan(47);
    expect(lookupCentroid({ city: 'Redmond', region: 'OR' })!.point.lat).toBeLessThan(45);
    expect(lookupCentroid({ city: 'Nowhere', region: 'OR', postalCode: '00000' })).toBeNull();
    expect(lookupCentroid({ city: 'Portland', region: 'OR', postalCode: '97204', country: 'CA' })).toBeNull();
    expect(cityKey('Saint  Helens')).toBe('st helens');
  });

  it('keeps every listed ZIP inside the Portland–Vancouver–Salem market (and its state)', () => {
    const zips = Object.entries(ZIP_CENTROIDS).filter(([z]) => z !== '98101');
    expect(zips.length).toBeGreaterThan(120);
    for (const [zip, [lat, lng]] of zips) {
      expect([zip, lat >= 44.7 && lat <= 46.0 && lng >= -123.6 && lng <= -121.9]).toEqual([zip, true]);
      expect(['OR', 'WA']).toContain(zipState(zip));
    }
    for (const key of Object.keys(CITY_CENTROIDS)) expect(key).toMatch(/^[a-z0-9 ]+\|[A-Z]{2}$/);
    // the seed data's places
    for (const z of ['97201', '97203', '97204', '97205', '97206', '97209', '97210', '97211', '97212', '97213', '97214', '97219', '97227', '97232', '97005', '97030', '97034', '97124', '97217', '97202', '98101']) expect(ZIP_CENTROIDS[z], z).toBeTruthy();
    for (const c of ['portland|OR', 'beaverton|OR', 'gresham|OR', 'lake oswego|OR', 'hillsboro|OR', 'bend|OR', 'seattle|WA', 'los angeles|CA', 'salem|OR', 'vancouver|WA']) expect(CITY_CENTROIDS[c], c).toBeTruthy();
  });

  it('the production stub is not configured and places nothing', async () => {
    expect(unconfiguredGeocoder.configured).toBe(false);
    expect(await unconfiguredGeocoder.geocode({ city: 'Portland', region: 'OR', postalCode: '97204' })).toBeNull();
    expect(devGeocoder.configured).toBe(true);
  });
});

describe('customer location', () => {
  it('geocodes a saved address and answers the default address as the customer location (coordinates stay internal)', async () => {
    const c = await kit.customer();
    expect(await kit.service.customerLocation(c.customerId)).toBeNull(); // no address yet
    const res = await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { label: 'Home', address: address({ line1: '1120 SW 5th Ave', postalCode: '97204' }) } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/lat|lng|geocod/);
    const row = await addresses().findOne({ _id: res.body.id });
    expect(row.geocode_precision).toBe('zip');
    expect(row.geocoded_at).toBeInstanceOf(Date);

    const loc = await kit.service.customerLocation(c.customerId);
    expect(loc).toMatchObject({ city: 'Portland', region: 'OR', addressId: res.body.id, label: '1120 SW 5th Ave', precision: 'zip' });
    expect(distanceMiles(loc!.point, PIONEER_SQUARE)).toBeLessThan(1);
    // callers holding only the account id (the principal had no customerId) get the same answer
    expect(await kit.service.customerLocation(c.accountId)).toEqual(loc);
    expect(await kit.service.customerLocation('not-a-uuid')).toBeNull();

    // a second address that is not the default changes nothing; making it the default moves the customer
    const work = await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { label: 'Work', address: address({ line1: '900 Court St NE', city: 'Salem', postalCode: '97301' }) } });
    expect((await kit.service.customerLocation(c.customerId))!.addressId).toBe(res.body.id);
    await kit.call('POST', `${STORE}/addresses/${work.body.id}/make-default`, { token: c.token });
    const salem = await kit.service.customerLocation(c.customerId);
    expect(salem).toMatchObject({ city: 'Salem', addressId: work.body.id, label: '900 Court St NE' });
    expect(distanceMiles(salem!.point, loc!.point)).toBeGreaterThan(40);

    // an edit re-geocodes: an unknown ZIP in a known city keeps the city's centroid
    await kit.call('PATCH', `${STORE}/addresses/${work.body.id}`, { token: c.token, body: { label: 'Work', address: address({ line1: '1 Main St', city: 'Woodburn', postalCode: '97071' }) } });
    expect((await kit.service.customerLocation(c.customerId))?.city).toBe('Woodburn');
    await kit.call('PATCH', `${STORE}/addresses/${work.body.id}`, { token: c.token, body: { label: 'Work', address: address({ line1: '1 Main St', city: 'Millbrook', region: 'NY', postalCode: '12545' }) } });
    expect(await kit.service.customerLocation(c.customerId)).toBeNull(); // not placed: the city is shown without a distance
    const notPlaced = await addresses().findOne({ _id: work.body.id });
    expect([notPlaced.lat, notPlaced.lng, notPlaced.geocode_precision]).toEqual([null, null, null]);
    expect(notPlaced.geocoded_at).toBeInstanceOf(Date);
  });

  it('geocodes any address for other modules (geocodeAddress)', async () => {
    const p = await kit.service.geocodeAddress({ line1: '3520 SE Hawthorne Blvd', city: 'Portland', region: 'OR', postalCode: '97214' });
    expect(p).toEqual({ lat: ZIP_CENTROIDS['97214']![0], lng: ZIP_CENTROIDS['97214']![1] });
    expect(await kit.service.geocodeAddress({ city: 'Vancouver', region: 'WA' })).toEqual({ lat: 45.6387, lng: -122.6615 });
    expect(await kit.service.geocodeAddress({ city: 'Atlantis', region: 'OR' })).toBeNull();
    expect(await kit.service.geocodeAddress({ city: '', region: '' })).toBeNull();
  });

  it('backfills addresses saved before geocoding existed (customers.geocode-addresses), defaults first, and only once', async () => {
    const c = await kit.customer();
    const res = await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: address({ line1: '1120 SW 5th Ave', postalCode: '97204' }) } });
    // as stored before: no geo fields at all
    await addresses().updateOne({ _id: res.body.id }, { $unset: { lat: '', lng: '', geocoded_at: '', geocode_precision: '' } });
    const updatedAt = (await addresses().findOne({ _id: res.body.id })).updated_at;
    await kit.app.kernel.jobs.runNow('customers.geocode-addresses');
    const row = await addresses().findOne({ _id: res.body.id });
    expect(row.geocode_precision).toBe('zip');
    expect(Number(row.lat.toString())).toBeCloseTo(ZIP_CENTROIDS['97204']![0], 4);
    expect(row.updated_at).toEqual(updatedAt); // the address itself did not change
    expect((await kit.service.customerLocation(c.customerId))?.addressId).toBe(res.body.id);

    const again = await kit.service.geocodeAddresses();
    expect(again.geocoded).toBe(0);
  });

  it('places a default address never geocoded when its location is first asked for', async () => {
    const c = await kit.customer();
    const res = await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: address({ line1: '2122 NE Broadway St', postalCode: '97232' }) } });
    await addresses().updateOne({ _id: res.body.id }, { $set: { lat: null, lng: null, geocoded_at: null, geocode_precision: null } });
    expect(await kit.service.customerLocation(c.customerId)).toMatchObject({ addressId: res.body.id, precision: 'zip' });
    expect((await addresses().findOne({ _id: res.body.id })).geocoded_at).toBeInstanceOf(Date);
  });
});
