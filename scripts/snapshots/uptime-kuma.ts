/**
 * Snapshot recipe: Uptime Kuma 2.5.3.
 *
 * Fourth app, and the one chosen deliberately to break an assumption the other
 * three never tested. Gitea, Jaeger and Excalidraw all speak plain HTTP, so G2
 * has only ever proven that the preview domain proxies request/response. Uptime
 * Kuma's entire UI runs over socket.io, which upgrades to a WebSocket. If the
 * preview proxy does not pass an upgrade, this app is a blank page behind a
 * healthy health check, and we would not have found out from any existing gate.
 *
 * So this recipe ends by forking its own snapshot and completing a WebSocket
 * handshake through the real previewUrl, from outside the sandbox. Checking it
 * over loopback would prove only that the app works, which was never in doubt.
 *
 * TWO THINGS THE OTHER RECIPES DID NOT NEED:
 *
 * Seeding goes through the app's own socket.io API rather than its SQLite file.
 * Uptime Kuma hashes passwords with bcrypt and dispenses rows through an ORM;
 * writing the database directly means reimplementing both and being wrong when
 * either changes. Driving `setup` and `add` over the socket is what a real
 * operator does, and it exercises the WebSocket path at build time as a side
 * effect.
 *
 * The seeded monitors point at loopback only. Uptime Kuma exists to make
 * outbound requests on a schedule, and Q5 established that egress from the guest
 * cannot be restricted. Seeding a monitor seeded with someone else's URL would
 * point every instance Blink ever launches at a third party, forever, on a
 * 60-second interval. Every monitor here watches the instance itself.
 */

import { fileURLToPath } from "node:url";
import { BudgetGuard } from "../../src/guard/guard.ts";
import { SandboxLedger } from "../../src/guard/ledger.ts";
import { PLANS, SIZE_SMALL, type Plan } from "../../src/guard/rates.ts";
import { CAPS_GATES, createCountingFetch } from "../../src/solari/fetch.ts";
import { SolariAdapter } from "../../src/solari/adapter.ts";
import { APPS, REGISTRY_PATH, loadRegistry } from "../gates/lib/apps.ts";
import { waitHealthyInGuest } from "../gates/lib/health.ts";
import { bootScriptStep, prerequisiteStep, proveSelfDestructStep, runLongInGuest, type Step } from "./lib/template.ts";
import {
  KUMA_NODE_DIR, KUMA_NODE_VERSION, KUMA_PORT, KUMA_SRC, SEED_PASS, SEED_USER,
  SEEDED_MONITORS,
} from "./lib/kuma-monitors.ts";

// Re-exported so the recipe stays the one place a caller has to know about.
export {
  KUMA_PORT, SEED_USER, SEED_PASS, SEEDED_MONITORS,
  SEEDED_MONITOR_TARGETS, MONITOR_REFRESH_SCRIPT, MONITOR_REFRESH_CMD,
} from "./lib/kuma-monitors.ts";
import { safeErr, safeOut, safeWriteJsonSync } from "../../src/safe-io.ts";
import { SEEDED } from "../../src/catalog/credentials.ts";

export const KUMA_VERSION = "2.5.3";
export const NODE_VERSION = KUMA_NODE_VERSION;
/** The range Uptime Kuma declares at the pinned tag. Asserted, not assumed. */
export const KUMA_NODE_RANGE = ">= 20.4.0";
export const KUMA_HEALTH = "/";

const NODE_TARBALL = `node-${NODE_VERSION}-linux-x64.tar.xz`;
const NODE_DIR = KUMA_NODE_DIR;
const SRC = KUMA_SRC;
const PIDFILE = "/var/run/uptime-kuma.pid";
const LOG = "/var/log/blink/uptime-kuma.log";
const INSTALL_LOG = "/var/log/blink/uptime-kuma-install.log";



/**
 * npm's cache goes to RAM for the same reason yarn's does (V67).
 *
 * npm also writes a cache and then hard-links or copies out of it, so both exist
 * at once against 2198 MB of unrequestable disk. Note what is NOT here: no
 * `--omit=optional`. That flag cost Excalidraw a build, because native binaries
 * ship as optional dependencies and skipping them drops the platform you are on
 * along with the ones you are not.
 */
