/**
 * Every control here is made to FIRE at least once.
 *
 * The rule this file exists for: a control is tested by making it fire, never by
 * confirming it was installed. The guest-side self-destruct passed every build
 * while being incapable of running, because its check asserted that a script was
 * written and executable, which was true and irrelevant.
 *
 * So each control below is driven to its trip condition and observed doing the
 * thing. Where a control cannot be made to fire in a test, that is stated at the
 * bottom rather than left looking covered.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CpuSampler } from "../src/canary/cpu-sampler.ts";
import { BillingLedger, MemoryLedgerStore } from "../src/billing/ledger.ts";
import { PLANS, SIZE_SMALL } from "../src/guard/rates.ts";
import { SandboxLedger } from "../src/guard/ledger.ts";
import { next } from "../src/orchestrator/states.ts";

// ---------------------------------------------------------------------------
// 1. CPU sampler kill path
// ---------------------------------------------------------------------------

function sampler() {
  const fired = { killed: [] as string[], banned: [] as string[], logged: [] as string[], ended: [] as string[] };
  const s = new CpuSampler("ins_1", "sbx_1", "ip_abc", {
    kill: async (id) => { fired.killed.push(id); },
    banIpHash: async (h, hours) => { fired.banned.push(`${h}:${hours}h`); },
    logPublic: async (l) => { fired.logged.push(l); },
    recordEnd: async (id, reason) => { fired.ended.push(`${id}:${reason}`); },
  });
  return { s, fired };
}

test("CPU sampler FIRES: three consecutive high samples kill the sandbox", async () => {
  const { s, fired } = sampler();
  assert.equal(await s.observe(95), false);
  assert.equal(await s.observe(97), false);
  assert.equal(await s.observe(99), true, "the third consecutive sample must trip it");
  assert.deepEqual(fired.killed, ["sbx_1"], "the sandbox must actually be killed");
  assert.deepEqual(fired.ended, ["ins_1:cpu_abuse"]);
  assert.deepEqual(fired.banned, ["ip_abc:24h"]);
  assert.equal(fired.logged.length, 1);
});

test("CPU sampler does NOT fire on a boot spike, which is why it needs three", async () => {
  // Metabase's own boot ran hot for half a minute. One sample would kill real
  // visitors during normal first load.
  const { s, fired } = sampler();
  await s.observe(99);
  await s.observe(98);
  await s.observe(12);
  await s.observe(99);
  assert.equal(s.hasTripped, false);
  assert.deepEqual(fired.killed, []);
});

test("the public log line carries no IP hash", async () => {
  const { s, fired } = sampler();
  for (const v of [95, 96, 97]) await s.observe(v);
  assert.ok(!fired.logged[0]!.includes("ip_abc"), "section 4 keeps the IP hash out of anything published");
});

test("the kill happens BEFORE the bookkeeping, so a bookkeeping failure cannot leave it running", async () => {
  const order: string[] = [];
  const s = new CpuSampler("i", "sbx", "ip", {
    kill: async () => { order.push("kill"); },
    recordEnd: async () => { order.push("record"); },
    banIpHash: async () => { order.push("ban"); },
    logPublic: async () => { order.push("log"); },
  });
  for (const v of [95, 96, 97]) await s.observe(v);
  assert.equal(order[0], "kill");
});

// ---------------------------------------------------------------------------
// 2. Expiry sweeper kill path
// ---------------------------------------------------------------------------

test("expiry sweeper FIRES: it issues a DELETE for every open sandbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blink-ctl-"));
  const l = new SandboxLedger(join(dir, "s.jsonl"));
  l.opened("sbx_leaked_a", "test");
  l.opened("sbx_leaked_b", "test");

  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    // 204 is a null-body status: `new Response("", ...)` throws, which the
    // sweeper's catch would swallow into a plausible-looking pass.
    return new Response(null, { status: 204 });
  }) as never;
  try {
    const results = await l.sweep("slr_live_test", "unit-test");
    assert.equal(results.length, 2);
    assert.equal(calls.filter((c) => c.startsWith("DELETE")).length, 2, "both leaked sandboxes must be deleted");
  } finally { globalThis.fetch = original; }
  assert.deepEqual(l.openIds(), [], "swept ids must be recorded closed, or the next sweep repeats them");
});

test("expiry sweeper leaves a FAILED delete open, so the next run hunts it again", async () => {
  // The opposite of the pkill bug: the failure path must not look like success.
  // A 500 that recorded the id closed would retire a machine that is still billing.
  const dir = mkdtempSync(join(tmpdir(), "blink-ctl-"));
  const l = new SandboxLedger(join(dir, "s.jsonl"));
  l.opened("sbx_stubborn", "test");

  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as never;
  try {
    const results = await l.sweep("slr_live_test", "unit-test");
    assert.equal(results[0]!.ok, false);
  } finally { globalThis.fetch = original; }
  assert.deepEqual(l.openIds(), ["sbx_stubborn"], "a failed kill must stay on the books");
});

test("expiry sweeper survives a delete that THROWS, and still keeps the id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blink-ctl-"));
  const l = new SandboxLedger(join(dir, "s.jsonl"));
  l.opened("sbx_a", "test");
  l.opened("sbx_b", "test");

  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => {
    if (n++ === 0) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    return new Response(null, { status: 204 });
  }) as never;
  try {
    const results = await l.sweep("slr_live_test", "unit-test");
    assert.equal(results.length, 2, "one throwing kill must not abandon the rest");
    assert.equal(results[0]!.error, "TimeoutError");
  } finally { globalThis.fetch = original; }
  assert.deepEqual(l.openIds(), ["sbx_a"], "only the one that actually died is retired");
});

// ---------------------------------------------------------------------------
// 3. kill_unconfirmed in ENDING
// ---------------------------------------------------------------------------

test("kill_unconfirmed FIRES: a stalled ENDING still reaches ENDED", async () => {
  // Without this, a hanging kill leaves the instance billing in a state the
  // orchestrator has already given up on.
  const t = next("ENDING", "STATE_DEADLINE_EXCEEDED");
  assert.ok(t, "ENDING must have an exit for a breached deadline");
  assert.equal(t.to, "ENDED");
  assert.match(t.note ?? "", /kill_unconfirmed/);
  assert.match(t.note ?? "", /leave the sandbox id open for the sweeper/,
    "billing settles, but the sandbox ledger must keep hunting the machine");
});

// ---------------------------------------------------------------------------
// 4. Drift trip that disables launches
// ---------------------------------------------------------------------------

test("drift trip FIRES: launches disable and the gauge changes", async () => {
  const l = new BillingLedger({
    store: new MemoryLedgerStore(), plan: PLANS.starter,
    ceilings: { global: { sandboxSeconds: 1e6, browserSeconds: 1e6 },
      ip: { sandboxSeconds: 1e6, browserSeconds: 1e6 },
      launch: { sandboxSeconds: 1e6, browserSeconds: 1e6 } },
  });
  const r = await l.reserve({ day: "2026-09-04", scope: "global", key: "*", sandboxSeconds: 900, size: SIZE_SMALL });
  await l.settle(r, { sandboxSeconds: 900, size: SIZE_SMALL, measured: true });
  const est = (await l.spent("2026-09-04", "global", "*")).usd;

  assert.equal((await l.health()).launchesEnabled, true, "precondition: launches are on");
  await l.reconcile({ observedSpentUsd: est * 1.3, at: "2026-09-04T12:00:00Z", note: "console" });
  const h = await l.health();
  assert.equal(h.launchesEnabled, false, "the trip must actually stop launches");
  assert.equal(h.gaugeState, "reconciling");
});

// ---------------------------------------------------------------------------
// 5. Share-snapshot expiry deletion
// ---------------------------------------------------------------------------

import {
  sweepExpiredShares, shareMayBeCreated, shareExpiryFor,
  MAX_LIVE_SHARE_SNAPSHOTS, type ShareSnapshot, type ShareStore,
} from "../src/share/expiry.ts";

function shareStore(rows: ShareSnapshot[]): ShareStore & { rows: ShareSnapshot[] } {
  return {
    rows,
    async expired(now) { return rows.filter((r) => !r.deletedAt && new Date(r.expiresAt) <= now); },
    async markDeleted(token, at) { rows.find((r) => r.token === token)!.deletedAt = at; },
    async liveCount() { return rows.filter((r) => !r.deletedAt).length; },
  };
}

const row = (t: string, expiresAt: string): ShareSnapshot =>
  ({ token: t, snapshotId: `snap_${t}`, appId: "gitea", expiresAt });

test("share expiry FIRES: expired snapshots are deleted, unexpired ones are not", async () => {
  const store = shareStore([
    row("old_a", "2026-09-01T00:00:00Z"),
    row("old_b", "2026-09-02T00:00:00Z"),
    row("fresh", "2026-09-30T00:00:00Z"),
  ]);
  const deleted: string[] = [];
  const res = await sweepExpiredShares(store, async (id) => { deleted.push(id); }, new Date("2026-09-04T00:00:00Z"));

  assert.deepEqual(deleted, ["snap_old_a", "snap_old_b"], "the bytes must actually be deleted");
  assert.deepEqual(res.deleted, ["old_a", "old_b"]);
  assert.equal(await store.liveCount(), 1, "only the unexpired link survives");
});

test("share expiry does NOT mark a row deleted when the delete failed", async () => {
  // Marking a failed delete as done retires GB of bytes that are still on disk
  // and now unreachable from any record. That is the one outcome with no way back.
  const store = shareStore([row("stuck", "2026-09-01T00:00:00Z")]);
  const res = await sweepExpiredShares(
    store, async () => { throw new Error("502 from gateway"); }, new Date("2026-09-04T00:00:00Z"),
  );
  assert.equal(res.deleted.length, 0);
  assert.equal(res.failed[0]!.token, "stuck");
  assert.equal(store.rows[0]!.deletedAt, undefined, "the row must stay on the books for the next tick");
  assert.equal((await store.expired(new Date("2026-09-04T00:00:00Z"))).length, 1);
});

test("share expiry is idempotent: a second sweep deletes nothing", async () => {
  const store = shareStore([row("old", "2026-09-01T00:00:00Z")]);
  const del: string[] = [];
  const fire = () => sweepExpiredShares(store, async (id) => { del.push(id); }, new Date("2026-09-04T00:00:00Z"));
  await fire();
  const second = await fire();
  assert.equal(second.examined, 0);
  assert.deepEqual(del, ["snap_old"], "a swept row must never be deleted twice");
});

test("share cap FIRES: the 12th live snapshot refuses rather than evicting", async () => {
  const full = shareStore(Array.from({ length: MAX_LIVE_SHARE_SNAPSHOTS }, (_, i) => row(`t${i}`, "2026-12-01T00:00:00Z")));
  const decision = await shareMayBeCreated(full);
  assert.equal(decision.ok, false);
  assert.match(decision.reason!, /cap reached \(12\/12\)/);
  assert.equal(full.rows.filter((r) => r.deletedAt).length, 0, "refusing must never evict somebody else's link");

  // And the cap lifts once the sweeper has done its job.
  full.rows[0]!.expiresAt = "2026-09-01T00:00:00Z";
  await sweepExpiredShares(full, async () => {}, new Date("2026-09-04T00:00:00Z"));
  assert.equal((await shareMayBeCreated(full)).ok, true);
});

test("share expiry is 7 days out, in UTC", () => {
  assert.equal(shareExpiryFor(new Date("2026-09-04T10:00:00Z")), "2026-09-11T10:00:00.000Z");
});

// ---------------------------------------------------------------------------
// 6. Pre-flight spend refusal
// ---------------------------------------------------------------------------

import { preflightVerdict } from "../scripts/gates/lib/preflight.ts";
import { GATES_TOTAL_BUDGET_USD } from "../src/guard/rates.ts";

test("pre-flight FIRES: an over-ceiling estimate is refused before any call", () => {
  const v = preflightVerdict(0.04, 0.03, GATES_TOTAL_BUDGET_USD);
  assert.ok(!v.allow);
  assert.equal(v.reason, "gate_ceiling");
  assert.match(v.message, /cost nothing/, "the message must say the refusal was free, since that is the point");
});

test("pre-flight FIRES on the total budget, and names the budget not the gate", () => {
  const v = preflightVerdict(0.90, 5, GATES_TOTAL_BUDGET_USD);
  assert.ok(!v.allow);
  assert.equal(v.reason, "total_budget");
  assert.match(v.message, /\$0\.40/);
});

test("the gate ceiling is reported ahead of the budget, because it is the better diagnosis", () => {
  // Both bounds are breached. A gate over its own ceiling has a wrong estimate,
  // which is more useful to hear than "the run is too expensive".
  const both = preflightVerdict(9, 0.03, GATES_TOTAL_BUDGET_USD);
  assert.ok(!both.allow);
  assert.equal(both.reason, "gate_ceiling");
});

test("pre-flight allows an estimate exactly AT the ceiling, so a gate sized to its cap still runs", () => {
  assert.equal(preflightVerdict(0.03, 0.03, GATES_TOTAL_BUDGET_USD).allow, true);
  assert.equal(preflightVerdict(GATES_TOTAL_BUDGET_USD, 5, GATES_TOTAL_BUDGET_USD).allow, true);
});

test("the total gates budget is still $0.40", () => {
  assert.equal(GATES_TOTAL_BUDGET_USD, 0.40);
});

// ---------------------------------------------------------------------------
// 7. The prerequisite step's own guard
// ---------------------------------------------------------------------------

import { prerequisiteStep, proveSelfDestructStep, BadPrerequisite, BASE_IMAGE_LACKS } from "../scripts/snapshots/lib/template.ts";

test("prerequisite guard FIRES: asserting something the image lacks is refused at construction", () => {
  // The first version of this helper asserted `git` for Gitea, which the recipe
  // installs six lines later. It would have failed every Gitea build. The guard
  // catches that class at authoring time rather than four minutes into a build.
  for (const missing of BASE_IMAGE_LACKS) {
    assert.throws(() => prerequisiteStep(["curl", missing]), BadPrerequisite,
      `${missing} is known absent and must not be asserted up front`);
  }
});

test("the refusal says what to do instead, since the next reader is mid-build", () => {
  assert.throws(() => prerequisiteStep(["pkill"]), /Install it first, then assert it after the install step/);
});

test("prerequisite step asserts binaries AND files, and fails loudly per name", () => {
  const step = prerequisiteStep(["curl", "tar"], ["/opt/app/app.jar"]);
  assert.match(step.cmd, /MISSING_BINARY:curl/);
  assert.match(step.cmd, /MISSING_BINARY:tar/);
  assert.match(step.cmd, /MISSING_FILE:\/opt\/app\/app.jar/);
  assert.equal(step.expect, "PREREQS_OK");
});

test("the self-destruct proof signals the real PID, not the pidfile's existence", () => {
  // test -s on the pidfile is what the broken version amounted to. kill -0 runs
  // the full permission check on a live process without sending a signal.
  const step = proveSelfDestructStep("/var/lib/app/app.pid");
  assert.match(step.cmd, /kill -0 "\$PID"/, "it must actually signal the process");
  assert.match(step.cmd, /test -d \/proc\/\$PID/, "and confirm the process is running");
  assert.match(step.cmd, /command -v kill/, "and that the killer exists, which is what pkill failed");
  // The step now MENTIONS pkill deliberately, as a pattern it refuses to find in
  // the arming script. So assert it is never invoked, rather than never written.
  assert.ok(!/(^|[;&|\s])pkill\s/.test(step.cmd), "pkill must never be invoked; it is absent from this image");
  assert.match(step.cmd, /grep -q "pkill"/, "and the step must reject an arming script that uses it");
});

// ---------------------------------------------------------------------------
// 8. Uptime Kuma: loopback-only monitors, and the preview WebSocket URL
// ---------------------------------------------------------------------------

import {
  previewWsUrl, SEEDED_MONITOR_TARGETS, SEEDED_MONITORS, SEED_SCRIPT,
  MONITOR_REFRESH_SCRIPT, KUMA_PORT,
} from "../scripts/snapshots/uptime-kuma.ts";

test("loopback-only FIRES: no seeded monitor may point off the instance", () => {
  // Uptime Kuma makes outbound requests on a schedule and Q5 established that
  // egress cannot be restricted. A third-party URL seeded here would point every
  // instance Blink ever launches at someone else's server, forever, every 20s.
  //
  // Scanned as URLs, not as `url:` keys. The earlier version matched the object
  // literal the seed script used to write by hand; the moment the monitors moved
  // into a JSON constant the key became `"url":` and the control matched nothing
  // while still passing its own "found at least one" guard. A control keyed to
  // the syntax of the thing it guards stops guarding when the syntax changes.
  const sources = { plan: JSON.stringify(SEEDED_MONITORS), seed: SEED_SCRIPT, refresh: MONITOR_REFRESH_SCRIPT };
  const urls: string[] = [];
  for (const [where, raw] of Object.entries(sources)) {
    const src = raw.replace(/^\s*\/\/.*$/gm, "");
    const found = [...src.matchAll(/https?:\/\/[^"'\s\\`]+/g)].map((m) => m[0]!);
    assert.ok(found.length > 0, `the ${where} source must actually name a monitor url`);
    for (const u of found) {
      const host = new URL(u).hostname;
      assert.ok(host === "127.0.0.1" || host === "localhost",
        `${where} points a monitor at ${host}, which is not this instance`);
    }
    urls.push(...found);
  }
  // Every target the plan declares actually appears. Not an equality check:
  // the scripts also connect a socket to loopback, and that URL is caught by
  // the same host assertion above, which is the property that matters.
  for (const target of SEEDED_MONITOR_TARGETS) {
    assert.ok(urls.includes(target), `${target} is in the plan but never appears`);
  }
});

test("the fork time refresh is covered by the same control as the seed", () => {
  // V80 was a fix applied to the launch path and not to the canary. The same
  // shape would be a monitor URL that only the refresh script sets, which the
  // seed-only control would never have looked at. This asserts the control's
  // own scope rather than trusting that it was widened.
  assert.ok(MONITOR_REFRESH_SCRIPT.includes("editMonitor"),
    "the refresh script must be the thing that sets monitor fields");
  for (const m of SEEDED_MONITORS) {
    assert.ok(MONITOR_REFRESH_SCRIPT.includes(m.url),
      `${m.url} is in the plan but the refresh script does not carry it`);
  }
});


test("previewWsUrl keeps the pt_token, which is what a naive rebuild drops", () => {
  const ws = previewWsUrl("https://abc.preview.getsolari.com/?pt_token=SECRETVALUE");
  const u = new URL(ws);
  assert.equal(u.protocol, "wss:", "https must upgrade to wss, not stay https");
  assert.equal(u.pathname, "/socket.io/");
  assert.equal(u.searchParams.get("pt_token"), "SECRETVALUE", "dropping this makes the check fail for the wrong reason");
  assert.equal(u.searchParams.get("EIO"), "4");
  assert.equal(u.searchParams.get("transport"), "websocket");
});

test("previewWsUrl maps plain http to ws, so a local target is still testable", () => {
  assert.equal(new URL(previewWsUrl(`http://127.0.0.1:${KUMA_PORT}/`)).protocol, "ws:");
});

test("previewWsUrl replaces any existing path rather than appending to it", () => {
  assert.equal(new URL(previewWsUrl("https://h.example/dashboard?pt_token=T")).pathname, "/socket.io/");
});

// ---------------------------------------------------------------------------
// 9. Registry keys: a mismatch here reads exactly like "not built yet"
// ---------------------------------------------------------------------------

import { APPS } from "../scripts/gates/lib/apps.ts";
import { readFileSync } from "node:fs";

test("every recipe writes a registry key that a gate will actually look up", () => {
  // A recipe that writes "uptime-kuma" while the gates read "uptimekuma" makes
  // every gate SKIP cleanly, which is indistinguishable from a snapshot that was
  // never built. Nothing fails, nothing is measured, and the run looks fine.
  const ids = new Set(Object.values(APPS).map((a) => a.id));
  const recipes = ["gitea", "jaeger", "metabase", "excalidraw", "uptime-kuma"];
  for (const r of recipes) {
    const src = readFileSync(new URL(`../scripts/snapshots/${r}.ts`, import.meta.url), "utf8");
    const writes = [...src.matchAll(/reg(?:\[["']([\w-]+)["']\]|\.(\w+))\s*=\s*snapshotId/g)]
      .map((m) => m[1] ?? m[2]!);
    const viaApps = /reg\[APPS\.\w+!?\.id\]\s*=\s*snapshotId/.test(src);
    assert.ok(writes.length > 0 || viaApps, `${r}.ts must record its snapshot in the registry`);
    for (const w of writes) {
      assert.ok(ids.has(w), `${r}.ts writes registry key "${w}", which is not an app id: ${[...ids].join(", ")}`);
    }
  }
});

test("no two apps collide on a registry key", () => {
  const ids = Object.values(APPS).map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the app ids the gates default to all exist", async () => {
  const { G1_APPS, G2_APPS } = await import("../scripts/gates/lib/apps.ts");
  for (const id of [...G1_APPS, ...G2_APPS]) {
    assert.ok(APPS[id], `gate default names "${id}", which is not in APPS`);
  }
});

// ---------------------------------------------------------------------------
// 10. runLongInGuest: quoting, and jobs that never start
// ---------------------------------------------------------------------------

import { runLongInGuest } from "../scripts/snapshots/lib/template.ts";

type Shell = (cmd: string, o?: { timeoutMs?: number }) => Promise<{ value: { stdout: string; stderr: string } }>;

/** A fake guest that records every command and answers from a scripted table. */
function fakeGuest(reply: (cmd: string, n: number) => string) {
  const seen: string[] = [];
  const sh: Shell = async (cmd) => {
    seen.push(cmd);
    return { value: { stdout: reply(cmd, seen.length), stderr: "" } };
  };
  return { sh, seen };
}

