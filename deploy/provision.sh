#!/bin/sh
# Provision a fresh Debian or Ubuntu host for Blink.
#
# Idempotent: safe to run twice. Every step checks before acting, because a
# provisioning script you are afraid to re-run is one you will edit by hand
# instead, and then the host stops matching the file.
#
#   scp -r deploy blink.tar.gz root@HOST:/tmp/
#   ssh root@HOST 'sh /tmp/deploy/provision.sh'
#
# It does NOT write secrets. /etc/blink/blink.env is created empty and you fill
# it in yourself, because a secret that passes through a script passes through
# your shell history.

set -eu

NODE_VERSION="${NODE_VERSION:-v22.23.2}"
APP_DIR=/opt/blink
STATE_DIR=/var/lib/blink

say() { printf '\n[provision] %s\n' "$1"; }

say "user and directories"
id blink >/dev/null 2>&1 || useradd --system --home "$STATE_DIR" --shell /usr/sbin/nologin blink
mkdir -p "$APP_DIR" "$STATE_DIR" /etc/blink
chown -R blink:blink "$STATE_DIR"

say "node ${NODE_VERSION}"
if ! /usr/bin/node --version 2>/dev/null | grep -q "${NODE_VERSION}"; then
  TARBALL="node-${NODE_VERSION}-linux-x64.tar.xz"
  cd /tmp
  curl -fsSL -O "https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" -o SHASUMS256.txt
  # Verify only our line: the file lists every platform and sha256sum -c fails
  # on the ones that are absent.
  grep " ${TARBALL}$" SHASUMS256.txt | sha256sum -c -
  tar xf "${TARBALL}" -C /opt
  ln -sf "/opt/node-${NODE_VERSION}-linux-x64/bin/node" /usr/bin/node
  ln -sf "/opt/node-${NODE_VERSION}-linux-x64/bin/npm" /usr/bin/npm
  rm -f "${TARBALL}" SHASUMS256.txt
fi
/usr/bin/node --version

say "application"
if [ -f /tmp/blink.tar.gz ]; then
  tar xzf /tmp/blink.tar.gz -C "$APP_DIR" --strip-components=1
  chown -R root:root "$APP_DIR"
fi
[ -d "$APP_DIR/node_modules" ] || (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)

say "secrets file"
if [ ! -f /etc/blink/blink.env ]; then
  cp "$APP_DIR/deploy/blink.env.example" /etc/blink/blink.env
  echo "  created /etc/blink/blink.env from the example. FILL IT IN before starting."
fi
chown blink:blink /etc/blink/blink.env
chmod 600 /etc/blink/blink.env

say "systemd"
cp "$APP_DIR/deploy/blink.service" /etc/systemd/system/blink.service
systemctl daemon-reload
systemctl enable blink

say "firewall"
# Only 22 and 443 reach the internet. The app listens on localhost and Caddy
# terminates TLS in front of it, so 8787 is never exposed.
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  ufw status | head -8
fi

say "done. Next:"
cat <<'NEXT'
  1. Fill in /etc/blink/blink.env  (SOLARI_API_KEY, DATABASE_URL, TURNSTILE_SECRET)
  2. Install Caddy and point it at 127.0.0.1:8787 (see deploy/Caddyfile)
  3. systemctl start blink && journalctl -u blink -f

  The log should say:
    [ledger] durable: Postgres. Reservations survive a restart.

  If it says memory instead, DATABASE_URL is wrong and the daily ceiling will
  reset on every restart. The health wall discloses this publicly, so it is
  visible rather than silent, but it is still wrong for a host.
NEXT
