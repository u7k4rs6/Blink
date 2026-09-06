/**
 * Snapshot recipe: Metabase, and the answer to Q13.
 *
 * Built FIRST on day 5 because it is the only remaining app that can force a
 * catalog substitution. Q13 asks whether Metabase boots and stays stable in
 * 2 vCPU / 4 GB with its bundled sample database. Vendor guidance supports the
 * size (a 1 core / 1 GB floor, and `-Xmx2g` recommended on a 4 GB machine), but
 * nothing has measured it.
 *
 * So this recipe MEASURES rather than assumes: it records heap and RSS after
 * boot and again after the sample database has been queried, and prints a
 * verdict. If it does not fit, `02-architecture.md` section 5 already records
 * the substitution and the reason goes in beside it.
 *
 * Same two rules as the other recipes, both learned from the gates:
 *   every command goes through `sh -c` (the SDK's commands.run is not a shell)
 *   every seed step asserts its OWN artefact, never a neighbouring count
 */

import { fileURLToPath } from "node:url";
import { BudgetGuard } from "../../src/guard/guard.ts";
import { SandboxLedger } from "../../src/guard/ledger.ts";
import { PLANS, SIZE_LARGE, type Plan } from "../../src/guard/rates.ts";
import { CAPS_GATES, createCountingFetch } from "../../src/solari/fetch.ts";
import { SolariAdapter } from "../../src/solari/adapter.ts";
import { REGISTRY_PATH, loadRegistry } from "../gates/lib/apps.ts";
import { waitHealthyInGuest } from "../gates/lib/health.ts";
import { prerequisiteStep, proveSelfDestructStep } from "./lib/template.ts";
import { safeErr, safeOut, safeWriteJsonSync } from "../../src/safe-io.ts";
import { applyEnv } from "../../src/env.ts";
import { SEEDED } from "../../src/catalog/credentials.ts";

applyEnv();

export const METABASE_VERSION = "v0.63.16";
export const METABASE_PORT = 3000;
export const METABASE_HEALTH = "/api/health";
const JAR_URL = `https://downloads.metabase.com/${METABASE_VERSION}/metabase.jar`;
const ADMIN_EMAIL = "blink@example.invalid";
const ADMIN_FIRST = "Blink";
const ADMIN_LAST = "Demo";

type Step = { name: string; cmd: string; expect: string };

