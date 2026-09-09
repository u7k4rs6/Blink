/**
 * Launch runner tests.
 *
 * Weighted entirely towards the paths that cost money: refusal before a call,
 * a kill on every exit, the lifetime starting at handover, and settlement being
 * idempotent. The happy path is the easy part and the cheap part.
 */

import { test } from "node:test";
import { mkdtempSync as mkTmp } from "node:fs";
import { tmpdir as osTmp } from "node:os";
import { join as pathJoin } from "node:path";

// Redirect the instance log BEFORE any test touches the store. Without this the
// suite appends fake sandbox ids to the real log, and the next server boot tries
// to kill sandboxes named sbx_1. It did exactly that, 25 rows deep.
process.env.BLINK_INSTANCE_LOG = pathJoin(mkTmp(pathJoin(osTmp(), "blink-instlog-")), "instances.jsonl");
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LaunchRunner, LaunchRefused, DEFAULT_LIFETIME_MS } from "../src/orchestrator/runner.ts";
import { BudgetGuard } from "../src/guard/guard.ts";
import { SandboxLedger } from "../src/guard/ledger.ts";
import { MemoryScopeLock } from "../src/concurrency/scope-lock.ts";
import { PLANS, SIZE_SMALL } from "../src/guard/rates.ts";

type Calls = { created: number; killed: string[]; execs: string[] };

function harness(over: {
  liveSlots?: () => Promise<number>;
  healthy?: boolean;
  previewUrl?: string | null;
  createThrows?: boolean;
} = {}) {
  const calls: Calls = { created: 0, killed: [], execs: [] };
  const dir = mkdtempSync(join(tmpdir(), "blink-run-"));
  const ledger = new SandboxLedger(join(dir, "s.jsonl"));
  const guard = new BudgetGuard(PLANS.starter, 1);

  const adapter = {
    async createSandbox() {
      calls.created += 1;
      if (over.createThrows) throw new Error("create exploded");
      return { value: { sandboxId: `sbx_${calls.created}` }, ms: 10 };
    },
    async exec(_k: string, _s: unknown, _g: string, cmd: string) {
      calls.execs.push(cmd);
      return { value: { stdout: "", stderr: "", exitCode: 0 }, ms: 1 };
    },
    async previewUrl() {
      return { value: { url: over.previewUrl === undefined ? "https://h.preview.getsolari.com/?pt_token=T" : over.previewUrl }, ms: 1 };
    },
    async killQuiet(_k: string, id: string) { calls.killed.push(id); },
  } as never;

  const runner = new LaunchRunner({
    apiKey: "slr_live_test", adapter, guard, ledger,
    lock: new MemoryScopeLock(),
    liveSlots: over.liveSlots ?? (async () => 0),
    waitHealthy: async () => ({ ok: over.healthy ?? true, ms: 300 }),
  });
  return { runner, calls, guard, ledger };
}

const APP = { appId: "gitea", snapshotId: "snap_x", size: SIZE_SMALL, port: 3000, healthPath: "/api/healthz" };

test("at capacity, launch REFUSES before any Solari call", async () => {
  // The cheapest thing the runner does and the most important. Every failure
  // downstream of a create costs money; this one costs nothing.
  const { runner, calls } = harness({ liveSlots: async () => 2 });
  await assert.rejects(() => runner.launch(APP), (e: LaunchRefused) => e.name === "LaunchRefused" && e.reason === "at_capacity");
  assert.equal(calls.created, 0, "no sandbox may be created when refused");
});

test("a launch may take the LAST slot, because that is what it is for", async () => {
  const { runner, calls } = harness({ liveSlots: async () => 1 });
  const inst = await runner.launch(APP);
  assert.equal(calls.created, 1);
  assert.equal(inst.state, "HANDOVER");
});

test("the lifetime starts at HANDOVER, not when the sandbox was created", async () => {
  // A visitor whose URL took four seconds to resolve should not lose four
  // seconds of their ten minutes for a wait they never saw.
  const { runner } = harness();
  const inst = await runner.launch(APP);
  assert.equal(inst.state, "HANDOVER");
  assert.ok(inst.lifetimeStartedAt !== null);
  assert.ok(inst.lifetimeStartedAt! >= inst.createdAt);
  assert.equal(inst.expiresAt, inst.lifetimeStartedAt! + DEFAULT_LIFETIME_MS);
});

