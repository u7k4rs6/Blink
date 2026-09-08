/**
 * Catalog apps and the snapshot registry the gates fork from.
 *
 * Ports, health paths and sizes come from docs/02-architecture.md section 5,
 * whose recipes were corrected by Phase 0 (00-verification.md V45 to V50).
 *
 * The gates do NOT build snapshots. Snapshot building is day-2 product work and
 * is deliberately out of the harness. A gate that needs a snapshot reads its id
 * from the registry and SKIPS cleanly if it is absent, rather than inventing
 * one or silently measuring something else.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SIZE_LARGE, SIZE_SMALL, type Size } from "../../../src/guard/rates.ts";
import {
  WELCOME_SCENE_B64, WELCOME_SCENE_ELEMENTS, WELCOME_SCENE_MARKER,
} from "../../snapshots/lib/welcome-scene.ts";
import { MONITOR_REFRESH_CMD } from "../../snapshots/lib/kuma-monitors.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const REGISTRY_PATH = join(root, "scripts", "gates", "snapshots.json");

export type App = {
  id: string;
  name: string;
  port: number;
  healthPath: string;
  size: Size;
  /** Expected in the health response body, when a status code is not enough. */
  expectBody?: string;
  /**
   * Run inside the guest after health, before handover.
   *
   * For apps whose seeded data is only meaningful relative to NOW. Jaeger is the
   * case that forced this: its traces were seeded when the snapshot was built,
   * and Jaeger's default query window looks back only a short period, so a
   * two day old snapshot opens on an empty screen while still holding 64
   * traces. Verified by probe: default lookback returned 0, an explicit seven
   * day window returned 64.
   *
   * Refreshing the data at launch is the honest fix. Widening the canary's query
   * instead would have made the check pass while every visitor still saw an
   * empty screen, which is the failure this whole project keeps finding.
   */
  postFork?: string;
  /**
   * Where the canary points a browser for the card screenshot.
   *
   * `/` is almost never right. Gitea's root is a logged out marketing page;
   * Jaeger's is an empty search form. The card is meant to show the app doing
   * the thing it was seeded to do, so each app names the view that proves it.
   */
  /**
   * Where the VISITOR is dropped, which must be where the card's screenshot was
   * taken. Defaults to shotPath, because the two being different is the defect.
   *
   * Every card photographed a deliberately chosen deep path while the handover
   * dropped the visitor at "/". So Gitea's card showed the seeded repo and the
   * visitor got Gitea's marketing page; Jaeger's showed six traces and the
   * visitor got an empty search form (V103). Making the screenshots prove the
   * instance was populated made them less representative of the arrival, and
   * nothing compared the two until somebody clicked the button.
   *
   * A postFork may override this at runtime by printing `BLINK_LANDING=<path>`,
   * which is how Metabase lands on a question whose id it only learns on boot.
   */
  landingPath?: string;
  shotPath?: string;
  /**
   * A JS expression that must be true in the page before a shot is published.
   *
   * The capture used to fire wherever the app happened to be. Three of five
   * cards showed an untouched default screen while every check was green, which
   * is the health check bug with a camera on it: proof the app is up, not proof
   * it has content. Each expression names the seeded state for that app.
   */
  shotExpect?: string;
  /**
   * JS run in the page before capture, for apps that gate their real state
   * behind a login. 04-frontend-spec.md section 9 note 2 predicted this for
   * exactly Metabase and Uptime Kuma. Resolves when the page is ready.
   */
  shotScript?: string;
};

