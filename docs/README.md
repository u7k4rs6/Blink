# The documents, and how to run it

| Doc | What it is |
|-----|------------|
| [`00-verification.md`](00-verification.md) | 114 rows. Every claim checked against a live source, with the verdict, the evidence and the cost. |
| [`06-what-broke.md`](06-what-broke.md) | The bugs, and what separates them. |
| [`01-prd.md`](01-prd.md) | Requirements, budget model, open questions. Section 2 is the problem this exists for. |
| [`02-architecture.md`](02-architecture.md) | 8.1 is the counting fetch, 8.2 is the three-layer expiry. |
| [`03-security-and-access.md`](03-security-and-access.md) | T1 to T12, for a site that hands strangers a Linux sandbox on one key. |
| [`04-frontend-spec.md`](04-frontend-spec.md) | Frontend spec, and where the published timings come from. |
| [`05-control-audit.md`](05-control-audit.md) | Each control, and the test that proves it fires. |
| [`q6-permission.md`](q6-permission.md) | The written permission to run anonymous public traffic on one operator key, and what was disclosed to get it. |
| [`gates/`](gates/) | Eight gates, the questions they answer, and their live reports. |
| [`art/`](art/) | The README figures, and the script that draws them. |

## Run it

Node 24, so there is no build step. `nvm use` picks it up from `.nvmrc`.

```
npm install
cp .env.example .env      # then fill in SOLARI_API_KEY

npm run web               # the site
npm test                  # 411 tests against fixtures, zero credits
npm run typecheck
npm run watchdog          # watches the site, the tunnel and itself
```

Gates and snapshot recipes spend real money, so both are opt in and both print
what they will cost before they start. See [`gates/`](gates/).

## Layout

```
src/orchestrator/   the launch state machine, the runner and the instance store
src/guard/          budget guard and sandbox ledger
src/solari/         adapter, counting fetch, recorded fixtures
src/web/            server, rendering, design tokens, the pixel field
src/canary/         continuous checks and the screenshots on the cards
src/warmpool/       warm pool and its own state machine
src/queue/          admission queue and promotion
src/billing/        per session cost, recorded rather than derived
src/redact.ts       structural redaction, with safe-io as the only writer
scripts/snapshots/  one recipe per app, plus the shared template
scripts/gates/      one runnable script per gate, plus the runner and sweeper
test/               411 tests against fixtures, zero credits
deploy/tunnel/      systemd unit, the tunnel runner and the edge worker
```

## Status and spend

Five apps built and seeded, eight gates run live, site deployed and self
restarting. 411 tests pass against recorded fixtures, so CI spends nothing.

The ledger records **812 sandboxes** created across the whole project, none still
live: 330 soak, 247 canary, 167 gates, 50 real launches, 37 snapshot builds. The
latest run of each gate sums to **$0.05465**, and two archived earlier runs add
**$0.01653**.

An exact all-time total is **not** reconstructible, and that is a gap rather than
an omission: `SandboxLedger` writes an open and a close per sandbox but never a
cost, so the file that knows every sandbox existed cannot say what any of them
cost. `src/billing/` is what fixes that for the product. The order-of-magnitude
answer, which is what the number is for, is that the whole project has cost well
under a dollar.
