# Backups and restores from the Admin Center

Built 2026-10-20 (branch `feature/backups`). Owner decisions: a restore needs two people; the database and the
uploaded files can be downloaded, the settings and keys file never; a backup can be uploaded and restored; the
nightly time and the days kept are settings.

## Who does what

The Marketly server runs unprivileged and hardened (`ProtectSystem=strict`): it can't stop itself, run
`mongorestore` over its own database, or touch `/etc/marketly`. So the work is split:

| Part | Runs as | Does |
| --- | --- | --- |
| `backups` module (`backend/src/modules/backups`) | marketly | lists backups, signs download links, receives uploads, records operations, asks for approval, writes **requests** |
| `ops.sh` + `ops-request.mjs` (`backend/deploy/linux`) | root, started by `marketly-ops.path` | checks each request, runs `backup.sh` / `restore.sh` / the timer change, writes **status** |
| `backup.sh` (nightly timer, or a request) | root | `<id>.archive.gz`, `<id>.media.tar.gz`, `<id>.config.tar.gz` (mode 600), `<id>.manifest.json` |

The two sides talk only through files:

```
/var/lib/marketly/ops/requests/<operation id>.json   written by the server (one JSON request; untrusted)
/var/lib/marketly/ops/status/<operation id>.json     written by ops.sh, read by the server
/var/lib/marketly/ops/schedule.json                  the schedule ops.sh applied
/var/lib/marketly/backup-uploads/<upload id>/        uploads, written by the server
/var/backups/marketly/                               backups (group marketly may read; config files root only)
```

The server finds them through `BACKUP_DIR`, `BACKUP_OPS_DIR` and `BACKUP_UPLOAD_DIR` (install.sh sets them).
Without `BACKUP_OPS_DIR` the module boots with "unavailable" ops: the page explains, every action answers
`BACKUPS_UNAVAILABLE`.

## Operations

`backups.operations` rows: `kind` backup | restore | schedule; states
`waiting_approval → queued → running → done | failed`, plus `rejected` and `cancelled` for a restore. One backup or
restore at a time (`OPERATION_IN_PROGRESS`). The job `backups.watch-operations` (every minute, and right after
start) copies status files into the rows, fails a request the service never picked up within 15 minutes, and
sends the schedule again when the setting and `schedule.json` differ. A restore replaces the database, rows
included: the watcher rebuilds the operation row from its status file afterwards.

## Restore

1. A Business Owner picks a backup (or a ready upload), gives a reason, types RESTORE and enters their password
   (re-auth purpose `backup-restore`).
2. The module records `waiting_approval` and opens the approval `backups.restore` (second reviewer always, step-up
   always): a Platform Administrator or another Business Owner approves in the Inbox with their password
   (purpose `approval`). The requester can't approve their own.
3. On `access.approval.decided` (approved) the module writes the request. `ops.sh` checks it: an uploaded backup
   must pass `gzip -t`, and its files archive may only hold plain files and folders under `media/`. Then
   `mongorestore --dryRun`, a **safety backup**, then `restore.sh --yes` (stops the server, restores, starts it).
   A failure is reported `failed` and the server is started again.

## Downloads and uploads

Downloads are signed file links (15 minutes) for the `backups` bucket, verified with the backups module's own
key. Several modules can now serve `/files` (`kernel/http/files.ts`, `registerFileRoutes`), each naming its
buckets. Only `.archive.gz` and `.media.tar.gz` names are accepted, so a link can never name the config file
(the server can't read it either). Uploads are raw `PUT` bodies streamed to disk, with the size limit from
Settings (`maxUploadGb`) and a gzip check on the first bytes (`NOT_A_BACKUP`).

## Tests

- `backend/src/modules/backups/test/backups.test.ts`: the module with temp folders; the service is simulated by
  writing status files.
- `backend/src/kernel/http/files.test.ts`: several modules on `/files`, ranges.
- `ops.sh` was run in a sandbox (stubbed `systemctl`, `mongorestore`, `flock`): backup, uploaded restore,
  schedule, a refused injection, a missing backup, a failed restore (server restarted), an archive with a link.
