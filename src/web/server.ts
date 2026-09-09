/**
 * The one always-on Node process (02-architecture.md).
 *
 * Serves the catalog, the health wall and the launch endpoint. No framework and
 * no build step: the pages are strings, the stylesheet is a string, and the only
 * client script is the launch handler.
 *
 * It reads REAL data. The health wall comes from the soak log and the app list
 * from the snapshot registry, so a page that claims a canary passed is claiming
 * something that happened. Where there is no measurement it says "no data"
 * rather than rendering a zero, because every other number here was measured and
 * one invented number would poison the rest.
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";

import { LaunchRunner, LaunchRefused, DEFAULT_LIFETIME_MS } from "../orchestrator/runner.ts";
import { BudgetGuard } from "../guard/guard.ts";
import { SandboxLedger } from "../guard/ledger.ts";
import { MemoryScopeLock } from "../concurrency/scope-lock.ts";
import { CAPS_DEFAULT, createCountingFetch } from "../solari/fetch.ts";
import { SolariAdapter } from "../solari/adapter.ts";
import { waitHealthyInGuest } from "../../scripts/gates/lib/health.ts";

import { safeOut, safeErr } from "../safe-io.ts";
import { at, renderCatalog, renderHealthWall, renderLaunchPanel, renderReceipt, renderToolbar, renderInstanceEnded, renderSharePage, shell, esc, type App, type Board } from "./render.ts";
import { createShare, resolveShare, MemoryShareStore, ShareRefused } from "../share/service.ts";
import { sweepExpiredShares } from "../share/expiry.ts";
import { QueueManager } from "../queue/manager.ts";
import { verifyTurnstile } from "../turnstile/verify.ts";
import { WarmPool } from "../warmpool/pool.ts";
import { setUpLedger, type LedgerSetup } from "../billing/setup.ts";
import { runCanaryOnce, type CanaryResult } from "../canary/runner.ts";
import { renderOffline, type OfflineSnapshot } from "./offline.ts";
import { readAll } from "../orchestrator/store.ts";
import { readFileSync as readBin } from "node:fs";
import { join as joinPath } from "node:path";
import { TOKENS, FONT_TEXT, CELL, RADIUS } from "./tokens.ts";
import { SEEDED } from "../catalog/credentials.ts";

/**
 * The seeded login for apps that have one, or null.
 *
 * Published deliberately. These accounts exist only inside a ten minute
 * instance that nobody else can reach, and withholding them is what left a
 * visitor at a password prompt under a card that said "logged in" (V103).
 */
function credentialsFor(appId: string): { user: string; password: string } | null {
  const c = (SEEDED as Record<string, { user?: string; password?: string }>)[appId];
  return c?.user !== undefined && c.password !== undefined
    ? { user: c.user, password: c.password }
    : null;
}
import { buildReceipt } from "./receipt.ts";
import { PLANS, SIZE_SMALL } from "../guard/rates.ts";
import { APPS, loadRegistry } from "../../scripts/gates/lib/apps.ts";
import { SOAK_LOG } from "../../scripts/soak/state.ts";

const PORT = Number(process.env.PORT ?? 8787);

const shares = new MemoryShareStore();
const queue = new QueueManager();

/**
 * Turnstile is REQUIRED in production and off only when explicitly disabled.
 *
 * The default is "on", so forgetting to configure it fails launches loudly
 * rather than quietly removing the only thing between an anonymous visitor and
 * a machine with unrestricted egress (Q5, V57). Turning it off has to be a
 * decision somebody typed.
 */
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET ?? "";
const TURNSTILE_DISABLED = process.env.BLINK_TURNSTILE_DISABLED === "1";

/**
 * Public launches off, everything else on.
 *
 * Set while the permission question (Q6) is out with Solari. The catalog, the
 * health wall and the canary log stay up, because they are the evidence and
 * they cost nothing on anyone else's account. Only the thing that creates a
 * sandbox on somebody's behalf is closed.
 *
 * Refused server side as well as hidden in the page, because a disabled button
 * is a decoration: the endpoint is what has to say no.
 */
const LAUNCHES_DISABLED = process.env.BLINK_LAUNCHES_DISABLED === "1";
const LAUNCHES_OFF_REASON =
  "Launches are paused while the operator confirms with Solari that public, " +
  "anonymous instances are permitted on this account. The catalog, the health " +
  "wall and the canary log are live and unchanged.";

/** Set at boot. Until then the site refuses launches rather than guessing. */
let billing: LedgerSetup | null = null;

/** Canary results, newest last. The health wall reads these. */
const canaryLog: CanaryResult[] = [];
const CANARY_INTERVAL_MS = Number(process.env.BLINK_CANARY_INTERVAL_MS ?? 15 * 60_000);

/** Card screenshots, written by the canary and served from here. */
const SHOT_DIR = process.env.BLINK_SHOT_DIR ?? joinPath(process.env.HOME ?? "/tmp", ".blink", "shots");
const shotPathFor = (appId: string): string => joinPath(SHOT_DIR, `${appId}.png`);

