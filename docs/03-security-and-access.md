# Blink: Security and Access

Scope: a public website that hands anonymous strangers a live Linux sandbox, on one operator's Solari key, with one shared balance. The threat surface is unusual for a portfolio project, and getting it visibly right is part of what the project demonstrates.

## 1. Assets and secrets

| Asset | Where it lives | Rotation | Notes |
|-------|----------------|----------|-------|
| `SOLARI_API_KEY` (`slr_live_`) | Server process environment only, injected by the host's secret store or a root-owned `.env` with mode 600 | Manual, immediately on any suspected exposure; also as a scheduled rotation at the end of the Starter month | Never sent to the client, never in a page, never in a log line, never in the cookbook example. One key covers browsers, sandboxes, and VMs, so exposure is total exposure of one balance. |
| `DATABASE_URL` (Supabase Postgres) | Server environment | On exposure | Service role key is never used from anything client-facing. Row level security is irrelevant here because nothing client-side talks to Postgres directly. |
| `TURNSTILE_SECRET` | Server environment | On exposure | The Turnstile site key is public by design. |
| Cloudflare API token | Not on the server; used from the developer's machine for DNS only | On exposure | Scoped to one zone, DNS edit only. |
| `ADMIN_SECRET` | Server environment | Monthly | Section 5. |
| Snapshot contents | Solari | Rebuilt per app version | Snapshots must contain no secrets. The boot script injects per-fork values, and the build recipe is reviewed for stray tokens before the first snapshot is taken. |

Controls: `.env` is in `.gitignore` and in a pre-commit secret scan (`gitleaks` or equivalent) run in CI on every push, including the cookbook fork. GitHub secret scanning and push protection stay on for both repos. No key is ever pasted into a Solari sandbox, because a sandbox is a machine strangers will get a fork of.

## 2. Threat model

| ID | Threat | Actor | Impact |
|----|--------|-------|--------|
| T1 | Crypto mining inside an instance | Any visitor | Credit burn, Solari acceptable-use violation |
| T2 | Outbound proxying or scanning from an instance | Any visitor | Abuse traffic attributed to Solari's egress and to the operator |
| T3 | Hosting malware or phishing on a `previewUrl` and sharing the link | Any visitor | Reputation damage to Solari's preview domain, possible domain blocklisting |
| T4 | Credit exhaustion as denial of service | Scripted attacker | Site dead for the reviewer, $20 gone |
| T5 | `previewUrl` sharing, or leakage of the URL into a public artifact | Passer-by | One visitor lands in another visitor's instance. **Guessing is off the table**: the URL carries a one-hour `pt_token` (V21). Leakage is the whole remaining risk. |
| T6 | Visitor-entered data captured in a fork-my-state snapshot (PII, abuse content) | Careless or malicious visitor | Operator now stores and redistributes third-party content |
| T7 | Clickjacking via an iframed instance | Attacker embedding Blink | Visitor tricked into acting inside their own instance |
| T8 | Shared default credentials, since every fork of a snapshot has the same admin password | Any visitor | Trivially predictable login on every instance; harmless alone, dangerous combined with T5 |
| T9 | Swarm used as a DDoS tool | Any visitor | 12 browsers pointed at a victim; Solari's IPs implicated |
| T10 | Relay abuse (opening many WebSockets, driving frame production) | Scripted attacker | Host bandwidth and CPU exhausted, browser-seconds burned |
| T11 | Scraping or scripting the launch endpoint | Scripted attacker | Slot starvation and credit burn without a browser |
| T12 | Plan downgrade exposing hard-coded Starter assumptions | Time | Launch loop against a 1-sandbox limit, 429 storm, broken site |

## 3. Controls mapped to threats

