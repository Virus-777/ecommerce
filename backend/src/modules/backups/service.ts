import type { Readable } from 'node:stream';
import { SYSTEM_ACTOR } from '../../kernel/auth/index.js';
import { fileLinkSecret, signFileLink } from '../../kernel/auth/file-links.js';
import { AppError, isNotImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { MINUTE } from '../../kernel/lib/dates.js';
import { isUuid, newId } from '../../kernel/lib/ids.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as audit from '../../spec/audit.js';
import type { BackupDownloadLinks, BackupOperation, BackupOverview, BackupsPublicApi, BackupUpload, DownloadLink } from '../../spec/backups.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import { backupOperationMachine } from './domain/state-machines.js';
import { ACTIVE_STATES, BACKUP_ID, BLOCKING_STATES, nextRunAt, NOTE_MAX, operationLabel, toBackup, toOperation, UPLOAD_LABEL_MAX, warningsOf } from './domain/rules.js';
import { UploadTooLarge, type BackupOnDisk, type BackupOps, type OperationRow, type OpsStatus, type UploadRow } from './ports.js';
import type { BackupsRepository } from './repository.js';

export interface BackupsServiceDeps {
  repo: BackupsRepository;
  ctx: ModuleContext<'backups'>;
  ops: BackupOps;
}

/** Who acts: the caller's actor and request id (and principal, where access needs it) */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: identity.Principal | null;
}

/** The bucket of backup downloads in /files links (served by this module from the backup folder) */
export const BACKUPS_BUCKET = 'backups';
const DOWNLOAD_MINUTES = 15;
const RESTORE_ACTION = 'backups.restore';
/** A request the backup service never picked up (the service is not installed, or stopped) */
const UNCLAIMED_MINUTES = 15;
const RECENT = 10;
const KINDS = new Set<string>(['backup', 'restore', 'schedule']);

/**
 * Backups use cases. The work is done by the server's root backup service (deploy/linux/ops.sh); this service asks
 * it through request files (ports BackupOps), follows its status files and keeps the operations' history.
 */
export class BackupsService implements BackupsPublicApi {
  readonly ops: BackupOps;

  constructor(protected readonly deps: BackupsServiceDeps) {
    this.ops = deps.ops;
  }

  private get ctx() {
    return this.deps.ctx;
  }
  private get repo() {
    return this.deps.repo;
  }
  private now = () => this.ctx.clock.now();

