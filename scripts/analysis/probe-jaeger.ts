import { SandboxClient } from "@solarisdk/sandbox";
import { readFileSync } from "node:fs";
const snap = JSON.parse(readFileSync("scripts/gates/snapshots.json","utf8")).jaeger;
const c = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: "https://api.getsolari.com" });
const sb = await c.create({ fromSnapshot: snap, cpu: 1, memMb: 2048, timeoutMs: 240000, lifecycle: { onTimeout: "kill" } });
try {
  for (let i = 0; i < 60; i++) {
    const r = await sb.commands.run("sh", { args: ["-c", "curl -sf -m 3 -o /dev/null http://127.0.0.1:16686/ && echo READY || echo WAIT"], timeoutMs: 8000 });
    if ((r.stdout ?? "").includes("READY")) break;
    await new Promise(r2 => setTimeout(r2, 500));
  }
  const q = async (label: string, url: string) => {
    const r = await sb.commands.run("sh", { args: ["-c", `curl -sf "${url}" | grep -o '"traceID"' | wc -l`], timeoutMs: 20000 });
    console.log(label, "=", (r.stdout ?? "").trim(), "traces");
  };
  await q("before postFork       ", "http://127.0.0.1:16686/api/traces?service=frontend&limit=20");
  const { APPS } = await import("../gates/lib/apps.ts");
  await sb.commands.run("sh", { args: ["-c", APPS.jaeger!.postFork!], timeoutMs: 30000 });
  await q("after postFork        ", "http://127.0.0.1:16686/api/traces?service=frontend&limit=20");
  const now = Date.now() * 1000;
  const weekAgo = now - 7 * 24 * 3600 * 1e6;
  await q("explicit 7-day window ", `http://127.0.0.1:16686/api/traces?service=frontend&limit=20&start=${weekAgo}&end=${now}`);
  const svc = await sb.commands.run("sh", { args: ["-c", "curl -sf http://127.0.0.1:16686/api/services"], timeoutMs: 15000 });
  console.log("services              =", (svc.stdout ?? "").trim().slice(0, 120));
} finally { await c.kill(sb.sandboxId); console.log("killed"); }
