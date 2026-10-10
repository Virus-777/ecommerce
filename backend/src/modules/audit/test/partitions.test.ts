/**
 * Monthly partitions (pass 5): the 0004 migration moves an unpartitioned history into UTC month partitions
 * with the chain intact; audit.prepare-partitions keeps market months ready ahead; the purge drops whole
 * months (checkpoint first) and deletes row by row only in a month partly past the cut-off; the append-only
 * protection covers the partitions, and a month dropped behind the app's back breaks the chain.
 */
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../../kernel/db/index.js';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { migrate } from '../../../kernel/migrations/index.js';
import { auth, buildTestApp, callers, tokenClock } from '../../../testing/app.js';
import { GENESIS_HASH, hashRow, type ChainRow } from '../domain/chain.js';
import { migrations } from '../infra/postgres/migrations/index.js';
import { auditApi, entry, tamper } from './helpers.js';

const staff = () => auth(callers.staff());
const get = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url: `/api/admin/audit${url}`, headers: staff() });
const verify = async (app: FastifyInstance) => {
  await app.kernel.jobs.runNow('audit.verify-chain');
  return (await get(app, '/integrity')).json();
};
const partitionNames = async (db: Kysely<any>) => (await sql<{ name: string }>`select name from audit.entry_partitions order by from_at`.execute(db)).rows.map((r) => r.name);
const tablesIn = async (db: Kysely<any>, prefix: string) =>
  (await sql<{ t: string }>`select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'audit_partitions' and c.relkind = 'r' and c.relname like ${`${prefix}%`} order by 1`.execute(db)).rows.map((r) => r.t);
const partitionOf = async (db: Kysely<any>, id: string) =>
  (await sql<{ p: string }>`select tableoid::regclass::text as p from audit.entries where id = ${id}`.execute(db)).rows[0]?.p;

/** Writes a valid chain straight into the pre-partitioning tables (0001–0003), as an older install holds it. */
async function writeLegacyChain(db: Kysely<any>, rows: { at: string; relatedTargets?: { type: string; id: string }[] }[]): Promise<string[]> {
  let prev = GENESIS_HASH;
  const ids: string[] = [];
  for (const r of rows) {
    const row: Omit<ChainRow, 'hash' | 'prevHash' | 'seq'> = {
      id: newId(),
      at: new Date(r.at),
      actorKind: 'staff',
      actorId: newId(),
      actorName: 'Priya Nair',
      actorRoles: [],
      action: 'finance.hold.released',
      actionLabel: 'Released payout hold',
      module: 'finance',
      category: 'financial',
      targetType: 'hold',
      targetId: newId(),
      targetRef: null,
      targetLabel: null,
      targetScreen: null,
      sellerId: null,
      reason: `Legacy entry at ${r.at}`,
      before: null,
      after: null,
      beforeText: null,
      afterText: null,
      evidence: [],
      approvalRequestId: null,
      approvalNote: null,
      requestId: null,
      ip: null,
      visibleToSeller: false,
      relatedTargets: r.relatedTargets ?? [],
    };
    const hash = hashRow(prev, row);
    await sql`
      insert into audit.entries (id, at, actor_kind, actor_id, actor_name, actor_roles, action, action_label, module, category, target_type, target_id,
        reason, evidence, visible_to_seller, search, prev_hash, hash)
      values (${row.id}, ${row.at}, ${row.actorKind}, ${row.actorId}, ${row.actorName}, '[]'::jsonb, ${row.action}, ${row.actionLabel}, ${row.module}, ${row.category},
        ${row.targetType}, ${row.targetId}, ${row.reason}, '[]'::jsonb, false, to_tsvector('simple', ${row.reason}), ${prev}, ${hash})`.execute(db);
    for (const t of row.relatedTargets) await sql`insert into audit.entry_targets (entry_id, target_type, target_id, at) values (${row.id}, ${t.type}, ${t.id}, ${row.at})`.execute(db);
    prev = hash;
    ids.push(row.id);
  }
  return ids;
}

