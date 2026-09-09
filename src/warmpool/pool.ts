/**
 * The warm pool: paused forks with their previewUrl already resolved.
 *
 * A paused sandbox holds no concurrency slot and does not bill (V19, V20), so a
 * pool of them is cheap to keep and turns a cold launch into a resume. The URL
 * is resolved BEFORE the pause, on our clock rather than a visitor's, which is
 * the whole point: the claim path never pays the 1,238 ms resolve.
 *
 * THE KILL CRITERION IS LIVE (01-prd.md section 9). If G1 shows cold p95 within
 * 500 ms of warm p50, this whole file is deleted rather than kept for its own
 * sake. `poolIsWorthIt()` below is that decision expressed as code, so the
 * criterion cannot quietly stop being applied.
 *
 * Two rules that are not negotiable, both from the slot design:
 *
 *   - replenishment YIELDS. It may only take a slot if doing so still leaves
 *     SLOTS_RESERVED_FOR_VISITORS free. A visitor must never wait behind the
 *     pool refilling itself.
 *   - a stored URL past URL_REFRESH_AFTER_MS is refreshed, never handed over.
 *     The pt_token lasts an hour (V21) and a stale one fails in the visitor's
 *     browser, which is the worst place to discover it.
 */

import type { SolariAdapter } from "../solari/adapter.ts";
import type { ScopeLock } from "../concurrency/scope-lock.ts";
import { admit } from "../slots/admit.ts";
import { URL_REFRESH_AFTER_MS, replenishMayStart } from "./states.ts";
import type { Size } from "../guard/rates.ts";

export type WarmFork = {
  id: string;
  appId: string;
  sandboxId: string;
  /** Resolved before the pause, so the claim path does not pay for it. */
  previewUrl: string;
  urlResolvedAt: number;
  size: Size;
  handle: unknown;
  state: "READY" | "CLAIMED" | "REFRESHING" | "DEAD";
};

export type PoolDeps = {
  apiKey: string;
  adapter: SolariAdapter;
  lock: ScopeLock;
  liveSlots: () => Promise<number>;
  maxSlots: number;
  /** Target depth per app. Zero disables the pool for that app. */
  depth: (appId: string) => number;
  waitHealthy: (
    exec: (cmd: string, o?: { timeoutMs?: number }) => Promise<{ value: { stdout: string; stderr: string } }>,
    port: number, path: string,
  ) => Promise<{ ok: boolean; ms: number }>;
  now?: () => number;
};

/**
 * The G1 kill criterion, as code.
 *
 * A warm pool that saves less than half a second is complexity with no visible
 * benefit, and the honest thing is to delete it rather than keep it because it
 * was built. Returns false when cold is close enough that the pool is not
 * earning its place.
 */
export function poolIsWorthIt(coldP95Ms: number, warmP50Ms: number, thresholdMs = 500): boolean {
  return coldP95Ms - warmP50Ms > thresholdMs;
}

export class WarmPool {
  private readonly d: PoolDeps;
  private readonly forks = new Map<string, WarmFork>();
  private replenishing = new Set<string>();

  constructor(deps: PoolDeps) { this.d = deps; }

  private now(): number { return (this.d.now ?? Date.now)(); }

  ready(appId: string): WarmFork[] {
    return [...this.forks.values()].filter((f) => f.appId === appId && f.state === "READY");
  }
  all(): WarmFork[] { return [...this.forks.values()]; }
  depthFor(appId: string): number { return this.ready(appId).length; }

  /**
   * Take a warm fork if one is usable, otherwise return null and let the caller
   * go cold. Never blocks a launch waiting for the pool.
   */
  claim(appId: string): WarmFork | null {
    for (const f of this.ready(appId)) {
      const age = this.now() - f.urlResolvedAt;
      if (age >= URL_REFRESH_AFTER_MS) {
        // Stale URL. Do not hand it over: a dead pt_token fails in the
        // visitor's browser, which is the worst place to find out.
        f.state = "REFRESHING";
        continue;
      }
      f.state = "CLAIMED";
      this.forks.delete(f.id);
      return f;
    }
    return null;
  }

