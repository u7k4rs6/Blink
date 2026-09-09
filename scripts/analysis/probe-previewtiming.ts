/** Does previewUrl resolved BEFORE the app listens differ from one resolved after? */
import { SandboxClient } from "@solarisdk/sandbox";
import { readFileSync } from "node:fs";
const snap = JSON.parse(readFileSync("scripts/gates/snapshots.json", "utf8")).uptimekuma;
const c = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: "https://api.getsolari.com" });
const sb = await c.create({ fromSnapshot: snap, cpu: 1, memMb: 2048, timeoutMs: 420000, lifecycle: { onTimeout: "kill" } });
const sh = async (cmd: string, ms = 15000): Promise<string> => {
  const r = await sb.commands.run("sh", { args: ["-c", cmd], timeoutMs: ms });
  return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
};
const probe = async (label: string, base: string): Promise<void> => {
  const b = new URL(base);
  const tok = b.searchParams.get("pt_token");
  const d = new URL("/dashboard", b);
  if (tok) d.searchParams.set("pt_token", tok);
  const jar: string[] = [];
  const r1 = await fetch(base, { redirect: "manual" });
  for (const [k, v] of r1.headers) if (k.toLowerCase() === "set-cookie") jar.push(v.split(";")[0]!);
  const r2 = await fetch(d.toString(), { redirect: "manual", headers: jar.length ? { cookie: jar.join("; ") } : {} });
  console.log(`  ${label.padEnd(34)} root=${r1.status}  /dashboard=${r2.status}  host=${b.hostname.slice(0, 24)}`);
};
try {
  // EXACTLY the launch path: previewUrl first, before anything is listening.
  const t0 = Date.now();
  const early = await sb.previewUrl(3001);
  console.log(`previewUrl called ${Date.now() - t0}ms after create, before any health check`);
  const listening0 = await sh(`curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3001/ || echo DOWN`);
  console.log(`  app on loopback at that moment: ${listening0}`);

  console.log("\nprobing the EARLY url immediately:");
  await probe("early url, app not yet up", early.url);

  let waited = 0;
  for (let i = 0; i < 300; i++) {
    const r = await sh(`curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3001/ || echo x`, 8000);
    if (r === "200" || r === "302") { waited = i * 500; break; }
    await new Promise((z) => setTimeout(z, 500));
  }
  console.log(`\napp became healthy on loopback after ~${waited}ms`);

  const late = await sb.previewUrl(3001);
  console.log(`same url? ${late.url === early.url}`);
  console.log("\nprobing both, now that the app IS up:");
  await probe("early url, re-probed", early.url);
  await probe("late url", late.url);
} finally { await c.kill(sb.sandboxId); console.log("\nkilled"); }
