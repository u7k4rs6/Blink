/**
 * The Solari adapter. Every Solari call in this codebase goes through here.
 *
 * Two constraints from Phase 0 that are not negotiable later
 * (docs/02-architecture.md section 14):
 *
 *   KEY PER CALL. Every function takes the API key as an argument. Nothing in
 *   this file reads process.env.SOLARI_API_KEY. The key is resolved once at the
 *   process edge and threaded down. That single rule is what makes the
 *   bring-your-own-key fallback (01-prd.md section 10.1) a config flip rather
 *   than a v2 rewrite, and it costs nothing to honour.
 *
 *   ONE FETCH. Every Solari HTTP request goes through the counting fetch. There
 *   is no second path to the gateway.
 *
 * A 429 is never handled, retried or swallowed. It is converted into a GuardBug
 * carrying the full slot state and thrown, which aborts the gate (D7, G7).
 */

import { createHash } from "node:crypto";

import { SandboxClient } from "@solarisdk/sandbox";
import type { CreateSandboxOptions, Sandbox, SandboxView } from "@solarisdk/core";

import { BudgetGuard } from "../guard/guard.ts";
import type { SandboxLedger } from "../guard/ledger.ts";
import { BLINK_RETRY_CAP, type Attempt, type CountingFetch } from "./fetch.ts";
import { registerSecret } from "../redact.ts";
import { safeErr } from "../safe-io.ts";

export const DEFAULT_BASE_URL = "https://api.getsolari.com";

export type AdapterOptions = {
  counting: CountingFetch;
  guard: BudgetGuard;
  ledger: SandboxLedger;
  baseUrl?: string;
  /** Per-request timeout handed to the SDK. */
  callTimeoutMs?: number;
};

export type Timed<T> = { value: T; attempts: Attempt[]; ms: number };

/** Thrown when the gateway refused for a reason worth naming in a report. */
export class SolariCallFailed extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "SolariCallFailed";
    this.status = status;
    this.code = code;
  }
}

function errCode(err: unknown): string | undefined {
  const e = err as { code?: string; body?: { code?: string } };
  return e?.code ?? e?.body?.code;
}

function errStatus(err: unknown): number | undefined {
  return (err as { status?: number })?.status;
}

function isConcurrency429(err: unknown): boolean {
  return errStatus(err) === 429 || errCode(err) === "ConcurrencyLimitExceeded";
}

export class SolariAdapter {
  private readonly counting: CountingFetch;
  private readonly guard: BudgetGuard;
  private readonly ledger: SandboxLedger;
  private readonly baseUrl: string;
  private readonly callTimeoutMs: number;
  /**
   * Client cache, keyed by a SHA-256 digest of the API key and NOT by the key
   * itself, so the map's own keys are never the secret.
   *
   * This matters because of the BYO-key fallback (01-prd.md section 10.1). In
   * that mode the keys flowing through here belong to visitors, so:
   *
   *   - never written to disk, never written to a log line, never serialised
   *   - evicted explicitly via forgetKey() when the instance that used it ends
   *   - bounded, so an unbounded number of visitors cannot grow this forever
   *
   * The SandboxClient itself necessarily holds the key in memory to sign
   * requests; that is unavoidable. What is avoidable is retaining it after it is
   * needed, and that is what forgetKey and the bound are for.
   */
  private readonly clients = new Map<string, SandboxClient>();
  private static readonly MAX_CACHED_CLIENTS = 32;

  constructor(opts: AdapterOptions) {
    this.counting = opts.counting;
    this.guard = opts.guard;
    this.ledger = opts.ledger;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.callTimeoutMs = opts.callTimeoutMs ?? 120_000;
  }

  /**
   * A client per key. Memoized so repeated calls with the same key reuse one
   * transport, but the key still arrives as an argument every time.
   */
  private clientFor(apiKey: string): SandboxClient {
    const id = SolariAdapter.keyDigest(apiKey);
    let c = this.clients.get(id);
    if (!c) {
      // Simple bound: evict the oldest insertion. Map preserves insertion order.
      if (this.clients.size >= SolariAdapter.MAX_CACHED_CLIENTS) {
        const oldest = this.clients.keys().next().value;
        if (oldest !== undefined) this.clients.delete(oldest);
      }
      c = new SandboxClient({
        apiKey,
        baseUrl: this.baseUrl,
        fetch: this.counting.fetch,
        callTimeoutMs: this.callTimeoutMs,
      });
      this.clients.set(id, c);
    }
    return c;
  }

