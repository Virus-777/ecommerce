/**
 * Points on the map and the distances the store shows ("1.2 mi"). Coordinates are WGS84 degrees.
 * The customer's point comes from customers.customerLocation (their geocoded default address).
 */

export type GeoPoint = { lat: number; lng: number };

const EARTH_RADIUS_MILES = 3958.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle (haversine) distance in miles. */
export function distanceMiles(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "0.3 mi", "1.2 mi", "14 mi": one decimal under 10 miles, whole miles above. */
export function milesLabel(miles: number): string {
  if (miles < 0.1) return '0.1 mi';
  return miles < 10 ? `${(Math.round(miles * 10) / 10).toFixed(1)} mi` : `${Math.round(miles)} mi`;
}

/** Distance label from the customer to a place, or null when either point is unknown. */
export function distanceLabel(from: GeoPoint | null | undefined, to: GeoPoint | null | undefined): string | null {
  if (!from || !to) return null;
  return milesLabel(distanceMiles(from, to));
}

export function isGeoPoint(v: unknown): v is GeoPoint {
  const p = v as GeoPoint | null;
  return !!p && typeof p.lat === 'number' && typeof p.lng === 'number' && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}
