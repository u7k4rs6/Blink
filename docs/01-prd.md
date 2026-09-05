# Blink: Product Requirements

## 1. Summary

Blink is a public website where a visitor picks a real open source web app from a catalog of five, taps Launch, watches a live timer, and has their own seeded, disposable instance of that app open in their browser about five seconds later, with every part of those five seconds shown on the page. Each instance is a Solari sandbox forked from a pre-built snapshot and served over `previewUrl`. It self-destructs after 10 minutes, with one 10-minute extension available, and ends with a cost receipt computed from published Solari rates. The headline number is the time until the app is in the visitor's browser, measured live, shown honestly as cold or warm, never blended, and always broken into its parts so a reader can see that the app itself accounts for about 0.3 s of it. A Swarm mode hits the visitor's own instance from up to 12 Solari browsers at once and shows a live grid of browser feeds with per-tile load times, p95, and a visual-consistency flag. The project is the second submission to Pinetree Research's SWE intern process and is built to make Solari's fork speed, isolation, and single-key surface obvious in under a minute on a phone.

## 2. Problem

Trying a piece of self-hosted software means installing it. Even a good README costs a stranger twenty minutes and a Docker daemon before they learn whether they care. The alternatives are worse: demo pages are stale screenshots, and public shared instances are trashed by whoever arrived first, so the thing a visitor evaluates is not the software, it is the wreckage.

Maintainers have no cheap answer. A hosted demo is a service to run, secure, seed, and pay for. A read-only sandbox is not a trial. So most projects ship a screenshot and lose the people who would have tried.

The missing primitive is a disposable, pre-seeded, single-tenant instance that costs fractions of a cent and dies on its own. Snapshot-fork sandboxes make that primitive real. Blink is the demonstration.

## 3. Users

### 3.1 The reviewer (primary)

Head of Growth and Ops at Pinetree Research, largely non-technical, arriving from a LinkedIn or X post, probably on a phone, with 5 to 10 minutes. Their exact path:

1. Reads the post, sees a 30 to 45 second recording of a phone launching a real app in about a second.
2. Taps the link. The catalog page paints in under a second: a live board strip (instances running, launched today, median fork time, credit gauge) over five app cards with real canary screenshots.
3. Reads one card, for example Gitea: category, what to try first in three steps, "2 of 2 slots free".
4. Taps Launch. Turnstile clears silently. A big mono timer counts up through four states: queued, resuming, health check, ready.
5. At about one second the timer freezes on the final number, labelled `warm resume` or `cold fork`, and a new tab opens with a working Gitea holding a seeded repo, issues, and a pull request.
6. Follows the three suggested steps: open the PR, leave a comment, see it appear. Realises this is their instance, not a shared one.
7. Returns to the toolbar tab. Sees the countdown, taps Swarm, watches 12 browser tiles load their instance at once with per-tile timings and a consistency flag.
8. Copies the invite link, or taps Extend, or lets it die. The countdown hits zero, the instance is destroyed, and a cost receipt appears: sandbox seconds, browser seconds, total in cents at Starter rates.
9. Leaves, or clicks through to the health wall and sees per-app fork-time p50 and p95 for the last seven days plus the public canary log.

What they need in the first 30 seconds: proof it is live, one number that is impressive and honest, and a working app they did not have to install.

### 3.2 Curious visitors (Show HN, X)

Technical, skeptical, arrive in a burst. They need to see the slot count and queue rather than a spinner, they need the cold number published next to the warm one, and they need the repo link within one tap. They will try to break it, so the budget guard and the out-of-credits state are part of the product surface, not error handling.

### 3.3 OSS maintainers

They need a Try-it badge for a README and a believable claim about what it costs to run. They need to see that the operator's monthly bill is public on the credit gauge.

## 4. What makes Solari look good here

- **Fork speed is the product.** The headline number is a Solari number. Nothing else in the UI competes with it.
- **Isolation is legible.** Every visitor gets their own instance because a fork is cheap. The failure mode of shared demos is visibly absent.
- **`previewUrl` removes an entire infrastructure layer.** No reverse proxy, no DNS, no certificates, no ingress.
- **One key across sandboxes and browsers.** Swarm launches 12 browsers against a sandbox with the same `slr_live_` key and one balance, in one process.
- **The cost receipt makes the pricing argument for them.** A 10-minute single-tenant instance costs under one cent at Starter rates, shown with arithmetic.

## 5. Scope

### v1 (ship by day 7)
Catalog of five apps, snapshot per app (D1), warm pool of paused forks (D2), visible slots and queue (D3), 10-minute lifetime with one extension and a cost receipt (D4), instance page and toolbar (D5), budget guard (D7), pre-computed health wall and live board (D8), public fork-time p50 and p95 plus public canary log (D10), single always-on server with Postgres and Cloudflare (D11), `examples/blink` added to the existing `solari-cookbook` fork (D12).

### v1.5
Swarm (D6) at N up to 12 on Starter and 3 on Free, live feeds via CDP screencast relayed over WebSocket, per-tile Navigation Timing, perceptual-hash consistency flag, 45-second cap, one run per instance per 2 minutes. Fork-my-state share links (D9) with 7-day expiry, a cap of 12 live share snapshots, fork counter, and a report-abuse path.

> **The web terminal via `pty.create` is cut from v1.5 and moved to v2, blocked on a network control existing.** G6 established that outbound cannot be restricted at any layer (`00-verification.md` V57). A shell turns "the app can make outbound requests" into "the visitor can make any outbound request, interactively", which is a categorical change in what Blink hands a stranger, not a marginal one. See `03-security-and-access.md` section 3.1.

### v2
External Swarm targets with ownership verification (meta tag or DNS TXT) and hard caps. Maintainer BYO-key mode. More apps. **Web terminal via `pty.create`, blocked on a network control existing at some layer.**

### Non-goals (verbatim)
AI features of any kind (the developer has no paid model key and will not buy one), driving or loading any third-party website, user accounts, payments, persistent instances, a hosted multi-tenant service for others' apps.

## 6. Features and acceptance criteria

