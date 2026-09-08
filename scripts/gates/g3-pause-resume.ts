/**
 * G3: does a paused sandbox bill, how long does resume take, and Q17.
 *
 * The billing half is already resolved on paper. POST /sandboxes/:id/pause is
 * documented as "Saves full RAM+disk state. Billing stops and it stops counting
 * against your concurrency limit" (00-verification.md V19). So this gate
 * CONFIRMS that observationally rather than discovering it: it pauses a sandbox,
 * holds it, and checks that a second sandbox can still be created while it is
 * paused, which is the concurrency half and the one we can actually observe from
 * the client side. Billing itself is only visible on the invoice, so the gate
 * records the paused duration for later reconciliation rather than pretending to
 * measure dollars.
 *
 * Q17 (new, from C-1). Does traffic to a previewUrl, or an open control channel,
 * reset the sandbox idle clock? This decides how much layer 3 of the three-layer
 * expiry design is worth. The design does not depend on the answer, which is the
 * point of layering it, but the answer sizes the layer.
 *
 * Method for Q17: create a sandbox with a short timeoutMs and onTimeout kill,
 * then drive HTTP through its previewUrl continuously while making NO SDK calls,
 * and see whether it dies at timeoutMs anyway. If it dies, preview traffic does
 * not count as activity and the dead-man refresh is worth its full value. If it
 * survives, layer 2 (guest-side self-destruct) is carrying the load.
 */

import { APPS, loadRegistry, missingSnapshots } from "./lib/apps.ts";
import { previewHealthUrl, waitHealthy } from "./lib/health.ts";
import { estimate } from "./lib/cost.ts";
import { fmtMs, stats } from "./lib/stats.ts";
import { table } from "./lib/report.ts";
import { main, type GateContext, type GateDefinition, type GateResult } from "./lib/harness.ts";
import { safeOut } from "../../src/safe-io.ts";
import { SIZE_SMALL } from "../../src/guard/rates.ts";

const G3_APP = process.env.BLINK_G3_APP ?? "gitea";
const RESUME_SAMPLES = Number(process.env.BLINK_G3_SAMPLES ?? 8);
/** Short enough to observe inside a gate, long enough to be a real idle window. */
const Q17_TIMEOUT_MS = 90_000;
const Q17_OBSERVE_MS = Q17_TIMEOUT_MS + 45_000;

function routeVerdictLine(r: Record<string, any>): string {
  if (r.error) return `not determined (${String(r.error).slice(0, 60)}).`;
  if (r.hostChanged) return "the preview HOST changes across a pause, so a stored URL cannot survive by definition.";
  // The question that decides the pre-resolve design in 02-architecture 2.1.
  if (r.storedUrlStillWorks === false) {
    return (
      `a URL resolved BEFORE the pause does NOT work after the resume. The pre-resolve design is dead: ` +
      `the claim path must call previewUrl() itself and pay the post-resume cost of ${r.resolveAfterResumeMs} ms, ` +
      `so warm ready is resume + health + resolve, not resume + health.`
    );
  }
  if (r.storedUrlStillWorks === true) {
    return (
      `a URL resolved BEFORE the pause STILL WORKS after the resume (${r.storedUrlFirstByteMs} ms first byte, ` +
      `no re-resolve). The pre-resolve design holds, and it saves the ${r.resolveAfterResumeMs} ms that resolving ` +
      `after a resume costs. This is the measurement the design was resting on.`
    );
  }
  // Three ways this can land, and only one of them is "the route died".
  const all = [r.freshFirstByteMs, r.prePauseSteadyMs, r.postResumeFirstByteMs, r.postResumeSecondMs];
  const spread = Math.max(...all) - Math.min(...all);
  const flat = spread < Math.min(...all) * 0.5;
  if (flat) {
    return (
      `there is NO per-route setup cost to save. Fresh ${r.freshFirstByteMs} ms, steady ${r.prePauseSteadyMs} ms, ` +
      `post-resume ${r.postResumeFirstByteMs} ms, post-resume second ${r.postResumeSecondMs} ms: a spread of ${spread} ms. ` +
      `Every request through previewUrl costs about the same whether it is the first ever or the tenth, so pre-touching ` +
      `before a pause buys nothing. This is NOT "the route died"; it is that the cost is per-request rather than per-route.`
    );
  }
  const survived = r.postResumeFirstByteMs < r.freshFirstByteMs * 0.6;
  return survived
    ? `SURVIVES a pause. Post-resume first byte ${r.postResumeFirstByteMs} ms against ${r.freshFirstByteMs} ms fresh, so the replenisher should touch previewUrl once before pausing.`
    : `does NOT survive a pause: post-resume first byte ${r.postResumeFirstByteMs} ms is close to the ${r.freshFirstByteMs} ms fresh cost, so pre-touching buys nothing.`;
}

