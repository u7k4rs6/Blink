/**
 * Frontend tests.
 *
 * Weighted towards the two things that would actually hurt: a capability URL
 * reaching a page that can be crawled or cached, and a number presented as
 * something stronger than it is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { TOKENS, CSS, contrast } from "../src/web/tokens.ts";
import { esc, renderCatalog, renderBoard, renderHealthWall, renderReceipt, renderLaunchPanel, type App, type Board } from "../src/web/render.ts";
import { buildReceipt, fmtDuration, fmtUsd } from "../src/web/receipt.ts";
import { pillsFor, labelAt } from "../src/web/launch-timeline.ts";
import { PLANS, SIZE_SMALL } from "../src/guard/rates.ts";

const board: Board = {
  instancesRunning: 1, launchedToday: 34, medianReadyMs: 4020,
  creditsUsedUsd: 16.42, creditsCapUsd: 20, staleSeconds: 3,
};

const app = (over: Partial<App> = {}): App => ({
  id: "gitea", name: "Gitea", description: "A git forge you can push to.",
  category: "developer tools", license: "MIT", upstream: "https://github.com/go-gitea/gitea",
  tryFirst: ["Open the seeded repo", "Read the pull request", "Push a commit"],
  lastForkMs: 5500,
  canary: { ok: true, asked: "created an issue and read it back", at: "14:02:11" },
  shotUrl: "/shots/gitea.png", shotAt: "14:02:11",
  ...over,
});

// ---------------------------------------------------------------------------
// Escaping and capability leakage
// ---------------------------------------------------------------------------

test("every field that reaches HTML is escaped", () => {
  const html = renderCatalog(board, [app({ name: `<script>alert(1)</script>`, description: `" onload="x` })]);
  assert.ok(!html.includes("<script>alert(1)</script>"), "app name was not escaped");
  assert.ok(html.includes("&lt;script&gt;"), "the escaped form should be present");
  assert.ok(!html.includes('" onload="x'), "an attribute break got through");
});

test("the catalog never renders a pt_token or a preview host", () => {
  // The preview URL is a bearer capability (V21, V60). It is rendered only into
  // the launching visitor's own toolbar, never onto a page that can be crawled,
  // cached, screenshotted or indexed.
  const html = renderCatalog(board, [app(), app({ id: "jaeger", name: "Jaeger" })]);
  assert.ok(!/pt_token/i.test(html));
  assert.ok(!/preview\.getsolari\.com/i.test(html));
  assert.ok(!/__pt_preview/i.test(html));
});

test("the health wall never renders a capability URL either", () => {
  const html = renderHealthWall(
    [{ app: "gitea", asked: "created an issue and read it back", source: "canary", strip: ["ok", "ok"], lastAt: "14:02", snapshot: "snap_x", p50: 257, p95: 284 }],
    { continuousHours: 3, distinctHours: 4, runs: 2 },
  );
  assert.ok(!/pt_token|preview\.getsolari|__pt_preview/i.test(html));
});

test("esc handles the characters that break out of attributes", () => {
  assert.equal(esc(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

// ---------------------------------------------------------------------------
// Numbers say what they are
// ---------------------------------------------------------------------------

test("the credit gauge is labelled an estimate, in the markup, not just the spec", () => {
  const html = renderCatalog(board, [app()]);
  assert.match(html, /estimate/i);
  assert.match(html, /not a bill/i, "it must say plainly that Solari did not produce this number");
});

test("the health wall states WHICH soak number it is showing", () => {
  const chunked = renderHealthWall([], { continuousHours: 3, distinctHours: 24, runs: 9 });
  assert.match(chunked, /24 hours total across 9 separate runs/);
  assert.match(chunked, /Longest uninterrupted stretch: 3 hours/);
  assert.ok(!/^Soaked for 24 hours\.$/m.test(chunked), "accumulated hours must never stand alone");

  const continuous = renderHealthWall([], { continuousHours: 24, distinctHours: 24, runs: 1 });
  assert.match(continuous, /continuously for 24 hours/);
});

test("a missing measurement reads as 'no data', never as zero", () => {
  // A zero here would be a measurement nobody made. Every other number on this
  // page was measured, so an invented one poisons the rest.
  const html = renderCatalog({ ...board, medianReadyMs: null }, [app({ lastForkMs: null })]);
  assert.match(html, /no launches yet/);
  assert.match(html, /no health data/);
  assert.ok(!/0\.00s/.test(html));
});

// ---------------------------------------------------------------------------
// Receipt: the arithmetic is shown
// ---------------------------------------------------------------------------

test("the receipt shows the working, not just the total", () => {
  const r = buildReceipt({ plan: PLANS.starter, size: SIZE_SMALL, sandboxSeconds: 600, browserSeconds: 540, browserTiles: 12 });
  const html = renderReceipt(r);
  assert.match(html, /x \$0\.\d+\/h =/, "the rate and the multiplication must be visible");
  assert.match(html, /10m 00s/);
  assert.match(html, /Total/);
  assert.match(html, /no usage API/i, "the receipt must say the figure is ours, not Solari's");
});

test("a lost instance says so above the same table", () => {
  const r = buildReceipt({ plan: PLANS.starter, size: SIZE_SMALL, sandboxSeconds: 133, lost: true });
  assert.match(renderReceipt(r), /instance ended early \(lost\)/);
});

test("receipt totals equal the sum of their lines", () => {
  const r = buildReceipt({ plan: PLANS.starter, size: SIZE_SMALL, sandboxSeconds: 600, browserSeconds: 540, browserTiles: 12 });
  const sum = r.lines.reduce((a, l) => a + l.usd, 0);
  assert.ok(Math.abs(sum - r.totalUsd) < 1e-12, "the total must be the sum of the shown lines");
});

test("USD is shown to four places, since two would round a real charge to zero", () => {
  assert.equal(fmtUsd(0.0095), "$0.0095");
  assert.notEqual(fmtUsd(0.0095), "$0.01");
});

test("durations are human, not raw seconds", () => {
  assert.equal(fmtDuration(600), "10m 00s");
  assert.equal(fmtDuration(45), "0m 45s");
});

// ---------------------------------------------------------------------------
// Launch sequence
// ---------------------------------------------------------------------------

test("a queue pill appears only when actually queued", () => {
  assert.ok(!pillsFor({ path: "warm" }).some((p) => p.id === "queued"));
  assert.ok(pillsFor({ path: "warm", queuedAhead: 2 }).some((p) => p.label.includes("2 ahead of you")));
});

test("the starting label is chosen by path and never changes mid-run", () => {
  assert.match(pillsFor({ path: "warm" })[0]!.label, /resuming/);
  assert.match(pillsFor({ path: "cold" })[0]!.label, /building/);
});

test("every moment of the launch has a caption, including the 4.0 to 5.5 second gap", () => {
  // That window is the recording's dead air. If it has no label the page shows
  // a number with nothing explaining it, which is where the wait feels broken.
  assert.equal(labelAt(2000, 4000, 5500), "starting");
  assert.equal(labelAt(4500, 4000, 5500), "ready, loading it in your browser");
  assert.equal(labelAt(6000, 4000, 5500), "in your browser");
});

test("the launch panel replaces content in place, with no navigation", () => {
  const html = renderLaunchPanel("gitea", { path: "warm" });
  assert.match(html, /data-launching="gitea"/);
  assert.ok(!/<a\s+href/.test(html), "the panel must not navigate anywhere");
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

test("body text clears WCAG AA against the background", () => {
  assert.ok(contrast(TOKENS.text, TOKENS.bg) >= 4.5, `text contrast was ${contrast(TOKENS.text, TOKENS.bg).toFixed(2)}`);
});

test("muted text clears AA for large text at minimum, and is reported if not", () => {
  const ratio = contrast(TOKENS.muted, TOKENS.bg);
  assert.ok(ratio >= 3, `muted contrast was ${ratio.toFixed(2)}, which fails even the large-text floor`);
});

test("the three state colours are distinguishable from the surface", () => {
  for (const [name, c] of [["accent", TOKENS.accent], ["warn", TOKENS.warn], ["fail", TOKENS.fail]] as const) {
    assert.ok(contrast(c, TOKENS.bg) >= 3, `${name} contrast was ${contrast(c, TOKENS.bg).toFixed(2)}`);
  }
});

test("reduced motion is respected, since the launch is the only animation", () => {
  const html = renderCatalog(board, [app()]);
  assert.match(html, /prefers-reduced-motion/);
});

test("fork time and resolve time are never borrowed from each other", async () => {
  // The first server rendered "last fork 0.27s" from the previewUrl resolve
  // time, which is four to five times smaller and measures a different thing.
  // Both numbers are real; putting one under the other's label is not.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  const body = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  assert.match(body, /medianReadyMs:\s*percentile\(readyMs,/,
    "the board must show time to ready, measured from real launches");
  assert.ok(!/medianReadyMs:\s*percentile\(forks,/.test(body),
    "the health poll is a COMPONENT of ready, not ready itself");
  assert.ok(!/lastForkMs:\s*resolves\./.test(body), "resolve time must never be labelled as fork time");
});

test("the health wall labels its percentiles as resolve times", () => {
  const html = renderHealthWall(
    [{ app: "gitea", asked: "x", source: "canary", strip: ["ok"], lastAt: "14:02", snapshot: "s", p50: 257, p95: 284 }],
    { continuousHours: 1, distinctHours: 1, runs: 1 },
  );
  assert.match(html, /resolve p50 257 ms/, "an unlabelled p50 invites reading it as the fork time");
});

test("hour counts are singular when there is one of them", () => {
  const html = renderHealthWall([], { continuousHours: 1, distinctHours: 1, runs: 1 });
  assert.match(html, /1 hour total/);
  assert.match(html, /stretch: 1 hour\./);
});

// ---------------------------------------------------------------------------
// Share pages
// ---------------------------------------------------------------------------

test("every share refusal names its own reason", async () => {
  const { renderSharePage } = await import("../src/web/render.ts");
  const cases = {
    unknown: /does not exist/,
    expired: /expired/,
    deleted: /deleted/,
    reported: /reported/,
  } as const;
  for (const [error, re] of Object.entries(cases)) {
    const html = renderSharePage({ error: error as keyof typeof cases });
    assert.match(html, re, `${error} must say what actually happened`);
    assert.match(html, /Start a fresh instance instead/, "and always offer a way forward");
  }
});

test("the share page says the fork is separate from the sharer's instance", async () => {
  const { renderSharePage } = await import("../src/web/render.ts");
  const html = renderSharePage({ appName: "Gitea", forkCount: 3, token: "tok" });
  assert.match(html, /nothing you do here reaches them/i);
  assert.match(html, /forked 3 times/);
  assert.match(html, /Report this link/);
});

test("share and report pages are noindex, since their URLs carry tokens", async () => {
  const { shell, renderSharePage } = await import("../src/web/render.ts");
  const html = shell(renderSharePage({ appName: "Gitea", forkCount: 0, token: "secret-token" }), true);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
});

test("a share page never leaks a preview URL or a snapshot id", async () => {
  const { renderSharePage } = await import("../src/web/render.ts");
  const html = renderSharePage({ appName: "Gitea", forkCount: 1, token: "tok" });
  assert.ok(!/pt_token|preview\.getsolari|snap_/i.test(html));
});

test("singular fork count reads correctly", async () => {
  const { renderSharePage } = await import("../src/web/render.ts");
  assert.match(renderSharePage({ appName: "G", forkCount: 1, token: "t" }), /forked 1 time so far/);
});

// ---------------------------------------------------------------------------
// Turnstile and queue defaults
// ---------------------------------------------------------------------------

test("Turnstile is ON by default and must be explicitly disabled", async () => {
  // Forgetting to configure it must fail launches loudly rather than quietly
  // removing the only thing between an anonymous visitor and a machine with
  // unrestricted egress (Q5, V57).
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  assert.match(src, /BLINK_TURNSTILE_DISABLED === "1"/,
    "the off switch must require an explicit value, not an absent one");
  assert.ok(!/TURNSTILE_DISABLED\s*=\s*process\.env\.\w+\s*!==/.test(src),
    "the default must not be off");
  const turnstileGate = src.indexOf("verifyTurnstile(token");
  const queueGate = src.indexOf("queue.enqueue(appId");
  const launchCall = src.indexOf("runner.launch({");
  assert.ok(turnstileGate > 0 && turnstileGate < launchCall,
    "Turnstile must be checked before anything that spends");
  assert.ok(queueGate > 0 && queueGate < launchCall,
    "the queue check must also come before the launch");
});

test("the session cookie is opaque, HttpOnly and short lived", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  // The set-cookie line specifically, not the regex that reads it back.
  const line = src.split("\n").find((l) => l.includes("set-cookie") && l.includes("blink_session="))!;
  assert.ok(line, "no set-cookie line for the session token");
  assert.match(line, /HttpOnly/);
  assert.match(line, /SameSite=Lax/);
  assert.match(line, /Max-Age=3600/);
  assert.ok(!/userId|email|name/i.test(line), "it identifies a queue entry, not a person");
});

// ---------------------------------------------------------------------------
// Ledger durability is disclosed, not assumed
// ---------------------------------------------------------------------------

test("a memory ledger is DISCLOSED on the health wall, not hidden", async () => {
  // An in-memory ledger forgets every reservation on restart, so the daily
  // ceiling silently resets. Showing a credit figure without saying that would
  // be the most expensive kind of silence in this project.
  const { renderHealthWall } = await import("../src/web/render.ts");
  const html = renderHealthWall([], { continuousHours: 1, distinctHours: 1, runs: 1 },
    { isDurable: false, describe: "memory (resets on restart)" });
  assert.match(html, /reset when the server restarts/);
  assert.match(html, /for this process only/);
});

test("a durable ledger says so plainly, without a warning", async () => {
  const { renderHealthWall } = await import("../src/web/render.ts");
  const html = renderHealthWall([], { continuousHours: 1, distinctHours: 1, runs: 1 },
    { isDurable: true, describe: "Postgres" });
  assert.match(html, /Ledger store: Postgres/);
  assert.ok(!/reset when the server restarts/.test(html));
});

test("a skipped canary renders as neutral, never as a failure", async () => {
  // A red cell must mean the app broke, not that background work lost a race
  // for a slot.
  const { renderHealthWall } = await import("../src/web/render.ts");
  const html = renderHealthWall(
    [{ app: "gitea", asked: "x", source: "canary", strip: ["ok", "none", "fail"], lastAt: "1", snapshot: "s", p50: 1, p95: 2 }],
    { continuousHours: 1, distinctHours: 1, runs: 1 },
  );
  assert.match(html, /data-s="none"/);
  assert.match(html, /data-s="fail"/);
});

// ---------------------------------------------------------------------------
// Hosting honesty
// ---------------------------------------------------------------------------

test("the health wall says the site runs from a laptop, in plain language", async () => {
  // Same register as the cold and warm labels: state the limitation where the
  // reader is, not in a footnote they will not reach.
  const { renderHealthWall } = await import("../src/web/render.ts");
  const html = renderHealthWall([], { continuousHours: 7, distinctHours: 23, runs: 9 },
    { isDurable: true, describe: "Postgres" }, { onLaptop: true });
  assert.match(html, /runs from a laptop/i);
  assert.match(html, /up while that machine is awake/i);
  assert.match(html, /no second server and no\s+failover/i);
  assert.match(html, /the uptime is not a service/i);
});

test("accumulated soak hours are never presented as continuous, even on a laptop", async () => {
  const { renderHealthWall } = await import("../src/web/render.ts");
  const html = renderHealthWall([], { continuousHours: 7, distinctHours: 23, runs: 9 },
    undefined, { onLaptop: true });
  assert.match(html, /23 hours total across 9 separate runs/);
  assert.match(html, /Longest uninterrupted stretch: 7 hours/);
  assert.ok(!/Soaked continuously for 23/.test(html));
});

test("the laptop notice is omitted when the site is not on a laptop", async () => {
  const { renderHealthWall } = await import("../src/web/render.ts");
  const html = renderHealthWall([], { continuousHours: 24, distinctHours: 24, runs: 1 },
    undefined, { onLaptop: false });
  assert.ok(!/runs from a laptop/i.test(html));
  assert.match(html, /continuously for 24 hours/);
});

// ---------------------------------------------------------------------------
// Turnstile: the widget must exist, or the control cannot fire
// ---------------------------------------------------------------------------

test("with a site key, the catalog renders a real Turnstile widget", async () => {
  // Server-side verification was tested and passing while NO widget existed, so
  // no genuine token could ever be produced. A control that cannot fire is not
  // a control, which is the pkill failure in a different costume.
  const html = renderCatalog(board, [app()], "0x4AAAAAAA_test_site_key");
  assert.match(html, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
  assert.match(html, /class="cf-turnstile"/);
  assert.match(html, /data-sitekey="0x4AAAAAAA_test_site_key"/);
  assert.match(html, /data-callback="blinkTurnstileOk"/);
});

test("the launch request carries the token", async () => {
  const html = renderCatalog(board, [app()], "sitekey");
  assert.match(html, /cf-turnstile-response=/, "the server reads this parameter; without it every launch is refused");
});

test("the token is cleared and the widget reset after every launch", () => {
  // Turnstile tokens are single use. Reusing one turns a single failure into a
  // permanent one, and it looks exactly like a broken launch button.
  const html = renderCatalog(board, [app()], "sitekey");
  assert.match(html, /blinkTsToken = null;/);
  assert.match(html, /turnstile\.reset\(\)/);
});

test("without a site key the page SAYS verification is off, loudly", () => {
  // The dangerous case is a public deployment that silently has no bot check.
  const html = renderCatalog(board, [app()]);
  // The WIDGET must be absent. The launch JS still mentions the parameter name,
  // because it is the same code path either way and simply sends no token.
  assert.ok(!/class="cf-turnstile"/.test(html), "no widget without a site key");
  assert.ok(!/challenges\.cloudflare\.com/.test(html), "and no Turnstile script");
  assert.match(html, /Bot verification is disabled/);
  assert.match(html, /not a safe one to run publicly/);
});

test("the widget explains why it exists, in the visitor's terms", () => {
  // The claim, not the wording. The copy was tightened for the redesign and the
  // old assertion pinned a phrase rather than the fact it was carrying: that a
  // visitor is handed a machine whose outbound network is not restricted.
  const html = renderCatalog(board, [app()], "sitekey");
  assert.match(html, /open outbound network|unrestricted outbound network/);
  assert.match(html, /real machine/);
});

test("a card with no canary run says so rather than borrowing a soak verdict", async () => {
  // Jaeger's card said "Down since 07:29" from a soak the previous day,
  // describing a failure since fixed, with no path to clearing: the run that
  // produced it had ended. A permanent false failure is worse than a stale one.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function buildApps"), src.indexOf("function soakSummary"));
  assert.match(fn, /const canary = canaryLog\.filter/, "the card must read the canary");
  assert.match(fn, /waiting for the first canary run/, "and say so when there is none");
  assert.ok(!/downSince: last &&/.test(fn), "downSince must never come from the soak log");
});

test("the board label names what it measures", () => {
  const html = renderCatalog({ ...board, medianReadyMs: 4020 }, [app()]);
  assert.match(html, /Median time to ready/);
  assert.match(html, /4\.02s/);
  assert.ok(!/Median fork/.test(html), "1.18s is the health poll, not the fork");
});

test("a soak strip says so, instead of looking like the canary's verdict", () => {
  // The wall drew a solid red bar of soak failures from an earlier run directly
  // beneath the words "waiting for the first canary run". Both were true and
  // the pair was a lie. V79 fixed this on the cards and not here.
  const soakRow = renderHealthWall(
    [{ app: "jaeger", asked: "waiting for the first canary run", source: "soak",
       strip: ["fail", "fail"], lastAt: "never", snapshot: "snap_x", p50: null, p95: null }],
    { continuousHours: 1, distinctHours: 1, runs: 1 });
  assert.match(soakRow, /soak checks, from an earlier run/,
    "a strip drawn from the soak log must say which measurement it is");

  const canaryRow = renderHealthWall(
    [{ app: "jaeger", asked: "queried a trace", source: "canary",
       strip: ["ok", "ok"], lastAt: "14:02", snapshot: "snap_x", p50: 1, p95: 2 }],
    { continuousHours: 1, distinctHours: 1, runs: 1 });
  assert.match(canaryRow, /last 24 canary checks/);
  assert.ok(!/earlier run/.test(canaryRow), "canary rows must not be labelled as soak");
});

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

test("the ladder runs at the measured proportions, and claims no length it did not measure", async () => {
  const { LADDER, LADDER_COMPRESS, ladderTiming } = await import("../src/web/motion.ts");
  const t = ladderTiming();
  assert.equal(t.length, LADDER.length);

  // Each rung starts where the last one ended. A gap or an overlap would make
  // the sequence say something about the launch path that is not true.
  let at = 0;
  for (let i = 0; i < t.length; i++) {
    assert.equal(t[i]!.delay, at, `rung ${i} does not start where rung ${i - 1} ended`);
    at += t[i]!.dur;
  }

  // The whole point is that the SHAPE survives compression: the fork is long,
  // the health check is a flash you can miss, the fetch is in between. If the
  // ratios were not preserved the animation would be decoration wearing a
  // measurement's clothes.
  const fork = LADDER.find((x) => x.label === "fork")!.ms!;
  const health = LADDER.find((x) => x.label === "health check")!.ms!;
  assert.equal(t[0]!.dur, Math.round(fork / LADDER_COMPRESS));
  assert.equal(t[1]!.dur, Math.round(health / LADDER_COMPRESS));
  assert.ok(t[0]!.dur > t[1]!.dur * 8, "the fork must still dwarf the health check");

  // A bar is a length and a length is a claim, so only measured rungs get one.
  for (let i = 0; i < LADDER.length; i++) {
    assert.equal(t[i]!.measured, LADDER[i]!.ms !== null,
      `${LADDER[i]!.label} draws a bar for a duration nobody measured`);
  }
  const html = renderCatalog(board, [app()]);
  assert.match(html, /data-n="02" data-measured="1" title="measured at about 281 ms"/);
  assert.match(html, /data-n="05" data-measured="0" style=/, "gone is not a measurement");
});

test("the field fills empty stretches, and never draws behind the catalog", async () => {
  /*
   * The band system is attribute driven, so reaching for a livelier page below
   * the fold is one attribute, and that is exactly how it went wrong. A band on
   * the catalog covered the full page width at hero strength, and the cards are
   * translucent by design, so the field passed THROUGH five cards and their
   * screenshots rather than behind them. Turning it down to a scatter did not
   * fix it either: it was still loose pixels over the content.
   *
   * A band belongs where there is nothing else, which is the hero above the
   * fold and the footer below the last card. Anywhere content lives, the field
   * stays out.
   */
  const html = renderCatalog(board, [app()]);
  assert.ok(!/class="cards"[^>]*data-ambient/.test(html),
    "no band may sit behind the cards, at any strength");
  assert.ok(!/class="pick"[^>]*data-ambient/.test(html));
  assert.ok(!/data-ambient-strength/.test(html),
    "nothing sets a strength any more, so nothing should read one");

  // The two that remain, and the reason each one is legible.
  assert.match(html, /class="hero" data-ambient="up" data-ambient-below="\.kick"/,
    "the hero's cloud stays out from under the headline");
  assert.match(html, /class="foot" data-ambient="up" data-ambient-below="span"/,
    "and the footer's stays out from under the footer's own words");

  const { PIXELS_SCRIPT } = await import("../src/web/pixels.ts");
  assert.ok(!/data-ambient-strength/.test(PIXELS_SCRIPT), "the unused knob is gone");
  assert.match(PIXELS_SCRIPT, /data-ambient-below/, "the anchor is the part that earns its keep");
});