| ID | Feature | Acceptance criterion |
|----|---------|----------------------|
| F1 | App catalog | Five cards render from Postgres with canary screenshot, category, three try-first steps, license note, upstream link, and live slots-free count. |
| F2 | Launch (warm) | Resume of a paused fork returns a health-checked `previewUrl` and the measured time is recorded and labelled `warm`. |
| F3 | Launch (cold) | With no warm fork available, a fresh fork from snapshot completes, is labelled `cold`, and the visitor is told before the timer starts. |
| F4 | Live timer | Four states (queued, resuming or forking, health check, ready) update from server timestamps, and the final number equals `ready_at - launch_requested_at`. |
| F5 | Queue | When 0 slots are free the visitor sees position and estimated wait computed from median instance lifetime, and is never shown an unexplained spinner. |
| F6 | Lifetime and extend | Instance expires 10 minutes after ready, one extension of 10 minutes is allowed, and Destroy kills within 3 seconds. Expiry is enforced by three independent layers (D4), not by Solari's `timeoutMs` alone, which is an idle timer and not a wall clock. |
| F7 | Cost receipt | On end of session a modal shows sandbox seconds, browser seconds, the plan rate used, and the total in cents, with the arithmetic visible. |
| F8 | Health wall | Per-app row with last canary status, last 24 canary runs, and fork-time p50 and p95 per day, read entirely from cache (D8). |
| F9 | Credit gauge | Public remaining-credit estimate from the ledger, updated by the worker, never by a visitor page. |
| F10 | Budget guard | A launch that would exceed a per-launch, per-IP-per-day, or global-per-day ceiling is refused before any Solari call, with a plain-language reason. |
| F11 | Out-of-credits state | With zero credits the catalog serves a recorded launch and the last known health wall instead of an error. |
| F12 | Swarm (v1.5) | N browsers load the visitor's own instance, tiles stream frames, per-tile load time and p95 render, and a consistency flag is set from perceptual hash agreement. |
| F13 | Fork-my-state (v1.5) | Snapshot on request produces a share link that forks it, expires in 7 days, and shows a fork counter and a report-abuse link. |
| F14 | Canary | An hourly canary fork verifies one rotating app end to end and writes a public log line. |
| F15 | Cookbook example | `examples/blink` exists in the cookbook fork with a runnable minimal fork-and-serve script. |

## 7. Success criteria at end of day 7

| # | Criterion | Justification |
|---|-----------|---------------|
| S1 | Five apps launchable, or four plus a written substitution note | Catalog credibility. Section 5 of the architecture doc records any substitution and why. |
| S2 | **Warm: ready at 3.7 s, in the visitor's browser at 5.0 s. Cold published beside it. The decomposition shown under both.** | **Measured, not provisional.** G1 ran 20 cold and 20 warm forks of Gitea on 2026-09-03 with zero failures. The original target of "warm p50 under 3.0 s" was missed on the serial path (6.1 s), and the design changed rather than the claim: pre-resolving `previewUrl` at replenish time removes a 1,035 ms API call from the visitor's clock (`02-architecture.md` section 2.1). The page leads with **5.0 s**, the number the visitor actually experienced, and shows immediately beneath it that **0.3 s of it was the app**. Leading with 3.7 s would read as a dodge. |
| S3 | Health wall green for 24 continuous hours before posting | The soak is the last day's work. Canary cost is $0.68/month at Starter (section 8), so a 24-hour soak is affordable. |
| S4 | At least 25 launches by people who are not the developer, within 48 hours of the post | 25 launches cost 25 x $0.0095 = $0.24 at Starter, well inside the daily ceiling of $0.442. Throughput allows 12 launches per hour, so 25 is about two hours of moderate traffic. |
| S5 | Recording published and post live, tagging Solari and Harry Chow | The post is what triggers review. |
| S6 | `examples/blink` merged into the cookbook fork | Satisfies the literal fork requirement (D12). |
| S7 | Total credits spent on build and launch under $8.00 of the $20 Starter allowance | Section 8 budgets $3.00 for build and gates and reserves $12.00 for post-launch traffic and the Free-plan transition. |

## 8. Budget model

All arithmetic uses Starter ($0.035 per vCPU-hour plus $0.011 per GB-hour; browsers $0.10 per hour) and Free ($0.0525 per vCPU-hour plus $0.0165 per GB-hour; browsers $0.15 per hour).

**Hourly sandbox rates**

| Size | Starter | Free |
|------|---------|------|
| 1 vCPU / 2 GB | 0.035 + (2 x 0.011) = **$0.057/h** | 0.0525 + (2 x 0.0165) = **$0.0855/h** |
| 2 vCPU / 4 GB | (2 x 0.035) + (4 x 0.011) = **$0.114/h** | (2 x 0.0525) + (4 x 0.0165) = **$0.171/h** |

**Per launch**

| Case | Starter | Free |
|------|---------|------|
| 10 min, 1 vCPU / 2 GB | 0.057 / 6 = **$0.0095** | 0.0855 / 6 = **$0.0143** |
| 20 min (extended), 1 vCPU / 2 GB | 0.057 / 3 = **$0.0190** | 0.0855 / 3 = **$0.0285** |
| 10 min, 2 vCPU / 4 GB | 0.114 / 6 = **$0.0190** | 0.171 / 6 = **$0.0285** |

**Per Swarm run** (45 s cap, browsers only, sandbox already billed)

| Case | Starter | Free |
|------|---------|------|
| 12 tiles x 45 s = 540 browser-seconds = 0.15 h | 0.15 x 0.10 = **$0.0150** | not applicable (3 concurrent max) |
| 3 tiles x 45 s = 135 browser-seconds = 0.0375 h | 0.0375 x 0.10 = $0.0038 | 0.0375 x 0.15 = **$0.0056** |

No proxies are used, so the $1.00/GB proxy rate never applies. No captchas are solved, so $0.01/solve never applies.

**Warm pool per day: resolved, it is free.**

| Case | Starter | Free |
|------|---------|------|
| Paused sandboxes at rest, any number, any duration | **$0.00** | **$0.00** |

