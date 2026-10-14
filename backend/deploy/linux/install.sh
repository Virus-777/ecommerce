#!/usr/bin/env bash
# Installs the Marketly release this script belongs to, on this server. Run as root, from the unpacked release:
#
#   tar -xzf marketly-0.1.0-abc1234.tar.gz
#   sudo bash marketly-0.1.0-abc1234/deploy/linux/install.sh
#
# The first time it also creates the service user, the folders, the settings file with new keys
# (/etc/marketly/marketly.env), and MongoDB's replica set. Every time it:
#   1. copies the release to /opt/marketly/releases/<name>
#   2. applies the database schema of the new release (migrate) while the old one still runs
#   3. points /opt/marketly/current at the new release (/opt/marketly/previous keeps the old one: rollback.sh)
#   4. installs the systemd units and (re)starts the server
# Safe to run again with the same release.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need_root

SOURCE=$(cd "$HERE/../.." && pwd)
NAME=$(basename "$SOURCE")
[ -f "$SOURCE/dist/src/main.js" ] || die "$SOURCE is not a Marketly release (no dist/src/main.js): unpack the .tar.gz from npm run package and run its deploy/linux/install.sh"
case "$NAME" in marketly-*) ;; *) die "the release folder should be named marketly-<version>-<commit> (got $NAME)" ;; esac
TARGET=$RELEASES_DIR/$NAME
NODE=$(node_bin)
info "Installing $NAME with $NODE ($("$NODE" --version))"
node_major=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 22 ] || die "Node.js 22 or later is needed (found $("$NODE" --version))"

# ---------------------------------------------------------------- user and folders
if ! id "$MARKETLY_USER" >/dev/null 2>&1; then
  info "Creating the system user $MARKETLY_USER (no login, no password)"
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$MARKETLY_USER"
fi
mkdir -p "$RELEASES_DIR" "$MEDIA_DIR" "$BACKUP_DIR" "$TLS_DIR"
# settings, keys and the HTTPS key: readable by the service user only
chown "$MARKETLY_USER:$MARKETLY_USER" "$ETC_DIR" "$TLS_DIR" "$DATA_DIR" "$MEDIA_DIR"
chmod 700 "$ETC_DIR" "$TLS_DIR"
chmod 750 "$DATA_DIR" "$MEDIA_DIR"
chmod 700 "$BACKUP_DIR"
# settings unpacked from a backup of another server carry that server's user id: make them this server's
if [ -f "$TLS_DIR/server.key" ]; then
  chown "$MARKETLY_USER:$MARKETLY_USER" "$TLS_DIR/server.key" "$TLS_DIR/server.crt"
  chmod 600 "$TLS_DIR/server.key"
fi
[ -d "$CA_DIR" ] && chown -R root:root "$CA_DIR"

# ---------------------------------------------------------------- the release files (owned by root: the service cannot change its own code)
if [ "$SOURCE" != "$TARGET" ]; then
  info "Copying the release to $TARGET"
  rm -rf "$TARGET.new"
  cp -a "$SOURCE" "$TARGET.new"
  rm -rf "$TARGET"
  mv "$TARGET.new" "$TARGET"