async function run(ctx: GateContext): Promise<GateResult> {
  const app = APPS[G3_APP]!;
  const snapshotId = loadRegistry()[G3_APP]!;
  const resumeMs: number[] = [];
  const pauseMs: number[] = [];
  let concurrencyFreed: boolean | null = null;
  let concurrencyDetail = "not attempted";

  // ---- part 1: resume latency, and pause frees the slot ----
  let sandboxId: string | null = null;
  try {
    const created = await ctx.adapter.createSandbox(
      ctx.apiKey, "g3",
      { fromSnapshot: snapshotId, cpu: app.size.cpu, memMb: app.size.memMb,
        timeoutMs: 600_000, lifecycle: { onTimeout: "kill" }, metadata: ctx.metadata },
      0.005,
    );
    sandboxId = created.value.sandboxId;
    await waitHealthy(previewHealthUrl((await ctx.adapter.previewUrl(ctx.apiKey, created.value, "g3", app.port)).value.url, app.healthPath), { timeoutMs: 60_000 });

    for (let i = 0; i < RESUME_SAMPLES; i++) {
      const p = await ctx.adapter.pause(ctx.apiKey, created.value, "g3");
      pauseMs.push(p.ms);

      if (i === 0) {
        // While it is paused, can we hold a second sandbox? On Starter the cap
        // is 2. If pause did NOT free the slot, the guard would refuse or the
        // gateway would 429. Either way we learn the answer without guessing.
        let probeId: string | null = null;
        try {
          const probe = await ctx.adapter.createSandbox(
            ctx.apiKey, "g3",
            { cpu: 1, memMb: 1024, timeoutMs: 120_000, lifecycle: { onTimeout: "kill" },
              metadata: { ...ctx.metadata, blink_probe: "concurrency" } },
            0.002,
          );
          probeId = probe.value.sandboxId;
          concurrencyFreed = true;
          concurrencyDetail = `created a second sandbox while the first was paused, so the paused one holds no slot`;
        } catch (err) {
          concurrencyFreed = false;
          concurrencyDetail = `could not create while paused: ${(err as Error).message}`;
        } finally {
          if (probeId) {
            ctx.guard.addSandboxSeconds(30, { cpu: 1, memMb: 1024 }, false, "concurrency probe, flat model");
            await ctx.adapter.killQuiet(ctx.apiKey, probeId, "g3");
          }
        }
      }

      safeOut(`      resume sample ${i + 1}/${RESUME_SAMPLES}\n`);
      const r = await ctx.adapter.resume(ctx.apiKey, created.value, "g3");
      const preview = await ctx.adapter.previewUrl(ctx.apiKey, created.value, "g3", app.port);
      const health = await waitHealthy(previewHealthUrl(preview.value.url, app.healthPath), { timeoutMs: 30_000 });
      resumeMs.push(r.ms + health.ms);
    }
  } finally {
    if (sandboxId) {
      ctx.guard.addSandboxSeconds(60 + RESUME_SAMPLES * 20, app.size, false, "resume-latency sandbox, flat model");
      await ctx.adapter.killQuiet(ctx.apiKey, sandboxId, "g3");
    }
  }

  // ---- part 2: does the previewUrl route survive pause/resume ----
  const route = await measureRouteSurvival(ctx, snapshotId);

  // ---- part 3: Q17, does previewUrl traffic reset the idle clock ----
  //
  // Skippable once answered. Q17 resolved on 2026-09-03 (preview traffic DOES
  // reset the clock) and its probe costs 135 s of sandbox time per run, so a
  // re-run targeting the route experiment should not pay for it again.
  const q17 = process.env.BLINK_G3_SKIP_Q17
    ? { requests: 0, died: null, diedAtMs: null, resetsClock: null, skipped: true }
    : await measureQ17(ctx, snapshotId);

  const rs = stats(resumeMs);
  const ps = stats(pauseMs);

  const verdict =
    `Resume to healthy p50 ${fmtMs(rs.p50)}, p95 ${fmtMs(rs.p95)}. ` +
    `Pause frees the concurrency slot: ${concurrencyFreed === null ? "not determined" : concurrencyFreed ? "CONFIRMED" : "NOT CONFIRMED, which contradicts the docs and breaks D2 and D3"}. ` +
    `PREVIEW ROUTE: ${routeVerdictLine(route)} ` +
    `Q17: preview traffic ${q17.resetsClock === null ? "not determined" : q17.resetsClock ? "DOES reset the idle clock, so layer 3 is weak and layer 2 carries the load" : "does NOT reset the idle clock, so the dead-man refresh is worth its full value"}.`;

  const md = [
    `## Resume latency (Q7)`,
    ``,
    table(
      ["measurement", "n", "p50", "p95", "min", "max"],
      [
        ["resume to healthy", rs.n, fmtMs(rs.p50), fmtMs(rs.p95), fmtMs(rs.min), fmtMs(rs.max)],
        ["pause API call", ps.n, fmtMs(ps.p50), fmtMs(ps.p95), fmtMs(ps.min), fmtMs(ps.max)],
      ],
    ),
    ``,
    `## Does pause free the concurrency slot (Q1, D3)`,
    ``,
    `Documented as yes: "A paused sandbox doesn't count against your plan's limit on running sandboxes; resuming it counts again" (00-verification.md V20). Observed here: **${concurrencyFreed === null ? "not determined" : concurrencyFreed ? "confirmed" : "NOT confirmed"}**.`,
    ``,
    `${concurrencyDetail}`,
    ``,
    `Billing itself is not observable from the client. The gate records paused durations below so they can be reconciled against the invoice, rather than claiming to have measured dollars it cannot see.`,
    ``,
    `## Does the previewUrl route survive a pause and resume`,
    ``,
    "error" in route
      ? `Not determined: ${String((route as any).error).slice(0, 200)}`
      : table(
          ["measurement", "ms"],
          [
            ["fresh sandbox, first byte (route setup)", String((route as any).freshFirstByteMs)],
            ["same route, second request (steady state)", String((route as any).prePauseSteadyMs)],
            ["after pause and resume, first byte", String((route as any).postResumeFirstByteMs)],
            ["after pause and resume, second request", String((route as any).postResumeSecondMs)],
            ["preview host changed across the pause", String((route as any).hostChanged)],
            ["**stored URL still works after resume**", String((route as any).storedUrlStillWorks)],
            ["stored URL first byte after resume", String((route as any).storedUrlFirstByteMs)],
            ["cost of resolving a NEW url after resume", String((route as any).resolveAfterResumeMs)],
          ],
        ),
    ``,
    `**Why this matters more than it looks.** G1 measured warm-resume total at 6,124 ms, of which **2,389 ms is previewUrl first byte** and only 281 ms is the app answering on loopback. If the route established before a pause is still warm after the resume, the warm-pool replenisher touches \`previewUrl\` once before pausing and the visitor never pays route setup. That is roughly the difference between publishing 6.1 s and publishing something near 3.7 s.`,
    ``,
    `${routeVerdictLine(route as any)}`,
    ``,
    `## Q17: does previewUrl traffic reset the idle clock`,
    ``,
    `Method: one sandbox with \`timeoutMs\` ${Q17_TIMEOUT_MS} ms and \`onTimeout: "kill"\`, driven with continuous HTTP through its previewUrl and **no SDK calls at all**, observed for ${Q17_OBSERVE_MS} ms.`,
    ``,
    table(
      ["observation", "value"],
      [
        ["timeoutMs set", `${Q17_TIMEOUT_MS} ms`],
        ["observed for", `${Q17_OBSERVE_MS} ms`],
        ["preview requests made", q17.requests],
        ["sandbox died", q17.died === null ? "not determined" : String(q17.died)],
        ["time to death", q17.diedAtMs === null ? "n/a" : fmtMs(q17.diedAtMs)],
        ["preview traffic resets clock", q17.resetsClock === null ? "not determined" : String(q17.resetsClock)],
      ],
    ),
    ``,
    `**What this changes.** Nothing structural. The three-layer expiry design (02-architecture.md section 8.2) deliberately does not depend on this answer. What it tells us is how much layer 3, the dead-man refresh, is actually worth: if preview traffic resets the clock, a visitor who keeps loading pages keeps the sandbox alive past a server death, and layer 2's guest-side self-destruct is the only thing that stops them.`,
  ].join("\n");

  return {
    verdict,
    markdown: md,
    observations: resumeMs.length,
    data: { resumeMs, pauseMs, resume: rs, pause: ps, concurrencyFreed, concurrencyDetail, route, q17 },
  };
}