export const APPS: Record<string, App> = {
  gitea: {
    id: "gitea", name: "Gitea", port: 3000, healthPath: "/api/healthz", size: SIZE_SMALL,
    // The seeded pull request, which is the thing worth showing. Public repo,
    // so it renders logged out and needs no credentials in the image.
    /**
     * The issue list, not the pull request list.
     *
     * The pull request view is correct and nearly empty: one row on a page of
     * whitespace, under a card promising a repo with things in it. The issue
     * list carries the three seeded issues plus the one the canary just wrote,
     * so the picture shows the seeded state AND the health check that proves it,
     * in the same frame. It also resolves a contradiction the pull request view
     * created: its tab bar read "Issues 4" beside card copy saying three, with
     * nothing on screen to explain that the canary had filed the fourth.
     */
    landingPath: "/blink/welcome/issues",
    shotPath: "/blink/welcome/issues",
    /**
     * The seeded issues, by name, all three of them.
     *
     * The first version of this counted `.issue.list li`, which Gitea 1.27 does
     * not use, so it was ABSENT on a page that was correct. Class names are a
     * theme's business and change between releases; the seeded titles are the
     * thing the card is actually claiming to show. All three, not any one, so a
     * partially seeded repo fails.
     */
    shotExpect: `((t) => /Typo in the README/.test(t)`
      + ` && /Add a contributing guide/.test(t)`
      + ` && /Support dark mode/.test(t))(document.body.innerText)`,
  },
  jaeger: {
    id: "jaeger", name: "Jaeger 2.x all-in-one", port: 16686, healthPath: "/", size: SIZE_SMALL,
    // Drive HotROD so traces exist NOW. Backgrounded and bounded: a visitor
    // must never wait on seed traffic, and a hung curl must not hold handover.
    postFork:
      "( for i in 1 2 3 4 5 6; do " +
      "curl -sf -m 2 -o /dev/null 'http://127.0.0.1:8080/dispatch?customer=123&nonse=0' || true; " +
      "done ) >/dev/null 2>&1 & sleep 3; echo POSTFORK_OK",
    // The trace list for the seeded service, not the empty search form.
    // lookback is REQUIRED by the UI. Without it the search page renders
    // "Failed to fetch trace summaries: 400", which is a worse card than an
    // empty frame because it looks like the app is broken when it is not.
    landingPath: "/search?service=frontend&lookback=1h&limit=20",
    shotPath: "/search?service=frontend&lookback=1h&limit=20",
    // The result count Jaeger prints above the list, which is only rendered
    // once a search has returned. "0 traces" fails, as does the empty state.
    shotExpect: `/\\b([1-9]\\d*) traces? \\(in /.test(document.body.innerText)`,
  },
  excalidraw: {
    id: "excalidraw", name: "Excalidraw", port: 8080, healthPath: "/", size: SIZE_SMALL,
    shotPath: "/",
    /**
     * Write the seeded board at fork time.
     *
     * The current snapshot carries a one line scene, and the card came out as a
     * blank canvas. Rebuilding the snapshot for a drawing would cost a
     * SIZE_LARGE build; writing the file into the fork costs nothing and lands
     * the same bytes, because both sides read WELCOME_SCENE_B64. The recipe
     * writes it too, so a future rebuild does not regress.
     */
    /**
     * Seed the board for EVERY visitor, not just the canary.
     *
     * Writing the scene file was only half of it. Excalidraw reads its document
     * from localStorage, and the only thing that loaded the file into
     * localStorage was the canary's shotScript. So the card showed a diagram
     * and a visitor got the empty splash screen (V103): the screenshot was
     * being produced by machinery the visitor does not have.
     *
     * The fix injects the scene into index.html itself, ahead of the bundle, so
     * the app finds a document already there. Guarded on the key being empty,
     * so a visitor who draws something never has it overwritten by a reload.
     */
    postFork:
      `echo ${WELCOME_SCENE_B64} | base64 -d > /var/www/excalidraw/scenes/welcome.excalidraw && ` +
      `grep -q ${JSON.stringify(WELCOME_SCENE_MARKER)} /var/www/excalidraw/scenes/welcome.excalidraw && ` +
      `python3 - <<'PY'\n` +
      `import json, pathlib\n` +
      `scene = json.load(open("/var/www/excalidraw/scenes/welcome.excalidraw"))\n` +
      `assert len(scene["elements"]) == ${WELCOME_SCENE_ELEMENTS}, len(scene["elements"])\n` +
      `boot = ("<script>try{if(!localStorage.getItem('excalidraw')){"\n` +
      `        "localStorage.setItem('excalidraw', %s);"\n` +
      `        "localStorage.setItem('excalidraw-state', %s);}}catch(e){}</script>") % (\n` +
      `    json.dumps(json.dumps(scene["elements"])), json.dumps(json.dumps(scene.get("appState", {}))))\n` +
      `p = pathlib.Path("/var/www/excalidraw/index.html")\n` +
      `html = p.read_text()\n` +
      `if "blink-seed" not in html:\n` +
      `    p.write_text(html.replace("<head>", "<head><!--blink-seed-->" + boot, 1))\n` +
      `print("scene_elements=%d" % len(scene["elements"]))\n` +
      `print("index_seeded=%s" % ("blink-seed" in p.read_text()))\n` +
      `PY`,
    landingPath: "/",
    shotScript: `
      const r = await fetch("/scenes/welcome.excalidraw" + location.search);
      if (!r.ok) throw new Error("scene fetch " + r.status);
      const d = await r.json();
      if (!Array.isArray(d.elements) || d.elements.length === 0) throw new Error("scene has no elements");
      localStorage.setItem("excalidraw", JSON.stringify(d.elements));
      localStorage.setItem("excalidraw-state", JSON.stringify(d.appState || {}));
      location.reload();
      await new Promise(res => setTimeout(res, 4000));
    `,
    // The scene is loaded and the canvas is mounted, so the shot is not a blank board.
    shotExpect: `(JSON.parse(localStorage.getItem('excalidraw') || '[]')).length >= 10 && !!document.querySelector('canvas')`,
  },
  uptimekuma: {
    id: "uptimekuma", name: "Uptime Kuma", port: 3001, healthPath: "/", size: SIZE_SMALL,
    /**
     * A monitor detail page, not the dashboard index.
     *
     * The index shows a list; the detail page shows the heartbeat bar, the
     * response time chart and the event log, which is where "this instance has
     * actually been checking something" is visible. shotScript clicks through
     * rather than hardcoding /dashboard/1, because a monitor id is a database
     * fact and guessing one lands on a blank page that still screenshots fine.
     */
    landingPath: "/dashboard",
    shotPath: "/dashboard",
    /** Rename the monitors and land fresh heartbeats. See MONITOR_REFRESH_CMD. */
    postFork: MONITOR_REFRESH_CMD,
    // Fills and submits the real login form. Uptime Kuma authenticates over
    // socket.io and keeps its JWT in localStorage, so there is no REST endpoint
    // to call: driving the form is the honest path and the one a visitor takes.
    shotScript: `
      await new Promise(r => setTimeout(r, 2500));
      const set = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const u = document.querySelector('input[type=text], input#floatingInput');
      const p = document.querySelector('input[type=password]');
      if (u && p) {
        set(u, "blink"); set(p, "blink-demo-2026");
        const btn = document.querySelector('button[type=submit]');
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 6000));
      }
      // Open the first monitor the sidebar actually lists. Router push rather
      // than a click, because the row is a link whose href the SPA owns.
      const row = document.querySelector('a[href^="/dashboard/"]');
      if (!row) throw new Error("no monitor in the sidebar after login");
      row.click();
      await new Promise(r => setTimeout(r, 6000));
    `,
    /**
     * A renamed monitor, checking on the fork's schedule, with a current event.
     *
     * The heartbeat bar's own labels are the freshness test. Everything else on
     * this page was already true of the capture that showed a last check three
     * weeks old: the monitor existed, it was up, its uptime was 100 percent.
     * What was missing was evidence it had done anything since the snapshot was
     * built. The bar is labelled with its span at one end and "now" at the
     * other, so "115h" and "now" together assert history AND currency, which is
     * the pair the card is claiming.
     */
    shotExpect: `((t) => /Web endpoint|Dashboard route/.test(t)`
      + ` && /Check every 20 seconds/.test(t)`
      + ` && /\\b\\d+h\\b/.test(t) && /\\bnow\\b/.test(t)`
      + `)(document.body.innerText)`,
  },
  metabase: {
    id: "metabase", name: "Metabase", port: 3000, healthPath: "/api/health", size: SIZE_LARGE,
    /**
     * Create the question the visitor lands on, and name it for the handover.
     *
     * Metabase has no anonymous mode, so a visitor always meets a login. What
     * they must not meet is a login and then Metabase's generic home, while the
     * card shows a table of orders. This saves a real question over the sample
     * database and prints its path, so the login carries a redirect straight to
     * it and the arrival matches the card once they sign in with the
     * credentials the toolbar shows them.
     *
     * The table id is a fact about the database, not a constant: an earlier
     * version guessed one and landed on "This dashboard is empty" (V82).
     */
    postFork:
      `set -e; ` +
      `S=$(curl -s -X POST -H 'Content-Type: application/json' ` +
      `-d '{"username":"blink@example.invalid","password":"blink-demo-2026"}' ` +
      `http://127.0.0.1:3000/api/session | sed 's/.*"id":"\\([^"]*\\)".*/\\1/'); ` +
      `test -n "$S"; ` +
      `T=$(curl -s -H "X-Metabase-Session: $S" http://127.0.0.1:3000/api/table); ` +
      `ID=$(printf '%s' "$T" | python3 -c "` +
      `import sys,json;t=json.load(sys.stdin);` +
      `o=[x for x in t if (x.get('name') or '').lower()=='orders'] or t;` +
      `print(o[0]['id'] if o else '')"); ` +
      `DB=$(printf '%s' "$T" | python3 -c "` +
      `import sys,json;t=json.load(sys.stdin);` +
      `o=[x for x in t if (x.get('name') or '').lower()=='orders'] or t;` +
      `print(o[0]['db_id'] if o else '')"); ` +
      `test -n "$ID"; ` +
      `C=$(curl -s -X POST -H "X-Metabase-Session: $S" -H 'Content-Type: application/json' ` +
      `-d "{\\"name\\":\\"Orders\\",\\"display\\":\\"table\\",\\"visualization_settings\\":{},` +
      `\\"dataset_query\\":{\\"database\\":$DB,\\"type\\":\\"query\\",\\"query\\":{\\"source-table\\":$ID}}}" ` +
      `http://127.0.0.1:3000/api/card | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))"); ` +
      `test -n "$C"; ` +
      // The handover sends them through the login with this as the destination,
      // so one sign in puts them on the same screen the card photographed.
      `echo "BLINK_LANDING=/auth/login?redirect=%2Fquestion%2F$C"; ` +
      `echo "METABASE_CARD=$C"`,
    landingPath: "/auth/login",
    shotPath: "/",
    // Metabase has a real session endpoint, so this authenticates properly and
    // lets the SPA route itself rather than faking a logged in view.
    shotScript: `
      const r = await fetch("/api/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "blink@example.invalid", password: "blink-demo-2026" }),
      });
      if (!r.ok) throw new Error("session " + r.status);
      const cards = await fetch("/api/card").then(x => x.json()).catch(() => []);
      const saved = (cards || []).find(c => c.name === "Orders");
      if (saved) {
        location.href = "/question/" + saved.id;
      } else {
        const tables = await fetch("/api/table").then(x => x.json());
        const t = tables.find(x => /^orders$/i.test(x.name)) || tables[0];
        const q = {
          dataset_query: { database: t.db_id, type: "query", query: { "source-table": t.id } },
          display: "table", visualization_settings: {},
        };
        location.href = "/question#" + btoa(JSON.stringify(q));
      }
      await new Promise(res => setTimeout(res, 14000));
    `,
    // Real cells from the sample database. Measured at 182 on a good capture;
    // a spinner, an error card or "This dashboard is empty" all give zero.
    shotExpect: `/Sample Database|Orders/.test(document.body.innerText)`
      + ` && document.querySelectorAll('[data-testid=cell-data]').length > 20`,
  },
};

