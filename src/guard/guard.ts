/**
 * Budget ceilings and concurrency accounting.
 *
 * Ported from thrice (thrice/budget/guard.py), which proved it on this account.
 * Two rules carried over unchanged, because both were learned the hard way:
 *
 *   1. Refuse BEFORE the call, never after. A refusal must cost nothing.
 *   2. A 429 is a guard bug, not a condition to handle. If the guard's model of
 *      concurrency were right, the call would never have been made. So a 429
 *      aborts the gate and dumps the slot state rather than being retried or
 *      swallowed. There is no retry loop anywhere in this codebase (D7, G7).
 *
 * What is new here versus thrice: the guard tracks slots itself rather than
 * leaning on an asyncio semaphore, so the slot state is inspectable at the
 * moment a 429 arrives, which is the only moment it matters.
 */

import {
  type Plan,
  type Size,
  browserRatePerSecond,
  sandboxRatePerSecond,
} from "./rates.ts";

export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceeded";
  }
}

/**
 * A 429 reached us. By construction that means the guard let through a call it
 * should have refused, so this carries the full slot state for the report.
 */
export class GuardBug extends Error {
  readonly slotState: SlotState;
  constructor(message: string, slotState: SlotState) {
    super(message);
    this.name = "GuardBug";
    this.slotState = slotState;
  }
}

export type SlotState = {
  readonly plan: string;
  readonly sandboxesHeld: number;
  readonly maxSandboxes: number;
  readonly browsersHeld: number;
  readonly maxBrowsers: number;
  readonly liveSandboxIds: string[];
  readonly liveBrowserIds: string[];
};

/**
 * One ledger row. `measured` is the important field.
 *
 * A row is `measured: true` when the seconds came from an observed lifetime
 * (born-at to killed-at). It is `measured: false` when they came from a flat
 * model, which several gates still use for convenience.
 *
 * This distinction is public-facing, not internal bookkeeping. D10 puts a credit
 * gauge on the site, and Solari exposes NO balance or usage endpoint to
 * reconcile against (00-verification.md V55): remaining credit is visible only
 * on the console Billing page. So the ledger is the only running number Blink
 * has, and a modelled row that silently diverges from the real balance becomes a
 * wrong number displayed in public. Every row therefore says which it is, and
 * every report prints the split.
 */
export type LedgerRow = {
  kind: "sandbox" | "browser";
  seconds: number;
  usd: number;
  measured: boolean;
  note: string;
};

export type GuardSummary = {
  sandboxSeconds: number;
  browserSeconds: number;
  usd: number;
  /** USD from observed lifetimes. */
  measuredUsd: number;
  /** USD from flat models. The part that can silently diverge. */
  modelledUsd: number;
  /** Fraction of spend that was actually measured, 0 to 1. */
  measuredFraction: number;
  ceilingUsd: number;
  headroomUsd: number;
  sandboxesHeld: number;
  browsersHeld: number;
  rows: LedgerRow[];
};

export class BudgetGuard {
  readonly plan: Plan;
  readonly ceilingUsd: number;

  private sandboxSeconds = 0;
  private browserSeconds = 0;
  private spentUsd = 0;
  private reservedUsd = 0;

  private readonly liveSandboxes = new Set<string>();
  private readonly liveBrowsers = new Set<string>();

  constructor(plan: Plan, ceilingUsd: number) {
    this.plan = plan;
    this.ceilingUsd = ceilingUsd;
  }

  // ---------- refusal, always before the call ----------

  /**
   * Reserve `estimateUsd` against the ceiling. Throws before anything is
   * launched. Call this immediately before every Solari call that spends.
   */
  reserve(estimateUsd: number, what: string): void {
    const committed = this.spentUsd + this.reservedUsd;
    if (committed + estimateUsd > this.ceilingUsd) {
      throw new BudgetExceeded(
        `${what} would cross the ceiling: spent $${this.spentUsd.toFixed(5)} ` +
          `+ reserved $${this.reservedUsd.toFixed(5)} + estimate $${estimateUsd.toFixed(5)} ` +
          `> ceiling $${this.ceilingUsd.toFixed(5)}. Refused before the call.`,
      );
    }
    this.reservedUsd += estimateUsd;
  }

  /** Release a reservation once the real cost has been recorded. */
  release(estimateUsd: number): void {
    this.reservedUsd = Math.max(0, this.reservedUsd - estimateUsd);
    this.spentUsd = this.usd();
  }

