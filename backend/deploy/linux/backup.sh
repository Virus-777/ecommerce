#!/usr/bin/env bash
# One backup of everything Marketly needs to come back after a disk failure, into /var/backups/marketly:
#   <id>.archive.gz      the whole MongoDB (mongodump --archive --gzip --oplog: consistent at one moment)
#   <id>.media.tar.gz    the uploaded files (/var/lib/marketly/media)
#   <id>.config.tar.gz   /etc/marketly: settings, keys and certificates. APP_SECRET is in there; without it,
#                        stored pass codes, audit checkpoints and file links of a restored database do not work.
#                        Root only (mode 600): the Marketly server can't read it, so it can never be downloaded.
#   <id>.manifest.json   what kind of backup it is (nightly, manual, safety) and which Admin Center request made it
# <id> is the time stamp, e.g. 2026-10-15_023000. The database and uploaded-files files are readable by the
# marketly group (Admin Center → Backups lists and downloads them).
#
# Backups older than the days kept are deleted: 14, or what Admin Center → Settings → backups.keepDays says (the
# backup service writes it to /var/lib/marketly/ops/schedule.env). Run nightly by marketly-backup.timer; by hand:
#   sudo systemctl start marketly-backup      (or: sudo bash backup.sh)
# Environment (set by ops.sh): BACKUP_KIND (nightly), BACKUP_OPERATION (the request id), BACKUP_ID_FILE (gets the id).
#
# The backups are on the same disk as the data: copy /var/backups/marketly to a USB disk regularly (README,
# "Backups"), and keep that disk locked away: the settings backup holds the keys.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need_root
command -v mongodump >/dev/null || die "mongodump is not installed (package mongodb-database-tools, README step 3)"

KEEP_DAYS=14
if [ -f "$OPS_DIR/schedule.env" ]; then
  days=$(env_value "$OPS_DIR/schedule.env" KEEP_DAYS)
  [[ $days =~ ^[0-9]{1,3}$ ]] && [ "$days" -ge 3 ] && KEEP_DAYS=$days
fi
KIND=${BACKUP_KIND:-nightly}
case "$KIND" in nightly | manual | safety) ;; *) die "unknown backup kind $KIND" ;; esac
stamp=$(date +%Y-%m-%d_%H%M%S)
mkdir -p "$BACKUP_DIR"
chown root:"$MARKETLY_USER" "$BACKUP_DIR"
chmod 750 "$BACKUP_DIR"
umask 077

uri=$(env_value "$ENV_FILE" MONGODB_URI)
[ -n "$uri" ] || die "MONGODB_URI is not set in $ENV_FILE"
server_uri=$(server_uri_of "$uri")

info "$(date '+%F %T') backing up MongoDB to $BACKUP_DIR/$stamp.archive.gz"
mongodump --uri="$server_uri" --archive="$BACKUP_DIR/$stamp.archive.gz.part" --gzip --oplog --quiet
mv "$BACKUP_DIR/$stamp.archive.gz.part" "$BACKUP_DIR/$stamp.archive.gz"

info "$(date '+%F %T') backing up the uploaded files to $BACKUP_DIR/$stamp.media.tar.gz"
tar -czf "$BACKUP_DIR/$stamp.media.tar.gz.part" -C "$(dirname "$MEDIA_DIR")" "$(basename "$MEDIA_DIR")"
mv "$BACKUP_DIR/$stamp.media.tar.gz.part" "$BACKUP_DIR/$stamp.media.tar.gz"

info "$(date '+%F %T') backing up the settings and keys to $BACKUP_DIR/$stamp.config.tar.gz"
tar -czf "$BACKUP_DIR/$stamp.config.tar.gz.part" -C "$(dirname "$ETC_DIR")" "$(basename "$ETC_DIR")"
mv "$BACKUP_DIR/$stamp.config.tar.gz.part" "$BACKUP_DIR/$stamp.config.tar.gz"

"$(node_bin)" "$HERE/ops-request.mjs" manifest "$BACKUP_DIR" "$stamp" "$KIND" "${BACKUP_OPERATION:-}"

# the server lists and downloads the database and uploaded files; the settings and keys stay root only
chown root:"$MARKETLY_USER" "$BACKUP_DIR/$stamp.archive.gz" "$BACKUP_DIR/$stamp.media.tar.gz" "$BACKUP_DIR/$stamp.manifest.json"
chmod 640 "$BACKUP_DIR/$stamp.archive.gz" "$BACKUP_DIR/$stamp.media.tar.gz" "$BACKUP_DIR/$stamp.manifest.json"
chown root:root "$BACKUP_DIR/$stamp.config.tar.gz"
chmod 600 "$BACKUP_DIR/$stamp.config.tar.gz"

# keep KEEP_DAYS days (and never leave half-written files from an interrupted run)
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '*.archive.gz' -o -name '*.media.tar.gz' -o -name '*.config.tar.gz' -o -name '*.manifest.json' \) -mtime +$((KEEP_DAYS - 1)) -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.part' -mmin +600 -delete

[ -n "${BACKUP_ID_FILE:-}" ] && printf '%s' "$stamp" >"$BACKUP_ID_FILE"
info "$(date '+%F %T') backup $stamp done ($KIND):"
ls -lh "$BACKUP_DIR/$stamp".*