export const NPM_CACHE = "/dev/shm/blink-npm-cache";

export const INSTALL_CMD =
  `export PATH=${NODE_DIR}/bin:$PATH && cd ${SRC} && ` +
  `mkdir -p ${NPM_CACHE} && ` +
  `npm ci --omit dev --no-audit --no-fund --cache ${NPM_CACHE} && ` +
  `rm -rf ${NPM_CACHE} && ` +
  `df -Pm / | awk 'NR==2{print "disk_avail_after_install_mb=" $4}' && ` +
  // Fetches the prebuilt dist.tar.gz from the matching GitHub release, so there
  // is no frontend build here at all. This is why Uptime Kuma fits in
  // SIZE_SMALL when Excalidraw needed SIZE_LARGE to build.
  `npm run download-dist`;

/**
 * The seed script, run inside the guest with the app's own socket.io-client.
 *
 * Written to a file rather than passed as `node -e` because it is long enough
 * that shell quoting would be the most likely thing to break.
 */
export const SEED_SCRIPT = `
const { io } = require("socket.io-client");
// Default transports (polling, then upgrade), NOT websocket-only.
// Uptime Kuma 2.x refuses a websocket whose Origin host differs from its Host
// header, and allowRequest lets polling through unconditionally. Forcing
// websocket-only made seeding fail with a bare "websocket error". Seeding is
// not the websocket test; the previewUrl check at the end of this recipe is.
const sock = io("http://127.0.0.1:${KUMA_PORT}", { reconnection: false, timeout: 20000 });

const call = (ev, ...args) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("timeout on " + ev)), 20000);
  sock.emit(ev, ...args, (r) => { clearTimeout(t); r && r.ok === false ? rej(new Error(ev + ": " + r.msg)) : res(r); });
});

// Every monitor points at this instance. See the note at the top of the recipe:
// egress cannot be restricted, so a seeded third-party URL would be a standing
// obligation on somebody else's server.
const MONITOR = {
  type: "http", name: "", parent: null, url: "",
  method: "GET", protocol: null, location: "world", ipFamily: null,
  // conditions is NOT NULL in the schema and the UI always sends it. Omitting it
  // failed the insert, not the request, so the callback reported the SQL error
  // rather than a validation message.
  conditions: [],
  interval: 60, retryInterval: 60, resendInterval: 0, maxretries: 0,
  retryOnlyOnStatusCodeFailure: false, notificationIDList: {}, ignoreTls: false,
  upsideDown: false, expiryNotification: false, domainExpiryNotification: false,
  maxredirects: 10, accepted_statuscodes: ["200-299"], saveResponse: false,
  saveErrorResponse: true, responseMaxLength: 1024, dns_resolve_type: "A",
  dns_resolve_server: "", docker_container: "", docker_host: null, proxyId: null,
  basic_auth_user: "", basic_auth_pass: "", bearer_token: "",
};

(async () => {
  await new Promise((res, rej) => {
    sock.on("connect", res);
    sock.on("connect_error", (e) => rej(new Error("socket connect_error: " + e.message)));
    setTimeout(() => rej(new Error("socket never connected")), 20000);
  });
  console.log("socket_connected=1");

  await call("setup", "${SEED_USER}", "${SEED_PASS}");
  console.log("admin_created=1");

  await call("login", { username: "${SEED_USER}", password: "${SEED_PASS}", token: "" });
  console.log("logged_in=1");

  const plan = ${JSON.stringify(SEEDED_MONITORS)};
  for (const m of plan) await call("add", { ...MONITOR, name: m.name, url: m.url });
  console.log("monitors_added=" + plan.length);

  sock.close();
  console.log("SEED_OK");
  process.exit(0);
})().catch((e) => { console.error("SEED_FAILED: " + e.message); process.exit(1); });
`;

