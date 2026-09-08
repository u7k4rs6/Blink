/**
 * The soak report.
 *
 * Written after every tick, so a soak that is killed at hour nine still leaves a
 * readable account of the first nine hours. A report produced only at the end is
 * a report you do not get on the run that fails.
 *
 * The resolve-time distribution is an HOURLY COUNT of resolves over 2000 ms, not
 * a daily total (02-architecture.md section 13). A daily total of "1.2% over
 * 2 s" hides an hour in which everything was over 2 s, and that hour is the
 * thing worth knowing.
 */

import { join } from "node:path";

import { safeWriteFileSync } from "../../src/safe-io.ts";
import { stats } from "../gates/lib/stats.ts";

// Nearest-rank, via the shared stats helper, so every number reported was measured.
const p50 = (v: number[]): number => Math.round(stats(v).p50);
const p95 = (v: number[]): number => Math.round(stats(v).p95);
import { readEvents, SOAK_DIR, type Tick } from "./state.ts";

const SLOW_MS = 2000;

export function summarise(): void {
  const events = readEvents();
  const ticks = events.filter((e): e is Tick => e.kind === "tick");
  const reconciles = events.filter((e) => e.kind === "reconcile") as Array<{ liveSandboxes: number }>;
  const kills = events.filter((e) => e.kind === "deliberate-kill") as Array<{ correct: boolean; observedState: string }>;
  const restarts = events.filter((e) => e.kind === "restart") as Array<{ survived: boolean; note: string }>;

  const apps = [...new Set(ticks.map((t) => t.app))].sort();
  const hours = [...new Set(ticks.map((t) => t.hour))].sort();

  const lines: string[] = [
    `# Soak`,
    ``,
    `Generated ${new Date().toISOString()}. ${ticks.length} app checks across ${hours.length} hour(s).`,
    ``,
    `Every check below exercises the app's real interface, not a status code. A soak`,
    `built on \`GET / -> 200\` would have stayed green through the entire Uptime Kuma`,
    `setup-wizard failure, which is why V70 and V71 exist.`,
    ``,
    `## Health wall`,
    ``,
    `| app | checks | green | failed | errored | what is asked |`,
    `|---|---|---|---|---|---|`,
  ];

  for (const app of apps) {
    const mine = ticks.filter((t) => t.app === app);
    const green = mine.filter((t) => t.livenessOk).length;
    const errored = mine.filter((t) => t.error).length;
    const failed = mine.length - green - errored;
    const asked = mine.find((t) => t.livenessAsked)?.livenessAsked ?? "";
    lines.push(`| ${app} | ${mine.length} | ${green} | ${failed} | ${errored} | ${asked} |`);
  }

  // Distinct hours covered, and the longest UNBROKEN stretch, reported
  // separately and never conflated.
  //
  // The soak log is append-only and keyed by UTC hour, so short runs on
  // different days accumulate toward 24 distinct hours. That is genuinely useful
  // and it is NOT the same claim as running for 24 hours without interruption: a
  // chunked soak cannot catch a leak that only appears after six continuous
  // hours, and saying otherwise would be exactly the kind of true-but-irrelevant
  // claim this project keeps finding.
  const hourNums = hours.map((h) => Date.parse(`${h}:00:00Z`) / 3_600_000).sort((a, b) => a - b);
  let longestRun = hourNums.length > 0 ? 1 : 0;
  let currentRun = longestRun;
  for (let i = 1; i < hourNums.length; i += 1) {
    currentRun = hourNums[i] === hourNums[i - 1]! + 1 ? currentRun + 1 : 1;
    if (currentRun > longestRun) longestRun = currentRun;
  }
  const sessions = events.filter((e) => e.kind === "start").length;

  const allGreen = ticks.length > 0 && ticks.every((t) => t.livenessOk);
  lines.push(``, `**Health wall green throughout: ${allGreen ? "YES" : "NO"}.**`);
  if (!allGreen) {
    const bad = ticks.filter((t) => !t.livenessOk).slice(0, 12);
    lines.push(``, `Failures, in full, because a soak that hides its failures is a soak that proves nothing:`, ``);
    for (const b of bad) lines.push(`- \`${b.at}\` **${b.app}**: ${b.error ?? b.livenessDetail}`);
  }

  // ---- resolve distribution, hourly ----
  lines.push(
    ``,
    `## previewUrl resolve time, by hour`,
    ``,
    `Counted per hour rather than totalled for the day. A daily figure hides an hour`,
    `that was entirely broken, and the hour is the unit an operator can act on.`,
    ``,
    `| hour (UTC) | resolves | p50 ms | p95 ms | over ${SLOW_MS} ms |`,
    `|---|---|---|---|---|`,
  );
  for (const h of hours) {
    const rs = ticks.filter((t) => t.hour === h && typeof t.resolveMs === "number").map((t) => t.resolveMs!);
    if (rs.length === 0) { lines.push(`| ${h} | 0 | | | |`); continue; }
    const slow = rs.filter((r) => r > SLOW_MS).length;
    lines.push(`| ${h} | ${rs.length} | ${p50(rs)} | ${p95(rs)} | ${slow}${slow > 0 ? " **" : ""} |`);
  }

  const allResolves = ticks.map((t) => t.resolveMs).filter((r): r is number => typeof r === "number");
  if (allResolves.length > 0) {
    lines.push(
      ``,
      `Across the whole run: ${allResolves.length} resolves, p50 **${p50(allResolves)} ms**, p95 **${p95(allResolves)} ms**, ` +
      `${allResolves.filter((r) => r > SLOW_MS).length} over ${SLOW_MS} ms.`,
    );
  }

  // ---- the three structural checks ----
  const leakTicks = reconciles.filter((r) => r.liveSandboxes > 0).length;
  const totalUsd = ticks.reduce((a, t) => a + t.usd, 0);
  lines.push(
    ``,
    `## Checklist`,
    ``,
    `| item | result |`,
    `|---|---|`,
    `| five apps, health wall green throughout | ${allGreen ? "PASS" : "**FAIL**"} |`,
    `| 24 distinct hours covered | ${hours.length >= 24 ? `PASS (${hours.length})` : `${hours.length} of 24 so far`} |`,
    `| longest UNINTERRUPTED stretch | ${longestRun} h, across ${sessions} run(s) |`,
    `| no leaked sandboxes at any reconciler tick | ${leakTicks === 0 ? `PASS (${reconciles.length} ticks, all zero)` : `**FAIL** (${leakTicks} of ${reconciles.length} ticks leaked)`} |`,
    `| one deliberate restart, live instance surviving | ${restarts.some((r) => r.survived) ? "PASS" : restarts.length ? "**FAIL**" : "not yet run"} |`,
    `| one deliberate kill showing the lost-instance state | ${kills.some((k) => k.correct) ? "PASS" : kills.length ? "**FAIL**" : "not yet run"} |`,
    `| resolve-time distribution as an hourly count | above |`,
    ``,
    `Spend across the run: **$${totalUsd.toFixed(5)}**.`,
    ``,
    `### Continuous versus accumulated`,
    ``,
    `This log is append-only and keyed by UTC hour, so short runs accumulate toward`,
    `24 distinct hours. **That is not the same claim as 24 hours of uninterrupted`,
    `operation.** ${hours.length} distinct hour(s) are covered here and the longest unbroken`,
    `stretch is ${longestRun} hour(s), across ${sessions} run(s). A chunked soak cannot catch a`,
    `leak that only appears after many continuous hours, or a slow drift in a`,
    `long-lived process, because no process lived that long. Both numbers are`,
    `printed so the weaker one cannot be quoted as the stronger.`,
  );

  if (kills.length > 0) {
    lines.push(
      ``,
      `### What a killed sandbox looks like from outside`,
      ``,
      `The point is not that a sandbox never dies. It is that when one does, the system`,
      `can tell, and says so. Observed after a deliberate kill:`,
      ``,
      "```",
      kills.map((k) => k.observedState).join("\n"),
      "```",
    );
  }

  safeWriteFileSync(join(SOAK_DIR, "soak.md"), lines.join("\n") + "\n");
}
