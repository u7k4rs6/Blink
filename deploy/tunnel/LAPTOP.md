# Running Blink from a laptop

The site runs on the development machine behind a Cloudflare Tunnel. That is a
real constraint, not a temporary arrangement, and the consequences are written
down here rather than discovered.

## What to close before starting

This box has about 11 GiB and OOMs with VS Code open. Blink itself is small; the
danger is everything else.

| Close | Typical |
|---|---|
| VS Code, including its language servers | 2 to 4 GB |
| Chrome, or cut it to one window | 1 to 3 GB |
| Docker Desktop, if it ever ran | 1 to 2 GB |
| Slack, Discord, Spotify | 0.5 to 1.5 GB |

Check before starting:

```sh
free -m | awk '/Mem:/ {printf "available: %d MB\n", $7}'
```

**Under 3000 MB available, do not start.** Blink needs a few hundred, the tunnel
needs almost nothing, and the rest is headroom for the kernel not to start
killing things.

## Starting it so it outlives the terminal

Use the user service. It is `deploy/tunnel/blink.user.service`:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/tunnel/blink.user.service ~/.config/systemd/user/blink.service
$EDITOR ~/.config/systemd/user/blink.service   # WorkingDirectory, BLINK_ENV_FILES, PATH
systemctl --user daemon-reload
systemctl --user enable --now blink
systemctl --user status blink
journalctl --user -u blink -f
```

`run.sh` puts its three children in their own process group so it can drain
them, but `run.sh` itself is a child of whatever started it. Close the terminal,
or have the tool that opened it exit, and the whole tree goes: the site goes
down, the canary stops mid run, and any sandbox it had open is left for the next
start to sweep. This happened twice during a capture run and cost two
screenshots the first time. **`setsid` and `disown` are not enough** when the
parent is torn down by session or cgroup rather than by hangup, which is the
case here. systemd owns the process instead.

It is a user unit, not a system one, and lingering stays off. That is the honest
lifetime: the site is up while this machine is awake and logged in, which is
what the health wall says. Enabling lingering would make the service outlive the
login and quietly overstate the claim.

If `systemctl --user restart blink` starts refusing with **"start of the
service was attempted too often"**, that is `StartLimitBurst=5` in
`StartLimitIntervalSec=1800` doing its job. Manual restarts count toward the
same budget as crashes, so a run of edit-and-restart cycles trips it. Clear it:

```sh
systemctl --user reset-failed blink.service
systemctl --user start blink
```

Do not raise the limit to make this go away. It exists so a crash loop cannot
run a Solari sweep every 60 seconds indefinitely, and the site being down with a
visible failed unit is better than the site being down with a hidden one.

`TimeoutStopSec=90` is load bearing. `run.sh` drains for 45 seconds on SIGTERM,
and a shorter stop timeout would have systemd SIGKILL it mid drain, which is the
leak the drain exists to prevent.

### Starting it by hand instead

Only for a one off, and it still dies with its terminal:

```sh
mkdir -p /tmp/blink-run
setsid nohup env BLINK_ENV_FILES="$HOME/path/to/.env:./.env" \
  sh deploy/tunnel/run.sh > /tmp/blink-run/session.log 2>&1 < /dev/null &
disown
```

`/tmp/blink-run` has to exist first. `run.sh` removes it on a clean exit, so the
redirect on the next start fails before the script runs, and the failure looks
like the server simply not being there.

Confirm both ends, not one:

```sh
curl -s -o /dev/null -w "local=%{http_code}\n" http://127.0.0.1:8787/
curl -s -o /dev/null -w "public=%{http_code}\n" https://blink.utkarshbahuguna.me/
```

A local 200 with a public 503 means the tunnel did not come up and the site is
down for everyone but you.

## The memory ceiling

`run.sh` sets `--max-old-space-size=512`.

Node's default heap on an 11 GiB machine is roughly a quarter of RAM, which is
far more than Blink needs and enough to make the server the largest process on
the box, and therefore the first one the OOM killer chooses. Capping it does two
things: it stops Blink growing into a target, and it converts a leak into a heap
error that names the ceiling instead of a silent `SIGKILL` with no message and no
drain.

If Blink ever approaches 512 MB, that is a bug worth finding, not a limit worth
raising.

## What happens to live instances if the process is OOM killed

**Read this part.** It is the sharpest consequence of running from a laptop, and
the answer was not obvious.

An OOM kill is `SIGKILL`. No handler runs, so there is no drain, no receipt and
no kill call. What is left is the three expiry layers, and here is exactly how
far each one gets:

| Layer | What it does | Does it cover an OOM kill? |
|---|---|---|
| 1. In-process expiry timer | Kills the sandbox at the instance's expiry | **No.** It lives in the process that just died |
| 2. Guest self-destruct | `kill -9` the app inside the guest after the lifetime | **Partly.** It survives, because it is a `sleep` inside the sandbox. But it kills the **app**, not the sandbox. The instance becomes unusable and the sandbox keeps billing |
| 3. Platform timeout | Solari kills the sandbox after 180 s idle | **Not reliably.** It is an IDLE timer, and **Q17 measured that traffic to a previewUrl resets it**. A visitor refreshing a dead instance can hold the sandbox open |

So the honest answer to "what covers an OOM kill with a visitor active" is:
**layer 2 makes the instance unusable, and nothing in the original design
reliably stops the sandbox billing.** At $0.057/h, two concurrent sandboxes is
about $2.74 a day, running until somebody notices.

That gap is why `scripts/watchdog.ts` exists.

### The watchdog

A separate process, started by `run.sh` before the server and stopped after it.
It is deliberately tiny: no HTTP server, no database pool, no SDK client cache.
That makes it the last thing the OOM killer picks and keeps it running when the
server is gone.

Every 60 seconds it reads the instance log the server writes and kills anything
more than 2 minutes past its expiry, then asks Solari directly for anything live
that the log does not explain. Foreign sandboxes, meaning ones that are not ours,
are reported and left alone.

**Worst case with the watchdog running:** an instance outlives its expiry by up
to the check interval plus the grace, so about 3 minutes. At 1 vCPU / 2 GB that
is about $0.003.

**Worst case if the watchdog dies too**, for example the whole machine loses
power: nothing kills the sandbox until the next start, because `run.sh` sweeps
before it serves. If the laptop stays off for a day, that is a day of billing for
whatever was live, roughly $1.37 per sandbox. **This is a real exposure and there
is no way around it from a machine that can lose power.** The mitigation is the
one already in place: ten minute lifetimes and at most two concurrent sandboxes,
so the worst case is bounded at two sandboxes rather than unbounded.

## Sweep on start

`run.sh` runs `npm run sweep` before starting the server, and again during
shutdown while the watchdog is still alive. A crashed previous run is the normal
case on a laptop, not the exceptional one.

## Availability, stated plainly

The site is up while this laptop is awake, unlocked and connected. It is down
when the lid closes, the machine sleeps, the network drops or the process is
killed. That is not a service level anybody should rely on, and the health wall
says so rather than implying otherwise.
