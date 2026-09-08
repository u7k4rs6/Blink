/**
 * G2: previewUrl framing headers, and whether the app actually works behind it.
 *
 * Two halves, and the second is the one that has historically been skipped:
 *
 *   1. Headers. Fetch a previewUrl and inspect X-Frame-Options and
 *      Content-Security-Policy: frame-ancestors. This decides whether the
 *      desktop iframe layout in 04-frontend-spec.md section 3 exists at all.
 *      New-tab-plus-toolbar is already the default design (D5), so a refusal
 *      costs a feature, not the project.
 *
 *   2. Does the app WORK behind it. Absolute URLs, websockets, cookies. Uptime
 *      Kuma's websockets are named in 02-architecture.md section 6 as the first
 *      thing to test, because a preview domain that breaks upgrade requests
 *      removes an app from the catalog.
 *
 * Q4 is already resolved and does not need measuring here: the previewUrl
 * carries a one-hour pt_token (00-verification.md V21). What we DO check is that
 * the token survives a redirect and that a tokenless request is refused, because
 * T5 in the security doc rests on exactly that.
 */

import { APPS, G2_APPS, loadRegistry, missingSnapshots } from "./lib/apps.ts";
import { previewHealthUrl, waitHealthy } from "./lib/health.ts";
import { estimate } from "./lib/cost.ts";
import { table } from "./lib/report.ts";
import { main, type GateContext, type GateDefinition, type GateResult } from "./lib/harness.ts";
import { SIZE_SMALL } from "../../src/guard/rates.ts";

const SECONDS_PER_APP = 90;

type Finding = {
  app: string;
  reachable: boolean;
  status: number | null;
  xFrameOptions: string | null;
  frameAncestors: string | null;
  framable: boolean | null;
  setCookie: string | null;
  sameSite: string | null;
  absoluteUrlsSeen: string[];
  websocketUpgrade: { attempted: boolean; ok: boolean | null; detail: string };
  tokenlessRefused: boolean | null;
  error?: string;
};

function parseFrameAncestors(csp: string | null): string | null {
  if (!csp) return null;
  const m = /frame-ancestors\s+([^;]+)/i.exec(csp);
  return m ? m[1]!.trim() : null;
}

/**
 * Framable means: no X-Frame-Options DENY/SAMEORIGIN, and either no
 * frame-ancestors or one that is not 'none'/'self'. Anything else and the
 * desktop iframe is off.
 */
function judgeFramable(xfo: string | null, fa: string | null): boolean {
  const x = (xfo ?? "").toLowerCase();
  if (x.includes("deny") || x.includes("sameorigin")) return false;
  const f = (fa ?? "").toLowerCase();
  if (f.includes("'none'") || f.includes("'self'")) return false;
  return true;
}

