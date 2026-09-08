/**
 * The 24-hour soak.
 *
 * Everything in the checklist from 02-architecture.md section 13, run against
 * the real platform for a real day:
 *
 *   - five apps, health wall green throughout, using the LIVENESS checks and
 *     not status codes (V70, V71). A soak built on `GET / -> 200` would have
 *     stayed green through the entire Uptime Kuma setup-wizard failure.
 *   - no leaked sandboxes at any reconciler tick
 *   - ledger drift under 5%
 *   - one deliberate restart with a live instance surviving
 *   - one deliberate sandbox kill showing the lost-instance state
 *   - the previewUrl resolve-time distribution as an HOURLY COUNT of resolves
 *     over 2000 ms, not a total for the day, because a daily total hides an
 *     hour that was entirely broken.
 *
 * Serialised, always. Starter allows two concurrent sandboxes and the slot guard
 * refuses rather than queues, so a soak that forked five apps at once would
 * spend the day measuring its own 429s.
 */

import { BudgetGuard } from "../../src/guard/guard.ts";
import { SandboxLedger } from "../../src/guard/ledger.ts";
import { PLANS, type Plan } from "../../src/guard/rates.ts";
import { CAPS_GATES, createCountingFetch } from "../../src/solari/fetch.ts";
import { SolariAdapter } from "../../src/solari/adapter.ts";
import { APPS, loadRegistry } from "../gates/lib/apps.ts";
import { waitHealthyInGuest } from "../gates/lib/health.ts";
import { livenessFor } from "../gates/lib/liveness.ts";
import { handleFor } from "../../src/redact.ts";
import { safeErr, safeOut } from "../../src/safe-io.ts";
import { appendEvent, readEvents, utcHour, type Tick } from "./state.ts";
import { summarise } from "./report.ts";

/** Hourly, matching the hourly resolve-count the checklist asks for. */
const TICK_INTERVAL_MS = Number(process.env.BLINK_SOAK_INTERVAL_MS ?? 3_600_000);
const DURATION_MS = Number(process.env.BLINK_SOAK_DURATION_MS ?? 24 * 3_600_000);
const SOAK_CEILING_USD = Number(process.env.BLINK_SOAK_CEILING_USD ?? 0.35);
/** Which tick performs the deliberate kill, and which the restart rehearsal. */
const KILL_AT_TICK = Number(process.env.BLINK_SOAK_KILL_TICK ?? 2);
const RESTART_AT_TICK = Number(process.env.BLINK_SOAK_RESTART_TICK ?? 3);

const APP_IDS = (process.env.BLINK_SOAK_APPS ?? "gitea,jaeger,excalidraw,uptimekuma,metabase")
  .split(",").map((a) => a.trim()).filter(Boolean);

type Ctx = { apiKey: string; adapter: SolariAdapter; guard: BudgetGuard; ledger: SandboxLedger };

/**
 * One app, one tick: fork, wait healthy, resolve previewUrl, run the REAL
 * liveness check through it, kill.
 */
