/**
 * Snapshot recipe: Jaeger 2.20.0 all-in-one, plus HotROD for traffic.
 *
 * Second app, built after Gitea so that G1 has a second data point on
 * fork-to-healthy (01-prd.md section 9). Deliberately the easiest remaining
 * recipe: one tarball, two static binaries, no database, no admin user, no
 * config file that the app rewrites at runtime.
 *
 * Reuses thrice's proven recipe. Two facts carried over from its verification
 * (00-verification.md V46) that are easy to get wrong:
 *
 *   - The tarball ships exactly two binaries, `jaeger` and `example-hotrod`.
 *   - The published `sha256sum.txt` checksums the EXTRACTED BINARIES, not the
 *     tarball. So verification is extract-then-verify, which is the opposite
 *     order from Gitea's.
 *
 * Same four rules as the Gitea recipe: every command through `sh -c`, assert on
 * postconditions rather than exit codes, health over loopback, and nothing baked
 * in that must differ per instance.
 */

import { fileURLToPath } from "node:url";
import { BudgetGuard } from "../../src/guard/guard.ts";
import { SandboxLedger } from "../../src/guard/ledger.ts";
import { PLANS, SIZE_SMALL, type Plan } from "../../src/guard/rates.ts";
import { CAPS_GATES, createCountingFetch } from "../../src/solari/fetch.ts";
import { SolariAdapter } from "../../src/solari/adapter.ts";
import { REGISTRY_PATH, loadRegistry } from "../gates/lib/apps.ts";
import { waitHealthyInGuest } from "../gates/lib/health.ts";
import { prerequisiteStep, proveSelfDestructStep } from "./lib/template.ts";
import { safeErr, safeOut, safeWriteJsonSync } from "../../src/safe-io.ts";

export const JAEGER_VERSION = "2.20.0";
export const JAEGER_PORT = 16686;
export const JAEGER_HEALTH = "/";
const BASE = `https://github.com/jaegertracing/jaeger/releases/download/v${JAEGER_VERSION}`;
const TARBALL = `jaeger-${JAEGER_VERSION}-linux-amd64.tar.gz`;
const DIR = `jaeger-${JAEGER_VERSION}-linux-amd64`;
/** HotROD's own UI port, used only to drive traffic during the build. */
const HOTROD_PORT = 8080;

type Step = { name: string; cmd: string; expect: string };

