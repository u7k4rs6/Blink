/**
 * The three cached surfaces: live board, slots display, health wall.
 *
 * All three are read-only projections built from Postgres, refreshed on their
 * own cadence, and served from memory (D8). No visitor page action other than
 * Launch, Extend, Destroy and Swarm reaches Solari, so a Solari outage leaves
 * every one of these serving real, if ageing, numbers.
 */

import { SurfaceCache } from "./surface.ts";

/** 04-frontend section 1: four cells, sticky at the top of the catalog. */
export type LiveBoard = {
  instancesRunning: number;
  launchedToday: number;
  /** Median of the number the page publishes: time until it is in the browser. */
  medianInBrowserMs: number | null;
  creditsLeftUsd: number;
  creditsTotalUsd: number;
  /** From the ledger's measured/modelled split. The gauge says so on the page. */
  measuredFraction: number;
  /** Set by the drift trip. The gauge reads "reconciling" instead of a number. */
  gaugeState: "ok" | "reconciling";
};

/** Per app, shown inline on the Launch button: "Launch, 2 of 2 slots free". */
export type SlotsDisplay = {
  free: number;
  total: number;
  /** Per app, because the queue is per app even though slots are per account. */
  queueDepth: Record<string, number>;
  /** False disables Launch and shows the reason rather than a spinner. */
  launchesEnabled: boolean;
  disabledReason: string | null;
};

/** 04-frontend section 5: one row per app plus the public canary log. */
export type HealthWall = {
  apps: Array<{
    id: string;
    canaryOk: boolean;
    lastOkAt: string | null;
    /** Both, always. A p50 alone is a claim about the median visitor only. */
    inBrowserP50Ms: number | null;
    inBrowserP95Ms: number | null;
    /** 24 cells, most recent last. */
    history: Array<0 | 1>;
    currentSnapshotId: string | null;
  }>;
  /** Pooled across apps, because the tail is a platform property (G1). */
  platformP95Ms: number | null;
  updatedAt: string;
};

export type SurfaceDeps = {
  liveBoard: () => Promise<LiveBoard>;
  slots: () => Promise<SlotsDisplay>;
  healthWall: () => Promise<HealthWall>;
  load?: (name: string) => Promise<never>;
  save?: (name: string, e: never) => Promise<void>;
  onError?: (surface: string, e: Error) => void;
};

/** Cadences from 02-architecture section 9. */
export const LIVE_BOARD_INTERVAL_MS = Number(process.env.BLINK_LIVE_BOARD_MS ?? 5_000);
export const SLOTS_INTERVAL_MS = Number(process.env.BLINK_SLOTS_MS ?? 5_000);
export const HEALTH_WALL_INTERVAL_MS = Number(process.env.BLINK_HEALTH_WALL_MS ?? 60_000);

export class Surfaces {
  readonly liveBoard: SurfaceCache<LiveBoard>;
  readonly slots: SurfaceCache<SlotsDisplay>;
  readonly healthWall: SurfaceCache<HealthWall>;

  constructor(deps: SurfaceDeps) {
    // Seeds are deliberately honest rather than flattering: zeros and nulls,
    // with the gauge in its normal state. A seed that invented plausible numbers
    // would be indistinguishable from real ones on the first paint after a
    // restart, which is the moment the page is least able to be checked.
    this.liveBoard = new SurfaceCache<LiveBoard>({
      refresh: deps.liveBoard, intervalMs: LIVE_BOARD_INTERVAL_MS,
      initial: { instancesRunning: 0, launchedToday: 0, medianInBrowserMs: null,
        creditsLeftUsd: 0, creditsTotalUsd: 0, measuredFraction: 1, gaugeState: "ok" },
      onError: (e) => deps.onError?.("liveBoard", e),
    });
    this.slots = new SurfaceCache<SlotsDisplay>({
      refresh: deps.slots, intervalMs: SLOTS_INTERVAL_MS,
      initial: { free: 0, total: 0, queueDepth: {}, launchesEnabled: false,
        // Disabled until the first successful refresh: the safe default is to
        // refuse a launch we cannot cost rather than admit one we cannot count.
        disabledReason: "starting up" },
      onError: (e) => deps.onError?.("slots", e),
    });
    this.healthWall = new SurfaceCache<HealthWall>({
      refresh: deps.healthWall, intervalMs: HEALTH_WALL_INTERVAL_MS,
      initial: { apps: [], platformP95Ms: null, updatedAt: new Date(0).toISOString() },
      onError: (e) => deps.onError?.("healthWall", e),
    });
  }

  async start(): Promise<void> {
    await Promise.all([this.liveBoard.start(), this.slots.start(), this.healthWall.start()]);
  }

  stop(): void {
    this.liveBoard.stop(); this.slots.stop(); this.healthWall.stop();
  }
}
