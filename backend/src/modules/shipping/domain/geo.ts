/**
 * Destinations: ZIP code → state, address kinds (PO box, military, territory) and zone matching.
 * One service region (the US) at launch; everything here is pure.
 */
import type * as common from '../../../spec/common.js';
import type { TransitRange } from '../../../spec/shipping.js';

/** ZIP3 ranges → state (USPS prefixes; military AA/AE/AP and territories included) */
const ZIP3: [number, number, string][] = [
  [5, 5, 'NY'], [6, 7, 'PR'], [8, 8, 'VI'], [9, 9, 'PR'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'],
  [50, 54, 'VT'], [55, 55, 'MA'], [56, 59, 'VT'], [60, 69, 'CT'], [70, 89, 'NJ'], [90, 99, 'AE'], [100, 149, 'NY'],
  [150, 196, 'PA'], [197, 199, 'DE'], [200, 200, 'DC'], [201, 201, 'VA'], [202, 205, 'DC'], [206, 219, 'MD'],
  [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'], [290, 299, 'SC'], [300, 319, 'GA'], [320, 339, 'FL'],
  [340, 340, 'AA'], [341, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'], [386, 397, 'MS'], [398, 399, 'GA'],
  [400, 427, 'KY'], [430, 458, 'OH'], [460, 479, 'IN'], [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'],
  [550, 567, 'MN'], [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'], [600, 629, 'IL'], [630, 658, 'MO'],
  [660, 679, 'KS'], [680, 693, 'NE'], [700, 714, 'LA'], [716, 729, 'AR'], [730, 749, 'OK'], [750, 799, 'TX'],
  [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'], [850, 865, 'AZ'], [870, 884, 'NM'],
  [885, 885, 'TX'], [889, 898, 'NV'], [900, 961, 'CA'], [962, 966, 'AP'], [967, 968, 'HI'], [969, 969, 'GU'],
  [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK'],
];

export const CONTIGUOUS_48_DC = [
  'AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];
export const MILITARY = ['AA', 'AE', 'AP'];
export const TERRITORIES = ['PR', 'VI', 'GU', 'AS', 'MP'];

export const normalizeZip = (postalCode: string | null | undefined) => (postalCode ?? '').trim().replace(/\s+/g, '').slice(0, 5);

/** State code of a ZIP code (null when unknown) */
export function stateOfZip(postalCode: string | null | undefined): string | null {
  const zip = normalizeZip(postalCode);
  if (!/^\d{3}/.test(zip)) return null;
  const n = Number(zip.slice(0, 3));
  return ZIP3.find(([a, b]) => n >= a && n <= b)?.[2] ?? null;
}

export type AddressKind = 'street' | 'po_box' | 'military' | 'territory';

export interface Destination {
  postalCode: string;
  region: string | null;
  city?: string | null;
  line1?: string | null;
  country: string;
}

export function destinationOf(input: { postalCode: string; region?: string | null; country?: string | null; address?: common.Address | null }): Destination {
  const a = input.address ?? null;
  const postalCode = normalizeZip(a?.postalCode ?? input.postalCode);
  const region = (a?.region ?? input.region ?? '').trim().toUpperCase() || stateOfZip(postalCode);
  return { postalCode, region, city: a?.city ?? null, line1: [a?.line1, a?.line2].filter(Boolean).join(' ') || null, country: (a?.country ?? input.country ?? 'US').toUpperCase() };
}

const PO_BOX = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|pmb\b)/i;
const MILITARY_CITY = /^(apo|fpo|dpo)$/i;

/** What kind of address it is (the carrier address check stands behind the same rule in production) */
export function addressKindOf(d: Destination): AddressKind {
  if ((d.region && MILITARY.includes(d.region)) || (d.city && MILITARY_CITY.test(d.city.trim()))) return 'military';
  if (d.region && TERRITORIES.includes(d.region)) return 'territory';
  if (d.line1 && PO_BOX.test(d.line1)) return 'po_box';
  return 'street';
}

export interface ZoneLike {
  id: string;
  name: string;
  kind: string;
  regions: string[];
  postal_prefixes: string[];
  address_kinds: string[];
  transit_by_method: Record<string, TransitRange>;
  status: string;
  customer_message: string | null;
}

const prefixMatch = (zip: string, prefixes: readonly string[]) => prefixes.some((p) => p && zip.startsWith(p));

/** A zone covers the destination by state, ZIP prefix or (excluded zones) address kind */
export function zoneMatches(z: ZoneLike, d: Destination, kind: AddressKind): boolean {
  if (d.region && z.regions.includes(d.region)) return true;
  if (prefixMatch(d.postalCode, z.postal_prefixes)) return true;
  if (z.kind === 'excluded' && kind !== 'street' && z.address_kinds.includes(kind)) return true;
  return false;
}

export function locationLabel(d: Destination): string {
  return [d.city, [d.region, d.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
