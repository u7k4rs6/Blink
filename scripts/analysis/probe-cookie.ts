/** Exactly what the preview domain sets, and whether assets need it. */
import { SandboxClient } from "@solarisdk/sandbox";
import { readFileSync } from "node:fs";

const snap = JSON.parse(readFileSync("scripts/gates/snapshots.json", "utf8")).gitea;
const c = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: "https://api.getsolari.com" });
const sb = await c.create({ fromSnapshot: snap, cpu: 1, memMb: 2048, timeoutMs: 420000, lifecycle: { onTimeout: "kill" } });
const sh = async (cmd: string, ms = 20000): Promise<string> => {
  const r = await sb.commands.run("sh", { args: ["-c", cmd], timeoutMs: ms });
  return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
};
try {
  for (let i = 0; i < 300; i++) {
    const r = await sh(`curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3000/ || echo x`, 8000);
    if (r === "200") break;
    await new Promise((z) => setTimeout(z, 500));
  }
  const pv = await sb.previewUrl(3000);
  const base = new URL(pv.url);
  const token = base.searchParams.get("pt_token")!;
  const landing = new URL("/blink/welcome/issues", base);
  landing.searchParams.set("pt_token", token);

  console.log("=== Set-Cookie on the landing request, attribute by attribute ===");
  const res = await fetch(landing.toString(), { redirect: "manual" });
  const jar: string[] = [];
  for (const [k, v] of res.headers) {
    if (k.toLowerCase() === "set-cookie") {
      console.log("  " + v.replace(/=([^;]{12})[^;]*/, "=$1..."));
      jar.push(v.split(";")[0]!);
    }
  }
  console.log("  landing status", res.status);
  const html = await res.text();
  const asset = /(?:href|src)="(\/assets\/[^"]+)"/.exec(html)?.[1]
    ?? /(?:href|src)="(\/[^"]*\.(?:css|js)[^"]*)"/.exec(html)?.[1];
  console.log("\n=== an asset the page references ===\n  " + asset);

  if (asset) {
    const abs = new URL(asset, base).toString();
    const withTok = new URL(asset, base); withTok.searchParams.set("pt_token", token);
    for (const [name, url, headers] of [
      ["no cookie, no token   ", abs, {}],
      ["WITH the jar's cookies", abs, { cookie: jar.join("; ") }],
      ["no cookie, WITH token ", withTok.toString(), {}],
    ] as Array<[string, string, Record<string, string>]>) {
      const r = await fetch(url, { headers, redirect: "manual" });
      console.log(`  ${name} -> ${r.status} ${r.headers.get("content-type") ?? ""}`);
    }
    console.log("\n=== a STALE __pt_preview from a different instance ===");
    const stale = jar.find((x) => x.startsWith("__pt_preview"));
    console.log("  (same-instance cookie sent above; testing cross-instance below)");
    console.log("  cookie names in jar:", jar.map((x) => x.split("=")[0]).join(", "));
    void stale;
  }
} finally { await c.kill(sb.sandboxId); console.log("\nkilled"); }
