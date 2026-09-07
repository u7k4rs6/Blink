/**
 * Snapshot recipe: Excalidraw v0.18.1, built from source and served statically.
 *
 * Third app. The first one whose build and its runtime want genuinely different
 * machines, which is where the deviation below comes from.
 *
 * DEVIATION (02-architecture.md section 5): built in 2 vCPU / 4 GB, served from
 * 1 vCPU / 2 GB.
 *
 * Excalidraw is a Vite/React monorepo. Installing its dependency tree and running
 * the production build is the single heaviest thing in this repository: it wants
 * a real amount of memory and more than one core to finish in reasonable time.
 * What comes out the other end is a directory of static files. Serving those
 * needs approximately nothing, and every earlier app in the catalog runs at
 * SIZE_SMALL, so sizing every Excalidraw instance for its build would multiply
 * the cost of every visitor by a build that happened once, weeks ago.
 *
 * The snapshot is therefore taken from a SIZE_LARGE sandbox and launched into
 * SIZE_SMALL ones. That is safe here specifically because the runtime is a static
 * file server with no JVM, no database and no background workers, so there is no
 * component whose memory floor was set by the build machine. It is not a general
 * licence: Metabase measures 1486 MB resident under load (Q13) and must keep its
 * 4 GB. The rule is that a snapshot may be launched smaller than it was built
 * only when the serving process is provably not the building process, and the
 * step "prove the runtime survives the smaller machine" below is what makes that
 * a measurement rather than an assertion.
 *
 * Same rules as every other recipe: every command through `sh -c`, assert on
 * postconditions rather than exit codes, health over loopback, prerequisites up
 * front, and the self-destruct proven by signalling the real process.
 */

import { fileURLToPath } from "node:url";
import { BudgetGuard } from "../../src/guard/guard.ts";
import { SandboxLedger } from "../../src/guard/ledger.ts";
import { PLANS, SIZE_LARGE, SIZE_SMALL, type Plan } from "../../src/guard/rates.ts";
import { CAPS_GATES, createCountingFetch } from "../../src/solari/fetch.ts";
import { SolariAdapter } from "../../src/solari/adapter.ts";
import { APPS, REGISTRY_PATH, loadRegistry } from "../gates/lib/apps.ts";
import { waitHealthyInGuest } from "../gates/lib/health.ts";
import { bootScriptStep, prerequisiteStep, proveSelfDestructStep, runLongInGuest, type Step } from "./lib/template.ts";
import {
  WELCOME_SCENE_B64, WELCOME_SCENE_ELEMENTS, WELCOME_SCENE_MARKER,
} from "./lib/welcome-scene.ts";
import { safeErr, safeOut, safeWriteJsonSync } from "../../src/safe-io.ts";

export const EXCALIDRAW_VERSION = "v0.18.1";
/**
 * Node 22, not 24, and not by preference.
 *
 * The first build installed 24.20.0 and yarn refused it: excalidraw-monorepo
 * declares `"node": "18.0.0 - 22.x.x"`. It failed in 12 seconds for $0.00066
 * rather than 20 minutes, which is the prerequisites-up-front rule paying for
 * itself, but it was still caught by yarn rather than by us. So the range is now
 * asserted directly, below, before the long build starts.
 */
export const NODE_VERSION = "v22.23.2";
/** The range Excalidraw declares at the pinned tag. Asserted, not assumed. */
export const EXCALIDRAW_NODE_RANGE = "18.0.0 - 22.x.x";
export const NODE_MAJOR_MIN = 18;
export const NODE_MAJOR_MAX = 22;
export const EXCALIDRAW_PORT = 8080;
export const EXCALIDRAW_HEALTH = "/";

const NODE_TARBALL = `node-${NODE_VERSION}-linux-x64.tar.xz`;
const NODE_DIR = `/opt/node-${NODE_VERSION}-linux-x64`;
const SRC = "/opt/excalidraw";
const WWW = "/var/www/excalidraw";
const PIDFILE = "/var/run/excalidraw.pid";
const LOG = "/var/log/blink/excalidraw.log";
const BUILD_LOG = "/var/log/blink/excalidraw-build.log";

