/**
 * The gate runner.
 *
 * Every gate is a separately runnable script that calls runGate(). The runner
 * owns the rules that apply to all seven, so no individual gate can forget one:
 *
 *   - The budget guard wraps every Solari call, and a gate whose ESTIMATE
 *     exceeds its ceiling refuses before the first call rather than after.
 *   - Every gate prints its cost in sandbox-seconds, browser-seconds and USD at
 *     Starter rates, before it starts and again after it finishes.
 *   - Every gate kills what it created. The ledger sweeper additionally kills
 *     orphans on exit and on SIGINT, because a leaked sandbox is a credit leak.
 *   - A 429 is a guard bug: the slot state is logged in full and the gate aborts.
 *     There is no retry loop anywhere in this codebase.
 *   - Zero retries during gates (CAPS_GATES), so G1 measures real latency.
 *
 * The API key is read from the environment HERE, at the process edge, and passed
 * down as an argument. Nothing under src/solari/ reads it.
 */

import { safeErr, safeOut } from "../../../src/safe-io.ts";
import { BudgetGuard, GuardBug } from "../../../src/guard/guard.ts";
import { SandboxLedger } from "../../../src/guard/ledger.ts";
import { PLANS, type Plan, type PlanName, GATES_TOTAL_BUDGET_USD } from "../../../src/guard/rates.ts";
import { CAPS_GATES, createCountingFetch } from "../../../src/solari/fetch.ts";
import { SolariAdapter } from "../../../src/solari/adapter.ts";
import { writeData, writeReport } from "./report.ts";
import { fmtCost, type CostEstimate } from "./cost.ts";
import { preflightVerdict } from "./preflight.ts";

export type GateContext = {
  apiKey: string;
  plan: Plan;
  adapter: SolariAdapter;
  guard: BudgetGuard;
  ledger: SandboxLedger;
  /** Tag every sandbox with this so the reconciler and sweeper can find orphans. */
  metadata: Record<string, string>;
  runId: string;
};

export type GateResult = {
  /** Short verdict line printed and put at the top of the report. */
  verdict: string;
  /** Markdown body, without the title and cost footer, which the runner adds. */
  markdown: string;
  /** Raw samples written to docs/gates/data/<id>.json. */
  data: unknown;
  /**
   * How many REAL observations this run produced, in the gate's own unit.
   *
   * Not "did it finish" and not "did it error". A gate can complete cleanly,
   * exit zero, and have observed nothing at all. G5 did exactly that: twelve
   * tiles connected, zero frames arrived, and the verdict read "within the
   * section 7 prediction" because the threshold was `kbPerS <= 720 * 1.5` and
   * zero satisfies it. See enforceMinimum below.
   */
  observations: number;
};

/**
 * Structural INCONCLUSIVE.
 *
 * Two false passes in one pass is a pattern, not two bugs, so this is enforced
 * by the runner rather than left to each gate to remember. Any verdict resting
 * on a zero, an empty result set, or a count below the gate's declared minimum
 * is replaced with INCONCLUSIVE, whatever the gate itself concluded.
 *
 * A gate author cannot opt out: `minObservations` is required on the definition
 * and `observations` is required on the result.
 */
export function enforceMinimum(
  result: Pick<GateResult, "verdict" | "observations">,
  def: Pick<GateDefinition, "minObservations" | "observationUnit" | "id">,
): { verdict: string; inconclusive: boolean; reason: string | null } {
  if (result.observations >= def.minObservations) {
    return { verdict: result.verdict, inconclusive: false, reason: null };
  }
  const reason =
    `${def.id.toUpperCase()} produced ${result.observations} ${def.observationUnit}` +
    `${result.observations === 1 ? "" : "s"}, below its declared minimum of ${def.minObservations}. ` +
    `A conclusion drawn from ${result.observations === 0 ? "nothing" : "too little"} is not a conclusion.`;
  return {
    verdict: `INCONCLUSIVE. ${reason} The gate's own verdict, withheld because it rests on too few observations, was: "${result.verdict}"`,
    inconclusive: true,
    reason,
  };
}

export type GateDefinition = {
  id: string;
  title: string;
  /** What this gate answers, in one line, from docs/01-prd.md section 11. */
  question: string;
  /** Pre-flight estimate. Refused before any call if it exceeds the ceiling. */
  estimate: (plan: Plan) => CostEstimate;
  /** Per-gate ceiling. The whole run is capped separately at $0.40. */
  ceilingUsd: number;
  /**
   * Fewer observations than this and the run is INCONCLUSIVE by construction,
   * regardless of what the gate concluded. Required, deliberately: a gate that
   * has not stated what "enough" means cannot report a pass.
   */
  minObservations: number;
  /** What one observation is, singular, for the report. */
  observationUnit: string;
  /**
   * Optional prerequisite check. Return a reason string to SKIP the gate
   * cleanly rather than fail it. Used where a gate needs snapshots that the
   * day-2 build has not produced yet.
   */
  preflight?: () => string | null;
  run: (ctx: GateContext) => Promise<GateResult>;
};

