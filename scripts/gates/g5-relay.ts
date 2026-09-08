/**
 * G5: CDP screencast relay. Frame rate and bandwidth for 12 concurrent tiles in
 * one process.
 *
 * 02-architecture.md section 7 predicts roughly 4 fps per tile at about 15 KB a
 * frame, so 12 tiles is about 720 KB/s outbound and 32 MB for a 45 second run.
 * This gate measures the real numbers on the real host.
 *
 * Unblocked by Phase 0: sessions.create() returns cdpEndpoint directly, "Raw CDP
 * endpoint for chromium.connectOverCDP() or Puppeteer" (00-verification.md V11),
 * so no extra call is needed to obtain one. And Starter allows 20 concurrent
 * browsers against the 12 needed (V28).
 *
 * The browser SDK does not accept a custom fetch, so the counting fetch cannot
 * wrap it. What it does expose is maxAttempts, which is set to 1 here, and
 * LaunchOptions.retries, which already defaults to 0 (V17). That is the whole
 * retry surface on this side and both are pinned shut.
 *
 * This gate speaks raw CDP over a WebSocket rather than through Playwright,
 * because the thing being measured is the relay, and a Playwright client in the
 * middle would be measuring Playwright.
 *
 * THE TARGET IS OUR OWN SANDBOX, and that is not a detail.
 *
 * Pointing 12 concurrent browsers at any third-party site is forbidden by the
 * non-goals in 01-prd.md section 5 and is abusive at this concurrency regardless
 * of whose rules apply. Pointing them at the developer's own portfolio would
 * measure GitHub Pages, not the relay. So the gate forks ONE fresh base-template
 * sandbox, serves a trivial static page from it, takes its previewUrl, and points
 * every tile at that. The target is ours, it is disposable, and it is the same
 * shape as what a real Swarm run hits: a Solari sandbox behind previewUrl.
 *
 * Two free extras fall out of owning the target, and both are recorded:
 *
 *   - The previewUrl response headers, which is an early partial read on G2.
 *   - Whether previewUrl holds up under 12 concurrent clients, which nothing
 *     else in the harness tests and which the Swarm design depends on.
 *
 * The target sandbox is killed through the same sweeper path as the browser
 * sessions, so an interrupted run cannot leak it.
 */

import { Solari } from "@solarisdk/browser";

import { estimate } from "./lib/cost.ts";
import { handleFor, registerSecret } from "../../src/redact.ts";
import { previewHealthUrl, waitHealthy } from "./lib/health.ts";
import { SIZE_SMALL } from "../../src/guard/rates.ts";
import { percentile, stats } from "./lib/stats.ts";
import { table } from "./lib/report.ts";
import { main, type GateContext, type GateDefinition, type GateResult } from "./lib/harness.ts";

const TILES = Number(process.env.BLINK_G5_TILES ?? 12);
const RUN_MS = Number(process.env.BLINK_G5_RUN_MS ?? 45_000);
/** Port the target sandbox serves its trivial page on. */
const TARGET_PORT = 8099;
/** Cap on the target sandbox's life. */
const TARGET_SECONDS = 240; // +latency probes: 20 sequential through previewUrl, 20 over loopback

/**
 * A trivial page with a little motion, so the screencast has something to encode
 * and the frame numbers are not measured against a static image.
 */
const TARGET_PAGE = `<!doctype html><meta charset=utf-8><title>Blink G5 target</title>
<style>body{background:#0B0C0E;color:#E8EAED;font:14px system-ui;margin:0;
display:grid;place-items:center;height:100vh}
.d{width:120px;height:120px;border-radius:10px;background:#3DDC84;
animation:s 2s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style>
<div><div class=d></div><p>Blink G5 relay target</p></div>`;

