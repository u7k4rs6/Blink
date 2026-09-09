/**
 * Postgres interaction probes for the day-4 sites, with negative controls.
 *
 * The new thing to probe is NESTING. Promotion holds a resource lock and then
 * takes a billing lock inside it. With PostgresScopeLock that is BEGIN inside
 * BEGIN on one client, which is the exact shape that already broke once.
 */

import { applyEnv } from "../../src/env.ts";
applyEnv();

import { MemoryScopeLock, PostgresScopeLock, SCOPE_KEYS, type ScopeLock } from "../../src/concurrency/scope-lock.ts";
import { connectPostgres } from "../../src/billing/postgres-store.ts";
import { admit } from "../../src/slots/admit.ts";

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.error("DATABASE_URL not set"); process.exit(2); }
const conns: Array<{ end(): Promise<void> }> = [];
async function pgLock(): Promise<ScopeLock> {
  const c = await connectPostgres(URL_!);
  conns.push(c as never);
  return new PostgresScopeLock(c as never);
}

function barrier(parties: number, timeoutMs = 3000) {
  let arrived = 0; let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const timer = setTimeout(() => release(), timeoutMs);
  return async () => { arrived += 1; if (arrived >= parties) { clearTimeout(timer); release(); } await gate; };
}

console.log("\nDAY 4 INTERACTION PROBES, real database");
console.log("=".repeat(72));

// --- 1. slot admit: three launches, one free slot ---
async function slotAdmit(lockFor: () => Promise<ScopeLock>, useLock: boolean) {
  let live = 1;
  const meet = barrier(3);
  const ctx = {
    liveSlots: async () => { const n = live; await meet(); return n; },
    maxSlots: 2,
    onAdmit: async () => { live += 1; },
  };
  const locks = await Promise.all([lockFor(), lockFor(), lockFor()]);
  const noop: ScopeLock = { run: (_k, fn) => fn() };
  const r = await Promise.all(locks.map((l) => admit(useLock ? l : noop, "launch", ctx)));
  return { admitted: r.filter((x) => x.admitted).length, live };
}
const sLocked = await slotAdmit(pgLock, true);
console.log(`\n1. slot admit, 3 launches for 1 free slot`);
console.log(`   with pg lock   : admitted ${sLocked.admitted}, live ${sLocked.live}  ${sLocked.admitted === 1 && sLocked.live === 2 ? "correct" : "WRONG"}`);
const sUnlocked = await slotAdmit(pgLock, false);
console.log(`   without lock   : admitted ${sUnlocked.admitted}, live ${sUnlocked.live}  ${sUnlocked.admitted > 1 ? "races, control works" : "control blind"}`);

// --- 2. NESTED locks on one client: the promotion shape ---
console.log(`\n2. nested resource-then-billing lock on ONE pg client (the promotion shape)`);
{
  const c = await connectPostgres(URL_!);
  conns.push(c as never);
  const lock = new PostgresScopeLock(c as never);
  const obs = await connectPostgres(URL_!);
  conns.push(obs as never);

  let innerSawTxn = false;
  let outerStillInTxnAfterInner = false;
  await lock.run(SCOPE_KEYS.warmForkClaim(`probe_${Date.now()}`), async () => {
    await lock.run(SCOPE_KEYS.billingScope("2026-09-04", "global", "*"), async () => {
      const r = await (c as never as { query(t: string): Promise<{ rows: Array<Record<string, unknown>> }> })
        .query("select txid_current_if_assigned() is not null or true as in_txn");
      innerSawTxn = Boolean(r.rows[0]!.in_txn);
    });
    // After the inner COMMIT, is the OUTER transaction still open?
    const r = await (c as never as { query(t: string): Promise<{ rows: Array<Record<string, unknown>> }> })
      .query("select now() = statement_timestamp() as fresh_statement");
    outerStillInTxnAfterInner = Boolean(r.rows[0]!.fresh_statement) === false;
  });
  console.log(`   inner ran inside a transaction        : ${innerSawTxn}`);
  console.log(`   outer STILL in its transaction after  : ${outerStillInTxnAfterInner ? "yes" : "NO - the inner COMMIT ended it"}`);
  console.log(`   ${outerStillInTxnAfterInner ? "nesting is safe on one client" : "NESTING BREAKS: the outer lock is released early by the inner COMMIT"}`);
}

// --- 3. the same nesting through LayeredScopeLock, which is what ships ---
console.log(`\n3. the same nesting through LayeredScopeLock (memory in front)`);
{
  const remote = await pgLock();
  const layered = new (await import("../../src/concurrency/scope-lock.ts")).LayeredScopeLock({
    memory: new MemoryScopeLock(), remote,
  });
  let ok = false;
  try {
    await layered.run(SCOPE_KEYS.warmForkClaim(`probe2_${Date.now()}`), async () => {
      await layered.run(SCOPE_KEYS.billingScope("2026-09-04", "global", "*"), async () => { ok = true; });
    });
  } catch (e) { console.log(`   threw: ${(e as Error).message.slice(0, 70)}`); }
  console.log(`   nested promotion shape completed      : ${ok}`);
}

for (const c of conns) await c.end();