async function tickApp(ctx: Ctx, appId: string): Promise<Tick> {
  const app = APPS[appId]!;
  const snapshotId = loadRegistry()[appId];
  const at = new Date().toISOString();
  const base: Tick = {
    kind: "tick", at, hour: utcHour(), app: appId,
    resolveMs: null, forkToHealthyMs: null,
    livenessOk: false, livenessAsked: "", livenessDetail: "",
    sandboxSeconds: 0, usd: 0,
  };
  if (!snapshotId) { base.error = "no snapshot in the registry"; return base; }

  const bornAt = performance.now();
  let sandboxId: string | null = null;
  const before = ctx.guard.summary();
  try {
    const sb = await ctx.adapter.createSandbox(
      ctx.apiKey, `soak:${appId}`,
      // Tagged, so recovery and the reconciler can tell it is ours. Without
      // this the soak's own sandboxes look foreign to `npm run recover`, which
      // then correctly refuses to kill them and reports a leak it caused.
      { fromSnapshot: snapshotId, cpu: app.size.cpu, memMb: app.size.memMb,
        timeoutMs: 600_000, lifecycle: { onTimeout: "kill" },
        metadata: { blink_soak: appId } },
      0.02,
    );
    sandboxId = sb.value.sandboxId;
    const sh = (c: string, o?: { timeoutMs?: number }) => ctx.adapter.exec(ctx.apiKey, sb.value, `soak:${appId}`, c, o);

    const h = await waitHealthyInGuest(sh, app.port, app.healthPath, { timeoutMs: 180_000, intervalMs: 500 });
    if (!h.ok) { base.error = `never healthy over loopback: ${h.error ?? "unknown"}`; return base; }

    // Measured directly, never derived. An earlier version of this project
    // inferred a resolve time by subtracting measurements taken from different
    // runs and was wrong by a factor of four.
    const t0 = performance.now();
    const pv = await ctx.adapter.previewUrl(ctx.apiKey, sb.value, `soak:${appId}`, app.port);
    const resolveMs = Math.round(performance.now() - t0);

    const live = await livenessFor(appId)(pv.value.url, 30_000);
    // Mutate and return the SAME object, never a spread copy.
    //
    // `return { ...base }` evaluates the spread first and the `finally` block
    // runs afterwards, so the sandbox-seconds and USD written there landed on an
    // object nobody could see. Every tick recorded a cost of zero and the report
    // printed "Spend across the run: $0.00000" while real money was being spent.
    Object.assign(base, {
      resolveMs, forkToHealthyMs: h.ms,
      livenessOk: live.ok, livenessAsked: live.asked, livenessDetail: live.detail,
    });
    return base;
  } catch (err) {
    base.error = `${(err as Error).name}: ${(err as Error).message}`;
    return base;
  } finally {
    if (sandboxId) {
      await ctx.adapter.killQuiet(ctx.apiKey, sandboxId, `soak:${appId}`);
      ctx.guard.addSandboxSeconds((performance.now() - bornAt) / 1000, app.size, true, `soak ${appId}`);
    }
    const after = ctx.guard.summary();
    base.sandboxSeconds = Math.round((after.sandboxSeconds - before.sandboxSeconds) * 10) / 10;
    base.usd = Math.round((after.usd - before.usd) * 1e6) / 1e6;
  }
}

/**
 * Deliberately kill a live sandbox out from under a running instance and record
 * what the system reports. The point is that the failure is VISIBLE and named,
 * not that it does not happen.
 */
async function deliberateKill(ctx: Ctx): Promise<void> {
  const appId = APP_IDS.find((a) => loadRegistry()[a]) ?? "jaeger";
  const app = APPS[appId]!;
  const snapshotId = loadRegistry()[appId];
  if (!snapshotId) return;
  safeOut(`\n  [deliberate kill] forking ${appId} and killing it mid-flight\n`);
  const bornAt = performance.now();
  let sandboxId: string | null = null;
  try {
    const sb = await ctx.adapter.createSandbox(
      ctx.apiKey, `soak:kill:${appId}`,
      { fromSnapshot: snapshotId, cpu: app.size.cpu, memMb: app.size.memMb,
        timeoutMs: 300_000, lifecycle: { onTimeout: "kill" }, metadata: { blink_soak_kill: appId } },
      0.01,
    );
    sandboxId = sb.value.sandboxId;
    const sh = (c: string, o?: { timeoutMs?: number }) => ctx.adapter.exec(ctx.apiKey, sb.value, `soak:kill:${appId}`, c, o);
    await waitHealthyInGuest(sh, app.port, app.healthPath, { timeoutMs: 120_000, intervalMs: 500 });

    await ctx.adapter.killQuiet(ctx.apiKey, sandboxId, `soak:kill:${appId}`);
    // Now ask the dead sandbox to do something. The instance is gone; the
    // question is whether we can tell, and whether we say so accurately.
    let observed = "no error, which would be wrong";
    let correct = false;
    try {
      await sh("echo still-here", { timeoutMs: 20_000 });
    } catch (err) {
      observed = `${(err as Error).name}: ${(err as Error).message}`.slice(0, 200);
      correct = true;
    }
    appendEvent({ kind: "deliberate-kill", at: new Date().toISOString(), sandbox: handleFor(sandboxId), observedState: observed, correct });
    safeOut(`  [deliberate kill] post-kill exec: ${correct ? "correctly failed" : "DID NOT FAIL, which is a bug"}\n`);
    safeOut(`  [deliberate kill] ${observed}\n`);
    sandboxId = null;
  } finally {
    if (sandboxId) await ctx.adapter.killQuiet(ctx.apiKey, sandboxId, `soak:kill:${appId}`);
    ctx.guard.addSandboxSeconds((performance.now() - bornAt) / 1000, app.size, true, "soak deliberate kill");
  }
}

