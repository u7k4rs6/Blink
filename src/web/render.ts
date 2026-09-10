/**
 * Server-rendered pages. No framework, no build step, no client bundle beyond a
 * few inline scripts that do exactly one thing each.
 *
 * The rule from 04-frontend-spec.md: the data is the visual. Big mono numbers,
 * one accent colour, motion only for the launch reveal.
 */

import { CSS, FONT_LINK } from "./tokens.ts";
import { PIXELS_SCRIPT } from "./pixels.ts";
import { receiptRows, type Receipt } from "./receipt.ts";
import { pillsFor, type TimelineInput } from "./launch-timeline.ts";

/**
 * Join a path onto a preview URL, KEEPING the capability token.
 *
 * Same rule as the liveness checks: the query string IS the credential, so
 * `new URL(path, base)` silently discards it and string concatenation puts the
 * path after the query (V72). The handover link is the one place a visitor
 * notices, because the failure is a 401 on the page they were just promised.
 */
export function at(base: string, path?: string): string {
  if (path === undefined || path === "") return base;
  const b = new URL(base);
  const token = b.searchParams.get("pt_token");
  const out = new URL(path, b);
  if (token !== null) out.searchParams.set("pt_token", token);
  return out.toString();
}

/** Escape everything that reaches HTML. There is no exception to this. */
export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export type App = {
  id: string;
  name: string;
  description: string;
  category: string;
  /** Shown on the card when the app has a login, so the promise matches the arrival. */
  credentials?: { user: string; password: string } | null;
  license: string;
  upstream: string;
  tryFirst: string[];
  /** Null when the canary has never run. Never guessed. */
  lastForkMs: number | null;
  canary: { ok: boolean; asked: string; at: string; downSince?: string };
  shotUrl: string | null;
  shotAt: string | null;
};

export type Board = {
  instancesRunning: number;
  launchedToday: number;
  /** Launch pressed to instance handed over. What the headline calls ready. */
  medianReadyMs: number | null;
  creditsUsedUsd: number;
  creditsCapUsd: number;
  /** Seconds since the last SSE update. Numbers never vanish; the dot goes grey. */
  staleSeconds: number;
};

