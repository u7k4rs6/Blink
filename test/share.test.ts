/**
 * Share link tests.
 *
 * The cap, the TTL and the sweeper are the only things bounding snapshot storage,
 * because the budget guard cannot see it: ceilings are in sandbox-seconds and
 * browser-seconds, and a snapshot costs neither (V56). So these are tested the
 * way the expiry sweeper is, by making each one fire.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createShare, resolveShare, newShareToken, MemoryShareStore, ShareRefused,
} from "../src/share/service.ts";
import { MAX_LIVE_SHARE_SNAPSHOTS, sweepExpiredShares } from "../src/share/expiry.ts";

function adapterStub(over: { throws?: boolean } = {}) {
  let n = 0;
  return {
    calls: () => n,
    adapter: {
      async snapshot() {
        n += 1;
        if (over.throws) throw new Error("snapshot failed");
        return { value: `snap_${n}`, ms: 100 };
      },
    } as never,
  };
}

const deps = (store: MemoryShareStore, a = adapterStub()) => ({
  adapter: a.adapter, apiKey: "slr_live_test", store, sandbox: {}, appId: "gitea",
});

test("a share token is 16 random bytes and unguessable", () => {
  const a = newShareToken(), b = newShareToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 20, "a short token is a guessable token");
  assert.match(a, /^[A-Za-z0-9_-]+$/, "base64url, so it survives a URL unescaped");
});

test("creating a share snapshots the LIVE sandbox and mints a token", async () => {
  const store = new MemoryShareStore();
  const a = adapterStub();
  const r = await createShare(deps(store, a));
  assert.equal(a.calls(), 1);
  assert.equal(r.snapshotId, "snap_1");
  assert.ok(r.token);
  assert.equal(await store.liveCount(), 1);
});

test("the share expires 7 days out", async () => {
  const store = new MemoryShareStore();
  const r = await createShare({ ...deps(store), now: () => new Date("2026-09-04T10:00:00Z") });
  assert.equal(r.expiresAt, "2026-09-11T10:00:00.000Z");
});

test("the cap FIRES before the snapshot is taken, not after", async () => {
  // Refusing after paying for the storage is the worst of both. The check has
  // to come first, and this asserts the adapter was never called.
  const store = new MemoryShareStore();
  for (let i = 0; i < MAX_LIVE_SHARE_SNAPSHOTS; i += 1) {
    await store.put({ token: `t${i}`, snapshotId: `s${i}`, appId: "gitea", expiresAt: "2026-12-01T00:00:00Z" });
  }
  const a = adapterStub();
  await assert.rejects(
    () => createShare(deps(store, a)),
    (e: ShareRefused) => e.name === "ShareRefused" && e.reason === "cap_reached",
  );
  assert.equal(a.calls(), 0, "no snapshot may be taken once the cap is reached");
});

test("reaching the cap refuses rather than evicting somebody else's link", async () => {
  const store = new MemoryShareStore();
  for (let i = 0; i < MAX_LIVE_SHARE_SNAPSHOTS; i += 1) {
    await store.put({ token: `t${i}`, snapshotId: `s${i}`, appId: "gitea", expiresAt: "2026-12-01T00:00:00Z" });
  }
  await assert.rejects(() => createShare(deps(store)));
  const rows = await store.all();
  assert.equal(rows.filter((r) => r.deletedAt).length, 0, "nothing may be evicted to make room");
});

test("the cap lifts once the sweeper has actually deleted something", async () => {
  const store = new MemoryShareStore();
  for (let i = 0; i < MAX_LIVE_SHARE_SNAPSHOTS; i += 1) {
    await store.put({ token: `t${i}`, snapshotId: `s${i}`, appId: "gitea", expiresAt: "2026-09-01T00:00:00Z" });
  }
  const deleted: string[] = [];
  await sweepExpiredShares(store, async (id) => { deleted.push(id); }, new Date("2026-09-04T00:00:00Z"));
  assert.equal(deleted.length, MAX_LIVE_SHARE_SNAPSHOTS);
  const r = await createShare(deps(store));
  assert.ok(r.token, "a fresh share is possible once storage was really freed");
});

test("resolve distinguishes unknown, expired, deleted and reported", async () => {
  // "This link does not work" is the least useful thing a share page can say.
  const store = new MemoryShareStore();
  assert.deepEqual(await resolveShare(store, "nope"), { ok: false, reason: "unknown" });

  await store.put({ token: "old", snapshotId: "s", appId: "gitea", expiresAt: "2026-09-01T00:00:00Z" });
  assert.deepEqual(await resolveShare(store, "old", new Date("2026-09-04T00:00:00Z")), { ok: false, reason: "expired" });

  await store.put({ token: "gone", snapshotId: "s", appId: "gitea", expiresAt: "2026-12-01T00:00:00Z" });
  await store.markDeleted("gone", "2026-09-04T00:00:00Z");
  assert.deepEqual(await resolveShare(store, "gone"), { ok: false, reason: "deleted" });

  await store.put({ token: "bad", snapshotId: "s", appId: "gitea", expiresAt: "2026-12-01T00:00:00Z" });
  await store.report("bad");
  assert.deepEqual(await resolveShare(store, "bad"), { ok: false, reason: "reported" });
});

test("a reported share stops resolving immediately, not at the next sweep", async () => {
  const store = new MemoryShareStore();
  const r = await createShare(deps(store));
  assert.equal((await resolveShare(store, r.token)).ok, true);
  await store.report(r.token);
  const after = await resolveShare(store, r.token);
  assert.equal(after.ok, false);
  assert.equal(await store.liveCount(), 0, "a reported share also stops occupying a cap slot");
});

test("fork count is recorded, since it is the only signal a share is being used", async () => {
  const store = new MemoryShareStore();
  const r = await createShare(deps(store));
  await store.countFork(r.token);
  await store.countFork(r.token);
  const got = await resolveShare(store, r.token);
  assert.ok(got.ok);
  assert.equal(got.forkCount, 2);
});

test("a failed snapshot mints no token, so no link can point at nothing", async () => {
  const store = new MemoryShareStore();
  await assert.rejects(() => createShare(deps(store, adapterStub({ throws: true }))));
  assert.equal(await store.liveCount(), 0);
});
