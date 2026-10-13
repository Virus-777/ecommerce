// Development tokens minted from the backend's dev signing key (DEV_TOKENS on, loopback only).
// Same format as backend/src/kernel/auth/tokens.ts signAccessToken + kernel/auth/dev.ts devClaims.
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ISSUER = 'marketly-identity';
const TTL_SECONDS = 12 * 3600;

/** UUIDv7 (the backend checks ids are uuids; v7 like everything it issues) */
export function uuidv7() {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export class Tokens {
  /** @param {string} backendDir backend folder (key file at .data/dev-signing-key.json) */
  constructor(backendDir) {
    this.backendDir = backendDir;
    this.cache = new Map();
    const file = join(backendDir, '.data', 'dev-signing-key.json');
    if (existsSync(file)) {
      const jwk = JSON.parse(readFileSync(file, 'utf8'));
      this.key = createPrivateKey({ key: jwk, format: 'jwk' });
      const spki = createPublicKey(this.key).export({ format: 'der', type: 'spki' });
      this.kid = `dev-${createHash('sha256').update(spki).digest('hex').slice(0, 12)}`;
    }
  }

  #mint(claims) {
    if (!this.key) return null;
    const iat = Math.floor(Date.now() / 1000);
    const body = { ...claims, iss: ISSUER, iat, exp: iat + TTL_SECONDS, jti: randomUUID() };
    const data = `${b64({ alg: 'EdDSA', typ: 'at+jwt', kid: this.kid })}.${b64(body)}`;
    return `${data}.${sign(null, Buffer.from(data), this.key).toString('base64url')}`;
  }

  /** Fallback: the backend's own CLI (npm run -s token -- …) */
  #cli(args) {
    const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', 'token', '--', ...args], { cwd: this.backendDir, encoding: 'utf8', shell: process.platform === 'win32' });
    return out.trim().split(/\r?\n/).pop();
  }

  #cached(key, make) {
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.token;
    const token = make();
    this.cache.set(key, { token, until: Date.now() + (TTL_SECONDS - 600) * 1000 });
    return token;
  }

  visitor(audience = 'store') {
    return this.#cached(`visitor:${audience}`, () => this.#mint({ aud: audience, kind: 'visitor', sid: uuidv7(), dev: {} }) ?? this.#cli(['visitor', '--audience', audience]));
  }

  customer(accountId) {
    const now = Math.floor(Date.now() / 1000);
    return this.#cached(`customer:${accountId}`, () => this.#mint({ aud: 'store', kind: 'customer', sub: accountId, sid: uuidv7(), authAt: now, dev: {} }) ?? this.#cli(['customer', '--account', accountId]));
  }

  seller(sellerId, accountId) {
    const now = Math.floor(Date.now() / 1000);
    return this.#cached(`seller:${sellerId}:${accountId}`, () =>
      this.#mint({ aud: 'seller', kind: 'seller', sub: accountId, sid: uuidv7(), authAt: now, sellerId, memberId: accountId, dev: { isOwner: true, permissions: [] } }) ?? this.#cli(['seller', '--seller', sellerId, '--account', accountId]),
    );
  }

  /** Staff with every permission, acting as a real staff account (approval limits resolve its roles) */
  staff(accountId, name) {
    const now = Math.floor(Date.now() / 1000);
    return this.#cached(`staff:${accountId}`, () =>
      this.#mint({ aud: 'admin', kind: 'staff', sub: accountId, sid: uuidv7(), authAt: now, twoStepAt: now, dev: { permissions: ['*'], ...(name ? { name } : {}) } }) ?? this.#cli(['staff', '--account', accountId]),
    );
  }
}
