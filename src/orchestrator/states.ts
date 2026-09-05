/**
 * The launch state machine.
 *
 * Written as data rather than as control flow so that the transitions can be
 * tested, drawn, and argued about without running a launch. Every transition
 * below either was measured on day 2 or handles a failure that day 2 showed is
 * reachable.
 *
 * THE WINDOW THIS EXISTS FOR:
 *
 * Handover fires on the loopback health check, which lands at about 300 ms after
 * a resume. The preview URL is a separate thing that may or may not be in hand
 * at that moment. So there is a real interval in which the visitor has been told
 * "ready" and Blink cannot yet give them a working URL. Before day 2 that window
 * was theoretical; the measurements make it concrete:
 *
 *   WARM  the URL was resolved at replenish time and confirmed to survive a
 *         pause (G3), so it is in hand at `ready` and the window is normally
 *         zero. It reopens only if the stored token has gone stale.
 *   COLD  previewUrl() runs concurrently with the health check. It measures
 *         about 300 ms against a health check of about 1,300 ms, so it normally
 *         finishes first and the window is again zero. It is not guaranteed to.
 *
 * "Normally zero" is not "never", which is why URL_PENDING is a state with its
 * own copy and its own timeout rather than a busy-wait inside another state.
 */

export type LaunchState =
  /** No slot. Position and estimated wait are shown; nothing has been spent. */
  | "QUEUED"
  /** Claiming a warm fork, or deciding to build cold. No Solari call yet. */
  | "CLAIMING"
  /** resume() or create() in flight. The expensive step: about 3.6 s warm, 9.5 s cold. */
  | "WAKING"
  /** Polling the app over loopback inside the guest. About 300 ms warm. */
  | "CHECKING"
  /** Health passed. Timer stop one. The URL may or may not be in hand. */
  | "READY"
  /** READY but no usable URL yet. Bounded; see URL_PENDING_TIMEOUT_MS. */
  | "URL_PENDING"
  /** URL handed to the visitor. Their lifetime clock starts HERE, not at READY. */
  | "HANDOVER"
  /** The visitor's browser fetched the first byte. Timer stop two. */
  | "LIVE"
  /** Extension granted. Returns to LIVE. */
  | "EXTENDING"
  /** Expiry, destroy, or a lost sandbox. Killing and settling. */
  | "ENDING"
  /** Terminal, with a receipt. */
  | "ENDED"
  /** Terminal, without a usable instance. Always carries a reason. */
  | "FAILED";

export type LaunchEvent =
  | "SLOT_FREED" | "CLAIMED_WARM" | "NO_WARM_FORK"
  | "WAKE_OK" | "WAKE_FAILED"
  | "HEALTH_OK" | "HEALTH_TIMEOUT"
  | "URL_IN_HAND" | "URL_RESOLVE_FAILED" | "URL_REJECTED" | "URL_PENDING_TIMEOUT"
  | "UNUSABLE_BUDGET_EXHAUSTED" | "STATE_DEADLINE_EXCEEDED"
  | "FIRST_BYTE" | "EXTEND_REQUESTED" | "EXTEND_DONE"
  | "EXPIRED" | "DESTROY_REQUESTED" | "SANDBOX_LOST"
  | "KILLED";

export type Transition = {
  from: LaunchState;
  event: LaunchEvent;
  to: LaunchState;
  /** What the visitor sees while in the destination state. */
  copy?: string;
  note?: string;
};

/**
 * How long the visitor may sit in URL_PENDING before the launch is abandoned.
 *
 * Drawn from measurement: previewUrl() is about 300 ms cold and about 1,300 ms
 * on a resumed sandbox, and the slowest single resolve across 80 samples was
 * under 3 s. Four seconds clears the worst observed case.
 *
 * CONFIGURATION, NOT A CONSTANT. Eighty samples on two apps at one time of day
 * is enough to pick a number and not enough to trust it. The day-7 soak
 * measures whether the tail has moved, and this is the knob that responds.
 */
export const URL_PENDING_TIMEOUT_MS = Number(process.env.BLINK_URL_PENDING_TIMEOUT_MS ?? 4000);

/**
 * Any previewUrl resolve slower than this is logged with its duration.
 *
 * Set below the observed warm p50 of about 1,300 ms so that a shift in the
 * distribution shows up as a rising count rather than as a single breach. The
 * soak checklist reads these; see 02-architecture.md section 13.
 */