| Control | Threats |
|---------|---------|
| Cloudflare Turnstile on Launch, Extend, and Swarm, verified server-side before any Solari call | T4, T9, T10, T11 |
| Budget guard ceilings in sandbox-seconds and browser-seconds: per launch (1200 sandbox-seconds, 600 browser-seconds), per IP per day (5 launches, 2 Swarm runs on Starter; 2 and 1 on Free), global per day (21,600 sandbox-seconds and 3,600 browser-seconds on Starter; 2,880 and 720 on Free), refused before starting, 429 treated as a guard bug and never retried (D7) | T1, T4, T9, T10, T11 |
| **Three-layer expiry (D4)**, because Solari's `timeoutMs` is an idle timer that every action and open connection resets, not a wall clock, and so is not a backstop on its own (`00-verification.md` C-1). Layer 1: the expiry sweeper calls `kill()`. Layer 2: a guest-side self-destruct scheduled by the boot script stops the app process at a fixed wall-clock deadline. Layer 3: `timeoutMs` 180 s with `onTimeout: "kill"`, refreshed by a 45 s server heartbeat tolerating two misses, so server death costs at most 3 minutes of overrun ($0.0029). `onTimeout` is **never** `"pause"` for a visitor instance: a paused zombie neither bills nor counts against concurrency, which is exactly what would make it invisible and permanent | T1, T2, T3, T6 |
| **Layer 2 is the one that matters for abuse.** It is the only layer indifferent to visitor activity, and a miner or an outbound proxy user is active by definition. Layers 1 and 3 protect the credit balance; layer 2 protects against the visitor | T1, T2 |
| **Guest-side egress denial as the primary control, not the fallback.** No platform-level egress feature is documented anywhere in Solari's docs (V32), so G6 tests what can actually be built: the boot script installs `nftables` rules denying all outbound except loopback before the app starts, and G6 also tests whether a non-root app user can remove them. Visitors have no shell in v1, so a guest-side firewall is a real control rather than a courtesy. Package mirrors are needed at snapshot build time only, never at run time, so deny-all-except-loopback is the run-time default | T1, T2, T3 |
| **CONFIRMED 2026-09-03. Blink ships with no network restriction at all, and that is a known accepted gap, stated here rather than implied away.** G6 found the guest running as root with every capability set, and the kernel carrying no netfilter subsystem: `nft` returns `Operation not supported`, there is no `nf_tables` module, no `modprobe` and no `iptables` (V57). This is not a permission gap that could be granted, so there is no workaround and none was attempted. No guest-side firewall can be installed, and Solari documents no platform-level egress control (V32), so there is nothing to fall back to on the network layer. **The site must not claim outbound is restricted, because it is not.** The whole control for T1 and T2 is then: 1 vCPU being a poor miner, memory caps, 10-minute lifetimes, the `metrics()` CPU sampler flagging sustained 100% usage for kill, and **layer 2 of the three-layer expiry, the guest-side self-destruct, which is the only layer indifferent to visitor activity**. That combination bounds the damage a miner can do to one vCPU for ten minutes; it does not prevent outbound traffic, and the site should not claim otherwise. `metrics()` returning `{cpuPct, memBytes, memTotalBytes, diskBytes}` (V13) makes the sampler implementable as specified | T1, T2 |
| Swarm restricted to instances Blink itself launched, or the developer's own portfolio as the prefilled demo. The target URL is never taken from user input; it is read from the `instance` row (D6) | T9 |
| v2 external targets require ownership verification before a URL is eligible: a `blink-verify` meta tag on the target page or a DNS TXT record containing a per-user token, re-checked at run time, plus a hard cap of 12 browsers and 45 seconds and one run per domain per hour. Designed now, not shipped in v1 | T9 |
| Share snapshots (D9) expire in 7 days, show a fork counter, carry a visible report-abuse link on every share page, and are deleted on report pending review. A snapshot the operator has not inspected is never featured anywhere on the site | T3, T6 |
| The share page states plainly, before the snapshot is taken, that anything typed into the instance will be copied into a link anyone can open. Snapshot is opt-in per session and never automatic | T6 |
| No visitor data is persisted beyond share snapshots. Instances are killed, not archived. Screenshots on catalog cards come from canary runs, never from visitor instances | T6 |
| `Content-Security-Policy` with `frame-ancestors 'self'` on all Blink pages, plus `X-Frame-Options: DENY` on the toolbar and admin pages. Blink may embed an instance; nobody may embed Blink | T7 |
| Per-fork admin credentials generated at boot where the app supports it: Gitea admin password is set by the boot script from a per-instance random value and shown once in the toolbar; Uptime Kuma and Metabase are seeded through their setup APIs at fork time with a per-instance password where that is possible. Where an app cannot take a boot-time password, the card states plainly that credentials are shared and the instance is disposable | T5, T8 |
| `previewUrl` treated as a bearer capability, now confirmed to be exactly that: it "carries a one-hour `pt_token` query parameter", also accepted as the header `x-pinetree-preview-token`, and an expired token returns 401 (V21). The URL is the secret, it is shown only to the launching session and to whoever they choose to share it with, it is never listed publicly, and both the instance and the token expire regardless. The one-hour token ceiling is shorter than any extended instance lifetime, so the capability cannot outlive its usefulness | T5 |
| **The `pt_token` must never appear in a durable artifact, in EITHER of its two forms.** It travels as a `?pt_token=` query parameter and, confirmed by G5 on 2026-09-03, also as the cookie **`__pt_preview`** (`HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=3597`, matching the documented one hour). Its JWT payload carries `sandboxId`, `port`, `orgId` and `exp`, is base64-decodable by anyone holding it, and therefore **discloses the org id** as well as granting access. The preview domain also sets `AWSALB` and `AWSALBCORS` stickiness cookies with a 7-day expiry, so redaction covering only the URL form leaks it through cookie jars, captured HAR files, browser session replays and any `Set-Cookie` echoed into a log. All three cookies plus the URL form are redacted at the logger. Redaction covering only `?pt_token=` would leak the capability through cookie jars, captured HAR files and browser session replays, which is precisely the material a debugging session tends to keep. It is redacted from every log line, and it is never written into an OG image, a share page, the public canary log, a swarm report page, or any screenshot published on the site. The `instance.preview_url` column is nulled on destroy (section 4). Redaction is applied at the logger, not at each call site, so a new call site cannot forget | T5 |
| **The pty terminal is CUT from v1.5 and moved to v2, blocked on a network control existing.** The earlier plan was to constrain it: run the shell as a non-root user that cannot edit the `nftables` rules. G6 removed that option by establishing there are no `nftables` rules to edit and no way to create any (V57). Without a network control, a shell converts "the app can make outbound requests" into "the visitor can make **any** outbound request, interactively", which is a categorical increase in what T2 and T3 permit, not a marginal one. There is no version of the terminal that is safe to ship while outbound is unrestricted, so it does not ship. Removed from the toolbar spec in `04-frontend-spec.md` section 3 rather than left greyed out, because a disabled control invites someone to enable it | T1, T2, T3 |
| Rate limits on every mutating endpoint at the Cloudflare edge and again in the process: launch 5 per IP per day, extend 1 per instance, swarm 1 per instance per 2 minutes, share 1 per instance, admin endpoints 10 per minute | T4, T9, T10, T11 |
| Relay caps: one WebSocket per swarm run, run bound to an instance the socket's session owns, 45-second hard teardown, disconnect kills every browser session, idempotent kill sweeper | T10 |
| `plan_config` table drives every limit and rate, so the Starter to Free downgrade is a row update. A startup assertion compares configured `max_sandboxes` against the plan and refuses to start the warm pool if they disagree | T12 |
| Pinned dependencies with a committed lockfile, `npm ci` in CI and in deploy, Dependabot on, no postinstall scripts from unpinned sources | supply chain |
| Solari acceptable-use review: **done. Granted in writing 2026-09-10** (`docs/q6-permission.md`). Anonymous public visitors driving sandboxes on one operator key is permitted on Starter. The safeguards named in the request are what was approved, so removing one means asking again | T1, T2, T3, T9 |

