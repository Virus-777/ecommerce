/**
 * Signed checkpoints (gap pass 3): a clean verify-chain run signs where it stopped (HMAC keyed with
 * secretFor(config, 'audit.checkpoint')); the next run checks that signature and continues from it, so a chain
 * rewritten with every hash recomputed is still caught. New categories (support, trust, inventory, shipping).
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auth, buildTestApp, callers } from '../../../testing/app.js';
import { hashRow } from '../domain/chain.js';
import type { AuditRepository } from '../repository.js';
import { auditApi, auditTable, entry, waitForEvents } from './helpers.js';

let app: FastifyInstance;
const staff = auth(callers.staff());
const integrity = async () => (await app.inject({ method: 'GET', url: '/api/admin/audit/integrity', headers: staff })).json();
const verify = async () => {
  await app.kernel.jobs.runNow('audit.verify-chain');
  return integrity();
};
const repo = () => (app.kernel.boot.apis.get('audit') as unknown as { deps: { repo: AuditRepository } }).deps.repo;
const checkpoints = async () => (await auditTable(app, 'checkpoints').find({}, { sort: { seq: 1 } })).map(({ seq, kind, mac, key_id }) => ({ seq, kind, mac, key_id }));
const maxSeq = async () => (await auditTable(app, 'entries').findOne({}, { sort: { seq: -1 } }))!.seq;

beforeEach(async () => {
  // a fresh database per test: checkpoints are global to the chain
  app = await buildTestApp({ only: ['audit'] });
});
afterEach(async () => {
  await app?.close();
});

describe('signed checkpoints', () => {
  it('a clean run writes a signed checkpoint at the last seq and reports it', async () => {
    expect(await integrity()).toMatchObject({ lastCheckpointSeq: null, checkpointSignatureOk: null });
    await auditApi(app).recordMany([entry(), entry(), entry()]);
    const status = await verify();
    const head = await maxSeq();
    expect(status).toMatchObject({ ok: true, lastVerifiedSeq: head, lastCheckpointSeq: head, lastCheckpointAt: expect.any(String), checkpointSignatureOk: true });
    expect(await checkpoints()).toEqual([expect.objectContaining({ seq: head, kind: 'verified', key_id: 'audit.checkpoint.v1', mac: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    // nothing new: no second checkpoint
    await verify();
    expect(await checkpoints()).toHaveLength(1);
    // new entries: the next run continues from the checkpoint and signs the new head
    await auditApi(app).record(entry());
    expect(await verify()).toMatchObject({ ok: true, lastCheckpointSeq: await maxSeq() });
    expect(await checkpoints()).toHaveLength(2);
  });

  it('catches a chain rewritten with every hash recomputed (the checkpoint no longer matches)', async () => {
    const failed: unknown[] = [];
    app.kernel.events.subscribe('test', 'audit.integrity.failed', (e) => void failed.push(e.payload));
    await auditApi(app).recordMany([entry(), entry({ reason: 'Original reason' })]);
    expect((await verify()).ok).toBe(true);
    const head = await maxSeq();
    // someone with database access rewrites the signed entry and recomputes its hash, so the row is self-consistent
    const row = (await repo().entryBySeq(head))!;
    const forged = { ...row, reason: 'Rewritten reason' };
    const hash = hashRow(forged.prevHash, forged);
    await auditTable(app, 'entries').updateOne({ seq: head }, { reason: 'Rewritten reason', hash: Buffer.from(hash) });
    const status = await verify();
    expect(status).toMatchObject({ ok: false, brokenAtSeq: head });
    await waitForEvents(app);
    expect(failed).toContainEqual(expect.objectContaining({ brokenAtSeq: head }));
  });

  it('catches a forged checkpoint (its HMAC does not verify without the key)', async () => {
    await auditApi(app).recordMany([entry(), entry()]);
    await verify();
    const head = await maxSeq();
    await auditTable(app, 'checkpoints').updateOne({ seq: head }, { mac: '0'.repeat(64) });
    expect(await integrity()).toMatchObject({ ok: false, checkpointSignatureOk: false, brokenAtSeq: head, message: expect.stringMatching(/does not verify/) });
    const status = await verify();
    expect(status).toMatchObject({ ok: false, checkpointSignatureOk: false, brokenAtSeq: head });
    // no new checkpoint is signed over a failed run
    expect(await checkpoints()).toHaveLength(1);
  });

  it('catches a signed entry deleted outside a purge', async () => {
    await auditApi(app).recordMany([entry(), entry()]);
    await verify();
    const head = await maxSeq();
    await auditApi(app).record(entry());
    await auditTable(app, 'entries').deleteMany({ seq: head });
    expect(await verify()).toMatchObject({ ok: false, brokenAtSeq: head });
  });
});

describe('categories', () => {
  it('records and filters support, trust, inventory and shipping entries', async () => {
    for (const category of ['support', 'trust', 'inventory', 'shipping'] as const) {
      await auditApi(app).record(entry({ module: category, category, action: `${category}.thing.done` }));
      const res = await app.inject({ method: 'GET', url: `/api/admin/audit/entries?category=${category}`, headers: staff });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().items).toEqual([expect.objectContaining({ category, module: category })]);
    }
    // the GraphQL enum has them too (an unknown enum value would fail the whole query)
    const gql = await app.inject({
      method: 'POST',
      url: '/graphql/admin',
      headers: staff,
      payload: { query: `query($f: AuditFilterInput) { auditEntries(filter: $f, paging: { limit: 5 }) { items { category } } }`, variables: { f: { category: 'SHIPPING' } } },
    });
    expect(gql.json().errors).toBeUndefined();
    expect(gql.json().data.auditEntries.items).toEqual([{ category: 'SHIPPING' }]);
  });
});
