#!/usr/bin/env bash
# Checks the Marketly server and prints one line per check: OK, WARN (look at it soon) or FAIL (broken now).
#
#   sudo marketly check        (or: sudo bash /opt/marketly/current/deploy/linux/check.sh)
#
# Exit status 1 when anything FAILs, so it can also run from cron or a monitoring tool.
# No "set -e": a failing check is reported and the next one still runs.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need_root

failed=0
ok() { printf 'OK    %s\n' "$*"; }
warn_line() { printf 'WARN  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  failed=1
}

[ -f "$ENV_FILE" ] || {
  fail "no settings file $ENV_FILE (run install.sh)"
  exit 1
}
admin_url=$(env_value "$ENV_FILE" ADMIN_URL)
host=$(url_host "$admin_url")
port=$(env_value "$ENV_FILE" PORT)
health_port=$(env_value "$ENV_FILE" HEALTH_PORT)
cert=$(env_value "$ENV_FILE" TLS_CERT_FILE)
ca=$TLS_DIR/marketly-root-ca.crt

# ---------------------------------------------------------------- services
for unit in mongod marketly marketly-backup.timer; do
  if systemctl is-active --quiet "$unit"; then ok "$unit is running"; else fail "$unit is not running (systemctl status $unit)"; fi
done
release=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)
[ -n "$release" ] && ok "release $(basename "$release")"

# ---------------------------------------------------------------- HTTPS, as a staff PC sees it (through this machine)
if [ -f "$ca" ]; then
  # --resolve: connect to this machine but check the certificate for the real name
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --cacert "$ca" --resolve "$host:${port:-443}:127.0.0.1" "https://$host:${port:-443}/" 2>&1)
  if [ "$code" = 200 ]; then ok "$admin_url answers over HTTPS (Admin Center page, certificate valid)"; else fail "$admin_url: $code"; fi
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --cacert "$ca" --resolve "$host:${port:-443}:127.0.0.1" "https://$host:${port:-443}/api/admin/identity/staff" 2>&1)
  if [ "$code" = 401 ]; then ok "the API refuses a request without a token (401)"; else fail "the API answered $code without a token (expected 401)"; fi
else
  fail "no root certificate $ca (run make-cert.sh)"
fi

# ---------------------------------------------------------------- internal health port
health=$(curl -sS --max-time 5 "http://127.0.0.1:${health_port:-4001}/health" 2>&1)
if [[ $health == *'"status":"ok"'* ]]; then ok "health: $health"; else fail "health port ${health_port:-4001}: $health"; fi

# ---------------------------------------------------------------- MongoDB replica set
uri=$(env_value "$ENV_FILE" MONGODB_URI)
if command -v mongosh >/dev/null; then
  state=$(mongosh "$uri" --quiet --eval 'rs.status().members.find(m => m.self).stateStr' 2>&1 | tail -n 1)
  if [ "$state" = PRIMARY ]; then ok "MongoDB is PRIMARY of its replica set"; else fail "MongoDB replica set state: $state"; fi
else
  warn_line "mongosh is not installed: MongoDB's state not checked (package mongodb-mongosh)"
fi

# ---------------------------------------------------------------- disk space
for dir in /var/lib/mongodb "$MEDIA_DIR" "$BACKUP_DIR"; do
  [ -d "$dir" ] || continue
  used=$(df -P "$dir" | awk 'NR==2 { gsub("%", "", $5); print $5 }')
  free=$(df -Ph "$dir" | awk 'NR==2 { print $4 }')
  if [ "$used" -ge 95 ]; then fail "disk of $dir is $used% full ($free free)"
  elif [ "$used" -ge 85 ]; then warn_line "disk of $dir is $used% full ($free free)"
  else ok "disk of $dir: $used% used, $free free"; fi
done

# ---------------------------------------------------------------- last backup
newest=$(ls -1t "$BACKUP_DIR"/*.archive.gz 2>/dev/null | head -n 1)
if [ -z "$newest" ]; then
  warn_line "no backup yet in $BACKUP_DIR (the first runs at 02:30; now: sudo systemctl start marketly-backup)"
else
  age_hours=$((($(date +%s) - $(stat -c %Y "$newest")) / 3600))
  if [ "$age_hours" -gt 48 ]; then fail "last backup is $age_hours hours old: $newest (journalctl -u marketly-backup)"
  elif [ "$age_hours" -gt 26 ]; then warn_line "last backup is $age_hours hours old: $newest"
  else ok "last backup $age_hours h ago: $(basename "$newest")"; fi
fi

# ---------------------------------------------------------------- certificate expiry
if [ -n "$cert" ] && [ -f "$cert" ]; then
  end=$(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2)
  days=$((($(date -d "$end" +%s) - $(date +%s)) / 86400))
  if [ "$days" -lt 0 ]; then fail "HTTPS certificate expired on $end: run make-cert.sh, then systemctl restart marketly"
  elif [ "$days" -lt 30 ]; then warn_line "HTTPS certificate expires in $days days ($end): run make-cert.sh, then systemctl restart marketly"
  else ok "HTTPS certificate valid for $days more days (until $end)"; fi
else
  fail "no HTTPS certificate ${cert:-(TLS_CERT_FILE not set)}"
fi

exit $failed
