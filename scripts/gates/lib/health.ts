/** Health checking a forked app through its previewUrl. */

export type HealthResult = {
  ok: boolean;
  ms: number;
  attempts: number;
  status: number | null;
  error?: string;
};

/**
 * Poll until the app answers or the budget of time runs out.
 *
 * 15 s ceiling at 250 ms intervals, matching docs/02-architecture.md section 2.1.
 * This is a plain fetch and not the counting fetch on purpose: it talks to the
 * preview domain, not the Solari gateway, so it spends no API calls and needs no
 * retry cap. The sandbox-seconds it burns are accounted by the caller.
 */
export async function waitHealthy(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number; expectBody?: string } = {},
): Promise<HealthResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 250;
  const t0 = performance.now();
  let attempts = 0;
  let lastStatus: number | null = null;
  let lastError: string | undefined;

  while (performance.now() - t0 < timeoutMs) {
    attempts += 1;
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(Math.min(5000, timeoutMs)),
      });
      lastStatus = res.status;
      if (res.ok) {
        if (opts.expectBody) {
          const body = await res.text();
          if (body.includes(opts.expectBody)) {
            return { ok: true, ms: Math.round(performance.now() - t0), attempts, status: res.status };
          }
        } else {
          return { ok: true, ms: Math.round(performance.now() - t0), attempts, status: res.status };
        }
      }
    } catch (err) {
      lastError = (err as Error).name;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return {
    ok: false,
    ms: Math.round(performance.now() - t0),
    attempts,
    status: lastStatus,
    ...(lastError ? { error: lastError } : {}),
  };
}

/**
 * Build a health-check URL from a previewUrl and a path.
 *
 * The previewUrl carries a one-hour pt_token as a query parameter
 * (00-verification.md V21), so the query MUST be preserved when swapping the
 * path. Doing this with `new URL(path, base)` silently drops it and every
 * request 401s, which is a confusing failure to debug.
 */
export function previewHealthUrl(previewUrl: string, healthPath: string): string {
  const u = new URL(previewUrl);
  u.pathname = healthPath;
  return u.href;
}


/**
 * Poll an in-guest port over loopback, from a Node-side loop of SHORT execs.
 *
 * NOT one long exec containing the loop. That is how the first Gitea build
 * failed: a `for i in $(seq 1 90); do curl ...; sleep 1; done` inside a single
 * exec returned `GatewayError: exec failed`, because the one-shot REST exec path
 * has its own duration limit and a 90-second command exceeds it. The error names
 * neither duration nor the limit, so it reads like a broken command.
 *
 * Polling from Node keeps every exec sub-second, well inside any gateway bound,
 * and has a second benefit: each attempt is timed host-side, so the health-check
 * cost is decomposed rather than being one opaque number.
 *
 * Loopback rather than previewUrl, because the preview domain costs about 265 ms
 * per request (V59) and a poll loop through it would add seconds of pure routing
 * to every fork-to-healthy measurement.
 */
export async function waitHealthyInGuest(
  exec: (cmd: string, opts?: { timeoutMs?: number }) => Promise<{ value: { exitCode: number; stdout: string; stderr: string } }>,
  port: number,
  path: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<HealthResult & { execCalls: number }> {
  const budget = opts.timeoutMs ?? 90_000;
  const interval = opts.intervalMs ?? 500;
  const t0 = performance.now();
  let execCalls = 0;
  let lastOut = "";

  while (performance.now() - t0 < budget) {
    execCalls += 1;
    // One quick curl. Exits 0 and prints READY only when the app answers.
    const r = await exec(
      `curl -sf -m 3 -o /dev/null http://127.0.0.1:${port}${path} && echo READY || echo WAITING`,
      { timeoutMs: 8000 },
    );
    lastOut = `${r.value.stdout}${r.value.stderr}`.trim();
    if (lastOut.includes("READY")) {
      return { ok: true, ms: Math.round(performance.now() - t0), attempts: execCalls, status: 200, execCalls };
    }
    await new Promise((res) => setTimeout(res, interval));
  }

  return {
    ok: false,
    ms: Math.round(performance.now() - t0),
    attempts: execCalls,
    status: null,
    error: `never answered on 127.0.0.1:${port}${path}; last output: ${lastOut.slice(0, 120)}`,
    execCalls,
  };
}
