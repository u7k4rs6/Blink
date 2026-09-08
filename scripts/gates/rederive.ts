/**
 * `npm run rederive -- g6`
 *
 * Re-run a gate's verdict logic against its ALREADY STORED data. No Solari
 * calls, no credits, no new observations.
 *
 * This exists to enforce one process rule:
 *
 *   When a gate's verdict disagrees with your reading of its own data, fix the
 *   logic and re-derive. NEVER publish a reading under the old logic's run.
 *
 * A corrected conclusion asserted in prose, over a report file that still says
 * something else, is not a record anyone can audit six weeks later. Re-deriving
 * costs nothing and makes the provenance explicit: the verdict comes from code
 * over stored data, and the report says so.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { deriveG6Verdict } from "./lib/g6-verdict.ts";
import { DATA_DIR, writeReport } from "./lib/report.ts";
import { enforceMinimum } from "./lib/harness.ts";
import { safeOut, safeErr } from "../../src/safe-io.ts";

const which = process.argv[2] ?? process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);

if (which !== "g6") {
  safeErr(
    `usage: npm run rederive -- g6\n\n` +
      `Only g6 has extracted verdict logic today. Extract another gate's logic into\n` +
      `scripts/gates/lib/ before re-deriving it.\n`,
  );
  process.exit(2);
}

const dataPath = join(DATA_DIR, "g6.json");
if (!existsSync(dataPath)) {
  safeErr(`no stored data at ${dataPath}. Run the gate first.\n`);
  process.exit(2);
}

const stored = JSON.parse(readFileSync(dataPath, "utf8")) as {
  runId: string;
  plan: string;
  verdict: string;
  data: { steps: Array<{ name: string; ok: boolean | null; detail: string }>; sizeDelta: unknown; capDiag: string | null; mountInfo: string | null };
};

const originalVerdict = stored.verdict;

// The context is only used for plan-name interpolation in the markdown.
const fakeCtx = { plan: { name: stored.plan } } as never;
const result = deriveG6Verdict(
  fakeCtx,
  stored.data.steps,
  null,
  stored.data.sizeDelta as never,
  stored.data.capDiag,
  stored.data.mountInfo,
);

const judged = enforceMinimum(result, {
  id: "g6",
  minObservations: 5,
  observationUnit: "decided step",
});

const changed = judged.verdict !== originalVerdict;

const provenance = [
  `> **Verdict re-derived ${new Date().toISOString()} from corrected logic over the ORIGINAL stored data.**`,
  `>`,
  `> No Solari call was made and no new observation was taken. The bytes in`,
  `> \`docs/gates/data/g6.json\` from run \`${stored.runId}\` are unchanged; only the`,
  `> logic that reads them was fixed.`,
  `>`,
  changed
    ? `> The original run printed:\n> \n> > ${originalVerdict}\n> \n> The corrected logic produces the verdict below. **This is code over data, not a\n> human reading over a disagreeing report.**`
    : `> The corrected logic produces the same verdict as the original run.`,
  ``,
].join("\n");

const md = [
  `# G6: outbound egress restriction`,
  ``,
  provenance,
  `**Question.** Can outbound network from the sandbox be restricted, by a guest-side nftables firewall or otherwise (Q5)?`,
  ``,
  `**Verdict.** ${judged.verdict}`,
  ``,
  `**Observations.** ${result.observations} decided steps, against a declared minimum of 5.`,
  ``,
  result.markdown,
].join("\n");

writeReport("g6", md);

safeOut(`\nRe-derived g6 from ${dataPath}\n\n`);
safeOut(`  original : ${originalVerdict.slice(0, 160)}\n\n`);
safeOut(`  corrected: ${judged.verdict.slice(0, 300)}\n\n`);
safeOut(changed ? "  VERDICT CHANGED. docs/gates/g6.md rewritten with provenance.\n" : "  unchanged.\n");