export function kumaSteps(): Step[] {
  return [
    prerequisiteStep(["curl", "tar", "python3", "sha256sum"]),
    {
      name: "record the machine we are building on",
      cmd:
        "mkdir -p /var/log/blink && " +
        "TOTAL=$(awk '/MemTotal/{printf \"%d\", $2/1024}' /proc/meminfo); " +
        "AVAIL=$(awk '/MemAvailable/{printf \"%d\", $2/1024}' /proc/meminfo); " +
        "echo \"build_total_mb=$TOTAL\"; echo \"build_avail_mb=$AVAIL\"; echo \"build_vcpu=$(nproc)\"; " +
        // Disk before anything heavy. V62: the template gives 3952 MB total and
        // about 2192 MB free, which is under half the memory, and it is not
        // requestable. npm ci for this app is the second largest tree we install.
        "echo \"disk_total_mb=$(df -Pm / | awk 'NR==2{print $2}')\"; " +
        "echo \"disk_avail_mb=$(df -Pm / | awk 'NR==2{print $4}')\"; " +
        "echo MACHINE_OK",
      expect: "MACHINE_OK",
    },
    {
      name: "install git, which the base image does not have",
      cmd:
        "( command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git) ) " +
        "&& command -v git >/dev/null && echo GIT_OK",
      expect: "GIT_OK",
    },
    {
      name: `install Node ${NODE_VERSION}, checksum verified against the published SHASUMS`,
      cmd:
        `cd /opt && curl -fsSL -O https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL} ` +
        `&& curl -fsSL https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt -o SHASUMS256.txt ` +
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
        `echo "node_version=$(node -v)"; echo TOOLCHAIN_OK`,
      expect: "TOOLCHAIN_OK",
    },
    {
      name: `clone Uptime Kuma at ${KUMA_VERSION}, pinned and shallow`,
      cmd:
        `rm -rf ${SRC} && git clone --depth 1 --branch ${KUMA_VERSION} ` +
        `https://github.com/louislam/uptime-kuma.git ${SRC} ` +
        `&& cd ${SRC} && test -f package.json ` +
        `&& echo "commit=$(git rev-parse --short HEAD)" && echo CLONE_OK`,
      expect: "CLONE_OK",
    },
    {
      name: "assert the installed Node satisfies what Uptime Kuma declares",
      // Excalidraw's first build died because we installed a Node its engines
      // field forbade. Pinning the declared range means a future version bump
      // that changes it fails here, in seconds, rather than mid-install.
      cmd:
        `cd ${SRC} && export PATH=${NODE_DIR}/bin:$PATH && ` +
        `DECL=$(python3 -c "import json;print(json.load(open('package.json'))['engines']['node'])"); ` +
        `echo "declared_node_range=$DECL"; ` +
        `test "$DECL" = "${KUMA_NODE_RANGE}" || { echo ENGINE_RANGE_CHANGED; exit 1; }; ` +
        `MAJ=$(node -p "process.versions.node.split('.')[0]"); ` +
        `echo "installed_node_major=$MAJ"; ` +
        `test "$MAJ" -ge 20 || { echo NODE_OUT_OF_RANGE; exit 1; }; ` +
        `echo ENGINES_OK`,
      expect: "ENGINES_OK",
    },
    {
      name: "enlarge /dev/shm and assert headroom before installing",
      // The same three measurements that took Excalidraw nine attempts to learn.
      cmd:
        `mount -o remount,size=2048M /dev/shm || { echo REMOUNT_FAILED; exit 1; }; ` +
        `AVAIL=$(df -Pm / | awk 'NR==2{print $4}'); SHM=$(df -Pm /dev/shm | awk 'NR==2{print $2}'); ` +
        `echo "disk_avail_mb=$AVAIL"; echo "shm_total_mb=$SHM"; ` +
        `test "$AVAIL" -ge 1200 || { echo NOT_ENOUGH_DISK; exit 1; }; ` +
        `test "$SHM" -ge 1500 || { echo NOT_ENOUGH_SHM_FOR_CACHE; exit 1; }; ` +
        `echo HEADROOM_OK`,
      expect: "HEADROOM_OK",
    },
    "__INSTALL__" as unknown as Step,
    {
      name: "assert the prebuilt dist is really there",
      cmd:
        `test -s ${SRC}/dist/index.html || { echo NO_DIST_INDEX; exit 1; }; ` +
        `JS=$(find ${SRC}/dist -name '*.js' -size +50k | head -1); ` +
        `test -n "$JS" || { echo NO_DIST_BUNDLE; exit 1; }; ` +
        `test -d ${SRC}/node_modules/socket.io-client || { echo NO_SOCKET_CLIENT; exit 1; }; ` +
        `echo "dist_mb=$(du -sm ${SRC}/dist | cut -f1)"; ` +
        `echo "modules_mb=$(du -sm ${SRC}/node_modules | cut -f1)"; ` +
        `echo DIST_OK`,
      expect: "DIST_OK",
    },
    {
      name: "choose SQLite up front, so the server does not sit in its setup wizard",
      // Uptime Kuma 2.x will not accept normal socket connections until a
      // database is chosen. Without this it starts, answers GET / with 200, and
      // refuses every handshake: a health check that passes while the app is
      // unusable, which is the exact failure this project keeps meeting.
      // The wizard's own answer is a one-key file (server/database.js readDBConfig).
      cmd:
        `mkdir -p ${SRC}/data && echo '{"type": "sqlite"}' > ${SRC}/data/db-config.json && ` +
        `python3 -c "import json;d=json.load(open('${SRC}/data/db-config.json'));assert d['type']=='sqlite';print('db_type='+d['type'])" && ` +
        `echo DBCONFIG_OK`,
      expect: "DBCONFIG_OK",
    },
    {
      name: "start the server and write its pidfile",
      cmd:
        `mkdir -p /var/log/blink ${SRC}/data && cd ${SRC} && ` +
        `export PATH=${NODE_DIR}/bin:$PATH && ` +
        // Writes its own PID before exec, so nothing downstream needs pkill,
        // which this image does not have (V61).
        `setsid sh -c 'echo $$ > ${PIDFILE}; exec node server/server.js --port=${KUMA_PORT} --host=0.0.0.0' ` +
        `>>${LOG} 2>&1 & ` +
        `sleep 3; test -s ${PIDFILE} || { echo NO_PIDFILE; exit 1; }; ` +
        `echo "server_pid=$(cat ${PIDFILE})"; echo SERVER_OK`,
      expect: "SERVER_OK",
    },
    "__HEALTH_POLL__" as unknown as Step,
    {
      name: "seed the admin user and loopback monitors over the app's own socket.io",
      cmd:
        `cd ${SRC} && export PATH=${NODE_DIR}/bin:$PATH && ` +
        // The script goes INSIDE the app directory, not /tmp. Node resolves
        // `require` from the script's own directory, not the working directory,
        // so a seed in /tmp would look in /tmp/node_modules and /node_modules and
        // fail to find socket.io-client, which exists only in the app's tree.
        `cat > ${SRC}/blink-seed.cjs <<'SEEDEOF'\n${SEED_SCRIPT}\nSEEDEOF\n` +
        // Every one of these prints something. The first attempt failed with
        // completely empty output, which is the least useful failure available:
        // it cannot distinguish "the file was not written" from "node is not on
        // PATH" from "the script threw before its first log line".
        `test -s ${SRC}/blink-seed.cjs || { echo NO_SEED_FILE_WRITTEN; exit 1; }; ` +
        `echo "seed_bytes=$(wc -c < ${SRC}/blink-seed.cjs)"; ` +
        `command -v node >/dev/null || { echo NODE_NOT_ON_PATH; exit 1; }; ` +
        `test -d ${SRC}/node_modules/socket.io-client || { echo NO_SOCKET_IO_CLIENT; exit 1; }; ` +
        // 2>&1 so a stack trace cannot vanish into a stream nobody prints.
        // On failure, bring the SERVER's account of the rejection into the same
        // output as the client's. "server error" is what the client sees when
        // the handshake is refused, and it is the server that knows why.
        `node ${SRC}/blink-seed.cjs 2>&1; RC=$?; echo "seed_exit=$RC"; ` +
        `if [ "$RC" -ne 0 ]; then echo "--- server log ---"; ` +
        `tr '\\r' '\\n' < ${LOG} 2>/dev/null | tr -cd '[:print:]\\n' | tail -30; fi`,
      expect: "SEED_OK",
    },
    {
      name: "prove the seed landed by reading it back, not by trusting the callback",
      cmd:
        `cd ${SRC} && export PATH=${NODE_DIR}/bin:$PATH && ` +
        // Reads the database the app actually wrote. A callback saying ok is the
        // app's opinion; a row is evidence.
        `node -e "` +
        `const s=require('@louislam/sqlite3');` +
        `const db=new s.Database('./data/kuma.db', s.OPEN_READONLY, (e)=>{if(e){console.log('NO_DB');process.exit(1)}});` +
        `db.get('select (select count(*) from user) u, (select count(*) from monitor) m', (e,r)=>{` +
        `if(e){console.log('QUERY_FAILED: '+e.message);process.exit(1)}` +
        `console.log('seeded_users='+r.u);console.log('seeded_monitors='+r.m);` +
        `if(r.u<1||r.m<2){console.log('SEED_NOT_PERSISTED');process.exit(1)}` +
        `console.log('SEED_VERIFIED');process.exit(0)})"`,
      expect: "SEED_VERIFIED",
    },
    bootScriptStep(PIDFILE, LOG),
    proveSelfDestructStep(PIDFILE),
    {
      name: "verify the served state one last time before snapshotting",
      // Written as separate reporting statements, not one `a && b && echo OK`
      // chain. A chain like that emits NOTHING when a middle link fails, which
      // is how this step first failed: an empty diagnostic for a redirect.
      cmd:
        // The seed script carries the seed password in plain text and would
        // otherwise be baked into every instance forked from this snapshot.
        `rm -f ${SRC}/blink-seed.cjs; ` +
        `test ! -e ${SRC}/blink-seed.cjs || { echo SEED_SCRIPT_NOT_REMOVED; exit 1; }; ` +
        // -L, because once an admin exists Uptime Kuma redirects / to the
        // dashboard. The first version demanded a bare 200 and got a 302.
        `CODE=$(curl -sS -L -o /dev/null -w '%{http_code}' http://127.0.0.1:${KUMA_PORT}/); ` +
        `echo "http_code=$CODE"; ` +
        `test "$CODE" = "200" || { echo UNEXPECTED_HTTP_CODE; exit 1; }; ` +
        `echo "oom_lines=$(dmesg 2>/dev/null | grep -ci 'out of memory' || true)"; ` +
        `echo "db_bytes=$(wc -c < ${SRC}/data/kuma.db)"; ` +
        `echo VERIFY_OK`,
      expect: "VERIFY_OK",
    },
  ];
}