Q1 is resolved and it resolves in favour of D2. `POST /sandboxes/:id/pause` is documented as "Saves full RAM+disk state. Billing stops and it stops counting against your concurrency limit." A warm fork therefore costs nothing while it waits, and it does not consume one of the two Starter sandbox slots. The only cost a warm fork incurs is the roughly 30 seconds of running time between forking it and pausing it, which is $0.00048 per replenish at Starter.

The contingency branches this table used to carry (paused billing at full rate, the demo-window pool, the single rotated fork) are deleted rather than kept as defect records, because they were contingencies against a fact that is now known. See `00-verification.md` V19.

The warm pool's remaining risk is not cost, it is whether it is worth building at all. See the G1 kill criterion in section 9.

**Canary**: one rotating app per hour, 60 s per run. 24 x 60 = 1440 sandbox-seconds = 0.4 h/day. Starter 0.4 x 0.057 = **$0.0228/day** ($0.68/month). Free, reduced to every 6 h: 4 x 60 = 240 s = 0.0667 h x 0.0855 = **$0.0057/day** ($0.17/month).

**Snapshot builds**: about 10 min at 2 vCPU / 4 GB each. Starter 0.114 / 6 = $0.019 per build. Fifty builds across the week (five apps, ten iterations) = **$0.95**.

**Gates (G1)**: 120 forks (3 apps x 20 x cold and warm), 60 s each = 7200 s = 2 h. Starter at 1 vCPU / 2 GB = 2 x 0.057 = **$0.114**; at 2 vCPU / 4 GB = **$0.228**.

**Daily ceilings (D7)**

| Ceiling | Starter | Free |
|---------|---------|------|
| Per launch | 1200 sandbox-seconds, 600 browser-seconds | same |
| Per IP per day | 5 launches, 2 Swarm runs | 2 launches, 1 Swarm run |
| Global per day | 21,600 sandbox-seconds (6 h) + 3,600 browser-seconds (1 h) | 2,880 sandbox-seconds (0.8 h) + 720 browser-seconds (0.2 h) |
| Cost of a full-ceiling day | (6 x 0.057) + (1 x 0.10) = **$0.442** | (0.8 x 0.0855) + (0.2 x 0.15) = **$0.0984** |
| Cost of 30 full-ceiling days | **$13.26** of $20 | **$2.95** of $3 |

**How many visitor sessions $20 buys**: at $0.0095 per 10-minute 1 vCPU launch, $20 is about 2,100 launches. Mixed realistically (30% extended, 25% on 2 vCPU apps, 20% with a Swarm run) the average launch costs about $0.0145, so about 1,370 sessions. Credits are not the binding constraint. Concurrency is: 2 slots at 10 minutes each is 12 launches per hour, 288 per day maximum, so a fully saturated day costs at most 288 x 0.0145 = **$4.18**.

**A Show HN day**: 500 attempts arrive, 288 are servable, the rest queue or are refused by the ceiling. Uncapped that day costs $4.18, which is 21% of the month. The 6-hour global ceiling caps it at $0.442 and turns the rest into a visible queue and an honest "daily ceiling reached, back tomorrow" state. That ceiling is the protection, and it is stated on the page rather than hidden.

## 9. Plan for 7 days

Revised 2026-09-03 against what the gates actually showed. Four gates have run live for a total of $0.081. G4, G7, G5 and Q5 are answered; G1, G2 and G3 need snapshots and therefore run at the top of day 2, not before.

**What the gates changed about this plan.** The warm pool **stays and is load-bearing** (G1, measured): it halves the wait, so day 4 keeps its full weight. The terminal is cut, which takes a chunk of day 6. Egress restriction is impossible, so that work is gone and replaced by the CPU sampler, which is smaller. The relay is comfortably within budget, so day 6 is less risky than it looked. And the headline number is far worse than S2 assumed, which is a writing problem for day 7 rather than a build problem, but it is the biggest open item on the plan.

**Day 2, morning: Gitea snapshot, then the three build-changing gates, reporting before lunch.**

Ordered so the three gates that change the build report early, and so a slow first recipe cannot push them into the afternoon:

1. **Gitea snapshot only.** One app, one recipe, built and verified. Budget generously: the recipes are shell, and the `sh -c` wrapper only started working today, so the first one is where every remaining wrapper assumption gets found. Assert on postconditions, never exit codes.
2. **Run G1, G2 and G3 against Gitea alone.** One app is enough to answer all three build-changing questions: whether the warm pool survives, whether the iframe exists, and what resume latency is. About $0.05.
3. **Report.** This is the checkpoint. Nothing downstream starts before it.
4. **Then Jaeger snapshot, and re-run G1 on it** for a second data point on fork-to-healthy. About $0.03. If the morning has run long, this slips to the afternoon without blocking anything, because G1's *decision* was already made on Gitea.

The reason for splitting Jaeger out is that the first recipe carries all the risk and none of the extra information. Two apps in the morning is two chances to lose the morning; one app plus a second data point later is neither.

**Day 2, afternoon:** snapshot build pipeline proper, health checks over loopback, snapshot registry in Postgres, canary loop skeleton. Every recipe command goes through the `sh -c` wrapper (architecture section 5) and asserts on a postcondition, never an exit code.

**Day 3:** launch orchestrator on the cold path, instance lifecycle with the three expiry layers, timers, budget guard and counting fetch ported in from the harness (they already exist and are tested), Postgres schema complete. The guest-side self-destruct is written today because it is now the primary abuse control, not a backstop.

**Day 4:** warm pool manager, queue, slots display, Cloudflare and Turnstile, live board and health wall cache, CPU sampler as specified in the security doc.

**G1 settled the kill criterion the other way, and decisively: the warm pool stays.** Cold p50 11,947 ms against warm p50 6,124 ms is a gap of 5,823 ms, against a 500 ms threshold. So D2 is **load-bearing rather than an optimisation**: it is the difference between a six second wait and a twelve second one, and it is the single largest lever the build has over the number on the page. There is no half-day of slack on this day; the earlier plan assumed one might appear and it has not. Anything that slips slips from days 5 and 6, not from here.

