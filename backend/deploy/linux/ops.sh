#!/usr/bin/env bash
# The backup service: does what staff asked for in Admin Center → Backups. Started by marketly-ops.path whenever a
# request file appears in /var/lib/marketly/ops/requests (written by the Marketly server, which runs unprivileged).
#
#   backup     a backup now (backup.sh, kind manual)
#   restore    an approved restore (two people approved it in the Admin Center): checks the files, takes a safety
#              backup, then restore.sh (stops the server, restores the database and the uploaded files, starts it)
#   schedule   the nightly time and the days kept from Settings: the timer's time and KEEP_DAYS for backup.sh
#
# Requests are untrusted (the web process wrote them): ops-request.mjs checks every field before the shell sees it.
# Progress goes to /var/lib/marketly/ops/status/<id>.json, which the server reads. One request at a time.
# By hand: sudo systemctl start marketly-ops   log: journalctl -u marketly-ops
set -euo pipefail
# a failure inside $( … ) fails the command that uses it (bash does not do that by default)
shopt -s inherit_errexit

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need_root

NODE=$(node_bin)
HELPER="$HERE/ops-request.mjs"
REQUESTS="$OPS_DIR/requests"
STATUS="$OPS_DIR/status"
mkdir -p "$REQUESTS" "$STATUS"

# one service run at a time (the path unit can start it again while a restore is running)
exec 9>"$OPS_LOCK"
flock -n 9 || exit 0

# status <id> <state> [options]: writes the status file the server reads (group marketly)
status() { "$NODE" "$HELPER" status "$STATUS" "$@" && chgrp "$MARKETLY_USER" "$STATUS/$1.json" 2>/dev/null || true; }

# A backup into BACKUP_DIR; prints its id
make_backup() {
  local kind=$1 operation=$2 idfile
  idfile=$(mktemp)
  BACKUP_KIND=$kind BACKUP_OPERATION=$operation BACKUP_ID_FILE=$idfile bash "$HERE/backup.sh" >&2
  [ -s "$idfile" ] || die "the $kind backup did not finish (journalctl -u marketly-ops)"
  cat "$idfile"
  rm -f "$idfile"
}

# The database and files of the restore: a backup in BACKUP_DIR, or an uploaded one moved there first
restore_source() {
  local id
  if [ -n "$OP_BACKUP_ID" ]; then
    [ -f "$BACKUP_DIR/$OP_BACKUP_ID.archive.gz" ] || die "backup $OP_BACKUP_ID is not on the server"
    printf '%s' "$OP_BACKUP_ID"
    return
  fi
  local up="$UPLOAD_DIR/$OP_UPLOAD_ID"
  [ -f "$up/database.archive.gz" ] || die "the uploaded backup has no database file"
  gzip -t "$up/database.archive.gz" || die "the uploaded database file is damaged (gzip check failed)"
  if [ -f "$up/files.media.tar.gz" ]; then
    gzip -t "$up/files.media.tar.gz" || die "the uploaded files backup is damaged (gzip check failed)"
    tar -tzf "$up/files.media.tar.gz" >/dev/null || die "the uploaded files backup is not a tar archive"
    # it is unpacked as root: only plain files and folders under media/, nothing outside it, no links (a link could
    # make the server hand out any file of the machine as an "uploaded file")
    if tar -tzf "$up/files.media.tar.gz" | grep -qvE '^media(/|$)'; then die "the uploaded files backup has entries outside media/"; fi
    if tar -tzf "$up/files.media.tar.gz" | grep -qE '(^|/)\.\.(/|$)'; then die "the uploaded files backup has .. in its paths"; fi
    if tar -tvzf "$up/files.media.tar.gz" | grep -qvE '^[-d]'; then die "the uploaded files backup holds links or devices"; fi
  fi
  id="$(date +%Y-%m-%d_%H%M%S)-uploaded"
  mv "$up/database.archive.gz" "$BACKUP_DIR/$id.archive.gz"
  [ -f "$up/files.media.tar.gz" ] && mv "$up/files.media.tar.gz" "$BACKUP_DIR/$id.media.tar.gz"
  chown root:"$MARKETLY_USER" "$BACKUP_DIR/$id".*
  chmod 640 "$BACKUP_DIR/$id".*
  "$NODE" "$HELPER" manifest "$BACKUP_DIR" "$id" uploaded "$OP_ID"
  chown root:"$MARKETLY_USER" "$BACKUP_DIR/$id.manifest.json"
  rm -rf "$up"
  printf '%s' "$id"
}

