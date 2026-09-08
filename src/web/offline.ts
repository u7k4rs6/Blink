/**
 * The offline page.
 *
 * Served by a Cloudflare Worker when the laptop is unreachable. A dead hostname
 * is the one outcome that loses a reader outright: they arrived from a post, at
 * a time nobody controls, and a connection error tells them nothing except that
 * this does not work.
 *
 * So the page says the machine is asleep, says roughly when it is up, and still
 * shows the measurements, because the numbers are the point of the project and
 * they do not stop being true when the laptop is closed.
 *
 * Same register as the health wall and the cold and warm labels: state the
 * limitation where the reader is, in the plainest available words, and do not
 * dress it up as maintenance.
 */

import { CSS } from "./tokens.ts";
import { esc } from "./render.ts";

export type OfflineSnapshot = {
  /** When the cache was written, ISO. */
  capturedAt: string;
  apps: Array<{ name: string; asked: string; ok: boolean }>;
  resolveP50Ms: number | null;
  resolveP95Ms: number | null;
  soak: { distinctHours: number; continuousHours: number; runs: number };
  /** Local hours the operator is typically awake, in UTC, for the "back around" line. */
  awakeHoursUtc?: string;
  recordingUrl?: string;
  repoUrl?: string;
};

export function renderOffline(s: OfflineSnapshot): string {
  const captured = s.capturedAt.slice(0, 16).replace("T", " ");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blink is asleep</title>
<style>${CSS}</style>
</head><body>
<main class="wrap" style="padding:64px 16px;max-width:720px">

  <h1 style="font-size:28px;margin:0 0 16px">Blink is asleep right now.</h1>

  <p style="max-width:62ch;margin:0 0 8px">
    Blink runs from a laptop, not a server. It is up while that machine is awake and
    connected, and right now it is not. Nothing is broken.
    ${s.awakeHoursUtc ? `It is usually up around ${esc(s.awakeHoursUtc)}.` : ""}
  </p>
  <p class="muted" style="max-width:62ch;margin:0 0 40px">
    That is a real limitation of how this is hosted, and the health wall says the same
    thing when the site is up. Everything below was measured, and is shown from a cache
    written at ${esc(captured)} UTC.
  </p>

  <h2 style="font-size:18px;margin:0 0 8px">What it does when it is awake</h2>
  <p class="muted" style="max-width:62ch;margin:0 0 16px;font-size:14px">
    You pick an open source app, press Launch, and get your own seeded instance in a
    few seconds. It is yours alone, and it is destroyed ten minutes later.
  </p>
  ${s.recordingUrl ? `<p style="margin:0 0 40px"><a href="${esc(s.recordingUrl)}">Watch a recorded launch</a>, which is the same thing you would have done here.</p>` : ""}

  <h2 style="font-size:18px;margin:40px 0 8px">Last known health</h2>
  <p class="muted" style="font-size:13px;margin:0 0 16px">
    Each check does the app's real work. None of them is a status code, because an app
    can answer 200 from its own installer.
  </p>
  ${s.apps.map((a) => `<div class="row">
    <div><strong>${esc(a.name)}</strong></div>
    <div class="muted" style="font-size:13px">${esc(a.asked)}</div>
    <div class="mono ${a.ok ? "accent" : "fail"}" style="font-size:13px">${a.ok ? "passing" : "failing"}</div>
  </div>`).join("\n")}

  <h2 style="font-size:18px;margin:40px 0 8px">Measured</h2>
  <table class="receipt" style="max-width:520px">
    <tr><td>previewUrl resolve, p50</td><td>${s.resolveP50Ms === null ? "no data" : `${s.resolveP50Ms} ms`}</td></tr>
    <tr><td>previewUrl resolve, p95</td><td>${s.resolveP95Ms === null ? "no data" : `${s.resolveP95Ms} ms`}</td></tr>
    <tr><td>soaked, total</td><td>${s.soak.distinctHours} h across ${s.soak.runs} runs</td></tr>
    <tr><td>longest uninterrupted</td><td>${s.soak.continuousHours} h</td></tr>
  </table>
  <p class="muted" style="font-size:12px;max-width:62ch">
    Total hours and longest uninterrupted stretch are different numbers and are never
    added together. A laptop that sleeps cannot produce a continuous day, so that is
    not claimed.
  </p>

  ${s.repoUrl ? `<p style="margin-top:40px"><a href="${esc(s.repoUrl)}">The code, the measurements and the write-up</a>, including every failure found along the way.</p>` : ""}

  <p class="muted" style="font-size:12px;margin-top:40px">
    This page is served by Cloudflare from a cache. Reload in a while and the real site
    may be back.
  </p>
</main></body></html>`;
}
