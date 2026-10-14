/**
 * npm run keys: fills the production secrets of an env file, never overwrites them, and rotates the signing key
 * while the previous public key keeps verifying tokens signed just before.
 */
import { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signAccessToken, verifyAccessToken } from '../../src/kernel/auth/tokens.js';
import { loadConfig } from '../../src/kernel/config/index.js';
import { keyRing, tokenSigner } from '../../src/kernel/auth/setup.js';
import { envValue, fillKeys, setEnvValue } from './keys.js';

const TEMPLATE = ['# Production settings', 'NODE_ENV=production', '# AUTH_JWKS=', '# AUTH_SIGNING_JWK=', '# APP_SECRET=', 'ADMIN_URL=https://marketly.lan', ''].join('\n');

/** The settings production checks, around the keys an env file holds */
const prodEnv = (text: string) => ({
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  STORE_URL: 'https://marketly.lan',
  SELLER_URL: 'https://marketly.lan',
  ADMIN_URL: 'https://marketly.lan',
  API_URL: 'https://marketly.lan',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/marketly?replicaSet=rs0',
  AUTH_SIGNING_JWK: envValue(text, 'AUTH_SIGNING_JWK'),
  AUTH_JWKS: envValue(text, 'AUTH_JWKS'),
  APP_SECRET: envValue(text, 'APP_SECRET'),
});
const silent = { warn: () => {} } as never;

describe('npm run keys', () => {
  it('fills the placeholders with keys production accepts', () => {
    const r = fillKeys(TEMPLATE, { now: new Date('2026-10-15T08:00:00Z') });
    expect(r.written).toHaveLength(3);
    expect(r.text).toContain('ADMIN_URL=https://marketly.lan');
    expect(r.text).not.toMatch(/^# (AUTH_JWKS|AUTH_SIGNING_JWK|APP_SECRET)=/m);
    const jwk = JSON.parse(envValue(r.text, 'AUTH_SIGNING_JWK')!);
    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    expect(jwk.kid).toMatch(/^marketly-2026-10-15-[0-9a-f]{8}$/);
    expect(JSON.parse(envValue(r.text, 'AUTH_JWKS')!).keys).toEqual([{ kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: jwk.kid }]);
    expect(envValue(r.text, 'APP_SECRET')!.length).toBe(64);

    // the server starts with them and verifies what it signs
    const config = loadConfig(prodEnv(r.text));
    const ring = keyRing(config, silent);
    const signer = tokenSigner(config);
    const token = signAccessToken(signer, { aud: 'admin', kind: 'visitor', sid: 's1' }, { issuer: config.auth.issuer });
    expect(verifyAccessToken(ring, token, { issuer: config.auth.issuer, leewaySeconds: 0, now: () => new Date() }).sid).toBe('s1');
  });

  it('never overwrites what is there', () => {
    const first = fillKeys(TEMPLATE).text;
    const again = fillKeys(first);
    expect(again.written).toEqual([]);
    expect(again.kept).toEqual(['AUTH_SIGNING_JWK', 'AUTH_JWKS', 'APP_SECRET']);
    expect(again.text).toBe(first);
  });

  it('rotates the signing key only, keeping the previous public key for tokens already out', () => {
    const first = fillKeys(TEMPLATE).text;
    const old = loadConfig(prodEnv(first));
    const oldToken = signAccessToken(tokenSigner(old), { aud: 'admin', kind: 'visitor', sid: 'before' }, { issuer: old.auth.issuer });

    const rotated = fillKeys(first, { rotate: true }).text;
    expect(envValue(rotated, 'APP_SECRET')).toBe(envValue(first, 'APP_SECRET'));
    expect(envValue(rotated, 'AUTH_SIGNING_JWK')).not.toBe(envValue(first, 'AUTH_SIGNING_JWK'));
    const config = loadConfig(prodEnv(rotated));
    expect(verifyAccessToken(keyRing(config, silent), oldToken, { issuer: config.auth.issuer, leewaySeconds: 0, now: () => new Date() }).sid).toBe('before');

    // a second rotation drops the oldest key
    const twice = fillKeys(rotated, { rotate: true }).text;
    const kids = JSON.parse(envValue(twice, 'AUTH_JWKS')!).keys.map((k: { kid: string }) => k.kid);
    expect(kids).toHaveLength(2);
    expect(kids[1]).toBe(JSON.parse(envValue(rotated, 'AUTH_SIGNING_JWK')!).kid);
  });

  it('adds a signing key missing from AUTH_JWKS, and keeps a hand-made APP_SECRET', () => {
    const jwk = createPrivateKey({ key: JSON.parse(envValue(fillKeys(TEMPLATE).text, 'AUTH_SIGNING_JWK')!), format: 'jwk' }).export({ format: 'jwk' });
    let text = setEnvValue(TEMPLATE, 'AUTH_SIGNING_JWK', JSON.stringify({ ...jwk, kid: 'k1' }));
    text = setEnvValue(text, 'APP_SECRET', 'y'.repeat(40));
    const r = fillKeys(text);
    expect(r.written).toEqual(['AUTH_JWKS (added k1)']);
    expect(envValue(r.text, 'APP_SECRET')).toBe('y'.repeat(40));
  });

  it('reads and writes env lines', () => {
    expect(envValue("A='{\"x\":1}'\n", 'A')).toBe('{"x":1}');
    expect(envValue('# A=1\n', 'A')).toBeUndefined();
    expect(envValue('A=\n', 'A')).toBeUndefined();
    expect(setEnvValue('A=1\nB=2\n', 'B', '3')).toBe("A=1\nB='3'\n");
    expect(setEnvValue('A=1\n', 'C', '3')).toBe("A=1\nC='3'\n");
    expect(() => setEnvValue('', 'A', "it's")).toThrow(/quote/);
  });
});