function page(title: string, body: string, opts: { noindex?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${opts.noindex ? '<meta name="robots" content="noindex, nofollow">' : ""}
<link rel="icon" href="data:image/svg+xml,${
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="%23fff"/><rect x="1" y="1" width="3" height="3" fill="%230A0A0A"/><rect x="4" y="4" width="3" height="3" fill="%23E0492A"/></svg>')
}">
${FONT_LINK}
<style>${CSS}</style>
</head><body>${body}
<script>${PIXELS_SCRIPT}</script></body></html>`;
}

function boardCell(label: string, value: string, extra = ""): string {
  /*
   * A number gets display size. A sentence does not.
   *
   * "no launches yet" set at 38px wrapped onto two lines and read as a headline
   * rather than as the absence of a measurement. The board's whole idea is that
   * the data is the visual, so the type has to know when there is no datum.
   */
  const isNumber = /^[$\d]/.test(value);
  // Value first, label under it. The number is the visual; the label only says
  // which one it is, which is the order a readout on an instrument has.
  return `<div><div class="cell-value${isNumber ? "" : " cell-none"}">${esc(value)}</div>` +
    `<div class="cell-label">${esc(label)}</div>${extra}</div>`;
}

export function renderBoard(b: Board, canaryHistory: Array<boolean | null> = []): string {
  const pct = b.creditsCapUsd > 0 ? Math.min(100, (b.creditsUsedUsd / b.creditsCapUsd) * 100) : 0;
  const stale = b.staleSeconds > 15 ? "1" : "0";
  return `<div class="board"><div class="wrap"><div class="board-grid">
${boardCell("Instances running", String(b.instancesRunning))}
${boardCell("Launched today", String(b.launchedToday))}
${boardCell(
  "Median time to ready",
  b.medianReadyMs === null ? "no launches yet" : `${(b.medianReadyMs / 1000).toFixed(2)}s`,
)}
${boardCell(
  "Credits (estimate)",
  `$${b.creditsUsedUsd.toFixed(2)}`,
  `<div class="gauge"><i style="width:${pct.toFixed(1)}%"></i></div>` +
    `<div class="cell-label gauge-cap">of $${b.creditsCapUsd.toFixed(2)} cap</div>`,
)}
</div>
<div class="board-note">
  <div>
    <div class="label"><span class="staledot" data-stale="${stale}" title="last updated ${esc(b.staleSeconds)}s ago"></span>${
      stale === "1" ? "readout stale, last update " + esc(b.staleSeconds) + "s ago" : "live readout"
    }</div>
    <div class="muted">Every number here is measured. The credit figure is the one estimate: computed locally from published rates, not a bill from Solari.</div>
  </div>
  ${canaryHistory.length > 0 ? heroField(canaryHistory) : ""}
</div>
</div></div>`;
}

function card(app: App, launchesOff = false): string {
  const down = !app.canary.ok;
  const slots = 2;
  const health = app.lastForkMs === null
    ? `<span class="shot-cap">no health data</span>`
    : down
    ? `<span class="fail"><span class="dot" data-s="fail"></span>down</span>`
    : `<span class="ok"><span class="dot"></span>healthy &middot; ${(app.lastForkMs / 1000).toFixed(2)}s</span>`;
  /*
   * The screenshot is a window into the running app, so its state bar says two
   * things and nothing else: is the thing in the picture alive right now, and
   * when was the picture taken.
   */
  const shot = app.shotUrl
    ? `<div class="shot-wrap"><img class="shot" src="${esc(app.shotUrl)}" alt="A real screenshot of ${esc(app.name)} taken by the canary">
       <div class="shot-state">${health}<span class="shot-cap">canary screenshot ${esc(app.shotAt ?? "")}</span></div></div>`
    : `<div class="shot-wrap"><div class="shot" role="img" aria-label="No canary screenshot yet"></div>
       <div class="shot-state">${health}<span class="shot-cap">no canary screenshot yet</span></div></div>`;
  const button = launchesOff
    ? `<button class="btn btn-launch" disabled data-permanently-off="1">Launches paused</button>`
    : down
    ? `<button class="btn btn-launch" disabled data-permanently-off="1">Launch unavailable</button>`
    : `<div class="launch"><span class="slots">${slots} / ${slots} slots free</span>` +
      `<button class="btn btn-launch" data-launch="${esc(app.id)}">Launch <span class="arrow" aria-hidden="true">&#8599;</span></button></div>`;
  return `<article class="card" data-app="${esc(app.id)}">
${shot}
<div class="card-body">
  <div class="card-title"><h2>${esc(app.name)}</h2><span class="cat">${esc(app.category)}</span></div>
  <p class="desc">${esc(app.description)}</p>
  <ol class="try">${app.tryFirst.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
  ${app.credentials ? `<div class="label creds">
    signs you in with ${esc(app.credentials.user)} / ${esc(app.credentials.password)}
  </div>` : ""}
  ${down ? `<p class="fail t-small" style="margin:0">Down since ${esc(app.canary.downSince ?? "recently")}. <a href="/health">See the health wall</a></p>` : ""}
  <div class="card-foot">
    <span>${esc(app.license)}</span><span class="sep">&middot;</span>
    <a href="${esc(app.upstream)}" rel="noopener">upstream &#8599;</a>
  </div>
  <div data-panel="${esc(app.id)}">${button}</div>
</div></article>`;
}

/**
 * The launch panel replaces the card's button in place. No navigation, no modal,
 * because the panel IS the card (section 2).
 */
export function renderLaunchPanel(appId: string, input: TimelineInput, instanceId?: string): string {
  const pills = pillsFor(input);
  return `<div class="panel" data-launching="${esc(appId)}"${instanceId ? ` data-instance="${esc(instanceId)}"` : ""}>
<div class="timer mono" data-timer data-stopped="0">0.00</div>
<div class="muted t-small" data-timer-label>starting</div>
<div class="pills">
${pills.map((p) => `<div class="pill" data-pill="${esc(p.id)}" data-on="0"><i></i>${esc(p.label)}</div>`).join("\n")}
</div>
<div data-reveal hidden></div>
</div>`;
}

/**
 * The instance toolbar. The ONLY place a preview URL is ever rendered.
 *
 * Not on the catalog, not on the health wall, not in an OG image, not in a log
 * line. It goes into the launching visitor's own page and nowhere else, because
 * it is a bearer capability: anyone holding it can use the instance until it
 * expires, and the caption says exactly that rather than implying it is private.
 */
