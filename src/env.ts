/**
 * Read .env in-process, never through the shell.
 *
 * Sourcing a .env in zsh echoes the offending line on any syntax error, and a
 * malformed line put a live database password into a transcript. A file holding
 * a credential should never be interpreted by something whose error handling is
 * to print the input back.
 *
 * This parser has no execution semantics at all: it splits on the first `=` and
 * stops. A malformed line is skipped, not run.
 */

import { existsSync, readFileSync } from "node:fs";

export function loadEnv(path = ".env"): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // no key: skipped, never executed
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Load into process.env without overwriting anything already set. */
export function applyEnv(path = ".env"): void {
  for (const [k, v] of Object.entries(loadEnv(path))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
