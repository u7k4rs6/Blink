/**
 * The Postgres LedgerStore.
 *
 * Deliberately thin: every decision about ceilings, settlement and drift lives
 * in BillingLedger, which is tested against the memory store. This file only
 * moves rows, so that the two implementations cannot diverge in behaviour.
 *
 * It satisfies the same contract suite as the memory store
 * (test/ledger-store-contract.test.ts). That suite runs against Postgres only
 * when DATABASE_URL is set, and this laptop has no Docker and 11 GiB of RAM, so
 * it has NOT yet been run against a real database. Until it has, this adapter is
 * unproven and the test suite says so out loud rather than passing silently.
 *
 * Two things it does not do, on purpose:
 *
 *   NO POOL OF ITS OWN.  A caller passes a connection string and the adapter
 *                        opens one client. The single always-on process (D11)
 *                        does not need pooling, and a pool would hide the
 *                        reservation-before-call ordering behind a queue.
 *   NO RETRIES.          There is no retry loop anywhere in this codebase. A
 *                        failed write propagates, and the reserve-before-call
 *                        discipline means a failed reserve stops the launch
 *                        before any money is spent.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LedgerStore, Reconciliation, ReservationId, Row, Scope } from "./ledger.ts";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "schema.sql");

/** The subset of a pg client this adapter needs. Keeps `pg` out of the types. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end?(): Promise<void>;
}

function toRow(r: Record<string, unknown>): Row {
  const num = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number));
  const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
  return {
    id: r.id as string,
    // The driver parser (src/db/pg-types.ts) makes this a plain 'YYYY-MM-DD'
    // string already. The Date branch is a belt-and-braces fallback for a client
    // built without the parsers, and it formats in UTC deliberately: the old
    // code used toISOString() on a Date parsed at LOCAL midnight, which shifted
    // the day backwards east of UTC. Formatting the UTC components avoids that.
    day: r.day instanceof Date
      ? `${r.day.getUTCFullYear()}-${String(r.day.getUTCMonth() + 1).padStart(2, "0")}-${String(r.day.getUTCDate()).padStart(2, "0")}`
      : String(r.day),
    scope: r.scope as Scope,
    key: r.key as string,
    estSandboxSeconds: num(r.est_sandbox_seconds),
    estBrowserSeconds: num(r.est_browser_seconds),
    actSandboxSeconds: numOrNull(r.act_sandbox_seconds),
    actBrowserSeconds: numOrNull(r.act_browser_seconds),
    usd: num(r.usd),
    measured: r.measured as boolean,
    createdAtMs: num(r.created_at_ms),
    settledAtMs: numOrNull(r.settled_at_ms),
    note: (r.note as string) ?? "",
  };
}

/**
 * Open a client from a connection string.
 *
 * `pg` is imported dynamically and is NOT a dependency of this package. The
 * whole codebase runs its tests against the memory store, so nothing should have
 * to install a database driver to run `npm test`. Only a caller that actually
 * has a DATABASE_URL reaches this line, and it fails with a clear message rather
 * than a module-not-found if the driver is absent.
 */
