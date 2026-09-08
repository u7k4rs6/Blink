/**
 * Liveness checks that exercise each app's REAL interface.
 *
 * This replaces asking whether a process is listening, which is what every
 * health check in this project did until Uptime Kuma proved the two are not the
 * same thing. It refused every socket connection for three consecutive builds,
 * because it was sitting in its database setup wizard, while answering `GET /`
 * with 200 the entire time. The health check asked for that 200 and got it.
 *
 * This is the pkill lesson in a second form. There the postcondition asserted
 * that a script had been written and was executable: both true, and neither the
 * thing that mattered. Here the postcondition asserts that a socket accepted a
 * TCP connection and returned a status line: also true, also not the thing that
 * mattered. In both cases the check tested an arrangement rather than a
 * capability, and in both cases it passed while the capability was absent.
 *
 *   A control is tested by making it fire.
 *   An application is tested by making it work.
 *
 * So each check below does the thing the app exists to do. Gitea writes an issue
 * and reads it back. Jaeger returns a seeded trace. Metabase runs SQL against
 * the sample database. Excalidraw fetches a bundle asset rather than the shell
 * that references it. Uptime Kuma completes a socket handshake.
 *
 * Each returns evidence rather than a boolean, because a canary that says "down"
 * without saying what it asked is a canary that gets ignored.
 */

import { SEEDED } from "../../../src/catalog/credentials.ts";

export type LivenessResult = {
  ok: boolean;
  ms: number;
  /** What was asked, in one line, for the public canary log. */
  asked: string;
  detail: string;
  evidence?: Record<string, string | number>;
};

export type LivenessCheck = (base: string, timeoutMs?: number) => Promise<LivenessResult>;

const DEFAULT_TIMEOUT = 15_000;

/**
 * What a VISITOR's first request actually returns.
 *
 * Every check below exercises an app's real interface, which is the V70 lesson
 * and still right. It is not sufficient. Uptime Kuma passed a socket.io
 * handshake while the first thing a visitor got was a redirect that threw the
 * capability away, and no check looked at the front door at all. A working API
 * and a broken landing page are compatible, and only one of them is the thing
 * the catalog card promises.
 *
 * So this follows redirects the way a browser does, and it has to do two things
 * a plain `fetch` will not:
 *
 * 1. Carry cookies. The preview domain sets `__pt_preview` on the first
 *    response, and from then on the cookie IS the capability. `fetch` has no
 *    cookie jar, so without this the second hop arrives unauthenticated.
 * 2. Re-attach `pt_token` to every hop. Uptime Kuma answers `/` with a 302 to a
 *    relative `/dashboard`, and a relative redirect drops the query string,
 *    which is where the capability lives (V72). A browser survives that on the
 *    cookie alone; anything without a cookie jar gets a 401.
 *
 * Measured, on a live fork: no jar 401, jar 200, token re-attached 200.
 */