test("both inline scripts parse, and neither ships an unsubstituted placeholder", async () => {
  /*
   * `var RESOLVE = ${"$"}{RESOLVE_FRAMES};` looked like an escape and was not.
   * It put the literal text ${RESOLVE_FRAMES} into the browser, which is a
   * syntax error, and a syntax error in an inline script kills every line after
   * it silently: no console any visitor reads, no failed request, nothing on
   * the page except motion that quietly does not happen. Typecheck passed,
   * every other test passed, and the page was broken.
   *
   * These scripts are strings on the server and code in the browser, so nothing
   * else in the toolchain looks at them. This is the only thing that does.
   */
  const { MOTION_SCRIPT } = await import("../src/web/motion.ts");
  const { PIXELS_SCRIPT } = await import("../src/web/pixels.ts");
  for (const [name, src] of [["motion", MOTION_SCRIPT], ["pixels", PIXELS_SCRIPT]] as const) {
    assert.doesNotThrow(() => new Function(src), `${name} script does not parse`);
    const left = src.match(/\$\{[^}]*\}/);
    assert.equal(left, null, `${name} ships an unsubstituted ${left?.[0]}`);
  }
});

test("no reveal may be the reason something is not on the page", async () => {
  /*
   * The first version clipped the canary record to zero width in a RESTING rule
   * and undid it from an ancestor's scroll reveal. Any jump past that ancestor
   * (an anchor, a restored scroll position, ctrl+End, find-in-page) left the
   * record clipped to nothing permanently, and a jump to the bottom of the page
   * left seven of eight reveals unfired.
   *
   * The rule this encodes: a hidden state belongs in a keyframe, never in a
   * resting rule. A reveal that never fires then looks like a reveal nobody
   * asked for, rather than like content that is missing. It is the same shape
   * as a control that passes its own test and cannot fire, except here the
   * thing that cannot fire is the only thing making the page visible.
   */
  const { MOTION_SCRIPT } = await import("../src/web/motion.ts");

  // Split the sheet into keyframe blocks and everything else, then look for a
  // hiding declaration outside a keyframe.
  const withoutKeyframes = CSS.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  for (const bad of [/clip-path:\s*inset\([^)]*100%/, /\bvisibility:\s*hidden/, /\bopacity:\s*0\b(?![.\d])/]) {
    const hit = bad.exec(withoutKeyframes);
    assert.equal(hit, null,
      `a resting rule hides content: ${JSON.stringify(hit?.[0])}. Put it in a keyframe.`);
  }

  // And the gate is set by the script itself, so no JavaScript means no gate,
  // which means every rule that could hide something is inert.
  assert.match(MOTION_SCRIPT, /js-motion/);
  assert.ok(
    MOTION_SCRIPT.indexOf("prefers-reduced-motion") < MOTION_SCRIPT.indexOf("js-motion"),
    "reduced motion has to return BEFORE the gate is set, or it gates nothing",
  );
  assert.match(MOTION_SCRIPT, /if \(!\("IntersectionObserver" in window\)\)[\s\S]{0,200}forEach\(play\)/,
    "no observer must mean show everything, never show nothing");
  assert.match(CSS, /\.js-motion \[data-reveal-on-scroll\]/,
    "every reveal rule has to sit behind the gate");
});