> **Dependency on section 10.1, hard.** The permission request must have been sent with enough lead time to allow a reply by this morning. If no written permission has arrived, **today is when BYO-key mode ships**, which is a config flip plus the key-entry UI. This is a schedule dependency rather than a preference: the decision cannot be deferred past today without either shipping something the terms may not permit, or not shipping.

**Day 5, morning: Metabase FIRST.** It is the only remaining app that can force a catalog substitution (Q13: does it boot and stay stable in 2 vCPU / 4 GB), so the answer is wanted in the morning rather than the evening. If it does not fit, apply the substitution already recorded in `02-architecture.md` section 5 and note the measured reason. **The decision is not reopened**: the alternatives were chosen when the constraint was understood, and re-litigating them on the day costs more than the substitution does.

**Day 5, then:** Excalidraw **built from source in the sandbox at the pinned tag `v0.18.1`**, which supersedes the CI-built-tarball plan and removes the need to host a tarball ourselves. It is built at 2 vCPU / 4 GB and served at 1 vCPU / 2 GB, a deviation recorded in `02-architecture.md` section 5. Then Uptime Kuma with its `npm ci`, whose prebuilt `dist.tar.gz` means no frontend build at all. Uptime Kuma additionally needs **its websockets verified behind `previewUrl`**, which is still undetermined: G2 only ever ran against Gitea, so section 6's note that Uptime Kuma is the first thing G2 should test remains unpaid.

**Day 5, afternoon:** catalog page, launch sequence UI, cost receipt, instance toolbar. ~~Q6 decision point.~~ **Permission arrived 2026-09-10 and was granted, so the decision point never fired** and BYO-key was never needed.

**Day 6:** Swarm relay and grid, with the routing-versus-instance line on the page. Fork-my-state if time allows, with the 12-snapshot cap and a proven expiry sweeper. Cookbook example. **No terminal.**

**Day 6, end:** deploy behind a Cloudflare Tunnel from the development laptop, on `blink.utkarshbahuguna.me`. **This replaces the Hetzner plan, which did not happen: there is no paid host and no card to buy one with.** `02-architecture.md` section 11 states what is actually true and what it costs in reliability.

**Day 7, in this order: deploy, soak, record, post.** The order is unchanged. What changed is what the soak can prove.

**The 24 hour continuous soak is not achievable from a laptop, and the claim changes rather than the standard.**

The gate was 24 continuous hours on a machine that stays up. This machine cannot: it sleeps, its lid closes, and it OOMs with an editor open. Pretending otherwise would be the exact failure this project has documented five times, a true statement standing in for the one that was asked.

**What is verified instead, and it is stated as its own thing rather than as a shortfall:**

| Claim | Status |
|---|---|
| Five apps green on real interface checks, not status codes | Achieved, and re-verified every run |
| No leaked sandboxes at any reconciler tick | Achieved across 40+ ticks |
| Deliberate kill shows the lost-instance state | Achieved |
| Deliberate restart, live instance surviving | Achieved |
| Resolve-time distribution as an hourly count | Achieved, 20+ distinct hours |
| **24 continuous hours** | **Not achieved. Longest uninterrupted stretch is reported instead** |

The report already prints distinct hours and longest continuous stretch as two numbers and never merges them, which is why this change is a copy change and not a measurement change. The health wall states which number it is showing, in the same register as the cold and warm labels.

**What that means for the post.** The honest line is that Blink was soaked for N hours in total with a longest unbroken stretch of M, on a laptop, and that the site is up while that laptop is awake. A reader who cares about uptime learns the truth immediately, and a reader who cares about the measurements gets numbers that were actually taken. Claiming a day of continuous uptime from a machine that sleeps would poison every other number on the page, and there are a lot of other numbers.

## 10. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `previewUrl` refuses to be iframed (G2) | New-tab plus floating toolbar page is the default design (D5). The iframe is an enhancement, not a dependency. |
| Forks are slow (warm p50 above 3 s) | The headline becomes the measured number. The page never promises a number it did not just measure (D10). |
| Snapshot storage is billed at an unlisted rate (Q18) | Ceilings are in sandbox-seconds and browser-seconds and would not catch it. Mitigations that hold either way: a hard cap of **12 live share snapshots** (D9), 7-day expiry, and a **proven** expiry sweeper rather than an assumed one. At about 3.84 GB each, 12 is roughly 46 GB, which is a bounded exposure whatever the rate turns out to be. |
| The public credit gauge is wrong (D10) | Solari exposes **no balance or usage endpoint** (V55); remaining credit is visible only on the console Billing page. The gauge is therefore a projection, not a reading, and is **labelled an estimate on the page**. Every ledger row records whether it was measured or modelled, and the reconciliation step is a manual console read at a stated cadence. |
| ~~Paused forks bill (G3)~~ | **Resolved, not a risk.** Pause stops billing and frees the concurrency slot (`00-verification.md` V19, V20). The warm pool is free at rest. |
| Credits exhausted while the reviewer visits | Global daily ceiling of 6 sandbox-hours keeps a full-ceiling month at $13.26. The out-of-credits state serves a recorded launch and the last health wall, so the site is never broken, only paused (D7). Documented exhaustion error is `402 InsufficientCredit` (`00-verification.md` V26). |
| An app misbehaves behind `previewUrl` (absolute URLs, websockets, cookies) | Each app is verified behind `previewUrl` in the canary before it enters the catalog. An app that fails is removed from the catalog with a public note rather than shipped broken. |
| **Outbound network is unrestricted, and cannot be restricted (Q5, V57)** | **Accepted, disclosed, and the reason lifetimes stay short.** Blink hands anonymous visitors a machine with unrestricted egress from Solari's IP space. The controls bound **volume, not category**: a 1 vCPU box for 10 minutes is a poor miner and a perfectly good proxy, spam relay, scanner or credential-stuffing client. This is a platform property, not a Blink choice, and there is no workaround. Mitigations that remain: 10-minute lifetimes, hard kills, the guest-side self-destruct, Turnstile, per-IP ceilings, and the CPU sampler (defined in `03-security-and-access.md` section 3.2). The pty terminal is cut because of it. Disclosed to Solari in the permission request, section 10.1. |
| Abuse (miners, outbound proxying) | Three-layer expiry (D4), of which the guest-side self-destruct is the only layer indifferent to visitor activity, which is what a miner is. Plus guest-side egress denial if G6 allows it, CPU and memory caps, Turnstile, per-IP ceilings. Covered fully in the security doc. |
| Plan downgrade after the Starter month | Plan rates and limits live in one config table, not in code. The site reads its own plan and degrades: 1 slot, 3-tile Swarm, no warm pool, 6-hour canary, tighter ceilings. Q12 covers what happens to running sandboxes and stored snapshots at the moment of downgrade. |
| Solari outage during the reviewer's visit | The catalog, health wall, and metrics are served from cache and stay up (D8). Launch is disabled with a plain status line and the recorded launch is offered. The canary log shows the outage publicly, which is more credible than hiding it. |
| Server restart with live instances | Every long-running operation is resumable from Postgres state. Live instances are reconciled against Solari on boot. |

