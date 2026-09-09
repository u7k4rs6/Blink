import { test } from "node:test";
import assert from "node:assert/strict";

import { Surfaces, type SurfaceDeps } from "../src/cache/surfaces.ts";

const deps = (over: Partial<SurfaceDeps> = {}): SurfaceDeps => ({
  liveBoard: async () => ({ instancesRunning: 1, launchedToday: 34, medianInBrowserMs: 5472,
    creditsLeftUsd: 16.42, creditsTotalUsd: 20, measuredFraction: 0.8, gaugeState: "ok" as const }),
  slots: async () => ({ free: 1, total: 2, queueDepth: { gitea: 0 }, launchesEnabled: true, disabledReason: null }),
  healthWall: async () => ({ apps: [], platformP95Ms: 10491, updatedAt: new Date().toISOString() }),
  ...over,
});

test("slots start DISABLED, so a launch is never admitted before it can be counted", async () => {
  // The safe default is refusing a launch we cannot cost, not admitting one we
  // cannot count. A seed that said "enabled" would open the site for one refresh
  // interval on every restart.
  const s = new Surfaces(deps());
  assert.equal(s.slots.read().value.launchesEnabled, false);
  assert.equal(s.slots.read().value.disabledReason, "starting up");
});

test("seeds are honest rather than flattering", async () => {
  // Zeros and nulls, never invented plausible numbers: a fabricated seed is
  // indistinguishable from a real value on the first paint after a restart,
  // which is exactly when the page is least checkable.
  const s = new Surfaces(deps());
  assert.equal(s.liveBoard.read().value.medianInBrowserMs, null);
  assert.equal(s.liveBoard.read().value.launchedToday, 0);
  assert.equal(s.healthWall.read().value.platformP95Ms, null);
});

test("a Solari outage leaves every surface serving its last real value", async () => {
  let up = true;
  const s = new Surfaces(deps({
    liveBoard: async () => { if (!up) throw new Error("solari down"); return {
      instancesRunning: 3, launchedToday: 99, medianInBrowserMs: 5472,
      creditsLeftUsd: 16.42, creditsTotalUsd: 20, measuredFraction: 1, gaugeState: "ok" as const }; },
  }));
  await s.liveBoard.refreshOnce();
  assert.equal(s.liveBoard.read().value.launchedToday, 99);
  up = false;
  await s.liveBoard.refreshOnce();
  assert.equal(s.liveBoard.read().value.launchedToday, 99, "the number must not vanish");
  assert.equal(s.liveBoard.read().failures, 1);
  s.stop();
});

test("the health wall carries p50 AND p95, since a p50 alone speaks for the median visitor only", async () => {
  const s = new Surfaces(deps({
    healthWall: async () => ({ apps: [{ id: "gitea", canaryOk: true, lastOkAt: null,
      inBrowserP50Ms: 5472, inBrowserP95Ms: 11933, history: [], currentSnapshotId: null }],
      platformP95Ms: 10491, updatedAt: new Date().toISOString() }),
  }));
  await s.healthWall.refreshOnce();
  const app = s.healthWall.read().value.apps[0]!;
  assert.equal(typeof app.inBrowserP50Ms, "number");
  assert.equal(typeof app.inBrowserP95Ms, "number");
  assert.equal(typeof s.healthWall.read().value.platformP95Ms, "number", "the tail is pooled and platform-wide");
  s.stop();
});

test("the gauge can report reconciling instead of a number", async () => {
  const s = new Surfaces(deps({
    liveBoard: async () => ({ instancesRunning: 0, launchedToday: 0, medianInBrowserMs: null,
      creditsLeftUsd: 0, creditsTotalUsd: 20, measuredFraction: 0.3, gaugeState: "reconciling" as const }),
  }));
  await s.liveBoard.refreshOnce();
  assert.equal(s.liveBoard.read().value.gaugeState, "reconciling");
  s.stop();
});