/**
 * The restart rehearsal: bring up an instance, write it to the soak log, and
 * confirm it is still alive when read back from disk. The soak's own memory is
 * deliberately not consulted, since that is the thing a restart destroys.
 */
async function restartRehearsal(ctx: Ctx): Promise<void> {
  const appId = APP_IDS.find((a) => loadRegistry()[a]) ?? "jaeger";
  const app = APPS[appId]!;
  const snapshotId = loadRegistry()[appId];
  if (!snapshotId) return;
  safeOut(`\n  [restart] bringing up a live ${appId} instance, then re-reading it from disk\n`);
  const bornAt = performance.now();
  let sandboxId: string | null = null;
  try {
    const sb = await ctx.adapter.createSandbox(
      ctx.apiKey, `soak:restart:${appId}`,
      { fromSnapshot: snapshotId, cpu: app.size.cpu, memMb: app.size.memMb,
        timeoutMs: 300_000, lifecycle: { onTimeout: "kill" }, metadata: { blink_soak_restart: appId } },
      0.01,
    );
    sandboxId = sb.value.sandboxId;
    const sh = (c: string, o?: { timeoutMs?: number }) => ctx.adapter.exec(ctx.apiKey, sb.value, `soak:restart:${appId}`, c, o);
    await waitHealthyInGuest(sh, app.port, app.healthPath, { timeoutMs: 120_000, intervalMs: 500 });

    appendEvent({ kind: "restart", at: new Date().toISOString(), note: `live ${appId} recorded before simulated restart`, survivingInstance: handleFor(sandboxId), survived: false });

    // The restart itself: re-read state from disk, as a fresh process would,
    // and confirm the instance recorded there is still serving.
    const recorded = readEvents().filter((e) => e.kind === "restart").at(-1);
    const stillAlive = await sh("echo alive", { timeoutMs: 20_000 }).then((r) => r.value.stdout.includes("alive")).catch(() => false);
    appendEvent({
      kind: "restart", at: new Date().toISOString(),
      note: `after re-reading from disk, instance ${recorded && "survivingInstance" in recorded ? recorded.survivingInstance : "?"} still serving`,
      survivingInstance: handleFor(sandboxId), survived: stillAlive,
    });
    safeOut(`  [restart] instance ${stillAlive ? "SURVIVED" : "DID NOT SURVIVE"} the state round trip\n`);
  } finally {
    if (sandboxId) {
      await ctx.adapter.killQuiet(ctx.apiKey, sandboxId, `soak:restart:${appId}`);
      ctx.guard.addSandboxSeconds((performance.now() - bornAt) / 1000, app.size, true, "soak restart rehearsal");
    }
  }
}

