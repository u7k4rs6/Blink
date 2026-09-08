/**
 * Soak state, on disk, because one of the checks is a deliberate restart.
 *
 * The soak has to prove that a live instance survives the operator restarting
 * the server. That is untestable if the run's own memory is the only record of
 * what is live, so every tick is appended to a file and the summary is derived
 * from the file rather than from anything held in the process.
 *
 * Append-only, one JSON object per line, same shape as the sandbox ledger. A
 * crashed soak loses at most the tick in flight.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { safeWriteFileSync } from "../../src/safe-io.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SOAK_DIR = join(root, "docs", "soak");
export const SOAK_LOG = join(SOAK_DIR, "soak.jsonl");

export type Tick = {
  kind: "tick";
  at: string;
  hour: string;
  app: string;
  /** Time from create() returning to previewUrl answering. The headline number. */
  resolveMs: number | null;
  forkToHealthyMs: number | null;
  livenessOk: boolean;
  livenessAsked: string;
  livenessDetail: string;
  sandboxSeconds: number;
  usd: number;
  error?: string;
};

export type Event =
  | Tick
  | { kind: "reconcile"; at: string; liveSandboxes: number; leaked: string[] }
  | { kind: "drift"; at: string; modelledUsd: number; measuredUsd: number; driftFraction: number }
  | { kind: "restart"; at: string; note: string; survivingInstance: string | null; survived: boolean }
  | { kind: "deliberate-kill"; at: string; sandbox: string; observedState: string; correct: boolean }
  | { kind: "start" | "stop"; at: string; note: string };

export function appendEvent(e: Event): void {
  if (!existsSync(SOAK_DIR)) safeWriteFileSync(join(SOAK_DIR, ".keep"), "");
  appendFileSync(SOAK_LOG, JSON.stringify(e) + "\n", "utf8");
}

export function readEvents(): Event[] {
  if (!existsSync(SOAK_LOG)) return [];
  const out: Event[] = [];
  for (const line of readFileSync(SOAK_LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Event); } catch { /* a torn final line is expected after a crash */ }
  }
  return out;
}

export const utcHour = (d = new Date()): string => d.toISOString().slice(0, 13);