export function jaegerSteps(): Step[] {
  return [
    prerequisiteStep(['curl', 'tar', 'sha256sum'].map(String)),
    {
      name: "install prerequisites",
      cmd:
        "( command -v curl >/dev/null || (apt-get update -qq && apt-get install -y -qq curl) ) " +
        "&& curl --version | head -1 && echo PREREQS_OK",
      expect: "PREREQS_OK",
    },
    {
      name: "download and extract the release tarball",
      cmd:
        `mkdir -p /opt/jaeger && cd /opt/jaeger ` +
        `&& curl -fsSL -o ${TARBALL} ${BASE}/${TARBALL} ` +
        `&& tar xzf ${TARBALL} ` +
        `&& test -f ${DIR}/jaeger && test -f ${DIR}/example-hotrod ` +
        `&& echo EXTRACT_OK`,
      expect: "EXTRACT_OK",
    },
    {
      name: "verify the published checksums of the extracted binaries",
      // Extract THEN verify, because the published sums cover the binaries and
      // not the archive. Getting this backwards silently verifies nothing.
      cmd:
        `cd /opt/jaeger ` +
        `&& curl -fsSL -o sums.txt ${BASE}/jaeger-${JAEGER_VERSION}-linux-amd64.sha256sum.txt ` +
        `&& sha256sum -c sums.txt ` +
        `&& echo CHECKSUM_OK`,
      expect: "CHECKSUM_OK",
    },
    {
      name: "confirm the binary runs and is the expected version",
      cmd: `/opt/jaeger/${DIR}/jaeger version 2>&1 | head -3 | grep -q "${JAEGER_VERSION}" && echo VERSION_OK`,
      expect: "VERSION_OK",
    },
    {
      name: "start jaeger all-in-one with in-memory storage",
      cmd:
        `mkdir -p /var/log/blink ` +
        `&& ( setsid sh -c 'echo $$ > /var/log/blink/jaeger.pid; exec /opt/jaeger/${DIR}/jaeger' ` +
        `>/var/log/blink/jaeger.log 2>&1 & ) ; ` +
        `sleep 1 ; test -s /var/log/blink/jaeger.pid && echo STARTED`,
      expect: "STARTED",
    },
    { name: "wait for the jaeger query UI on loopback", cmd: "__HEALTH_POLL__", expect: "HEALTHY" },
    {
      name: "start hotrod and drive traffic so traces exist",
      // Traces have to exist BEFORE the snapshot, or every forked instance opens
      // on an empty trace list, which is the least interesting possible first
      // screen for the one app whose whole point is looking at traces.
      cmd:
        `( setsid env OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 ` +
        `/opt/jaeger/${DIR}/example-hotrod all >/var/log/blink/hotrod.log 2>&1 & ) ; ` +
        `sleep 5 ; ` +
        `for i in 1 2 3 4 5 6 7 8; do ` +
        `curl -sf -o /dev/null "http://127.0.0.1:${HOTROD_PORT}/dispatch?customer=$((123 + i))" || true; ` +
        `done ; ` +
        `sleep 3 ; echo DROVE_TRAFFIC`,
      expect: "DROVE_TRAFFIC",
    },
    {
      name: "confirm traces are queryable",
      // The postcondition asserts the artefact: services registered AND a trace
      // returned for one of them. A running UI with no traces is not seeded.
      cmd:
        `SVCS=$(curl -sf "http://127.0.0.1:${JAEGER_PORT}/api/services"); ` +
        `echo "$SVCS" | grep -q frontend || { echo NO_FRONTEND_SERVICE; exit 1; }; ` +
        `TR=$(curl -sf "http://127.0.0.1:${JAEGER_PORT}/api/traces?service=frontend&limit=5"); ` +
        `N=$(echo "$TR" | grep -o '"traceID"' | wc -l); ` +
        `echo "traces=$N"; test "$N" -ge 1 && echo TRACES_OK`,
      expect: "TRACES_OK",
    },
    {
      name: "install the per-instance boot script",
      // Jaeger's UI uses relative paths, so unlike Gitea there is no ROOT_URL to
      // patch (02-architecture.md section 6). The boot script therefore does one
      // job: arm layer 2 of the expiry design, the guest-side self-destruct,
      // which G3 confirmed is the only layer indifferent to visitor activity.
      cmd:
        "cat > /usr/local/bin/blink-boot <<'SH'\n" +
        "#!/bin/sh\n" +
        "# Usage: blink-boot <root_url_ignored> <lifetime_seconds>\n" +
        "LIFETIME=\"${2:-600}\"\n" +
        // kill(1), not pkill: the base image has no procps.
        "setsid sh -c \"sleep ${LIFETIME}; kill -9 \\$(cat /var/log/blink/jaeger.pid 2>/dev/null) 2>/dev/null; " +
        "echo blink-selfdestruct-fired >> /var/log/blink/jaeger.log\" >/dev/null 2>&1 &\n" +
        "echo BOOT_OK\n" +
        "SH\n" +
        "chmod +x /usr/local/bin/blink-boot && test -x /usr/local/bin/blink-boot && echo BOOTSCRIPT_OK",
      expect: "BOOTSCRIPT_OK",
    },
    proveSelfDestructStep("/var/log/blink/jaeger.pid"),
    {
      name: "verify the seeded state one last time before snapshotting",
      cmd:
        `curl -sf -o /dev/null http://127.0.0.1:${JAEGER_PORT}${JAEGER_HEALTH} ` +
        `&& curl -sf "http://127.0.0.1:${JAEGER_PORT}/api/services" | grep -q frontend ` +
        `&& echo FINAL_OK`,
      expect: "FINAL_OK",
    },
  ];
}

