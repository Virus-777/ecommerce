import type { FastifyInstance } from 'fastify';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';

// The server's backup service is played here: backups are files in a temp backup folder, and the service's answers
// are status files written into the ops folder (deploy/linux/ops.sh writes the same files on the server).

const ADMIN = '/api/admin/backups/backups';
let app: FastifyInstance;
let root: string;
let dirs: { dir: string; opsDir: string; uploadDir: string };
const clock = movingClock();
const approvals: { action: string; target: { id: string } }[] = [];
const audits: { action: string }[] = [];
const events: { name: string; payload: any }[] = [];

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `${ADMIN}${url}`, headers: { ...auth(callers.staff()), ...headers }, ...(payload !== undefined ? { payload: payload as never } : {}) });

const gz = (text: string) => gzipSync(Buffer.from(text));

async function backup(id: string, o: { kind?: string; operationId?: string; media?: boolean; config?: boolean; at?: Date } = {}) {
  await writeFile(join(dirs.dir, `${id}.archive.gz`), gz(`database ${id}`));
  if (o.media !== false) await writeFile(join(dirs.dir, `${id}.media.tar.gz`), gz(`media ${id}`));
  if (o.config !== false) await writeFile(join(dirs.dir, `${id}.config.tar.gz`), gz(`keys ${id}`));
  if (o.kind) await writeFile(join(dirs.dir, `${id}.manifest.json`), JSON.stringify({ id, kind: o.kind, operationId: o.operationId, createdAt: (o.at ?? clock.now()).toISOString() }));
  if (o.at) await utimes(join(dirs.dir, `${id}.archive.gz`), o.at, o.at);
}

