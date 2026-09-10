/**
 * The background pixel field: cells heat up under the cursor and cool down.
 *
 * Adapted from craft.wild.as, whose effect is a heat field rather than a hover
 * state. The cursor deposits heat into a grid, heat decays every frame, and
 * thresholds map heat to a colour ramp. The trail IS the cooling, which is why
 * theirs leaves a comet and a naive hover highlight does not.
 *
 * Four things are load bearing, and the first version of this had none of them:
 *
 * 1. A LARGE brush. Ten cells, not five. A small one draws a cursor, not a
 *    field.
 * 2. DITHER at the cold fringe. Cells near the bottom of the coldest band are
 *    drawn probabilistically from a stable hash, so the edge breaks into
 *    scattered pixels instead of ending on a circle. Without it the effect
 *    reads as a blurred blob; with it, it reads as pixels, which is the point.
 * 3. A NOISE term on the heat used to pick a band, so band edges shimmer and
 *    do not appear as contour lines.
 * 4. The ramp is neon, red, yellow, blue, navy from hot to cold. Those are the
 *    reference's own fill colours, used here for the same reason: they are
 *    large blocks nobody has to read. None would pass contrast as text and none
 *    is used as text.
 */

/**
 * The field's own cell, which is NOT the layout's 14px cell.
 *
 * The reference lays out on a 14px grid and draws its heat canvas on a 9px one.
 * Using 14 for both made the blob chunky and, at the same radius in cells, half
 * again as wide: the trail read as a slab rather than as the small smooth comet
 * it is on their site. The layout grid and the drawing grid are separate
 * decisions and only one of them is about spacing.
 */
export const FIELD_CELL = 9;

/**
 * Brush radius in field cells.
 *
 * Measured off a screen recording of the reference rather than off a still: the
 * cursor blob there is about 32px across in ordinary use. A still of a fast
 * sweep shows big clouds, but those are accumulated heat along a path, not the
 * brush. Sizing from the still gave a 180px blob that the eye reads as a stain.
 * Four cells is 36px of radius, so the blob is 72px and the CLOUDS are what get
 * large when you move quickly, which is the behaviour rather than the size.
 */
export const FIELD_RADIUS = 4;

/** Heat thresholds, coldest first. Below the first one a cell is not drawn. */
export const BANDS: Array<[number, string]> = [
  [0.14, "#1C2541"],
  [0.28, "#3B5BD9"],
  [0.44, "#F5C518"],
  [0.62, "#E0492A"],
  [0.82, "#D8FF00"],
];

/** How far below a band edge a cell is still dithered rather than solid. */
export const DITHER_BAND = 0.12;

/** Which colour a cell of this heat is, or null when it is too cold to draw. */
export function bandFor(heat: number): string | null {
  let found: string | null = null;
  for (const [threshold, colour] of BANDS) {
    if (heat >= threshold) found = colour;
  }
  return found;
}

/**
 * Heat after one frame of cooling.
 *
 * Slow, so a sweep leaves a trail that is still there when the eye comes back
 * to it, and clamped to zero below a floor so the field can reach cold and let
 * the render loop stop.
 */
export function cool(heat: number, decay = 0.965): number {
  const next = heat * decay;
  return next < 0.02 ? 0 : next;
}

/** Heat added to a cell this far (in cells) from the cursor. */
export function brush(distanceCells: number, radius: number): number {
  if (distanceCells > radius) return 0;
  const t = 1 - distanceCells / radius;
  return t * t;
}

/**
 * Pac-Man's mouth angle at a given age in frames.
 *
 * Chomps rather than sitting open, which is the difference between a Pac-Man
 * and a circle with a notch in it.
 */
export function mouthAt(ageFrames: number): number {
  return 0.05 + 0.6 * Math.abs(Math.sin(ageFrames * 0.16));
}

/** Is this cell inside a Pac-Man of this radius, facing this way? */
export function inPacman(
  dx: number, dy: number, radius: number, facing: number, mouth: number,
): boolean {
  if (dx * dx + dy * dy > radius * radius) return false;
  let a = Math.atan2(dy, dx) - facing;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return Math.abs(a) > mouth;
}

/**
 * The heat a pellet and Pac-Man himself are drawn at: the yellow band.
 *
 * The reference uses 0.72 and says "yellow band" in a comment, which is true of
 * ITS thresholds and false of these. Copying the number rather than the meaning
 * would have drawn a red Pac-Man. Asserted against BANDS by test.
 */
export const PAC_HEAT = 0.52;

/**
 * Pac-Man's radius and his pellet spacing, in cells.
 *
 * The reference computes his radius as BRUSH * 3.4, which is 34 of ITS cells at
 * 9px, inside a canvas that only covers the hero. Carried over literally to a
 * full page canvas on a 14px grid it made him 950px across: he covered the
 * headline, the board and half the cards at once. The number that transfers is
 * the one in pixels, not the one in cells.
 *
 * Sized down twice after looking at it: 34 cells was a wall, 14 was still a
 * third of the viewport. Eight field cells is 72px of radius, so he is about
 * 144px across and reads as Pac-Man without owning the page.
 */
