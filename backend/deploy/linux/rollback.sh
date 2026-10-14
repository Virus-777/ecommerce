#!/usr/bin/env bash
# Goes back to the release that ran before the last install (/opt/marketly/previous) and restarts the server.
# Running it again goes forward again (the two swap).
#
#   sudo bash /opt/marketly/current/deploy/linux/rollback.sh
#
# The database is not rolled back: schema changes of the newer release stay. They usually only add collections,
# fields and indexes, which the older release ignores. If the newer release changed data in a way the older one
# cannot read, restore the backup taken before the update instead (restore.sh).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need_root

current=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)
previous=$(readlink -f "$PREVIOUS_LINK" 2>/dev/null || true)
[ -n "$previous" ] && [ -d "$previous" ] || die "there is no previous release to go back to ($PREVIOUS_LINK)"
[ "$previous" != "$current" ] || die "the previous release is the current one ($current)"

info "Switching from $(basename "$current") to $(basename "$previous")"
ln -sfn "$previous" "$CURRENT_LINK.new"
mv -T "$CURRENT_LINK.new" "$CURRENT_LINK"
ln -sfn "$current" "$PREVIOUS_LINK"
set_env_value "$ENV_FILE" DEPLOY_ID "$(basename "$previous")"

# the unit file of the older release (node path, settings) applies again
sed "s|/usr/local/bin/node|$(node_bin)|g" "$previous/deploy/linux/marketly.service" >/etc/systemd/system/marketly.service
systemctl daemon-reload
systemctl restart marketly
sleep 3
if systemctl is-active --quiet marketly; then
  info "Running $(basename "$previous"). To go forward again: sudo bash $CURRENT_LINK/deploy/linux/rollback.sh"
else
  die "marketly did not start; see: journalctl -u marketly -n 50 --no-pager"
fi
