/**
 * Fail if an em dash appears anywhere in the docs, the README or the source.
 *
 * A house style rule that is enforced by whoever remembers it is a rule that
 * decays. This is cheap, runs with the tests, and is referenced by the pre-post
 * checklist, so it has to exist as a command rather than as a grep someone
 * types from memory.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { safeErr, safeOut } from "../src/safe-io.ts";

const EM_DASH = "—";
const ROOTS = ["README.md", "docs", "src", "scripts", "test"];
const SKIP = new Set(["node_modules", ".git", "data"]);
/** Generated files that quote external output verbatim. */
const GENERATED = ["docs/soak/soak.md"];

function walk(path: string, out: string[]): void {
  const s = statSync(path);
  if (s.isDirectory()) {
    if (SKIP.has(path.split("/").pop() ?? "")) return;
    for (const e of readdirSync(path)) walk(join(path, e), out);
    return;
  }
  if (!/\.(ts|md|json)$/.test(path)) return;
  // This file necessarily contains the character it is looking for.
  if (path.endsWith("lint-dashes.ts")) return;
  // Generated evidence files quote external systems verbatim. A Solari SDK error
  // reading "Not connected - call connect() first" arrives with an em dash in it,
  // and rewriting somebody else's error message to satisfy our house style would
  // falsify the record. House style governs prose we write, not evidence we quote.
  if (GENERATED.some((g) => path.endsWith(g))) return;
  const text = readFileSync(path, "utf8");
  text.split("\n").forEach((line, i) => {
    if (line.includes(EM_DASH)) out.push(`${path}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
}

const found: string[] = [];
for (const r of ROOTS) {
  try { walk(r, found); } catch { /* a missing root is not a failure */ }
}

if (found.length > 0) {
  safeErr(`\n${found.length} em dash(es) found. House style forbids them.\n\n`);
  for (const f of found) safeErr(`  ${f}\n`);
  safeErr(`\n`);
  process.exit(1);
}
safeOut(`No em dashes in ${ROOTS.join(", ")}.\n`);