export const PAC_RADIUS_CELLS = 8;
export const PAC_FOOD_CELLS = 5;
/** Cells per frame. About 215 px a second, so a crossing takes roughly six. */
export const PAC_SPEED_CELLS = 0.4;


/**
 * Little pixel shapes the field stamps when the cursor goes still.
 *
 * Rows of characters, because a bitmap is the one thing better read as a
 * picture than as data: "#" is a hot cell, "+" a warmer one, "." is nothing.
 * Two heats per sprite so the shapes come out two toned like the reference's,
 * rather than as a flat silhouette.
 */
export const SPRITES: Record<string, string[]> = {
  heart: [
    ".++...++.",
    "+####+####",
    "+#########",
    "+#########",
    ".########.",
    "..######..",
    "...####...",
    "....##....",
  ],
  arrow: [
    "....+####",
    "....+####",
    "....##+##",
    "...##..##",
    "..##....#",
    ".##......",
    "##.......",
  ],
  star: [
    "....##....",
    "....##....",
    "..+####+..",
    "##########",
    ".+######+.",
    "..##..##..",
    ".##....##.",
  ],
  smile: [
    "..######..",
    ".########.",
    "##.####.##",
    "##.####.##",
    "##########",
    "#+######+#",
    ".##....##.",
    "..######..",
  ],
  /*
   * A thin shaft and a triangular head, in four directions.
   *
   * Left and right only was the first version, so a cursor sitting directly
   * above or below a heading pointed sideways at nothing. Nine cells on the
   * long axis, which is about 80px: it is drawn at the cursor and has to read
   * as a pointer rather than as a banner.
   */
  arrowR: [
    "....N....",
    "....NN...",
    "NNNNNNN..",
    "NNNNNNNNN",
    "NNNNNNN..",
    "....NN...",
    "....N....",
  ],
  arrowL: [
    "....N....",
    "...NN....",
    "..NNNNNNN",
    "NNNNNNNNN",
    "..NNNNNNN",
    "...NN....",
    "....N....",
  ],
  arrowD: [
    "..NNN..",
    "..NNN..",
    "..NNN..",
    "NNNNNNN",
    "NNNNNNN",
    ".NNNNN.",
    "..NNN..",
    "...N...",
  ],
  arrowU: [
    "...N...",
    "..NNN..",
    ".NNNNN.",
    "NNNNNNN",
    "NNNNNNN",
    "..NNN..",
    "..NNN..",
    "..NNN..",
  ],
  spark: [
    "....#....",
    "....#....",
    "..+.#.+..",
    "...###...",
    "#####+###",
    "...###...",
    "..+.#.+..",
    "....#....",
  ],
};

/** How many field cells wide one sprite pixel is. */
export const SPRITE_SCALE = 2;

/**
 * The aimed arrow is drawn at single scale, so about 90px wide.
 *
 * Drawn at the cursor, so it has to read as a pointer and not as a banner. At
 * scale two it was 200px, which is a third of a card and was reported as huge.
 * At scale one this sprite is about 100px, and it stays legible because the
 * shape was fixed at the same time: the version that read as a lump at 80px was
 * a bar with two nubs, not a shaft with a head.
 */
export const ARROW_SCALE = 1;

/**
 * How long a stamped shape is held at full heat before it is let go.
 *
 * Without a hold, a shape is unreadable. Stamping once and leaving it to the
 * normal decay took it from neon through red and yellow to blue in about half a
 * second, so what a visitor actually saw was a blue smudge with no colour and
 * barely a silhouette. The shape is re-stamped every frame until the hold ends,
 * then released to melt like everything else, which is the part worth watching.
 */
export const SPRITE_HOLD_MS = 1500;

/**
 * How fast the field cools while the cursor is a shape rather than a blob.
 *
 * The normal decay leaves a trail, which is the whole point of it. Under a
 * shape that trail is the previous frames of the SAME shape, half faded and
 * offset by however far the cursor moved, so an arrow came out as an arrow
 * inside a smear and read as a blob. Cooling hard while a shape is active
 * clears the last frame before the next one lands.
 */
export const SHAPE_DECAY = 0.72;

/**
 * The ambient field: a cloud that drifts under the hero whether or not anyone
 * touches the page.
 *
 * The cursor trail alone left the hero empty until someone moved through it,
 * and the reference's hero is never empty: it has a large animated pixel cloud
 * that is simply always there. This is the same idea, built from layered sines
 * rather than a texture, so there is nothing to load and it never repeats.
 *
 * Confined to one band on purpose. Running it behind the whole page would put a
 * moving colour under every paragraph on the site, and this is a page whose
 * argument is that the numbers on it can be read.
 *
 * STRENGTH is above 1 deliberately. The value is a heat, and heats above the
 * top band simply stay in it, so pushing past 1 does not overflow: it widens
 * the part of each crest that reaches the hot colours. At 0.92 the whole band
 * came out navy with a few blue cells at the very bottom, which is a texture
 * rather than the drifting colour it is copying.
 */
export const AMBIENT_STRENGTH = 1.35;
/** Below this the noise draws nothing, which is what makes clouds and not a wash. */
export const AMBIENT_FLOOR = 0.24;
/** Frames between remeasuring the band. Scroll and resize also trigger it. */
export const AMBIENT_REMEASURE_FRAMES = 15;

