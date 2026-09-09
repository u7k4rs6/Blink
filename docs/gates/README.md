# The gates

Eight gates answer the questions that decide the build. Each is separately
runnable, writes a markdown report into `docs/gates/` and raw JSON into
`docs/gates/data/`, and prints its own cost before it starts and after it
finishes.

```
npm run gates            # pre-flight the whole run, then run G1 to G8
npm run gates -- --dry-run          # estimate only, zero credits
npm run gates -- --only=g2,g6       # a subset
npm run gate:g1          # one gate
npm run sweep            # kill orphans after an interrupted run
npm test                 # unit tests against fixtures, zero credits
npm run typecheck
```

Snapshot recipes are separate from the gates, because building a snapshot is
product work and a gate is a measurement. Each recipe dry-runs for nothing.

```
npm run snapshot:gitea -- --dry-run   # print the steps, spend nothing
npm run snapshot:gitea                # build it and record the id
npm run snapshot:jaeger
npm run snapshot:metabase
npm run snapshot:excalidraw
npm run snapshot:uptime-kuma          # ends with a websocket check through previewUrl
npm run check:excalidraw-assets       # fork the snapshot and prove fonts are served
```

| Gate | Question |
|------|----------|
| G1 | Cold and warm time to healthy, p50 and p95, 20 forks each of 3 apps. Carries the warm-pool kill criterion. |
| G2 | `previewUrl` framing headers, and whether the app works behind it: absolute URLs, websockets, cookies. |
| G3 | Resume latency, that pause frees the slot, and Q17: does preview traffic reset the idle clock. |
| G4 | Snapshot count, size, creation time, deletion rules. |
| G5 | CDP screencast relay: fps and bandwidth for 12 tiles in one process. |
| G6 | Can outbound egress be restricted, by a guest-side `nftables` firewall or otherwise. |
| G7 | Is the concurrency 429 immediate and non-retryable, and does it carry `Retry-After`. |
| G8 | Does a real browser's WebSocket survive Uptime Kuma's origin check behind `previewUrl`. A protocol that carries upgrades is not the same claim as a browser being admitted. |

### Rules the harness enforces, so no gate can forget one

- The budget guard wraps every Solari call, and a gate whose **estimate** exceeds
  its ceiling refuses **before** the first call. A refusal costs nothing.
- A full run is capped at **$0.40** and refuses to start above it. Current
  estimate for all seven: about **$0.13**.
- **A 429 is a guard bug, not a condition to handle.** It aborts the gate and
  dumps the full slot state. There is no retry loop anywhere in this codebase.
- Every gate kills what it created. A disk-backed ledger sweeps orphans on exit
  and on SIGINT, and an independent check asks Solari what is actually live
  rather than trusting the local file.
- Zero retries during gates, so G1 measures real latency.

### Two rules that shape `src/`

- **Key per call.** Every adapter function takes the API key as an argument.
  Nothing under `src/solari/` reads it from the environment; it is read once at
  the process edge in `scripts/gates/lib/harness.ts`. That makes the
  bring-your-own-key fallback (`01-prd.md` section 10.1) a config flip.
- **One fetch.** Every Solari HTTP request goes through the counting fetch in
  `src/solari/fetch.ts`. The SDK retries idempotent requests five times by
  default and `SandboxClient` exposes no way to disable it, so the injected
  `fetch` is the only place that sees every real attempt, and it owns the retry
  cap, the guard hook, the per-call deadline and the ledger.

---

# Gate reports

Written by `npm run gates`. Empty until the first live run.

- `g<N>.md` is the report a human reads, with the verdict at the top.
- `data/g<N>.json` is the raw sample data, and is also the capture source for
  replacing the synthesized fixtures in `src/solari/fixtures/` with real traffic.

Both are redacted on write: `pt_token` values and `slr_live_` keys never reach a
durable artifact (`03-security-and-access.md` section 3).
