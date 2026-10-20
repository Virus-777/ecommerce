// Admin Center → Backups (admin/backups): designed in React. Backups of the whole system made by the server's backup
// service: the list, a backup now, downloads (password again), uploads of a backup copied back from a USB disk, and
// restores (password, the word RESTORE, a reason, and a second person's approval in the Inbox). Data: data/backups.ts.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage, fileSize } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { download } from '@marketly/web-shared/lib/exports';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, Dialog, EmptyState, Field, KeyValue, Meter, TableWrap, Textarea, TextInput } from '@marketly/web-shared/ui';
import { actorLabel, dateTime, LoadError, SkeletonLines } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import {
  BACKUPS_KEY,
  KIND_LABEL,
  OPERATION_LABEL,
  sendBackupFile,
  startDownloads,
  STATE_LABEL,
  STATE_TONE,
  useBackups,
  useBackupsApi,
  type Backup,
  type BackupOperation,
  type BackupUpload,
} from './data/backups';
import { isStepUpCancel, useStepUp } from './data/step-up';

type Notice = { tone: 'success' | 'info' | 'danger'; title: string; text?: string } | null;
type RestoreSource = { backupId?: string; uploadId?: string; label: string } | null;

const CRUMBS = [{ label: 'Reports and settings' }, { label: 'Backups' }];