/** The build step, run detached because it outlives the gateway's exec limit. */
/**
 * The build, with the yarn cache kept off the disk.
 *
 * Measured cause of four failed builds (V62, V67): `yarn install` writes its
 * cache to /usr/local/share/.cache/yarn and then COPIES from it into
 * node_modules, so both exist at once. The template gives 2198 MB free, and the
 * two together do not fit:
 *
 *   error ENOSPC: no space left on device, copyfile
 *     '/usr/local/share/.cache/yarn/v6/...' -> '/opt/excalidraw/node_modules/...'
 *
 * So the cache goes to /dev/shm, which is RAM, and is deleted the moment the
 * install finishes and before the build starts. Memory is the resource we can
 * actually request here (4 GB, consistently delivered) and disk is the one we
 * cannot (V62), so this trades the plentiful resource for the scarce one and
 * holds both only briefly.
 */
export const YARN_CACHE = "/dev/shm/blink-yarn-cache";

export const BUILD_CMD =
  `export PATH=${NODE_DIR}/bin:$PATH && cd ${SRC} && ` +
  // build:app:docker sets VITE_APP_DISABLE_SENTRY=true, so a visitor's instance
  // ships no error telemetry to a third party. That is the build we want anyway.
  `corepack enable && ` +
  `mkdir -p ${YARN_CACHE} && ` +
  // NOT --ignore-optional. It looks like the right tool for the platform-binary
  // problem (V67) and is not: rollup and esbuild ship their NATIVE binaries as
  // optional dependencies, so the flag drops @rollup/rollup-linux-x64-gnu, the
  // one platform we are actually building on, along with the Windows and Solaris
  // ones we are not. The build then dies with "Cannot find module
  // @rollup/rollup-linux-x64-gnu" long after the install reported success.
  //
  // Disk is solved by putting the cache in RAM and deleting it before the build,
  // which is a real fix. Skipping optional dependencies was a disk fix that
  // broke the build to save space it was not the cause of.
  `yarn install --cache-folder ${YARN_CACHE} && ` +
  // Free the cache before the build, not after. The build needs the memory and
  // the install no longer needs the cache, so nothing holds both at their peak.
  `rm -rf ${YARN_CACHE} && ` +
  `df -Pm / | awk 'NR==2{print "disk_avail_before_build_mb=" $4}' && ` +
  // /proc/meminfo, not `free`: procps is not on this image (V61), and the first
  // version of this line would have printed nothing and been believed.
  `awk '/MemAvailable/{printf "mem_avail_before_build_mb=%d\\n", $2/1024}' /proc/meminfo && ` +
  `yarn build:app:docker`;