## 10.1 BYO-key: a designed alternative, no longer a contingency

**Q6 was answered on 2026-09-10 and the answer was yes** (`docs/q6-permission.md`), so this stops being insurance. It is kept here because the design is sound and because the reasoning that produced it is the record of how the project would have handled a no.

The question was whether Solari's terms permit anonymous public visitors driving sandboxes on one operator's key. Phase 0 could not resolve it and it leaned against: there is no separate acceptable use policy, and the terms at `getsolari.com/terms` say "You may not copy, modify, reverse engineer, redistribute, resell, sublicense, or otherwise exploit any part of the platform without prior written permission from Solari Browser" (`00-verification.md` V44). A written request was sent and granted, which is the only thing that could have settled it.

The insurance is cheap, so it is built now rather than designed now and built later. **The Solari adapter takes an API key per call, passed in by the caller. It never reads `SOLARI_API_KEY` from the environment at the call site.** The operator key is resolved once, at the edge of the process, and threaded down. That single constraint makes bring-your-own-key a configuration flip rather than a v2 rewrite, and it costs nothing to honour from the first line of `src/solari/`.

### The permission request, drafted

Disclosing the outbound finding is far better than Solari discovering it. The draft below is what goes out, and the third paragraph is the one that matters.

> Subject: Permission request, public demo site running sandboxes on one operator key
>
> I am building Blink, a public site where a visitor picks an open source app, taps Launch, and gets their own disposable Solari sandbox forked from a snapshot, served over `previewUrl`, destroyed after 10 minutes. It is measured rather than estimated: a warm launch puts a seeded Gitea in the visitor's browser in about 5.5 seconds, of which about 0.3 seconds is the app starting and the rest is waking the machine and fetching the first page. It is a portfolio project and the second submission to Pinetree Research's SWE intern process. Fork speed, isolation and `previewUrl` are the point of it, and the cost receipt at the end of every session makes your pricing argument for you.
>
> **What I am asking permission for.** Anonymous members of the public would drive sandboxes on my single `slr_live_` key, against my one balance. Your terms prohibit redistributing or sublicensing platform access without prior written permission, and I read handing strangers a sandbox as plausibly falling under that. I would rather ask than assume.
>
> **What you should know before answering, because it is the part I would want to know.** I tested whether I could restrict outbound network from inside a sandbox and I cannot. The guest runs as root with a full capability set, but the kernel carries no netfilter subsystem: `nft` returns "Operation not supported", there is no `nf_tables` module, no `modprobe`, and no `iptables` binary. I found no documented platform-level egress control either. So a Blink instance is a machine with unrestricted outbound access from your egress IPs, handed to an anonymous stranger for ten minutes. My controls bound how much compute and time each visitor gets; they do not bound what that machine talks to. A 1 vCPU box for ten minutes is a poor miner and a serviceable proxy, spam relay or scanner. I am not able to fix that from my side, and I would rather tell you than have you find it.
>
> **What Blink does instead:** 10-minute lifetimes with one extension and a hard kill; a guest-side self-destruct that stops the app on a wall clock regardless of visitor activity; Cloudflare Turnstile before any sandbox is created; per-IP and global daily ceilings enforced before the call, never after; a bounded residency on every state that bills, so an instance that is alive but unusable is killed rather than left running; a CPU sampler that kills an instance at 90% CPU across three consecutive 20-second samples and bans the IP hash for 24 hours; no shell for visitors, and the terminal feature cut specifically because of this finding; and a public canary log where I publish failures and incidents rather than hiding them.
>
> **On spend, since it is your balance:** measured cost is $0.0095 for a 10-minute 1 vCPU instance, and my whole build and gate programme has cost $0.13 so far across about 200 sandboxes. Every ledger row records whether its seconds were measured or modelled, and if my ledger drifts more than 10% under a console reading, launches disable themselves until I reconcile. I would rather stop the site than quietly overrun.
>
> **Three questions.** Is anonymous public use on one operator key acceptable to you at all? Given unrestricted egress, is it still acceptable, or would you want additional limits I have not thought of? And separately, is snapshot storage billed, since I find no storage line on your pricing page and my snapshots measure 3.84 to 3.92 GB each?
>
> (I sent a separate short note earlier about what the `__pt_preview` cookie decodes to. This message does not depend on that one.)
>
> Happy to take a no, or a yes with conditions.

**If no written permission has arrived by day 5**, Blink ships live in BYO-key mode rather than not shipping:

- Catalog, health wall, canary log, credit gauge, fork-time percentiles and the recorded launch are all real and all served, because they run on the operator's key doing the operator's own canary work, which is ordinary single-tenant use and raises no question under the terms.
- Launch asks the visitor for their own Solari key. The key is held in the browser session, forwarded per request, used server-side for that one request, and **never written to Postgres, never written to logs, and never included in any artifact**. Same handling as the v2 maintainer BYO-key mode already described in `03-security-and-access.md` section 5.
- The cost receipt still computes, against the visitor's own plan rates, and says whose balance it drew on.
- The post and the recording change one line: the demo is the developer launching on the developer's key, which is exactly what the recording shows anyway.