  private async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'>, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ ...entry, category: 'security', actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      // the change is made; a missing audit entry is logged, never turned into a failed request
      this.ctx.log[isNotImplemented(err) ? 'debug' : 'error']({ err, action: entry.action }, 'audit entry not recorded');
    }
  }

  private requireAvailable() {
    if (!this.ops.available) throw this.ctx.error('BACKUPS_UNAVAILABLE', this.ops.unavailableReason ?? 'Backups are made by the production server');
  }

  /* ---------------- reads */

  async overview(): Promise<BackupOverview> {
    if (this.ops.available) await this.syncStatuses();
    const [backups, uploads, recent, active, waiting] = await Promise.all([
      this.ops.listBackups(),
      this.repo.listUploads(),
      this.repo.recentOperations(RECENT),
      this.repo.operationsIn(ACTIVE_STATES, ['backup', 'restore']),
      this.repo.operationsIn(['waiting_approval'], ['restore']),
    ]);
    const opIds = [...new Set(backups.map((b) => b.operationId).filter((x): x is string => !!x))];
    const ops = new Map((await this.repo.operationsByIds(opIds)).map((r) => [r.id, r]));
    const schedule = await this.schedule();
    const pending = waiting[0];
    return {
      available: this.ops.available,
      unavailableReason: this.ops.unavailableReason,
      backups: backups.map((b) => toBackup(b, b.operationId ? ops.get(b.operationId) : undefined)),
      uploads: uploads.map(toUpload),
      schedule,
      lastBackupAt: backups[0]?.createdAt.toISOString() ?? null,
      running: active[0] ? toOperation(active[0]) : null,
      pendingRestore: pending ? toOperation(pending, await this.approvalInfo(pending)) : null,
      recent: recent.map((r) => toOperation(r)),
      warnings: warningsOf({ available: this.ops.available, backups, now: this.now(), scheduleApplied: schedule.applied }),
    };
  }

  async operation(id: string): Promise<BackupOperation> {
    if (this.ops.available) await this.syncStatuses();
    const row = await this.repo.getOperation(id);
    if (!row) throw new AppError('NOT_FOUND', 'Operation not found');
    return toOperation(row, row.state === 'waiting_approval' ? await this.approvalInfo(row) : null);
  }

  private async approvalInfo(row: OperationRow): Promise<common.ApprovalInfo | null> {
    if (!row.approval_request_id) return null;
    try {
      return await this.ctx.use('access').approvalInfo(row.approval_request_id);
    } catch (err) {
      this.ctx.log.warn({ err }, 'backups: approval info unavailable');
      return null;
    }
  }

  private async schedule(): Promise<BackupOverview['schedule']> {
    const [time, keepDays, applied] = await Promise.all([this.ctx.settings.get('time'), this.ctx.settings.get('keepDays'), this.ops.readSchedule()]);
    const timeZone = this.ctx.config.market.timeZone;
    const t = String(time);
    const days = Number(keepDays);
    return {
      time: t,
      keepDays: days,
      timeZone,
      nextRunAt: this.ops.available ? (nextRunAt(t, timeZone, this.now())?.toISOString() ?? null) : null,
      applied: !this.ops.available || (applied?.time === t && applied.keepDays === days && applied.timeZone === timeZone),
    };
  }

  /* ---------------- back up now */

  async startBackup(body: { note?: string | null }, by: By): Promise<BackupOperation> {
    this.requireAvailable();
    const note = body.note?.trim() || null;
    if (note && note.length > NOTE_MAX) throw new AppError('VALIDATION_FAILED', 'Keep the note short', { issues: [{ path: 'note', message: `At most ${NOTE_MAX} characters` }] });
    const row = await this.newOperation({ kind: 'backup', state: 'queued', note, by }, ACTIVE_STATES);
    await this.send(row);
    await this.audit({ action: 'backups.backup.start', actionLabel: 'Started a backup', target: { type: 'backup_operation', id: row.id, label: note ?? 'Backup now', screen: 'admin/backups' }, after: { note } }, by);
    return toOperation(row);
  }

  /** Inserts an operation unless another one in `blocking` states is under way (one backup or restore at a time) */
  private async newOperation(o: { kind: OperationRow['kind']; state: OperationRow['state']; by: By; note?: string | null; reason?: string | null; backupId?: string | null; uploadId?: string | null; params?: unknown }, blocking: readonly OperationRow['state'][]): Promise<OperationRow> {
    const now = this.now();
    return this.repo.transaction(async (tx) => {
      await tx.lockOperations();
      if (o.kind !== 'schedule') {
        const busy = (await tx.operationsIn(blocking, ['backup', 'restore']))[0];
        if (busy) throw this.ctx.error('OPERATION_IN_PROGRESS', `${operationLabel(busy.kind)} ${busy.state === 'waiting_approval' ? 'waiting for approval' : 'under way'}: wait until it finishes`, { operationId: busy.id });
      }
      return tx.insertOperation({
        id: newId(),
        kind: o.kind,
        state: o.state,
        backup_id: o.backupId ?? null,
        upload_id: o.uploadId ?? null,
        safety_backup_id: null,
        note: o.note ?? null,
        reason: o.reason ?? null,
        message: null,
        params: (o.params ?? null) as never,
        requested_by: o.by.actor as never,
        requested_at: now,
        approval_request_id: null,
        started_at: null,
        finished_at: null,
        updated_at: now,
      });
    });
  }

  /** Hands a queued operation to the backup service; a request it can't write fails the operation */
  private async send(row: OperationRow): Promise<void> {
    const params = (row.params ?? {}) as { time?: string; keepDays?: number; timeZone?: string };
    try {
      await this.ops.writeRequest({
        version: 1,
        id: row.id,
        kind: row.kind,
        requestedAt: row.requested_at.toISOString(),
        requestedBy: row.requested_by as unknown as common.Actor,
        note: row.note,
        reason: row.reason,
        backupId: row.backup_id,
        uploadId: row.upload_id,
        ...(row.kind === 'schedule' ? { time: params.time, keepDays: params.keepDays, timeZone: params.timeZone } : {}),
      });
    } catch (err) {
      this.ctx.log.error({ err, operationId: row.id }, 'backups: request not written');
      await this.repo.updateOperation(row.id, { state: 'failed', message: 'The request could not be handed to the backup service', finished_at: this.now(), updated_at: this.now() });
      throw new AppError('INTERNAL_ERROR', 'The backup service could not be reached. Check the server (sudo marketly check).');
    }
  }

  /* ---------------- downloads */

  async downloadLinks(id: string, by: By): Promise<BackupDownloadLinks> {
    this.requireAvailable();
    const b = await this.findBackup(id);
    const expiresAt = new Date(this.now().getTime() + DOWNLOAD_MINUTES * MINUTE);
    const link = (f: { name: string; sizeBytes: number }): DownloadLink => ({
      url: `${this.ctx.config.apiUrl}${signFileLink(fileLinkSecret(this.ctx.config, this.ctx.name), {
        bucket: BACKUPS_BUCKET,
        key: f.name,
        expiresAt,
        contentType: 'application/gzip',
        disposition: `attachment; filename="marketly-${f.name}"`,
      })}`,
      fileName: `marketly-${f.name}`,
      sizeBytes: f.sizeBytes,
      expiresAt: expiresAt.toISOString(),
    });
    const out = { database: link(b.database), files: b.files ? link(b.files) : null };
    await this.audit({ action: 'backups.backup.download', actionLabel: 'Downloaded a backup', target: { type: 'backup', id: b.id, label: `Backup ${b.id}`, screen: 'admin/backups' }, after: { database: b.database.name, files: b.files?.name ?? null } }, by);
    return out;
  }

  private async findBackup(id: string): Promise<BackupOnDisk> {
    const b = BACKUP_ID.test(id) ? (await this.ops.listBackups()).find((x) => x.id === id) : undefined;
    if (!b) throw new AppError('NOT_FOUND', 'Backup not found');
    return b;
  }

  /** GET /files/backups/<name>: the backup file a verified link names (only database and uploaded-files files) */
  openDownload(name: string, range?: { start: number; end: number }) {
    return this.ops.openBackupFile(name, range);
  }

  /* ---------------- uploads */

  async createUpload(body: { label: string }, by: By): Promise<BackupUpload> {
    this.requireAvailable();
    const label = body.label?.trim();
    if (!label || label.length > UPLOAD_LABEL_MAX) throw new AppError('VALIDATION_FAILED', 'Name the uploaded backup', { issues: [{ path: 'label', message: `1 to ${UPLOAD_LABEL_MAX} characters` }] });
    const now = this.now();
    const row = await this.repo.insertUpload({ id: newId(), label, state: 'receiving', database_bytes: null, files_bytes: null, uploaded_by: by.actor as never, error: null, created_at: now, updated_at: now });
    await this.audit({ action: 'backups.upload.create', actionLabel: 'Started uploading a backup', target: { type: 'backup_upload', id: row.id, label, screen: 'admin/backups' } }, by);
    return toUpload(row);
  }

  async receiveUpload(id: string, part: 'database' | 'files', body: Readable | undefined, declaredBytes: number | undefined): Promise<BackupUpload> {
    this.requireAvailable();
    const upload = await this.repo.getUpload(id);
    if (!upload) throw new AppError('NOT_FOUND', 'Uploaded backup not found');
    if (upload.state === 'failed') throw new AppError('ILLEGAL_TRANSITION', 'This upload failed; start a new one', { from: upload.state, event: 'upload' });
    await this.refuseWhileRestoring(id);
    const maxBytes = Number(await this.ctx.settings.get('maxUploadGb')) * 1024 ** 3;
    if (declaredBytes !== undefined && declaredBytes > maxBytes) throw this.ctx.error('UPLOAD_TOO_LARGE', 'The file is larger than the upload limit (backups.maxUploadGb)', { maxBytes });
    if (!body) throw new AppError('VALIDATION_FAILED', 'Send the file', { issues: [{ path: 'body', message: 'The file is missing' }] });
    let received: { sizeBytes: number; gzip: boolean };
    try {
      received = await this.ops.receiveUpload(id, part, body, maxBytes);
    } catch (err) {
      if (err instanceof UploadTooLarge) throw this.ctx.error('UPLOAD_TOO_LARGE', 'The file is larger than the upload limit (backups.maxUploadGb)', { maxBytes });
      throw err;
    }
    if (!received.gzip) {
      const what = part === 'database' ? 'database backup (<date>.archive.gz)' : 'uploaded-files backup (<date>.media.tar.gz)';
      throw this.ctx.error('NOT_A_BACKUP', `This is not a ${what} made by the backup service`);
    }
    const patch: Partial<UploadRow> = part === 'database' ? { database_bytes: received.sizeBytes } : { files_bytes: received.sizeBytes };
    const databaseBytes = part === 'database' ? received.sizeBytes : upload.database_bytes;
    const after = await this.repo.updateUpload(id, { ...patch, state: databaseBytes ? 'ready' : 'receiving', error: null, updated_at: this.now() });
    return toUpload(after ?? upload);
  }

  async deleteUpload(id: string, by: By): Promise<void> {
    const upload = await this.repo.getUpload(id);
    if (!upload) throw new AppError('NOT_FOUND', 'Uploaded backup not found');
    await this.refuseWhileRestoring(id);
    await this.ops.removeUpload(id);
    await this.repo.deleteUpload(id);
    await this.audit({ action: 'backups.upload.delete', actionLabel: 'Deleted an uploaded backup', target: { type: 'backup_upload', id, label: upload.label, screen: 'admin/backups' } }, by);
  }

  private async refuseWhileRestoring(uploadId: string) {
    const restoring = (await this.repo.operationsIn(BLOCKING_STATES, ['restore'])).find((r) => r.upload_id === uploadId);
    if (restoring) throw this.ctx.error('OPERATION_IN_PROGRESS', 'A restore of this upload is waiting or under way', { operationId: restoring.id });
  }

  /* ---------------- restores */

  async requestRestore(body: { backupId?: string | null; uploadId?: string | null; confirm: string; reason: string }, by: By): Promise<BackupOperation> {
    this.requireAvailable();
    const issues: { path: string; message: string }[] = [];
    if (!!body.backupId === !!body.uploadId) issues.push({ path: 'backupId', message: 'Choose one backup: one on the server or an uploaded one' });
    if (body.confirm !== 'RESTORE') issues.push({ path: 'confirm', message: 'Type RESTORE to confirm' });
    if (!body.reason?.trim()) issues.push({ path: 'reason', message: 'Say why you are restoring' });
    if (issues.length) throw new AppError('VALIDATION_FAILED', issues[0]!.message, { issues });
    const principal = by.principal;
    if (!principal) throw new AppError('FORBIDDEN', 'Only staff can ask for a restore');

    let label: string;
    if (body.backupId) {
      const b = await this.findBackup(body.backupId);
      label = `backup ${b.id}`;
    } else {
      const u = isUuid(body.uploadId) ? await this.repo.getUpload(body.uploadId!) : undefined;
      if (!u) throw new AppError('NOT_FOUND', 'Uploaded backup not found');
      if (u.state !== 'ready') throw new AppError('VALIDATION_FAILED', 'Upload the database file first', { issues: [{ path: 'uploadId', message: 'The uploaded backup has no database file yet' }] });
      label = `uploaded backup “${u.label}”`;
    }

    const access = this.ctx.use('access');
    const check = await access.check(principal, RESTORE_ACTION);
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason);
    const reason = body.reason.trim();
    // saved first (one restore at a time), then the approval request names it
    const row = await this.newOperation({ kind: 'restore', state: check.decision === 'allowed' ? 'queued' : 'waiting_approval', by, reason, backupId: body.backupId ?? null, uploadId: body.uploadId ?? null }, BLOCKING_STATES);
    let approval: common.ApprovalInfo | null = null;
    let current = row;
    if (check.decision === 'approval_required') {
      try {
        const req = await access.requestApproval({
          action: RESTORE_ACTION,
          target: { type: 'backup_restore', id: row.id, label: `Restore ${label}`, screen: 'admin/backups' },
          summary: `Restore ${label} over the whole system (database and uploaded files)`,
          details: { backupId: body.backupId ?? null, uploadId: body.uploadId ?? null },
          reason,
          requestedBy: principal,
        });
        current = (await this.repo.updateOperation(row.id, { approval_request_id: req.id, updated_at: this.now() })) ?? row;
        approval = await this.approvalInfo(current);
      } catch (err) {
        await this.repo.updateOperation(row.id, { state: 'cancelled', message: 'The approval request could not be made', finished_at: this.now(), updated_at: this.now() });
        throw err;
      }
    } else {
      await this.send(row);
    }
    await this.audit({ action: 'backups.restore.request', actionLabel: 'Asked to restore a backup', target: { type: 'backup_restore', id: row.id, label: `Restore ${label}`, screen: 'admin/backups' }, reason, after: { backupId: body.backupId ?? null, uploadId: body.uploadId ?? null } }, by);
    return toOperation(current, approval);
  }

  async cancelRestore(id: string, by: By): Promise<BackupOperation> {
    const row = await this.repo.getOperation(id);
    if (!row || row.kind !== 'restore') throw new AppError('NOT_FOUND', 'Restore not found');
    const state = backupOperationMachine.next(row.state, 'cancel');
    const after = (await this.repo.updateOperation(id, { state, finished_at: this.now(), updated_at: this.now() })) ?? row;
    if (row.approval_request_id) {
      try {
        await this.ctx.use('access').cancelApproval(row.approval_request_id, by.actor, 'The restore was withdrawn');
      } catch (err) {
        this.ctx.log.warn({ err, operationId: id }, 'backups: approval request not cancelled');
      }
    }
    await this.audit({ action: 'backups.restore.cancel', actionLabel: 'Withdrew a restore', target: { type: 'backup_restore', id, screen: 'admin/backups' } }, by);
    return toOperation(after);
  }

  /** access.approval.decided: an approved restore goes to the backup service; a refused one is closed */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    if (event.actionKey !== RESTORE_ACTION) return;
    const row = await this.repo.operationByApproval(event.requestId);
    if (!row || row.state !== 'waiting_approval') return; // unknown, or already handled (a redelivered event)
    const now = this.now();
    if (event.outcome !== 'approved') {
      const state = backupOperationMachine.next(row.state, event.outcome === 'cancelled' ? 'cancel' : 'reject');
      await this.repo.updateOperation(row.id, { state, message: event.reason ?? null, finished_at: now, updated_at: now });
      return;
    }
    const queued = (await this.repo.updateOperation(row.id, { state: backupOperationMachine.next(row.state, 'approve'), updated_at: now })) ?? row;
    if (!this.ops.available) {
      await this.repo.updateOperation(row.id, { state: 'failed', message: this.ops.unavailableReason, finished_at: now, updated_at: now });
      return;
    }
    await this.send(queued).catch(() => {}); // a failure is recorded on the operation
    await this.audit({ action: 'backups.restore.approve', actionLabel: 'Restore approved: handed to the backup service', target: { type: 'backup_restore', id: row.id, screen: 'admin/backups' } }, { actor: event.decidedBy ?? SYSTEM_ACTOR });
  }

  /* ---------------- schedule */

  /** settings.setting.changed: the nightly time or the days kept changed → the backup service applies them */
  async onSettingChangedFromSettings(event: EventPayload<'settings.setting.changed'>): Promise<void> {
    if (event.key !== 'backups.time' && event.key !== 'backups.keepDays') return;
    await this.applySchedule();
  }

  /** Asks the backup service to apply the schedule in Settings (unless it has it, or a request is on its way) */
  async applySchedule(): Promise<void> {
    if (!this.ops.available) return;
    const s = await this.schedule();
    if (s.applied) return;
    if ((await this.repo.operationsIn(ACTIVE_STATES, ['schedule'])).length) return;
    const row = await this.newOperation({ kind: 'schedule', state: 'queued', by: { actor: SYSTEM_ACTOR }, params: { time: s.time, keepDays: s.keepDays, timeZone: s.timeZone } }, ACTIVE_STATES);
    await this.send(row).catch(() => {});
  }

  /* ---------------- following the backup service */

  /** Job backups.watch-operations (and at boot): follow the status files, rebuild what a restore replaced, keep the schedule applied */
  async watchOperations(): Promise<void> {
    if (!this.ops.available) return;
    await this.syncStatuses();
    await this.failUnclaimed();
    await this.applySchedule();
  }

  /** Brings operation rows up to date with the service's status files */
  async syncStatuses(): Promise<void> {
    for (const s of await this.ops.readStatuses()) {
      try {
        await this.syncOne(s);
      } catch (err) {
        this.ctx.log.warn({ err, operationId: s.id }, 'backups: status not applied');
      }
    }
  }

  private async syncOne(s: OpsStatus): Promise<void> {
    if (!KINDS.has(s.kind)) return; // not a status file of the backup service
    const row = await this.repo.getOperation(s.id);
    const patch = statusPatch(s);
    if (!row) {
      // a restore replaced this collection with the backup's: the operation lives on in its status file
      await this.repo.insertOperationIfAbsent({
        id: s.id,
        kind: s.kind,
        upload_id: s.uploadId ?? null,
        safety_backup_id: null,
        note: s.note ?? null,
        reason: s.reason ?? null,
        message: null,
        params: s.kind === 'schedule' ? ({ time: s.time, keepDays: s.keepDays, timeZone: s.timeZone } as never) : null,
        requested_by: (s.requestedBy ?? SYSTEM_ACTOR) as never,
        requested_at: new Date(s.requestedAt),
        approval_request_id: null,
        started_at: null,
        finished_at: null,
        updated_at: this.now(),
        state: 'queued',
        ...patch,
        backup_id: s.resultBackupId ?? s.backupId ?? null,
      } as OperationRow);
      if (patch.state === 'done' || patch.state === 'failed') this.finished(s.id, s.kind, s);
      return;
    }
    if (!patch.state || row.state === patch.state || !moves(row.state, patch.state)) return;
    await this.repo.updateOperation(row.id, { ...patch, ...(s.resultBackupId ? { backup_id: s.resultBackupId } : {}), updated_at: this.now() });
    if (patch.state === 'done' || patch.state === 'failed') this.finished(row.id, row.kind, s);
  }

  private finished(operationId: string, kind: OperationRow['kind'], s: OpsStatus) {
    if (kind === 'schedule') return;
    this.ctx.events.publish('backups.operation.finished', { operationId, kind, state: s.state, backupId: s.resultBackupId ?? s.backupId ?? null, message: s.message ?? null }, { actor: SYSTEM_ACTOR });
  }

  /** Requests the service never picked up: failed after a while, so the next backup isn't blocked forever */
  private async failUnclaimed(): Promise<void> {
    const cutoff = this.now().getTime() - UNCLAIMED_MINUTES * MINUTE;
    const statuses = new Set((await this.ops.readStatuses()).map((s) => s.id));
    for (const r of await this.repo.operationsIn(['queued'])) {
      if (statuses.has(r.id) || r.updated_at.getTime() > cutoff) continue;
      await this.repo.updateOperation(r.id, { state: 'failed', message: 'The backup service did not pick up the request. Check the server (sudo marketly check).', finished_at: this.now(), updated_at: this.now() });
    }
  }
}

