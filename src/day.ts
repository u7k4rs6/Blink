/**
 * What "day" means, decided once and asserted at startup.
 *
 * The word appears in four places that must agree, or the system is wrong in
 * ways that do not look like bugs:
 *
 *   per-day ceilings         (budget_ledger.day)
 *   the ip_day lock key      (src/concurrency/scope-lock.ts)
 *   budget_ledger day rows   (the reservation bucket)
 *   the public per-day p50/p95 on the metrics page
 *
 * THE DECISION: day means UTC.
 *
 * Two reasons, and the second is the one that settles it. Ceilings exist to
 * pace spend against Solari's monthly credit cycle, which is not keyed to the
 * operator's wall clock. And visitors are global, so any local midnight is
 * arbitrary for all but a fraction of them: a per-IP daily cap that rolls over
 * at 00:00 in one timezone gives some visitors two allowances in a calendar day
 * and others one.
 *
 * WHY THIS IS ASSERTED AND NOT ASSUMED. The driver returned a `date` column as a
 * JS Date at LOCAL midnight, and converting it with toISOString() shifted the
 * day backwards by one for the first 5.5 hours of every day in IST. It was
 * correct in the REST probe, correct in the memory store, and wrong only in the
 * real driver in the real timezone. A server that is UTC today may not be after
 * a redeploy to a different host, so the boundary is checked at startup rather
 * than trusted.
 */

/** The canonical day key. Always UTC, always YYYY-MM-DD. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** Start of a UTC day, for range queries. */
export function utcDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export class DayBoundaryMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DayBoundaryMismatch";
  }
}

/**
 * Fail loudly if the process timezone would move the day boundary.
 *
 * Called at startup. The check is not "is TZ set to UTC" but "does this process
 * compute the same day boundary as UTC", which is the property that actually
 * matters and survives someone setting TZ to Etc/UTC or UTC0.
 */
export function assertUtcDayBoundary(now: Date = new Date()): void {
  const offsetMinutes = now.getTimezoneOffset();
  if (offsetMinutes !== 0) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown";
    throw new DayBoundaryMismatch(
      `process timezone is ${tz} (UTC offset ${-offsetMinutes} minutes), so local midnight is not UTC midnight.\n` +
        `"day" is defined as UTC across ceilings, lock keys, ledger buckets and the public metrics page ` +
        `(see src/day.ts). Running with a local offset silently mis-buckets every per-day number, and the ` +
        `symptom is a daily cap that resets early rather than an error.\n` +
        `Set TZ=UTC on the process. This is asserted rather than assumed because a date column already ` +
        `caused exactly this bug once, and it was invisible in every environment except the real one.`,
    );
  }
  // Belt and braces: the two ways of computing the day must agree.
  const viaIso = now.toISOString().slice(0, 10);
  const viaLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (viaIso !== viaLocal) {
    throw new DayBoundaryMismatch(
      `UTC day (${viaIso}) and local day (${viaLocal}) disagree even though the reported offset is zero.`,
    );
  }
}
