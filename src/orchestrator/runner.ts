/**
 * The launch runner: the thing that turns a button press into a real instance.
 *
 * Everything it needs already existed and was tested in isolation, which is
 * exactly why this file is the risky one. It is the first place where the slot
 * guard, the state machine, the budget ledger, the sandbox ledger and the kill
 * path all have to be right at the same time, against real money.
 *
 * THE INVARIANT THAT MATTERS MOST: a sandbox is recorded before it is created
 * and killed on every exit path, including the ones nobody plans for. The
 * sandbox ledger records intent first, so a create that times out without
 * returning an id still leaves something for the sweeper to find. A leaked
 * sandbox is not a bug that shows up in a test run; it is a bill that arrives
 * later.
 *
 * THE LIFETIME STARTS AT HANDOVER, not at READY (`states.ts`). A visitor whose
 * URL took four seconds to resolve should not lose four seconds of their ten
 * minutes for a wait they did not ask for and cannot see.
 */

import { randomUUID } from "node:crypto";

import type { SolariAdapter } from "../solari/adapter.ts";
import type { BudgetGuard } from "../guard/guard.ts";
import type { SandboxLedger } from "../guard/ledger.ts";
import type { ScopeLock } from "../concurrency/scope-lock.ts";
import { admit } from "../slots/admit.ts";
import { handleFor } from "../redact.ts";
import { buildReceipt, type Receipt } from "../web/receipt.ts";
import { persist, readUnsettled, type PersistedInstance } from "./store.ts";
import type { WarmPool, WarmFork } from "../warmpool/pool.ts";
import { PLANS, type Plan, type Size } from "../guard/rates.ts";
import {
  LIFETIME_STARTS_AT, URL_PENDING_TIMEOUT_MS, next,
  type LaunchEvent, type LaunchState,
} from "./states.ts";

export const DEFAULT_LIFETIME_MS = Number(process.env.BLINK_LIFETIME_MS ?? 10 * 60_000);
/** The guest self-destruct is armed slightly LONGER than the server lifetime. */
const GUEST_GRACE_MS = 60_000;

/**
 * LAYER 3: the dead-man refresh (02-architecture.md section 8).
 *
 * The platform timeout is 180 s with `onTimeout: "kill"`, refreshed by a
 * heartbeat every 45 s, tolerating two consecutive missed beats. It is NOT set
 * longer than the instance lifetime, which is what the first version of this
 * file did on the reasoning that our own expiry should act first.
 *
 * That reasoning was backwards. Our expiry does still act first in the normal
 * case, because 45 s heartbeats keep pushing the platform deadline out. What the
 * long timeout actually bought was a worse failure mode: if the Blink server
 * dies, a sandbox with a twelve minute platform timeout runs for twelve minutes
 * with nothing tracking it, where a 180 s one dies within three. The exposure is
 * `0.057 x (3/60) = $0.0029` per orphan, which is the entire point.
 */
/**
 * The ROOT_URL an app should generate its own links from.
 *
 * The origin, with a trailing slash, and **without the query**. The query is
 * the capability token (V21): baking it into ROOT_URL would put it into every
 * link the app renders, into its web manifest, and into anything a visitor
 * copies out, which is the disclosure this project spends a redaction layer
 * avoiding. The cookie carries the credential for same-origin requests, so the
 * links do not need it.
 */
export function rootUrlFor(previewUrl: string): string {
  const u = new URL(previewUrl);
  return `${u.origin}/`;
}

export const PLATFORM_TIMEOUT_MS = Number(process.env.BLINK_PLATFORM_TIMEOUT_MS ?? 180_000);
export const HEARTBEAT_MS = Number(process.env.BLINK_HEARTBEAT_MS ?? 45_000);

export type Instance = {
  id: string;
  appId: string;
  state: LaunchState;
  /** Never rendered on a crawlable page. Only into the launching session. */
  previewUrl: string | null;
  /** Where the handover drops the visitor. Null means the app's default. */
  landingPath: string | null;
  sandboxId: string | null;
  size: Size;
  createdAt: number;
  /** Set at HANDOVER, not before. Null until then. */
  lifetimeStartedAt: number | null;
  /** The live SDK handle, needed to snapshot a running session (V6). */
  handle?: unknown;
  /** Set when this instance was forked from a share link, not the catalog. */
  fromShareToken?: string;
  /** warm when a pooled fork was resumed, cold when built from the snapshot. */
  path: "warm" | "cold";
  expiresAt: number | null;
  extended: boolean;
  endedReason: string | null;
  receipt: Receipt | null;
  history: Array<{ at: number; from: LaunchState; to: LaunchState; event: LaunchEvent }>;
};

