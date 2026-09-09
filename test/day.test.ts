/**
 * "day" means UTC, everywhere, and the process asserts it at startup.
 *
 * A `date` column parsed by node-pg becomes a JS Date at LOCAL midnight, and
 * formatting that with toISOString() shifted the day backwards by one for the
 * first 5.5 hours of every day in IST. It was correct in the REST probe, correct
 * in the memory store, and wrong only in the real driver in the real timezone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DayBoundaryMismatch, assertUtcDayBoundary, utcDay, utcDayStart } from "../src/day.ts";

test("utcDay is the UTC calendar day, not the local one", () => {
  // 2026-09-04T01:00Z is still 2026-09-04 in UTC but already the 4th at 06:30
  // in IST, and would be the 3rd at 21:00 in US Pacific. Only UTC is stable.
  assert.equal(utcDay(new Date("2026-09-04T01:00:00Z")), "2026-09-04");
  assert.equal(utcDay(new Date("2026-09-04T23:59:59Z")), "2026-09-04");
  assert.equal(utcDay(new Date("2026-09-05T00:00:00Z")), "2026-09-05");
});

test("the boundary is exactly UTC midnight", () => {
  assert.equal(utcDayStart("2026-09-04").toISOString(), "2026-09-04T00:00:00.000Z");
});

test("a non-UTC process is rejected at startup, with the reason", () => {
  const shifted = new Date("2026-09-04T12:00:00Z");
  // Simulate IST: getTimezoneOffset returns -330 for UTC+05:30.
  Object.defineProperty(shifted, "getTimezoneOffset", { value: () => -330 });
  assert.throws(() => assertUtcDayBoundary(shifted), DayBoundaryMismatch);
  try {
    assertUtcDayBoundary(shifted);
  } catch (e) {
    const m = (e as Error).message;
    assert.match(m, /local midnight is not UTC midnight/);
    assert.match(m, /TZ=UTC/);
    assert.match(m, /resets early rather than an error/, "the symptom must be described, not just the cause");
  }
});

test("a UTC process passes", () => {
  const utc = new Date("2026-09-04T12:00:00Z");
  Object.defineProperty(utc, "getTimezoneOffset", { value: () => 0 });
  Object.defineProperty(utc, "getFullYear", { value: () => 2026 });
  Object.defineProperty(utc, "getMonth", { value: () => 8 });
  Object.defineProperty(utc, "getDate", { value: () => 4 });
  assert.doesNotThrow(() => assertUtcDayBoundary(utc));
});