const requestsWritten = async () => (await readdir(join(dirs.opsDir, 'requests')).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
const readRequest = async (id: string) => JSON.parse(await readFile(join(dirs.opsDir, 'requests', `${id}.json`), 'utf8'));
/** The backup service reports on an operation (and removes its request, as ops.sh does) */
async function report(id: string, status: Record<string, unknown>) {
  // like ops.sh: the status file carries the request (and keeps what an earlier status said)
  const before = JSON.parse(await readFile(join(dirs.opsDir, 'status', `${id}.json`), 'utf8').catch(() => '{}'));
  const req = { ...before, ...(await readRequest(id).catch(() => ({}))) };
  await mkdir(join(dirs.opsDir, 'status'), { recursive: true });
  await writeFile(join(dirs.opsDir, 'status', `${id}.json`), JSON.stringify({ ...req, id, ...status }));
  await rm(join(dirs.opsDir, 'requests', `${id}.json`), { force: true });
}
/** The service applied the schedule in Settings (02:30, 14 days) */
const scheduleApplied = () => writeFile(join(dirs.opsDir, 'schedule.json'), JSON.stringify({ time: '02:30', keepDays: 14, timeZone: 'America/Los_Angeles', appliedAt: clock.now().toISOString() }));

beforeAll(async () => {
  // tokens are signed at the app's time: the tests move the clock ahead
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 24 * 3600;
  root = await mkdtemp(join(tmpdir(), 'backups-test-'));
  dirs = { dir: join(root, 'backups'), opsDir: join(root, 'ops'), uploadDir: join(root, 'uploads') };
  await mkdir(dirs.dir, { recursive: true });
  app = await buildTestApp({
    only: ['backups'],
    clock,
    config: { backups: dirs },
    apiStubs: {
      access: {
        check: async (_p: any, action: string) => ({ decision: 'approval_required', action, reason: 'Always needs a second person: Platform Administrator', requiresSecondReviewer: true, approvalsNeeded: 1, eligibleApproverRoles: [], eligibleApprovers: [], stepUpRequired: true }) as any,
        requestApproval: async (input: any) => {
          approvals.push(input);
          return { id: newId(), ref: 'AP-1', target: input.target } as any;
        },
        approvalInfo: async (id: string) => ({ required: true, reason: 'Second person', approvalRequestId: id, approvers: ['Platform Administrator'] }),
        cancelApproval: async () => {},
      },
      identity: {
        verifyReauthToken: async (_p: any, token: string, purpose: string) => token === `dev-reauth.${purpose}`,
        consumeReauthToken: async () => true,
        releaseReauthToken: async () => {},
      },
      audit: { record: async (e: any) => void audits.push(e) },
    } as never,
  });
  app.kernel.events.subscribe('test', 'backups.operation.finished', (e) => void events.push({ name: e.name, payload: e.payload }));
});

afterAll(async () => {
  tokenClock.now = undefined;
  tokenClock.ttlSeconds = 900;
  await app?.close();
  await rm(root, { recursive: true, force: true });
});

/** Each test starts with no operation under way */
async function settle() {
  const overview = (await call('GET', '')).json();
  for (const op of [overview.running, overview.pendingRestore].filter(Boolean)) {
    if (op.state === 'waiting_approval') await call('POST', `/restores/${op.id}/cancel`);
    else await report(op.id, { state: 'done', finishedAt: clock.now().toISOString() });
  }
  await app.kernel.jobs.runNow('backups.watch-operations');
}
beforeEach(async () => {
  await settle();
  approvals.length = 0;
  audits.length = 0;
  events.length = 0;
});

describe('the list of backups', () => {
  it('lists the backups on the server, newest first, with their files; the settings and keys file is only flagged', async () => {
    await backup('2026-10-13_0230', { at: new Date(clock.now().getTime() - 2 * 86_400_000), media: false, config: false });
    await backup('2026-10-14_0230', { kind: 'nightly', at: new Date(clock.now().getTime() - 86_400_000) });
    const res = await call('GET', '');
    expect(res.statusCode, res.body).toBe(200);
    const o = res.json();
    expect(o.available).toBe(true);
    const ids = o.backups.map((b: any) => b.id);
    expect(ids.indexOf('2026-10-14_0230')).toBeLessThan(ids.indexOf('2026-10-13_0230'));
    expect(o.backups.find((b: any) => b.id === '2026-10-14_0230')).toMatchObject({ kind: 'nightly', database: { name: '2026-10-14_0230.archive.gz' }, files: { name: '2026-10-14_0230.media.tar.gz' }, hasSettingsAndKeys: true });
    expect(o.backups.find((b: any) => b.id === '2026-10-13_0230')).toMatchObject({ files: null, hasSettingsAndKeys: false });
    expect(o.schedule).toMatchObject({ time: '02:30', keepDays: 14, timeZone: 'America/Los_Angeles' });
    expect(new Date(o.schedule.nextRunAt).getTime()).toBeGreaterThan(clock.now().getTime());
    expect(o.warnings.some((w: string) => w.includes('USB'))).toBe(true);
  });

  it('asks the backup service to apply the schedule until it has, and then stops asking', async () => {
    await rm(join(dirs.opsDir, 'schedule.json'), { force: true });
    await app.kernel.jobs.runNow('backups.watch-operations');
    const asked = [];
    for (const n of await requestsWritten()) {
      const r = await readRequest(n.replace('.json', ''));
      if (r.kind === 'schedule') asked.push(r);
    }
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: 'schedule', time: '02:30', keepDays: 14, timeZone: 'America/Los_Angeles' });
    await scheduleApplied();
    await report(asked[0].id, { state: 'done', finishedAt: clock.now().toISOString() });
    await app.kernel.jobs.runNow('backups.watch-operations');
    expect((await call('GET', '')).json().schedule.applied).toBe(true);
    const after = [];
    for (const n of await requestsWritten()) if ((await readRequest(n.replace('.json', ''))).kind === 'schedule') after.push(n);
    expect(after).toHaveLength(0);
  });

  it('still asks for the schedule while a backup is running: a backup is not a schedule request', async () => {
    await rm(join(dirs.opsDir, 'schedule.json'), { force: true });
    const started = await call('POST', '', { note: 'While the schedule is unapplied' });
    expect(started.statusCode, started.body).toBe(202);
    await app.kernel.jobs.runNow('backups.watch-operations');
    const kinds: Record<string, string> = {};
    for (const n of await requestsWritten()) {
      const r = await readRequest(n.replace('.json', ''));
      kinds[r.kind] = r.id;
    }
    expect(Object.keys(kinds).sort()).toEqual(['backup', 'schedule']);
    // and the file is left as the other tests expect it: the backup finished, the schedule applied
    await report(kinds.backup!, { state: 'done', backupId: 'bk-sched', finishedAt: clock.now().toISOString() });
    await scheduleApplied();
    await report(kinds.schedule!, { state: 'done', finishedAt: clock.now().toISOString() });
    await app.kernel.jobs.runNow('backups.watch-operations');
  });
});