export function excalidrawSteps(): Step[] {
  return [
    // Asserts only what the base image supplies. Node, npm and git are installed
    // below and asserted after their install steps, never here.
    prerequisiteStep(["curl", "tar", "python3", "sha256sum"]),
    {
      name: "record the machine we are building on",
      cmd:
        "mkdir -p /var/log/blink && " +
        "TOTAL=$(awk '/MemTotal/{printf \"%d\", $2/1024}' /proc/meminfo); " +
        "AVAIL=$(awk '/MemAvailable/{printf \"%d\", $2/1024}' /proc/meminfo); " +
        "echo \"build_total_mb=$TOTAL\"; echo \"build_avail_mb=$AVAIL\"; echo \"build_vcpu=$(nproc)\"; " +
        // Disk was never measured until a yarn install hit ENOSPC. Memory and
        // vCPU are requestable; disk is whatever the template gives you, so it
        // is the constraint you find out about rather than choose.
        "echo \"disk_total_mb=$(df -Pm / | awk 'NR==2{print $2}')\"; " +
        "echo \"disk_avail_mb=$(df -Pm / | awk 'NR==2{print $4}')\"; " +
        "echo MACHINE_OK",
      expect: "MACHINE_OK",
    },
    {
      name: "install git, which the base image does not have",
      cmd:
        "( command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git) ) " +
        "&& command -v git >/dev/null && git --version && echo GIT_OK",
      expect: "GIT_OK",
    },
    {
      name: `install Node ${NODE_VERSION}, checksum verified against the published SHASUMS`,
      cmd:
        `cd /opt && curl -fsSL -O https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL} ` +
        `&& curl -fsSL https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt -o SHASUMS256.txt ` +
        // Verify only our line: the file lists every platform and sha256sum -c
        // fails on the ones that are absent.
        `&& grep " ${NODE_TARBALL}$" SHASUMS256.txt | sha256sum -c - ` +
        `&& tar xf ${NODE_TARBALL} && rm -f ${NODE_TARBALL} ` +
        `&& test -x ${NODE_DIR}/bin/node && echo NODE_OK`,
      expect: "NODE_OK",
    },
    {
      name: "assert the toolchain now exists, after installing it",
      cmd:
        `export PATH=${NODE_DIR}/bin:$PATH; ` +
        `command -v node >/dev/null || { echo MISSING_BINARY:node; exit 1; }; ` +
        `command -v npm >/dev/null || { echo MISSING_BINARY:npm; exit 1; }; ` +
        `command -v corepack >/dev/null || { echo MISSING_BINARY:corepack; exit 1; }; ` +
        `echo "node_version=$(node -v)"; echo TOOLCHAIN_OK`,
      expect: "TOOLCHAIN_OK",
    },
    {
      name: `clone Excalidraw at ${EXCALIDRAW_VERSION}, pinned and shallow`,
      cmd:
        `rm -rf ${SRC} && git clone --depth 1 --branch ${EXCALIDRAW_VERSION} ` +
        `https://github.com/excalidraw/excalidraw.git ${SRC} ` +
        `&& cd ${SRC} && test -f package.json ` +
        `&& echo "commit=$(git rev-parse --short HEAD)" && echo CLONE_OK`,
      expect: "CLONE_OK",
    },
    {
      name: "assert the installed Node satisfies what Excalidraw declares",
      // Pins the CONSTRAINT, not just the version. If upstream widens or narrows
      // its engines range on a future bump, this fails in seconds and says so,
      // instead of the build failing 20 minutes in or, worse, succeeding on a
      // Node the project does not support.
      cmd:
        `cd ${SRC} && export PATH=${NODE_DIR}/bin:$PATH && ` +
        `DECL=$(python3 -c "import json;print(json.load(open('package.json'))['engines']['node'])"); ` +
        `echo "declared_node_range=$DECL"; ` +
        `test "$DECL" = "${EXCALIDRAW_NODE_RANGE}" || { echo ENGINE_RANGE_CHANGED; exit 1; }; ` +
        `MAJ=$(node -p "process.versions.node.split('.')[0]"); ` +
        `echo "installed_node_major=$MAJ"; ` +
        `test "$MAJ" -ge ${NODE_MAJOR_MIN} -a "$MAJ" -le ${NODE_MAJOR_MAX} || { echo NODE_OUT_OF_RANGE; exit 1; }; ` +
        `echo ENGINES_OK`,
      expect: "ENGINES_OK",
    },
    {
      name: "drop the examples workspaces, which pull a Next.js toolchain we never build",
      // The first Node 22 attempt died with ENOSPC while fetching
      // @next/swc-darwin-x64, @next/swc-win32-arm64-msvc and the rest: yarn
      // resolves optional platform binaries for every OS, none of which this
      // build uses. examples/* are demo apps for the npm package, not part of
      // excalidraw-app, so removing them from the workspace list removes that
      // entire dependency tree.
      cmd:
        `cd ${SRC} && python3 - <<'PY'\n` +
        `import json\n` +
        `d = json.load(open("package.json"))\n` +
        `before = list(d["workspaces"])\n` +
        `d["workspaces"] = [w for w in before if not w.startswith("examples")]\n` +
        `assert "excalidraw-app" in d["workspaces"], "the app workspace must survive"\n` +
        `assert len(d["workspaces"]) < len(before), "nothing was dropped, so the layout changed"\n` +
        `json.dump(d, open("package.json", "w"), indent=2)\n` +
        `print("workspaces_kept=" + ",".join(d["workspaces"]))\n` +
        `PY\n` +
        `rm -rf ${SRC}/examples && echo WORKSPACES_TRIMMED`,
      expect: "WORKSPACES_TRIMMED",
    },
    {
      name: "enlarge /dev/shm, since the yarn cache lives there and RAM is what we have",
      // /dev/shm defaults to half of RAM but was reported at 992 MB free, and the
      // cache does not fit: yarn downloads platform binaries for every OS it has
      // ever heard of (win32-arm64, win32-ia32, sunos-x64) before discarding the
      // ones it cannot use. Q5 established the guest runs as root with all
      // capabilities, which is a liability everywhere else in this project and
      // is the one thing making this remount possible.
      cmd:
        `mount -o remount,size=2560M /dev/shm || { echo REMOUNT_FAILED; exit 1; }; ` +
        `echo "shm_total_mb=$(df -Pm /dev/shm | awk 'NR==2{print $2}')"; ` +
        `echo SHM_RESIZED`,
      expect: "SHM_RESIZED",
    },
    {
      name: "assert there is disk headroom for the install before starting it",
      // Four builds died on ENOSPC, one of them after forty minutes of thrashing.
      // The cache now lives in RAM, so this checks the resource that is actually
      // scarce and refuses in a second rather than discovering it in an hour.
      cmd:
        `AVAIL=$(df -Pm / | awk 'NR==2{print $4}'); ` +
        `SHM=$(df -Pm /dev/shm | awk 'NR==2{print $4}'); ` +
        `echo "disk_avail_mb=$AVAIL"; echo "shm_avail_mb=$SHM"; ` +
        `test "$AVAIL" -ge 1600 || { echo NOT_ENOUGH_DISK; exit 1; }; ` +
        `test "$SHM" -ge 2000 || { echo NOT_ENOUGH_SHM_FOR_CACHE; exit 1; }; ` +
        `echo HEADROOM_OK`,
      expect: "HEADROOM_OK",
    },
    "__BUILD__" as unknown as Step,
    {
      name: "publish the built files and assert they are real",
      cmd:
        `rm -rf ${WWW} && mkdir -p ${WWW} && ` +
        // The Docker build target writes to excalidraw-app/build.
        `cp -r ${SRC}/excalidraw-app/build/. ${WWW}/ && ` +
        `test -s ${WWW}/index.html || { echo NO_INDEX; exit 1; }; ` +
        // An index.html alone proves nothing: a failed Vite build can still leave
        // the template behind. The bundle is the artefact that matters.
        `JS=$(find ${WWW} -name '*.js' -size +100k | head -1); ` +
        `test -n "$JS" || { echo NO_BUNDLE; exit 1; }; ` +
        `echo "bundle_kb=$(du -k "$JS" | cut -f1)"; ` +
        `echo "www_mb=$(du -sm ${WWW} | cut -f1)"; ` +
        `echo PUBLISH_OK`,
      expect: "PUBLISH_OK",
    },
    {
      name: "seed a welcome scene, so a fresh instance is not an empty canvas",
      // Excalidraw keeps documents in localStorage, so there is no server-side
      // document to seed. What can be seeded is a scene file the app loads via
      // its own #json import, which is the same path a shared link uses.
      //
      // The scene lives in lib/welcome-scene.ts, shared with the fork time write
      // in gates/lib/apps.ts, so the snapshot and a live instance cannot drift
      // apart. It was one line of text; a canvas with one line of text on it
      // photographs exactly like a canvas whose seed failed.
      cmd:
        `mkdir -p ${WWW}/scenes && ` +
        `echo ${WELCOME_SCENE_B64} | base64 -d > ${WWW}/scenes/welcome.excalidraw && ` +
        `grep -q '${WELCOME_SCENE_MARKER}' ${WWW}/scenes/welcome.excalidraw && ` +
        `python3 -c "import json;d=json.load(open('${WWW}/scenes/welcome.excalidraw'));` +
        `n=len(d['elements']);assert n==${WELCOME_SCENE_ELEMENTS},'elements=%d' % n;` +
        `print('elements=%d' % n)" ` +
        `&& echo SEED_OK`,
      expect: "SEED_OK",
    },
    {
      name: "start the static server and write its pidfile",
      cmd:
        `mkdir -p /var/log/blink && ` +
        // The server writes its own PID before exec, so nothing downstream needs
        // pgrep or pkill, neither of which exists on this image (V61).
        `setsid sh -c 'echo $$ > ${PIDFILE}; exec python3 -m http.server ${EXCALIDRAW_PORT} ` +
        `--directory ${WWW} --bind 0.0.0.0' >>${LOG} 2>&1 & ` +
        `sleep 2; test -s ${PIDFILE} || { echo NO_PIDFILE; exit 1; }; ` +
        `echo "server_pid=$(cat ${PIDFILE})"; echo SERVER_OK`,
      expect: "SERVER_OK",
    },
    "__HEALTH_POLL__" as unknown as Step,
    {
      name: "prove the runtime survives the smaller machine it will be launched into",
      // This is the measurement that licenses the build/serve size deviation.
      // If the serving footprint does not fit inside SIZE_SMALL with room to
      // spare, the deviation is wrong and the recipe says so here rather than
      // in production.
      cmd:
        `PID=$(cat ${PIDFILE}); ` +
        `RSS=$(awk '/VmRSS/{printf "%d", $2/1024}' /proc/$PID/status); ` +
        `echo "serve_rss_mb=$RSS"; ` +
        `test "$RSS" -lt 512 || { echo TOO_FAT_FOR_SMALL; exit 1; }; ` +
        `echo "serve_budget_mb=${SIZE_SMALL.memMb}"; ` +
        `echo SIZE_DEVIATION_JUSTIFIED`,
      expect: "SIZE_DEVIATION_JUSTIFIED",
    },
    bootScriptStep(PIDFILE, LOG),
    proveSelfDestructStep(PIDFILE),
    {
      name: "verify the served state one last time before snapshotting",
      cmd:
        `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:${EXCALIDRAW_PORT}/ | grep -q 200 ` +
        `&& curl -fsS http://127.0.0.1:${EXCALIDRAW_PORT}/scenes/welcome.excalidraw | grep -q "${WELCOME_SCENE_MARKER}" ` +
        `&& echo "oom_lines=$(dmesg 2>/dev/null | grep -ci 'out of memory' || echo 0)" ` +
        `&& echo VERIFY_OK`,
      expect: "VERIFY_OK",
    },
  ];
}