/**
 * Complete a WebSocket handshake through the preview domain, from outside.
 *
 * This is the point of the whole recipe. Every gate so far has proven that the
 * preview proxy carries request and response; none has proven it carries an
 * HTTP Upgrade. If it does not, Uptime Kuma renders a shell and never populates,
 * while the health check stays green, because the health check is a GET.
 *
 * The check speaks engine.io's protocol directly rather than pulling in a
 * client: connecting to `/socket.io/?EIO=4&transport=websocket` must produce an
 * OPEN packet, which is a frame beginning with `0` and carrying a session id.
 * Receiving that frame means the upgrade survived the proxy end to end.
 *
 * WHAT THIS DOES NOT PROVE, stated because it would otherwise read as a full
 * pass. Node's WebSocket sends no `Origin` header and provides no way to set
 * one. Uptime Kuma's `allowRequest` explicitly allows a websocket with no
 * origin, and checks `origin.host === host` only when an origin IS present. A
 * browser always sends one. So a pass here means the preview domain carries the
 * upgrade; it does NOT mean a visitor's browser will be admitted, because the
 * check that would reject the browser is the one this client cannot trigger.
 *
 * That gap needs a real browser to close, and it is recorded as Q20 rather than
 * papered over. The alternative fix, setting UPTIME_KUMA_WS_ORIGIN_CHECK=bypass
 * in the snapshot, is deliberately NOT applied here: it would make the app work
 * by disabling a cross-site websocket hijacking defence, which is a security
 * decision to be taken on evidence rather than as a build convenience.
 */
