"""Regenerates icon.png, the home screen emblem.

A week grid with the class you are in right now lit up and a time marker
across it, which is the one idea the whole app is built around. Colours are
the app's own: crimson field, cream blocks, amber marker.

    python make_icon.py

Then run build.py to copy it into b/ and c/.
"""
from PIL import Image, ImageDraw, ImageFilter

S = 512           # shipped size
X = 4             # supersample factor
N = S * X

CRIMSON_TOP = (155, 28, 28)     # #9b1c1c
CRIMSON_BOT = (104, 14, 17)     # deeper, for the gradient
CREAM = (255, 248, 236)         # #fff8ec
AMBER = (240, 169, 59)          # #f0a93b


def px(v):
    """512-space coordinate to supersampled canvas."""
    return v * X


def background():
    """Vertical crimson gradient, drawn a row at a time."""
    img = Image.new('RGB', (N, N), CRIMSON_TOP)
    d = ImageDraw.Draw(img)
    for y in range(N):
        t = y / (N - 1)
        # ease so the top stays rich longer than a straight ramp
        t = t * t * (3 - 2 * t)
        d.line(
            [(0, y), (N, y)],
            fill=tuple(
                round(a + (b - a) * t)
                for a, b in zip(CRIMSON_TOP, CRIMSON_BOT)
            ),
        )
    return img


# Grid geometry in 512-space. Sized to fill the frame, since iOS masks the
# corners off anyway and a small mark just looks lost on a home screen.
LEFT, RIGHT = 78, 434
TOP, BOT = 116, 412
COLS = 5
GAP = 16
COLW = (RIGHT - LEFT - GAP * (COLS - 1)) / COLS
H = BOT - TOP
RADIUS = 17

# (column, start, end) as fractions of the grid height.
QUIET = [
    (0, 0.00, 0.30), (0, 0.42, 0.66),
    (1, 0.18, 0.52),
    (3, 0.06, 0.36), (3, 0.60, 0.88),
    (4, 0.24, 0.58),
]
NOW = (2, 0.30, 0.78)
MARKER_Y = TOP + 0.30 * H


def block_box(col, a, b, bleed=0):
    x0 = LEFT + col * (COLW + GAP)
    return [
        px(x0 - bleed), px(TOP + a * H - bleed),
        px(x0 + COLW + bleed), px(TOP + b * H + bleed),
    ]


def main():
    img = background().convert('RGBA')

    # Warm glow behind the live block, so it reads as lit rather than painted.
    glow = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle(
        block_box(*NOW, bleed=20), radius=px(RADIUS + 20),
        fill=AMBER + (120,),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(px(16)))
    img = Image.alpha_composite(img, glow)

    layer = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # The rest of the week, present but receded. Bright enough to still read
    # as a grid at 40px, where anything fainter turns to mud.
    for col, a, b in QUIET:
        d.rounded_rectangle(
            block_box(col, a, b), radius=px(RADIUS), fill=CREAM + (92,)
        )

    # Time marker, edge to edge, with a dot anchoring it on the left. Kept
    # deliberately thick; a hairline disappears at home screen size.
    my = px(MARKER_Y)
    d.rounded_rectangle(
        [px(LEFT - 24), my - px(4), px(RIGHT + 14), my + px(4)],
        radius=px(4), fill=AMBER + (240,),
    )
    d.ellipse(
        [px(LEFT - 36), my - px(11), px(LEFT - 14), my + px(11)], fill=AMBER
    )

    # Now.
    d.rounded_rectangle(block_box(*NOW), radius=px(RADIUS), fill=CREAM)

    img = Image.alpha_composite(img, layer)
    img.convert('RGB').resize((S, S), Image.LANCZOS).save(
        'icon.png', optimize=True
    )
    print('wrote icon.png')


if __name__ == '__main__':
    main()
