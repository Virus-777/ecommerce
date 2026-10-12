/**
 * Ids of the seeded carriers and carrier services (decision D-S1). They are derived from the codes, so every
 * install has the same ids for the same carrier.
 */
import { createHash } from 'node:crypto';

/** A stable RFC 4122 UUID (version 8 layout) from a name */
function stableId(name: string): string {
  const h = createHash('sha256').update(name).digest('hex').split('');
  h[12] = '8';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export const carrierSeedId = (code: string) => stableId(`shipping.carrier:${code}`);
export const carrierServiceSeedId = (carrierCode: string, serviceCode: string) => stableId(`shipping.carrier_service:${carrierCode}:${serviceCode}`);
