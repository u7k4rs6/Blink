/**
 * Warm pool tests.
 *
 * The pool exists to move the previewUrl resolve off the visitor's clock. Its
 * two dangerous behaviours are taking a slot a visitor needed, and handing over
 * a URL whose token has expired, so those get the most attention.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { WarmPool, poolIsWorthIt } from "../src/warmpool/pool.ts";
import { MemoryScopeLock } from "../src/concurrency/scope-lock.ts";
import { URL_REFRESH_AFTER_MS } from "../src/warmpool/states.ts";
import { SIZE_SMALL } from "../src/guard/rates.ts";

const APP = { appId: "gitea", snapshotId: "snap_x", size: SIZE_SMALL, port: 3000, healthPath: "/" };

function pool(over: {
  liveSlots?: number; depth?: number; healthy?: boolean; url?: string | null; now?: () => number;
  pauseThrows?: boolean;
} = {}) {
  const calls = { created: 0, killed: [] as string[], paused: 0, resolved: 0 };
  const adapter = {
    async createSandbox() {
      calls.created += 1;
      return { value: { sandboxId: `sbx_${calls.created}` }, ms: 1 };
    },
    async exec() { return { value: { stdout: "", stderr: "", exitCode: 0 }, ms: 1 }; },
    async previewUrl() {
      calls.resolved += 1;
      return { value: { url: over.url === undefined ? "https://h/?pt_token=T" : over.url }, ms: 1 };
    },
    async pause() {
      if (over.pauseThrows) throw new Error("pause failed");
      calls.paused += 1;
      return { value: undefined, ms: 1 };
    },
    async killQuiet(_k: string, id: string) { calls.killed.push(id); },
  } as never;

  const p = new WarmPool({
    apiKey: "k", adapter, lock: new MemoryScopeLock(),
    liveSlots: async () => over.liveSlots ?? 0,
    maxSlots: 2,
    depth: () => over.depth ?? 1,
    waitHealthy: async () => ({ ok: over.healthy ?? true, ms: 10 }),
    now: over.now,
  });
  return { p, calls };
}

test("the pool resolves the URL BEFORE pausing, which is the whole saving", async () => {
  const { p, calls } = pool();
  const r = await p.replenishOne(APP);
  assert.equal(r.built, true);
  assert.equal(calls.resolved, 1);
  assert.equal(calls.paused, 1);
  assert.equal(p.depthFor("gitea"), 1);
});

test("replenishment YIELDS the last slot to visitors", async () => {
  // A visitor must never wait behind the pool refilling itself.
  const { p, calls } = pool({ liveSlots: 1 });
  const r = await p.replenishOne(APP);
  assert.equal(r.built, false);
  assert.equal(r.reason, "yielded to visitors");
  assert.equal(calls.created, 0, "no sandbox may be created when yielding");
});

test("at capacity the pool refuses without calling Solari", async () => {
  const { p, calls } = pool({ liveSlots: 2 });
  const r = await p.replenishOne(APP);
  assert.equal(r.built, false);
  assert.equal(calls.created, 0);
});

test("a claim with a STALE url refuses it rather than handing it over", async () => {
  // A dead pt_token fails in the visitor's browser, which is the worst possible
  // place to discover the URL had expired.
  let t = 1_000_000;
  const { p } = pool({ now: () => t });
  await p.replenishOne(APP);
  assert.equal(p.depthFor("gitea"), 1);

  t += URL_REFRESH_AFTER_MS + 1;
  assert.equal(p.claim("gitea"), null, "a stale fork must not be claimable");
  assert.equal(p.depthFor("gitea"), 0, "and it must leave the ready set");
});

test("a fresh fork IS claimed, and leaves the pool when it is", async () => {
  const { p } = pool();
  await p.replenishOne(APP);
  const f = p.claim("gitea");
  assert.ok(f);
  assert.equal(f!.state, "CLAIMED");
  assert.equal(p.depthFor("gitea"), 0, "a claimed fork is no longer available to anyone else");
  assert.equal(p.claim("gitea"), null);
});

test("a released claim goes back into the pool", async () => {
  const { p } = pool();
  await p.replenishOne(APP);
  const f = p.claim("gitea")!;
  p.release(f);
  assert.equal(p.depthFor("gitea"), 1);
});

test("a fork that fails anywhere is KILLED, not left half built", async () => {
  // A half-built warm fork is a sandbox nobody will claim and nothing will look
  // for, which is the definition of a leak.
  for (const bad of [{ healthy: false }, { url: null }, { pauseThrows: true }]) {
    const { p, calls } = pool(bad);
    const r = await p.replenishOne(APP);
    assert.equal(r.built, false);
    assert.equal(calls.killed.length, 1, `not killed for ${JSON.stringify(bad)}`);
    assert.equal(p.depthFor("gitea"), 0);
  }
});

test("the pool stops at its target depth", async () => {
  const { p, calls } = pool({ depth: 2 });
  await p.replenishOne(APP);
  await p.replenishOne(APP);
  const third = await p.replenishOne(APP);
  assert.equal(third.built, false);
  assert.equal(third.reason, "at target depth");
  assert.equal(calls.created, 2);
});

test("depth zero disables the pool for that app entirely", async () => {
  const { p, calls } = pool({ depth: 0 });
  const r = await p.replenishOne(APP);
  assert.equal(r.built, false);
  assert.equal(calls.created, 0);
});

test("draining kills every parked fork", async () => {
  const { p, calls } = pool({ depth: 2 });
  await p.replenishOne(APP);
  await p.replenishOne(APP);
  assert.equal(await p.drain(), 2);
  assert.equal(calls.killed.length, 2);
  assert.equal(p.all().length, 0);
});

test("the G1 kill criterion is code, not a note in a document", () => {
  // If cold p95 is within 500 ms of warm p50 the pool is deleted rather than
  // kept because it was built.
  assert.equal(poolIsWorthIt(5500, 4000), true, "1.5 s of saving is worth keeping");
  assert.equal(poolIsWorthIt(4300, 4000), false, "300 ms is not, and the pool goes");
  assert.equal(poolIsWorthIt(4500, 4000), false, "exactly 500 ms is not enough either");
});

// ---------------------------------------------------------------------------
// The warm path inside the runner
// ---------------------------------------------------------------------------

import { LaunchRunner } from "../src/orchestrator/runner.ts";
import { SandboxLedger } from "../src/guard/ledger.ts";
import { BudgetGuard } from "../src/guard/guard.ts";
import { PLANS } from "../src/guard/rates.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runnerWith(poolObj: WarmPool | undefined) {
  const calls = { created: 0, resumed: 0, resolved: 0, killed: [] as string[] };
  const dir = mkdtempSync(join(tmpdir(), "blink-warm-"));
  const runner = new LaunchRunner({
    apiKey: "k",
    adapter: {
      async createSandbox() { calls.created += 1; return { value: { sandboxId: `sbx_${calls.created}` }, ms: 1 }; },
      async resume() { calls.resumed += 1; return { value: undefined, ms: 1 }; },
      async exec() { return { value: { stdout: "", stderr: "", exitCode: 0 }, ms: 1 }; },
      async previewUrl() { calls.resolved += 1; return { value: { url: "https://cold/?pt_token=C" }, ms: 1 }; },
      async killQuiet(_k: string, id: string) { calls.killed.push(id); },
    } as never,
    guard: new BudgetGuard(PLANS.starter, 1),
    ledger: new SandboxLedger(join(dir, "s.jsonl")),
    lock: new MemoryScopeLock(),
    liveSlots: async () => 0,
    waitHealthy: async () => ({ ok: true, ms: 10 }),
    pool: poolObj,
  });
  return { runner, calls };
}

test("a warm claim RESUMES and never creates or re-resolves", async () => {
  const { p } = pool();
  await p.replenishOne(APP);
  const { runner, calls } = runnerWith(p);
  const inst = await runner.launch(APP);

  assert.equal(inst.path, "warm");
  assert.equal(calls.resumed, 1);
  assert.equal(calls.created, 0, "a warm claim must not create a sandbox");
  assert.equal(calls.resolved, 0, "nor pay the previewUrl resolve the pool already paid");
  assert.equal(inst.previewUrl, "https://h/?pt_token=T", "it hands over the URL resolved at build time");
  assert.equal(inst.state, "HANDOVER");
});

test("an empty pool falls back to cold without failing the launch", async () => {
  const { p } = pool({ depth: 0 });
  const { runner, calls } = runnerWith(p);
  const inst = await runner.launch(APP);
  assert.equal(inst.path, "cold");
  assert.equal(calls.created, 1);
  assert.equal(calls.resolved, 1);
});

test("no pool at all is a valid configuration", async () => {
  const { runner, calls } = runnerWith(undefined);
  const inst = await runner.launch(APP);
  assert.equal(inst.path, "cold");
  assert.equal(calls.created, 1);
});

test("a share launch NEVER uses the pool", async () => {
  // A pooled fork carries the catalog snapshot's state. The entire point of a
  // share is somebody else's, so taking a warm fork would serve the wrong data.
  const { p } = pool();
  await p.replenishOne(APP);
  const { runner, calls } = runnerWith(p);
  const inst = await runner.launch({ ...APP, snapshotId: "snap_shared", fromShareToken: "tok" });
  assert.equal(inst.path, "cold");
  assert.equal(calls.created, 1);
  assert.equal(p.depthFor("gitea"), 1, "and the warm fork stays in the pool for someone else");
});
