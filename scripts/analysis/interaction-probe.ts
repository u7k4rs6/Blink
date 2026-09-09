/**
 * Probe the INTERACTIONS, not the sites.
 *
 * Each site alone passes now. The cases that matter are the ones the shared key
 * exists for, and a single-site probe cannot reveal a wrong key: it only ever
 * exercises one path, so two paths sharing a resource look fine until they run
 * together.
 *
 * Two interactions, both against the real database:
 *
 *   1. a queue promotion racing a direct launch for the last READY fork
 *   2. a replenishment racing a visitor launch for the last account slot
 *
 * Each runs twice: once with the keys as configured, and once with the keys
 * deliberately split, so the probe proves it can DETECT a wrong key rather than
 * only reporting a pass.
 */

import { applyEnv } from "../../src/env.ts";
applyEnv();

import { PostgresScopeLock, SCOPE_KEYS, type ScopeLock } from "../../src/concurrency/scope-lock.ts";
import { connectPostgres } from "../../src/billing/postgres-store.ts";
import { replenishMayStart } from "../../src/warmpool/states.ts";

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.error("DATABASE_URL not set"); process.exit(2); }

const conns: Array<{ end(): Promise<void> }> = [];
async function lock(): Promise<ScopeLock> {
  const c = await connectPostgres(URL_!);
  conns.push(c as never);
  return new PostgresScopeLock(c as never);
}

const RUN = Date.now();

/**
 * A two-party barrier, because sleeps do not reliably interleave here.
 *
 * The first version of this probe used a 40 ms await between the read and the
 * write and reported that split keys did NOT race. That was the probe being
 * blind, not the keys being safe: a connection round trip through the pooler is
 * several hundred milliseconds, so the first caller finished its whole body
 * before the second had opened its transaction. The negative control is what
 * caught it.
 *
 * A barrier removes the timing assumption. Both callers announce they have READ
 * and then wait for the other. If a lock is held, the second never arrives and
 * the first proceeds after a timeout, so the probe is correct in both cases
 * instead of depending on how fast the network happens to be.
 */
function barrier(parties: number, timeoutMs = 3000) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const timer = setTimeout(() => release(), timeoutMs);
  return async () => {
    arrived += 1;
    if (arrived >= parties) { clearTimeout(timer); release(); }
    await gate;
  };
}

// ---------------------------------------------------------------------------
// 1. queue promotion vs direct launch, for the last READY fork
// ---------------------------------------------------------------------------
async function forkContention(sameKey: boolean) {
  const app = `gitea_${RUN}_${sameKey ? "same" : "split"}`;
  let readyForks = 1;
  let claims = 0;

  const meet = barrier(2);
  const claimBody = async () => {
    const n = readyForks;          // READ
    await meet();                  // both callers park here if nothing excludes them
    if (n < 1) return false;       // CHECK
    readyForks = n - 1;            // WRITE
    claims += 1;
    return true;
  };

  const promoteLock = await lock();
  const launchLock = await lock();
  const kPromote = SCOPE_KEYS.queuePromote(app);
  // The wrong version: the launch path gets its own key, as it would if the key
  // followed the code path instead of the resource.
  const kLaunch = sameKey ? SCOPE_KEYS.warmForkClaim(app) : `launch_path|${app}`;

  await Promise.all([
    promoteLock.run(kPromote, claimBody),
    launchLock.run(kLaunch, claimBody),
  ]);
  return { claims, readyForks };
}

// ---------------------------------------------------------------------------
// 2. replenishment vs visitor launch, for the last account slot
// ---------------------------------------------------------------------------
async function slotContention(replenishYields: boolean) {
  const MAX = 2;
  let live = 1;                 // one instance already running: one slot free
  let admitted = { launch: 0, replenish: 0 };

  const meet = barrier(2);
  const takeSlot = async (who: "launch" | "replenish") => {
    const free = MAX - live;                       // READ
    await meet();
    if (who === "replenish" && replenishYields && !replenishMayStart(free)) return false;
    if (free < 1) return false;                    // CHECK
    live += 1;                                     // WRITE
    admitted[who] += 1;
    return true;
  };

  const l1 = await lock();
  const l2 = await lock();
  const k = SCOPE_KEYS.sandboxSlot();
  await Promise.all([
    l1.run(k, () => takeSlot("launch")),
    l2.run(k, () => takeSlot("replenish")),
  ]);
  return { ...admitted, live, overCap: live > MAX };
}

// ---------------------------------------------------------------------------

console.log("\nINTERACTION PROBES, against the real database");
console.log("=".repeat(74));

console.log("\n1. queue promotion vs direct launch, one READY fork");
const shared = await forkContention(true);
console.log(`   shared key : ${shared.claims} claims, forks left ${shared.readyForks}` +
  `  ${shared.claims === 1 ? "correct" : "DOUBLE CLAIM"}`);
const split = await forkContention(false);
console.log(`   split key  : ${split.claims} claims, forks left ${split.readyForks}` +
  `  ${split.claims > 1 ? "races, as it must to prove the probe works" : "did not race, probe is blind"}`);

console.log("\n2. replenishment vs visitor launch, one free slot of two");
const yielding = await slotContention(true);
console.log(`   replenish yields   : launch=${yielding.launch} replenish=${yielding.replenish} live=${yielding.live}` +
  `  ${yielding.launch === 1 && yielding.replenish === 0 ? "visitor wins, correct" : "WRONG"}`);
const greedy = await slotContention(false);
console.log(`   replenish greedy   : launch=${greedy.launch} replenish=${greedy.replenish} live=${greedy.live}` +
  `  ${greedy.overCap ? "OVER CAP" : greedy.replenish === 1 ? "replenish took the visitor's slot" : "visitor won by luck of ordering"}`);

for (const c of conns) await c.end();

console.log("\nVERDICT");
const keyOk = shared.claims === 1 && split.claims > 1;
const yieldOk = yielding.launch === 1 && yielding.replenish === 0;
console.log(`  shared key prevents double-claim, and probe can detect a wrong key : ${keyOk ? "YES" : "NO"}`);
console.log(`  replenishment yields the last slot to a visitor                     : ${yieldOk ? "YES" : "NO"}`);
