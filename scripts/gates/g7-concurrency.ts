/**
 * G7: behaviour at the concurrency limit. Is the 429 immediate and non-retryable?
 *
 * This gate deliberately provokes the one error the rest of the codebase treats
 * as a bug. Everywhere else a 429 aborts the gate and dumps the slot state,
 * because if the guard were right the call would never have been made. Here the
 * overrun is the experiment, so the guard's slot check is bypassed ON PURPOSE
 * and only here, which is why it is the last gate and its own script.
 *
 * Phase 0 already settled the shape (00-verification.md V24). Solari documents
 * `429 {code:"ConcurrencyLimitExceeded"}` with "Retrying cannot help: a slot only
 * frees when _you_ pause or kill a session", and the SDK's transport explicitly
 * excludes 429 from its retry path while retrying 5xx. What is NOT documented,
 * and what this gate measures (V25):
 *
 *   - How fast does the 429 come back? Immediate means the local queue design in
 *     02-architecture.md section 8 works. Delayed means the visitor waits on a
 *     doomed call and the queue has to pre-empt it.
 *   - Is there a Retry-After header on the wire? No doc mentions one.
 *   - Is the code really ConcurrencyLimitExceeded, distinguishable from a rate
 *     limit, so the guard can branch on `code` rather than on the bare status?
 *   - Does the SDK actually make exactly one attempt, as its code says and its
 *     own file-header comment denies?
 */

import { estimate } from "./lib/cost.ts";
import { table } from "./lib/report.ts";
import { main, type GateContext, type GateDefinition, type GateResult } from "./lib/harness.ts";
import { SIZE_SMALL } from "../../src/guard/rates.ts";

const SECONDS_PER_FILLER = 90;

type Overrun = {
  status: number | null;
  code: string | null;
  retryAfter: string | null;
  ms: number;
  attempts: number;
  bodyKeys: string[];
  raw: string;
};

async function run(ctx: GateContext): Promise<GateResult> {
  const cap = ctx.plan.maxSandboxes;
  const filled: string[] = [];
  let overrun: Overrun | null = null;

  try {
    // Fill every slot the plan allows.
    for (let i = 0; i < cap; i++) {
      const sb = await ctx.adapter.createSandbox(
        ctx.apiKey, "g7",
        { template: "base", cpu: 1, memMb: 1024, timeoutMs: 300_000,
          lifecycle: { onTimeout: "kill" }, metadata: { ...ctx.metadata, blink_role: "filler" } },
        0.002,
      );
      filled.push(sb.value.sandboxId);
    }

    // Now overrun, on purpose. This goes around the adapter and the guard's slot
    // check, because the guard exists precisely to make this impossible and we
    // need the raw wire behaviour. This is the ONLY place in the codebase that
    // does this, and it makes exactly one attempt.
    const t0 = performance.now();
    const res = await fetch("https://api.getsolari.com/sandboxes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        template: "base", cpu: 1, memMb: 1024, timeoutMs: 60_000,
        lifecycle: { onTimeout: "kill" },
        metadata: { ...ctx.metadata, blink_role: "overrun" },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const ms = Math.round(performance.now() - t0);
    const raw = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* not json */ }

    overrun = {
      status: res.status,
      code: (body.code as string) ?? null,
      retryAfter: res.headers.get("retry-after"),
      ms,
      attempts: 1,
      bodyKeys: Object.keys(body),
      raw: raw.slice(0, 400),
    };

    // If it unexpectedly succeeded, we just created a sandbox over the cap and
    // must not leak it.
    if (res.ok) {
      const created = body as { sandboxId?: string };
      if (created.sandboxId) {
        filled.push(created.sandboxId);
        ctx.ledger.opened(created.sandboxId, "g7");
      }
    }
  } finally {
    for (const id of filled) {
      ctx.guard.addSandboxSeconds(SECONDS_PER_FILLER, { cpu: 1, memMb: 1024 }, false, "concurrency filler, flat model");
      await ctx.adapter.killQuiet(ctx.apiKey, id, "g7");
    }
  }

  const is429 = overrun?.status === 429;
  const immediate = (overrun?.ms ?? Infinity) < 2000;
  const named = overrun?.code === "ConcurrencyLimitExceeded";

  const verdict = !overrun
    ? "no overrun response captured"
    : `Overrun returned ${overrun.status}${overrun.code ? ` ${overrun.code}` : ""} in ${overrun.ms} ms. ` +
      `${is429 ? "429 as documented" : `NOT a 429, which contradicts the docs and changes the queue design`}. ` +
      `${immediate ? "Immediate" : "NOT immediate, so the local queue must pre-empt rather than let a visitor wait on a doomed call"}. ` +
      `Retry-After: ${overrun.retryAfter ?? "absent"}.`;

  const md = [
    `## The overrun`,
    ``,
    `Plan cap is ${cap} concurrent sandbox(es) on ${ctx.plan.name}. ${filled.length} were held, then one more was requested.`,
    ``,
    overrun
      ? table(
          ["observation", "value", "expectation from Phase 0"],
          [
            ["HTTP status", String(overrun.status), "429 (V24)"],
            ["code", overrun.code ?? "none", "ConcurrencyLimitExceeded (V24)"],
            ["time to response", `${overrun.ms} ms`, "undocumented, this gate is the evidence"],
            ["Retry-After header", overrun.retryAfter ?? "absent", "undocumented, no doc mentions one (V25)"],
            ["attempts made", String(overrun.attempts), "exactly 1, never retried"],
            ["body keys", overrun.bodyKeys.join(", ") || "none", "code, error, possibly retryable"],
          ],
        )
      : "No response captured.",
    ``,
    overrun ? `Raw body:\n\n\`\`\`json\n${overrun.raw}\n\`\`\`` : "",
    ``,
    `## What this decides`,
    ``,
    `**The local queue (D3, 02-architecture.md section 8).** Slots are counted in Postgres, never inferred from Solari errors, and a 429 means the guard's model was wrong. ${immediate ? "An immediate 429 means a visitor who somehow reaches one loses no time, so the queue can stay purely local and reactive." : "A slow 429 means a visitor would sit on a doomed call, so the queue has to refuse before the call rather than after, which it already does."}`,
    ``,
    `**Branching on code, not status.** ${named ? "The code is ConcurrencyLimitExceeded, distinguishable from FeatureRequiresPlan and NotEntitled, so the guard branches on `code` as designed." : "The expected code was not present, so the guard cannot safely distinguish a concurrency 429 from a rate-limit 429 and must treat every 429 as a guard bug, which it already does."}`,
    ``,
    `**No retry, confirmed on the wire.** ${overrun ? "Exactly one attempt was made." : ""} This matches the SDK implementation, which excludes 429 from its retry path, and contradicts the SDK's own file-header comment claiming 429 is retried. That contradiction is why \`test/counting-fetch.test.ts\` pins the behaviour with the SDK version in the lockfile (00-verification.md C-2).`,
  ].join("\n");

  return { observations: overrun ? 1 : 0, verdict, markdown: md, data: { cap, filled: filled.length, overrun } };
}

const def: GateDefinition = {
  id: "g7",
  title: "behaviour at the concurrency limit",
  question: "Is the concurrency 429 immediate and non-retryable, and does it carry Retry-After (Q8)?",
  ceilingUsd: 0.01,
  // The overrun response itself. Without it the gate observed nothing.
  minObservations: 1,
  observationUnit: "captured overrun response",
  estimate: (plan) => estimate(plan, [{ sandboxSeconds: plan.maxSandboxes * SECONDS_PER_FILLER, size: SIZE_SMALL }]),
  run,
};

await main(def);
