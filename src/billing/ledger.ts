/**
 * The billing ledger.
 *
 * Blink has no upstream to check its arithmetic against. Solari exposes no
 * balance, usage or spend endpoint (00-verification.md V55): remaining credit
 * lives only on the console Billing page, read by a human. So this ledger is the
 * single running account of what has been spent, and D10 puts its output on a
 * public page next to a claim that the numbers here are real.
 *
 * Three properties, in the order they matter:
 *
 *   CONSERVATIVE  A reservation counts in full until it is settled. Forgetting
 *                 to settle overcounts, which refuses launches. The opposite
 *                 mistake spends money that is not there.
 *   DURABLE       Reservations are written before the Solari call and survive a
 *                 restart, because the process can die in between. Same
 *                 discipline as the sandbox ledger in src/guard/ledger.ts, for
 *                 the same reason, learned the same way.
 *   HONEST        Every row says whether its seconds were measured or modelled.
 *                 The gauge shows the split rather than a single confident
 *                 number, because a modelled row that drifts becomes a public
 *                 wrongness with nothing to catch it.
 */

import { randomUUID } from "node:crypto";

import { type Plan, type Size, browserRatePerSecond, sandboxRatePerSecond } from "../guard/rates.ts";

export type Scope = "global" | "ip" | "launch";

export type Ceiling = { sandboxSeconds: number; browserSeconds: number };
export type Ceilings = Record<Scope, Ceiling>;

export type ReservationId = string;

export type Row = {
  id: ReservationId;
  day: string;
  scope: Scope;
  key: string;
  /** What was reserved up front. */
  estSandboxSeconds: number;
  estBrowserSeconds: number;
  /** What was actually consumed. Null until settled. */
  actSandboxSeconds: number | null;
  actBrowserSeconds: number | null;
  usd: number;
  /** False when the seconds came from a model rather than an observed lifetime. */
  measured: boolean;
  createdAtMs: number;
  settledAtMs: number | null;
  note: string;
};

export type Reconciliation = {
  at: string;
  ledgerUsd: number;
  observedSpentUsd: number;
  driftUsd: number;
  direction: "ledger_under" | "ledger_over" | "exact";
  note: string;
};

/**
 * Past this drift, launches stop and the gauge says so.
 *
 * Drift nobody acts on is not a control, in the same way an undefined CPU
 * sampler was not a control. The dangerous direction is `ledger_under`: real
 * spend outrunning the number that decides whether to refuse. At that point the
 * ledger is not merely inaccurate, it is unfit to gate on, so it stops gating
 * and says why.
 *
 * 10% is chosen to sit well above ordinary rounding and well below the point
 * where a month is at risk.
 */
export const DRIFT_TRIP_FRACTION = Number(process.env.BLINK_DRIFT_TRIP ?? 0.10);

export type LedgerHealth = {
  /** False disables launches. The catalog, health wall and canary stay up. */
  launchesEnabled: boolean;
  /** Shown on the credit gauge in place of a number. */
  gaugeState: "ok" | "reconciling";
  reason: string | null;
  lastReconciliation: Reconciliation | null;
};

export class CeilingExceeded extends Error {
  readonly scope: Scope;
  readonly key: string;
  constructor(message: string, scope: Scope, key: string) {
    super(message);
    this.name = "CeilingExceeded";
    this.scope = scope;
    this.key = key;
  }
}

/**
 * Storage is an interface so the ledger can be tested without Postgres, and so
 * the Postgres implementation is a thin adapter rather than the logic itself.
 */
