#!/bin/sh
# Start Blink, the watchdog and the tunnel together. Stop all three cleanly.
#
#   sh deploy/tunnel/run.sh
#
# Ctrl+C, SIGTERM and SIGHUP all take the same path: drain, then exit. The drain
# is the same 45 seconds the systemd unit had, and it matters MORE here, not
# less. A tunnel dropping while instances are live is the same leak as a server
# dying, and this machine can be closed, suspended or OOM killed at any moment.

set -eu

cd "$(dirname "$0")/../.."
PORT="${PORT:-8787}"
DRAIN_SECONDS="${DRAIN_SECONDS:-45}"
LOG_DIR="${LOG_DIR:-/tmp/blink-run}"
mkdir -p "$LOG_DIR"

# ---------------------------------------------------------------------------
# Memory ceiling
# ---------------------------------------------------------------------------
# This laptop has about 11 GiB and OOMs with VS Code open. Node's default heap
# on such a machine is roughly a quarter of RAM, which is far more than Blink
# needs and enough to make the server the biggest process on the box, and so the
# first thing the OOM killer takes.
#
# 512 MB is generous: the server holds page strings, an instance map and a
# Postgres pool. If it ever approaches this it is a leak, and a heap error
# naming the ceiling is a far better failure than the kernel killing the process
# with no message and no drain.
NODE_MEM_MB="${NODE_MEM_MB:-512}"
export NODE_OPTIONS="--max-old-space-size=${NODE_MEM_MB}"

export TZ=UTC

# Environment files, in order, later ones winning. Defaults to ./.env.
#
# BLINK_ENV_FILES lets the key live somewhere other than this repo, which is
# how it works on this machine: the Solari key is shared with another project
# and is deliberately not copied here. A secret copied into a second file is a
# secret with two places to leak from and two places to forget to rotate.
#
#   BLINK_ENV_FILES="$HOME/other/.env:./.env" sh deploy/tunnel/run.sh
for F in $(printf '%s' "${BLINK_ENV_FILES:-./.env}" | tr ':' ' '); do
  if [ -f "$F" ]; then
    set -a; . "$F"; set +a
    echo "[run] loaded env from $F"
  fi
done

if [ -z "${SOLARI_API_KEY:-}" ]; then
  cat >&2 <<'MISSING'
SOLARI_API_KEY is not set, so every launch would be refused.

Set it in ./.env, or point at the file that has it:

  BLINK_ENV_FILES="$HOME/Desktop/thrice/.env:./.env" sh deploy/tunnel/run.sh

MISSING
  exit 2
fi

say() { printf '\n[run] %s\n' "$1"; }

# ---------------------------------------------------------------------------
# Sweep BEFORE serving
# ---------------------------------------------------------------------------
# If the last run was OOM killed or the lid was closed, sandboxes from it may
# still be alive and billing. Killing them before accepting a single new launch
# is the cheapest thing this script does.
# Keep one generation of each log. These are opened with `>`, so a restart
# truncates them, and Restart=on-failure means the restart happens 60 seconds
# after the failure: the log that explains why the tunnel died is destroyed by
# the retry it triggered. That is how the boot race below stayed invisible.
for f in tunnel blink watchdog; do
  [ -s "$LOG_DIR/$f.log" ] && mv -f "$LOG_DIR/$f.log" "$LOG_DIR/$f.prev.log"
done

say "sweeping orphans from any previous run"
npm run sweep --silent || echo "  sweep failed; continuing, the watchdog will retry"

say "starting watchdog"
# Started FIRST and killed LAST. It is the thing that cleans up if the server
# dies, so it must outlive the server on both ends.
# setsid, so each child leads its own process group and `kill -TERM -PGID`
# reaches the actual node process.
#
# The first version killed $! from `npm run`, which is the npm wrapper. npm
# spawns a shell which spawns node, so the wrapper died and node kept running:
# the script printed "[run] stopped" while Blink was still serving, and the
# drain never reached it. With a live instance that is a leaked sandbox and a
# shutdown that reports success.
setsid npm run watchdog --silent > "$LOG_DIR/watchdog.log" 2>&1 &
WATCHDOG_PID=$!

say "starting blink on 127.0.0.1:${PORT} (heap ceiling ${NODE_MEM_MB} MB)"
setsid env PORT="$PORT" npm run web --silent > "$LOG_DIR/blink.log" 2>&1 &
BLINK_PID=$!

# Wait for it to answer before opening the tunnel, so the first visitor never
# hits a tunnel pointing at nothing.
i=0
while [ $i -lt 40 ]; do
  if curl -sf -m 2 -o /dev/null "http://127.0.0.1:${PORT}/"; then break; fi
  sleep 0.5
  i=$((i + 1))
done
if ! curl -sf -m 2 -o /dev/null "http://127.0.0.1:${PORT}/"; then
  echo "blink did not answer on ${PORT}. Log:" >&2
  tail -20 "$LOG_DIR/blink.log" >&2
  kill "$BLINK_PID" "$WATCHDOG_PID" 2>/dev/null || true
  exit 1
fi
grep -m1 '\[ledger\]' "$LOG_DIR/blink.log" || true

