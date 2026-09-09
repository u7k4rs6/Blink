/**
 * The lock that five sites needed.
 *
 * A race audit implemented five unwritten sites the obvious way and raced each
 * against its boundary. All five failed. These tests pin the primitive that
 * fixes them, and the granularity rules that decide whether a fix is a fix or a
 * bottleneck.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryScopeLock, SCOPE_KEYS } from "../src/concurrency/scope-lock.ts";

test("the same key serialises: the read-check-write race cannot occur", async () => {
  const lock = new MemoryScopeLock();
  let live = 1;
  const MAX = 2;
  const admit = () => lock.run(SCOPE_KEYS.sandboxSlot(), async () => {
    const n = live;
    await new Promise((r) => setTimeout(r, 0));
    if (n >= MAX) return false;
    await new Promise((r) => setTimeout(r, 0));
    live += 1;
    return true;
  });
  const r = await Promise.all([admit(), admit(), admit()]);
  assert.equal(r.filter(Boolean).length, 1, "only one launch fits under the cap");
  assert.equal(live, 2, "the hard cap of 2 must not be exceeded");
});

test("different keys do not block each other", async () => {
  const lock = new MemoryScopeLock();
  const order: string[] = [];
  const work = (tag: string, ms: number) => async () => {
    order.push(`${tag}:start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${tag}:end`);
  };
  await Promise.all([
    lock.run(SCOPE_KEYS.warmForkClaim("gitea"), work("gitea", 20)),
    lock.run(SCOPE_KEYS.warmForkClaim("jaeger"), work("jaeger", 1)),
  ]);
  assert.equal(order[0], "gitea:start");
  assert.equal(order[1], "jaeger:start", "two apps must launch in parallel, or the site serialises");
});

test("a thrown error releases the lock instead of poisoning the queue", async () => {
  const lock = new MemoryScopeLock();
  await assert.rejects(() => lock.run("k", async () => { throw new Error("boom"); }));
  assert.equal(await lock.run("k", async () => "ok"), "ok");
});

test("claim and promote share a key on purpose, since they consume one resource", () => {
  assert.equal(SCOPE_KEYS.warmForkClaim("gitea"), SCOPE_KEYS.queuePromote("gitea"));
});

test("the two global caps do NOT share a key, so a Share click never queues behind a launch", () => {
  assert.notEqual(SCOPE_KEYS.sandboxSlot(), SCOPE_KEYS.shareSnapshotCap());
});

test("the per-IP key includes the day, so midnight rollover cannot contend", () => {
  assert.notEqual(SCOPE_KEYS.ipDailyCount("2026-09-04", "ip_a"), SCOPE_KEYS.ipDailyCount("2026-09-05", "ip_a"));
  assert.notEqual(SCOPE_KEYS.ipDailyCount("2026-09-04", "ip_a"), SCOPE_KEYS.ipDailyCount("2026-09-04", "ip_b"));
});

test("a burst on one key admits exactly the number that fits", async () => {
  const lock = new MemoryScopeLock();
  let count = 4;
  const MAX = 5;
  const launch = () => lock.run(SCOPE_KEYS.ipDailyCount("2026-09-04", "ip_a"), async () => {
    const n = count;
    await new Promise((r) => setTimeout(r, 0));
    if (n >= MAX) return false;
    count = n + 1;
    return true;
  });
  const r = await Promise.all(Array.from({ length: 6 }, launch));
  assert.equal(r.filter(Boolean).length, 1, "a visitor at 4 of 5 gets exactly one more launch");
  assert.equal(count, 5);
});

// ---------------------------------------------------------------------------
// The layered lock, and the reason it exists.
// ---------------------------------------------------------------------------

import { LayeredScopeLock, type ScopeLock } from "../src/concurrency/scope-lock.ts";

/** Counts how many callers the remote layer actually sees. */
class CountingLock implements ScopeLock {
  concurrent = 0;
  maxConcurrent = 0;
  calls = 0;
  async run<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    this.calls += 1;
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try { return await fn(); } finally { this.concurrent -= 1; }
  }
}

test("the memory layer means the remote lock never sees concurrency", async () => {
  // This is the whole point: PostgresScopeLock is only correct with one caller
  // per connection, so it must never be handed two at once.
  const remote = new CountingLock();
  const lock = new LayeredScopeLock({ remote, bypassMemory: false });
  await Promise.all(Array.from({ length: 8 }, () =>
    lock.run("k", async () => { await new Promise((r) => setTimeout(r, 5)); })));
  assert.equal(remote.calls, 8, "every call still reaches the remote lock");
  assert.equal(remote.maxConcurrent, 1, "but never more than one at a time");
});

test("bypassMemory sends callers straight at the remote lock, on purpose", async () => {
  // So the cross-process path can be put under real concurrency deliberately,
  // rather than rotting unexercised until the day D11 stops being one process.
  const remote = new CountingLock();
  const lock = new LayeredScopeLock({ remote, bypassMemory: true });
  await Promise.all(Array.from({ length: 4 }, () =>
    lock.run("k", async () => { await new Promise((r) => setTimeout(r, 10)); })));
  assert.equal(remote.calls, 4);
  assert.ok(remote.maxConcurrent > 1, "bypass must actually expose the remote lock to contention");
});

