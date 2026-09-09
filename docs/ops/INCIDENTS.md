# Incident playbook

Written to be read when something is already wrong. Every entry starts with the
command, because that is what you need first.

## 1. The machine died uncleanly

Power loss, kernel panic, forced reboot, battery. **This is the expensive one.**

**Run this first, before anything else:**

```sh
cd ~/Desktop/Blink
set -a; . ~/Desktop/thrice/.env; . ./.env; set +a
npm run recover
```

It prints what Solari is running, which of those are ours, how long they have
been alive, and what leaving them costs per day. **It changes nothing.**

Then stop them:

```sh
npm run recover -- --kill
npm run sweep          # verify: Live sandboxes: 0
```

`--kill` kills our sandboxes, marks each row settled so the watchdog and the next
boot stop chasing them, and closes stale rows for instances that are already
gone. Sandboxes that are **not** ours are listed and never touched.

### Why this is the expensive case

An unclean death means no handler ran: no drain, no receipts, no kill calls. The
three expiry layers do not close the gap:

| Layer | Survives a power cut? |
|---|---|
| 1. In-process expiry timer | No. It died with the machine |
| 2. Guest self-destruct | Yes, but it kills the **app**, not the sandbox. The instance goes unusable and the sandbox keeps billing |
| 3. Platform idle timeout | Not reliably. Q17 measured that previewUrl traffic resets the idle clock |

The watchdog (`scripts/watchdog.ts`) covers a crashed **server**, because it is a
separate process that keeps running. It does **not** cover a dead **machine**,
because it dies with it.

**So after a power loss, nothing is killing those sandboxes until you run the
command above.** At $0.057/h that is about **$1.37 per sandbox per day**, bounded
only by the Starter concurrency limit of 2, so roughly **$2.74 a day** worst case.

Bounded, survivable, and entirely avoidable by running one command. That is why
it is the first entry in this file.

### If `--kill` reports failures

Re-run it. Kills are idempotent (V9), so a repeat is free. If ids keep failing,
they are printed: kill them by hand with the Solari console or

```sh
curl -X DELETE -H "Authorization: Bearer $SOLARI_API_KEY" \
  https://api.getsolari.com/sandboxes/<ID>
```

## 1a. The site shows the offline page and you do not know why

Once the Worker is deployed, every origin problem looks the same from outside: a
calm offline page. One command separates them.

```sh
curl -sI https://blink.utkarshbahuguna.me | grep -i '^x-blink'
```

| `x-blink-origin` | Meaning | Next |
|---|---|---|
| header absent | Origin is healthy, this is the real site | nothing |
| `no-origin` | Nothing listening: tunnel down, `run.sh` stopped, laptop asleep | `cloudflared tunnel info blink` |
| `timeout` | Accepted the connection, never answered: wedged or out of memory | `tail -30 /tmp/blink-run/blink.log`, check free memory |
| `origin-5xx` | Blink is awake and erroring | read the log, this is an app fault |

`x-blink-origin-ms` distinguishes further: a failure at 3 ms is refused, a
failure at 8000 ms is hung.

## 2. The tunnel is up but the site 502s

Blink died while `cloudflared` kept running. `run.sh` normally stops both
together, so this means the script itself was killed.

```sh
tail -30 /tmp/blink-run/blink.log
npm run recover            # check for orphans first
sh deploy/tunnel/run.sh    # restart everything cleanly
```

If the log ends with a heap error naming `--max-old-space-size`, that is the
memory ceiling doing its job: something leaked, and a named error is a better
outcome than a silent kill. Close applications and restart.

## 3. Blink was OOM killed

`journalctl -k | tail -20` shows `Out of memory: Killed process ... node`.

Same recovery as case 1, and then close things. The list is in
`deploy/tunnel/LAPTOP.md`. If available memory was under 3000 MB at start, that
is the cause.

## 4. The ledger says memory instead of Postgres

```sh
grep '\[ledger\]' /tmp/blink-run/blink.log
```

`DATABASE_URL` is wrong or Supabase is unreachable. The site still works and the
health wall discloses it publicly, but the daily ceiling resets on every restart.
Fix the URL and restart. Do not run a soak in this state: its drift figure would
be meaningless.

## 5. Launches are refused with a UTC message

The process is not running in UTC, so per-day ceilings would be mis-bucketed and
the server refuses rather than mis-charging. `run.sh` and the systemd unit both
set `TZ=UTC`; if you started the server by hand, that is why.

## 6. A canary row is red

Read what it asked, in the row itself. The checks describe themselves
(`created an issue and read it back`), so the row names the failure. If every row
for one app is red, the snapshot is broken rather than the platform: rebuild it
with `npm run snapshot:<app>`.

**Seen once already:** every Jaeger tick failed with `the UI is up but has no
traces` because the seeded traces had aged out of Jaeger's default query window
(V77). The fix was a `postFork` refresh, not a wider query.

## Routine check, worth doing daily

```sh
npm run sweep      # Live sandboxes: 0 when nothing should be running
npm run recover    # dry run: shows anything the ledger has lost track of
```
