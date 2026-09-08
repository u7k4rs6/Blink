/**
 * `npm run sweep`: kill every sandbox this account has live, and everything the
 * ledger still thinks is open.
 *
 * This exists because of thrice's day-4 leak: a foreground run killed by a shell
 * timeout runs no exit handler, so the sandbox it created outlived the process
 * that owned it and billed until someone noticed. The ledger is on disk exactly
 * so that the NEXT process can reap what the last one abandoned, and this script
 * is that next process.
 *
 * Run it after any interrupted gate, and before walking away.
 */

import { safeErr, safeOut } from "../../src/safe-io.ts";
import { SandboxLedger } from "../../src/guard/ledger.ts";
import { resolveApiKey } from "./lib/harness.ts";

const apiKey = resolveApiKey();
const ledger = new SandboxLedger();

const open = ledger.openIds();
safeOut(`Ledger thinks ${open.length} sandbox(es) are open.\n`);
if (open.length > 0) {
  const results = await ledger.sweep(apiKey, "manual-sweep");
  for (const r of results) safeOut(`  ${JSON.stringify(r)}\n`);
}

safeOut("\nAsking Solari what is actually live, which is the check that matters.\n");
try {
  const live = await ledger.assertZeroLive(apiKey, { reap: true });
  safeOut(`Live sandboxes: ${live.liveCount}. Nothing to reap.\n`);
} catch (err) {
  safeErr(`${(err as Error).message}\n`);
  process.exit(1);
}
