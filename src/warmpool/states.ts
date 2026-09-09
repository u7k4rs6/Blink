/**
 * The warm pool state machine.
 *
 * G1 made this load-bearing rather than an optimisation: cold p50 was 11,947 ms
 * against warm 6,124 ms, a gap of 5,823 ms against a 500 ms deletion threshold.
 * The pool is the difference between a six second wait and a twelve second one.
 *
 * Two measurements from day 2 and 3 shape every transition below:
 *
 *   PAUSE COSTS 12,428 ms. Not visitor-facing, but on Starter's 2 slots that
 *   transient holds half the account's concurrency for twelve seconds after
 *   every claim. Replenishment is therefore slow and must never be on a
 *   visitor's path, and two replenishments must never overlap on one app.
 *
 *   A PRE-RESOLVED previewUrl SURVIVES A PAUSE (G3, confirmed by hitting the
 *   pre-pause URL after resuming with no re-resolve). That is why RESOLVING is
 *   a state before PAUSING rather than work done at claim time: it removes a
 *   1,238 ms call from the visitor's clock.
 */

export type ForkState =
  /** A row exists, nothing has been created yet. Holds no slot, costs nothing. */
  | "PLANNED"
  /** create({fromSnapshot}) in flight. Holds a slot and bills. */
  | "BUILDING"
  /** Created, waiting for the app to answer on loopback. Holds a slot, bills. */
  | "CHECKING"
  /** Healthy, resolving previewUrl BEFORE the pause so the claim path need not. */
  | "RESOLVING"
  /** pause() in flight. Measured at 12,428 ms. Still holds a slot until it lands. */
  | "PAUSING"
  /** Paused with a stored URL. Holds NO slot and does NOT bill (V19, V20). */
  | "READY"
  /** Claimed by a launch. Ownership has transferred to the instance. */
  | "CLAIMED"
  /** Its stored URL is past the refresh age and is being re-resolved. */
  | "REFRESHING"
  /** Solari no longer has it, or a step failed. Terminal. */
  | "DEAD";

export type ForkEvent =
  | "BUILD_STARTED" | "BUILD_OK" | "BUILD_FAILED"
  | "HEALTH_OK" | "HEALTH_TIMEOUT"
  | "URL_RESOLVED" | "URL_RESOLVE_FAILED"
  | "PAUSE_OK" | "PAUSE_FAILED"
  | "CLAIMED"
  | "URL_STALE" | "REFRESH_OK" | "REFRESH_FAILED"
  | "RECONCILER_LOST_IT" | "STATE_DEADLINE_EXCEEDED";

export type ForkTransition = { from: ForkState; event: ForkEvent; to: ForkState; note?: string };

/**
 * The stored previewUrl carries a one-hour pt_token (V21). A fork is refreshed
 * well before that, so a claim never finds a stale URL in normal operation and
 * the claim path never pays the 1,238 ms resolve.
 */
export const URL_REFRESH_AFTER_MS = Number(process.env.BLINK_URL_REFRESH_AFTER_MS ?? 50 * 60_000);

/**
 * Bounds on every state that holds a slot or bills. Same invariant as the launch
 * machine: not "can it reach DEAD" but "can it sit here forever". A fork stuck
 * in PAUSING holds one of two Starter slots indefinitely.
 */
export const MAX_FORK_STATE_MS: Readonly<Partial<Record<ForkState, number>>> = {
  BUILDING: Number(process.env.BLINK_MAX_FORK_BUILDING_MS ?? 60_000),
  CHECKING: Number(process.env.BLINK_MAX_FORK_CHECKING_MS ?? 90_000),
  RESOLVING: Number(process.env.BLINK_MAX_FORK_RESOLVING_MS ?? 20_000),
  // Measured at 12,428 ms, so the bound is generous but finite.
  PAUSING: Number(process.env.BLINK_MAX_FORK_PAUSING_MS ?? 45_000),
  REFRESHING: Number(process.env.BLINK_MAX_FORK_REFRESHING_MS ?? 20_000),
};

