/**
 * Per-scope locking, shared by every read-check-write site.
 *
 * WHY THIS IS A SHARED PRIMITIVE AND NOT FIVE LOCAL FIXES:
 *
 * A race audit probed five sites that had not been written yet, each implemented
 * the obvious way, each raced against its own boundary condition. All five
 * failed. The pattern is not a mistake anyone made; it is what read-check-write
 * looks like when written naturally in async code:
 *
 *   const n = await read();      // READ
 *   if (n >= limit) return;      // CHECK   <- another caller runs here
 *   await write(n + 1);          // WRITE
 *
 * Single-threaded JavaScript does not prevent this. It prevents parallel
 * execution, not interleaving at await points, which is a different guarantee
 * and the wrong one to rely on.
 *
 * ON GRANULARITY. A lock at the wrong scope is either a race (too coarse a key
 * that different callers do not share, so they do not exclude) or a throughput
 * bug (too coarse a scope, so unrelated callers queue). Every call site states
 * its key and its reason; see SCOPE_KEYS below.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * LOCK ORDERING, ENFORCED.
 *
 * The ordering rule used to be a comment. A comment is enforced by whoever
 * remembers to read it, and this week produced four bugs that got past someone
 * who knew the right answer. So the rule is now checked at acquisition time and
 * throws at development time, rather than deadlocking under load on day 7.
 *
 * Ranks are the order keys must be taken in. A caller holding a higher-ranked
 * key may not then take a lower-ranked one, because some other caller taking
 * them in the natural order would deadlock against it.
 *
 *   1  RESOURCE   warm_claim, sandbox_slot, share_cap, ip_day
 *   2  BILLING    the ledger's own scope lock
 *
 * Promotion takes a resource lock and then reserves inside it, which is 1 then
 * 2 and legal. A path that reserved and then claimed a fork would be 2 then 1,
 * and is now impossible rather than merely discouraged.
 */
export const LOCK_RANKS: ReadonlyArray<{ prefix: string; rank: number; label: string }> = [
  { prefix: "warm_claim|", rank: 1, label: "resource" },
  { prefix: "sandbox_slot|", rank: 1, label: "resource" },
  { prefix: "share_cap|", rank: 1, label: "resource" },
  { prefix: "ip_day|", rank: 1, label: "resource" },
  // The ledger's keys are `<day>|<scope>|<key>`, which has no distinguishing
  // prefix, so billing is the default rank for anything unrecognised. That is
  // the safe default: an unknown key is treated as late-ordered, so taking a
  // known resource key after it is caught rather than waved through.
];
export const BILLING_RANK = 2;

export function keyRank(key: string): { rank: number; label: string } {
  for (const r of LOCK_RANKS) if (key.startsWith(r.prefix)) return { rank: r.rank, label: r.label };
  return { rank: BILLING_RANK, label: "billing/unclassified" };
}

export class LockOrderViolation extends Error {
  constructor(held: string, heldRank: number, wanted: string, wantedRank: number) {
    super(
      `lock ordering violation: holding ${held} (rank ${heldRank}) and attempting ${wanted} (rank ${wantedRank}).
` +
        `Keys must be acquired in ascending rank: resource locks first, billing locks inside them. ` +
        `Taking them in this order deadlocks against any caller using the natural order.
` +
        `See LOCK_RANKS in src/concurrency/scope-lock.ts. If this is a new legitimate pattern, ` +
        `the rank table is the thing to change, not this call site.`,
    );
    this.name = "LockOrderViolation";
  }
}

/** Keys held by the current async context. */
const held = new AsyncLocalStorage<Array<{ key: string; rank: number }>>();

/** For tests and diagnostics. */
export function currentlyHeldKeys(): string[] {
  return (held.getStore() ?? []).map((h) => h.key);
}

/**
 * Run `fn` recorded as holding `key`, refusing an out-of-order acquisition.
 *
 * Every ScopeLock implementation routes through this, so the check cannot be
 * skipped by adding another one.
 */
export async function withHeldKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const stack = held.getStore() ?? [];
  const wanted = keyRank(key);
  for (const h of stack) {
    if (wanted.rank < h.rank) throw new LockOrderViolation(h.key, h.rank, key, wanted.rank);
  }
  return held.run([...stack, { key, rank: wanted.rank }], fn);
}

