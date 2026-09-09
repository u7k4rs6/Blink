/**
 * What is on screen when a visitor's first request lands, for every app.
 *
 * Forks each snapshot, runs the app's postFork, resolves previewUrl, and then
 * asks the same question the new landing check asks, following redirects the
 * way a browser does. Reports the final status, the path it ended on, and the
 * first words of the page, so "a 404, a login wall or an empty state" can be
 * told apart from the seeded app.
 */
import { SandboxClient } from "@solarisdk/sandbox";
import { readFileSync } from "node:fs";
import { APPS } from "../gates/lib/apps.ts";
import { firstScreen } from "../gates/lib/liveness.ts";
import { Solari } from "@solarisdk/browser";
import { writeFileSync, mkdirSync } from "node:fs";

const browser = new Solari({ apiKey: process.env.SOLARI_API_KEY! });

/** Open the previewUrl in a real browser and report what a visitor SEES. */
async function renderFirstScreen(url: string, id: string): Promise<{
  path: string; text: string; assetsOk: number; assetsFailed: number; failedSample: string[];
}> {
  const session = await browser.sessions.create({});
  const ws = new WebSocket(session.cdpEndpoint);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("cdp timeout")), 20000);
    ws.addEventListener("open", () => { clearTimeout(t); res(); });
    ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("cdp error")); });
  });
  let n = 0;
  const pend = new Map<number, (v: unknown) => void>();
  ws.addEventListener("message", (e: MessageEvent) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pend.has(m.id)) { pend.get(m.id)!(m); pend.delete(m.id); }
  });
  const cdp = (method: string, params: unknown = {}, sid?: string): Promise<any> =>
    new Promise((res, rej) => {
      const k = ++n;
      pend.set(k, (m: any) => (m.error ? rej(new Error(method)) : res(m.result)));
      ws.send(JSON.stringify({ id: k, method, params, sessionId: sid }));
      setTimeout(() => rej(new Error(method + " timeout")), 40000);
    });
  try {
    const t = await cdp("Target.createTarget", { url: "about:blank" });
    const a = await cdp("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    const sid = a.sessionId;
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sid);
    await cdp("Page.enable", {}, sid);
    await cdp("Runtime.enable", {}, sid);
    /*
     * Watch the SUBRESOURCES, not just the document.
     *
     * The first screen test asserted text in the HTML, and Gitea's HTML says
     * "Issues" and lists the seeded titles whether or not a single stylesheet
     * loaded. A visitor got the seeded data on a completely unstyled page with
     * every asset 401ing, and the test passed, because it was asking about the
     * document and the document was fine. An arrival with no CSS matches no
     * card, so failed assets are now part of the bar.
     */
    await cdp("Network.enable", {}, sid);
    const assetOk: string[] = [];
    const assetBad: string[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      const m = JSON.parse(String(e.data));
      if (m.method !== "Network.responseReceived") return;
      const r = m.params?.response;
      if (!r || m.params.type === "Document") return;
      const path = (() => { try { return new URL(r.url).pathname; } catch { return r.url; } })();
      /*
       * Assets, not API calls.
       *
       * Metabase asks /api/user/current on load and a 401 there is the correct
       * answer for someone not signed in: the app is working, not broken. Only
       * a stylesheet, script, image, font or manifest failing means the page
       * cannot render, which is what this bar is for.
       */
      const kind = String(m.params.type ?? "");
      const isAsset = ["Stylesheet", "Script", "Image", "Font", "Media", "Manifest", "Other"].includes(kind);
      if (!isAsset) return;
      if (r.status >= 400) assetBad.push(`${r.status} ${kind} ${path.slice(0, 38)}`);
      else assetOk.push(path);
    });
    await cdp("Page.navigate", { url }, sid);
    await new Promise((r) => setTimeout(r, 9000));
    const got = await cdp("Runtime.evaluate", {
      expression: `JSON.stringify({ p: location.pathname, t: document.body.innerText.replace(/\\s+/g," ").trim().slice(0,150) })`,
      returnByValue: true,
    }, sid);
    const shot = await cdp("Page.captureScreenshot", { format: "png" }, sid);
    mkdirSync("/tmp/first", { recursive: true });
    writeFileSync(`/tmp/first/${id}.png`, Buffer.from(shot.data, "base64"));
    const v = JSON.parse(got.result.value);
    return {
      path: v.p, text: v.t,
      assetsOk: assetOk.length, assetsFailed: assetBad.length,
      failedSample: [...new Set(assetBad)].slice(0, 4),
    };
  } finally {
    try { ws.close(); } catch { /* closing */ }
    await browser.sessions.releaseAndWait(session.id).catch(() => {});
  }
}

