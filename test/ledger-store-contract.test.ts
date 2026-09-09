/**
 * The LedgerStore contract.
 *
 * Written before the Postgres adapter, and shaped so the SAME suite runs against
 * both implementations. The memory store is not a toy that happens to pass: it
 * is the reference, and Postgres has to match it exactly.
 *
 * This laptop has no Docker and 11 GiB of RAM, so Postgres is not running
 * locally. The suite therefore runs against memory always, and against Postgres
 * only when DATABASE_URL is set. That is stated rather than hidden: until it has
 * run green against a real database, the adapter is unproven, and the suite says
 * so out loud when it skips.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryLedgerStore, type LedgerStore, type Row } from "../src/billing/ledger.ts";

function row(over: Partial<Row> = {}): Row {
  return {
    id: `res_${Math.random().toString(36).slice(2, 10)}`,
    day: "2026-09-04", scope: "global", key: "*",
    estSandboxSeconds: 60, estBrowserSeconds: 0,
    actSandboxSeconds: null, actBrowserSeconds: null,
    usd: 0.00095, measured: false,
    createdAtMs: Date.now(), settledAtMs: null, note: "",
    ...over,
  };
}

/**
 * Every behaviour the ledger relies on. Both stores must satisfy all of it.
 *
 * `secondCaller` returns another handle in the SAME LOCK DOMAIN as the given
 * store. The two implementations disagree about what that means, and the
 * disagreement is real rather than an artefact:
 *
 *   memory    the store IS the domain. One store is one process, and a second
 *             independent store models a second process, which shares nothing.
 *   postgres  the DATABASE is the domain. Two stores on two connections still
 *             contend, and must, because that is what two web requests are.
 *
 * Passing the same object for both would test a shared pg client, which is the
 * arrangement where the lock silently excludes nothing.
 */
