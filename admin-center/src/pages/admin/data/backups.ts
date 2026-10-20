// Admin Center → Backups: the overview query, the actions and the upload with progress. The backup service on the
// server does the work (deploy/linux/ops.sh); the API hands it requests and reports what it did.
import { useQuery } from '@tanstack/react-query';
import { ApiError, call, toApiError, useApi, type components } from '@marketly/web-shared/api';
import { reauthField } from './step-up';

type S = components['schemas'];
export type BackupOverview = S['backups.BackupOverview'];
export type Backup = S['backups.Backup'];
export type BackupUpload = S['backups.BackupUpload'];
export type BackupOperation = S['backups.BackupOperation'];
export type DownloadLinks = S['backups.BackupDownloadLinks'];

export const BACKUPS_KEY = ['backups', 'overview'] as const;

/** The overview; while a backup or restore is under way it is read again every few seconds */
export function useBackups(enabled: boolean) {
  const { api } = useApi();
  return useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: () => call(api.GET('/api/admin/backups/backups')),
    enabled,
    // a restore stops the server for a few minutes: keep asking until it answers again
    retry: (n, e) => n < 60 && (!(e instanceof ApiError) || e.status >= 500 || e.status === 0),
    retryDelay: 5000,
    refetchInterval: (q) => {
      const o = q.state.data;
      return o?.running || o?.pendingRestore || (o && !o.schedule.applied) ? 5000 : false;
    },
  });
}

export const KIND_LABEL: Record<Backup['kind'], string> = { nightly: 'Nightly', manual: 'Manual', safety: 'Safety (before a restore)', uploaded: 'Uploaded' };
export const STATE_LABEL: Record<BackupOperation['state'], string> = {
  waiting_approval: 'Waiting for approval',
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
};
export const STATE_TONE: Record<BackupOperation['state'], 'info' | 'warning' | 'success' | 'danger' | ''> = {
  waiting_approval: 'warning',
  queued: 'info',
  running: 'info',
  done: 'success',
  failed: 'danger',
  rejected: '',
  cancelled: '',
};
export const OPERATION_LABEL: Record<BackupOperation['kind'], string> = { backup: 'Backup', restore: 'Restore', schedule: 'Schedule change' };

/**
 * Sends a backup file to an upload (PUT, the raw bytes) with progress: the browser streams it, the server writes it to
 * disk as it arrives. XMLHttpRequest because fetch reports no upload progress.
 */
export async function sendBackupFile(
  token: () => Promise<string>,
  uploadId: string,
  part: 'database' | 'files',
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<BackupUpload> {
  const bearer = await token();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/admin/backups/backups/uploads/${encodeURIComponent(uploadId)}/${part}`);
    xhr.setRequestHeader('Authorization', `Bearer ${bearer}`);
    xhr.setRequestHeader('X-Client', 'web');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'The upload was interrupted. Check the connection and try again.'));
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'The upload was cancelled.'));
    xhr.onload = async () => {
      const res = new Response(xhr.responseText, { status: xhr.status, headers: { 'content-type': 'application/json', ...(xhr.getResponseHeader('x-request-id') ? { 'x-request-id': xhr.getResponseHeader('x-request-id')! } : {}) } });
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText) as BackupUpload);
      else reject(await toApiError(res));
    };
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

/** Starts the browser downloads of a backup's files */
export function startDownloads(links: DownloadLinks, download: (url: string, name?: string | null) => void) {
  download(links.database.url, links.database.fileName);
  // a second download right away is blocked by some browsers: give the first one a moment
  if (links.files) setTimeout(() => download(links.files!.url, links.files!.fileName), 800);
}

export const useBackupsApi = () => {
  const { api, session } = useApi();
  return {
    session,
    startBackup: (note: string | null) => call(api.POST('/api/admin/backups/backups', { body: { note } })),
    downloadLinks: (id: string, reauthToken?: string) => call(api.POST('/api/admin/backups/backups/{id}/download-links', { params: { path: { id } }, body: reauthField(reauthToken) })),
    createUpload: (label: string) => call(api.POST('/api/admin/backups/backups/uploads', { body: { label } })),
    deleteUpload: (id: string) => call(api.DELETE('/api/admin/backups/backups/uploads/{id}', { params: { path: { id } } })),
    requestRestore: (body: { backupId?: string | null; uploadId?: string | null; confirm: string; reason: string }, reauthToken?: string) =>
      call(api.POST('/api/admin/backups/backups/restores', { body: { ...body, ...reauthField(reauthToken) } })),
    cancelRestore: (id: string) => call(api.POST('/api/admin/backups/backups/restores/{id}/cancel', { params: { path: { id } } })),
  };
};
