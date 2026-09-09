/**
 * Cold recovery after an unclean shutdown.
 *
 *   npm run recover           # show what is live and what the ledger knows
 *   npm run recover -- --kill # actually kill our orphans, then reconcile
 *
 * Written to be run when you are not in a position to reconstruct anything: the
 * machine died, sandboxes may still be billing, and the useful thing is one
 * command that answers "what is running, is it mine, and stop it".
 *
 * Dry by default. It prints the plan and changes nothing until `--kill`, because
 * the first thing you want after a crash is to know what happened, and the
 * second thing is to stop it, in that order.
 */

import { readAll, persist } from "../src/orchestrator/store.ts";
import { handleFor } from "../src/redact.ts";
import { safeErr, safeOut } from "../src/safe-io.ts";

const KILL = process.argv.includes("--kill");
const apiKey = process.env.SOLARI_API_KEY;
const baseUrl = process.env.SOLARI_BASE_URL ?? "https://api.getsolari.com";

if (!apiKey) {
  safeErr("SOLARI_API_KEY is not set. Source your env first.\n");
  process.exit(2);
}

type Live = { sandboxId: string; metadata?: Record<string, unknown>; createdAt?: string };

async function listLive(): Promise<Live[]> {
  const res = await fetch(`${baseUrl}/sandboxes?state=running`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const body = (await res.json()) as { sandboxes?: Live[] };
  return body.sandboxes ?? [];
}

async function kill(id: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}/sandboxes/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  return res.status === 200 || res.status === 204 || res.status === 404;
}

const RATE_PER_HOUR = 0.057; // 1 vCPU / 2 GB on Starter

async function main(): Promise<number> {
  safeOut(`\n=== Blink cold recovery ===\n${KILL ? "  MODE: killing\n" : "  MODE: dry run. Add --kill to act.\n"}\n`);

  const live = await listLive();
  const rows = readAll();
  const known = new Map(rows.filter((r) => r.sandboxId).map((r) => [r.sandboxId!, r]));

  safeOut(`Solari says ${live.length} sandbox(es) are running.\n`);
  if (live.length === 0) {
    safeOut(`Nothing to recover. The ledger has ${rows.filter((r) => !r.settled).length} unsettled row(s), which is bookkeeping only.\n`);
    return 0;
  }

  // Ours if the instance log recorded it, or it carries our metadata tag.
  // Anything else belongs to something else on this account and is left alone.
  const ours: Live[] = [];
  const foreign: Live[] = [];
  for (const s of live) {
    const tagged = Object.keys(s.metadata ?? {}).some((k) => k.startsWith("blink"));
    (known.has(s.sandboxId) || tagged ? ours : foreign).push(s);
  }

  safeOut(`\n  ours    : ${ours.length}\n  foreign : ${foreign.length}  (left alone, always)\n\n`);

  for (const s of ours) {
    const row = known.get(s.sandboxId);
    const age = row?.lifetimeStartedAt ? Math.round((Date.now() - row.lifetimeStartedAt) / 60_000) : null;
    safeOut(
      `  ${handleFor(s.sandboxId)}  ${row?.appId ?? "unknown app"}` +
      `${age !== null ? `  alive ${age} min` : "  not in the ledger, so it predates the last write"}\n`,
    );
  }

  const burnPerDay = ours.length * RATE_PER_HOUR * 24;
  safeOut(`\n  If left running: about $${burnPerDay.toFixed(2)} per day at $${RATE_PER_HOUR}/h each.\n`);

  if (!KILL) {
    safeOut(`\n  Nothing was changed. Run again with --kill to stop them.\n\n`);
    return 0;
  }

  safeOut(`\n  killing ${ours.length}...\n`);
  let killed = 0;
  for (const s of ours) {
    const ok = await kill(s.sandboxId);
    safeOut(`    ${ok ? "killed " : "FAILED "} ${handleFor(s.sandboxId)}\n`);
    if (!ok) continue;
    killed += 1;
    // Reconcile the ledger: mark the row settled so the watchdog and the next
    // boot stop chasing it. Its cost is already spent; this stops the chasing,
    // it does not pretend the money came back.
    const row = known.get(s.sandboxId);
    if (row) persist({ ...row, settled: true, state: "ENDED" });
  }

  // Rows for sandboxes that are no longer live are settled too: the instance is
  // gone either way, and leaving them open makes every future recovery noisier.
  let tidied = 0;
  const liveIds = new Set(live.map((s) => s.sandboxId));
  for (const r of rows) {
    if (!r.settled && r.sandboxId && !liveIds.has(r.sandboxId)) {
      persist({ ...r, settled: true, state: "ENDED" });
      tidied += 1;
    }
  }

  safeOut(`\n  killed ${killed} of ${ours.length}. Ledger: ${killed} settled, ${tidied} stale row(s) closed.\n`);
  if (killed < ours.length) {
    safeErr(`\n  SOME KILLS FAILED. Re-run this command. If it keeps failing, the ids are above.\n`);
    return 1;
  }
  safeOut(`\n  Recovered. Verify with: npm run sweep\n\n`);
  return 0;
}

process.exit(await main());
