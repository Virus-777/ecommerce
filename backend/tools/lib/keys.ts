/**
 * The production secrets in an env file (npm run keys, tools/keys.ts):
 *
 *   AUTH_SIGNING_JWK  identity's private Ed25519 key that signs access and visitor tokens (JWK with a kid)
 *   AUTH_JWKS         the public keys every request's token is checked against: the signing key's, and after a
 *                     rotation also the previous one, so tokens signed just before keep working until they expire
 *   APP_SECRET        root secret (48 random bytes): identity's data key (stored pass codes, encrypted secrets),
 *                     audit checkpoints, file links and unsubscribe links all derive from it
 *
 * Existing values are never overwritten. --rotate replaces the signing key only: access tokens live 15 minutes and
 * refresh tokens are random values checked in the database, not signed with this key, so nobody is signed out.
 * APP_SECRET is never rotated here: changing it would break stored pass codes and 2-step secrets, audit checkpoints
 * and every file link already handed out.
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';

export interface EnvKeys {
  AUTH_SIGNING_JWK?: string;
  AUTH_JWKS?: string;
  APP_SECRET?: string;
}

type PublicJwk = { kty: string; crv: string; x: string; kid: string };

/** The value of KEY=… in an env file (quotes removed); commented lines (# KEY=…) and empty values count as unset */
export function envValue(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*${key}\\s*=(.*)$`).exec(line);
    if (!m) continue;
    let v = m[1]!.trim();
    if (/^'.*'$/.test(v) || /^".*"$/.test(v)) v = v.slice(1, -1);
    return v || undefined;
  }
  return undefined;
}

/**
 * Sets KEY='value' in an env file's text: replaces the KEY= line, else the first commented "# KEY=" placeholder,
 * else appends. Single quotes: Node's --env-file takes the JSON as it is, and bash could read the file too.
 */
export function setEnvValue(text: string, key: string, value: string): string {
  if (value.includes("'") || /[\r\n]/.test(value)) throw new Error(`${key}: a value with a quote or a line break cannot be written`);
  const line = `${key}='${value}'`;
  const lines = text.split(/\r?\n/);
  let i = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (i < 0) i = lines.findIndex((l) => new RegExp(`^\\s*#\\s*${key}\\s*=`).test(l));
  if (i >= 0) lines[i] = line;
  else {
    if (lines.length && lines.at(-1) === '') lines.pop();
    lines.push(line, '');
  }
  return lines.join('\n');
}

/** A new Ed25519 signing key as a JWK with a kid that says when it was made (never "dev-…") */
export function newSigningJwk(now = new Date()): { private: Record<string, string>; public: PublicJwk } {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as Record<string, string>;
  const kid = `marketly-${now.toISOString().slice(0, 10)}-${createHash('sha256').update(jwk.x!).digest('hex').slice(0, 8)}`;
  return { private: { ...jwk, kid }, public: publicOf({ ...jwk, kid }) };
}

/** The public half of a signing JWK (what AUTH_JWKS lists) */
export function publicOf(jwk: Record<string, string>): PublicJwk {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.kid) throw new Error('AUTH_SIGNING_JWK must be an Ed25519 JWK (kty OKP) with a kid');
  // derived from the private key, so a hand-edited "x" cannot slip through
  const x = (createPublicKey({ key: jwk as never, format: 'jwk' }).export({ format: 'jwk' }) as { x: string }).x;
  return { kty: 'OKP', crv: 'Ed25519', x, kid: jwk.kid };
}

export const newAppSecret = () => randomBytes(48).toString('base64url');

export interface KeysResult {
  text: string;
  /** What was written, for the operator (never a secret value) */
  written: string[];
  /** Values already there and kept */
  kept: string[];
}

/**
 * Fills the missing secrets of an env file's text; with rotate, also replaces the signing key and keeps the
 * previous public key in AUTH_JWKS (only that one: older keys are dropped).
 */
export function fillKeys(text: string, o: { rotate?: boolean; now?: Date } = {}): KeysResult {
  const written: string[] = [];
  const kept: string[] = [];
  let out = text;
  const current = envValue(text, 'AUTH_SIGNING_JWK');

  if (!current || o.rotate) {
    const key = newSigningJwk(o.now);
    const previous = current ? publicOf(JSON.parse(current)) : undefined;
    out = setEnvValue(out, 'AUTH_SIGNING_JWK', JSON.stringify(key.private));
    out = setEnvValue(out, 'AUTH_JWKS', JSON.stringify({ keys: previous ? [key.public, previous] : [key.public] }));
    written.push(`AUTH_SIGNING_JWK (new key ${key.private.kid})`, previous ? `AUTH_JWKS (${key.private.kid} and the previous ${previous.kid})` : `AUTH_JWKS (${key.private.kid})`);
  } else {
    kept.push('AUTH_SIGNING_JWK');
    const signing = publicOf(JSON.parse(current));
    const jwks = envValue(text, 'AUTH_JWKS');
    const listed = jwks ? ((JSON.parse(jwks) as { keys?: PublicJwk[] }).keys ?? []) : [];
    if (listed.some((k) => k.kid === signing.kid)) kept.push('AUTH_JWKS');
    else {
      // the signing key's public half must be listed, or production refuses to start (AUTH_JWKS is required)
      out = setEnvValue(out, 'AUTH_JWKS', JSON.stringify({ keys: [signing, ...listed] }));
      written.push(`AUTH_JWKS (added ${signing.kid})`);
    }
  }

  if (envValue(text, 'APP_SECRET')) kept.push('APP_SECRET');
  else {
    out = setEnvValue(out, 'APP_SECRET', newAppSecret());
    written.push('APP_SECRET (48 random bytes)');
  }
  return { text: out, written, kept };
}