  /** Non-reversible handle for a key, safe to hold and safe to log. */
  static keyDigest(apiKey: string): string {
    return createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
  }

  /**
   * Drop a cached client and its retained key. Call this when the instance that
   * supplied the key ends. In BYO-key mode this is mandatory, not hygiene.
   */
  forgetKey(apiKey: string): void {
    this.clients.delete(SolariAdapter.keyDigest(apiKey));
  }

  /** Drop every cached client. Used at process teardown. */
  forgetAllKeys(): void {
    this.clients.clear();
  }

  /** How many keys are currently retained. For assertions and for the report. */
  cachedKeyCount(): number {
    return this.clients.size;
  }

  /**
   * Refuse to serialise. An adapter reaching JSON.stringify, a log formatter or
   * an error report must not be able to carry a key out with it.
   */
  toJSON(): Record<string, unknown> {
    return { solariAdapter: true, cachedKeys: this.clients.size, note: "keys are never serialised" };
  }

  /**
   * Run one logical Solari call: scope it for attempt counting, translate a 429
   * into a GuardBug, and unwrap our own synthetic retry-cap response back into
   * the real failure underneath it.
   */
  private async run<T>(label: string, cls: "create" | "read" | "spend", fn: () => Promise<T>): Promise<Timed<T>> {
    const t0 = performance.now();
    try {
      const { value, attempts } = await this.counting.call(label, cls, fn);
      return { value, attempts, ms: Math.round(performance.now() - t0) };
    } catch (err) {
      if (isConcurrency429(err)) {
        // Never retried, never handled. The guard's model of concurrency was
        // wrong, and that is the finding.
        throw this.guard.concurrencyBug(label);
      }
      if (errCode(err) === BLINK_RETRY_CAP) {
        throw new SolariCallFailed(
          `${label}: ${(err as Error).message} (the SDK tried to retry past the cap; ` +
            `the underlying failure is the one to read in the attempt log)`,
          errStatus(err),
          BLINK_RETRY_CAP,
        );
      }
      throw err;
    }
  }

  // ---------- lifecycle ----------

  /**
   * Create a sandbox. The ledger records the INTENT before the call, because a
   * create that times out can still have created something whose id we never
   * learn (see src/guard/ledger.ts).
   */
  async createSandbox(
    apiKey: string,
    gate: string,
    opts: CreateSandboxOptions,
    estimateUsd: number,
  ): Promise<Timed<Sandbox>> {
    this.guard.reserveSandboxSlot();
    this.guard.reserve(estimateUsd, `${gate} createSandbox`);
    const token = this.ledger.intent(gate, JSON.stringify({ cpu: opts.cpu, memMb: opts.memMb }));
    try {
      const out = await this.run(`${gate}:create`, "create", () => this.clientFor(apiKey).create(opts));
      // Register before anything downstream can write it. A sandbox id decodes
      // to Solari's host pool identifier and this org's id (V61), and it appears
      // in the path of every subsequent request.
      registerSecret(out.value.sandboxId);
      registerSecret(out.value.controlUrl);
      this.ledger.opened(out.value.sandboxId, gate, token);
      this.guard.openedSandbox(out.value.sandboxId);
      return out;
    } finally {
      this.guard.release(estimateUsd);
    }
  }

  async killSandbox(apiKey: string, sandboxId: string, gate: string): Promise<Timed<void>> {
    const out = await this.run(`${gate}:kill`, "read", () => this.clientFor(apiKey).kill(sandboxId));
    this.ledger.closed(sandboxId);
    this.guard.closedSandbox(sandboxId);
    return out;
  }

  /** Kill without throwing. For teardown paths, where failing loudly helps nobody. */
  async killQuiet(apiKey: string, sandboxId: string, gate: string): Promise<void> {
    try {
      await this.killSandbox(apiKey, sandboxId, gate);
    } catch (err) {
      safeErr(`[teardown] kill ${sandboxId.slice(0, 16)} failed: ${(err as Error).message}\n`);
    }
  }

  async pause(apiKey: string, sandbox: Sandbox, gate: string): Promise<Timed<void>> {
    const out = await this.run(`${gate}:pause`, "spend", () => sandbox.pause());
    // Pause frees the slot and stops billing (00-verification.md V19, V20).
    this.guard.pausedSandbox(sandbox.sandboxId);
    return out;
  }

