/**
 * Pure rules of the backups module: backup ids and file names (the names the server's backup service writes), the
 * next scheduled run, warnings and the API shapes. No I/O.
 */
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { addCalendarDays, HOUR } from '../../../kernel/lib/dates.js';
import type { Backup, BackupOperation } from '../../../spec/backups.js';
import type * as common from '../../../spec/common.js';
import type { BackupOnDisk, OperationRow } from '../ports.js';

/** A backup id: the service's time stamp (YYYY-MM-DD_HHMM, newer ones with seconds), "-uploaded" for an uploaded one */
export const BACKUP_ID = /^\d{4}-\d{2}-\d{2}_\d{4}(\d{2})?(-uploaded)?$/;
/** The two files a backup download may name: the database and the uploaded files (never the settings and keys file) */
export const DOWNLOADABLE_FILE = /^(\d{4}-\d{2}-\d{2}_\d{4}(?:\d{2})?(?:-uploaded)?)\.(archive\.gz|media\.tar\.gz)$/;
/** Every file of a backup in the backup folder */
export const BACKUP_FILE = /^(\d{4}-\d{2}-\d{2}_\d{4}(?:\d{2})?(?:-uploaded)?)\.(archive\.gz|media\.tar\.gz|config\.tar\.gz|manifest\.json)$/;
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const UPLOAD_LABEL_MAX = 120;
export const NOTE_MAX = 200;

export const fileNames = (id: string) => ({
  database: `${id}.archive.gz`,
  files: `${id}.media.tar.gz`,
  config: `${id}.config.tar.gz`,
  manifest: `${id}.manifest.json`,
});

/** Operations the service is busy with or will be: only one at a time */
export const ACTIVE_STATES: readonly OperationRow['state'][] = ['queued', 'running'];
/** A backup or restore still to come or under way (a waiting restore also blocks another restore) */
export const BLOCKING_STATES: readonly OperationRow['state'][] = ['waiting_approval', 'queued', 'running'];

/** The next nightly run at `time` (HH:MM) in the market time zone */
export function nextRunAt(time: string, timeZone: string, now: Date): Date | null {
  if (!TIME.test(time)) return null;
  const today = dateInZone(now, timeZone);
  const t = zonedTimeToUtc(today, time, timeZone);
  return t.getTime() > now.getTime() ? t : zonedTimeToUtc(addCalendarDays(today, 1), time, timeZone);
}

/** What staff should know before relying on the backups */
export function warningsOf(o: { available: boolean; backups: readonly BackupOnDisk[]; now: Date; scheduleApplied: boolean }): string[] {
  if (!o.available) return [];
  const out: string[] = [];
  const last = o.backups[0]?.createdAt;
  if (!last) out.push('There is no backup yet. Back up now, or wait for the nightly backup.');
  else if (o.now.getTime() - last.getTime() > 26 * HOUR) out.push('The last backup is more than a day old: check the nightly backup on the server (sudo marketly check).');
  if (!o.scheduleApplied) out.push('The backup service has not applied the schedule in Settings yet; it does within a minute while the server runs.');
  out.push('Backups are kept on the server’s own disk. Download them, or copy /var/backups/marketly to a USB disk, regularly: a disk failure would take them with the data.');
  return out;
}

/** Newest first */
export const byNewest = (a: { createdAt: Date }, b: { createdAt: Date }) => b.createdAt.getTime() - a.createdAt.getTime();

export function toBackup(b: BackupOnDisk, op: OperationRow | undefined): Backup {
  return {
    id: b.id,
    createdAt: b.createdAt.toISOString(),
    kind: b.kind,
    database: b.database,
    files: b.files,
    hasSettingsAndKeys: b.hasSettingsAndKeys,
    note: op?.note ?? null,
    requestedBy: op ? (op.requested_by as unknown as common.Actor) : null,
  };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toOperation(r: OperationRow, approval?: common.ApprovalInfo | null): BackupOperation {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    backupId: r.backup_id,
    uploadId: r.upload_id,
    safetyBackupId: r.safety_backup_id,
    note: r.note,
    reason: r.reason,
    message: r.message,
    requestedBy: r.requested_by as unknown as common.Actor,
    requestedAt: r.requested_at.toISOString(),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    approval: approval ?? (r.approval_request_id ? { required: true, approvalRequestId: r.approval_request_id, approvers: [] } : null),
  };
}

/** One line for people: what an operation did (audit and the list) */
export function operationLabel(kind: OperationRow['kind']): string {
  return kind === 'backup' ? 'Backup' : kind === 'restore' ? 'Restore' : 'Backup schedule';
}
