import os
from pix import Grid, emit, preview
from terrain import terrain

OUT = "/mnt/user-data/outputs/blink-art"
os.makedirs(OUT, exist_ok=True)
CELL = 5


def write(name, g, cols, rows, grid_lines=None):
    # a figure whose text runs off the edge must fail loudly, not ship
    if g.cells:
        mx = max(x for (x, _) in g.cells)
        my = max(y for (_, y) in g.cells)
        if mx >= cols or my >= rows:
            raise SystemExit(
                f"{name}: content overflows canvas "
                f"(x={mx}/{cols-1}, y={my}/{rows-1})")
    svg = emit(g, CELL, cols, rows, grid_lines=grid_lines)
    with open(f"{OUT}/{name}.svg", "w") as f:
        f.write(svg)
    preview(g, CELL, cols, rows, f"/home/claude/prev_{name}.png")
    return len(svg)


# ---------------------------------------------------------------- hero
def hero():
    COLS, ROWS = 256, 104
    g = Grid()
    g.text_center("BLINK", 0, 8, COLS, "ink", scale=5)
    g.text_center("PRESS LAUNCH.  GET A REAL MACHINE.", 0, 50, COLS, "mute",
                  scale=1)
    terrain(g, 0, 58, COLS, 46, seed=7)
    return write("hero", g, COLS, ROWS)


# ------------------------------------------------------- the breakdown
def legend_row(g, y, colour, big, rest):
    g.rect(12, y, 6, 6, colour)
    g.text(big, 22, y, colour, scale=1)
    g.text(rest, 52, y, "mute", scale=1)


def breakdown():
    COLS, ROWS = 240, 112
    g = Grid()
    g.text("5.5 SECONDS", 12, 8, "ink", scale=3)
    g.text("TO YOUR BROWSER. ONE BLOCK = 100MS.", 12, 32, "mute", scale=1)

    x, y = 12, 46
    for count, colour in ((36, "blue"), (3, "red"), (13, "yellow"),
                          (3, "faint")):
        for _ in range(count):
            g.rect(x, y, 3, 16, colour)
            x += 4

    legend_row(g, 70, "blue", "3.6S", "WAKING A PRIVATE MACHINE")
    legend_row(g, 80, "red", "0.3S", "THE APP STARTING INSIDE IT")
    legend_row(g, 90, "yellow", "1.3S", "YOUR BROWSER FETCHING PAGE ONE")
    legend_row(g, 100, "faint", "0.3S", "ROUNDING. DRAWN, NOT DROPPED.")
    return write("breakdown", g, COLS, ROWS)


# ------------------------------------------------------------ the flow
def flow():
    COLS, ROWS = 240, 72
    g = Grid()
    g.text("PRESS LAUNCH", 12, 8, "ink", scale=2)
    g.text("FOUR THINGS HAPPEN BEFORE YOU SEE IT.",
           12, 24, "mute", scale=1)

    stages = [("FORK", "blue"), ("HEALTH", "blue"), ("URL", "yellow"),
              ("10 MIN", "red"), ("GONE", "ink")]
    x = 12
    for i, (label, colour) in enumerate(stages):
        g.frame(x, 36, 36, 20, colour, t=2)
        g.rect(x + 2, 38, 32, 5, colour)
        g.text_center(label, x, 46, 36, "ink", scale=1)
        x += 36
        if i < len(stages) - 1:
            g.rect(x + 1, 45, 6, 2, "ink")
            g.rect(x + 6, 44, 2, 4, "ink")
            x += 9

    g.text("ONE SANDBOX EACH. NOBODY SHARES ONE.", 12, 62, "mute", scale=1)
    return write("flow", g, COLS, ROWS)