## 3.1 What Blink actually hands a visitor (Q5 resolved negative)

**Blink hands anonymous strangers a root shell's worth of unrestricted outbound network access, from Solari's egress, for ten minutes at a time.** That is the plain statement, and every control below should be read against it rather than instead of it.

G6 established that no network restriction is available at any layer (V57): the guest is root with every capability set, the kernel carries no netfilter subsystem, and no platform-level egress control is documented (V32). This is a property of the platform, not a Blink design choice, and there is no workaround.

**The controls constrain volume, not category.** That distinction is the whole security posture and it should not be blurred:

| | |
|---|---|
| What the controls do bound | How much compute and wall-clock time one visitor gets: 1 vCPU, 2 GB, 10 minutes, one extension, per-IP and global daily ceilings. |
| What they do not bound at all | What that machine talks to. |

A 1 vCPU box for 10 minutes is a **poor miner**, which is the threat the caps were designed against. It is a perfectly **good proxy, spam relay, vulnerability scanner, or credential-stuffing client**, because none of those need much CPU and all of them are useful in ten-minute bursts. Every packet leaves from Solari's egress and is attributed to Solari's IP space and to this operator's account.

That is the accepted risk. It is accepted because the alternative is not shipping, and because the mitigations that remain (short lifetimes, hard kills, Turnstile, per-IP ceilings, the CPU sampler, and the guest-side self-destruct) do bound the blast radius per visitor even though they cannot bound the kind of traffic. It is stated here, disclosed to Solari in the permission request (`01-prd.md` section 10.1), and it is the single strongest argument for keeping instance lifetimes short.