  /** Put a fork back if a claim could not be used after all. */
  release(fork: WarmFork): void {
    if (fork.state !== "CLAIMED") return;
    fork.state = "READY";
    this.forks.set(fork.id, fork);
  }

  markDead(id: string): void {
    const f = this.forks.get(id);
    if (f) { f.state = "DEAD"; this.forks.delete(id); }
  }

  /**
   * Build one fork and park it paused, if a slot can be spared.
   *
   * Every early return is a refusal that costs nothing, which is the shape the
   * whole project uses: decide before spending, never after.
   */
  async replenishOne(app: {
    appId: string; snapshotId: string; size: Size; port: number; healthPath: string;
    landingPath?: string;
  }): Promise<{ built: boolean; reason?: string }> {
    if (this.d.depth(app.appId) === 0) return { built: false, reason: "pool disabled for this app" };
    if (this.depthFor(app.appId) >= this.d.depth(app.appId)) return { built: false, reason: "at target depth" };
    if (this.replenishing.has(app.appId)) return { built: false, reason: "already replenishing" };

    const free = this.d.maxSlots - (await this.d.liveSlots());
    if (!replenishMayStart(free)) return { built: false, reason: "yielded to visitors" };

    this.replenishing.add(app.appId);
    let sandboxId: string | null = null;
    try {
      let admitted = false;
      const res = await admit(this.d.lock, "replenish", {
        liveSlots: this.d.liveSlots, maxSlots: this.d.maxSlots,
        onAdmit: async () => { admitted = true; },
      });
      if (!res.admitted || !admitted) return { built: false, reason: res.admitted ? "unknown" : res.reason };

      const sb = await this.d.adapter.createSandbox(
        this.d.apiKey, `warm:${app.appId}`,
        { fromSnapshot: app.snapshotId, cpu: app.size.cpu, memMb: app.size.memMb,
          timeoutMs: 180_000, lifecycle: { onTimeout: "kill" },
          metadata: { blink_warm: app.appId } },
        0.02,
      );
      sandboxId = sb.value.sandboxId;

      const sh = (cmd: string, o?: { timeoutMs?: number }) =>
        this.d.adapter.exec(this.d.apiKey, sb.value, `warm:${app.appId}`, cmd, o);
      const h = await this.d.waitHealthy(sh, app.port, app.healthPath);
      if (!h.ok) throw new Error("warm fork never became healthy");

      // Resolve BEFORE pausing. This is the entire saving.
      const pv = await this.d.adapter.previewUrl(this.d.apiKey, sb.value, `warm:${app.appId}`, app.port);
      if (!pv.value.url) throw new Error("warm fork resolved no preview url");

      await this.d.adapter.pause(this.d.apiKey, sb.value, `warm:${app.appId}`);

      const fork: WarmFork = {
        id: `${app.appId}-${sandboxId}`, appId: app.appId, sandboxId,
        previewUrl: pv.value.url, urlResolvedAt: this.now(),
        size: app.size, handle: sb.value, state: "READY",
      };
      this.forks.set(fork.id, fork);
      sandboxId = null;
      return { built: true };
    } catch (err) {
      // A fork that failed anywhere is killed here. A half-built warm fork is a
      // sandbox nobody will ever claim and nothing else will ever look for.
      if (sandboxId) await this.d.adapter.killQuiet(this.d.apiKey, sandboxId, `warm:${app.appId}`);
      return { built: false, reason: (err as Error).message };
    } finally {
      this.replenishing.delete(app.appId);
    }
  }

  /** Kill every parked fork. Called on shutdown, same as instances. */
  async drain(): Promise<number> {
    const forks = this.all();
    for (const f of forks) {
      await this.d.adapter.killQuiet(this.d.apiKey, f.sandboxId, `warm:${f.appId}`);
      this.forks.delete(f.id);
    }
    return forks.length;
  }
}