describe('back up now', () => {
  it('hands a backup to the service, one at a time, and follows it to done', async () => {
    await scheduleApplied();
    const res = await call('POST', '', { note: 'Before the price update' });
    expect(res.statusCode, res.body).toBe(202);
    const op = res.json();
    expect(op).toMatchObject({ kind: 'backup', state: 'queued', note: 'Before the price update' });
    expect(await readRequest(op.id)).toMatchObject({ version: 1, id: op.id, kind: 'backup', note: 'Before the price update' });
    expect(audits.map((a) => a.action)).toContain('backups.backup.start');

    const again = await call('POST', '', {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'OPERATION_IN_PROGRESS', details: { operationId: op.id } });

    await report(op.id, { state: 'running', startedAt: clock.now().toISOString() });
    expect((await call('GET', `/operations/${op.id}`)).json().state).toBe('running');
    await backup('2026-10-15_101500', { kind: 'manual', operationId: op.id });
    await report(op.id, { state: 'done', startedAt: clock.now().toISOString(), finishedAt: clock.now().toISOString(), resultBackupId: '2026-10-15_101500' });
    await app.kernel.jobs.runNow('backups.watch-operations');
    await app.kernel.events.drain();
    expect((await call('GET', `/operations/${op.id}`)).json()).toMatchObject({ state: 'done', backupId: '2026-10-15_101500' });
    expect(events).toEqual([{ name: 'backups.operation.finished', payload: expect.objectContaining({ operationId: op.id, kind: 'backup', state: 'done', backupId: '2026-10-15_101500' }) }]);
    const listed = (await call('GET', '')).json().backups.find((b: any) => b.id === '2026-10-15_101500');
    expect(listed).toMatchObject({ kind: 'manual', note: 'Before the price update' });
  });

  it('fails a request the service never picks up, so the next backup is not blocked', async () => {
    const op = (await call('POST', '', {})).json();
    clock.advance(16 * 60_000);
    await app.kernel.jobs.runNow('backups.watch-operations');
    expect((await call('GET', `/operations/${op.id}`)).json()).toMatchObject({ state: 'failed', message: expect.stringContaining('did not pick up') });
    expect((await call('POST', '', {})).statusCode).toBe(202);
  });
});

describe('downloads', () => {
  it('gives 15-minute links to the database and uploaded files after the password, and serves them (ranges too)', async () => {
    await backup('2026-10-16_0230', { kind: 'nightly' });
    expect((await call('POST', '/2026-10-16_0230/download-links', {})).statusCode).toBe(403); // no password: STEP_UP_REQUIRED
    const res = await call('POST', '/2026-10-16_0230/download-links', { reauthToken: 'dev-reauth.backup-download' });
    expect(res.statusCode, res.body).toBe(200);
    const links = res.json();
    expect(links.database).toMatchObject({ fileName: 'marketly-2026-10-16_0230.archive.gz' });
    expect(links.files).toMatchObject({ fileName: 'marketly-2026-10-16_0230.media.tar.gz' });
    expect(new Date(links.database.expiresAt).getTime() - clock.now().getTime()).toBeLessThanOrEqual(15 * 60_000);
    expect(audits.map((a) => a.action)).toContain('backups.backup.download');

    const path = new URL(links.database.url).pathname + new URL(links.database.url).search;
    const file = await app.inject({ method: 'GET', url: path });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toContain('marketly-2026-10-16_0230.archive.gz');
    expect(file.rawPayload.equals(gz('database 2026-10-16_0230'))).toBe(true);
    const part = await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=0-1' } });
    expect(part.statusCode).toBe(206);
    expect([...part.rawPayload]).toEqual([0x1f, 0x8b]);
  });

  it('never serves the settings and keys file, and refuses an unknown backup', async () => {
    const forged = await app.inject({ method: 'GET', url: '/files/backups/2026-10-16_0230.config.tar.gz?sig=forged' });
    expect(forged.statusCode).toBe(401);
    expect((await call('POST', '/2026-01-01_0000/download-links', { reauthToken: 'dev-reauth.backup-download' })).statusCode).toBe(404);
    expect((await call('POST', '/..%2F..%2Fetc/download-links', { reauthToken: 'dev-reauth.backup-download' })).statusCode).toBe(404);
  });
});