/**
 * The share expiry sweeper, on a timer.
 *
 * Snapshot storage is invisible to the budget guard (V56), so this sweep is the
 * only thing that reclaims it. It runs hourly and on boot, because a share that
 * expired while the process was down is exactly the leak nobody notices.
 */
const SHARE_SWEEP_MS = Number(process.env.BLINK_SHARE_SWEEP_MS ?? 3_600_000);

/**
 * The runner is created only when a key is present.
 *
 * Without one the site still serves: the catalog renders, the health wall
 * renders, and Launch returns a plain refusal saying so. A page that half works
 * and explains why beats a page that will not start.
 */
const apiKey = process.env.SOLARI_API_KEY;
let runner: LaunchRunner | null = null;
if (apiKey) {
  const guard = new BudgetGuard(PLANS.starter, Number(process.env.BLINK_WEB_CEILING_USD ?? 0.5));
  const ledger = new SandboxLedger();
  ledger.install(apiKey);
  runner = new LaunchRunner({
    apiKey,
    adapter: new SolariAdapter({ counting: createCountingFetch({ caps: CAPS_DEFAULT }), guard, ledger }),
    guard,
    ledger,
    lock: new MemoryScopeLock(),
    // Counted from our OWN records. A Solari 429 is a guard bug, not a source of
    // truth about how many slots we hold.
    liveSlots: async (): Promise<number> => runner?.liveCount() ?? 0,
    waitHealthy: async (sh, port, path) => {
      const r = await waitHealthyInGuest(
        // waitHealthyInGuest wants exitCode; the runner's shell type does not
        // promise one, so it is supplied here rather than widening the runner.
        (cmd, o) => sh(cmd, o).then((x) => ({ value: { exitCode: 0, ...x.value } })),
        port, path, { timeoutMs: 120_000, intervalMs: 400 },
      );
      return { ok: r.ok, ms: r.ms };
    },
  });
}

// Every exit path settles. An instance outliving the process is a bill.
/**
 * The warm pool, if enabled.
 *
 * Depth 0 disables it entirely, which is a supported configuration and the one
 * the G1 kill criterion points at if cold turns out to be within 500 ms of warm.
 */
const POOL_DEPTH = Number(process.env.BLINK_POOL_DEPTH ?? 0);
let pool: WarmPool | null = null;

function startWarmPool(): void {
  if (!runner || POOL_DEPTH < 1) return;
  pool = new WarmPool({
    apiKey: runner.apiKey, adapter: runner.adapter, lock: runner.lock,
    liveSlots: async () => runner!.liveCount(),
    maxSlots: runner.plan.maxSandboxes ?? 2,
    depth: () => POOL_DEPTH,
    waitHealthy: async (sh, port, path) => {
      const r = await waitHealthyInGuest(
        (cmd, o) => sh(cmd, o).then((x) => ({ value: { exitCode: 0, ...x.value } })),
        port, path, { timeoutMs: 120_000, intervalMs: 400 },
      );
      return { ok: r.ok, ms: r.ms };
    },
  });
  runner.attachPool(pool);

  const ids = Object.keys(APPS).filter((id) => loadRegistry()[id]);
  let i = 0;
  const tick = async () => {
    const id = ids[i % ids.length];
    i += 1;
    const app = id ? APPS[id] : undefined;
    const snap = id ? loadRegistry()[id] : undefined;
    if (!app || !snap) return;
    // Replenishment yields: it refuses before any Solari call when a visitor
    // would be left without a slot.
    await pool!.replenishOne({
      appId: app.id, snapshotId: snap, size: app.size, port: app.port, healthPath: app.healthPath,
      landingPath: app.landingPath,
    });
  };
  const t = setInterval(() => { void tick(); }, 60_000);
  if (typeof t.unref === "function") t.unref();
}

/**
 * Drain on shutdown, and say what happened.
 *
 * Instances AND parked warm forks. A paused fork that survives the process is a
 * sandbox nothing owns: it holds no slot and costs nothing while paused, so
 * nothing will notice it, and it stays until someone reads a bill. systemd gives
 * this 45 seconds (TimeoutStopSec), which is why it is bounded rather than
 * best effort.
 */
let draining = false;
async function drainAndExit(reason: string): Promise<void> {
  if (draining) return;
  draining = true;
  const t = setTimeout(() => {
    safeErr(`[shutdown] drain did not finish in time; exiting anyway. Run npm run sweep.\n`);
    process.exit(1);
  }, 40_000);
  if (typeof t.unref === "function") t.unref();
  try {
    const live = runner?.liveCount() ?? 0;
    await runner?.endAll(reason);
    const parked = pool ? await pool.drain() : 0;
    safeOut(`[shutdown] ${reason}: settled ${live} instance(s), drained ${parked} warm fork(s)\n`);
  } catch (err) {
    safeErr(`[shutdown] drain failed: ${(err as Error).message}. Run npm run sweep.\n`);
  } finally {
    clearTimeout(t);
    process.exit(0);
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void drainAndExit(`process ${sig}`);
  });
}

