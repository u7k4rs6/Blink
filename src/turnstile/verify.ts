/**
 * Cloudflare Turnstile verification.
 *
 * Verified server-side BEFORE any Solari call, on Launch, Extend and Swarm
 * (03-security-and-access.md section 3). It is the cheapest control there is:
 * a refused token costs one HTTPS round trip to Cloudflare and nothing on the
 * Solari balance.
 *
 * NO RETRY. A failed verification is an answer, not a transient condition, and
 * there is no retry loop anywhere in this codebase. A network failure reaching
 * Cloudflare is treated as a refusal rather than a pass: failing open would make
 * the control removable by anyone who can cause a timeout.
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileResult =
  | { ok: true }
  | { ok: false; reason: "missing_token" | "rejected" | "unreachable" | "misconfigured"; detail?: string };

export type TurnstileOptions = {
  secret: string;
  /** Injected for tests; production passes the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp: string | undefined,
  opts: TurnstileOptions,
): Promise<TurnstileResult> {
  if (!opts.secret) {
    // Refuse rather than skip. A missing secret in production would otherwise
    // silently disable the control on the one path that spends money.
    return { ok: false, reason: "misconfigured", detail: "TURNSTILE_SECRET is not set" };
  }
  if (!token) return { ok: false, reason: "missing_token" };

  const body = new URLSearchParams({ secret: opts.secret, response: token });
  // Cloudflare accepts the client IP as an extra signal. The raw IP is used here
  // and never stored: only its salted hash reaches Postgres (section 4).
  if (remoteIp) body.set("remoteip", remoteIp);

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) return { ok: false, reason: "unreachable", detail: `HTTP ${res.status}` };
    const json = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (json.success === true) return { ok: true };
    return { ok: false, reason: "rejected", detail: (json["error-codes"] ?? []).join(",") };
  } catch (err) {
    // Fail closed. An attacker who can make Cloudflare unreachable must not
    // thereby remove the control.
    return { ok: false, reason: "unreachable", detail: (err as Error).name };
  }
}