describe('uploads', () => {
  it('receives a gzip database file and becomes ready; anything else is not a backup', async () => {
    const created = await call('POST', '/uploads', { label: 'Copy from the USB disk' });
    expect(created.statusCode, created.body).toBe(201);
    const up = created.json();
    expect(up).toMatchObject({ state: 'receiving', database: null });
    const bad = await call('PUT', `/uploads/${up.id}/database`, Buffer.from('not a backup'), { 'content-type': 'application/octet-stream' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('NOT_A_BACKUP');
    const ok = await call('PUT', `/uploads/${up.id}/database`, gz('database upload'), { 'content-type': 'application/octet-stream' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'ready', database: { sizeBytes: gz('database upload').length } });
    expect(await readFile(join(dirs.uploadDir, up.id, 'database.archive.gz'))).toEqual(gz('database upload'));
    const del = await call('DELETE', `/uploads/${up.id}`);
    expect(del.statusCode).toBe(204);
    expect((await readdir(dirs.uploadDir)).includes(up.id)).toBe(false);
  });
});

describe('restores', () => {
  it('needs the password, RESTORE and a reason, then waits for a second person', async () => {
    await backup('2026-10-17_0230', { kind: 'nightly' });
    const body = { backupId: '2026-10-17_0230', confirm: 'RESTORE', reason: 'The disk was corrupted' };
    expect((await call('POST', '/restores', { ...body, reauthToken: 'wrong' })).statusCode).toBe(403);
    const typo = await call('POST', '/restores', { ...body, confirm: 'restore', reauthToken: 'dev-reauth.backup-restore' });
    expect(typo.statusCode).toBe(400);
    const res = await call('POST', '/restores', { ...body, reauthToken: 'dev-reauth.backup-restore' });
    expect(res.statusCode, res.body).toBe(202);
    const op = res.json();
    expect(op).toMatchObject({ kind: 'restore', state: 'waiting_approval', backupId: '2026-10-17_0230', approval: { required: true, approvers: ['Platform Administrator'] } });
    expect(approvals).toEqual([expect.objectContaining({ action: 'backups.restore', target: expect.objectContaining({ type: 'backup_restore', id: op.id }) })]);
    expect(await requestsWritten()).not.toContain(`${op.id}.json`); // nothing reaches the service before the approval
    // one restore at a time (a backup meanwhile is fine)
    expect((await call('POST', '/restores', { ...body, reauthToken: 'dev-reauth.backup-restore' })).json().error?.code).toBe('OPERATION_IN_PROGRESS');
    expect((await call('GET', '')).json().pendingRestore).toMatchObject({ id: op.id });

    // approved: the request goes to the backup service
    const decided = (outcome: string) => ({ requestId: op.approval.approvalRequestId, ref: 'AP-1', actionKey: 'backups.restore', module: 'backups', target: { type: 'backup_restore', id: op.id }, outcome, decidedBy: { kind: 'staff', id: newId(), name: 'Pat Admin' }, approverIds: [], requestedById: newId() });
    app.kernel.events.publish('access', 'access.approval.decided', decided('approved'));
    await app.kernel.events.drain();
    expect((await call('GET', `/operations/${op.id}`)).json().state).toBe('queued');
    expect(await readRequest(op.id)).toMatchObject({ kind: 'restore', backupId: '2026-10-17_0230', reason: 'The disk was corrupted' });
    // a redelivered decision changes nothing
    app.kernel.events.publish('access', 'access.approval.decided', decided('approved'));
    await app.kernel.events.drain();
    expect((await call('GET', `/operations/${op.id}`)).json().state).toBe('queued');
  });

  it('closes a refused restore, and lets the requester withdraw one still waiting', async () => {
    await backup('2026-10-18_0230', { kind: 'nightly' });
    const ask = () => call('POST', '/restores', { backupId: '2026-10-18_0230', confirm: 'RESTORE', reason: 'Test', reauthToken: 'dev-reauth.backup-restore' });
    const a = (await ask()).json();
    app.kernel.events.publish('access', 'access.approval.decided', { requestId: a.approval.approvalRequestId, ref: 'AP-2', actionKey: 'backups.restore', module: 'backups', target: { type: 'backup_restore', id: a.id }, outcome: 'rejected', reason: 'Not needed', approverIds: [], requestedById: newId() });
    await app.kernel.events.drain();
    expect((await call('GET', `/operations/${a.id}`)).json()).toMatchObject({ state: 'rejected', message: 'Not needed' });
    const b = (await ask()).json();
    const cancelled = await call('POST', `/restores/${b.id}/cancel`);
    expect(cancelled.json().state).toBe('cancelled');
    expect((await call('POST', `/restores/${b.id}/cancel`)).statusCode).toBe(409);
  });

  it('keeps the restore on the list after the database was replaced by the backup', async () => {
    // the restored database knows nothing of this restore: its status file brings it back
    const id = newId();
    await mkdir(join(dirs.opsDir, 'status'), { recursive: true });
    await writeFile(
      join(dirs.opsDir, 'status', `${id}.json`),
      JSON.stringify({ version: 1, id, kind: 'restore', requestedAt: clock.now().toISOString(), requestedBy: { kind: 'staff', id: newId(), name: 'Owen Owner' }, reason: 'Disk failure', backupId: '2026-10-17_0230', state: 'done', startedAt: clock.now().toISOString(), finishedAt: clock.now().toISOString(), safetyBackupId: '2026-10-19_0900' }),
    );
    await app.kernel.jobs.runNow('backups.watch-operations');
    expect((await call('GET', `/operations/${id}`)).json()).toMatchObject({ kind: 'restore', state: 'done', backupId: '2026-10-17_0230', safetyBackupId: '2026-10-19_0900', reason: 'Disk failure', requestedBy: { name: 'Owen Owner' } });
  });
});