  /**
   * Refuse to take a sandbox slot we do not have. This is the check whose
   * failure produces a 429, so getting it right here is the whole point.
   */
  reserveSandboxSlot(): void {
    if (this.liveSandboxes.size >= this.plan.maxSandboxes) {
      throw new BudgetExceeded(
        `no sandbox slot free: ${this.liveSandboxes.size}/${this.plan.maxSandboxes} held on ` +
          `${this.plan.name}. Refused before the call, which is what stops a 429.`,
      );
    }
  }

  reserveBrowserSlots(n: number): void {
    if (this.liveBrowsers.size + n > this.plan.maxBrowsers) {
      throw new BudgetExceeded(
        `not enough browser slots: ${this.liveBrowsers.size} held + ${n} requested ` +
          `> ${this.plan.maxBrowsers} on ${this.plan.name}. Refused before the call.`,
      );
    }
  }

  // ---------- slot bookkeeping ----------

  openedSandbox(id: string): void {
    this.liveSandboxes.add(id);
  }

  closedSandbox(id: string): void {
    this.liveSandboxes.delete(id);
  }

  openedBrowser(id: string): void {
    this.liveBrowsers.add(id);
  }

  closedBrowser(id: string): void {
    this.liveBrowsers.delete(id);
  }

  /**
   * Paused sandboxes do not hold a slot and do not bill (00-verification.md
   * V19, V20), so releasing the slot on pause is correct rather than optimistic.
   */
  pausedSandbox(id: string): void {
    this.liveSandboxes.delete(id);
  }

  slotState(): SlotState {
    return {
      plan: this.plan.name,
      sandboxesHeld: this.liveSandboxes.size,
      maxSandboxes: this.plan.maxSandboxes,
      browsersHeld: this.liveBrowsers.size,
      maxBrowsers: this.plan.maxBrowsers,
      liveSandboxIds: [...this.liveSandboxes],
      liveBrowserIds: [...this.liveBrowsers],
    };
  }

  /** Turn a 429 into a guard bug carrying everything needed to diagnose it. */
  concurrencyBug(context: string): GuardBug {
    return new GuardBug(
      `429 ConcurrencyLimitExceeded during ${context}. The guard believed a slot ` +
        `was free, so its model of concurrency is wrong. Aborting this gate ` +
        `rather than retrying: a 429 is never retried anywhere in this codebase.`,
      this.slotState(),
    );
  }

  // ---------- cost ----------

  private readonly rows: LedgerRow[] = [];

  /**
   * @param measured true if `seconds` is an observed lifetime, false if modelled.
   *                 Required rather than defaulted: a caller that has not thought
   *                 about which it is should be forced to.
   */
  addSandboxSeconds(seconds: number, size: Size, measured: boolean, note = ""): void {
    this.sandboxSeconds += seconds;
    const usd = seconds * sandboxRatePerSecond(this.plan, size);
    this.spentUsd += usd;
    this.rows.push({ kind: "sandbox", seconds, usd, measured, note });
  }

  addBrowserSeconds(seconds: number, measured: boolean, note = ""): void {
    this.browserSeconds += seconds;
    const usd = seconds * browserRatePerSecond(this.plan);
    this.spentUsd += usd;
    this.rows.push({ kind: "browser", seconds, usd, measured, note });
  }

  usd(): number {
    return this.spentUsd;
  }

  summary(): GuardSummary {
    const measuredUsd = this.rows.filter((r) => r.measured).reduce((a, r) => a + r.usd, 0);
    const modelledUsd = this.rows.filter((r) => !r.measured).reduce((a, r) => a + r.usd, 0);
    const total = measuredUsd + modelledUsd;
    return {
      sandboxSeconds: Math.round(this.sandboxSeconds * 10) / 10,
      browserSeconds: Math.round(this.browserSeconds * 10) / 10,
      usd: Math.round(this.spentUsd * 1e5) / 1e5,
      measuredUsd: Math.round(measuredUsd * 1e5) / 1e5,
      modelledUsd: Math.round(modelledUsd * 1e5) / 1e5,
      measuredFraction: total > 0 ? Math.round((measuredUsd / total) * 1000) / 1000 : 1,
      ceilingUsd: this.ceilingUsd,
      headroomUsd: Math.round((this.ceilingUsd - this.spentUsd) * 1e5) / 1e5,
      sandboxesHeld: this.liveSandboxes.size,
      browsersHeld: this.liveBrowsers.size,
      rows: [...this.rows],
    };
  }
}
