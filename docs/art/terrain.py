import math
import random


def terrain(grid, x0, y0, cols, rows, seed=7, crest=True):
    """The landscape band.

    Each colour boundary is its own wave with its own phase, so the hot cores
    read as blobs sitting inside the mass rather than as geological strata.
    Deterministic per seed.
    """
    rnd = random.Random(seed)
    s = seed * 0.37

    def crest_y(x):
        w = (math.sin(x * 0.055 + 0.4 + s) * 1.00
             + math.sin(x * 0.127 + 1.9 + s) * 0.40
             + math.sin(x * 0.026 + 3.1 + s) * 0.80
             + math.sin(x * 0.223 + 0.7) * 0.18)
        return rows * 0.34 - w * rows * 0.22

    def band_h(x, base, amp, f1, ph1, f2, ph2):
        """Height of a band above the baseline; <=0 means absent here."""
        w = math.sin(x * f1 + ph1 + s) + 0.55 * math.sin(x * f2 + ph2 + s)
        return rows * base + w * rows * amp

    for cx in range(cols):
        top = int(crest_y(cx))
        top = max(0, min(rows - 3, top))

        # anchored to the baseline: blue is the mass, lime is rare
        y_yellow = rows - band_h(cx, 0.30, 0.17, 0.037, 2.4, 0.089, 0.9)
        y_red = rows - band_h(cx, 0.115, 0.105, 0.045, 5.1, 0.101, 2.7)
        y_lime = rows - band_h(cx, 0.028, 0.062, 0.052, 1.2, 0.118, 4.4)

        for cy in range(top, rows):
            depth = cy - top

            if crest and depth < 6:
                # spiky, sparse at the tip and solidifying downward
                p = ((depth + 1) / 6.5) ** 1.35
                if rnd.random() > p:
                    continue
                grid.set(x0 + cx, y0 + cy, "ink")
                continue

            if cy >= y_lime:
                colour = "lime"
            elif cy >= y_red:
                colour = "red"
            elif cy >= y_yellow:
                colour = "yellow"
            else:
                colour = "blue"

            # flecks of ink drifting down out of the crest
            if colour == "blue" and depth < 11 and rnd.random() < 0.085:
                colour = "ink"

            grid.set(x0 + cx, y0 + cy, colour)
