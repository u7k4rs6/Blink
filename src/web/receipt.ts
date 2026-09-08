/**
 * The session cost receipt.
 *
 * 04-frontend-spec.md section 3: **the arithmetic is shown, not just the total.**
 * A total alone asks the reader to trust it; the working lets them check it, and
 * the whole project's claim is that the numbers are checkable.
 *
 * Every figure is computed locally from the published Starter rates, because
 * Solari exposes no usage or balance API (V55). That is a real limitation and the
 * receipt says so rather than implying the number came from a bill.
 */

import { sandboxRatePerSecond, browserRatePerSecond, type Plan, type Size } from "../guard/rates.ts";

export type ReceiptLine = {
  label: string;
  detail: string;
  seconds: number;
  hours: number;
  ratePerHour: number;
  usd: number;
};

export type Receipt = {
  lines: ReceiptLine[];
  totalUsd: number;
  plan: string;
  /** Set when the instance ended before its lifetime expired. */
  lost: boolean;
  note: string;
};

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export function buildReceipt(input: {
  plan: Plan;
  size: Size;
  sandboxSeconds: number;
  browserSeconds?: number;
  browserTiles?: number;
  lost?: boolean;
}): Receipt {
  const { plan, size, sandboxSeconds } = input;
  const browserSeconds = input.browserSeconds ?? 0;
  const lines: ReceiptLine[] = [];

  const sbRateHour = sandboxRatePerSecond(plan, size) * 3600;
  lines.push({
    label: "Sandbox",
    detail: `${size.cpu} vCPU / ${Math.round(size.memMb / 1024)} GB`,
    seconds: sandboxSeconds,
    hours: round4(sandboxSeconds / 3600),
    ratePerHour: sbRateHour,
    usd: sandboxSeconds * sandboxRatePerSecond(plan, size),
  });

  if (browserSeconds > 0) {
    const brRateHour = browserRatePerSecond(plan) * 3600;
    lines.push({
      label: "Browsers",
      detail: `${input.browserTiles ?? 1} tile${(input.browserTiles ?? 1) === 1 ? "" : "s"}`,
      seconds: browserSeconds,
      hours: round4(browserSeconds / 3600),
      ratePerHour: brRateHour,
      usd: browserSeconds * browserRatePerSecond(plan),
    });
  }

  const totalUsd = lines.reduce((a, l) => a + l.usd, 0);
  return {
    lines,
    totalUsd,
    plan: plan.name,
    lost: input.lost ?? false,
    // Named plainly. The gauge elsewhere carries the same caveat, and it is the
    // single most misleading thing on the site if it is left implied.
    note: `Rates from Solari's published ${plan.name} pricing, computed locally. Solari exposes no usage API, so this is our arithmetic and not their bill.`,
  };
}

/** `10m 00s`, because a receipt reading `600s` makes the reader do the division. */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

export function fmtUsd(usd: number): string {
  // Four decimals: at these rates two would round a real charge to $0.00 and
  // make the receipt look like a joke rather than a measurement.
  return `$${usd.toFixed(4)}`;
}

export function receiptRows(r: Receipt): string[][] {
  const rows = r.lines.map((l) => [
    l.label,
    l.detail,
    fmtDuration(l.seconds),
    `${l.hours} h x $${l.ratePerHour.toFixed(3)}/h = ${fmtUsd(l.usd)}`,
  ]);
  rows.push(["", "", "Total", fmtUsd(r.totalUsd)]);
  return rows;
}
