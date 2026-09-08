/**
 * G1: fork to healthy.
 *
 * 20 forks each of 3 apps, cold and warm-resume, p50 and p95.
 *
 * THE KILL CRITERION, written here before the gate runs so the verdict is
 * printed rather than inferred (01-prd.md section 9):
 *
 *   Snapshots carry memory as well as disk (00-verification.md V22), so a cold
 *   fork may land within noise of a warm resume. IF COLD p95 IS WITHIN 500 ms OF
 *   WARM p50, THE WARM POOL IS DELETED FROM v1: D2, the warm pool manager, the
 *   replenish path and its reconciler all come out, and the cold number becomes
 *   the headline.
 *
 * Attempt counting (00-verification.md C-2): every sample records how many real
 * HTTP attempts its create took. A sample with attempts > 1 is FLAGGED, NOT
 * DROPPED, and the report gives p50 and p95 both with and without them. Retries
 * are capped at zero during gates, so a flagged sample means the cap fired and
 * the number is not a clean latency measurement.
 */

import { G1_APPS, APPS, loadRegistry, missingSnapshots } from "./lib/apps.ts";
import { previewHealthUrl, waitHealthy, waitHealthyInGuest } from "./lib/health.ts";
import { estimate } from "./lib/cost.ts";
import { fmtMs, stats } from "./lib/stats.ts";
import { table } from "./lib/report.ts";
import { main, type GateContext, type GateDefinition, type GateResult } from "./lib/harness.ts";
import { safeOut } from "../../src/safe-io.ts";
import { SIZE_SMALL } from "../../src/guard/rates.ts";

const FORKS_PER_APP = Number(process.env.BLINK_G1_FORKS ?? 20);
const WARM_POOL_DELETION_THRESHOLD_MS = 500;
/**
 * Cap on how long a fork stays alive, not a fixed duration.
 *
 * Forks are killed as soon as they are healthy. A slow cold fork should cost
 * wall-clock time, not sandbox-seconds, so billed time is the measured lifetime
 * capped at this value rather than this value flat. The pre-flight estimate
 * still uses the cap, because an estimate has to assume the worst.
 */
const MAX_SECONDS_PER_FORK = 30;

type Sample = {
  app: string;
  path: "cold" | "warm";
  i: number;
  /** Time from issuing create/resume to the app answering its health check. */
  totalMs: number;
  /**
   * Three phases, reported separately and never merged.
   *
   * G5 measured previewUrl overhead in the hundreds of milliseconds for a
   * trivial static file. A single fork-to-healthy number silently contains that
   * routing cost, so publishing one without the split invites claiming
   * preview-domain latency as fork speed. S2 and the recording beat both hang
   * off this number, so all three parts are always reported.
   */
  forkMs: number;
  /** The previewUrl() API round trip alone. */
  previewResolveMs: number;
  /** The first HTTP request through the resolved URL, alone. */
  previewFirstByteMs: number;
  healthCompleteMs: number;
  apiMs: number;
  healthMs: number;
  attempts: number;
  flagged: boolean;
  ok: boolean;
  error?: string;
};

function summarise(samples: Sample[]) {
  const ok = samples.filter((s) => s.ok);
  const clean = ok.filter((s) => !s.flagged);
  return {
    all: stats(ok.map((s) => s.totalMs)),
    clean: stats(clean.map((s) => s.totalMs)),
    flaggedCount: ok.length - clean.length,
    failed: samples.length - ok.length,
  };
}

