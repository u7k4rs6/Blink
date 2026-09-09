"""Pixel-grid SVG generator for the Blink README.

Everything is drawn on an integer cell grid and emitted as merged <rect> runs,
so the output is genuinely pixelated rather than a smooth vector pretending.
"""

PALETTE = {
    "ink":   "#151515",
    "blue":  "#4460E0",
    "yellow": "#F5B72B",
    "red":   "#E4432C",
    "lime":  "#DDEE33",
    "paper": "#FFFFFF",
    "grid":  "#EDEDED",
    "mute":  "#9A9A9A",
    "faint": "#D8D8D8",
}

FONT = {
    "A": "01110 10001 10001 11111 10001 10001 10001",
    "B": "11110 10001 10001 11110 10001 10001 11110",
    "C": "01110 10001 10000 10000 10000 10001 01110",
    "D": "11110 10001 10001 10001 10001 10001 11110",
    "E": "11111 10000 10000 11110 10000 10000 11111",
    "F": "11111 10000 10000 11110 10000 10000 10000",
    "G": "01110 10001 10000 10111 10001 10001 01111",
    "H": "10001 10001 10001 11111 10001 10001 10001",
    "I": "11111 00100 00100 00100 00100 00100 11111",
    "J": "00111 00010 00010 00010 00010 10010 01100",
    "K": "10001 10010 10100 11000 10100 10010 10001",
    "L": "10000 10000 10000 10000 10000 10000 11111",
    "M": "10001 11011 10101 10101 10001 10001 10001",
    "N": "10001 11001 10101 10011 10001 10001 10001",
    "O": "01110 10001 10001 10001 10001 10001 01110",
    "P": "11110 10001 10001 11110 10000 10000 10000",
    "Q": "01110 10001 10001 10001 10101 10010 01101",
    "R": "11110 10001 10001 11110 10100 10010 10001",
    "S": "01111 10000 10000 01110 00001 00001 11110",
    "T": "11111 00100 00100 00100 00100 00100 00100",
    "U": "10001 10001 10001 10001 10001 10001 01110",
    "V": "10001 10001 10001 10001 10001 01010 00100",
    "W": "10001 10001 10001 10101 10101 11011 10001",
    "X": "10001 10001 01010 00100 01010 10001 10001",
    "Y": "10001 10001 01010 00100 00100 00100 00100",
    "Z": "11111 00001 00010 00100 01000 10000 11111",
    "0": "01110 10001 10011 10101 11001 10001 01110",
    "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111",
    "3": "11111 00010 00100 00010 00001 10001 01110",
    "4": "00010 00110 01010 10010 11111 00010 00010",
    "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110",
    "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110",
    "9": "01110 10001 10001 01111 00001 00010 01100",
    ".": "00000 00000 00000 00000 00000 01100 01100",
    ",": "00000 00000 00000 00000 01100 01100 01000",
    ":": "00000 01100 01100 00000 01100 01100 00000",
    "-": "00000 00000 00000 11111 00000 00000 00000",
    "+": "00000 00100 00100 11111 00100 00100 00000",
    "/": "00001 00010 00010 00100 01000 01000 10000",
    "$": "00100 01111 10100 01110 00101 11110 00100",
    "%": "11001 11011 00010 00100 01000 11011 10011",
    "!": "00100 00100 00100 00100 00100 00000 00100",
    "?": "01110 10001 00001 00010 00100 00000 00100",
    "(": "00010 00100 01000 01000 01000 00100 00010",
    ")": "01000 00100 00010 00010 00010 00100 01000",
    "=": "00000 00000 11111 00000 11111 00000 00000",
    "'": "00100 00100 00000 00000 00000 00000 00000",
    "*": "00000 10101 01110 11111 01110 10101 00000",
    " ": "00000 00000 00000 00000 00000 00000 00000",
}

FW, FH = 5, 7


