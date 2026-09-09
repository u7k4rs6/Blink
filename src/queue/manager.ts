/**
 * The launch queue.
 *
 * Everything expensive is already guarded elsewhere; this exists so that when
 * slots run out a visitor sees a place in line rather than a refusal, and so
 * that the line is fair.
 *
 * `decidePromotion` already encodes the ordering that matters (health, then
 * fairness, then affordability, then capacity). This wraps it in the bookkeeping
 * a server needs: who is waiting, for how long, and who gets asked next.
 *
 * An entry that has waited longer than ABANDON_AFTER_MS is dropped. A visitor
 * who waited five minutes has almost certainly closed the tab, and holding their
 * place penalises the people who are still there.
 */

import { randomUUID } from "node:crypto";

import {
  ABANDON_AFTER_MS, MIN_ESTIMATE_S, decidePromotion,
  type QueueEntry, type PromotionContext,
} from "./promotion.ts";

export type Position = {
  id: string;
  ahead: number;
  estimateSeconds: number;
  state: QueueEntry["state"];
};

export class QueueManager {
  private readonly entries: QueueEntry[] = [];
  private readonly now: () => number;
  /** Median observed launch seconds, used only for the estimate shown. */
  private medianLaunchS = 6;

  constructor(now: () => number = Date.now) { this.now = now; }

  observeLaunchSeconds(s: number): void {
    // A slow smoothing, so one outlier does not make the estimate lurch.
    this.medianLaunchS = this.medianLaunchS * 0.8 + s * 0.2;
  }

  enqueue(appId: string, sessionToken: string): Position {
    this.reap();
    const entry: QueueEntry = {
      id: randomUUID(), appId, sessionToken,
      enqueuedAtMs: this.now(), state: "waiting",
    };
    this.entries.push(entry);
    return this.positionOf(entry.id)!;
  }

  /** Drop entries nobody is waiting on any more. */
  reap(): string[] {
    const cutoff = this.now() - ABANDON_AFTER_MS;
    const dropped: string[] = [];
    for (const e of this.entries) {
      if (e.state === "waiting" && e.enqueuedAtMs < cutoff) {
        e.state = "abandoned";
        dropped.push(e.id);
      }
    }
    return dropped;
  }

  waiting(appId?: string): QueueEntry[] {
    return this.entries.filter((e) =>
      e.state === "waiting" && (appId === undefined || e.appId === appId));
  }

  oldestWaitingId(appId: string): string | null {
    const w = this.waiting(appId);
    return w.length > 0 ? w[0]!.id : null;
  }

  positionOf(id: string): Position | null {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    const ahead = this.waiting(e.appId).findIndex((x) => x.id === id);
    return {
      id,
      ahead: Math.max(0, ahead),
      // Never below MIN_ESTIMATE_S: an estimate of "3 seconds" that is then
      // missed reads as broken, where a conservative one reads as honest.
      estimateSeconds: Math.max(MIN_ESTIMATE_S, Math.round((ahead + 1) * this.medianLaunchS)),
      state: e.state,
    };
  }

  /**
   * Ask whether the head of this app's queue may go now.
   *
   * Returns the entry to promote, or null. The caller does the launching; this
   * only decides, so a launch failure cannot corrupt the queue's own state.
   */
  async nextPromotable(appId: string, ctx: Omit<PromotionContext, "oldestWaitingId">): Promise<{
    entry: QueueEntry; path: "warm" | "cold";
  } | null> {
    this.reap();
    const head = this.waiting(appId)[0];
    if (!head) return null;
    const decision = await decidePromotion(head, {
      ...ctx,
      oldestWaitingId: async (a) => this.oldestWaitingId(a),
    });
    if (!decision.promote) return null;
    return { entry: head, path: decision.path };
  }

  markPromoted(id: string): void {
    const e = this.entries.find((x) => x.id === id);
    if (e) e.state = "promoted";
  }

  /** Only the entry's own holder may leave the queue, hence the token check. */
  leave(id: string, sessionToken: string): boolean {
    const e = this.entries.find((x) => x.id === id && x.sessionToken === sessionToken);
    if (!e || e.state !== "waiting") return false;
    e.state = "abandoned";
    return true;
  }

  depth(appId?: string): number { return this.waiting(appId).length; }
}
