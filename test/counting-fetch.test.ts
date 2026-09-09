/**
 * The two load-bearing tests from 00-verification.md C-2.
 *
 * These run against the REAL SDK with a fake fetch, because the thing being
 * pinned is the SDK's retry behaviour, not ours. The SDK's own file-header
 * comment in http.js claims 429 is retried, and the code twenty lines below it
 * excludes 429. The code is right. If a future SDK bump changes that, these fail
 * before a single credit is spent, which is the whole point of pinning the
 * version in the lockfile.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SandboxClient } from "@solarisdk/sandbox";
import { BudgetGuard, GuardBug } from "../src/guard/guard.ts";
import { SandboxLedger } from "../src/guard/ledger.ts";
import { PLANS } from "../src/guard/rates.ts";
import { CAPS_DEFAULT, CAPS_GATES, createCountingFetch } from "../src/solari/fetch.ts";
import { SolariAdapter } from "../src/solari/adapter.ts";
import { errorStep, fakeFetch, fixtures } from "../src/solari/fixtures.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "https://api.getsolari.test";

function harness(caps: typeof CAPS_GATES, script: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(script);
  const counting = createCountingFetch({ caps, deadlineSignal: undefined });
  // Route the counting fetch at the fake instead of the network.
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  const client = new SandboxClient({ apiKey: "slr_live_test", baseUrl: BASE, fetch: counting.fetch });
  const restore = () => { globalThis.fetch = original; };
  return { fake, counting, client, restore };
}

test("a 429 produces exactly one attempt, and is never retried", async () => {
  const { fake, counting, client, restore } = harness(CAPS_GATES, [errorStep("concurrency429")]);
  try {
    await assert.rejects(
      () => counting.call("create", "create", () => client.create({ template: "base" })),
      (err: unknown) => (err as { status?: number }).status === 429,
    );
  } finally {
    restore();
  }
  assert.equal(fake.calls.length, 1, "429 must reach the wire exactly once, with no retry");
  assert.equal(counting.log.length, 1);
  assert.equal(counting.log[0]!.status, 429);
});

test("a 429 is still exactly one attempt under production caps", async () => {
  const { fake, counting, client, restore } = harness(CAPS_DEFAULT, [errorStep("concurrency429")]);
  try {
    await assert.rejects(() => counting.call("create", "create", () => client.create({ template: "base" })));
  } finally {
    restore();
  }
  assert.equal(fake.calls.length, 1, "create's retry allowance must never apply to a 429");
});

test("a 503 produces the documented retry count: zero retries under gate caps", async () => {
  // CAPS_GATES.create is 0, so exactly one attempt reaches the wire. This is
  // what makes G1 measure real latency rather than a retried one.
  const { fake, counting, client, restore } = harness(CAPS_GATES, [errorStep("noCapacity503")]);
  try {
    await assert.rejects(() => counting.call("create", "create", () => client.create({ template: "base" })));
  } finally {
    restore();
  }
  assert.equal(fake.calls.length, 1, "gate caps allow zero retries");
});

test("a 503 produces the documented retry count: one retry under production caps", async () => {
  // CAPS_DEFAULT.create is 1, because create carries an Idempotency-Key and so
  // one 503 retry is safe and worth having. The SDK would otherwise make six.
  const { fake, counting, client, restore } = harness(CAPS_DEFAULT, [errorStep("noCapacity503")]);
  try {
    await assert.rejects(() => counting.call("create", "create", () => client.create({ template: "base" })));
  } finally {
    restore();
  }
  assert.equal(fake.calls.length, 2, "production caps allow exactly one retry of create, not the SDK's five");
});

test("create still sends an Idempotency-Key, which is why one retry is safe", async () => {
  const { fake, counting, client, restore } = harness(CAPS_GATES, [
    { status: 200, body: fixtures.createSandbox },
  ]);
  try {
    await counting.call("create", "create", () => client.create({ template: "base" }));
  } finally {
    restore();
  }
  assert.ok(fake.calls[0]!.headers["idempotency-key"], "SDK must still send Idempotency-Key on create");
});

test("the adapter turns a 429 into a GuardBug carrying the slot state", async () => {
  const fake = fakeFetch([errorStep("concurrency429")]);
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    const counting = createCountingFetch({ caps: CAPS_GATES });
    const guard = new BudgetGuard(PLANS.starter, 1);
    const ledger = new SandboxLedger(join(tmpdir(), `blink-test-${Date.now()}.jsonl`));
    const adapter = new SolariAdapter({ counting, guard, ledger, baseUrl: BASE });

    await assert.rejects(
      () => adapter.createSandbox("slr_live_test", "test", { template: "base" }, 0.001),
      (err: unknown) => {
        assert.ok(err instanceof GuardBug, "a 429 must surface as a GuardBug, not as a condition to handle");
        assert.equal(err.slotState.maxSandboxes, 2);
        assert.ok(err.message.includes("never retried"));
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(fake.calls.length, 1);
});
