/**
 * The watchdog: a separate process whose only job is to kill what the server
 * forgot.
 *
 * WHY THIS EXISTS, stated plainly because it is a gap the other layers do not
 * close.
 *
 * The three expiry layers all assume the Blink server is alive, or that traffic
 * to the instance stops:
 *
 *   Layer 1, the in-process expiry timer, dies with the process.
 *
 *   Layer 2, the guest self-destruct, survives. But it kills the APP, not the
 *   sandbox: `kill -9 $(cat pidfile)`. The instance becomes unusable and the
 *   sandbox keeps running and keeps billing.
 *
 *   Layer 3, the platform timeout, is IDLE based, and Q17 measured that traffic
 *   to a previewUrl resets that idle clock. So it fires 180 s after traffic
 *   stops, not 180 s after the server dies. A visitor refreshing a dead instance
 *   can hold the sandbox open indefinitely.
 *
 * On a laptop that OOM kills the server, that combination leaves a sandbox
 * billing at $0.057/h with nothing to stop it until somebody notices. Two
 * concurrent sandboxes is about $2.74 a day.
 *
 * This process closes that. It is deliberately tiny, holds no HTTP server, no
 * database pool and no SDK client cache, so it is the last thing the OOM killer
 * chooses and it keeps running when the server is gone. It reads the instance
 * log the server writes, and kills anything past its expiry.
 *
 * It is NOT a replacement for the three layers. It is the backstop for the case
 * where the server itself is the thing that failed.
 */

import { readAll, persist } from "../src/orchestrator/store.ts";
import { SandboxLedger } from "../src/guard/ledger.ts";
import { handleFor } from "../src/redact.ts";
import { safeErr, safeOut } from "../src/safe-io.ts";

const INTERVAL_MS = Number(process.env.BLINK_WATCHDOG_INTERVAL_MS ?? 60_000);
/**
 * How long past expiry before the watchdog acts.
 *
 * Long enough that a healthy server always settles its own instances first, so
 * the watchdog never races the thing it is backing up. Short enough that a dead
 * server costs minutes rather than hours.
 */
const GRACE_MS = Number(process.env.BLINK_WATCHDOG_GRACE_MS ?? 120_000);

const apiKey = process.env.SOLARI_API_KEY;
if (!apiKey) {
  safeErr("watchdog: SOLARI_API_KEY is not set, so it cannot kill anything. Refusing to run.\n");
  process.exit(2);
}

const baseUrl = process.env.SOLARI_BASE_URL ?? "https://api.getsolari.com";

async function killSandbox(sandboxId: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    // 404 counts: it is already gone, which is the outcome we wanted.
    return res.status === 200 || res.status === 204 || res.status === 404;
  } catch {
    return false;
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  const rows = readAll();
  const overdue = rows.filter((r) =>
    !r.settled && r.sandboxId && r.expiresAt !== null && r.expiresAt + GRACE_MS < now);

  for (const row of overdue) {
    const ok = await killSandbox(row.sandboxId!);
    safeOut(
      `[watchdog] ${ok ? "killed" : "FAILED to kill"} ${handleFor(row.sandboxId!)} ` +
      `(${row.appId}, ${Math.round((now - row.expiresAt!) / 1000)}s past expiry)\n`,
    );
    if (ok) {
      // Mark settled so the next tick does not chase it again. The receipt is
      // the server's job; this only stops the bleeding.
      persist({ ...row, settled: true, state: "ENDED" });
    }
  }

  /*
   * Independently ask the platform, because the log only knows what the server
   * managed to write. A crash between create and the first write leaves a
   * sandbox that appears in neither.
   *
   * EXEMPT the instances that are supposed to be alive.
   *
   * assertZeroLive is an exit assertion. It means "nothing of ours is still
   * running", which is true at the end of a gates run and false at every moment
   * of a server whose job is keeping instances running. Calling it bare on a 60
   * second timer reaped every visitor's instance within a minute of creation,
   * because a live instance IS recorded in the ledger and that is exactly what
   * the function treats as proof it should die. The block above had already
   * decided, carefully, which rows were overdue; this one then killed the ones
   * it had spared.
   */
  const alive = rows
    .filter((r) => !r.settled && r.sandboxId !== null && r.sandboxId !== undefined
      && (r.expiresAt === null || r.expiresAt + GRACE_MS >= now))
    .map((r) => r.sandboxId as string);

  try {
    const ledger = new SandboxLedger();
    const live = await ledger.assertZeroLive(apiKey!, { reap: true, exempt: alive });
    if (live.foreignIds.length > 0) {
      safeOut(`[watchdog] ${live.foreignIds.length} sandbox(es) are not ours and were left alone\n`);
    }
  } catch (err) {
    // assertZeroLive throws when it reaps OUR leaked sandboxes. That is the
    // watchdog working, not failing.
    safeOut(`[watchdog] reaped: ${(err as Error).message.slice(0, 200)}\n`);
  }
}

safeOut(`[watchdog] started, checking every ${Math.round(INTERVAL_MS / 1000)}s, grace ${Math.round(GRACE_MS / 1000)}s\n`);
void tick();
setInterval(() => { void tick(); }, INTERVAL_MS);