/**
 * Does the previewUrl route survive a pause and resume?
 *
 * This is the highest-value cheap experiment available right now. G1 measured a
 * fresh sandbox's previewUrl first byte at p50 2,389 ms, and that sits inside
 * warm-resume total of 6,124 ms. If the route established before a pause is
 * still warm after the resume, then the warm-pool replenisher should touch
 * previewUrl once before pausing, and warm total drops toward 3.7 s. That is the
 * difference between publishing 6.1 s and publishing something near 4 s, which
 * is a different sentence on the page.
 *
 * Method: fork, resolve previewUrl, hit it twice (once to establish the route,
 * once to read steady state), pause, resume, re-resolve, hit it again. Compare
 * the post-resume first byte against both the fresh baseline and the pre-pause
 * steady state.
 *
 * The host is recorded on both sides, because if the preview host CHANGES across
 * a pause then the route cannot survive by definition and the timing is moot.
 */
async function measureRouteSurvival(ctx: GateContext, snapshotId: string) {
  const app = APPS[G3_APP]!;
  let sandboxId: string | null = null;
  let bornAt = 0;
  try {
    const sb = await ctx.adapter.createSandbox(
      ctx.apiKey, "g3",
      { fromSnapshot: snapshotId, cpu: app.size.cpu, memMb: app.size.memMb,
        timeoutMs: 600_000, lifecycle: { onTimeout: "kill" },
        metadata: { ...ctx.metadata, blink_probe: "route-survival" } },
      0.004,
    );
    sandboxId = sb.value.sandboxId;
    bornAt = performance.now();

    const pv1 = await ctx.adapter.previewUrl(ctx.apiKey, sb.value, "g3", app.port);
    const url1 = previewHealthUrl(pv1.value.url, app.healthPath);
    const host1 = new URL(url1).host;

    // Establish the route, then read steady state on the same route.
    const cold = await timeGet(url1, 30_000);
    const warmSame = await timeGet(url1, 15_000);

    await ctx.adapter.pause(ctx.apiKey, sb.value, "g3");
    safeOut("      route-survival: paused, resuming\n");
    await ctx.adapter.resume(ctx.apiKey, sb.value, "g3");

    // THE ACTUAL QUESTION, and the one the first version of this experiment did
    // not ask: does the URL resolved BEFORE the pause still route to the sandbox
    // after the resume?
    //
    // The first version resolved a NEW url after resuming and compared hosts.
    // Equal hosts proved the hostname is stable; it proved nothing about whether
    // the old URL still works, and the entire pre-resolve design in
    // 02-architecture.md section 2.1 rests on exactly that. Hitting url1 with no
    // re-resolve is the whole test.
    //
    // It matters more than it did: G1 measured previewUrl() at about 255 ms on a
    // fresh sandbox but about 1,275 ms after a resume, so resuming appears to
    // rebuild the route. If the stored URL survives, the warm path skips a 1.3 s
    // call. If it does not, the claim path must re-resolve and pay it.
    const oldUrlAfterResume = await timeGet(url1, 30_000);
    const oldUrlSecond = oldUrlAfterResume.ok ? await timeGet(url1, 15_000) : { ok: false, ms: 0 };

    // Only then resolve a fresh one, to compare cost and confirm the host.
    const rT0 = performance.now();
    const pv2 = await ctx.adapter.previewUrl(ctx.apiKey, sb.value, "g3", app.port);
    const resolveAfterResumeMs = Math.round(performance.now() - rT0);
    const url2 = previewHealthUrl(pv2.value.url, app.healthPath);
    const host2 = new URL(url2).host;
    const afterResume = await timeGet(url2, 30_000);
    const afterResume2 = await timeGet(url2, 15_000);

    return {
      hostChanged: host1 !== host2,
      freshFirstByteMs: cold.ms,
      prePauseSteadyMs: warmSame.ms,
      // The load-bearing pair.
      storedUrlStillWorks: oldUrlAfterResume.ok,
      storedUrlFirstByteMs: oldUrlAfterResume.ms,
      storedUrlSecondMs: oldUrlSecond.ms,
      resolveAfterResumeMs,
      postResumeFirstByteMs: afterResume.ms,
      postResumeSecondMs: afterResume2.ms,
      allOk: cold.ok && warmSame.ok && afterResume.ok && afterResume2.ok,
    };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    if (sandboxId) {
      await ctx.adapter.killQuiet(ctx.apiKey, sandboxId, "g3");
      const lived = (performance.now() - bornAt) / 1000;
      ctx.guard.addSandboxSeconds(Math.min(lived, 180), app.size, true, "route-survival probe, observed lifetime");
    }
  }
}

