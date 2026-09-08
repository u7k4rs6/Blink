/** Cost accounting printed before and after every gate. */

import type { Plan, Size } from "../../../src/guard/rates.ts";
import { browserRatePerSecond, sandboxRatePerSecond } from "../../../src/guard/rates.ts";

export type CostEstimate = {
  sandboxSeconds: number;
  browserSeconds: number;
  usd: number;
};

export function estimate(
  plan: Plan,
  parts: Array<{ sandboxSeconds?: number; size?: Size; browserSeconds?: number }>,
): CostEstimate {
  let sandboxSeconds = 0;
  let browserSeconds = 0;
  let usd = 0;
  for (const p of parts) {
    if (p.sandboxSeconds && p.size) {
      sandboxSeconds += p.sandboxSeconds;
      usd += p.sandboxSeconds * sandboxRatePerSecond(plan, p.size);
    }
    if (p.browserSeconds) {
      browserSeconds += p.browserSeconds;
      usd += p.browserSeconds * browserRatePerSecond(plan);
    }
  }
  return {
    sandboxSeconds: Math.round(sandboxSeconds),
    browserSeconds: Math.round(browserSeconds),
    usd: Math.round(usd * 1e5) / 1e5,
  };
}

export function fmtCost(label: string, c: CostEstimate, plan: Plan): string {
  return (
    `${label}: ${c.sandboxSeconds} sandbox-seconds, ${c.browserSeconds} browser-seconds, ` +
    `$${c.usd.toFixed(5)} at ${plan.name} rates`
  );
}
