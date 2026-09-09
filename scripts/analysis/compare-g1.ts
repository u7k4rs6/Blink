/**
 * Compare G1 runs across apps.
 *
 * G1 writes one report per run and the file is overwritten each time, so the
 * per-app comparison has to be assembled from archived copies. This reads any
 * number of saved g1 JSON files and prints the four phases side by side, p50 and
 * p95 together.
 *
 * p95 is not optional here. Gitea's warm p50 was 6,124 ms against a p95 of
 * 9,745 ms, and a headline built on p50 alone is right for the median visitor
 * and wrong for one in twenty, which is exactly the gap this project claims not
 * to have.
 *
 *   node scripts/analysis/compare-g1.ts docs/gates/data/g1-gitea.json docs/gates/data/g1.json
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { safeOut, safeErr } from "../../src/safe-io.ts";

type Sample = {
  app: string; path: "cold" | "warm"; ok: boolean; totalMs: number;
  forkMs: number; healthCompleteMs: number; previewResolveMs?: number; previewFirstByteMs: number;
};

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
const q = (v: number[], p: number) => pct([...v].sort((a, b) => a - b), p);
const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n)).padStart(6) : "     .");

const files = process.argv.slice(2);
if (!files.length) {
  safeErr("usage: node scripts/analysis/compare-g1.ts <g1.json> [more...]\n");
  process.exit(2);
}

type Row = { label: string; path: string; n: number; samples: Sample[] };
const rows: Row[] = [];
for (const f of files) {
  const d = JSON.parse(readFileSync(f, "utf8")) as { data: { samples: Sample[] } };
  const byApp = new Map<string, Sample[]>();
  for (const s of d.data.samples) {
    if (!s.ok) continue;
    byApp.set(s.app, [...(byApp.get(s.app) ?? []), s]);
  }
  for (const [app, all] of byApp) {
    for (const path of ["cold", "warm"] as const) {
      const samples = all.filter((s) => s.path === path);
      if (samples.length) rows.push({ label: `${app} (${basename(f)})`, path, n: samples.length, samples });
    }
  }
}

const phases: Array<[string, (s: Sample) => number]> = [
  ["fork/resume", (s) => s.forkMs],
  ["health loopback", (s) => s.healthCompleteMs],
  ["previewUrl()", (s) => s.previewResolveMs ?? NaN],
  ["first byte", (s) => s.previewFirstByteMs],
  ["TOTAL", (s) => s.totalMs],
];

for (const path of ["cold", "warm"] as const) {
  const rs = rows.filter((r) => r.path === path);
  if (!rs.length) continue;
  safeOut(`\n=== ${path.toUpperCase()} ===\n`);
  safeOut("phase".padEnd(18) + rs.map((r) => `${r.label.split(" ")[0]} p50/p95`.padStart(22)).join("") + "\n");
  for (const [name, get] of phases) {
    let line = name.padEnd(18);
    for (const r of rs) {
      const v = r.samples.map(get).filter(Number.isFinite);
      line += `${fmt(q(v, 50))}/${fmt(q(v, 95))}`.padStart(22);
    }
    safeOut(line + "\n");
  }
  safeOut("n".padEnd(18) + rs.map((r) => String(r.n).padStart(22)).join("") + "\n");
}

// The question the comparison exists to answer.
const warm = rows.filter((r) => r.path === "warm");
if (warm.length >= 2) {
  const totals = warm.map((r) => q(r.samples.map((s) => s.totalMs), 50));
  const spread = Math.max(...totals) - Math.min(...totals);
  const rel = spread / Math.min(...totals);
  safeOut(
    `\nwarm p50 spread across apps: ${Math.round(spread)} ms (${(rel * 100).toFixed(1)}%)\n` +
      (rel < 0.15
        ? "  -> within 15%: the number is dominated by the platform, not the app.\n" +
          "     The catalog can carry ONE headline figure, with per-app detail on the health wall.\n"
        : "  -> apps differ materially: the catalog needs a per-app number, not one headline.\n"),
  );
}