async function probeWebsocket(previewUrl: string): Promise<{ attempted: boolean; ok: boolean | null; detail: string }> {
  // A real upgrade handshake, not a guess. 101 means the preview domain proxies
  // websockets; anything else means Uptime Kuma will not work behind it.
  const u = new URL(previewUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  try {
    const ws = new WebSocket(u.href);
    const outcome = await new Promise<string>((resolve) => {
      const t = setTimeout(() => resolve("timeout after 8s"), 8000);
      ws.addEventListener("open", () => { clearTimeout(t); resolve("open"); });
      ws.addEventListener("error", () => { clearTimeout(t); resolve("error"); });
      ws.addEventListener("close", (e) => { clearTimeout(t); resolve(`close code=${(e as { code?: number }).code ?? "unknown"}`); });
    });
    try { ws.close(); } catch { /* already closed */ }
    return { attempted: true, ok: outcome === "open", detail: outcome };
  } catch (err) {
    return { attempted: true, ok: false, detail: (err as Error).message };
  }
}

async function run(ctx: GateContext): Promise<GateResult> {
  const reg = loadRegistry();
  const findings: Finding[] = [];

  for (const appId of G2_APPS) {
    const app = APPS[appId]!;
    let sandboxId: string | null = null;
    try {
      const created = await ctx.adapter.createSandbox(
        ctx.apiKey, "g2",
        {
          fromSnapshot: reg[appId]!, cpu: app.size.cpu, memMb: app.size.memMb,
          timeoutMs: 180_000, lifecycle: { onTimeout: "kill" },
          metadata: { ...ctx.metadata, blink_app: appId },
        },
        0.002,
      );
      sandboxId = created.value.sandboxId;
      const preview = await ctx.adapter.previewUrl(ctx.apiKey, created.value, "g2", app.port);
      const url = preview.value.url;

      const health = await waitHealthy(previewHealthUrl(url, app.healthPath), { timeoutMs: 60_000 });
      if (!health.ok) {
        findings.push({
          app: appId, reachable: false, status: health.status, xFrameOptions: null,
          frameAncestors: null, framable: null, setCookie: null, sameSite: null,
          absoluteUrlsSeen: [], websocketUpgrade: { attempted: false, ok: null, detail: "app never became healthy" },
          tokenlessRefused: null, error: `unhealthy after 60 s: ${health.error ?? health.status}`,
        });
        continue;
      }

      const res = await fetch(url, { redirect: "follow" });
      const body = await res.text();
      const xfo = res.headers.get("x-frame-options");
      const csp = res.headers.get("content-security-policy");
      const fa = parseFrameAncestors(csp);
      const setCookie = res.headers.get("set-cookie");
      const sameSite = setCookie ? (/samesite=(\w+)/i.exec(setCookie)?.[1] ?? null) : null;

      // Absolute URLs pointing anywhere other than the preview host will break
      // behind previewUrl. Gitea writes these from ROOT_URL, which is why the
      // boot script has to patch app.ini after the fork.
      const host = new URL(url).host;
      const absolute = [...body.matchAll(/(?:href|src|action)="(https?:\/\/[^"]+)"/gi)]
        .map((m) => m[1]!)
        .filter((h) => { try { return new URL(h).host !== host; } catch { return false; } });

      // T5 depends on a tokenless request being refused.
      const bare = new URL(url);
      bare.search = "";
      let tokenlessRefused: boolean | null = null;
      try {
        const r2 = await fetch(bare.href, { redirect: "manual" });
        tokenlessRefused = r2.status === 401 || r2.status === 403;
      } catch { tokenlessRefused = null; }

      const ws = appId === "uptimekuma" ? await probeWebsocket(url) : { attempted: false, ok: null, detail: "not applicable" };

      findings.push({
        app: appId, reachable: true, status: res.status,
        xFrameOptions: xfo, frameAncestors: fa, framable: judgeFramable(xfo, fa),
        setCookie: setCookie ? "present" : null, sameSite,
        absoluteUrlsSeen: [...new Set(absolute)].slice(0, 5),
        websocketUpgrade: ws, tokenlessRefused,
      });
    } catch (err) {
      findings.push({
        app: appId, reachable: false, status: null, xFrameOptions: null, frameAncestors: null,
        framable: null, setCookie: null, sameSite: null, absoluteUrlsSeen: [],
        websocketUpgrade: { attempted: false, ok: null, detail: "gate failed before probe" },
        tokenlessRefused: null, error: (err as Error).message,
      });
    } finally {
      if (sandboxId) {
        ctx.guard.addSandboxSeconds(SECONDS_PER_APP, app.size, false, `${appId} framing probe, flat model`);
        await ctx.adapter.killQuiet(ctx.apiKey, sandboxId, "g2");
      }
    }
  }

  const anyFramable = findings.some((f) => f.framable === true);
  const kuma = findings.find((f) => f.app === "uptimekuma");
  const wsOk = kuma?.websocketUpgrade.ok;

  const verdict =
    `${anyFramable ? "Iframe is possible for at least one app" : "Iframe refused, new-tab-plus-toolbar is the design (D5), which was already the default"}. ` +
    `Uptime Kuma websockets behind previewUrl: ${wsOk === true ? "WORK" : wsOk === false ? "DO NOT WORK, remove it from the catalog or drop the live monitor view" : "not determined"}.`;

  const md = [
    `## Framing headers`,
    ``,
    table(
      ["app", "reachable", "X-Frame-Options", "frame-ancestors", "framable"],
      findings.map((f) => [f.app, String(f.reachable), f.xFrameOptions ?? "none", f.frameAncestors ?? "none", f.framable === null ? "n/a" : String(f.framable)]),
    ),
    ``,
    "If no app is framable, `04-frontend-spec.md` section 3's desktop iframe layout is dead and the toolbar page is the only layout. That was already the default design, so nothing else changes.",
    ``,
    `## Does the app actually work behind previewUrl`,
    ``,
    table(
      ["app", "cross-host absolute URLs", "cookie SameSite", "websocket upgrade", "tokenless request refused"],
      findings.map((f) => [
        f.app,
        f.absoluteUrlsSeen.length === 0 ? "none" : `${f.absoluteUrlsSeen.length}: ${f.absoluteUrlsSeen.slice(0, 2).join(", ")}`,
        f.sameSite ?? "no cookie",
        f.websocketUpgrade.attempted ? `${f.websocketUpgrade.ok ? "ok" : "failed"} (${f.websocketUpgrade.detail})` : "n/a",
        f.tokenlessRefused === null ? "not determined" : String(f.tokenlessRefused),
      ]),
    ),
    ``,
    `**Cross-host absolute URLs** are the Gitea failure mode: it writes them from \`ROOT_URL\`, so the boot script must patch \`app.ini\` to the previewUrl after the fork and restart before the health check.`,
    ``,
    `**Tokenless request refused** is the check T5 rests on. If a bare previewUrl without its \`pt_token\` is served rather than refused, the URL is not a capability and every instance needs an app-level password.`,
  ].join("\n");

  return { observations: findings.filter((f) => f.reachable).length, verdict, markdown: md, data: { findings } };
}

const def: GateDefinition = {
  id: "g2",
  title: "previewUrl framing, and whether the app works behind it",
  question: "What framing headers does previewUrl carry (Q3), and do absolute URLs, websockets and cookies survive behind it?",
  ceilingUsd: 0.02,
  // At least one app actually reachable behind previewUrl. Header conclusions
  // drawn from an app that never came up are worthless.
  minObservations: 1,
  observationUnit: "app reached behind previewUrl",
  preflight: () => missingSnapshots(G2_APPS),
  estimate: (plan) => estimate(plan, [{ sandboxSeconds: G2_APPS.length * SECONDS_PER_APP, size: SIZE_SMALL }]),
  run,
};

await main(def);
