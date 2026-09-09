/** What does a visitor's FIRST request to a forked Uptime Kuma actually get. */
import { SandboxClient } from "@solarisdk/sandbox";
import { readFileSync } from "node:fs";

const snap = JSON.parse(readFileSync("scripts/gates/snapshots.json", "utf8")).uptimekuma;
const c = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: "https://api.getsolari.com" });
const sb = await c.create({ fromSnapshot: snap, cpu: 1, memMb: 2048, timeoutMs: 420000, lifecycle: { onTimeout: "kill" } });
const sh = async (cmd: string, timeoutMs = 20000): Promise<string> => {
  const r = await sb.commands.run("sh", { args: ["-c", cmd], timeoutMs });
  return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
};
try {
  for (let i = 0; i < 240; i++) {
    const r = await sh(`curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3001/ || echo x`, 8000);
    if (r && r !== "x" && r !== "000") { console.log("first response code on loopback:", r, "after", i * 0.5, "s"); break; }
    await new Promise((z) => setTimeout(z, 500));
  }
  console.log("\n--- what the root actually returns, on loopback ---");
  console.log(await sh(`curl -s -i -m 5 http://127.0.0.1:3001/ | head -14`));
  console.log("\n--- other paths ---");
  console.log(await sh(`for p in / /dashboard /index.html /assets /socket.io/?EIO=4\\&transport=polling; do printf '%-34s %s\\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' -m 4 http://127.0.0.1:3001$p)"; done`));
  console.log("\n--- is the frontend build on disk ---");
  console.log(await sh(`ls -la /opt/uptime-kuma/dist 2>&1 | head -8; echo "dist entries: $(ls /opt/uptime-kuma/dist 2>/dev/null | wc -l)"`));
  console.log("\n--- process and pidfile ---");
  console.log(await sh(`cat /var/run/uptime-kuma.pid 2>&1; ps -o pid,args -p "$(cat /var/run/uptime-kuma.pid 2>/dev/null)" 2>&1 | tail -2`));
  console.log("\n--- server log tail ---");
  console.log(await sh(`tail -25 /var/log/blink/uptime-kuma.log 2>&1`));
  const pv = await sb.previewUrl(3001);
  console.log("\n--- through previewUrl, exactly what a visitor gets ---");
  const res = await fetch(pv.url, { redirect: "manual" });
  console.log("status", res.status, res.statusText, "| content-type", res.headers.get("content-type"));
  console.log((await res.text()).slice(0, 240).replace(/\s+/g, " "));
} finally {
  await c.kill(sb.sandboxId);
  console.log("\nkilled");
}
