/**
 * Ask one instance what is actually on the screen, rather than guessing.
 *
 * Prints the URL the page ended on, its visible text, and the count for every
 * selector the shotExpect for that app depends on, then saves the PNG. One
 * sandbox and one browser session per app.
 */
import { SandboxClient } from "@solarisdk/sandbox";
import { Solari } from "@solarisdk/browser";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { APPS } from "../gates/lib/apps.ts";

const appId = process.argv[2]!;
const app = APPS[appId]!;
const snap = JSON.parse(readFileSync("scripts/gates/snapshots.json", "utf8"))[appId];
const key = process.env.SOLARI_API_KEY!;
const OUT = process.env.PROBE_OUT ?? "/tmp/probe";

const at = (base: string, path: string) => {
  const b = new URL(base);
  const t = b.searchParams.get("pt_token");
  const u = new URL(path, b);
  if (t) u.searchParams.set("pt_token", t);
  return u.toString();
};

const c = new SandboxClient({ apiKey: key, baseUrl: "https://api.getsolari.com" });
const sb = await c.create({ fromSnapshot: snap, cpu: app.size.cpu, memMb: app.size.memMb,
  timeoutMs: 420000, lifecycle: { onTimeout: "kill" } });
console.log("sandbox up");

let ws: WebSocket | null = null;
let sid2: string | null = null;
const browser = new Solari({ apiKey: key });
try {
  for (let i = 0; i < 300; i++) {
    const r = await sb.commands.run("sh", { args: ["-c",
      `curl -sf -m 3 -o /dev/null http://127.0.0.1:${app.port}${app.healthPath} && echo READY || echo WAIT`], timeoutMs: 8000 });
    if ((r.stdout ?? "").includes("READY")) break;
    await new Promise((r2) => setTimeout(r2, 500));
  }
  console.log("healthy");

  if (app.postFork) {
    const r = await sb.commands.run("sh", { args: ["-c", app.postFork], timeoutMs: 60000 });
    console.log("postFork exit", r.exitCode, "|", (r.stdout ?? "").trim().slice(-200), "|", (r.stderr ?? "").trim().slice(-300));
  }

  const pv = await sb.previewUrl(app.port);
  const session = await browser.sessions.create({});
  sid2 = session.id;
  ws = new WebSocket(session.cdpEndpoint);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("cdp timeout")), 20000);
    ws!.addEventListener("open", () => { clearTimeout(t); res(); });
    ws!.addEventListener("error", () => { clearTimeout(t); rej(new Error("cdp error")); });
  });
  let id = 0;
  const pending = new Map<number, (v: unknown) => void>();
  ws.addEventListener("message", (e: MessageEvent) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  });
  const cdp = (method: string, params: unknown = {}, s?: string) => new Promise<any>((res, rej) => {
    const n = ++id;
    pending.set(n, (m: any) => (m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result)));
    ws!.send(JSON.stringify({ id: n, method, params, sessionId: s }));
    setTimeout(() => rej(new Error(method + " timed out")), 45000);
  });

  const tgt = await cdp("Target.createTarget", { url: "about:blank" });
  const att = await cdp("Target.attachToTarget", { targetId: tgt.targetId, flatten: true });
  const s = att.sessionId;
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, s);
  await cdp("Page.enable", {}, s);
  await cdp("Runtime.enable", {}, s);
  await cdp("Page.navigate", { url: at(pv.url, app.shotPath ?? "/") }, s);

  if (app.shotScript) {
    await new Promise((r) => setTimeout(r, 1500));
    const ran = await cdp("Runtime.evaluate", {
      expression: `(async () => { try { ${app.shotScript}; return "SHOT_SCRIPT_OK"; } catch (e) { return "SHOT_SCRIPT_FAILED: " + ((e && e.message) || e); } })()`,
      awaitPromise: true, returnByValue: true,
    }, s).catch((e: Error) => ({ result: { value: "EVAL_REJECTED: " + e.message } }));
    console.log("shotScript ->", ran.result?.value);
  }
  await new Promise((r) => setTimeout(r, 5000));

  const probe = await cdp("Runtime.evaluate", {
    expression: `JSON.stringify({
      url: location.pathname + location.hash.slice(0, 60),
      title: document.title,
      text: document.body.innerText.replace(/\\n+/g, " | ").slice(0, 700),
      counts: Object.fromEntries(${JSON.stringify([
        "[data-testid=cell-data]", ".cellData", "td", "table",
        "[data-testid=search-result-item]", ".ResultItem", ".ResultItemTitle",
        ".issue.list li", ".flex-item", "canvas", ".beat", ".hp-bar-big .beat",
        'a[href^="/dashboard/"]', ".monitor-list a",
      ])}.map(sel => { try { return [sel, document.querySelectorAll(sel).length]; } catch { return [sel, -1]; } })),
      expect: (() => { try { return (${app.shotExpect ?? "true"}) ? "PRESENT" : "ABSENT"; } catch (e) { return "ERROR: " + e.message; } })(),
    })`, returnByValue: true,
  }, s);
  console.log(JSON.stringify(JSON.parse(probe.result.value), null, 1));

  const shot = await cdp("Page.captureScreenshot", { format: "png" }, s);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${appId}.png`, Buffer.from(shot.data, "base64"));
  console.log("wrote", `${OUT}/${appId}.png`);
} finally {
  try { ws?.close(); } catch { /* closing */ }
  if (sid2) await browser.sessions.releaseAndWait(sid2).catch(() => {});
  await c.kill(sb.sandboxId);
  console.log("killed");
}
