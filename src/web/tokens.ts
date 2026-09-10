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
/**
 * Zero. The reference site's 26px radius was copied along with its grid, and
 * the two fight: a grid is a system of right angles, and a rounded card sits on
 * it like a sticker. Every surface is now a rectangle cut by hairlines, which
 * is what lets the page read as one instrument rather than as tiles.
 */
export const RADIUS = 0;
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

  /*
   * The one state colour. Neon is a FILL: it marks a thing that is alive (a
   * healthy card, a fresh board, a step that has completed, a button under the
   * cursor) and it is never text, because at 1.15:1 it cannot be.
   */
  --alive: var(--neon);

  --line: rgba(10, 10, 10, .14);
  --line-2: rgba(10, 10, 10, .06);
  --line-3: rgba(10, 10, 10, .035);

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
 * The graph paper, at three intensities.
 *
 * The body carries the faintest grid, for alignment. The hero carries none of
 * its own, so the pixel field is the only thing moving there. A card under the
 * cursor draws the grid one step stronger inside its own border, which is the
 * only place the grid is allowed to answer the visitor. Fixed rather than
 * scrolled, because a grid that moves reads as texture and a grid that stays
 * reads as paper.
 */
body {
  margin: 0;
  background-color: var(--paper);
  background-image:
    linear-gradient(to right, var(--line-3) 1px, transparent 1px),
    linear-gradient(to bottom, var(--line-3) 1px, transparent 1px);
  background-size: var(--cell) var(--cell);
  background-attachment: fixed;
  color: var(--ink);
  font-family: var(--font);
  font-size: 17px;
  line-height: 1.5;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--line); }
a:hover, a:focus-visible { border-bottom-color: var(--ink); }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }

.wrap { max-width: var(--max); margin: 0 auto; padding: 0 var(--gutter); }

/*
 * Micro labels: monospace, uppercase, wide tracking. Every measurement on the
 * page is introduced by one of these, which is what lets the numbers themselves
 * be set large and unadorned.
 */
