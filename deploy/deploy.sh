#!/usr/bin/env bash
# Deploy Plane Transit to a home server (a Raspberry Pi, say), and (re)install its
# systemd unit. Needs ssh with a key and passwordless sudo on the server.
#
#   ./deploy/deploy.sh                 # deploy to the ssh host "pi"
#   PLANE_TRANSIT_HOST=mypi.local ./deploy/deploy.sh
#   ./deploy/deploy.sh --status        # just report what is running there
#
# Deploys the working tree as it is — uncommitted changes included — because that is
# what you want when you are fixing something between two passes. It prints the git
# state so you know what you shipped.
set -euo pipefail

HOST="${PLANE_TRANSIT_HOST:-pi}"
PORT="${PLANE_TRANSIT_PORT:-8321}"
# The adsb.im feeder image serves its receiver's aircraft.json here (ultrafeeder/tar1090).
# Used only if the box answers on it; PLANE_TRANSIT_LOCAL_URL= (empty) turns it off.
ADSBIM_URL=http://localhost:8080/data/aircraft.json
TLS_PORT="${PLANE_TRANSIT_TLS_PORT:-8443}"
SERVICE=plane-transit
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

status() {
  ssh "$HOST" "systemctl is-active $SERVICE 2>/dev/null; systemctl is-enabled $SERVICE 2>/dev/null; \
    curl -fsS --max-time 5 http://localhost:$PORT/api/status 2>/dev/null \
      | head -c 2000 || echo '(no answer on :$PORT)'"
}

if [ "${1:-}" = "--status" ]; then say "status of $SERVICE on $HOST"; status; exit 0; fi

command -v rsync >/dev/null || die "rsync not installed locally"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null \
  || die "cannot ssh to '$HOST' (try: ssh $HOST, or set PLANE_TRANSIT_HOST). A Raspberry Pi
  on wifi may drop new connections while it sleeps — a second attempt usually gets through."

REMOTE_HOME=$(ssh "$HOST" 'echo $HOME')
DIR="${PLANE_TRANSIT_DIR:-$REMOTE_HOME/plane-transit}"
# Kept outside $DIR on purpose: rsync --delete would wipe a certificate living there.
TLS_DIR="${PLANE_TRANSIT_TLS_DIR:-$REMOTE_HOME/.config/plane-transit/tls}"

REMOTE_NODE=$(ssh "$HOST" 'command -v node || true')
[ -n "$REMOTE_NODE" ] || die "node is not installed on $HOST (sudo apt install -y nodejs)"

if [ -n "${PLANE_TRANSIT_LOCAL_URL+set}" ]; then
  LOCAL_URL="$PLANE_TRANSIT_LOCAL_URL"
else
  LOCAL_URL=$(ssh "$HOST" "curl -fsS --max-time 3 $ADSBIM_URL 2>/dev/null | grep -q '\"aircraft\"' && echo $ADSBIM_URL || true")
fi
say "local receiver: ${LOCAL_URL:-none}"

say "shipping $REPO → $HOST:$DIR"
git -C "$REPO" status --short | sed 's/^/    uncommitted: /' || true
say "commit $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '(none)')"

ssh "$HOST" "mkdir -p '$DIR'"
rsync -az --delete \
  --exclude '.git/' --exclude '.claude/' --exclude 'snap.png' --exclude 'node_modules/' \
  --exclude '.DS_Store' --exclude '*.local.md' --exclude 'docs/' --exclude 'test/' --exclude '.github/' \
  "$REPO/" "$HOST:$DIR/"

REMOTE_USER=$(ssh "$HOST" 'id -un')
say "installing $SERVICE unit (runs as $REMOTE_USER)"
ssh "$HOST" "sed -e 's|__USER__|$REMOTE_USER|g' -e 's|__DIR__|$DIR|g' -e 's|__PORT__|$PORT|g' \
      -e 's|__LOCAL_URL__|$LOCAL_URL|g' -e 's|__TLS_DIR__|$TLS_DIR|g' -e 's|__TLS_PORT__|$TLS_PORT|g' \
      '$DIR/deploy/plane-transit.service' \
      | sudo tee /etc/systemd/system/$SERVICE.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable $SERVICE >/dev/null
  sudo systemctl restart $SERVICE"

sleep 2
say "checking it came up"
ssh "$HOST" "systemctl is-active --quiet $SERVICE" \
  || { ssh "$HOST" "journalctl -u $SERVICE -n 30 --no-pager"; die "$SERVICE did not start"; }
ssh "$HOST" "curl -fsS --max-time 5 http://localhost:$PORT/api/status >/dev/null" \
  || die "$SERVICE is running but not answering on :$PORT"

PI_NAME="$(ssh "$HOST" hostname).local"
say "deployed. Open http://$PI_NAME:$PORT"
if ssh "$HOST" "test -f '$TLS_DIR/server.crt'"; then
  say "     or https://$PI_NAME:$TLS_PORT (location + screen wake lock work there)"
else
  say "     no HTTPS yet: ./deploy/make-cert.sh sets it up"
fi
say "logs: ssh $HOST journalctl -u $SERVICE -f"
