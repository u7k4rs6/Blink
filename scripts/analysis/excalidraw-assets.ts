/**
 * Verify a built Excalidraw snapshot actually serves its fonts.
 *
 * 02-architecture.md section 5 carried a warning from the npm-package install
 * path: fonts live under `@excalidraw/excalidraw/dist/prod/fonts` and 404 at
 * runtime unless they are copied to the asset root and `EXCALIDRAW_ASSET_PATH`
 * points at them. A Vite source build should emit them itself, but "should" is
 * the word that produced most of the bugs in this project.
 *
 * A missing font does not fail a health check, does not log an error the server
 * can see, and does not stop the app loading. It just renders wrong. So this is
 * checked by asking for the bytes, and it forks the existing snapshot rather
 * than rebuilding, which costs about a sandbox-minute instead of forty.
 */

import { BudgetGuard } from "../../src/guard/guard.ts";
import { SandboxLedger } from "../../src/guard/ledger.ts";
import { PLANS, SIZE_SMALL, type Plan } from "../../src/guard/rates.ts";
import { CAPS_GATES, createCountingFetch } from "../../src/solari/fetch.ts";
import { SolariAdapter } from "../../src/solari/adapter.ts";
import { loadRegistry } from "../gates/lib/apps.ts";
import { waitHealthyInGuest } from "../gates/lib/health.ts";
import { safeErr, safeOut } from "../../src/safe-io.ts";
import { EXCALIDRAW_PORT } from "../snapshots/excalidraw.ts";

async function main(): Promise<number> {
  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) { safeErr("SOLARI_API_KEY is not set.\n"); return 2; }
  const snapshotId = loadRegistry().excalidraw;
  if (!snapshotId) { safeErr("No excalidraw snapshot in the registry. Build it first.\n"); return 2; }

  const plan: Plan = PLANS[(process.env.BLINK_PLAN ?? "starter") as "starter" | "free"]!;
  const guard = new BudgetGuard(plan, 0.01);
  const ledger = new SandboxLedger();
  ledger.install(apiKey);
  const adapter = new SolariAdapter({ counting: createCountingFetch({ caps: CAPS_GATES }), guard, ledger });

  const bornAt = performance.now();
  let id: string | null = null;
  try {
    const sb = await adapter.createSandbox(
      apiKey, "analysis:excalidraw-assets",
      { fromSnapshot: snapshotId, cpu: SIZE_SMALL.cpu, memMb: SIZE_SMALL.memMb,
        timeoutMs: 300_000, lifecycle: { onTimeout: "kill" } },
      0.01,
    );
    id = sb.value.sandboxId;
    const sh = (c: string, o?: { timeoutMs?: number }) =>
      adapter.exec(apiKey, sb.value, "analysis:excalidraw-assets", c, o);

    const h = await waitHealthyInGuest(sh, EXCALIDRAW_PORT, "/", { timeoutMs: 60_000, intervalMs: 500 });
    safeOut(`  forked instance healthy in ${h.ms} ms\n`);
    if (!h.ok) throw new Error("forked excalidraw never became healthy");

    // Inventory first, then fetch one over HTTP. The inventory says whether the
    // build emitted fonts at all; the fetch says whether they are reachable at
    // the path the app will actually ask for.
    const inv = await sh(
      `echo "font_files=$(find /var/www/excalidraw -iname '*.woff2' -o -iname '*.ttf' | wc -l)"; ` +
      `echo "total_files=$(find /var/www/excalidraw -type f | wc -l)"; ` +
      `F=$(find /var/www/excalidraw -iname '*.woff2' | head -1); ` +
      `if [ -n "$F" ]; then REL=$(echo "$F" | sed 's#^/var/www/excalidraw##'); ` +
      `  echo "sample_font=$REL"; ` +
      `  echo "font_http=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${EXCALIDRAW_PORT}$REL)"; ` +
      `  echo "font_bytes=$(curl -s http://127.0.0.1:${EXCALIDRAW_PORT}$REL | wc -c)"; ` +
      `else echo "font_http=NO_FONT_FILES"; fi; ` +
      `echo "asset_path_ref=$(grep -c EXCALIDRAW_ASSET_PATH /var/www/excalidraw/index.html 2>/dev/null || echo 0)"`,
      { timeoutMs: 60_000 },
    );
    for (const line of inv.value.stdout.split("\n")) if (line.trim()) safeOut(`  ${line.trim()}\n`);

    const ok = /font_http=200/.test(inv.value.stdout) && !/font_files=0/.test(inv.value.stdout);
    safeOut(`\n  VERDICT: fonts ${ok ? "are served correctly" : "are NOT being served, the card would render wrong"}\n`);
    return ok ? 0 : 1;
  } finally {
    if (id) {
      await adapter.killQuiet(apiKey, id, "analysis:excalidraw-assets");
      guard.addSandboxSeconds((performance.now() - bornAt) / 1000, SIZE_SMALL, true, "excalidraw asset check");
    }
    safeOut(`  cost: $${guard.summary().usd.toFixed(5)}\n`);
  }
}

process.exit(await main());
