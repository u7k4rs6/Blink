/**
 * Sandbox ledger: record every sandbox before it is created, sweep at exit,
 * assert zero live afterwards.
 *
 * Ported from thrice (thrice/env/ledger.py). This is a correctness check, not a
 * budget feature. The bug it exists to catch is a sandbox the harness does not
 * know it owns. From thrice's own record, that happened twice:
 *
 *   Day 3  acquire() created a sandbox internally, then failed before handing it
 *          back, so the caller's finally block had nothing to kill. It billed
 *          for about ten minutes and was found only by a manual sweep.
 *   Day 4  A foreground run was killed by a shell timeout mid-attempt. No
 *          finally and no exit hook runs when the process is killed, so again
 *          the leak was invisible until swept by hand.
 *
 * The second case is why the ledger is on DISK rather than in memory. An
 * in-process registry dies with the process that leaked. A file survives, so the
 * next run, or `npm run sweep`, reaps what the last one abandoned.
 *
 * The design rule, unchanged: the record is written BEFORE the sandbox is
 * created, never after, because a create that times out may still have created
 * something whose id we never learn.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { handleFor } from "../redact.ts";
import { safeErr } from "../safe-io.ts";

export type LedgerRecord = {
  kind: "intent" | "open" | "closed" | "sweep";
  /** Which resource this record is about. Absent means sandbox, for records
   *  written before browser sessions were tracked. */
  res?: "sandbox" | "browser";
  ts: number;
  token?: string;
  sandboxId?: string;
  gate?: string;
  note?: string;
  results?: unknown;
};

export class LeakDetected extends Error {
  readonly liveIds: string[];
  constructor(message: string, liveIds: string[]) {
    super(message);
    this.name = "LeakDetected";
    this.liveIds = liveIds;
  }
}

export const DEFAULT_LEDGER_PATH =
  process.env.BLINK_LEDGER ?? join(homedir(), ".blink", "sandboxes.jsonl");

/** Repository root, derived from this module's own location. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export class LedgerInsideRepo extends Error {
  constructor(path: string) {
    super(
      `refusing to open a ledger inside the repository: ${path}\n` +
        `The ledger holds UNREDACTED sandbox ids, which decode to Solari's host pool ` +
        `identifier and this org's id. It is the one file in this codebase exempt from ` +
        `redaction, and that exemption is justified purely by living outside the repo, ` +
        `outside anything published, and inside .gitignore.\n` +
        `A copy inside the repo would publish it. Set BLINK_LEDGER to a path under your ` +
        `home directory, or leave it at the default.`,
    );
    this.name = "LedgerInsideRepo";
  }
}

/**
 * The ledger exemption is safe-by-location, so the location is CHECKED rather
 * than assumed.
 *
 * A stray copy during a rushed day, a `cp ~/.blink/sandboxes.jsonl .` while
 * debugging a leak, or a BLINK_LEDGER pointed at `./tmp` would quietly move
 * unredacted infrastructure identifiers into a repository headed for a public
 * remote. This turns that into a startup failure instead.
 */
export function assertOutsideRepo(path: string): void {
  const rel = relative(REPO_ROOT, resolve(path));
  const inside = rel !== "" && !rel.startsWith("..");
  if (inside) throw new LedgerInsideRepo(path);
}

export class SandboxLedger {
  readonly path: string;
  private readonly baseUrl: string;
  private installed = false;

  constructor(path: string = DEFAULT_LEDGER_PATH, baseUrl = "https://api.getsolari.com") {
    this.path = path;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    assertOutsideRepo(this.path);
    mkdirSync(dirname(this.path), { recursive: true });
  }

  private append(rec: Omit<LedgerRecord, "ts">): void {
    const line = JSON.stringify({ ...rec, ts: Date.now() / 1000 });
    // Synchronous and flushed: this must survive a kill between the write and
    // the create it is protecting.
    // NOT redacted, and this is the ONE deliberate exception in the codebase.
    //
    // The ledger's whole job is to hold real sandbox ids so a later process can
    // kill what this one leaked. Redacting it would turn every recovery into a
    // no-op and convert a disclosure risk into a credit-leak certainty, which is
    // the worse failure by a wide margin.
    //
    // It is safe because of where it lives, not because of what it contains:
    // ~/.blink/sandboxes.jsonl is outside the repository, is in .gitignore, and
    // is never published, screenshotted or served. Nothing under docs/ or any
    // report writer touches it.
    appendFileSync(this.path, line + "\n", { flush: true });
  }

