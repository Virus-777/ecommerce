/** Row types of the backups collections and the port to the server's backup service. */
import type { Readable } from 'node:stream';
import type { BackupsDb } from '../../spec/backups.js';
import type * as common from '../../spec/common.js';

export type OperationRow = BackupsDb['operations'];
export type UploadRow = BackupsDb['uploads'];
export type OperationKind = OperationRow['kind'];
export type OperationState = OperationRow['state'];

/** A backup the service made, as found in the backup folder */
export interface BackupOnDisk {
  id: string;
  createdAt: Date;
  kind: 'nightly' | 'manual' | 'safety' | 'uploaded';
  database: { name: string; sizeBytes: number };
  files: { name: string; sizeBytes: number } | null;
  hasSettingsAndKeys: boolean;
  /** The operation that asked for it (manual and safety backups) */
  operationId: string | null;
}

/** What the module asks the backup service to do (written as BACKUP_OPS_DIR/requests/<id>.json) */
export interface OpsRequest {
  version: 1;
  id: string;
  kind: OperationKind;
  requestedAt: string;
  requestedBy: common.Actor;
  note?: string | null;
  reason?: string | null;
  /** restore: a backup in the backup folder */
  backupId?: string | null;
  /** restore: an uploaded backup */
  uploadId?: string | null;
  /** schedule */
  time?: string;
  keepDays?: number;
  timeZone?: string;
}

/** What the backup service reports (BACKUP_OPS_DIR/status/<id>.json): the request plus its progress */
export interface OpsStatus extends OpsRequest {
  state: 'queued' | 'running' | 'done' | 'failed';
  startedAt?: string | null;
  finishedAt?: string | null;
  message?: string | null;
  /** backup: the backup made; restore: the backup restored */
  resultBackupId?: string | null;
  safetyBackupId?: string | null;
}

/** The schedule the service applied (BACKUP_OPS_DIR/schedule.json) */
export interface AppliedSchedule {
  time: string;
  keepDays: number;
  timeZone: string;
  appliedAt: string;
}

/**
 * The server's backup service, seen from the web process: files only. It reads the backup folder, writes requests,
 * reads statuses and keeps uploaded backups. It never runs a backup, a restore or a shell command itself.
 */
export interface BackupOps {
  readonly available: boolean;
  readonly unavailableReason: string | null;
  listBackups(): Promise<BackupOnDisk[]>;
  /** A backup file to download (only .archive.gz and .media.tar.gz of a listed backup) */
  openBackupFile(name: string, range?: { start: number; end: number }): Promise<{ stream: Readable; sizeBytes: number; modifiedAt: Date } | null>;
  writeRequest(request: OpsRequest): Promise<void>;
  readStatuses(): Promise<OpsStatus[]>;
  readSchedule(): Promise<AppliedSchedule | null>;
  /** Streams an uploaded file to the upload folder; refuses more than maxBytes (the partial file is removed) */
  receiveUpload(uploadId: string, part: 'database' | 'files', body: Readable, maxBytes: number): Promise<{ sizeBytes: number; gzip: boolean }>;
  removeUpload(uploadId: string): Promise<void>;
}

/** receiveUpload: the body is larger than maxBytes */
export class UploadTooLarge extends Error {}