export async function firstScreen(
  base: string, timeoutMs: number,
): Promise<{ status: number; url: string; body: string; hops: number; contentType: string }> {
  const token = new URL(base).searchParams.get("pt_token");
  const jar: string[] = [];
  let url = base;
  let hops = 0;

  for (;;) {
    const res = await fetch(url, {
      redirect: "manual",
      headers: jar.length > 0 ? { cookie: jar.join("; ") } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    for (const [k, v] of res.headers) {
      if (k.toLowerCase() === "set-cookie") jar.push(v.split(";")[0]!);
    }
    const loc = res.headers.get("location");
    const redirecting = loc !== null && res.status >= 300 && res.status < 400;
    if (!redirecting || hops >= 5) {
      return {
        status: res.status, url, hops,
        contentType: res.headers.get("content-type") ?? "",
        body: (await res.text()).slice(0, 20_000),
      };
    }
    const next = new URL(loc, url);
    // The capability the redirect just discarded.
    if (token && !next.searchParams.has("pt_token")) next.searchParams.set("pt_token", token);
    url = next.toString();
    hops += 1;
  }
}

/**
 * Assert the landing page is the app, not a 404, a redirect loop or a wall.
 *
 * `expect` is text that must be present in the HTML. Every app declares its own,
 * because "200 and some HTML" is the class of check this whole file exists to
 * replace.
 */
export async function landingOk(
  base: string, expect: RegExp, timeoutMs: number,
): Promise<{ ok: boolean; detail: string; evidence: Record<string, string | number> }> {
  const r = await firstScreen(base, timeoutMs);
  const ev = { landing_status: r.status, landing_hops: r.hops, landing_type: r.contentType.split(";")[0] ?? "" };
  if (r.status !== 200) {
    return { ok: false, detail: `a visitor's first request ended at ${r.status} after ${r.hops} redirect(s)`, evidence: ev };
  }
  if (!expect.test(r.body)) {
    return { ok: false, detail: `landing page was 200 but did not contain ${String(expect)}`, evidence: ev };
  }
  return { ok: true, detail: `landing page 200 after ${r.hops} redirect(s)`, evidence: ev };
}

/** `fetch` with a timeout and no retry. There is no retry loop in this codebase. */
async function get(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return await fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Join a path onto a preview base URL, KEEPING the capability token.
 *
 * Two ways to get this wrong, and the first version of this file managed both.
 *
 * String concatenation puts the path after the query: `https://h/?pt_token=X`
 * plus `/api/v1/thing` gives `https://h/?pt_token=X/api/v1/thing`, which is one
 * URL with a strange token and no path.
 *
 * `new URL(path, base)` fixes that and silently drops the query, so every
 * request after the first arrives without a capability and gets a 401. The soak
 * caught exactly this on Excalidraw's bundle fetch: the shell loaded because its
 * URL carried the token, and the bundle it referenced did not.
 *
 * A browser would not have noticed, because it keeps the `__pt_preview` cookie
 * the first response sets (V60). A plain fetch client keeps no cookie jar, so it
 * has to carry the token on every request.
 */
function at(base: string, path: string): string {
  const b = new URL(base);
  const token = b.searchParams.get("pt_token");
  const out = new URL(path, b);
  if (token) out.searchParams.set("pt_token", token);
  return out.toString();
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function done(t0: number, ok: boolean, asked: string, detail: string, evidence?: Record<string, string | number>): LivenessResult {
  return { ok, ms: Math.round(performance.now() - t0), asked, detail, evidence };
}

/**
 * Gitea: write an issue through the API and read it back.
 *
 * A write, not a read, because a read-only check passes against a Gitea whose
 * database is mounted read-only or whose disk is full, which is a real state
 * this project has already produced twice (V62, V67).
 */
export const giteaLiveness: LivenessCheck = async (base, timeoutMs = DEFAULT_TIMEOUT) => {
  const t0 = performance.now();
  const asked = "loaded the landing page, then created an issue through the API and read it back";
  const { user, password, repo } = SEEDED.gitea;
  /**
   * Unique per run, and legible.
   *
   * It was `blink-canary-${Date.now()}`, which is unique but reads as noise on
   * the issue list. That list is what the catalog card photographs, so the row
   * the canary writes is public: it should say what wrote it and when. The
   * milliseconds stay, because the read back only proves anything if the title
   * it compares could not have come from a previous run.
   */
  const title = `Blink canary check ${new Date().toISOString().replace("T", " ").replace("Z", "")} UTC`;
  try {
    /*
     * The front door first. A visitor's first request has to land on the app
     * before anything the app can do afterwards is worth reporting.
     */
    const landing = await landingOk(base, /Sign In|Explore|Gitea/, timeoutMs);
    if (!landing.ok) return done(t0, false, asked, landing.detail, landing.evidence);
    const created = await get(at(base, `/api/v1/repos/${user}/${repo}/issues`), {
      method: "POST",
      headers: { Authorization: basic(user, password), "Content-Type": "application/json" },
      body: JSON.stringify({ title, body: "Written by the Blink canary." }),
    }, timeoutMs);
    if (!created.ok) return done(t0, false, asked, `create returned ${created.status}`);
    const issue = await created.json() as { number?: number };
    if (typeof issue.number !== "number") return done(t0, false, asked, "create returned no issue number");

    const read = await get(at(base, `/api/v1/repos/${user}/${repo}/issues/${issue.number}`), {
      headers: { Authorization: basic(user, password) },
    }, timeoutMs);
    if (!read.ok) return done(t0, false, asked, `read back returned ${read.status}`);
    const got = await read.json() as { title?: string };
    if (got.title !== title) return done(t0, false, asked, `read back the wrong issue: ${got.title}`);
    return done(t0, true, asked, `issue #${issue.number} written and read back`, { issue: issue.number });
  } catch (e) {
    return done(t0, false, asked, `${(e as Error).name}: ${(e as Error).message}`);
  }
};

/** Jaeger: return a seeded trace, with spans, for the seeded service. */
export const jaegerLiveness: LivenessCheck = async (base, timeoutMs = DEFAULT_TIMEOUT) => {
  const t0 = performance.now();
  const asked = `loaded the landing page, then queried a trace for the seeded service "${SEEDED.jaeger.service}"`;
  try {
    /*
     * The front door first. A visitor's first request has to land on the app
     * before anything the app can do afterwards is worth reporting.
     */
    const landing = await landingOk(base, /Jaeger UI|<div id=\"jaeger-ui-root\"/, timeoutMs);
    if (!landing.ok) return done(t0, false, asked, landing.detail, landing.evidence);
    const r = await get(at(base, `/api/traces?service=${SEEDED.jaeger.service}&limit=1`), {}, timeoutMs);
    if (!r.ok) return done(t0, false, asked, `traces query returned ${r.status}`);
    const body = await r.json() as { data?: Array<{ traceID?: string; spans?: unknown[] }> };
    const trace = body.data?.[0];
    if (!trace?.traceID) return done(t0, false, asked, "the UI is up but has no traces, which is an empty screen");
    const spans = trace.spans?.length ?? 0;
    // A trace with no spans renders as a blank detail page.
    if (spans === 0) return done(t0, false, asked, "trace returned with zero spans");
    return done(t0, true, asked, `trace with ${spans} spans`, { spans });
  } catch (e) {
    return done(t0, false, asked, `${(e as Error).name}: ${(e as Error).message}`);
  }
};

/**
 * Excalidraw: fetch a bundle asset, not the shell that references it.
 *
 * `GET /` returns index.html from any static server, including one serving an
 * empty directory with a leftover template. The bundle is the artefact.
 */
export const excalidrawLiveness: LivenessCheck = async (base, timeoutMs = DEFAULT_TIMEOUT) => {
  const t0 = performance.now();
  const asked = "loaded the landing page, then fetched the JS bundle and a font";
  try {
    /*
     * The front door first. A visitor's first request has to land on the app
     * before anything the app can do afterwards is worth reporting.
     */
    const landing = await landingOk(base, /Excalidraw/, timeoutMs);
    if (!landing.ok) return done(t0, false, asked, landing.detail, landing.evidence);
    const shell = await get(at(base, "/"), {}, timeoutMs);
    if (!shell.ok) return done(t0, false, asked, `shell returned ${shell.status}`);
    const html = await shell.text();
    const m = html.match(/src="([^"]+\.js)"/) ?? html.match(/href="([^"]+\.js)"/);
    if (!m) return done(t0, false, asked, "the shell references no JS bundle at all");
    const bundleUrl = at(base, m[1]!);
    const bundle = await get(bundleUrl, {}, timeoutMs);
    if (!bundle.ok) return done(t0, false, asked, `bundle returned ${bundle.status}`);
    const bytes = (await bundle.arrayBuffer()).byteLength;
    // A 404 page served with status 200 is small; a real bundle is not.
    if (bytes < 50_000) return done(t0, false, asked, `bundle was only ${bytes} bytes, which is not a build`);

    const font = await get(at(base, "/Virgil.woff2"), {}, timeoutMs);
    const fontBytes = font.ok ? (await font.arrayBuffer()).byteLength : 0;
    if (fontBytes === 0) return done(t0, false, asked, "the hand-drawn font is missing, so it renders wrong");
    return done(t0, true, asked, `bundle ${bytes} bytes, font ${fontBytes} bytes`, { bundleBytes: bytes, fontBytes });
  } catch (e) {
    return done(t0, false, asked, `${(e as Error).name}: ${(e as Error).message}`);
  }
};

/** Metabase: authenticate, then run SQL against the bundled sample database. */
export const metabaseLiveness: LivenessCheck = async (base, timeoutMs = DEFAULT_TIMEOUT) => {
  const t0 = performance.now();
  const asked = "loaded the landing page, then ran a SQL query against the sample database";
  const { user, password } = SEEDED.metabase;
  try {
    /*
     * The front door first. A visitor's first request has to land on the app
     * before anything the app can do afterwards is worth reporting.
     */
    const landing = await landingOk(base, /Metabase|<div id=\"root\"/, timeoutMs);
    if (!landing.ok) return done(t0, false, asked, landing.detail, landing.evidence);
    const s = await get(at(base, "/api/session"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password }),
    }, timeoutMs);
    if (!s.ok) return done(t0, false, asked, `session returned ${s.status}`);
    const { id } = await s.json() as { id?: string };
    if (!id) return done(t0, false, asked, "session returned no token");

    const dbs = await get(at(base, "/api/database"), { headers: { "X-Metabase-Session": id } }, timeoutMs);
    if (!dbs.ok) return done(t0, false, asked, `database list returned ${dbs.status}`);
    const list = await dbs.json() as { data?: Array<{ id: number; name: string }> };
    const sample = list.data?.find((d) => /sample/i.test(d.name)) ?? list.data?.[0];
    if (!sample) return done(t0, false, asked, "no database is attached, so every question is empty");

    const q = await get(at(base, "/api/dataset"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Metabase-Session": id },
      body: JSON.stringify({
        type: "native", database: sample.id,
        native: { query: "select count(*) as n from orders" },
      }),
    }, timeoutMs);
    if (!q.ok) return done(t0, false, asked, `query returned ${q.status}`);
    const res = await q.json() as { data?: { rows?: unknown[][] }; status?: string };
    const rows = res.data?.rows ?? [];
    if (rows.length === 0) return done(t0, false, asked, `query ran but returned no rows (status ${res.status})`);
    return done(t0, true, asked, `select count(*) returned ${JSON.stringify(rows[0])}`, { rows: rows.length });
  } catch (e) {
    return done(t0, false, asked, `${(e as Error).name}: ${(e as Error).message}`);
  }
};

/**
 * Uptime Kuma: complete an engine.io handshake.
 *
 * Its entire UI is socket.io, so HTTP status codes say nothing about it. See
 * Q20: this speaks the protocol without an Origin header, which is the branch
 * Uptime Kuma allows unconditionally, so it proves the transport and not the
 * origin check.
 */
export const uptimeKumaLiveness: LivenessCheck = async (base, timeoutMs = DEFAULT_TIMEOUT) => {
  const t0 = performance.now();
  const asked = "loaded the landing page a visitor gets, then completed a socket.io handshake";
  try {
    /*
     * The front door first. A visitor's first request has to land on the app
     * before anything the app can do afterwards is worth reporting.
     */
    const landing = await landingOk(base, /Uptime Kuma|<div id=\"app\"/, timeoutMs);
    if (!landing.ok) return done(t0, false, asked, landing.detail, landing.evidence);
    const u = new URL(base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/socket.io/";
    u.searchParams.set("EIO", "4");
    u.searchParams.set("transport", "websocket");
    return await new Promise<LivenessResult>((resolve) => {
      let settled = false;
      const finish = (ok: boolean, detail: string, ev?: Record<string, string | number>) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* already closing */ }
        resolve(done(t0, ok, asked, detail, ev));
      };
      const ws = new WebSocket(u.toString());
      const timer = setTimeout(() => finish(false, "no OPEN packet before timeout"), timeoutMs);
      ws.onmessage = (ev) => {
        clearTimeout(timer);
        const data = typeof ev.data === "string" ? ev.data : "";
        if (!data.startsWith("0")) return finish(false, `first frame was not OPEN: ${data.slice(0, 60)}`);
        try {
          const hs = JSON.parse(data.slice(1)) as { sid?: string; pingInterval?: number };
          if (!hs.sid) return finish(false, "OPEN packet carried no sid");
          return finish(true, `handshake completed, pingInterval ${hs.pingInterval}`, { pingInterval: hs.pingInterval ?? 0 });
        } catch { return finish(false, "OPEN packet was not JSON"); }
      };
      ws.onerror = () => { clearTimeout(timer); finish(false, "socket error before any frame"); };
      ws.onclose = (ev) => { clearTimeout(timer); finish(false, `closed before OPEN: code ${ev.code}`); };
    });
  } catch (e) {
    return done(t0, false, asked, `${(e as Error).name}: ${(e as Error).message}`);
  }
};

export const LIVENESS: Record<string, LivenessCheck> = {
  gitea: giteaLiveness,
  jaeger: jaegerLiveness,
  excalidraw: excalidrawLiveness,
  metabase: metabaseLiveness,
  uptimekuma: uptimeKumaLiveness,
};

/** Every catalog app must have one. A missing check is a card we cannot promise. */
export function livenessFor(appId: string): LivenessCheck {
  const c = LIVENESS[appId];
  if (!c) throw new Error(`no liveness check for "${appId}": every catalog card needs one`);
  return c;
}