test("a failed health check KILLS the sandbox rather than leaking it", async () => {
  const { runner, calls } = harness({ healthy: false });
  const inst = await runner.launch(APP);
  assert.deepEqual(calls.killed, ["sbx_1"], "an unhealthy instance must still be killed");
  assert.equal(inst.state, "FAILED");
  assert.ok(inst.receipt, "and it must still produce a receipt");
  assert.equal(inst.receipt!.lost, true, "marked lost, because the visitor never got it");
});

test("a missing preview URL kills the sandbox too", async () => {
  const { runner, calls } = harness({ previewUrl: null });
  const inst = await runner.launch(APP);
  assert.deepEqual(calls.killed, ["sbx_1"]);
  assert.equal(inst.state, "FAILED");
});

test("a create that throws still records intent for the sweeper", async () => {
  // The create may have succeeded on the platform even when the client never
  // learned the id. Intent is what makes that recoverable.
  const { runner, ledger } = harness({ createThrows: true });
  await assert.rejects(() => runner.launch(APP));
  const raw = ledger.openIds();
  // No id was ever returned, so nothing is open, but the intent row exists.
  assert.deepEqual(raw, []);
});

test("the guest self-destruct is armed BEFORE handover", async () => {
  // Layer 2 of the expiry design, and the only layer indifferent to visitor
  // activity. Arming it after handover leaves a window with no backstop.
  const { runner, calls } = harness();
  await runner.launch(APP);
  const armIndex = calls.execs.findIndex((c) => c.includes("blink-boot "));
  assert.ok(armIndex >= 0, "the boot script must be armed");
});

test("the boot script is called with a ROOT_URL, not with a made up subcommand", async () => {
  /*
   * blink-boot takes `<root_url> <lifetime_seconds>` and rewrites the app's own
   * ROOT_URL to it. The runner called it as `blink-boot arm <seconds>`,
   * inventing a subcommand the script does not have, so Gitea's ROOT_URL became
   * the literal string "arm". Gitea then emitted `arm/assets/...` as a RELATIVE
   * url, which resolved against whatever page the visitor was on, and every
   * stylesheet 404ed on an otherwise perfect instance.
   */
  const { runner, calls } = harness();
  await runner.launch(APP);
  const boot = calls.execs.find((c) => c.includes("blink-boot "))!;
  assert.ok(boot, "the boot script must run");
  assert.ok(!/blink-boot arm\b/.test(boot), "arm is not a subcommand, it became the ROOT_URL");
  const arg = /blink-boot "([^"]*)"/.exec(boot)?.[1];
  assert.ok(arg, `the first argument must be a quoted url, got: ${boot.slice(0, 70)}`);
  const u = new URL(arg!);
  assert.match(u.protocol, /^https?:$/);
  assert.equal(u.pathname, "/", "ROOT_URL is an origin, not a deep path");
  assert.equal(u.search, "", "the capability token must NOT be baked into every link the app renders");
});

test("the self-destruct outlives the server lifetime, so the server acts first", async () => {
  const { runner, calls } = harness();
  await runner.launch(APP);
  const arm = calls.execs.find((c) => c.includes("blink-boot "))!;
  const seconds = Number(/blink-boot "[^"]*" (\d+)/.exec(arm)![1]);
  assert.ok(seconds * 1000 > DEFAULT_LIFETIME_MS,
    "a guest that self-destructs first would kill instances the server thinks are alive");
});

test("ending is idempotent, since expiry and destroy can race", async () => {
  const { runner, calls } = harness();
  const inst = await runner.launch(APP);
  const a = await runner.end(inst, "destroyed");
  const b = await runner.end(inst, "expired");
  assert.equal(a, b, "the second end must return the first receipt, not a new one");
  assert.equal(calls.killed.length, 1, "and must not kill twice");
});

test("the preview URL stops existing the moment the instance ends", async () => {
  // It is a bearer capability. Holding it after it is useless is pure downside.
  const { runner } = harness();
  const inst = await runner.launch(APP);
  assert.ok(inst.previewUrl);
  await runner.end(inst, "expired");
  assert.equal(inst.previewUrl, null);
});

test("extend works once and then says so", async () => {
  const { runner } = harness();
  const inst = await runner.launch(APP);
  const before = inst.expiresAt!;
  assert.deepEqual(await runner.extend(inst.id), { ok: true });
  assert.equal(inst.expiresAt, before + DEFAULT_LIFETIME_MS);
  const second = await runner.extend(inst.id);
  assert.equal(second.ok, false);
  assert.match(second.reason!, /already extended once/);
});

test("endAll settles every live instance, which is what shutdown needs", async () => {
  const { runner, calls } = harness();
  await runner.launch(APP);
  await runner.launch(APP);
  await runner.endAll("shutdown");
  assert.equal(calls.killed.length, 2);
  assert.equal(runner.liveCount(), 0);
});

