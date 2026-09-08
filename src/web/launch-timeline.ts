/**
 * The launch timeline: the two stops, and the pills between them.
 *
 * 04-frontend-spec.md section 2. The timer STOPS TWICE and keeps counting in
 * between, because the instance being ready and the visitor being able to see it
 * are different moments and both are honest.
 *
 * The measured warm path for Gitea is ready at about 4.0 s and in the browser at
 * about 5.5 s (G1). The gap between the stops is real, it is about 1.5 s, and
 * the shot list marks it as the one place a recording has dead air. It is not
 * padded out and it is not hidden.
 */

export type PhaseId = "queued" | "starting" | "checking" | "ready" | "loading" | "shown";

export type Phase = {
  id: PhaseId;
  label: string;
  /** Shown only when it actually happened. A queue pill on an unqueued launch is a lie. */
  conditional?: boolean;
  note?: string;
};

export const PHASES: Phase[] = [
  { id: "queued", label: "queued", conditional: true, note: "Only when actually queued, with position and estimated wait" },
  { id: "starting", label: "starting your instance" },
  { id: "checking", label: "checking it answers", note: "The loopback health check. Typically 281 ms, so this is a blink" },
  { id: "ready", label: "ready", note: "First stop" },
  { id: "loading", label: "loading it in your browser" },
  { id: "shown", label: "in your browser", note: "Second stop" },
];

/** The two moments the timer stops. Everything else keeps counting. */
export const STOPS: readonly PhaseId[] = ["ready", "shown"];

export type TimelineInput = {
  /** Chosen before the timer starts and never changed mid-run. */
  path: "warm" | "cold";
  queuedAhead?: number;
};

/**
 * Which pills to show, in order.
 *
 * `starting` reads differently for a warm resume and a cold build, and the
 * choice is made up front: switching the label mid-run would tell the visitor
 * the system changed its mind about what it was doing.
 */
export function pillsFor(input: TimelineInput): Array<{ id: PhaseId; label: string }> {
  const out: Array<{ id: PhaseId; label: string }> = [];
  if ((input.queuedAhead ?? 0) > 0) {
    out.push({ id: "queued", label: `queued, ${input.queuedAhead} ahead of you` });
  }
  out.push({
    id: "starting",
    label: input.path === "warm" ? "resuming your instance" : "building your instance",
  });
  for (const p of PHASES) {
    if (p.id === "queued" || p.id === "starting") continue;
    out.push({ id: p.id, label: p.label });
  }
  return out;
}

/** `4.03` style, hundredths, monospace, driven by rAF against a server anchor. */
export function fmtElapsed(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(2);
}

/**
 * The label under the timer at a given moment.
 *
 * Deliberately total: every millisecond of the launch has a caption, so there is
 * no window in which the page shows a number with nothing explaining it. The 4.0
 * to 5.5 second gap is exactly that window if this returns nothing.
 */
export function labelAt(ms: number, readyAtMs: number, shownAtMs: number | null): string {
  if (shownAtMs !== null && ms >= shownAtMs) return "in your browser";
  if (ms >= readyAtMs) return "ready, loading it in your browser";
  return "starting";
}

export function isStopped(ms: number, readyAtMs: number, shownAtMs: number | null): boolean {
  if (shownAtMs !== null && ms >= shownAtMs) return true;
  // The first stop is a flash, not a freeze: the number resumes immediately.
  return false;
}