/**
 * Turn a previewUrl into the engine.io WebSocket URL for it.
 *
 * Separated so the URL construction can be tested without a live sandbox. The
 * detail that matters and is easy to lose: the `pt_token` query parameter must
 * survive, because the preview domain rejects a request without it (V21), and
 * naively rebuilding the URL from its host and path drops it.
 */
export function previewWsUrl(previewUrl: string): string {
  const u = new URL(previewUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/socket.io/";
  u.searchParams.set("EIO", "4");
  u.searchParams.set("transport", "websocket");
  return u.toString();
}

export async function websocketThroughPreview(
  previewUrl: string,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; ms: number; detail: string }> {
  const t0 = performance.now();
  const u = new URL(previewWsUrl(previewUrl));

  return await new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* already closing */ }
      resolve({ ok, ms: Math.round(performance.now() - t0), detail });
    };

    const ws = new WebSocket(u.toString());
    const timer = setTimeout(() => done(false, "no OPEN packet before timeout"), timeoutMs);

    ws.onmessage = (ev) => {
      clearTimeout(timer);
      const data = typeof ev.data === "string" ? ev.data : "";
      // engine.io OPEN is packet type 0 followed by a JSON handshake.
      if (!data.startsWith("0")) return done(false, `first frame was not OPEN: ${data.slice(0, 80)}`);
      try {
        const hs = JSON.parse(data.slice(1)) as { sid?: string; pingInterval?: number };
        if (!hs.sid) return done(false, "OPEN packet carried no sid");
        return done(true, `sid received, pingInterval ${hs.pingInterval ?? "unknown"} ms`);
      } catch {
        return done(false, `OPEN packet was not JSON: ${data.slice(0, 80)}`);
      }
    };
    ws.onerror = () => { clearTimeout(timer); done(false, "socket error before any frame"); };
    ws.onclose = (ev) => { clearTimeout(timer); done(false, `closed before OPEN: code ${ev.code}`); };
  });
}

