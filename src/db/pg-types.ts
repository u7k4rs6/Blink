/**
 * Driver-level type parsers, registered before any query runs.
 *
 * THE BUG THIS EXISTS TO PREVENT RECURRING:
 *
 * node-pg parses a `date` column into a JS Date at LOCAL midnight. Formatting
 * that with toISOString() converts to UTC first, so in any timezone east of UTC
 * the day shifts backwards: `2026-09-04` came back as `2026-09-03`. Every
 * per-day ceiling would have been keyed to the wrong bucket for the first 5.5
 * hours of every day in IST.
 *
 * Fixing the one call site that formats it is not enough. The next `date` column
 * anyone adds re-introduces it silently, and the failure mode is a number that
 * is merely wrong rather than an error. So the fix is at the boundary: a `date`
 * arrives as the string Postgres sent, and never becomes a Date at all.
 *
 * Same reasoning for int8: node-pg returns bigint as a string to avoid losing
 * precision past 2^53. Every timestamp-in-milliseconds column here is well
 * inside safe-integer range, so converting is safe and leaving it a string is
 * the thing that causes silent bugs.
 */

const DATE_OID = 1082;
const INT8_OID = 20;

let registered = false;

/** Idempotent. Safe to call from every entry point. */
export async function registerPgTypeParsers(): Promise<void> {
  if (registered) return;
  const specifier = "pg";
  const pg = (await import(specifier)) as unknown as {
    types: { setTypeParser(oid: number, fn: (v: string) => unknown): void };
  };
  // `date` stays exactly what the server sent: 'YYYY-MM-DD'.
  pg.types.setTypeParser(DATE_OID, (v: string) => v);
  // `bigint` becomes a number. Millisecond timestamps are far inside 2^53.
  pg.types.setTypeParser(INT8_OID, (v: string) => (v === null ? null : Number(v)));
  registered = true;
}