test("the type scale is the only source of a font size", async () => {
  /*
   * The catalog carried five body sizes inside seven pixels of each other
   * (21, 19, 17, 15, 14) and thirty six inline `font-size` rules across three
   * files. None was wrong on its own, which is why it accumulated: each was
   * reached for once, in one place, and never compared against the others.
   * A reader cannot tell a deliberate step from a rounding error, so the whole
   * page reads as sloppiness rather than as hierarchy.
   *
   * The fix is not tidier numbers, it is having somewhere for a number to come
   * from. This test is what stops the next one being typed in a style attribute.
   */
  const { readFileSync } = await import("node:fs");
  for (const file of ["render.ts", "offline.ts", "server.ts", "tokens.ts"]) {
    const src = readFileSync(new URL(`../src/web/${file}`, import.meta.url), "utf8");
    const literal = [...src.matchAll(/font-size:\s*(\d+)px/g)].map((m) => m[0]);
    assert.deepEqual(literal, [],
      `${file} sets a font size by hand. Every size comes from TYPE in tokens.ts.`);
  }
  // And within a register, the steps have to be far enough apart to read as
  // steps. Across registers they do not: 12px mono and 13px sans are a pixel
  // apart and the face separates them before the size does.
  const { TYPE, REGISTER } = await import("../src/web/tokens.ts");
  const names = Object.keys(TYPE) as Array<keyof typeof TYPE>;
  assert.deepEqual(Object.keys(REGISTER), names, "every step declares its face");
  for (const face of ["mono", "sans"] as const) {
    const steps = names.filter((n) => REGISTER[n] === face).map((n) => TYPE[n] as number);
    for (let i = 1; i < steps.length; i++) {
      assert.ok(steps[i]! >= steps[i - 1]! * 1.15,
        `${face}: ${steps[i - 1]} to ${steps[i]} is not a visible step`);
    }
  }
});

