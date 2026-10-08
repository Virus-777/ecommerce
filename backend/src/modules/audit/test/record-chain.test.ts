/**
 * record / recordMany, redaction, roles, the append-only rule and the hash chain (verify-chain).
 * access is stubbed: rolesOf(accountId) answers the staff member's roles.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, buildTestApp, callers } from '../../../testing/app.js';
import { auditApi, entry, staffActor, tamper, waitForEvents } from './helpers.js';

const ROLES = [{ id: newId(), key: 'finance_manager', name: 'Finance Manager' }];
const rolesOf = vi.fn(async (_accountId: string) => ROLES);

let app: FastifyInstance;
const staff = auth(callers.staff());
const get = (url: string) => app.inject({ method: 'GET', url: `/api/admin/audit${url}`, headers: staff });

beforeAll(async () => {
  app = await buildTestApp({ only: ['audit', 'access'], apiStubs: { access: { rolesOf } } });
});
afterAll(async () => {
  await app?.close();
});

describe('record', () => {
  it('appends an entry that reads back complete', async () => {
    const actor = staffActor('Priya Nair');
    const sellerId = newId();
    const orderId = newId();
    const id = await auditApi(app).record(
      entry({
        actor,
        target: { type: 'hold', id: 'hold-1', ref: 'HLD-1', label: 'Casa Verde Home', sellerId, screen: 'admin/payouts' },
        relatedTargets: [{ type: 'order', id: orderId, ref: 'MK-261002-55410' }],
        before: { state: 'held', amount: 124000 },
        after: { state: 'available', amount: 124000 },
        beforeText: 'Held $1,240.00',
        afterText: 'Available $1,240.00',
        evidence: ['UPS proof of delivery'],
        approvalNote: 'Within $2,000 limit',
        requestId: 'req-1',
        ip: '203.0.113.7',
        visibleToSeller: true,
      }),
    );
    const res = await get(`/entries/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    const e = res.json();
    expect(e).toMatchObject({
      id,
      actor: { kind: 'staff', id: actor.id, name: 'Priya Nair' },
      actorRoles: [{ key: 'finance_manager', name: 'Finance Manager' }],
      action: 'finance.hold.released',
      module: 'finance',
      category: 'financial',
      target: { type: 'hold', id: 'hold-1', ref: 'HLD-1', label: 'Casa Verde Home', sellerId, screen: 'admin/payouts' },
      relatedTargets: [{ type: 'order', id: orderId }],
      reason: 'Delivery confirmed',
      change: { before: 'Held $1,240.00', after: 'Available $1,240.00' },
      before: { state: 'held', amount: 124000 },
      after: { state: 'available', amount: 124000 },
      evidence: ['UPS proof of delivery'],
      approval: { state: 'not_required', note: 'Within $2,000 limit', approvers: [], steps: [] },
      requestId: 'req-1',
      ip: '203.0.113.7',
      visibleToSeller: true,
    });
    expect(e.seq).toBeGreaterThan(0);
    expect(rolesOf).toHaveBeenCalledWith(actor.id);
  });

  it('masks redactKeys in before/after at record time; account numbers keep the last 4 digits', async () => {
    const id = await auditApi(app).record(
      entry({
        before: { password: 'hunter2', destination: { accountNumber: '000123456789', bank: 'First Bank' }, accessToken: 'tok_123' },
        after: { nested: [{ clientSecret: 's3cr3t', cardNumber: '4242 4242 4242 4242' }], note: 'kept' },
      }),
    );
    const stored = await sql<{ before: any; after: any }>`select before, after from audit.entries where id = ${id}`.execute(app.kernel.database.kysely);
    const { before, after } = stored.rows[0]!;
    expect(before).toEqual({ password: '[redacted]', destination: { accountNumber: '••••6789', bank: 'First Bank' }, accessToken: '[redacted]' });
    expect(after).toEqual({ nested: [{ clientSecret: '[redacted]', cardNumber: '••••4242' }], note: 'kept' });
    expect(JSON.stringify(stored.rows[0])).not.toMatch(/hunter2|tok_123|s3cr3t|000123456789/);
  });

  it('keeps roles given by the caller and skips access for other actors', async () => {
    rolesOf.mockClear();
    const a = await auditApi(app).record(entry({ actorRoles: [{ key: 'seller_manager', name: 'Seller Manager' }] }));
    const b = await auditApi(app).record(entry({ actor: { kind: 'system' } }));
    expect(rolesOf).not.toHaveBeenCalled();
    expect((await get(`/entries/${a}`)).json().actorRoles).toEqual([{ key: 'seller_manager', name: 'Seller Manager' }]);
    expect((await get(`/entries/${b}`)).json().actorRoles).toEqual([]);
  });

  it('still records when access.rolesOf fails', async () => {
    rolesOf.mockRejectedValueOnce(new Error('access is down'));
    const id = await auditApi(app).record(entry());
    expect((await get(`/entries/${id}`)).json().actorRoles).toEqual([]);
  });

  it('refuses an invalid entry', async () => {
    await expect(auditApi(app).record({ ...entry(), category: 'nope' as never })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(auditApi(app).record({ ...entry(), approvalRequestId: 'not-a-uuid' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('drops an IP address it cannot store instead of failing', async () => {
    const id = await auditApi(app).record(entry({ ip: 'not an ip' }));
    expect((await get(`/entries/${id}`)).json().ip).toBeNull();
  });

  it('recordMany appends in order, linked one to the next, resolving each staff member once', async () => {
    rolesOf.mockClear();
    const actor = staffActor();
    const ids = await auditApi(app).recordMany([entry({ actor }), entry({ actor }), entry({ actor })]);
    expect(ids).toHaveLength(3);
    expect(rolesOf).toHaveBeenCalledTimes(1);
    const rows = await sql<{ id: string; seq: number; prev_hash: Uint8Array; hash: Uint8Array }>`
      select id, seq, prev_hash, hash from audit.entries where id in (${sql.join(ids)}) order by seq`.execute(app.kernel.database.kysely);
    expect(rows.rows.map((r) => r.id)).toEqual(ids);
    expect(Buffer.from(rows.rows[1]!.prev_hash).equals(Buffer.from(rows.rows[0]!.hash))).toBe(true);
    expect(Buffer.from(rows.rows[2]!.prev_hash).equals(Buffer.from(rows.rows[1]!.hash))).toBe(true);
    expect(await auditApi(app).recordMany([])).toEqual([]);
  });

  it('entries cannot be edited or deleted through the database either', async () => {
    const id = await auditApi(app).record(entry());
    const db = app.kernel.database.kysely;
    await expect(sql`update audit.entries set reason = 'changed' where id = ${id}`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit.entries where id = ${id}`.execute(db)).rejects.toThrow(/append-only/);
  });
});

describe('hash chain', () => {
  const verify = async () => {
    await app.kernel.jobs.runNow('audit.verify-chain');
    return (await get('/integrity')).json();
  };

  it('stays one unbroken chain under concurrent appends', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => (i % 5 === 0 ? auditApi(app).recordMany([entry(), entry()]) : auditApi(app).record(entry()))));
    const links = await sql<{ n: number; distinct_prev: number }>`select count(*)::int as n, count(distinct prev_hash)::int as distinct_prev from audit.entries`.execute(app.kernel.database.kysely);
    expect(links.rows[0]!.distinct_prev).toBe(links.rows[0]!.n); // no two entries link to the same head
    const status = await verify();
    expect(status).toMatchObject({ ok: true, brokenAtSeq: null });
    const max = await sql<{ m: number }>`select max(seq)::int as m from audit.entries`.execute(app.kernel.database.kysely);
    expect(status.lastVerifiedSeq).toBe(max.rows[0]!.m);
  });

  it('detects a row altered with raw SQL and publishes audit.integrity.failed', async () => {
    const failed: unknown[] = [];
    app.kernel.events.subscribe('test', 'audit.integrity.failed', (e) => void failed.push(e.payload));
    expect((await verify()).ok).toBe(true);

    // new entries after the last verified one; one of them is then edited
    const ids = await auditApi(app).recordMany([entry(), entry({ reason: 'Original reason' }), entry()]);
    const { rows } = await sql<{ seq: number }>`select seq::int from audit.entries where id = ${ids[1]!}`.execute(app.kernel.database.kysely);
    const seq = rows[0]!.seq;
    await tamper(app, sql`update audit.entries set reason = 'Rewritten reason' where id = ${ids[1]!}`);

    const status = await verify();
    expect(status).toMatchObject({ ok: false, brokenAtSeq: seq });
    expect(status.message).toMatch(/Broken link/);
    await waitForEvents(app);
    expect(failed).toContainEqual(expect.objectContaining({ brokenAtSeq: seq }));

    // the break is reported again on the next run until it is dealt with
    expect((await verify()).ok).toBe(false);

    // putting the original value back restores the chain
    await tamper(app, sql`update audit.entries set reason = 'Original reason' where id = ${ids[1]!}`);
    expect(await verify()).toMatchObject({ ok: true, brokenAtSeq: null });
  });

  it('detects a removed entry (the next entry no longer links to its predecessor)', async () => {
    const ids = await auditApi(app).recordMany([entry(), entry(), entry()]);
    const seqs = await sql<{ seq: number }>`select seq::int from audit.entries where id in (${sql.join(ids)}) order by seq`.execute(app.kernel.database.kysely);
    await tamper(app, sql`delete from audit.entries where id = ${ids[1]!}`);
    const status = await verify();
    expect(status).toMatchObject({ ok: false, brokenAtSeq: seqs.rows[2]!.seq });
  });

  it('detects an edit of an already verified entry from a full re-check (the anchor is recomputed)', async () => {
    // a fresh app on a fresh database: verify everything, then edit the last verified entry
    const other = await buildTestApp({ only: ['audit'] });
    try {
      const api = auditApi(other);
      await api.recordMany([entry(), entry()]);
      await other.kernel.jobs.runNow('audit.verify-chain');
      const head = await sql<{ id: string; seq: number }>`select id, seq::int from audit.entries order by seq desc limit 1`.execute(other.kernel.database.kysely);
      await tamper(other, sql`update audit.entries set action_label = 'Something else' where id = ${head.rows[0]!.id}`);
      await other.kernel.jobs.runNow('audit.verify-chain');
      const res = await other.inject({ method: 'GET', url: '/api/admin/audit/integrity', headers: staff });
      expect(res.json()).toMatchObject({ ok: false, brokenAtSeq: head.rows[0]!.seq });
    } finally {
      await other.close();
    }
  });
});