const reg = JSON.parse(readFileSync("scripts/gates/snapshots.json", "utf8"));
const c = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: "https://api.getsolari.com" });
const only = process.argv.slice(2);

for (const [id, app] of Object.entries(APPS)) {
  if (only.length > 0 && !only.includes(id)) continue;
  const snap = reg[id];
  if (!snap) { console.log(`${id}: no snapshot`); continue; }
  const sb = await c.create({ fromSnapshot: snap, cpu: app.size.cpu, memMb: app.size.memMb,
    timeoutMs: 420000, lifecycle: { onTimeout: "kill" } });
  try {
    const sh = async (cmd: string, ms = 30000): Promise<string> => {
      const r = await sb.commands.run("sh", { args: ["-c", cmd], timeoutMs: ms });
      return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
    };
    let ready = false;
    for (let i = 0; i < 300; i++) {
      const r = await sh(`curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:${app.port}${app.healthPath} || echo x`, 8000);
      if (r && r !== "x" && r !== "000") { ready = true; break; }
      await new Promise((z) => setTimeout(z, 500));
    }
    /*
     * The boot script, exactly as the launch path runs it.
     *
     * Without this the bar forks a snapshot whose ROOT_URL is still the
     * placeholder, and measures asset loading on an instance no visitor gets.
     * That is how "assets OK: 9 loaded" was reported for a page that arrived
     * unstyled for a real person.
     */
    const pvEarly = await sb.previewUrl(app.port);
    const rootUrl = `${new URL(pvEarly.url).origin}/`;
    console.log(`${" ".repeat(11)} blink-boot ${rootUrl}`);
    await sh(`/usr/local/bin/blink-boot ${JSON.stringify(rootUrl)} 660 || true`, 30000).catch(() => "");
    for (let i = 0; i < 200; i++) {
      const r = await sh(`curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:${app.port}${app.healthPath} || echo x`, 8000);
      if (r === "200" || r === "302") break;
      await new Promise((z) => setTimeout(z, 500));
    }

    let postForkOut = "";
    if (app.postFork) {
      postForkOut = await sh(app.postFork, 90000).catch((e) => `POSTFORK_THREW ${String(e).slice(0, 80)}`);
      if (process.env.SHOW_POSTFORK === "1") {
        console.log(`${" ".repeat(11)} postFork: ${postForkOut.replace(/\s+/g, " ").slice(0, 200)}`);
      }
    }
    // The path the HANDOVER uses, including a runtime override, so this test
    // measures what a visitor gets rather than what the port serves at "/".
    const named = /BLINK_LANDING=(\S+)/.exec(postForkOut)?.[1];
    const landing = (named !== undefined && named.startsWith("/")) ? named : app.landingPath;
    const pv = pvEarly;
    const handover = landing === undefined ? pv.url : (() => {
      const b = new URL(pv.url);
      const tok = b.searchParams.get("pt_token");
      const out = new URL(landing, b);
      if (tok !== null) out.searchParams.set("pt_token", tok);
      return out.toString();
    })();
    const s = await firstScreen(handover, 20000);
    const text = s.body.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, 110);
    console.log(
      `${id.padEnd(11)} loopback=${ready ? "up" : "DOWN"}  first=${String(s.status).padEnd(3)}` +
      ` hops=${s.hops} path=${new URL(s.url).pathname.padEnd(12)} | ${text}`,
    );

    // HTTP 200 does not say whether the RENDERED screen is the app or a wall.
    // That is the whole question, so render it.
    const rendered = await renderFirstScreen(handover, id);
    const verdict = rendered.assetsFailed === 0 ? "assets OK" : `ASSETS FAILED (${rendered.assetsFailed})`;
    console.log(`${" ".repeat(11)} RENDERED path=${rendered.path.padEnd(12)} | ${rendered.text.slice(0, 90)}`);
    console.log(`${" ".repeat(11)} ${verdict}: ${rendered.assetsOk} loaded` +
      (rendered.failedSample.length > 0 ? ` | ${rendered.failedSample.join(" ")}` : ""));
  } finally {
    await c.kill(sb.sandboxId);
  }
}
