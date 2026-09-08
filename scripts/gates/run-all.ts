/**
 * `npm run gates`: pre-flight the whole run, then run G1 through G7 in order.
 *
 * The pre-flight is the important part. It sums every gate's estimate and
 * REFUSES TO START if the total exceeds $0.40, before any Solari call is made,
 * so a refusal costs nothing. Gates are run as separate child processes because
 * each is independently runnable by design, and because a gate that wedges
 * should not take the rest of the run with it.
 *
 * Order matters. G7 is last because it deliberately provokes a 429, which is
 * the one condition every other gate treats as an abort.
 */

import { safeErr, safeOut } from "../../src/safe-io.ts";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GATES_TOTAL_BUDGET_USD, PLANS, type PlanName } from "../../src/guard/rates.ts";
import { estimate, fmtCost } from "./lib/cost.ts";
import { SIZE_SMALL } from "../../src/guard/rates.ts";
import { G1_APPS, G2_APPS, missingSnapshots } from "./lib/apps.ts";
import { SandboxLedger } from "../../src/guard/ledger.ts";
import { resolveApiKey } from "./lib/harness.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Estimates duplicated from each gate deliberately. The pre-flight must be able
 * to refuse WITHOUT importing and executing the gate modules, since importing
 * one runs it (each ends with `await main(def)`).
 *
 * KEEP THESE IN SYNC with each gate's own `estimate()`. They drifted once
 * already, when G6 grew a snapshot size-delta step. A stale figure here weakens
 * the refusal, which is the one thing that must not be approximate: the gate's
 * own ceiling still catches it, but the whole-run refusal would let it through.
 */
/**
 * Order is deliberate and the run is SERIAL, never parallel.
 *
 * G7 exists to overrun the concurrency limit on purpose. Every other gate treats
 * a 429 as a guard bug that aborts it. So anything running beside G7 would log a
 * false GuardBug and report a failure that is really G7 doing its job. G7 runs
 * last and alone.
 *
 * The declared order for a partial pass is G4, G6, G5, G7: cheap and read-mostly
 * first, the browser-heavy one next, the deliberately destructive one last.
 */
const GATES = [
  { id: "g4", file: "g4-snapshot-limits.ts", sandboxSeconds: 330, browserSeconds: 0 },
  { id: "g6", file: "g6-egress.ts", sandboxSeconds: 260, browserSeconds: 0 },
  { id: "g5", file: "g5-relay.ts", sandboxSeconds: 240, browserSeconds: Number(process.env.BLINK_G5_TILES ?? 12) * 65 },
  { id: "g7", file: "g7-concurrency.ts", sandboxSeconds: 180, browserSeconds: 0 },
  { id: "g1", file: "g1-fork-to-healthy.ts", sandboxSeconds: G1_APPS.length * Number(process.env.BLINK_G1_FORKS ?? 20) * 30 * 3, browserSeconds: 0 },
  { id: "g2", file: "g2-preview-framing.ts", sandboxSeconds: G2_APPS.length * 90, browserSeconds: 0 },
  { id: "g3", file: "g3-pause-resume.ts", sandboxSeconds: 445, browserSeconds: 0 },
] as const;

/** Order gates run in, regardless of the order they were requested. */
const RUN_ORDER = ["g4", "g6", "g5", "g7", "g1", "g2", "g3"] as const;

/**
 * Hard stop on cumulative spend across the run, separate from the pre-flight
 * estimate. Override for a deliberately small pass, e.g. --max-spend=0.06.
 */
const maxSpendArg = process.argv.find((a) => a.startsWith("--max-spend="))?.split("=")[1];
const MAX_SPEND_USD = maxSpendArg ? Number(maxSpendArg) : GATES_TOTAL_BUDGET_USD;

// `npm run gates -- --q12` is a different job entirely: it answers Q12 after the
// downgrade rather than running gates. Dispatch before any pre-flight.
if (process.argv.includes("--q12")) {
  const { runQ12 } = await import("./q12-downgrade.ts");
  process.exit(await runQ12());
}

const plan = PLANS[(process.env.BLINK_PLAN ?? "starter") as PlanName]!;
const dryRun = process.argv.includes("--dry-run");
const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",");

const selected = (only ? GATES.filter((g) => only.includes(g.id)) : [...GATES]).sort(
  (a, b) => RUN_ORDER.indexOf(a.id) - RUN_ORDER.indexOf(b.id),
);

safeOut(`\n${"=".repeat(72)}\nBlink gates pre-flight\n${"=".repeat(72)}\n\n`);
safeOut(`Plan: ${plan.name}. Sandbox cap ${plan.maxSandboxes}, browser cap ${plan.maxBrowsers}.\n\n`);

let totalUsd = 0;
let totalSandbox = 0;
let totalBrowser = 0;
for (const g of selected) {
  const e = estimate(plan, [
    { sandboxSeconds: g.sandboxSeconds, size: SIZE_SMALL },
    { browserSeconds: g.browserSeconds },
  ]);
  totalUsd += e.usd;
  totalSandbox += e.sandboxSeconds;
  totalBrowser += e.browserSeconds;
  safeOut(`  ${g.id}  ${String(e.sandboxSeconds).padStart(5)} sandbox-s  ${String(e.browserSeconds).padStart(4)} browser-s  $${e.usd.toFixed(5)}\n`);
}
totalUsd = Math.round(totalUsd * 1e5) / 1e5;

