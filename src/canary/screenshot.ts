/**
 * Canary screenshots.
 *
 * Every card's largest element is a 16:10 frame, and until now it was an empty
 * grey rectangle. That is the first thing a reviewer sees, before a word of
 * copy, so it is worth the browser-seconds: five sessions at about 20 s each is
 * roughly 100 browser-seconds, about $0.003 at Starter rates.
 *
 * TWO RULES, both from the security doc.
 *
 * The image comes from the CANARY's own instance, never a visitor's (T6).
 * Visitor instances are private and are killed, not photographed.
 *
 * No previewUrl may appear anywhere in the image. `Page.captureScreenshot`
 * returns the page viewport only, with no browser chrome, so there is no address
 * bar to leak the capability URL (V21, V60). That is a property of the capture
 * method rather than something to crop afterwards, which is why this uses CDP
 * directly rather than a screenshot helper that might include chrome.
 */

import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { Solari } from "@solarisdk/browser";
import { registerSecret } from "../redact.ts";
import { safeErr, safeOut } from "../safe-io.ts";

/** 16:10, matching the card frame, so nothing is cropped in the browser. */
const WIDTH = 1280;
const HEIGHT = 800;
const SETTLE_MS = Number(process.env.BLINK_SHOT_SETTLE_MS ?? 4000);
/** Recapture at most this often. A card does not need a fresh photo hourly. */
export const SHOT_MAX_AGE_MS = Number(process.env.BLINK_SHOT_MAX_AGE_MS ?? 6 * 3600_000);

export function shotIsFresh(path: string): boolean {
  if (!existsSync(path)) return false;
  return Date.now() - statSync(path).mtimeMs < SHOT_MAX_AGE_MS;
}

async function cdp(ws: WebSocket, method: string, params: Record<string, unknown>,
                   sessionId?: string, id = Math.floor(Math.random() * 1e9)): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
    const onMsg = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        if (m.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg as never);
        if (m.error) reject(new Error(m.error.message ?? "cdp error"));
        else resolve(m.result ?? {});
      } catch { /* not ours */ }
    };
    ws.addEventListener("message", onMsg as never);
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });
}

/**
 * Join a path onto a preview URL, keeping the capability token.
 *
 * Same rule as the liveness checks (V72): `new URL(path, base)` drops the query,
 * and the query IS the credential, so the navigation would 401 and the card
 * would show an error page.
 */
function at(base: string, path: string): string {
  const b = new URL(base);
  const token = b.searchParams.get("pt_token");
  const out = new URL(path, b);
  if (token) out.searchParams.set("pt_token", token);
  return out.toString();
}

export async function captureAppScreenshot(opts: {
  apiKey: string; previewUrl: string; outPath: string; appId: string;
  /** The view that shows the seeded state. Defaults to the root. */
  shotPath?: string;
  /** Runs in the page before capture, for apps that gate behind a login. */
  shotScript?: string;
  /**
   * A JS expression that must be true in the page for the shot to be published.
   *
   * Without this a capture is a liveness check with a camera on it. Every one of
   * these ran green while three of the five cards showed an app sitting on its
   * empty default screen: the shutter opens whether or not the page it was
   * pointed at ever arrived. The expression names what the seeded state looks
   * like, so a shot of the wrong page fails instead of being published.
   */
  shotExpect?: string;
}): Promise<{ ok: boolean; bytes: number; ms: number; error?: string }> {
  const t0 = performance.now();
  const client = new Solari({ apiKey: opts.apiKey });
  let sessionId: string | null = null;
  let ws: WebSocket | null = null;

  try {
    const session = await client.sessions.create({});
    // Session ids embed the org id. Register before anything can write one.
    registerSecret(session.id);
    registerSecret(session.cdpEndpoint);
    registerSecret(session.wsEndpoint);
    sessionId = session.id;

    ws = new WebSocket(session.cdpEndpoint);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("cdp connect timeout")), 20_000);
      ws!.addEventListener("open", () => { clearTimeout(t); resolve(); });
      ws!.addEventListener("error", () => { clearTimeout(t); reject(new Error("cdp connect error")); });
    });

    const created = await cdp(ws, "Target.createTarget", { url: "about:blank" }) as { targetId?: string };
    if (!created.targetId) throw new Error("no targetId");
    const attached = await cdp(ws, "Target.attachToTarget", { targetId: created.targetId, flatten: true }) as { sessionId?: string };
    const sid = attached.sessionId;
    if (!sid) throw new Error("no cdp session");

    await cdp(ws, "Emulation.setDeviceMetricsOverride",
      { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sid);
    await cdp(ws, "Page.enable", {}, sid);
    await cdp(ws, "Runtime.enable", {}, sid);
    await cdp(ws, "Page.navigate", { url: at(opts.previewUrl, opts.shotPath ?? "/") }, sid);

    if (opts.shotScript) {
      // Wrapped in an async IIFE and awaited, so a login that navigates has
      // finished before the shutter opens.
      //
      // The script reports rather than throwing, because a script that ends in a
      // full page navigation kills its own promise and the evaluate rejects on
      // success. So a rejection here means "the page went away", which is
      // usually what was wanted, and a returned FAILED marker means the script
      // knew it had gone wrong. Only the second is worth logging. Neither aborts
      // the capture: shotExpect below is what decides whether to publish.
      await new Promise((r) => setTimeout(r, 1500));
      const ran = await cdp(ws, "Runtime.evaluate", {
        expression: `(async () => { try { ${opts.shotScript}; return "SHOT_SCRIPT_OK"; }`
          + ` catch (e) { return "SHOT_SCRIPT_FAILED: " + ((e && e.message) || e); } })()`,
        awaitPromise: true, returnByValue: true,
      }, sid).catch(() => null) as { result?: { value?: string } } | null;
      const marker = ran?.result?.value;
      if (typeof marker === "string" && marker.startsWith("SHOT_SCRIPT_FAILED")) {
        safeErr(`[shot] ${opts.appId}: ${marker}\n`);
      }
    }
    // Seeded apps render their real state a beat after load: Jaeger draws its
    // trace list, Metabase its dashboard. Capturing too early photographs a
    // spinner, which is worse than no picture.
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // Prove the seeded state is on screen before opening the shutter.
    if (opts.shotExpect) {
      const seen = await cdp(ws, "Runtime.evaluate", {
        expression: `(() => { try { return (${opts.shotExpect}) ? "PRESENT" : "ABSENT"; }`
          + ` catch (e) { return "ERROR: " + ((e && e.message) || e); } })()`,
        returnByValue: true,
      }, sid) as { result?: { value?: string } };
      const got = seen.result?.value ?? "NO_RESULT";
      if (got !== "PRESENT") {
        throw new Error(`seeded state not on screen for ${opts.appId} (${got})`);
      }
    }

    const shot = await cdp(ws, "Page.captureScreenshot", { format: "png" }, sid) as { data?: string };
    if (!shot.data) throw new Error("captureScreenshot returned no data");

    const buf = Buffer.from(shot.data, "base64");
    mkdirSync(dirname(opts.outPath), { recursive: true });
    writeFileSync(opts.outPath, buf);
    return { ok: true, bytes: buf.byteLength, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { ok: false, bytes: 0, ms: Math.round(performance.now() - t0), error: (err as Error).message };
  } finally {
    try { ws?.close(); } catch { /* already closing */ }
    if (sessionId) {
      try { await client.sessions.releaseAndWait(sessionId); }
      catch { safeErr(`[shot] failed to release a browser session for ${opts.appId}\n`); }
    }
    void safeOut;
  }
}
