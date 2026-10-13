/**
 * audit.purge-expired with a fixed clock, the chain verifying across the purged range, and audit on
 * its own (no access, no reports): shortening needs approval it cannot get, exports are unavailable.
 * The history is one collection: the purge deletes by the indexed at, and audit.prepare-partitions does nothing
 * but still succeeds.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { devClaims } from '../../../kernel/auth/dev.js';
import { devSigner, signAccessToken } from '../../../kernel/auth/tokens.js';
import { auth, buildTestApp, callers, ISSUER, TEST_JWK, tokenClock } from '../../../testing/app.js';
import { auditApi, auditTable, entry } from './helpers.js';

const clock = fixedClock('2026-10-09T12:00:00Z');
let app: FastifyInstance;
// tokens are checked against the app clock, so they are issued at its time
const staff = auth(signAccessToken(devSigner({ jwk: TEST_JWK }), devClaims('staff'), { issuer: ISSUER, now: clock.now() }));
const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) => app.inject({ method, url: `/api/admin/audit${url}`, headers: staff, ...(payload ? { payload } : {}) });
const count = () => auditTable(app, 'entries').count();

beforeAll(async () => {
  app = await buildTestApp({ only: ['audit'], clock });
});
afterAll(async () => {
  await app?.close();
});

describe('audit.purge-expired', () => {
  const ids: Record<string, string> = {};

  it('removes the entries older than the retention period and records the purge with a checkpoint', async () => {
    const api = auditApi(app);
    const order = newId();
    // 7 years back from 2026-10-09 is 2019-10-09: months before October 2019 (market time) go, October 2019 stays
    ids.old1 = await api.record(entry({ at: '2018-03-15T12:00:00Z', target: { type: 'order', id: order }, relatedTargets: [{ type: 'seller', id: newId() }] }));
    ids.old2 = await api.record(entry({ at: '2019-10-01T06:00:00Z' })); // Sep 30, 23:00 in Los Angeles
    ids.kept = await api.record(entry({ at: '2019-10-01T08:00:00Z' })); // Oct 1, 01:00 in Los Angeles
    ids.backdated = await api.record(entry({ at: '2018-01-01T00:00:00Z', relatedTargets: [{ type: 'seller', id: newId() }] })); // older, but after a kept entry in the chain
    ids.recent = await api.record(entry());
    expect(await count()).toBe(5);

    await app.kernel.jobs.runNow('audit.purge-expired');

    const left = (await auditTable(app, 'entries').find({}, { sort: { seq: 1 } })).map((r) => r.id);
    expect(left.slice(0, 3)).toEqual([ids.kept, ids.backdated, ids.recent]);
    expect(left).toHaveLength(4);
    // the removed entry's related targets go with it; the kept backdated entry keeps its own
    expect(await auditTable(app, 'entry_targets').count({ entry_id: ids.old1 })).toBe(0);
    expect(await auditTable(app, 'entry_targets').count({ entry_id: ids.backdated })).toBe(1);

    const purge = (await call('GET', '/entries?action=audit.retention.purged')).json().items[0];
    expect(purge).toMatchObject({ actor: { kind: 'system' }, category: 'settings', after: { removedEntries: 2, retainYears: 7, checkpoint: { seq: expect.any(Number), hash: expect.stringMatching(/^[0-9a-f]{64}$/) } } });
    expect(purge.after).not.toHaveProperty('droppedPartitions');
    // and a signed purge checkpoint at the last removed entry
    const cps = await auditTable(app, 'checkpoints').find();
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
    const first = (await auditTable(app, 'entries').findOne({}, { sort: { seq: 1 } }))!;
    await auditTable(app, 'entries').updateOne({ id: first.id }, { prev_hash: Buffer.alloc(32, 7) });
    // a fresh check (no verified anchor or verified checkpoint) walks from the purge checkpoint
    await auditTable(app, 'integrity_checks').deleteMany({});
    await auditTable(app, 'checkpoints').deleteMany({ kind: 'verified' });
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

describe('a purge when every entry is past the cut-off, years later', () => {
  const later = fixedClock('2026-10-09T12:00:00Z');
  let other: FastifyInstance;
  const verify = async () => {
    await other.kernel.jobs.runNow('audit.verify-chain');
    return (await other.inject({ method: 'GET', url: '/api/admin/audit/integrity', headers: auth(callers.staff()) })).json();
  };
  beforeAll(async () => {
    tokenClock.now = () => later.now();
    tokenClock.ttlSeconds = 20 * 365 * 86_400;
    other = await buildTestApp({ only: ['audit'], clock: later });
  });
  afterAll(async () => {
    tokenClock.now = undefined;
    tokenClock.ttlSeconds = 900;
    await other?.close();
  });

  it('audit.prepare-partitions has nothing to prepare and succeeds', async () => {
    await other.kernel.jobs.runNow('audit.prepare-partitions');
    await other.kernel.jobs.runNow('audit.prepare-partitions');
    expect(await auditTable(other, 'entries').count()).toBe(0);
  });

  it('keeps only the purge entry, still verifiable', async () => {
    await auditApi(other).record(entry({ at: '2018-02-10T12:00:00Z', relatedTargets: [{ type: 'seller', id: newId() }] }));
    await auditApi(other).record(entry({ at: '2018-05-10T12:00:00Z' }));
    await other.kernel.jobs.runNow('audit.purge-expired');
    const items = (await other.inject({ method: 'GET', url: '/api/admin/audit/entries', headers: auth(callers.staff()) })).json().items;
    expect(items).toEqual([expect.objectContaining({ action: 'audit.retention.purged', after: expect.objectContaining({ removedEntries: 2, checkpoint: expect.objectContaining({ seq: 2 }) }) })]);
    expect(await auditTable(other, 'entry_targets').count()).toBe(0);
    expect(await verify()).toMatchObject({ ok: true });
  });

  it('seven years on, a second purge continues the chain from its own checkpoint, and a later rewrite is caught', async () => {
    await auditApi(other).record(entry({ reason: 'Kept for now' }));
    later.set('2034-01-15T12:00:00Z');
    await other.kernel.jobs.runNow('audit.purge-expired');
    const left = await auditTable(other, 'entries').find({}, { sort: { seq: 1 } });
    expect(left.map((r) => r.action)).toEqual(['audit.retention.purged']);
    expect(await auditTable(other, 'checkpoints').count({ kind: 'purge' })).toBe(2);
    expect(await verify()).toMatchObject({ ok: true, brokenAtSeq: null });
    const head = left.at(-1)!;
    await auditTable(other, 'entries').updateOne({ id: head.id }, { reason: 'Rewritten' });
    expect(await verify()).toMatchObject({ ok: false, brokenAtSeq: head.seq });
  });
});

describe('entries deleted behind the app’s back', () => {
  const at = fixedClock('2026-10-09T12:00:00Z');
  let other: FastifyInstance;
  beforeAll(async () => {
    tokenClock.now = () => at.now();
    other = await buildTestApp({ only: ['audit'], clock: at });
  });
  afterAll(async () => {
    tokenClock.now = undefined;
    await other?.close();
  });

  it('break the chain (a month deleted without a purge)', async () => {
    const api = auditApi(other);
    await api.record(entry({ at: '2026-01-15T12:00:00Z' }));
    const march = await api.record(entry({ at: '2026-03-15T12:00:00Z' }));
    const now = await api.record(entry());
    const verify = async () => {
      await other.kernel.jobs.runNow('audit.verify-chain');
      return (await other.inject({ method: 'GET', url: '/api/admin/audit/integrity', headers: auth(callers.staff()) })).json();
    };
    expect(await verify()).toMatchObject({ ok: true });
    await auditTable(other, 'entries').deleteMany({ at: { $gte: new Date('2026-03-01T08:00:00Z'), $lt: new Date('2026-04-01T07:00:00Z') } });
    expect(await auditTable(other, 'entries').count({ id: march })).toBe(0);
    // a fresh walk from the start (the last verified checkpoint would only cover what follows it)
    await auditTable(other, 'integrity_checks').deleteMany({});
    await auditTable(other, 'checkpoints').deleteMany({});
    const seqNow = (await auditTable(other, 'entries').findOne({ id: now }))!.seq;
    expect(await verify()).toMatchObject({ ok: false, brokenAtSeq: seqNow });
  });
});
