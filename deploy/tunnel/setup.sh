#!/bin/sh
# One time setup for a NAMED Cloudflare Tunnel.
#
#   sh deploy/tunnel/setup.sh blink.utkarshbahuguna.me
#
# Named, not a quick tunnel. A quick tunnel gets a random *.trycloudflare.com
# hostname that changes on every restart, which is useless when a post links to
# it. A named tunnel has a stable hostname and a credentials file that survives
# reboots.
#
# Run this once. After it, `run.sh` is the only thing you use.

set -eu

HOSTNAME_ARG="${1:?usage: setup.sh blink.your-domain.com}"
TUNNEL_NAME="${TUNNEL_NAME:-blink}"
LOCAL_PORT="${LOCAL_PORT:-8787}"
CFG_DIR="$HOME/.cloudflared"

say() { printf '\n[tunnel] %s\n' "$1"; }

say "1. cloudflared"
if ! command -v cloudflared >/dev/null 2>&1; then
  ARCH=$(dpkg --print-architecture 2>/dev/null || echo amd64)
  curl -fsSL -o /tmp/cloudflared.deb \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb"
  sudo dpkg -i /tmp/cloudflared.deb
  rm -f /tmp/cloudflared.deb
fi
cloudflared --version

say "2. authenticate"
# Opens a browser. Pick the zone for your domain. Writes ~/.cloudflared/cert.pem,
# which is what authorises creating tunnels and DNS routes for that zone.
if [ ! -f "$CFG_DIR/cert.pem" ]; then
  cloudflared tunnel login
else
  echo "  already authenticated (cert.pem exists)"
fi

say "3. named tunnel: $TUNNEL_NAME"
if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  echo "  tunnel already exists, reusing it"
else
  cloudflared tunnel create "$TUNNEL_NAME"
fi

TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1}' | head -1)
if [ -z "$TUNNEL_ID" ]; then
  echo "could not determine the tunnel id. Run: cloudflared tunnel list" >&2
  exit 1
fi
echo "  id: $TUNNEL_ID"

say "4. config"
mkdir -p "$CFG_DIR"
cat > "$CFG_DIR/config.yml" <<CFG
# Written by deploy/tunnel/setup.sh. Edit here, not by hand elsewhere.
tunnel: ${TUNNEL_ID}
credentials-file: ${CFG_DIR}/${TUNNEL_ID}.json

ingress:
  - hostname: ${HOSTNAME_ARG}
    service: http://127.0.0.1:${LOCAL_PORT}
    originRequest:
      # The launch page holds a connection while an instance starts, which takes
      # about 6 s warm and longer cold. The default timeout is shorter than that
      # and would cut the request off mid launch.
      connectTimeout: 30s
      noTLSVerify: false
  # Everything not matching the hostname above is refused rather than proxied.
  - service: http_status:404
CFG
echo "  wrote $CFG_DIR/config.yml"

say "5. DNS"
# A named tunnel's target, <id>.cfargotunnel.com, has NO public DNS record. It
# resolves only inside Cloudflare's edge, so the hostname MUST be served from a
# zone on Cloudflare nameservers with the record proxied. A CNAME pointing at it
# from Namecheap's own DNS will not resolve at all.
#
# This is checked rather than assumed, because the failure is a hostname that
# silently does not exist.
NS=$(dig +short NS "$(echo "$HOSTNAME_ARG" | cut -d. -f2-)" 2>/dev/null | head -1)
case "$NS" in
  *cloudflare*)
    echo "  zone is on Cloudflare nameservers, creating the route"
    cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_ARG" || \
      echo "  route already exists, or create it by hand as a proxied CNAME to ${TUNNEL_ID}.cfargotunnel.com"
    ;;
  *)
    cat <<DNS

  STOP. The zone is NOT on Cloudflare nameservers (found: ${NS:-none}).

  A named tunnel cannot work from Namecheap DNS. Its target,
  ${TUNNEL_ID}.cfargotunnel.com, has no public DNS record: it resolves only
  inside Cloudflare's network, so the record has to live in Cloudflare DNS and
  be proxied.

  What to do, once, and it keeps the portfolio working:

    1. Cloudflare dashboard -> Add a site -> utkarshbahuguna.me -> Free plan.
    2. Cloudflare imports your existing records. CHECK THEM before continuing,
       especially the GitHub Pages A records and any CNAME for www.
    3. Cloudflare shows two nameservers. At Namecheap: Domain List -> Manage
       -> Nameservers -> Custom DNS, and enter those two.
    4. Wait for Cloudflare to report the zone active. Usually minutes.
    5. Set the GitHub Pages records to DNS only (grey cloud). Pages does its
       own TLS and proxying them breaks it.
    6. Re-run this script. It will create the blink record itself.

  Nothing about your portfolio changes: the same records, served by a different
  nameserver.

DNS
    exit 1
    ;;
esac

say "done. Next: sh deploy/tunnel/run.sh"
