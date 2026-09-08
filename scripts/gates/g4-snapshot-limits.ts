/**
 * G4: snapshot limits on Starter. Count, size, creation time, downgrade survival.
 *
 * Nothing about snapshot limits is published anywhere: not on /pricing, not on
 * /snapshots, not on /volumes, /organizations or /api-reference
 * (00-verification.md V30, V31). So this gate is pure discovery, and it is cheap
 * because SnapshotView already carries sizeBytes and createdAt, meaning count and
 * size need no extra calls beyond one listSnapshots.
 *
 * This matters to D9 (fork-my-state), which mints one snapshot per share link and
 * could exhaust an unknown ceiling, and to the canary, which rebuilds snapshots
 * on a schedule and must not be blocked by share links.
 *
 * It also verifies the deletion rule found in Phase 0: deletion is refused with
 * 409 SnapshotHasChildren while a fork is live (V23). The D9 expiry sweeper has
 * to treat that as a normal re-queue rather than an error, so it is worth
 * confirming rather than assuming.
 *
 * Downgrade survival (Q12) cannot be tested without actually downgrading the
 * account, which this gate will not do. It records the pre-downgrade inventory so
 * that a real downgrade can be compared against it later.
 */

import { estimate } from "./lib/cost.ts";
import { table } from "./lib/report.ts";
import { main, type GateContext, type GateDefinition, type GateResult } from "./lib/harness.ts";
import { SIZE_SMALL, STARTER_ENDS, reInventoryDate } from "../../src/guard/rates.ts";
import { writeBaseline } from "./lib/inventory.ts";
import { safeOut } from "../../src/safe-io.ts";

/** How many snapshots to mint while probing for a ceiling. */
const PROBE_COUNT = Number(process.env.BLINK_G4_PROBES ?? 5);
const SECONDS_PER_PROBE = 45;

