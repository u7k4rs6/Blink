/**
 * Nothing reaches disk unredacted, through any writer.
 *
 * This test exists because redaction-by-discipline failed twice in one day:
 *
 *   1. `redact()` covered the query and header forms of the preview token but
 *      not the cookie form, and every gate report written before the fix carried
 *      the raw JWT to disk.
 *   2. Solari sandbox ids and browser session ids are long opaque strings that
 *      DECODE to a host pool identifier, a cloud instance id and the org id.
 *      They appear in the path of every request. No pattern could see them, and
 *      the sweep found them in all four stored gate reports.
 *
 * So the guarantee under test is not "the regex is right". It is "a value cannot
 * reach disk through a writer", which is the property that actually protects a
 * surface nobody thought about yet.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearSecrets, handleFor, redact, registerSecret } from "../src/redact.ts";
import { safeAppendFileSync, safeWriteFileSync, safeWriteJsonSync } from "../src/safe-io.ts";

const dir = () => mkdtempSync(join(tmpdir(), "blink-safeio-"));

// A JWT shaped exactly like __pt_preview but with invented contents.
const RAW_JWT = "eyJzYW5kYm94SWQiOiJGQUtFX0lOTkVSIiwib3JnSWQiOiJGQUtFX09SRyJ9.FAKESIGNATUREVALUE";
const RAW_AWSALB = "FAKESTICKYVALUE0123456789abcdefXYZ";

test("a raw JWT cannot reach disk through safeWriteFileSync", () => {
  const p = join(dir(), "report.md");
  safeWriteFileSync(p, `the cookie was __pt_preview=${RAW_JWT}; Path=/`);
  const onDisk = readFileSync(p, "utf8");
  assert.ok(!onDisk.includes(RAW_JWT), "raw JWT reached disk");
  assert.ok(!onDisk.includes("FAKESIGNATUREVALUE"));
  assert.match(onDisk, /REDACTED/);
});

test("a raw AWSALB value cannot reach disk through safeWriteFileSync", () => {
  const p = join(dir(), "report.md");
  safeWriteFileSync(p, `Set-Cookie: AWSALB=${RAW_AWSALB}; Expires=Thu, 10 Sep 2026`);
  const onDisk = readFileSync(p, "utf8");
  assert.ok(!onDisk.includes(RAW_AWSALB), "raw AWSALB value reached disk");
  assert.ok(onDisk.includes("AWSALB=REDACTED"));
});

test("neither reaches disk through safeWriteJsonSync, including when nested", () => {
  const p = join(dir(), "data.json");
  safeWriteJsonSync(p, {
    deep: { nested: [{ cookie: `__pt_preview=${RAW_JWT}` }, { alb: `AWSALB=${RAW_AWSALB}` }] },
  });
  const onDisk = readFileSync(p, "utf8");
  assert.ok(!onDisk.includes(RAW_JWT));
  assert.ok(!onDisk.includes(RAW_AWSALB));
});

test("neither reaches disk through safeAppendFileSync", () => {
  const p = join(dir(), "log.jsonl");
  safeAppendFileSync(p, `${RAW_JWT}\n`);
  safeAppendFileSync(p, `AWSALB=${RAW_AWSALB}\n`);
  const onDisk = readFileSync(p, "utf8");
  assert.ok(!onDisk.includes(RAW_JWT));
  assert.ok(!onDisk.includes(RAW_AWSALB));
});

test("a sandbox id in a request path is redacted, which is how it actually leaked", () => {
  // The real leak was 23 occurrences across four files, all in stored HTTP paths.
  const p = join(dir(), "attempts.json");
  safeWriteJsonSync(p, { attempts: [{ method: "POST", path: "/sandboxes/ZGVza3RvcC1wb29sLWktZmFrZWluc3RhbmNlOnZtXzk5OTk/snapshots" }] });
  const onDisk = readFileSync(p, "utf8");
  assert.ok(!onDisk.includes("ZGVza3RvcC1wb29s"), "host pool blob reached disk");
  assert.match(onDisk, /REDACTED_ID/);
});

test("an OPAQUE registered value is scrubbed even though no pattern matches it", () => {
  // This is the class regexes are structurally blind to: a 113-character session
  // id that looks like any other token but embeds the org id.
  clearSecrets();
  const opaque = "Zm9vYmFyYmF6cXV4LXNlc3Npb24taWRlbnRpZmllci13aXRoLW9yZy1pbnNpZGU";
  const before = redact(`session ${opaque} connected`);
  assert.ok(before.includes(opaque), "precondition: no pattern matches it");

  registerSecret(opaque);
  const p = join(dir(), "after.md");
  safeWriteFileSync(p, `session ${opaque} connected`);
  assert.ok(!readFileSync(p, "utf8").includes(opaque), "registered secret reached disk");
  clearSecrets();
});

test("registerSecret ignores short values, so reports stay readable", () => {
  clearSecrets();
  registerSecret("ok");
  registerSecret("g5");
  assert.equal(redact("g5 result ok"), "g5 result ok");
  clearSecrets();
});

test("handleFor is stable and non-reversible, so tiles stay distinguishable", () => {
  const a = handleFor("session-aaaaaaaaaaaaaaaaaaaa");
  const b = handleFor("session-bbbbbbbbbbbbbbbbbbbb");
  assert.equal(a, handleFor("session-aaaaaaaaaaaaaaaaaaaa"));
  assert.notEqual(a, b);
  assert.ok(!a.includes("session"));
  assert.match(a, /^id_/);
});

// ---------------------------------------------------------------------------
// Connection strings.
//
// DATABASE_URL is the highest-value secret this process now holds: it is
// standing write access to the production store, it does not expire, and unlike
// the preview token it cannot be revoked by waiting.
// ---------------------------------------------------------------------------

const FAKE_CONN = "postgresql://postgres.abcdefghijklmnop:S3cr3tPassw0rd@aws-0-us-west-1.pooler.supabase.com:6543/postgres";

test("a connection string cannot reach disk through any writer", () => {
  const p = join(dir(), "report.md");
  safeWriteFileSync(p, `connecting with ${FAKE_CONN} now`);
  const onDisk = readFileSync(p, "utf8");
  assert.ok(!onDisk.includes("S3cr3tPassw0rd"), "the password reached disk");
  assert.ok(!onDisk.includes("abcdefghijklmnop"), "the project ref reached disk");
  assert.ok(!onDisk.includes("pooler.supabase.com"), "the host reached disk");
  assert.match(onDisk, /REDACTED/);
});

test("a connection string is redacted inside nested JSON too", () => {
  const p = join(dir(), "data.json");
  safeWriteJsonSync(p, { config: { db: { url: FAKE_CONN } }, note: "ok" });
  const onDisk = readFileSync(p, "utf8");
  assert.ok(!onDisk.includes("S3cr3tPassw0rd"));
  assert.ok(onDisk.includes("ok"), "surrounding content survives");
});

test("userinfo in any URL scheme is redacted, not just postgres", () => {
  const out = redact("redis://user:hunter2@cache.internal:6379/0");
  assert.ok(!out.includes("hunter2"));
  assert.match(out, /REDACTED_CREDENTIALS@/);
});

test("a bare supabase host is redacted even with no credentials attached", () => {
  const out = redact("host is db.ghrkojmqkliuedmcqydx.supabase.co and that is all");
  assert.ok(!out.includes("ghrkojmqkliuedmcqydx"), "the project ref identifies the project");
  assert.match(out, /REDACTED_HOST/);
});

test("an ordinary https URL is left alone, so reports stay readable", () => {
  const url = "https://docs.getsolari.com/sandboxes";
  assert.equal(redact(url), url);
});