async function build(dryRun: boolean): Promise<number> {
  const plan: Plan = PLANS[(process.env.BLINK_PLAN ?? "starter") as "starter" | "free"]!;
  const steps = excalidrawSteps();
  safeOut(`\n=== Snapshot: Excalidraw ${EXCALIDRAW_VERSION} (Node ${NODE_VERSION}) ===\n`);
  safeOut(`  build size: ${SIZE_LARGE.cpu} vCPU / ${SIZE_LARGE.memMb} MB\n`);
  safeOut(`  serve size: ${SIZE_SMALL.cpu} vCPU / ${SIZE_SMALL.memMb} MB  (deviation, see section 5)\n`);
  safeOut(`  ${steps.length} steps\n\n`);
  if (dryRun) {
    for (const [i, st] of steps.entries()) {
      const name = (st as Step).name ?? String(st);
      safeOut(`  ${String(i + 1).padStart(2)}. ${name}\n      postcondition: ${(st as Step).expect ?? "special"}\n`);
    }
    return 0;
  }

  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) { safeErr("SOLARI_API_KEY is not set.\n"); return 2; }

  // 2 vCPU / 4 GB is $0.114/h, so this ceiling buys about 50 minutes. Sized for
  // a yarn install of a monorepo plus a Vite production build, both of which are
  // slower than anything else in this repository. Being refused mid-build would
  // waste the whole run, which is the one failure mode worth over-provisioning against.
  const guard = new BudgetGuard(plan, 0.16);
  const ledger = new SandboxLedger();
  ledger.install(apiKey);
  const adapter = new SolariAdapter({ counting: createCountingFetch({ caps: CAPS_GATES }), guard, ledger });

  const bornAt = performance.now();
  let sandboxId: string | null = null;
  let snapshotId: string | null = null;
  const evidence: string[] = [];

  try {
    const sb = await adapter.createSandbox(
      apiKey, "snapshot:excalidraw",
      { template: "base", cpu: SIZE_LARGE.cpu, memMb: SIZE_LARGE.memMb, timeoutMs: 3_300_000,
        lifecycle: { onTimeout: "kill" },
        metadata: { blink_build: "excalidraw", blink_version: EXCALIDRAW_VERSION } },
      0.05,
    );
    sandboxId = sb.value.sandboxId;
    const sh = (cmd: string, o?: { timeoutMs?: number }) =>
      adapter.exec(apiKey, sb.value, "snapshot:excalidraw", cmd, o);

    for (const [i, st] of steps.entries()) {
      const t0 = performance.now();
      let out: string;

      if ((st as unknown as string) === "__BUILD__") {
        safeOut(`  ${String(i + 1).padStart(2)}. .... yarn install and production build (detached, this is the slow one)\n`);
        const b = await runLongInGuest(sh, BUILD_CMD, {
          marker: "/tmp/blink-build-done", log: BUILD_LOG,
          // 40 minutes, not 25. V63: an identical 2 vCPU request delivers one
          // core about as often as two, and this build is CPU bound, so the
          // window has to cover the slow draw rather than the average one.
          timeoutMs: 2_400_000, intervalMs: 10_000,
          progressEvery: 6,
          onProgress: (sec, line) => safeOut(`      [${String(sec).padStart(4)}s] ${line}\n`),
        });
        safeOut(`      polled ${b.polls} times over ${Math.round(b.ms / 1000)} s, exit ${b.status}\n`);
        if (!b.ok) {
          safeErr(`\n     build failed (exit ${b.status}). Last lines:\n${b.tail.trim().slice(0, 4000)}\n`);
          throw new Error("excalidraw build did not succeed");
        }
        evidence.push(`build_ms=${b.ms}`);
        out = "BUILD_OK";
        safeOut(`  ${String(i + 1).padStart(2)}. ok   build finished in ${Math.round(b.ms / 1000)} s\n`);
        continue;
      }

      if ((st as unknown as string) === "__HEALTH_POLL__") {
        const h = await waitHealthyInGuest(sh, EXCALIDRAW_PORT, EXCALIDRAW_HEALTH,
          { timeoutMs: 60_000, intervalMs: 1000 });
        out = h.ok ? "HEALTHY" : `not healthy: ${h.error ?? "unknown"}`;
        safeOut(`      polled ${h.execCalls} times over ${h.ms} ms\n`);
        if (h.ok) evidence.push(`boot_to_healthy_ms=${h.ms}`);
        if (!h.ok) {
          const log = await sh(`tail -20 ${LOG} 2>/dev/null || echo no-log`);
          safeErr(`      tail of excalidraw.log:\n${log.value.stdout.trim().slice(0, 900)}\n`);
        }
        const ok = out.includes("HEALTHY");
        safeOut(`  ${String(i + 1).padStart(2)}. ${ok ? "ok  " : "FAIL"} health over loopback (${Math.round(performance.now() - t0)} ms)\n`);
        if (!ok) throw new Error(`step ${i + 1} (health) postcondition not met`);
        continue;
      }

      const step = st as Step;
      const r = await sh(step.cmd, { timeoutMs: 180_000 });
      out = `${r.value.stdout}\n${r.value.stderr}`;
      const ms = Math.round(performance.now() - t0);
      const ok = out.includes(step.expect);
      safeOut(`  ${String(i + 1).padStart(2)}. ${ok ? "ok  " : "FAIL"} ${step.name} (${ms} ms)\n`);
      for (const line of out.split("\n")) {
        if (/^(build_|serve_|disk_|shm_|mem_|bundle_kb|www_mb|node_version|declared_node_range|installed_node_major|workspaces_kept|commit|elements|server_pid|oom_lines)/.test(line.trim())) {
          evidence.push(line.trim());
          safeOut(`      ${line.trim()}\n`);
        }
      }
      if (!ok) {
        safeErr(`\n     expected ${JSON.stringify(step.expect)}, got:\n     ${out.trim().slice(0, 900)}\n`);
        throw new Error(`step ${i + 1} (${step.name}) postcondition not met`);
      }
    }

    const snap = await adapter.snapshot(apiKey, sb.value, "snapshot:excalidraw",
      `excalidraw-${EXCALIDRAW_VERSION}-${new Date().toISOString().slice(0, 10)}`);
    snapshotId = snap.value;
    safeOut(`\n  snapshot ${snapshotId} created in ${snap.ms} ms\n`);
    const reg = loadRegistry();
    reg[APPS.excalidraw!.id] = snapshotId;
    safeWriteJsonSync(REGISTRY_PATH, reg);
    safeOut(`  recorded in ${REGISTRY_PATH}\n`);
    safeOut(`\n  EVIDENCE: ${evidence.join("  ")}\n`);
    safeOut(`  DEVIATION: built at ${SIZE_LARGE.cpu}/${SIZE_LARGE.memMb}, launches at ${SIZE_SMALL.cpu}/${SIZE_SMALL.memMb}, justified by serve_rss_mb above.\n`);
  } finally {
    if (sandboxId) {
      await adapter.killQuiet(apiKey, sandboxId, "snapshot:excalidraw");
      guard.addSandboxSeconds((performance.now() - bornAt) / 1000, SIZE_LARGE, true, "excalidraw snapshot build");
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
