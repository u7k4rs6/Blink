/**
 * The pre-flight spend refusal, as a pure decision.
 *
 * It lived inline in runGate, which meant the only evidence it worked was that
 * the code was there: firing it required a real gate run against a real
 * estimate, which is the one thing a refusal is supposed to avoid. Pulled out so
 * a test can drive it to every outcome for nothing.
 *
 * The ordering is deliberate. The per-gate ceiling is checked first because it
 * is the tighter and more informative bound: a gate that blows its own ceiling
 * is a gate whose estimate is wrong, and saying so beats reporting it as a
 * budget problem.
 */

export type PreflightVerdict =
  | { allow: true }
  | { allow: false; reason: string; message: string };

export function preflightVerdict(
  estimateUsd: number,
  gateCeilingUsd: number,
  totalBudgetUsd: number,
): PreflightVerdict {
  if (estimateUsd > gateCeilingUsd) {
    return {
      allow: false,
      reason: "gate_ceiling",
      message:
        `REFUSED: estimate $${estimateUsd.toFixed(5)} exceeds this gate's ceiling ` +
        `$${gateCeilingUsd.toFixed(5)}. No Solari call was made, so this refusal cost nothing.`,
    };
  }
  if (estimateUsd > totalBudgetUsd) {
    return {
      allow: false,
      reason: "total_budget",
      message:
        `REFUSED: estimate $${estimateUsd.toFixed(5)} exceeds the total gates budget ` +
        `$${totalBudgetUsd.toFixed(2)}. No Solari call was made.`,
    };
  }
  return { allow: true };
}
