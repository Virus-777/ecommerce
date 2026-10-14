# Running Marketly on one offline Linux server

This is the step-by-step for the production server: **one Ubuntu Server machine** (22.04 or 24.04 LTS, x86-64)
with **no internet access**, used by **staff only** on the local network. It runs everything:

- **MongoDB 6.0** (the database), reachable from this machine only;
- **the Marketly server** (one process): the API, the scheduled jobs, and the Admin Center web pages, all on one
  HTTPS address such as `https://marketly.lan`;
- **daily backups** at 02:30.

HTTPS uses a certificate made on the server itself. Each staff PC trusts the server's root certificate once (step 6).
HTTPS is required, not optional: the browser keeps the staff sign-in cookie only over HTTPS.

Everything that must be downloaded is downloaded on another computer with internet access (step 1) and carried to
the server on a USB stick.

| What | Where on the server |
|---|---|
| Installed releases (code) | `/opt/marketly/releases/<name>`; `/opt/marketly/current` is the one that runs, `/opt/marketly/previous` the one before |
| Settings and keys | `/etc/marketly/marketly.env` (secret: never copy it anywhere unsafe) |
| HTTPS certificate | `/etc/marketly/tls/` (`server.crt`, `server.key`, `marketly-root-ca.crt`; the root's key in `ca/`) |
| Uploaded files | `/var/lib/marketly/media` |
| Database files | `/var/lib/mongodb` (MongoDB's own) |
| Backups | `/var/backups/marketly` (14 days) |
| Logs | `journalctl -u marketly` (server), `journalctl -u marketly-backup` (backups), `/var/log/mongodb/mongod.log` |

The scripts are in this folder (`deploy/linux/`, also at `/opt/marketly/current/deploy/linux/` once installed):

| Script | What it does |
|---|---|
| `install.sh` | installs a release (the first one and every update) |
| `make-cert.sh` | makes the HTTPS certificate (first install, and before it expires) |
| `check.sh` | checks everything (`sudo marketly check`) |
| `backup.sh`, `restore.sh` | one backup now, restore a backup |
| `rollback.sh` | back to the previous release |
| `marketly` | the everyday command, installed as `/usr/local/bin/marketly`: `sudo marketly help` |
| `marketly.service`, `marketly-backup.service`, `marketly-backup.timer` | the systemd units install.sh installs |
| `mongod.conf` | MongoDB's settings (install.sh puts it in place) |

---

## 1. On a computer with internet access: download everything

Put all of this on a USB stick.

1. **Node.js 22 LTS for Linux x64**, the `.tar.xz` file, from <https://nodejs.org/en/download> (choose
   "Linux", "x64", "Standalone binary"), for example `node-v22.20.0-linux-x64.tar.xz`. Any newer LTS (24) works too.
2. **MongoDB 6.0.29** for your Ubuntu version, from the MongoDB download centre
   (<https://www.mongodb.com/try/download/community>: version 6.0.29, platform Ubuntu 22.04 x64 (or 24.04),
   package `server`), and the tools from <https://www.mongodb.com/try/download/shell> and
   <https://www.mongodb.com/try/download/database-tools>. You need these three `.deb` files:
   - `mongodb-org-server_6.0.29_amd64.deb` (the database server, `mongod`)
   - `mongodb-mongosh_<version>_amd64.deb` (the shell, `mongosh`: check.sh uses it)
   - `mongodb-database-tools-ubuntu2204-x86_64-<version>.deb` (or `ubuntu2404`; `mongodump` and `mongorestore`:
     the backups use them)

   MongoDB publishes 6.0 for Ubuntu 22.04 ("jammy"), not for 24.04: **use Ubuntu Server 22.04 LTS** for this
   server. (On 24.04 the 22.04 packages may install, but MongoDB does not support that combination.)
3. **The Marketly release**, made from this repository on the development PC:

   ```bash
   cd admin-center && npm run build                 # in the frontend project: the Admin Center (admin-center/dist)
   cd backend && npm run package -- --admin <path to admin-center/dist>
   ```

   This makes `backend/release/marketly-<version>-<commit>.tar.gz` (about 15 MB). Without `--admin` the release
   shows a placeholder page instead of the Admin Center.

The server itself needs nothing else: `openssl`, `curl`, `tar` and systemd are part of Ubuntu Server.

## 2. On the server: install Node.js

Copy the files from the USB stick to your home folder (for example `~/install`), then:

```bash
cd ~/install
sudo tar -xJf node-v22.*-linux-x64.tar.xz -C /usr/local --strip-components=1
node --version            # v22.…
```

## 3. Install MongoDB

```bash
sudo apt install ./mongodb-org-server_6.0.29_amd64.deb ./mongodb-mongosh_*_amd64.deb ./mongodb-database-tools-*.deb
```

(`apt install ./file.deb` works offline: it installs the files given. If it asks for a missing Ubuntu package,
that package is on the Ubuntu installation medium.) You don't need to configure MongoDB: install.sh replaces
`/etc/mongod.conf` with [`mongod.conf`](mongod.conf) (this machine only, replica set `rs0`, keeping the original as
`/etc/mongod.conf.before-marketly`) and starts it.

## 4. Install Marketly

```bash
cd ~/install
tar -xzf marketly-0.1.0-abc1234.tar.gz
sudo bash marketly-0.1.0-abc1234/deploy/linux/install.sh
```

The first time, install.sh:

- creates the system user `marketly` (no login) and the folders in the table above;
- creates `/etc/marketly/marketly.env` from [`.env.production.example`](../../.env.production.example) and writes
  new keys into it (`npm run prod:keys`: the token signing key, its public key and `APP_SECRET`);
- sets MongoDB up as the replica set `rs0` (`prod:db-setup`) and creates the database's collections and indexes
  (`prod:migrate`);
- installs the systemd units (server, daily backup timer) and the `marketly` command.

It does not start the server yet: there is no certificate. It tells you so.

**Choose the address** staff will type, for example `marketly.lan`, and put it in the settings:

```bash
sudo nano /etc/marketly/marketly.env
```

Change `https://marketly.lan` on the seven lines `ADMIN_URL`, `API_URL`, `STORE_URL`, `SELLER_URL`,
`CORS_ADMIN_ORIGINS`, `CORS_STORE_ORIGINS`, `CORS_SELLER_ORIGINS` if you chose another name. Keep `https://`; no
slash at the end. Leave the key lines (`AUTH_SIGNING_JWK`, `AUTH_JWKS`, `APP_SECRET`) as they are. Every other line
has a comment saying what it does.

## 5. Make the HTTPS certificate

With the address you chose and the server's IP address on the LAN (`hostname -I` shows it):

```bash
sudo bash /opt/marketly/current/deploy/linux/make-cert.sh marketly.lan 192.168.1.20
sudo systemctl start marketly
sudo marketly check
```

make-cert.sh makes a root certificate authority on this server (valid 10 years; its private key never leaves
`/etc/marketly/tls/ca/`) and signs the server's certificate with it (valid 825 days). It prints the expiry date and
the same staff instructions as step 6.

`sudo marketly check` should print only `OK` lines, except "no backup yet" until the first night.

## 6. Prepare each staff PC (once per PC)

1. **Trust the root certificate.** Copy `/etc/marketly/tls/marketly-root-ca.crt` to a USB stick
   (`sudo cp /etc/marketly/tls/marketly-root-ca.crt /media/$USER/<stick>/`), then on each PC:
   - **Windows:** double-click `marketly-root-ca.crt` > *Install Certificate* > *Local Machine* > *Place all
     certificates in the following store* > *Browse* > *Trusted Root Certification Authorities* > *Finish*.
     Or, in a command prompt opened as administrator: `certutil -addstore -f ROOT marketly-root-ca.crt`.
     Chrome and Edge use this store.
   - **macOS:** double-click the file (Keychain Access opens; choose the *System* keychain), open the certificate,
     *Trust* > *When using this certificate: Always Trust*.
   - **Firefox** (any system) keeps its own list: *Settings* > *Privacy & Security* > *Certificates* > *View
     Certificates* > *Authorities* > *Import*, and tick *Trust this CA to identify websites*.
   - Restart the browser.
2. **Let the PC find the name.** Either add the name to the LAN's DNS (most routers have a "local DNS" or "static
   host" page: `marketly.lan` → `192.168.1.20`), or add one line to each PC's hosts file:
   - Windows: open Notepad as administrator, open `C:\Windows\System32\drivers\etc\hosts`, add
     `192.168.1.20  marketly.lan`, save.
   - macOS: `sudo nano /etc/hosts`, add the same line.
3. Open `https://marketly.lan` : the Admin Center opens with a padlock and no warning. A warning means step 1 or
   the name is wrong (the certificate must be for exactly the name in the address bar).

## 7. Create the first Business Owners

On the server, for the owner and a deputy (two people from day one, so every two-person rule works):

```bash
sudo marketly bootstrap-owner --email olivia@company.example --name "Olivia Hart" \
  --deputy-email daniel@company.example --deputy-name "Daniel Reyes"
```

It prints a link and a pass code per person. Hand both over in person; each opens the link on their PC, types the
pass code and chooses a password. They then invite the other staff from *Admin Center > Staff*, and every invited
person gets their link and pass code from the server:

```bash
sudo marketly staff-link --email ana@company.example                     # new link + pass code, or a password reset link
sudo marketly staff-link --email ana@compnay.example --revoke "Mistyped email"
```

(`docs/MAINTAINING.md` §7 explains each case. In the release folder the same tools are
`npm run prod:bootstrap-owner -- …` and `npm run prod:staff-link -- …`, run as the `marketly` user.)

---

## Daily operation

### Checking

```bash
sudo marketly check
```

One line per check: the services, the HTTPS address (certificate trusted, Admin Center page, the API refusing a
request without a token), the internal health port, MongoDB being `PRIMARY`, free disk space, the age of the last
backup, and the certificate's expiry. `WARN` means: look at it soon; `FAIL`: something is broken now.

### Logs

```bash
sudo marketly logs                                  # the server, live (Ctrl+C to stop)
journalctl -u marketly --since "1 hour ago"         # a period
journalctl -u marketly -p err --since today         # errors only
journalctl -u marketly-backup -n 20                 # the last backup
```

Each request has an `X-Request-Id`; staff can quote it from an error message, and `journalctl -u marketly | grep <id>`
finds it.

### Backups

Every night at 02:30 (`systemctl list-timers marketly-backup.timer` shows the next run) `backup.sh` writes three
files to `/var/backups/marketly`:

- `<date>.archive.gz`: the whole database (`mongodump --archive --gzip --oplog`, consistent at one moment);
- `<date>.media.tar.gz`: the uploaded files;
- `<date>.config.tar.gz`: `/etc/marketly`, the settings with the keys and the certificates. A restored database
  needs the same `APP_SECRET`, so keep this file with the backups, and keep it as safe as a password.

Backups older than 14 days are deleted. They are on the same disk as the data, so **copy them off the server
every week**: plug in a USB disk, then

```bash
sudo rsync -a /var/backups/marketly/ /media/$USER/<disk>/marketly-backups/
```

A backup now: `sudo marketly backup`.

**Restoring** (after a mistake, or on a new server): this replaces the whole database and the uploaded files with
the backup; everything since is lost.

```bash
ls -lt /var/backups/marketly
sudo bash /opt/marketly/current/deploy/linux/restore.sh /var/backups/marketly/2026-10-15_0230.archive.gz
```

On a **new server**, unpack the settings first so the same keys are used, then install, then restore:
`sudo tar -xzf <date>.config.tar.gz -C /etc`, then steps 2–4 (install.sh keeps the existing settings), then
`restore.sh`.

### Updating to a new release

On the development PC: `npm run package -- --admin <admin-center/dist>`. On the server:

```bash
sudo marketly backup                                    # a backup from just before the update
tar -xzf marketly-0.2.0-def5678.tar.gz
sudo bash marketly-0.2.0-def5678/deploy/linux/install.sh
sudo marketly check
```

install.sh applies the new release's database changes while the old release still runs, switches
`/opt/marketly/current`, restarts the server (a few seconds of downtime) and keeps the previous release.
Your settings in `/etc/marketly/marketly.env` are kept. If a new release adds a setting, its
`.env.production.example` (in the release folder) shows it with its comment: copy the line into your settings.

### Going back to the previous release

```bash
sudo marketly rollback
```

It switches `/opt/marketly/current` back and restarts. Running it again goes forward again. The database is not
rolled back: a newer release's schema changes stay. They usually only add things the older release ignores; if not,
restore the backup made before the update.

### Renewing the certificate

The server certificate lasts 825 days; `sudo marketly check` warns 30 days before it ends. Then:

```bash
sudo bash /opt/marketly/current/deploy/linux/make-cert.sh marketly.lan 192.168.1.20
sudo systemctl restart marketly
```

The same root signs the new certificate, so staff PCs need nothing new. The root itself lasts 10 years. Don't let
the certificate expire: browsers refuse an expired certificate of an HTTPS-only site without a way to click
through.

Changing the server's name or IP address: run make-cert.sh with the new name and address, update the seven address
lines in `/etc/marketly/marketly.env`, restart, and update the DNS or hosts files.

### Rotating the token signing key

Rarely needed (only if `/etc/marketly/marketly.env` may have been copied by someone):

```bash
sudo marketly keys --rotate && sudo systemctl restart marketly
```

Nobody is signed out: the previous public key stays in `AUTH_JWKS` until the next rotation. `APP_SECRET` is
never rotated (stored pass codes, audit checkpoints and file links depend on it).

### Other commands

```bash
sudo systemctl status marketly            # running? since when?
sudo systemctl restart marketly           # after changing /etc/marketly/marketly.env
sudo systemctl stop marketly              # stop (it starts again at boot)
sudo marketly help
```

## When something is wrong

| Symptom | Look at |
|---|---|
| Browser warns about the certificate | the PC trusts the root (step 6.1)? the address is exactly the certificate's name? `sudo marketly check` (expiry) |
| Browser can't reach the address | the name resolves (`ping marketly.lan` on the PC)? `sudo marketly check`; firewall: `sudo ufw status` (allow 80 and 443: `sudo ufw allow 443/tcp`, `sudo ufw allow 80/tcp`) |
| The server does not start | `journalctl -u marketly -n 50 --no-pager`: a wrong setting is named in the message (the server checks every setting at startup) |
| `MongoDB … PRIMARY` fails | `systemctl status mongod`, `/var/log/mongodb/mongod.log`; `sudo marketly db-setup` shows the replica set |
| Disk full | old releases are removed automatically (three are kept); copy old backups off and delete them; `sudo du -sh /var/lib/mongodb /var/lib/marketly/media /var/backups/marketly` |

## How the pieces fit

- The server listens on `443` (HTTPS) and `80` (only redirects to `https://`), as the unprivileged user
  `marketly` (systemd gives it the one capability to bind ports below 1024). The health check listens on
  `127.0.0.1:4001` (plain HTTP, this machine only).
- `GET` requests outside `/api`, `/graphql`, `/files`, `/webhooks` are answered with the Admin Center's files
  (`ADMIN_APP_DIR`); the Admin Center then calls `/api` on the same address with sign-in tokens. Every `/api` and
  `/graphql` request needs a token.
- MongoDB listens on `127.0.0.1:27017` only, as a one-member replica set (Marketly uses transactions, which need a
  replica set). It has no password: only programs on this machine can reach it, so keep shell access to the server
  to the people who maintain it.
- The one Marketly process also runs the scheduled jobs (`JOBS_ENABLED=true`): search indexing, refunds, payouts,
  clean-ups. `DEPLOY_ID` (set by install.sh to the release name) makes the "once per release" jobs run once.
- systemd restarts the server if it crashes, and starts MongoDB and the server at boot.
