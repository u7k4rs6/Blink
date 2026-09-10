/**
 * Motion.
 *
 * One rule, and it is the same rule the numbers on this page follow: motion is
 * a measurement or it is a state change, and if it is neither it does not ship.
 *
 * That rules out the obvious thing. Every section fading upward as it crosses
 * the viewport is motion about scrolling, which is something the visitor is
 * already doing and does not need narrated. It also rules out a board number
 * counting up to its value, which looks like an instrument warming up and is
 * actually four hundred milliseconds of displaying a figure that is not true.
 * On a page whose entire argument is that a green signal is worth what it
 * measured, a number that lies on the way to being right is the wrong ornament.
 *
 * What is left is smaller and worth more:
 *
 *   1. The hero ladder runs the launch sequence once, at the REAL proportions.
 *   2. A rule draws itself when its section first arrives. The grid assembling.
 *   3. The canary record wipes in oldest to newest, because it is a time series.
 *   4. The credit gauge grows to its true width. A bar cannot show a wrong
 *      number on the way, which is exactly why the bar may move and the numeral
 *      beside it may not.
 *   5. A healthy card's state square pulses once as it arrives. A failing one
 *      does not, so the motion itself carries the verdict.
 */

/**
 * The launch sequence, with the measured cost of each step.
 *
 * These are the same figures the copy publishes: about 3.6 s to wake a machine
 * (`states.ts`, the expensive step), 281 ms for the loopback health check
 * (`launch-timeline.ts`), about 1.3 s for the browser to fetch page one. They
 * live here as data so the animation and the sentence cannot drift apart, and
 * so the ladder's motion is made of the same thing the hero field is made of.
 *
 * `ms: null` means the step is not a duration anybody measured. Those steps
 * light up and get no bar, because a bar is a length and a length is a claim.
 */
export const LADDER: ReadonlyArray<{ n: string; label: string; ms: number | null }> = [
  { n: "01", label: "fork", ms: 3600 },
  { n: "02", label: "health check", ms: 281 },
  { n: "03", label: "url", ms: 1300 },
  { n: "04", label: "ten minutes", ms: null },
  { n: "05", label: "gone", ms: null },
];

/**
 * Real time, divided by this.
 *
 * The point of running it at all is that the shape survives compression: the
 * fork is long, the health check is a flash you can miss, the fetch is in
 * between. That is the argument the page makes in words, and at 4x it is the
 * argument the page makes in motion, in under two seconds.
 */
export const LADDER_COMPRESS = 4;

/** How long an unmeasured step is held. Marked as arbitrary, because it is. */
export const LADDER_HOLD_MS = 420;

/** Delay and duration for each rung, in document order. */
export function ladderTiming(): Array<{ delay: number; dur: number; measured: boolean }> {
  const out: Array<{ delay: number; dur: number; measured: boolean }> = [];
  let at = 0;
  for (const step of LADDER) {
    const dur = step.ms === null ? LADDER_HOLD_MS : Math.round(step.ms / LADDER_COMPRESS);
    out.push({ delay: at, dur, measured: step.ms !== null });
    at += dur;
  }
  return out;
}

/**
 * The reveal script.
 *
 * Everything it does is additive. The page is complete and readable with this
 * script deleted, which is the property that matters: `js-motion` is set by the
 * script itself, and every rule that hides something is written behind that
 * class. No JavaScript, an old browser, a thrown exception, and the visitor
 * gets the page rather than a set of invisible sections waiting for an observer
 * that is never going to fire.
 *
 * That is not a hypothetical failure mode. It is the same shape as a control
 * that passes its own test and cannot fire: the reveal would work perfectly in
 * every browser that ran it, and show a blank page in the one that did not.
 */
export const MOTION_SCRIPT = `
(function () {
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return;
  var root = document.documentElement;
  // Only now may anything start hidden. Set before the observer, so a section
  // already on screen at load is measured in its hidden state and revealed.
  root.className += " js-motion";

  var play = function (el) { el.setAttribute("data-in", "1"); };

  if (!("IntersectionObserver" in window)) {
    // No observer, no reveal: show everything at once rather than never.
    document.querySelectorAll("[data-reveal-on-scroll]").forEach(play);
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i].isIntersecting) continue;
      play(entries[i].target);
      io.unobserve(entries[i].target);
    }
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.01 });

  document.querySelectorAll("[data-reveal-on-scroll]").forEach(function (el) { io.observe(el); });

  // The gauge grows to the width the server rendered, so the animation cannot
  // end anywhere but the true value. Read it first, then start from zero.
  document.querySelectorAll(".gauge > i").forEach(function (bar) {
    var to = bar.style.width;
    bar.style.width = "0%";
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { bar.style.width = to; });
    });
  });
})();
`;
