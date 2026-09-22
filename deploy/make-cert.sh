#!/usr/bin/env bash
# HTTPS for Plane Transit on a home server, from a private certificate authority.
#
#   ./deploy/make-cert.sh            # create the CA once, (re)issue the server cert, ship it
#   ./deploy/make-cert.sh --info     # show the CA fingerprint and the cert's expiry
#
# Why: browsers only allow geolocation and the screen wake lock in a secure context,
# and http://<pi>.local is not one. Why a private CA rather than a self-signed cert:
# once its root is installed on your devices, the page opens with no warnings at all.
#
# Two safety properties, both deliberate:
#  - The CA is NAME-CONSTRAINED to this host and its /24 subnet. A root certificate on
#    your phone can normally vouch for any site at all — bank included — so a leaked
#    key would be a serious problem. Browsers reject anything this CA signs outside the
#    permitted names, so even a leaked key cannot impersonate anything else.
#  - The CA private key stays on THIS machine ($CA_DIR, outside the repo). Only the
#    server certificate and its own key go to the server.
#
# The names and address are asked of the server itself (hostname, LAN address); set
# the PLANE_TRANSIT_TLS_* variables below to override. Note that the subnet is fixed into
# the CA when it is first created.
set -euo pipefail

HOST="${PLANE_TRANSIT_HOST:-pi}"                              # ssh alias or address of the server
CA_DIR="${PLANE_TRANSIT_CA_DIR:-$HOME/.plane-transit-ca}"
TLS_PORT="${PLANE_TRANSIT_TLS_PORT:-8443}"
HTTP_PORT="${PLANE_TRANSIT_PORT:-8321}"
SERVER_DAYS=825     # Apple rejects TLS server certificates valid for longer than this

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
fingerprint() { openssl x509 -in "$1" -noout -fingerprint -sha256 | sed 's/.*=//'; }

if [ "${1:-}" = "--info" ]; then
  [ -f "$CA_DIR/ca.crt" ] || die "no CA yet in $CA_DIR — run without --info first"
  say "CA:      $(openssl x509 -in "$CA_DIR/ca.crt" -noout -subject | sed 's/subject=//')"
  say "SHA-256: $(fingerprint "$CA_DIR/ca.crt")"
  say "expires: $(openssl x509 -in "$CA_DIR/ca.crt" -noout -enddate | sed 's/.*=//')"
  say "allows:  $(openssl x509 -in "$CA_DIR/ca.crt" -noout -ext nameConstraints | grep -E '^ *(DNS|IP):' | tr -d ' ' | paste -sd ' ' -)"
  [ -f "$CA_DIR/server.crt" ] && say "server cert expires: $(openssl x509 -in "$CA_DIR/server.crt" -noout -enddate | sed 's/.*=//')"
  exit 0
fi

command -v openssl >/dev/null || die "openssl not found"
remote() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "$@"; }
remote true 2>/dev/null \
  || die "cannot ssh to '$HOST' (set PLANE_TRANSIT_HOST; a Raspberry Pi on wifi may drop the first attempt — retry)"

SHORT="${PLANE_TRANSIT_TLS_SHORT:-$(remote hostname -s)}"      # bare hostname, if your router resolves it
NAME="${PLANE_TRANSIT_TLS_NAME:-$SHORT.local}"                  # what you type in the browser
IP="${PLANE_TRANSIT_TLS_IP:-$(remote "ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p'")}"
[ -n "$IP" ] || die "could not find $HOST's LAN address — set PLANE_TRANSIT_TLS_IP"
SUBNET="${PLANE_TRANSIT_TLS_SUBNET:-${IP%.*}.0/255.255.255.0}"  # what the CA may ever sign for
REMOTE_DIR="${PLANE_TRANSIT_TLS_DIR:-$(remote 'echo $HOME')/.config/plane-transit/tls}"

mkdir -p "$CA_DIR"
chmod 700 "$CA_DIR"

# ---- the CA, created once and kept ------------------------------------------------
if [ ! -f "$CA_DIR/ca.key" ]; then
  say "creating a private CA in $CA_DIR (constrained to $NAME, $SHORT, $SUBNET)"
  (umask 077; openssl ecparam -name prime256v1 -genkey -noout -out "$CA_DIR/ca.key")
  openssl req -x509 -new -key "$CA_DIR/ca.key" -sha256 -days 3650 \
    -subj "/CN=Plane Transit home CA ($SHORT)/O=Plane Transit" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "nameConstraints=critical,permitted;DNS:$NAME,permitted;DNS:$SHORT,permitted;IP:$SUBNET" \
    -addext "subjectKeyIdentifier=hash" \
    -out "$CA_DIR/ca.crt"
else
  say "reusing the CA in $CA_DIR"
fi

# ---- the server certificate, reissued every run -----------------------------------
say "issuing a server certificate for $NAME, $SHORT, $IP ($SERVER_DAYS days)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
(umask 077; openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/server.key")
openssl req -new -key "$WORK/server.key" -subj "/CN=$NAME" -out "$WORK/server.csr"
cat > "$WORK/ext.cnf" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:$NAME,DNS:$SHORT,IP:$IP
authorityKeyIdentifier=keyid
subjectKeyIdentifier=hash
EOF
openssl x509 -req -in "$WORK/server.csr" -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" \
  -CAcreateserial -days "$SERVER_DAYS" -sha256 -extfile "$WORK/ext.cnf" \
  -out "$WORK/server.crt" 2>/dev/null
openssl verify -CAfile "$CA_DIR/ca.crt" "$WORK/server.crt" >/dev/null \
  || die "the new certificate does not verify against the CA — is $IP outside the subnet
  the CA was created for? (make-cert.sh --info shows it)"
cp "$WORK/server.crt" "$CA_DIR/server.crt"      # a copy for --info; the key is not kept

# ---- ship it ------------------------------------------------------------------------
say "installing into $HOST:$REMOTE_DIR"
ssh "$HOST" "mkdir -p '$REMOTE_DIR' && chmod 700 '$REMOTE_DIR'"
scp -q "$WORK/server.crt" "$CA_DIR/ca.crt" "$HOST:$REMOTE_DIR/"
scp -q "$WORK/server.key" "$HOST:$REMOTE_DIR/server.key"
ssh "$HOST" "chmod 600 '$REMOTE_DIR/server.key'; chmod 644 '$REMOTE_DIR/server.crt' '$REMOTE_DIR/ca.crt'"

if ssh "$HOST" "systemctl is-enabled --quiet plane-transit 2>/dev/null"; then
  ssh "$HOST" "sudo systemctl restart plane-transit"
  sleep 2
  ssh "$HOST" "journalctl -u plane-transit -n 5 --no-pager | grep -i https" || true
else
  say "plane-transit is not installed as a service yet — run ./deploy/deploy.sh"
fi

cat <<EOF

$(say "done")
  Open:      https://$NAME:$TLS_PORT   (or https://$IP:$TLS_PORT)
  Install the CA on each device once, from http://$NAME:$HTTP_PORT/plane-transit-ca.crt
  Its SHA-256 fingerprint — compare it on the device before you trust it:
    $(fingerprint "$CA_DIR/ca.crt")
  Per-device steps: DEPLOY.md, "HTTPS".
EOF
