/**
 * Gift card codes at rest: a batch's plain codes are sealed with AES-256-GCM under the
 * secretFor(config, 'wallet.gift-card-codes') key (hex, 32 bytes) and the batch id as associated data, so a
 * sealed blob copied onto another batch does not open. Format: base64(iv[12] | tag[16] | ciphertext).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const keyOf = (keyHex: string) => {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('The gift card codes key must be 32 bytes');
  return key;
};

export function sealCodes(keyHex: string, batchId: string, codes: readonly string[]): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(keyHex), iv);
  cipher.setAAD(Buffer.from(batchId, 'utf8'));
  const body = Buffer.concat([cipher.update(JSON.stringify(codes), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** The codes, or an error when the blob was altered, belongs to another batch or the key changed */
export function openCodes(keyHex: string, batchId: string, sealed: string): string[] {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyOf(keyHex), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(batchId, 'utf8'));
  decipher.setAuthTag(raw.subarray(12, 28));
  const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  const codes = JSON.parse(text) as unknown;
  if (!Array.isArray(codes) || !codes.every((c) => typeof c === 'string')) throw new Error('Sealed gift card codes are malformed');
  return codes;
}
