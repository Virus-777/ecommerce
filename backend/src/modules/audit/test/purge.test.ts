/**
 * audit.purge-expired with a fixed clock, the chain verifying across the purged range, and audit on
 * its own (no access, no reports): shortening needs approval it cannot get, exports are unavailable.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { devClaims } from '../../../kernel/auth/dev.js';
import { devSigner, signAccessToken } from '../../../kernel/auth/tokens.js';
import { auth, buildTestApp, ISSUER, TEST_JWK } from '../../../testing/app.js';
import { auditApi, entry, tamper } from './helpers.js';

const clock = fixedClock('2026-10-09T12:00:00Z');
let app: FastifyInstance;
// tokens are checked against the app clock, so they are issued at its time
const staff = auth(signAccessToken(devSigner({ jwk: TEST_JWK }), devClaims('staff'), { issuer: ISSUER, now: clock.now() }));
const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) => app.inject({ method, url: `/api/admin/audit${url}`, headers: staff, ...(payload ? { payload } : {}) });
const count = async (where = sql`true`) =>
  (await sql<{ n: number }>`select count(*)::int as n from audit.entries where ${where}`.execute(app.kernel.database.kysely)).rows[0]!.n;

beforeAll(async () => {
  app = await buildTestApp({ only: ['audit'], clock });
});
afterAll(async () => {
  await app?.close();
});

describe('audit.purge-expired', () => {
  const ids: Record<string, string> = {};

  it('drops whole months older than the retention period and records the purge with a checkpoint', async () => {
    const api = auditApi(app);
    const order = newId();
    // 7 years back from 2026-10-09 is 2019-10-09: months before October 2019 (market time) go, October 2019 stays
    ids.old1 = await api.record(entry({ at: '2018-03-15T12:00:00Z', target: { type: 'order', id: order }, relatedTargets: [{ type: 'seller', id: newId() }] }));
    ids.old2 = await api.record(entry({ at: '2019-10-01T06:00:00Z' })); // Sep 30, 23:00 in Los Angeles
    ids.kept = await api.record(entry({ at: '2019-10-01T08:00:00Z' })); // Oct 1, 01:00 in Los Angeles
    ids.backdated = await api.record(entry({ at: '2018-01-01T00:00:00Z' })); // older, but after a kept entry in the chain
    ids.recent = await api.record(entry());
    expect(await count()).toBe(5);

    await app.kernel.jobs.runNow('audit.purge-expired');

    const left = (await sql<{ id: string }>`select id from audit.entries order by seq`.execute(app.kernel.database.kysely)).rows.map((r) => r.id);
    expect(left.slice(0, 3)).toEqual([ids.kept, ids.backdated, ids.recent]);
    expect(left).toHaveLength(4);
    expect(await sql`select 1 from audit.entry_targets where entry_id = ${ids.old1}`.execute(app.kernel.database.kysely).then((r) => r.rows.length)).toBe(0);

    const purge = (await call('GET', '/entries?action=audit.retention.purged')).json().items[0];
    expect(purge).toMatchObject({ actor: { kind: 'system' }, category: 'settings', after: { removedEntries: 2, droppedPartitions: 2, retainYears: 7, checkpoint: { seq: expect.any(Number), hash: expect.stringMatching(/^[0-9a-f]{64}$/) } } });
    // and a signed purge checkpoint at the last removed entry
    const cps = (await sql<{ seq: number; kind: string; hash: Uint8Array; key_id: string }>`select seq::int, kind, hash, key_id from audit.checkpoints`.execute(app.kernel.database.kysely)).rows;
    expect(cps).toEqual([expect.objectContaining({ seq: purge.after.checkpoint.seq, kind: 'purge', key_id: 'audit.checkpoint.v1' })]);
    expect(Buffer.from(cps[0]!.hash).toString('hex')).toBe(purge.after.checkpoint.hash);

    const policy = (await call('GET', '/retention')).json();
    expect(policy.lastPurge).toEqual({ at: '2026-10-09T12:00:00.000Z', removedEntries: 2, removedThrough: '2019-10-01T07:00:00.000Z' });
    expect(policy.oldestEntryAt).toBe('2018-01-01T00:00:00.000Z');
    expect(policy.nextPurgeAt).toBe('2026-11-01T07:00:00.000Z');
  });

  it('the chain still verifies from the checkpoint', async () => {
    await app.kernel.jobs.runNow('audit.verify-chain');
    const status = (await call('GET', '/integrity')).json();
    expect(status).toMatchObject({ ok: true, brokenAtSeq: null });
  });

  it('a forged first link is still caught after a purge', async () => {
    const first = (await sql<{ id: string; seq: number }>`select id, seq::int from audit.entries order by seq limit 1`.execute(app.kernel.database.kysely)).rows[0]!;
    await tamper(app, sql`update audit.entries set prev_hash = ${new Uint8Array(32).fill(7)} where id = ${first.id}`);
    // a fresh check (no verified anchor or verified checkpoint) walks from the purge checkpoint
    await tamper(app, sql`delete from audit.integrity_checks`);
    await tamper(app, sql`delete from audit.checkpoints where kind = 'verified'`);
    await app.kernel.jobs.runNow('audit.verify-chain');
    expect((await call('GET', '/integrity')).json()).toMatchObject({ ok: false, brokenAtSeq: first.seq });
  });

  it('a second run with nothing to remove records nothing', async () => {
    const before = await count();
    await app.kernel.jobs.runNow('audit.purge-expired');
    expect(await count()).toBe(before);
    expect((await call('GET', '/retention')).json().lastPurge.removedEntries).toBe(0);
  });
});

describe('audit without access and reports', () => {
  it('lengthening works; shortening answers APPROVAL_REQUIRED', async () => {
    expect((await call('PUT', '/retention', { retainYears: 9, reason: 'Longer' })).statusCode).toBe(200);
    const res = await call('PUT', '/retention', { retainYears: 8, reason: 'Shorter' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('APPROVAL_REQUIRED');
    expect((await call('GET', '/retention')).json()).toMatchObject({ retainYears: 9, pendingChange: null });
  });

  it('exports are unavailable while reports is off', async () => {
    const res = await call('POST', '/exports', { filters: {}, format: 'csv', reason: 'Review' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DATASET_UNAVAILABLE');
    expect((await call('GET', '/exports')).json()).toEqual({ items: [], nextCursor: null });
    expect((await call('GET', `/exports/${newId()}`)).statusCode).toBe(404);
  });
});
