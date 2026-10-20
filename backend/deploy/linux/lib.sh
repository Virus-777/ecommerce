# Shared settings and helpers for the Marketly server scripts (sourced by install.sh, rollback.sh, make-cert.sh,
# backup.sh, restore.sh, check.sh and the marketly command). Not run on its own.
#
# Where everything lives on the server:
#   /opt/marketly/releases/<name>   each installed release (code, node_modules, admin/), owned by root
#   /opt/marketly/current           symlink to the release that runs; /opt/marketly/previous: the one before
#   /etc/marketly/marketly.env      settings and keys (owner marketly, mode 600)
#   /etc/marketly/tls/              HTTPS certificate and key; tls/ca/ holds the local root CA (root only)
#   /var/lib/marketly/media         uploaded files
#   /var/backups/marketly           daily backups (database, media, settings), 14 days (Admin Center → Settings)
#   /var/lib/marketly/ops           the backup service's requests and status (Admin Center → Backups)
#   /var/lib/marketly/backup-uploads backups uploaded in the Admin Center, until restored

MARKETLY_USER=marketly
OPT_DIR=/opt/marketly
RELEASES_DIR=$OPT_DIR/releases
CURRENT_LINK=$OPT_DIR/current
PREVIOUS_LINK=$OPT_DIR/previous
# MARKETLY_ETC_DIR only for trying the scripts elsewhere (the server always uses /etc/marketly)
ETC_DIR=${MARKETLY_ETC_DIR:-/etc/marketly}
ENV_FILE=$ETC_DIR/marketly.env
TLS_DIR=$ETC_DIR/tls
CA_DIR=$TLS_DIR/ca
DATA_DIR=/var/lib/marketly
MEDIA_DIR=$DATA_DIR/media
BACKUP_DIR=/var/backups/marketly
# the backup service (ops.sh): requests from the server and their status; backups uploaded in the Admin Center
OPS_DIR=$DATA_DIR/ops
UPLOAD_DIR=$DATA_DIR/backup-uploads
OPS_LOCK=/run/marketly-ops.lock
# where ops.sh writes the nightly time from Settings (a drop-in of marketly-backup.timer)
TIMER_DROPIN_DIR=/etc/systemd/system/marketly-backup.timer.d

info() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

need_root() {
  [ "$(id -u)" -eq 0 ] || die "run this as root: sudo bash $0 $*"
}

# The value of KEY in an env file (KEY=value or KEY='value'); empty when missing or commented out
env_value() {
  local file=$1 key=$2 line
  line=$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1) || true
  line=${line#*=}
  line=${line#\'}
  line=${line%\'}
  printf '%s' "$line"
}

# Sets KEY=value in an env file (replaces the line, or appends it). Only for simple values (no quotes, no |).
set_env_value() {
  local file=$1 key=$2 value=$3
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

# The node binary the service runs (README: Node.js 22 LTS unpacked into /usr/local)
node_bin() {
  command -v node || die "Node.js is not installed (deploy/linux/README.md, step 2)"
}

# Runs a production tool (dist/tools/<name>.js) of a release as the service user, with the server's settings,
# from the release folder (the caller's folder, e.g. /root, may be closed to that user)
run_tool() {
  local release=$1 tool=$2 node
  shift 2
  node=$(node_bin)
  (cd "$release" && runuser -u "$MARKETLY_USER" -- "$node" --enable-source-maps --env-file="$ENV_FILE" "$release/dist/tools/$tool.js" "$@")
}

# The host name in a URL (https://marketly.lan:8443/x -> marketly.lan)
url_host() {
  local rest=${1#*://}
  rest=${rest%%/*}
  printf '%s' "${rest%:*}"
}

# A mongodb:// URI without the database name (mongodump --oplog and mongorestore work on the whole server):
# mongodb://host/marketly?replicaSet=rs0 -> mongodb://host/?replicaSet=rs0
server_uri_of() {
  local uri=$1 base query hosts
  base=${uri%%\?*}
  query=${uri#"$base"}
  hosts=${base#mongodb://}
  hosts=${hosts%%/*}
  printf 'mongodb://%s/%s' "$hosts" "$query"
}