export interface LedgerStore {
  /**
   * Serialise a read-then-write against one scope.
   *
   * `reserve` reads the held total, checks a ceiling, then inserts. Those are
   * separate awaits, so another reserve can interleave between the read and the
   * write and both can pass a ceiling that only one of them fits under.
   *
   * Single-threaded JavaScript does NOT prevent this. It prevents parallel
   * execution, not interleaving at await points, and a live probe confirmed the
   * breach in the memory store as readily as the reasoning predicted it in
   * Postgres.
   *
   * The lock is PER SCOPE. A global one would serialise every launch on the site
   * behind a single mutex, turning a safety fix into a throughput bug.
   */
  withScopeLock<T>(day: string, scope: Scope, key: string, fn: () => Promise<T>): Promise<T>;
  insert(row: Row): Promise<void>;
  update(row: Row): Promise<void>;
  get(id: ReservationId): Promise<Row | null>;
  byScope(day: string, scope: Scope, key: string): Promise<Row[]>;
  unsettled(): Promise<Row[]>;
  all(): Promise<Row[]>;
  addReconciliation(r: Reconciliation): Promise<void>;
  reconciliations(): Promise<Reconciliation[]>;
}

export class MemoryLedgerStore implements LedgerStore {
  private rows = new Map<ReservationId, Row>();
  private recs: Reconciliation[] = [];
  /** One promise chain per scope key. Awaiting the tail serialises the scope. */
  private locks = new Map<string, Promise<unknown>>();

  async withScopeLock<T>(day: string, scope: Scope, key: string, fn: () => Promise<T>): Promise<T> {
    const { withHeldKey } = await import("../concurrency/scope-lock.ts");
    return withHeldKey(`${day}|${scope}|${key}`, () => this.lockInner(day, scope, key, fn));
  }

  private async lockInner<T>(day: string, scope: Scope, key: string, fn: () => Promise<T>): Promise<T> {
    const k = `${day}|${scope}|${key}`;
    const prior = this.locks.get(k) ?? Promise.resolve();
    // Chain onto the previous holder, swallowing its result and its failure so
    // one caller's error cannot poison the queue behind it.
    const mine = prior.then(fn, fn);
    this.locks.set(k, mine.then(() => undefined, () => undefined));
    return mine;
  }

  async insert(row: Row) {
    // Reject rather than overwrite. A duplicate id means two reservations were
    // conflated, which silently halves a ceiling: the second launch would be
    // admitted against the first one's budget.
    if (this.rows.has(row.id)) throw new Error(`duplicate reservation id ${row.id}`);
    this.rows.set(row.id, { ...row });
  }
  async update(row: Row) {
    if (!this.rows.has(row.id)) throw new Error(`cannot update unknown reservation ${row.id}`);
    this.rows.set(row.id, { ...row });
  }
  async get(id: ReservationId) { return this.rows.get(id) ?? null; }
  async byScope(day: string, scope: Scope, key: string) {
    return [...this.rows.values()].filter((r) => r.day === day && r.scope === scope && r.key === key);
  }
  async unsettled() { return [...this.rows.values()].filter((r) => r.settledAtMs === null); }
  async all() { return [...this.rows.values()]; }
  async addReconciliation(r: Reconciliation) { this.recs.push(r); }
  async reconciliations() { return [...this.recs]; }

  /** Test helper: pretend a reservation was made longer ago than it was. */
  ageReservation(id: ReservationId, byMs: number) {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, createdAtMs: r.createdAtMs - byMs });
  }
}

export type Spent = {
  sandboxSeconds: number;
  browserSeconds: number;
  usd: number;
  measuredUsd: number;
  modelledUsd: number;
  measuredFraction: number;
  openReservations: number;
};

export class BillingLedger {
  private readonly store: LedgerStore;
  private readonly plan: Plan;
  private readonly ceilings: Ceilings;

  constructor(opts: { store: LedgerStore; plan: Plan; ceilings: Ceilings }) {
    this.store = opts.store;
    this.plan = opts.plan;
    this.ceilings = opts.ceilings;
  }

  private usdFor(sandboxSeconds: number, browserSeconds: number, size: Size): number {
    return sandboxSeconds * sandboxRatePerSecond(this.plan, size) + browserSeconds * browserRatePerSecond(this.plan);
  }

  /** Effective consumption of a row: what it actually cost, or what it reserved. */
  private effective(r: Row): { sandbox: number; browser: number } {
    return {
      sandbox: r.actSandboxSeconds ?? r.estSandboxSeconds,
      browser: r.actBrowserSeconds ?? r.estBrowserSeconds,
    };
  }