type Tile = {
  idx: number;
  /**
   * A non-reversible handle, NOT the session id.
   *
   * Solari browser session ids are 113-character strings that embed the org id.
   * The 2026-09-03 sweep found twelve of them stored in this gate's own report.
   * No regex could have caught them: they are opaque, and pattern-based
   * redaction is structurally blind to that class. The report needs to tell
   * twelve tiles apart, not to address them, so a handle is sufficient.
   */
  session: string;
  frames: number;
  bytes: number;
  firstFrameMs: number | null;
  fps: number;
  error?: string;
};

type LatencyProfile = {
  /** The very first request, which includes any one-off routing setup. */
  firstMs: number;
  /** Every request after the first. */
  restMs: number[];
  p50Ms: number;
  p95Ms: number;
  minMs: number;
};

type TargetInfo = {
  url: string;
  headers: Record<string, string>;
  setCookies: string[];
  status: number | null;
  concurrent: { clients: number; ok: number; failed: number; p50Ms: number; maxMs: number } | null;
  /** 20 sequential requests from this server, through previewUrl. */
  viaPreview: LatencyProfile | null;
  /** 20 sequential requests from inside the guest, over loopback. */
  viaLoopback: LatencyProfile | null;
};

function profile(times: number[]): LatencyProfile {
  const first = times[0] ?? NaN;
  const rest = times.slice(1);
  const sorted = [...rest].sort((a, b) => a - b);
  return {
    firstMs: Math.round(first),
    restMs: rest.map((t) => Math.round(t)),
    p50Ms: Math.round(percentile(sorted, 50)),
    p95Ms: Math.round(percentile(sorted, 95)),
    minMs: Math.round(sorted[0] ?? NaN),
  };
}

/** 20 sequential GETs from this server, through previewUrl. */
async function probeSequential(url: string, n = 20): Promise<LatencyProfile> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    try {
      await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch { /* recorded as its elapsed time either way */ }
    times.push(performance.now() - t);
  }
  return profile(times);
}