fi
chown -R root:root "$TARGET"
chmod -R u=rwX,go=rX "$TARGET"
chmod 755 "$TARGET"/deploy/linux/*.sh "$TARGET/deploy/linux/marketly"
# npm run prod:* in the release folder reads .env.production: the server's settings
ln -sfn "$ENV_FILE" "$TARGET/.env.production"

# ---------------------------------------------------------------- settings and keys (first install)
FIRST_INSTALL=no
if [ ! -f "$ENV_FILE" ]; then
  FIRST_INSTALL=yes
  info "Creating $ENV_FILE from .env.production.example, with new keys"
  install -o "$MARKETLY_USER" -g "$MARKETLY_USER" -m 600 "$TARGET/.env.production.example" "$ENV_FILE"
  runuser -u "$MARKETLY_USER" -- "$NODE" "$TARGET/dist/tools/keys.js" --env "$ENV_FILE"
fi
chown "$MARKETLY_USER:$MARKETLY_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"
# "on boot" jobs run once per release
set_env_value "$ENV_FILE" DEPLOY_ID "$NAME"

# ---------------------------------------------------------------- MongoDB: running, as replica set rs0, on this machine only
[ -n "$(systemctl list-unit-files mongod.service --no-legend 2>/dev/null)" ] || die "MongoDB is not installed (deploy/linux/README.md, step 3)"
if ! grep -qE '^\s*replSetName:' /etc/mongod.conf 2>/dev/null; then
  info "Configuring MongoDB as replica set rs0 on 127.0.0.1 (the old /etc/mongod.conf is kept as /etc/mongod.conf.before-marketly)"
  if [ -f /etc/mongod.conf ] && [ ! -f /etc/mongod.conf.before-marketly ]; then
    cp /etc/mongod.conf /etc/mongod.conf.before-marketly
  fi
  install -m 644 "$TARGET/deploy/linux/mongod.conf" /etc/mongod.conf
  systemctl restart mongod
fi
systemctl enable --now mongod >/dev/null
# mongod needs a moment after a (re)start before it accepts connections; db-setup waits up to 10 s itself
for _ in 1 2 3 4 5 6 7 8 9 10; do
  systemctl is-active --quiet mongod && break
  sleep 1
done
info "MongoDB replica set:"
run_tool "$TARGET" db-setup

# ---------------------------------------------------------------- database schema of the new release
info "Applying the database schema (migrate)"
run_tool "$TARGET" migrate

# ---------------------------------------------------------------- switch to the new release
old=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)
if [ -n "$old" ] && [ "$old" != "$TARGET" ]; then
  ln -sfn "$old" "$PREVIOUS_LINK"
fi
ln -sfn "$TARGET" "$CURRENT_LINK.new"
mv -T "$CURRENT_LINK.new" "$CURRENT_LINK"
info "Current release: $NAME${old:+ (previous: $(basename "$old"))}"

# ---------------------------------------------------------------- systemd units and the marketly command
sed "s|/usr/local/bin/node|$NODE|g" "$TARGET/deploy/linux/marketly.service" >/etc/systemd/system/marketly.service
install -m 644 "$TARGET/deploy/linux/marketly-backup.service" /etc/systemd/system/marketly-backup.service
install -m 644 "$TARGET/deploy/linux/marketly-backup.timer" /etc/systemd/system/marketly-backup.timer
ln -sfn "$CURRENT_LINK/deploy/linux/marketly" /usr/local/bin/marketly
systemctl daemon-reload
systemctl enable marketly.service >/dev/null
systemctl enable --now marketly-backup.timer >/dev/null

# ---------------------------------------------------------------- keep the current, the previous and the newest other release
keep_current=$(readlink -f "$CURRENT_LINK")
keep_previous=$(readlink -f "$PREVIOUS_LINK" 2>/dev/null || true)
# shellcheck disable=SC2012 # release names have no spaces
for dir in $(ls -1dt "$RELEASES_DIR"/marketly-* 2>/dev/null | tail -n +4); do
  if [ "$dir" != "$keep_current" ] && [ "$dir" != "$keep_previous" ]; then
    info "Removing the old release $(basename "$dir")"
    rm -rf "$dir"
  fi
done

# ---------------------------------------------------------------- start
cert=$(env_value "$ENV_FILE" TLS_CERT_FILE)
if [ -n "$cert" ] && [ ! -f "$cert" ]; then
  info ""
  info "Installed $NAME. The server is not started yet: there is no HTTPS certificate ($cert)."
  info "Next (deploy/linux/README.md, step 5):"
  info "  1. Set your address in $ENV_FILE (ADMIN_URL ... CORS_SELLER_ORIGINS, default https://marketly.lan)"
  info "  2. sudo bash $CURRENT_LINK/deploy/linux/make-cert.sh <that name> <this server's IP>"
  info "  3. sudo systemctl start marketly && sudo marketly check"
  exit 0
fi
info "Restarting the server"
systemctl restart marketly
sleep 3
if systemctl is-active --quiet marketly; then
  info "marketly is running. Check everything: sudo marketly check"
else
  warn "marketly did not start. See why: journalctl -u marketly -n 50 --no-pager"
  warn "Back to the previous release: sudo bash $CURRENT_LINK/deploy/linux/rollback.sh"
  exit 1
fi
[ "$FIRST_INSTALL" = yes ] && info "First install: create the Business Owners next (README step 7): sudo marketly bootstrap-owner --email ... --name ..."
exit 0
