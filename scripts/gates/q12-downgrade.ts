/**
 * `npm run gates -- --q12`
 *
 * Answers Q12 (what happens to running sandboxes and stored snapshots at the
 * moment of downgrade from Starter to Free) by comparing the live account
 * against the baseline G4 captured while still on Starter.
 *
 * It REFUSES to run early. Running it before the downgrade would record a
 * non-answer that looks like an answer, and a non-answer in the file is worse
 * than an empty file, because the next reader believes it.
 */

import { BudgetGuard } from "../../src/guard/guard.ts";
import { SandboxLedger } from "../../src/guard/ledger.ts";
import { PLANS, STARTER_ENDS, starterHasEnded, type PlanName } from "../../src/guard/rates.ts";
import { CAPS_GATES, createCountingFetch } from "../../src/solari/fetch.ts";
import { SolariAdapter } from "../../src/solari/adapter.ts";
import { readBaseline, type SnapshotRecord } from "./lib/inventory.ts";
import { table, writeData, writeReport } from "./lib/report.ts";
import { resolveApiKey, resolvePlan } from "./lib/harness.ts";
import { safeOut, safeErr } from "../../src/safe-io.ts";

export async function runQ12(): Promise<number> {
  // ---- refusals, before any call ----
  if (!STARTER_ENDS) {
    safeErr(
      "REFUSED: BLINK_STARTER_ENDS is not set.\n" +
        "Set it in src/guard/rates.ts (STARTER_ENDS_LITERAL) or export BLINK_STARTER_ENDS=YYYY-MM-DD.\n" +
        "Without it this command cannot tell whether the downgrade has happened, and recording\n" +
        "a non-answer would be worse than recording nothing.\n",
    );
    return 2;
  }
  if (!starterHasEnded()) {
    safeErr(
      `REFUSED: the Starter month ends ${STARTER_ENDS} and today is ${new Date().toISOString().slice(0, 10)}.\n` +
        "Running before the downgrade would record a non-answer that looks like an answer.\n" +
        "Run this the day after.\n",
    );
    return 2;
  }

  const baseline = readBaseline();
  if (!baseline) {
    safeErr(
      "REFUSED: no pre-downgrade baseline at docs/gates/data/g4-baseline.json.\n" +
        "That baseline is unrecoverable now: there is no way to ask Solari what you used to have.\n" +
        "Q12 cannot be answered for this account.\n",
    );
    return 2;
  }

  const apiKey = resolveApiKey();
  const plan = resolvePlan();
  const guard = new BudgetGuard(plan, 0.01);
  const ledger = new SandboxLedger();
  const counting = createCountingFetch({ caps: CAPS_GATES });
  const adapter = new SolariAdapter({ counting, guard, ledger });

  safeOut(`\nQ12 re-inventory. Baseline captured ${baseline.capturedAt} on plan ${baseline.plan}.\n`);
  safeOut(`Now on plan ${plan.name}. Reading live inventory (one API call, read-only).\n`);

  const snaps = await adapter.listSnapshots(apiKey, "q12");
  const now: SnapshotRecord[] = snaps.value.map((s) => ({
    id: s.id, name: s.name, sizeBytes: s.sizeBytes, createdAt: s.createdAt, template: s.template,
  }));

  const beforeById = new Map(baseline.snapshots.map((s) => [s.id, s]));
  const nowById = new Map(now.map((s) => [s.id, s]));

  const survived = baseline.snapshots.filter((s) => nowById.has(s.id));
  const lost = baseline.snapshots.filter((s) => !nowById.has(s.id));
  const added = now.filter((s) => !beforeById.has(s.id));
  const resized = survived
    .map((s) => ({ s, after: nowById.get(s.id)! }))
    .filter((x) => x.after.sizeBytes !== x.s.sizeBytes);

  const liveSandboxes = await adapter.listSandboxes(apiKey, "q12", {});

  const verdict =
    `Snapshots: ${survived.length}/${baseline.snapshotCount} survived the downgrade, ${lost.length} lost, ${added.length} new. ` +
    `${resized.length === 0 ? "No size changes." : `${resized.length} changed size.`} ` +
    `Concurrency cap moved ${baseline.maxSandboxes} -> ${plan.maxSandboxes} sandboxes, ${baseline.maxBrowsers} -> ${plan.maxBrowsers} browsers.`;

  const md = [
    `# Q12: what the Starter to Free downgrade did`,
    ``,
    `**Verdict.** ${verdict}`,
    ``,
    `Baseline captured **${baseline.capturedAt}** on plan \`${baseline.plan}\`. Re-inventory run **${new Date().toISOString()}** on plan \`${plan.name}\`. Starter ended ${STARTER_ENDS}.`,
    ``,
    `## 1. Did the stored snapshots survive?`,
    ``,
    table(
      ["", "count", "bytes"],
      [
        ["before downgrade", baseline.snapshotCount, baseline.totalBytes],
        ["survived", survived.length, survived.reduce((a, s) => a + (nowById.get(s.id)?.sizeBytes ?? 0), 0)],
        ["lost", lost.length, lost.reduce((a, s) => a + s.sizeBytes, 0)],
        ["new since baseline", added.length, added.reduce((a, s) => a + s.sizeBytes, 0)],
      ],
    ),
    ``,
    lost.length === 0
      ? `**All snapshots survived.** D1 and D9 both hold across a downgrade, and the canary can still rebuild.`
      : `**${lost.length} snapshot(s) did not survive.** This breaks D1 and D9 on the first day of Free, and the canary cannot rebuild from a snapshot that is gone. Lost ids: ${lost.map((s) => s.id).join(", ")}.`,
    ``,
    `## 2. Did their sizes change?`,
    ``,
    resized.length === 0
      ? `No surviving snapshot changed size, so there is no silent re-encode or size cap on downgrade.`
      : table(["id", "bytes before", "bytes after"], resized.map((x) => [x.s.id, x.s.sizeBytes, x.after.sizeBytes])),
    ``,
    `## 3. What happened to anything running at the moment of the drop?`,
    ``,
    `Live sandboxes right now: **${liveSandboxes.value.length}**.`,
    ``,
    liveSandboxes.value.length > 0
      ? table(["id", "state", "cpu", "memMb"], liveSandboxes.value.map((s) => [s.sandboxId.slice(0, 16), s.state, s.cpu, s.memMb]))
      : `None. If a sandbox was deliberately left alive across the boundary, its absence here means the downgrade killed it. If nothing was left alive, this question is unanswered for this account and stays unanswered, because it cannot be reconstructed after the fact.`,
    ``,
    `## Plan limits`,
    ``,
    table(
      ["limit", "on Starter (baseline)", `on ${plan.name} (now)`],
      [
        ["concurrent sandboxes", baseline.maxSandboxes, plan.maxSandboxes],
        ["concurrent browsers", baseline.maxBrowsers, plan.maxBrowsers],
      ],
    ),
    ``,
    `Feed the answer back into \`00-verification.md\` V40 and close Q12 in \`01-prd.md\` section 11.`,
  ].join("\n");

  const path = writeReport("G4-q12-downgrade", md);
  writeData("G4-q12-downgrade", { baseline, now, survived, lost, added, resized, liveSandboxes: liveSandboxes.value, plan: plan.name });

  safeOut(`\n${verdict}\n\nWritten: ${path}\n`);
  return 0;
}

// Runnable directly as well as through `npm run gates -- --q12`.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await runQ12());
}