This is a worse product and an honest one. It is strictly better than a launch that violates the terms, and strictly better than not launching. The decision point is day 5, and it is a decision about a written answer, not about anything the build can influence.

## 10.2 The identifier note, sent first and on its own

**Sequencing: this now goes as a follow up on the existing thread, not cold.** Q6
was answered in writing on 2026-09-10 and there is a live conversation with a
named person at Solari, so the disclosure note lands as the next message in a
thread that already exists rather than as an unsolicited approach from a
stranger. That changes the opening line and nothing else in it.

It stays a **separate message** for the original reason: folding it into the
permission request would have made it read as leverage or as a complaint
attached to an ask, and it is neither. The same holds now that the ask has been
granted, where mixing them would read as a list of problems delivered on the
back of a favour.

**Ordered by who it affects, not by the order I found things.** The sandbox id case leads because it touches every customer who logs HTTP requests, whether or not they ever use a preview link. The cookie is the narrower case and comes second.

> Subject: Two notes on identifier contents, from reading closely while building
>
> Thanks again for the quick answer on the public instances question. Two
> unrelated things came up while building, both about identifier contents, and
> I would rather flag them than quietly work around them. Neither is urgent.
>
> I have been building a demo on Solari sandboxes and reading the identifier formats carefully. Two things came up that I would rather flag than quietly work around. Neither is urgent and I have no timeline pressure.
>
> **First, and the one that affects everyone: sandbox ids decode to infrastructure details, and they are in the path of every request.**
>
> A sandbox id is a `base64.signature` token. The body decodes without any key to a colon-delimited tuple of four fields: what reads as a host pool identifier including a cloud instance id, an internal VM id, the caller's org id, and a creation timestamp.
>
> Because the id sits in the path of every call (`POST /sandboxes/<id>/snapshots`, `DELETE /sandboxes/<id>`, and so on), it is captured by default by ordinary tooling. Anything that records request paths already has it: application logs, APM traces, Sentry breadcrumbs, CI job output, reverse proxy access logs, HAR captures. That happens whether or not the customer uses preview URLs, shares anything, or does anything unusual. My own harness stored it in four report files without anyone deciding to.
>
> **Second, and narrower: the `__pt_preview` cookie carries the same kind of content.**
>
> It is a JWT, so the payload decodes without a key. The signature stops forgery but does not hide the contents. Four outer claims: `sandboxId`, `port`, `orgId`, `exp`. The `sandboxId` claim is itself the nested token described above, so a preview URL hands its holder seven claims across two layers.
>
> For a typical integration this would be a footnote, since the URL is usually held by one developer and expires within the hour. **My project makes it less of a footnote, which is part of why I am writing.** The whole loop mints these continuously, one per visitor, and one feature actively encourages visitors to pass the link to other people. So I am about to industrialise the disclosure, and then publish a site that explains the mechanism to anyone who reads it.
>
> **Third, the part that I think saves you the most time: the usual mitigation does not work here.**
>
> "Scrub it from your logs" is not advice that can be given for this one. Both identifiers are opaque high-entropy strings that match no recognisable pattern, so no customer's existing log scrubber will strip them. Mine did not: I had regex redaction covering token query parameters, auth headers and API keys, and it caught none of this, because there is nothing about a 113-character id that distinguishes it from any other id. What I ended up needing was a registry that learns each identifier at the moment it is created and scrubs it from every write afterwards, which only works because my code is the thing that creates them.
>
> A customer cannot retrofit that onto an APM agent or a proxy access log. So the practical fix is on your side rather than theirs: either the id format stops carrying decodable infrastructure details, or the docs say plainly what these decode to so people can decide for themselves. I mention it because the second option is cheap and would have saved me the afternoon.
>
> **One last small thing, not a defect on your side but a trap worth a line in the docs.**
>
> A `previewUrl` puts the capability in the query string, so `new URL(path, previewUrl)` silently strips it: that is standard `URL` behaviour and correct everywhere else, but here the query IS the credential. The failure then presents as a 401 on the second request, which sends you looking at tokens and expiry rather than at URL construction. It is invisible in a browser, because the first response sets `__pt_preview` and the cookie carries every request afterwards, so it only shows up in clients without a cookie jar. That is exactly the set of things people point at a preview URL: health checks, canaries, uptime probes, CI smoke tests. Cost me a soak tick to find. One sentence in the preview docs saying the token must be carried on every request, not just the first, would save the next person the same detour.
>
> **What I am doing on my side, regardless of what you decide.** Treating both as sensitive throughout: never rendered on any page that can be crawled, cached, screenshotted or indexed; scrubbed from every report and log through a single writer that cannot be bypassed; the id registry above for the opaque cases; nulled from the database when the instance dies; and `noindex` plus a `robots.txt` disallow on the two pages that could ever carry one.
>
> **One question: is there anything you would like me to change, or hold back, before this goes public?** I am happy to delay for as long as you like, to describe the mechanism less precisely, or to leave it out of the write-up entirely. That offer matters more for the first item than the second, since it sits in a lot of people's logs already and you may want lead time before it is described publicly.
>
> **A third thing, and the one with the widest blast radius: `preview.getsolari.com` is not on the Public Suffix List.**
>
> I checked the current list, 16,477 entries, and `getsolari` is not in it. So for every browser mechanism keyed on *site* rather than *origin*, every customer's sandbox on the platform is the same site: `getsolari.com`. I measured a partitioned cookie set by one of my instances and its partition key is `{"topLevelSite":"https://getsolari.com","hasCrossSiteAncestor":false}`, not the instance host.
>
> That means partitioned storage, `Sec-Fetch-Site: same-site`, Related Website Sets, and any cookie a customer's app sets with a `Domain` attribute broader than host-only are shared across unrelated tenants. Your own `__pt_preview` is correctly host-scoped so the preview token itself is not exposed by this. The exposure is between customer applications, and a sandbox is a machine a customer can run arbitrary code on.
>
> `vercel.app`, `pages.dev` and `github.io` are all on the list for exactly this reason. Submitting `preview.getsolari.com` is a pull request against a public repository and browsers pick it up on their next release, so it is slow to take effect but cheap to start.