export interface ScopeLock {
  /** Run `fn` with exclusive access to `key`. Blocks; never spins, never retries. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * In-process lock. Correct for the single always-on process (D11).
 *
 * A promise chain per key. Each caller awaits the previous holder, so callers on
 * the same key serialise and callers on different keys do not interact at all.
 */
export class MemoryScopeLock implements ScopeLock {
  private chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Ordering is checked BEFORE queueing, so a violating caller fails fast
    // instead of waiting for a lock it must not take.
    return withHeldKey(key, () => this.runInner(key, fn));
  }

  private async runInner<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    // `.then(fn, fn)` runs fn whether the previous holder resolved or rejected,
    // so one caller's failure cannot poison the queue behind it.
    const mine = prior.then(fn, fn);
    // The stored tail must never reject, or the next caller inherits it.
    this.chains.set(key, mine.then(() => undefined, () => undefined));
    try {
      return await mine;
    } finally {
      // Drop the entry once this is the tail, so the map does not grow without
      // bound across a long-running process with per-IP and per-day keys.
      if (this.chains.get(key) === undefined) this.chains.delete(key);
    }
  }
}

/**
 * Cross-process lock, for when Blink is no longer one process.
 *
 * `pg_advisory_xact_lock` blocks and releases on COMMIT or ROLLBACK, so there is
 * no lock to leak. Deliberately not SERIALIZABLE isolation: that resolves the
 * same race by ABORTING a transaction, which then has to be retried, and there
 * is no retry loop anywhere in this codebase.
 */
export class PostgresScopeLock implements ScopeLock {
  private readonly client: { query(t: string, v?: unknown[]): Promise<unknown> };

  constructor(client: { query(t: string, v?: unknown[]): Promise<unknown> }) {
    this.client = client;
  }

  /**
   * Transaction depth on THIS client.
   *
   * Nesting was broken: promotion takes a resource lock and then a billing lock
   * inside it, which issued BEGIN inside BEGIN on one connection. The second
   * BEGIN is a no-op, and the inner COMMIT then ended the OUTER transaction,
   * releasing the outer advisory lock while the outer body was still running.
   * Probed against the real database, and the outer lock was gone.
   *
   * The fix is to nest the LOCK, not the transaction. Advisory transaction locks
   * are re-entrant and all of them release together at the single COMMIT, so an
   * inner acquisition takes its lock inside the transaction that is already open
   * and leaves the commit to the outermost caller. Both keys are then held for
   * the full duration, which is the property promotion needs.
   */
  private depth = 0;

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return withHeldKey(key, () => this.runInner(key, fn));
  }

  private async runInner<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Nested acquisition: take the lock inside the open transaction and let the
    // outermost caller own the commit.
    if (this.depth > 0) {
      await this.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      return fn();
    }

    await this.client.query("BEGIN");
    this.depth += 1;
    try {
      await this.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      const out = await fn();
      await this.client.query("COMMIT");
      return out;
    } catch (err) {
      await this.client.query("ROLLBACK");
      throw err;
    } finally {
      this.depth -= 1;
    }
  }
}

/**
 * THE RULE: the lock key follows the RESOURCE, not the code path.
 *
 * Two paths that consume one resource share a key. Two paths that touch one
 * table but different resources do not. The table is an implementation detail;
 * the thing being depleted is what needs protecting.
 *
 * Applied here: queue promotion and a direct launch both consume the same
 * per-app warm fork, so they share `warm_claim|<app>` even though one arrives
 * through the queue and the other does not. Meanwhile the sandbox slot counter
 * and the share-snapshot cap are both account-wide and both live in the same
 * database, but they deplete different things, so they get different keys and a
 * Share click never waits behind a launch.
 *
 * The two failure modes look nothing alike, which is why the rule is stated
 * rather than left to judgement. Keying by code path gives two paths separate
 * keys for one resource, and they race. Keying by table gives unrelated
 * resources one key, and the site serialises.
 *
 * LOCK ORDERING. A caller that needs two keys always takes them in this order:
 *
 *     1. resource locks   (warm_claim, sandbox_slot, share_cap, ip_day)
 *     2. billing locks    (the ledger's own scope lock)
 *
 * Promotion reserves against the ledger while holding the app lock, so the two
 * are held together. Nothing may take them in the opposite order: a path that
 * reserved first and then claimed a fork would deadlock against promotion.
 * There is no code that needs to, and this comment exists so that it stays true.
 */