  /**
   * Record the INTENT to create, before the API call.
   *
   * A create that times out or resets can still have created a sandbox whose id
   * the client never learns. Recording intent means the sweep at least knows to
   * go looking, even when there is no id to record.
   */
  intent(gate: string, note = ""): string {
    const token = `intent-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.append({ kind: "intent", token, gate, note });
    return token;
  }

  opened(sandboxId: string, gate: string, token?: string): void {
    this.append({ kind: "open", sandboxId, gate, token });
  }

  closed(sandboxId: string): void {
    this.append({ kind: "closed", sandboxId });
  }

  /** Ids recorded open and never recorded closed, across every run ever. */
  openIds(res: "sandbox" | "browser" = "sandbox"): string[] {
    if (!existsSync(this.path)) return [];
    const opened: string[] = [];
    const closed = new Set<string>();
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r: LedgerRecord;
      try {
        r = JSON.parse(line) as LedgerRecord;
      } catch {
        continue;
      }
      if ((r.res ?? "sandbox") !== res) continue;
      if (r.kind === "open" && r.sandboxId) opened.push(r.sandboxId);
      else if (r.kind === "closed" && r.sandboxId) closed.add(r.sandboxId);
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of opened) {
      if (!closed.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }

  /**
   * Blocking DELETE for every open id, using the raw gateway rather than the
   * SDK. Deliberately not routed through the counting fetch: this runs during
   * process teardown, where the guard may already be gone, and a kill that
   * fails is worse than a kill that is unaccounted for. Kills are idempotent
   * (00-verification.md V9), so a redundant one is free.
   */
  async sweep(apiKey: string, reason = "exit"): Promise<Array<Record<string, unknown>>> {
    const ids = this.openIds();
    if (ids.length === 0) return [];
    const results: Array<Record<string, unknown>> = [];
    for (const id of ids) {
      try {
        const res = await fetch(`${this.baseUrl}/sandboxes/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(20_000),
        });
        const ok = res.status === 200 || res.status === 204 || res.status === 404;
        results.push({ sandboxId: handleFor(id), status: res.status, ok });
        if (ok) this.closed(id);
      } catch (err) {
        results.push({ sandboxId: handleFor(id), error: (err as Error).name });
      }
    }
    this.append({ kind: "sweep", note: reason, results });
    return results;
  }

  // ---------- browser sessions ----------
  //
  // Tracked with the same intent-before-create discipline as sandboxes, and for
  // the same reason. There is one important difference, and it is a platform
  // limitation rather than a choice: THE BROWSER API HAS NO ENDPOINT THAT LISTS
  // LIVE SESSIONS. `GET /sessions/:id` answers about an id you already hold, and
  // that is all. So there is no equivalent of assertZeroLive's independent sweep
  // for browsers: we can only verify the sessions we know about. A session whose
  // id we never learned, because a create timed out after the gateway made it,
  // is invisible to us and can only be caught by its own deadline expiring.
  // The `intent` record is the only trace such a session leaves.

  browserIntent(gate: string, note = ""): string {
    const token = `bintent-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.append({ kind: "intent", res: "browser", token, gate, note });
    return token;
  }

  browserOpened(sessionId: string, gate: string, token?: string): void {
    this.append({ kind: "open", res: "browser", sandboxId: sessionId, gate, token });
  }

  browserClosed(sessionId: string): void {
    this.append({ kind: "closed", res: "browser", sandboxId: sessionId });
  }

  openBrowserIds(): string[] {
    return this.openIds("browser");
  }

  /** Release every browser session the ledger still thinks is open. */
  async sweepBrowsers(apiKey: string, reason = "exit"): Promise<Array<Record<string, unknown>>> {
    const ids = this.openBrowserIds();
    if (ids.length === 0) return [];
    const results: Array<Record<string, unknown>> = [];
    for (const id of ids) {
      try {
        const res = await fetch(`${this.baseUrl}/sessions/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(20_000),
        });
        const ok = res.status === 200 || res.status === 204 || res.status === 404;
        results.push({ sessionId: handleFor(id), status: res.status, ok });
        if (ok) this.browserClosed(id);
      } catch (err) {
        results.push({ sessionId: handleFor(id), error: (err as Error).name });
      }
    }
    this.append({ kind: "sweep", res: "browser", note: reason, results });
    return results;
  }

  /**
   * Ask the gateway about each browser session we know of, one by one, because
   * there is no listing endpoint. Returns the ones the gateway still considers
   * usable.
   */
  async liveBrowserSessions(apiKey: string): Promise<Array<{ id: string; status: string }>> {
    const live: Array<{ id: string; status: string }> = [];
    for (const id of this.openBrowserIds()) {
      try {
        const res = await fetch(`${this.baseUrl}/sessions/${id}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 404) continue; // gone, which is what we want
        const body = (await res.json()) as { status?: string; state?: string };
        const status = body.status ?? body.state ?? `http_${res.status}`;
        if (!/released|gone|closed|expired/i.test(status)) live.push({ id, status });
      } catch {
        // Unreachable is not proof of life. Recorded as unknown rather than live.
      }
    }
    return live;
  }

  /**
   * Install exit and signal handlers. Nothing can be done about SIGKILL, which
   * is exactly why the ledger is on disk: the next process reads the file and
   * reaps what this one could not.
   */
  install(apiKey: string): void {
    if (this.installed) return;
    this.installed = true;

    let sweeping = false;
    const runSweep = async (reason: string, exitCode: number | null) => {
      if (sweeping) return;
      sweeping = true;
      const ids = this.openIds();
      if (ids.length > 0) {
        safeErr(`\n[sweeper] ${reason}: reaping ${ids.length} sandbox(es)\n`);
        const results = await this.sweep(apiKey, reason);
        for (const r of results) safeErr(`[sweeper]   ${JSON.stringify(r)}\n`);
      }
      const bids = this.openBrowserIds();
      if (bids.length > 0) {
        safeErr(`\n[sweeper] ${reason}: releasing ${bids.length} browser session(s)\n`);
        const results = await this.sweepBrowsers(apiKey, reason);
        for (const r of results) safeErr(`[sweeper]   ${JSON.stringify(r)}\n`);
      }
      if (exitCode !== null) process.exit(exitCode);
    };

    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => {
        void runSweep(`signal-${sig}`, 130);
      });
    }
    process.on("beforeExit", () => {
      void runSweep("beforeExit", null);
    });
    process.on("uncaughtException", (err) => {
      safeErr(`\n[sweeper] uncaught: ${(err as Error).stack ?? err}\n`);
      void runSweep("uncaughtException", 1);
    });
  }

  /**
   * Ask the API what is actually live and fail loudly if anything is.
   *
   * The ledger can only be trusted about sandboxes it recorded. This is the
   * independent check: it asks Solari, not the local file, which is what would
   * have caught both of thrice's leaks at the moment they happened.
   */
  async assertZeroLive(
    apiKey: string,
    opts: { reap?: boolean; metadataTag?: string; exempt?: Iterable<string> } = {},
  ): Promise<{ liveCount: number; liveIds: string[]; reaped: string[]; foreignIds: string[] }> {
    const reap = opts.reap ?? true;
    const res = await fetch(`${this.baseUrl}/sandboxes?state=running`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as {
      sandboxes?: Array<{ sandboxId: string; metadata?: Record<string, unknown> }>;
    };
    const live = body.sandboxes ?? [];

    /**
     * OURS versus SOMEBODY ELSE'S. The distinction is not pedantic.
     *
     * The first version of this reaped every live sandbox on the account and
     * then threw. That is defensible at the exit of a gates run, where nothing
     * else should be running, and it is friendly fire anywhere else: a soak tick
     * killed a sandbox belonging to a separate process on the same account
     * mid-run, then died itself. An account is shared by a developer, their
     * examples, and anything else they have going.
     *
     * A sandbox is ours if the ledger recorded it, or if it carries our metadata
     * tag. Anything else is reported loudly and left alone. Killing what we
     * cannot account for trades one correctness bug for a worse one.
     */
    const knownIds = new Set(this.openIds());
    const tag = opts.metadataTag ?? "blink";
    const isOurs = (s: { sandboxId: string; metadata?: Record<string, unknown> }): boolean =>
      knownIds.has(s.sandboxId) ||
      Object.keys(s.metadata ?? {}).some((k) => k.startsWith(tag));

    /**
     * OURS is not the same question as SHOULD BE DEAD.
     *
     * This is an EXIT assertion: it means "nothing of ours is still running",
     * which is true at the end of a gates run and false at every moment of a
     * server that exists to keep instances running. The watchdog called it on a
     * 60 second timer while visitors were using the site, and since a live
     * visitor instance is recorded in the ledger, `isOurs` said yes and it was
     * reaped. Every instance died within a minute of being created.
     *
     * `exempt` is how a live system says "these are alive on purpose". Anything
     * exempt is neither counted nor reaped, so what remains is what genuinely
     * cannot be accounted for, which is the only thing a reaper should touch.
     */
    const exempt = new Set(opts.exempt ?? []);
    const ours = live.filter((s) => isOurs(s) && !exempt.has(s.sandboxId));
    const foreign = live.filter((s) => !isOurs(s));
    const liveIds = ours.map((s) => s.sandboxId);
    const foreignIds = foreign.map((s) => s.sandboxId);
    const reaped: string[] = [];

    if (liveIds.length > 0 && reap) {
      for (const id of liveIds) {
        try {
          await fetch(`${this.baseUrl}/sandboxes/${id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(20_000),
          });
          this.closed(id);
          reaped.push(handleFor(id));
        } catch (err) {
          reaped.push(`${handleFor(id)}:${(err as Error).name}`);
        }
      }
      throw new LeakDetected(
        `${liveIds.length} of OUR sandbox(es) still live at exit: ${liveIds.map((i) => handleFor(i)).join(", ")}. ` +
          `Reaped ${reaped.join(", ")}. A live sandbox the harness did not know about ` +
          `is a correctness bug, not a billing detail.` +
          (foreignIds.length > 0
            ? ` Additionally ${foreignIds.length} sandbox(es) on this account are not ours and were LEFT ALONE.`
            : ""),
        liveIds,
      );
    }

    return { liveCount: liveIds.length, liveIds, reaped, foreignIds };
  }
}
