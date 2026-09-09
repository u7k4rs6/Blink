/**
 * Cloudflare Worker: serve Blink when the laptop is up, and a cached offline
 * page when it is not.
 *
 * A dead hostname is the one outcome that loses a reader outright. They arrived
 * from a post at a time nobody controls, and a connection error tells them
 * nothing except that this does not work.
 *
 * How it decides: try the origin with a short timeout. Anything that is not a
 * usable response, meaning a network error, a timeout, or a 5xx from the tunnel
 * when nothing is behind it, falls back. Everything else is passed through
 * untouched, including 404s, which are the app's own answers and not an outage.
 *
 * The snapshot is refreshed opportunistically: every successful request has a
 * small chance of updating the cached numbers, so the offline page stays close
 * to current without a cron job or a second moving part.
 */

const ORIGIN_TIMEOUT_MS = 8000;
const SNAPSHOT_KEY = "blink:offline-snapshot";
const SNAPSHOT_REFRESH_CHANCE = 0.02;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Never fall back for these: an offline page with a 200 in place of an API
    // response would be worse than an error, because a caller would parse it.
    const isApi = url.pathname.startsWith("/instance/")
      || url.pathname.startsWith("/instances")
      || url.pathname.startsWith("/extend/")
      || url.pathname.startsWith("/share/");

    /**
     * Classify the failure, do not just detect it.
     *
     * Once this Worker is live a broken origin renders as a working offline
     * page. That is a success state that looks like a success state, which is
     * the exact shape of every expensive bug in this project. So the page
     * carries WHY it fell back, in a form an operator can read and a visitor
     * reads past.
     *
     * Elapsed time is what separates "nothing is listening" from "something
     * accepted the connection and never answered". A refused connection fails in
     * milliseconds; a hung origin fails at the timeout. Those are different
     * problems with different fixes, and a single "origin unreachable" hides
     * the difference.
     */
    const startedAt = Date.now();
    let response = null;
    let threw = false;
    try {
      response = await fetch(request, { signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS) });
    } catch (err) {
      threw = true;
    }
    const elapsedMs = Date.now() - startedAt;
    const failure = classifyOrigin({
      threw, status: response === null ? null : response.status,
      elapsedMs, timeoutMs: ORIGIN_TIMEOUT_MS,
    });

    const originUsable = failure === null && response !== null;

    if (originUsable) {
      // Opportunistically refresh the cached snapshot from a live origin.
      if (env.BLINK_KV && Math.random() < SNAPSHOT_REFRESH_CHANCE) {
        ctx.waitUntil(refreshSnapshot(url, env));
      }
      return response;
    }

    // Operator headers. Invisible to a visitor, one curl away for you.
    //
    // The raw status is carried separately from the classification. Folding
    // them into one field is what produced `origin-530`, a label that read as
    // "Blink crashed" for the one condition that means "Blink is not there".
    const diag = {
      "x-blink-origin": failure ?? "unknown",
      "x-blink-origin-status": response === null ? "none" : String(response.status),
      "x-blink-origin-ms": String(elapsedMs),
      "x-blink-checked": new Date().toISOString(),
    };

    if (isApi) {
      return new Response(JSON.stringify({ error: "origin unreachable", reason: failure }), {
        status: 503,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...diag },
      });
    }

    const snapshot = env.BLINK_KV ? await env.BLINK_KV.get(SNAPSHOT_KEY, "json") : null;
    return new Response(offlinePage(snapshot, failure, elapsedMs), {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Short, because the laptop may come back at any moment and a reader
        // who reloads should get the real site rather than a stale apology.
        "cache-control": "public, max-age=60",
        "retry-after": "300",
        ...diag,
      },
    });
  },
};

async function refreshSnapshot(url, env) {
  try {
    const res = await fetch(`${url.origin}/offline-snapshot.json`, {
      signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
    });
    if (res.ok) await env.BLINK_KV.put(SNAPSHOT_KEY, await res.text());
  } catch {
    // A failed refresh keeps the previous snapshot, which is the right outcome:
    // stale numbers beat no numbers, and they are labelled with their date.
  }
}

/**
 * Which of three problems is this: absent, hung, or up and broken.
 *
 * MEASURED, not assumed. Stopping the tunnel for 46 seconds against the live
 * deployment returned `x-blink-origin: origin-530`, and the offline page told
 * the visitor "Blink is asleep right now" in the headline and "The machine is
 * awake but returned an error (status 530)" four lines below it. Both on the
 * same page, saying opposite things.
 *
 * The cause is that Cloudflare's edge SYNTHESISES a status when it cannot reach
 * a tunnel origin, so the Worker's fetch resolves with a response rather than
 * throwing. The old code read "a response arrived, and it is 5xx" as "the
 * origin answered and is failing", which is true of a 500 from Blink and false
 * of every one of these:
 *
 *   530  error 1033, tunnel not connected. THE case this deployment has
 *   521  web server is down
 *   522  connection timed out before the origin accepted
 *   523  origin is unreachable
 *   524  origin ACCEPTED and never answered, which is a hang, not an absence
 *
 * So 524 is the only one of them that is not an absence, and it is the one that
 * looks most like the others. Anything else at or above 500 really is Blink
 * answering badly, and stays distinguishable.
 */
