/** Tax ids are stored encrypted (AES-256-GCM with the sellers.tax-id purpose key); only the last 4 digits are ever returned. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface TaxIdCipher {
  encrypt(plain: string): Buffer;
  decrypt(blob: Uint8Array): string;
}

export function taxIdCipher(hexKey: string): TaxIdCipher {
  const key = Buffer.from(hexKey, 'hex');
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    decrypt(blob) {
      const b = Buffer.from(blob);
      const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
  };
}