# ------------------------------------------------------------ the apps
ICONS = {
    "gitea": [
        "0000110000000000",
        "0001111000000000",
        "0000110000000000",
        "0000110000000000",
        "0000111111100000",
        "0000110000110000",
        "0000110000110000",
        "0000110000110000",
        "0000110000110000",
        "0011110000111100",
        "0111110000111110",
        "0111110000111110",
        "0011110000111100",
        "0000110000000000",
        "0000000000000000",
        "0000000000000000",
    ],
    "jaeger": [
        "0000000000000000",
        "0111111110000000",
        "0111111110000000",
        "0000000000000000",
        "0001111111111000",
        "0001111111111000",
        "0000000000000000",
        "0000011111100000",
        "0000011111100000",
        "0000000000000000",
        "0000111111111110",
        "0000111111111110",
        "0000000000000000",
        "0011111100000000",
        "0011111100000000",
        "0000000000000000",
    ],
    "excalidraw": [
        "0000000000011000",
        "0000000000111100",
        "0000000001111000",
        "0000000011110000",
        "0000000111100000",
        "0000001111000000",
        "0000011110000000",
        "0000111100000000",
        "0001111000000000",
        "0011110000000000",
        "0111100000000000",
        "0111000000000000",
        "0110000000000000",
        "0100000000000000",
        "0000000000000000",
        "0000000000000000",
    ],
    "uptime": [
        "0000000000000000",
        "0000000000000000",
        "0000000110000000",
        "0000000110000000",
        "0000000110000000",
        "1111000110000000",
        "0001000110001111",
        "0001100110011000",
        "0000100110010000",
        "0000110010110000",
        "0000011001100000",
        "0000001111000000",
        "0000000110000000",
        "0000000000000000",
        "0000000000000000",
        "0000000000000000",
    ],
    "metabase": [
        "0000000000000000",
        "0000000000011000",
        "0000000000011000",
        "0000011000011000",
        "0000011000011000",
        "0000011000011000",
        "0011011000011000",
        "0011011000011000",
        "0011011000011000",
        "0011011001111000",
        "0011011001111000",
        "0011011001111000",
        "0011011001111000",
        "1111111111111111",
        "0000000000000000",
        "0000000000000000",
    ],
}


def blit(g, art, x, y, colour, scale=1):
    for ry, row in enumerate(art):
        for rx, bit in enumerate(row):
            if bit == "1":
                for sy in range(scale):
                    for sx in range(scale):
                        g.set(x + rx * scale + sx, y + ry * scale + sy, colour)


def apps():
    COLS, ROWS = 240, 142
    g = Grid()
    g.text("FIVE APPS", 12, 8, "ink", scale=2)
    g.text("ALREADY SEEDED. SOMETHING TO LOOK AT.",
           12, 24, "mute", scale=1)

    items = [
        ("gitea", "GITEA", "REPO, 3 ISSUES, 1 PR", "blue"),
        ("jaeger", "JAEGER", "TRACES, ALREADY THERE", "yellow"),
        ("excalidraw", "EXCALIDRAW", "A BOARD WITH SHAPES", "red"),
        ("uptime", "UPTIME KUMA", "MONITORS, REAL BEATS", "blue"),
        ("metabase", "METABASE", "SAMPLE DB, REAL ROWS", "yellow"),
    ]
    y = 38
    for i, (key, name, desc, colour) in enumerate(items):
        blit(g, ICONS[key], 12, y, colour, scale=1)
        g.text(name, 34, y + 4, "ink", scale=1)
        g.text(desc, 108, y + 4, "mute", scale=1)
        if i < len(items) - 1:
            g.rect(12, y + 16, 216, 1, "faint")
        y += 18

    g.text("YOURS ALONE. NOBODY ELSE HAS USED IT.",
           12, 130, "mute", scale=1)
    return write("apps", g, COLS, ROWS)


# -------------------------------------------------------- the lifetime
def lifetime():
    COLS, ROWS = 240, 62
    g = Grid()
    g.text("TEN MINUTES", 12, 8, "ink", scale=2)
    g.text("THEN IT DESTROYS ITSELF, ALWAYS.",
           12, 24, "mute", scale=1)

    # 60 blocks, one per ten seconds
    for i in range(60):
        colour = "blue" if i < 48 else ("yellow" if i < 57 else "red")
        g.rect(12 + i * 3, 34, 2, 12, colour)

    for tick in (0, 48, 60):
        g.rect(12 + tick * 3, 48, 1, 3, "faint")
    g.text("0:00", 12, 52, "mute", scale=1)
    g.text("10:00", 163, 52, "mute", scale=1)
    return write("lifetime", g, COLS, ROWS)


# --------------------------------------------------------- the receipt
def receipt():
    COLS, ROWS = 160, 68
    g = Grid()
    g.frame(4, 4, 152, 60, "ink", t=1)
    g.rect(4, 4, 152, 10, "ink")
    g.text("SESSION RECEIPT", 10, 6, "paper", scale=1)

    g.text("SANDBOX 1 VCPU / 2 GB", 10, 20, "ink", scale=1)
    g.text("10M 00S = 0.1667 HOURS", 10, 30, "mute", scale=1)
    g.text("X $0.057 PER HOUR", 10, 40, "mute", scale=1)
    g.rect(10, 50, 140, 1, "faint")
    g.text("TOTAL", 10, 55, "ink", scale=1)
    g.text("$0.0095", 106, 55, "red", scale=1)
    return write("receipt", g, COLS, ROWS)


if __name__ == "__main__":
    for fn in (hero, breakdown, flow, apps, lifetime, receipt):
        size = fn()
        print(f"{fn.__name__:12} {size/1024:6.1f} KB")