export function classifyOrigin({ threw, status, elapsedMs, timeoutMs }) {
  if (threw) {
    // At or near the timeout means the connection was accepted and nothing came
    // back: Blink is running but wedged, thrashing, or mid restart. A refused
    // connection fails in milliseconds.
    return elapsedMs >= timeoutMs - 500 ? "timeout" : "no-origin";
  }
  if (status === null) return "no-origin";
  if (status === 530 || status === 521 || status === 522 || status === 523) return "no-origin";
  if (status === 524) return "timeout";
  if (status >= 500) return `origin-${status}`;
  return null;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * One sentence a visitor reads past and an operator can decode.
 *
 * Plain enough that a stranger takes it as ordinary status text, specific enough
 * that it names which of three different problems is happening.
 */
function statusLine(failure, ms) {
  switch (failure) {
    case "no-origin":
      return `The machine did not answer (checked in ${ms} ms).`;
    case "timeout":
      return `The machine answered too slowly to serve this page (waited ${ms} ms).`;
    default:
      if (failure && failure.startsWith("origin-")) {
        return `The machine is awake but returned an error (${esc(failure.replace("origin-", "status "))}).`;
      }
      return "The machine did not answer.";
  }
}

function offlinePage(s, failure, ms) {
  const captured = s?.capturedAt ? esc(String(s.capturedAt).slice(0, 16).replace("T", " ")) : null;
  const rows = (s?.apps ?? []).map((a) => `
    <div class="row">
      <div><strong>${esc(a.name)}</strong></div>
      <div class="muted">${esc(a.asked)}</div>
      <div class="mono ${a.ok ? "accent" : "fail"}">${a.ok ? "passing" : "failing"}</div>
    </div>`).join("");

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blink is asleep</title>
<style>
:root{--paper:#FFFFFF;--surface:#FAFAFA;--border:#E3E3E3;--ink:#0A0A0A;--muted:#6E6E6E;
--accent:#1A7F37;--fail:#C1341A;--line:rgba(10,10,10,.12);--line-2:rgba(10,10,10,.06);--cell:14px}
*{box-sizing:border-box}
body{margin:0;background-color:var(--paper);
background-image:linear-gradient(to right,var(--line-2) 1px,transparent 1px),linear-gradient(to bottom,var(--line-2) 1px,transparent 1px);
background-size:var(--cell) var(--cell);background-attachment:fixed;
color:var(--ink);font-family:"Helvetica Neue",Helvetica,Inter,system-ui,-apple-system,Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1176px;margin:0 auto;padding:calc(var(--cell)*6) 56px}
a{color:var(--ink);border-bottom:1px solid var(--line);text-decoration:none}
a:hover{border-bottom-color:var(--ink)}
h1{font-size:clamp(38px,7vw,96px);font-weight:300;letter-spacing:-.03em;line-height:1;margin:0 0 calc(var(--cell)*2);max-width:13ch}
h2{font-size:clamp(20px,2.4vw,28px);font-weight:400;letter-spacing:-.02em;margin:calc(var(--cell)*4) 0 var(--cell)}
p{max-width:62ch}
.muted{color:var(--muted)}.accent{color:var(--accent)}.fail{color:var(--fail)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;
font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.row{display:grid;gap:8px;padding:calc(var(--cell)*1) 0;border-bottom:1px solid var(--line-2);font-size:14px}
@media(min-width:720px){.row{grid-template-columns:180px 1fr 90px;align-items:center}}
table{font-family:ui-monospace,monospace;font-size:13px;border-collapse:collapse;max-width:520px;width:100%}
td{padding:4px 8px;border-bottom:1px solid var(--line-2)}td:last-child{text-align:right}
@media(max-width:720px){.wrap{padding:calc(var(--cell)*3) 20px}}
</style></head><body><main class="wrap">

<h1>Blink is asleep right now.</h1>

<p>Blink runs from a laptop, not a server. It is up while that machine is awake and
connected, and right now it is not. Nothing is broken.${
  s?.awakeHoursUtc ? ` It is usually up around ${esc(s.awakeHoursUtc)}.` : ""}</p>

<p class="muted">That is a real limitation of how this is hosted, and the health wall says the
same thing when the site is up.${captured ? ` Everything below was measured, and is shown from a
cache written at ${captured} UTC.` : ""}</p>

<h2>What it does when it is awake</h2>
<p class="muted">You pick an open source app, press Launch, and get your own seeded instance in
a few seconds. It is yours alone, and it is destroyed ten minutes later.</p>
${s?.recordingUrl ? `<p><a href="${esc(s.recordingUrl)}">Watch a recorded launch</a>, which is the same thing you would have done here.</p>` : ""}

${rows ? `<h2>Last known health</h2>
<p class="muted">Each check does the app's real work. None of them is a status code, because an
app can answer 200 from its own installer.</p>${rows}` : ""}

${s ? `<h2>Measured</h2>
<table>
<tr><td>previewUrl resolve, p50</td><td>${s.resolveP50Ms == null ? "no data" : esc(s.resolveP50Ms) + " ms"}</td></tr>
<tr><td>previewUrl resolve, p95</td><td>${s.resolveP95Ms == null ? "no data" : esc(s.resolveP95Ms) + " ms"}</td></tr>
<tr><td>soaked, total</td><td>${esc(s.soak?.distinctHours ?? 0)} h across ${esc(s.soak?.runs ?? 0)} runs</td></tr>
<tr><td>longest uninterrupted</td><td>${esc(s.soak?.continuousHours ?? 0)} h</td></tr>
</table>
<p class="muted" style="font-size:12px">Total hours and longest uninterrupted stretch are different
numbers and are never added together. A laptop that sleeps cannot produce a continuous day, so that
is not claimed.</p>` : ""}

${s?.repoUrl ? `<p style="margin-top:40px"><a href="${esc(s.repoUrl)}">The code, the measurements and the
write-up</a>, including every failure found along the way.</p>` : ""}

<p class="muted" style="font-size:12px;margin-top:40px">${esc(statusLine(failure, ms))} Served by
Cloudflare from a cache. Reload in a while and the real site may be back.</p>
</main></body></html>`;
}