export const SCOPE_KEYS = {
  /**
   * Two visitors launching the SAME app must exclude; two launching different
   * apps must not. A global key here would serialise every launch on the site.
   */
  warmForkClaim: (appId: string) => `warm_claim|${appId}`,

  /**
   * Promotion consumes the same per-app resource as claiming, so it shares the
   * key deliberately: one lock covers both, and they cannot deadlock against
   * each other because there is only ever one to take.
   */
  queuePromote: (appId: string) => `warm_claim|${appId}`,

  /**
   * The Solari concurrency cap is per ACCOUNT, so this one is genuinely global.
   * It is the only site here where a global key is correct rather than lazy,
   * which is exactly why the others must not share it: they would inherit a
   * bottleneck they have no reason to pay for.
   */
  sandboxSlot: () => `sandbox_slot|global`,

  /**
   * The 12-live cap is on account-wide storage, so global. Separate key from
   * sandboxSlot because sharing one would make a Share click queue behind an
   * unrelated launch.
   */
  shareSnapshotCap: () => `share_cap|global`,

  /**
   * Per IP per day. The day is in the key so a midnight rollover cannot contend
   * with the previous day, and two visitors never block each other. This is the
   * hottest path on the site, so the key is as narrow as correctness allows.
   */
  ipDailyCount: (day: string, ipHash: string) => `ip_day|${day}|${ipHash}`,

  /** Billing ceilings, already locked inside the ledger's store. */
  billingScope: (day: string, scope: string, key: string) => `${day}|${scope}|${key}`,
} as const;


/**
 * The lock the application actually uses: memory in front, Postgres behind.
 *
 * WHY MEMORY IN FRONT AND NOT A POOL.
 *
 * A pool would give each concurrent caller its own connection, which fixes the
 * shared-client bug. It also introduces a subtler version of it: a pooled
 * connection can be handed back mid-transaction by a caller that failed between
 * BEGIN and COMMIT, and the next holder inherits a session that is already
 * inside a transaction. That is the same class of failure, harder to see, and it
 * depends on connections coming back clean rather than on anything structural.
 *
 * One caller per key by construction is stronger. The memory lock guarantees
 * that at most one caller per key ever reaches Postgres, so the Postgres lock
 * never sees the concurrency that breaks it on a shared client.
 *
 * WHY THE POSTGRES LOCK IS STILL THERE.
 *
 * The memory lock is correct only while Blink is one process (D11). The day it
 * is not, the memory lock silently protects nothing and the Postgres lock is the
 * only real exclusion. Keeping it wired means the second process does not need a
 * rewrite; it needs a flag.
 *
 * Which creates the rot risk: in normal single-process operation the Postgres
 * path is never exercised under contention, so it can break without anyone
 * noticing until the day it matters. Two things guard that. The contract suite
 * exercises PostgresScopeLock DIRECTLY with a connection per caller, never
 * through this layer. And `bypassMemory` runs the Postgres path under real
 * concurrency on purpose, so it can be tested deliberately rather than hoped at.
 */
export class LayeredScopeLock implements ScopeLock {
  private readonly memory: ScopeLock;
  private readonly remote: ScopeLock | null;
  private readonly bypassMemory: boolean;

  constructor(opts: { memory?: ScopeLock; remote?: ScopeLock | null; bypassMemory?: boolean } = {}) {
    this.memory = opts.memory ?? new MemoryScopeLock();
    this.remote = opts.remote ?? null;
    // BLINK_BYPASS_MEMORY_LOCK=1 sends every caller straight at Postgres, so the
    // cross-process path can be put under load deliberately. Never set in
    // production on a single process: it would be slower and no safer.
    this.bypassMemory = opts.bypassMemory ?? process.env.BLINK_BYPASS_MEMORY_LOCK === "1";
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.bypassMemory) {
      if (!this.remote) throw new Error("bypassMemory is set but no remote lock is configured");
      return this.remote.run(key, fn);
    }
    // Memory first: at most one caller per key proceeds. The remote lock then
    // only ever sees a single caller, which is the arrangement it is correct in.
    return this.memory.run(key, () => (this.remote ? this.remote.run(key, fn) : fn()));
  }
}