async function run(ctx: GateContext): Promise<GateResult> {
  ctx.guard.reserveBrowserSlots(TILES);

  const tiles: Tile[] = [];
  const sessionIds: string[] = [];
  let targetSandboxId: string | null = null;
  let target: TargetInfo | null = null;
  const client = new Solari({ apiKey: ctx.apiKey, maxAttempts: 1 }); // no retry (V17)
  const t0 = performance.now();
  let targetBornAt = 0;

  try {
    // ---- 1. our own target sandbox, never a third-party site ----
    const sb = await ctx.adapter.createSandbox(
      ctx.apiKey, "g5",
      { template: "base", cpu: 1, memMb: 2048, timeoutMs: 300_000,
        lifecycle: { onTimeout: "kill" }, metadata: { ...ctx.metadata, blink_role: "relay-target" } },
      0.004,
    );
    targetSandboxId = sb.value.sandboxId;
    targetBornAt = performance.now();

    await ctx.adapter.exec(
      ctx.apiKey, sb.value, "g5",
      `mkdir -p /tmp/g5 && cat > /tmp/g5/index.html <<'HTML'\n${TARGET_PAGE}\nHTML\n` +
        `cd /tmp/g5 && (nohup python3 -m http.server ${TARGET_PORT} >/dev/null 2>&1 &) ; sleep 2 ; echo served`,
    );

    const pv = await ctx.adapter.previewUrl(ctx.apiKey, sb.value, "g5", TARGET_PORT);
    const targetUrl = previewHealthUrl(pv.value.url, "/index.html");
    const health = await waitHealthy(targetUrl, { timeoutMs: 45_000 });
    if (!health.ok) throw new Error(`relay target never became healthy: ${health.error ?? health.status}`);

    // ---- 2. free extras: header read (partial G2) and 12-concurrent load ----
    const headRes = await fetch(targetUrl, { redirect: "follow" });
    const headers: Record<string, string> = {};
    headRes.headers.forEach((v, k) => { headers[k] = v; });
    // Full Set-Cookie lines, not the folded single header. A bare
    // `python3 -m http.server` sets no cookies, so anything here comes from the
    // preview domain itself and needs identifying: if it is the pt_token in
    // cookie form, the security doc's redaction rule has to cover both forms.
    const setCookies = typeof headRes.headers.getSetCookie === "function" ? headRes.headers.getSetCookie() : [];
    for (const c of setCookies) registerSecret(c.split("=", 2)[1]?.split(";", 1)[0]);
    const concurrent = await probeConcurrent(targetUrl, TILES);
    target = { url: targetUrl, headers, setCookies, status: headRes.status, concurrent, viaPreview: null, viaLoopback: null };

    // ---- 3. the relay measurement proper ----
    const sessions = await Promise.all(
      Array.from({ length: TILES }, async (_, idx) => {
        const token = ctx.ledger.browserIntent("g5", `tile ${idx}`);
        const s = await client.sessions.create({});
        // Register before anything can write it. Session ids embed the org id.
        registerSecret(s.id);
        registerSecret(s.cdpEndpoint);
        registerSecret(s.wsEndpoint);
        sessionIds.push(s.id);
        ctx.ledger.browserOpened(s.id, "g5", token);
        ctx.guard.openedBrowser(s.id);
        return { idx, session: s };
      }),
    );

    const results = await Promise.all(
      sessions.map(({ idx, session }) => driveTile(idx, session.id, session.cdpEndpoint, RUN_MS, targetUrl)),
    );
    tiles.push(...results);

    // ---- 4. where does the 1196 ms go? ----
    //
    // The previous run measured p50 1196 ms for a trivial static file behind
    // previewUrl. If that is per-request rather than one-off routing setup, then
    // fork-to-healthy through previewUrl has a floor near 1.2 s no matter how
    // fast the fork is, and the headline in 01-prd.md S2 changes. Two probes,
    // 20 sequential requests each, to separate the three possibilities.
    const viaPreview = await probeSequential(targetUrl, 20);

    const loopUrl = `http://127.0.0.1:${TARGET_PORT}/index.html`;
    const loop = await ctx.adapter.exec(
      ctx.apiKey, sb.value, "g5",
      `for i in $(seq 1 20); do curl -s -o /dev/null -w '%{time_total}\n' ${loopUrl}; done`,
    );
    const loopTimes = loop.value.stdout
      .split("\n").map((x) => parseFloat(x.trim())).filter((x) => Number.isFinite(x))
      .map((sec) => sec * 1000);
    const viaLoopback = loopTimes.length > 1 ? profile(loopTimes) : null;

    target = { ...target!, viaPreview, viaLoopback };
  } finally {
    // One teardown path for both resources. A run that leaks either is a credit
    // leak, so releases are idempotent and the ledger sweeps whatever survives.
    // Bill for sessions actually created, not for tiles intended. The first live
    // run billed 572.5 browser-seconds for a run where the target 502'd before a
    // single session was opened, which overstated the cost of a failure.
    const elapsedS = (performance.now() - t0) / 1000;
    ctx.guard.addBrowserSeconds(elapsedS * sessionIds.length, true, `${sessionIds.length} browser sessions, observed elapsed`);
    for (const id of sessionIds) {
      try { await client.sessions.releaseAndWait(id); } catch { /* already gone */ }
      ctx.ledger.browserClosed(id);
      ctx.guard.closedBrowser(id);
    }
    try { await client.close(); } catch { /* nothing to close */ }

    if (targetSandboxId) {
      await ctx.adapter.killQuiet(ctx.apiKey, targetSandboxId, "g5");
      const lived = (performance.now() - targetBornAt) / 1000;
      ctx.guard.addSandboxSeconds(Math.min(lived, TARGET_SECONDS), SIZE_SMALL, true, "relay target sandbox, observed lifetime");
    }
  }

  const ok = tiles.filter((t) => !t.error);
  const fps = stats(ok.map((t) => t.fps));
  const totalBytes = ok.reduce((a, t) => a + t.bytes, 0);
  const runS = RUN_MS / 1000;
  const kbPerS = totalBytes / 1024 / runS;
  const mbps = (totalBytes * 8) / 1e6 / runS;
  const bytesPerFrame = ok.reduce((a, t) => a + t.frames, 0) > 0 ? totalBytes / ok.reduce((a, t) => a + t.frames, 0) : 0;

  const predictedKbPerS = 720;
  const totalFrames = ok.reduce((a, t) => a + t.frames, 0);
  const withinPrediction = kbPerS <= predictedKbPerS * 1.5;

  // A floor check, because zero is not "within budget".
  //
  // The previous run reported "0.0 fps, 0 KB/s, Within the section 7 prediction"
  // and exited 0. The threshold was `kbPerS <= 720 * 1.5`, which zero satisfies
  // trivially. A gate that reports total failure as a pass is worse than one
  // that crashes, so streaming nothing is now INCONCLUSIVE by construction.
  const streamed = totalFrames > 0;

  const verdict = !streamed
    ? `INCONCLUSIVE. ${ok.length}/${TILES} tiles connected over CDP but **zero screencast frames arrived**, so the relay was never exercised and Q11 is untouched. This is not a slow relay, it is no relay: total payload was ${totalBytes} bytes across all tiles, which is command acknowledgements and nothing else. Do not read any throughput number below as a measurement.`
    : `${ok.length}/${TILES} tiles streamed ${totalFrames} frames. Median ${fps.p50.toFixed(1)} fps per tile, ` +
      `${Math.round(kbPerS)} KB/s aggregate (${mbps.toFixed(1)} Mbps), ${Math.round(bytesPerFrame / 1024)} KB per frame. ` +
      `${withinPrediction ? "Within" : "ABOVE"} the section 7 prediction of about ${predictedKbPerS} KB/s.`;

  const md = [
    `## Aggregate`,
    ``,
    table(
      ["measurement", "predicted (section 7)", "measured"],
      [
        ["tiles", TILES, `${ok.length} streamed, ${tiles.length - ok.length} failed`],
        ["fps per tile", "about 4", `p50 ${fps.p50.toFixed(1)}, p95 ${fps.p95.toFixed(1)}, min ${fps.min.toFixed(1)}`],
        ["bytes per frame", "about 15 KB", `${Math.round(bytesPerFrame / 1024)} KB`],
        ["aggregate outbound", "about 720 KB/s (5.8 Mbps)", `${Math.round(kbPerS)} KB/s (${mbps.toFixed(1)} Mbps)`],
        ["total for a 45 s run", "about 32 MB", `${(totalBytes / 1048576).toFixed(1)} MB`],
      ],
    ),
    ``,
    `## Per tile`,
    ``,
    table(
      ["tile", "frames", "KB", "fps", "first frame", "error"],
      tiles.map((t) => [t.idx, t.frames, Math.round(t.bytes / 1024), t.fps.toFixed(1), t.firstFrameMs === null ? "never" : `${t.firstFrameMs} ms`, t.error ?? ""]),
    ),
    ``,
    `## The relay target, and two free readings from it`,
    ``,
    `Every tile pointed at **our own sandbox**, a fresh base-template fork serving a trivial animated page on port ${TARGET_PORT} behind \`previewUrl\`. No third-party site was loaded, which the non-goals forbid and which would be abusive at 12 concurrent browsers regardless. It is also the right target on the merits: it is the same shape as a real Swarm run, a Solari sandbox behind \`previewUrl\`, rather than someone else's CDN.`,
    ``,
    `### previewUrl response headers (early partial read on G2)`,
    ``,
    target
      ? table(
          ["header", "value"],
          [
            ["status", String(target.status)],
            ["x-frame-options", target.headers["x-frame-options"] ?? "absent"],
            ["content-security-policy", target.headers["content-security-policy"] ?? "absent"],
            ["server", target.headers["server"] ?? "absent"],
            ["set-cookie", target.headers["set-cookie"] ? "present" : "absent"],
            ["access-control-allow-origin", target.headers["access-control-allow-origin"] ?? "absent"],
          ],
        )
      : "Target never came up, so no headers were read.",
    ``,
    target
      ? `This is one app on one port, so it is a partial read and not G2's answer. G2 still has to check three real apps, because a framing header set by the *app* (Gitea, Uptime Kuma) is a different question from one set by the *preview domain*. What this does settle is which headers the preview domain itself adds, since the page behind it is a bare \`python3 -m http.server\` that sets almost nothing: ${target.headers["x-frame-options"] || target.headers["content-security-policy"] ? "the preview domain **does** add framing headers of its own, which G2 must account for." : "the preview domain adds **no** framing headers of its own, so whatever G2 finds on a real app comes from that app and is therefore configurable."}`
      : "",
    ``,
    `### Where the previewUrl overhead actually goes`,
    ``,
    target?.viaPreview
      ? table(
          ["path", "first request", "steady-state p50", "steady-state p95", "min"],
          [
            [
              "server to previewUrl",
              `${target.viaPreview.firstMs} ms`,
              `${target.viaPreview.p50Ms} ms`,
              `${target.viaPreview.p95Ms} ms`,
              `${target.viaPreview.minMs} ms`,
            ],
            target.viaLoopback
              ? [
                  "inside the guest, over loopback",
                  `${target.viaLoopback.firstMs} ms`,
                  `${target.viaLoopback.p50Ms} ms`,
                  `${target.viaLoopback.p95Ms} ms`,
                  `${target.viaLoopback.minMs} ms`,
                ]
              : ["inside the guest, over loopback", "not measured", "", "", ""],
          ],
        )
      : "Not measured on this run.",
    ``,
    (() => {
      if (!target?.viaPreview) return "";
      const vp = target.viaPreview;
      const oneOff = vp.firstMs > vp.p50Ms * 2 && vp.p50Ms < 400;
      const loop = target.viaLoopback;
      const overhead = loop ? vp.p50Ms - loop.p50Ms : null;
      return [
        oneOff
          ? `**The overhead is largely one-off routing setup.** The first request cost ${vp.firstMs} ms and steady state settled to ${vp.p50Ms} ms. So the 1196 ms seen earlier was first-request cost, not a per-request tax, and fork-to-healthy does **not** carry a ~1.2 s floor. S2's headline stands as a fork-speed number.`
          : `**The overhead is per-request, not one-off.** First request ${vp.firstMs} ms, steady-state p50 ${vp.p50Ms} ms: the cost does not amortise. **This changes the headline.** Fork-to-healthy measured through \`previewUrl\` has a floor near ${vp.p50Ms} ms no matter how fast the fork is, so \`01-prd.md\` S2 must either publish a number measured over loopback and say so, or publish the through-preview number and stop calling it fork speed. The recording beat in \`04-frontend-spec.md\` section 10 assumes a sub-second reveal and needs rewriting against the real number.`,
        ``,
        overhead !== null
          ? `**Preview-domain overhead is about ${overhead} ms per request** (${vp.p50Ms} ms through previewUrl versus ${loop!.p50Ms} ms over loopback inside the guest). The loopback figure is the app's own service time; everything above it is routing.`
          : `Loopback baseline was not captured, so the split between routing and app service time is unknown.`,
        ``,
        `**Design consequence, and it holds either way: the health check runs over loopback inside the sandbox via \`commands.run\`, not through \`previewUrl\`.** The launch path polls health up to 15 s at 250 ms intervals, which is up to 60 requests. Paying preview-domain overhead on every one of them inflates fork-to-healthy by routing cost that a visitor never experiences as part of the fork. \`previewUrl\` is then resolved once, for the handover, and its first-byte cost is reported as its own number rather than hidden inside the fork time. Written into \`02-architecture.md\` sections 2.1 and 2.2.`,
      ].join("\n");
    })(),
    ``,
    `### The Set-Cookie on the preview domain`,
    ``,
    target && target.setCookies.length > 0
      ? [
          "```",
          ...target.setCookies,
          "```",
          "",
          (() => {
            const joined = target.setCookies.join(" ");
            const isPt = /pt_token|preview[_-]?token|pinetree/i.test(joined);
            return isPt
              ? `**This is the preview token in cookie form.** The bare \`python3 -m http.server\` behind it sets no cookies, so the preview domain is issuing it. Three consequences. First, \`03-security-and-access.md\`'s redaction rule currently covers the \`?pt_token=\` URL form only and **must cover the cookie form too**, in logs, reports and any captured HAR or replay. Second, Swarm's ${TILES} browsers are ${TILES} fresh cookie jars, so every tile pays the token handshake independently, which is a candidate cause of the first-request cost above and may behave differently at higher concurrency than at ${TILES}. Third, a cookie means the capability can outlive the URL in a browser profile, so Swarm sessions must not reuse profiles across visitors.`
              : `Not obviously the preview token. Name and attributes are above; identify it before assuming it is harmless, since the origin server sets no cookies at all.`;
          })(),
        ].join("\n")
      : "No Set-Cookie was returned on this run.",
    ``,
    `### Does previewUrl hold up under ${TILES} concurrent clients`,
    ``,
    target?.concurrent
      ? table(
          ["clients", "ok", "failed", "p50", "max"],
          [[target.concurrent.clients, target.concurrent.ok, target.concurrent.failed, `${target.concurrent.p50Ms} ms`, `${target.concurrent.maxMs} ms`]],
        )
      : "Not measured.",
    ``,
    target?.concurrent
      ? (target.concurrent.failed === 0
          ? `All ${target.concurrent.clients} concurrent requests succeeded, so \`previewUrl\` does not fall over at Swarm concurrency. The Swarm design assumes exactly this and nothing else in the harness tests it.`
          : `**${target.concurrent.failed} of ${target.concurrent.clients} concurrent requests failed.** The Swarm design assumes previewUrl serves N simultaneous clients, and at N=${TILES} it did not. Either cap Swarm below this number or expect visibly failed tiles.`)
      : "",
    ``,
    `## What this means`,
    ``,
    `The relay runs in one Node process alongside the orchestrator (02-architecture.md section 1), so this number is a budget for the whole server, not just the grid. On the chosen host, Hetzner CX22 with 20 TB of traffic (V52), ${mbps.toFixed(1)} Mbps for 45 seconds per run is ${(totalBytes / 1048576).toFixed(1)} MB, and the traffic allowance is not the constraint. CPU in one process is.`,
    ``,
    `If measured fps is far below 4, the backpressure design in section 7 (acknowledge a frame only after the visitor socket drains, and double \`everyNthFrame\` for a tile more than 2 s behind) is doing the right thing but from a worse starting point, and the grid should ship at fewer tiles rather than a slower grid.`,
  ].join("\n");

  return { observations: totalFrames, verdict, markdown: md, data: { target, tiles, totalFrames, totalBytes, kbPerS, mbps, bytesPerFrame, fps, streamed } };
}

