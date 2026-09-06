/**
 * The Uptime Kuma monitors: what they are, and how a fork refreshes them.
 *
 * Split out of the recipe because the app registry needs the fork time command
 * and the recipe imports the app registry. Nothing in here may import the
 * registry back, or the cycle returns as an undefined at module load: the first
 * version of this crashed every test file that touched the registry with
 * "Cannot access MONITOR_REFRESH_CMD before initialization".
 */

import { SEEDED } from "../../../src/catalog/credentials.ts";

export const KUMA_PORT = 3001;
export const KUMA_NODE_VERSION = "v22.23.2";
export const KUMA_NODE_DIR = `/opt/node-${KUMA_NODE_VERSION}-linux-x64`;
export const KUMA_SRC = "/opt/uptime-kuma";

/** Seed credentials. Public by design: the instance is disposable and single-visitor. */
export const SEED_USER = SEEDED.uptimekuma.user;
export const SEED_PASS = SEEDED.uptimekuma.password;

/**
 * What the seeded monitors are, in one place.
 *
 * Both were named "This instance (HTTP)" and "This instance (dashboard)" and
 * both pointed at "/". The sidebar truncates to the width of the column, so the
 * card showed "This instance..." twice: two rows a reader cannot tell apart,
 * describing two checks that really were identical. The names now differ in the
 * first word and each one names the path it actually requests.
 *
 * Read by the seed script (which creates them) and by the refresh script (which
 * renames them at fork time on snapshots built before this change), so the two
 * cannot drift. Both are covered by the loopback-only test, which reads this.
 */
export const SEEDED_MONITORS = [
  { name: "Web endpoint (/)", url: `http://127.0.0.1:${KUMA_PORT}/` },
  { name: "Dashboard route (/dashboard)", url: `http://127.0.0.1:${KUMA_PORT}/dashboard` },
] as const;

/** Every URL a seeded monitor may point at. Loopback only, checked by test. */
export const SEEDED_MONITOR_TARGETS = SEEDED_MONITORS.map((m) => m.url);


/**
 * Rename the monitors and restart their checks, run in the guest after a fork.
 *
 * Two things were wrong with the captured card and only one can be fixed in the
 * snapshot. The names are baked in, so a rebuild fixes those. The timestamps are
 * not: the newest heartbeat in a snapshot is from the day the snapshot was
 * built, so every instance forked from it opens showing a check that last ran
 * weeks ago. That is stale by construction and no rebuild helps, which is the
 * same reason Jaeger has a postFork.
 *
 * editMonitor restarts the monitor, which fires a heartbeat immediately, so the
 * old beats stay as history and a current one lands on top. Tightening the
 * interval to 20s means a second beat arrives before the screenshot does.
 *
 * This goes through the app's own socket.io API, the same path the seed and the
 * UI use. Writing kuma.db directly under a running server would have been
 * quicker and would have been read back into nothing, because Uptime Kuma holds
 * the monitor list in memory.
 */
export const MONITOR_REFRESH_SCRIPT = `
const { io } = require("socket.io-client");
const sock = io("http://127.0.0.1:${KUMA_PORT}", { reconnection: false, timeout: 15000 });

const call = (ev, ...args) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("timeout on " + ev)), 15000);
  sock.emit(ev, ...args, (r) => { clearTimeout(t); r && r.ok === false ? rej(new Error(ev + ": " + r.msg)) : res(r); });
});

// The server pushes monitorList after login rather than answering a request for
// it, so it is captured from the event and waited for below.
let list = null;
sock.on("monitorList", (l) => { list = l; });

(async () => {
  await new Promise((res, rej) => {
    sock.on("connect", res);
    sock.on("connect_error", (e) => rej(new Error("socket connect_error: " + e.message)));
    setTimeout(() => rej(new Error("socket never connected")), 15000);
  });
  await call("login", { username: "${SEED_USER}", password: "${SEED_PASS}", token: "" });

  for (let i = 0; i < 60 && !list; i++) await new Promise((r) => setTimeout(r, 200));
  if (!list) throw new Error("monitorList never arrived");

  const plan = ${JSON.stringify(SEEDED_MONITORS)};
  const live = Object.values(list).sort((a, b) => a.id - b.id);
  if (live.length === 0) throw new Error("no monitors on this instance");

  let n = 0;
  for (let i = 0; i < live.length && i < plan.length; i++) {
    // Spread the live monitor first: editMonitor wants the whole object and a
    // partial one blanks the fields it omits.
    await call("editMonitor", { ...live[i], name: plan[i].name, url: plan[i].url, interval: 20, retryInterval: 20 });
    n++;
  }
  console.log("monitors_refreshed=" + n);

  // Uptime Kuma logs an event only when a monitor CHANGES state, so the newest
  // row in the event table is the one written when the snapshot was built. The
  // heartbeats and the uptime percentages are worth keeping, and they are; the
  // single stale row is not, and it is the only date on the page. Clearing it
  // and cycling the monitor makes the resume beat important, which writes a row
  // dated now. This is exactly what the Clear Data button in the UI does.
  for (const m of live.slice(0, plan.length)) {
    await call("clearEvents", m.id);
    await call("pauseMonitor", m.id);
    await call("resumeMonitor", m.id);
  }
  console.log("monitors_cycled=" + Math.min(live.length, plan.length));

  sock.close();
  console.log("REFRESH_OK");
  process.exit(0);
})().catch((e) => { console.error("REFRESH_FAILED: " + e.message); process.exit(1); });
`;

/** The guest command that runs it. Referenced by the app registry's postFork. */
export const MONITOR_REFRESH_CMD =
  `cd ${KUMA_SRC} && export PATH=${KUMA_NODE_DIR}/bin:$PATH && ` +
  // In SRC, not /tmp: node resolves socket.io-client from the cwd upwards and
  // /tmp has no node_modules above it. The seed step learned this already.
  `cat > ${KUMA_SRC}/blink-refresh.cjs <<'REFRESHEOF'\n${MONITOR_REFRESH_SCRIPT}\nREFRESHEOF\n` +
  `node ${KUMA_SRC}/blink-refresh.cjs; RC=$?; rm -f ${KUMA_SRC}/blink-refresh.cjs; ` +
  `test $RC -eq 0 || exit $RC; ` +
  // Let a second heartbeat land, so the chart has more than one point on it by
  // the time the screenshot is taken.
  `sleep 16; echo POSTFORK_OK`;
