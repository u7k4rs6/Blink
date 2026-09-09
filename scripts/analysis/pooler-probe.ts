/**
 * Does pg_advisory_xact_lock actually hold through the pooler?
 *
 * The concern is specific and correct: transaction-mode pooling (pgbouncer at
 * port 6543) hands a backend back to the pool between statements. Anything
 * relying on session state breaks. `pg_advisory_lock` is session-scoped and
 * WOULD break; `pg_advisory_xact_lock` is transaction-scoped and should survive
 * because a transaction pins a backend for its duration.
 *
 * That is the reasoning. This file is the probe, because the whole lesson of the
 * last two days is that reasoning about behaviour is how the expensive bugs got
 * in. Two real connections, raced against one key.
 *
 * Never prints the connection string or any part of it.
 */

import { MemoryScopeLock } from "../../src/concurrency/scope-lock.ts";

const { applyEnv } = await import("../../src/env.ts");
applyEnv();
const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.error("DATABASE_URL not set"); process.exit(2); }

const specifier = "pg";
const pg = (await import(specifier)) as unknown as {
  Client: new (o: { connectionString: string }) => {
    connect(): Promise<void>;
    query(t: string, v?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    end(): Promise<void>;
  };
};

const mk = async () => { const c = new pg.Client({ connectionString: URL_ }); await c.connect(); return c; };
const KEY = `blink_probe_${Date.now()}`;
const now = () => performance.now();
const ms = (t: number) => `${Math.round(now() - t)} ms`;

// --- what are we actually connected to? Derived facts only. ---
const u = new URL(URL_);
console.log("\nCONNECTION");
console.log("  host shape :", u.hostname.includes("pooler.supabase.com") ? "pooler.supabase.com" : u.hostname.startsWith("db.") ? "direct db.<ref>" : "other");
console.log("  port       :", u.port, u.port === "6543" ? "(transaction mode)" : u.port === "5432" ? "(session mode or direct)" : "(unknown)");

const probe = await mk();
const info = await probe.query(
  `select current_setting('server_version') as v,
          inet_server_port() as backend_port,
          current_database() as db,
          (select count(*) from pg_stat_activity where application_name like '%pgbouncer%') as bouncer_procs`,
);
console.log("  server     :", info.rows[0]!.v);
console.log("  backend port:", info.rows[0]!.backend_port, "(differs from client port when pooled)");

// --- A. does the lock EXCLUDE across two pooled connections? ---
console.log("\nA. EXCLUSION across two connections");
const a1 = await mk();
const a2 = await mk();
const t0 = now();
await a1.query("BEGIN");
await a1.query("SELECT pg_advisory_xact_lock(hashtext($1))", [KEY]);
console.log(`   conn1 holds the lock at ${ms(t0)}`);

let conn2AcquiredAt = -1;
const waiter = (async () => {
  await a2.query("BEGIN");
  await a2.query("SELECT pg_advisory_xact_lock(hashtext($1))", [KEY]);
  conn2AcquiredAt = now();
})();

await new Promise((r) => setTimeout(r, 600));
const acquiredEarly = conn2AcquiredAt > 0;
console.log(`   after 600 ms, conn2 acquired? ${acquiredEarly ? "YES - LOCK DOES NOT HOLD" : "no, still blocked (correct)"}`);
const commitAt = now();
await a1.query("COMMIT");
await waiter;
console.log(`   conn2 acquired ${Math.round(conn2AcquiredAt - commitAt)} ms after conn1 committed`);
await a2.query("COMMIT");
const exclusionOk = !acquiredEarly;

// --- B. is the lock RELEASED on ROLLBACK? ---
// A lock surviving a failed transaction through a pooler would be handed to
// whichever request gets that backend next: a deadlock generator under exactly
// the load the lock exists for.
console.log("\nB. RELEASE ON ROLLBACK");
const b1 = await mk();
const b2 = await mk();
const KEY2 = `${KEY}_rb`;
await b1.query("BEGIN");
await b1.query("SELECT pg_advisory_xact_lock(hashtext($1))", [KEY2]);
console.log("   conn1 holds the lock, and will now FAIL the transaction");

let b2At = -1;
const waiter2 = (async () => {
  await b2.query("BEGIN");
  await b2.query("SELECT pg_advisory_xact_lock(hashtext($1))", [KEY2]);
  b2At = now();
})();
await new Promise((r) => setTimeout(r, 400));
const b2Early = b2At > 0;
console.log(`   after 400 ms, conn2 acquired? ${b2Early ? "YES - not excluding" : "no, blocked (correct)"}`);

try { await b1.query("SELECT 1/0"); } catch { /* the failure is the point */ }
const rbAt = now();
await b1.query("ROLLBACK");
await waiter2;
console.log(`   conn2 acquired ${Math.round(b2At - rbAt)} ms after conn1 ROLLED BACK`);
await b2.query("COMMIT");
const rollbackReleases = b2At > 0;

// --- C. did the pooler leak the lock to a later, unrelated connection? ---
console.log("\nC. NO LEAK to a fresh connection afterwards");
const c1 = await mk();
const tC = now();
await c1.query("BEGIN");
await c1.query("SELECT pg_advisory_xact_lock(hashtext($1))", [KEY2]);
await c1.query("COMMIT");
console.log(`   a fresh connection took the same key in ${ms(tC)} (no residue held by a pooled backend)`);

for (const c of [probe, a1, a2, b1, b2, c1]) await c.end();

console.log("\nVERDICT");
console.log(`  exclusion across pooled connections : ${exclusionOk ? "HOLDS" : "BROKEN"}`);
console.log(`  released on ROLLBACK                : ${rollbackReleases ? "YES" : "NO - deadlock generator"}`);
console.log(`  ${exclusionOk && rollbackReleases
    ? "pg_advisory_xact_lock is safe through this pooler. No change needed."
    : "pg_advisory_xact_lock is NOT safe here. Alternatives: session-mode pooler (port 5432), a direct connection reserved for the lock path only, or a row-level lock (SELECT ... FOR UPDATE on a per-scope row) which is transaction-scoped by construction."}`);
void MemoryScopeLock;