/** Copy that is the product, kept here rather than invented per render. */
const COPY: Record<string, { description: string; category: string; license: string; upstream: string; tryFirst: string[] }> = {
  gitea: {
    description: "A git forge with a seeded repo, three issues and a pull request waiting.",
    category: "developer tools", license: "MIT", upstream: "https://github.com/go-gitea/gitea",
    tryFirst: ["Open the seeded repo", "Read the open pull request", "File an issue"],
  },
  jaeger: {
    description: "Distributed tracing, already populated with traces from a running demo app.",
    category: "observability", license: "Apache 2.0", upstream: "https://github.com/jaegertracing/jaeger",
    tryFirst: ["Search traces for frontend", "Open a trace", "Look at the span timeline"],
  },
  excalidraw: {
    description: "A whiteboard that starts with a scene on it. Nothing is saved anywhere.",
    category: "drawing", license: "MIT", upstream: "https://github.com/excalidraw/excalidraw",
    tryFirst: ["Draw something", "Drag a shape", "Export a PNG"],
  },
  uptimekuma: {
    /*
     * "logged in" was a lie the visitor met immediately.
     *
     * The canary reaches the dashboard by typing the seeded password into the
     * form; a visitor got the form and no password (V103). The credentials are
     * on the card and on the toolbar now, so the copy says what actually
     * happens rather than what the screenshot shows.
     */
    description: "Uptime monitoring watching itself every twenty seconds. Sign in with the details shown when it launches.",
    category: "monitoring", license: "MIT", upstream: "https://github.com/louislam/uptime-kuma",
    tryFirst: ["Open the dashboard", "Look at a monitor", "Add one of your own"],
  },
  metabase: {
    description: "Business intelligence over a sample database of 18,760 orders.",
    category: "analytics", license: "AGPL", upstream: "https://github.com/metabase/metabase",
    tryFirst: ["Browse the sample database", "Ask a question", "Chart the answer"],
  },
};

type Tick = {
  kind: string; at: string; hour: string; app: string;
  /** previewUrl resolve time. NOT the fork time. */
  resolveMs: number | null;
  /** Fork to answering over loopback. This is what "fork" means on the page. */
  forkToHealthyMs: number | null;
  livenessOk: boolean; livenessAsked: string; error?: string;
};

