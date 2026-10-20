#!/usr/bin/env node
// JSON for the backup service (ops.sh), so the shell never parses or writes JSON itself. Plain Node, no packages.
//
//   node ops-request.mjs parse <request.json>
//       Checks a request the web process wrote (untrusted: every field is matched against a strict pattern) and
//       prints it as shell assignments for eval: OP_ID, OP_KIND, OP_BACKUP_ID, OP_UPLOAD_ID, OP_TIME, OP_KEEP_DAYS,
//       OP_TZ. Exit 2 and OP_ERROR when it is not a valid request (OP_ID still set when the id is valid).
//   node ops-request.mjs status <status dir> <id> <queued|running|done|failed> [--request <file>] [--message <text>]
//       [--result <backup id>] [--safety <backup id>]
//       Writes <status dir>/<id>.json: the request (first time) plus state, times and what happened.
//   node ops-request.mjs manifest <backup dir> <backup id> <nightly|manual|safety|uploaded> [operation id]
//   node ops-request.mjs schedule <ops dir> <HH:MM> <days> <time zone>
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BACKUP_ID = /^\d{4}-\d{2}-\d{2}_\d{4}(\d{2})?(-uploaded)?$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const KINDS = ['backup', 'restore', 'schedule'];
const STATES = ['queued', 'running', 'done', 'failed'];
const MANIFEST_KINDS = ['nightly', 'manual', 'safety', 'uploaded'];

const isTimeZone = (tz) => {
  if (typeof tz !== 'string' || !(tz.includes('/') || tz === 'UTC') || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
/** Written aside, then renamed: readers never see half a file */
const writeJson = (file, value, mode = 0o640) => {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tmp, file);
};
const shell = (vars) => Object.entries(vars).map(([k, v]) => `${k}='${String(v ?? '')}'`).join('\n');
const fail = (msg) => {
  process.stderr.write(`ops-request: ${msg}\n`);
  process.exit(1);
};

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'parse') {
  const r = readJson(args[0]);
  const id = r && typeof r.id === 'string' && UUID.test(r.id) ? r.id : '';
  const bad = (why) => {
    console.log(shell({ OP_ID: id, OP_ERROR: why }));
    process.exit(2);
  };
  if (!r || typeof r !== 'object') bad('the request is not JSON');
  if (!id) bad('the request has no valid id');
  if (r.version !== 1) bad('unknown request version');
  if (!KINDS.includes(r.kind)) bad('unknown request kind');
  const out = { OP_ID: id, OP_KIND: r.kind, OP_BACKUP_ID: '', OP_UPLOAD_ID: '', OP_TIME: '', OP_KEEP_DAYS: '', OP_TZ: '' };
  if (r.kind === 'restore') {
    const hasBackup = typeof r.backupId === 'string' && r.backupId !== '';
    const hasUpload = typeof r.uploadId === 'string' && r.uploadId !== '';
    if (hasBackup === hasUpload) bad('a restore names one backup or one upload');
    if (hasBackup && !BACKUP_ID.test(r.backupId)) bad('the backup id is not valid');
    if (hasUpload && !UUID.test(r.uploadId)) bad('the upload id is not valid');
    out.OP_BACKUP_ID = hasBackup ? r.backupId : '';
    out.OP_UPLOAD_ID = hasUpload ? r.uploadId : '';
  }
  if (r.kind === 'schedule') {
    if (typeof r.time !== 'string' || !TIME.test(r.time)) bad('the time is not HH:MM');
    if (!Number.isInteger(r.keepDays) || r.keepDays < 3 || r.keepDays > 365) bad('days kept must be 3 to 365');
    if (!isTimeZone(r.timeZone)) bad('the time zone is not valid');
    out.OP_TIME = r.time;
    out.OP_KEEP_DAYS = r.keepDays;
    out.OP_TZ = r.timeZone;
  }
  console.log(shell(out));
} else if (cmd === 'status') {
  const [dir, id, state, ...rest] = args;
  if (!dir || !UUID.test(id ?? '') || !STATES.includes(state)) fail('usage: status <dir> <id> <state> [options]');
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
  const file = join(dir, `${id}.json`);
  const before = readJson(file) ?? (opt.request ? readJson(opt.request) : null) ?? { version: 1, id };
  // only what the request said is carried over; ids and texts from the request are re-checked
  const base = {
    version: 1,
    id,
    kind: KINDS.includes(before.kind) ? before.kind : undefined,
    requestedAt: typeof before.requestedAt === 'string' ? before.requestedAt : undefined,
    requestedBy: before.requestedBy && typeof before.requestedBy === 'object' ? { kind: String(before.requestedBy.kind ?? ''), id: before.requestedBy.id ?? null, name: before.requestedBy.name ?? null } : undefined,
    note: typeof before.note === 'string' ? before.note.slice(0, 200) : null,
    reason: typeof before.reason === 'string' ? before.reason.slice(0, 2000) : null,
    backupId: typeof before.backupId === 'string' && BACKUP_ID.test(before.backupId) ? before.backupId : null,
    uploadId: typeof before.uploadId === 'string' && UUID.test(before.uploadId) ? before.uploadId : null,
    time: before.time,
    keepDays: before.keepDays,
    timeZone: before.timeZone,
    startedAt: before.startedAt ?? null,
    finishedAt: before.finishedAt ?? null,
    message: before.message ?? null,
    resultBackupId: before.resultBackupId ?? null,
    safetyBackupId: before.safetyBackupId ?? null,
  };
  const now = new Date().toISOString();
  const next = { ...base, state };
  if (state === 'running' && !next.startedAt) next.startedAt = now;
  if (state === 'done' || state === 'failed') next.finishedAt = now;
  if (opt.message !== undefined) next.message = String(opt.message).slice(0, 500);
  if (opt.result && BACKUP_ID.test(opt.result)) next.resultBackupId = opt.result;
  if (opt.safety && BACKUP_ID.test(opt.safety)) next.safetyBackupId = opt.safety;
  writeJson(file, next);
} else if (cmd === 'manifest') {
  const [dir, id, kind, operationId] = args;
  if (!dir || !BACKUP_ID.test(id ?? '') || !MANIFEST_KINDS.includes(kind)) fail('usage: manifest <dir> <id> <kind> [operation id]');
  writeJson(join(dir, `${id}.manifest.json`), { version: 1, id, kind, createdAt: new Date().toISOString(), operationId: operationId && UUID.test(operationId) ? operationId : null });
} else if (cmd === 'schedule') {
  const [dir, time, days, tz] = args;
  if (!dir || !TIME.test(time ?? '') || !/^\d{1,3}$/.test(days ?? '') || !isTimeZone(tz)) fail('usage: schedule <dir> <HH:MM> <days> <time zone>');
  writeJson(join(dir, 'schedule.json'), { time, keepDays: Number(days), timeZone: tz, appliedAt: new Date().toISOString() });
} else {
  fail('usage: parse | status | manifest | schedule (see the top of this file)');
}
