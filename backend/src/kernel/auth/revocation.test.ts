/**
 * The revocation list: revoked sessions and account-wide revocations from identity's poll, and the
 * production rule that admin requests fail closed (503) when the list is not current.
 */
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Authorities, Revocations } from './authorities.js';
import { RevocationList } from './revocation.js';
import type { AccessClaims } from './tokens.js';

let now = Date.parse('2026-10-11T10:00:00Z');
const clock = { now: () => new Date(now) };
const log = { error: () => {} } as unknown as FastifyBaseLogger;

function list(answer: () => Promise<Revocations | null>, maxStalenessMs?: number) {
  const authorities = { revocationsSince: answer } as unknown as Authorities;
  return new RevocationList(authorities, clock, log, { pollMs: 3000, windowMs: 16 * 60_000, maxStalenessMs });
}
const ok = async (): Promise<Revocations> => ({ sessions: [{ sessionId: 's-1', at: new Date(now).toISOString() }], accounts: [], cursor: 'c' });
const claims = (sid: string) => ({ sid, sub: 'a-1', iat: Math.floor(now / 1000) }) as AccessClaims;

describe('revocation list', () => {
  it('refuses tokens of revoked sessions', async () => {
    const l = list(ok);
    await l.sync();
    expect(l.isRevoked(claims('s-1'))).toBe(true);
    expect(l.isRevoked(claims('s-2'))).toBe(false);
  });

  it('fails closed for admin requests when the sync fails beyond the limit (production)', async () => {
    let answer: () => Promise<Revocations | null> = ok;
    const l = list(() => answer(), 30_000);
    await l.sync();
    expect(() => l.assertFresh()).not.toThrow();

    // identity throws: the last good sync still counts until it is too old
    answer = async () => {
      throw new Error('identity down');
    };
    now += 20_000;
    await l.sync();
    expect(() => l.assertFresh()).not.toThrow();
    now += 15_000;
    await l.sync();
    expect(() => l.assertFresh()).toThrow(expect.objectContaining({ code: 'SERVICE_UNAVAILABLE', status: 503 }));

    // identity answers nothing (off or not built): still not current
    answer = async () => null;
    await l.sync();
    expect(() => l.assertFresh()).toThrow(expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }));

    answer = ok;
    await l.sync();
    expect(() => l.assertFresh()).not.toThrow();
  });

  it('fails closed when no sync ever succeeded', async () => {
    const l = list(async () => null, 30_000);
    await l.sync();
    expect(() => l.assertFresh()).toThrow(expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }));
  });

  it('does not gate requests outside production (no staleness limit)', async () => {
    const l = list(async () => null);
    await l.sync();
    expect(() => l.assertFresh()).not.toThrow();
  });
});
