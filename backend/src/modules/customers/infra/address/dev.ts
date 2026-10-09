/**
 * Deterministic development address provider (no network). Normalises the way a US address service
 * would: standard street suffixes and directions, upper-case state, 5-digit ZIP kept, PO boxes flagged.
 * ZIP 00000 is "not found" so tests can exercise that answer.
 */
import type * as common from '../../../../spec/common.js';
import { cleanAddress, isPoBox } from '../../domain/address.js';
import type { AddressValidationProvider } from '../../ports.js';

const SUFFIX: Record<string, string> = {
  street: 'St', avenue: 'Ave', road: 'Rd', boulevard: 'Blvd', drive: 'Dr', lane: 'Ln', court: 'Ct', place: 'Pl', terrace: 'Ter',
  parkway: 'Pkwy', highway: 'Hwy', circle: 'Cir', square: 'Sq', suite: 'Ste', apartment: 'Apt',
  north: 'N', south: 'S', east: 'E', west: 'W', northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW',
};

const titleWord = (w: string) => (/^\d/.test(w) || w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
const street = (s: string) =>
  s
    .split(' ')
    .filter(Boolean)
    .map((w) => SUFFIX[w.toLowerCase().replace(/[.,]$/, '')] ?? titleWord(w))
    .join(' ');

export const devAddressProvider: AddressValidationProvider = {
  name: 'dev',
  async normalise(input: common.Address) {
    const a = cleanAddress(input);
    if (a.postalCode.startsWith('00000')) return null;
    return {
      address: { ...a, line1: street(a.line1), line2: a.line2 ? street(a.line2) : null, city: a.city.split(' ').map(titleWord).join(' ') },
      poBox: isPoBox(a),
    };
  },
};