  /**
   * Reserve against a ceiling. Throws BEFORE any row is written, so a refusal
   * leaves no trace and costs nothing.
   */
  async reserve(req: {
    day: string; scope: Scope; key: string;
    sandboxSeconds?: number; browserSeconds?: number;
    size: Size; note?: string;
  }): Promise<ReservationId> {
    // The whole check-then-act runs under the scope lock. Without it, two
    // concurrent launches both read the same held total, both pass the ceiling,
    // and both insert. Measured: a 1,000 s ceiling ended up holding 1,100 s.
    return this.store.withScopeLock(req.day, req.scope, req.key, () => this.reserveLocked(req));
  }

  private async reserveLocked(req: {
    day: string; scope: Scope; key: string;
    sandboxSeconds?: number; browserSeconds?: number;
    size: Size; note?: string;
  }): Promise<ReservationId> {
    const est = { sandbox: req.sandboxSeconds ?? 0, browser: req.browserSeconds ?? 0 };
    const ceiling = this.ceilings[req.scope];
    const existing = await this.store.byScope(req.day, req.scope, req.key);

    let heldSandbox = 0;
    let heldBrowser = 0;
    for (const r of existing) {
      const e = this.effective(r);
      heldSandbox += e.sandbox;
      heldBrowser += e.browser;
    }

    if (heldSandbox + est.sandbox > ceiling.sandboxSeconds) {
      throw new CeilingExceeded(
        `${req.scope}:${req.key} would exceed its sandbox-second ceiling: ` +
          `${heldSandbox} held + ${est.sandbox} requested > ${ceiling.sandboxSeconds}. Refused before the call.`,
        req.scope, req.key,
      );
    }
    if (heldBrowser + est.browser > ceiling.browserSeconds) {
      throw new CeilingExceeded(
        `${req.scope}:${req.key} would exceed its browser-second ceiling: ` +
          `${heldBrowser} held + ${est.browser} requested > ${ceiling.browserSeconds}. Refused before the call.`,
        req.scope, req.key,
      );
    }

    const row: Row = {
      id: `res_${randomUUID()}`,
      day: req.day, scope: req.scope, key: req.key,
      estSandboxSeconds: est.sandbox, estBrowserSeconds: est.browser,
      actSandboxSeconds: null, actBrowserSeconds: null,
      usd: this.usdFor(est.sandbox, est.browser, req.size),
      // A reservation is an estimate by definition. It becomes measured only if
      // something observes the real lifetime and settles it as such.
      measured: false,
      createdAtMs: Date.now(), settledAtMs: null,
      note: req.note ?? "",
    };
    await this.store.insert(row);
    return row.id;
  }

  /**
   * Settle with what was actually consumed.
   *
   * Actuals are recorded as given, never clamped to the reservation. An instance
   * that overran must show its real cost: clamping would make the ledger wrong
   * in the one direction that matters.
   */
  async settle(id: ReservationId, actual: {
    sandboxSeconds?: number; browserSeconds?: number; size: Size; measured: boolean; note?: string;
  }): Promise<void> {
    const row = await this.store.get(id);
    if (!row) throw new Error(`unknown reservation ${id}`);
    if (row.settledAtMs !== null) throw new Error(`reservation ${id} is already settled`);

    const sandbox = actual.sandboxSeconds ?? 0;
    const browser = actual.browserSeconds ?? 0;
    await this.store.update({
      ...row,
      actSandboxSeconds: sandbox,
      actBrowserSeconds: browser,
      usd: this.usdFor(sandbox, browser, actual.size),
      measured: actual.measured,
      settledAtMs: Date.now(),
      note: actual.note ?? row.note,
    });
  }