export async function connectPostgres(connectionString: string): Promise<SqlClient> {
  let pg: { Client: new (o: { connectionString: string }) => SqlClient & { connect(): Promise<void> } };
  try {
    // Specifier built at runtime so the typechecker does not require `pg` to be
    // installed. It is an optional driver, not a dependency: `npm test` runs
    // entirely against the memory store and must work on a laptop with no
    // database.
    const specifier = "pg";
    pg = (await import(specifier)) as never;
  } catch {
    throw new Error(
      "DATABASE_URL is set but the `pg` driver is not installed. " +
        "Run `npm install pg` to use the Postgres ledger store; the memory store needs nothing.",
    );
  }
  // Parsers registered BEFORE connecting, so no query can observe the default
  // date-to-local-Date behaviour that caused the day-boundary bug.
  const { registerPgTypeParsers } = await import("../db/pg-types.ts");
  await registerPgTypeParsers();
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

export class PostgresLedgerStore implements LedgerStore {
  private readonly client: SqlClient;
  /**
   * Schema to address. Contract tests point at a scratch schema so a truncating
   * test can never reach production state; the app points at `public`.
   */
  private readonly schema: string;

  constructor(client: SqlClient, schema = "public") {
    this.client = client;
    if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error(`unsafe schema name: ${schema}`);
    this.schema = schema;
  }

  private t(name: string): string {
    return `${this.schema}.${name}`;
  }

  /** Apply the schema. Idempotent: every statement is CREATE ... IF NOT EXISTS. */
  async migrate(): Promise<void> {
    const sql = readFileSync(SCHEMA_PATH, "utf8");
    await this.client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.client.query(`SET search_path TO ${this.schema}`);
    await this.client.query(sql);
  }

  /** Empty the ledger tables. Contract tests only; never the app. */
  async truncate(): Promise<void> {
    await this.client.query(`TRUNCATE ${this.t("billing_reservation")}, ${this.t("billing_reconciliation")}`);
  }

  /**
   * Serialise a scope with a transaction-scoped advisory lock.
   *
   * REQUIRES ONE CLIENT PER CONCURRENT CALLER. A single pg client cannot hold
   * two transactions: the second BEGIN is a no-op against an open one, both
   * bodies run inside the same transaction, the advisory lock is re-entrant
   * within it, and the first COMMIT ends it for both. The result excludes
   * nothing and raises no error, only a server NOTICE nobody reads.
   *
   * In the application this is never called concurrently, because
   * LayeredScopeLock puts a memory lock in front of it. In tests it is called
   * with a connection per caller, deliberately, so the real behaviour is
   * exercised rather than the safe arrangement.
   *
   * `pg_advisory_xact_lock` blocks rather than failing, and releases on COMMIT
   * or ROLLBACK, so there is no lock to leak and no retry loop to write. That
   * matters: SERIALIZABLE isolation would solve the same race by ABORTING one
   * transaction, which then has to be retried, and there is no retry loop
   * anywhere in this codebase.
   *
   * The lock key is the scope, so launches against different apps and different
   * IPs proceed in parallel.
   */
  async withScopeLock<T>(day: string, scope: Scope, key: string, fn: () => Promise<T>): Promise<T> {
    const { withHeldKey } = await import("../concurrency/scope-lock.ts");
    return withHeldKey(`${day}|${scope}|${key}`, () => this.withScopeLockInner(day, scope, key, fn));
  }

  private async withScopeLockInner<T>(day: string, scope: Scope, key: string, fn: () => Promise<T>): Promise<T> {
    await this.client.query("BEGIN");
    try {
      await this.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${day}|${scope}|${key}`]);
      const out = await fn();
      await this.client.query("COMMIT");
      return out;
    } catch (err) {
      await this.client.query("ROLLBACK");
      throw err;
    }
  }

  async insert(row: Row): Promise<void> {
    // No ON CONFLICT. A duplicate id means two reservations were conflated,
    // which silently halves a ceiling, so it must fail loudly.
    await this.client.query(
      `INSERT INTO ${this.t("billing_reservation")}
        (id, day, scope, key, est_sandbox_seconds, est_browser_seconds,
         act_sandbox_seconds, act_browser_seconds, usd, measured,
         created_at_ms, settled_at_ms, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [row.id, row.day, row.scope, row.key, row.estSandboxSeconds, row.estBrowserSeconds,
       row.actSandboxSeconds, row.actBrowserSeconds, row.usd, row.measured,
       row.createdAtMs, row.settledAtMs, row.note],
    );
  }

  async update(row: Row): Promise<void> {
    const res = await this.client.query(
      `UPDATE ${this.t("billing_reservation")} SET
         act_sandbox_seconds=$2, act_browser_seconds=$3, usd=$4,
         measured=$5, settled_at_ms=$6, note=$7
       WHERE id=$1 RETURNING id`,
      [row.id, row.actSandboxSeconds, row.actBrowserSeconds, row.usd,
       row.measured, row.settledAtMs, row.note],
    );
    if (res.rows.length === 0) throw new Error(`cannot update unknown reservation ${row.id}`);
  }

  async get(id: ReservationId): Promise<Row | null> {
    const res = await this.client.query(`SELECT * FROM ${this.t("billing_reservation")} WHERE id=$1`, [id]);
    return res.rows[0] ? toRow(res.rows[0]) : null;
  }

  async byScope(day: string, scope: Scope, key: string): Promise<Row[]> {
    const res = await this.client.query(
      `SELECT * FROM ${this.t("billing_reservation")} WHERE day=$1 AND scope=$2 AND key=$3`,
      [day, scope, key],
    );
    return res.rows.map(toRow);
  }

  async unsettled(): Promise<Row[]> {
    const res = await this.client.query(
      `SELECT * FROM ${this.t("billing_reservation")} WHERE settled_at_ms IS NULL`,
    );
    return res.rows.map(toRow);
  }

  async all(): Promise<Row[]> {
    const res = await this.client.query(`SELECT * FROM ${this.t("billing_reservation")}`);
    return res.rows.map(toRow);
  }

  async addReconciliation(r: Reconciliation): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.t("billing_reconciliation")}
        (at, ledger_usd, observed_spent_usd, drift_usd, direction, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.at, r.ledgerUsd, r.observedSpentUsd, r.driftUsd, r.direction, r.note],
    );
  }

  async reconciliations(): Promise<Reconciliation[]> {
    // Ordered by id, not by `at`: health() reads the LAST element and means "the
    // most recently recorded", which is not the same as the latest timestamp if
    // a backdated reading is ever entered.
    const res = await this.client.query(
      `SELECT * FROM ${this.t("billing_reconciliation")} ORDER BY id ASC`,
    );
    return res.rows.map((r) => ({
      at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
      ledgerUsd: Number(r.ledger_usd),
      observedSpentUsd: Number(r.observed_spent_usd),
      driftUsd: Number(r.drift_usd),
      direction: r.direction as Reconciliation["direction"],
      note: (r.note as string) ?? "",
    }));
  }
}
