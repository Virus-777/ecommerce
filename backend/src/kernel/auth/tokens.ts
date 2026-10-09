/**
 * Access and visitor tokens: JWTs signed with EdDSA (Ed25519), verified locally by the middleware
 * (docs/03-auth-middleware.md §5). Identity holds the private key and signs; every server verifies
 * with the public keys published by key id (AUTH_JWKS).
 *
 * Development and tests sign with a per-machine dev key (kid "dev-…"), never shared and never accepted
 * in production. Only dev-key tokens may carry `dev` claims (permissions, owner flag) that stand in for
 * the access and sellers modules until they are built.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject, type webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Audience = 'store' | 'seller' | 'admin';
export type Jwk = webcrypto.JsonWebKey;
export type TokenKind = 'visitor' | 'customer' | 'seller' | 'staff';

export interface AccessClaims {
  iss: string;
  aud: Audience;
  kind: TokenKind;
  /** account id; absent for visitors */
  sub?: string;
  /** session id; for store visitors also the guest session */
  sid: string;
  sellerId?: string;
  memberId?: string;
  authAt?: number;
  twoStepAt?: number;
  iat: number;
  exp: number;
  jti: string;
  /** Development only (dev-key tokens): permissions and owner flag standing in for access and sellers */
  dev?: { permissions?: string[]; isOwner?: boolean; name?: string };
}

export type TokenFailure = 'missing' | 'malformed' | 'unknown_key' | 'bad_signature' | 'wrong_type' | 'wrong_issuer' | 'expired' | 'not_yet_valid' | 'revoked';

export class TokenError extends Error {
  constructor(readonly reason: TokenFailure) {
    super(`token ${reason}`);
  }
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const unb64 = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
const KINDS = new Set<TokenKind>(['visitor', 'customer', 'seller', 'staff']);
const AUDIENCES = new Set<Audience>(['store', 'seller', 'admin']);

export interface KeyRing {
  /** kid → public key */
  keys: Map<string, KeyObject>;
  /** Development signer (absent in production) */
  dev?: { kid: string; key: KeyObject };
}

export interface TokenOptions {
  issuer: string;
  leewaySeconds: number;
  now: () => Date;
}

/** Verifies signature, type, issuer, audience, kind and times. Throws TokenError. */
export function verifyAccessToken(ring: KeyRing, token: string, o: TokenOptions): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('malformed');
  let header: { alg?: string; typ?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = unb64(parts[0]!);
    claims = unb64(parts[1]!);
  } catch {
    throw new TokenError('malformed');
  }
  if (header.alg !== 'EdDSA') throw new TokenError('wrong_type'); // algorithm allowlist: EdDSA only
  if (header.typ !== 'at+jwt') throw new TokenError('wrong_type');
  const key = header.kid ? ring.keys.get(header.kid) : undefined;
  if (!key) throw new TokenError('unknown_key');
  if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'))) throw new TokenError('bad_signature');
  if (claims.iss !== o.issuer) throw new TokenError('wrong_issuer');
  if (!AUDIENCES.has(claims.aud) || !KINDS.has(claims.kind) || typeof claims.sid !== 'string') throw new TokenError('malformed');
  if (claims.kind !== 'visitor' && typeof claims.sub !== 'string') throw new TokenError('malformed');
  const now = Math.floor(o.now().getTime() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + o.leewaySeconds < now) throw new TokenError('expired');
  if (typeof claims.iat !== 'number' || claims.iat - o.leewaySeconds > now) throw new TokenError('not_yet_valid');
  if (claims.dev && !header.kid!.startsWith('dev-')) delete claims.dev; // dev claims only count on dev-key tokens
  return claims;
}

export function signAccessToken(signer: { kid: string; key: KeyObject }, claims: Omit<AccessClaims, 'iat' | 'exp' | 'jti' | 'iss'>, o: { issuer: string; ttlSeconds?: number; now?: Date }): string {
  const iat = Math.floor((o.now ?? new Date()).getTime() / 1000);
  const body = { ...claims, iss: o.issuer, iat, exp: iat + (o.ttlSeconds ?? 900), jti: randomUUID() };
  const data = `${b64({ alg: 'EdDSA', typ: 'at+jwt', kid: signer.kid })}.${b64(body)}`;
  return `${data}.${sign(null, Buffer.from(data), signer.key).toString('base64url')}`;
}

/** AUTH_JWKS: { "keys": [{ "kty": "OKP", "crv": "Ed25519", "x": "…", "kid": "…" }] } */
export function parseJwks(json: string | undefined): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  if (!json) return keys;
  const set = JSON.parse(json) as { keys?: (Jwk & { kid?: string })[] };
  for (const jwk of set.keys ?? []) {
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.kid) throw new Error('AUTH_JWKS keys must be Ed25519 (kty OKP) with a kid');
    if (jwk.kid.startsWith('dev-')) throw new Error('AUTH_JWKS must not contain development keys');
    keys.set(jwk.kid, createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' }));
  }
  return keys;
}

/** A per-machine development key: created once in the given file (or supplied as a JWK by tests). */
export function devSigner(source: { jwk?: Jwk; file?: string }): { kid: string; key: KeyObject; publicKey: KeyObject } {
  let jwk = source.jwk;
  if (!jwk && source.file) {
    if (existsSync(source.file)) jwk = JSON.parse(readFileSync(source.file, 'utf8'));
    else {
      jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
      mkdirSync(dirname(source.file), { recursive: true });
      writeFileSync(source.file, JSON.stringify(jwk), { mode: 0o600 });
    }
  }
  if (!jwk) jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = createPublicKey(key);
  const kid = `dev-${createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 12)}`;
  return { kid, key, publicKey };
}

export const newDevJwk = (): Jwk => generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
