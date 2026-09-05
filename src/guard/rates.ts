/**
 * Plan rates and ceilings.
 *
 * Every figure here was confirmed against https://docs.getsolari.com/pricing on
 * 2026-09-03 and is recorded in docs/00-verification.md V27 to V29. Ceilings are
 * expressed in sandbox-seconds and browser-seconds, never in dollars, so a price
 * change is an edit to this file and nothing else (D7).
 */

export type PlanName = "starter" | "free";

export type Plan = {
  readonly name: PlanName;
  /** USD per vCPU-hour. */
  readonly vcpuHour: number;
  /** USD per GB-hour. */
  readonly gbHour: number;
  /** USD per browser-hour. */
  readonly browserHour: number;
  /** Hard platform cap on concurrent sandboxes. Exceeding it returns 429. */
  readonly maxSandboxes: number;
  /** Hard platform cap on concurrent browsers. */
  readonly maxBrowsers: number;
};

export const PLANS: Record<PlanName, Plan> = {
  starter: {
    name: "starter",
    vcpuHour: 0.035,
    gbHour: 0.011,
    browserHour: 0.1,
    maxSandboxes: 2,
    maxBrowsers: 20,
  },
  free: {
    name: "free",
    vcpuHour: 0.0525,
    gbHour: 0.0165,
    browserHour: 0.15,
    maxSandboxes: 1,
    maxBrowsers: 3,
  },
};

/** Sandbox size. `memMb` is what the SDK takes; GB is what the rate is per. */
export type Size = { readonly cpu: number; readonly memMb: number };

export const SIZE_SMALL: Size = { cpu: 1, memMb: 2048 };
export const SIZE_LARGE: Size = { cpu: 2, memMb: 4096 };

/** USD per hour for one sandbox of this size on this plan. */
export function sandboxHourly(plan: Plan, size: Size): number {
  return size.cpu * plan.vcpuHour + (size.memMb / 1024) * plan.gbHour;
}

/** USD per sandbox-second at this size. */
export function sandboxRatePerSecond(plan: Plan, size: Size): number {
  return sandboxHourly(plan, size) / 3600;
}

/** USD per browser-second. */
export function browserRatePerSecond(plan: Plan): number {
  return plan.browserHour / 3600;
}

/**
 * Total budget for one full `npm run gates` run.
 *
 * Refuse to start if the pre-flight estimate exceeds this. The refusal happens
 * before any Solari call, so a refused run costs nothing.
 */
export const GATES_TOTAL_BUDGET_USD = 0.4;

/**
 * The date the Starter month ends, ISO `YYYY-MM-DD`, or null if not yet set.
 *
 * This is not a hypothetical. The downgrade to Free is SCHEDULED, so Q12 (what
 * happens to running sandboxes and stored snapshots at the moment of downgrade)
 * has a known answer date rather than an open one. G4 records a pre-downgrade
 * inventory and prints the exact re-inventory step to run the day after this
 * date, which is what turns Q12 from a question into a diary entry.
 *
 * Set it here, or override with BLINK_STARTER_ENDS. Until it is set, G4 prints
 * the procedure with a TODO and says plainly that Q12 stays unanswerable.
 */
const STARTER_ENDS_LITERAL: string | null = null; // <- set to "YYYY-MM-DD" from the Solari console

export const STARTER_ENDS: string | null =
  process.env.BLINK_STARTER_ENDS ?? STARTER_ENDS_LITERAL;

/** True once the downgrade date has passed, in UTC. */
export function starterHasEnded(now: Date = new Date()): boolean {
  if (!STARTER_ENDS) return false;
  const end = new Date(`${STARTER_ENDS}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return false;
  return now.getTime() >= end.getTime();
}

/** The day after the downgrade, when the re-inventory is run. */
export function reInventoryDate(): string | null {
  if (!STARTER_ENDS) return null;
  const d = new Date(`${STARTER_ENDS}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