async function build(dryRun: boolean): Promise<number> {
  const steps = jaegerSteps();
  if (dryRun) {
    safeOut(`\nJaeger ${JAEGER_VERSION} snapshot recipe, ${steps.length} steps. Nothing has run.\n\n`);
    steps.forEach((st, i) => {
      safeOut(`${String(i + 1).padStart(2)}. ${st.name}\n    postcondition: ${JSON.stringify(st.expect)}\n`);
    });
    return 0;
  }

  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey || apiKey.includes("replace_me")) { safeErr("SOLARI_API_KEY is not set.\n"); return 2; }
  const plan: Plan = PLANS[(process.env.BLINK_PLAN ?? "starter") as "starter" | "free"]!;
  const guard = new BudgetGuard(plan, 0.05);
  const ledger = new SandboxLedger();
  ledger.install(apiKey);
  const adapter = new SolariAdapter({ counting: createCountingFetch({ caps: CAPS_GATES }), guard, ledger });

  safeOut(`\nBuilding Jaeger ${JAEGER_VERSION} snapshot. ${steps.length} steps.\n`);
  const bornAt = performance.now();
  let sandboxId: string | null = null;
  let snapshotId: string | null = null;

  try {
    const sb = await adapter.createSandbox(
      apiKey, "snapshot:jaeger",
      { template: "base", cpu: SIZE_SMALL.cpu, memMb: SIZE_SMALL.memMb, timeoutMs: 900_000,
        lifecycle: { onTimeout: "kill" }, metadata: { blink_build: "jaeger", blink_version: JAEGER_VERSION } },
      0.02,
    );
    sandboxId = sb.value.sandboxId;
    const sh = (cmd: string, o?: { timeoutMs?: number }) => adapter.exec(apiKey, sb.value, "snapshot:jaeger", cmd, o);

    for (const [i, st] of steps.entries()) {
      const t0 = performance.now();
      let out: string;
      if (st.cmd === "__HEALTH_POLL__") {
        const h = await waitHealthyInGuest(sh, JAEGER_PORT, JAEGER_HEALTH, { timeoutMs: 120_000 });
        out = h.ok ? "HEALTHY" : `not healthy: ${h.error ?? "unknown"}`;
        safeOut(`      polled ${h.execCalls} times over ${h.ms} ms\n`);
        if (!h.ok) {
          const log = await sh("tail -20 /var/log/blink/jaeger.log 2>&1 || echo no-log");
          safeErr(`      jaeger.log:\n${log.value.stdout.trim().slice(0, 800)}\n`);
        }
      } else {
        const r = await sh(st.cmd, { timeoutMs: 90_000 });
        out = `${r.value.stdout}\n${r.value.stderr}`;
      }
      const ms = Math.round(performance.now() - t0);
      const ok = out.includes(st.expect);
      safeOut(`  ${String(i + 1).padStart(2)}. ${ok ? "ok  " : "FAIL"} ${st.name} (${ms} ms)\n`);
      if (!ok) {
        safeErr(`\n     expected ${JSON.stringify(st.expect)}, got:\n     ${out.trim().slice(0, 900)}\n`);
        throw new Error(`step ${i + 1} (${st.name}) postcondition not met`);
      }
      const interesting = out.trim().split("\n").filter((l) => l && !l.includes(st.expect) && l !== "WAITING");
      if (interesting.length) safeOut(`      ${interesting.slice(-2).join(" | ").slice(0, 150)}\n`);
    }

    const snap = await adapter.snapshot(apiKey, sb.value, "snapshot:jaeger",
      `jaeger-${JAEGER_VERSION}-${new Date().toISOString().slice(0, 10)}`);
    snapshotId = snap.value;
    safeOut(`\n  snapshot ${snapshotId} created in ${snap.ms} ms\n`);
    const reg = loadRegistry();
    reg.jaeger = snapshotId;
    safeWriteJsonSync(REGISTRY_PATH, reg);
    safeOut(`  recorded in ${REGISTRY_PATH}\n`);
  } finally {
    if (sandboxId) {
      await adapter.killQuiet(apiKey, sandboxId, "snapshot:jaeger");
      guard.addSandboxSeconds((performance.now() - bornAt) / 1000, SIZE_SMALL, true, "jaeger snapshot build");
    }
    const s = guard.summary();
    safeOut(`\n  cost: ${s.sandboxSeconds} sandbox-seconds, $${s.usd.toFixed(5)} at ${plan.name} rates (100% measured)\n`);
  }
  return snapshotId ? 0 : 1;
}

/**
 * Only build when this file IS the program.
 *
 * It used to run on import, which meant a unit test that imported a recipe to
 * check one exported constant would try to create a sandbox. A module that
 * spends money as a side effect of being read is a module that cannot be tested.
 */
const isMainModule = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  process.exit(await build(process.argv.includes("--dry-run")));
}
