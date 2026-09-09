/**
 * Fork a snapshot and serve it, in the smallest honest form.
 *
 * This is the whole of Blink in about eighty lines: take a snapshot of a seeded
 * app, fork it, wait for the app to answer, get a preview URL, hand it over,
 * then kill it. Everything else in the project is guard rails around exactly
 * this.
 *
 * Run it:
 *
 *   export SOLARI_API_KEY=slr_live_...
 *   node fork-and-serve.ts snap_your_snapshot_id 3000 /api/healthz
 *
 * Four things here are not decoration, and each one cost a real bug to learn.
 * They are the reason this file is longer than the four SDK calls it wraps.
 */

import { SandboxClient, type Sandbox } from "@solarisdk/sandbox";

const [, , snapshotId, portArg, healthPath = "/"] = process.argv;
const PORT = Number(portArg ?? 3000);
const LIFETIME_S = Number(process.env.LIFETIME_S ?? 120);

if (!snapshotId) {
  console.error("usage: node fork-and-serve.ts <snapshotId> [port] [healthPath]");
  process.exit(2);
}
const apiKey = process.env.SOLARI_API_KEY;
if (!apiKey) {
  console.error("SOLARI_API_KEY is not set.");
  process.exit(2);
}

/**
 * (1) RECORD THE INTENT BEFORE THE CALL.
 *
 * A create that times out can still have created a sandbox whose id you never
 * learn. If the only record of it is the value the call returns, a network blip
 * leaves a machine running that nothing knows about, billing until someone
 * notices. Write down that you are about to create one, first.
 */
const ledger: string[] = [];
let sandbox: Sandbox | null = null;
// baseUrl is required by the SDK rather than defaulted, so it is explicit here.
const client = new SandboxClient({
  apiKey,
  baseUrl: process.env.SOLARI_BASE_URL ?? "https://api.getsolari.com",
});

async function main(): Promise<void> {
  console.log(`forking ${snapshotId}...`);
  const t0 = Date.now();

  sandbox = await client.create({ fromSnapshot: snapshotId, cpu: 1, memMb: 2048,
    // The platform timeout is a backstop, not your product's lifetime. Set it
    // longer than your own expiry so your code is normally what acts.
    timeoutMs: (LIFETIME_S + 120) * 1000,
    lifecycle: { onTimeout: "kill" },
  });
  ledger.push(sandbox.sandboxId);
  console.log(`  forked in ${Date.now() - t0} ms`);

  /**
   * (2) POLL FROM OUTSIDE, IN SHORT CALLS.
   *
   * A long-running loop inside one `exec` hits the gateway's duration limit and
   * comes back as a bare "exec failed" that says nothing about duration. Loop
   * here and keep each call short.
   */
  const healthT0 = Date.now();
  let healthy = false;
  for (let i = 0; i < 120 && !healthy; i += 1) {
    const r = await sandbox.commands.run("sh", {
      args: ["-c", `curl -sf -m 3 -o /dev/null http://127.0.0.1:${PORT}${healthPath} && echo READY || echo WAITING`],
      timeoutMs: 8000,
    });
    healthy = (r.stdout ?? "").includes("READY");
    if (!healthy) await new Promise((res) => setTimeout(res, 500));
  }
  if (!healthy) throw new Error(`app never answered on 127.0.0.1:${PORT}${healthPath}`);
  console.log(`  healthy in ${Date.now() - healthT0} ms`);

  /**
   * (3) A HEALTH CHECK IS NOT PROOF THE APP WORKS.
   *
   * `GET / -> 200` proves a process is listening. It does not prove the app is
   * usable: an app sitting in its own installer or database setup wizard answers
   * 200 happily while refusing every real request. If your app has a real
   * interface, exercise it here instead of trusting the status code.
   */
  // previewUrl returns an OBJECT, not a string. Interpolating it directly
  // prints "[object Object]", which is what the first version of this file did.
  const preview = await sandbox.previewUrl(PORT);
  console.log(`\n  ${preview.url}\n`);

  /**
   * (4) THE URL'S QUERY STRING IS THE CREDENTIAL.
   *
   * `previewUrl` returns a capability URL carrying a `pt_token`. Anyone holding
   * it can reach the sandbox. Two consequences: never log it or put it anywhere
   * that gets indexed, and never build a sub-URL with `new URL(path, previewUrl)`,
   * which drops the query string and gives you a puzzling 401 on the second
   * request. A browser hides this because the first response sets a cookie; a
   * script has no cookie jar.
   */
  console.log(`  live for ${LIFETIME_S}s, then it is destroyed.`);
  await new Promise((res) => setTimeout(res, LIFETIME_S * 1000));
}

/**
 * Kill on EVERY exit path, including the ones you did not plan for.
 *
 * A leaked sandbox is not a bug you see in a test run. It is a bill that arrives
 * later.
 */
async function cleanup(reason: string): Promise<void> {
  for (const id of ledger.splice(0)) {
    try {
      await client.kill(id);
      // The id is NOT printed. A sandbox id decodes without a key to a host pool
      // identifier, an internal VM id, your org id and a timestamp, and even a
      // truncated prefix reveals the pool. Print that it died, not which one.
      console.log(`  killed the sandbox (${reason})`);
    } catch (e) {
      // The one case where the id IS needed, because a human has to go and
      // find it. Treat this line as sensitive wherever it lands.
      console.error(`  KILL FAILED, sweep this manually: ${id}`);
      console.error(`  reason: ${(e as Error).message}`);
    }
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { void cleanup(sig).finally(() => process.exit(130)); });
}

main()
  .then(() => cleanup("finished"))
  .catch(async (e: Error) => {
    console.error(`\nfailed: ${e.message}`);
    await cleanup("failed");
    process.exit(1);
  });