export const URL_RESOLVE_LOG_THRESHOLD_MS = Number(process.env.BLINK_URL_RESOLVE_LOG_MS ?? 2000);

/**
 * The whole billing-but-unusable region is bounded, not just each step in it.
 *
 * READY and URL_PENDING both bill and neither is usable by the visitor. Bounding
 * each transition individually leaves the case where every transition is legal
 * and the loop is simply slow, which is exactly what a busy day looks like. So
 * the clock starts on entering READY and covers everything until HANDOVER,
 * regardless of how many legal hops happen in between.
 */
export const MAX_BILLING_UNUSABLE_MS = Number(process.env.BLINK_MAX_UNUSABLE_MS ?? 8000);

/**
 * The invariant, stated so it can be tested rather than hoped for:
 *
 *   NO BILLING STATE PERSISTS LONGER THAN ITS BOUND.
 *
 * "Every billing state can reach ENDED" is too weak. A path that reaches ENDED
 * eventually still bills while it dawdles. Each billing state therefore carries
 * a maximum residency, and the orchestrator kills on breach rather than waiting
 * for a transition that is technically still coming.
 */
export const MAX_STATE_MS: Readonly<Record<string, number>> = {
  // Solari-bound. Cold create measured about 9.5 s p50, 11.7 s p95.
  WAKING: Number(process.env.BLINK_MAX_WAKING_MS ?? 30_000),
  // Loopback health. Measured about 300 ms warm, 1.3 s cold.
  CHECKING: Number(process.env.BLINK_MAX_CHECKING_MS ?? 20_000),
  // Both covered jointly by MAX_BILLING_UNUSABLE_MS as well.
  READY: MAX_BILLING_UNUSABLE_MS,
  URL_PENDING: URL_PENDING_TIMEOUT_MS,
  HANDOVER: Number(process.env.BLINK_MAX_HANDOVER_MS ?? 60_000),
  EXTENDING: Number(process.env.BLINK_MAX_EXTENDING_MS ?? 15_000),
  ENDING: Number(process.env.BLINK_MAX_ENDING_MS ?? 30_000),
  // LIVE is bounded by the instance lifetime, not by this table.
};

/** One re-resolve. Not a loop, and not a retry policy. See TRANSITIONS. */
export const URL_RERESOLVE_ATTEMPTS = 1;