test("a board cell holds one number, because the readout is sized for one", () => {
  /*
   * The credits cell read "$0.00 / $20.00" at the same 60px as "0", needed
   * 391px in a 223px cell, and hung 168px past its own border into the next
   * one. Two numbers in a slot the panel treats as holding one.
   *
   * Spent is the measurement. The cap is the bound the gauge is drawn against,
   * so it belongs to the gauge, where it also gives the bar the scale it was
   * missing.
   */
  const html = renderBoard({ ...board, creditsUsedUsd: 1234.56, creditsCapUsd: 20 });
  for (const m of html.matchAll(/<div class="cell-value">([^<]*)<\/div>/g)) {
    assert.ok(m[1]!.length <= 8,
      `board value ${JSON.stringify(m[1])} is too long for a 60px readout`);
  }
  assert.match(html, /class="cell-label gauge-cap">of \$20\.00 cap</,
    "the cap labels the bar it bounds");
  assert.ok(!/cell-value">[^<]*\/[^<]*</.test(html),
    "no cell-value may carry a second figure after a slash");
});

test("monospace DATA is never uppercased, because ids are not labels", () => {
  // snap_dl6c3hu908ru rendered as SNAP_DL6C3HU908RU. Anyone copying it off the
  // page copied an id that does not exist.
  const rule = /\.mono\s*\{[^}]*\}/.exec(CSS)?.[0] ?? "";
  assert.ok(rule, ".mono must have its own rule");
  assert.match(rule, /text-transform:\s*none/,
    ".mono carries snapshot ids and ISO timestamps and must not transform them");
  const labels = /\.label,[^{]*\{[^}]*\}/.exec(CSS)?.[0] ?? "";
  assert.match(labels, /text-transform:\s*uppercase/,
    "the uppercase micro label class is what .mono stopped being");
});

// --------------------------------------------------------------------------
// The background pixel field
// --------------------------------------------------------------------------

test("the heat ramp runs cold to hot and every colour is a fill, never text", async () => {
  const { BANDS, bandFor } = await import("../src/web/pixels.ts");
  // Thresholds must ascend, or bandFor returns the wrong colour for a heat.
  for (let i = 1; i < BANDS.length; i++) {
    assert.ok(BANDS[i]![0] > BANDS[i - 1]![0], "bands must ascend");
  }
  assert.equal(bandFor(0), null, "a cold cell is not drawn at all");
  assert.equal(bandFor(BANDS[0]![0] - 0.001), null);
  assert.equal(bandFor(1), BANDS[BANDS.length - 1]![1], "the hottest heat is the last band");

  // The two that must never become text, whatever they look like on a
  // screenshot: neon is 1.15:1 on paper and yellow is 1.63:1. Navy is dark
  // enough to be text and is used as one, on the button hover, so it is not
  // included here. This test exists because the ramp is the one place these
  // colours are allowed, and the temptation is to reuse them for status.
  const NEVER_TEXT = ["#D8FF00", "#F5C518"];
  for (const colour of NEVER_TEXT) {
    assert.ok(BANDS.some(([, c]) => c === colour), `${colour} should be in the ramp`);
    assert.ok(contrast(colour, TOKENS.bg) < 3,
      `${colour} is a fill only and must stay well under the text floor`);
  }
});

test("cooling reaches zero, so the render loop can actually stop", async () => {
  const { cool } = await import("../src/web/pixels.ts");
  let h = 1;
  for (let i = 0; i < 500 && h > 0; i++) h = cool(h);
  assert.equal(h, 0, "heat must reach exactly zero, or the animation runs forever on a laptop");
  assert.ok(cool(1) < 1, "heat must actually decrease");
});

test("Pac-Man has a mouth that chomps and a body that is not a full disk", async () => {
  const { mouthAt, inPacman } = await import("../src/web/pixels.ts");
  const opens = [0, 5, 10, 15, 20].map(mouthAt);
  assert.ok(Math.max(...opens) - Math.min(...opens) > 0.3, "the mouth must open and close");

  // Facing right: a cell straight ahead is inside the mouth, one behind is body.
  const mouth = 0.6;
  assert.equal(inPacman(5, 0, 10, 0, mouth), false, "the wedge ahead must be cut out");
  assert.equal(inPacman(-5, 0, 10, 0, mouth), true, "behind him is body");
  assert.equal(inPacman(50, 0, 10, 0, mouth), false, "outside the radius is nothing");
});

test("the field does nothing without a fine pointer, or under reduced motion", async () => {
  const { PIXELS_SCRIPT } = await import("../src/web/pixels.ts");
  assert.match(PIXELS_SCRIPT, /hover: hover\) and \(pointer: fine/);
  assert.match(PIXELS_SCRIPT, /prefers-reduced-motion: reduce/);
  assert.match(PIXELS_SCRIPT, /if \(!fine \|\| still\) return;/,
    "both checks must bail before anything is created");
});

test("the canvas cannot swallow the launch button", async () => {
  // It covers the viewport. Without pointer-events: none it is a full screen
  // click shield over the one control the whole site exists for.
  assert.match(CSS, /\.pixfield\s*\{[^}]*pointer-events:\s*none/);
});

test("Pac-Man is drawn in the yellow band, not whatever number the reference used", async () => {
  // The reference draws him at 0.72 with a comment saying "yellow band". That is
  // true of its thresholds and false of ours, where 0.72 is red. Copying the
  // number instead of the meaning is the whole failure mode.
  const { PAC_HEAT, bandFor, BANDS } = await import("../src/web/pixels.ts");
  assert.equal(bandFor(PAC_HEAT), "#F5C518", "Pac-Man must be yellow");
  const yellow = BANDS.findIndex(([, c]) => c === "#F5C518");
  assert.ok(PAC_HEAT >= BANDS[yellow]![0] && PAC_HEAT < BANDS[yellow + 1]![0],
    "PAC_HEAT must sit inside the yellow band, not on its edge");
});

test("a click releases Pac-Man, and moving the cursor dismisses him", async () => {
  const { PIXELS_SCRIPT } = await import("../src/web/pixels.ts");
  assert.match(PIXELS_SCRIPT, /pointerdown[\s\S]{0,400}releasePacman/,
    "the click is the trigger");
  assert.match(PIXELS_SCRIPT, /pointermove[\s\S]{0,300}pacOn = false/,
    "moving the cursor must dismiss him, or he cannot be got rid of");
});

