import { safeOut } from "../../src/safe-io.ts";
/**
 * Race audit: probe, do not reason.
 *
 * `reserve` was read-check-write across awaits, and single-threaded JavaScript
 * did not save it. Every site below has the same shape and every one is
 * reachable by two concurrent visitors. Three of them get built tomorrow.
 *
 * Each site is implemented here the OBVIOUS way, the way it would be written
 * without thinking about interleaving, and then raced against a boundary
 * condition. The probe decides, not the argument: a site that does not race is
 * reported as not racing, and one that does is reported with the breach.
 */

type Probe = {
  site: string;
  boundary: string;
  /** Returns [admitted, limit, detail]. */
  run: () => Promise<{ admitted: number; expected: number; detail: string }>;
  /** The lock key that would fix it, if it races. */
  scopeKey: string;
  scopeReason: string;
};

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------

const probes: Probe[] = [
  {
    site: "warm pool: claiming a fork",
    boundary: "one ready fork, two visitors launch the same app at once",
    scopeKey: "app_id",
    scopeReason:
      "Claiming is per app: two visitors launching DIFFERENT apps must not queue behind each other, " +
      "and two launching the same app must. A global lock would serialise every launch on the site.",
    run: async () => {
      const forks = [{ id: "wf_1", app: "gitea", status: "ready" }];
      let claimed = 0;
      const claim = async (app: string) => {
        const f = forks.find((x) => x.app === app && x.status === "ready"); // READ
        await tick();                                                       // await point
        if (!f) return false;                                               // CHECK
        await tick();
        f.status = "claimed";                                               // WRITE
        claimed += 1;
        return true;
      };
      const r = await Promise.all([claim("gitea"), claim("gitea")]);
      return {
        admitted: r.filter(Boolean).length, expected: 1,
        detail: `${claimed} claims recorded against 1 ready fork`,
      };
    },
  },
  {
    site: "queue: promoting an entry",
    boundary: "one free slot, two waiting entries promoted at once",
    scopeKey: "app_id",
    scopeReason:
      "Promotion consumes a slot, and slots are counted per app in the warm pool. Same granularity as " +
      "claiming, so the two can share one lock and cannot deadlock against each other.",
    run: async () => {
      const q = [{ id: "q1", state: "waiting" }, { id: "q2", state: "waiting" }];
      let free = 1;
      const promote = async (id: string) => {
        const e = q.find((x) => x.id === id && x.state === "waiting"); // READ
        await tick();
        if (!e || free <= 0) return false;                             // CHECK
        await tick();
        free -= 1; e.state = "promoted";                               // WRITE
        return true;
      };
      const r = await Promise.all([promote("q1"), promote("q2")]);
      return {
        admitted: r.filter(Boolean).length, expected: 1,
        detail: `free slots left: ${free} (negative means oversold)`,
      };
    },
  },
  {
    site: "slot counter: admitting a launch",
    boundary: "Starter caps 2 sandboxes; 1 in use; three visitors launch at once",
    scopeKey: "global",
    scopeReason:
      "The Solari concurrency cap is per ACCOUNT, not per app, so this one genuinely is global. " +
      "It is the only site here where a global lock is correct rather than lazy, and it is why the " +
      "other sites must not share it: they would inherit a bottleneck they do not need.",
    run: async () => {
      const MAX = 2;
      let live = 1;
      const admit = async () => {
        const n = live;      // READ
        await tick();
        if (n >= MAX) return false; // CHECK
        await tick();
        live += 1;           // WRITE
        return true;
      };
      const r = await Promise.all([admit(), admit(), admit()]);
      return {
        admitted: r.filter(Boolean).length, expected: 1,
        detail: `live sandboxes now ${live} against a hard cap of ${MAX}; over the cap means a 429 from Solari`,
      };
    },
  },
  {
    site: "share snapshots: the 12 live cap",
    boundary: "11 live snapshots, two visitors click Share at once",
    scopeKey: "global",
    scopeReason:
      "The cap is on total live share snapshots for the account, so it is global. Storage is the shared " +
      "resource and Q18 has not established whether it is even billed, which is why the cap exists at all.",
    run: async () => {
      const CAP = 12;
      let live = 11;
      const share = async () => {
        const n = live;               // READ
        await tick();
        if (n >= CAP) return false;   // CHECK
        await tick();
        live += 1;                    // WRITE
        return true;
      };
      const r = await Promise.all([share(), share()]);
      return {
        admitted: r.filter(Boolean).length, expected: 1,
        detail: `${live} live snapshots against a cap of ${CAP}, roughly ${(live * 3.9).toFixed(1)} GB`,
      };
    },
  },
  {
    site: "per-IP daily launch count",
    boundary: "5 launches per IP per day; visitor at 4 opens two tabs",
    scopeKey: "day|ip_hash",
    scopeReason:
      "Per IP per day. Including the day in the key means midnight rollover cannot contend with the " +
      "previous day, and two different visitors never block each other, which matters because this is " +
      "the hottest path on the site.",
    run: async () => {
      const MAX = 5;
      const counts = new Map<string, number>([["ip_a", 4]]);
      const launch = async (ip: string) => {
        const n = counts.get(ip) ?? 0; // READ
        await tick();
        if (n >= MAX) return false;    // CHECK
        await tick();
        counts.set(ip, n + 1);         // WRITE
        return true;
      };
      const r = await Promise.all([launch("ip_a"), launch("ip_a")]);
      return {
        admitted: r.filter(Boolean).length, expected: 1,
        detail: `count now ${counts.get("ip_a")} against a cap of ${MAX}`,
      };
    },
  },
];

// ---------------------------------------------------------------------------

let raced = 0;
safeOut("\nRACE AUDIT: two concurrent callers against a boundary\n");
safeOut("=".repeat(78) + "\n");

for (const p of probes) {
  const { admitted, expected, detail } = await p.run();
  const races = admitted > expected;
  if (races) raced += 1;
  safeOut(`\n${races ? "RACES  " : "safe   "} ${p.site}\n`);
  safeOut(`         boundary: ${p.boundary}\n`);
  safeOut(`         admitted ${admitted}, should admit ${expected}\n`);
  safeOut(`         ${detail}\n`);
  if (races) {
    safeOut(`         lock scope: ${p.scopeKey}\n`);
    safeOut(`         why: ${p.scopeReason}\n`);
  }
}

safeOut(`\n${"=".repeat(78)}\n${raced} of ${probes.length} sites race.\n`);