async function run(ctx: GateContext): Promise<GateResult> {
  const before = await ctx.adapter.listSnapshots(ctx.apiKey, "g4");

  // Write the pre-downgrade baseline UNCONDITIONALLY, before anything else can
  // fail. This baseline is unrecoverable once the Starter month drops: there is
  // no way to ask Solari what you used to have. An existing baseline is never
  // overwritten, because an older one is more valuable than a newer one.
  const baselineWrite = writeBaseline({
    capturedAt: new Date().toISOString(),
    plan: ctx.plan.name,
    starterEnds: STARTER_ENDS,
    maxSandboxes: ctx.plan.maxSandboxes,
    maxBrowsers: ctx.plan.maxBrowsers,
    snapshotCount: before.value.length,
    totalBytes: before.value.reduce((a, x) => a + x.sizeBytes, 0),
    snapshots: before.value.map((x) => ({
      id: x.id, name: x.name, sizeBytes: x.sizeBytes, createdAt: x.createdAt, template: x.template,
    })),
  });
  safeOut(
    `[g4] pre-downgrade baseline ${baselineWrite.wasFirst ? "written" : "already existed, wrote a dated copy"}: ${baselineWrite.path}\n`,
  );

  const created: Array<{ id: string; ms: number; sizeBytes: number | null }> = [];
  let ceilingHit: string | null = null;
  let childDeletionRefused: boolean | null = null;
  let childDeletionDetail = "not attempted";

  let sandboxId: string | null = null;
  try {
    const sb = await ctx.adapter.createSandbox(
      ctx.apiKey, "g4",
      { template: "base", cpu: 1, memMb: 2048, timeoutMs: 300_000,
        lifecycle: { onTimeout: "kill" }, metadata: ctx.metadata },
      0.004,
    );
    sandboxId = sb.value.sandboxId;

    // Write a known amount of data so successive snapshots have something to
    // differ by, which is what makes the size numbers meaningful.
    await ctx.adapter.exec(ctx.apiKey, sb.value, "g4", "mkdir -p /tmp/blink && dd if=/dev/urandom of=/tmp/blink/blob bs=1M count=64 2>/dev/null; echo done");

    for (let i = 0; i < PROBE_COUNT; i++) {
      try {
        const snap = await ctx.adapter.snapshot(ctx.apiKey, sb.value, "g4", `blink-g4-probe-${i}`);
        created.push({ id: snap.value, ms: snap.ms, sizeBytes: null });
      } catch (err) {
        ceilingHit = `snapshot ${i + 1} failed: ${(err as Error).message}`;
        break;
      }
    }

    // The 409 rule: a snapshot with a live child cannot be deleted. Fork one of
    // ours and try, because D9's expiry sweeper will meet exactly this.
    if (created.length > 0) {
      let childId: string | null = null;
      try {
        const child = await ctx.adapter.createSandbox(
          ctx.apiKey, "g4",
          { fromSnapshot: created[0]!.id, cpu: 1, memMb: 2048, timeoutMs: 120_000,
            lifecycle: { onTimeout: "kill" }, metadata: { ...ctx.metadata, blink_probe: "child" } },
          0.002,
        );
        childId = child.value.sandboxId;
        try {
          await ctx.adapter.deleteSnapshot(ctx.apiKey, "g4", created[0]!.id);
          childDeletionRefused = false;
          childDeletionDetail = "deletion SUCCEEDED with a live child, which contradicts the documented 409 SnapshotHasChildren";
        } catch (err) {
          childDeletionRefused = true;
          childDeletionDetail = `deletion refused as documented: ${(err as Error).message}`;
        }
      } finally {
        if (childId) {
          ctx.guard.addSandboxSeconds(45, SIZE_SMALL, false, "child fork for 409 check, flat model");
          await ctx.adapter.killQuiet(ctx.apiKey, childId, "g4");
        }
      }
    }
  } finally {
    if (sandboxId) {
      ctx.guard.addSandboxSeconds(60 + PROBE_COUNT * SECONDS_PER_PROBE, SIZE_SMALL, false, "snapshot probe sandbox, flat model");
      await ctx.adapter.killQuiet(ctx.apiKey, sandboxId, "g4");
    }
  }

  // Sizes come from the listing, not from the create response, so one call
  // covers every snapshot we made.
  const after = await ctx.adapter.listSnapshots(ctx.apiKey, "g4");
  const ourIds = new Set(created.map((c) => c.id));
  for (const s of after.value) {
    const hit = created.find((c) => c.id === s.id);
    if (hit) hit.sizeBytes = s.sizeBytes;
  }

  // Clean up every snapshot this gate minted. A leaked snapshot is storage we
  // keep paying for, and possibly a ceiling we later hit for no reason.
  const deleted: string[] = [];
  const undeleted: string[] = [];
  for (const c of created) {
    try {
      await ctx.adapter.deleteSnapshot(ctx.apiKey, "g4", c.id);
      deleted.push(c.id);
    } catch (err) {
      undeleted.push(`${c.id}: ${(err as Error).message}`);
    }
  }

  const times = created.map((c) => c.ms);
  const sizes = created.map((c) => c.sizeBytes ?? 0).filter((n) => n > 0);
  const verdict =
    `Minted ${created.length}/${PROBE_COUNT} snapshots${ceilingHit ? `, then hit a limit: ${ceilingHit}` : " with no ceiling reached"}. ` +
    `Creation time ${times.length ? `${Math.min(...times)} to ${Math.max(...times)} ms` : "n/a"}. ` +
    `Deletion with a live child ${childDeletionRefused === null ? "not determined" : childDeletionRefused ? "refused as documented" : "SUCCEEDED, contradicting the docs"}. ` +
    `Cleaned up ${deleted.length}, left ${undeleted.length}.`;

  const md = [
    `## Inventory`,
    ``,
    table(
      ["", "count"],
      [
        ["snapshots before this gate", before.value.length],
        ["minted by this gate", created.length],
        ["snapshots after cleanup", after.value.length - deleted.length],
      ],
    ),
    ``,
    `## Per snapshot`,
    ``,
    table(
      ["#", "creation ms", "size bytes", "size MiB"],
      created.map((c, i) => [i + 1, c.ms, c.sizeBytes ?? "unknown", c.sizeBytes ? Math.round(c.sizeBytes / 1048576) : "unknown"]),
    ),
    ``,
    ceilingHit
      ? `**A ceiling was reached.** ${ceilingHit}\n\nThis is directly relevant to D9: share links mint one snapshot each, so a ceiling this low is exhaustible by visitors and needs a cap plus eviction before fork-my-state ships.`
      : `**No ceiling was reached at ${PROBE_COUNT} snapshots.** That does not prove there is none, only that it is above ${PROBE_COUNT}. Raise \`BLINK_G4_PROBES\` to push further, at proportional cost.`,
    ``,
    `## Deletion with a live child (V23)`,
    ``,
    `${childDeletionDetail}`,
    ``,
    `D9's expiry sweeper must treat a 409 as a normal re-queue for the next tick, never as an error and never as something to retry in place. Instances live 20 minutes at most, so the conflict always clears on its own.`,
    ``,
    `## Downgrade survival (Q12): the scheduled re-inventory`,
    ``,
    `**Not tested here, and deliberately so.** Testing it by downgrading would cost the Starter month. But the downgrade is **scheduled, not hypothetical**, so Q12 has an answer date rather than an open question mark. ${STARTER_ENDS ? `Starter ends **${STARTER_ENDS}**, so the re-inventory runs on **${reInventoryDate()}**.` : "**TODO: the Starter end date is not set.** Set \`BLINK_STARTER_ENDS=YYYY-MM-DD\`, or edit \`STARTER_ENDS\` in \`src/guard/rates.ts\`. Until it is set, Q12 stays unanswerable, because nobody will remember to look."}`,
    ``,
    `### Pre-downgrade inventory, captured by this run`,
    ``,
    table(
      ["field", "value"],
      [
        ["snapshots held", String(after.value.length - deleted.length)],
        ["snapshot ids", after.value.filter((x) => !deleted.includes(x.id)).map((x) => x.id).join(", ") || "none"],
        ["total bytes", String(after.value.filter((x) => !deleted.includes(x.id)).reduce((a, x) => a + x.sizeBytes, 0))],
        ["captured at", new Date().toISOString()],
      ],
    ),
    ``,
    `Baseline written to \`${baselineWrite.path}\`${baselineWrite.wasFirst ? "" : " (an earlier baseline already existed and was left untouched)"}.`,
    ``,
    `### The exact step to run the day after the downgrade`,
    ``,
    `One command. It reads the stored baseline, re-inventories snapshots, reads the current plan limits, diffs them, and writes \`docs/gates/G4-q12-downgrade.md\`.`,
    ``,
    "```bash",
    `# On ${reInventoryDate() ?? "<the day after BLINK_STARTER_ENDS>"}, with the account already on Free:`,
    `BLINK_PLAN=free npm run gates -- --q12`,
    "```",
    ``,
    `It **refuses to run** if \`BLINK_STARTER_ENDS\` is unset, if today is before that date, or if no baseline exists. Running early would record a non-answer that looks like an answer, and a non-answer in the file is worse than an empty file because the next reader believes it.`,
    ``,
    `It answers three questions and writes them up:`,
    ``,
    `1. **Did the stored snapshots survive?** If they are deleted on downgrade, D1 and D9 both break on the first day of Free and the canary cannot rebuild.`,
    `2. **Did their sizes change?** A silent re-encode or a size cap shows here.`,
    `3. **What happened to anything running at the moment of the drop?**`,
    ``,
    `**One step has to happen before the date, not after.** Question 3 cannot be reconstructed retrospectively, so leave one cheap sandbox alive across the boundary the night before. Without that, question 3 stays permanently unanswered for this account, and \`--q12\` will say so rather than guess.`,
    ``,
    undeleted.length > 0 ? `## Snapshots this gate could not clean up\n\n${undeleted.map((u) => `- ${u}`).join("\n")}\n` : "",
  ].join("\n");

  return { observations: created.length, verdict, markdown: md, data: { before: before.value.length, created, deleted, undeleted, ceilingHit, childDeletionRefused, childDeletionDetail } };
}

const def: GateDefinition = {
  id: "g4",
  title: "snapshot limits on Starter",
  question: "What are the snapshot count, size, creation time and deletion rules on Starter (Q2), and does a snapshot survive downgrade (Q12)?",
  ceilingUsd: 0.03,
  // At least two snapshots, or there is no delta and no count evidence.
  minObservations: 2,
  observationUnit: "snapshot minted",
  estimate: (plan) => estimate(plan, [{ sandboxSeconds: 60 + PROBE_COUNT * SECONDS_PER_PROBE + 45, size: SIZE_SMALL }]),
  run,
};

await main(def);