export default function Backups() {
  const me = useStaffSession();
  const canView = me.can('backups.view');
  const canCreate = me.can('backups.create');
  const canDownload = me.can('backups.download');
  const canRestore = me.can('backups.restore');
  const qc = useQueryClient();
  const q = useBackups(canView);
  const api = useBackupsApi();
  const stepUp = useStepUp();
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<RestoreSource>(null);
  const [uploading, setUploading] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: BACKUPS_KEY });

  if (!canView) {
    return (
      <AdminLayout active="backups">
        <Head />
        <Alert tone="info" title="You don’t have access to Backups">
          Backups are for the Business Owner and the Platform Administrator (permission “See backups”).
        </Alert>
      </AdminLayout>
    );
  }

  const o = q.data;
  const act = async (key: string, fn: () => Promise<unknown>, done: Notice) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      if (done) announce(done.title);
      await refresh();
    } catch (e) {
      if (!isStepUpCancel(e)) setNotice({ tone: 'danger', title: 'That didn’t work', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const backUpNow = () =>
    act('backup', () => api.startBackup(null), { tone: 'success', title: 'Backup started', text: 'The backup service is making a backup of the database, the uploaded files and the settings. It appears below when it’s done.' });
  const downloadBackup = (b: Backup) =>
    act(`download:${b.id}`, async () => startDownloads(await stepUp.run((t) => api.downloadLinks(b.id, t)), download), {
      tone: 'info',
      title: 'Download started',
      text: 'Keep the files somewhere safe and locked away: they hold all customer, seller and staff data. The settings and keys file is not offered here; copy it by USB on the server.',
    });
  const deleteUpload = (u: BackupUpload) => act(`delete:${u.id}`, () => api.deleteUpload(u.id), { tone: 'success', title: 'Uploaded backup deleted' });
  const withdraw = (op: BackupOperation) => act(`cancel:${op.id}`, () => api.cancelRestore(op.id), { tone: 'success', title: 'Restore withdrawn' });

  const restoreRunning = o?.running?.kind === 'restore';
  return (
    <AdminLayout active="backups">
      <Head
        actions={
          <>
            {canRestore && (
              <Button variant="secondary" size="sm" icon="upload" onClick={() => setUploading(true)} disabled={!o?.available}>
                Upload a backup
              </Button>
            )}
            {canCreate && (
              <Button size="sm" icon="hard-drive" onClick={() => void backUpNow()} disabled={!o?.available || !!o.running || busy === 'backup'} aria-busy={busy === 'backup' || undefined}>
                {busy === 'backup' ? 'Starting…' : 'Back up now'}
              </Button>
            )}
          </>
        }
      />
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.text}
        </Alert>
      )}
      {restoreRunning && (
        <Alert tone="warning" title="A backup is being restored">
          The server stops for a few minutes while the database and the uploaded files are replaced. This page reconnects by itself; sign in again if it asks.
        </Alert>
      )}
      {q.isError && !restoreRunning ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} title="We couldn’t load the backups" />
      ) : !o ? (
        <Card pad>
          <SkeletonLines rows={4} />
        </Card>
      ) : (
        <div className="stack gap-5">
          {!o.available && (
            <Alert tone="info" title="Backups are made by the production server">
              {o.unavailableReason}
            </Alert>
          )}
          {o.warnings.map((w) => (
            <Alert key={w} tone={/USB/.test(w) ? 'info' : 'warning'} title={/USB/.test(w) ? 'Keep a copy off the server' : 'Check the backups'}>
              {w}
            </Alert>
          ))}

          <Card pad title="Status">
            <KeyValue
              pairs={[
                ['Last backup', o.lastBackupAt ? dateTime(o.lastBackupAt) : 'None yet'],
                ['Nightly backup', `${o.schedule.time} (${o.schedule.timeZone.replace(/_/g, ' ')})${o.schedule.nextRunAt ? `, next ${dateTime(o.schedule.nextRunAt)}` : ''}`],
                ['Kept for', `${o.schedule.keepDays} days`],
                ['Under way', o.running ? `${OPERATION_LABEL[o.running.kind]} · ${STATE_LABEL[o.running.state]}${o.running.message ? ` · ${o.running.message}` : ''}` : 'Nothing'],
              ]}
            />
            <p className="small muted u-mt-sp-3">
              The nightly time and the days kept are settings:{' '}
              <Button variant="link" size="sm" to={href('admin/settings')}>
                Settings → Backups
              </Button>
              {!o.schedule.applied && ' (the backup service applies a change within a minute)'}
            </p>
          </Card>

          {o.pendingRestore && <PendingRestore op={o.pendingRestore} onWithdraw={canRestore ? () => void withdraw(o.pendingRestore!) : undefined} busy={busy === `cancel:${o.pendingRestore.id}`} />}

          <Card title="Backups on the server" sub="Newest first. Each holds the whole database and the uploaded files; the settings and keys file stays on the server.">
            {o.backups.length === 0 ? (
              <EmptyState icon="hard-drive" title="No backups yet">
                {o.available ? 'The first nightly backup runs at the time in Settings, or back up now.' : 'This server has no backup service.'}
              </EmptyState>
            ) : (
              <TableWrap label="Backups on the server">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Made</th>
                      <th scope="col">Kind</th>
                      <th scope="col" className="r">
                        Database
                      </th>
                      <th scope="col" className="r">
                        Uploaded files
                      </th>
                      <th scope="col">Settings and keys</th>
                      <th scope="col">Note</th>
                      <th scope="col" className="col-pin">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.backups.map((b) => (
                      <tr key={b.id}>
                        <td>
                          <div className="strong">{dateTime(b.createdAt)}</div>
                          <div className="xs muted mono">{b.id}</div>
                        </td>
                        <td>
                          <Badge tone={b.kind === 'safety' ? 'warning' : b.kind === 'uploaded' ? 'info' : ''}>{KIND_LABEL[b.kind]}</Badge>
                        </td>
                        <td className="r">{fileSize(b.database.sizeBytes)}</td>
                        <td className="r">{b.files ? fileSize(b.files.sizeBytes) : '—'}</td>
                        <td>{b.hasSettingsAndKeys ? 'On the server' : '—'}</td>
                        <td className="small">
                          {b.note ?? ''}
                          {b.requestedBy && <div className="xs muted">by {actorLabel(b.requestedBy)}</div>}
                        </td>
                        <td className="col-pin">
                          <div className="row gap-2 nowrap">
                            {canDownload && (
                              <Button variant="secondary" size="sm" icon="download" onClick={() => void downloadBackup(b)} disabled={busy === `download:${b.id}`} srLabel={`Download backup ${b.id}`}>
                                Download
                              </Button>
                            )}
                            {canRestore && (
                              <Button variant="danger-soft" size="sm" icon="rotate-ccw" onClick={() => setRestoring({ backupId: b.id, label: `the backup of ${dateTime(b.createdAt)}` })} disabled={!!o.pendingRestore || !!o.running} srLabel={`Restore backup ${b.id}`}>
                                Restore…
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          {(o.uploads.length > 0 || canRestore) && (
            <Card title="Uploaded backups" sub="Backups copied back from a USB disk. Restoring one moves it to the list above.">
              {o.uploads.length === 0 ? (
                <p className="small muted">None. Use Upload a backup to restore one kept off the server.</p>
              ) : (
                <TableWrap label="Uploaded backups">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">State</th>
                        <th scope="col" className="r">
                          Database
                        </th>
                        <th scope="col" className="r">
                          Uploaded files
                        </th>
                        <th scope="col">Uploaded</th>
                        <th scope="col" className="col-pin">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.uploads.map((u) => (
                        <tr key={u.id}>
                          <td className="strong">{u.label}</td>
                          <td>
                            <Badge tone={u.state === 'ready' ? 'success' : u.state === 'failed' ? 'danger' : 'warning'}>{u.state === 'ready' ? 'Ready' : u.state === 'failed' ? 'Failed' : 'Database file missing'}</Badge>
                          </td>
                          <td className="r">{u.database ? fileSize(u.database.sizeBytes) : '—'}</td>
                          <td className="r">{u.files ? fileSize(u.files.sizeBytes) : '—'}</td>
                          <td className="small">
                            {dateTime(u.createdAt)}
                            <div className="xs muted">by {actorLabel(u.uploadedBy)}</div>
                          </td>
                          <td className="col-pin">
                            <div className="row gap-2 nowrap">
                              {canRestore && u.state === 'ready' && (
                                <Button variant="danger-soft" size="sm" icon="rotate-ccw" onClick={() => setRestoring({ uploadId: u.id, label: `the uploaded backup “${u.label}”` })} disabled={!!o.pendingRestore || !!o.running}>
                                  Restore…
                                </Button>
                              )}
                              {canRestore && (
                                <Button variant="ghost" size="sm" icon="trash-2" onClick={() => void deleteUpload(u)} disabled={busy === `delete:${u.id}`} srLabel={`Delete ${u.label}`}>
                                  Delete
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>
          )}

          {o.recent.length > 0 && (
            <Card title="Recent activity">
              <ul className="stack gap-3">
                {o.recent.map((r) => (
                  <li key={r.id} className="row gap-3 wrap">
                    <Badge tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Badge>
                    <span className="strong">{OPERATION_LABEL[r.kind]}</span>
                    <span className="small muted">
                      {dateTime(r.requestedAt)} · {actorLabel(r.requestedBy)}
                      {r.backupId ? ` · ${r.backupId}` : ''}
                    </span>
                    {r.message && <span className="small grow">{r.message}</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      <RestoreDialog
        source={restoring}
        onClose={() => setRestoring(null)}
        onAsk={async (body) => {
          const op = await stepUp.run((t) => api.requestRestore(body, t));
          setRestoring(null);
          const who = op.approval?.approvers?.join(' or ') || 'a second staff member';
          setNotice({ tone: 'info', title: 'Restore waiting for approval', text: `${who} must approve it in the Inbox, confirming with their password. Nothing changes until then.` });
          announce('Restore waiting for approval');
          await refresh();
        }}
      />
      <UploadDialog open={uploading} onClose={() => setUploading(false)} onDone={() => void refresh()} />
      {stepUp.dialog}
    </AdminLayout>
  );
}

function Head({ actions }: { actions?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div className="t">
        <Breadcrumbs items={CRUMBS} />
        <h1 className="h1">Backups</h1>
        <p className="sub small">Backups of the whole system: the database, the uploaded files, and the settings and keys.</p>
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

function PendingRestore({ op, onWithdraw, busy }: { op: BackupOperation; onWithdraw?: () => void; busy: boolean }) {
  return (
    <Alert tone="warning" title="A restore is waiting for approval">
      {actorLabel(op.requestedBy)} asked to restore {op.backupId ?? 'an uploaded backup'} on {dateTime(op.requestedAt)}: “{op.reason}”.{' '}
      {op.approval?.approvers?.length ? `${op.approval.approvers.join(' or ')} can approve it in the Inbox.` : 'A second staff member approves it in the Inbox.'}{' '}
      {onWithdraw && (
        <Button variant="link" size="sm" onClick={onWithdraw} disabled={busy}>
          Withdraw it
        </Button>
      )}
    </Alert>
  );
}

function RestoreDialog({ source, onClose, onAsk }: { source: RestoreSource; onClose: () => void; onAsk: (body: { backupId?: string; uploadId?: string; confirm: string; reason: string }) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => {
    setReason('');
    setConfirm('');
    setError('');
    onClose();
  };
  const ready = confirm === 'RESTORE' && reason.trim().length > 0;
  const submit = async () => {
    if (!source || !ready) return;
    setBusy(true);
    setError('');
    try {
      await onAsk({ ...(source.backupId ? { backupId: source.backupId } : { uploadId: source.uploadId }), confirm, reason: reason.trim() });
      setReason('');
      setConfirm('');
    } catch (e) {
      if (!isStepUpCancel(e)) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!source}
      onClose={close}
      title="Restore a backup"
      foot={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void submit()} disabled={!ready || busy} aria-busy={busy || undefined}>
            {busy ? 'Asking…' : 'Ask for approval'}
          </Button>
        </>
      }
    >
      <div className="stack gap-4">
        <Alert tone="danger" title={`This replaces everything with ${source?.label ?? 'the backup'}`}>
          The whole database and all uploaded files are replaced. Orders, customers, staff changes and uploads since that backup are lost. A safety backup of the current data is taken first, and the server stops for a few minutes.
        </Alert>
        <p className="small">
          After you confirm with your password, a second staff member (a Platform Administrator or another Business Owner) must approve the restore in the Inbox, with their password. Nothing changes until then.
        </p>
        {error && (
          <Alert tone="danger" title="The restore wasn’t requested">
            {error}
          </Alert>
        )}
        <Field label="Why restore?" hint="Recorded in the action history and shown to the approver.">
          <Textarea id="bk-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Type RESTORE to confirm">
          <TextInput id="bk-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
    </Dialog>
  );
}

function UploadDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const api = useBackupsApi();
  const [label, setLabel] = useState('');
  const [database, setDatabase] = useState<File | null>(null);
  const [files, setFiles] = useState<File | null>(null);
  const [progress, setProgress] = useState<{ part: string; fraction: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (busy) return;
    setLabel('');
    setDatabase(null);
    setFiles(null);
    setProgress(null);
    setError('');
    onClose();
  };
  const submit = async () => {
    if (!database || !label.trim()) return;
    setBusy(true);
    setError('');
    try {
      const up = await api.createUpload(label.trim());
      setProgress({ part: 'database', fraction: 0 });
      await sendBackupFile(() => api.session.token(), up.id, 'database', database, (f) => setProgress({ part: 'database', fraction: f }));
      if (files) {
        setProgress({ part: 'uploaded files', fraction: 0 });
        await sendBackupFile(() => api.session.token(), up.id, 'files', files, (f) => setProgress({ part: 'uploaded files', fraction: f }));
      }
      announce('Backup uploaded');
      onDone();
      setBusy(false);
      close();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      dismissable={!busy}
      title="Upload a backup"
      foot={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!database || !label.trim() || busy} aria-busy={busy || undefined}>
            {busy ? 'Uploading…' : 'Upload'}
          </Button>
        </>
      }
    >
      <div className="stack gap-4">
        <p className="small">
          For a backup kept off the server (for example on a USB disk). Upload the database file and, to restore the uploaded files too, the files backup made at the same time. Restoring it afterwards needs a second person’s approval.
        </p>
        {error && (
          <Alert tone="danger" title="The upload didn’t finish">
            {error}
          </Alert>
        )}
        <Field label="Name" hint="So you can tell it apart, e.g. “USB copy of 15 October”.">
          <TextInput id="bk-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} disabled={busy} />
        </Field>
        <Field label="Database file" hint="The file ending in .archive.gz">
          <input id="bk-db" className="input" type="file" accept=".gz,application/gzip" disabled={busy} onChange={(e) => setDatabase(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="Uploaded files" optional hint="The file ending in .media.tar.gz">
          <input id="bk-files" className="input" type="file" accept=".gz,application/gzip" disabled={busy} onChange={(e) => setFiles(e.target.files?.[0] ?? null)} />
        </Field>
        {progress && <Meter pct={Math.round(progress.fraction * 100)} tone="info" label={`Sending the ${progress.part}: ${Math.round(progress.fraction * 100)}%`} />}
      </div>
    </Dialog>
  );
}
