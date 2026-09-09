/**
 * Queue tests.
 *
 * The queue's job is fairness and honesty: the head goes first, and the estimate
 * shown is one the visitor will not feel lied to about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { QueueManager } from "../src/queue/manager.ts";
import { ABANDON_AFTER_MS, MIN_ESTIMATE_S } from "../src/queue/promotion.ts";

const allow = {
  readyForkCount: async () => 0,
  freeColdSlots: async () => 1,
  wouldPassCeilings: async () => true,
  launchesEnabled: async () => true,
};

test("the head of the queue goes first, regardless of who asks", async () => {
  const q = new QueueManager();
  const first = q.enqueue("gitea", "sess-a");
  q.enqueue("gitea", "sess-b");
  const p = await q.nextPromotable("gitea", allow);
  assert.equal(p!.entry.id, first.id, "a later arrival must not overtake");
});

test("position and estimate reflect the line, and never promise too little", async () => {
  const q = new QueueManager();
  q.enqueue("gitea", "a");
  const second = q.enqueue("gitea", "b");
  const pos = q.positionOf(second.id)!;
  assert.equal(pos.ahead, 1);
  assert.ok(pos.estimateSeconds >= MIN_ESTIMATE_S,
    "an estimate of a few seconds that is then missed reads as broken");
});

test("a stale entry is abandoned, so it stops holding a place", async () => {
  // Somebody who waited five minutes has almost certainly closed the tab, and
  // holding their place penalises the people still there.
  let t = 1_000_000;
  const q = new QueueManager(() => t);
  const a = q.enqueue("gitea", "gone");
  const b = q.enqueue("gitea", "here");
  assert.equal(q.depth("gitea"), 2);

  t += ABANDON_AFTER_MS + 1;
  // enqueue reaps first, so the two stale entries are dropped by this call and
  // a later explicit reap() correctly finds nothing left to do.
  const newest = q.enqueue("gitea", "newest");
  assert.equal(q.depth("gitea"), 1, "both stale entries must be gone");
  assert.deepEqual(q.reap(), [], "reaping twice must not double-count");

  const p = await q.nextPromotable("gitea", allow);
  assert.equal(p!.entry.id, newest.id, "the survivor is promoted, not the abandoned head");
  assert.equal(q.positionOf(a.id)!.state, "abandoned");
  assert.equal(q.positionOf(b.id)!.state, "abandoned");
});

test("promotion is refused when launches are disabled, before anything else", async () => {
  // The drift trip disables launches. The queue must respect that rather than
  // promoting into a system that has stopped accepting work.
  const q = new QueueManager();
  q.enqueue("gitea", "a");
  const p = await q.nextPromotable("gitea", { ...allow, launchesEnabled: async () => false });
  assert.equal(p, null);
});

test("promotion is refused when a ceiling would be breached", async () => {
  const q = new QueueManager();
  q.enqueue("gitea", "a");
  assert.equal(await q.nextPromotable("gitea", { ...allow, wouldPassCeilings: async () => false }), null);
});

test("promotion is refused with no capacity, and granted when a slot frees", async () => {
  const q = new QueueManager();
  q.enqueue("gitea", "a");
  assert.equal(await q.nextPromotable("gitea", { ...allow, freeColdSlots: async () => 0 }), null);
  assert.ok(await q.nextPromotable("gitea", allow));
});

test("a warm fork is preferred over a cold slot", async () => {
  const q = new QueueManager();
  q.enqueue("gitea", "a");
  const p = await q.nextPromotable("gitea", { ...allow, readyForkCount: async () => 1 });
  assert.equal(p!.path, "warm");
});

test("queues are per app, so a busy app does not block a quiet one", async () => {
  const q = new QueueManager();
  q.enqueue("gitea", "a");
  const j = q.enqueue("jaeger", "b");
  const p = await q.nextPromotable("jaeger", allow);
  assert.equal(p!.entry.id, j.id);
  assert.equal(q.depth("gitea"), 1);
});

test("only the holder of an entry can leave it", () => {
  // Otherwise anyone who guessed an id could evict somebody from the queue.
  const q = new QueueManager();
  const a = q.enqueue("gitea", "sess-a");
  assert.equal(q.leave(a.id, "sess-b"), false, "a different session must not be able to remove it");
  assert.equal(q.leave(a.id, "sess-a"), true);
  assert.equal(q.depth("gitea"), 0);
});

test("a promoted entry leaves the waiting line", async () => {
  const q = new QueueManager();
  const a = q.enqueue("gitea", "a");
  q.markPromoted(a.id);
  assert.equal(q.depth("gitea"), 0);
  assert.equal(await q.nextPromotable("gitea", allow), null);
});

test("the estimate follows observed launch times", () => {
  const q = new QueueManager();
  for (let i = 0; i < 40; i += 1) q.observeLaunchSeconds(120);
  q.enqueue("gitea", "a");
  const second = q.enqueue("gitea", "b");
  assert.ok(q.positionOf(second.id)!.estimateSeconds > MIN_ESTIMATE_S,
    "a slow system must show a longer wait, not a comforting constant");
});