export type RunnerDeps = {
  apiKey: string;
  adapter: SolariAdapter;
  guard: BudgetGuard;
  ledger: SandboxLedger;
  lock: ScopeLock;
  plan?: Plan;
  maxSlots?: number;
  /** Live slot count, from our own records, never inferred from a Solari error. */
  liveSlots: () => Promise<number>;
  waitHealthy: (
    exec: (cmd: string, o?: { timeoutMs?: number }) => Promise<{ value: { stdout: string; stderr: string } }>,
    port: number, path: string,
  ) => Promise<{ ok: boolean; ms: number }>;
  /** Optional. Without it every launch is cold, which is a valid configuration. */
  pool?: WarmPool;
  now?: () => number;
};

export class LaunchRefused extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "LaunchRefused";
    this.reason = reason;
  }
}

export class LaunchRunner {
  private readonly d: RunnerDeps;
  private readonly instances = new Map<string, Instance>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();

  constructor(deps: RunnerDeps) {
    this.d = deps;
  }

  get plan(): Plan { return this.d.plan ?? PLANS.starter; }
  /** Exposed so the share service can snapshot a live session (V6). */
  get adapter(): SolariAdapter { return this.d.adapter; }
  get apiKey(): string { return this.d.apiKey; }
  /** Shared so background work admits through the SAME lock as launches. */
  get lock(): ScopeLock { return this.d.lock; }

  /** Attach a pool after construction, since the pool needs the runner first. */
  attachPool(pool: WarmPool): void { this.d.pool = pool; }