export const FORK_TRANSITIONS: readonly ForkTransition[] = [
  { from: "PLANNED", event: "BUILD_STARTED", to: "BUILDING" },
  { from: "BUILDING", event: "BUILD_OK", to: "CHECKING" },
  { from: "BUILDING", event: "BUILD_FAILED", to: "DEAD" },

  { from: "CHECKING", event: "HEALTH_OK", to: "RESOLVING" },
  { from: "CHECKING", event: "HEALTH_TIMEOUT", to: "DEAD",
    note: "A fork that never answers is killed. It is not offered to a visitor and not retried here." },

  { from: "RESOLVING", event: "URL_RESOLVED", to: "PAUSING" },
  { from: "RESOLVING", event: "URL_RESOLVE_FAILED", to: "DEAD",
    note: "Pausing without a stored URL would push the 1,238 ms resolve onto a visitor, which is the cost this state exists to avoid." },

  { from: "PAUSING", event: "PAUSE_OK", to: "READY",
    note: "Only here does the fork stop billing and release its slot." },
  { from: "PAUSING", event: "PAUSE_FAILED", to: "DEAD",
    note: "A fork that will not pause bills at full rate forever. Kill it rather than keep it." },

  { from: "READY", event: "CLAIMED", to: "CLAIMED" },
  { from: "READY", event: "URL_STALE", to: "REFRESHING" },
  { from: "READY", event: "RECONCILER_LOST_IT", to: "DEAD" },

  { from: "REFRESHING", event: "REFRESH_OK", to: "READY" },
  { from: "REFRESHING", event: "REFRESH_FAILED", to: "DEAD" },

  // Anything that overstays a bound while holding a slot is killed.
  ...(["BUILDING", "CHECKING", "RESOLVING", "PAUSING", "REFRESHING"] as const).map(
    (from): ForkTransition => ({ from, event: "STATE_DEADLINE_EXCEEDED", to: "DEAD",
      note: "Held a slot past its bound. Legal-but-slow still occupies one of two." }),
  ),
];

/** States that hold a Solari concurrency slot and bill. */
export const SLOT_HOLDING_STATES: readonly ForkState[] = [
  "BUILDING", "CHECKING", "RESOLVING", "PAUSING", "REFRESHING",
];

export function nextFork(from: ForkState, event: ForkEvent): ForkTransition | null {
  return FORK_TRANSITIONS.find((t) => t.from === from && t.event === event) ?? null;
}

/**
 * Replenishment competes for the SAME account-wide slot counter that launches
 * use, and always loses.
 *
 * A per-app cap was the right limit at the wrong scope: five apps each
 * replenishing one fork respects "one per app" and still takes every slot. The
 * Solari concurrency limit is per ACCOUNT, so the cap has to be too.
 *
 * "Always loses" is the stronger half. A replenishment holds a slot for the
 * whole BUILDING to PAUSING sequence, of which the pause alone measured
 * 12,428 ms. A visitor arriving during that would queue behind the pool
 * refilling itself, or worse take a 429, which D7 classifies as a guard bug
 * rather than a condition to handle. So replenishment may only start when it
 * would leave at least SLOTS_RESERVED_FOR_VISITORS free afterwards.
 *
 * On Starter (2 slots) that means replenishment runs only when both are free.
 * On Free (1 slot) it means never, which is already the documented policy:
 * `warm_pool_enabled = false`.
 */
export const SLOTS_RESERVED_FOR_VISITORS = Number(process.env.BLINK_SLOTS_RESERVED ?? 1);

/**
 * Whether a replenishment may take a slot right now.
 *
 * Deliberately a function of the ACCOUNT-wide free count, not of anything per
 * app. Called inside the sandbox-slot lock, since it is a read-check-write.
 */
export function replenishMayStart(freeSlots: number): boolean {
  return freeSlots - 1 >= SLOTS_RESERVED_FOR_VISITORS;
}
