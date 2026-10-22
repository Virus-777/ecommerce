/**
 * Sample dealers for farm orders (farm module): three Portland-area farm machine dealers with real-looking addresses,
 * their map points (a staff pin, so distances work without a geocoder), opening hours, phones and lead times. The
 * first one (Greenfield Agri Equipment, Canby) is the market default dealer that visitors and customers without a
 * geocoded default address see in Farm machines' "Your nearest dealer". Written through the Admin Center API, and
 * only what is missing (a dealer with the same name is kept as it is), so it is safe to run again. Used by
 * tools/seed-departments.ts. Names, phones and emails are samples.
 */
import type { AdminCall } from './departments-data.js';

export const FARM_DEALERS = [
  {
    name: 'Greenfield Agri Equipment',
    address: { line1: '26685 S Hwy 99E', city: 'Canby', region: 'OR', postalCode: '97013' },
    point: { lat: 45.2447, lng: -122.6728 },
    hours: 'Mon–Sat 7:00–18:00',
    phone: '503-555-0142',
    messagePhone: '503-555-0143',
    messageEmail: 'sales@greenfieldagri.example',
  },
  {
    name: 'Tualatin Valley Tractor',
    address: { line1: '4085 NW Cornell Rd', city: 'Hillsboro', region: 'OR', postalCode: '97124' },
    point: { lat: 45.5306, lng: -122.9372 },
    hours: 'Mon–Fri 7:30–17:30 · Sat 8:00–14:00',
    phone: '503-555-0177',
    messageEmail: 'sales@tvtractor.example',
    leadDays: 5,
  },
  {
    name: 'Willamette Farm Supply',
    address: { line1: '3050 Silverton Rd NE', city: 'Salem', region: 'OR', postalCode: '97301' },
    point: { lat: 44.9567, lng: -123.008 },
    hours: 'Mon–Sat 8:00–17:00',
    phone: '503-555-0190',
    messagePhone: '503-555-0191',
    leadDays: 7,
  },
];

export async function seedFarm(admin: AdminCall): Promise<{ dealers: number }> {
  const added = { dealers: 0 };
  const existing = new Set(((await admin('GET', '/admin/farm/dealers')) as { name: string }[]).map((d) => d.name));
  for (const [i, d] of FARM_DEALERS.entries()) {
    if (existing.has(d.name)) continue;
    await admin('POST', '/admin/farm/dealers', { ...d, active: true, position: i + 1 });
    added.dealers++;
  }
  return added;
}