### 3.1a Three independent findings that converge on the same weakness

Written as one convergence rather than three separate notes, because that is what it is, and because three confirmations of a weak control is a much stronger claim than one.

The three-layer expiry design (`02-architecture.md` section 8.2) was written on the assumption that its layers were independent, so that any one of them failing left the other two. Measurement has since established that **two of the three layers are weak against exactly the visitor the design exists to contain**, and it did so from three unrelated directions:

| # | Finding | Source | What it removes |
|---|---------|--------|-----------------|
| 1 | `timeoutMs` is an **idle** timer, not a wall clock. Every action and open connection resets it. | Documentation read, C-1, 2026-09-03 | The original single-mechanism backstop |
| 2 | **Traffic to `previewUrl` resets that clock.** A sandbox with `timeoutMs` 90 s survived 58 requests over 135 s with no SDK calls at all. | Q17, measured in G3, twice | Layer 3 against any visitor who keeps loading pages |
| 3 | **The guest kernel has no netfilter.** Root holds every capability and `nft` still returns `Operation not supported`. No egress control is possible at any layer. | Q5, measured in G6 | Any network-level containment at all |

Each was found while looking for something else. Finding 1 came from reading documentation for an unrelated reason. Finding 2 was a sub-measurement bolted onto a latency gate. Finding 3 was a gate expected to answer a permissions question and which answered a kernel question instead. None of the three was looking for the others, which is the reason the agreement is worth something.

**What they converge on: layer 2, the guest-side self-destruct, carries abuse containment alone, and there is nothing behind it.**

- Layer 1, the expiry sweeper, dies with the server process. It handles the normal case and nothing else.
- Layer 3, the dead-man refresh, is defeated by the visitor simply using their instance (finding 2). Against an idle visitor it works; against an active one, which is the definition of an abusive one, it does not.
- There is no network layer at all to fall back to (finding 3).

So the wall-clock `pkill` that the boot script schedules inside the guest is the only mechanism that is indifferent to what the visitor does. That is a **single point of failure for T1, T2 and T3**, and it is stated here rather than left implicit, because a reader of the earlier draft would reasonably have concluded there were three lines of defence.

**Consequences already taken:** the pty terminal is cut to v2 (a visitor with a shell can kill the self-destruct process, and there is no firewall to fall back on), the CPU sampler below is specified rather than mentioned, and instance lifetimes stay short because lifetime is now the primary control rather than a convenience.

**Consequence not yet taken, and worth deciding before launch:** the self-destruct is a `sleep` in a shell process. It should be hardened to survive a visitor who finds and kills it, or its failure should at least be observable. A control this load-bearing should not be a single unmonitored background process.

### 3.2 The CPU sampler, defined

An undefined sampler is not a control, so:

| Property | Value |
|---|---|
| Source | `metrics()` on each live instance, returning `{cpuPct, memBytes, memTotalBytes, diskBytes}` (V13) |
| Interval | every **20 seconds** per live instance |
| Trip condition | `cpuPct >= 90` on **3 consecutive samples**, so roughly 60 seconds of sustained near-full CPU |
| Why not one sample | A legitimate first-load spike (Metabase booting, Gitea indexing a push) saturates 1 vCPU briefly. One sample would kill real users. |
| Action on trip, in order | 1. `kill()` the sandbox immediately. 2. Write an `instance` row with `end_reason = "cpu_abuse"` and the three sample values. 3. Ban that `ip_hash` for **24 hours** at both the edge and in-process. 4. Write a line to the public canary log, without the IP hash. |
| Visitor-facing | The toolbar shows `This instance was stopped for sustained full CPU use.` with the partial cost receipt. No appeal path in v1. |
| Known limit | It catches mining. It does **not** catch proxying, scanning or spam relay, none of which are CPU-bound. Those are bounded only by the 10-minute lifetime. |

### 3.3 What an invite link discloses, and why that is accepted

**Stated acceptance, not an oversight.** Anyone holding a `previewUrl` holds the `__pt_preview` cookie value, which is a JWT that anyone can base64-decode without a key. Signature verification protects it from forgery; it does nothing to hide its contents. The full claim list, from decoding a live one on 2026-09-03 (G5, V60):

| Layer | Claim | Discloses |
|---|---|---|
| Outer | `sandboxId` | Not an opaque id: a **nested signed token**, decoded below |
| Outer | `port` | Which in-guest port is exposed |
| Outer | `orgId` | **This operator's Solari organization id** |
| Outer | `exp` | Expiry, ms epoch, one hour out |
| Inner | host/pool identifier | **Solari's internal host pool identifier**, which embeds what appears to be a cloud instance id |
| Inner | vm identifier | Solari's internal VM id for this sandbox |
| Inner | org identifier | The organization id again, duplicated |
| Inner | timestamp | Sandbox creation time, ms epoch |

Seven distinct claims across two layers, not the four the outer token appears to carry.

**Why this is accepted rather than fixed.** None of it is Blink's to fix: the token is minted by the preview domain and Blink cannot alter its claims. The realistic harm is low. `orgId` is an opaque identifier that grants nothing on its own; there is no documented endpoint that takes an org id from an unauthenticated caller. The token expires in an hour and the instance it addresses dies in ten minutes. Blink already treats the URL as a bearer capability and never publishes one.

**What is worth reporting upstream:** the inner claims disclose *Solari's own* infrastructure identifiers, including a host pool id, to anyone who is handed an invite link by a visitor. That is Solari's disclosure decision rather than Blink's. It goes as a follow up on the thread Q6 opened, as a courtesy rather than a complaint, and deliberately not folded into the permission request itself.

**Smaller, second item.** The preview domain also sets `AWSALB` and `AWSALBCORS` load-balancer stickiness cookies with a **7-day expiry**, against an instance that lives at most 20 minutes. They outlive their subject by roughly 500 times. They are not capabilities and carry no access, so the impact is a stale cookie in a visitor's browser pointing at a hostname that stopped resolving to anything useful long ago, plus a small fingerprinting surface. Also not Blink's to change, also worth mentioning upstream, also not a blocker.

### 3.4 The previewUrl containment rule, and the audit against it

**The rule. A `previewUrl` never appears on any surface that can be crawled, cached, screenshotted, archived or indexed, and it is nulled from the `instance` row on destroy.**

The URL *is* the capability (V21) and it carries the `__pt_preview` JWT, which decodes without a key (V60). So a `previewUrl` that reaches a durable surface is both an access grant and an infrastructure disclosure. Blink's core loop mints these continuously and its share feature actively encourages visitors to pass them around, so containment has to be a rule with an audit rather than care at each call site.

Audited 2026-09-03. Every surface that could render one:

