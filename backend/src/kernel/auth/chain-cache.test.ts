/**
 * The auth chain's answer caches (permissions, member access, customers, staff sessions): concurrent misses share
 * one load, and an answer loaded across an invalidation is not kept.
 */
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../lib/clock.js';
import { AuthChain, type AuthKernel } from './chain.js';

// the caches only need the clock
const chainWith = () => new AuthChain({ clock: fixedClock('2026-10-01T00:00:00Z') } as Partial<AuthKernel> as AuthKernel);

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