test("everything that draws without the cursor keeps the render loop alive", async () => {
  // Tying the loop to leftover heat alone stopped it underneath Pac-Man, who is
  // the only thing that draws with the cursor still. Every later addition has
  // the same problem, so this asserts the SET rather than the expression: an
  // earlier version pinned the exact string and broke on each new flag, which
  // trains you to edit the test instead of reading it.
  const { PIXELS_SCRIPT } = await import("../src/web/pixels.ts");
  const cond = /if \(alive \|\|([\s\S]*?)\) \{\n?\s*requestAnimationFrame/.exec(PIXELS_SCRIPT)?.[1] ?? "";
  assert.ok(cond, "the loop's continue condition moved and this test lost it");
  for (const flag of ["pacOn", "held", "aimed", "ambOn"]) {
    assert.ok(cond.includes(flag),
      `${flag} draws without the cursor, so it must keep the loop running`);
    // The pixelation overlay is deliberately NOT here: it has its own rAF and
    // its own canvas, so folding it into the heat loop would keep the field
    // redrawing for something that is not drawn on the field at all.
  }
  assert.match(cond, /visible/, "none of it should run in a background tab");
  assert.match(PIXELS_SCRIPT, /running = false;/, "the loop must still have an exit");
});

test("the field's drawing grid is finer than the layout grid", async () => {
  // The reference lays out on 14px and draws its heat canvas on 9px. Using the
  // layout cell for both made the trail chunky and, at the same radius in
  // cells, half again as wide. They are separate decisions.
  const { FIELD_CELL, FIELD_RADIUS } = await import("../src/web/pixels.ts");
  const { CELL } = await import("../src/web/tokens.ts");
  assert.ok(FIELD_CELL < CELL, `field cell ${FIELD_CELL} must be finer than layout cell ${CELL}`);
  // Size is asserted separately, against the recording. Here the point is only
  // that the drawing grid is the finer of the two.
  assert.ok(FIELD_RADIUS >= 3, "a radius under three cells cannot show a ramp");
});

test("every sprite is a rectangle of known characters that lands in the ramp", async () => {
  const { SPRITES, SPRITE_HEAT, SPRITE_NAMES, bandFor } = await import("../src/web/pixels.ts");
  assert.ok(SPRITE_NAMES.length >= 4, "a random pick needs something to pick from");
  for (const [name, rows] of Object.entries(SPRITES)) {
    assert.ok(rows.length >= 5, `${name} is too small to read as a shape`);
    for (const row of rows) {
      for (const ch of row) {
        assert.ok(ch === "." || ch in SPRITE_HEAT,
          `${name} uses "${ch}", which has no heat and would draw nothing`);
      }
    }
    // A sprite whose cells all fall below the coldest band is invisible, which
    // is a shape that ships, runs, and cannot be seen.
    const lit = rows.join("").split("").filter((c) => c !== ".").length;
    assert.ok(lit > 8, `${name} has only ${lit} lit cells`);
  }
  for (const [ch, heat] of Object.entries(SPRITE_HEAT)) {
    assert.ok(bandFor(heat), `"${ch}" at heat ${heat} is below the coldest band and draws nothing`);
  }
});

test("the sprite tones resolve to different colours, and the arrow stays neon", async () => {
  // Two heats in the same band make a flat silhouette, which is what the second
  // tone exists to avoid. The arrow's tone must additionally survive the stamp
  // noise without dropping a band, or a "clean neon" arrow comes out speckled
  // red like the mottled shapes it is meant to read differently from.
  const { SPRITE_HEAT, SPRITES, bandFor, BANDS } = await import("../src/web/pixels.ts");
  // The two SHAPE tones must differ, or a heart is a flat silhouette. "N" is
  // deliberately in the same band as "#": it differs by noise tolerance, not by
  // colour, which is the whole reason it exists.
  assert.notEqual(bandFor(SPRITE_HEAT["#"]!), bandFor(SPRITE_HEAT["+"]!),
    "the two shape tones must be different colours");

  const NOISE = 0.11;
  const neon = BANDS[BANDS.length - 1]![1];
  const arrowTone = new Set(SPRITES.arrowR!.join("").split("").filter((c) => c !== "."));
  for (const ch of arrowTone) {
    const base = SPRITE_HEAT[ch]!;
    assert.equal(bandFor(base - NOISE), neon,
      `the arrow tone "${ch}" drops out of neon once stamp noise is applied`);
  }
});

test("idle shapes are armed by a timer, and the card outline is delegated", async () => {
  const { PIXELS_SCRIPT } = await import("../src/web/pixels.ts");
  // V93 again: the exit path must schedule the wake, or idle never happens.
  assert.match(PIXELS_SCRIPT, /running = false;[\s\S]{0,600}if \(visible\) armIdle\(\);/,
    "stopping the loop must arm the idle timer");
  assert.match(PIXELS_SCRIPT, /measureAmbient\(\);\n  armIdle\(\);/,
    "idle must be armed at startup, after the ambient band is measured");
  // One delegated listener, because card bodies are rewritten in place after a
  // launch and per card listeners would leak on every rewrite.
  assert.match(PIXELS_SCRIPT, /addEventListener\("pointerover"[\s\S]{0,400}closest\("\[data-app\]"\)/);
  assert.match(PIXELS_SCRIPT, /querySelector\("img\.shot"\)/,
    "the screenshot itself is what gets pixelated");
  assert.ok(!/querySelectorAll\("\[data-app\]"\)[\s\S]{0,200}addEventListener/.test(PIXELS_SCRIPT),
    "do not attach a listener per card");
});

test("a stamped shape is held long enough to still be its own colour", async () => {
  // Stamped once and left to decay, a sprite fell from neon through red and
  // yellow to blue in about half a second: a blue smudge, not a heart.
  const { SPRITE_HEAT, SPRITE_HOLD_MS, cool, bandFor } = await import("../src/web/pixels.ts");
  const hot = Math.max(...Object.values(SPRITE_HEAT));

  // Without a hold, half a second of 60fps decay loses the top bands entirely.
  let h = hot;
  for (let i = 0; i < 30; i++) h = cool(h);
  assert.notEqual(bandFor(h), bandFor(hot), "this is the decay the hold exists to defeat");

  assert.ok(SPRITE_HOLD_MS >= 800,
    `a ${SPRITE_HOLD_MS}ms hold is too short to read a shape`);
});

test("a sweep clears a held shape, and hovering an image pixelates it", async () => {
  const { PIXELS_SCRIPT } = await import("../src/web/pixels.ts");
  assert.match(PIXELS_SCRIPT, /pointermove[\s\S]{0,400}held = null;/,
    "moving the cursor must drop a held shape, or it hangs around mid sweep");
  // A coloured outline was the first attempt and just restated the CSS border
  // the card already has. The image itself has to resolve into blocks.
  assert.ok(!/function outline\(/.test(PIXELS_SCRIPT), "the outline is gone");
  assert.match(PIXELS_SCRIPT, /g\.imageSmoothingEnabled = false;/,
    "scaling back up with smoothing off is what makes the blocks");
  assert.match(PIXELS_SCRIPT, /parentNode\.removeChild\(pxCanvas\)/,
    "the overlay must be removed, or every hovered card leaves a canvas behind");
  // It RESOLVES: blocky to sharp, once. Holding it pixelated hides the
  // screenshot, which is the card's entire evidence that the instance is real.
  assert.match(PIXELS_SCRIPT, /pxLevel = 1; pxDir = -1;/,
    "hover must start blocky and sharpen, not the other way round");
});

test("the field script RUNS: a full frame of every path throws nothing", async () => {
  /*
   * Every other test here reads PIXELS_SCRIPT as text.
   *
   * That let a plain ReferenceError ship: a variable rename missed one line
   * inside the deposit helper, so the field threw "rows is not defined" on the
   * first pointermove of every page load. Thirty-odd assertions about the
   * script's contents all passed, because none of them executed a single line
   * of it. A string that mentions the right identifiers is not a program that
   * runs. So this one builds the smallest browser the script needs and drives
   * it: move, click, hover a card, and let the idle timer fire.
   */
  const { PIXELS_SCRIPT } = await import("../src/web/pixels.ts");

  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const on = (type: string, fn: (e: unknown) => void): void => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type)!.push(fn);
  };
  const fire = (type: string, e: unknown): void => {
    for (const fn of listeners.get(type) ?? []) fn(e);
  };

  const ctx = {
    clearRect() {}, fillRect() {}, set fillStyle(_v: string) {},
  };
  const canvas = { width: 0, height: 0, className: "", getContext: () => ctx };
  const shot = { isConnected: true, getBoundingClientRect: () => ({ left: 40, right: 300, top: 60, bottom: 220 }) };
  const card = { querySelector: (sel: string) => (sel === ".shot" ? shot : null) };

  const heading = { getBoundingClientRect: () => ({ left: 200, right: 620, top: 80, bottom: 150, width: 420 }) };
  const doc = {
    createElement: () => canvas,
    body: { appendChild() {} },
    visibilityState: "visible",
    addEventListener: on,
    querySelectorAll: (sel: string) => (sel === "[data-ambient]" ? [] : [heading]),
    querySelector: () => null,
    createRange: () => ({
      selectNodeContents() {},
      getBoundingClientRect: () => ({ left: 200, right: 620, top: 80, bottom: 150, width: 420 }),
    }),
    createTreeWalker: () => {
      let served = false;
      return { nextNode: () => (served ? null : ((served = true), { nodeValue: "Press launch." })) };
    },
  };

  let now = 0;
  const timers: Array<() => void> = [];
  const frames: Array<() => void> = [];

  const run = new Function(
    "matchMedia", "document", "addEventListener", "innerWidth", "innerHeight",
    "requestAnimationFrame", "performance", "setTimeout", "clearTimeout", "Float32Array",
    PIXELS_SCRIPT,
  );

  // A fine pointer, and reduced motion OFF. Returning true for both is how the
  // first version of this stub made the script bail on line three and then
  // asserted nothing, which would have been a test that passes by not running.
  const mq = (q: string) => ({ matches: /hover: hover/.test(q) });

  run(
    mq, doc, on, 800, 600,
    (fn: () => void) => { frames.push(fn); return frames.length; },
    { now: () => now },
    (fn: () => void) => { timers.push(fn); return timers.length; },
    () => {}, Float32Array,
  );

  assert.ok(listeners.has("pointermove"), "the script must have installed its listeners");

  // Drive it. Any ReferenceError or TypeError in any path surfaces here.
  fire("pointermove", { clientX: 100, clientY: 90 });
  fire("pointermove", { clientX: 260, clientY: 240 });
  fire("pointerdown", { clientX: 300, clientY: 300 });
  fire("pointerover", { target: { closest: (sel: string) => (sel === "[data-app]" ? card : null) } });
  fire("pointerover", { target: { closest: () => null } });

  // Several frames, with Pac-Man out and a card traced.
  for (let i = 0; i < 12 && frames.length > 0; i++) {
    now += 16;
    const next = frames.shift()!;
    next();
  }

  // And the idle path, which is the one that only runs from a timer.
  //
  // Snapshot first: armIdle schedules the NEXT idle from inside the current
  // one, so iterating timers.length while it grows is an infinite loop. It hung
  // this test for two minutes before the array was copied.
  now += 5000;
  const due = timers.splice(0, timers.length);
  for (const fire2 of due) fire2();
  for (let i = 0; i < 6 && frames.length > 0; i++) { now += 16; frames.shift()!(); }

  assert.ok(canvas.width > 0, "the canvas must have been sized");
});

test("the aimed arrows are excluded from the idle bag", async () => {
  // An arrow is a pointer. One appearing by itself in the middle of the page
  // during an idle stamp would be pointing at nothing, which is worse than not
  // appearing: it reads as a broken link to something.
  const { SPRITE_NAMES, SPRITES } = await import("../src/web/pixels.ts");
  assert.ok(SPRITES.arrowR && SPRITES.arrowL, "both directions must exist");
  for (const n of SPRITE_NAMES) {
    assert.ok(!n.startsWith("arrow"), `${n} is aimed and must not be picked at random`);
  }
  assert.ok(SPRITE_NAMES.length >= 4, "the idle bag still needs shapes in it");
});

test("the arrow aims at the heading's glyphs, not its column", async () => {
  // A heading is a block, so its own rect is the full column width whatever the
  // words occupy. Aiming at that put the arrow a third of a page away from the
  // headline it was pointing at, on the right hand edge of empty space.
  const { PIXELS_SCRIPT } = await import("../src/web/pixels.ts");
  assert.match(PIXELS_SCRIPT, /var b = textBox\(hs\[i\]\);/,
    "the heading's text box, not its element box");
  assert.match(PIXELS_SCRIPT, /createTreeWalker\(el, 4\)/,
    "a Range over the element is still the column, because the hero h1 wraps each line in a block span");
  assert.match(PIXELS_SCRIPT, /rg\.selectNodeContents\(n\)/, "measured per text node");
  assert.match(PIXELS_SCRIPT, /return el\.getBoundingClientRect\(\);/,
    "and a fallback, so a browser without Range still aims somewhere sane");
});

test("the cursor blob is small, sized off the recording rather than a still", async () => {
  // A still of a fast sweep shows large clouds, but those are accumulated heat
  // along a path. Sizing the brush from that gave a 180px blob that reads as a
  // stain. The reference's cursor blob is about 32px in ordinary use.
  const { FIELD_CELL, FIELD_RADIUS } = await import("../src/web/pixels.ts");
  const across = FIELD_CELL * FIELD_RADIUS * 2;
  assert.ok(across <= 90, `the blob is ${across}px across, which is a stain rather than a cursor`);
  assert.ok(across >= 40, `${across}px is too small to show a colour ramp at all`);
});

test("the aimed arrow is a single tone, like the reference's", async () => {
  const { SPRITES } = await import("../src/web/pixels.ts");
  for (const name of ["arrowR", "arrowL"]) {
    const chars = new Set(SPRITES[name]!.join("").split("").filter((c) => c !== "."));
    assert.equal(chars.size, 1, `${name} should be one tone, got ${[...chars].join("")}`);
  }
});

test("the resolve lasts long enough to be seen", async () => {
  // It ran in about 300ms and the reported symptom was not noticing it at all.
  // An animation nobody sees is an animation that is not there.
  const { PIXELATE_HOLD_FRAMES, PIXELATE_RESOLVE_FRAMES } = await import("../src/web/pixels.ts");
  const ms = ((PIXELATE_HOLD_FRAMES + PIXELATE_RESOLVE_FRAMES) / 60) * 1000;
  assert.ok(ms >= 800, `the resolve takes ${Math.round(ms)}ms, which reads as a flicker`);
  assert.ok(PIXELATE_HOLD_FRAMES >= 6,
    "the blocky frame must be held, or the eye lands on the tail of a fade");
});

test("the arrow silhouette is a shaft and a head, not a bar with nubs", async () => {
  // The first version was a bar with two nubs, which at 80px was a lump rather
  // than a direction. Asserted on the silhouette, because that is the thing
  // that was wrong and a hand drawn bitmap has no other way to be checked.
  const { SPRITES } = await import("../src/web/pixels.ts");
  for (const name of ["arrowR", "arrowL"] as const) {
    const rows = SPRITES[name]!;
    const filled = rows.map((r) => r.split("").filter((c) => c !== ".").length);
    const mid = filled[Math.floor(rows.length / 2)]!;
    assert.equal(mid, Math.max(...filled), `${name}'s widest row must be its middle`);
    assert.ok(filled[0]! <= 2, `${name} must taper to a point, not start as a bar`);
    assert.ok(mid - filled[0]! >= 6, `${name} has no head to speak of`);
  }
});

test("a shape cools the field hard, so it is not drawn over its own ghosts", async () => {
  const { SHAPE_DECAY } = await import("../src/web/pixels.ts");
  assert.ok(SHAPE_DECAY < 0.9,
    "the normal trail under a shape is the previous frames of that same shape, offset");
  assert.ok(SHAPE_DECAY > 0.4, "cooling this hard would strobe");
});

test("the blob IS an arrow near a heading, and a blob away from one", async () => {
  /*
   * Run the script and measure what it actually paints.
   *
   * The reported symptom was "it does not become an arrow many times, and it
   * does not look like an arrow". Both were one cause: at a 260px trigger the
   * cursor on the right hand side of a card is about 300px from that card's
   * title, so the common case fell outside the radius and the plain round brush
   * drew instead. What people saw was the blob, and they read it as a broken
   * arrow. Asserted by geometry, because "looks like an arrow" is exactly the
   * kind of claim a string test cannot make.
   */
  const { PIXELS_SCRIPT } = await import("../src/web/pixels.ts");

  const paintedWidth = (cx: number, cy: number): number => {
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    const on = (t: string, f: (e: unknown) => void): void => {
      if (!listeners.has(t)) listeners.set(t, []);
      listeners.get(t)!.push(f);
    };
    const xs: number[] = [];
    const ctx = { clearRect() {}, fillRect: (x: number) => { xs.push(x); }, set fillStyle(_v: string) {} };
    const canvas = { width: 0, height: 0, className: "", getContext: () => ctx, style: {} };
    // A card heading, at the position one occupies on the real page.
    const box = { left: 764, right: 1006, top: 340, bottom: 368, width: 242 };
    const doc = {
      createElement: () => canvas, body: { appendChild() {} }, visibilityState: "visible",
      addEventListener: on,
    querySelectorAll: (sel: string) =>
      (sel === "[data-ambient]" ? [] : [{ getBoundingClientRect: () => box }]),
    querySelector: () => null,
      createTreeWalker: () => {
        let done = false;
        return { nextNode: () => (done ? null : ((done = true), { nodeValue: "Jaeger" })) };
      },
      createRange: () => ({ selectNodeContents() {}, getBoundingClientRect: () => box }),
    };
    const frames: Array<() => void> = [];
    let now = 0;
    new Function(
      "matchMedia", "document", "addEventListener", "innerWidth", "innerHeight",
      "requestAnimationFrame", "performance", "setTimeout", "clearTimeout", "Float32Array",
      PIXELS_SCRIPT,
    )(
      (q: string) => ({ matches: /hover: hover/.test(q) }), doc, on, 1440, 900,
      (f: () => void) => frames.push(f), { now: () => now },
      () => {}, () => {}, Float32Array,
    );
    const fire = (t: string, e: unknown): void => { for (const f of listeners.get(t) ?? []) f(e); };
    fire("pointermove", { clientX: cx + 2, clientY: cy + 2 });
    fire("pointermove", { clientX: cx, clientY: cy });
    xs.length = 0;
    now += 16;
    frames.shift()!();
    return xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs) + 9;
  };

  /*
   * The gate is two thresholds, not one radius, and both directions of getting
   * it wrong are in this table. A 260px radius missed the right hand side of a
   * card, about 300px from its title. Widening to 380 fixed that and made the
   * cursor an arrow essentially everywhere, because headings are dense enough
   * here that almost every point is within 380px of one.
   *
   * "Hovering around a heading" means roughly LEVEL with it: generous
   * sideways, tight vertically.
   */
  const cases: Array<[number, number, "arrow" | "blob", string]> = [
    [1290, 354, "arrow", "right of the title, level with it"],
    [600, 354, "arrow", "left of the title, level with it"],
    [900, 352, "arrow", "on the title itself"],
    [885, 300, "arrow", "directly above the title"],
    [885, 410, "arrow", "directly below the title"],
    [1290, 432, "blob", "right of the title but 64px below its band"],
    [900, 560, "blob", "card body, well below the title"],
    [900, 700, "blob", "down by the launch button"],
    [300, 700, "blob", "nowhere near a heading"],
    [1380, 354, "blob", "level with it but too far right"],
  ];
  for (const [x, y, want, label] of cases) {
    const w = paintedWidth(x, y);
    const got = w > 60 ? "arrow" : "blob";
    assert.equal(got, want, `${label}: painted ${w}px, which is a ${got}`);
  }
});

