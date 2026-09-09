import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyTurnstile } from "../src/turnstile/verify.ts";

const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as never;
const throwingFetch = (name: string): typeof fetch =>
  (async () => { const e = new Error("boom"); e.name = name; throw e; }) as never;

test("a valid token passes", async () => {
  const r = await verifyTurnstile("tok", "1.2.3.4", { secret: "s", fetchImpl: fakeFetch(200, { success: true }) });
  assert.deepEqual(r, { ok: true });
});

test("a rejected token is refused, with the error codes kept", async () => {
  const r = await verifyTurnstile("tok", undefined, {
    secret: "s", fetchImpl: fakeFetch(200, { success: false, "error-codes": ["invalid-input-response"] }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "rejected");
  assert.match(r.ok === false ? r.detail! : "", /invalid-input-response/);
});

test("a missing token is refused without contacting Cloudflare", async () => {
  let called = false;
  const spy: typeof fetch = (async () => { called = true; return new Response("{}"); }) as never;
  const r = await verifyTurnstile(null, undefined, { secret: "s", fetchImpl: spy });
  assert.equal(r.ok === false && r.reason, "missing_token");
  assert.equal(called, false, "no point paying a round trip for an absent token");
});

test("a missing secret REFUSES rather than skipping the check", async () => {
  // Otherwise a misconfigured deploy silently disables the control on the one
  // path that spends money.
  const r = await verifyTurnstile("tok", undefined, { secret: "" });
  assert.equal(r.ok === false && r.reason, "misconfigured");
});

test("an unreachable Cloudflare FAILS CLOSED", async () => {
  // Failing open would make the control removable by anyone who can cause a
  // timeout, which is a strictly easier attack than solving the challenge.
  for (const name of ["TimeoutError", "TypeError", "AbortError"]) {
    const r = await verifyTurnstile("tok", undefined, { secret: "s", fetchImpl: throwingFetch(name) });
    assert.equal(r.ok, false, `${name} must not pass`);
    assert.equal(r.ok === false && r.reason, "unreachable");
  }
});

test("a non-200 from Cloudflare fails closed too", async () => {
  const r = await verifyTurnstile("tok", undefined, { secret: "s", fetchImpl: fakeFetch(503, {}) });
  assert.equal(r.ok === false && r.reason, "unreachable");
});

test("verification is a single attempt, never retried", async () => {
  let calls = 0;
  const counting: typeof fetch = (async () => { calls += 1; throw new Error("down"); }) as never;
  await verifyTurnstile("tok", undefined, { secret: "s", fetchImpl: counting });
  assert.equal(calls, 1, "there is no retry loop anywhere in this codebase");
});