describe('the partitioning migration on a history with rows in several months', () => {
  const clock = fixedClock('2026-03-15T12:00:00Z');
  let database: Database;
  let app: FastifyInstance;
  const db = () => app.kernel.database.kysely;
  const seller = newId();
  let ids: string[] = [];

  beforeAll(async () => {
    tokenClock.now = () => clock.now();
    tokenClock.ttlSeconds = 20 * 365 * 86_400;
    database = await createDatabase();
    await migrate(database, [{ module: 'audit', schema: 'audit', migrations: migrations.filter((m) => m.id < '0004') }]);
    ids = await writeLegacyChain(database.kysely, [
      { at: '2025-11-15T12:00:00Z', relatedTargets: [{ type: 'seller', id: seller }] },
      { at: '2025-12-31T23:30:00Z' }, // December in UTC (and in Los Angeles)
      { at: '2026-01-01T03:00:00Z' }, // January in UTC, still December 31 in Los Angeles
      { at: '2026-01-10T12:00:00Z' },
      { at: '2026-03-01T03:00:00Z' }, // March in UTC, February 28 in Los Angeles
    ]);
    // a sequence value used and lost (a rolled-back append): the identity must carry on after it
    await sql`select nextval('audit.entries_seq_seq')`.execute(database.kysely);
    app = await buildTestApp({ only: ['audit'], clock, database });
  });
  afterAll(async () => {
    tokenClock.now = undefined;
    tokenClock.ttlSeconds = 900;
    await app?.close();
    await database?.close();
  });

  it('turns entries and entry_targets into tables partitioned by month, one UTC month per month with rows', async () => {
    const kinds = (await sql<{ relname: string; relkind: string }>`
      select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'audit' and c.relname in ('entries', 'entry_targets') order by 1`.execute(db())).rows;
    expect(kinds).toEqual([
      { relname: 'entries', relkind: 'p' },
      { relname: 'entry_targets', relkind: 'p' },
    ]);
    expect(await partitionNames(db())).toEqual(['20251101_0000', '20251201_0000', '20260101_0000', '20260301_0000']);
    expect(await tablesIn(db(), 'entries_')).toEqual(['entries_20251101_0000', 'entries_20251201_0000', 'entries_20260101_0000', 'entries_20260301_0000']);
    expect(await tablesIn(db(), 'entry_targets_')).toHaveLength(4);
    expect(await partitionOf(db(), ids[0]!)).toBe('audit_partitions.entries_20251101_0000');
    expect(await partitionOf(db(), ids[2]!)).toBe('audit_partitions.entries_20260101_0000');
    const targets = (await sql<{ p: string; entry_id: string }>`select tableoid::regclass::text as p, entry_id from audit.entry_targets`.execute(db())).rows;
    expect(targets).toEqual([{ p: 'audit_partitions.entry_targets_20251101_0000', entry_id: ids[0] }]);
    // the same rows and sequence numbers; the old tables are gone
    const rows = (await sql<{ id: string; seq: number }>`select id, seq::int from audit.entries order by seq`.execute(db())).rows;
    expect(rows).toEqual(ids.map((id, i) => ({ id, seq: i + 1 })));
    expect((await sql`select 1 from pg_class where relname like '%unpartitioned%'`.execute(db())).rows).toHaveLength(0);
  });

  it('keeps the chain verifiable and the queries working across partitions', async () => {
    expect(await verify(app)).toMatchObject({ ok: true, brokenAtSeq: null, lastVerifiedSeq: 5 });
    const list = (await get(app, '/entries?limit=10')).json();
    expect(list.items.map((e: { id: string }) => e.id)).toEqual([...ids].reverse());
    const related = (await get(app, `/targets/seller/${seller}`)).json();
    expect(related.items.map((e: { id: string }) => e.id)).toEqual([ids[0]]);
    const range = (await get(app, '/entries?from=2025-12-01T00:00:00Z&to=2026-01-31T00:00:00Z')).json();
    expect(range.items).toHaveLength(3);
  });

  it('new entries continue the identity and the chain', async () => {
    const id = await auditApi(app).record(entry());
    const seq = (await sql<{ seq: number }>`select seq::int from audit.entries where id = ${id}`.execute(db())).rows[0]!.seq;
    expect(seq).toBe(7); // 6 was used before the migration
    expect(await partitionOf(db(), id)).toBe('audit_partitions.entries_20260301_0000');
    expect(await verify(app)).toMatchObject({ ok: true, lastVerifiedSeq: 7 });
  });

  it('audit.prepare-partitions fills the market months ahead next to the UTC months, once', async () => {
    await app.kernel.jobs.runNow('audit.prepare-partitions');
    // Los Angeles months from March to June 2026; March is already covered by the UTC month up to April 1 00:00 UTC
    expect(await partitionNames(db())).toEqual([
      '20251101_0000',
      '20251201_0000',
      '20260101_0000',
      '20260301_0000',
      '20260401_0000', // the rest of March in Los Angeles (until April 1 07:00 UTC)
      '20260401_0700',
      '20260501_0700',
      '20260601_0700',
    ]);
    const bounds = (await sql<{ from_at: Date; to_at: Date }>`select from_at, to_at from audit.entry_partitions where name = '20260401_0700'`.execute(db())).rows[0]!;
    expect([bounds.from_at.toISOString(), bounds.to_at.toISOString()]).toEqual(['2026-04-01T07:00:00.000Z', '2026-05-01T07:00:00.000Z']);
    await app.kernel.jobs.runNow('audit.prepare-partitions');
    expect(await partitionNames(db())).toHaveLength(8);

    // a month later the next month is created ahead
    clock.set('2026-04-15T12:00:00Z');
    await app.kernel.jobs.runNow('audit.prepare-partitions');
    expect((await partitionNames(db())).at(-1)).toBe('20260701_0700');
    expect(await tablesIn(db(), 'entry_targets_20260701_0700')).toEqual(['entry_targets_20260701_0700']);
  });

  it('the purge writes its checkpoint, drops the months entirely past the cut-off and deletes the rest row by row', async () => {
    // 7 years on: the cut-off is 2026-01-01 00:00 in Los Angeles (08:00 UTC)
    clock.set('2033-01-15T12:00:00Z');
    await app.kernel.jobs.runNow('audit.purge-expired');

    expect(await partitionNames(db())).not.toContain('20251101_0000');
    expect(await partitionNames(db())).not.toContain('20251201_0000');
    expect(await tablesIn(db(), 'entries_2025')).toEqual([]);
    expect(await tablesIn(db(), 'entry_targets_2025')).toEqual([]);
    // January (UTC) also held the entry of January 1 03:00 UTC, before the cut-off: deleted row by row, the month stays
    expect(await partitionNames(db())).toContain('20260101_0000');
    const left = (await sql<{ id: string }>`select id from audit.entries order by seq`.execute(db())).rows.map((r) => r.id);
    expect(left.slice(0, 2)).toEqual([ids[3], ids[4]]);

    const purge = (await get(app, '/entries?action=audit.retention.purged')).json().items[0];
    expect(purge.after).toMatchObject({ removedEntries: 3, droppedPartitions: 2, removedThrough: '2026-01-01T08:00:00.000Z', checkpoint: { seq: 3 } });
    const cp = (await sql<{ seq: number; kind: string }>`select seq::int, kind from audit.checkpoints where kind = 'purge'`.execute(db())).rows;
    expect(cp).toEqual([{ seq: 3, kind: 'purge' }]);
    // the purge entry lands in the month of its time, created on demand
    expect(await partitionOf(db(), purge.id)).toBe('audit_partitions.entries_20330101_0800');
  });

  it('the chain still verifies from the checkpoint, and a later rewrite is caught', async () => {
    expect(await verify(app)).toMatchObject({ ok: true, brokenAtSeq: null });
    const head = (await sql<{ id: string; seq: number }>`select id, seq::int from audit.entries order by seq desc limit 1`.execute(db())).rows[0]!;
    await tamper(app, sql`update audit.entries set reason = 'Rewritten' where id = ${head.id}`);
    expect(await verify(app)).toMatchObject({ ok: false, brokenAtSeq: head.seq });
  });
});