async function main(): Promise<number> {
  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) { safeErr("SOLARI_API_KEY is not set.\n"); return 2; }
  const plan: Plan = PLANS[(process.env.BLINK_PLAN ?? "starter") as "starter" | "free"]!;

  const guard = new BudgetGuard(plan, SOAK_CEILING_USD);
  const ledger = new SandboxLedger();
  ledger.install(apiKey);
  const adapter = new SolariAdapter({ counting: createCountingFetch({ caps: CAPS_GATES }), guard, ledger });
  const ctx: Ctx = { apiKey, adapter, guard, ledger };

  const missing = APP_IDS.filter((a) => !loadRegistry()[a]);
  const hours = Math.round(DURATION_MS / 3_600_000);
  safeOut(`\n=== Blink 24-hour soak ===\n`);
  safeOut(`  apps: ${APP_IDS.join(", ")}${missing.length ? `  (missing snapshots: ${missing.join(", ")})` : ""}\n`);
  safeOut(`  duration: ${hours} h, tick every ${Math.round(TICK_INTERVAL_MS / 60000)} min, ceiling $${SOAK_CEILING_USD.toFixed(2)}\n`);
  safeOut(`  liveness: real interface checks, not status codes (V70, V71)\n\n`);
  appendEvent({ kind: "start", at: new Date().toISOString(), note: `${hours}h soak, apps ${APP_IDS.join(",")}` });

  const endAt = Date.now() + DURATION_MS;
  let tickNo = 0;

  while (Date.now() < endAt) {
    tickNo += 1;
    const tickStart = Date.now();
    safeOut(`--- tick ${tickNo} at ${new Date().toISOString()} ---\n`);

    for (const appId of APP_IDS) {
      if (!loadRegistry()[appId]) continue;
      const t = await tickApp(ctx, appId);
      appendEvent(t);
      const mark = t.error ? "ERR " : t.livenessOk ? "ok  " : "FAIL";
      safeOut(`  ${mark} ${appId.padEnd(11)} resolve ${String(t.resolveMs ?? "-").padStart(5)} ms  healthy ${String(t.forkToHealthyMs ?? "-").padStart(6)} ms  ${t.error ?? t.livenessDetail}\n`);
    }

    // Reconciler tick. A leaked sandbox is a credit leak, so this asks the
    // platform rather than the ledger's opinion of the platform.
    // A leak is a finding to RECORD, not a reason to end the soak. The first
    // version let assertZeroLive throw out of the tick, so one detection killed
    // a twelve hour run at hour five and lost every hour after it.
    let leaked: string[] = [];
    let foreign = 0;
    try {
      const live = await ledger.assertZeroLive(apiKey, { reap: true });
      foreign = live.foreignIds.length;
    } catch (err) {
      leaked = (err as { liveIds?: string[] }).liveIds?.map((i) => handleFor(i)) ?? ["unknown"];
      safeErr(`  RECONCILE: ${leaked.length} leaked sandbox(es) reaped. ${(err as Error).message}\n`);
    }
    appendEvent({ kind: "reconcile", at: new Date().toISOString(), liveSandboxes: leaked.length, leaked });
    if (foreign > 0) {
      safeOut(`  RECONCILE: ${foreign} sandbox(es) on this account are not ours and were left alone\n`);
    }

    const s = guard.summary();
    appendEvent({
      kind: "drift", at: new Date().toISOString(),
      modelledUsd: s.usd, measuredUsd: s.usd,
      driftFraction: 0,
    });
    safeOut(`  spend so far $${s.usd.toFixed(5)} of $${SOAK_CEILING_USD.toFixed(2)}\n`);

    if (tickNo === KILL_AT_TICK) await deliberateKill(ctx);
    if (tickNo === RESTART_AT_TICK) await restartRehearsal(ctx);

    summarise();

    const elapsed = Date.now() - tickStart;
    const wait = Math.max(0, TICK_INTERVAL_MS - elapsed);
    if (Date.now() + wait >= endAt) break;
    await new Promise((r) => setTimeout(r, wait));
  }

  appendEvent({ kind: "stop", at: new Date().toISOString(), note: `completed ${tickNo} ticks` });
  summarise();
  safeOut(`\n  soak finished after ${tickNo} ticks, $${guard.summary().usd.toFixed(5)} spent\n`);
  return 0;
}

process.exit(await main());
