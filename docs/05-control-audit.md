# Control audit

Every control in Blink that exists to stop something, listed with the evidence
that it works.

The audit exists because of one bug. The guest-side self-destruct was armed with
`pkill`, which is not on the base image, so it would have failed silently on
every instance of every app. The build step that installed it passed every single
time, because its postcondition asserted the script had been written and was
executable. Both true. Neither relevant.

> A control is tested by making it fire. Never by confirming it was installed.

"The file exists", "the flag is set", "the config parsed", "the handler is
registered" are all statements about arrangements, and every one of them can be
true while the control does nothing. The only evidence that a kill works is
something dying.

So the column that matters below is **how it was made to fire**, not whether the
code is present.

## Controls proven by firing

| Control | What it stops | Made to fire by |
|---|---|---|
| Budget guard refusal | A call that would exceed a ceiling | `guard.test.ts`: the guard refuses before the call, not after, and the refusal records nothing |
| Pre-flight spend refusal | A gates run above $0.40, or a gate above its own ceiling | `controls-fire.test.ts`: both bounds driven to refusal, plus the at-the-ceiling boundary that must still run |
| Counting fetch retry caps | Silent retries multiplying spend | `counting-fetch.test.ts`: a 503 produces exactly the documented attempt count at each cap; a 429 is exactly one attempt |
| Ledger ceiling under concurrency | Two launches both taking the last of the budget | `billing-ledger.test.ts`: a burst of concurrent reserves admits exactly as many as fit |
| Drift trip | Spending against a ledger known to be wrong | `controls-fire.test.ts`: 30% drift disables launches and moves the gauge to `reconciling`; small drift deliberately does not trip |
| Slot admission | A 429 at the concurrency limit | `admit.test.ts`: three concurrent launches against one free slot admit exactly one |
| Lock ordering | Deadlock between resource and billing locks | `scope-lock.test.ts`: a rank inversion throws `LockOrderViolation` naming both keys |
| Turnstile verification | Unattested launches | `turnstile.test.ts`: unreachable, non-200, missing secret and missing token each fail closed; single attempt |
| Redaction | Credentials and sandbox ids reaching an artefact | `stats-and-redaction.test.ts`: driven with the exact strings that leaked, including a sandbox id in a request path |
| Ledger path refusal | A credential-bearing ledger written inside the repo | `safe-io.test.ts`: construction is refused, and the refusal explains why |
| UTC day boundary | Ledger rows landing on the wrong day | `day.test.ts`: a non-UTC process is rejected at startup |
| CPU sampler kill path | Sustained mining on a free instance | `controls-fire.test.ts`: three consecutive high samples kill the sandbox; the kill is asserted to precede the bookkeeping |
| Expiry sweeper kill | A leaked sandbox billing unattended | `controls-fire.test.ts`: a DELETE is issued per open id; a failed or throwing delete keeps the id on the books |
| `kill_unconfirmed` in ENDING | A stalled kill parking an instance forever | `controls-fire.test.ts`: a breached ENDING deadline still reaches ENDED, leaving the id for the sweeper |
| Share-snapshot expiry deletion | GB-scale storage leaking on an unbilled line item | `controls-fire.test.ts`: expired rows deleted, unexpired untouched, failed deletes not marked done, second sweep idempotent |
| Share-snapshot cap | Unbounded snapshot storage | `controls-fire.test.ts`: the 12th refuses rather than evicting, and the cap lifts after a sweep |
| Self-destruct arming | A lifetime cap that cannot signal its own process | Every recipe now runs `proveSelfDestructStep`, which sends `kill -0` to the real PID from the pidfile |
| Recipe prerequisites | Four-minute builds failing on a missing binary | Every recipe runs `prerequisiteStep` first; a missing binary fails in about a second |
| Prerequisite guard | A prerequisite step asserting something the recipe installs later | `controls-fire.test.ts`: constructing one with any binary in `BASE_IMAGE_LACKS` throws. This caught a bug I had just written: Gitea's step asserted `git`, which the recipe apt-installs six lines further down |
| Engines range assertion | Building against a Node the project forbids | Excalidraw's recipe pins the declared range string, not just the version. The first Node 24 build failed in 12 seconds for $0.00066 instead of 20 minutes |
| Loopback-only monitors | Every Uptime Kuma instance probing a third party on a 60-second interval | `controls-fire.test.ts`: the seed script is parsed and every monitor URL asserted to be loopback, plus a check that no non-loopback absolute URL appears in it at all |
| Recipe entry-point guard | A module spending money as a side effect of being imported | `controls-fire.test.ts` imports all of them. Before the guard, importing a recipe tried to create a sandbox |
| Preview WebSocket URL | A websocket check failing for the wrong reason | `controls-fire.test.ts`: `pt_token` is asserted to survive the rewrite, since a naive rebuild from host and path drops it |

## Controls that cannot be made to fire in a test, stated rather than implied

Three, and each is listed with what does cover it instead.

**1. The guest-side self-destruct actually firing.** Proving it needs a real
sandbox to survive `sleep $LIFETIME` and then die, which is wall-clock time and
credits, not a unit test. What the test suite covers is the arming: the recipe
proves at build time that the PID is real, running, and signallable by this user,
which is the exact check that would have caught the `pkill` bug. What remains
unproven in CI is the timer itself. **The 24-hour soak is where it fires**, with
a deliberately short lifetime, and until that soak has run this control is armed
and unfired.

**2. The dead-man refresh, layer 3 of expiry.** It is not implemented. It is
specified in `02-architecture.md` as a 180-second lease with a 45-second
heartbeat, and there is no code, so there is nothing to fire. Listing it here
rather than in the table above is the point: the specification is not the control.

**3. `assertZeroLive` between gates.** It queries the live platform for orphans,
so a fixture-backed test would only prove that a fake returns what the fake was
told to return. It runs for real between every gate in a live run, and every
gates run so far has reported zero live sandboxes after teardown. That is
evidence from production rather than from CI, and it is the right kind here, but
it is not a test.

## What this audit did not cover

Controls that exist only in the frontend spec, since none of it is built yet.
When the launch sequence, cost receipt and instance toolbar land, each control
they introduce joins the table above or the list below it, with no third option.