describe('a purge when every entry is past the cut-off', () => {
  const clock = fixedClock('2026-10-09T12:00:00Z');
  let app: FastifyInstance;
  beforeAll(async () => {
    tokenClock.now = () => clock.now();
    app = await buildTestApp({ only: ['audit'], clock });
  });
  afterAll(async () => {
    tokenClock.now = undefined;
    await app?.close();
  });

  it('drops every old month and keeps only the purge entry, still verifiable', async () => {
    const db = app.kernel.database.kysely;
    await auditApi(app).record(entry({ at: '2018-02-10T12:00:00Z' }));
    await auditApi(app).record(entry({ at: '2018-05-10T12:00:00Z' }));
    expect(await partitionNames(db)).toEqual(['20180201_0800', '20180501_0700']);
    await app.kernel.jobs.runNow('audit.purge-expired');
    expect(await tablesIn(db, 'entries_2018')).toEqual([]);
    const purge = (await get(app, '/entries')).json().items;
    expect(purge).toEqual([expect.objectContaining({ action: 'audit.retention.purged', after: expect.objectContaining({ removedEntries: 2, droppedPartitions: 2, checkpoint: expect.objectContaining({ seq: 2 }) }) })]);
    expect(await verify(app)).toMatchObject({ ok: true });
  });
});