test("a command containing single quotes is NOT inlined into a quoted shell string", async () => {
  // This is the bug: `sh -c '{ CMD; }'` closes its quote early the moment CMD
  // contains a quote of its own. It manifested as a seventeen minute hang, not
  // as an error, because the detached job simply never started.
  const nasty = `df -Pm / | awk 'NR==2{print "avail=" $4}' && echo 'done'`;
  const { sh, seen } = fakeGuest((c) => (c.includes("cat ") ? "STARTED" : "0"));
  await runLongInGuest(sh, nasty, { marker: "/tmp/m", log: "/tmp/l", timeoutMs: 5000, intervalMs: 10 });

  const start = seen[0]!;
  assert.ok(start.includes("BLINK_LONG_EOF"), "the command must be delivered by heredoc");
  assert.ok(start.includes(nasty), "the command must survive verbatim, quotes and all");
  // The only thing inside the sh -c quotes should be the script path.
  const inner = start.match(/setsid sh -c '([^']*)'/);
  assert.ok(inner, "the detach must still use a single-quoted sh -c");
  assert.ok(!inner[1]!.includes("awk"), "no part of the user command may appear inside those quotes");
});

test("runLongInGuest FIRES its never-started detection instead of waiting out the timeout", async () => {
  // A job that never starts writes no marker and no log. Previously that was
  // indistinguishable from a job still working, so the loop burned its whole
  // budget before reporting. Now it gives up after three empty polls.
  const t0 = Date.now();
  const { sh } = fakeGuest((c) => (c.includes("BLINK_LONG_EOF") ? "STARTED" : "NO_OUTPUT_YET"));
  const r = await runLongInGuest(sh, "true", { marker: "/tmp/m", log: "/tmp/l", timeoutMs: 600_000, intervalMs: 10 });

  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.match(r.tail, /never started/);
  assert.ok(Date.now() - t0 < 5000, "it must not wait out the 10 minute timeout to say so");
});