async function build(dryRun: boolean): Promise<number> {
  const steps = kumaSteps();
  safeOut(`\n=== Snapshot: Uptime Kuma ${KUMA_VERSION} (Node ${NODE_VERSION}) ===\n`);
  safeOut(`  ${SIZE_SMALL.cpu} vCPU / ${SIZE_SMALL.memMb} MB. ${steps.length} steps.\n`);
  safeOut(`  Ends by forking the snapshot and completing a WebSocket handshake through previewUrl,\n`);
  safeOut(`  which is the thing no existing gate covers.\n\n`);
  if (dryRun) {
    for (const [i, st] of steps.entries()) {
      const name = (st as Step).name ?? String(st);
      safeOut(`  ${String(i + 1).padStart(2)}. ${name}\n      postcondition: ${(st as Step).expect ?? "special"}\n`);
    }
    safeOut(`  ${steps.length + 1}. fork the snapshot and complete a WebSocket handshake through previewUrl\n`);
    return 0;
  }

  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) { safeErr("SOLARI_API_KEY is not set.\n"); return 2; }
  const plan: Plan = PLANS[(process.env.BLINK_PLAN ?? "starter") as "starter" | "free"]!;
  const guard = new BudgetGuard(plan, 0.08);
  const ledger = new SandboxLedger();
  ledger.install(apiKey);
  const adapter = new SolariAdapter({ counting: createCountingFetch({ caps: CAPS_GATES }), guard, ledger });

  const bornAt = performance.now();
  let sandboxId: string | null = null;
  let snapshotId: string | null = null;
  let forkId: string | null = null;
  let forkBornAt = 0;
  const evidence: string[] = [];

  try {
    const sb = await adapter.createSandbox(
      apiKey, "snapshot:uptime-kuma",
      { template: "base", cpu: SIZE_SMALL.cpu, memMb: SIZE_SMALL.memMb, timeoutMs: 2_700_000,
        lifecycle: { onTimeout: "kill" },
        metadata: { blink_build: "uptime-kuma", blink_version: KUMA_VERSION } },
      0.04,
    );
    sandboxId = sb.value.sandboxId;
    const sh = (cmd: string, o?: { timeoutMs?: number }) =>
      adapter.exec(apiKey, sb.value, "snapshot:uptime-kuma", cmd, o);

    for (const [i, st] of steps.entries()) {
      const t0 = performance.now();
      const label = String(i + 1).padStart(2);

      if ((st as unknown as string) === "__INSTALL__") {
        safeOut(`  ${label}. .... npm ci and dist download (detached, this is the slow one)\n`);
        const b = await runLongInGuest(sh, INSTALL_CMD, {
          marker: "/tmp/blink-install-done", log: INSTALL_LOG,
          // No frontend build here, just npm ci and a dist download, but V63
          // means this may land on one core, so the window covers that case.
          timeoutMs: 1_800_000, intervalMs: 10_000,
          progressEvery: 6,
          onProgress: (sec, line) => safeOut(`      [${String(sec).padStart(4)}s] ${line}\n`),
        });
        safeOut(`      polled ${b.polls} times over ${Math.round(b.ms / 1000)} s, exit ${b.status}\n`);
        if (!b.ok) {
          safeErr(`\n     install failed (exit ${b.status}). Last lines:\n${b.tail.trim().slice(0, 4000)}\n`);
          throw new Error("uptime-kuma install did not succeed");
        }
        evidence.push(`install_ms=${b.ms}`);
        safeOut(`  ${label}. ok   install finished in ${Math.round(b.ms / 1000)} s\n`);
        continue;
      }

      if ((st as unknown as string) === "__HEALTH_POLL__") {
        const h = await waitHealthyInGuest(sh, KUMA_PORT, KUMA_HEALTH, { timeoutMs: 120_000, intervalMs: 1000 });
        safeOut(`      polled ${h.execCalls} times over ${h.ms} ms\n`);
        if (h.ok) evidence.push(`boot_to_healthy_ms=${h.ms}`);
        if (!h.ok) {
          const log = await sh(`tail -20 ${LOG} 2>/dev/null || echo no-log`);
          safeErr(`      tail of uptime-kuma.log:\n${log.value.stdout.trim().slice(0, 900)}\n`);
        }
        safeOut(`  ${label}. ${h.ok ? "ok  " : "FAIL"} health over loopback (${Math.round(performance.now() - t0)} ms)\n`);
        if (!h.ok) throw new Error(`step ${i + 1} (health) postcondition not met`);
        continue;
      }

      const step = st as Step;
      const r = await sh(step.cmd, { timeoutMs: 180_000 });
      const out = `${r.value.stdout}\n${r.value.stderr}`;
      const ms = Math.round(performance.now() - t0);
      const ok = out.includes(step.expect);
      safeOut(`  ${label}. ${ok ? "ok  " : "FAIL"} ${step.name} (${ms} ms)\n`);
      for (const line of out.split("\n")) {
        if (/^(build_|disk_|shm_|mem_|dist_mb|modules_mb|install_|node_version|declared_node_range|installed_node_major|commit|server_pid|http_code|db_bytes|seeded_|socket_connected|admin_created|logged_in|monitors_added|oom_lines)/.test(line.trim())) {
          evidence.push(line.trim());
          safeOut(`      ${line.trim()}\n`);
        }
      }
      if (!ok) {
        safeErr(`\n     expected ${JSON.stringify(step.expect)}, got:\n     ${out.trim().slice(0, 3000)}\n`);
        throw new Error(`step ${i + 1} (${step.name}) postcondition not met`);
      }
    }

    const snap = await adapter.snapshot(apiKey, sb.value, "snapshot:uptime-kuma",
      `uptime-kuma-${KUMA_VERSION}-${new Date().toISOString().slice(0, 10)}`);
    snapshotId = snap.value;
    safeOut(`\n  snapshot ${snapshotId} created in ${snap.ms} ms\n`);
    const reg = loadRegistry();
    // Keyed off APPS rather than a literal. The first version wrote
    // "uptime-kuma" while the registry keys on "uptimekuma", so every gate would
    // have looked it up, missed, and SKIPPED cleanly, which reads exactly like
    // a snapshot that was never built.
    reg[APPS.uptimekuma!.id] = snapshotId;
    safeWriteJsonSync(REGISTRY_PATH, reg);
    safeOut(`  recorded in ${REGISTRY_PATH}\n`);

    // The build sandbox is killed BEFORE the fork, not after. Starter allows two
    // concurrent sandboxes and the slot check would refuse rather than queue,
    // so holding both would turn a passing check into a refusal.
    await adapter.killQuiet(apiKey, sandboxId, "snapshot:uptime-kuma");
    guard.addSandboxSeconds((performance.now() - bornAt) / 1000, SIZE_SMALL, true, "uptime-kuma snapshot build");
    sandboxId = null;

    safeOut(`\n  --- WebSocket through previewUrl ---\n`);
    forkBornAt = performance.now();
    const fork = await adapter.createSandbox(
      apiKey, "snapshot:uptime-kuma:wscheck",
      { fromSnapshot: snapshotId, cpu: SIZE_SMALL.cpu, memMb: SIZE_SMALL.memMb, timeoutMs: 300_000,
        lifecycle: { onTimeout: "kill" }, metadata: { blink_build: "uptime-kuma-wscheck" } },
      0.02,
    );
    forkId = fork.value.sandboxId;
    const fsh = (cmd: string, o?: { timeoutMs?: number }) =>
      adapter.exec(apiKey, fork.value, "snapshot:uptime-kuma:wscheck", cmd, o);

    const fh = await waitHealthyInGuest(fsh, KUMA_PORT, KUMA_HEALTH, { timeoutMs: 90_000, intervalMs: 500 });
    safeOut(`  forked instance healthy over loopback in ${fh.ms} ms (${fh.execCalls} polls)\n`);
    if (!fh.ok) throw new Error("forked instance never became healthy, so the websocket check would be meaningless");
    evidence.push(`fork_to_healthy_ms=${fh.ms}`);

    const pv = await adapter.previewUrl(apiKey, fork.value, "snapshot:uptime-kuma:wscheck", KUMA_PORT);
    const ws = await websocketThroughPreview(pv.value.url);
    evidence.push(`ws_through_preview=${ws.ok ? "yes" : "no"}`, `ws_handshake_ms=${ws.ms}`);
    safeOut(`  WebSocket through previewUrl: ${ws.ok ? "PASSED" : "FAILED"} in ${ws.ms} ms (${ws.detail})\n`);
    if (!ws.ok) {
      safeErr(
        `\n  FINDING: the preview domain did NOT carry the WebSocket upgrade.\n` +
        `  Uptime Kuma's UI is socket.io end to end, so it would render a shell and never populate,\n` +
        `  while the health check stayed green because the health check is a GET.\n` +
        `  This blocks Uptime Kuma as a catalog app until it is resolved. Detail: ${ws.detail}\n`,
      );
      return 1;
    }
    safeOut(`\n  EVIDENCE: ${evidence.join("  ")}\n`);
  } finally {
    if (sandboxId) {
      await adapter.killQuiet(apiKey, sandboxId, "snapshot:uptime-kuma");
      guard.addSandboxSeconds((performance.now() - bornAt) / 1000, SIZE_SMALL, true, "uptime-kuma snapshot build");
    }
    if (forkId) {
      await adapter.killQuiet(apiKey, forkId, "snapshot:uptime-kuma:wscheck");
      guard.addSandboxSeconds((performance.now() - forkBornAt) / 1000, SIZE_SMALL, true, "uptime-kuma websocket check");
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
