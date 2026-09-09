/**
 * Structural INCONCLUSIVE.
 *
 * Two false passes appeared in a single live pass, from different causes:
 *
 *   G5  streamed zero frames and reported "Within the section 7 prediction",
 *       because the threshold was `kbPerS <= 720 * 1.5` and zero satisfies it.
 *   G6  never reached its egress test and reported "egress denial DID NOT work",
 *       turning "we learned nothing" into a negative finding.
 *
 * Two in one pass is a pattern, so the rule is enforced by the runner and cannot
 * be forgotten by a gate author. These tests are the guarantee.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { enforceMinimum } from "../scripts/gates/lib/harness.ts";

test("a zero-sample G5 comes back INCONCLUSIVE, not a pass", () => {
  const out = enforceMinimum(
    { verdict: "12/12 tiles streamed. Within the section 7 prediction of about 720 KB/s.", observations: 0 },
    { id: "g5", minObservations: 12, observationUnit: "screencast frame" },
  );
  assert.equal(out.inconclusive, true);
  assert.match(out.verdict, /^INCONCLUSIVE\./);
  assert.match(out.verdict, /0 screencast frames/);
  // The original claim is preserved but explicitly withheld, not silently dropped.
  assert.match(out.verdict, /withheld/);
  assert.match(out.verdict, /Within the section 7 prediction/);
});

test("a never-executed G6 comes back INCONCLUSIVE, not a negative finding", () => {
  const out = enforceMinimum(
    { verdict: "Guest-side egress denial DID NOT work as specified.", observations: 1 },
    { id: "g6", minObservations: 5, observationUnit: "decided step" },
  );
  assert.equal(out.inconclusive, true);
  assert.match(out.verdict, /^INCONCLUSIVE\./);
  assert.match(out.verdict, /1 decided step,/);
  assert.match(out.verdict, /below its declared minimum of 5/);
});

test("an empty result set is inconclusive even when the gate is happy", () => {
  const out = enforceMinimum(
    { verdict: "All checks passed.", observations: 0 },
    { id: "g2", minObservations: 1, observationUnit: "app reached behind previewUrl" },
  );
  assert.equal(out.inconclusive, true);
  assert.match(out.verdict, /not a conclusion/);
});

test("meeting the minimum passes the gate's own verdict through untouched", () => {
  const v = "Overrun returned 429 ConcurrencyLimitExceeded in 250 ms.";
  const out = enforceMinimum(
    { verdict: v, observations: 1 },
    { id: "g7", minObservations: 1, observationUnit: "captured overrun response" },
  );
  assert.equal(out.inconclusive, false);
  assert.equal(out.verdict, v);
  assert.equal(out.reason, null);
});

test("exceeding the minimum also passes through", () => {
  const out = enforceMinimum(
    { verdict: "Minted 5/5 snapshots.", observations: 5 },
    { id: "g4", minObservations: 2, observationUnit: "snapshot minted" },
  );
  assert.equal(out.inconclusive, false);
});

test("singular and plural units read correctly, since the verdict is published", () => {
  const one = enforceMinimum(
    { verdict: "x", observations: 1 },
    { id: "g6", minObservations: 5, observationUnit: "decided step" },
  );
  assert.match(one.verdict, /1 decided step,/);
  const zero = enforceMinimum(
    { verdict: "x", observations: 0 },
    { id: "g6", minObservations: 5, observationUnit: "decided step" },
  );
  assert.match(zero.verdict, /0 decided steps,/);
});