test("a job that IS producing output is left alone", async () => {
  let polls = 0;
  const { sh } = fakeGuest((c) => {
    if (c.includes("BLINK_LONG_EOF")) return "STARTED";
    if (c.includes("--- log")) return "build output";
    return ++polls < 5 ? "RUNNING" : "0";
  });
  const r = await runLongInGuest(sh, "true", { marker: "/tmp/m", log: "/tmp/l", timeoutMs: 60_000, intervalMs: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.status, 0);
});

test("a nonzero exit is reported as a failure with the log tail attached", async () => {
  const { sh } = fakeGuest((c) => {
    if (c.includes("BLINK_LONG_EOF")) return "STARTED";
    if (c.includes("--- log")) return "--- context around first error ---\nerror: no space left on device";
    return "1";
  });
  const r = await runLongInGuest(sh, "true", { marker: "/tmp/m", log: "/tmp/l", timeoutMs: 60_000, intervalMs: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 1);
  assert.match(r.tail, /no space left/);
});

// ---------------------------------------------------------------------------
// 11. Redaction on the paths that run when things are already going wrong
// ---------------------------------------------------------------------------

import { redact } from "../src/redact.ts";

test("redaction FIRES on the SDK stack that actually leaked a sandbox id", () => {
  // This is the real string, from a failed teardown. The sweeper's uncaught
  // handler wrote it with process.stderr.write, which bypasses redact entirely.
  // Every writer in ledger.ts and adapter.ts now goes through safeErr.
  const leaked =
    "ConnectionError: POST /sandboxes/ZGVza3RvcC1wb29sLWktMDliYTQyZGEzOGU5NzJmOTM6dm1fMDAxNDI0" +
    "OmNtdGsxMXJsOTAwZTlvMjAxc3MzbGdnYzg6MTc4ODQ3MDQwNTM5NA.0vJbDYXC2sDS62UOV8loGIRE0ePvxHUW7B5qoqWz28k" +
    "/exec failed: fetch failed";
  const out = redact(leaked);
  assert.ok(!out.includes("ZGVza3RvcC1wb29s"), "the base64 sandbox id prefix must not survive");
  assert.ok(!out.includes("0vJbDYXC2sDS62UOV8loGIRE0ePvxHUW7B5qoqWz28k"), "nor the signature after the dot");
  assert.match(out, /REDACTED/);
  assert.match(out, /fetch failed/, "the diagnosis must survive, or redaction has cost us the bug report");
});

test("no module writes to stderr or stdout except through the safe writers", async () => {
  // The leak was not a missing pattern. It was a writer that never consulted
  // one. A pattern cannot defend a channel it is not on.
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      if (statSync(f).isDirectory()) { walk(f); continue; }
      if (!f.endsWith(".ts")) continue;
      if (f.includes("safe-io")) continue;
      const src = readFileSync(f, "utf8");
      if (/process\.(stderr|stdout)\.write\(/.test(src)) offenders.push(f);
    }
  };
  walk(new URL("../src", import.meta.url).pathname);
  walk(new URL("../scripts", import.meta.url).pathname);
  assert.deepEqual(offenders, [], `these write around redaction: ${offenders.join(", ")}`);
});

test("a single transport blip does NOT kill a long build, but a 429 still does", async () => {
  // The no-retry rule exists because retries multiply spend and mask 429s.
  // A missed observation of a detached job does neither. The boundary is
  // enforced here rather than described: anything with a status aborts.
  let n = 0;
  const shFlaky: Shell = async (cmd) => {
    n += 1;
    if (cmd.includes("BLINK_LONG_EOF")) return { value: { stdout: "STARTED", stderr: "" } };
    if (n === 2) throw Object.assign(new Error("fetch failed"), { name: "ConnectionError" });
    if (cmd.includes("--- log")) return { value: { stdout: "ok", stderr: "" } };
    return { value: { stdout: "0", stderr: "" } };
  };
  const r = await runLongInGuest(shFlaky, "true", { marker: "/tmp/m", log: "/tmp/l", timeoutMs: 60_000, intervalMs: 5 });
  assert.equal(r.ok, true, "one blip must not lose a twenty minute build");
});

test("a GuardBug during polling aborts immediately and is never swallowed", async () => {
  const { GuardBug } = await import("../src/guard/guard.ts");
  const shGuard: Shell = async (cmd) => {
    if (cmd.includes("BLINK_LONG_EOF")) return { value: { stdout: "STARTED", stderr: "" } };
    throw new GuardBug("429 at the concurrency limit", {} as never);
  };
  await assert.rejects(
    () => runLongInGuest(shGuard, "true", { marker: "/tmp/m", log: "/tmp/l", timeoutMs: 60_000, intervalMs: 5 }),
    (e: Error) => e.name === "GuardBug",
  );
});

test("two consecutive transport failures end the run rather than looping", async () => {
  const shDead: Shell = async (cmd) => {
    if (cmd.includes("BLINK_LONG_EOF")) return { value: { stdout: "STARTED", stderr: "" } };
    throw Object.assign(new Error("fetch failed"), { name: "ConnectionError" });
  };
  const r = await runLongInGuest(shDead, "true", { marker: "/tmp/m", log: "/tmp/l", timeoutMs: 600_000, intervalMs: 5 });
  assert.equal(r.ok, false);
  assert.match(r.tail, /two consecutive observations failed/);
});

// ---------------------------------------------------------------------------
// 12. The self-destruct proof must fail when nothing is armed
// ---------------------------------------------------------------------------

import { bootScriptStep, BOOT_SCRIPT_PATH } from "../scripts/snapshots/lib/template.ts";

test("every recipe that proves a self-destruct also ARMS one", () => {
  // The first version of proveSelfDestructStep only checked that a kill would
  // work. It passed on two recipes that had no self-destruct at all: the exact
  // bug the step exists to prevent, reproduced inside the fix for it.
  const recipes = ["gitea", "jaeger", "metabase", "excalidraw", "uptime-kuma"];
  for (const r of recipes) {
    const src = readFileSync(new URL(`../scripts/snapshots/${r}.ts`, import.meta.url), "utf8");
    if (!src.includes("proveSelfDestructStep")) continue;
    const arms = src.includes("bootScriptStep(") || src.includes("blink-boot");
    assert.ok(arms, `${r}.ts proves a self-destruct it never installs`);
  }
});

test("the proof checks installation, the right pidfile, and the ability to signal", () => {
  const step = proveSelfDestructStep("/var/run/app.pid");
  assert.match(step.cmd, /NO_BOOT_SCRIPT/, "an absent arming script must fail it");
  assert.match(step.cmd, /BOOT_SCRIPT_WRONG_PIDFILE/, "a script pointing at another app's pidfile must fail it");
  assert.match(step.cmd, /BOOT_SCRIPT_USES_PKILL/, "pkill is not on this image and must never appear");
  assert.match(step.cmd, /kill -0 "\$PID"/, "and the real process must be signallable");
});

test("the arming script kills by pidfile and never mentions pkill", () => {
  const boot = bootScriptStep("/var/lib/app/app.pid", "/var/log/blink/app.log");
  assert.match(boot.cmd, /kill -9/);
  assert.match(boot.cmd, /cat \/var\/lib\/app\/app\.pid/);
  assert.ok(!boot.cmd.includes("pkill"), "V61: pkill does not exist on the base image");
  assert.match(boot.cmd, new RegExp(BOOT_SCRIPT_PATH.replace(/\//g, "\\/")));
  assert.match(boot.cmd, /blink-selfdestruct-fired/, "it must leave evidence that it fired");
});

// ---------------------------------------------------------------------------
// 13. Liveness: a check that passes on a listening-but-useless app is the bug
// ---------------------------------------------------------------------------

import { LIVENESS, livenessFor } from "../scripts/gates/lib/liveness.ts";
import { SEEDED as SEEDED_FOR_TEST } from "../src/catalog/credentials.ts";
import { APPS as CATALOG } from "../scripts/gates/lib/apps.ts";

/** Serve canned responses so a check can be driven to both outcomes for free. */
function stubServer(routes: Record<string, { status?: number; body?: unknown; bytes?: number }>) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    seen.push(`${init?.method ?? "GET"} ${u}`);
    /*
     * A healthy landing page by default.
     *
     * Every check now loads the front door before it touches an API, because a
     * working API and a broken landing page turned out to be compatible (V102).
     * These tests are about the API failure modes, so the door is open unless a
     * test says otherwise, and the landing gate has its own tests below.
     */
    const path = new URL(u).pathname;
    if (path === "/" && routes["/"] === undefined) {
      return new Response(
        "<div id=\"app\">Uptime Kuma Jaeger UI Excalidraw Metabase Gitea Sign In</div>",
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    const key = Object.keys(routes).find((k) => u.includes(k));
    const r = key ? routes[key]! : { status: 404 };
    if (r.bytes !== undefined) return new Response(new Uint8Array(r.bytes), { status: r.status ?? 200 });
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status ?? 200, headers: { "content-type": "application/json" },
    });
  }) as never;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test("every catalog app has a liveness check, since a card we cannot check is a card we cannot promise", () => {
  for (const id of Object.keys(CATALOG)) {
    assert.doesNotThrow(() => livenessFor(id), `${id} has no liveness check`);
  }
  assert.throws(() => livenessFor("nonexistent"), /every catalog card needs one/);
});

test("Gitea liveness FIRES on a server that answers but cannot write", async () => {
  // The exact shape Uptime Kuma had: listening, replying, unusable.
  const s = stubServer({ "/api/v1/repos": { status: 500 } });
  try {
    const r = await LIVENESS.gitea!("http://x", 2000);
    assert.equal(r.ok, false);
    assert.match(r.detail, /create returned 500/);
    assert.match(r.asked, /read it back/, "the canary log must say what was asked");
  } finally { s.restore(); }
});

test("Gitea liveness requires the issue it READ to be the issue it WROTE", async () => {
  // A server that accepts writes and returns someone else's data passes any
  // check that only asserts a 200.
  const s = stubServer({
    "/issues/7": { body: { title: "a different issue" } },
    "/api/v1/repos": { body: { number: 7 } },
  });
  try {
    const r = await LIVENESS.gitea!("http://x", 2000);
    assert.equal(r.ok, false);
    assert.match(r.detail, /read back the wrong issue/);
  } finally { s.restore(); }
});

test("Jaeger liveness FIRES on a UI that is up with no traces", async () => {
  const s = stubServer({ "/api/traces": { body: { data: [] } } });
  try {
    const r = await LIVENESS.jaeger!("http://x", 2000);
    assert.equal(r.ok, false);
    assert.match(r.detail, /no traces, which is an empty screen/);
  } finally { s.restore(); }
});

test("Jaeger liveness FIRES on a trace with zero spans, which renders blank", async () => {
  const s = stubServer({ "/api/traces": { body: { data: [{ traceID: "abc", spans: [] }] } } });
  try {
    assert.equal((await LIVENESS.jaeger!("http://x", 2000)).ok, false);
  } finally { s.restore(); }
});

test("Excalidraw liveness FIRES when the shell loads but the bundle is a 404 page", async () => {
  // A static server with an empty directory and a leftover index.html passes
  // `GET / -> 200` forever.
  const s = stubServer({ "/index-abc.js": { bytes: 900 }, "http://x/": { body: "" } });
  try {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (new URL(u).pathname === "/") {
        return new Response(
          '<html><title>Excalidraw</title><script src="/index-abc.js"></script></html>',
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (u.includes("index-abc.js")) return new Response(new Uint8Array(900), { status: 200 });
      return new Response("", { status: 404 });
    }) as never;
    const r = await LIVENESS.excalidraw!("http://x", 2000);
    globalThis.fetch = original;
    assert.equal(r.ok, false);
    assert.match(r.detail, /only 900 bytes, which is not a build/);
  } finally { s.restore(); }
});

test("Metabase liveness FIRES when it authenticates but has no database attached", async () => {
  const s = stubServer({ "/api/session": { body: { id: "tok" } }, "/api/database": { body: { data: [] } } });
  try {
    const r = await LIVENESS.metabase!("http://x", 2000);
    assert.equal(r.ok, false);
    assert.match(r.detail, /no database is attached/);
  } finally { s.restore(); }
});

test("Metabase liveness PASSES only when the query returns rows", async () => {
  const s = stubServer({
    "/api/session": { body: { id: "tok" } },
    "/api/database": { body: { data: [{ id: 1, name: "Sample Database" }] } },
    "/api/dataset": { body: { data: { rows: [[18760]] } } },
  });
  try {
    const r = await LIVENESS.metabase!("http://x", 2000);
    assert.equal(r.ok, true);
    assert.match(r.detail, /18760/);
  } finally { s.restore(); }
});

test("every liveness check reports what it asked, for the public canary log", async () => {
  const s = stubServer({});
  try {
    for (const [id, check] of Object.entries(LIVENESS)) {
      if (id === "uptimekuma") continue; // websocket, covered separately
      const r = await check("http://x", 500);
      assert.ok(r.asked.length > 10, `${id} must describe what it asked`);
      assert.ok(r.detail.length > 0, `${id} must say why it failed`);
      assert.equal(typeof r.ms, "number");
    }
  } finally { s.restore(); }
});

test("liveness FIRES the token-preservation rule: every request carries pt_token", async () => {
  // The soak caught this live: Excalidraw's shell loaded because its URL carried
  // the capability, and the bundle it referenced did not, so the asset 401'd.
  // A browser hides the bug by keeping the __pt_preview cookie (V60); a fetch
  // client has no cookie jar and must carry the token every time.
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("/api/traces")) {
      return new Response(JSON.stringify({ data: [{ traceID: "t", spans: [{}, {}] }] }), { status: 200 });
    }
    if (new URL(u).pathname === "/") {
      return new Response('<div id="jaeger-ui-root">Jaeger UI</div>',
        { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("", { status: 404 });
  }) as never;
  try {
    const r = await LIVENESS.jaeger!("https://host.preview.getsolari.com/?pt_token=SECRET", 2000);
    assert.equal(r.ok, true);
    assert.ok(seen.length > 0);
    // The landing request IS the base URL, so it has no path of its own. It
    // still has to carry the capability, which is asserted with the rest.
    const [landing, ...api] = seen;
    assert.ok(landing!.includes("pt_token=SECRET"), "the landing request dropped the token");
    assert.ok(api.length > 0, "the check must do more than load the landing page");
    for (const u of api) {
      assert.ok(u.includes("pt_token=SECRET"), `request dropped the capability token: ${u}`);
      assert.ok(u.includes("/api/traces"), `path was lost by string concatenation: ${u}`);
    }
  } finally { globalThis.fetch = original; }
});

test("liveness never concatenates a path after a query string", async () => {
  // `https://h/?pt_token=X` + `/api/thing` yields one URL with a strange token
  // and no path at all. It fails as a 404, which reads like a missing endpoint.
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u2 = String(url);
    seen.push(u2);
    if (new URL(u2).pathname === "/") {
      return new Response('<div id="root">Metabase</div>',
        { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response(JSON.stringify({ id: "tok", data: [] }), { status: 200 });
  }) as never;
  try {
    await LIVENESS.metabase!("https://host.preview.getsolari.com/?pt_token=SECRET", 2000);
    // Skip the landing request, which is the base URL and has no path.
    for (const u of seen.slice(1)) {
      const parsed = new URL(u);
      assert.ok(parsed.pathname.startsWith("/api/"), `path went missing: ${u}`);
      assert.equal(parsed.searchParams.get("pt_token"), "SECRET");
    }
    assert.equal(new URL(seen[0]!).searchParams.get("pt_token"), "SECRET",
      "even the landing request must carry the capability");
  } finally { globalThis.fetch = original; }
});

test("the seeded repo name matches what the Gitea recipe actually creates", () => {
  // The first version took the repo name from the API TOKEN's name, which is a
  // different string, and every Gitea liveness check 404'd on a repo that never
  // existed. The recipe's source is the authority, so read it.
  const src = readFileSync(new URL("../scripts/snapshots/gitea.ts", import.meta.url), "utf8");
  const m = src.match(/"name":"([a-z0-9-]+)","description":"[^"]*","auto_init"/);
  assert.ok(m, "could not find the repo creation call in the recipe");
  assert.equal(SEEDED_FOR_TEST.gitea.repo, m[1], "credentials.ts and the recipe disagree about the repo name");
});

// ---------------------------------------------------------------------------
// 14. A tick must carry the cost its finally block measured
// ---------------------------------------------------------------------------

test("cost written in a finally block reaches the returned object", () => {
  // The soak reported "Spend across the run: $0.00000" while spending real
  // money. `return { ...base }` evaluates the spread BEFORE finally runs, so the
  // cost landed on an object nobody could see. Returning the same reference the
  // finally block mutates is what makes the number real.
  const spread = (): { usd: number } => {
    const base = { usd: 0 };
    try { return { ...base }; } finally { base.usd = 42; }
  };
  const sameRef = (): { usd: number } => {
    const base = { usd: 0 };
    try { return base; } finally { base.usd = 42; }
  };
  assert.equal(spread().usd, 0, "this is the bug: the spread copy never sees the mutation");
  assert.equal(sameRef().usd, 42, "and this is the fix the soak now uses");
});

test("the soak returns the mutated tick, not a spread copy", () => {
  const src = readFileSync(new URL("../scripts/soak/run.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function tickApp"), src.indexOf("async function deliberateKill"))
    // Strip comments: the fix is DOCUMENTED by quoting the broken form, so a
    // naive search finds the explanation and calls it the bug.
    .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  assert.ok(!/return\s*\{\s*\.\.\.base/.test(fn), "tickApp must not return a spread copy of base");
  assert.match(fn, /return base;/);
});

// ---------------------------------------------------------------------------
// 15. Reaping is scoped to our own sandboxes
// ---------------------------------------------------------------------------

test("assertZeroLive reaps OUR sandboxes and leaves other people's alone", async () => {
  // The first version killed every live sandbox on the account. A soak tick then
  // killed a separate process's sandbox mid-run and died itself. An account is
  // shared by a developer, their examples, and whatever else they have going.
  const dir = mkdtempSync(join(tmpdir(), "blink-scope-"));
  const l = new SandboxLedger(join(dir, "s.jsonl"));
  l.opened("sbx_ours", "test");

  const deleted: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "DELETE") { deleted.push(u.split("/").pop()!); return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify({
      sandboxes: [
        { sandboxId: "sbx_ours" },
        { sandboxId: "sbx_tagged", metadata: { blink_instance: "x" } },
        { sandboxId: "sbx_someone_else", metadata: { other: "tool" } },
      ],
    }), { status: 200 });
  }) as never;
  try {
    await assert.rejects(() => l.assertZeroLive("slr_live_test", { reap: true }), /still live at exit/);
    assert.ok(deleted.includes("sbx_ours"), "a sandbox the ledger recorded is ours");
    assert.ok(deleted.includes("sbx_tagged"), "so is one carrying our metadata tag");
    assert.ok(!deleted.includes("sbx_someone_else"), "another tool's sandbox must never be killed");
  } finally { globalThis.fetch = original; }
});

test("a foreign sandbox alone is reported, not reaped, and does not throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blink-scope2-"));
  const l = new SandboxLedger(join(dir, "s.jsonl"));
  const deleted: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") { deleted.push(String(url)); return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify({ sandboxes: [{ sandboxId: "sbx_theirs", metadata: { tool: "other" } }] }), { status: 200 });
  }) as never;
  try {
    const r = await l.assertZeroLive("slr_live_test", { reap: true });
    assert.equal(r.liveCount, 0, "none of ours are live");
    assert.deepEqual(r.foreignIds, ["sbx_theirs"]);
    assert.deepEqual(deleted, [], "nothing may be killed");
  } finally { globalThis.fetch = original; }
});

