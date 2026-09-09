# The figures in the README

Six SVGs, drawn from a 5x7 bitmap font and a run-length rect emitter, so there
is no `<text>` element and no font dependency. GitHub renders them without
loading anything, and they look the same on every machine.

Each one has an explicit white background, so they read correctly on GitHub's
dark theme as well as its light one. No `prefers-color-scheme` swap needed.

| File | Where it sits | What it claims |
|------|---------------|----------------|
| `hero.svg` | Top of the README | Nothing measurable. It is the name and the promise. |
| `breakdown.svg` | Under the opening | 5.5 s to the browser, split 3.6 / 0.3 / 1.3 with 0.3 s of rounding drawn rather than dropped. Matches `docs/04-frontend-spec.md`. |
| `flow.svg` | How a launch works | Fork, health, URL, ten minutes, gone. One sandbox each. |
| `apps.svg` | The catalog | The five apps and what is seeded in each. |
| `lifetime.svg` | Ten minutes | The lifetime, and that it ends by itself. |
| `receipt.svg` | Status, beside the cost | 1 vCPU / 2 GB for 0.1667 hours at $0.057 per hour is $0.0095. |

The rounding block in `breakdown.svg` is drawn in grey rather than left out.
Four measured parts summing to 5.2 under a headline of 5.5 is the kind of small
dishonesty that this project spent a week finding in itself.

## Regenerating

`build.py` writes all six from `pix.py` (the font and the rect emitter) and
`terrain.py` (the landscape under the hero). The terrain is seeded, so
rebuilding does not reshuffle the artwork.

```
python3 build.py
```

`write()` refuses to emit a figure whose content runs past the canvas edge,
because a caption sliding off the right-hand side is the kind of thing that
renders fine locally and looks broken in the README. It caught three overflows
while these were being drawn.

## Palette

Taken from the site, not invented alongside it.

| | |
|---|---|
| ink | `#151515` |
| blue | `#4460E0` |
| yellow | `#F5B72B` |
| red | `#E4432C` |
| lime | `#DDEE33` |
| paper | `#FFFFFF` |
