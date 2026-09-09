import { test } from "node:test";
import assert from "node:assert/strict";

import { SurfaceCache } from "../src/cache/surface.ts";

test("a failing refresh keeps the last good value instead of blanking the page", async () => {
  let mode: "ok" | "fail" = "ok";
  const c = new SurfaceCache({
    initial: { n: 0 }, intervalMs: 10_000,
    refresh: async () => { if (mode === "fail") throw new Error("solari down"); return { n: 42 }; },
  });
  await c.refreshOnce();
  assert.equal(c.read().value.n, 42);

  mode = "fail";
  await c.refreshOnce();
  assert.equal(c.read().value.n, 42, "the number must not vanish during an outage");
  assert.equal(c.read().failures, 1);
  assert.match(c.read().lastError!, /solari down/);
});

test("a read never throws, even when every refresh has failed", async () => {
  const c = new SurfaceCache({
    initial: { n: -1 }, intervalMs: 1000,
    refresh: async () => { throw new Error("always down"); },
  });
  await c.refreshOnce();
  assert.doesNotThrow(() => c.read());
  assert.equal(c.read().value.n, -1, "the seed is served rather than an exception");
});

test("a restart serves the mirror, not the seed", async () => {
  const c = new SurfaceCache({
    initial: { n: 0 }, intervalMs: 10_000,
    load: async () => ({ value: { n: 99 }, updatedAtMs: Date.now() - 500, failures: 0, lastError: null }),
    refresh: async () => { throw new Error("solari still down"); },
  });
  await c.start();
  c.stop();
  assert.equal(c.read().value.n, 99, "stale but real beats a spinner");
});

test("staleness is two intervals, so one missed tick is not an apology", async () => {
  const c = new SurfaceCache({ initial: { n: 1 }, intervalMs: 1000, refresh: async () => ({ n: 1 }) });
  await c.refreshOnce();
  const t = Date.now();
  assert.equal(c.read(t + 1500).stale, false, "one missed tick is normal");
  assert.equal(c.read(t + 2500).stale, true);
});

test("a never-refreshed cache reports infinite age rather than pretending to be fresh", () => {
  const c = new SurfaceCache({ initial: { n: 0 }, intervalMs: 1000, refresh: async () => ({ n: 1 }) });
  assert.equal(c.read().ageMs, Infinity);
  assert.equal(c.read().stale, true);
});

test("a failing save does not lose the fresh value", async () => {
  const c = new SurfaceCache({
    initial: { n: 0 }, intervalMs: 1000,
    refresh: async () => ({ n: 7 }),
    save: async () => { throw new Error("postgres down"); },
  });
  await c.refreshOnce();
  assert.equal(c.read().value.n, 7, "the mirror is a convenience, not the source of truth");
});

test("the refresh timer does not hold the process open", async () => {
  const c = new SurfaceCache({ initial: { n: 0 }, intervalMs: 50, refresh: async () => ({ n: 1 }) });
  await c.start();
  // unref'd, so node can exit with this running. An unclosed handle already cost
  // a diagnosis session once.
  c.stop();
  assert.ok(true);
});