/**
 * Does previewUrl hold up under N concurrent clients? Nothing else in the
 * harness tests this, and the whole Swarm design assumes it does.
 */
async function probeConcurrent(url: string, n: number) {
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: n }, async () => {
      const t = performance.now();
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        return { ok: r.ok, ms: performance.now() - t };
      } catch {
        return { ok: false, ms: performance.now() - t };
      }
    }),
  );
  void started;
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  return {
    clients: n,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    p50Ms: Math.round(times[Math.floor(times.length / 2)] ?? 0),
    maxMs: Math.round(times[times.length - 1] ?? 0),
  };
}

/** Drive one tile over raw CDP and count frames and bytes. */
async function driveTile(idx: number, sessionId: string, cdpEndpoint: string, runMs: number, targetUrl: string): Promise<Tile> {
  const tile: Tile = { idx, session: handleFor(sessionId), frames: 0, bytes: 0, firstFrameMs: null, fps: 0 };
  const started = performance.now();
  let ws: WebSocket | null = null;
  try {
    ws = new WebSocket(cdpEndpoint);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("cdp connect timeout")), 15_000);
      ws!.addEventListener("open", () => { clearTimeout(t); resolve(); });
      ws!.addEventListener("error", () => { clearTimeout(t); reject(new Error("cdp connect error")); });
    });

    let id = 0;
    let pageSessionId: string | undefined;
    const pending = new Map<number, (v: unknown) => void>();

    const send = (method: string, params: Record<string, unknown> = {}) => {
      id += 1;
      const msg: Record<string, unknown> = { id, method, params };
      // Once attached, every Page.* message must be routed to the page session.
      if (pageSessionId && method.startsWith("Page.")) msg.sessionId = pageSessionId;
      ws!.send(JSON.stringify(msg));
      return id;
    };

    /** Send and await the matching response. Used for the attach handshake. */
    const call = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<unknown>((resolve, reject) => {
        const myId = send(method, params);
        const timer = setTimeout(() => { pending.delete(myId); reject(new Error(`${method} timed out`)); }, 15_000);
        pending.set(myId, (v) => { clearTimeout(timer); resolve(v); });
      });

    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      if (!raw) return;
      tile.bytes += raw.length;
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: { sessionId?: number; data?: string } };
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const done = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) { tile.error = `${msg.error.message ?? "cdp error"}`; done({}); }
        else done(msg.result ?? {});
        return;
      }
      if (msg.method === "Page.screencastFrame") {
        tile.frames += 1;
        if (tile.firstFrameMs === null) tile.firstFrameMs = Math.round(performance.now() - started);
        // Acknowledge, or the browser stops producing frames. Real backpressure
        // lives in the relay; here we ack immediately because we are measuring
        // the ceiling, not the throttle.
        if (msg.params?.sessionId !== undefined) {
          // Note the two different sessionIds: the screencast frame's own ack id
          // goes in params, while the CDP page session is set by send().
          send("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
        }
      }
    });

    // `cdpEndpoint` is a BROWSER-level endpoint, the kind chromium.connectOverCDP
    // takes. `Page.*` does not exist there. The previous run sent Page.enable,
    // Page.navigate and Page.startScreencast straight down it, got three small
    // "wasn't found" errors totalling 224 bytes per tile, and streamed nothing.
    //
    // So: create a page target, attach to it flat, and tag every subsequent
    // message with the returned sessionId.
    const created = await call("Target.createTarget", { url: "about:blank" });
    const targetId = (created as { targetId?: string }).targetId;
    if (!targetId) throw new Error("Target.createTarget returned no targetId");

    const attached = await call("Target.attachToTarget", { targetId, flatten: true });
    const cdpSessionId = (attached as { sessionId?: string }).sessionId;
    if (!cdpSessionId) throw new Error("Target.attachToTarget returned no sessionId");
    pageSessionId = cdpSessionId;

    send("Page.enable");
    send("Page.navigate", { url: targetUrl });
    await new Promise((r) => setTimeout(r, 1500));
    send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 480, maxHeight: 320, everyNthFrame: 2 });

    await new Promise((r) => setTimeout(r, runMs));
    send("Page.stopScreencast");
  } catch (err) {
    tile.error = (err as Error).message;
  } finally {
    try { ws?.close(); } catch { /* already closed */ }
    const elapsedS = (performance.now() - started) / 1000;
    tile.fps = elapsedS > 0 ? tile.frames / elapsedS : 0;
  }
  return tile;
}

const def: GateDefinition = {
  id: "g5",
  title: "CDP screencast relay at 12 tiles",
  question: "What frame rate and bandwidth does one Node process sustain relaying 12 concurrent CDP screencasts against our own previewUrl target (Q11)?",
  ceilingUsd: 0.05,
  // Screencast frames. Zero frames is not a slow relay, it is no relay, and the
  // first re-run reported exactly that as "within prediction".
  minObservations: TILES,
  observationUnit: "screencast frame",
  estimate: (plan) =>
    estimate(plan, [
      { browserSeconds: TILES * (RUN_MS / 1000 + 20) },
      // The relay target sandbox we host ourselves.
      { sandboxSeconds: TARGET_SECONDS, size: SIZE_SMALL },
    ]),
  run,
};

await main(def);
