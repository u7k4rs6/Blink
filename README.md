<p align="center">
  <img src="docs/art/hero.svg" alt="Blink: press launch, get a real machine" width="100%">
</p>

# Blink

Pick an open source app, press Launch, and a private Linux machine wakes up with
that app already running and already full of data. Yours alone for ten minutes.
Then it destroys itself and tells you what it cost.

**Live at [blink.utkarshbahuguna.me](https://blink.utkarshbahuguna.me)**, running
from a laptop behind a Cloudflare Tunnel. Said here rather than left to be
discovered, because it is why the site can be asleep.

## Why this exists

Trying a piece of self-hosted software means installing it. Even a good README
costs a stranger twenty minutes and a Docker daemon before they learn whether
they care. The alternatives are worse. Demo pages are stale screenshots. Public
shared instances are trashed by whoever arrived first, so the thing a visitor
evaluates is not the software, it is the wreckage.

Maintainers have no cheap answer either. A hosted demo is a service to run,
secure, seed and pay for. A read-only sandbox is not a trial. So most projects
ship a screenshot and lose the people who would have tried.

The missing piece is a disposable, pre-seeded, single-tenant instance that costs
fractions of a cent and dies on its own. Snapshot-fork sandboxes make that
possible. **Blink is the demonstration that it works.**

<p align="center">
  <img src="docs/art/breakdown.svg" alt="5.5 seconds to your browser: 3.6s waking a private machine, 0.3s the app starting, 1.3s your browser fetching page one" width="100%">
</p>

Every timing is published as its parts, because a total hides which part you are
waiting for. The app is the fastest thing in that bar. Most of the wait is a real
computer waking up, and that is the number worth being honest about.

## What it is

<p align="center">
  <img src="docs/art/flow.svg" alt="Press launch: fork, health check, preview URL, ten minutes, gone" width="100%">
</p>

Each instance is a [Solari](https://docs.getsolari.com) sandbox forked from a
snapshot and served over `previewUrl`. Not a shared demo that gets wiped between
visitors: one machine, forked for you, destroyed after you.

The snapshot already holds the app, its data and its warm memory, so nothing
installs and nothing seeds while you wait. Your ten minutes start at handover,
not at fork, because an instance that was ready three minutes before you could
use it has not been yours for three minutes.

<p align="center">
  <img src="docs/art/apps.svg" alt="Five apps: Gitea, Jaeger, Excalidraw, Uptime Kuma, Metabase" width="100%">
</p>

Every app is seeded at build time, and each card decides where it drops you:
Gitea on its issue list, Jaeger on a search with traces already in range, Uptime
Kuma on the dashboard. A card that does not match its arrival does not ship.

<p align="center">
  <img src="docs/art/lifetime.svg" alt="Ten minutes, then it destroys itself" width="100%">
</p>

Three independent layers end it, because any one of them can be the thing that
fails: an in-process sweeper, a self-destruct inside the guest that needs no
server to be alive, and a platform timeout that a heartbeat keeps pushing out.

<p align="center">
  <img src="docs/art/receipt.svg" alt="Session receipt: 10 minutes at $0.057 per hour is $0.0095" width="55%">
</p>

Then it tells you what it cost, from published rates, on real measured seconds.
That receipt is the argument: a real machine, to yourself, for less than a cent.

## What broke

The useful bugs all had one shape: a control that exists, passes its own test,
and cannot fire.

Turnstile was complete, tested and mapped to four threats, with no widget on the
page. Every card photographed a deep, populated screen while the handover dropped
visitors at `/`. A watchdog reaped a live instance 2 ms before handover, because
a live instance is in the ledger and that is exactly what the reaper reads as
proof it should die.

[**The catalogue is in `docs/06-what-broke.md`**](docs/06-what-broke.md), with the
three times a published number turned out to be derived rather than measured.
Each one made Blink look worse than it is, and no test caught any of them,
because all three produced entirely plausible numbers.

---

[**Docs, how to run it, and what it all cost**](docs/) &nbsp;&middot;&nbsp;
[**Every claim, verified**](docs/00-verification.md) &nbsp;&middot;&nbsp;
[**Why it broke**](docs/06-what-broke.md)
