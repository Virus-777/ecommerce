/**
 * record / recordMany, redaction, roles, the append-only rule and the hash chain (verify-chain).
 * access is stubbed: rolesOf(accountId) answers the staff member's roles.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, buildTestApp, callers } from '../../../testing/app.js';
import { normalizeIp } from '../infra/mongo/text.js';
import { auditApi, auditTable, entry, staffActor, waitForEvents } from './helpers.js';

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
    const stored = (await auditTable(app, 'entries').findOne({ id }))!;
    const { before, after } = stored;
    expect(before).toEqual({ password: '[redacted]', destination: { accountNumber: '••••6789', bank: 'First Bank' }, accessToken: '[redacted]' });
    expect(after).toEqual({ nested: [{ clientSecret: '[redacted]', cardNumber: '••••4242' }], note: 'kept' });
    expect(JSON.stringify(stored)).not.toMatch(/hunter2|tok_123|s3cr3t|000123456789/);
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
    const rows = await auditTable(app, 'entries').find({ id: { $in: ids } }, { sort: { seq: 1 } });
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(Buffer.from(rows[1]!.prev_hash).equals(Buffer.from(rows[0]!.hash))).toBe(true);
    expect(Buffer.from(rows[2]!.prev_hash).equals(Buffer.from(rows[1]!.hash))).toBe(true);
    expect(await auditApi(app).recordMany([])).toEqual([]);
  });

  it('stores IP addresses in the text form PostgreSQL gave them (inet), so the hash recomputes', async () => {
    const id = await auditApi(app).record(entry({ ip: '::FFFF:0102:0304' }));
    expect((await get(`/entries/${id}`)).json().ip).toBe('::ffff:1.2.3.4');
    // host(inet) of each address on PostgreSQL 17
    for (const [ip, host] of [
      ['203.0.113.7', '203.0.113.7'],
      ['::2', '::2'],
      ['::1.2.3.4', '::1.2.3.4'],
      ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
      ['2001:db8::1:0:0:1', '2001:db8::1:0:0:1'],
      ['2001:0:0:1:0:0:0:1', '2001:0:0:1::1'],
      ['fe80::', 'fe80::'],
      ['64:ff9b::1.2.3.4', '64:ff9b::102:304'],
      ['::', '::'],
      ['0:0:0:0:0:1:0:0', '::1:0:0'],
      ['::0.0.0.1', '::1'],
      ['::ffff:0:0', '::ffff:0.0.0.0'],
      ['0:0:0:0:0:ffff:0:1', '::ffff:0.0.0.1'],
    ]) expect(normalizeIp(ip!)).toBe(host);
  });

  it('stores before/after as JSON would (undefined members dropped, dates as text), so the chain verifies', async () => {
    const id = await auditApi(app).record(entry({ before: { gone: undefined, kept: 1, at: new Date('2026-01-02T03:04:05Z') } as never, after: { list: [1, 'two', null] } }));
    expect((await get(`/entries/${id}`)).json()).toMatchObject({ before: { kept: 1, at: '2026-01-02T03:04:05.000Z' }, after: { list: [1, 'two', null] } });
    expect((await get(`/entries/${id}`)).json().before).not.toHaveProperty('gone');
    await app.kernel.jobs.runNow('audit.verify-chain');
    expect((await get('/integrity')).json()).toMatchObject({ ok: true });
  });
});

describe('hash chain', () => {
  const verify = async () => {
    await app.kernel.jobs.runNow('audit.verify-chain');
    return (await get('/integrity')).json();
  };

  it('stays one unbroken chain under concurrent appends', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => (i % 5 === 0 ? auditApi(app).recordMany([entry(), entry()]) : auditApi(app).record(entry()))));
    const all = await auditTable(app, 'entries').find();
    expect(new Set(all.map((r) => Buffer.from(r.prev_hash).toString('hex'))).size).toBe(all.length); // no two entries link to the same head
    const status = await verify();
    expect(status).toMatchObject({ ok: true, brokenAtSeq: null });
    expect(status.lastVerifiedSeq).toBe(Math.max(...all.map((r) => r.seq)));
  });

  it('detects a row altered in the database and publishes audit.integrity.failed', async () => {
    const failed: unknown[] = [];
    app.kernel.events.subscribe('test', 'audit.integrity.failed', (e) => void failed.push(e.payload));
    expect((await verify()).ok).toBe(true);

    // new entries after the last verified one; one of them is then edited
    const ids = await auditApi(app).recordMany([entry(), entry({ reason: 'Original reason' }), entry()]);
    const seq = (await auditTable(app, 'entries').findOne({ id: ids[1]! }))!.seq;
    await auditTable(app, 'entries').updateOne({ id: ids[1]! }, { reason: 'Rewritten reason' });

    const status = await verify();
    expect(status).toMatchObject({ ok: false, brokenAtSeq: seq });
    expect(status.message).toMatch(/Broken link/);
    await waitForEvents(app);
    expect(failed).toContainEqual(expect.objectContaining({ brokenAtSeq: seq }));

    // the break is reported again on the next run until it is dealt with
    expect((await verify()).ok).toBe(false);

    // putting the original value back restores the chain
    await auditTable(app, 'entries').updateOne({ id: ids[1]! }, { reason: 'Original reason' });
    expect(await verify()).toMatchObject({ ok: true, brokenAtSeq: null });
  });

  it('detects a removed entry (the next entry no longer links to its predecessor)', async () => {
    const ids = await auditApi(app).recordMany([entry(), entry(), entry()]);
    const seqs = (await auditTable(app, 'entries').find({ id: { $in: ids } }, { sort: { seq: 1 } })).map((r) => r.seq);
    await auditTable(app, 'entries').deleteMany({ id: ids[1]! });
    const status = await verify();
    expect(status).toMatchObject({ ok: false, brokenAtSeq: seqs[2] });
  });

  it('detects an edit of an already verified entry from a full re-check (the anchor is recomputed)', async () => {
    // a fresh app on a fresh database: verify everything, then edit the last verified entry
    const other = await buildTestApp({ only: ['audit'] });
    try {
      const api = auditApi(other);
      await api.recordMany([entry(), entry()]);
      await other.kernel.jobs.runNow('audit.verify-chain');
      const head = (await auditTable(other, 'entries').findOne({}, { sort: { seq: -1 } }))!;
      await auditTable(other, 'entries').updateOne({ id: head.id }, { action_label: 'Something else' });
      await other.kernel.jobs.runNow('audit.verify-chain');
      const res = await other.inject({ method: 'GET', url: '/api/admin/audit/integrity', headers: staff });
      expect(res.json()).toMatchObject({ ok: false, brokenAtSeq: head.seq });
    } finally {
      await other.close();
    }
  });
});
