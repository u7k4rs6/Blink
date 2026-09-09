/**
 * The billing ledger. Tests written BEFORE the implementation, deliberately.
 *
 * The rule that orders this work: a wrong launch costs a visitor ten seconds; a
 * wrong ledger costs the month. There is no Solari endpoint that reports balance
 * or usage (00-verification.md V55), so this ledger is the ONLY running account
 * of what has been spent, and D10 puts its output on a public page. It has no
 * upstream to reconcile against except a human reading the console.
 *
 * That makes three properties load-bearing, and each has tests here:
 *
 *   CONSERVATIVE   An unsettled reservation counts in full against ceilings.
 *                  Forgetting to settle must overcount, never undercount.
 *   DURABLE        Reservations survive a process restart, because the process
 *                  can die between the reserve and the Solari call.
 *   HONEST         Every row records whether its seconds were measured or
 *                  modelled, and the split survives settlement.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { BillingLedger, CeilingExceeded, MemoryLedgerStore } from "../src/billing/ledger.ts";
import { PLANS, SIZE_SMALL } from "../src/guard/rates.ts";

const DAY = "2026-09-04";
const plan = PLANS.starter;

function ledger(store = new MemoryLedgerStore()) {
  return {
    store,
    ledger: new BillingLedger({
      store,
      plan,
      ceilings: {
        // Deliberately small, so tests exercise refusal rather than arithmetic.
        global: { sandboxSeconds: 1000, browserSeconds: 500 },
        ip: { sandboxSeconds: 300, browserSeconds: 200 },
        launch: { sandboxSeconds: 120, browserSeconds: 60 },
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// CONSERVATIVE
// ---------------------------------------------------------------------------

test("an unsettled reservation counts in full against the ceiling", async () => {
  const { ledger: l } = ledger();
  await l.reserve({ day: DAY, scope: "ip", key: "ip_a", sandboxSeconds: 200, size: SIZE_SMALL });
  // 200 reserved of a 300 ceiling. A second 200 must be refused even though
  // nothing has actually been spent yet.
  await assert.rejects(
    () => l.reserve({ day: DAY, scope: "ip", key: "ip_a", sandboxSeconds: 200, size: SIZE_SMALL }),
    CeilingExceeded,
  );
});

test("settling for less than reserved releases the difference", async () => {
  const { ledger: l } = ledger();
  const r = await l.reserve({ day: DAY, scope: "ip", key: "ip_a", sandboxSeconds: 200, size: SIZE_SMALL });
  await l.settle(r, { sandboxSeconds: 30, size: SIZE_SMALL, measured: true });
  // 30 actually spent, so a 200 reservation now fits under the 300 ceiling.
  await assert.doesNotReject(
    () => l.reserve({ day: DAY, scope: "ip", key: "ip_a", sandboxSeconds: 200, size: SIZE_SMALL }),
  );
});

test("settling for MORE than reserved is recorded, not clamped", async () => {
  // An instance that overran must show its real cost. Clamping to the
  // reservation would make the ledger lie in the one direction that matters.
  const { ledger: l } = ledger();
  const r = await l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 100, size: SIZE_SMALL });
  await l.settle(r, { sandboxSeconds: 450, size: SIZE_SMALL, measured: true });
  const spent = await l.spent(DAY, "global", "*");
  assert.equal(spent.sandboxSeconds, 450);
});

test("a refusal is thrown before anything is recorded, so it costs nothing", async () => {
  const { ledger: l, store } = ledger();
  await assert.rejects(
    () => l.reserve({ day: DAY, scope: "launch", key: "ins_1", sandboxSeconds: 5000, size: SIZE_SMALL }),
    CeilingExceeded,
  );
  assert.equal((await store.all()).length, 0, "a refused reservation must leave no row");
});

// ---------------------------------------------------------------------------
// DURABLE
// ---------------------------------------------------------------------------

test("reservations survive a process restart", async () => {
  const store = new MemoryLedgerStore();
  const a = ledger(store).ledger;
  await a.reserve({ day: DAY, scope: "ip", key: "ip_a", sandboxSeconds: 250, size: SIZE_SMALL });

  // A new ledger over the same store, standing in for a restarted process.
  const b = ledger(store).ledger;
  await assert.rejects(
    () => b.reserve({ day: DAY, scope: "ip", key: "ip_a", sandboxSeconds: 100, size: SIZE_SMALL }),
    CeilingExceeded,
    "a restart must not forget what was already reserved",
  );
});

test("reservations orphaned by a crash are settled at their estimate and marked modelled", async () => {
  const store = new MemoryLedgerStore();
  const a = ledger(store).ledger;
  const r = await a.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 90, size: SIZE_SMALL });
  store.ageReservation(r, 3600_000); // an hour old, nothing settled it

  const b = ledger(store).ledger;
  const swept = await b.sweepOrphans({ olderThanMs: 1800_000 });
  assert.equal(swept.length, 1);
  const spent = await b.spent(DAY, "global", "*");
  assert.equal(spent.sandboxSeconds, 90, "the estimate stands in for the unknown real cost");
  assert.equal(spent.measuredUsd, 0);
  assert.ok(spent.modelledUsd > 0, "an orphan is modelled, never measured");
});

// ---------------------------------------------------------------------------
// HONEST
// ---------------------------------------------------------------------------

test("the measured and modelled split survives settlement", async () => {
  const { ledger: l } = ledger();
  const a = await l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 60, size: SIZE_SMALL });
  const b = await l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 60, size: SIZE_SMALL });
  await l.settle(a, { sandboxSeconds: 60, size: SIZE_SMALL, measured: true });
  await l.settle(b, { sandboxSeconds: 60, size: SIZE_SMALL, measured: false });

  const s = await l.spent(DAY, "global", "*");
  assert.equal(Math.round(s.measuredUsd * 1e6), Math.round(s.modelledUsd * 1e6));
  assert.equal(s.measuredFraction, 0.5);
});

test("a ledger with nothing in it reports fully measured, not NaN", async () => {
  const { ledger: l } = ledger();
  const s = await l.spent(DAY, "global", "*");
  assert.equal(s.usd, 0);
  assert.equal(s.measuredFraction, 1);
});

// ---------------------------------------------------------------------------
// SCOPES AND DAYS
// ---------------------------------------------------------------------------

test("scopes are independent: an IP at its ceiling does not block another IP", async () => {
  const { ledger: l } = ledger();
  await l.reserve({ day: DAY, scope: "ip", key: "ip_a", sandboxSeconds: 300, size: SIZE_SMALL });
  await assert.rejects(() => l.reserve({ day: DAY, scope: "ip", key: "ip_a", sandboxSeconds: 1, size: SIZE_SMALL }));
  await assert.doesNotReject(() => l.reserve({ day: DAY, scope: "ip", key: "ip_b", sandboxSeconds: 300, size: SIZE_SMALL }));
});

test("a per-day scope resets on the next day", async () => {
  const { ledger: l } = ledger();
  await l.reserve({ day: DAY, scope: "ip", key: "ip_a", sandboxSeconds: 300, size: SIZE_SMALL });
  await assert.doesNotReject(
    () => l.reserve({ day: "2026-09-05", scope: "ip", key: "ip_a", sandboxSeconds: 300, size: SIZE_SMALL }),
  );
});

test("the global scope sees spend from every IP", async () => {
  const { ledger: l } = ledger();
  for (const ip of ["a", "b", "c"]) {
    const r = await l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 300, size: SIZE_SMALL });
    await l.settle(r, { sandboxSeconds: 300, size: SIZE_SMALL, measured: true });
    void ip;
  }
  const s = await l.spent(DAY, "global", "*");
  assert.equal(s.sandboxSeconds, 900);
  await assert.rejects(
    () => l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 200, size: SIZE_SMALL }),
    CeilingExceeded,
  );
});

// ---------------------------------------------------------------------------
// SETTLEMENT INTEGRITY
// ---------------------------------------------------------------------------

test("a reservation cannot be settled twice", async () => {
  const { ledger: l } = ledger();
  const r = await l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 60, size: SIZE_SMALL });
  await l.settle(r, { sandboxSeconds: 60, size: SIZE_SMALL, measured: true });
  await assert.rejects(() => l.settle(r, { sandboxSeconds: 60, size: SIZE_SMALL, measured: true }), /already settled/i);
  const s = await l.spent(DAY, "global", "*");
  assert.equal(s.sandboxSeconds, 60, "a double settle must not double count");
});

test("settling an unknown reservation is an error, not a silent no-op", async () => {
  const { ledger: l } = ledger();
  await assert.rejects(() => l.settle("res_nonexistent", { sandboxSeconds: 1, size: SIZE_SMALL, measured: true }), /unknown/i);
});

// ---------------------------------------------------------------------------
// RECONCILIATION, since there is no usage API to reconcile against
// ---------------------------------------------------------------------------

test("a reconciliation records the drift between the ledger and the console", async () => {
  const { ledger: l } = ledger();
  const r = await l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 600, size: SIZE_SMALL });
  await l.settle(r, { sandboxSeconds: 600, size: SIZE_SMALL, measured: true });

  const est = (await l.spent(DAY, "global", "*")).usd;
  const drift = await l.reconcile({ observedSpentUsd: est + 0.004, at: `${DAY}T12:00:00Z`, note: "console read" });
  assert.ok(drift.driftUsd > 0.0039 && drift.driftUsd < 0.0041);
  assert.equal(drift.ledgerUsd, est);
  // Direction matters: under-reporting is the dangerous one.
  assert.equal(drift.direction, "ledger_under");
});

test("reconciliation history is retained, because drift over time is the signal", async () => {
  const { ledger: l } = ledger();
  await l.reconcile({ observedSpentUsd: 1, at: `${DAY}T09:00:00Z`, note: "first" });
  await l.reconcile({ observedSpentUsd: 2, at: `${DAY}T18:00:00Z`, note: "second" });
  const hist = await l.reconciliations();
  assert.equal(hist.length, 2);
  assert.equal(hist[1]!.note, "second");
});

// ---------------------------------------------------------------------------
// DRIFT AS A CONTROL
//
// Drift nobody acts on is not a control, in the same way an undefined CPU
// sampler was not a control. These tests are the "acts on" half.
// ---------------------------------------------------------------------------

test("a fresh ledger with no reconciliation is fit to gate on", async () => {
  const { ledger: l } = ledger();
  const h = await l.health();
  assert.equal(h.launchesEnabled, true);
  assert.equal(h.gaugeState, "ok");
});

test("under-reporting past the threshold disables launches and flips the gauge", async () => {
  const { ledger: l } = ledger();
  const r = await l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 900, size: SIZE_SMALL });
  await l.settle(r, { sandboxSeconds: 900, size: SIZE_SMALL, measured: true });
  const est = (await l.spent(DAY, "global", "*")).usd;

  await l.reconcile({ observedSpentUsd: est * 1.25, at: `${DAY}T12:00:00Z`, note: "console" });
  const h = await l.health();
  assert.equal(h.launchesEnabled, false, "a ledger under-reporting by 25% must stop gating");
  assert.equal(h.gaugeState, "reconciling");
  assert.match(h.reason!, /under-reporting/);
  assert.match(h.reason!, /looser than they appear/);
});

test("over-reporting is recorded but does NOT trip, because it fails safe", async () => {
  const { ledger: l } = ledger();
  const r = await l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 900, size: SIZE_SMALL });
  await l.settle(r, { sandboxSeconds: 900, size: SIZE_SMALL, measured: true });
  const est = (await l.spent(DAY, "global", "*")).usd;

  await l.reconcile({ observedSpentUsd: est * 0.5, at: `${DAY}T12:00:00Z`, note: "console" });
  const h = await l.health();
  assert.equal(h.launchesEnabled, true, "refusing launches that could have run is the safe error");
  assert.equal(h.lastReconciliation!.direction, "ledger_over");
});

test("small drift does not trip, so the control is not noise", async () => {
  const { ledger: l } = ledger();
  const r = await l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 900, size: SIZE_SMALL });
  await l.settle(r, { sandboxSeconds: 900, size: SIZE_SMALL, measured: true });
  const est = (await l.spent(DAY, "global", "*")).usd;
  await l.reconcile({ observedSpentUsd: est * 1.02, at: `${DAY}T12:00:00Z`, note: "console" });
  assert.equal((await l.health()).launchesEnabled, true);
});

test("a later confirming reconciliation clears the trip", async () => {
  const { ledger: l } = ledger();
  const r = await l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 900, size: SIZE_SMALL });
  await l.settle(r, { sandboxSeconds: 900, size: SIZE_SMALL, measured: true });
  const est = (await l.spent(DAY, "global", "*")).usd;

  await l.reconcile({ observedSpentUsd: est * 1.25, at: `${DAY}T12:00:00Z`, note: "bad" });
  assert.equal((await l.health()).launchesEnabled, false);
  await l.reconcile({ observedSpentUsd: est, at: `${DAY}T13:00:00Z`, note: "confirmed" });
  assert.equal((await l.health()).launchesEnabled, true, "health reads the LATEST reconciliation");
});

// ---------------------------------------------------------------------------
// CONCURRENCY
//
// `reserve` reads the held total, compares it to the ceiling, then inserts.
// Those are three awaits, so another reserve can interleave between the read and
// the write. Single-threaded JavaScript does NOT prevent this: it prevents
// parallel execution, not interleaving at await points.
//
// Found by moving to Postgres and asking what two racing launches do. The
// question exposed the bug in BOTH stores, which is the useful kind of finding:
// the database was not the problem, it was the check-then-act pattern.
// ---------------------------------------------------------------------------

test("two concurrent reserves cannot both take the last slot", async () => {
  const { ledger: l } = ledger();
  const r = await l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 900, size: SIZE_SMALL });
  await l.settle(r, { sandboxSeconds: 900, size: SIZE_SMALL, measured: true });

  // 100 s left of a 1000 s ceiling. Two launches want 100 s each.
  const results = await Promise.allSettled([
    l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 100, size: SIZE_SMALL }),
    l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 100, size: SIZE_SMALL }),
  ]);

  const admitted = results.filter((x) => x.status === "fulfilled").length;
  assert.equal(admitted, 1, "exactly one launch may take the last slot");
  const spent = await l.spent(DAY, "global", "*");
  assert.ok(spent.sandboxSeconds <= 1000, `ceiling breached: ${spent.sandboxSeconds} held of 1000`);
});

test("concurrent reserves on DIFFERENT scopes do not block each other", async () => {
  // The lock must be per scope. A global lock would serialise every launch on
  // the site behind one mutex, which is a throughput bug rather than a safety one.
  const { ledger: l } = ledger();
  const results = await Promise.allSettled([
    l.reserve({ day: DAY, scope: "ip", key: "ip_a", sandboxSeconds: 300, size: SIZE_SMALL }),
    l.reserve({ day: DAY, scope: "ip", key: "ip_b", sandboxSeconds: 300, size: SIZE_SMALL }),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 2);
});

test("a burst of concurrent reserves admits exactly as many as fit", async () => {
  const { ledger: l } = ledger();
  // 1000 s ceiling, ten simultaneous requests for 200 s each. Five fit.
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      l.reserve({ day: DAY, scope: "global", key: "*", sandboxSeconds: 200, size: SIZE_SMALL })),
  );
  const admitted = results.filter((x) => x.status === "fulfilled").length;
  assert.equal(admitted, 5, `expected exactly 5 to fit, got ${admitted}`);
  assert.equal((await l.spent(DAY, "global", "*")).sandboxSeconds, 1000);
});