/**
 * Layered sines, in cell space and time. Four of them at different rates so
 * the pattern drifts and shears instead of sliding, and none of the periods
 * divide evenly into another, so it does not visibly repeat.
 */
export function ambientAt(c: number, r: number, t: number): number {
  const v =
    Math.sin(c * 0.071 + t * 0.0130) +
    Math.sin(r * 0.113 - t * 0.0091) +
    Math.sin((c + r) * 0.048 + t * 0.0067) +
    Math.sin((c - r * 0.6) * 0.093 - t * 0.0113);
  return (v / 4 + 1) / 2;
}

/**
 * How long the screenshot takes to resolve from blocks to sharp, in frames.
 *
 * It ran in about 18 frames, roughly 300ms, and the reported symptom was that
 * you could not notice it happening at all. An animation nobody sees is an
 * animation that is not there. This holds the blocky frame briefly first, then
 * resolves over about a second, which is long enough to read as the picture
 * arriving rather than as a flicker on hover.
 */
export const PIXELATE_HOLD_FRAMES = 14;
export const PIXELATE_RESOLVE_FRAMES = 58;

/** Heat for each sprite character. Two tones, both inside the visible ramp. */
/**
 * Heat for each sprite character.
 *
 * "#" and "+" are the two tones the cute shapes use, and the noise added at
 * stamp time is what mixes them into the speckle the reference has. "N" is
 * hot enough that the same noise cannot push it out of the top band, which is
 * how the aimed arrow stays a clean neon while a heart stays mottled.
 */
export const SPRITE_HEAT: Record<string, number> = { "#": 0.86, "+": 0.66, "N": 0.98 };

/**
 * The sprites the idle timer picks from.
 *
 * The two arrows are excluded on purpose: they are aimed at a heading, so one
 * appearing on its own in the middle of the page would be pointing at nothing.
 */
export const SPRITE_NAMES = Object.keys(SPRITES).filter((n) => !n.startsWith("arrow"));

/**
 * How near a heading counts as hovering around it.
 *
 * TWO thresholds, not one radius, and that is the point. A single 260px radius
 * missed the right hand side of a card, which sits about 300px from that card's
 * title. Widening it to 380 fixed that and broke the opposite thing: headings
 * are dense enough on this page that almost every position is within 380px of
 * one, so the cursor was an arrow essentially always and stopped being a blob
 * at all.
 *
 * "Hovering around a heading" means roughly LEVEL with it. Generous sideways,
 * tight vertically: the whole width of a card at its title's height is near,
 * and the same card's body two hundred pixels lower is not.
 *
 * Tightened from 340 by 70 after seeing it in use: the arrow was appearing more
 * often than it was earning. 300 still reaches the right hand edge of a card
 * from that card's own title, which is the case the first attempt missed.
 */
export const POINT_DX = 300;
export const POINT_DY = 60;

/**
 * The browser half, as a string.
 *
 * Pac-Man is released by a CLICK, not by going idle. A wanderer that starts on
 * its own is something a reader has to wait out; one that answers a click is
 * something they did.
 *
 * Inline rather than a module because the page has no build step and no bundle,
 * which is the rule the rest of the front end already follows. The pure
 * functions above are the parts worth testing, and the values they encode are
 * interpolated in below rather than retyped.
 */
