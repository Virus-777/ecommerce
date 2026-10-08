/**
 * IDs are UUIDv7 strings generated in the app: time-sortable and database-independent
 * (architecture §5). Human references (MK-…, RT-…) are separate fields, see refs.ts.
 */
import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

export function newId(now: number = Date.now()): string {
  // 48-bit timestamp, 4-bit version, 12-bit sequence (monotonic within a millisecond), 2-bit variant, 62 random bits
  const b = randomBytes(16);
  if (now === lastMs) seq = (seq + 1) & 0xfff;
  else {
    lastMs = now;
    seq = b.readUInt16BE(6) & 0x7ff; // random start, with room to count up within the millisecond
  }
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);