describe('append-only protection of the partitions', () => {
  const clock = fixedClock('2026-10-09T12:00:00Z');
  let app: FastifyInstance;
  const db = () => app.kernel.database.kysely;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    tokenClock.now = () => clock.now();
    app = await buildTestApp({ only: ['audit'], clock });
    const api = auditApi(app);
    ids.jan = await api.record(entry({ at: '2026-01-15T12:00:00Z', relatedTargets: [{ type: 'seller', id: newId() }] }));
    ids.mar = await api.record(entry({ at: '2026-03-15T12:00:00Z' }));
    ids.now = await api.record(entry());
  });
  afterEach(async () => {
    tokenClock.now = undefined;
    await app?.close();
  });

  it('records create the market month of a backdated entry on demand', async () => {
    expect(await partitionNames(db())).toEqual(['20260101_0800', '20260301_0800', '20261001_0700']);
    expect(await partitionOf(db(), ids.jan!)).toBe('audit_partitions.entries_20260101_0800');
  });

  it('refuses UPDATE, DELETE, TRUNCATE and DROP of a partition outside a purge', async () => {
    const part = sql.id('audit_partitions', 'entries_20260301_0800');
    await expect(sql`update ${part} set reason = 'x'`.execute(db())).rejects.toThrow(/append-only/);
    await expect(sql`delete from ${part}`.execute(db())).rejects.toThrow(/append-only/);
    await expect(sql`truncate ${part}`.execute(db())).rejects.toThrow(/append-only/);
    await expect(sql`drop table ${part}`.execute(db())).rejects.toThrow(/append-only/);
    await expect(sql`truncate audit.entries`.execute(db())).rejects.toThrow(/append-only/);
    expect(await partitionOf(db(), ids.mar!)).toBe('audit_partitions.entries_20260301_0800');
  });

  it('a month dropped behind the app’s back breaks the chain', async () => {
    expect(await verify(app)).toMatchObject({ ok: true });
    await db().transaction().execute(async (trx) => {
      await sql`select set_config('audit.purging', 'on', true)`.execute(trx);
      await sql`drop table audit_partitions.entry_targets_20260301_0800`.execute(trx);
      await sql`drop table audit_partitions.entries_20260301_0800`.execute(trx);
    });
    // a fresh walk from the start (the last verified checkpoint would only cover what follows it)
    await tamper(app, sql`delete from audit.integrity_checks`);
    await tamper(app, sql`delete from audit.checkpoints`);
    const seqNow = (await sql<{ seq: number }>`select seq::int from audit.entries where id = ${ids.now!}`.execute(db())).rows[0]!.seq;
    expect(await verify(app)).toMatchObject({ ok: false, brokenAtSeq: seqNow });
  });
});