test("the arrow is a pointer, not a banner", async () => {
  // Drawn AT the cursor, so it must not dominate it. At scale two it was 200px,
  // a third of a card wide.
  const { SPRITES, ARROW_SCALE, FIELD_CELL } = await import("../src/web/pixels.ts");
  const px = Math.max(...SPRITES.arrowR!.map((r) => r.length)) * ARROW_SCALE * FIELD_CELL;
  assert.ok(px <= 100, `the arrow is ${px}px on its long axis, which is a banner`);
  assert.ok(px >= 60, `${px}px is too small for the head and shaft to separate`);
});

test("scrolling a heading away turns the arrow back into a blob, without moving the cursor", async () => {
  /*
   * The shape is derived from an element's position on screen, and that has two
   * inputs. Recomputing it only on pointermove pinned it to a heading position
   * that had since moved: scrolling a heading out from under a stationary
   * cursor left it an arrow until the visitor moved the mouse. Scroll is the
   * input that is easy to forget, because nothing about it looks like input.
   *
   * Clearing `aimed` was necessary and not sufficient. The arrow's heat stays
   * in the field and fades over a second or two, and nothing redraws at the
   * cursor until it moves, so the arrow dissolved where a blob should be.
   */
  const { PIXELS_SCRIPT } = await import("../src/web/pixels.ts");

  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const on = (t: string, f: (e: unknown) => void): void => {
    if (!listeners.has(t)) listeners.set(t, []);
    listeners.get(t)!.push(f);
  };
  const fire = (t: string, e: unknown): void => { for (const f of listeners.get(t) ?? []) f(e); };
  const xs: number[] = [];
  const ctx = { clearRect() {}, fillRect: (x: number) => { xs.push(x); }, set fillStyle(_v: string) {} };
  const canvas = { width: 0, height: 0, className: "", getContext: () => ctx, style: {} };
  let box = { left: 764, right: 1006, top: 340, bottom: 368, width: 242 };
  const doc = {
    createElement: () => canvas, body: { appendChild() {} }, visibilityState: "visible",
    addEventListener: on,
    querySelectorAll: (sel: string) =>
      (sel === "[data-ambient]" ? [] : [{ getBoundingClientRect: () => box }]),
    querySelector: () => null,
    createTreeWalker: () => {
      let done = false;
      return { nextNode: () => (done ? null : ((done = true), { nodeValue: "H" })) };
    },
    createRange: () => ({ selectNodeContents() {}, getBoundingClientRect: () => box }),
  };
  const frames: Array<() => void> = [];
  let now = 0;
  new Function(
    "matchMedia", "document", "addEventListener", "innerWidth", "innerHeight",
    "requestAnimationFrame", "performance", "setTimeout", "clearTimeout", "Float32Array",
    PIXELS_SCRIPT,
  )(
    (q: string) => ({ matches: /hover: hover/.test(q) }), doc, on, 1440, 900,
    (f: () => void) => frames.push(f), { now: () => now }, () => {}, () => {}, Float32Array,
  );

  const width = (): number => {
    xs.length = 0;
    now += 16;
    frames.shift()!();
    return xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs) + 9;
  };

  fire("pointermove", { clientX: 900, clientY: 352 });
  fire("pointermove", { clientX: 898, clientY: 354 });
  assert.ok(width() > 60, "level with the heading it must be an arrow");

  // Scroll it far out of range. The cursor does NOT move.
  box = { left: 764, right: 1006, top: -900, bottom: -872, width: 242 };
  fire("scroll", {});
  const after = width();
  assert.ok(after > 0 && after < 60,
    `after scrolling the heading away it must be a blob again, painted ${after}px`);
});

