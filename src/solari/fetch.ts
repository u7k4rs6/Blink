/**
 * The counting fetch: the single choke point for every Solari HTTP attempt.
 *
 * Why this exists (docs/00-verification.md C-2). The SDK's HttpTransport retries
 * idempotent requests up to five times by default, with 150/300/600/1200/2400 ms
 * backoff plus jitter. SandboxClient.create() sends an Idempotency-Key on every
 * call, which makes it retry-eligible. And SandboxClientOptions is only
 * { apiKey, baseUrl, fetch?, callTimeoutMs? }, so maxRetries is never forwarded
 * to the transport and CANNOT be turned off through the SDK's public options.
 *
 * The `fetch` option is exposed, though, and it is the only place in the process
 * that sees every real HTTP attempt. So it owns four things:
 *
 *   1. The retry cap, per call class.
 *   2. The budget guard hook (refuse before the call, never after).
 *   3. The per-call deadline, as an AbortSignal tied to the timer a visitor is
 *      watching, so no retry can outlive it.
 *   4. The ledger of attempts, because attempts are what cost money, not
 *      intentions.
 *
 * How the cap is enforced. We cannot stop the SDK's loop by throwing (a thrown
 * fetch is treated as a network error and retried) and we cannot stop it by
 * returning a 5xx (that is precisely what it retries). So on exceeding the cap
 * we return a synthetic 400 carrying code BLINK_RETRY_CAP, which the SDK maps to
 * a non-retryable GatewayError. The adapter recognises that code and rethrows the
 * real underlying failure, so callers see the truth and the loop still stops dead.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export const BLINK_RETRY_CAP = "BlinkRetryCapExceeded";

export type CallClass =
  /** POST /sandboxes. Carries an Idempotency-Key, so one 503 retry is safe. */
  | "create"
  /** GET/DELETE. Cheap and idempotent. */
  | "read"
  /** Anything that spends money without an idempotency key. Never retried. */
  | "spend";

export type RetryCaps = Record<CallClass, number>;

/**
 * Production caps. `create` gets exactly one retry because its idempotency key
 * makes a single 503 retry worth having and cannot double-create.
 */
export const CAPS_DEFAULT: RetryCaps = { create: 1, read: 1, spend: 0 };

/**
 * Gate caps. Zero retries everywhere, so G1 measures real latency rather than a
 * retried one, and G7 measures the real shape of a 429.
 */
export const CAPS_GATES: RetryCaps = { create: 0, read: 0, spend: 0 };

export type Attempt = {
  /** 1-based attempt number within one logical call. */
  n: number;
  method: string;
  path: string;
  status: number | null;
  ms: number;
  error?: string;
  retriedByCap?: boolean;
};

export type CallScope = {
  label: string;
  cls: CallClass;
  attempts: Attempt[];
  /** Last real failure, kept so we can rethrow it instead of the synthetic 400. */
  lastFailure: { status: number; body: unknown } | null;
};

const als = new AsyncLocalStorage<CallScope>();

/** The scope of the logical Solari call currently in flight, if any. */
export function currentScope(): CallScope | undefined {
  return als.getStore();
}

export type CountingFetchOptions = {
  caps: RetryCaps;
  /**
   * Called before every real HTTP attempt. Throw to refuse. This is where the
   * budget guard hangs, which is what makes "refuse before the call" true rather
   * than aspirational.
   */
  beforeAttempt?: (a: { method: string; path: string; attempt: number; cls: CallClass }) => void;
  onAttempt?: (a: Attempt, scope: CallScope) => void;
  /** Deadline for the whole run. Composed with any per-call signal. */
  deadlineSignal?: AbortSignal;
};

export type CountingFetch = {
  fetch: typeof fetch;
  /** Run one logical Solari operation, collecting its attempts. */
  call<T>(label: string, cls: CallClass, fn: () => Promise<T>): Promise<{ value: T; attempts: Attempt[] }>;
  /** Every attempt this process has made, in order. */
  readonly log: Attempt[];
};

type FetchInput = Parameters<typeof fetch>[0];

function pathOf(input: FetchInput): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw).pathname;
  } catch {
    return raw;
  }
}

export function createCountingFetch(opts: CountingFetchOptions): CountingFetch {
  const log: Attempt[] = [];

  const wrapped: typeof fetch = async (input, init) => {
    const scope = als.getStore();
    const method = (init?.method ?? "GET").toUpperCase();
    const path = pathOf(input);
    const cls: CallClass = scope?.cls ?? "read";
    const cap = opts.caps[cls];

    // Attempt 1 is not a retry. The cap counts retries, so attempts allowed is
    // cap + 1.
    const priorAttempts = scope ? scope.attempts.length : 0;
    if (scope && priorAttempts > cap) {
      // The SDK is trying to retry past our cap. Hard stop with a status the SDK
      // will not retry, carrying a code the adapter unwraps.
      const synthetic = {
        code: BLINK_RETRY_CAP,
        error:
          `retry cap exceeded for call class "${cls}": ${priorAttempts} attempt(s) already made, ` +
          `cap allows ${cap} retr${cap === 1 ? "y" : "ies"}. There is no retry loop in this codebase.`,
        retryable: false,
      };
      scope.attempts.push({
        n: priorAttempts + 1,
        method,
        path,
        status: 400,
        ms: 0,
        error: BLINK_RETRY_CAP,
        retriedByCap: true,
      });
      return new Response(JSON.stringify(synthetic), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    opts.beforeAttempt?.({ method, path, attempt: priorAttempts + 1, cls });

    // Compose the run deadline with whatever the SDK already set, so a retry can
    // never outlive the timer the visitor is watching.
    const signals: AbortSignal[] = [];
    if (init?.signal) signals.push(init.signal);
    if (opts.deadlineSignal) signals.push(opts.deadlineSignal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    const started = performance.now();
    let status: number | null = null;
    let errName: string | undefined;
    try {
      const res = await fetch(input, { ...init, signal });
      status = res.status;
      if (scope && !res.ok) {
        // Keep the real failure so the adapter can rethrow it rather than the
        // synthetic cap response.
        let body: unknown;
        try {
          body = await res.clone().json();
        } catch {
          body = undefined;
        }
        scope.lastFailure = { status: res.status, body };
      }
      return res;
    } catch (err) {
      errName = (err as Error).name;
      throw err;
    } finally {
      const rec: Attempt = {
        n: priorAttempts + 1,
        method,
        path,
        status,
        ms: Math.round(performance.now() - started),
        ...(errName ? { error: errName } : {}),
      };
      log.push(rec);
      if (scope) {
        scope.attempts.push(rec);
        opts.onAttempt?.(rec, scope);
      }
    }
  };

  async function call<T>(
    label: string,
    cls: CallClass,
    fn: () => Promise<T>,
  ): Promise<{ value: T; attempts: Attempt[] }> {
    const scope: CallScope = { label, cls, attempts: [], lastFailure: null };
    const value = await als.run(scope, fn);
    return { value, attempts: scope.attempts };
  }

  return { fetch: wrapped, call, log };
}