async function run(ctx: GateContext): Promise<GateResult> {
  const reg = loadRegistry();
  const samples: Sample[] = [];

  // Progress output, because a gate that runs 15 minutes in silence is
  // indistinguishable from a hung one. The first live G1 run had to be tracked
  // by reading the sandbox ledger from another shell, which is a workaround
  // rather than a design. One line per sample, flushed as it goes.
  const totalSamples = G1_APPS.length * FORKS_PER_APP * 2;
  let done = 0;
  const started = performance.now();
  const progress = (s: Sample) => {
    done += 1;
    const elapsed = (performance.now() - started) / 1000;
    const eta = done > 1 ? ((elapsed / done) * (totalSamples - done)) / 60 : NaN;
    safeOut(
      `      [${String(done).padStart(3)}/${totalSamples}] ${s.app} ${s.path.padEnd(4)} ` +
        `${s.ok ? `${String(s.totalMs).padStart(6)} ms` : "   FAILED"} ` +
        `(fork ${s.forkMs} + health ${s.healthCompleteMs} + resolve ${s.previewResolveMs} + byte ${s.previewFirstByteMs})` +
        `${Number.isFinite(eta) ? `  eta ${eta.toFixed(1)}m` : ""}\n`,
    );
  };

  for (const appId of G1_APPS) {
    const app = APPS[appId]!;
    const snapshotId = reg[appId]!;

    for (let i = 0; i < FORKS_PER_APP; i++) {
      // ---- cold: create from snapshot, health check, kill ----
      const cold = await measureCold(ctx, appId, snapshotId, i);
      samples.push(cold);
      progress(cold);

      // ---- warm: create, pause, resume, health check, kill ----
      const warm = await measureWarm(ctx, appId, snapshotId, i);
      samples.push(warm);
      progress(warm);
    }
  }

  const cold = summarise(samples.filter((s) => s.path === "cold"));
  const warm = summarise(samples.filter((s) => s.path === "warm"));

  // The kill criterion.
  const delta = cold.all.p95 - warm.all.p50;
  const deleteWarmPool = Number.isFinite(delta) && delta <= WARM_POOL_DELETION_THRESHOLD_MS;

  const verdict = deleteWarmPool
    ? `DELETE THE WARM POOL. Cold p95 ${fmtMs(cold.all.p95)} is within ${WARM_POOL_DELETION_THRESHOLD_MS} ms of warm p50 ${fmtMs(warm.all.p50)} (delta ${fmtMs(delta)}). D2, the warm pool manager, the replenish path and its reconciler come out of v1, and the cold number becomes the headline.`
    : `KEEP THE WARM POOL. Cold p95 ${fmtMs(cold.all.p95)} exceeds warm p50 ${fmtMs(warm.all.p50)} by ${fmtMs(delta)}, more than the ${WARM_POOL_DELETION_THRESHOLD_MS} ms threshold, so the warm pool buys real time.`;

  const perApp: Array<Array<string | number>> = [];
  for (const appId of G1_APPS) {
    for (const path of ["cold", "warm"] as const) {
      const s = summarise(samples.filter((x) => x.app === appId && x.path === path));
      perApp.push([
        APPS[appId]!.name,
        path,
        s.all.n,
        fmtMs(s.all.p50),
        fmtMs(s.all.p95),
        fmtMs(s.all.min),
        fmtMs(s.all.max),
        s.flaggedCount,
        s.failed,
      ]);
    }
  }

  const md = [
    `## Kill criterion`,
    ``,
    `Declared before the run: **if cold p95 is within ${WARM_POOL_DELETION_THRESHOLD_MS} ms of warm p50, the warm pool is deleted from v1.**`,
    ``,
    `- Cold p95: **${fmtMs(cold.all.p95)}**`,
    `- Warm p50: **${fmtMs(warm.all.p50)}**`,
    `- Delta: **${fmtMs(delta)}** against a ${WARM_POOL_DELETION_THRESHOLD_MS} ms threshold`,
    ``,
    `**Verdict: ${deleteWarmPool ? "DELETE THE WARM POOL" : "KEEP THE WARM POOL"}.**`,
    ``,
    `## Overall`,
    ``,
    table(
      ["path", "n", "p50", "p95", "min", "max", "flagged", "failed"],
      [
        ["cold", cold.all.n, fmtMs(cold.all.p50), fmtMs(cold.all.p95), fmtMs(cold.all.min), fmtMs(cold.all.max), cold.flaggedCount, cold.failed],
        ["warm", warm.all.n, fmtMs(warm.all.p50), fmtMs(warm.all.p95), fmtMs(warm.all.min), fmtMs(warm.all.max), warm.flaggedCount, warm.failed],
      ],
    ),
    ``,
    `### Excluding flagged samples`,
    ``,
    `A flagged sample is one whose create took more than one real HTTP attempt, meaning the retry cap fired and the latency is not clean. Flagged samples are kept, not dropped, and shown separately.`,
    ``,
    table(
      ["path", "n clean", "p50 clean", "p95 clean"],
      [
        ["cold", cold.clean.n, fmtMs(cold.clean.p50), fmtMs(cold.clean.p95)],
        ["warm", warm.clean.n, fmtMs(warm.clean.p50), fmtMs(warm.clean.p95)],
      ],
    ),
    ``,
    `## Timing decomposition, so no number is published without knowing what is inside it`,
    ``,
    table(
      ["path", "fork or resume", "health (loopback)", "previewUrl() API", "first HTTP byte", "total"],
      (["cold", "warm"] as const).map((path) => {
        const ok = samples.filter((x) => x.path === path && x.ok);
        const st = (f: (s: Sample) => number) => stats(ok.map(f));
        return [
          path,
          fmtMs(st((x) => x.forkMs).p50),
          fmtMs(st((x) => x.healthCompleteMs).p50),
          fmtMs(st((x) => x.previewResolveMs).p50),
          fmtMs(st((x) => x.previewFirstByteMs).p50),
          fmtMs(st((x) => x.totalMs).p50),
        ];
      }),
    ),
    ``,
    `All figures are p50. The health check runs over **loopback inside the guest**, so it does not pay preview-domain overhead on every poll; \`previewUrl\` is resolved once for the handover and its first byte is timed separately. G5 measured that routing cost independently. **The headline number in \`01-prd.md\` S2 is fork plus health, and the previewUrl first byte is reported beside it, never folded in.**`,
    ``,
    `## Per app`,
    ``,
    table(["app", "path", "n", "p50", "p95", "min", "max", "flagged", "failed"], perApp),
    ``,
    `## What this means for S2`,
    ``,
    `\`01-prd.md\` S2 provisionally claimed warm p50 under 3.0 s. Measured warm p50 is ${fmtMs(warm.all.p50)}, which ${warm.all.p50 < 3000 ? "meets" : "does not meet"} that bar. Per D10 the site publishes the measured number either way, and never blends cold and warm.`,
  ].join("\n");

  return { observations: samples.filter((s) => s.ok).length, verdict, markdown: md, data: { samples, cold, warm, delta, deleteWarmPool, threshold: WARM_POOL_DELETION_THRESHOLD_MS } };
}

