/** The launch path for Uptime Kuma, step for step, with timings. */
import { SandboxClient } from "@solarisdk/sandbox";
import { readFileSync } from "node:fs";
import { APPS } from "../gates/lib/apps.ts";
const app = APPS.uptimekuma!;
const snap = JSON.parse(readFileSync("scripts/gates/snapshots.json", "utf8")).uptimekuma;
const c = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: "https://api.getsolari.com" });
const t0 = Date.now();
const el = (): string => `${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s`;
const sb = await c.create({ fromSnapshot: snap, cpu: app.size.cpu, memMb: app.size.memMb,
  timeoutMs: 420000, lifecycle: { onTimeout: "kill" } });
console.log(`${el()} created`);
const sh = async (cmd: string, ms = 20000): Promise<string> => {
  const r = await sb.commands.run("sh", { args: ["-c", cmd], timeoutMs: ms });
  return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
};
try {
  // 1. previewUrl FIRST, exactly as the runner does it now.
  const pv = await sb.previewUrl(app.port);
  console.log(`${el()} previewUrl resolved`);

  // 2. blink-boot with the ROOT_URL.
  const rootUrl = `${new URL(pv.url).origin}/`;
  console.log(`${el()} blink-boot -> ${await sh(`/usr/local/bin/blink-boot ${JSON.stringify(rootUrl)} 660 || true`, 25000)}`);

  // 3. health.
  for (let i = 0; i < 300; i++) {
    const r = await sh(`curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:${app.port}${app.healthPath} || echo x`, 8000);
    if (r === "200" || r === "302") break;
    await new Promise((z) => setTimeout(z, 500));
  }
  console.log(`${el()} healthy on loopback`);

  // 4. postFork, with the RUNNER's 45s budget, not the bar's 90s.
  const pfStart = Date.now();
  let pf = "";
  try {
    pf = await sh(app.postFork!, 45000);
    console.log(`${el()} postFork finished in ${((Date.now() - pfStart) / 1000).toFixed(1)}s: ${pf.replace(/\s+/g, " ").slice(0, 90)}`);
  } catch (e) {
    console.log(`${el()} postFork THREW after ${((Date.now() - pfStart) / 1000).toFixed(1)}s: ${String(e).slice(0, 100)}`);
  }

  // 5. is the sandbox and the app still there?
  console.log(`${el()} loopback now: ${await sh(`curl -s -o /dev/null -w '%{http_code}' -m 4 http://127.0.0.1:${app.port}/ || echo DOWN`)}`);
  console.log(`${el()} node still running: ${await sh(`pgrep -f 'server/server.js' >/dev/null && echo yes || echo NO`)}`);

  // 6. the handover url the visitor is given.
  const b = new URL(pv.url);
  const tok = b.searchParams.get("pt_token");
  const h = new URL(app.landingPath!, b);
  if (tok) h.searchParams.set("pt_token", tok);
  const jar: string[] = [];
  const root = await fetch(pv.url, { redirect: "manual" });
  for (const [k, v] of root.headers) if (k.toLowerCase() === "set-cookie") jar.push(v.split(";")[0]!);
  const land = await fetch(h.toString(), { redirect: "manual", headers: jar.length ? { cookie: jar.join("; ") } : {} });
  console.log(`${el()} HANDOVER root=${root.status} landing(/dashboard)=${land.status}` +
    ` server=${land.headers.get("server") ?? "?"}`);
} finally { await c.kill(sb.sandboxId); console.log(`${el()} killed`); }