  async spent(day: string, scope: Scope, key: string): Promise<Spent> {
    const rows = await this.store.byScope(day, scope, key);
    let sandbox = 0, browser = 0, usd = 0, measuredUsd = 0, modelledUsd = 0, open = 0;
    for (const r of rows) {
      const e = this.effective(r);
      sandbox += e.sandbox;
      browser += e.browser;
      usd += r.usd;
      if (r.settledAtMs === null) open += 1;
      if (r.measured) measuredUsd += r.usd; else modelledUsd += r.usd;
    }
    const total = measuredUsd + modelledUsd;
    return {
      sandboxSeconds: sandbox, browserSeconds: browser,
      usd: round(usd), measuredUsd: round(measuredUsd), modelledUsd: round(modelledUsd),
      measuredFraction: total > 0 ? measuredUsd / total : 1,
      openReservations: open,
    };
  }

  /**
   * Settle reservations that nothing ever came back for.
   *
   * A process killed between the Solari call and the settle leaves a row open
   * forever, which holds a ceiling hostage. Settling at the estimate is the
   * conservative choice: it assumes the money was spent, and marks the row
   * modelled so the gauge shows it as such rather than folding it into a
   * confident total.
   */
  async sweepOrphans(opts: { olderThanMs: number; size?: Size }): Promise<ReservationId[]> {
    const cutoff = Date.now() - opts.olderThanMs;
    const swept: ReservationId[] = [];
    for (const r of await this.store.unsettled()) {
      if (r.createdAtMs > cutoff) continue;
      await this.store.update({
        ...r,
        actSandboxSeconds: r.estSandboxSeconds,
        actBrowserSeconds: r.estBrowserSeconds,
        measured: false,
        settledAtMs: Date.now(),
        note: `${r.note} [orphan swept at estimate]`.trim(),
      });
      swept.push(r.id);
    }
    return swept;
  }

  /**
   * Record a human reading of the console against what the ledger believed.
   *
   * This is the only reconciliation available: there is no usage API (V55). The
   * value is not the single number but the drift over time, which is why the
   * history is kept. `ledger_under` is the dangerous direction, because it means
   * real spend is outrunning the gauge that is deciding whether to refuse.
   */
  async reconcile(r: { observedSpentUsd: number; at: string; note?: string }): Promise<Reconciliation> {
    const all = await this.store.all();
    const ledgerUsd = round(all.reduce((a, x) => a + x.usd, 0));
    const drift = round(r.observedSpentUsd - ledgerUsd);
    const rec: Reconciliation = {
      at: r.at,
      ledgerUsd,
      observedSpentUsd: r.observedSpentUsd,
      driftUsd: Math.abs(drift),
      direction: drift > 0 ? "ledger_under" : drift < 0 ? "ledger_over" : "exact",
      note: r.note ?? "",
    };
    await this.store.addReconciliation(rec);
    return rec;
  }

  async reconciliations(): Promise<Reconciliation[]> {
    return this.store.reconciliations();
  }

  /**
   * Whether the ledger is fit to gate on.
   *
   * A ledger that has drifted past the trip threshold in the `ledger_under`
   * direction is under-reporting real spend, which means every ceiling it
   * enforces is looser than it looks. It stops being a control and becomes a
   * guess, so launches disable and the gauge reads "reconciling" until a human
   * confirms a console figure. Over-reporting is recorded but does not trip:
   * it refuses launches that could have run, which is the safe error.
   */
  async health(): Promise<LedgerHealth> {
    const recs = await this.store.reconciliations();
    const last = recs.length ? recs[recs.length - 1]! : null;
    if (!last) {
      return { launchesEnabled: true, gaugeState: "ok", reason: null, lastReconciliation: null };
    }
    const base = Math.max(last.ledgerUsd, 1e-9);
    const fraction = last.driftUsd / base;
    if (last.direction === "ledger_under" && fraction >= DRIFT_TRIP_FRACTION) {
      return {
        launchesEnabled: false,
        gaugeState: "reconciling",
        reason:
          `Ledger is under-reporting by $${last.driftUsd.toFixed(4)} ` +
          `(${(fraction * 100).toFixed(1)}%) against the console read at ${last.at}. ` +
          `Ceilings computed from it are looser than they appear, so launches are paused ` +
          `until a confirmed figure is entered.`,
        lastReconciliation: last,
      };
    }
    return { launchesEnabled: true, gaugeState: "ok", reason: null, lastReconciliation: last };
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
