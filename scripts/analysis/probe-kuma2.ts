import { SandboxClient } from "@solarisdk/sandbox";
import { readFileSync } from "node:fs";
const snap = JSON.parse(readFileSync("scripts/gates/snapshots.json", "utf8")).uptimekuma;
const c = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: "https://api.getsolari.com" });
const sb = await c.create({ fromSnapshot: snap, cpu: 1, memMb: 2048, timeoutMs: 420000, lifecycle: { onTimeout: "kill" } });
const sh = async (cmd: string, ms = 20000): Promise<string> => {
  const r = await sb.commands.run("sh", { args: ["-c", cmd], timeoutMs: ms });
  return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
};
try {
  for (let i = 0; i < 240; i++) {
    const r = await sh(`curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3001/ || echo x`, 8000);
    if (r && r !== "x" && r !== "000") break;
    await new Promise((z) => setTimeout(z, 500));
  }
  console.log("=== on loopback, per path ===");
  console.log(await sh(`for p in / /dashboard /dashboard/1 /index.html; do printf '%-16s %s\\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' -m 4 http://127.0.0.1:3001$p)"; done`));
  console.log("dist/index.html:", await sh(`test -f /opt/uptime-kuma/dist/index.html && echo present || echo MISSING`));

  const pv = await sb.previewUrl(3001);
  const base = new URL(pv.url);
  const token = base.searchParams.get("pt_token")!;

  console.log("\n=== A: no cookie jar, follow redirects (a probe, a canary, curl) ===");
  const a = await fetch(pv.url);
  console.log("final", a.status, a.url.replace(token, "TOKEN").slice(0, 90));

  console.log("\n=== B: WITH a cookie jar, follow redirects (a browser) ===");
  const jar: string[] = [];
  let url = pv.url, status = 0, hops = 0, finalUrl = url;
  while (hops++ < 5) {
    const r: Response = await fetch(url, { redirect: "manual", headers: jar.length ? { cookie: jar.join("; ") } : {} });
    for (const [k, v] of r.headers) if (k.toLowerCase() === "set-cookie") jar.push(v.split(";")[0]!);
    status = r.status; finalUrl = url;
    const loc = r.headers.get("location");
    if (!loc || (r.status !== 301 && r.status !== 302 && r.status !== 307)) break;
    url = new URL(loc, url).toString();
  }
  console.log("final", status, finalUrl.replace(token, "TOKEN").slice(0, 90));
  console.log("cookies collected:", jar.map((c2) => c2.split("=")[0]).join(", ") || "NONE");

  console.log("\n=== C: /dashboard WITH the token carried explicitly ===");
  const d = new URL("/dashboard", base); d.searchParams.set("pt_token", token);
  const cRes = await fetch(d.toString(), { redirect: "manual" });
  console.log("status", cRes.status, "| content-type", cRes.headers.get("content-type"));
} finally { await c.kill(sb.sandboxId); console.log("\nkilled"); }