export function renderToolbar(inst: {
  id: string; appName: string; previewUrl: string; msRemaining: number; extended: boolean;
  /** Where the visitor is dropped. Must be where the card's screenshot was taken. */
  landingPath?: string | null;
  /** Shown when the app has a login. Disposable by design, so publishing them is the honest fix. */
  credentials?: { user: string; password: string } | null;
}): string {
  const mins = Math.floor(inst.msRemaining / 60000);
  const secs = Math.floor((inst.msRemaining % 60000) / 1000);
  const open = at(inst.previewUrl, inst.landingPath ?? undefined);
  /*
   * The credentials, on the page, next to the button.
   *
   * Uptime Kuma and Metabase drop a visitor on a password prompt, and the cards
   * claimed "logged in" while the site never showed the password anywhere
   * (V103). These accounts live ten minutes on a machine nobody else can reach,
   * so printing them costs nothing and not printing them cost the whole arrival.
   */
  const creds = inst.credentials
    ? `<div class="panel" style="margin-top:var(--cell);padding:var(--cell)">
    <div class="label">sign in with</div>
    <div class="mono t-body">${esc(inst.credentials.user)} &nbsp; ${esc(inst.credentials.password)}</div>
    <p class="muted t-small" style="margin:6px 0 0">
      This account exists only inside your instance and dies with it in ten minutes.
    </p>
  </div>` : "";
  return `<div class="panel" data-toolbar="${esc(inst.id)}">
  <div class="timer mono" data-countdown data-ms="${inst.msRemaining}">${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}</div>
  <div class="muted t-small">until your ${esc(inst.appName)} is destroyed</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
    <button class="btn btn-ghost" style="width:auto" data-extend="${esc(inst.id)}"${inst.extended ? " disabled" : ""}>
      ${inst.extended ? "extended once" : "Extend +10 min"}
    </button>
    <button class="btn btn-ghost" style="width:auto" data-copy="${esc(inst.id)}" data-copy-go="1">Copy invite link</button>
    <button class="btn btn-ghost" style="width:auto" data-share="${esc(inst.id)}">Share my state</button>
    <a class="btn btn-open" style="width:auto" href="${esc(open)}" target="_blank" rel="noopener noreferrer">Open your ${esc(inst.appName)}</a>
    <button class="btn btn-danger" style="width:auto" data-destroy="${esc(inst.id)}">Destroy</button>
  </div>
  ${creds}
  <p class="muted t-small">anyone with this link can use your instance until it expires</p>
</div>`;
}

/**
 * The instance-ended panel, shown in place of the toolbar once the ten minutes
 * are up or the instance was destroyed.
 *
 * It replaces `<p class="fail">That instance is gone.</p>`, which was accurate
 * and told a visitor nothing: not what happened, not whether they had done
 * something wrong, not what to do next. Clicking the preview link after expiry
 * gets Solari's bare 404, which this cannot change, but the toolbar is Blink's
 * page and Blink knows exactly what happened.
 *
 * Same register as the offline page: say the plain fact first, say it was
 * expected, then give the one action worth taking.
 */
export function renderInstanceEnded(opts: {
  appName: string;
  /** Present when we know it; omitted rather than guessed. */
  lastedMinutes?: number;
  reason: "expired" | "destroyed" | "unknown";
  /** True when reached from a shared invite link rather than by the owner. */
  shared?: boolean;
}): string {
  const what = opts.reason === "destroyed"
    ? `You destroyed your ${esc(opts.appName)}.`
    : opts.reason === "expired"
    ? `Your ${esc(opts.appName)} reached the end of its ten minutes.`
    : `Your ${esc(opts.appName)} has ended.`;
  return `<div class="panel" data-ended="1">
  <h2 class="t-title">${what}</h2>
  <p class="muted" style="margin:0;max-width:44ch">
    It has been destroyed along with everything in it. That is what is supposed to
    happen${opts.lastedMinutes !== undefined ? ` after ${esc(opts.lastedMinutes)} minutes` : ""},
    and nothing went wrong.
  </p>
  <p class="muted t-body" style="margin:0;max-width:44ch">
    The old link will not work any more. It points at a machine that no longer
    exists, so it answers with a bare 404 that does not explain itself.
  </p>
  ${opts.shared ? `<p class="muted t-body" style="margin:0;max-width:44ch">
    Somebody shared this with you while it was running. You can start your own,
    which will be a fresh instance with the same seeded data.
  </p>` : ""}
  <div><a class="btn" style="width:auto;display:inline-block" href="/">${
    opts.shared ? "Launch your own" : "Launch another"
  }</a></div>
</div>`;
}