test("an illegal transition throws rather than being silently absorbed", async () => {
  const { runner } = harness();
  const inst = await runner.launch(APP);
  await runner.end(inst, "expired");
  // ENDED is terminal. Extending it must not quietly succeed.
  assert.equal((await runner.extend(inst.id)).ok, false);
});

test("every instance that was created gets killed, across mixed outcomes", async () => {
  // The property that matters more than any single path: creates and kills
  // balance. A test per path can pass while the sum still leaks.
  for (const opts of [{}, { healthy: false }, { previewUrl: null }]) {
    const { runner, calls } = harness(opts);
    const inst = await runner.launch(APP);
    await runner.end(inst, "expired");
    assert.equal(calls.killed.length, calls.created,
      `created ${calls.created} but killed ${calls.killed.length} for ${JSON.stringify(opts)}`);
  }
});

// ---------------------------------------------------------------------------
// Layer 3: the dead-man refresh, and surviving a restart
// ---------------------------------------------------------------------------

import { PLATFORM_TIMEOUT_MS, HEARTBEAT_MS } from "../src/orchestrator/runner.ts";

test("the platform timeout is SHORT and the heartbeat is shorter", async () => {
  // The first version set the platform timeout longer than the lifetime, so a
  // server death left a sandbox running twelve minutes with nothing tracking it.
  // Layer 3 inverts that: 180 s, pushed out every 45 s while we are alive.
  assert.equal(PLATFORM_TIMEOUT_MS, 180_000);
  assert.ok(HEARTBEAT_MS < PLATFORM_TIMEOUT_MS / 2,
    "the heartbeat must tolerate two consecutive misses before the platform acts");
  assert.ok(PLATFORM_TIMEOUT_MS < DEFAULT_LIFETIME_MS,
    "a platform timeout longer than the lifetime is not a backstop, it is a delay");
});

test("the sandbox is created with the SHORT timeout, not the lifetime", async () => {
  let opts: { timeoutMs?: number } | null = null;
  const dir = mkdtempSync(join(tmpdir(), "blink-hb-"));
  const ledger = new SandboxLedger(join(dir, "s.jsonl"));
  const runner = new LaunchRunner({
    apiKey: "k",
    adapter: {
      async createSandbox(_k: string, _g: string, o: { timeoutMs?: number }) {
        opts = o;
        return { value: { sandboxId: "sbx_1", setTimeout: async () => ({}) }, ms: 1 };
      },
      async exec() { return { value: { stdout: "", stderr: "", exitCode: 0 }, ms: 1 }; },
      async previewUrl() { return { value: { url: "https://h/?pt_token=T" }, ms: 1 }; },
      async killQuiet() { /* noop */ },
    } as never,
    guard: new BudgetGuard(PLANS.starter, 1), ledger, lock: new MemoryScopeLock(),
    liveSlots: async () => 0,
    waitHealthy: async () => ({ ok: true, ms: 10 }),
  });
  await runner.launch({ appId: "gitea", snapshotId: "s", size: SIZE_SMALL, port: 3000, healthPath: "/" });
  assert.equal(opts!.timeoutMs, PLATFORM_TIMEOUT_MS);
});

test("a restart KILLS an orphan that is past its expiry", async () => {
  // Without adoption a restart silently abandons every live instance, and the
  // only thing that eventually stops them is layer 3 three minutes later.
  const { persist, instanceLogPath } = await import("../src/orchestrator/store.ts");
  const { rmSync } = await import("node:fs");
  try { rmSync(instanceLogPath()); } catch { /* first run */ }

  persist({
    id: "old", appId: "gitea", sandboxId: "sbx_orphan", state: "LIVE",
    createdAt: Date.now() - 900_000, lifetimeStartedAt: Date.now() - 900_000,
    expiresAt: Date.now() - 300_000, extended: false, settled: false,
    sizeCpu: 1, sizeMemMb: 2048,
  });

  const { runner } = harness();
  const killed: string[] = [];
  const r = await runner.adoptOrphans(async (id) => { killed.push(id); });
  assert.deepEqual(killed, ["sbx_orphan"]);
  assert.deepEqual(r.killed, ["old"]);
});

