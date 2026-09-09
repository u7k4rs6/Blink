import { SandboxClient } from "@solarisdk/sandbox";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
const snap = JSON.parse(readFileSync("scripts/gates/snapshots.json", "utf8")).gitea;
const c = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY, baseUrl: "https://api.getsolari.com" });
const sb = await c.create({ fromSnapshot: snap, cpu: 1, memMb: 2048, timeoutMs: 900000, lifecycle: { onTimeout: "kill" } });
const sh = async (cmd) => (await sb.commands.run("sh", { args: ["-c", cmd], timeoutMs: 15000 })).stdout ?? "";
try {
  for (let i = 0; i < 300; i++) {
    if ((await sh(`curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3000/ || echo x`)).trim() === "200") break;
    await new Promise(z => setTimeout(z, 500));
  }
  const pv = await sb.previewUrl(3000);
  const u = new URL("/blink/welcome/issues", pv.url);
  u.searchParams.set("pt_token", new URL(pv.url).searchParams.get("pt_token"));
  writeFileSync("/tmp/live-url", u.toString());
  if (existsSync("/tmp/live-stop")) unlinkSync("/tmp/live-stop");
  console.log("READY");
  for (let i = 0; i < 600 && !existsSync("/tmp/live-stop"); i++) await new Promise(z => setTimeout(z, 1000));
} finally { await c.kill(sb.sandboxId); console.log("killed"); }
