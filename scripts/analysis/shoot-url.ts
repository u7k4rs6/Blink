/** Screenshot an arbitrary public URL through the Solari browser. No local Chrome. */
import { Solari } from "@solarisdk/browser";
import { writeFileSync } from "node:fs";

const url = process.argv[2]!;
const out = process.argv[3]!;
const scrollY = Number(process.argv[4] ?? 0);
const b = new Solari({ apiKey: process.env.SOLARI_API_KEY! });
const s = await b.sessions.create({});
const ws = new WebSocket(s.cdpEndpoint);
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error("cdp timeout")), 20000);
  ws.addEventListener("open", () => { clearTimeout(t); res(); });
  ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("cdp error")); });
});
let id = 0;
const pend = new Map<number, (v: any) => void>();
ws.addEventListener("message", (e: MessageEvent) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pend.has(m.id)) { pend.get(m.id)!(m); pend.delete(m.id); }
});
const cdp = (method: string, params: unknown = {}, sid?: string) => new Promise<any>((res, rej) => {
  const n = ++id;
  pend.set(n, (m: any) => (m.error ? rej(new Error(method + " " + JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id: n, method, params, sessionId: sid }));
  setTimeout(() => rej(new Error(method + " timed out")), 45000);
});
try {
  const t = await cdp("Target.createTarget", { url: "about:blank" });
  const a = await cdp("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const sid = a.sessionId;
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  await cdp("Page.enable", {}, sid);
  await cdp("Runtime.enable", {}, sid);
  await cdp("Page.navigate", { url }, sid);
  await new Promise((r) => setTimeout(r, 7000));
  if (scrollY) {
    await cdp("Runtime.evaluate", { expression: `window.scrollTo(0, ${scrollY})` }, sid);
    await new Promise((r) => setTimeout(r, 2500));
  }
  const shot = await cdp("Page.captureScreenshot", { format: "png" }, sid);
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("wrote", out);
} finally {
  try { ws.close(); } catch { /* closing */ }
  await b.sessions.releaseAndWait(s.id).catch(() => {});
}