export function storeContract(
  name: string,
  make: () => Promise<LedgerStore>,
  secondCaller: (s: LedgerStore) => Promise<LedgerStore>,
) {
  test(`${name}: a row round-trips unchanged`, async () => {
    const s = await make();
    const r = row({ note: "hello" });
    await s.insert(r);
    const got = await s.get(r.id);
    assert.deepEqual(got, r);
  });

  test(`${name}: get returns null for an unknown id, never throws`, async () => {
    const s = await make();
    assert.equal(await s.get("res_missing"), null);
  });

  test(`${name}: update replaces, it does not append`, async () => {
    const s = await make();
    const r = row();
    await s.insert(r);
    await s.update({ ...r, actSandboxSeconds: 30, settledAtMs: 123, measured: true });
    const all = await s.all();
    assert.equal(all.length, 1, "an update that appends would double count every settlement");
    assert.equal(all[0]!.actSandboxSeconds, 30);
    assert.equal(all[0]!.measured, true);
  });

  test(`${name}: byScope filters on all three of day, scope and key`, async () => {
    const s = await make();
    await s.insert(row({ day: "2026-09-04", scope: "ip", key: "a" }));
    await s.insert(row({ day: "2026-09-04", scope: "ip", key: "b" }));
    await s.insert(row({ day: "2026-09-05", scope: "ip", key: "a" }));
    await s.insert(row({ day: "2026-09-04", scope: "global", key: "a" }));
    const got = await s.byScope("2026-09-04", "ip", "a");
    assert.equal(got.length, 1, "a leaky filter silently merges scopes and breaks every ceiling");
  });

  test(`${name}: byScope returns empty, not null, when nothing matches`, async () => {
    const s = await make();
    assert.deepEqual(await s.byScope("2026-01-01", "ip", "nobody"), []);
  });

  test(`${name}: unsettled returns exactly the rows with a null settledAtMs`, async () => {
    const s = await make();
    const open = row();
    const done = row({ settledAtMs: Date.now(), actSandboxSeconds: 10 });
    await s.insert(open);
    await s.insert(done);
    const got = await s.unsettled();
    assert.equal(got.length, 1);
    assert.equal(got[0]!.id, open.id);
  });

  test(`${name}: numbers survive the round trip without precision loss`, async () => {
    // usd values are small and the gauge is public; a float mangled by the
    // driver would be wrong in a place people can see.
    const s = await make();
    const r = row({ usd: 0.000475, estSandboxSeconds: 1234, actSandboxSeconds: 987 });
    await s.insert(r);
    const got = (await s.get(r.id))!;
    assert.equal(got.usd, 0.000475);
    assert.equal(got.estSandboxSeconds, 1234);
    assert.equal(got.actSandboxSeconds, 987);
  });

  test(`${name}: null actuals stay null and do not become zero`, async () => {
    // The difference matters: null means unsettled and counts at estimate, zero
    // means settled at no cost. Conflating them undercounts.
    const s = await make();
    const r = row();
    await s.insert(r);
    const got = (await s.get(r.id))!;
    assert.equal(got.actSandboxSeconds, null);
    assert.notEqual(got.actSandboxSeconds, 0);
  });

  test(`${name}: reconciliations are returned in insertion order`, async () => {
    // Health reads the LATEST reconciliation, so order is not cosmetic.
    const s = await make();
    await s.addReconciliation({ at: "2026-09-04T09:00:00Z", ledgerUsd: 1, observedSpentUsd: 1, driftUsd: 0, direction: "exact", note: "first" });
    await s.addReconciliation({ at: "2026-09-04T18:00:00Z", ledgerUsd: 2, observedSpentUsd: 3, driftUsd: 1, direction: "ledger_under", note: "second" });
    const got = await s.reconciliations();
    assert.equal(got.length, 2);
    assert.equal(got[0]!.note, "first");
    assert.equal(got[1]!.note, "second", "health() reads the last element, so order is load-bearing");
  });

  test(`${name}: withScopeLock serialises the same scope`, async () => {
    // A store per caller. Sharing one would test the broken arrangement: a
    // single connection cannot hold two transactions, so the lock would appear
    // to work while excluding nothing.
    const s = await make();
    const s2 = await secondCaller(s);
    const order: string[] = [];
    const slow = async (tag: string, ms: number) => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:end`);
    };
    await Promise.all([
      s.withScopeLock("2026-09-04", "global", "*", () => slow("a", 20)),
      s2.withScopeLock("2026-09-04", "global", "*", () => slow("b", 1)),
    ]);
    // The property is NON-INTERLEAVING, not a particular winner. Which caller
    // acquires first is nondeterministic, especially through a pooler where
    // connection setup dominates the bodies. Asserting a fixed order tested the
    // scheduler and produced a flake that looked like a lock failure.
    const first = order[0]!.split(":")[0];
    const expected = [`${first}:start`, `${first}:end`];
    assert.deepEqual(order.slice(0, 2), expected,
      `whoever acquired first must finish before the other starts; got ${order.join(" ")}`);
    assert.equal(new Set(order).size, 4, "both callers must have run");
  });

  test(`${name}: withScopeLock does NOT serialise different scopes`, async () => {
    // Asserting a start ORDER was fragile: through a pooler, connection setup
    // dominates the bodies, so the fast caller can finish before the slow one
    // has issued its BEGIN, and the test failed while the lock was correct.
    //
    // The property is that a caller on key "b" does not WAIT for a holder of
    // key "a". So "a" holds long enough that waiting would be unmistakable, and
    // "b" must finish first.
    const s = await make();
    const s2 = await secondCaller(s);
    const HOLD = 2500;

    let aDone = 0;
    let bDone = 0;
    await Promise.all([
      s.withScopeLock("2026-09-04", "ip", "a", async () => {
        await new Promise((r) => setTimeout(r, HOLD));
        aDone = Date.now();
      }),
      s2.withScopeLock("2026-09-04", "ip", "b", async () => {
        bDone = Date.now();
      }),
    ]);
    assert.ok(bDone > 0 && aDone > 0, "both callers must have run");
    assert.ok(
      bDone < aDone,
      `a caller on a different key must not wait for the holder: b finished ${aDone - bDone} ms before a`,
    );
  });

  test(`${name}: a failure inside the lock releases it for the next caller`, async () => {
    const s = await make();
    await assert.rejects(() => s.withScopeLock("2026-09-04", "global", "*", async () => {
      throw new Error("boom");
    }));
    // The queue behind a failed holder must not be poisoned.
    const got = await s.withScopeLock("2026-09-04", "global", "*", async () => "ok");
    assert.equal(got, "ok");
  });

  test(`${name}: inserting a duplicate id is rejected, not silently merged`, async () => {
    const s = await make();
    const r = row();
    await s.insert(r);
    await assert.rejects(() => s.insert(r), "a duplicate reservation id would double count a ceiling");
  });
}

storeContract(
  "memory",
  async () => new MemoryLedgerStore(),
  // One store is one process, so the same instance is the same lock domain.
  async (s) => s,
);

// Postgres runs the identical suite when a database is available.
const { applyEnv } = await import("../src/env.ts");
applyEnv();

if (process.env.DATABASE_URL) {
  const { PostgresLedgerStore, connectPostgres } = await import("../src/billing/postgres-store.ts");
  // A scratch schema, never `public`: these tests truncate between cases and
  // day 4's real state must be unreachable from them.
  const SCHEMA = "blink_contract_test";

  /**
   * One connection PER CALLER, not one shared client.
   *
   * A single pg client cannot hold two transactions: the second BEGIN is a
   * no-op against an open one, both callers end up inside the same transaction,
   * and the first COMMIT ends it for both. The lock then excludes nothing and
   * reports no error. Sharing a client here made the suite test the broken
   * arrangement rather than the real one.
   */
  const clients: Array<{ end(): Promise<void> }> = [];
  const mkClient = async () => {
    const c = await connectPostgres(process.env.DATABASE_URL!);
    clients.push(c as never);
    return c;
  };

  storeContract(
    "postgres",
    async () => {
      const store = new PostgresLedgerStore(await mkClient(), SCHEMA);
      await store.truncate();
      return store;
    },
    // A second connection to the same database: what a second web request is.
    async () => new PostgresLedgerStore(await mkClient(), SCHEMA),
  );

  /**
   * Close every connection when the suite finishes.
   *
   * Without this the process runs every test green and then never exits, because
   * an open socket keeps Node's event loop alive. That is indistinguishable from
   * a deadlock in a lock suite, and telling the two apart cost a full diagnosis
   * session: an observer connection had to confirm no backend was waiting and no
   * lock was ungranted before the real cause (an unclosed handle) was visible.
   * A suite that hangs after green is a trap, so it closes what it opens.
   */
  test("postgres: teardown, close every connection so the suite can exit", async () => {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
    assert.ok(true);
  });
} else {
  test("postgres contract: SKIPPED, no DATABASE_URL", () => {
    // Deliberately a passing test with a loud name rather than a silent absence.
    // The adapter is UNPROVEN until this has run green against a real database,
    // and a green suite that quietly tested nothing is worse than a red one.
    assert.ok(true);
  });
}