/**
 * The share page, shown to whoever opens a /s/:token link.
 *
 * Every refusal names its own reason. "This link does not work" tells the
 * holder nothing about whether to ask for a new one, wait, or give up.
 */
export function renderSharePage(opts: {
  appName: string; forkCount: number; token: string;
} | { error: "unknown" | "expired" | "deleted" | "reported" }): string {
  if ("error" in opts) {
    const copy: Record<string, string> = {
      unknown: "That share link does not exist. It may have been mistyped.",
      expired: "That share link has expired. Share links last seven days, and the state behind this one has been deleted.",
      deleted: "The state behind that link has been deleted.",
      reported: "That share link was reported and is no longer available.",
    };
    return `<div class="panel"><h2 style="margin-top:0">Link unavailable</h2>
<p class="muted">${esc(copy[opts.error])}</p>
<p><a href="/">Start a fresh instance instead</a></p></div>`;
  }
  return `<div class="panel"><h2 style="margin-top:0">Someone shared their ${esc(opts.appName)} with you</h2>
<p class="muted">You will get your own copy of their instance, with their work in it. Yours is separate from theirs: nothing you do here reaches them.</p>
<p class="muted mono">forked ${esc(opts.forkCount)} time${opts.forkCount === 1 ? "" : "s"} so far</p>
<button class="btn" data-launch-share="${esc(opts.token)}">Open my copy</button>
<p class="muted t-small" style="margin-bottom:0">
  <a href="/report/${esc(opts.token)}">Report this link</a> if it contains something it should not.
</p></div>`;
}

export function renderReceipt(r: Receipt): string {
  const rows = receiptRows(r);
  return `<div class="panel">
<h3 style="margin-top:0">Session receipt</h3>
${r.lost ? `<p class="fail mono">instance ended early (lost)</p>` : ""}
<table class="receipt">
${rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("\n")}
</table>
<p class="muted t-small" style="margin-bottom:0">${esc(r.note)}</p>
</div>`;
}

/**
 * Wrap a fragment in a full page. `noindex` for anything whose URL carries a
 * token, so a share link cannot be crawled into a search index.
 */
export function shell(inner: string, noindex = false): string {
  return page("Blink", `<main class="wrap" style="padding:40px 16px;max-width:640px">${inner}</main>`, { noindex });
}

/**
 * Where the Source link points.
 *
 * A constant, not a literal in the markup, because it was wrong: it carried a
 * guessed GitHub handle and pointed at an account that is not the author's. A
 * link on a public page that goes to the wrong person is worse than no link.
 * Overridable so the deployment can point at the repository once it is public
 * without an edit here.
 */
export const SOURCE_URL = process.env.BLINK_SOURCE_URL ?? "https://github.com/u7k4rs6";

/**
 * The masthead. One hairline, a wordmark and three links, nothing else.
 */
function masthead(): string {
  return `<header class="masthead">
  <a class="brand" href="/">Blink</a>
  <span class="sys">disposable machines &middot; ten minutes each</span>
  <nav>
    <a href="/health">Health wall</a>
    <a href="${esc(SOURCE_URL)}" rel="noopener">Source</a>
  </nav>
</header>`;
}

/**
 * The hero field: one cell per canary check, drawn from real history.
 *
 * The reference site's hero is a large pixel canvas, and copying an ornament
 * would have been the easy read of it. Blink already has something with the
 * right shape and the advantage of being true: the canary's own pass and fail
 * record, six rows deep. Ink is a pass, red is a fail, and a faint cell is a
 * slot no canary has reached yet, which on a fresh start is most of them.
 *
 * So the biggest decorative element on the page cannot show a healthy pattern
 * unless the checks actually passed. That is the only reason it earns the space.
 */
function heroField(history: Array<boolean | null>): string {
  const cells = history
    .map((h) => `<i data-s="${h === null ? "idle" : h ? "ok" : "fail"}"></i>`)
    .join("");
  const passed = history.filter((h) => h === true).length;
  const ran = history.filter((h) => h !== null).length;
  return `<div class="canary">
  <div class="label"><span class="dot" data-s="${
    ran === 0 ? "off" : passed === ran ? "on" : "fail"
  }"></span>${
    ran === 0 ? "canary record, nothing checked yet" : `canary record, ${passed} of ${ran} checks passed`
  }</div>
  <div class="field" role="img" aria-label="${
    ran === 0 ? "No canary checks recorded yet" : `${passed} of ${ran} canary checks passed`
  }">${cells}</div></div>`;
}