test("bypassMemory without a remote lock fails loudly rather than silently unlocking", async () => {
  const lock = new LayeredScopeLock({ remote: null, bypassMemory: true });
  await assert.rejects(() => lock.run("k", async () => 1), /no remote lock is configured/);
});

test("with no remote lock configured, the memory lock still excludes", async () => {
  const lock = new LayeredScopeLock({});
  let live = 0, max = 0;
  await Promise.all(Array.from({ length: 5 }, () => lock.run("k", async () => {
    live += 1; max = Math.max(max, live);
    await new Promise((r) => setTimeout(r, 3));
    live -= 1;
  })));
  assert.equal(max, 1);
});

// ---------------------------------------------------------------------------
// Lock ordering, enforced rather than documented.
//
// The rule was a comment for one day. A comment is enforced by whoever remembers
// to read it, and this week produced four bugs that got past someone who knew
// the right answer.
// ---------------------------------------------------------------------------

import { LockOrderViolation, currentlyHeldKeys, keyRank } from "../src/concurrency/scope-lock.ts";

test("resource keys rank before billing keys", () => {
  assert.equal(keyRank(SCOPE_KEYS.warmForkClaim("gitea")).rank, 1);
  assert.equal(keyRank(SCOPE_KEYS.sandboxSlot()).rank, 1);
  assert.equal(keyRank(SCOPE_KEYS.shareSnapshotCap()).rank, 1);
  assert.equal(keyRank(SCOPE_KEYS.ipDailyCount("2026-09-04", "ip_a")).rank, 1);
  assert.equal(keyRank(SCOPE_KEYS.billingScope("2026-09-04", "global", "*")).rank, 2);
});

test("an unrecognised key is treated as late-ordered, which is the safe default", () => {
  // So taking a KNOWN resource key after it is caught rather than waved through.
  assert.equal(keyRank("something_nobody_classified").rank, 2);
});

test("resource then billing is legal: that is what promotion does", async () => {
  const lock = new MemoryScopeLock();
  const seen: string[] = [];
  await lock.run(SCOPE_KEYS.warmForkClaim("gitea"), async () => {
    seen.push(...currentlyHeldKeys());
    await lock.run(SCOPE_KEYS.billingScope("2026-09-04", "global", "*"), async () => {
      seen.push(...currentlyHeldKeys());
    });
  });
  assert.equal(seen.length, 3, "the inner call sees both keys held");
});

test("billing then resource THROWS, instead of deadlocking under load", async () => {
  const lock = new MemoryScopeLock();
  await assert.rejects(
    () => lock.run(SCOPE_KEYS.billingScope("2026-09-04", "global", "*"), async () =>
      lock.run(SCOPE_KEYS.sandboxSlot(), async () => "should never run")),
    LockOrderViolation,
  );
});

test("the violation names both keys and points at the rank table, not the call site", async () => {
  const lock = new MemoryScopeLock();
  try {
    await lock.run(SCOPE_KEYS.billingScope("2026-09-04", "ip", "a"), async () =>
      lock.run(SCOPE_KEYS.warmForkClaim("gitea"), async () => 1));
    assert.fail("should have thrown");
  } catch (e) {
    const m = (e as Error).message;
    assert.match(m, /warm_claim\|gitea/);
    assert.match(m, /ascending rank/);
    assert.match(m, /the rank table is the thing to change, not this call site/);
  }
});

test("two resource keys at the same rank are allowed", async () => {
  // Same rank is not an ordering violation. Deadlock between equals is a
  // separate concern, and no path here holds two resource keys today.
  const lock = new MemoryScopeLock();
  await assert.doesNotReject(() =>
    lock.run(SCOPE_KEYS.warmForkClaim("gitea"), async () =>
      lock.run(SCOPE_KEYS.sandboxSlot(), async () => "ok")));
});

test("held keys are released when the body returns", async () => {
  const lock = new MemoryScopeLock();
  await lock.run(SCOPE_KEYS.warmForkClaim("gitea"), async () => {
    assert.equal(currentlyHeldKeys().length, 1);
  });
  assert.equal(currentlyHeldKeys().length, 0);
});

test("a nested acquisition holds BOTH keys, it does not release the outer one", async () => {
  // Probed against the real database: nesting used to issue BEGIN inside BEGIN,
  // and the inner COMMIT ended the outer transaction, releasing the outer
  // advisory lock while the outer body was still running. That is the promotion
  // shape exactly: resource lock outside, billing lock inside.
  const lock = new MemoryScopeLock();
  let innerHeld: string[] = [];
  await lock.run(SCOPE_KEYS.warmForkClaim("gitea"), async () => {
    await lock.run(SCOPE_KEYS.billingScope("2026-09-04", "global", "*"), async () => {
      innerHeld = currentlyHeldKeys();
    });
  });
  assert.equal(innerHeld.length, 2, "both keys must be held for the inner body");
  assert.ok(innerHeld.includes(SCOPE_KEYS.warmForkClaim("gitea")), "the outer key must not be released early");
});
