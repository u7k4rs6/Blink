/**
 * Design tokens.
 *
 * Exported as data rather than written into a stylesheet by hand, so a token
 * cannot drift between the spec and the page, and so a test can assert the
 * contrast ratios rather than trusting that they were checked once.
 *
 * The system is the one used by craft.wild.as: white paper, near black ink, a
 * visible 14px cell grid, hairline rules, very large light display type, and
 * monospace micro labels in wide uppercase. Blink's earlier dark theme is gone.
 *
 * TWO DELIBERATE DEPARTURES FROM THE REFERENCE, both measured with contrast()
 * below rather than eyeballed:
 *
 * 1. Muted text is #6E6E6E (5.10:1), not the reference's #8B8B8B (3.41:1). The
 *    reference sets its muted colour at 10px, which is exactly the size where
 *    3.41 hurts most. Copying it would have imported a legibility bug.
 * 2. The bright colours are FILLS ONLY and never text. Neon #D8FF00 is 1.15:1
 *    on paper and yellow #F5C518 is 1.63:1, so either as a status colour would
 *    be invisible. The reference never uses them as text either; that is the
 *    part of the system worth copying, and it is easy to miss by looking at a
 *    screenshot and pulling the hex codes out.
 *
 * Status colours are therefore darkened relatives that pass AA on paper, which
 * is why they are not the reference's own red.
 */

export const TOKENS = {
  /** Page. `bg` and `text` keep their names because the contrast test reads them. */
  bg: "#FFFFFF",
  surface: "#FAFAFA",
  border: "#E3E3E3",
  text: "#0A0A0A",
  muted: "#6E6E6E",

  /**
   * The primary action: "Open your <app>".
   *
   * Carries paper coloured text, so it is measured the same way the status
   * colours are: 5.14:1 against white, which clears AA. The lighter pinks that
   * read better as a brand colour do not: #E91E63 is 4.35 and would have put
   * the one button the whole site exists for below the floor every other piece
   * of text on the page has to meet.
   */
  pink: "#D6006E",

  /** Status. Darkened so each one passes AA against paper. */
  accent: "#1A7F37",
  warn: "#9A6700",
  fail: "#C1341A",
} as const;

/**
 * Large blocks of colour only: pixel cells, fills, the hero field. Never text,
 * never a border a reader has to find. Asserted by test.
 */
export const PIXEL = {
  neon: "#D8FF00",
  blue: "#3B5BD9",
  yellow: "#F5C518",
  navy: "#1C2541",
  red: "#E0492A",
} as const;

/**
 * The pixel grid everything snaps to.
 *
 * Not a decoration. Spacing, the hero field, the canary strip and the card
 * rhythm are all multiples of this, which is what makes the page read as one
 * drawing rather than as boxes that happen to share a colour.
 */
export const CELL = 14;
export const GUTTER = 56;
export const MAX_WIDTH = 1176;
export const RADIUS = 26;
export const READ_WIDTH = "34ch";

/** 14, 28, 42, 56, 84, 112. Every one a multiple of the cell. */
export const SPACE = [14, 28, 42, 56, 84, 112] as const;

/**
 * Space Grotesk, with a real fallback stack behind it.
 *
 * The reference uses Sneak, which is licensed and cannot ship here. Space
 * Grotesk is the closest free grotesque with the same tight apertures and a
 * usable 700, which the headings need. Loaded with font-display: swap and a
 * stack that stands up on its own, because this site is served from a laptop
 * and a blocking web font is the wrong thing to make a visitor wait for.
 */
export const FONT_TEXT =
  '"Space Grotesk", "Helvetica Neue", Helvetica, system-ui, -apple-system, Arial, sans-serif';

/** One link, in the page head. Kept here so the face and the fetch cannot drift. */
export const FONT_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?' +
  'family=Space+Grotesk:wght@400;500;700&display=swap">';
export const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Relative luminance per WCAG 2.1. */
export function luminance(hex: string): number {
  const v = hex.replace("#", "");
  const parts = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = parts.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

export function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (la + 0.05) / (lb + 0.05);
}