| Surface | Status | What was found, and what changed |
|---|---|---|
| Share page `/s/:token` | **Complies** | It renders a share *token*, not a `previewUrl`. Opening it launches a fresh instance whose URL is shown only to that visitor's own session. No change needed beyond the `noindex` below. |
| Swarm report `/swarm/:id` | **NEEDED A CHANGE** | It was specified to carry "the app and instance metadata". Instance metadata is exactly where a `previewUrl` would end up on a permanent public page. Narrowed: the report carries app id, timings, p95, consistency verdict and final screenshots only. **No instance id, no `previewUrl`, no host.** |
| OG images | **Complies** | Generated by screenshotting a server-rendered *catalog* page, never a live instance, so no token can reach the image. The rule is now explicit: the generator must never render a link as text and must never be pointed at a live `previewUrl`. |
| Canary log | **Complies** | Lines are `14:02:11 gitea ok fork 980ms health 240ms`. No URLs, by construction. |
| Public gate reports | **NEEDED A CHANGE** | `redact()` covered the query-parameter and header forms but **not the `__pt_preview` cookie**, which passed through untouched. Fixed, plus the `AWSALB`/`AWSALBCORS` cookies, with tests asserting all four forms. |
| Postgres `instance.preview_url` | **Complies, now enforced** | Nulled on destroy, on expiry, and on the lost-instance path. The 30-day row trim keeps timings and drops the column. `metric_sample` never had it. |
| Screenshots on catalog cards | **Complies** | Canary screenshots only, never visitor instances, and the canary drives its own instance whose URL it never renders. |

**Crawler controls.** `/s/:token` and `/swarm/:id` both serve `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` and carry `<meta name="robots" content="noindex, nofollow, noarchive">`. `robots.txt` disallows `/s/` and `/swarm/`. These are belt and braces on top of the rule: the pages should contain nothing sensitive even if indexed, and the directives mean a mistake is not permanent. Note that `noindex` does not protect against a page being fetched, only against it being listed, which is exactly why the containment rule above is the primary control and the directives are secondary.

## 4. Data handling and privacy

No accounts, no email, no login. A visitor is a random session token in a cookie, and a truncated SHA-256 of their IP with a rotating daily salt, used only for the per-IP ceiling. The raw IP is never written to Postgres.

Logged: app id, path (cold or warm), timings, sandbox id, outcome, ceiling decisions, canary results, ledger totals. Not logged: `previewUrl` values beyond the instance row's lifetime (nulled on destroy), request bodies, anything typed inside an instance, Swarm frames (relayed, never written to disk).

Analytics are aggregate only: launches per day, median fork time, apps launched, Swarm runs. No third-party analytics script, so there is nothing to disclose beyond a one-paragraph privacy note on the site.

Retention: `instance` rows are trimmed to 30 days with timings kept in `metric_sample` indefinitely because they are aggregate. `ip_hash` is deleted at 24 hours, the moment it stops being needed for the daily ceiling. Share snapshots and their rows are deleted at 7 days. Browser session recordings, if enabled at all, follow the plan's retention (7 days on Starter, 1 day on Free) and are not linked publicly.

## 5. Access model

Single operator. Admin routes (`/admin/*`) are behind a separate `ADMIN_SECRET` presented as a header or a signed cookie, are rate limited, are `noindex`, and carry `X-Frame-Options: DENY`. Admin actions: rebuild a snapshot, promote or demote a snapshot to current, drain the warm pool, pause all launches, force-kill an instance, delete a share snapshot, adjust ceilings, switch plan. Every admin action writes an audit row with the actor secret's fingerprint, the action, and the before and after values.

There is no user-facing role system, because there are no users.

**BYO-key mode is no longer only a v2 idea, and the constraint that enables it is enforced from day 1.** The Solari adapter takes an API key as a per-call argument and never reads `SOLARI_API_KEY` from the environment at the call site (`02-architecture.md` section 14). The operator key is resolved once at the process edge and threaded down. That single rule makes BYO-key a configuration flip rather than a rewrite, and it costs nothing to honour.

The handling, now that BYO-key is a designed alternative rather than the Q6 fallback (`01-prd.md` section 10.1), and if it is ever built as the v2 maintainer feature: the key is held in the browser session, forwarded per request, used server-side for that request only, and **never written to Postgres, never written to logs, and never included in any artifact, receipt, or report page**. It is redacted at the logger alongside the `pt_token`. A visitor's key is treated as a secret belonging to someone else, which is the strictest class of secret this system handles.