/**
 * The apps G1 measures. Small, cheap, and already proven buildable.
 *
 * Overridable with BLINK_G1_APPS, because day 2 runs the three build-changing
 * gates against Gitea alone before Jaeger is built: one app answers all three
 * questions, and waiting on a second recipe would push them past lunch
 * (01-prd.md section 9).
 */
export const G1_APPS: readonly string[] =
  (process.env.BLINK_G1_APPS ?? "gitea,jaeger,excalidraw").split(",").map((a) => a.trim()).filter(Boolean);

/** The apps G2 inspects. Uptime Kuma first when present: it is the websocket case. */
export const G2_APPS: readonly string[] =
  (process.env.BLINK_G2_APPS ?? "uptimekuma,gitea,jaeger").split(",").map((a) => a.trim()).filter(Boolean);

export type SnapshotRegistry = Record<string, string>;

export function loadRegistry(): SnapshotRegistry {
  if (!existsSync(REGISTRY_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Record<string, unknown>;
    const out: SnapshotRegistry = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && v.startsWith("snap_")) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Reason string if the named apps lack snapshots, else null. */
export function missingSnapshots(appIds: readonly string[]): string | null {
  const reg = loadRegistry();
  const missing = appIds.filter((a) => !reg[a]);
  if (missing.length === 0) return null;
  return (
    `no snapshot id for ${missing.join(", ")}. Build the snapshots first (day 2) and record ` +
    `their ids in scripts/gates/snapshots.json, for example {"gitea": "snap_..."}. ` +
    `See scripts/gates/snapshots.example.json.`
  );
}
