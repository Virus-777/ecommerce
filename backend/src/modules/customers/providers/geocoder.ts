/**
 * Geocoder providers (ports.ts Geocoder).
 *
 * devGeocoder: deterministic, no network. The ZIP's centroid from the built-in table (geocoder-data.ts) when the ZIP
 * is listed and lies in the address's state, otherwise the city's centroid, otherwise null.
 * unconfiguredGeocoder: production until a real geocoding service is wired; always null ("not configured"), so
 * addresses keep no point and the store shows the city without a distance.
 */
import type { Geocoder, GeocodeQuery, GeocodeResult } from '../ports.js';
import { CITY_CENTROIDS, ZIP_CENTROIDS, zipState, type LatLng } from './geocoder-data.js';

const STATES: Record<string, string> = { oregon: 'OR', washington: 'WA', california: 'CA', nevada: 'NV', texas: 'TX', utah: 'UT', alaska: 'AK' };

/** Upper-case 2-letter state code; full names of the states the tables hold are accepted */
export function stateCode(region: string): string {
  const r = region.trim().replace(/\.$/, '');
  return STATES[r.toLowerCase()] ?? r.toUpperCase();
}

/** Lower-case city key: "St. Helens", "Saint Helens" and "st helens" are one city; a trailing ", OR" is dropped */
export function cityKey(city: string): string {
  return city
    .toLowerCase()
    .replace(/,\s*[a-z]{2}\s*$/, '')
    .replace(/\bsaint\b/g, 'st')
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const result = (p: LatLng, precision: GeocodeResult['precision']): GeocodeResult => ({ point: { lat: p[0], lng: p[1] }, precision });

/** The dev lookup itself (sync), shared by the provider and tests */
export function lookupCentroid(q: GeocodeQuery): GeocodeResult | null {
  const country = (q.country ?? 'US').trim().toUpperCase();
  if (country && country !== 'US' && country !== 'USA') return null;
  const state = stateCode(q.region ?? '');
  const zip = /^\s*(\d{5})/.exec(q.postalCode ?? '')?.[1];
  if (zip) {
    const p = ZIP_CENTROIDS[zip];
    if (p && (!state || zipState(zip) === state)) return result(p, 'zip');
  }
  const c = CITY_CENTROIDS[`${cityKey(q.city ?? '')}|${state}`];
  return c ? result(c, 'city') : null;
}

export const devGeocoder: Geocoder = {
  name: 'dev',
  configured: true,
  async geocode(q) {
    return lookupCentroid(q);
  },
};

export const unconfiguredGeocoder: Geocoder = {
  name: 'none',
  configured: false,
  async geocode() {
    return null;
  },
};
