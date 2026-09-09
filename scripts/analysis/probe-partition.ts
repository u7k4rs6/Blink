/**
 * What the browser says about __pt_preview on every subresource request.
 *
 * CDP's *ExtraInfo events carry the cookie verdicts DevTools shows in its
 * Network cookie column, including blockedReasons and the partition key, which
 * is the thing a screenshot of the Application tab cannot tell you.
 *
 * Navigates Blink FIRST, then follows the handover link, so the partition
 * context matches a visitor clicking through rather than pasting a URL.
 */
import { SandboxClient } from "@solarisdk/sandbox";
import { Solari } from "@solarisdk/browser";
import { readFileSync } from "node:fs";

const snap = JSON.parse(readFileSync("scripts/gates/snapshots.json", "utf8")).gitea;
const sbc = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: "https://api.getsolari.com" });
const sb = await sbc.create({ fromSnapshot: snap, cpu: 1, memMb: 2048, timeoutMs: 600000, lifecycle: { onTimeout: "kill" } });
const browser = new Solari({ apiKey: process.env.SOLARI_API_KEY! });
let session: { id: string; cdpEndpoint: string } | null = null;

try {
  const sh = async (c: string): Promise<string> =>
    ((await sb.commands.run("sh", { args: ["-c", c], timeoutMs: 15000 })).stdout ?? "").trim();
  for (let i = 0; i < 300; i++) {
    if (await sh(`curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3000/ || echo x`) === "200") break;
    await new Promise((z) => setTimeout(z, 500));
  }
  const pv = await sb.previewUrl(3000);
  const landing = new URL("/blink/welcome/issues", pv.url);
  landing.searchParams.set("pt_token", new URL(pv.url).searchParams.get("pt_token")!);

  session = await browser.sessions.create({});
  const ws = new WebSocket(session.cdpEndpoint);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("cdp timeout")), 20000);
    ws.addEventListener("open", () => { clearTimeout(t); res(); });
    ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("cdp error")); });
  });
  let n = 0;
  const pend = new Map<number, (v: unknown) => void>();
  const sent = new Map<string, string>();
  const report: string[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pend.has(m.id)) { pend.get(m.id)!(m); pend.delete(m.id); return; }
    if (m.method === "Network.requestWillBeSent") {
      sent.set(m.params.requestId, m.params.request.url);
    }
    if (m.method === "Network.requestWillBeSentExtraInfo") {
      const cookies = m.params.associatedCookies ?? [];
      const pt = cookies.find((c: { cookie?: { name?: string } }) => c.cookie?.name === "__pt_preview");
      if (pt) {
        const url = sent.get(m.params.requestId) ?? "?";
        const path = (() => { try { return new URL(url).pathname; } catch { return url; } })();
        const blocked = (pt.blockedReasons ?? []).join(",") || "sent";
        const part = pt.cookie?.partitionKey;
        report.push(`${blocked.padEnd(28)} ${String(part?.topLevelSite ?? part ?? "none").padEnd(34)} ${path.slice(0, 40)}`);
      }
    }
    if (m.method === "Network.responseReceived" && m.params.response.status >= 400) {
      const path = (() => { try { return new URL(m.params.response.url).pathname; } catch { return "?"; } })();
      report.push(`HTTP ${m.params.response.status} (${m.params.type})`.padEnd(28) + " ".repeat(35) + path.slice(0, 40));
    }
  });
  const cdp = (method: string, params: unknown = {}, sid?: string): Promise<any> =>
    new Promise((res, rej) => {
      const k = ++n;
      pend.set(k, (m: any) => (m.error ? rej(new Error(method + " " + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: k, method, params, sessionId: sid }));
      setTimeout(() => rej(new Error(method + " timeout")), 40000);
    });

  const t = await cdp("Target.createTarget", { url: "about:blank" });
  const a = await cdp("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const sid = a.sessionId;
  await cdp("Network.enable", {}, sid);
  await cdp("Page.enable", {}, sid);

  console.log("1. top level navigation to Blink, so the partition context is Blink's");
  await cdp("Page.navigate", { url: "https://blink.utkarshbahuguna.me/" }, sid);
  await new Promise((r) => setTimeout(r, 4000));

  console.log("2. following the handover link\n");
  report.length = 0;
  await cdp("Page.navigate", { url: landing.toString() }, sid);
  await new Promise((r) => setTimeout(r, 8000));

  console.log("VERDICT".padEnd(28) + " PARTITION KEY".padEnd(35) + " PATH");
  for (const line of [...new Set(report)]) console.log(line);

  const cookies = await cdp("Network.getCookies", { urls: [landing.origin] }, sid);
  console.log("\ncookies the browser holds for that origin:");
  for (const c of cookies.cookies ?? []) {
    console.log(`  ${String(c.name).padEnd(14)} partitionKey=${JSON.stringify(c.partitionKey ?? null)}`);
  }
} finally {
  if (session) await browser.sessions.releaseAndWait(session.id).catch(() => {});
  await sbc.kill(sb.sandboxId);
  console.log("\nkilled");
}
