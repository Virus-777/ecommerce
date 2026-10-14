#!/usr/bin/env bash
# One backup of everything Marketly needs to come back after a disk failure, into /var/backups/marketly:
#   <date>.archive.gz      the whole MongoDB (mongodump --archive --gzip --oplog: consistent at one moment)
#   <date>.media.tar.gz    the uploaded files (/var/lib/marketly/media)
#   <date>.config.tar.gz   /etc/marketly: settings, keys and certificates. APP_SECRET is in there; without it,
#                          stored pass codes, audit checkpoints and file links of a restored database do not work.
# Backups older than 14 days are deleted. Run daily at 02:30 by marketly-backup.timer; by hand:
#   sudo systemctl start marketly-backup      (or: sudo bash backup.sh)
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
stamp=$(date +%Y-%m-%d_%H%M)
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
umask 077

# --oplog needs a dump of the whole server, so the URI without the database name: mongodb://host/?replicaSet=rs0
uri=$(env_value "$ENV_FILE" MONGODB_URI)
[ -n "$uri" ] || die "MONGODB_URI is not set in $ENV_FILE"
base=${uri%%\?*}
query=${uri#"$base"}
hosts=${base#mongodb://}
hosts=${hosts%%/*}
server_uri="mongodb://$hosts/$query"

info "$(date '+%F %T') backing up MongoDB to $BACKUP_DIR/$stamp.archive.gz"
mongodump --uri="$server_uri" --archive="$BACKUP_DIR/$stamp.archive.gz.part" --gzip --oplog --quiet
mv "$BACKUP_DIR/$stamp.archive.gz.part" "$BACKUP_DIR/$stamp.archive.gz"

info "$(date '+%F %T') backing up the uploaded files to $BACKUP_DIR/$stamp.media.tar.gz"
tar -czf "$BACKUP_DIR/$stamp.media.tar.gz.part" -C "$(dirname "$MEDIA_DIR")" "$(basename "$MEDIA_DIR")"
mv "$BACKUP_DIR/$stamp.media.tar.gz.part" "$BACKUP_DIR/$stamp.media.tar.gz"

info "$(date '+%F %T') backing up the settings and keys to $BACKUP_DIR/$stamp.config.tar.gz"
tar -czf "$BACKUP_DIR/$stamp.config.tar.gz.part" -C "$(dirname "$ETC_DIR")" "$(basename "$ETC_DIR")"
mv "$BACKUP_DIR/$stamp.config.tar.gz.part" "$BACKUP_DIR/$stamp.config.tar.gz"

# keep 14 days (and never leave half-written files from an interrupted run)
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '*.archive.gz' -o -name '*.media.tar.gz' -o -name '*.config.tar.gz' \) -mtime +$((KEEP_DAYS - 1)) -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.part' -mmin +600 -delete

info "$(date '+%F %T') backup done:"
ls -lh "$BACKUP_DIR/$stamp".*