export const PIXELS_SCRIPT = `
(function () {
  var fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
  var still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!fine || still) return;

  var CELL = ${FIELD_CELL}, RADIUS = ${FIELD_RADIUS}, DITHER = ${DITHER_BAND};
  var SPRITES = ${JSON.stringify(SPRITES)};
  var SPRITE_NAMES = ${JSON.stringify(SPRITE_NAMES)};
  var SPRITE_HEAT = ${JSON.stringify(SPRITE_HEAT)};
  var SCALE = ${SPRITE_SCALE}, ARROW_SCALE = ${ARROW_SCALE};
  var IDLE_MS = 2400, IDLE_EVERY_MS = 3400, HOLD = ${SPRITE_HOLD_MS};
  var SHAPE_DECAY = ${SHAPE_DECAY};
  var AMB_STRENGTH = ${AMBIENT_STRENGTH}, AMB_FLOOR = ${AMBIENT_FLOOR};
  var AMB_EVERY = ${AMBIENT_REMEASURE_FRAMES};
  var PX_HOLD = ${PIXELATE_HOLD_FRAMES}, PX_STEP = 1 / ${PIXELATE_RESOLVE_FRAMES};
  var PDX = ${POINT_DX}, PDY = ${POINT_DY};
  var BANDS = ${JSON.stringify(BANDS)};
  var PAC_HEAT = ${PAC_HEAT}, PAC_R = ${PAC_RADIUS_CELLS};
  var PFOOD = ${PAC_FOOD_CELLS}, PAC_SPEED = ${PAC_SPEED_CELLS};

  var cv = document.createElement("canvas");
  cv.className = "pixfield";
  document.body.appendChild(cv);
  var ctx = cv.getContext("2d");
  if (!ctx) return;

  var cols = 0, rows_ = 0, heat = null, running = false;
  var mx = -1, my = -1, lastMove = 0, t = 0;

  function size() {
    cv.width = innerWidth; cv.height = innerHeight;
    cols = Math.ceil(innerWidth / CELL) + 1;
    rows_ = Math.ceil(innerHeight / CELL) + 1;
    heat = new Float32Array(cols * rows_);
  }
  size();
  addEventListener("resize", size);

  // ---- The ambient clouds ---------------------------------------------------
  //
  // Any element carrying data-ambient gets one, so filling a new empty stretch
  // of page is an attribute rather than another special case in here. An
  // element can name a child to start below, which is how the hero keeps its
  // cloud out from under the headline.
  var bands = [], ambOn = false;

  function measureAmbient() {
    var els = document.querySelectorAll("[data-ambient]");
    bands = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var b = el.getBoundingClientRect();
      var below = el.getAttribute("data-ambient-below");
      var child = below ? el.querySelector(below) : null;
      var from = child ? child.getBoundingClientRect().bottom + 18 : b.top;
      if (b.bottom <= 0 || from >= innerHeight) continue;
      var top = Math.max(0, from) / CELL, bot = b.bottom / CELL;
      if (bot <= top) continue;
      // "up" grows from the top edge downward instead of rising from the floor,
      // so a band under the footer can hang rather than stand.
      /*
       * Per band intensity, because "has a cloud" and "has a cloud as loud as
       * the hero's" are different questions. The hero and the footer are empty
       * stretches and can take the full strength. The catalog is not: a band at
       * full strength there drew straight through five translucent cards and
       * their screenshots, which is the difference between a background and a
       * thing in the way.
       */
      var mul = parseFloat(el.getAttribute("data-ambient-strength") || "1");
      if (!(mul > 0)) mul = 1;
      bands.push({ top: top, bot: bot, mul: mul,
        flip: el.getAttribute("data-ambient") === "down" });
    }
    ambOn = bands.length > 0;
  }

  /** Density for this row: 0 outside every band, rising towards each one's foot. */
  function bandFade(r) {
    for (var i = 0; i < bands.length; i++) {
      var bd = bands[i];
      if (r < bd.top || r > bd.bot) continue;
      var p = (r - bd.top) / ((bd.bot - bd.top) || 1);
      if (bd.flip) p = 1 - p;
      var f = 0.10 + 0.90 * Math.pow(p, 1.6);
      if (p > 0.92) f *= (1 - p) / 0.08;
      return f * bd.mul;
    }
    return 0;
  }

  function noiseAt(c, r, tt) {
    var v = Math.sin(c * 0.071 + tt * 0.0130)
          + Math.sin(r * 0.113 - tt * 0.0091)
          + Math.sin((c + r) * 0.048 + tt * 0.0067)
          + Math.sin((c - r * 0.6) * 0.093 - tt * 0.0113);
    return (v / 4 + 1) / 2;
  }

  /**
   * Two octaves, and a drift.
   *
   * One octave gives smooth crests far apart, which drew a single lonely blob
   * in the middle of an otherwise empty band. The second, at roughly twice the
   * frequency and moving faster, breaks those crests up so the band fills edge
   * to edge and the texture reads as pixels rather than as a gradient.
   */
  function ambientAt(c, r, tt) {
    var drift = tt * 0.09;
    var base = noiseAt(c + drift, r, tt);
    var fine = noiseAt(c * 2.3 - drift * 1.6, r * 2.1, tt * 1.7);
    return base * 0.64 + fine * 0.36;
  }

  /** Stable per cell noise. Deterministic, so a cell does not flicker at random. */
  function hash(c, r) {
    var n = Math.sin(c * 127.1 + r * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  function add(cx, cy, radius, amount) {
    var c0 = Math.max(0, (cx - radius) | 0), c1 = Math.min(cols, cx + radius + 1);
    var r0 = Math.max(0, (cy - radius) | 0), r1 = Math.min(rows_, cy + radius + 1);
    for (var r = r0; r < r1; r++) {
      for (var c = c0; c < c1; c++) {
        var dx = c - cx, dy = r - cy;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d > radius) continue;
        var k = 1 - d / radius;
        var i = r * cols + c;
        var v = heat[i] + k * k * amount;
        heat[i] = v > 1 ? 1 : v;
      }
    }
  }

  /**
   * Stamp a sprite, centred on a point, with a little per cell noise.
   *
   * The noise is what makes a shape come out speckled in two or three colours
   * the way the reference's do, instead of as one flat silhouette. Without it a
   * heart is a red blob and reads as a smear rather than a drawing.
   */
  function stamp(name, cx, cy, scale) {
    var SC = scale || SCALE;
    var art = SPRITES[name];
    if (!art) return;
    var h = art.length, w = 0;
    for (var r = 0; r < h; r++) if (art[r].length > w) w = art[r].length;
    var ox = Math.round(cx / CELL - (w * SC) / 2);
    var oy = Math.round(cy / CELL - (h * SC) / 2);
    for (var r2 = 0; r2 < h; r2++) {
      for (var c2 = 0; c2 < art[r2].length; c2++) {
        var base = SPRITE_HEAT[art[r2][c2]];
        if (!base) continue;
        for (var sy = 0; sy < SC; sy++) {
          for (var sx = 0; sx < SC; sx++) {
            var gx = ox + c2 * SC + sx, gy = oy + r2 * SC + sy;
            if (gx < 0 || gy < 0 || gx >= cols || gy >= rows_) continue;
            var v = base + (hash(gx, gy) - 0.5) * 0.22;
            var id = gy * cols + gx;
            if (v > heat[id]) heat[id] = v > 1 ? 1 : v;
          }
        }
      }
    }
  }

  /** The shape currently being held at full heat, if any. */
  var held = null;
  /** The screenshot being pixelated, if the cursor is on its card. */
  var traced = null;
  /** The arrow currently pointing at a heading, if the cursor is near one. */
  var aimed = null;

  /** A different one each time, never the same twice running. */
  var lastSprite = "";
  function randomSprite() {
    var pick = lastSprite;
    for (var i = 0; i < 8 && pick === lastSprite; i++) {
      pick = SPRITE_NAMES[(Math.random() * SPRITE_NAMES.length) | 0];
    }
    lastSprite = pick;
    return pick;
  }

  /**
   * The heading nearest the cursor, if one is close enough to point at.
   *
   * Distance is measured to the heading's BOX, not its centre, so a long
   * headline is near along its whole length rather than only in the middle.
   */
  function nearestHeading(x, y) {
    var hs = document.querySelectorAll("h1, h2");
    var best = null, bestD = Infinity;
    for (var i = 0; i < hs.length; i++) {
      /*
       * The TEXT's box, not the element's.
       *
       * A heading is a block, so getBoundingClientRect returns the full column
       * width whatever the words actually occupy. The arrow aimed at the right
       * hand edge of an empty column and landed a third of the page away from
       * the headline it was supposed to be pointing at. A Range over the
       * contents measures the glyphs.
       */
      var b = textBox(hs[i]);
      if (b.width < 40 || b.bottom < 0 || b.top > innerHeight) continue;
      var dx = x < b.left ? b.left - x : (x > b.right ? x - b.right : 0);
      var dy = y < b.top ? b.top - y : (y > b.bottom ? y - b.bottom : 0);
      // Both gates, separately. Distance only picks between the ones that
      // already qualify; it never lets a far one in because the other axis
      // happened to be small.
      if (dx > PDX || dy > PDY) continue;
      var d = dx + dy;
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /**
   * The box the GLYPHS occupy, unioned over the heading's text nodes.
   *
   * Two wrong answers came before this one. The element's own rect is the full
   * column, because a heading is a block. A Range over the element's contents is
   * also the full column here, because the hero h1 wraps each line in a block
   * span for the reveal animation, so the range still spans block boxes. Only a
   * range per TEXT NODE measures letters. The arrow was landing a third of a
   * page to the right of the headline it was pointing at, twice, for two
   * different reasons that produced the identical symptom.
   */
  function textBox(el) {
    try {
      var walk = document.createTreeWalker(el, 4);
      var L = Infinity, T = Infinity, R = -Infinity, B = -Infinity, found = false, n;
      while ((n = walk.nextNode())) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        var rg = document.createRange();
        rg.selectNodeContents(n);
        var r = rg.getBoundingClientRect();
        if (!r || r.width < 1) continue;
        found = true;
        if (r.left < L) L = r.left;
        if (r.top < T) T = r.top;
        if (r.right > R) R = r.right;
        if (r.bottom > B) B = r.bottom;
      }
      if (found) return { left: L, top: T, right: R, bottom: B, width: R - L };
    } catch (err) { /* fall through */ }
    return el.getBoundingClientRect();
  }

  /**
   * Where the arrow goes: just below the heading's left edge.
   *
   * Beside it was the guess, and the recording says otherwise. The reference
   * drops its shape under the start of the headline, in the gap above whatever
   * follows, which is space that is already empty. Beside a left aligned
   * heading there is only the gutter, so an arrow there is half off screen and
   * has to be clamped back over the text it is pointing at.
   */
  /**
   * Which way the arrow faces. It is drawn AT THE CURSOR, not near the heading.
   *
   * The cursor blob turns into the arrow. Placing a separate arrow beside the
   * heading was a misreading of the same picture: it put a second object on the
   * page and left the blob sitting somewhere else, so nothing pointed at
   * anything. There is one thing, it is the cursor, and its shape changes.
   */
  function aimAt(box, x, y) {
    var cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
    var dx = cx - x, dy = cy - y;
    /*
     * Inside the heading's own column, always point vertically.
     *
     * Comparing the two axes alone is right in the middle and wrong at the
     * edges: above the LEFT end of a wide headline the horizontal offset to its
     * centre can exceed the vertical one, so the cursor sat above the heading
     * and pointed sideways along it. Being within its columns means above or
     * below it, whatever the arithmetic to the centre says.
     */
    if (x >= box.left && x <= box.right) {
      return { name: dy > 0 ? "arrowD" : "arrowU", scale: ARROW_SCALE };
    }
    if (Math.abs(dx) >= Math.abs(dy)) return { name: dx > 0 ? "arrowR" : "arrowL", scale: ARROW_SCALE };
    return { name: dy > 0 ? "arrowD" : "arrowU", scale: ARROW_SCALE };
  }

  // ---- Pac-Man: released by a click, dismissed by moving the cursor --------
  var pacOn = false, px = 0, py = 0, dir = 1, pstart = 0, age = 0;

  function releasePacman(x, y) {
    pacOn = true;
    // Heads for the far side, so a click anywhere gives him room to run.
    dir = x < innerWidth / 2 ? 1 : -1;
    px = x / CELL;
    py = y / CELL;
    pstart = px;
    age = 0;
  }

  function pacman() {
    var rad = PAC_R;
    age++;
    px += dir * PAC_SPEED;
    if (px > cols + rad || px < -rad) {
      dir = Math.random() < 0.5 ? 1 : -1;
      py = 4 + Math.random() * Math.max(1, rows_ - 8);
      px = dir > 0 ? -rad : cols + rad;
      pstart = px; age = 0;
    }
    // Pellets on one grid row, each vanishing as the mouth reaches it.
    var pr = Math.round(py);
    for (var k = 1; k <= 90; k++) {
      var pxx = pstart + dir * PFOOD * k;
      if (pxx < -2 || pxx > cols + 2) continue;
      if (dir * (pxx - px) > rad * 0.7) {
        var pc = Math.round(pxx);
        if (pc >= 0 && pr >= 0 && pc < cols && pr < rows_) {
          var pid = pr * cols + pc;
          if (PAC_HEAT > heat[pid]) heat[pid] = PAC_HEAT;
        }
      }
    }
    var mouth = 0.05 + 0.6 * Math.abs(Math.sin(age * 0.16));
    var facing = dir > 0 ? 0 : Math.PI;
    var c0 = Math.max(0, (px - rad) | 0), c1 = Math.min(cols, px + rad + 1);
    var r0 = Math.max(0, (py - rad) | 0), r1 = Math.min(rows_, py + rad + 1);
    for (var r = r0; r < r1; r++) {
      for (var c = c0; c < c1; c++) {
        var dx = c - px, dy = r - py;
        if (dx * dx + dy * dy > rad * rad) continue;
        var a = Math.atan2(dy, dx) - facing;
        while (a > Math.PI) a -= Math.PI * 2;
        while (a < -Math.PI) a += Math.PI * 2;
        if (Math.abs(a) <= mouth) continue;
        var id = r * cols + c;
        if (PAC_HEAT > heat[id]) heat[id] = PAC_HEAT;
      }
    }
  }

  function frame() {
    t++;
    ctx.clearRect(0, 0, cv.width, cv.height);

    if (pacOn && document.visibilityState === "visible") pacman();
    // Hold a stamped shape at full heat so it can be read, then let it melt.
    if (held && performance.now() < held.until) stamp(held.name, held.x, held.y);
    else held = null;
    // Keep the arrow on the heading while the cursor is still near it.
    if (aimed && mx >= 0) stamp(aimed.name, mx, my, aimed.scale);


    if (t % AMB_EVERY === 0) measureAmbient();

    var alive = false;
    var floor = BANDS[0][0];
    // Hard cooling while the cursor is a shape, so the shape is not drawn on
    // top of three half faded copies of itself.
    var decay = (aimed || held) ? SHAPE_DECAY : 0.965;
    for (var r = 0; r < rows_; r++) {
      /*
       * The cloud's own heat for this row, before the cursor's is mixed in.
       *
       * Faded to nothing at both edges of the band, so it dissolves into the
       * page rather than ending on a straight line, and floored so that only
       * the crests light up. Without the floor it is a wash of colour across
       * the whole band instead of clouds with gaps between them.
       */
      /*
       * A rising horizon, not a symmetric band.
       *
       * Fading at both edges centred the cloud and left the bottom of the hero
       * as empty as its top, which was the thing being fixed. Density climbs
       * from nothing at the band's head to full at its foot, so it reads as
       * ground the headline stands on, and the last rows ease off so it meets
       * the rule below rather than being cut by it.
       */
      var rowFade = ambOn ? bandFade(r) : 0;

      for (var c = 0; c < cols; c++) {
        var i = r * cols + c;
        var amb = 0;
        if (rowFade > 0) {
          var raw = ambientAt(c, r, t);
          amb = ((raw - AMB_FLOOR) / (1 - AMB_FLOOR)) * rowFade * AMB_STRENGTH;
          if (amb < 0) amb = 0;
        }
        var h = heat[i];
        if (amb > h) h = amb;
        if (h > 0) {
          // Noise on the value used to pick a band, so edges shimmer rather
          // than showing up as contour lines.
          var v = h + 0.035 * Math.sin(c * 0.7 + r * 0.7 - t * 0.02);
          var colour = null;
          for (var b = 0; b < BANDS.length; b++) if (v >= BANDS[b][0]) colour = BANDS[b][1];
          if (colour) {
            // Dither the fringe: the coldest sliver draws sparsely, which is
            // what makes the edge read as pixels instead of a circle.
            var draw = true;
            if (v < floor + DITHER) draw = hash(c, r) < (v - floor) / DITHER;
            if (draw) {
              ctx.fillStyle = colour;
              ctx.fillRect(c * CELL, r * CELL, CELL - 1, CELL - 1);
            }
          }
          // Only the CURSOR's heat decays. The cloud is recomputed every frame
          // from the clock, so cooling it would fight the thing that draws it.
          var n = heat[i] * decay;
          heat[i] = n < 0.02 ? 0 : n;
          if (heat[i] > 0) alive = true;
        }
      }
    }
    /*
     * Keep running while Pac-Man is out, even once the field is cold.
     *
     * He is the only thing that draws without the cursor, so tying the loop
     * purely to leftover heat stopped it under him. Moving the cursor clears
     * pacOn, the field cools, and the loop ends on its own: a click cannot
     * leave an animation running forever on the visitor's machine.
     */
    var visible = document.visibilityState === "visible";
    // The cloud keeps the loop going while the band is on screen, and only
    // while it is: scrolled past, or in a background tab, this stops entirely.
    if (alive || ((pacOn || held || aimed || ambOn) && visible)) {
      requestAnimationFrame(frame);
      return;
    }

    running = false;
    /*
     * Hand off to a timer so the idle shapes can arrive.
     *
     * V93: the field goes cold about 1.5s after the last movement and the loop
     * ends there, which is BEFORE the idle threshold. An idle check that only
     * runs inside the loop is unreachable, not broken, and nothing errors while
     * it never happens. So the exit schedules the wake rather than assuming
     * something else will. Armed only while the tab is visible.
     */
    if (visible) armIdle();
  }

  function wake() { if (!running) { running = true; requestAnimationFrame(frame); } }

  // ---- Idle: the blob turns into a small drawing, every few seconds --------
  var idleTimer = 0;
  function armIdle() {
    clearTimeout(idleTimer);
    var wait = Math.max(120, IDLE_MS - (performance.now() - lastMove));
    idleTimer = setTimeout(function () {
      if (document.visibilityState !== "visible") return;
      // The blob BECOMES the shape, so with no pointer on the page there is no
      // blob to become one. Without this a starburst appeared in the middle of
      // the viewport of a page nobody had touched.
      if (mx < 0) { armIdle(); return; }
      if (performance.now() - lastMove < IDLE_MS) { armIdle(); return; }
      // At the cursor: the blob becomes the shape, it does not spawn one nearby.
      // Clamped only so a shape resting near an edge is not half off screen.
      var x = Math.min(innerWidth - 100, Math.max(100, mx));
      var y = Math.min(innerHeight - 100, Math.max(100, my));
      held = { name: randomSprite(), x: x, y: y, until: performance.now() + HOLD };
      stamp(held.name, x, y);
      wake();
      idleTimer = setTimeout(armIdle, IDLE_EVERY_MS);
    }, wait);
  }

  /**
   * Recompute what the cursor is near, from wherever it currently is.
   *
   * Called on move AND on scroll. Only recomputing it on move meant the shape
   * was pinned to a heading position that had since moved: scrolling a heading
   * out from under a stationary cursor left it an arrow, pointing at whatever
   * happened to be there now, until the visitor moved the mouse. Anything
   * derived from an element's position on screen has two inputs, and scroll is
   * the one that is easy to forget because nothing about it looks like input.
   */
  function reaim() {
    if (mx < 0) { aimed = null; return; }
    var box = nearestHeading(mx, my);
    aimed = box ? aimAt(box, mx, my) : null;
  }

  addEventListener("scroll", function () {
    // Scrolling is activity: it cancels Pac-Man and a held shape the same way
    // moving the cursor does, and it re-checks what the cursor is now next to.
    var hadShape = !!(aimed || held);
    lastMove = performance.now();
    pacOn = false;
    held = null;
    reaim();
    /*
     * When a shape stops being a shape, replace it rather than letting it fade.
     *
     * Clearing aimed is not enough on its own. The arrow's heat is still in the
     * field and decays over a second or two, and nothing redraws at the cursor
     * until the visitor moves it, so what they saw was an arrow slowly
     * dissolving where a blob should be. The shape goes at once and the cursor
     * gets its blob back in the same frame.
     */
    if (hadShape && !aimed) {
      heat.fill(0);
      if (mx >= 0) add(mx / CELL, my / CELL, RADIUS, 0.42);
    }
    wake();
  }, { passive: true });

  addEventListener("resize", function () { reaim(); wake(); });

  addEventListener("pointermove", function (e) {
    var ox = mx, oy = my;
    mx = e.clientX; my = e.clientY;
    lastMove = performance.now();
    pacOn = false;
    held = null;
    reaim();
    // Interpolate between the last point and this one. A fast sweep fires few
    // pointermove events, so depositing only at the endpoints draws a dotted
    // line instead of a trail. The reference does the same thing.
    // No round brush while the blob is a shape: the blob is the shape, and
    // drawing both leaves an arrow sitting in a smudge.
    if (!aimed) {
      if (ox >= 0) {
        var dx = mx - ox, dy = my - oy;
        var steps = Math.min(12, Math.max(1, Math.round(Math.hypot(dx, dy) / CELL)));
        for (var s2 = 1; s2 <= steps; s2++) {
          add((ox + dx * s2 / steps) / CELL, (oy + dy * s2 / steps) / CELL, RADIUS, 0.42 / steps * 1.8);
        }
      } else {
        add(mx / CELL, my / CELL, RADIUS, 0.42);
      }
    }
    wake();
  }, { passive: true });

  // A click detonates and releases Pac-Man from the point of the blast. The
  // detonation is the only place the neon band shows up on its own.
  addEventListener("pointerdown", function (e) {
    lastMove = performance.now();
    add(e.clientX / CELL, e.clientY / CELL, RADIUS * 4, 0.95);
    releasePacman(e.clientX, e.clientY);
    wake();
  }, { passive: true });

  /*
   * Pixelate the SCREENSHOT under the cursor.
   *
   * The first version drew a coloured outline round it, which is not what the
   * reference does and, on a card that already has a CSS border, just restated
   * that border in a brighter colour. The image itself resolves down into
   * blocks and back, which is the same idea as the rest of the page: the
   * picture is made of the cells everything else is made of.
   *
   * A canvas over the image, not a CSS filter, because CSS can only pixelate an
   * image it is scaling UP and these are scaled to fit.
   *
   * pointerover, not mouseenter, because a card contains a screenshot, a
   * heading and a button, and a listener per card is a leak on a page that
   * rewrites card bodies in place after a launch. One delegated listener asks
   * closest() instead, so hovering anywhere on the card pixelates its image.
   */
  var pxCanvas = null, pxRaf = 0, pxLevel = 0, pxDir = 1, pxHold = 0;

  function cleanupPixelate() {
    if (pxCanvas && pxCanvas.parentNode) pxCanvas.parentNode.removeChild(pxCanvas);
    pxCanvas = null; pxLevel = 0; traced = null;
  }

  function pxStep() {
    pxRaf = 0;
    if (!traced || !pxCanvas) return;
    var img = traced;
    var w = img.clientWidth, h = img.clientHeight;
    if (!w || !h || !img.naturalWidth) { cleanupPixelate(); return; }
    // Sit on the blocky frame for a moment before resolving, so the first
    // thing the eye lands on is the pixels rather than the tail of a fade.
    if (pxHold > 0) pxHold--;
    else pxLevel = Math.max(0, Math.min(1, pxLevel + pxDir * PX_STEP));
    if (pxCanvas.width !== w) pxCanvas.width = w;
    if (pxCanvas.height !== h) pxCanvas.height = h;
    var g = pxCanvas.getContext("2d");
    // Down to a small buffer, then back up with smoothing off. The block size
    // eases in, so it steps down rather than snapping to chunky in one frame.
    // About 46 blocks across at the chunkiest. At w/41 the screenshot went to
    // roughly twelve blocks and stopped being a screenshot: the card's whole
    // claim is that the picture is a real instance, so it has to stay readable.
    var small = Math.max(8, Math.round(w / (1 + pxLevel * 10)));
    var smallH = Math.max(2, Math.round(small * h / w));
    g.clearRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    g.drawImage(img, 0, 0, small, smallH);
    g.imageSmoothingEnabled = false;
    g.drawImage(pxCanvas, 0, 0, small, smallH, 0, 0, w, h);
    if (pxDir > 0 ? pxLevel < 1 : pxLevel > 0) pxRaf = requestAnimationFrame(pxStep);
    else if (pxDir < 0) cleanupPixelate();
  }

  /**
   * Hovering RESOLVES the image: it starts blocky and sharpens, once.
   *
   * Holding it pixelated while the cursor sits there hides the screenshot, and
   * the screenshot is the card's entire evidence that the instance is real. So
   * the animation runs the other way: the picture arrives, which is also what
   * the product does. The overlay removes itself at the end, so nothing is left
   * covering the image.
   */
  function startPixelate(img) {
    if (!img || img.tagName !== "IMG" || !img.complete || !img.naturalWidth) return;
    cleanupPixelate();
    traced = img;
    pxCanvas = document.createElement("canvas");
    pxCanvas.className = "pixshot";
    if (img.parentNode) img.parentNode.insertBefore(pxCanvas, img.nextSibling);
    pxLevel = 1; pxDir = -1; pxHold = PX_HOLD;
    if (!pxRaf) pxRaf = requestAnimationFrame(pxStep);
  }

  /**
   * Leaving early finishes the resolve rather than snapping it away.
   *
   * Cancelling it on pointerout would make a quick pass over a card flash and
   * vanish, which is the version that was reported as unnoticeable.
   */
  function stopPixelate() {
    if (!traced) return;
    pxDir = -1;
    pxHold = 0;
    if (!pxRaf) pxRaf = requestAnimationFrame(pxStep);
  }

  addEventListener("pointerover", function (e) {
    var card = e.target && e.target.closest ? e.target.closest("[data-app]") : null;
    var shot = card ? card.querySelector("img.shot") : null;
    if (shot && shot !== traced) startPixelate(shot);
    else if (!card && traced) stopPixelate();
  }, { passive: true });

  addEventListener("pointerleave", function () { mx = -1; my = -1; aimed = null; });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") pacOn = false;
  });
  lastMove = performance.now();
  measureAmbient();
  armIdle();
  wake();
})();
`;