export const CSS = `
:root {
  --paper: ${TOKENS.bg};
  --surface: ${TOKENS.surface};
  --ink: ${TOKENS.text};
  --muted: ${TOKENS.muted};
  --border: ${TOKENS.border};
  --accent: ${TOKENS.accent};
  --warn: ${TOKENS.warn};
  --fail: ${TOKENS.fail};
  --pink: ${TOKENS.pink};

  --neon: ${PIXEL.neon};
  --blue: ${PIXEL.blue};
  --yellow: ${PIXEL.yellow};
  --navy: ${PIXEL.navy};
  --red: ${PIXEL.red};

  --line: rgba(10, 10, 10, .12);
  --line-2: rgba(10, 10, 10, .06);

  --cell: ${CELL}px;
  --gutter: ${GUTTER}px;
  --max: ${MAX_WIDTH}px;
  --readw: ${READ_WIDTH};
  --radius: ${RADIUS}px;
  --font: ${FONT_TEXT};
  --mono: ${FONT_MONO};

  /* Kept so the old names resolve rather than silently rendering transparent. */
  --bg: var(--paper);
  --text: var(--ink);
  color-scheme: light;
}

* { box-sizing: border-box; }

/*
 * The pixel field. Behind everything, catching nothing: the canvas covers the
 * viewport, so without pointer-events: none it would swallow the launch button.
 */
.pixfield {
  position: fixed; inset: 0; z-index: 0;
  pointer-events: none;
  opacity: .85;
}
body > *:not(.pixfield) { position: relative; z-index: 1; }

/*
 * The graph paper. One background-image, two gradients, drawn at the cell size
 * so it lines up with every margin on the page. It is fixed rather than scrolled
 * because a grid that moves reads as texture and a grid that stays reads as
 * paper, which is the whole effect.
 */
body {
  margin: 0;
  background-color: var(--paper);
  background-image:
    linear-gradient(to right, var(--line-2) 1px, transparent 1px),
    linear-gradient(to bottom, var(--line-2) 1px, transparent 1px);
  background-size: var(--cell) var(--cell);
  background-attachment: fixed;
  color: var(--ink);
  font-family: var(--font);
  font-size: 18px;
  line-height: 1.5;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--line); }
a:hover, a:focus-visible { border-bottom-color: var(--ink); }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }

.wrap { max-width: var(--max); margin: 0 auto; padding: 0 var(--gutter); }

/*
 * Micro labels. Monospace, 10px, uppercase, wide tracking. Every measurement on
 * the page is introduced by one of these, which is what lets the numbers
 * themselves be set large and unadorned.
 */
/*
 * Micro labels: monospace, uppercase, wide tracking. Every measurement on the
 * page is introduced by one of these, which is what lets the numbers themselves
 * be set large and unadorned.
 */
.label, .cell-label, .shot-cap, .chip, .slots, .kick {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--muted);
}

/*
 * Monospace DATA is a different thing and must never be uppercased. The health
 * wall prints snapshot ids and ISO timestamps in it: snap_dl6c3hu908ru came
 * out as SNAP_DL6C3HU908RU, which is not the id, and anyone who copied it off
 * the page would have copied something that does not exist.
 */
.mono {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0;
  text-transform: none;
  font-variant-numeric: tabular-nums;
}

h1, h2, h3 { font-weight: 700; letter-spacing: -.03em; line-height: 1.02; margin: 0; }
/*
 * Sized so each hero line fits on one line at the top of its range. The first
 * pass used clamp(38px, 7vw, 96px) with a 13ch measure and broke a two line
 * headline into five, which is the one thing a display face must not do.
 */
h1 { font-size: clamp(40px, 6.4vw, 88px); letter-spacing: -.04em; }
h2 { font-size: clamp(28px, 3.4vw, 46px); }
p { margin: 0 0 calc(var(--cell) * 1); }

.muted { color: var(--muted); }
.fail { color: var(--fail); }
.warn { color: var(--warn); }
.ok { color: var(--accent); }

/* ------------------------------------------------------------------ masthead */

.masthead {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: calc(var(--cell) * 2);
  padding: calc(var(--cell) * 1) var(--gutter);
  border-bottom: 1px solid var(--line);
}
.masthead .brand {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: .18em;
  text-transform: uppercase;
  border: 0;
}
.masthead nav { display: flex; gap: calc(var(--cell) * 2); }
.masthead nav a { border: 0; font-family: var(--mono); font-size: 10px;
  letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.masthead nav a:hover { color: var(--ink); }

/* ---------------------------------------------------------------------- hero */

.hero { position: relative; border-bottom: 1px solid var(--line); }
.hero .wrap { padding-top: calc(var(--cell) * 4); padding-bottom: calc(var(--cell) * 19); }
.hero h1 { max-width: 100%; }
.hero .lede { max-width: 34ch; margin: calc(var(--cell) * 2) 0 0; color: var(--muted);
  font-size: 21px; line-height: 1.35; }


/*
 * The hero field is drawn from real canary history, not from noise. Each cell is
 * one check: ink for a pass, red for a fail, faint for a slot no canary has
 * reached yet. It is the one ornament on the page and it is made of data, which
 * is the only reason it is allowed to be this large.
 */
/* Sits with the board, because it is a measurement and not decoration. It was
 * in the hero, where the ambient cloud now is, and a grid of faint grey cells
 * over a drifting colour field is neither of those things clearly. */
.field { margin-top: calc(var(--cell) * 2.5); display: grid; grid-auto-flow: column; grid-auto-columns: var(--cell);
  grid-template-rows: repeat(4, var(--cell)); gap: 2px; justify-content: start;
  overflow: hidden; }
.field i { width: var(--cell); height: var(--cell); display: block; background: var(--line-2); }
.field i[data-s="ok"] { background: var(--ink); }
.field i[data-s="fail"] { background: var(--red); }
.field i[data-s="idle"] { background: rgba(10, 10, 10, .05); }

/* --------------------------------------------------------------------- board */

/*
 * A paper backdrop under the board, because the pixel field passes beneath it.
 * A measurement that is only legible when the cursor is somewhere else is not a
 * measurement anybody can read.
 */
.board { border-bottom: 1px solid var(--line);
  background: rgba(255, 255, 255, .82);
  -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
.board .wrap { padding: calc(var(--cell) * 2) var(--gutter); }
.board-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: calc(var(--cell) * 2); }
.cell-label { margin: 0 0 6px; }
.cell-value { font-size: clamp(26px, 2.8vw, 40px); font-weight: 700; white-space: nowrap; line-height: 1; letter-spacing: -.02em;
  font-variant-numeric: tabular-nums; }
.cell-value.cell-none { font-size: 15px; letter-spacing: 0; color: var(--muted);
  line-height: 1.4; padding-top: 6px; }
.gauge { margin-top: 10px; height: 6px; background: var(--line-2); }
.gauge i { display: block; height: 100%; background: var(--ink); }
.staledot { display: inline-block; width: 7px; height: 7px; margin-right: 6px;
  background: var(--accent); vertical-align: middle; }
.staledot[data-stale="1"] { background: var(--muted); }

/* --------------------------------------------------------------------- cards */

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: calc(var(--cell) * 3); padding: calc(var(--cell) * 4) 0; }
/*
 * Translucent, so the pixel field shows through rather than being hidden.
 *
 * The field is a fixed canvas behind the page, and an opaque card paints over
 * it: the cursor could be an arrow pointing at a card's own title and none of
 * it was visible, because the card was in the way. Same treatment as the board,
 * for the same reason, and the blur keeps the body text readable over whatever
 * colour is passing underneath.
 */
.card { display: flex; flex-direction: column;
  background: rgba(255, 255, 255, .84);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.card:hover { border-color: rgba(10, 10, 10, .3); }
/* The pixelation canvas sits exactly over the screenshot it replaces. */
.card { position: relative; }
.pixshot { position: absolute; inset: 0 0 auto 0; width: 100%;
  aspect-ratio: 16 / 10; display: block; z-index: 2; pointer-events: none; }

.shot { aspect-ratio: 16 / 10; background: var(--surface); display: block; width: 100%;
  object-fit: cover; object-position: top center; border-bottom: 1px solid var(--line); }
.shot-cap { padding: 10px calc(var(--cell) * 1.5) 0; }
.card-body { display: flex; flex-direction: column; gap: var(--cell);
  padding: var(--cell) calc(var(--cell) * 1.5) calc(var(--cell) * 1.5); }
.card-title { display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--cell); }
.card-title h2 { font-size: 26px; }
.chip { border: 1px solid var(--line); border-radius: 999px; padding: 3px 9px; }
.try { margin: 0; padding-left: 1.1em; color: var(--ink); font-size: 16px; }
.try li { margin: 2px 0; }
.card-foot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cell);
  padding-top: var(--cell); border-top: 1px solid var(--line-2);
  font-family: var(--mono); font-size: 10px; letter-spacing: .1em;
  text-transform: uppercase; color: var(--muted); }

/* ------------------------------------------------------------------- buttons */

.btn {
  font: inherit; font-size: 17px; font-weight: 500; cursor: pointer;
  background: var(--ink); color: var(--paper); border: 1px solid var(--ink);
  border-radius: 999px; padding: 11px 22px; width: 100%;
}
.btn:hover { background: var(--navy); border-color: var(--navy); }
.btn:disabled { background: transparent; color: var(--muted); border-color: var(--line);
  cursor: not-allowed; }
.btn-ghost { background: transparent; color: var(--ink); border-color: var(--line); }
.btn-ghost:hover { background: var(--surface); border-color: var(--ink); }
.btn-danger { background: var(--fail); border-color: var(--fail); color: var(--paper); }

/*
 * The one button the site exists for, so it stops looking like the other four.
 * Filled rather than ghost, because "Open your instance" is the primary action
 * on that panel and everything beside it is secondary.
 */
.btn-open { background: var(--pink); border-color: var(--pink); color: var(--paper); }
.btn-open:hover { background: #B80060; border-color: #B80060; }
.btn .slots { color: inherit; opacity: .7; }

/* -------------------------------------------------------- panels and strips */

.panel { border: 1px solid var(--line); border-radius: var(--radius);
  padding: calc(var(--cell) * 1.5); display: flex; flex-direction: column; gap: var(--cell); }
.pills { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0; padding: 0; }
.pill { font-family: var(--mono); font-size: 10px; letter-spacing: .1em;
  text-transform: uppercase; border: 1px solid var(--line); border-radius: 999px;
  padding: 3px 9px; color: var(--muted); }
.pill[data-on="1"] { border-color: var(--ink); color: var(--ink); }
.timer { font-size: clamp(28px, 4vw, 52px); line-height: 1; letter-spacing: -.02em;
  font-variant-numeric: tabular-nums; text-transform: none; color: var(--ink); }

.strip { display: flex; gap: 2px; }
.strip i { width: 9px; height: 20px; background: var(--line); display: block; }
.strip i[data-s="ok"] { background: var(--ink); }
.strip i[data-s="fail"] { background: var(--red); }
.strip i[data-s="warn"] { background: var(--warn); }
.strip i[data-s="none"] { background: var(--line-2); }

.row { display: grid; gap: calc(var(--cell) * .5); padding: calc(var(--cell) * 1.5) 0;
  border-bottom: 1px solid var(--line-2); }
.receipt { font-family: var(--mono); font-size: 12px; text-transform: none;
  letter-spacing: 0; color: var(--ink); }

/* ------------------------------------------------------------------- motion */

/*
 * The reference reveals each display line with a stepped easing, which is what
 * makes the motion read as pixels rather than as a fade. steps(6) is the whole
 * trick: six discrete jumps, no interpolation.
 */
@keyframes lineGrowX { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes heroLine { from { transform: translateY(115%); } to { transform: translateY(0); } }

.hero h1 span { display: block; overflow: hidden; }
.hero h1 span > span { display: block; animation: heroLine .95s steps(6) both; }
.hero h1 span:nth-child(2) > span { animation-delay: .12s; }
.hero::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px;
  background: var(--line); transform-origin: left;
  animation: lineGrowX .9s cubic-bezier(.16, 1, .3, 1) .4s both; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .hero h1 span > span { transform: none; }
}

@media (max-width: 720px) {
  :root { --gutter: 20px; }
  .hero .hgrid, .masthead { grid-template-columns: 1fr; }
  .field { display: none; }
}
`;