.label, .cell-label, .shot-cap, .chip, .slots, .kick, .cat, .steps, .card-foot, .sys, .foot {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: .12em;
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

/*
 * Two registers of type. Statement type is the display face, large and tight.
 * Instrument type is monospace, small, tracked. Nothing on the page is set in
 * between, and that gap is most of the hierarchy.
 */
h1, h2, h3 { font-weight: 700; letter-spacing: -.03em; line-height: 1.02; margin: 0; }
h1 { font-size: clamp(40px, 6.4vw, 88px); letter-spacing: -.04em; }
h2 { font-size: clamp(28px, 3.4vw, 46px); }
p { margin: 0 0 calc(var(--cell) * 1); }

.muted { color: var(--muted); }
.fail { color: var(--fail); }
.warn { color: var(--warn); }
.ok { color: var(--accent); }

/*
 * The alive mark. A filled square, one cell of the grid, set in the state
 * colour. It is the only accent the page has and it appears only where
 * something is genuinely running, passing or ready.
 */
.dot { display: inline-block; width: 8px; height: 8px; margin-right: 8px;
  background: var(--alive); vertical-align: 1px; outline: 1px solid rgba(10, 10, 10, .18); }
.dot[data-s="off"], .dot[data-stale="1"] { background: transparent; outline-color: var(--line); }
.dot[data-s="fail"] { background: var(--red); outline-color: transparent; }

/* ------------------------------------------------------------------ masthead */

.masthead {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: calc(var(--cell) * 2);
  padding: calc(var(--cell) * 1) var(--gutter);
  border-bottom: 1px solid var(--line);
}
.masthead .brand {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: .22em;
  text-transform: uppercase;
  border: 0;
}
.masthead .sys { letter-spacing: .1em; }
.masthead nav { display: flex; gap: calc(var(--cell) * 2); justify-self: end; }
.masthead nav a { border: 0; font-family: var(--mono); font-size: 10px;
  letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.masthead nav a:hover { color: var(--ink); }

/* ---------------------------------------------------------------------- hero */

.hero { position: relative; border-bottom: 1px solid var(--line); }
.hero .wrap { padding-top: calc(var(--cell) * 5); padding-bottom: calc(var(--cell) * 13); }
.hero h1 { max-width: 100%; }
.hero .lede { max-width: 34ch; margin: calc(var(--cell) * 2) 0 0; color: var(--muted);
  font-size: 21px; line-height: 1.35; }

/*
 * The provisioning ladder. Five steps, one hairline each, set as instrument
 * text under the statement: what happens between the button and the browser.
 * It is the whole product in one row, and it is the same five words the
 * launch panel later lights up one at a time.
 */
.steps { display: flex; flex-wrap: wrap; margin: calc(var(--cell) * 3) 0 0;
  padding: 0; list-style: none; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
  max-width: 640px; }
.steps li { display: flex; align-items: baseline; gap: 10px; padding: 10px calc(var(--cell) * 1.5) 10px 0;
  margin-right: calc(var(--cell) * 1.5); border-top: 1px solid transparent; color: var(--ink); }
.steps li::before { content: attr(data-n); color: var(--muted); }
.steps li:last-child { color: var(--muted); }
.kick { display: inline-flex; align-items: center; gap: 10px; margin-top: calc(var(--cell) * 3);
  color: var(--ink); border: 0; }
.kick::after { content: ""; width: 8px; height: 8px; background: var(--ink); }
.kick:hover::after { background: var(--alive); outline: 1px solid var(--ink); }

/* --------------------------------------------------------------------- board */

/*
 * The instrument panel. A number, then its label underneath, one hairline
 * between each cell and one above and below the row. The number is the visual;
 * the label only says which one it is.
 *
 * A paper backdrop, because the pixel field passes beneath it and a measurement
 * that is only legible when the cursor is somewhere else is not a measurement
 * anybody can read.
 */
.board { border-bottom: 1px solid var(--line);
  background: rgba(255, 255, 255, .86);
  -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
.board .wrap { padding: 0 var(--gutter); }
.board-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  border-left: 1px solid var(--line); }
.board-grid > div { padding: calc(var(--cell) * 2) calc(var(--cell) * 1.5) calc(var(--cell) * 1.5);
  border-right: 1px solid var(--line); display: flex; flex-direction: column; }
.cell-value { order: 0; font-size: clamp(36px, 4.2vw, 60px); font-weight: 500; white-space: nowrap;
  line-height: 1; letter-spacing: -.035em; font-variant-numeric: tabular-nums; }
.cell-value.cell-none { font-size: 15px; letter-spacing: 0; color: var(--muted);
  line-height: 1.4; padding: 10px 0 8px; }
.cell-label { order: 1; margin: 12px 0 0; }
.gauge { order: 2; margin-top: 12px; height: 4px; background: var(--line-2); }
.gauge i { display: block; height: 100%; background: var(--ink); }
.staledot { display: inline-block; width: 8px; height: 8px; margin-right: 8px;
  background: var(--alive); vertical-align: 1px; outline: 1px solid rgba(10, 10, 10, .18); }
.staledot[data-stale="1"] { background: transparent; outline-color: var(--line); }

/* The verification signal. Quieter than the panel above it on purpose. */
.board-note { display: grid; grid-template-columns: 1fr auto; gap: calc(var(--cell) * 2);
  align-items: end; padding: calc(var(--cell) * 1.25) 0 calc(var(--cell) * 1.5);
  border-top: 1px solid var(--line); }
.board-note .label { color: var(--ink); }
.board-note .muted { font-size: 12px; margin-top: 6px; max-width: 60ch; }
.canary { text-align: right; }

/*
 * The canary record: one cell per check, ink for a pass, red for a fail, faint
 * for a slot no canary has reached yet. It is drawn from data, which is the only
 * reason it is allowed to be on the page at all.
 */
.field { margin-top: 10px; display: grid; grid-auto-flow: column; grid-auto-columns: 6px;
  grid-template-rows: repeat(4, 6px); gap: 2px; justify-content: end; overflow: hidden; }
.field i { width: 6px; height: 6px; display: block; background: var(--line-2); }
.field i[data-s="ok"] { background: var(--ink); }
.field i[data-s="fail"] { background: var(--red); }
.field i[data-s="idle"] { background: rgba(10, 10, 10, .05); }

/* ------------------------------------------------------------------ catalog */

.pick { padding-top: calc(var(--cell) * 6); }
.pick h2 { margin: 0; }
.pick .sub { margin: calc(var(--cell) * 1) 0 0; max-width: 46ch; color: var(--muted); font-size: 19px; }

/*
 * The one check, as a row of the instrument rather than a widget dropped on
 * the page. Label, widget, state. It sits above the cards because it gates
 * every button beneath it.
 */
.verify { display: grid; grid-template-columns: auto 1fr; gap: calc(var(--cell) * 2);
  align-items: center; margin: calc(var(--cell) * 3) 0 0; padding: calc(var(--cell) * 1.25) 0;
  border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.verify .label { color: var(--ink); }
.verify .muted { font-size: 14px; margin: 0; max-width: 48ch; }
.verify #ts-state { margin-top: 6px; }
.verify #ts-state[data-state="ok"]::before { content: ""; display: inline-block; width: 8px; height: 8px;
  background: var(--alive); outline: 1px solid rgba(10,10,10,.18); margin-right: 8px; vertical-align: 1px; }

/* --------------------------------------------------------------------- cards */

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: calc(var(--cell) * 2); padding: calc(var(--cell) * 3) 0 calc(var(--cell) * 6); }

/*
 * A card is a rectangle of paper cut by hairlines: screenshot, identity, why,
 * launch, in that order and in that weight. Translucent, so the pixel field
 * shows through rather than being hidden by it, and the blur keeps the body
 * text readable over whatever colour is passing underneath.
 */
.card { position: relative; display: flex; flex-direction: column;
  background: rgba(255, 255, 255, .86);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden;
  transition: border-color .15s ease; }
.card:hover { border-color: var(--ink);
  background-image:
    linear-gradient(to right, var(--line-2) 1px, transparent 1px),
    linear-gradient(to bottom, var(--line-2) 1px, transparent 1px);
  background-size: var(--cell) var(--cell); }
/* The pixelation canvas sits exactly over the screenshot it replaces. */
.pixshot { position: absolute; inset: 0 0 auto 0; width: 100%;
  aspect-ratio: 16 / 10; display: block; z-index: 2; pointer-events: none; }

/*
 * The screenshot is a window, not an illustration. Edge to edge, one hairline
 * under it, and a state bar laid over its bottom edge saying whether the thing
 * in the picture is alive right now and when the picture was taken.
 */
.shot-wrap { position: relative; }
.shot { aspect-ratio: 16 / 10; background: var(--surface); display: block; width: 100%;
  object-fit: cover; object-position: top center; border-bottom: 1px solid var(--line); }
.shot-state { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3;
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 4px var(--cell);
  padding: 6px calc(var(--cell) * 1); background: rgba(255, 255, 255, .92);
  border-top: 1px solid var(--line); }
.shot-state > * { white-space: nowrap; }
.shot-state .shot-cap { padding: 0; }
.shot-state .ok, .shot-state .fail { font-family: var(--mono); font-size: 10px; letter-spacing: .12em;
  text-transform: uppercase; }
.shot-state .ok { color: var(--ink); }

.card-body { display: flex; flex-direction: column; gap: calc(var(--cell) * 1);
  padding: calc(var(--cell) * 1.25) calc(var(--cell) * 1.5) calc(var(--cell) * 1.5); }
.card-title h2 { font-size: 28px; letter-spacing: -.035em; }
.cat { display: block; margin-top: 4px; }
.desc { margin: 0; font-size: 15px; color: var(--muted); line-height: 1.45; }

/*
 * Things to try, numbered as part of the instrument: 01, 02, 03 in the label
 * face, tight enough to read as one block.
 */
.try { margin: 0; padding: 0; list-style: none; counter-reset: try; font-size: 15px; }
.try li { counter-increment: try; display: grid; grid-template-columns: 28px 1fr; gap: 6px;
  padding: 5px 0; border-top: 1px solid var(--line-2); }
.try li:first-child { border-top: 0; }
.try li::before { content: counter(try, decimal-leading-zero); font-family: var(--mono); font-size: 10px;
  letter-spacing: .12em; color: var(--muted); padding-top: 4px; }

.creds { display: block; }
.card-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 0 12px;
  padding-top: calc(var(--cell) * 1); border-top: 1px solid var(--line-2); }
