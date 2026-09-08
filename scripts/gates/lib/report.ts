/**
 * Report writing. Every gate produces two artifacts:
 *   docs/gates/<id>.md        a report a human reads
 *   docs/gates/data/<id>.json the raw samples, which are also the capture
 *                             source for replacing the synthesized fixtures
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { safeWriteFileSync, safeWriteJsonSync } from "../../../src/safe-io.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const GATES_DIR = join(root, "docs", "gates");
export const DATA_DIR = join(GATES_DIR, "data");

/**
 * Redaction lives in `src/redact.ts` now, as the single point every writer uses.
 * Re-exported here so existing imports keep working, but nothing should call it
 * directly: use the safe writers below, which cannot be bypassed by forgetting.
 */
export { redact, registerSecret, handleFor } from "../../../src/redact.ts";

export function writeReport(id: string, markdown: string): string {
  const p = join(GATES_DIR, `${id}.md`);
  safeWriteFileSync(p, markdown);
  return p;
}

/**
 * Write a gate's raw samples, twice.
 *
 * `<id>.json` is the latest run, which the report tooling and `npm run rederive`
 * read. `<id>-<runId>.json` is a permanent per-run archive.
 *
 * The archive exists because the latest-only file silently destroyed evidence:
 * running G1 against a second app overwrote the first app's 40 samples, and it
 * was noticed by accident with minutes to spare. The whole argument for
 * publishing raw samples rather than summaries depends on the samples still
 * being there, so a run that cost real money is never overwritten by the next
 * one.
 */
export function writeData(id: string, data: unknown): string {
  const p = join(DATA_DIR, `${id}.json`);
  safeWriteJsonSync(p, data);
  const runId = (data as { runId?: string })?.runId;
  if (runId) {
    // runId already carries the gate id and an ISO timestamp.
    safeWriteJsonSync(join(DATA_DIR, `${runId}.json`), data);
  }
  return p;
}

export function table(headers: string[], rows: Array<Array<string | number>>): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `|${headers.map(() => "---").join("|")}|`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}
