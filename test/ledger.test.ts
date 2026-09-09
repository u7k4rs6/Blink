/**
 * The ledger is the leak detector. thrice lost sandboxes twice, both times
 * because the process that owned them died without running a handler, which is
 * why this is on disk rather than in memory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SandboxLedger } from "../src/guard/ledger.ts";

function freshLedger() {
  const dir = mkdtempSync(join(tmpdir(), "blink-ledger-"));
  return new SandboxLedger(join(dir, "sandboxes.jsonl"));
}

test("an opened sandbox is open until it is closed", () => {
  const l = freshLedger();
  l.opened("sbx_a", "g1");
  assert.deepEqual(l.openIds(), ["sbx_a"]);
  l.closed("sbx_a");
  assert.deepEqual(l.openIds(), []);
});

test("intent is recorded before the create, so a timed-out create is still findable", () => {
  const l = freshLedger();
  const token = l.intent("g1", "cold fork");
  assert.ok(token.startsWith("intent-"));
  // Intent alone does not mark anything open: there is no id yet to kill.
  assert.deepEqual(l.openIds(), []);
});

test("the ledger survives a new process reading the same file", () => {
  const l1 = freshLedger();
  l1.opened("sbx_leaked", "g1");
  // A second reader, standing in for `npm run sweep` after a SIGKILL.
  const l2 = new SandboxLedger(l1.path);
  assert.deepEqual(l2.openIds(), ["sbx_leaked"], "a leak must outlive the process that caused it");
});

test("duplicate opens do not produce duplicate ids", () => {
  const l = freshLedger();
  l.opened("sbx_a", "g1");
  l.opened("sbx_a", "g1");
  assert.deepEqual(l.openIds(), ["sbx_a"]);
});

test("a malformed line does not break the reader", () => {
  const l = freshLedger();
  l.opened("sbx_a", "g1");
  appendFileSync(l.path, "this is not json\n");
  l.opened("sbx_b", "g1");
  assert.deepEqual(l.openIds(), ["sbx_a", "sbx_b"]);
});

// ---------------------------------------------------------------------------
// The ledger is the ONE file exempt from redaction, because it must hold real
// sandbox ids or every recovery sweep becomes a no-op. That exemption is
// justified entirely by where the file lives, so the location is checked rather
// than assumed: a stray copy into the repo during a rushed day would publish
// unredacted infrastructure identifiers to a public remote.
// ---------------------------------------------------------------------------

import { assertOutsideRepo, LedgerInsideRepo } from "../src/guard/ledger.ts";
import { resolve } from "node:path";

test("a ledger path inside the repository is refused at construction", () => {
  assert.throws(() => new SandboxLedger(resolve("docs/gates/data/leaked.jsonl")), LedgerInsideRepo);
  assert.throws(() => new SandboxLedger(resolve("sandboxes.jsonl")), LedgerInsideRepo);
  assert.throws(() => new SandboxLedger(resolve("tmp/nested/deep.jsonl")), LedgerInsideRepo);
});

test("the refusal explains why, since the next reader will be in a hurry", () => {
  try {
    assertOutsideRepo(resolve("ledger.jsonl"));
    assert.fail("should have thrown");
  } catch (err) {
    const m = (err as Error).message;
    assert.match(m, /UNREDACTED sandbox ids/);
    assert.match(m, /outside the repo/);
    assert.match(m, /BLINK_LEDGER/);
  }
});

test("a path outside the repository is accepted", () => {
  assert.doesNotThrow(() => assertOutsideRepo(join(tmpdir(), "blink", "sandboxes.jsonl")));
  assert.doesNotThrow(() => assertOutsideRepo("/home/someone/.blink/sandboxes.jsonl"));
});

test("sweep results identify sandboxes by handle, never by a raw prefix", async () => {
  // A 16-character prefix of a sandbox id is exactly base64("desktop-pool"),
  // so truncation was itself a disclosure.
  const l = freshLedger();
  l.opened("ZGVza3RvcC1wb29sLWktZmFrZTp2bV85OTk5", "g1");
  assert.deepEqual(l.openIds(), ["ZGVza3RvcC1wb29sLWktZmFrZTp2bV85OTk5"], "the ledger itself keeps the real id");
  // but nothing it reports for display carries the prefix
  const { handleFor } = await import("../src/redact.ts");
  assert.ok(!handleFor("ZGVza3RvcC1wb29sLWktZmFrZTp2bV85OTk5").includes("ZGVza3RvcC"));
});