async function timeGet(url: string, timeoutMs: number) {
  const t = performance.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: r.ok, ms: Math.round(performance.now() - t) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - t) };
  }
}

async function measureQ17(ctx: GateContext, snapshotId: string) {
  const app = APPS[G3_APP]!;
  let sandboxId: string | null = null;
  let requests = 0;
  let died: boolean | null = null;
  let diedAtMs: number | null = null;
  try {
    const created = await ctx.adapter.createSandbox(
      ctx.apiKey, "g3",
      { fromSnapshot: snapshotId, cpu: app.size.cpu, memMb: app.size.memMb,
        timeoutMs: Q17_TIMEOUT_MS, lifecycle: { onTimeout: "kill" },
        metadata: { ...ctx.metadata, blink_probe: "q17" } },
      0.004,
    );
    sandboxId = created.value.sandboxId;
    const preview = await ctx.adapter.previewUrl(ctx.apiKey, created.value, "g3", app.port);
    const url = previewHealthUrl(preview.value.url, app.healthPath);
    await waitHealthy(url, { timeoutMs: 60_000 });

    // From here on: preview HTTP only. No SDK calls, because an SDK call would
    // itself be "activity" and would invalidate the measurement.
    const t0 = performance.now();
    while (performance.now() - t0 < Q17_OBSERVE_MS) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        requests += 1;
        if (!res.ok && res.status >= 500) {
          // The app is gone: the sandbox was killed under us.
          died = true;
          diedAtMs = Math.round(performance.now() - t0);
          break;
        }
      } catch {
        requests += 1;
        died = true;
        diedAtMs = Math.round(performance.now() - t0);
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (died === null) died = false;
  } catch (err) {
    return { requests, died, diedAtMs, resetsClock: null, error: (err as Error).message };
  } finally {
    if (sandboxId) {
      ctx.guard.addSandboxSeconds(Math.round(Q17_OBSERVE_MS / 1000) + 60, app.size, false, "Q17 idle-clock probe, flat model");
      await ctx.adapter.killQuiet(ctx.apiKey, sandboxId, "g3");
    }
  }

  // Died at roughly timeoutMs means preview traffic did NOT keep it alive.
  // Survived well past timeoutMs means it did.
  const resetsClock = died === null ? null : !died;
  return { requests, died, diedAtMs, resetsClock };
}

const def: GateDefinition = {
  id: "g3",
  title: "pause billing, resume latency, and Q17",
  question: "Does a paused sandbox free its slot, how long does resume take (Q7), and does previewUrl traffic reset the idle clock (Q17)?",
  ceilingUsd: 0.03,
  // Half the intended resume samples. A p95 from two numbers is not a p95.
  minObservations: Math.max(2, Math.floor(RESUME_SAMPLES / 2)),
  observationUnit: "resume-to-healthy sample",
  preflight: () => missingSnapshots([G3_APP]),
  estimate: (plan) =>
    estimate(plan, [
      { sandboxSeconds: 60 + RESUME_SAMPLES * 20 + 30 + Math.round(Q17_OBSERVE_MS / 1000) + 60 + 180, size: SIZE_SMALL },
    ]),
  run,
};

await main(def);