test("the arrow points four ways, and the tip is a single cell in each", async () => {
  // Left and right only meant a cursor sitting directly above or below a
  // heading pointed sideways at nothing.
  const { SPRITES } = await import("../src/web/pixels.ts");
  const names = ["arrowR", "arrowL", "arrowU", "arrowD"] as const;
  for (const n of names) assert.ok(SPRITES[n], `${n} is missing, so that direction is unreachable`);

  const lit = (rows: string[]): number[][] =>
    rows.map((r) => r.split("").map((c) => (c === "." ? 0 : 1)));

  // Horizontal arrows: widest row in the middle, tapering to one cell at top.
  for (const n of ["arrowR", "arrowL"] as const) {
    const counts = lit(SPRITES[n]!).map((r) => r.reduce((a, b) => a + b, 0));
    assert.equal(counts[Math.floor(counts.length / 2)], Math.max(...counts),
      `${n}'s widest row must be its middle`);
    assert.equal(counts[0], 1, `${n} must taper to a single cell`);
  }
  // Vertical arrows: the same shape stood up, so the widest COLUMN is central
  // and one end row is a single cell.
  for (const n of ["arrowU", "arrowD"] as const) {
    const rows = SPRITES[n]!;
    const counts = rows.map((r) => r.split("").filter((c) => c !== ".").length);
    assert.ok(Math.max(...counts) === rows[0]!.length,
      `${n} must have a row spanning its full width, which is the head's base`);
    const ends = [counts[0]!, counts[counts.length - 1]!];
    assert.ok(ends.includes(1), `${n} must taper to a single cell at one end`);
  }
});