/** The fields a status file sets on its operation row */
function statusPatch(s: OpsStatus): Partial<OperationRow> {
  const at = (v: string | null | undefined) => (v ? new Date(v) : null);
  return {
    ...(s.state === 'queued' || s.state === 'running' || s.state === 'done' || s.state === 'failed' ? { state: s.state } : {}),
    started_at: at(s.startedAt),
    finished_at: at(s.finishedAt),
    message: s.message ?? null,
    safety_backup_id: s.safetyBackupId ?? null,
  };
}

/** Status files only move an operation forward (a stale file never takes a finished one back) */
const ORDER: Record<OperationRow['state'], number> = { waiting_approval: 0, queued: 1, running: 2, done: 3, failed: 3, rejected: 3, cancelled: 3 };
const moves = (from: OperationRow['state'], to: OperationRow['state']) => ORDER[to] > ORDER[from];

function toUpload(r: UploadRow): BackupUpload {
  return {
    id: r.id,
    label: r.label,
    state: r.state,
    database: r.database_bytes != null ? { name: 'database.archive.gz', sizeBytes: Number(r.database_bytes) } : null,
    files: r.files_bytes != null ? { name: 'files.media.tar.gz', sizeBytes: Number(r.files_bytes) } : null,
    uploadedBy: r.uploaded_by as unknown as common.Actor,
    createdAt: r.created_at.toISOString(),
    error: r.error,
  };
}