export function metabaseSteps(adminPassword: string): Step[] {
  return [
    prerequisiteStep(['curl', 'awk'].map(String)),
    {
      name: "install Eclipse Temurin JRE 25",
      // Metabase requires Java 25: "Earlier Java versions aren't supported."
      // Debian 12's default-jre-headless is Java 17, and the first build attempt
      // died on a Clojure bootstrap stack trace that looked like anything but a
      // version problem.
      //
      // Not from apt: Debian has no Java 25 package. Adoptium's API redirects to
      // the current GA tarball, so `-L` is required.
      cmd:
        "mkdir -p /opt/java && curl -fsSL -o /tmp/jre.tar.gz " +
        "'https://api.adoptium.net/v3/binary/latest/25/ga/linux/x64/jre/hotspot/normal/eclipse' " +
        "&& tar xzf /tmp/jre.tar.gz -C /opt/java --strip-components=1 " +
        "&& /opt/java/bin/java -version 2>&1 | head -1 " +
        // THE ARTEFACT, not a neighbouring signal. The previous version asserted
        // that `java -version` exited zero, which Java 17 does perfectly well.
        "&& /opt/java/bin/java -version 2>&1 | grep -qE '\"25[.\"]' " +
        "&& echo JAVA25_OK",
      expect: "JAVA25_OK",
    },
    {
      name: "download the jar from downloads.metabase.com",
      // NOT from GitHub: release v0.63.16 ships zero assets (V49).
      cmd:
        `mkdir -p /opt/metabase && curl -fsSL -o /opt/metabase/metabase.jar ${JAR_URL} ` +
        `&& test -s /opt/metabase/metabase.jar ` +
        `&& stat -c %s /opt/metabase/metabase.jar && echo JAR_OK`,
      expect: "JAR_OK",
    },
    {
      name: "record the memory ceiling we are testing against",
      cmd:
        // /proc/meminfo, not `free`: the base image has no procps, and the
        // first version silently produced an empty total while still reporting
        // success. A measurement step that passes without measuring is the same
        // species as a gate that passes on zero frames.
        "TOTAL=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo); " +
        "AVAIL=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo); " +
        "echo \"total_mb=$TOTAL\"; echo \"avail_mb=$AVAIL\"; echo \"vcpu=$(nproc)\"; " +
        "test -n \"$TOTAL\" && test \"$TOTAL\" -gt 3000 && echo MEM_BASELINE_OK",
      expect: "MEM_BASELINE_OK",
    },
    {
      name: "prove the JVM starts headless before waiting on a web server",
      // A four-minute health poll is an expensive way to discover that the JVM
      // cannot start. This costs a second and fails at step 3 instead of step 6.
      cmd:
        "/opt/java/bin/java -Djava.awt.headless=true -version 2>&1 | head -1 " +
        "&& echo 'public class T{public static void main(String[] a){System.out.println(\"JVM_HEADLESS_OK\");}}' > /tmp/T.java " +
        "&& (command -v javac >/dev/null && javac -d /tmp /tmp/T.java && /opt/java/bin/java -Djava.awt.headless=true -cp /tmp T " +
        "|| /opt/java/bin/java -Djava.awt.headless=true -XshowSettings:properties -version 2>&1 | grep -q 'java.awt.headless' && echo JVM_HEADLESS_OK)",
      expect: "JVM_HEADLESS_OK",
    },
    {
      name: "start metabase with -Xmx2g",
      // Vendor guidance for a 4 GB machine, leaving headroom for the OS.
      cmd:
        "mkdir -p /var/log/blink /var/lib/metabase " +
        // Writes its own PID before exec'ing, so nothing downstream needs pgrep
        // or pkill. The base image has no procps: `free`, `pgrep` and `pkill`
        // are all absent, and pkill's absence would have silently disabled the
        // guest-side self-destruct on every instance.
        "&& ( setsid sh -c 'echo $$ > /var/lib/metabase/app.pid; exec env " +
        "MB_DB_FILE=/var/lib/metabase/metabase.db MB_JETTY_PORT=3000 " +
        // -Djava.awt.headless=true is not optional here. The JVM initialises AWT
        // during Metabase boot and the base image has no X11 libraries, so it
        // died on `UnsatisfiedLinkError: libawt_xawt.so: libXi.so.6`. Headless
        // mode skips that path entirely, which is correct for a server with no
        // display rather than a workaround.
        "/opt/java/bin/java -Xmx2g -Djava.awt.headless=true " +
        "--add-opens java.base/java.nio=ALL-UNNAMED -jar /opt/metabase/metabase.jar " +
        "' >/var/log/blink/metabase.log 2>&1 & ) ; sleep 2 ; " +
        "test -s /var/lib/metabase/app.pid && echo \"pid=$(cat /var/lib/metabase/app.pid)\" && echo STARTED",
      expect: "STARTED",
    },
    { name: "wait for metabase to answer on loopback", cmd: "__HEALTH_POLL__", expect: "HEALTHY" },
    {
      name: "measure memory after boot (Q13 evidence)",
      cmd:
        "PID=$(cat /var/lib/metabase/app.pid 2>/dev/null); " +
        "test -n \"$PID\" && test -d /proc/$PID || { echo NO_PID; exit 1; }; " +
        "RSS=$(awk '/VmRSS/{print int($2/1024)}' /proc/$PID/status); " +
        "AVAIL=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo); " +
        "echo \"rss_mb_after_boot=$RSS\"; echo \"avail_mb_after_boot=$AVAIL\"; " +
        "test -n \"$RSS\" && echo MEM_AFTER_BOOT_OK",
      expect: "MEM_AFTER_BOOT_OK",
    },
    {
      name: "complete setup and create the admin user",
      // The setup token is minted by Metabase on first boot and is the only way
      // to create the first user without a browser. Postcondition asserts the
      // session id came back, not that the call returned 200.
      cmd:
        `TOKEN=$(curl -sf http://127.0.0.1:${METABASE_PORT}/api/session/properties ` +
        `| sed -n 's/.*"setup-token":"\\([^"]*\\)".*/\\1/p'); ` +
        `test -n "$TOKEN" || { echo NO_SETUP_TOKEN; exit 1; }; ` +
        `RESP=$(curl -sf -X POST -H 'Content-Type: application/json' ` +
        `-d "{\\"token\\":\\"$TOKEN\\",\\"user\\":{\\"first_name\\":\\"${ADMIN_FIRST}\\",\\"last_name\\":\\"${ADMIN_LAST}\\",` +
        `\\"email\\":\\"${ADMIN_EMAIL}\\",\\"password\\":\\"${adminPassword}\\"},` +
        `\\"prefs\\":{\\"site_name\\":\\"Blink Metabase\\",\\"allow_tracking\\":false}}" ` +
        `http://127.0.0.1:${METABASE_PORT}/api/setup); ` +
        `echo "$RESP" | grep -q '"id"' || { echo NO_SESSION; exit 1; }; ` +
        `echo "$RESP" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p' > /var/lib/metabase/session && chmod 600 /var/lib/metabase/session; ` +
        `test -s /var/lib/metabase/session && echo ADMIN_OK`,
      expect: "ADMIN_OK",
    },
    {
      name: "confirm the bundled sample database is present and queryable",
      // Asserts the artefact: a named database AND a table inside it. A count of
      // databases would pass on an empty install.
      cmd:
        `S=$(cat /var/lib/metabase/session); ` +
        `DBS=$(curl -sf -H "X-Metabase-Session: $S" http://127.0.0.1:${METABASE_PORT}/api/database); ` +
        `echo "$DBS" | grep -qi 'sample' || { echo NO_SAMPLE_DB; exit 1; }; ` +
        `ID=$(echo "$DBS" | sed -n 's/.*"id":\\([0-9]*\\),"name":"Sample[^"]*".*/\\1/p' | head -1); ` +
        `test -n "$ID" || ID=1; ` +
        `T=$(curl -sf -H "X-Metabase-Session: $S" "http://127.0.0.1:${METABASE_PORT}/api/database/$ID/metadata"); ` +
        `echo "$T" | grep -o '"name"' | wc -l | awk '{print "metadata_fields=" $1}'; ` +
        `echo "$T" | grep -qi 'orders\\|people\\|products' || { echo NO_SAMPLE_TABLES; exit 1; }; ` +
        `echo SAMPLE_DB_OK`,
      expect: "SAMPLE_DB_OK",
    },
    {
      name: "measure memory under query load (the real Q13 answer)",
      // Boot memory is not the question. The question is whether it survives
      // actually being used, which is what a visitor will do.
      cmd:
        `S=$(cat /var/lib/metabase/session); ` +
        `for i in 1 2 3 4 5 6; do ` +
        `curl -sf -H "X-Metabase-Session: $S" -H 'Content-Type: application/json' ` +
        `-d '{"database":1,"type":"native","native":{"query":"select count(*) from ORDERS"}}' ` +
        `-X POST http://127.0.0.1:${METABASE_PORT}/api/dataset >/dev/null 2>&1 || true; done; ` +
        `sleep 3; ` +
        `PID=$(cat /var/lib/metabase/app.pid 2>/dev/null); ` +
        `test -n "$PID" && test -d /proc/$PID || { echo DIED_UNDER_LOAD; exit 1; }; ` +
        `RSS=$(awk '/VmRSS/{print int($2/1024)}' /proc/$PID/status); echo "rss_mb_after_load=$RSS"; ` +
        `echo "avail_mb_after_load=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)"; ` +
        `grep -ci 'OutOfMemoryError' /var/log/blink/metabase.log | awk '{print "oom_lines=" $1}'; ` +
        `curl -sf -o /dev/null http://127.0.0.1:${METABASE_PORT}${METABASE_HEALTH} || { echo UNHEALTHY_AFTER_LOAD; exit 1; }; ` +
        `echo LOAD_OK`,
      expect: "LOAD_OK",
    },
    {
      name: "install the per-instance boot script",
      // Metabase serves relative URLs, so unlike Gitea there is no ROOT_URL to
      // patch. The boot script arms layer 2 of the expiry design only.
      cmd:
        "cat > /usr/local/bin/blink-boot <<'SH'\n" +
        "#!/bin/sh\n" +
        "LIFETIME=\"${2:-600}\"\n" +
        // kill(1) is a shell builtin and always present; pkill is not.
        "setsid sh -c \"sleep ${LIFETIME}; kill -9 \\$(cat /var/lib/metabase/app.pid 2>/dev/null) 2>/dev/null; " +
        "echo blink-selfdestruct-fired >> /var/log/blink/metabase.log\" >/dev/null 2>&1 &\n" +
        "echo BOOT_OK\n" +
        "SH\n" +
        "chmod +x /usr/local/bin/blink-boot && test -x /usr/local/bin/blink-boot && echo BOOTSCRIPT_OK",
      expect: "BOOTSCRIPT_OK",
    },
    {
      name: "prove the self-destruct can actually kill this process",
      // Layer 2 of the three-layer expiry is the ONLY layer indifferent to
      // visitor activity, so it carries abuse containment alone. It was written
      // with pkill, which does not exist on this image, and would have failed
      // silently on every instance. This asserts the mechanism rather than the
      // presence of the script: it signals the real PID with signal 0.
      cmd:
        "PID=$(cat /var/lib/metabase/app.pid); " +
        "test -n \"$PID\" || { echo NO_PIDFILE; exit 1; }; " +
        "kill -0 \"$PID\" 2>/dev/null || { echo CANNOT_SIGNAL; exit 1; }; " +
        "command -v kill >/dev/null || { echo NO_KILL; exit 1; }; " +
        "echo SELFDESTRUCT_ARMED_OK",
      expect: "SELFDESTRUCT_ARMED_OK",
    },
    proveSelfDestructStep("/var/lib/metabase/app.pid"),
    {
      name: "verify the seeded state one last time before snapshotting",
      cmd:
        `curl -sf -o /dev/null http://127.0.0.1:${METABASE_PORT}${METABASE_HEALTH} ` +
        `&& test -s /var/lib/metabase/metabase.db.mv.db ` +
        `&& du -sh /var/lib/metabase/ | cut -f1 && echo FINAL_OK`,
      expect: "FINAL_OK",
    },
  ];
}