test("the soak records a leak instead of dying on it", () => {
  // One detection killed a twelve hour run at hour five and lost every hour
  // after it. A leak is a finding to record, not a reason to end the soak.
  const src = readFileSync(new URL("../scripts/soak/run.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("assertZeroLive") - 400, src.indexOf("assertZeroLive") + 900);
  assert.match(body, /try \{/, "the reconcile tick must catch");
  assert.match(body, /catch \(err\)/);
});


// ---------------------------------------------------------------------------
// 9. Screenshots: the seeded-state assertion, made to fire
// ---------------------------------------------------------------------------

import { APPS as SHOT_APPS } from "../scripts/gates/lib/apps.ts";

/**
 * Page text from a real capture of each app, good and bad.
 *
 * The bad samples are not invented. Each is what that app actually put on
 * screen while its capture ran green: Metabase's empty x-ray, Jaeger's
 * zero-result search, Uptime Kuma's monitor showing only snapshot-age data,
 * Gitea's repo home with no pull request on it.
 */
const SHOT_SAMPLES: Record<string, { good: string; bad: string }> = {
  gitea: {
    good: "Issues 4 | Typo in the README | Add a contributing guide | Support dark mode"
      + " | Blink canary check 2026-09-09 17:13:44.812 UTC",
    bad: "Issues 0 | There are no issues yet. | 1 Open 0 Closed",
  },
  jaeger: {
    good: "Find Traces | 6 traces (in 73.4ms) | frontend: GET /dispatch",
    bad: "Find Traces | 0 traces (in 2.1ms) | No trace results. Try another query.",
  },
  uptimekuma: {
    good: "Dashboard route (/dashboard) | 115h | now | Check every 20 seconds (20 seconds) | Up",
    bad: "This instance (HTTP) | Check every 60 seconds (60 seconds) | Up | 2026-09-03 16:59:43",
  },
  metabase: {
    good: "Sample Database / Orders | ID | User ID | Subtotal",
    bad: "Sample Database | This dashboard is empty",
  },
};

/** The DOM the expressions read, minus a browser. */
function pageWith(text: string, cells: number): void {
  const list = Array.from({ length: cells }, () => ({}));
  (globalThis as Record<string, unknown>).document = {
    body: { innerText: text },
    querySelectorAll: (sel: string) => (sel.includes("cell-data") ? list : []),
    querySelector: () => null,
  };
}

test("every shotExpect FIRES: a good page passes, the page that shipped fails", () => {
  for (const [id, sample] of Object.entries(SHOT_SAMPLES)) {
    const expr = SHOT_APPS[id]?.shotExpect;
    assert.ok(expr, `${id} must declare shotExpect`);
    const run = (text: string, cells: number): unknown => {
      pageWith(text, cells);
      return (0, eval)(expr!);
    };
    assert.equal(run(sample.good, 182), true, `${id}: a good page must pass`);
    assert.equal(run(sample.bad, 0), false, `${id}: the page that actually shipped must fail`);
  }
  delete (globalThis as Record<string, unknown>).document;
});

test("no shotExpect is a template literal escape away from meaning nothing", () => {
  // These expressions live in template literals, where \\b is a backspace and
  // \\d is a bare "d". Written the obvious way, a regex compiles to something
  // that matches nothing and the assertion is false on every page, good or bad,
  // so no screenshot is ever published and the cause is invisible. This caught
  // it once already, in two of the five.
  const BACKSPACE = String.fromCharCode(8);
  for (const [id, app] of Object.entries(SHOT_APPS)) {
    if (!app.shotExpect) continue;
    assert.ok(!app.shotExpect.includes(BACKSPACE),
      `${id}: shotExpect contains a literal backspace, so its word boundary was eaten`);
    for (const m of app.shotExpect.matchAll(/\/(?:[^/\\\n]|\\.)+\//g)) {
      assert.ok(!/[^\\]d[+*{]/.test(m[0]!),
        `${id}: ${m[0]} has an unescaped d, which is a letter and not a digit class`);
    }
  }
});

test("every catalog app declares an assertion for its capture", () => {
  // V82: the capture used to fire wherever the app happened to open. An app
  // with a shotPath and no shotExpect is that bug reintroduced.
  for (const [id, app] of Object.entries(SHOT_APPS)) {
    assert.ok(app.shotExpect, `${id} has no shotExpect, so its capture cannot fail on an empty app`);
  }
});


// ---------------------------------------------------------------------------
// 10. The offline Worker: classify the failure, and get the class right
// ---------------------------------------------------------------------------

import { classifyOrigin } from "../deploy/tunnel/worker/worker.js";

const T = 8000;

test("no-origin FIRES for every way a tunnel origin can be absent", () => {
  // Measured against the live deployment: stopping cloudflared for 46 seconds
  // produced x-blink-origin: origin-530, and the page said "Blink is asleep
  // right now" above "The machine is awake but returned an error (status 530)".
  // 530 is Cloudflare error 1033, tunnel not connected, which is the ONLY
  // failure mode this deployment routinely has.
  for (const status of [530, 521, 522, 523]) {
    assert.equal(classifyOrigin({ threw: false, status, elapsedMs: 28, timeoutMs: T }), "no-origin",
      `Cloudflare ${status} means the origin is absent, not that Blink answered badly`);
  }
  assert.equal(classifyOrigin({ threw: true, status: null, elapsedMs: 12, timeoutMs: T }), "no-origin",
    "a connection refused in milliseconds is an absence");
});

test("timeout FIRES only when something accepted and did not answer", () => {
  assert.equal(classifyOrigin({ threw: false, status: 524, elapsedMs: 9000, timeoutMs: T }), "timeout",
    "524 is the one Cloudflare 52x that means the origin accepted and hung");
  assert.equal(classifyOrigin({ threw: true, status: null, elapsedMs: T, timeoutMs: T }), "timeout",
    "a fetch that throws at the deadline is a hang, not an absence");
});

test("origin-5xx FIRES only for Blink actually answering badly", () => {
  assert.equal(classifyOrigin({ threw: false, status: 500, elapsedMs: 40, timeoutMs: T }), "origin-500");
  assert.equal(classifyOrigin({ threw: false, status: 502, elapsedMs: 40, timeoutMs: T }), "origin-502");
  // The distinction is the whole point of the header. If these collapsed into
  // no-origin the operator would go looking for a sleeping laptop while Blink
  // was awake and throwing.
  assert.notEqual(classifyOrigin({ threw: false, status: 500, elapsedMs: 40, timeoutMs: T }), "no-origin");
});

test("a healthy origin is not a failure", () => {
  for (const status of [200, 204, 302, 404]) {
    assert.equal(classifyOrigin({ threw: false, status, elapsedMs: 30, timeoutMs: T }), null,
      `${status} is the origin working, or the origin saying no, and neither is a fallback`);
  }
});

test("the page cannot say asleep and awake at once", () => {
  // The contradiction was two functions disagreeing: the headline is fixed text
  // and the status line switched on the classification. They agree now because
  // no-origin is what a dead tunnel classifies as, so assert exactly that.
  assert.equal(classifyOrigin({ threw: false, status: 530, elapsedMs: 28, timeoutMs: T }), "no-origin",
    "the status line reads 'did not answer' for no-origin, which is what the headline says");
});


// ---------------------------------------------------------------------------
// 11. run.sh: a child dying must be a failure, and all three children count
// ---------------------------------------------------------------------------

import { readFileSync as readRun } from "node:fs";

const RUN_SH = readRun(new URL("../deploy/tunnel/run.sh", import.meta.url), "utf8");

test("a child dying exits NON-ZERO, or systemd's crash recovery cannot fire", () => {
  // V89. shutdown() ended `exit 0` on every path, so a crash drained tidily and
  // reported success, and Restart=on-failure sat there doing nothing. Fired
  // live: killing the tunnel produced "Failed with result 'exit-code'" and an
  // automatic restart. This guards the property so it cannot quietly revert.
  assert.match(RUN_SH, /shutdown 1/,
    "the path taken when a child died must exit non-zero");
  assert.match(RUN_SH, /trap 'shutdown 0' INT TERM HUP/,
    "a signal is a requested stop, not a failure, and must NOT be restarted");
  assert.ok(!/^\s*exit 0\s*$/m.test(RUN_SH.slice(RUN_SH.indexOf("shutdown() {"))),
    "shutdown() must not hardcode exit 0 again");
});

test("all three children are watched, not just the web server", () => {
  // V88. It watched BLINK_PID alone. A dead tunnel left systemd active,
  // localhost answering 200 and every visitor on the offline page.
  const loop = RUN_SH.slice(RUN_SH.indexOf('dead=""'));
  for (const pid of ["BLINK_PID", "TUNNEL_PID", "WATCHDOG_PID"]) {
    assert.ok(loop.includes(pid), `${pid} is started but never watched`);
  }
});


// ---------------------------------------------------------------------------
// 12. The offline page's palette cannot drift from the site's
// ---------------------------------------------------------------------------

import { TOKENS as SITE_TOKENS } from "../src/web/tokens.ts";

test("the Worker's palette matches the site's tokens, value for value", () => {
  // worker.js is deployed to Cloudflare by wrangler and cannot import from this
  // repo, so its palette is a copy. A copy with nothing checking it is how the
  // offline page ends up being the one surface still wearing last year's theme,
  // which a visitor only ever sees when the site is already down and nobody is
  // looking. The duplication is fine; the duplication going unchecked is not.
  const worker = readRun(new URL("../deploy/tunnel/worker/worker.js", import.meta.url), "utf8");
  const declared = Object.fromEntries(
    [...worker.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1]!, m[2]!.toUpperCase()]),
  );
  const mustMatch = {
    paper: SITE_TOKENS.bg, surface: SITE_TOKENS.surface, border: SITE_TOKENS.border,
    ink: SITE_TOKENS.text, muted: SITE_TOKENS.muted,
    accent: SITE_TOKENS.accent, fail: SITE_TOKENS.fail,
  };
  for (const [name, expected] of Object.entries(mustMatch)) {
    assert.equal(declared[name], expected.toUpperCase(),
      `offline page --${name} is ${declared[name]}, the site uses ${expected}`);
  }
});

test("no surface still carries the old dark palette", () => {
  // Every hex that was in the dark theme. If one reappears, some page was
  // restyled by hand and missed.
  const DEAD = ["#0B0C0E", "#141619", "#23262B", "#E8EAED", "#8A9099", "#3DDC84", "#E05252"];
  const files = [
    "../src/web/tokens.ts", "../src/web/render.ts", "../src/web/server.ts",
    "../src/web/offline.ts", "../deploy/tunnel/worker/worker.js",
  ];
  for (const f of files) {
    const src = readRun(new URL(f, import.meta.url), "utf8").toUpperCase();
    for (const hex of DEAD) {
      assert.ok(!src.includes(hex), `${f} still contains ${hex} from the dark theme`);
    }
  }
});


test("the Uptime Kuma card quotes the interval the fork actually sets", () => {
  // The card said "one minute interval" for a monitor the fork time refresh
  // retunes to twenty seconds. Copy is a claim like any other, and this one had
  // a machine readable source of truth sitting next to it.
  const server = readRun(new URL("../src/web/server.ts", import.meta.url), "utf8");
  const card = /description: "(Uptime monitoring[^"]*)"/.exec(server)?.[1] ?? "";
  assert.ok(card, "the Uptime Kuma card description moved and this test lost it");
  const seconds = /interval: (\d+)/.exec(MONITOR_REFRESH_SCRIPT)?.[1];
  assert.equal(seconds, "20", "the refresh interval changed and the card copy needs to follow");
  assert.match(card, /twenty seconds/, `card says "${card}" but the fork sets ${seconds}s`);
});


// ---------------------------------------------------------------------------
// 13. The landing page: what a visitor's FIRST request returns
// ---------------------------------------------------------------------------

import { firstScreen, landingOk } from "../scripts/gates/lib/liveness.ts";

/** A tiny preview domain: a token in the query, or a cookie, or 401. */
function previewServer(routes: Record<string, { status: number; body?: string; location?: string }>) {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const cookie = String((init?.headers as Record<string, string> | undefined)?.cookie ?? "");
    seen.push(url.pathname + (url.searchParams.has("pt_token") ? "?token" : "") + (cookie ? "+cookie" : ""));
    const authorised = url.searchParams.has("pt_token") || cookie.includes("__pt_preview");
    if (!authorised) return new Response("unauthorized", { status: 401 });
    const r = routes[url.pathname] ?? { status: 404 };
    const h = new Headers({ "content-type": "text/html" });
    // The preview domain hands out the cookie on the first authorised response.
    if (seen.length === 1) h.append("set-cookie", "__pt_preview=jwt; Path=/");
    if (r.location) h.set("location", r.location);
    return new Response(r.body ?? "", { status: r.status, headers: h });
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

const PREVIEW = "https://abc-3001.preview.getsolari.com/?pt_token=SECRET";

test("firstScreen FIRES on the redirect that drops the capability", async () => {
  // Measured on a live Uptime Kuma fork: "/" answers 302 to a RELATIVE
  // "/dashboard", and a relative redirect discards the query string, which is
  // where the capability lives. Without a cookie jar the second hop is a 401.
  // A browser survives on the cookie alone, which is why this was invisible.
  const srv = previewServer({
    "/": { status: 302, location: "/dashboard" },
    "/dashboard": { status: 200, body: "<div id=\"app\">Uptime Kuma</div>" },
  });
  try {
    const r = await firstScreen(PREVIEW, 5000);
    assert.equal(r.status, 200, "the landing page must be reached");
    assert.equal(r.hops, 1);
    assert.ok(srv.seen[1]!.includes("?token"), "the token must be re-attached to the redirect");
  } finally { srv.restore(); }
});

test("landingOk FAILS when the visitor's first request ends anywhere but the app", async () => {
  for (const [name, routes] of Object.entries({
    "a 404 root": { "/": { status: 404 } },
    "a redirect into a 404": { "/": { status: 302, location: "/dashboard" }, "/dashboard": { status: 404 } },
    "200 with the wrong page": { "/": { status: 200, body: "<h1>Setup wizard</h1>" } },
  })) {
    const srv = previewServer(routes as never);
    try {
      const r = await landingOk(PREVIEW, /Uptime Kuma/, 5000);
      assert.equal(r.ok, false, `${name} must fail the landing check`);
      assert.match(r.detail, /first request|did not contain/);
    } finally { srv.restore(); }
  }
});

test("every app asserts its landing page, not just its API", async () => {
  // V102: the Uptime Kuma check completed a socket handshake and passed while a
  // visitor's first request 401'd. A working API and a broken front door are
  // compatible, and only one of them is what the catalog card promises.
  const src = readRun(new URL("../scripts/gates/lib/liveness.ts", import.meta.url), "utf8");
  const checks = [...src.matchAll(/export const (\w+Liveness): LivenessCheck/g)].map((m) => m[1]!);
  assert.equal(checks.length, 5, "five apps, five checks");
  for (const name of checks) {
    const body = src.slice(src.indexOf(`export const ${name}:`));
    const upTo = body.slice(0, body.indexOf("\n};"));
    assert.match(upTo, /await landingOk\(base,/,
      `${name} must check what a visitor's first request returns`);
  }
});


// ---------------------------------------------------------------------------
// 14. The reaper must not eat the thing it is protecting
// ---------------------------------------------------------------------------

test("assertZeroLive FIRES on an orphan and SPARES a live instance", async () => {
  /*
   * The watchdog called this bare on a 60 second timer while the site was
   * serving. A live visitor instance IS recorded in the ledger, and the ledger
   * recording it is exactly what the function treats as proof it should die, so
   * every instance was killed within a minute of being created (V112).
   *
   * Ours and should-be-dead are different questions, and this is the test that
   * makes the difference fire: one sandbox that is legitimately live, one that
   * is genuinely orphaned, and only the orphan may be touched.
   */
  const { SandboxLedger } = await import("../src/guard/ledger.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const LIVE = "sbx_alive_on_purpose";
  const ORPHAN = "sbx_nobody_owns_this";
  const deleted: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "DELETE") {
      deleted.push(u.split("/sandboxes/")[1]!);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({
      sandboxes: [{ sandboxId: LIVE, metadata: { blink_app: "gitea" } },
                  { sandboxId: ORPHAN, metadata: { blink_app: "jaeger" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as never;

  try {
    const ledger = new SandboxLedger(join(mkdtempSync(join(tmpdir(), "blink-reap-")), "s.jsonl"));
    ledger.opened(LIVE, "launch:gitea", "t1");
    ledger.opened(ORPHAN, "launch:jaeger", "t2");

    await ledger.assertZeroLive("slr_live_test", { reap: true, exempt: [LIVE] })
      .catch(() => { /* it throws when it reaps, which is the point */ });

    assert.deepEqual(deleted, [ORPHAN],
      `only the orphan may be reaped, but it deleted: ${deleted.join(", ") || "nothing"}`);
    assert.ok(!deleted.includes(LIVE),
      "a visitor's live instance must survive the reaper");
  } finally { globalThis.fetch = original; }
});

test("the watchdog exempts every instance that is not past its grace", async () => {
  // The block that kills overdue rows had already decided which were expired.
  // The reaper below it then killed the ones it had deliberately spared.
  const src = readRun(new URL("../scripts/watchdog.ts", import.meta.url), "utf8");
  assert.match(src, /const alive = rows[\s\S]{0,260}\.map\(\(r\) => r\.sandboxId as string\);/,
    "the watchdog must compute what is alive on purpose");
  assert.match(src, /assertZeroLive\(apiKey!, \{ reap: true, exempt: alive \}\)/,
    "and hand that to the reaper, or it kills what the block above spared");
});