.card-foot a { border: 0; color: var(--muted); }
.card-foot a:hover { color: var(--ink); }
.card-foot .sep { color: var(--line); }

/*
 * The launch block. Capacity above the button, the button itself a command:
 * mono, uppercase, full width, one arrow. Under the cursor it turns the state
 * colour with ink text, which is the machine coming alive before it is asked.
 */
.launch { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.launch .slots { color: var(--ink); }

/* ------------------------------------------------------------------- buttons */

.btn {
  font: inherit; font-size: 16px; font-weight: 500; cursor: pointer;
  background: var(--ink); color: var(--paper); border: 1px solid var(--ink);
  border-radius: var(--radius); padding: 12px 20px; width: 100%;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
.btn:hover { background: var(--navy); border-color: var(--navy); }
.btn:disabled { background: transparent; color: var(--muted); border-color: var(--line);
  cursor: not-allowed; }
.btn-ghost { background: transparent; color: var(--ink); border-color: var(--line); }
.btn-ghost:hover { background: var(--surface); border-color: var(--ink); }
.btn-danger { background: var(--fail); border-color: var(--fail); color: var(--paper); }

.btn-launch { display: flex; justify-content: space-between; align-items: center;
  font-family: var(--mono); font-size: 12px; letter-spacing: .16em; text-transform: uppercase;
  padding: 14px 18px; }
.btn-launch:hover:not(:disabled) { background: var(--alive); color: var(--ink); border-color: var(--ink); }
.btn-launch:disabled { justify-content: center; }
.btn-launch .arrow { font-size: 14px; letter-spacing: 0; }

/*
 * The one button the site exists for, so it stops looking like the other four.
 * Filled rather than ghost, because "Open your instance" is the primary action
 * on that panel and everything beside it is secondary.
 */
.btn-open { background: var(--pink); border-color: var(--pink); color: var(--paper); }
.btn-open:hover { background: #B80060; border-color: #B80060; }
.btn .slots { color: inherit; opacity: .7; }

/* -------------------------------------------------------- panels and strips */

.panel { border: 1px solid var(--ink); border-radius: var(--radius);
  padding: calc(var(--cell) * 1.5); display: flex; flex-direction: column; gap: var(--cell);
  background: rgba(255, 255, 255, .92); }

/*
 * The state ladder. Each step is a square and a word; a completed step fills
 * its square with the state colour. The whole progression is visible from the
 * first frame, so the visitor can see how far there is to go, not just that
 * something is happening.
 */
.pills { display: grid; gap: 0; list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line-2); }
.pill { display: flex; align-items: center; gap: 10px; font-family: var(--mono); font-size: 10px;
  letter-spacing: .12em; text-transform: uppercase; color: var(--muted); padding: 7px 0;
  border-bottom: 1px solid var(--line-2); border-radius: 0; }
.pill i { width: 8px; height: 8px; display: block; background: transparent;
  outline: 1px solid var(--line); flex: none; }
.pill[data-on="1"] { color: var(--ink); }
.pill[data-on="1"] i { background: var(--alive); outline-color: rgba(10, 10, 10, .18); }
.timer { font-size: clamp(36px, 4.6vw, 64px); line-height: 1; letter-spacing: -.035em; font-weight: 500;
  font-family: var(--font); font-variant-numeric: tabular-nums; text-transform: none; color: var(--ink); }

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

/* -------------------------------------------------------------------- footer */

.foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--cell);
  padding: calc(var(--cell) * 1.5) var(--gutter) calc(var(--cell) * 3); border-top: 1px solid var(--line); }
.foot a { border: 0; color: var(--ink); }

/* ------------------------------------------------------------------- motion */

/*
 * Motion is a state change or it is not here. The two display lines step in,
 * the hero rule draws itself once, and everything else moves only because the
 * machine did: a step completing, a number changing, a button under the cursor.
 * steps(6) is the whole trick: six discrete jumps, no interpolation.
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
  .masthead { grid-template-columns: 1fr auto; }
  .masthead .sys { display: none; }
  .hero .wrap { padding-bottom: calc(var(--cell) * 8); }
  .board-grid { border-left: 0; }
  .board-grid > div { border-right: 0; border-top: 1px solid var(--line-2); padding-left: 0; }
  .board-note { grid-template-columns: 1fr; }
  .canary { text-align: left; }
  .field { justify-content: start; }
  .verify { grid-template-columns: 1fr; }
}
`;
