/**
 * Canary tests.
 *
 * The canary is what makes a catalog card a promise rather than a claim, so the
 * two things that matter are that it never degrades the site to measure it, and
 * that it never reports a green cell for something it did not actually verify.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runCanaryOnce, type CanaryResult } from "../src/canary/runner.ts";
import { MemoryScopeLock } from "../src/concurrency/scope-lock.ts";
import { SIZE_SMALL } from "../src/guard/rates.ts";

const APP = { appId: "jaeger", snapshotId: "snap_x", size: SIZE_SMALL, port: 16686, healthPath: "/" };

function deps(over: { liveSlots?: number; healthy?: boolean; traces?: boolean; createThrows?: boolean } = {}) {
  const calls = { created: 0, killed: [] as string[] };
  const recorded: CanaryResult[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL) => {
    if (String(u).includes("/api/traces")) {
      return new Response(JSON.stringify({
        data: over.traces === false ? [] : [{ traceID: "t", spans: [{}, {}, {}] }],
      }), { status: 200 });
    }
    // The landing page a visitor lands on. Every check loads the front door
    // before it touches an API now, because the two turned out to be
    // independent: Uptime Kuma passed a socket handshake while a visitor's
    // first request 401'd (V102).
    if (new URL(String(u)).pathname === "/") {
      return new Response('<div id="jaeger-ui-root">Jaeger UI</div>',
        { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("", { status: 404 });
  }) as never;

  return {
    restore: () => { globalThis.fetch = original; },
    calls, recorded,
    d: {
      apiKey: "k",
      adapter: {
        async createSandbox() {
          calls.created += 1;
          if (over.createThrows) throw new Error("create exploded");
          return { value: { sandboxId: `sbx_${calls.created}` }, ms: 1 };
        },
        async exec() { return { value: { stdout: "", stderr: "", exitCode: 0 }, ms: 1 }; },
        async previewUrl() { return { value: { url: "https://h/?pt_token=T" }, ms: 1 }; },
        async killQuiet(_k: string, id: string) { calls.killed.push(id); },
      } as never,
      lock: new MemoryScopeLock(),
      liveSlots: async () => over.liveSlots ?? 0,
      maxSlots: 2,
      waitHealthy: async () => ({ ok: over.healthy ?? true, ms: 900 }),
      record: (r: CanaryResult) => { recorded.push(r); },
    },
  };
}

test("the canary YIELDS the last slot rather than making a visitor queue", async () => {
  // Background work that degrades the site to measure it is worse than no
  // measurement.
  const h = deps({ liveSlots: 1 });
  try {
    const r = await runCanaryOnce(h.d, APP);
    assert.equal(h.calls.created, 0, "no sandbox may be created when yielding");
    assert.match(r.detail, /skipped/);
    assert.equal(r.ok, false);
  } finally { h.restore(); }
});

test("a skipped run is NOT recorded as a failure of the app", async () => {
  // A red cell on the health wall must mean the app broke, not that the canary
  // could not get a slot.
  const h = deps({ liveSlots: 1 });
  try {
    const r = await runCanaryOnce(h.d, APP);
    assert.match(r.detail, /skipped/);
    assert.equal(r.error, undefined, "a yield is not an error");
  } finally { h.restore(); }
});

test("a passing canary reports WHAT IT ASKED, not just a tick", async () => {
  const h = deps();
  try {
    const r = await runCanaryOnce(h.d, APP);
    assert.equal(r.ok, true);
    assert.match(r.asked, /trace/i, "the public log has to say what was checked");
    assert.match(r.detail, /3 spans/);
    assert.ok(r.forkToHealthyMs !== null && r.resolveMs !== null);
  } finally { h.restore(); }
});

test("an app that answers but is EMPTY fails the canary", async () => {
  // Jaeger with no traces is a running UI showing a blank screen. A status code
  // check calls that healthy; this must not.
  const h = deps({ traces: false });
  try {
    const r = await runCanaryOnce(h.d, APP);
    assert.equal(r.ok, false);
    assert.match(r.detail, /no traces/);
  } finally { h.restore(); }
});

test("the canary always kills its sandbox, on every path", async () => {
  for (const over of [{}, { healthy: false }, { traces: false }]) {
    const h = deps(over);
    try {
      await runCanaryOnce(h.d, APP);
      assert.equal(h.calls.killed.length, 1, `not killed for ${JSON.stringify(over)}`);
    } finally { h.restore(); }
  }
});

test("a create that throws is recorded, not swallowed", async () => {
  const h = deps({ createThrows: true });
  try {
    const r = await runCanaryOnce(h.d, APP);
    assert.equal(r.ok, false);
    assert.match(r.error!, /create exploded/);
    assert.equal(h.recorded.length, 1, "every run reaches the log, including the broken ones");
  } finally { h.restore(); }
});

test("every run is recorded, so the public log cannot omit failures", async () => {
  const h = deps({ healthy: false });
  try {
    await runCanaryOnce(h.d, APP);
    assert.equal(h.recorded.length, 1);
    assert.equal(h.recorded[0]!.ok, false);
  } finally { h.restore(); }
});

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

test("a screenshot is captured only when the check PASSED", async () => {
  // A photograph of a broken app on a card is worse than an empty frame,
  // because it looks finished and is wrong.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/canary/runner.ts", import.meta.url), "utf8");
  assert.match(src, /if \(live\.ok && d\.shotPathFor\)/,
    "capture must be gated on the liveness check passing");
});

test("the capture uses Page.captureScreenshot, which has no browser chrome", async () => {
  // The previewUrl is a bearer capability. It must not appear in an address bar
  // in an image published on a public page. That is a property of the capture
  // method, not something to crop afterwards.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/canary/screenshot.ts", import.meta.url), "utf8");
  assert.match(src, /Page\.captureScreenshot/);
  assert.ok(!/screenshot\(\)/.test(src), "no helper that might include chrome");
  assert.match(src, /registerSecret\(session\.id\)/, "session ids embed the org id");
});

test("the browser session is released on every path", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/canary/screenshot.ts", import.meta.url), "utf8");
  const fin = src.slice(src.indexOf("} finally {"));
  assert.match(fin, /releaseAndWait/, "a leaked browser session bills like any other");
});

test("a fresh screenshot is not recaptured", async () => {
  const { shotIsFresh, SHOT_MAX_AGE_MS } = await import("../src/canary/screenshot.ts");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const p = join(mkdtempSync(join(tmpdir(), "blink-shot-")), "gitea.png");
  assert.equal(shotIsFresh(p), false, "a missing file is never fresh");
  writeFileSync(p, "x");
  assert.equal(shotIsFresh(p), true);
  assert.ok(SHOT_MAX_AGE_MS >= 3600_000, "recapturing hourly would burn browser-seconds for nothing");
});

test("every app names the view that shows its seeded state, never bare /", async () => {
  // The first capture photographed Gitea's logged out marketing page. A card
  // showing a generic landing page is a card that proves nothing, and the whole
  // argument of the project is that the instance is really seeded.
  const { APPS } = await import("../scripts/gates/lib/apps.ts");
  for (const [id, app] of Object.entries(APPS)) {
    assert.ok(app.shotPath, `${id} has no shotPath, so it would photograph its root`);
  }
  assert.match(APPS.gitea!.shotPath!, /pulls|issues/, "Gitea should show the seeded PR");
  assert.match(APPS.jaeger!.shotPath!, /service=frontend/, "Jaeger should show the seeded traces");
});

test("the two apps that gate behind a login have a script to get past it", async () => {
  // 04-frontend-spec.md section 9 note 2 predicted exactly these two.
  const { APPS } = await import("../scripts/gates/lib/apps.ts");
  assert.ok(APPS.metabase!.shotScript, "Metabase gates on login");
  assert.ok(APPS.uptimekuma!.shotScript, "Uptime Kuma gates on login");
  assert.ok(!APPS.gitea!.shotScript, "Gitea's seeded repo is public and needs none");
});

test("the screenshot navigation keeps the capability token", async () => {
  // Same trap as V72: new URL(path, base) drops the query, the query is the
  // credential, and the card would show a 401 page.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/canary/screenshot.ts", import.meta.url), "utf8");
  assert.match(src, /out\.searchParams\.set\("pt_token", token\)/);
  assert.match(src, /at\(opts\.previewUrl, opts\.shotPath/);
});

test("the canary runs postFork, or it fails apps for the bug postFork fixes", async () => {
  // postFork was wired into the launch path only. The canary kept failing
  // Jaeger for exactly the reason postFork exists (V77): a fix applied to what
  // the visitor sees but not to the thing that checks what the visitor sees.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/canary/runner.ts", import.meta.url), "utf8");
  assert.match(src, /if \(h\.ok && app\.postFork\)/,
    "the canary must refresh time-sensitive data before checking it");
});

test("cards point at a screenshot once one exists", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function buildApps"), src.indexOf("function soakSummary"));
  assert.match(fn, /shotUrl: existsSync\(shotPathFor\(id\)\)/);
  assert.ok(!/shotUrl: null, shotAt: null/.test(fn), "a hardcoded null means no card ever shows one");
});