run_backup() {
  local id
  id=$(make_backup manual "$OP_ID")
  status "$OP_ID" done --message "Backup $id made" --result "$id"
}

run_restore() {
  local source safety uri server_uri
  source=$(restore_source)
  # the archive must be readable by mongorestore before anything is stopped
  uri=$(env_value "$ENV_FILE" MONGODB_URI)
  server_uri=$(server_uri_of "$uri")
  mongorestore --uri="$server_uri" --archive="$BACKUP_DIR/$source.archive.gz" --gzip --dryRun --quiet || die "backup $source can't be read by mongorestore"
  info "taking a safety backup before restoring $source"
  safety=$(make_backup safety "$OP_ID")
  status "$OP_ID" running --message "Safety backup $safety made; restoring $source (the server is stopped for a few minutes)" --safety "$safety"
  bash "$HERE/restore.sh" --yes "$BACKUP_DIR/$source.archive.gz"
  status "$OP_ID" done --message "Restored $source. Safety backup from just before: $safety" --result "$source" --safety "$safety"
}

run_schedule() {
  local dropin=$TIMER_DROPIN_DIR
  mkdir -p "$dropin"
  # OnCalendar with the market time zone: the backup runs at that wall-clock time whatever the server's zone
  printf '[Timer]\nOnCalendar=\nOnCalendar=*-*-* %s:00 %s\n' "$OP_TIME" "$OP_TZ" >"$dropin/schedule.conf"
  printf 'KEEP_DAYS=%s\n' "$OP_KEEP_DAYS" >"$OPS_DIR/schedule.env"
  systemctl daemon-reload
  systemctl restart marketly-backup.timer
  "$NODE" "$HELPER" schedule "$OPS_DIR" "$OP_TIME" "$OP_KEEP_DAYS" "$OP_TZ"
  chgrp "$MARKETLY_USER" "$OPS_DIR/schedule.json"
  status "$OP_ID" done --message "Nightly backup at $OP_TIME ($OP_TZ), kept $OP_KEEP_DAYS days"
}

# Oldest request first, until none are left (requests arriving meanwhile are taken in the same run)
while true; do
  next=$(ls -1tr "$REQUESTS"/*.json 2>/dev/null | head -n 1 || true)
  [ -n "$next" ] || break
  OP_ID='' OP_KIND='' OP_BACKUP_ID='' OP_UPLOAD_ID='' OP_TIME='' OP_KEEP_DAYS='' OP_TZ='' OP_ERROR=''
  parsed=$("$NODE" "$HELPER" parse "$next") && ok=1 || ok=0
  eval "$parsed"
  if [ "$ok" -ne 1 ]; then
    warn "refused $(basename "$next"): ${OP_ERROR:-not a valid request}"
    [ -n "$OP_ID" ] && status "$OP_ID" failed --request "$next" --message "Refused: ${OP_ERROR:-not a valid request}"
    rm -f "$next"
    continue
  fi
  info "$(date '+%F %T') $OP_KIND $OP_ID"
  status "$OP_ID" running --request "$next"
  rm -f "$next"
  log=$(mktemp)
  # run outside any if/&&/||: there bash would ignore set -e inside the subshell and carry on after a failure
  set +e
  ( set -euo pipefail; "run_$OP_KIND" ) 2>"$log"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    info "$(date '+%F %T') $OP_KIND $OP_ID done"
  else
    reason=$(grep -v '^\s*$' "$log" | tail -n 1 | sed 's/^ERROR: //' | cut -c1-300)
    warn "$OP_KIND $OP_ID failed: $reason"
    status "$OP_ID" failed --message "Failed: ${reason:-see journalctl -u marketly-ops}"
    # a failed restore must not leave the server stopped
    [ "$OP_KIND" = restore ] && systemctl start marketly || true
  fi
  cat "$log" >&2
  rm -f "$log"
done
