/**
 * Address checks (pure): format rules (required fields, 5-digit ZIP, state code), the service region
 * (all 50 US states at launch) and PO box detection. A provider, when configured, adds a normalised
 * suggestion; without one these rules are all that run (spec integrations).
 */
import type * as common from '../../../spec/common.js';
import type { AddressIssue, AddressValidation } from '../../../spec/customers.js';

/** The 50 states plus DC (a US delivery address everyone expects to work). */
export const SERVICE_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);
/** Valid US codes outside the launch region: territories and military post offices */
const OTHER_US_CODES = new Set(['PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'AA', 'AE', 'AP']);

const ZIP = /^\d{5}(-\d{4})?$/;
const PO_BOX = /\b(p\s*\.?\s*o\s*\.?\s*box|post\s+office\s+box|pob\s+\d|box\s+\d+\s*$)/i;
const PHONE = /^\+?[0-9 ().-]{7,20}$/;

export const MAX_FIELD = 200;

const collapse = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Trimmed copy with upper-case state and country codes; empty optional fields become null. */
export function cleanAddress(a: common.Address): common.Address {
  return {
    name: collapse(a.name),
    line1: collapse(a.line1),
    line2: collapse(a.line2) || null,
    city: collapse(a.city),
    region: collapse(a.region).toUpperCase(),
    postalCode: collapse(a.postalCode),
    country: collapse(a.country).toUpperCase(),
    phone: collapse(a.phone) || null,
  };
}

export const isPoBox = (a: common.Address) => PO_BOX.test(a.line1) || PO_BOX.test(a.line2 ?? '');

/** Format rules, service region and PO boxes. `issues` with missing / invalid_format make the address invalid. */
export function checkAddress(input: common.Address): AddressValidation {
  const a = cleanAddress(input);
  const issues: AddressIssue[] = [];
  const missing = (field: keyof common.Address, label: string) => issues.push({ field, code: 'missing', message: `${label} is required` });
  if (!a.name) missing('name', 'Full name');
  if (!a.line1) missing('line1', 'Street address');
  if (!a.city) missing('city', 'City');
  if (!a.region) missing('region', 'State');
  if (!a.postalCode) missing('postalCode', 'ZIP code');
  if (!a.country) missing('country', 'Country');
  for (const f of ['name', 'line1', 'line2', 'city'] as const) {
    if ((a[f] ?? '').length > MAX_FIELD) issues.push({ field: f, code: 'invalid_format', message: `Use at most ${MAX_FIELD} characters` });
  }

  const us = a.country === 'US';
  if (a.country && !us && a.country.length !== 2) issues.push({ field: 'country', code: 'invalid_format', message: 'Use a 2-letter country code, e.g. US' });
  if (us && a.postalCode && !ZIP.test(a.postalCode)) issues.push({ field: 'postalCode', code: 'invalid_format', message: '5-digit ZIP code required' });
  if (us && a.region && !SERVICE_STATES.has(a.region) && !OTHER_US_CODES.has(a.region)) {
    issues.push({ field: 'region', code: 'invalid_format', message: 'Use a 2-letter state code, e.g. OR' });
  }
  if (a.phone && !PHONE.test(a.phone)) issues.push({ field: 'phone', code: 'invalid_format', message: 'Enter a phone number with digits only' });

  let inRegion = true;
  if (a.country && !us) {
    inRegion = false;
    issues.push({ field: 'country', code: 'outside_service_region', message: 'We deliver to US addresses only' });
  } else if (us && OTHER_US_CODES.has(a.region)) {
    inRegion = false;
    issues.push({ field: 'region', code: 'outside_service_region', message: 'We deliver to the 50 US states and DC only' });
  }
  const poBox = isPoBox(a);
  if (poBox) issues.push({ field: 'line1', code: 'po_box_not_allowed', message: 'We can’t deliver to PO boxes; use a street address' });

  const valid = !issues.some((i) => i.code === 'missing' || i.code === 'invalid_format');
  return { valid, issues, suggestion: null, deliverable: valid && inRegion && !poBox, poBox };
}

/** Problems that make an address unusable before anything else is checked */
export const hardIssues = (v: AddressValidation) => v.issues.filter((i) => i.code === 'missing' || i.code === 'invalid_format');

/** The same address, ignoring case and spacing (deduplicates addresses saved at checkout) */
export function sameAddress(a: common.Address, b: common.Address): boolean {
  const k = (x: common.Address) => {
    const c = cleanAddress(x);
    return [c.name, c.line1, c.line2 ?? '', c.city, c.region, c.postalCode.slice(0, 5), c.country].map((s) => s.toLowerCase()).join('|');
  };
  return k(a) === k(b);
}
