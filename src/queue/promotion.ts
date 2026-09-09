/**
 * The queue and its promotion rule.
 *
 * D3: slots are counted in Postgres, never inferred from Solari errors. A 429 is
 * a guard bug, so the queue exists to make sure one never happens rather than to
 * recover from one.
 *
 * The promotion rule is the whole queue. Everything else is bookkeeping.
 */

import { SCOPE_KEYS, type ScopeLock } from "../concurrency/scope-lock.ts";

export type QueueState = "waiting" | "promoted" | "abandoned" | "refused";

export type QueueEntry = {
  id: string;
  appId: string;
  sessionToken: string;
  enqueuedAtMs: number;
  state: QueueState;
};

/**
 * How long an entry may wait before it is abandoned.
 *
 * Five minutes, from `01-prd.md` F5. A visitor who has waited longer than that
 * has almost certainly closed the tab, and holding their place penalises people
 * who are still there.
 */
export const ABANDON_AFTER_MS = Number(process.env.BLINK_QUEUE_ABANDON_MS ?? 5 * 60_000);

/** Floor on the estimate shown, so it never reads as "about 0 seconds". */
export const MIN_ESTIMATE_S = 60;

/**
 * THE PROMOTION RULE, stated once.
 *
 *   An entry is promoted when, and only when, ALL of:
 *     1. it is the OLDEST waiting entry for its app             (fairness)
 *     2. a warm fork for that app is READY, or a cold slot is free  (capacity)
 *     3. the launch would pass every budget ceiling             (affordability)
 *     4. the site is accepting launches                         (health)
 *
 * All four are checked INSIDE the same scope lock that the claim itself takes,
 * because each one is a read-check-write against shared state. The race audit
 * probed this exact site with two concurrent promotions against one free slot
 * and both were admitted, leaving the slot count at -1.
 *
 * The lock key is per app and is deliberately THE SAME KEY the warm fork claim
 * uses (`SCOPE_KEYS.queuePromote` === `SCOPE_KEYS.warmForkClaim`). Promotion and
 * claiming consume one resource, so they must exclude each other; giving them
 * separate keys would let a promotion and a direct launch both take the last
 * fork. They cannot deadlock because neither ever holds two keys.
 */
export type PromotionContext = {
  oldestWaitingId: (appId: string) => Promise<string | null>;
  readyForkCount: (appId: string) => Promise<number>;
  freeColdSlots: () => Promise<number>;
  wouldPassCeilings: () => Promise<boolean>;
  launchesEnabled: () => Promise<boolean>;
};

export type PromotionDecision =
  | { promote: true; path: "warm" | "cold" }
  | { promote: false; reason: "not_oldest" | "no_capacity" | "ceiling" | "launches_disabled" };

export async function decidePromotion(
  entry: QueueEntry,
  ctx: PromotionContext,
): Promise<PromotionDecision> {
  // Health first: it is the cheapest check and the one that should short-circuit
  // everything else when the site has stopped accepting launches.
  if (!(await ctx.launchesEnabled())) return { promote: false, reason: "launches_disabled" };

  // Fairness before capacity, so a later arrival cannot take a slot that the
  // head of the queue is entitled to.
  const oldest = await ctx.oldestWaitingId(entry.appId);
  if (oldest !== entry.id) return { promote: false, reason: "not_oldest" };

  // Affordability before capacity, because a refusal after taking a slot would
  // have to give it back, and a slot handed back is a slot briefly invisible.
  if (!(await ctx.wouldPassCeilings())) return { promote: false, reason: "ceiling" };

  if ((await ctx.readyForkCount(entry.appId)) > 0) return { promote: true, path: "warm" };
  if ((await ctx.freeColdSlots()) > 0) return { promote: true, path: "cold" };
  return { promote: false, reason: "no_capacity" };
}

/**
 * PROMOTION RESERVES. It does not check and hope.
 *
 * The gap this closes: ceilings were checked at promotion while the guard
 * reserved at launch, so an entry could pass promotion and then be refused at
 * reserve. That leaves a warm fork claimed for a launch that never happens, and
 * the fork is the scarcest thing in the system.
 *
 * Two ways to fix it, and this is the one taken:
 *
 *   TAKEN      Promotion reserves against the ledger inside the same lock that
 *              claims the fork. A promoted entry is affordable by construction,
 *              and there is no refusal path after the fork is claimed.
 *   NOT TAKEN  Promotion stays best-effort and the refusal path returns the fork
 *              and re-queues. That path exists only to undo a decision that
 *              should not have been made, and every undo path is a place to
 *              leak a fork. Fewer states beats more recovery.
 *
 * The cost is that a reservation is now held across the launch. If the launch
 * fails, the reservation must be settled at what was actually consumed, which
 * is usually zero. That is the orphan sweeper's existing job, so the failure
 * mode is one the ledger already handles rather than a new one.
 *
 * LOCK ORDERING: the app lock is taken FIRST, then the ledger's scope lock
 * inside it. See the ordering rule in src/concurrency/scope-lock.ts. Nothing may
 * reserve first and then claim a fork, or it deadlocks against this.
 */
export type PromotionReservation = { reservationId: string; release: () => Promise<void> };

export async function promoteUnderLock<T>(
  lock: ScopeLock,
  appId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return lock.run(SCOPE_KEYS.queuePromote(appId), fn);
}

/**
 * The full promote step: decide and reserve atomically, under the app lock.
 *
 * Returns null when the entry is not promoted, with nothing reserved and nothing
 * claimed. Returns a reservation when it is, and the caller owns settling it.
 */
export async function promoteAndReserve(
  lock: ScopeLock,
  entry: QueueEntry,
  ctx: PromotionContext & {
    /** Takes the ledger's own lock internally. Called while holding the app lock. */
    reserve: () => Promise<PromotionReservation>;
    claimFork: (path: "warm" | "cold") => Promise<boolean>;
  },
): Promise<{ path: "warm" | "cold"; reservation: PromotionReservation } | { refused: PromotionDecision }> {
  return promoteUnderLock(lock, entry.appId, async () => {
    const decision = await decidePromotion(entry, ctx);
    if (!decision.promote) return { refused: decision };

    // Reserve BEFORE claiming. If the reservation fails, nothing has been taken
    // and the entry simply stays queued.
    const reservation = await ctx.reserve();
    const claimed = await ctx.claimFork(decision.path);
    if (!claimed) {
      // Capacity vanished between the check and the claim. Impossible while
      // holding this lock, so it means the lock is not covering something it
      // should; release and refuse rather than proceed on a bad assumption.
      await reservation.release();
      return { refused: { promote: false, reason: "no_capacity" } };
    }
    return { path: decision.path, reservation };
  });
}

/**
 * Estimated wait, from `01-prd.md` F5: position times the median instance
 * lifetime over the last hour, floored at 60 s.
 *
 * Deliberately median rather than mean. One visitor who extends to twenty
 * minutes would drag a mean upward and make every queued visitor read a number
 * that describes nobody's actual wait.
 */
export function estimateWaitSeconds(position: number, medianLifetimeS: number): number {
  return Math.max(MIN_ESTIMATE_S, Math.round(position * medianLifetimeS));
}

export function shouldAbandon(entry: QueueEntry, nowMs = Date.now()): boolean {
  return entry.state === "waiting" && nowMs - entry.enqueuedAtMs > ABANDON_AFTER_MS;
}
