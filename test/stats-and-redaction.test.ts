/** Percentiles, and the redaction that keeps pt_token out of durable artifacts. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { percentile, stats } from "../scripts/gates/lib/stats.ts";
import { redact } from "../scripts/gates/lib/report.ts";
import { previewHealthUrl } from "../scripts/gates/lib/health.ts";

test("percentiles are nearest-rank, so every number reported was measured", () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(s, 50), 5);
  assert.equal(percentile(s, 95), 10);
  assert.equal(percentile(s, 100), 10);
  // No interpolation: 5 is in the data, 5.5 would not be.
  assert.ok(s.includes(percentile(s, 50)));
});

test("stats over 20 samples, the G1 sample size", () => {
  const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
  const st = stats(values);
  assert.equal(st.n, 20);
  assert.equal(st.min, 100);
  assert.equal(st.max, 2000);
  assert.equal(st.p50, 1000);
  assert.equal(st.p95, 1900);
});

test("empty input does not throw, it reports n=0", () => {
  const st = stats([]);
  assert.equal(st.n, 0);
  assert.ok(Number.isNaN(st.p50));
});

test("pt_token is redacted from every artifact", () => {
  const s = "https://sbx-abc-3000.preview.getsolari.com/?pt_token=secret123abc&x=1";
  const out = redact(s);
  assert.ok(!out.includes("secret123abc"), "the bearer capability must never reach a report");
  assert.ok(out.includes("pt_token=REDACTED"));
  assert.ok(out.includes("x=1"), "other query parameters survive, so the URL stays debuggable");
});

test("the api key is redacted too", () => {
  const out = redact("Authorization: Bearer slr_live_abc123DEF456");
  assert.ok(!out.includes("abc123DEF456"));
  assert.ok(out.includes("slr_live_REDACTED"));
});

test("previewHealthUrl preserves the token when swapping the path", () => {
  // Doing this with `new URL(path, base)` silently drops the query and every
  // request 401s, which is a confusing failure to debug.
  const preview = "https://sbx-abc-3000.preview.getsolari.com/?pt_token=tok123";
  const url = previewHealthUrl(preview, "/api/healthz");
  assert.ok(url.includes("/api/healthz"));
  assert.ok(url.includes("pt_token=tok123"), "the token must survive the path swap");
});

// ---------------------------------------------------------------------------
// The preview capability travels in four forms. An earlier version of redact()
// caught two, and the cookie form (which decodes to Solari's internal host and
// VM identifiers plus the org id) passed through durable artifacts untouched.
// ---------------------------------------------------------------------------

test("the __pt_preview cookie form is redacted, not just the URL form", () => {
  const line = "Set-Cookie: __pt_preview=eyJzYW5kYm94SWQiOiJuZXN0ZWQifQ.SIGPART; Path=/; HttpOnly";
  const out = redact(line);
  assert.ok(!out.includes("eyJzYW5kYm94SWQ"), "the JWT decodes without a key and must never reach an artifact");
  assert.ok(!out.includes("SIGPART"));
  assert.ok(out.includes("__pt_preview=REDACTED"));
  assert.ok(out.includes("HttpOnly"), "surrounding attributes stay, so the record is still readable");
});

test("AWS load-balancer stickiness cookies are redacted too", () => {
  const out = redact("Set-Cookie: AWSALB=STICKYVALUE123; Expires=Thu, 10 Sep 2026; Path=/");
  assert.ok(!out.includes("STICKYVALUE123"));
  assert.ok(out.includes("AWSALB=REDACTED"));
  const cors = redact("AWSALBCORS=OTHERVALUE456; SameSite=None");
  assert.ok(!cors.includes("OTHERVALUE456"));
});

test("all four capability forms are covered in one pass", () => {
  const blob = [
    "https://h-8099.preview.getsolari.com/?pt_token=AAA",
    "x-pinetree-preview-token: BBB",
    "__pt_preview=CCC; Path=/",
    "AWSALB=DDD",
    "Bearer slr_live_EEE",
  ].join("\n");
  const out = redact(blob);
  for (const secret of ["AAA", "BBB", "CCC", "DDD", "EEE"]) {
    assert.ok(!out.includes(secret), `${secret} survived redaction`);
  }
});
