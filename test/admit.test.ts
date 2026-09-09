import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryScopeLock, SCOPE_KEYS } from "../src/concurrency/scope-lock.ts";
import { admit } from "../src/slots/admit.ts";

const ctx = (live: number, max = 2, onAdmit = async () => {}) => {
  let n = live;
  return {
    liveSlots: async () => n,
    maxSlots: max,
    onAdmit: async () => { n += 1; await onAdmit(); },
    get live() { return n; },
  };
};

test("three concurrent launches against one free slot admit exactly one", async () => {
  // The race audit admitted all three and took a cap of 2 to 4.
  const lock = new MemoryScopeLock();
  const c = ctx(1);
  const r = await Promise.all([
    admit(lock, "launch", c), admit(lock, "launch", c), admit(lock, "launch", c),
  ]);
  assert.equal(r.filter((x) => x.admitted).length, 1);
  assert.equal(c.live, 2, "the hard cap must not be exceeded, or Solari returns a 429");
});

test("a launch may take the last slot, because that is what it is for", async () => {
  const lock = new MemoryScopeLock();
  assert.deepEqual(await admit(lock, "launch", ctx(1)), { admitted: true });
});

test("replenish yields the last slot rather than making a visitor wait", async () => {
  const lock = new MemoryScopeLock();
  assert.deepEqual(await admit(lock, "replenish", ctx(1)), { admitted: false, reason: "yielded_to_visitors" });
});

test("the canary yields too, since it is background work by definition", async () => {
  const lock = new MemoryScopeLock();
  assert.deepEqual(await admit(lock, "canary", ctx(1)), { admitted: false, reason: "yielded_to_visitors" });
});

test("replenish proceeds when both slots are free", async () => {
  const lock = new MemoryScopeLock();
  assert.deepEqual(await admit(lock, "replenish", ctx(0)), { admitted: true });
});

test("at capacity, everyone is refused before any Solari call", async () => {
  const lock = new MemoryScopeLock();
  for (const who of ["launch", "replenish", "canary"] as const) {
    assert.deepEqual(await admit(lock, who, ctx(2)), { admitted: false, reason: "at_capacity" });
  }
});

test("a launch racing a replenish for the last slot: the visitor wins", async () => {
  const lock = new MemoryScopeLock();
  const c = ctx(1);
  const [l, r] = await Promise.all([admit(lock, "launch", c), admit(lock, "replenish", c)]);
  assert.equal(l.admitted, true);
  assert.equal(r.admitted, false);
});

test("admit takes a rank-1 key, so it cannot be called while holding a billing lock", async () => {
  // Enforced by withHeldKey rather than by remembering. This is the exact
  // pattern that would have deadlocked against promotion.
  const lock = new MemoryScopeLock();
  await assert.rejects(
    () => lock.run(SCOPE_KEYS.billingScope("2026-09-04", "global", "*"), async () =>
      admit(lock, "launch", ctx(0))),
    /lock ordering violation/,
  );
});
