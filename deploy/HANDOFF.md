# Host handoff

Everything needed to take a bare Ubuntu box to a running Blink with a soak on it.
Written so the order is fixed and nothing waits on me.

## What I need from you, in order

| When | What | Why |
|---|---|---|
| 1 | The host's `user@ip` | So `deploy.sh` can reach it |
| 2 | The domain, if you have one pointed at the box | Caddy needs it for a certificate. Skip it and the site serves on the IP over plain HTTP, which is fine for a soak but not for the recording |
| 3 | Confirmation that `/etc/blink/blink.env` is filled in | I never see it. The deploy creates it empty and stops |
| 4 | The first-boot checklist result below | A misconfigured host eats a night of wall clock, and the checklist is five minutes |

Nothing else. I do not need the API key, the database URL, or the Turnstile
secret at any point.

## 1. One command

```sh
sh deploy/deploy.sh root@1.2.3.4 blink.example
```

Packages the repo, copies it, installs Node 22 checksum-verified, installs
dependencies, writes the systemd unit, configures the firewall, installs Caddy
for the domain, and restarts the service. Idempotent: run it again for every
subsequent deploy.

**It never copies secrets.** `/etc/blink/blink.env` is created from the example
on the host, and you fill it in there.

### Drain on restart

The unit sends `SIGTERM` and waits 45 seconds. On that signal the server:

1. settles every live instance, writing each one a real receipt
2. drains the warm pool, killing every parked fork
3. reports what it did, then exits

A parked warm fork holds no slot and costs nothing while paused, which is exactly
why nothing would notice one that survived a restart. It would sit there until
somebody read a bill. Hence the explicit drain rather than relying on the
platform timeout.

If the drain cannot finish in 40 seconds it exits anyway and says so, and
`npm run sweep` cleans up.

## 2. Environment variables to set on the host

In `/etc/blink/blink.env`, mode 600, owned by `blink`. **Names only. I do not
need any of these values and should never see them.**

**Required:**

| Variable | Consequence if missing |
|---|---|
| `SOLARI_API_KEY` | The catalog and health wall still serve; launching is refused with a message saying why |
| `DATABASE_URL` | The ledger falls back to memory, the daily ceiling resets on every restart, and the health wall discloses it publicly |
| `TURNSTILE_SECRET` | Every launch is refused. Turnstile fails closed by design, because it is the only thing between an anonymous visitor and a machine with unrestricted egress (Q5, V57) |

**Optional, all with measured defaults in the source:**

`BLINK_LIFETIME_MS`, `BLINK_PLATFORM_TIMEOUT_MS`, `BLINK_HEARTBEAT_MS`,
`BLINK_CANARY_INTERVAL_MS`, `BLINK_WEB_CEILING_USD`, `BLINK_POOL_DEPTH`,
`BLINK_PLAN`.

**Do not set `BLINK_TURNSTILE_DISABLED` on the host.** It exists for local
development. Setting it in production removes the abuse control entirely.

`TZ=UTC` is set by the systemd unit, not by this file. It is required: the server
refuses launches without it, because a non-UTC process files every ledger row
under the wrong day and the daily ceiling silently resets early.

## 3. First-boot checklist

Five minutes, before the soak. A misconfigured host costs a night.

```sh
ssh root@HOST
systemctl is-active blink                 # active
journalctl -u blink -n 30 --no-pager
```

**In the log, look for exactly this line:**

```
[ledger] durable: Postgres. Reservations survive a restart.
```

If it says `memory` instead, stop and fix `DATABASE_URL`. The soak will run, but
its ledger drift figure will be meaningless.

Then:

```sh
curl -s localhost:8787/health | grep -o 'Ledger store: [^<.]*'   # Postgres
curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/         # 200
date -u                                                          # sanity
cd /opt/blink && npm run sweep                                    # Live sandboxes: 0
```

| Check | Expected | If wrong |
|---|---|---|
| `systemctl is-active blink` | `active` | `journalctl -u blink -n 50` |
| ledger line | `durable: Postgres` | `DATABASE_URL` is wrong |
| `/health` | 200, ledger says Postgres | as above |
| `/` | 200 | check the log |
| `npm run sweep` | `Live sandboxes: 0` | something leaked; investigate before soaking |
| a real launch | reaches HANDOVER | Turnstile or the key |

**Do the real launch by hand once** before the soak. Open the site, press Launch,
confirm the timer reaches `in your browser`, then press Destroy and confirm the
receipt shows arithmetic. That single click exercises Turnstile, the slot guard,
the ledger, the heartbeat and the kill path together, and it is the difference
between a soak that measures the product and one that measures a broken config.

## 4. The soak, on the host

Detached, skipping both rehearsals since the deliberate kill and the restart have
already passed:

```sh
cd /opt/blink
sudo -u blink env \
  TZ=UTC \
  BLINK_SOAK_INTERVAL_MS=3600000 \
  BLINK_SOAK_DURATION_MS=86400000 \
  BLINK_SOAK_KILL_TICK=99 \
  BLINK_SOAK_RESTART_TICK=99 \
  BLINK_SOAK_CEILING_USD=0.35 \
  nohup npm run soak --silent > /var/lib/blink/soak.log 2>&1 &
```

24 hours, hourly ticks, roughly $0.06 total.

Watch it:

```sh
tail -f /var/lib/blink/soak.log
cat /opt/blink/docs/soak/soak.md      # regenerated after every tick
```

**The report is readable at any point**, so a soak interrupted at hour nine still
leaves an account of the first nine hours.

**Do not run anything else against the same Solari account while it soaks.** A
concurrent sandbox from another process is what killed a twelve hour run once:
the reconciler saw a sandbox it did not recognise and reacted. That specific
bug is fixed (foreign sandboxes are now reported and left alone), but the general
rule stands, because the soak is measuring an account and anything else on it is
noise in the measurement.

## What the soak is for

The gate is **24 continuous hours**, not 24 hours accumulated. The report prints
both numbers and never merges them. This host run is the first that can produce
the continuous one, which is the whole reason for moving it off the laptop.