  /** Delete a snapshot. Used by the share expiry sweeper, which is the only
   *  thing that reclaims storage the budget guard cannot see (V56). */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.d.adapter.deleteSnapshot(this.d.apiKey, "share:sweep", snapshotId);
  }
  private now(): number { return (this.d.now ?? Date.now)(); }

  get(id: string): Instance | undefined { return this.instances.get(id); }
  all(): Instance[] { return [...this.instances.values()]; }
  liveCount(): number {
    return this.all().filter((i) => !["ENDED", "FAILED"].includes(i.state)).length;
  }

  /** Apply an event through the state table. An illegal transition throws. */
  private step(inst: Instance, event: LaunchEvent): void {
    const t = next(inst.state, event);
    if (!t) {
      throw new Error(`illegal transition: ${inst.state} on ${event}`);
    }
    inst.history.push({ at: this.now(), from: inst.state, to: t.to, event });
    inst.state = t.to;
    this.save(inst);
    if (t.to === LIFETIME_STARTS_AT && inst.lifetimeStartedAt === null) {
      // The clock starts when the visitor can use it, not when we became ready.
      inst.lifetimeStartedAt = this.now();
      inst.expiresAt = inst.lifetimeStartedAt + DEFAULT_LIFETIME_MS;
    }
  }

  /**
   * Launch one instance.
   *
   * Refuses before any Solari call when there is no slot. That refusal is the
   * cheapest thing this class does and the most important: every failure mode
   * downstream of a create costs money, and this one costs nothing.
   */
  async launch(opts: {
    appId: string; snapshotId: string; size: Size; port: number; healthPath: string;
    fromShareToken?: string;
    /** Refreshes data that is only meaningful relative to launch time. */
    postFork?: string;
    landingPath?: string;
  }): Promise<Instance> {
    const inst: Instance = {
      id: randomUUID(), appId: opts.appId, state: "CLAIMING",
      previewUrl: null, landingPath: opts.landingPath ?? null, sandboxId: null, size: opts.size,
      createdAt: this.now(), lifetimeStartedAt: null, expiresAt: null,
      extended: false, endedReason: null, receipt: null, history: [],
      fromShareToken: opts.fromShareToken, path: "cold",
    };

    /**
     * WARM PATH FIRST.
     *
     * A claimed fork is already paused, already healthy, and already carries a
     * resolved previewUrl, so this path pays for a resume and nothing else. It
     * holds no slot while paused (V19, V20), so claiming one does not need slot
     * admission: ownership simply transfers.
     *
     * A share launch never uses the pool. The whole point of a share is somebody
     * else's state, and a pooled fork carries the catalog snapshot's.
     */
    const warm = opts.fromShareToken ? null : this.d.pool?.claim(opts.appId) ?? null;
    if (warm) {
      try {
        return await this.resumeWarm(inst, warm, opts);
      } catch (err) {
        // The fork was unusable. Kill it and fall through to a cold build rather
        // than failing a launch over a pool problem the visitor did not cause.
        this.d.pool?.markDead(warm.id);
        await this.d.adapter.killQuiet(this.d.apiKey, warm.sandboxId, `launch:${opts.appId}`);
        inst.history.push({ at: this.now(), from: inst.state, to: inst.state, event: "NO_WARM_FORK" });
      }
    }

    let admitted = false;
    const result = await admit(this.d.lock, "launch", {
      liveSlots: this.d.liveSlots,
      maxSlots: this.d.maxSlots ?? this.plan.maxSandboxes,
      onAdmit: async () => { admitted = true; this.instances.set(inst.id, inst); },
    });
    if (!result.admitted || !admitted) {
      throw new LaunchRefused(result.admitted ? "unknown" : result.reason,
        result.admitted ? "admission did not complete" : `no sandbox slot: ${result.reason}`);
    }

    // Intent BEFORE the call. A create that times out without returning an id
    // still leaves the sweeper something to hunt.
    const token = this.d.ledger.intent(`launch:${opts.appId}`, inst.id);
    const bornAt = this.now();

    try {
      this.step(inst, "NO_WARM_FORK");
      const sb = await this.d.adapter.createSandbox(
        this.d.apiKey, `launch:${opts.appId}`,
        {
          fromSnapshot: opts.snapshotId, cpu: opts.size.cpu, memMb: opts.size.memMb,
          // Layer 3. Short, and kept alive by the heartbeat below.
          timeoutMs: PLATFORM_TIMEOUT_MS,
          lifecycle: { onTimeout: "kill" },
          metadata: { blink_instance: inst.id, blink_app: opts.appId },
        },
        0.02,
      );
      inst.sandboxId = sb.value.sandboxId;
      inst.handle = sb.value;
      this.d.ledger.opened(inst.sandboxId, `launch:${opts.appId}`, token);
      this.step(inst, "WAKE_OK");

      const sh = (cmd: string, o?: { timeoutMs?: number }) =>
        this.d.adapter.exec(this.d.apiKey, sb.value, `launch:${opts.appId}`, cmd, o);

      /*
       * previewUrl FIRST, because the boot script needs it.
       *
       * `blink-boot` takes `<root_url> <lifetime_seconds>` and rewrites the
       * app's own ROOT_URL to it, which is how an app knows what host to build
       * its links from. This called it as `blink-boot arm <seconds>`, inventing
       * a subcommand the script does not have, so Gitea's ROOT_URL was set to
       * the literal string **arm** on every launch. Gitea then emitted
       * `arm/assets/...` as a RELATIVE url, which the browser resolved against
       * whatever page it was on: `/arm/assets/...` at the root, and
       * `/blink/welcome/arm/assets/...` at the landing path. Every stylesheet
       * and script 404ed and the page arrived unstyled.
       *
       * Resolving previewUrl before the health check is safe: it asks the API
       * for a route to a port and does not require anything to be listening.
       */
      const pvEarly = await this.d.adapter.previewUrl(this.d.apiKey, sb.value, `launch:${opts.appId}`, opts.port);
      if (!pvEarly.value.url) {
        this.step(inst, "URL_RESOLVE_FAILED");
        await this.end(inst, "no preview url");
        return inst;
      }
      inst.previewUrl = pvEarly.value.url;

      // Arm the guest self-destruct BEFORE handing over. Layer 2 of the expiry
      // design (V61), and the only layer indifferent to visitor activity.
      const lifetimeSecs = Math.round((DEFAULT_LIFETIME_MS + GUEST_GRACE_MS) / 1000);
      await sh(
        `/usr/local/bin/blink-boot ${JSON.stringify(rootUrlFor(pvEarly.value.url))} ${lifetimeSecs} || true`,
        { timeoutMs: 25_000 },
      );

      const health = await this.d.waitHealthy(sh, opts.port, opts.healthPath);
      if (health.ok && opts.postFork) {
        // Never fatal. Stale seed data is a worse instance, not a broken one,
        // and failing a launch over it would trade a blemish for an outage.
        const out = await sh(opts.postFork, { timeoutMs: 45_000 })
          .then((r) => r.value.stdout ?? "")
          .catch(() => "");
        /*
         * A postFork may name where the visitor should land.
         *
         * Metabase needs it: the question it lands on is created at boot and its
         * id is not known until then. Everything else uses a static landingPath.
         * Parsed rather than trusted: a path only, so a postFork cannot redirect
         * a visitor off the instance.
         */
        const named = /BLINK_LANDING=(\S+)/.exec(out)?.[1];
        if (named !== undefined && named.startsWith("/")) inst.landingPath = named;
      }
      if (!health.ok) {
        this.step(inst, "HEALTH_TIMEOUT");
        await this.end(inst, "never became healthy");
        return inst;
      }
      this.step(inst, "HEALTH_OK");

      // Resolved above, before the boot script, because ROOT_URL depends on it.
      this.step(inst, "URL_IN_HAND");

      // HANDOVER starts the visitor's clock, and only now do we schedule expiry.
      this.scheduleExpiry(inst);
      this.startHeartbeat(inst);
      return inst;
    } catch (err) {
      inst.endedReason = `${(err as Error).name}: ${(err as Error).message}`;
      await this.end(inst, inst.endedReason, { bornAt });
      throw err;
    }
  }

  /** Write the instance's current shape, so a restart can adopt it. */
  private save(inst: Instance): void {
    persist({
      id: inst.id, appId: inst.appId, sandboxId: inst.sandboxId, state: inst.state,
      createdAt: inst.createdAt, lifetimeStartedAt: inst.lifetimeStartedAt,
      expiresAt: inst.expiresAt, extended: inst.extended,
      settled: inst.receipt !== null,
      sizeCpu: inst.size.cpu, sizeMemMb: inst.size.memMb,
    });
  }

  /**
   * Push the platform deadline out, every HEARTBEAT_MS.
   *
   * If this stops, the sandbox dies on its own within PLATFORM_TIMEOUT_MS. That
   * is the whole design: the absence of a heartbeat IS the signal, so a server
   * that crashes without running any cleanup still bounds its own damage.
   */
  private startHeartbeat(inst: Instance): void {
    if (!inst.handle) return;
    const beat = async () => {
      if (inst.receipt) return;
      try {
        await (inst.handle as { setTimeout: (ms: number) => Promise<unknown> })
          .setTimeout(PLATFORM_TIMEOUT_MS);
      } catch {
        // A failed beat is tolerated: the design allows two consecutive misses
        // before the platform acts, and acting here would kill a live instance
        // over one flaky call.
      }
    };
    const t = setInterval(() => { void beat(); }, HEARTBEAT_MS);
    if (typeof t.unref === "function") t.unref();
    this.heartbeats.set(inst.id, t);
  }

  private stopHeartbeat(id: string): void {
    const h = this.heartbeats.get(id);
    if (h) { clearInterval(h); this.heartbeats.delete(id); }
  }

  /**
   * Adopt instances left behind by a previous process.
   *
   * Anything past its expiry is killed and settled. Anything still inside its
   * lifetime keeps running, with its timer and heartbeat re-armed. Without this
   * a restart silently abandons every live instance, and the only thing that
   * eventually stops them is layer 3.
   */
  async adoptOrphans(kill: (sandboxId: string) => Promise<void>): Promise<{
    adopted: string[]; killed: string[];
  }> {
    const adopted: string[] = [];
    const killed: string[] = [];
    for (const row of readUnsettled()) {
      const expired = row.expiresAt === null || row.expiresAt <= this.now();
      if (expired) {
        try { await kill(row.sandboxId!); } catch { /* the sweeper hunts it next */ }
        persist({ ...row, settled: true, state: "ENDED" });
        killed.push(row.id);
        continue;
      }
      // Still inside its lifetime. It keeps running, but we can no longer
      // heartbeat it (the SDK handle died with the old process), so layer 3
      // now bounds it at PLATFORM_TIMEOUT_MS. That is the backstop working.
      adopted.push(row.id);
      persist({ ...row, state: "ENDING" });
      try { await kill(row.sandboxId!); } catch { /* ditto */ }
      persist({ ...row, settled: true, state: "ENDED" });
    }
    return { adopted, killed };
  }

  /**
   * Resume a pooled fork and hand it straight over.
   *
   * No health poll and no URL resolve: both already happened on our clock when
   * the fork was built, which is the entire reason the pool exists.
   */
  private async resumeWarm(inst: Instance, warm: WarmFork, opts: { appId: string }): Promise<Instance> {
    const bornAt = this.now();
    inst.path = "warm";
    inst.sandboxId = warm.sandboxId;
    inst.handle = warm.handle;
    this.d.ledger.opened(warm.sandboxId, `launch:${opts.appId}`, undefined);

    this.step(inst, "CLAIMED_WARM");
    await this.d.adapter.resume(this.d.apiKey, warm.handle as never, `launch:${opts.appId}`);
    this.step(inst, "WAKE_OK");
    this.step(inst, "HEALTH_OK");

    inst.previewUrl = warm.previewUrl;
    this.step(inst, "URL_IN_HAND");

    await this.d.adapter.exec(
      this.d.apiKey, warm.handle as never, `launch:${opts.appId}`,
      // Same contract as the cold path: <root_url> <lifetime_seconds>.
      `/usr/local/bin/blink-boot ${JSON.stringify(rootUrlFor(warm.previewUrl))} ` +
      `${Math.round((DEFAULT_LIFETIME_MS + GUEST_GRACE_MS) / 1000)} || true`,
      { timeoutMs: 20_000 },
    ).catch(() => { /* the boot script is a backstop, not a launch blocker */ });

    this.scheduleExpiry(inst);
    this.startHeartbeat(inst);
    void bornAt;
    return inst;
  }

  private scheduleExpiry(inst: Instance): void {
    if (inst.expiresAt === null) return;
    const delay = Math.max(0, inst.expiresAt - this.now());
    const t = setTimeout(() => { void this.end(inst, "expired"); }, delay);
    // Never hold the process open for an instance timer.
    if (typeof t.unref === "function") t.unref();
    this.timers.set(inst.id, t);
  }

  /** One extension, once, and the label says so afterwards. */
  async extend(id: string): Promise<{ ok: boolean; reason?: string }> {
    const inst = this.instances.get(id);
    if (!inst) return { ok: false, reason: "unknown instance" };
    if (inst.extended) return { ok: false, reason: "already extended once" };
    if (!["HANDOVER", "LIVE"].includes(inst.state)) return { ok: false, reason: `cannot extend from ${inst.state}` };
    inst.extended = true;
    inst.expiresAt = (inst.expiresAt ?? this.now()) + DEFAULT_LIFETIME_MS;
    const old = this.timers.get(id);
    if (old) clearTimeout(old);
    this.scheduleExpiry(inst);
    return { ok: true };
  }

  /**
   * End an instance and settle it. Safe to call twice, and called from the
   * expiry timer, the destroy button, a failed launch and process shutdown.
   */
  async end(inst: Instance, reason: string, opts: { bornAt?: number } = {}): Promise<Receipt> {
    if (inst.receipt) return inst.receipt;

    const timer = this.timers.get(inst.id);
    if (timer) { clearTimeout(timer); this.timers.delete(inst.id); }
    this.stopHeartbeat(inst.id);

    const bornAt = opts.bornAt ?? inst.createdAt;
    const seconds = Math.max(0, (this.now() - bornAt) / 1000);

    if (inst.sandboxId) {
      // killQuiet, because a failure here must not stop the settlement. The
      // sandbox ledger keeps the id open so the sweeper hunts it again.
      await this.d.adapter.killQuiet(this.d.apiKey, inst.sandboxId, `launch:${inst.appId}`);
      this.d.guard.addSandboxSeconds(seconds, inst.size, true, `instance ${handleFor(inst.id)}`);
    }

    inst.endedReason = inst.endedReason ?? reason;
    // A lost sandbox and a clean expiry produce different receipts, and the
    // visitor is told which one happened.
    const lost = reason === "lost" || /lost|never became healthy|no preview url/.test(reason);
    inst.receipt = buildReceipt({
      plan: this.plan, size: inst.size, sandboxSeconds: seconds, lost,
    });
    if (inst.state !== "ENDED" && inst.state !== "FAILED") {
      inst.state = reason === "expired" || reason === "destroyed" ? "ENDED" : "FAILED";
    }
    // Both point at something that no longer exists. The URL is a bearer
    // capability, and a stale handle would let a later share snapshot a dead
    // sandbox, so neither outlives the instance.
    inst.previewUrl = null;
    inst.handle = undefined;
    this.save(inst);
    return inst.receipt;
  }

  /** Kill everything. Called on SIGINT and on shutdown. */
  async endAll(reason = "shutdown"): Promise<void> {
    await Promise.all(this.all()
      .filter((i) => !i.receipt)
      .map((i) => this.end(i, reason)));
  }

  msRemaining(inst: Instance): number | null {
    return inst.expiresAt === null ? null : Math.max(0, inst.expiresAt - this.now());
  }
}

export { URL_PENDING_TIMEOUT_MS };