async function measureCold(ctx: GateContext, appId: string, snapshotId: string, i: number): Promise<Sample> {
  const app = APPS[appId]!;
  const t0 = performance.now();
  let sandboxId: string | null = null;
  let bornAt = 0;
  try {
    const created = await ctx.adapter.createSandbox(
      ctx.apiKey,
      "g1",
      {
        fromSnapshot: snapshotId,
        cpu: app.size.cpu,
        memMb: app.size.memMb,
        timeoutMs: 180_000,
        lifecycle: { onTimeout: "kill" },
        metadata: { ...ctx.metadata, blink_app: appId, blink_path: "cold" },
      },
      MAX_SECONDS_PER_FORK * 0.00002,
    );
    sandboxId = created.value.sandboxId;
    bornAt = performance.now();
    const apiMs = created.ms;
    const forkMs = Math.round(performance.now() - t0);

    // Health over LOOPBACK inside the guest, so the poll loop does not pay
    // preview-domain overhead up to 60 times (02-architecture.md section 2.2).
    // Node-side loop of short execs, NOT a long loop inside one exec. The latter
    // returns a bare `GatewayError: exec failed` once it passes the gateway's
    // own exec duration limit, which is how the first Gitea build died.
    const hcT0 = performance.now();
    const hc = await waitHealthyInGuest(
      (cmd, o) => ctx.adapter.exec(ctx.apiKey, created.value, "g1", cmd, o),
      app.port, app.healthPath, { timeoutMs: 60_000, intervalMs: 250 },
    );
    const healthCompleteMs = Math.round(performance.now() - hcT0);
    const healthy = hc.ok;

    // previewUrl resolved ONCE, for the handover, and its first byte timed on
    // its own so it is never hidden inside the fork number.
    // Two separate costs, measured separately. An earlier version timed both as
    // one and labelled the sum "previewUrl first byte", which overstated the HTTP
    // cost by about 1 s and hid an API round trip inside a network number. The
    // route-survival experiment in G3 is what exposed it.
    const pT0 = performance.now();
    const preview = await ctx.adapter.previewUrl(ctx.apiKey, created.value, "g1", app.port);
    const previewResolveMs = Math.round(performance.now() - pT0);
    const bT0 = performance.now();
    const health = await waitHealthy(previewHealthUrl(preview.value.url, app.healthPath), { timeoutMs: 20_000 });
    const previewFirstByteMs = Math.round(performance.now() - bT0);

    const totalMs = Math.round(performance.now() - t0);
    const attempts = created.attempts.length;
    return {
      app: appId, path: "cold", i, totalMs,
      forkMs, previewResolveMs, previewFirstByteMs, healthCompleteMs,
      apiMs, healthMs: healthy ? healthCompleteMs : health.ms,
      attempts, flagged: attempts > 1, ok: health.ok,
      ...(health.error ? { error: health.error } : {}),
    };
  } catch (err) {
    return {
      app: appId, path: "cold", i, totalMs: Math.round(performance.now() - t0),
      forkMs: 0, previewResolveMs: 0, previewFirstByteMs: 0, healthCompleteMs: 0,
      apiMs: 0, healthMs: 0, attempts: 0, flagged: false, ok: false,
      error: (err as Error).message,
    };
  } finally {
    if (sandboxId) {
      // Kill on healthy: bill the real lifetime, capped. A slow fork costs
      // wall-clock time, not credits.
      await ctx.adapter.killQuiet(ctx.apiKey, sandboxId, "g1");
      const lived = (performance.now() - bornAt) / 1000;
      ctx.guard.addSandboxSeconds(Math.min(lived, MAX_SECONDS_PER_FORK), app.size, true, `${appId} cold fork, observed lifetime`);
    }
  }
}