  async resume(apiKey: string, sandbox: Sandbox, gate: string): Promise<Timed<void>> {
    this.guard.reserveSandboxSlot();
    const out = await this.run(`${gate}:resume`, "spend", () => sandbox.resume());
    this.guard.openedSandbox(sandbox.sandboxId);
    return out;
  }

  async snapshot(apiKey: string, sandbox: Sandbox, gate: string, name?: string): Promise<Timed<string>> {
    return this.run(`${gate}:snapshot`, "spend", () => sandbox.snapshot(name));
  }

  async setTimeout(apiKey: string, sandbox: Sandbox, gate: string, timeoutMs: number): Promise<Timed<{ expiresAt: string }>> {
    return this.run(`${gate}:setTimeout`, "read", () => sandbox.setTimeout(timeoutMs));
  }

  /**
   * Resolve a preview URL. Returns { url, token? }: an object, not a string
   * (00-verification.md V5). The url carries a one-hour pt_token, so it is a
   * bearer capability and must never reach a log line or a published artifact.
   */
  async previewUrl(apiKey: string, sandbox: Sandbox, gate: string, port: number): Promise<Timed<{ url: string; token?: string }>> {
    return this.run(`${gate}:previewUrl`, "read", () => sandbox.previewUrl(port));
  }

  /**
   * Run a shell command in the guest.
   *
   * ALWAYS through `sh -c`. The SDK's `commands.run(cmd)` executes the program
   * directly and NOT via a shell: "Arguments passed to the program (the guest
   * runs `cmd` with these, NOT via a shell). For shell syntax use
   * `run("sh", { args: ["-c", "..."] })`."
   *
   * This cost the first live gate run. G6's baseline probe, G4's data write and
   * G5's target page all used `&&`, `||`, heredocs and redirection, and all
   * three were silently passed as literal arguments instead of being
   * interpreted. G6 reported a false negative on egress, G4 measured snapshot
   * deltas of a file that was never written, and G5's static server had no page
   * to serve so `previewUrl` returned 502. One bug, three wrong answers, and it
   * looked like three unrelated findings.
   *
   * Wrapping here rather than at each call site means no future gate can
   * reintroduce it.
   */
  async exec(
    apiKey: string, sandbox: Sandbox, gate: string, cmd: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<Timed<{ exitCode: number; stdout: string; stderr: string }>> {
    return this.run(`${gate}:exec`, "read", async () => {
      // Pass timeoutMs explicitly. The SDK forwards it to the one-shot REST exec
      // path, and leaving it undefined means the gateway's own default applies,
      // which is short: a 90-second polling loop inside one exec came back as a
      // bare `GatewayError: exec failed` with no indication that duration was
      // the problem. Long-running work belongs in a Node-side loop of short
      // execs, not one long exec (see waitHealthyInGuest).
      const r = await sandbox.commands.run("sh", { args: ["-c", cmd], timeoutMs: opts.timeoutMs ?? 20_000 });
      return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    });
  }

  /** Run a program directly, with no shell. Use when the args are untrusted. */
  async execRaw(apiKey: string, sandbox: Sandbox, gate: string, cmd: string, args: string[] = []): Promise<Timed<{ exitCode: number; stdout: string; stderr: string }>> {
    return this.run(`${gate}:execRaw`, "read", async () => {
      const r = await sandbox.commands.run(cmd, { args });
      return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    });
  }

  async metrics(apiKey: string, sandbox: Sandbox, gate: string) {
    return this.run(`${gate}:metrics`, "read", () => sandbox.metrics());
  }

  // ---------- inventory ----------

  async listSandboxes(apiKey: string, gate: string, filter?: { state?: SandboxView["state"]; metadata?: Record<string, string> }): Promise<Timed<SandboxView[]>> {
    return this.run(`${gate}:list`, "read", async () => {
      const page = await this.clientFor(apiKey).list(filter ?? {});
      return page.sandboxes;
    });
  }

  async listSnapshots(apiKey: string, gate: string) {
    return this.run(`${gate}:listSnapshots`, "read", async () => {
      const r = await this.clientFor(apiKey).listSnapshots({});
      return r.snapshots;
    });
  }

  async deleteSnapshot(apiKey: string, gate: string, snapshotId: string): Promise<Timed<void>> {
    return this.run(`${gate}:deleteSnapshot`, "read", () => this.clientFor(apiKey).deleteSnapshot(snapshotId));
  }
}
