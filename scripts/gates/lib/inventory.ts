/**
 * The pre-downgrade snapshot baseline.
 *
 * This exists because the baseline is UNRECOVERABLE once the Starter month
 * drops. There is no way to ask Solari what you used to have. So G4 writes it
 * unconditionally on every run, whether or not anyone has thought about Q12 yet,
 * and never overwrites an existing one: an older baseline is more valuable than
 * a newer one, because it was taken further from the event.
 */

import { existsSync, readFileSync } from "node:fs";

import { safeWriteJsonSync } from "../../../src/safe-io.ts";
import { join } from "node:path";

import { DATA_DIR } from "./report.ts";

export const BASELINE_PATH = join(DATA_DIR, "g4-baseline.json");

export type SnapshotRecord = {
  id: string;
  name: string | null;
  sizeBytes: number;
  createdAt: string;
  template: string;
};

export type Baseline = {
  capturedAt: string;
  plan: string;
  starterEnds: string | null;
  maxSandboxes: number;
  maxBrowsers: number;
  snapshotCount: number;
  totalBytes: number;
  snapshots: SnapshotRecord[];
};

/**
 * Write the baseline. Returns the path written.
 *
 * If the canonical file already exists it is left alone and a dated file is
 * written beside it, so a later run can never destroy the earliest record.
 */
export function writeBaseline(b: Baseline): { path: string; wasFirst: boolean } {
  if (!existsSync(BASELINE_PATH)) {
    safeWriteJsonSync(BASELINE_PATH, b);
    return { path: BASELINE_PATH, wasFirst: true };
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, "-");
  const dated = join(DATA_DIR, `g4-baseline-${stamp}.json`);
  safeWriteJsonSync(dated, b);
  return { path: dated, wasFirst: false };
}

/** The earliest baseline, which is the one Q12 compares against. */
export function readBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch {
    return null;
  }
}