export function resolvePlan(): Plan {
  const name = (process.env.BLINK_PLAN ?? "starter") as PlanName;
  const plan = PLANS[name];
  if (!plan) throw new Error(`unknown BLINK_PLAN "${name}", expected starter or free`);
  return plan;
}

/** Read the key once, here, at the edge. */
export function resolveApiKey(): string {
  const k = process.env.SOLARI_API_KEY;
  if (!k || k.includes("replace_me")) {
    throw new Error(
      "SOLARI_API_KEY is not set. Copy .env.example to .env and fill it in, or export it. " +
        "Gates make live Solari calls and spend credits.",
    );
  }
  return k;
}

export type RunOptions = {
  /** Print the estimate and exit without calling Solari. Default false. */
  dryRun?: boolean;
  /** Ceiling for this invocation. Defaults to the gate's own ceiling. */
  ceilingUsd?: number;
};

export async function runGate(def: GateDefinition, opts: RunOptions = {}): Promise<number> {
  const plan = resolvePlan();
  const est = def.estimate(plan);
  const ceiling = opts.ceilingUsd ?? def.ceilingUsd;

  safeOut(`\n=== ${def.id.toUpperCase()}: ${def.title} ===\n`);
  safeOut(`Question: ${def.question}\n`);
  safeOut(`${fmtCost("Estimated before start", est, plan)}\n`);
  safeOut(`Ceiling for this gate: $${ceiling.toFixed(5)}\n`);

  // Refuse before the call, never after.
  // The refusal is a pure function so a test can fire it without spending.
  const preflight = preflightVerdict(est.usd, ceiling, GATES_TOTAL_BUDGET_USD);
  if (!preflight.allow) {
    safeErr(`\n${preflight.message}\n`);
    return 2;
  }

  const skip = def.preflight?.();
  if (skip) {
    safeOut(`\nSKIPPED: ${skip}\nNo Solari call was made.\n`);
    writeReport(def.id, `# ${def.id.toUpperCase()}: ${def.title}\n\nSKIPPED. ${skip}\n`);
    return 0;
  }

  if (opts.dryRun) {
    safeOut("\nDRY RUN: estimate only, no Solari call made.\n");
    return 0;
  }

  const apiKey = resolveApiKey();
  const runId = `${def.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const guard = new BudgetGuard(plan, ceiling);
  const ledger = new SandboxLedger();
  ledger.install(apiKey);

  const counting = createCountingFetch({
    caps: CAPS_GATES, // zero retries, so G1 measures real latency
    beforeAttempt: ({ method, path, attempt }) => {
      if (process.env.BLINK_TRACE) {
        safeErr(`[http] ${method} ${path} attempt ${attempt}\n`);
      }
    },
  });

  const adapter = new SolariAdapter({ counting, guard, ledger });
  const metadata = { blink_gate: def.id, blink_run: runId };
  const ctx: GateContext = { apiKey, plan, adapter, guard, ledger, metadata, runId };

  const started = Date.now();
  let exitCode = 0;
  let result: GateResult | null = null;
  let failure: Error | null = null;

  try {
    result = await def.run(ctx);
  } catch (err) {
    failure = err as Error;
    exitCode = 1;
    if (err instanceof GuardBug) {
      safeErr(`\nGUARD BUG (429). Aborting ${def.id}.\n`);
      safeErr(`${err.message}\n`);
      safeErr(`Slot state at the moment of the 429:\n`);
      safeErr(`${JSON.stringify(err.slotState, null, 2)}\n`);
    } else {
      safeErr(`\nFAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
  }

  // Every gate kills what it created. The sweeper is the backstop, not the plan.
  const stillOpen = ledger.openIds();
  if (stillOpen.length > 0) {
    safeErr(`\n[teardown] ${stillOpen.length} sandbox(es) left open, sweeping now\n`);
    const swept = await ledger.sweep(apiKey, `${def.id}-teardown`);
    for (const s of swept) safeErr(`[teardown]   ${JSON.stringify(s)}\n`);
  }

  const sum = guard.summary();
  const actual: CostEstimate = {
    sandboxSeconds: sum.sandboxSeconds,
    browserSeconds: sum.browserSeconds,
    usd: sum.usd,
  };
  safeOut(`\n${fmtCost("Actual after finish", actual, plan)}\n`);
  safeOut(
    `Cost basis: $${sum.measuredUsd.toFixed(5)} measured, $${sum.modelledUsd.toFixed(5)} modelled ` +
      `(${(sum.measuredFraction * 100).toFixed(0)}% measured)\n`,
  );
  safeOut(`Elapsed: ${((Date.now() - started) / 1000).toFixed(1)} s\n`);

  // Structural INCONCLUSIVE, applied before anything is printed or written.
  const judged = result
    ? enforceMinimum(result, def)
    : { verdict: failure ? `FAILED: ${failure.message}` : "no verdict", inconclusive: false, reason: null };
  const verdict = judged.verdict;
  if (judged.inconclusive) {
    exitCode = exitCode === 0 ? 3 : exitCode;
    safeErr(`\nINCONCLUSIVE: ${judged.reason}\n`);
  }
  safeOut(`Verdict: ${verdict}\n`);

  const md = [
    `# ${def.id.toUpperCase()}: ${def.title}`,
    ``,
    `**Question.** ${def.question}`,
    ``,
    `**Verdict.** ${verdict}`,
    ``,
    result
      ? `**Observations.** ${result.observations} ${def.observationUnit}${result.observations === 1 ? "" : "s"}, against a declared minimum of ${def.minObservations}.${judged.inconclusive ? " **Below minimum, so this run concludes nothing.**" : ""}`
      : "",
    ``,
    `Run \`${runId}\` on plan \`${plan.name}\`, ${new Date().toISOString()}.`,
    ``,
    result?.markdown ?? (failure ? `## Failure\n\n\`\`\`\n${failure.stack ?? failure.message}\n\`\`\`` : ""),
    ``,
    `## Cost`,
    ``,
    `| | sandbox-seconds | browser-seconds | USD at ${plan.name} |`,
    `|---|---|---|---|`,
    `| Estimated before start | ${est.sandboxSeconds} | ${est.browserSeconds} | $${est.usd.toFixed(5)} |`,
    `| Actual after finish | ${actual.sandboxSeconds} | ${actual.browserSeconds} | $${actual.usd.toFixed(5)} |`,
    ``,
    `### Measured versus modelled`,
    ``,
    `| | USD | share |`,
    `|---|---|---|`,
    `| measured from observed lifetimes | $${sum.measuredUsd.toFixed(5)} | ${(sum.measuredFraction * 100).toFixed(0)}% |`,
    `| modelled from flat estimates | $${sum.modelledUsd.toFixed(5)} | ${((1 - sum.measuredFraction) * 100).toFixed(0)}% |`,
    ``,
    sum.modelledUsd > 0
      ? `**${((1 - sum.measuredFraction) * 100).toFixed(0)}% of this gate's cost is modelled, not measured.** Solari exposes no balance or usage endpoint to reconcile against (remaining credit is visible only on the console Billing page), so a modelled row can drift from the real balance with nothing to catch it. D10 puts this number on a public page, so the gauge is labelled an estimate until a gate measures its own lifetimes.`
      : `Every row in this gate came from an observed lifetime. Nothing here is modelled.`,
    ``,
    `| row | kind | seconds | USD | measured |`,
    `|---|---|---|---|---|`,
    ...sum.rows.map((r, i) => `| ${i + 1} | ${r.kind} | ${Math.round(r.seconds * 10) / 10} | $${r.usd.toFixed(5)} | ${r.measured ? "yes" : "no (modelled)"}${r.note ? `, ${r.note}` : ""} |`),
    ``,
    `Ceiling for this gate was $${ceiling.toFixed(5)}. Total gates budget is $${GATES_TOTAL_BUDGET_USD.toFixed(2)}.`,
    ``,
    `Attempts recorded: ${counting.log.length}. Any attempt beyond the first for one logical call is a retry, and the gate caps retries at zero (\`CAPS_GATES\`).`,
  ].join("\n");

  writeReport(def.id, md);
  writeData(def.id, {
    runId,
    plan: plan.name,
    verdict,
    inconclusive: judged.inconclusive,
    observations: result?.observations ?? 0,
    minObservations: def.minObservations,
    estimate: est,
    actual,
    costBasis: {
      measuredUsd: sum.measuredUsd,
      modelledUsd: sum.modelledUsd,
      measuredFraction: sum.measuredFraction,
      rows: sum.rows,
    },
    attempts: counting.log,
    data: result?.data ?? null,
    failure: failure ? { name: failure.name, message: failure.message } : null,
  });

  // The independent check: ask Solari, not the local file.
  try {
    const live = await ledger.assertZeroLive(apiKey, { reap: true });
    safeOut(`Live sandboxes after teardown: ${live.liveCount}\n`);
  } catch (err) {
    safeErr(`\nLEAK: ${(err as Error).message}\n`);
    exitCode = 1;
  }

  return exitCode;
}

/** Standard entrypoint for a single-gate script. */
export async function main(def: GateDefinition): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const code = await runGate(def, { dryRun });
  process.exit(code);
}