function hero(): string {
  return `<section class="hero" data-ambient="up" data-ambient-below=".kick">
  <div class="wrap">
    <h1><span><span>Press launch.</span></span><span><span>Get a real machine.</span></span></h1>
    <p class="lede">An open source app, seeded and running, yours alone.
    Gone in ten minutes.</p>
    <ol class="steps" aria-label="What happens when you press launch">
      <li data-n="01">fork</li>
      <li data-n="02">health check</li>
      <li data-n="03">url</li>
      <li data-n="04">ten minutes</li>
      <li data-n="05">gone</li>
    </ol>
    <a class="kick" href="#pick">Pick one</a>
  </div>
</section>`;
}

export function renderCatalog(
  board: Board, apps: App[], turnstileSiteKey?: string,
  canaryHistory: Array<boolean | null> = [],
  /** When set, launches are paused and this says why, in the visitor's terms. */
  launchesOff?: string,
): string {
  return page(
    "Blink: your own instance of an open source app, in seconds",
    `${masthead()}
${hero()}
${renderBoard(board, canaryHistory)}
<main class="wrap">
  <div class="pick" id="pick">
  <h2>Pick one.</h2>
  <p class="sub">
    Real upstream builds, already seeded with something to look at. Blink brings the machine.
  </p>
  </div>
  ${launchesOff ? `<p class="warn t-body" style="max-width:52ch;margin:0 0 calc(var(--cell) * 2)">
    <strong>Launches are paused.</strong> ${esc(launchesOff)}
  </p>` : ""}
  ${turnstileSiteKey ? `<div class="verify">
    <div id="ts-widget" class="cf-turnstile"
         data-sitekey="${esc(turnstileSiteKey)}"
         data-callback="blinkTurnstileOk"
         data-error-callback="blinkTurnstileErr"
         data-expired-callback="blinkTurnstileErr"
         data-theme="light"></div>
    <div>
      <div class="label">verification</div>
      <p class="muted">One check, once. A real machine with open outbound network is worth standing in front of.</p>
      <p id="ts-state" class="label" data-state="pending">checking you are a person</p>
    </div>
  </div>` : `<p class="warn t-small" style="max-width:62ch">
    Bot verification is disabled on this instance. Every launch spends real money on a
    machine with unrestricted outbound network, so this is a development setting and
    not a safe one to run publicly.
  </p>`}

  <div class="cards">${apps.map((a) => card(a, launchesOff !== undefined)).join("\n")}</div>
</main>
<footer class="foot">
  <span><a href="/health">Health wall</a> &middot; every check names what it asked</span>
  <span>runs from a laptop &middot; up while it is on</span>
</footer>
${turnstileSiteKey ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}
<script>
// The Turnstile token, captured by the widget's callback.
//
// Tokens are SINGLE USE. After a launch consumes one the widget must be reset,
// or the second launch sends a token the server has already seen and is
// correctly refused. That is the detail most likely to look like a bug.
/*
 * The launch buttons follow the token, because a button that cannot work must
 * not look like one that can.
 *
 * There is ONE widget and ONE token, shared by all five cards. Nothing on any
 * button reflected whether a token existed, so a visitor could press Launch
 * before the check had finished, get missing_token, and see four other cards
 * still looking perfectly ready. Every one of them would have failed the same
 * way. That is the same rule as the paused launches: a disabled button is a
 * decoration unless something actually gates the action.
 */
var blinkTsToken = null;
var blinkTsRequired = document.getElementById("ts-widget") !== null;

function blinkTsSetState(state, text) {
  var el = document.getElementById("ts-state");
  if (el) { el.setAttribute("data-state", state); el.textContent = text; }
  var ready = !blinkTsRequired || blinkTsToken !== null;
  document.querySelectorAll("[data-launch]").forEach(function (b) {
    if (b.getAttribute("data-permanently-off") === "1") return;
    b.disabled = !ready;
    if (!b.hasAttribute("data-label")) b.setAttribute("data-label", b.innerHTML);
    b.innerHTML = ready ? b.getAttribute("data-label") : "Verifying you are a person";
  });
}

function blinkTurnstileOk(t) { blinkTsToken = t; blinkTsSetState("ok", "verified, you can launch"); }
function blinkTurnstileErr() {
  blinkTsToken = null;
  blinkTsSetState("failed", "verification did not complete, reload the page");
}
// Buttons start off when a widget is present, and only the widget turns them on.
if (blinkTsRequired) blinkTsSetState("pending", "checking you are a person");

// One listener, one job: swap the button for the launch panel in place.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-launch]");
  if (!btn) return;
  const app = btn.getAttribute("data-launch");
  const slot = document.querySelector('[data-panel="' + app + '"]');
  if (blinkTsRequired && !blinkTsToken) {
    // Refuse locally rather than sending a request that is certain to come back
    // as missing_token. The server would be right and the visitor would learn
    // nothing from it.
    blinkTsSetState("pending", "the check has not finished yet, one moment");
    return;
  }
  var q = blinkTsToken ? "?cf-turnstile-response=" + encodeURIComponent(blinkTsToken) : "";
  const res = await fetch("/launch/" + encodeURIComponent(app) + q, { method: "POST" });
  // Consumed either way: a refused token is spent too, and reusing it would turn
  // one failure into a permanent one. Every button goes back off until the
  // widget mints a fresh one, or the next card fails exactly as this one did.
  blinkTsToken = null;
  if (window.turnstile) { try { window.turnstile.reset(); } catch (e) {} }
  blinkTsSetState("pending", "checking you are a person again");
  slot.innerHTML = await res.text();
  const t = slot.querySelector("[data-timer]");
  const label = slot.querySelector("[data-timer-label]");
  if (!t) return;
  const started = performance.now();
  let stopped = false;
  // Counts against a local start. Never resets, never hides, and the two stops
  // are the only moments it changes character.
  (function frame() {
    if (!stopped) t.textContent = ((performance.now() - started) / 1000).toFixed(2);
    requestAnimationFrame(frame);
  })();

  const pill = (id, on) => {
    const el = slot.querySelector('[data-pill="' + id + '"]');
    if (el) el.setAttribute("data-on", on ? "1" : "0");
  };
  pill("starting", true);

  // Find our instance by polling the list. The launch is fire and forget on the
  // server so a slow create cannot block the response the visitor is reading.
  let id = null;
  for (let i = 0; i < 240 && !id; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const list = await fetch("/instances").then((r) => r.json()).catch(() => []);
    const mine = list.filter((x) => x.appId === app).pop();
    if (mine) id = mine.id;
  }
  if (!id) { label.textContent = "could not start an instance"; return; }

  for (let i = 0; i < 600; i++) {
    const s = await fetch("/instance/" + id).then((r) => r.json()).catch(() => null);
    if (!s) break;
    if (s.state === "CHECKING") pill("checking", true);
    if (s.state === "READY" || s.state === "HANDOVER" || s.state === "LIVE") {
      pill("checking", true); pill("ready", true);
    }
    // The URL alone is not the handover: it now exists during CHECKING, before
    // the clock starts. Wait for the state that means a visitor may have it.
    if (s.previewUrl && (s.state === "HANDOVER" || s.state === "LIVE")) {
      pill("loading", true); pill("shown", true);
      stopped = true;
      t.setAttribute("data-stopped", "1");
      label.textContent = "in your browser";
      const html = await fetch("/toolbar/" + id).then((r) => r.text());
      slot.innerHTML = html;
      startCountdown(slot);
      return;
    }
    if (s.state === "FAILED" || s.state === "ENDED") {
      label.textContent = s.endedReason || "instance ended";
      stopped = true;
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
});

function startCountdown(root) {
  const el = root.querySelector("[data-countdown]");
  if (!el) return;
  let ms = Number(el.getAttribute("data-ms"));
  const tick = () => {
    ms -= 1000;
    if (ms < 0) ms = 0;
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    el.textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    el.className = "timer mono" + (ms < 30000 ? " fail" : ms < 120000 ? " warn" : "");
    if (ms > 0) setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

document.addEventListener("click", async (e) => {
  const copy = e.target.closest("[data-copy]");
  if (copy) {
    // The invite link goes through Blink, not straight at the preview domain.
    //
    // A shared link outliving its instance used to hit Solari's bare 404, and
    // the person holding it has the least context of anyone: they did not
    // launch it and do not know it had ten minutes. /go/:id knows, and says so.
    const v = copy.getAttribute("data-copy");
    const text = copy.hasAttribute("data-copy-go") ? location.origin + "/go/" + v : v;
    await navigator.clipboard.writeText(text);
    copy.textContent = "copied";
    return;
  }
  const destroy = e.target.closest("[data-destroy]");
  if (destroy) {
    const id = destroy.getAttribute("data-destroy");
    const panel = destroy.closest("[data-toolbar]");
    panel.innerHTML = await fetch("/destroy/" + id, { method: "POST" }).then((r) => r.text());
    return;
  }
  const share = e.target.closest("[data-share]");
  if (share) {
    share.disabled = true;
    share.textContent = "snapshotting...";
    const r = await fetch("/share/" + share.getAttribute("data-share"), { method: "POST" }).then((r) => r.json());
    if (r.ok) {
      await navigator.clipboard.writeText(location.origin + "/s/" + r.token).catch(() => {});
      share.textContent = "link copied";
    } else {
      share.textContent = r.reason || "could not share";
    }
    return;
  }
  const sl = e.target.closest("[data-launch-share]");
  if (sl) {
    sl.disabled = true;
    sl.textContent = "starting your copy...";
    const panel = sl.closest(".panel");
    panel.innerHTML = await fetch("/launch-share/" + sl.getAttribute("data-launch-share"), { method: "POST" }).then((r) => r.text());
    return;
  }
  const ext = e.target.closest("[data-extend]");
  if (ext) {
    const id = ext.getAttribute("data-extend");
    const r = await fetch("/extend/" + id, { method: "POST" }).then((r) => r.json());
    ext.disabled = true;
    ext.textContent = r.ok ? "extended once" : (r.reason || "cannot extend");
  }
});
</script>`,
  );
}

