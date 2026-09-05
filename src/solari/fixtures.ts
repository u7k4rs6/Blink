/**
 * Fixture loading and the fake fetch used by the unit tests.
 *
 * The point of this file is that `npm test` spends zero credits
 * (02-architecture.md section 13). Nothing here ever reaches the network.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export type Fixtures = Record<string, any>;

export const fixtures: Fixtures = JSON.parse(
  readFileSync(join(here, "fixtures", "responses.json"), "utf8"),
);

export type ProgrammedResponse =
  | { status: number; body: unknown }
  | { throw: string };

/**
 * A fetch that serves a programmed script of responses and counts every call.
 *
 * `script` is consumed in order; once exhausted the last entry repeats, which is
 * what lets a test say "always 503" without writing six entries.
 */
export function fakeFetch(script: ProgrammedResponse[]): {
  fetch: typeof fetch;
  calls: Array<{ method: string; url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  let i = 0;

  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h) {
      if (h instanceof Headers) h.forEach((v, k) => (headers[k] = v));
      else if (Array.isArray(h)) for (const pair of h) { const k = pair[0] ?? ""; headers[k.toLowerCase()] = pair[1] ?? ""; }
      else for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    }
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), url, headers });

    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;

    if ("throw" in step) {
      const e = new Error(step.throw);
      e.name = "TypeError";
      throw e;
    }
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { fetch: f, calls };
}

/** Shorthand for a programmed error taken straight from the fixture file. */
export function errorStep(name: string): ProgrammedResponse {
  const e = fixtures.errors[name];
  if (!e) throw new Error(`no such fixture error: ${name}`);
  return { status: e.status, body: e.body };
}