test("above a WIDE heading it points down, wherever along it the cursor is", async () => {
  /*
   * Comparing the two axes alone is right in the middle and wrong at the ends.
   *
   * The hero h1 spans 188 to 930. Above its left end at x=210, the horizontal
   * offset to its centre is 349px and the vertical offset is 137px, so the
   * larger axis was horizontal and the arrow pointed sideways ALONG the heading
   * while sitting directly above it. Reported from a screenshot, and I first
   * mistook it for a stale page because the case I reproduced by hand happened
   * to be the middle, where the arithmetic gives the right answer.
   *
   * Being within a heading's columns means above or below it, whatever the
   * distance to its centre says.
   */
  const { SPRITES } = await import("../src/web/pixels.ts");
  const box = { left: 188, right: 930, top: 91, bottom: 294 };
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;

  // The rule, stated directly: inside the columns is vertical, outside compares.
  const direction = (x: number, y: number): string => {
    if (x >= box.left && x <= box.right) return cy - y > 0 ? "arrowD" : "arrowU";
    return Math.abs(cx - x) >= Math.abs(cy - y)
      ? (cx - x > 0 ? "arrowR" : "arrowL")
      : (cy - y > 0 ? "arrowD" : "arrowU");
  };
  const vertical = (n: string): boolean => n === "arrowU" || n === "arrowD";

  for (const x of [210, 400, 559, 800, 925]) {
    assert.ok(vertical(direction(x, 55)), `above the heading at x=${x} must point down`);
    assert.ok(vertical(direction(x, 340)), `below the heading at x=${x} must point up`);
  }
  assert.equal(direction(120, 190), "arrowR", "left of it, level, points right");
  assert.equal(direction(1050, 190), "arrowL", "right of it, level, points left");

  // And the source implements that rule rather than the axis comparison alone.
  const { PIXELS_SCRIPT } = await import("../src/web/pixels.ts");
  assert.match(PIXELS_SCRIPT, /if \(x >= box\.left && x <= box\.right\) \{/,
    "inside the heading's columns must short circuit to vertical");
  assert.ok(SPRITES.arrowU && SPRITES.arrowD, "both vertical sprites must exist");
});

test("paused launches are refused by the ENDPOINT, not just hidden in the page", async () => {
  // A disabled button is a decoration. The thing that creates a sandbox on
  // somebody else's account has to be the thing that says no, or "we took it
  // down" means "we took down the way we happened to link to it".
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  for (const route of ['/launch/', '/launch-share/']) {
    const at = src.indexOf(`url.pathname.startsWith("${route}")`);
    assert.ok(at > 0, `${route} route moved`);
    const body = src.slice(at, at + 400);
    assert.match(body, /if \(LAUNCHES_DISABLED\) return send\(503/,
      `${route} must refuse while launches are paused`);
  }
});

test("a paused catalog still shows the apps, the board and the reason", () => {
  const html = renderCatalog(board, [app()], undefined, [], "Paused pending a permission answer.");
  assert.match(html, /Launches are paused/, "the reason has to be on the page");
  assert.match(html, /Paused pending a permission answer\./);
  assert.match(html, /Launches paused<\/button>/, "the button says what it is");
  assert.ok(!/data-launch=/.test(html), "no live launch control may remain");
  // The evidence stays up: this is what the site is FOR.
  assert.match(html, /Gitea/, "the catalog still lists the apps");
  assert.match(html, /INSTANCES RUNNING|Instances running/i, "the board stays");
});

test("an expired instance says what happened, not that something did", async () => {
  const { renderInstanceEnded } = await import("../src/web/render.ts");
  const html = renderInstanceEnded({ appName: "Uptime Kuma", reason: "expired", lastedMinutes: 10 });
  // The old page said "That instance is gone", which is accurate and tells a
  // visitor nothing: not what happened, not whether they broke it, not what next.
  assert.match(html, /reached the end of its ten minutes/);
  assert.match(html, /nothing went wrong/, "it must say this was expected");
  assert.match(html, /Launch another/, "and offer the one action worth taking");
  // The dead preview link is the thing they are most likely to click again.
  assert.match(html, /404/, "it must explain the bare 404 the old link now gives");
  assert.ok(!/That instance is gone/.test(html));
});

test("a destroyed instance is not described as having expired", async () => {
  const { renderInstanceEnded } = await import("../src/web/render.ts");
  const html = renderInstanceEnded({ appName: "Gitea", reason: "destroyed" });
  assert.match(html, /You destroyed your Gitea/);
  assert.ok(!/ten minutes/.test(html), "do not tell someone their instance timed out when they ended it");
});

test("the toolbar route answers 410 for an instance that has ended", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  const at = src.indexOf('url.pathname.startsWith("/toolbar/")');
  const body = src.slice(at, at + 2200);
  assert.match(body, /send\(410, renderInstanceEnded/,
    "410 Gone is the status for a resource that existed and deliberately does not now");
  assert.ok(!/That instance is gone/.test(body));
  // And an instance that is alive but not yet handed over is neither gone nor
  // ready: rendering a toolbar there shows every control beside a 00:00 timer.
  assert.match(body, /inst\.lifetimeStartedAt === null/);
  assert.match(body, /send\(409/, "not yet handed over is a different answer from gone");
});

test("the handover lands where the card's screenshot was taken", async () => {
  // V103: every card photographed a deep path while the handover dropped the
  // visitor at "/". The card and the arrival have to be the same screen.
  const { renderToolbar, at } = await import("../src/web/render.ts");
  const base = "https://abc-3000.preview.getsolari.com/?pt_token=SECRET";
  const html = renderToolbar({
    id: "i1", appName: "Gitea", previewUrl: base, msRemaining: 60000,
    extended: false, landingPath: "/blink/welcome/issues", credentials: null,
  });
  const href = /href="([^"]*preview\.getsolari\.com[^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(href, "the open link must be on the toolbar");
  const u = new URL(href!);
  assert.equal(u.pathname, "/blink/welcome/issues", "it must land on the card's path");
  assert.equal(u.searchParams.get("pt_token"), "SECRET",
    "and keep the capability, which new URL() would have dropped (V72)");
  // at() is the shared rule, so the same bug cannot come back through a helper.
  assert.equal(new URL(at(base, "/x")).searchParams.get("pt_token"), "SECRET");
  assert.equal(at(base, undefined), base, "no path means the base, unchanged");
});

test("an app with a login shows its credentials, on the card and the toolbar", async () => {
  const { renderToolbar } = await import("../src/web/render.ts");
  const creds = { user: "blink", password: "blink-demo-2026" };
  const bar = renderToolbar({
    id: "i1", appName: "Uptime Kuma", previewUrl: "https://a-3001.preview.getsolari.com/?pt_token=S",
    msRemaining: 1000, extended: false, landingPath: "/dashboard", credentials: creds,
  });
  assert.match(bar, /blink-demo-2026/, "the password has to be where the visitor is");
  assert.match(bar, /dies with it in ten minutes/, "and say why publishing it is safe");

  const html = renderCatalog(board, [{ ...app(), credentials: creds }], undefined, []);
  assert.match(html, /signs you in with blink \/ blink-demo-2026/);
});

test("no card claims to be logged in without giving the way in", async () => {
  // The exact defect: "Uptime monitoring, logged in" over a password prompt the
  // visitor was never given.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  for (const m of src.matchAll(/description: "([^"]*)"/g)) {
    const text = m[1]!;
    if (/logged in/i.test(text)) {
      assert.fail(`a card says "logged in": ${text}`);
    }
  }
});

test("a shared invite link that has ended explains itself to someone with no context", async () => {
  const { renderInstanceEnded } = await import("../src/web/render.ts");
  const html = renderInstanceEnded({ appName: "Gitea", reason: "unknown", shared: true });
  assert.match(html, /Somebody shared this with you/);
  assert.match(html, /Launch your own/, "the offer differs from the owner's");
});

test("/go/:id redirects to the landing path, or explains that it ended", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  const at = src.indexOf('url.pathname.startsWith("/go/")');
  assert.ok(at > 0, "the invite route must exist");
  const body = src.slice(at, at + 900);
  assert.match(body, /renderInstanceEnded/, "a dead instance must explain, not 404");
  assert.match(body, /shared: true/, "and know the holder did not launch it");
  assert.match(body, /at\(inst\.previewUrl, inst\.landingPath/,
    "a live instance must redirect to the landing path with its token intact");
});

test("launch buttons are gated on the token, because one widget serves all five cards", () => {
  const html = renderCatalog(board, [app()], "sitekey");
  // One widget, one token, five cards. Nothing on the buttons reflected whether
  // a token existed, so a visitor could press Launch before the check finished,
  // get missing_token, and see the other cards still looking ready. They would
  // all have failed identically.
  assert.equal((html.match(/id="ts-widget"/g) ?? []).length, 1, "one shared widget");
  assert.match(html, /blinkTsSetState\("pending"/, "buttons must start gated");
  assert.match(html, /b\.disabled = !ready;/, "the gate has to touch every button");
  assert.match(html, /if \(blinkTsRequired && !blinkTsToken\) \{/,
    "a launch with no token must be refused locally, not sent to be refused");
  // And re-gated after every attempt, or the next card fails the same way.
  assert.match(html, /blinkTsSetState\("pending", "checking you are a person again"\)/);
});

test("the widget is above the cards, not below all five", () => {
  // It was rendered after every card, well below the fold, so a visitor reached
  // the Launch buttons having never seen the thing that has to complete first.
  const html = renderCatalog(board, [app()], "sitekey");
  assert.ok(html.indexOf('id="ts-widget"') < html.indexOf('class="cards"'),
    "the check has to be visible before the buttons it gates");
});

test("a button that is off for another reason is never re-enabled by the token", () => {
  // Paused launches and a down app are permanent for this page load. The
  // Turnstile gate must not undo them when a token arrives.
  const paused = renderCatalog(board, [app()], "sitekey", [], "Paused.");
  assert.match(paused, /data-permanently-off="1"/);
  const html = renderCatalog(board, [app()], "sitekey");
  assert.match(html, /if \(b\.getAttribute\("data-permanently-off"\) === "1"\) return;/);
});

test("the Source link points at the author, not a guessed handle", async () => {
  // It shipped pointing at github.com/utkarshbahuguna, which is not the author's
  // account. A public link to the wrong person is worse than no link, and this
  // is the kind of detail no test would ever fail on by accident.
  const { SOURCE_URL } = await import("../src/web/render.ts");
  assert.match(SOURCE_URL, /u7k4rs6/, "the handle is u7k4rs6");
  const html = renderCatalog(board, [app()], undefined, []);
  assert.ok(!/github\.com\/utkarshbahuguna/.test(html), "the wrong handle must not be in the page");
  assert.match(html, /github\.com\/u7k4rs6/);
});

test("the URL is not reported to the client before the clock starts", async () => {
  /*
   * previewUrl is resolved during CHECKING now, because the guest boot script
   * needs it for ROOT_URL (V107). The polling client read "previewUrl present"
   * as "handed over" and swapped in the toolbar immediately, before expiresAt
   * existed, so msRemaining was null and the timer rendered 00:00 on an
   * instance that was alive and still being checked.
   */
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  const at = server.indexOf('url.pathname.startsWith("/instance/")');
  const body = server.slice(at, at + 1600);
  assert.match(body, /const handedOver = inst\.lifetimeStartedAt !== null;/);
  assert.match(body, /previewUrl: handedOver \? inst\.previewUrl : null,/,
    "the capability must not be reported before the guest self destruct is armed");

  // And the client waits for the state, not merely for the field.
  const html = renderCatalog(board, [app()], undefined, []);
  assert.match(html, /s\.previewUrl && \(s\.state === "HANDOVER" \|\| s\.state === "LIVE"\)/);
});

test("the unstyled-page warning is gone, now that the cause is fixed", async () => {
  // It was interim, while ROOT_URL was being set to the literal string "arm"
  // (V107). Leaving a warning up after its cause is fixed teaches people to
  // read warnings as decoration.
  const { renderToolbar } = await import("../src/web/render.ts");
  const html = renderToolbar({
    id: "i1", appName: "Gitea", previewUrl: "https://a-3000.preview.getsolari.com/?pt_token=S",
    msRemaining: 600000, extended: false, landingPath: "/blink/welcome/issues", credentials: null,
  });
  assert.ok(!/page looks unstyled or broken/.test(html));
  assert.match(html, /until your Gitea is destroyed/, "the toolbar itself is intact");
});

test("the open button is pink, filled, and readable", async () => {
  const { TOKENS, CSS, contrast } = await import("../src/web/tokens.ts");
  // It carries paper coloured text, so it is held to the same floor as every
  // other piece of text on the page rather than being exempt for being a brand
  // colour. The prettier pinks sit at 4.35 and do not clear it.
  assert.ok(contrast(TOKENS.pink, TOKENS.bg) >= 4.5,
    `pink is ${contrast(TOKENS.pink, TOKENS.bg).toFixed(2)} against paper`);
  assert.match(CSS, /\.btn-open \{[^}]*background: var\(--pink\)/);
  assert.match(CSS, /\.btn-open \{[^}]*color: var\(--paper\)/);

  const { renderToolbar } = await import("../src/web/render.ts");
  const html = renderToolbar({
    id: "i1", appName: "Gitea", previewUrl: "https://a-3000.preview.getsolari.com/?pt_token=S",
    msRemaining: 600000, extended: false, landingPath: "/blink/welcome/issues", credentials: null,
  });
  assert.match(html, /class="btn btn-open"[^>]*>Open your Gitea</,
    "the primary action must not look like the four secondary ones");
  assert.ok(!/class="btn btn-ghost"[^>]*>Open your/.test(html));
});
