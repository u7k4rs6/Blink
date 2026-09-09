#!/bin/sh
# One command, laptop to running Blink.
#
#   sh deploy/deploy.sh root@1.2.3.4 blink.example
#
# Packages the repo, copies it, provisions the host, and restarts the service.
# Safe to run repeatedly: that is the point. A deploy you are reluctant to repeat
# is one you will patch by hand, and then the host stops matching the repo.
#
# It NEVER copies secrets. /etc/blink/blink.env is created from the example on
# the host and you fill it in there, so nothing sensitive passes through this
# script, your shell history, or the tarball.

set -eu

HOST="${1:?usage: deploy.sh user@host [domain]}"
DOMAIN="${2:-}"
TARBALL=/tmp/blink-deploy.tar.gz

echo "[deploy] packaging"
# Deliberately excludes .env, node_modules, and every local run artefact. The
# host installs its own dependencies and keeps its own state.
tar czf "$TARBALL" \
  --exclude=.git --exclude=node_modules --exclude=.env \
  --exclude=docs/gates/data --exclude=docs/soak \
  package.json package-lock.json tsconfig.json src scripts deploy examples \
  docs/00-verification.md README.md

echo "[deploy] copying to $HOST"
scp -q "$TARBALL" "$HOST:/tmp/blink.tar.gz"
ssh "$HOST" 'mkdir -p /opt/blink && tar xzf /tmp/blink.tar.gz -C /opt/blink'

echo "[deploy] provisioning"
ssh "$HOST" 'sh /opt/blink/deploy/provision.sh'

if [ -n "$DOMAIN" ]; then
  echo "[deploy] caddy for $DOMAIN"
  ssh "$HOST" "command -v caddy >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl && \
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && \
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list && \
    apt-get update -qq && apt-get install -y -qq caddy)"
  ssh "$HOST" "sed 's/blink.example/${DOMAIN}/' /opt/blink/deploy/Caddyfile > /etc/caddy/Caddyfile && systemctl reload caddy || systemctl restart caddy"
fi

echo "[deploy] restarting blink"
# The unit sends SIGTERM and waits 45 s. The server settles every live instance,
# writes their receipts and drains the warm pool before exiting, so a deploy in
# the middle of the day does not leak sandboxes.
ssh "$HOST" 'systemctl restart blink && sleep 3 && systemctl is-active blink'

echo "[deploy] recent log"
ssh "$HOST" 'journalctl -u blink -n 20 --no-pager'

rm -f "$TARBALL"
cat <<'DONE'

[deploy] done. Check the log above for:

    [ledger] durable: Postgres. Reservations survive a restart.

If it says memory, DATABASE_URL is not set correctly on the host, the daily
ceiling will reset on every restart, and the health wall will say so publicly.
DONE
