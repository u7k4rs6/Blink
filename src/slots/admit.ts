/**
 * The sandbox slot counter.
 *
 * D3: slots are counted in Postgres, never inferred from Solari errors. The
 * whole point is that a 429 never happens, because D7 classifies one as a guard
 * bug rather than a condition to handle.
 *
 * The race audit probed this site with three concurrent launches against a cap
 * of two with one already live, and admitted all three, taking the count to
 * four. Every admission therefore runs inside the account-wide slot lock.
 *
 * Ordering note, now enforced rather than remembered: `sandbox_slot|global` is a
 * rank-1 resource key. A caller that already holds a billing lock cannot take
 * it, and `withHeldKey` throws rather than deadlocking. That is why `admit`
 * takes the slot lock FIRST and reserves inside it, matching promotion.
 */

import { SCOPE_KEYS, type ScopeLock } from "../concurrency/scope-lock.ts";
import { replenishMayStart } from "../warmpool/states.ts";

export type Caller = "launch" | "replenish" | "canary";

export type AdmitContext = {
  /** Slots currently held, counted from Postgres and never from a Solari error. */
  liveSlots: () => Promise<number>;
  maxSlots: number;
  /** Called inside the lock once admission is granted. */
  onAdmit: () => Promise<void>;
};

export type AdmitResult =
  | { admitted: true }
  | { admitted: false; reason: "at_capacity" | "yielded_to_visitors" };

/**
 * Admit a caller to a sandbox slot, or refuse before any Solari call.
 *
 * `replenish` and `canary` yield: they may only take a slot if doing so still
 * leaves SLOTS_RESERVED_FOR_VISITORS free. A visitor must never wait behind the
 * pool refilling itself, and the canary is background work by definition.
 * `launch` may take the last slot, because that is what the last slot is for.
 */
export async function admit(
  lock: ScopeLock,
  caller: Caller,
  ctx: AdmitContext,
): Promise<AdmitResult> {
  return lock.run(SCOPE_KEYS.sandboxSlot(), async () => {
    const live = await ctx.liveSlots();
    const free = ctx.maxSlots - live;

    if (free < 1) return { admitted: false, reason: "at_capacity" };

    // Background callers yield the last slot. Checked inside the lock, because
    // the free count it reads must not change before the decision is acted on.
    if (caller !== "launch" && !replenishMayStart(free)) {
      return { admitted: false, reason: "yielded_to_visitors" };
    }

    await ctx.onAdmit();
    return { admitted: true };
  });
}