export const TRANSITIONS: readonly Transition[] = [
  { from: "QUEUED", event: "SLOT_FREED", to: "CLAIMING" },

  { from: "CLAIMING", event: "CLAIMED_WARM", to: "WAKING",
    copy: "resuming your instance" },
  { from: "CLAIMING", event: "NO_WARM_FORK", to: "WAKING",
    copy: "building your instance",
    note: "The cold label is chosen HERE, before the timer starts, and never changes mid-run (D2)." },

  { from: "WAKING", event: "WAKE_OK", to: "CHECKING", copy: "checking it answers" },
  { from: "WAKING", event: "WAKE_FAILED", to: "FAILED" },

  // Health is the handover trigger. The URL is a separate race.
  { from: "CHECKING", event: "HEALTH_OK", to: "READY",
    note: "Timer stop one. Does NOT imply a usable URL." },
  { from: "CHECKING", event: "HEALTH_TIMEOUT", to: "ENDING",
    note: "Kill and record end_reason=unhealthy. One cold retry is the orchestrator's business, not this machine's." },
  { from: "CHECKING", event: "URL_RESOLVE_FAILED", to: "ENDING",
    note: "The preview URL is now resolved DURING checking, because the guest boot script needs it: it rewrites the app's ROOT_URL so the app knows what host to build its own links from. Without a URL there is nothing to hand the boot script and nothing to hand a visitor, so this ends rather than waiting." },

  { from: "READY", event: "URL_IN_HAND", to: "HANDOVER" },
  { from: "READY", event: "URL_RESOLVE_FAILED", to: "URL_PENDING",
    copy: "ready, opening it now" },

  // The window. Bounded, with one re-resolve, then given up on.
  { from: "URL_PENDING", event: "URL_IN_HAND", to: "HANDOVER" },
  { from: "READY", event: "UNUSABLE_BUDGET_EXHAUSTED", to: "ENDING",
    note: "The joint READY+URL_PENDING bound tripped. Billing, not usable, so kill." },
  { from: "URL_PENDING", event: "UNUSABLE_BUDGET_EXHAUSTED", to: "ENDING",
    note: "Same bound, reached from the other side. Counts from entry to READY, not to URL_PENDING." },
  { from: "URL_PENDING", event: "URL_PENDING_TIMEOUT", to: "ENDING",
    note: "Alive, healthy and unreachable is the worst combination: it bills while being useless. Kill it." },
  { from: "URL_PENDING", event: "URL_RESOLVE_FAILED", to: "ENDING",
    note: "Second failure. There is no third attempt anywhere in this codebase." },

  { from: "HANDOVER", event: "FIRST_BYTE", to: "LIVE",
    note: "Timer stop two. This is the number the headline publishes." },
  // The visitor's browser rejected the URL after handover: a stale pt_token.
  { from: "HANDOVER", event: "URL_REJECTED", to: "URL_PENDING",
    note: "One explicit re-resolve on a real signal (a 401 the browser saw), not a poll." },
  { from: "LIVE", event: "URL_REJECTED", to: "URL_PENDING",
    note: "The one-hour pt_token can expire under a visitor who extended. Same single re-resolve." },

  { from: "LIVE", event: "EXTEND_REQUESTED", to: "EXTENDING" },
  { from: "EXTENDING", event: "EXTEND_DONE", to: "LIVE" },

  { from: "LIVE", event: "EXPIRED", to: "ENDING" },
  { from: "LIVE", event: "DESTROY_REQUESTED", to: "ENDING" },
  { from: "LIVE", event: "SANDBOX_LOST", to: "ENDING" },
  { from: "HANDOVER", event: "SANDBOX_LOST", to: "ENDING" },
  { from: "READY", event: "SANDBOX_LOST", to: "ENDING" },

  // Any billing state that overstays its bound is killed, whatever it was doing.
  ...(["WAKING", "CHECKING", "READY", "URL_PENDING", "HANDOVER", "EXTENDING"] as const).map(
    (from): Transition => ({ from, event: "STATE_DEADLINE_EXCEEDED", to: "ENDING",
      note: "Bounded residency breached. Legal-but-slow is still billing." }),
  ),

  { from: "ENDING", event: "KILLED", to: "ENDED" },
  /**
   * ENDING can itself stall: the kill call hangs or keeps failing. Staying here
   * is the worst option, because the instance bills while the orchestrator has
   * already given up on it.
   *
   * So a breach moves to ENDED with `end_reason = "kill_unconfirmed"`, and the
   * sandbox id is deliberately LEFT OPEN in the on-disk ledger
   * (src/guard/ledger.ts) so the sweeper reaps it on the next tick or the next
   * process start. This is the one place the two ledgers disagree on purpose:
   * the billing ledger settles and closes the instance, while the sandbox ledger
   * keeps hunting for the machine. A visitor is not held on a page waiting for a
   * kill to confirm, and the machine is still chased.
   */
  { from: "ENDING", event: "STATE_DEADLINE_EXCEEDED", to: "ENDED",
    note: "end_reason=kill_unconfirmed. Settle billing, leave the sandbox id open for the sweeper." },
];

/** States in which the instance is billing and therefore must be killable. */
export const BILLING_STATES: readonly LaunchState[] = [
  "WAKING", "CHECKING", "READY", "URL_PENDING", "HANDOVER", "LIVE", "EXTENDING", "ENDING",
];

/**
 * The visitor's ten minutes start at HANDOVER, not at READY.
 *
 * The sandbox bills from WAKING, so any time spent in READY or URL_PENDING is
 * Blink's cost rather than the visitor's. That is the fair split and it is
 * cheap: the window is normally zero and bounded at four seconds. Starting the
 * clock at READY would charge a visitor for a URL they could not yet use.
 */
export const LIFETIME_STARTS_AT: LaunchState = "HANDOVER";

export function next(from: LaunchState, event: LaunchEvent): Transition | null {
  return TRANSITIONS.find((t) => t.from === from && t.event === event) ?? null;
}

export function isTerminal(s: LaunchState): boolean {
  return s === "ENDED" || s === "FAILED";
}