safeOut(`\n  ${"-".repeat(60)}\n`);
safeOut(`  TOTAL ${String(totalSandbox).padStart(5)} sandbox-s  ${String(totalBrowser).padStart(4)} browser-s  $${totalUsd.toFixed(5)}\n`);
safeOut(`  Budget for a full run: $${GATES_TOTAL_BUDGET_USD.toFixed(2)}\n\n`);

if (totalUsd > GATES_TOTAL_BUDGET_USD) {
  safeErr(
    `REFUSED: estimated $${totalUsd.toFixed(5)} exceeds the total gates budget of ` +
      `$${GATES_TOTAL_BUDGET_USD.toFixed(2)}. No Solari call was made, so this refusal cost nothing.\n` +
      `Lower BLINK_G1_FORKS or BLINK_G5_TILES, or run a subset with --only=g2,g3.\n`,
  );
  process.exit(2);
}

const blocked = missingSnapshots(G1_APPS);
if (blocked) {
  safeOut(`Note: some gates will SKIP because ${blocked}\n\n`);
}

if (dryRun) {
  safeOut("DRY RUN: pre-flight only, no gate was run and no Solari call was made.\n");
  process.exit(0);
}

safeOut(
  `Running ${selected.length} gate(s) SERIALLY, in order: ${selected.map((g) => g.id).join(", ")}.\n` +
    `G7 runs last and alone because it deliberately provokes a 429, which every other gate treats as an abort.\n` +
    `Cumulative spend stop: $${MAX_SPEND_USD.toFixed(5)}.\n`,
);

const apiKey = resolveApiKey();
const ledger = new SandboxLedger();

/**
 * Between gates: assert nothing is still live. A gate that leaks into the next
 * one corrupts its measurement and bills for it, so the run ABORTS here rather
 * than continuing.
 */
async function assertClean(after: string): Promise<boolean> {
  safeOut(`\n[between] asserting zero live after ${after}\n`);
  let clean = true;

  try {
    const live = await ledger.assertZeroLive(apiKey, { reap: true });
    safeOut(`[between]   sandboxes live: ${live.liveCount}\n`);
  } catch (err) {
    safeErr(`[between]   SANDBOX LEAK: ${(err as Error).message}\n`);
    clean = false;
  }

  // Browser sessions have NO listing endpoint (docs.getsolari.com/api-reference/browser),
  // so this can only check the ids the ledger knows about. A session whose id we
  // never learned is invisible; the intent records are the only trace it leaves.
  try {
    const liveB = await ledger.liveBrowserSessions(apiKey);
    if (liveB.length > 0) {
      safeErr(`[between]   BROWSER SESSION LEAK: ${JSON.stringify(liveB)}\n`);
      await ledger.sweepBrowsers(apiKey, `between-${after}`);
      clean = false;
    } else {
      const known = ledger.openBrowserIds().length;
      safeOut(`[between]   browser sessions live: 0 (of ${known} tracked; no listing endpoint exists, so this covers tracked ids only)\n`);
    }
  } catch (err) {
    safeErr(`[between]   browser check failed: ${(err as Error).message}\n`);
    clean = false;
  }

  return clean;
}

/** Read a gate's actual spend back out of the JSON it just wrote. */
function spendOf(id: string): number {
  try {
    const raw = readFileSync(join(here, "..", "..", "docs", "gates", "data", `${id}.json`), "utf8");
    return (JSON.parse(raw) as { actual?: { usd?: number } }).actual?.usd ?? 0;
  } catch {
    return 0;
  }
}

const results: Array<{ id: string; code: number; usd: number }> = [];
let runningUsd = 0;

for (const g of selected) {
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [join(here, g.file)], { stdio: "inherit" });
    child.on("exit", (c) => resolve(c ?? 1));
  });
  const usd = spendOf(g.id);
  runningUsd = Math.round((runningUsd + usd) * 1e5) / 1e5;
  results.push({ id: g.id, code, usd });

  safeOut(`\n[cost] ${g.id} spent $${usd.toFixed(5)}. Running total $${runningUsd.toFixed(5)} of $${MAX_SPEND_USD.toFixed(5)}.\n`);

  if (code === 2) {
    safeErr(`\n${g.id} refused on budget. Stopping the run.\n`);
    break;
  }

  const clean = await assertClean(g.id);
  if (!clean) {
    safeErr(
      `\nABORTING THE RUN: something was still live after ${g.id}.\n` +
        `A leak into the next gate corrupts its measurement and bills for it, so the run stops here\n` +
        `rather than continuing. Run \`npm run sweep\` and investigate before re-running.\n`,
    );
    break;
  }

  if (runningUsd > MAX_SPEND_USD) {
    safeErr(
      `\nSTOPPING: running total $${runningUsd.toFixed(5)} passed the cap of $${MAX_SPEND_USD.toFixed(5)}.\n` +
        `Remaining gates were not run.\n`,
    );
    break;
  }
}

safeOut(`\n${"=".repeat(72)}\nGates summary\n${"=".repeat(72)}\n\n`);
for (const r of results) {
  const label = r.code === 0 ? "ok" : r.code === 2 ? "REFUSED (budget)" : "FAILED";
  safeOut(`  ${r.id.padEnd(4)} ${label.padEnd(18)} $${r.usd.toFixed(5)}\n`);
}
safeOut(`\n  TOTAL SPENT $${runningUsd.toFixed(5)} of a $${MAX_SPEND_USD.toFixed(5)} cap\n`);
safeOut(`\nReports: docs/gates/*.md\nRaw data: docs/gates/data/*.json\n`);

const failed = results.filter((r) => r.code !== 0).length;
process.exit(failed > 0 ? 1 : 0);
