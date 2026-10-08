/**
 * Secrets identity keeps: password hashes (scrypt), opaque tokens stored as hashes, 6-digit codes,
 * TOTP (RFC 6238), recovery codes and encrypted 2-step secrets. node:crypto only.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, scrypt, timingSafeEqual, type KeyObject } from 'node:crypto';

/* ------------------------------------------------------------------ passwords (scrypt, per-password salt) */

/** Current parameters; hashes made with others are upgraded at the next successful sign-in. */
export const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

const scryptAsync = (password: string, salt: Buffer, o: { N: number; r: number; p: number; keylen: number }) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 128 * o.N * o.r * 2 }, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** `scrypt$N$r$p$salt$hash` (base64url) */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function parseHash(stored: string) {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return null;
  const key = Buffer.from(hash, 'base64url');
  return { N: Number(n), r: Number(r), p: Number(p), salt: Buffer.from(salt, 'base64url'), key, keylen: key.length };
}

/** Constant-time comparison of a password with a stored hash. */
export async function verifyPassword(stored: string | null | undefined, password: string): Promise<boolean> {
  const parsed = stored ? parseHash(stored) : null;
  if (!parsed) {
    await hashPassword(password); // same work whether or not there is a hash to compare with
    return false;
  }
  const key = await scryptAsync(password, parsed.salt, parsed);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

export const needsRehash = (stored: string) => {
  const p = parseHash(stored);
  return !p || p.N !== SCRYPT.N || p.r !== SCRYPT.r || p.p !== SCRYPT.p || p.keylen !== SCRYPT.keylen;
};

/* ------------------------------------------------------------------ opaque tokens and codes */

/** 256-bit random token, URL safe */
export const randomToken = (prefix = '') => `${prefix}${randomBytes(32).toString('base64url')}`;

/** Lookup hash of a high-entropy token (refresh, reset, invitation, order link, re-auth) */
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export const sixDigitCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ------------------------------------------------------------------ base32 (RFC 4648) */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ------------------------------------------------------------------ TOTP (RFC 6238: SHA-1, 6 digits, 30 s) */

export const TOTP_PERIOD = 30;

export const totpStep = (at: Date) => Math.floor(at.getTime() / 1000 / TOTP_PERIOD);

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const totpCode = (secret: Buffer, at: Date) => hotp(secret, totpStep(at));

/**
 * The time step the code belongs to (one step of drift either way), or null. Steps at or before
 * `lastUsedStep` are refused, so a code can't be replayed.
 */
export function verifyTotp(secret: Buffer, code: string, at: Date, lastUsedStep: number | null | undefined): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = totpStep(at);
  let match: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    if (safeEqual(hotp(secret, step), c) && (lastUsedStep == null || step > lastUsedStep) && match === null) match = step;
  }
  return match;
}

export const newTotpSecret = () => randomBytes(20);

/** ABCD EFGH … for typing into an authenticator app */
export const groupKey = (base32: string) => base32.replace(/(.{4})/g, '$1 ').trim();

export const otpauthUri = (secretBase32: string, account: string, issuer = 'Marketly') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`;

/* ------------------------------------------------------------------ recovery codes */

const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** `xxxxx-xxxxx`, about 49 bits each */
export function newRecoveryCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += RC_ALPHABET[randomInt(0, RC_ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

/* ------------------------------------------------------------------ keys derived from identity's signing key */

/**
 * Identity's secrets for HMACs (codes, recovery codes, refresh rotation) and for encrypting 2-step
 * secrets, derived (HKDF) from the private key it signs tokens with, so there is one secret to manage.
 */
export class IdentityKeys {
  readonly #ikm: Buffer;
  readonly #cache = new Map<string, Buffer>();

  constructor(signingKey: KeyObject) {
    const d = signingKey.export({ format: 'jwk' }).d;
    if (!d) throw new Error('identity signing key has no private part');
    this.#ikm = Buffer.from(d, 'base64url');
  }

  key(purpose: string): Buffer {
    let k = this.#cache.get(purpose);
    if (!k) {
      k = Buffer.from(hkdfSync('sha256', this.#ikm, 'marketly-identity', purpose, 32));
      this.#cache.set(purpose, k);
    }
    return k;
  }

  hmac(purpose: string, value: string): string {
    return createHmac('sha256', this.key(purpose)).update(value).digest('hex');
  }

  /** The refresh token that follows `current` in a session: deterministic, so a parallel refresh in the grace window gets the same one. */
  nextRefreshToken(sessionId: string, current: string): string {
    const prefix = current.slice(0, current.indexOf('.') + 1);
    return prefix + createHmac('sha256', this.key('refresh-rotation')).update(`${sessionId}:${current}`).digest('base64url');
  }

  /** AES-256-GCM: iv(12) | tag(16) | ciphertext */
  encrypt(plain: Buffer): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key('two-step-secrets'), iv);
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }

  decrypt(sealed: Uint8Array): Buffer {
    const b = Buffer.from(sealed);
    const d = createDecipheriv('aes-256-gcm', this.key('two-step-secrets'), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]);
  }
}
