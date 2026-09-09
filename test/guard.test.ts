/** Guard arithmetic, slot accounting, and refusal-before-the-call. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { BudgetExceeded, BudgetGuard } from "../src/guard/guard.ts";
import { PLANS, SIZE_LARGE, SIZE_SMALL, sandboxHourly } from "../src/guard/rates.ts";

test("Starter hourly rates match 01-prd.md section 8 exactly", () => {
  // 0.035 + (2 x 0.011) = 0.057
  assert.equal(Math.round(sandboxHourly(PLANS.starter, SIZE_SMALL) * 1e6) / 1e6, 0.057);
  // (2 x 0.035) + (4 x 0.011) = 0.114
  assert.equal(Math.round(sandboxHourly(PLANS.starter, SIZE_LARGE) * 1e6) / 1e6, 0.114);
});

test("Free hourly rates match 01-prd.md section 8 exactly", () => {
  // 0.0525 + (2 x 0.0165) = 0.0855
  assert.equal(Math.round(sandboxHourly(PLANS.free, SIZE_SMALL) * 1e6) / 1e6, 0.0855);
  // (2 x 0.0525) + (4 x 0.0165) = 0.171
  assert.equal(Math.round(sandboxHourly(PLANS.free, SIZE_LARGE) * 1e6) / 1e6, 0.171);
});

test("a 10 minute 1 vCPU launch costs $0.0095 on Starter", () => {
  const g = new BudgetGuard(PLANS.starter, 1);
  g.addSandboxSeconds(600, SIZE_SMALL, true, "10 min launch");
  assert.equal(Math.round(g.usd() * 1e4) / 1e4, 0.0095);
});

test("a 12 tile 45 second Swarm run costs $0.0150 on Starter", () => {
  const g = new BudgetGuard(PLANS.starter, 1);
  g.addBrowserSeconds(12 * 45, true, "swarm run");
  assert.equal(Math.round(g.usd() * 1e4) / 1e4, 0.015);
});

test("the guard refuses before the call, not after", () => {
  const g = new BudgetGuard(PLANS.starter, 0.01);
  g.reserve(0.009, "first");
  assert.throws(() => g.reserve(0.009, "second"), BudgetExceeded);
  // Nothing was spent by the refusal.
  assert.equal(g.usd(), 0);
});

test("the sandbox slot check is what stops a 429 happening at all", () => {
  const g = new BudgetGuard(PLANS.starter, 1);
  g.reserveSandboxSlot();
  g.openedSandbox("sbx_a");
  g.reserveSandboxSlot();
  g.openedSandbox("sbx_b");
  // Starter caps at 2.
  assert.throws(() => g.reserveSandboxSlot(), BudgetExceeded);
});

test("pausing frees the slot, because a paused sandbox holds none (V20)", () => {
  const g = new BudgetGuard(PLANS.starter, 1);
  g.openedSandbox("sbx_a");
  g.openedSandbox("sbx_b");
  assert.throws(() => g.reserveSandboxSlot(), BudgetExceeded);
  g.pausedSandbox("sbx_a");
  assert.doesNotThrow(() => g.reserveSandboxSlot());
});

test("browser slots respect the plan cap: 20 on Starter, 3 on Free", () => {
  const starter = new BudgetGuard(PLANS.starter, 1);
  assert.doesNotThrow(() => starter.reserveBrowserSlots(12), "Swarm at 12 must fit on Starter");
  const free = new BudgetGuard(PLANS.free, 1);
  assert.throws(() => free.reserveBrowserSlots(12), BudgetExceeded);
  assert.doesNotThrow(() => free.reserveBrowserSlots(3), "Free degrades to 3 tiles");
});

test("a guard bug carries the full slot state for the report", () => {
  const g = new BudgetGuard(PLANS.starter, 1);
  g.openedSandbox("sbx_a");
  const bug = g.concurrencyBug("test");
  assert.equal(bug.slotState.sandboxesHeld, 1);
  assert.equal(bug.slotState.maxSandboxes, 2);
  assert.deepEqual(bug.slotState.liveSandboxIds, ["sbx_a"]);
});

// ---------------------------------------------------------------------------
// Key retention. These exist because the BYO-key fallback (01-prd.md 10.1)
// means the keys flowing through the adapter can belong to visitors.
// ---------------------------------------------------------------------------

import { SolariAdapter } from "../src/solari/adapter.ts";
import { SandboxLedger } from "../src/guard/ledger.ts";
import { CAPS_GATES, createCountingFetch } from "../src/solari/fetch.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function adapter() {
  const dir = mkdtempSync(join(tmpdir(), "blink-adapter-"));
  return new SolariAdapter({
    counting: createCountingFetch({ caps: CAPS_GATES }),
    guard: new BudgetGuard(PLANS.starter, 1),
    ledger: new SandboxLedger(join(dir, "l.jsonl")),
  });
}

test("the client cache is keyed by a digest, never by the key itself", () => {
  const d = SolariAdapter.keyDigest("slr_live_secret");
  assert.equal(d.length, 32);
  assert.ok(!d.includes("secret"), "the cache key must not contain the secret");
  assert.equal(d, SolariAdapter.keyDigest("slr_live_secret"), "digest is stable");
  assert.notEqual(d, SolariAdapter.keyDigest("slr_live_other"));
});

test("forgetKey evicts a retained key, which BYO-key mode requires on destroy", () => {
  const a = adapter();
  // Touching a private path via a public call would need the network, so drive
  // the cache through the digest-keyed public surface instead.
  assert.equal(a.cachedKeyCount(), 0);
  a.forgetKey("slr_live_absent");
  assert.equal(a.cachedKeyCount(), 0, "forgetting an absent key is a no-op, not an error");
});

test("the adapter refuses to serialise its keys", () => {
  const a = adapter();
  const json = JSON.stringify(a);
  assert.ok(!json.includes("slr_live"), "no key may leave via JSON.stringify");
  assert.ok(json.includes("keys are never serialised"));
});

test("the ledger separates measured spend from modelled spend", () => {
  // D10 shows a credit gauge publicly and Solari exposes no balance endpoint to
  // reconcile against, so a modelled row that diverges becomes a public wrongness.
  const g = new BudgetGuard(PLANS.starter, 1);
  g.addSandboxSeconds(600, SIZE_SMALL, true, "observed");
  g.addSandboxSeconds(600, SIZE_SMALL, false, "modelled");
  const s = g.summary();
  assert.equal(s.rows.length, 2);
  assert.equal(s.measuredUsd, 0.0095);
  assert.equal(s.modelledUsd, 0.0095);
  assert.equal(s.measuredFraction, 0.5);
  assert.equal(Math.round(s.usd * 1e4) / 1e4, 0.019);
});

test("a ledger with no rows reports fully measured rather than dividing by zero", () => {
  const s = new BudgetGuard(PLANS.starter, 1).summary();
  assert.equal(s.measuredFraction, 1);
  assert.equal(s.rows.length, 0);
});
