#!/usr/bin/env bash
# Makes the HTTPS certificate for the Marketly server, signed by a root certificate authority (CA) made on this
# server. Staff PCs trust that root once; after that every certificate it signs (renewals too) is trusted.
#
#   sudo bash make-cert.sh <dns-name> [<more names or IP addresses> ...]
#   sudo bash make-cert.sh marketly.lan 192.168.1.20
#
# Run it again before the certificate expires (check.sh shows the date): it signs a new server certificate with the
# same root, so staff PCs need nothing new. Then: sudo systemctl restart marketly
#
# Files (/etc/marketly/tls):
#   ca/marketly-root-ca.key   the root's private key: root only, never leaves this server (10 years)
#   marketly-root-ca.crt      the root certificate: the file staff PCs install (public)
#   server.key, server.crt    the server's key and certificate (at most 825 days: the limit Apple devices accept)
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
need_root "$@"
command -v openssl >/dev/null || die "openssl is not installed (it is part of Ubuntu Server: apt package openssl)"

[ $# -ge 1 ] || die "usage: sudo bash make-cert.sh <dns-name> [<more names or IP addresses> ...]   e.g. make-cert.sh marketly.lan 192.168.1.20"
DNS_NAME=$1
SERVER_DAYS=825
CA_DAYS=3650

# subjectAltName: every name and address staff may type
san=""
for item in "$@"; do
  if [[ $item =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ || $item =~ ^[0-9a-fA-F:]+:[0-9a-fA-F:]*$ ]]; then
    san+="${san:+,}IP:$item"
  elif [[ $item =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$ ]]; then
    san+="${san:+,}DNS:$item"
  else
    die "\"$item\" is neither a DNS name nor an IP address"
  fi
done
[[ $DNS_NAME =~ [A-Za-z] ]] || die "the first argument must be the DNS name staff will use (e.g. marketly.lan); add IP addresses after it"

id "$MARKETLY_USER" >/dev/null 2>&1 || die "run install.sh first (it creates the user $MARKETLY_USER)"
mkdir -p "$CA_DIR"
chown "$MARKETLY_USER:$MARKETLY_USER" "$TLS_DIR"
chmod 700 "$TLS_DIR"
chown root:root "$CA_DIR"
chmod 700 "$CA_DIR"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------- the root CA (made once, kept)
if [ ! -f "$CA_DIR/marketly-root-ca.key" ]; then
  info "Making the local root CA (valid $CA_DAYS days)"
  openssl req -x509 -new -sha256 -days "$CA_DAYS" -nodes \
    -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$WORK/ca.key" -out "$WORK/ca.crt" \
    -subj "/O=Marketly/CN=Marketly local root CA $(hostname) $(date +%Y-%m-%d)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash"
  install -o root -g root -m 600 "$WORK/ca.key" "$CA_DIR/marketly-root-ca.key"
  install -o root -g root -m 644 "$WORK/ca.crt" "$CA_DIR/marketly-root-ca.crt"
else
  info "Using the existing root CA ($CA_DIR): staff PCs that trust it need nothing new"
fi
install -o root -g root -m 644 "$CA_DIR/marketly-root-ca.crt" "$TLS_DIR/marketly-root-ca.crt"

# ---------------------------------------------------------------- the server certificate
cat >"$WORK/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=$san
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$WORK/server.key" -out "$WORK/server.csr" -subj "/CN=$DNS_NAME"
openssl x509 -req -sha256 -days "$SERVER_DAYS" -in "$WORK/server.csr" \
  -CA "$CA_DIR/marketly-root-ca.crt" -CAkey "$CA_DIR/marketly-root-ca.key" \
  -set_serial "0x$(openssl rand -hex 16)" -extfile "$WORK/server.ext" -out "$WORK/server.crt"
openssl verify -CAfile "$CA_DIR/marketly-root-ca.crt" "$WORK/server.crt" >/dev/null
install -o "$MARKETLY_USER" -g "$MARKETLY_USER" -m 600 "$WORK/server.key" "$TLS_DIR/server.key"
install -o "$MARKETLY_USER" -g "$MARKETLY_USER" -m 644 "$WORK/server.crt" "$TLS_DIR/server.crt"

expires=$(openssl x509 -in "$TLS_DIR/server.crt" -noout -enddate | cut -d= -f2)
info ""
info "Server certificate: $TLS_DIR/server.crt for $san"
info "  valid until $expires: run this script again before then, then: sudo systemctl restart marketly"
info ""
info "Root certificate for staff PCs: $TLS_DIR/marketly-root-ca.crt"
info "  Copy it to a USB stick (sudo cp $TLS_DIR/marketly-root-ca.crt /media/<stick>/) and on each staff PC, once:"
info "  - Windows: double-click the file > Install Certificate > Local Machine > Place all certificates in the"
info "    following store > Trusted Root Certification Authorities; or, in an administrator command prompt:"
info "    certutil -addstore -f ROOT marketly-root-ca.crt"
info "  - macOS: double-click (Keychain Access, System keychain), open the certificate > Trust > Always Trust"
info "  - Firefox has its own list: Settings > Privacy & Security > Certificates > View Certificates >"
info "    Authorities > Import, tick \"Trust this CA to identify websites\""
info "  - Ubuntu desktop: sudo cp marketly-root-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates"
info "  Then restart the browser."
info ""
info "Staff PCs must find $DNS_NAME: add it to the LAN's DNS (router), or to each PC's hosts file"
info "  (Windows: C:\\Windows\\System32\\drivers\\etc\\hosts, macOS/Linux: /etc/hosts), e.g.:  192.168.1.20  $DNS_NAME"

# the address in the settings must be one of the certificate's names
if [ -f "$ENV_FILE" ]; then
  admin_host=$(url_host "$(env_value "$ENV_FILE" ADMIN_URL)")
  if [[ ",$san," != *",DNS:$admin_host,"* && ",$san," != *",IP:$admin_host,"* ]]; then
    warn "ADMIN_URL in $ENV_FILE names $admin_host, which this certificate does not cover. Set ADMIN_URL, API_URL,"
    warn "STORE_URL, SELLER_URL and the CORS_*_ORIGINS lines to https://$DNS_NAME (or make the certificate for $admin_host)."
  fi
fi
info ""
info "Now: sudo systemctl restart marketly   (or start, the first time)"