test("a settled instance is never adopted twice", async () => {
  const { persist, instanceLogPath } = await import("../src/orchestrator/store.ts");
  const { rmSync } = await import("node:fs");
  try { rmSync(instanceLogPath()); } catch { /* first run */ }
  persist({
    id: "done", appId: "gitea", sandboxId: "sbx_done", state: "ENDED",
    createdAt: 1, lifetimeStartedAt: 1, expiresAt: 2, extended: false, settled: true,
    sizeCpu: 1, sizeMemMb: 2048,
  });
  const { runner } = harness();
  const killed: string[] = [];
  await runner.adoptOrphans(async (id) => { killed.push(id); });
  assert.deepEqual(killed, [], "a settled instance has already been paid for and killed");
});

test("a launched instance is written to disk before it is handed over", async () => {
  const { readAll, instanceLogPath } = await import("../src/orchestrator/store.ts");
  const { rmSync } = await import("node:fs");
  try { rmSync(instanceLogPath()); } catch { /* first run */ }
  const { runner } = harness();
  const inst = await runner.launch(APP);
  const rows = readAll().filter((r) => r.id === inst.id);
  assert.ok(rows.length > 0, "nothing was persisted, so a restart would lose it");
  assert.equal(rows[0]!.sandboxId, "sbx_1");
  assert.equal(rows[0]!.settled, false);
});

test("settling marks the row settled, so a restart leaves it alone", async () => {
  const { readAll } = await import("../src/orchestrator/store.ts");
  const { runner } = harness();
  const inst = await runner.launch(APP);
  await runner.end(inst, "expired");
  const row = readAll().find((r) => r.id === inst.id)!;
  assert.equal(row.settled, true);
});

test("the test suite never writes to the real instance log", async () => {
  // It did: 25 rows of fake sandbox ids, and the next server boot tried to kill
  // sandboxes named sbx_1. Setting the variable in one test file did not help,
  // because node --test gives each file its own process, so it is set for the
  // whole suite in package.json instead.
  const { instanceLogPath } = await import("../src/orchestrator/store.ts");
  const { homedir } = await import("node:os");
  const real = pathJoin(homedir(), ".blink", "instances.jsonl");
  assert.notEqual(instanceLogPath(), real,
    "BLINK_INSTANCE_LOG must be redirected for tests; check the test script in package.json");
});

test("the log path is read lazily, so it can be redirected at all", async () => {
  const { instanceLogPath } = await import("../src/orchestrator/store.ts");
  const before = instanceLogPath();
  process.env.BLINK_INSTANCE_LOG = "/tmp/blink-lazy-check.jsonl";
  assert.equal(instanceLogPath(), "/tmp/blink-lazy-check.jsonl",
    "a path captured at module load cannot be redirected by anything set afterwards");
  process.env.BLINK_INSTANCE_LOG = before;
});

test("a fresh instance's countdown is a real number, not zero", async () => {
  /*
   * A zero clock renders perfectly and is completely wrong.
   *
   * The toolbar shows every control and a timer reading 00:00, which looks like
   * an instance that has already been destroyed. Nothing errors, nothing logs,
   * and the page is indistinguishable from a correct one apart from four
   * characters. So the countdown is asserted as a quantity rather than as a
   * rendered string.
   */
  const { runner } = harness();
  const inst = await runner.launch(APP);

  assert.equal(inst.state, "HANDOVER", "the clock starts at HANDOVER (D4)");
  assert.notEqual(inst.lifetimeStartedAt, null, "lifetimeStartedAt must be set");
  assert.notEqual(inst.expiresAt, null, "expiresAt must be set");

  const left = runner.msRemaining(inst);
  assert.notEqual(left, null, "msRemaining must not be null, which the toolbar renders as 00:00");
  assert.ok(left! > 9 * 60_000,
    `a fresh instance had ${Math.round((left ?? 0) / 1000)}s left, which is not a fresh instance`);
  assert.ok(left! <= DEFAULT_LIFETIME_MS, "and no more than the lifetime it was given");
});

test("the boot script gets the lifetime in the second slot, not the first", async () => {
  // The old broken call was `blink-boot arm 660`, where 660 was the lifetime in
  // the second slot and "arm" was silently taken as the ROOT_URL. Fixing the
  // first argument must not shift the second.
  const { runner, calls } = harness();
  await runner.launch(APP);
  const boot = calls.execs.find((c) => c.includes("blink-boot "))!;
  const m = /blink-boot "([^"]*)" (\d+)/.exec(boot);
  assert.ok(m, `boot call did not parse: ${boot.slice(0, 80)}`);
  assert.ok(m![1]!.startsWith("http"), "slot one is the ROOT_URL");
  const secs = Number(m![2]);
  assert.ok(secs * 1000 > DEFAULT_LIFETIME_MS,
    `slot two is the lifetime and must outlive the server's, got ${secs}s`);
});
