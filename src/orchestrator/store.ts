/**
 * Instance state on disk.
 *
 * The runner kept instances in a Map, which is fine right up until the process
 * restarts. Then every timer is gone, no receipt is written, and the sandboxes
 * run on until the platform timeout with nothing tracking them. The soak's
 * restart rehearsal did not catch this: it proved a SANDBOX survives a state
 * round trip, which is a different claim from the SERVER recovering.
 *
 * Append-only, one JSON object per line, same shape as the sandbox ledger. The
 * last line for an id wins, so a crash mid-write loses at most one update and
 * never corrupts an earlier one.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Read lazily, never captured at module load.
 *
 * A constant resolved at import time cannot be redirected by a test that sets
 * the variable afterwards, and the consequence was not theoretical: unit tests
 * wrote 25 rows of fake sandbox ids into the real instance log, and the next
 * server boot dutifully tried to kill sandboxes named `sbx_1`. Test state
 * reaching a production code path is a bug even when it is harmless, because
 * the next time it will not be.
 */
export function instanceLogPath(): string {
  return process.env.BLINK_INSTANCE_LOG ?? join(homedir(), ".blink", "instances.jsonl");
}

export type PersistedInstance = {
  id: string;
  appId: string;
  sandboxId: string | null;
  state: string;
  createdAt: number;
  lifetimeStartedAt: number | null;
  expiresAt: number | null;
  extended: boolean;
  settled: boolean;
  sizeCpu: number;
  sizeMemMb: number;
};

export function persist(row: PersistedInstance): void {
  const path = instanceLogPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
}

/** The latest record for every instance. Later lines win. */
export function readAll(): PersistedInstance[] {
  const path = instanceLogPath();
  if (!existsSync(path)) return [];
  const byId = new Map<string, PersistedInstance>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as PersistedInstance;
      byId.set(r.id, r);
    } catch { /* a torn final line after a crash is expected */ }
  }
  return [...byId.values()];
}

/** Instances that were live when the process stopped. What a restart must adopt. */
export function readUnsettled(): PersistedInstance[] {
  return readAll().filter((r) => !r.settled && r.sandboxId);
}