async function measureWarm(ctx: GateContext, appId: string, snapshotId: string, i: number): Promise<Sample> {
  const app = APPS[appId]!;
  let sandboxId: string | null = null;
  let bornAt = 0;
  try {
    // Build the warm fork first. Its cost counts, but not its latency: what we
    // are measuring is resume to healthy, which is what a visitor experiences.
    const created = await ctx.adapter.createSandbox(
      ctx.apiKey,
      "g1",
      {
        fromSnapshot: snapshotId,
        cpu: app.size.cpu,
        memMb: app.size.memMb,
        timeoutMs: 180_000,
        lifecycle: { onTimeout: "kill" },
        metadata: { ...ctx.metadata, blink_app: appId, blink_path: "warm" },
      },
      MAX_SECONDS_PER_FORK * 0.00002,
    );
    sandboxId = created.value.sandboxId;
    bornAt = performance.now();
    const pre = await ctx.adapter.previewUrl(ctx.apiKey, created.value, "g1", app.port);
    await waitHealthy(previewHealthUrl(pre.value.url, app.healthPath));
    await ctx.adapter.pause(ctx.apiKey, created.value, "g1");

    // Now the measurement proper.
    const t0 = performance.now();
    const resumed = await ctx.adapter.resume(ctx.apiKey, created.value, "g1");
    const forkMs = Math.round(performance.now() - t0);

    // Node-side loop of short execs, NOT a long loop inside one exec. The latter
    // returns a bare `GatewayError: exec failed` once it passes the gateway's
    // own exec duration limit, which is how the first Gitea build died.
    const hcT0 = performance.now();
    const hc = await waitHealthyInGuest(
      (cmd, o) => ctx.adapter.exec(ctx.apiKey, created.value, "g1", cmd, o),
      app.port, app.healthPath, { timeoutMs: 60_000, intervalMs: 250 },
    );
    const healthCompleteMs = Math.round(performance.now() - hcT0);
    const healthy = hc.ok;

    // The control URL changes on resume, and so may the preview URL, so both are
    // re-resolved rather than reused (00-verification.md V19).
    // Two separate costs, measured separately. An earlier version timed both as
    // one and labelled the sum "previewUrl first byte", which overstated the HTTP
    // cost by about 1 s and hid an API round trip inside a network number. The
    // route-survival experiment in G3 is what exposed it.
    const pT0 = performance.now();
    const preview = await ctx.adapter.previewUrl(ctx.apiKey, created.value, "g1", app.port);
    const previewResolveMs = Math.round(performance.now() - pT0);
    const bT0 = performance.now();
    const health = await waitHealthy(previewHealthUrl(preview.value.url, app.healthPath), { timeoutMs: 20_000 });
    const previewFirstByteMs = Math.round(performance.now() - bT0);

    const totalMs = Math.round(performance.now() - t0);
    const attempts = resumed.attempts.length;
    return {
      app: appId, path: "warm", i, totalMs,
      forkMs, previewResolveMs, previewFirstByteMs, healthCompleteMs,
      apiMs: resumed.ms, healthMs: healthy ? healthCompleteMs : health.ms,
      attempts, flagged: attempts > 1, ok: health.ok,
      ...(health.error ? { error: health.error } : {}),
    };
  } catch (err) {
    return {
      app: appId, path: "warm", i, totalMs: 0,
      forkMs: 0, previewResolveMs: 0, previewFirstByteMs: 0, healthCompleteMs: 0,
      apiMs: 0, healthMs: 0,
      attempts: 0, flagged: false, ok: false, error: (err as Error).message,
    };
  } finally {
    if (sandboxId) {
      await ctx.adapter.killQuiet(ctx.apiKey, sandboxId, "g1");
      // Billed time excludes the paused interval, which costs nothing (V19).
      // Capped at two lifetimes: the build before the pause, and the resumed one.
      const lived = (performance.now() - bornAt) / 1000;
      ctx.guard.addSandboxSeconds(Math.min(lived, MAX_SECONDS_PER_FORK * 2), app.size, true, `${appId} warm fork, observed lifetime`);
    }
  }
}

const def: GateDefinition = {
  id: "g1",
  title: "fork to healthy",
  question: "What are cold-fork and warm-resume time to healthy, p50 and p95, across three apps? (S2, and the warm-pool kill criterion)",
  ceilingUsd: 0.2,
  // One usable fork-to-healthy sample. Below half the intended 120 and any
  // percentile is theatre.
  minObservations: Math.floor(G1_APPS.length * FORKS_PER_APP * 2 * 0.5),
  observationUnit: "successful fork-to-healthy sample",
  preflight: () => missingSnapshots(G1_APPS),
  estimate: (plan) =>
    estimate(plan, [
      // cold: 1 lifetime each; warm: 2 lifetimes each (build then resumed).
      // Worst case: every fork runs to the cap. Real cost is kill-on-healthy.
      { sandboxSeconds: G1_APPS.length * FORKS_PER_APP * MAX_SECONDS_PER_FORK * 3, size: SIZE_SMALL },
    ]),
  run,
};

await main(def);
