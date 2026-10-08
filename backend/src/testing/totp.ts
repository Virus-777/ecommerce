/** RFC 6238 authenticator codes for tests that walk the real 2-step flows (no module internals). */
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(key: string): Buffer {
  let bits = '';
  for (const c of key.replace(/[\s=-]/g, '').toUpperCase()) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base32: ${c}`);
    bits += i.toString(2).padStart(5, '0');
  }
  return Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
}

/** The 6-digit code for an authenticator's manual entry key at a time (30-second steps) */
export function totp(manualEntryKey: string, at: Date): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const mac = createHmac('sha1', base32(manualEntryKey)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
