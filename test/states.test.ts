/**
 * The invariant is stronger than reachability.
 *
 *   NOT  "every billing state can reach ENDED"
 *   BUT  "no billing state can persist longer than its bound"
 *
 * The weak version is satisfied by a path that reaches ENDED eventually while
 * billing the whole way. That is what a busy day looks like: every transition
 * legal, the loop merely slow.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BILLING_STATES, MAX_BILLING_UNUSABLE_MS, MAX_STATE_MS, TRANSITIONS,
  URL_PENDING_TIMEOUT_MS, isTerminal, next, type LaunchState,
} from "../src/orchestrator/states.ts";

test("every billing state except LIVE has a bounded residency", () => {
  for (const s of BILLING_STATES) {
    if (s === "LIVE") continue; // bounded by instance lifetime instead
    assert.ok(MAX_STATE_MS[s] !== undefined, `${s} bills with no deadline`);
    assert.ok(MAX_STATE_MS[s]! > 0);
  }
});

test("every state with a deadline can act on breaching it", () => {
  for (const s of Object.keys(MAX_STATE_MS) as LaunchState[]) {
    assert.ok(next(s, "STATE_DEADLINE_EXCEEDED"), `${s} has a deadline but no transition out of it`);
  }
});

test("the billing-but-unusable region is bounded jointly, not just per step", () => {
  // Both halves must be able to trip the joint budget, or a slow loop between
  // them escapes by never exhausting either individual timer.
  assert.ok(next("READY", "UNUSABLE_BUDGET_EXHAUSTED"));
  assert.ok(next("URL_PENDING", "UNUSABLE_BUDGET_EXHAUSTED"));
  assert.equal(next("READY", "UNUSABLE_BUDGET_EXHAUSTED")!.to, "ENDING");
  assert.equal(next("URL_PENDING", "UNUSABLE_BUDGET_EXHAUSTED")!.to, "ENDING");
});

test("the joint bound is at least as large as the single step it contains", () => {
  assert.ok(MAX_BILLING_UNUSABLE_MS >= URL_PENDING_TIMEOUT_MS,
    "a joint bound smaller than its own sub-step would make the sub-step unreachable");
});

test("every billing state still reaches ENDED", () => {
  const reach = (s: LaunchState, seen = new Set<string>()): boolean => {
    if (s === "ENDED") return true;
    if (seen.has(s)) return false;
    seen.add(s);
    return TRANSITIONS.filter((t) => t.from === s).some((t) => reach(t.to, seen));
  };
  for (const s of BILLING_STATES) assert.ok(reach(s), `${s} bills and cannot reach ENDED`);
});

test("terminal states have no outgoing transitions", () => {
  for (const t of TRANSITIONS) assert.ok(!isTerminal(t.from), `${t.from} is terminal but has an exit`);
});

test("the timeouts are configuration, since 80 samples is not a distribution", () => {
  // Reading them from env is the point: the day-7 soak may move them.
  assert.equal(typeof URL_PENDING_TIMEOUT_MS, "number");
  assert.ok(Number.isFinite(MAX_BILLING_UNUSABLE_MS));
});