> Unrelated and much smaller: the `AWSALB` and `AWSALBCORS` cookies carry a 7-day expiry against sandboxes that live minutes, which is harmless but looked unintentional.

## 10.3 The performance note, sent separately from both of the above

**Sequencing: this goes out AFTER section 10.2 has landed, not alongside it.** Two unsolicited notes in one day from someone applying for a job is a lot to receive, and the disclosure note matters more: it concerns their identifier format and every customer who logs HTTP requests, while this one concerns my project's numbers. Send 10.2, let it land, then send this.

**Why this is its own message.** Section 10.2 is about identifier disclosure and stays narrow on it; mixing a performance question into a disclosure note makes both harder to answer and makes the disclosure note read as a list of complaints. This one has a different purpose: **they should hear these numbers from me before they appear on a public page, not after.** The whole project publishes measured fork times, so this conversation is going to happen either way, and it goes better if it starts privately with the raw data attached.

Sent after G1 has run and before anything is posted.

> Subject: Fork and resume timings I measured, and what I plan to publish
>
> I have been measuring fork-to-healthy on Solari sandboxes for a demo I am building, and I want to show you the numbers before they end up on a public page, since publishing measured performance is most of what the project is.
>
> **To be clear about why you are seeing this now: nothing is published yet.** I am showing you before rather than after, while everything is still editable. If you would rather I held any of it, described it less precisely, or left a particular number out, say so and I will. I would rather have that conversation now than have you read it on a public page first.
>
> Setup: one 3.92 GB snapshot of a seeded Gitea on a 1 vCPU / 2 GB sandbox, Starter plan, us-west, 20 cold forks and 20 warm resumes, all successful. I split each measurement into three parts rather than reporting one number, because the parts turned out to matter more than the total.
>
> | | cold p50 | warm p50 |
> |---|---|---|
> | Solari API call (`create({fromSnapshot})` or `resume()`) | 9,264 ms | 3,408 ms |
> | app answering on loopback inside the guest | 1,159 ms | 281 ms |
> | first byte through `previewUrl` | 1,538 ms | 2,389 ms |
> | **total** | **11,947 ms** | **6,124 ms** |
>
> **The part I want to check with you is the first row.** `create({fromSnapshot})` returns after about 9.3 seconds, and the app is then healthy 1.2 seconds later, so the call appears to block through the snapshot restore rather than returning early. The docs describe a sandbox booting from a snapshot in about a second, which I read as describing the microVM boot rather than the API round trip a caller waits on. I would rather ask than assume: is roughly 9 seconds expected for a snapshot this size, is there something in how I am calling it that makes it slower than it needs to be, or is the one-second figure measuring a different thing?
>
> Two smaller observations from the same runs, offered in case they are useful:
>
> The `previewUrl` first byte to a **fresh** sandbox is 1.5 to 2.4 seconds, while steady-state requests on an established route settle to about 265 ms. So route setup looks like a real one-off cost per sandbox rather than a per-request tax. Separately, twelve simultaneous clients against one `previewUrl` came back at p50 1,242 ms each, against 265 ms sequential.
>
> The app itself is never the bottleneck: 281 ms on loopback after a resume. I mention that because it is the number I would have got wrong if I had health-checked through `previewUrl` like I originally intended, and I would have concluded the app was slow.
>
> **What I plan to publish**, unless you tell me something that changes it: the three-way split above rather than a single number, on the grounds that "your instance is ready in six seconds, and here is where those six seconds went" is both truer and more interesting than a round number. The app-healthy-in-281 ms figure is genuinely impressive and a single total hides it completely.
>
> If any of this is measuring something wrong, I would rather find out now than argue with a reader about it later. And if there is a faster path I have missed, I would obviously rather publish that number instead.

## 11. Open questions

Status as of the Phase 0 sweep on 2026-09-03. Full evidence and source links in `00-verification.md`.