function readTicks(): Tick[] {
  if (!existsSync(SOAK_LOG)) return [];
  const out: Tick[] = [];
  for (const line of readFileSync(SOAK_LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Tick;
      if (e.kind === "tick") out.push(e);
    } catch { /* a torn final line after a crash is expected */ }
  }
  return out;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  // Nearest rank, so every number shown was actually measured.
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

function buildApps(ticks: Tick[]): App[] {
  const registry = loadRegistry();
  const out: App[] = [];
  for (const id of Object.keys(APPS)) {
    if (!registry[id]) continue;
    const copy = COPY[id];
    if (!copy) continue;
    /**
     * The CANARY is the source of truth for a card, never the soak log.
     *
     * The soak is a measurement run that ends. Reading it here meant Jaeger's
     * card said "Down since 07:29" from a soak the day before, describing a
     * failure that had since been fixed, with no path to ever clearing: the run
     * that produced the record was over, so nothing would overwrite it. A
     * permanent false failure on one of five apps is worse than a stale number.
     *
     * The soak remains only as a cold-start fallback, for a fresh process that
     * has not completed a canary yet, and the card says which it is showing.
     */
    const canary = canaryLog.filter((c) => c.appId === id && !c.detail.startsWith("skipped"));
    const lastCanary = canary.at(-1);
    const mine = ticks.filter((t) => t.app === id);
    const last = mine.at(-1);
    // Fork time is fork to healthy. The first version used resolveMs and rendered
    // "last fork 0.27s" from a number measuring the previewUrl round trip, which
    // is four to five times smaller and a different thing. Two measurements, two
    // labels, no borrowing.
    const forks = mine.map((t) => t.forkToHealthyMs).filter((n): n is number => typeof n === "number");
    out.push({
      id, name: APPS[id]!.name, ...copy,
      lastForkMs: lastCanary?.forkToHealthyMs ?? forks.at(-1) ?? null,
      canary: lastCanary
        ? {
            ok: lastCanary.ok,
            asked: lastCanary.asked || lastCanary.detail,
            at: lastCanary.at,
            // Only from a run that actually happened, and only from THIS
            // process's canary, so a fixed app clears on its next check.
            downSince: lastCanary.ok ? undefined : lastCanary.at.slice(11, 16),
          }
        : {
            // No canary yet. Say so rather than borrowing a verdict from a run
            // that ended, which is what produced the permanent failure.
            ok: true,
            asked: "waiting for the first canary run",
            at: "never",
            downSince: undefined,
          },
      // Real screenshots come from canary runs (T6). Until one exists the card
      // shows an empty frame rather than a stock image pretending to be one.
      // Real screenshots, from the canary's own instance (T6). Null until one
      // exists, so a card shows an empty frame rather than a stock image.
      credentials: credentialsFor(id),
      shotUrl: existsSync(shotPathFor(id)) ? `/shots/${id}.png` : null,
      shotAt: existsSync(shotPathFor(id))
        ? `${new Date(statSync(shotPathFor(id)).mtimeMs).toISOString().slice(11, 16)} UTC`
        : null,
    });
  }
  return out;
}

function soakSummary(ticks: Tick[]): { continuousHours: number; distinctHours: number; runs: number } {
  const hours = [...new Set(ticks.map((t) => t.hour))].sort();
  const nums = hours.map((h) => Date.parse(`${h}:00:00Z`) / 3_600_000).sort((a, b) => a - b);
  let longest = nums.length > 0 ? 1 : 0;
  let run = longest;
  for (let i = 1; i < nums.length; i += 1) {
    run = nums[i] === nums[i - 1]! + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  const runs = existsSync(SOAK_LOG)
    ? readFileSync(SOAK_LOG, "utf8").split("\n").filter((l) => l.includes('"kind":"start"')).length
    : 0;
  return { continuousHours: longest, distinctHours: hours.length, runs: Math.max(1, runs) };
}

/**
 * A per-visitor token, so a queue entry belongs to somebody.
 *
 * Not an account and not tracking: a random opaque value in a session cookie,
 * used only so one visitor cannot remove another from the queue.
 */
function sessionTokenFor(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): string {
  const cookie = req.headers.cookie ?? "";
  const found = /blink_session=([A-Za-z0-9_-]+)/.exec(cookie);
  if (found) return found[1]!;
  const token = randomBytes(16).toString("base64url");
  res.setHeader("set-cookie", `blink_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
  return token;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  void queue.reap();
  const ticks = readTicks();

  const send = (code: number, body: string, type = "text/html; charset=utf-8") => {
    res.writeHead(code, {
      "content-type": type,
      // The instance page can carry a capability URL, so nothing here is cached
      // by an intermediary and nothing is framed by a third party.
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  };

  if (url.pathname === "/") {
    const apps = buildApps(ticks);
    /**
     * TIME TO READY, from real launches, because that is what the headline says.
     *
     * The board previously showed `forkToHealthyMs`, which is the health poll
     * ALONE, measured after `create()` had already returned. It is a component
     * of the 4.0 s ready figure, not the figure, and calling it "fork" invited a
     * reader to compare 1.18 s against a published 5.5 s and conclude one of
     * them was wrong. Both were right; the label was not.
     *
     * This is the interval a visitor actually experiences: from pressing Launch
     * to the instance being handed over. Null until somebody launches, and the
     * board says "no launches yet" rather than inventing one.
     */
    const readyMs = readAll()
      .filter((r) => r.lifetimeStartedAt !== null)
      .map((r) => r.lifetimeStartedAt! - r.createdAt)
      .filter((n) => n > 0);
    const today = new Date().toISOString().slice(0, 10);
    const board: Board = {
      instancesRunning: runner?.liveCount() ?? 0,
      launchedToday: readAll().filter((r) => new Date(r.createdAt).toISOString().slice(0, 10) === today).length,
      medianReadyMs: percentile(readyMs, 50),
      creditsUsedUsd: 0,
      creditsCapUsd: 20,
      staleSeconds: 0,
    };
    /**
     * The hero field is real canary history, six rows deep, oldest first.
     *
     * Padded with nulls rather than with passes, so a fresh start draws an empty
     * grid instead of a wall of green it has not earned. That is the whole point
     * of building the ornament out of data: it has to be able to look bad.
     */
    const FIELD_CELLS = 4 * 70;
    const recent = canaryLog.filter((c) => !c.detail.startsWith("skipped")).slice(-FIELD_CELLS);
    const canaryHistory: Array<boolean | null> = [
      ...Array<null>(Math.max(0, FIELD_CELLS - recent.length)).fill(null),
      ...recent.map((c) => c.ok),
    ];
    return send(200, renderCatalog(board, apps, process.env.TURNSTILE_SITE_KEY, canaryHistory,
      LAUNCHES_DISABLED ? LAUNCHES_OFF_REASON : undefined));
  }

  /**
   * The snapshot the Cloudflare Worker caches and serves when this laptop is
   * unreachable. Deliberately small and JSON: the Worker holds the markup, and
   * this only supplies the numbers, so the offline page can be restyled without
   * a redeploy of the site.
   */
  if (url.pathname.startsWith("/shots/") && url.pathname.endsWith(".png")) {
    const appId = url.pathname.slice("/shots/".length, -".png".length);
    if (!APPS[appId]) return send(404, "not found", "text/plain");
    try {
      const buf = readBin(shotPathFor(appId));
      res.writeHead(200, {
        "content-type": "image/png",
        // Short, so a rebuilt snapshot's new screenshot appears promptly.
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      });
      return res.end(buf);
    } catch {
      return send(404, "no screenshot yet", "text/plain");
    }
  }

  if (url.pathname === "/offline-snapshot.json") {
    const apps = buildApps(ticks).map((a) => {
      const last = canaryLog.filter((c) => c.appId === a.id).at(-1);
      return { name: a.name, asked: last?.asked || a.canary.asked, ok: last ? last.ok : a.canary.ok };
    });
    const resolves = canaryLog.map((c) => c.resolveMs).filter((n): n is number => typeof n === "number");
    const fallback = ticks.map((t) => t.resolveMs).filter((n): n is number => typeof n === "number");
    const source = resolves.length > 0 ? resolves : fallback;
    const snap: OfflineSnapshot = {
      capturedAt: new Date().toISOString(),
      apps,
      resolveP50Ms: percentile(source, 50),
      resolveP95Ms: percentile(source, 95),
      soak: soakSummary(ticks),
      awakeHoursUtc: process.env.BLINK_AWAKE_HOURS_UTC,
      recordingUrl: process.env.BLINK_RECORDING_URL,
      repoUrl: process.env.BLINK_REPO_URL,
    };
    return send(200, JSON.stringify(snap), "application/json");
  }

  /** Rendered here too, so the copy can be reviewed without simulating an outage. */
  if (url.pathname === "/offline-preview") {
    const apps = buildApps(ticks).map((a) => ({
      name: a.name, asked: a.canary.asked, ok: a.canary.ok,
    }));
    const resolves = ticks.map((t) => t.resolveMs).filter((n): n is number => typeof n === "number");
    return send(200, renderOffline({
      capturedAt: new Date().toISOString(), apps,
      resolveP50Ms: percentile(resolves, 50), resolveP95Ms: percentile(resolves, 95),
      soak: soakSummary(ticks),
      awakeHoursUtc: process.env.BLINK_AWAKE_HOURS_UTC ?? "09:00 to 22:00 UTC",
      recordingUrl: process.env.BLINK_RECORDING_URL,
      repoUrl: process.env.BLINK_REPO_URL,
    }));
  }

  if (url.pathname === "/health") {
    // Canary results first: they are this server's own measurements. The soak
    // log is a fallback for a fresh process that has not run a canary yet, and
    // it is a different thing, so it is never silently mixed in.
    const rows = buildApps(ticks).map((a) => {
      const canary = canaryLog.filter((c) => c.appId === a.id).slice(-24);
      const useCanary = canary.length > 0;
      const mine = ticks.filter((t) => t.app === a.id).slice(-24);
      const resolves = (useCanary ? canary.map((c) => c.resolveMs) : mine.map((t) => t.resolveMs))
        .filter((n): n is number => typeof n === "number");
      const last = canary.at(-1);
      return {
        app: a.name,
        asked: useCanary ? (last?.asked || last?.detail || "no canary run yet") : a.canary.asked,
        strip: (useCanary
          ? canary.map((c) => (c.detail.startsWith("skipped") ? "none" : c.ok ? "ok" : "fail"))
          : mine.map((t) => (t.error ? "warn" : t.livenessOk ? "ok" : "fail"))
        ) as Array<"ok" | "warn" | "fail" | "none">,
        /*
         * Say which measurement the strip is. The comment above promised the
         * soak log is "never silently mixed in", and it was: Jaeger showed a
         * solid red bar of soak failures from the V77 trace expiry, long since
         * fixed, directly beneath the words "waiting for the first canary run".
         * V79 fixed exactly this on the CARDS and not here, which is V80's
         * shape again: one surface repaired and its sibling left alone.
         */
        source: (useCanary ? "canary" : "soak") as "canary" | "soak",
        lastAt: useCanary ? (last?.at ?? "never") : a.canary.at,
        snapshot: loadRegistry()[a.id] ?? "",
        p50: percentile(resolves, 50),
        p95: percentile(resolves, 95),
      };
    });
    return send(200, renderHealthWall(rows, soakSummary(ticks),
      billing ? { isDurable: billing.isDurable, describe: billing.describe } : undefined,
      // Declared, not detected. A laptop deployment is a fact about the operator
      // and guessing it from the environment would be a guess on the one page
      // whose whole purpose is not guessing.
      { onLaptop: process.env.BLINK_ON_LAPTOP !== "0" }));
  }

  if (url.pathname === "/receipt-preview") {
    // A rendered example, so the receipt can be reviewed without spending.
    const r = buildReceipt({ plan: PLANS.starter, size: SIZE_SMALL, sandboxSeconds: 600, browserSeconds: 540, browserTiles: 12 });
    return send(200, `<!doctype html><meta charset="utf-8"><title>Receipt</title>` +
      // The receipt page hand rolls its CSS because it must render with nothing
      // else loaded. Tokens are read from tokens.ts rather than retyped, so it
      // cannot be the one page still wearing the old dark theme.
      `<style>body{background:${TOKENS.bg};color:${TOKENS.text};font-family:${FONT_TEXT};padding:calc(${CELL}px * 4)}` +
      `.panel{max-width:560px;border:1px solid ${TOKENS.border};border-radius:${RADIUS}px;padding:calc(${CELL}px * 2);background:${TOKENS.surface}}` +
      `.receipt{font-family:ui-monospace,monospace;font-size:13px;width:100%;border-collapse:collapse}` +
      `.receipt td{padding:4px 8px;border-bottom:1px solid ${TOKENS.border}}.receipt td:last-child{text-align:right}` +
      `.muted{color:${TOKENS.muted}}.fail{color:${TOKENS.fail}}</style>${renderReceipt(r)}`);
  }

  if (url.pathname.startsWith("/launch/") && req.method === "POST") {
    if (LAUNCHES_DISABLED) return send(503, `<p class="warn">${esc(LAUNCHES_OFF_REASON)}</p>`);
    const appId = decodeURIComponent(url.pathname.slice("/launch/".length));
    const app = APPS[appId];
    const snapshotId = loadRegistry()[appId];
    if (!app || !snapshotId) return send(404, `<p class="fail">No snapshot for that app yet.</p>`);
    if (!runner) {
      return send(200, `<p class="fail">Launching is off: this server has no Solari key. The catalog and health wall still work.</p>`);
    }

    // The ledger must be usable before anything spends. A wrong day boundary
    // mis-buckets every per-day ceiling, so refusing is the correct outcome.
    if (billing && !billing.usable) {
      return send(200, `<p class="fail">Launching is paused: ${esc(billing.refusedReason ?? "the budget ledger is not usable")}.</p>`);
    }

    // Turnstile before anything that spends. A refusal here costs nothing.
    if (!TURNSTILE_DISABLED) {
      const token = url.searchParams.get("cf-turnstile-response");
      const ip = (req.headers["cf-connecting-ip"] as string | undefined)
        ?? (req.socket.remoteAddress ?? undefined);
      const verdict = await verifyTurnstile(token, ip, { secret: TURNSTILE_SECRET });
      if (!verdict.ok) {
        /*
         * Say WHICH refusal, not just that there was one.
         *
         * The verifier already captures Cloudflare's error codes and this
         * dropped them one layer before anyone could read them, so every
         * failure looked identical: an expired token, a reused token, a wrong
         * secret and a forged token all rendered as "(rejected)". Those have
         * four different fixes and three of them are the operator's. Same rule
         * as the canary: a refusal that does not say what it asked is a
         * refusal people learn to ignore.
         */
        const why = verdict.detail !== undefined && verdict.detail !== ""
          ? `${verdict.reason}: ${verdict.detail}`
          : verdict.reason;
        return send(200, `<p class="fail">Could not verify you are a person (${esc(why)}). Reload and try again.</p>`);
      }
    }

    // No slot? Join the queue rather than being refused. The visitor sees a
    // position and an estimate, and nothing has been spent on their behalf.
    const free = (runner.plan.maxSandboxes ?? 2) - runner.liveCount();
    if (free < 1) {
      const session = sessionTokenFor(req, res);
      const pos = queue.enqueue(appId, session);
      return send(200, `<div class="panel" data-queued="${esc(pos.id)}">
        <div class="timer mono">${esc(pos.ahead + 1)}</div>
        <div class="muted" style="font-size:13px">in the queue for ${esc(app.name)}</div>
        <p class="muted" style="font-size:13px">About ${esc(pos.estimateSeconds)} seconds. Nothing has been charged, and you keep your place while this page is open.</p>
      </div>`);
    }
    void (async () => {
      try {
        await runner.launch({
          appId, snapshotId, size: app.size, port: app.port, healthPath: app.healthPath,
          postFork: app.postFork,
        });
      } catch {
        // Reported through /instance/:id, never thrown into the response the
        // visitor is already reading.
      }
    })();
    return send(200, renderLaunchPanel(appId, { path: "cold" }));
  }

  // The launching session polls this. The preview URL is rendered ONLY here.
  if (url.pathname === "/instances") {
    // Ids only, and only for instances this server started. No preview URLs.
    const list = (runner?.all() ?? [])
      .filter((i) => !["ENDED", "FAILED"].includes(i.state))
      .map((i) => ({ id: i.id, appId: i.appId, state: i.state }));
    return send(200, JSON.stringify(list), "application/json");
  }

  /*
   * The invite link. Redirects to the live instance, or explains that it ended.
   *
   * Solari answers a dead sandbox with a bare 404, which cannot be changed and
   * tells the holder nothing. Routing the shared link through Blink means the
   * one person with no context gets the same explanation the owner does.
   */
  if (url.pathname.startsWith("/go/")) {
    const id = decodeURIComponent(url.pathname.slice("/go/".length));
    const inst = runner?.get(id);
    if (!inst || !inst.previewUrl) {
      return send(410, renderInstanceEnded({
        appName: (inst ? APPS[inst.appId]?.name : undefined) ?? "instance",
        reason: inst?.state === "ENDED" && inst.endedReason === "destroyed" ? "destroyed" : "unknown",
        lastedMinutes: Math.round(DEFAULT_LIFETIME_MS / 60_000),
        shared: true,
      }));
    }
    const target = at(inst.previewUrl, inst.landingPath ?? APPS[inst.appId]?.landingPath);
    return { status: 302, headers: { location: target, "cache-control": "no-store" }, body: "" };
  }

  if (url.pathname.startsWith("/toolbar/")) {
    const id = decodeURIComponent(url.pathname.slice("/toolbar/".length));
    const inst = runner?.get(id);
    if (inst && inst.previewUrl && inst.lifetimeStartedAt === null) {
      // Alive, but the clock has not started. Rendering the toolbar here would
      // show every control beside a 00:00 timer, which reads as an instance
      // that has already been destroyed.
      return send(409, `<p class="muted">still handing it over</p>`);
    }
    if (!inst || !inst.previewUrl) {
      /*
       * Say what happened, rather than that something did.
       *
       * A visitor whose ten minutes ran out was getting "That instance is
       * gone", and the preview link they still had open was answering with
       * Solari's bare 404. Neither says whether they broke something.
       */
      const ended = inst
        ? (inst.state === "ENDED" && inst.endedReason === "destroyed" ? "destroyed" as const : "expired" as const)
        : "unknown" as const;
      return send(410, renderInstanceEnded({
        appName: (inst ? APPS[inst.appId]?.name : undefined) ?? "instance",
        reason: ended,
        lastedMinutes: Math.round(DEFAULT_LIFETIME_MS / 60_000),
      }));
    }
    return send(200, renderToolbar({
      id: inst.id,
      appName: APPS[inst.appId]?.name ?? inst.appId,
      previewUrl: inst.previewUrl,
      msRemaining: runner!.msRemaining(inst) ?? 0,
      extended: inst.extended,
      landingPath: inst.landingPath ?? APPS[inst.appId]?.landingPath ?? null,
      credentials: credentialsFor(inst.appId),
    }));
  }

  // Share: snapshot the caller's own live instance and mint a token.
  if (url.pathname.startsWith("/share/") && req.method === "POST") {
    const id = decodeURIComponent(url.pathname.slice("/share/".length));
    const inst = runner?.get(id);
    if (!inst || !inst.handle) {
      return send(404, JSON.stringify({ ok: false, reason: "that instance is gone" }), "application/json");
    }
    return void createShare({
      adapter: runner!.adapter, apiKey: runner!.apiKey, store: shares,
      sandbox: inst.handle, appId: inst.appId,
    })
      .then((r) => send(200, JSON.stringify({ ok: true, token: r.token, expiresAt: r.expiresAt }), "application/json"))
      .catch((e: Error) => send(200, JSON.stringify({
        ok: false,
        reason: e instanceof ShareRefused ? e.message : "could not snapshot",
      }), "application/json"));
  }

  // The share landing page. The token is in the path, so this page is noindex.
  if (url.pathname.startsWith("/s/")) {
    const token = decodeURIComponent(url.pathname.slice("/s/".length));
    return void resolveShare(shares, token).then((r) => {
      if (!r.ok) return send(200, shell(renderSharePage({ error: r.reason }), true));
      return send(200, shell(renderSharePage({
        appName: APPS[r.appId]?.name ?? r.appId, forkCount: r.forkCount, token,
      }), true));
    });
  }

  if (url.pathname.startsWith("/launch-share/") && req.method === "POST") {
    if (LAUNCHES_DISABLED) return send(503, `<p class="warn">${esc(LAUNCHES_OFF_REASON)}</p>`);
    const token = decodeURIComponent(url.pathname.slice("/launch-share/".length));
    if (!runner) return send(200, `<p class="fail">Launching is off: this server has no Solari key.</p>`);
    return void resolveShare(shares, token).then(async (r) => {
      if (!r.ok) return send(200, renderSharePage({ error: r.reason }));
      const app = APPS[r.appId];
      if (!app) return send(404, `<p class="fail">Unknown app.</p>`);
      await shares.countFork(token);
      void runner!.launch({
        appId: r.appId, snapshotId: r.snapshotId, size: app.size,
        port: app.port, healthPath: app.healthPath, fromShareToken: token,
      }).catch(() => { /* surfaced through /instance/:id */ });
      return send(200, renderLaunchPanel(r.appId, { path: "cold" }));
    });
  }

  if (url.pathname.startsWith("/report/")) {
    const token = decodeURIComponent(url.pathname.slice("/report/".length));
    return void shares.report(token).then((found) => send(200, shell(
      `<div class="panel"><h2 style="margin-top:0">${found ? "Reported" : "Nothing to report"}</h2>
       <p class="muted">${found
         ? "That link stops working immediately, and its stored state is deleted at the next sweep. Thank you."
         : "That link does not exist."}</p>
       <p><a href="/">Back to the catalog</a></p></div>`, true)));
  }

  if (url.pathname.startsWith("/extend/") && req.method === "POST") {
    const id = decodeURIComponent(url.pathname.slice("/extend/".length));
    if (!runner) return send(404, JSON.stringify({ ok: false, reason: "no runner" }), "application/json");
    return void runner.extend(id).then((r) => send(200, JSON.stringify(r), "application/json"));
  }

  if (url.pathname.startsWith("/instance/")) {
    const id = decodeURIComponent(url.pathname.slice("/instance/".length));
    const inst = runner?.get(id);
    if (!inst) return send(404, JSON.stringify({ error: "unknown instance" }), "application/json");
    /*
     * The URL is reported only once the clock has started.
     *
     * previewUrl is now resolved during CHECKING, because the guest boot script
     * needs it to set the app's ROOT_URL (V107). The polling client treated
     * "previewUrl is present" as "handed over" and swapped in the toolbar the
     * moment it appeared, which was before HANDOVER and therefore before
     * expiresAt existed. msRemaining was null, the toolbar rendered 00:00, and
     * an instance that was alive and mid check looked already destroyed.
     *
     * Reporting it only at HANDOVER makes the field mean what the client
     * assumed it meant, and has the second virtue of not handing out the
     * capability before the guest self destruct has been armed.
     */
    const handedOver = inst.lifetimeStartedAt !== null;
    return send(200, JSON.stringify({
      state: inst.state,
      previewUrl: handedOver ? inst.previewUrl : null,
      msRemaining: runner!.msRemaining(inst),
      extended: inst.extended,
      endedReason: inst.endedReason,
      receipt: inst.receipt,
    }), "application/json");
  }

  if (url.pathname.startsWith("/destroy/") && req.method === "POST") {
    const id = decodeURIComponent(url.pathname.slice("/destroy/".length));
    const inst = runner?.get(id);
    if (!inst) return send(404, "unknown instance", "text/plain");
    // Await the settle so the visitor sees the real receipt, not a placeholder
    // that a later poll would have to correct.
    return void runner!.end(inst, "destroyed").then((r) => send(200, renderReceipt(r)));
  }

  send(404, "not found", "text/plain");
});

/**
 * Run every app's canary on a loop.
 *
 * Staggered, one app at a time, so the canary never holds more than one slot.
 * It yields that slot to visitors anyway, but taking them one at a time also
 * keeps the reconciler's picture simple.
 */
function startCanary(): void {
  if (!runner || process.env.BLINK_CANARY_DISABLED === "1") return;
  const ids = Object.keys(APPS).filter((id) => loadRegistry()[id]);
  let i = 0;
  const tick = async () => {
    const id = ids[i % ids.length];
    i += 1;
    if (!id) return;
    const app = APPS[id]!;
    const snapshotId = loadRegistry()[id];
    if (!snapshotId) return;
    await runCanaryOnce({
      apiKey: runner!.apiKey, adapter: runner!.adapter, lock: runner!.lock,
      liveSlots: async () => runner!.liveCount(),
      maxSlots: runner!.plan.maxSandboxes ?? 2,
      waitHealthy: async (sh, port, path) => {
        const r = await waitHealthyInGuest(
          (cmd, o) => sh(cmd, o).then((x) => ({ value: { exitCode: 0, ...x.value } })),
          port, path, { timeoutMs: 120_000, intervalMs: 400 },
        );
        return { ok: r.ok, ms: r.ms };
      },
      shotPathFor,
      record: (r) => {
        canaryLog.push(r);
        // Bounded: the wall shows 24 cells per app and the log is not an archive.
        if (canaryLog.length > 500) canaryLog.splice(0, canaryLog.length - 500);
      },
    }, {
      appId: id, snapshotId, size: app.size, port: app.port, healthPath: app.healthPath,
      shotPath: app.shotPath, shotScript: app.shotScript, shotExpect: app.shotExpect,
      postFork: app.postFork,
    });
  };
  void tick();
  const t = setInterval(() => { void tick(); }, Math.max(60_000, CANARY_INTERVAL_MS / Math.max(1, ids.length)));
  if (typeof t.unref === "function") t.unref();
}

function startShareSweeper(): void {
  if (!runner) return;
  const run = async () => {
    const r = await sweepExpiredShares(shares, async (snapshotId) => {
      await runner!.deleteSnapshot(snapshotId);
    });
    if (r.deleted.length > 0 || r.failed.length > 0) {
      safeOut(`[share sweep] deleted ${r.deleted.length}, failed ${r.failed.length}\n`);
    }
  };
  void run();
  const t = setInterval(() => { void run(); }, SHARE_SWEEP_MS);
  if (typeof t.unref === "function") t.unref();
}

server.listen(PORT, () => {
  safeOut(`Blink web on http://localhost:${PORT}\n`);
  startShareSweeper();

  /**
   * Adopt anything a previous process left running, BEFORE serving traffic
   * matters to anyone.
   *
   * A restart used to abandon every live instance: the timers lived in memory,
   * so nothing settled them and nothing killed them. Layer 3 would have stopped
   * them three minutes later, which is the backstop doing its job and not a
   * reason to leave the hole.
   */
  // The ledger first: a launch must never be admitted against a ceiling we have
  // not loaded yet.
  void setUpLedger().then((b) => { billing = b; });

  startCanary();
  startWarmPool();

  if (runner) {
    void runner.adoptOrphans(async (sandboxId) => {
      await runner!.adapter.killQuiet(runner!.apiKey, sandboxId, "boot:adopt");
    }).then((r) => {
      if (r.killed.length > 0 || r.adopted.length > 0) {
        safeOut(`[boot] adopted ${r.adopted.length} and killed ${r.killed.length} orphaned instance(s)\n`);
      }
    });
  }
});
