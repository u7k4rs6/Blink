/**
 * The health wall and live board caches.
 *
 * D8: the visitor page reads only this cache. No visitor page action other than
 * Launch, Extend, Destroy and Swarm ever touches Solari, so a Solari outage
 * leaves the catalog, health wall and metrics up rather than taking the site
 * down with it.
 *
 * Two properties matter more than freshness:
 *
 *   STALE BEATS EMPTY   A restart serves the last known values immediately from
 *                       the mirror rather than showing a spinner. Numbers never
 *                       vanish, and a stale number carries its age (04-frontend
 *                       section 1: the muted dot reading "last updated 40s ago").
 *   NEVER THROWS        A read returns the last good value even when the refresh
 *                       behind it is failing, because a cache that throws takes
 *                       down the page whose whole job is to stay up during an
 *                       outage.
 */

export type CacheEntry<T> = {
  value: T;
  /** When the value was produced, not when it was read. */
  updatedAtMs: number;
  /** Consecutive refresh failures since the last success. */
  failures: number;
  lastError: string | null;
};

export type SurfaceCacheOptions<T> = {
  /** Produces a fresh value. May throw; the cache absorbs it. */
  refresh: () => Promise<T>;
  /** How often to refresh. Live board 5 s, health wall 60 s (section 9). */
  intervalMs: number;
  /** Seed, so the very first read is never empty. */
  initial: T;
  /** Persisted mirror, so a restart serves real values rather than the seed. */
  load?: () => Promise<CacheEntry<T> | null>;
  save?: (e: CacheEntry<T>) => Promise<void>;
  onError?: (e: Error) => void;
};

export class SurfaceCache<T> {
  private entry: CacheEntry<T>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: SurfaceCacheOptions<T>;

  constructor(opts: SurfaceCacheOptions<T>) {
    this.opts = opts;
    this.entry = { value: opts.initial, updatedAtMs: 0, failures: 0, lastError: null };
  }

  /** Load the mirror, then refresh once, then start the interval. */
  async start(): Promise<void> {
    if (this.opts.load) {
      try {
        const mirrored = await this.opts.load();
        // updatedAtMs 0 marks the seed, so a mirror always wins over it.
        if (mirrored) this.entry = mirrored;
      } catch (e) { this.opts.onError?.(e as Error); }
    }
    await this.refreshOnce();
    this.timer = setInterval(() => { void this.refreshOnce(); }, this.opts.intervalMs);
    // Do not hold the process open. A cache timer is not a reason for the server
    // to refuse to exit, and an unclosed handle already cost a diagnosis session.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Never throws. Returns the last good value with its age. */
  read(nowMs = Date.now()): CacheEntry<T> & { ageMs: number; stale: boolean } {
    const ageMs = this.entry.updatedAtMs === 0 ? Infinity : nowMs - this.entry.updatedAtMs;
    return {
      ...this.entry,
      ageMs,
      // Stale means "older than two refresh intervals", so one missed tick does
      // not make the page start apologising.
      stale: ageMs > this.opts.intervalMs * 2,
    };
  }

  async refreshOnce(): Promise<void> {
    try {
      const value = await this.opts.refresh();
      this.entry = { value, updatedAtMs: Date.now(), failures: 0, lastError: null };
      if (this.opts.save) {
        try { await this.opts.save(this.entry); } catch (e) { this.opts.onError?.(e as Error); }
      }
    } catch (e) {
      // Keep the old value. A failed refresh must not blank the page.
      this.entry = { ...this.entry, failures: this.entry.failures + 1, lastError: (e as Error).message };
      this.opts.onError?.(e as Error);
    }
  }
}