export function renderHealthWall(rows: Array<{
  app: string; asked: string; strip: Array<"ok" | "warn" | "fail" | "none">;
  /** Which measurement the strip is drawn from. Never inferred by the reader. */
  source: "canary" | "soak";
  lastAt: string; snapshot: string; p50: number | null; p95: number | null;
}>, soak: { continuousHours: number; distinctHours: number; runs: number },
   ledger?: { isDurable: boolean; describe: string },
   hosting?: { onLaptop: boolean }): string {
  return page(
    "Blink health wall",
    `<main class="wrap" style="padding-top:40px">
<h1 class="t-title">Health wall</h1>
<p class="muted" style="max-width:70ch">
  Each row says what its canary actually asked. A status code would show green for an app
  serving its own installer, which is not a hypothetical: it happened twice while building this.
</p>
${hosting?.onLaptop ? `<p class="warn t-small" style="max-width:70ch">
  <strong>This site runs from a laptop.</strong> It is up while that machine is awake, unlocked
  and connected, and down when the lid closes or it sleeps. There is no second server and no
  failover. Every measurement on this page is real; the uptime is not a service.
</p>` : ""}
<p class="mono">
  ${soak.continuousHours >= 24
    ? `Soaked continuously for ${soak.continuousHours} hours on the host that serves this page.`
    : `Soaked for ${soak.distinctHours} ${soak.distinctHours === 1 ? "hour" : "hours"} total across ${soak.runs} separate runs. Longest uninterrupted stretch: ${soak.continuousHours} ${soak.continuousHours === 1 ? "hour" : "hours"}.`}
</p>
${ledger && !ledger.isDurable ? `<p class="warn mono">
  Ledger store: ${esc(ledger.describe)}. Spending totals on this instance reset when the server restarts,
  so the credit figure is for this process only.
</p>` : ledger ? `<p class="muted mono">Ledger store: ${esc(ledger.describe)}.</p>` : ""}
${rows.map((r) => `<div class="row">
  <div><strong>${esc(r.app)}</strong><div class="muted mono">${esc(r.snapshot)}</div></div>
  <div><div class="strip">${r.strip.map((s) => `<i data-s="${esc(s)}"></i>`).join("")}</div>
    <div class="label" style="margin-top:6px">${
      r.source === "canary" ? "last 24 canary checks" : "last 24 soak checks, from an earlier run"
    }</div>
    <div class="muted t-small" style="margin-top:4px">${esc(r.asked)}</div></div>
  <div class="mono">
    resolve p50 ${r.p50 === null ? "no data" : `${r.p50} ms`} &middot; p95 ${r.p95 === null ? "no data" : `${r.p95} ms`}
    <div class="muted">last ${esc(r.lastAt)}</div>
  </div>
</div>`).join("\n")}
</main>`,
    { noindex: false },
  );
}