# Wait for the internet, not for network-online.target.
#
# This unit carries After=network-online.target, and in a USER unit that target
# is the user manager's own, which nothing orders against real connectivity. So
# at boot the tunnel started 1 second after the service did, could not reach the
# Cloudflare edge, and exited on its own two seconds later. run.sh correctly
# shut the rest down and exited non-zero, systemd correctly restarted it 60
# seconds later, and by then the network was up. Every reboot therefore cost a
# 60 second public outage that every local signal recorded as a clean recovery.
#
# cloudflared needs DNS and egress. Ask for both, rather than trusting an
# ordering dependency that does not mean what it reads as.
say "waiting for outbound connectivity"
i=0
while [ $i -lt 60 ]; do
  if curl -sf -m 3 -o /dev/null https://www.cloudflare.com/cdn-cgi/trace; then break; fi
  sleep 1
  i=$((i + 1))
done
if ! curl -sf -m 3 -o /dev/null https://www.cloudflare.com/cdn-cgi/trace; then
  echo "no outbound connectivity after 60s; not starting the tunnel" >&2
  kill "$BLINK_PID" "$WATCHDOG_PID" 2>/dev/null || true
  exit 1
fi
say "starting tunnel"
setsid cloudflared tunnel --config "$HOME/.cloudflared/config.yml" run > "$LOG_DIR/tunnel.log" 2>&1 &
TUNNEL_PID=$!

# shutdown [exit_code]
#
# The code is load bearing, not decoration. This used to `exit 0` on every path,
# including the path taken when Blink had died on its own. Under systemd that
# means a crash drains tidily and then reports success, so `Restart=on-failure`
# never fires and the site stays down until somebody notices by hand. The unit
# said it had crash recovery; the recovery could not fire. Requested stops
# (SIGTERM from systemctl, Ctrl+C) still exit 0, because those are not failures
# and should not be restarted.
shutdown() {
  rc="${1:-0}"
  say "draining, up to ${DRAIN_SECONDS}s"

  # Tunnel FIRST: stop new visitors arriving before settling what is here. The
  # reverse order would let somebody launch an instance during the drain.
  kill -TERM -"$TUNNEL_PID" 2>/dev/null || kill "$TUNNEL_PID" 2>/dev/null || true

  # SIGTERM to Blink triggers its own drain: every live instance is settled with
  # a receipt and the warm pool is emptied.
  kill -TERM -"$BLINK_PID" 2>/dev/null || kill "$BLINK_PID" 2>/dev/null || true
  i=0
  while [ $i -lt "$DRAIN_SECONDS" ] && pgrep -f "node src/web/server.ts" >/dev/null 2>&1; do
    sleep 1
    i=$((i + 1))
  done
  if pgrep -f "node src/web/server.ts" >/dev/null 2>&1; then
    echo "  blink did not drain in ${DRAIN_SECONDS}s, forcing" >&2
    kill -9 -"$BLINK_PID" 2>/dev/null || kill -9 "$BLINK_PID" 2>/dev/null || true
  fi

  # A final sweep while the watchdog is still up, so anything the drain missed
  # is killed now rather than at the next start.
  npm run sweep --silent || true
  kill -TERM -"$WATCHDOG_PID" 2>/dev/null || kill "$WATCHDOG_PID" 2>/dev/null || true

  say "stopped"
  exit "$rc"
}
# A signal is a request to stop, so it is not a failure: exit 0 and stay stopped.
trap 'shutdown 0' INT TERM HUP

cat <<INFO

  blink     pid $BLINK_PID     $LOG_DIR/blink.log
  watchdog  pid $WATCHDOG_PID  $LOG_DIR/watchdog.log
  tunnel    pid $TUNNEL_PID    $LOG_DIR/tunnel.log

  Ctrl+C drains and stops all three.

INFO

# Watch all three, not just Blink.
#
# This watched the server alone. If the TUNNEL died the loop kept spinning, so
# systemd reported the service active, 127.0.0.1:8787 answered 200, and the
# public site served the offline page to every visitor. Every local signal green
# and the site down: the same shape as a health check passing on a setup wizard.
#
# The watchdog counts too. It is the backstop that reaps sandboxes the drain
# missed, and a leaked sandbox bills by the hour, so losing it silently is a
# money problem rather than an availability one.
dead=""
while [ -z "$dead" ]; do
  kill -0 "$BLINK_PID" 2>/dev/null && pgrep -f "node src/web/server.ts" >/dev/null 2>&1 || dead="blink"
  [ -n "$dead" ] || kill -0 "$TUNNEL_PID" 2>/dev/null || dead="tunnel"
  [ -n "$dead" ] || kill -0 "$WATCHDOG_PID" 2>/dev/null || dead="watchdog"
  [ -n "$dead" ] || sleep 2
done

echo "[run] $dead exited on its own; shutting down the rest" >&2
case "$dead" in
  blink) tail -20 "$LOG_DIR/blink.log" >&2 ;;
  tunnel) tail -20 "$LOG_DIR/tunnel.log" >&2 ;;
  watchdog) tail -20 "$LOG_DIR/watchdog.log" >&2 ;;
esac
# Non-zero, so systemd treats this as the failure it is and restarts.
shutdown 1