- **Q1** ~~Do paused sandboxes bill?~~ **Resolved: no.** Pause stops billing and releases the concurrency slot. (V19, V20)
- **Q2** Snapshot limits on Starter: count, maximum size, creation time for a 2 to 4 GB app, and whether snapshot storage is billed at all. **Still open, needs G4.** No published limits anywhere. (V30, V31)
- **Q3** What framing headers do `previewUrl` responses carry, and are they configurable? **Still open, needs G2.** Nothing published about preview-domain response headers. (03-security item 7)
- **Q4** ~~Is a `previewUrl` public, tokenized, or guessable?~~ **Resolved: tokenized.** It carries a one-hour `pt_token` query parameter, also accepted as the header `x-pinetree-preview-token`. Expiry returns 401. (V21)
- **Q5** ~~Can outbound network egress be restricted?~~ **RESOLVED NEGATIVE, G6 live 2026-09-03.** Not for lack of privilege: the guest is root with every capability set. The kernel has no netfilter subsystem at all (`Operation not supported`, no `nf_tables`, no `iptables`), so no guest-side firewall is possible, and no platform control is documented (V32). **Blink ships with no network restriction, as a known accepted gap.** (V57)
- **Q6** Does Solari permit anonymous public visitors driving sandboxes on the operator's key? **RESOLVED 2026-09-10: GRANTED.** Harry at Solari confirmed in writing that the use case is permitted on the Starter plan and to proceed with reactivating launches. Verbatim reply and scope note in `docs/q6-permission.md`. (V44)
- **Q7** What is the resume latency distribution, and is there an extra penalty after a long pause? **Still open, needs G3.** (V33)
- **Q8** ~~Does a concurrency 429 carry `Retry-After`, and is it distinguishable from a rate-limit 429?~~ **RESOLVED, closed by G7 live on 2026-09-03: `429 ConcurrencyLimitExceeded` in 250 ms, no `Retry-After`, exactly one attempt.** Detail below. It is distinguishable: `429 {code:"ConcurrencyLimitExceeded"}`, documented as "Retrying cannot help: a slot only frees when _you_ pause or kill a session", and the SDK's own transport excludes 429 from retry. Whether a `Retry-After` header is present on the wire is undocumented and stays with G7. (V24, V25)
- **Q9** Is there a webhook or event stream for sandbox death? **Still open, leaning no.** No such route exists in the published API surface, so the 10-second poller stands. (V34)
- **Q10** ~~Does session recording produce a shareable replay link?~~ **Resolved: presigned and expiring, not public.** `getReplayUrl` returns `{url, expiresInSeconds, contentEncoding}`, NDJSON, ready 1 to 3 s after `releaseAndWait`. Usable as evidence, not as a published artifact, so D6 still needs its own filmstrip. (V35)
- **Q11** ~~How many concurrent CDP screencast sessions can one Node process relay?~~ **RESOLVED, G5 live 2026-09-03: 12 tiles at 8.0 fps each, 355 KB/s aggregate, 2.9 Mbps, 3.6 KB per frame.** Roughly half the predicted bandwidth at double the predicted frame rate. (V58)
- **Q12** On downgrade from Starter to Free, what happens to running sandboxes and stored snapshots? **Still open, needs a written answer.** Undocumented. `plan_config` already isolates the code from the answer. (V40)
- **Q13** ~~Does Metabase with its sample database boot and stay stable in 2 vCPU / 4 GB?~~ **RESOLVED, measured 2026-09-04: yes, with room.** Boot to healthy 32.5 s, RSS 1,405 MB after boot and 1,486 MB after query load, 2,276 MB still available, zero OOM lines. No substitution needed. (V50)
- **Q14** ~~Is there a prebuilt static Excalidraw release?~~ **Resolved: no, and the consequence has since changed.** Release v0.18.1 ships zero assets (V47). The answer was read as forcing a CI-built tarball, but a source build inside the sandbox turned out to be workable, so the recipe builds at the pinned tag instead. A resolved question can outlive the decision it produced.
- **Q15** ~~Does the Solari base template include a JRE and Node?~~ **Resolved: neither is documented.** `base` is the bare headless sandbox; Node appears only in `code`, which is a desktop template. Both installed at snapshot build time, or a custom template built. (V38)
- **Q16** ~~Confirmed monthly price of the chosen always-on host.~~ **Resolved, then overtaken by events: no host was bought and the site runs from a laptop behind a Cloudflare Tunnel (`02-architecture.md` section 11). The price research stands and is recorded because the decision was real when it was made.** Hetzner CX22 was the pick. EUR 3.79/month for 2 vCPU, 4 GB, 40 GB disk, 20 TB traffic. Fly.io shared-cpu-1x at 1 GB is roughly $5.92/month and bills egress separately, which matters for the relay. (V52, V53)
- **Q18 (new, from the 2026-09-03 live pass)** **Is snapshot storage billed, and is there an account-wide storage ceiling?** Verified pricing lists vCPU-hours, GB-hours, browsers, proxies and captcha solves, and **no storage line of any kind** (`00-verification.md` V56). G4 measured a snapshot of a *bare* `base` template at **about 3.84 GB**, and D9 mints one per share link. So either storage is free or it is unlisted, and under a public credit gauge (D10) an unlisted cost is a budget hole rather than a rounding error. Neither the docs nor the console Billing page states a storage rate. **This goes on the same written question to Solari as Q6.**
- **Q17 (new, from C-1)** Does traffic to a `previewUrl`, or an open control channel, reset the sandbox idle clock? **Still open, measured as a sub-measurement inside G3.** The three-layer expiry design (D4) deliberately does not depend on the answer; this measures how much the dead-man layer is actually worth.

## Verification status of this doc

Phase 0 ran on 2026-09-03 against `docs.getsolari.com`, the published SDK type definitions, vendor release pages and current host pricing. Full record, with source URLs and quoted evidence, in `00-verification.md`. The developer's 2026-09-02 notes are superseded by that document wherever the two disagree.

**Resolved, no longer tagged:**

1. Solari SDK surface. `create({fromSnapshot})`, `previewUrl`, `snapshot`, `pause`, `resume`, `setTimeout`, `kill`, `pty.create` and the browser CDP endpoint are all confirmed against the published `.d.ts`. One correction carried into `02-architecture.md`: `previewUrl(port)` returns `{url, token?}`, an object, not a string. (V1 to V18)
2. Pricing and limits. Every rate, concurrency cap, session ceiling and retention figure in section 8 is confirmed exact. (V27 to V29)
3. Paused sandboxes do not bill and do not hold a slot (Q1). (V19, V20)
4. Excalidraw has no prebuilt static release (Q14). (V47)
5. Base template ships neither a JRE nor Node (Q15). (V38)
6. Host pricing, and Hetzner CX22 at EUR 3.79 is the pick (Q16). (V52, V53)

**Still [UNVERIFIED], each with the gate that will settle it:**

1. Warm p50 under 3.0 s (S2) is [UNVERIFIED] until G1 runs. G1 also carries the warm-pool deletion criterion in section 9.
2. Resume latency (Q7) and what resets the idle clock (Q17) are [UNVERIFIED] until G3 runs.
3. Metabase stability in 2 vCPU / 4 GB with the sample database (Q13) is [UNVERIFIED] by measurement, though vendor guidance supports the size. (V50)
4. ~~Solari's permission for anonymous public visitors on one operator key (Q6) is [UNVERIFIED].~~ **RESOLVED 2026-09-10: granted in writing** (`docs/q6-permission.md`). Not a blocker. (V44)
5. Whether outbound egress can be restricted at all (Q5) is [UNVERIFIED] and undocumented. (V32)
6. Snapshot count, size and storage billing (Q2) are [UNVERIFIED]. (V30, V31)
7. Downgrade behaviour (Q12) is [UNVERIFIED]. (V40)
8. Cloudflare Turnstile and the Supabase free tier were not checked this pass. Neither is on the critical path for the gates; both are settled during the day-4 build. (V54)
