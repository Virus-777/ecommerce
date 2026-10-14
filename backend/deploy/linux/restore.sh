#!/usr/bin/env bash
# Restores a backup made by backup.sh: the database, and the uploaded files.
#
#   sudo bash restore.sh /var/backups/marketly/2026-10-15_0230.archive.gz
#
# WARNING: this REPLACES the whole Marketly database and the media folder with the backup. Everything done after
# the backup was taken (orders, staff changes, uploads) is lost. The server is stopped while it runs.
# Settings and keys (<date>.config.tar.gz) are not restored automatically: on a new server, unpack that file
# BEFORE installing (sudo tar -xzf <date>.config.tar.gz -C /etc), so the same APP_SECRET and keys are used.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need_root "$@"
command -v mongorestore >/dev/null || die "mongorestore is not installed (package mongodb-database-tools)"

ARCHIVE=${1:-}
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || die "usage: sudo bash restore.sh /var/backups/marketly/<date>.archive.gz   (ls -lt $BACKUP_DIR)"
case "$ARCHIVE" in *.archive.gz) ;; *) die "$ARCHIVE is not a database backup (<date>.archive.gz)" ;; esac
MEDIA=${ARCHIVE%.archive.gz}.media.tar.gz

echo "This replaces the WHOLE Marketly database with $ARCHIVE"
[ -f "$MEDIA" ] && echo "and the uploaded files with $MEDIA."
echo "Everything done since that backup is lost. The server stops during the restore."
read -r -p "Type RESTORE to continue: " answer
[ "$answer" = "RESTORE" ] || die "cancelled; nothing changed"

uri=$(env_value "$ENV_FILE" MONGODB_URI)
base=${uri%%\?*}
query=${uri#"$base"}
hosts=${base#mongodb://}
hosts=${hosts%%/*}
server_uri="mongodb://$hosts/$query"

systemctl stop marketly
info "Restoring the database (--drop: each collection is replaced by the backup's)"
mongorestore --uri="$server_uri" --archive="$ARCHIVE" --gzip --oplogReplay --drop
if [ -f "$MEDIA" ]; then
  info "Restoring the uploaded files"
  rm -rf "$MEDIA_DIR.before-restore"
  mv "$MEDIA_DIR" "$MEDIA_DIR.before-restore"
  tar -xzf "$MEDIA" -C "$(dirname "$MEDIA_DIR")"
  chown -R "$MARKETLY_USER:$MARKETLY_USER" "$MEDIA_DIR"
  info "The files from before the restore are in $MEDIA_DIR.before-restore (delete it when all is well)."
fi
# a backup from an older release may lack schema changes of the running one
run_tool "$(readlink -f "$CURRENT_LINK")" migrate
systemctl start marketly
info "Restored. Check: sudo marketly check"