class Grid:
    """Sparse integer cell grid holding colour keys."""

    def __init__(self):
        self.cells = {}

    def set(self, x, y, colour):
        if colour is not None:
            self.cells[(int(x), int(y))] = colour

    def rect(self, x, y, w, h, colour):
        for j in range(h):
            for i in range(w):
                self.set(x + i, y + j, colour)

    def frame(self, x, y, w, h, colour, t=1):
        self.rect(x, y, w, t, colour)
        self.rect(x, y + h - t, w, t, colour)
        self.rect(x, y, t, h, colour)
        self.rect(x + w - t, y, t, h, colour)

    def text(self, s, x, y, colour, scale=1, spacing=1):
        cx = x
        for ch in s.upper():
            glyph = FONT.get(ch)
            if glyph is None:
                glyph = FONT[" "]
            rows = glyph.split()
            for ry, row in enumerate(rows):
                for rxi, bit in enumerate(row):
                    if bit == "1":
                        for sy in range(scale):
                            for sx in range(scale):
                                self.set(cx + rxi * scale + sx,
                                         y + ry * scale + sy, colour)
            cx += (FW + spacing) * scale
        return cx - x - spacing * scale

    def text_width(self, s, scale=1, spacing=1):
        if not s:
            return 0
        return len(s) * (FW + spacing) * scale - spacing * scale

    def text_center(self, s, x, y, w, colour, scale=1, spacing=1):
        tw = self.text_width(s, scale, spacing)
        self.text(s, x + (w - tw) // 2, y, colour, scale, spacing)


def emit(grid, cell, width_cells, height_cells, bg="paper",
         grid_lines=None, extra=""):
    """Merge horizontal runs of identical colour into single rects."""
    W = width_cells * cell
    H = height_cells * cell
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
        f'viewBox="0 0 {W} {H}" shape-rendering="crispEdges" '
        f'role="img">'
    ]
    parts.append(f'<rect width="{W}" height="{H}" fill="{PALETTE[bg]}"/>')

    if grid_lines:
        step = grid_lines * cell
        g = []
        for gx in range(0, W + 1, step):
            g.append(f'M{gx} 0V{H}')
        for gy in range(0, H + 1, step):
            g.append(f'M0 {gy}H{W}')
        parts.append(
            f'<path d="{"".join(g)}" stroke="{PALETTE["grid"]}" '
            f'stroke-width="1" fill="none"/>'
        )

    by_colour = {}
    ys = sorted({y for (_, y) in grid.cells})
    for y in ys:
        row = sorted((x for (x, yy) in grid.cells if yy == y))
        if not row:
            continue
        run_start = row[0]
        prev = row[0]
        colour = grid.cells[(row[0], y)]
        for x in row[1:]:
            c = grid.cells[(x, y)]
            if x == prev + 1 and c == colour:
                prev = x
                continue
            by_colour.setdefault(colour, []).append(
                (run_start, y, prev - run_start + 1))
            run_start, prev, colour = x, x, c
        by_colour.setdefault(colour, []).append(
            (run_start, y, prev - run_start + 1))

    for colour, runs in by_colour.items():
        d = []
        for (x, y, w) in runs:
            d.append(f'M{x*cell} {y*cell}h{w*cell}v{cell}h{-w*cell}z')
        parts.append(
            f'<path d="{"".join(d)}" fill="{PALETTE[colour]}"/>'
        )

    if extra:
        parts.append(extra)
    parts.append("</svg>")
    return "".join(parts)


def preview(grid, cell, width_cells, height_cells, path, bg="paper", scale=1):
    from PIL import Image
    img = Image.new("RGB", (width_cells * cell * scale,
                            height_cells * cell * scale),
                    PALETTE[bg])
    px = img.load()
    for (x, y), colour in grid.cells.items():
        hexv = PALETTE[colour].lstrip("#")
        rgb = tuple(int(hexv[i:i+2], 16) for i in (0, 2, 4))
        for j in range(cell * scale):
            for i in range(cell * scale):
                X, Y = x * cell * scale + i, y * cell * scale + j
                if 0 <= X < img.width and 0 <= Y < img.height:
                    px[X, Y] = rgb
    img.save(path)
    return path
