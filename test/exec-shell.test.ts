/**
 * Regression test for the bug the first live gate run found.
 *
 * The SDK's `commands.run(cmd)` runs the program directly, NOT via a shell. Its
 * own type comment says so: "the guest runs `cmd` with these, NOT via a shell.
 * For shell syntax use `run("sh", { args: ["-c", "..."] })`."
 *
 * Three gates used shell syntax and got three different wrong answers from one
 * cause. This pins the wrapping so it cannot regress.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BudgetGuard } from "../src/guard/guard.ts";
import { SandboxLedger } from "../src/guard/ledger.ts";
import { PLANS } from "../src/guard/rates.ts";
import { CAPS_GATES, createCountingFetch } from "../src/solari/fetch.ts";
import { SolariAdapter } from "../src/solari/adapter.ts";

function adapterAndSpy() {
  const dir = mkdtempSync(join(tmpdir(), "blink-exec-"));
  const adapter = new SolariAdapter({
    counting: createCountingFetch({ caps: CAPS_GATES }),
    guard: new BudgetGuard(PLANS.starter, 1),
    ledger: new SandboxLedger(join(dir, "l.jsonl")),
  });
  const seen: Array<{ cmd: string; opts: { args?: string[] } | undefined }> = [];
  const fakeSandbox = {
    sandboxId: "sbx_fake",
    commands: {
      run: async (cmd: string, opts?: { args?: string[] }) => {
        seen.push({ cmd, opts });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
  };
  return { adapter, seen, fakeSandbox };
}

test("exec wraps every command in sh -c, so shell syntax actually works", async () => {
  const { adapter, seen, fakeSandbox } = adapterAndSpy();
  const cmd = "mkdir -p /tmp/x && echo hi > /tmp/x/f || echo FAILED";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await adapter.exec("k", fakeSandbox as any, "test", cmd);

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.cmd, "sh", "the program must be sh, not the whole command line");
  assert.deepEqual(seen[0]!.opts?.args, ["-c", cmd], "the command must be passed as -c");
});

test("execRaw does NOT wrap, for when args are untrusted", async () => {
  const { adapter, seen, fakeSandbox } = adapterAndSpy();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await adapter.execRaw("k", fakeSandbox as any, "test", "curl", ["-s", "https://example.com"]);

  assert.equal(seen[0]!.cmd, "curl");
  assert.deepEqual(seen[0]!.opts?.args, ["-s", "https://example.com"]);
});

test("a command containing shell metacharacters is never passed as the program name", async () => {
  const { adapter, seen, fakeSandbox } = adapterAndSpy();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await adapter.exec("k", fakeSandbox as any, "test", "a || b");
  assert.ok(!seen[0]!.cmd.includes("||"), "this is exactly what broke G6, G4 and G5");
});