async function build(dryRun: boolean): Promise<number> {
  // Deterministic for the same reason as Gitea: the visitor must be able to log
  // in, and a canary must be able to run a query. src/catalog/credentials.ts.
  const adminPassword = process.env.BLINK_METABASE_PASSWORD ?? SEEDED.metabase.password;
  const steps = metabaseSteps(adminPassword);
  if (dryRun) {
    safeOut(`\nMetabase ${METABASE_VERSION} recipe, ${steps.length} steps, 2 vCPU / 4 GB. Nothing has run.\n\n`);
    steps.forEach((st, i) => safeOut(`${String(i + 1).padStart(2)}. ${st.name}\n    postcondition: ${JSON.stringify(st.expect)}\n`));
    return 0;
  }

  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) { safeErr("SOLARI_API_KEY is not set.\n"); return 2; }
  const plan: Plan = PLANS[(process.env.BLINK_PLAN ?? "starter") as "starter" | "free"]!;
  const guard = new BudgetGuard(plan, 0.06);
  const ledger = new SandboxLedger();
  ledger.install(apiKey);
  const adapter = new SolariAdapter({ counting: createCountingFetch({ caps: CAPS_GATES }), guard, ledger });

  safeOut(`\nBuilding Metabase ${METABASE_VERSION} on 2 vCPU / 4 GB. ${steps.length} steps.\n`);
  safeOut(`This run answers Q13: does it boot and stay stable in 4 GB.\n`);
  const bornAt = performance.now();
  let sandboxId: string | null = null;
  let snapshotId: string | null = null;
  const evidence: string[] = [];

  try {
    const sb = await adapter.createSandbox(
      apiKey, "snapshot:metabase",
      { template: "base", cpu: SIZE_LARGE.cpu, memMb: SIZE_LARGE.memMb, timeoutMs: 1_200_000,
        lifecycle: { onTimeout: "kill" }, metadata: { blink_build: "metabase", blink_version: METABASE_VERSION } },
      0.03,
    );
    sandboxId = sb.value.sandboxId;
    const sh = (cmd: string, o?: { timeoutMs?: number }) => adapter.exec(apiKey, sb.value, "snapshot:metabase", cmd, o);

    for (const [i, st] of steps.entries()) {
      const t0 = performance.now();
      let out: string;
      if (st.cmd === "__HEALTH_POLL__") {
        // Metabase migrates its application database on first boot, which is
        // slow. 240 s, against Gitea's 12.8 s and Jaeger's 0.26 s.
        const h = await waitHealthyInGuest(sh, METABASE_PORT, METABASE_HEALTH, { timeoutMs: 240_000, intervalMs: 2000 });
        out = h.ok ? "HEALTHY" : `not healthy: ${h.error ?? "unknown"}`;
        safeOut(`      polled ${h.execCalls} times over ${h.ms} ms\n`);
        if (h.ok) evidence.push(`boot_to_healthy_ms=${h.ms}`);
        if (!h.ok) {
          // HEAD, not tail. A Java stack trace puts the cause on its first
          // line and 200 frames after it; tailing showed only the frames and
          // hid "Unsupported class file major version" entirely.
          const log = await sh(
            "grep -m3 -iE 'error|exception|caused by|unsupported|FATAL' /var/log/blink/metabase.log 2>/dev/null " +
            "|| head -20 /var/log/blink/metabase.log 2>&1 || echo no-log",
          );
          safeErr(`      first errors in metabase.log:\n${log.value.stdout.trim().slice(0, 900)}\n`);
        }
      } else {
        const r = await sh(st.cmd, { timeoutMs: 180_000 });
        out = `${r.value.stdout}\n${r.value.stderr}`;
      }
      const ms = Math.round(performance.now() - t0);
      const ok = out.includes(st.expect);
      safeOut(`  ${String(i + 1).padStart(2)}. ${ok ? "ok  " : "FAIL"} ${st.name} (${ms} ms)\n`);
      for (const line of out.split("\n")) {
        if (/^(rss_mb|avail_mb|total_mb|vcpu|oom_lines|metadata_fields)/.test(line.trim())) {
          evidence.push(line.trim());
          safeOut(`      ${line.trim()}\n`);
        }
      }
      if (!ok) {
        safeErr(`\n     expected ${JSON.stringify(st.expect)}, got:\n     ${out.trim().slice(0, 900)}\n`);
        throw new Error(`step ${i + 1} (${st.name}) postcondition not met`);
      }
    }

    const snap = await adapter.snapshot(apiKey, sb.value, "snapshot:metabase",
      `metabase-${METABASE_VERSION}-${new Date().toISOString().slice(0, 10)}`);
    snapshotId = snap.value;
    safeOut(`\n  snapshot ${snapshotId} created in ${snap.ms} ms\n`);
    const reg = loadRegistry();
    reg.metabase = snapshotId;
    safeWriteJsonSync(REGISTRY_PATH, reg);
    safeOut(`  recorded in ${REGISTRY_PATH}\n`);
    safeOut(`\n  Q13 EVIDENCE: ${evidence.join("  ")}\n`);
    safeOut(`  Q13 VERDICT: Metabase boots and stays healthy under query load in 2 vCPU / 4 GB.\n`);
  } finally {
    if (sandboxId) {
      await adapter.killQuiet(apiKey, sandboxId, "snapshot:metabase");
      guard.addSandboxSeconds((performance.now() - bornAt) / 1000, SIZE_LARGE, true, "metabase snapshot build");
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
