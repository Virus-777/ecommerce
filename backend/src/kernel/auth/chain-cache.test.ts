/**
 * The auth chain's caches. Answers (permissions, member access, customers, staff sessions): concurrent misses share
 * one load, and an answer loaded across an invalidation is not kept. Tokens: a verified token skips the signature
 * check next time, never the time checks.
 */
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../lib/clock.js';
import { AuthChain, type AuthKernel } from './chain.js';
import { cachingVerifier, devSigner, newDevJwk, signAccessToken, type KeyRing } from './tokens.js';

// the caches only need the clock
const chainWith = () => new AuthChain({ clock: fixedClock('2026-10-01T00:00:00Z'), config: { auth: { issuer: 'test' } } } as unknown as AuthKernel);

describe('auth chain caches', () => {
  it('requests that miss the same key at once share one load', async () => {
    const chain = chainWith();
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 10));
      return true;
    };
    expect(await Promise.all([chain.permissions.get('a:x', load), chain.permissions.get('a:x', load), chain.permissions.get('a:x', load)])).toEqual([true, true, true]);
    expect(loads).toBe(1);
    await chain.permissions.get('a:x', load);
    expect(loads).toBe(1); // cached
    await chain.permissions.get('b:x', load);
    expect(loads).toBe(2);
  });

  it('a failed load is not kept: the next request asks again', async () => {
    const chain = chainWith();
    let loads = 0;
    await expect(chain.permissions.get('a:x', async () => (loads++, Promise.reject(new Error('down'))))).rejects.toThrow('down');
    expect(await chain.permissions.get('a:x', async () => (loads++, true))).toBe(true);
    expect(loads).toBe(2);
  });

  it('a token verified before is accepted again only while its times are valid, and never with another signature', () => {
    const clock = fixedClock('2026-10-01T00:00:00Z');
    const signer = devSigner({ jwk: newDevJwk() });
    const ring: KeyRing = { keys: new Map([[signer.kid, signer.publicKey]]) };
    const verify = cachingVerifier(ring, { issuer: 'test', leewaySeconds: 60, now: () => clock.now() });
    const token = signAccessToken(signer, { aud: 'store', kind: 'customer', sub: 'a1', sid: 's1' }, { issuer: 'test', ttlSeconds: 900, now: clock.now() });
    const first = verify(token);
    const second = verify(token);
    expect(second).toEqual(first);
    expect(second).not.toBe(first); // each caller gets its own copy
    const [head, body, sig] = token.split('.');
    const forged = `${head}.${body}.${sig!.slice(0, 10)}${sig![10] === 'A' ? 'B' : 'A'}${sig!.slice(11)}`;
    expect(() => verify(forged)).toThrow(expect.objectContaining({ reason: 'bad_signature' }));
    clock.advance(961_000); // past exp + leeway
    expect(() => verify(token)).toThrow(expect.objectContaining({ reason: 'expired' }));
    expect(() => verify(token)).toThrow(expect.objectContaining({ reason: 'expired' }));
  });

  it('an answer loaded while the cache is invalidated is used once, not kept', async () => {
    const chain = chainWith();
    let release!: () => void;
    const slow = chain.permissions.get('a:x', () => new Promise<boolean>((r) => (release = () => r(true))));
    chain.invalidate('permissions');
    release();
    expect(await slow).toBe(true);
    expect(await chain.permissions.get('a:x', async () => false)).toBe(false);
  });
});
