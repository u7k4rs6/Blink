/**
 * The canary.
 *
 * It is what makes a catalog card a promise rather than a claim. Every card says
 * "this works"; the canary is the only thing that checks, and the health wall
 * publishes what it found including the failures.
 *
 * It uses the LIVENESS checks, never a status code. A canary built on
 * `GET / -> 200` would have shown five green rows for a Gitea serving its own
 * installer (V73) and an Uptime Kuma stuck in its database wizard (V70). Both
 * answered 200 while being completely unusable.
 *
 * It is background work, so it YIELDS: it takes a slot only when doing so still
 * leaves one free for a visitor. A canary that made someone queue would be
 * measuring the site by degrading it.
 */

import type { SolariAdapter } from "../solari/adapter.ts";
import type { ScopeLock } from "../concurrency/scope-lock.ts";
import { admit } from "../slots/admit.ts";
import { rootUrlFor } from "../orchestrator/runner.ts";
import { livenessFor } from "../../scripts/gates/lib/liveness.ts";
import { captureAppScreenshot, shotIsFresh } from "./screenshot.ts";
import { safeErr } from "../safe-io.ts";
import type { Size } from "../guard/rates.ts";

export type CanaryResult = {
  appId: string;
  at: string;
  ok: boolean;
  /** What was asked, in the app's own terms, for the public log. */
  asked: string;
  detail: string;
  forkToHealthyMs: number | null;
  resolveMs: number | null;
  livenessMs: number | null;
  /** Present only when a capture was attempted on this run. */
  screenshot?: { bytes: number; ms: number } | { error: string };
  error?: string;
};

export type CanaryDeps = {
  apiKey: string;
  adapter: SolariAdapter;
  lock: ScopeLock;
  liveSlots: () => Promise<number>;
  maxSlots: number;
  waitHealthy: (
    exec: (cmd: string, o?: { timeoutMs?: number }) => Promise<{ value: { stdout: string; stderr: string } }>,
    port: number, path: string,
  ) => Promise<{ ok: boolean; ms: number }>;
  record: (r: CanaryResult) => void;
  /** Where card screenshots live. Omit to disable capture entirely. */
  shotPathFor?: (appId: string) => string;
};

export async function runCanaryOnce(d: CanaryDeps, app: {
  appId: string; snapshotId: string; size: Size; port: number; healthPath: string;
  shotPath?: string; shotScript?: string; shotExpect?: string; postFork?: string;
}): Promise<CanaryResult> {
  const at = new Date().toISOString();
  const base: CanaryResult = {
    appId: app.appId, at, ok: false, asked: "", detail: "",
    forkToHealthyMs: null, resolveMs: null, livenessMs: null,
  };

  let admitted = false;
  const res = await admit(d.lock, "canary", {
    liveSlots: d.liveSlots, maxSlots: d.maxSlots,
    onAdmit: async () => { admitted = true; },
  });
  if (!res.admitted || !admitted) {
    // Not a failure of the app. Recording it as one would put a red cell on the
    // health wall for something the app did not do.
    base.detail = `skipped: ${res.admitted ? "unknown" : res.reason}`;
    return base;
  }

  let sandboxId: string | null = null;
  const bornAt = performance.now();
  try {
    const sb = await d.adapter.createSandbox(
      d.apiKey, `canary:${app.appId}`,
      { fromSnapshot: app.snapshotId, cpu: app.size.cpu, memMb: app.size.memMb,
        timeoutMs: 300_000, lifecycle: { onTimeout: "kill" },
        metadata: { blink_canary: app.appId } },
      0.02,
    );
    sandboxId = sb.value.sandboxId;
    const sh = (cmd: string, o?: { timeoutMs?: number }) =>
      d.adapter.exec(d.apiKey, sb.value, `canary:${app.appId}`, cmd, o);

    /*
     * Run the boot script, because the visitor's launch does.
     *
     * It never did, which is why ROOT_URL being set to the literal string "arm"
     * survived every check: the canary forked a snapshot whose ROOT_URL was
     * still the placeholder, so it saw correct asset URLs that no visitor ever
     * got. Third time this exact gap has produced a bug (V80, V103), and the
     * rule stands: when the visitor's path does something, the canary walks it
     * too, or the canary is checking a machine nobody is given.
     */
    const pvEarly = await d.adapter.previewUrl(d.apiKey, sb.value, `canary:${app.appId}`, app.port);
    if (pvEarly.value.url) {
      const secs = Math.round((10 * 60_000 + 60_000) / 1000);
      await sh(`/usr/local/bin/blink-boot ${JSON.stringify(rootUrlFor(pvEarly.value.url))} ${secs} || true`,
        { timeoutMs: 25_000 }).catch(() => { /* the checks below report it */ });
    }

    const h = await d.waitHealthy(sh, app.port, app.healthPath);
    base.forkToHealthyMs = h.ms;

    /**
     * The canary must refresh time-sensitive data too.
     *
     * `postFork` was wired into the launch path and NOT here, so the canary kept
     * failing Jaeger for the very reason `postFork` exists (V77): traces seeded
     * at build time fall outside Jaeger's default lookback. The fix was applied
     * to what a visitor sees and not to the thing that checks what a visitor
     * sees, which is how a card ends up permanently red for a bug that is fixed.
     */
    if (h.ok && app.postFork) {
      await sh(app.postFork, { timeoutMs: 30_000 }).catch(() => { /* the check will report it */ });
    }
    if (!h.ok) {
      base.error = "never answered on loopback";
      base.detail = base.error;
      return base;
    }

    const t0 = performance.now();
    const pv = pvEarly.value.url ? pvEarly
      : await d.adapter.previewUrl(d.apiKey, sb.value, `canary:${app.appId}`, app.port);
    base.resolveMs = Math.round(performance.now() - t0);

    const live = await livenessFor(app.appId)(pv.value.url, 30_000);

    /**
     * Screenshot from THIS instance, the canary's own, never a visitor's (T6).
     *
     * Only when the check passed: a photograph of a broken app on a card is
     * worse than an empty frame, because it looks finished and is wrong. Only
     * when the existing one is stale, so a card is not re-photographed hourly
     * for browser-seconds it does not need.
     */
    if (live.ok && d.shotPathFor) {
      const out = d.shotPathFor(app.appId);
      if (!shotIsFresh(out)) {
        const shot = await captureAppScreenshot({
          apiKey: d.apiKey, previewUrl: pv.value.url, outPath: out, appId: app.appId,
          shotPath: app.shotPath, shotScript: app.shotScript, shotExpect: app.shotExpect,
        });
        base.screenshot = shot.ok ? { bytes: shot.bytes, ms: shot.ms } : { error: shot.error ?? "failed" };
        // A capture that fails writes no file, and a card with no picture is the
        // only visible symptom. Say why, or the next person debugging this reads
        // an empty directory and guesses.
        if (!shot.ok) safeErr(`[canary] ${app.appId} screenshot failed: ${shot.error ?? "failed"}\n`);
      }
    }

    base.ok = live.ok;
    base.asked = live.asked;
    base.detail = live.detail;
    base.livenessMs = live.ms;
    return base;
  } catch (err) {
    base.error = `${(err as Error).name}: ${(err as Error).message}`;
    base.detail = base.error;
    return base;
  } finally {
    if (sandboxId) await d.adapter.killQuiet(d.apiKey, sandboxId, `canary:${app.appId}`);
    d.record(base);
    void bornAt;
  }
}