## 6. Incident playbook

**Credits drained unexpectedly.** Set `launches_enabled = false` through the admin route, which flips the site to the out-of-credits state (recorded launch plus last known health wall). Read the ledger by scope and day to find whether the burn was launches, warm pool, canaries, or Swarm. Reconcile against Solari's own usage. Kill every sandbox Solari lists that Blink does not own. Tighten the responsible ceiling, then re-enable. Publish the incident on the canary log page, because the transparency is the point.

**Abuse detected inside an instance.** Kill the instance immediately by sandbox id. If it came through a share link, delete the share snapshot and the row, which invalidates the link. Block the IP hash for 24 hours at the edge. If the abuse used outbound network, that is evidence G6's restriction is missing or bypassed, so disable share links and shorten lifetimes to 5 minutes until it is fixed. Notify Solari with the sandbox ids and timestamps.

**Solari outage.** Disable launches, keep cached pages serving, write an outage line to the public canary log, and leave the recorded launch available. Do not retry-loop. Resume when a manual smoke test passes.

**A bad snapshot shipped.** The canary catches it within one rotation (at most 5 hours; make it immediate for a snapshot just promoted by running the canary synchronously on promotion). Move `is_current` back to the previous good snapshot, mark the bad one `canary_status = "bad"`, and leave it in place for diagnosis rather than deleting it. If no good snapshot exists, disable the app on the catalog with a public note naming the failure.

**Key exposure.** Rotate the Solari key in the console, update the host secret, restart, kill every sandbox listed under the old key, and audit the ledger for the exposure window.

**Rotation is not instant. There is a 60-second revocation lag on Solari's side.** Solari documents that "Key verification is cached for 60 seconds, meaning revoked keys may continue authorizing briefly" (`00-verification.md` V41). This is Solari's own server-side verification cache. It holds nothing of Blink's, and it is not under Blink's control. It is named **revocation lag** everywhere in these docs, never "key cache", because that phrasing invited exactly the wrong reading.

What it means operationally: **for up to 60 seconds after rotation, a leaked key is still accepted by the gateway.** So the order matters and it is not the obvious one:

1. Rotate the key in the console.
2. Update the host secret and restart.
3. **Wait out the full 60 seconds.** Do not skip this.
4. Only now enumerate with `list()` and kill everything under the old key.
5. Re-run `list()` once more after the window, because a sandbox created during the lag would not have appeared in step 4.

Killing before the lag expires is worse than useless: an attacker holding the old key can create a sandbox in the gap that the sweep has already passed.

**Blink's own key retention, which is a separate thing.** The Solari adapter caches one client per key so repeated calls reuse a transport. That cache is keyed by a **SHA-256 digest of the key, never the key itself**, so the cache's own keys are not secrets. The client it holds necessarily retains the key in memory to sign requests, which is unavoidable, so the rules are about how long and where:

- **Never to disk.** No key is written to Postgres, to the ledger, to a report, or to any artifact.
- **Never to logs.** Keys are redacted at the logger alongside the `pt_token`, and the adapter refuses to serialise, returning a placeholder from `toJSON()` so that a key cannot leave inside an error report or a log formatter.
- **Evicted on instance destroy.** `forgetKey()` is called when the instance that supplied the key ends. In BYO-key mode (`01-prd.md` section 10.1) this is mandatory rather than hygiene, because the key belongs to a visitor.
- **Bounded.** The cache holds at most 32 clients and evicts oldest-first, so an unbounded number of visitors cannot grow it without limit.

In BYO-key mode the exposure window for a visitor's key is therefore the lifetime of their instance, plus Solari's 60-second revocation lag if they choose to rotate it afterwards. The share page says so before a visitor is ever asked for a key.

## 7. Open questions

The numbered list Q1 through Q17 lives in `docs/01-prd.md` section 11. The security-relevant ones, with Phase 0 status:

- **Q4** ~~Is a `previewUrl` derivable from a sandbox id?~~ **Resolved, and it resolves well.** It carries a one-hour `pt_token` (V21). T5 was the threat that would have forced an app-level password on every instance; it does not. Leakage into a durable artifact is the residual risk, and it is controlled at the logger.
- **Q5** Can outbound egress be restricted (G6)? **Still open, and no platform mechanism is documented at all** (V32). G6 therefore tests a guest-side `nftables` install as the primary candidate. This remains the single control that most reduces T1, T2 and T3.
- **Q6** Does Solari permit anonymous public visitors on the operator's key? **RESOLVED 2026-09-10: GRANTED.** Harry at Solari confirmed in writing that the use case is permitted on the Starter plan and to proceed with reactivating launches. Verbatim reply and scope note in `docs/q6-permission.md`. The terms alone never answered it either way, which is why this needed a person rather than a reading (V44).
- **Q12** What happens to running sandboxes and stored snapshots on downgrade to Free? **Still open, undocumented** (V40).
- **Q2** Can share links (D9) exhaust a snapshot count or size limit, and would that break canary rebuilds (G4)? **Still open, no published limits** (V30, V31). Related and newly known: snapshot deletion is refused with `409 SnapshotHasChildren` while a fork is live (V23), so the 7-day expiry sweeper must treat 409 as a normal re-queue rather than a failure.
- **Q18 (new)** Is snapshot storage billed, and is there an account-wide storage ceiling? Relevant here because **T6** (visitor data captured in a share snapshot) and **T4** (credit exhaustion as denial of service) both scale with snapshot count. A share-link flood is now bounded by the hard cap of 12 live share snapshots (`02-architecture.md` section 2.8), which was added for this reason, but an unlisted storage cost would still be an unmetered channel. Goes to Solari with Q6.
- **Q17 (new)** Does `previewUrl` traffic reset the sandbox idle clock? Measured in G3. It sizes layer 3 of the expiry design but does not decide it.

## Verification status of this doc

Phase 0 ran 2026-09-03. Full record in `00-verification.md`.

**Resolved:**

1. `previewUrl` is token-bearing, not public and not guessable: a one-hour `pt_token`, also accepted as `x-pinetree-preview-token`, 401 on expiry (V21). T5 is materially reduced and no app-level password is forced on every instance.
2. Browser session recordings are **off by default**: "The default is a fast headless browser with no profile, recording, proxy, or stealth" (V36). Recording is opt-in per session, and replay URLs are presigned and expiring rather than public (V35). Recording is also impossible on a headless sandbox at all, rejected as `400 RecordingRequiresDesktop` (V37), so a visitor instance cannot be recorded even by mistake.
3. API key rotation is not instantaneous: Solari's server-side verification carries a **60-second revocation lag** (V41). Section 6's playbook now orders the steps around it, and states Blink's own key-retention rules separately, since the two are different things and conflating them is how a visitor's key ends up somewhere it should not be.

**Still [UNVERIFIED]:**

1. Whether outbound egress can be restricted by **any** mechanism (Q5, G6). No platform feature is documented; the guest-side `nftables` approach is untested. Plan for it to fail and keep the CPU-cap fallback funded.
2. ~~Whether Solari permits anonymous public visitors on one operator key (Q6).~~ **Answered 2026-09-10: permitted.** No longer an open risk.
3. Whether Gitea, Uptime Kuma and Metabase can each take a per-fork admin password at boot without a manual step (V51). Gitea's `gitea admin user create` is documented and safe to assume; the other two are not confirmed. Settled during the day-5 recipes.
4. Whether snapshot count or size limits on Starter can be exhausted by share links (Q2, G4). G4 found no count ceiling at 5, and measured a bare snapshot at about 3.84 GB, so the exposure is real but now capped at 12 live share snapshots. Whether the bytes are billed is Q18.
5. Whether the preview domain applies its own framing or content headers, which would change the T7 analysis (Q3, G2).
6. Whether recording **retention** can be shortened or disabled outright, as opposed to recording itself being off. Only the per-plan retention windows are published (7 days on Starter). Low impact, since v1 records nothing.
7. Whether a non-root guest user can be prevented from removing `nftables` rules or killing the self-destruct timer, which is what the v1.5 terminal constraint rests on (G6).
