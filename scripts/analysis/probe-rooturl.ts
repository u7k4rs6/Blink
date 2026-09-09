/** What ROOT_URL actually is on a live fork, and what URLs Gitea emits from it. */
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
    if (await sh(`curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3000/ || echo x`, 8000) === "200") break;
    await new Promise((z) => setTimeout(z, 500));
  }
  console.log("=== app.ini, the [server] block ===");
  console.log(await sh(`sed -n '/^\\[server\\]/,/^\\[/p' /var/lib/gitea/custom/conf/app.ini 2>/dev/null || find / -name app.ini 2>/dev/null | head -3`));
  console.log("\n=== every ROOT_URL / STATIC_ / DOMAIN line anywhere in app.ini ===");
  console.log(await sh(`grep -rn 'ROOT_URL\\|STATIC_\\|^DOMAIN\\|^PROTOCOL' $(find / -name app.ini 2>/dev/null | head -1) 2>/dev/null`));
  console.log("\n=== does anything patch ROOT_URL at boot? ===");
  console.log(await sh(`grep -rln 'ROOT_URL' /usr/local/bin/ /etc/ 2>/dev/null | head -5; echo '---'; cat /usr/local/bin/blink-boot 2>/dev/null | head -30`));

  const pv = await sb.previewUrl(3000);
  const token = new URL(pv.url).searchParams.get("pt_token")!;
  const at = (p: string): string => { const u = new URL(p, pv.url); u.searchParams.set("pt_token", token); return u.toString(); };

  console.log("\n=== asset URLs Gitea emits, at the DEEP landing path ===");
  const deep = await (await fetch(at("/blink/welcome/issues"))).text();
  const refs = [...deep.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]!)
    .filter((u) => !u.startsWith("http") && !u.startsWith("#"));
  console.log("  first 8:", [...new Set(refs)].slice(0, 8).join("\n            "));
  console.log("  any RELATIVE (no leading slash):",
    [...new Set(refs.filter((u) => !u.startsWith("/")))].slice(0, 8).join(", ") || "none");

  console.log("\n=== the manifest, whose icon paths resolve against ITS OWN url ===");
  const man = await fetch(at("/assets/site-manifest.json"));
  console.log("  status", man.status, "|", (await man.text()).slice(0, 220));

  console.log("\n=== the exact failing path from the report ===");
  for (const p of ["/blink/welcome/arm/assets/img/favicon.png", "/assets/img/favicon.png"]) {
    const r = await fetch(at(p), { redirect: "manual" });
    console.log(`  ${p.padEnd(46)} -> ${r.status} ${r.headers.get("x-frame-options") ? "(from Gitea)" : "(from the edge)"}`);
  }
} finally { await c.kill(sb.sandboxId); console.log("\nkilled"); }
