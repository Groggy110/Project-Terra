#!/usr/bin/env python3
"""Builds every icon, launch image and link-preview card from the logo.

  public/favicon-*.png           the browser tab: the star over the rim only
  public/icon-*.png              home screen icons, opaque
  public/icon-maskable-512.png   Android's circular crop
  public/og-image.png            the card a shared link unfolds into
  public/splash/*.png            iOS launch images, one per device size

The logo (tools/brand/terra-logo.png) is white and light-blue light on
nothing, so everything here is set on the site's own night sky.

Two things iOS gets wrong if you let it:

  * A transparent icon is composited onto black, not onto the wallpaper — so
    the icons here are filled squares. iOS applies its own rounded mask, which
    is why the art is inset rather than bleeding to the edge.

  * With no launch image it flashes white before the page paints. On a page
    whose whole subject is a night sky that reads as a bug, so every size the
    current iPhones report is generated, on the same near-black the dark theme
    uses. iOS matches them by media query and is fussy: the query has to name
    the exact CSS width, height, pixel ratio and orientation, and a device with
    no match falls back to the white flash.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public"
SPLASH = PUB / "splash"

# --paper in the dark theme. The launch image has to agree with the first
# painted frame or the handover flickers.
IyNK = (0, 2, 6)

logo = Image.open(ROOT / "tools" / "brand" / "terra-logo.png").convert("RGBA")
# The star over the rim, without the word: at tab size the letters would be
# a smudge. The word starts just under row 462 of the logo.
mark = logo.crop((0, 0, logo.width, 462))
mark = mark.crop(mark.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox())


def sky(w: int, h: int) -> Image.Image:
    """The page's ground: deep navy at the top falling to black."""
    top, bottom = (0, 26, 56), (0, 0, 0)
    col = Image.new("RGB", (1, h))
    for y in range(h):
        k = (y / max(h - 1, 1)) ** 0.9
        col.putpixel((0, y), tuple(round(a + (b - a) * k) for a, b in zip(top, bottom)))
    return col.resize((w, h))


def place(canvas: Image.Image, art: Image.Image, width: float, dy: float = 0.0):
    """Pastes `art` centred, `width` of the canvas wide, nudged by `dy` of its height."""
    a = art.copy()
    w = round(canvas.width * width)
    a = a.resize((w, round(a.height * w / a.width)), Image.LANCZOS)
    canvas.paste(a, ((canvas.width - a.width) // 2, (canvas.height - a.height) // 2 + round(canvas.height * dy)), a)


def icon(size: int, width: float, out: Path):
    canvas = sky(size, size)
    place(canvas, logo, width)
    canvas.save(out, optimize=True)


for s in (180, 192, 256, 512, 1024):
    icon(s, 0.84, PUB / f"icon-{s}.png")
# Android masks to a circle: the art keeps inside its safe zone.
icon(512, 0.66, PUB / "icon-maskable-512.png")

for s in (32, 64):
    fav = sky(s, s)
    place(fav, mark, 0.92, 0.04)
    # Rounded, as a tab icon on a light tab bar should not be a hard black square.
    m = Image.new("L", (s * 4, s * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, s * 4 - 1, s * 4 - 1), radius=s * 4 // 5, fill=255)
    fav.putalpha(m.resize((s, s), Image.LANCZOS))
    fav.save(PUB / f"favicon-{s}.png", optimize=True)
print("  icons            written")

# The link card: 1200 x 630, the size every unfurler crops to.
og = sky(1200, 630)
stars = Image.open(PUB / "textures" / "stardust.png").convert("RGBA")
dust = Image.new("RGBA", og.size, (0, 0, 0, 0))
for x in range(0, og.width, stars.width):
    for y in range(0, og.height, stars.height):
        dust.paste(stars, (x, y))
dust.putalpha(dust.getchannel("A").point(lambda v: v * 0.55))
og = Image.alpha_composite(og.convert("RGBA"), dust)
place(og, logo, 0.5, -0.02)
og.convert("RGB").save(PUB / "og-image.png", optimize=True)
print("  link card        public/og-image.png")

# (css width, css height, device pixel ratio) for every current iPhone, and the
# older sizes that are still in circulation.
DEVICES = [
    (440, 956, 3),   # 16 Pro Max
    (430, 932, 3),   # 15/16 Plus, 14 Pro Max
    (402, 874, 3),   # 16 Pro
    (393, 852, 3),   # 14 Pro, 15, 16
    (390, 844, 3),   # 12, 13, 14
    (375, 812, 3),   # 12/13 mini, X, XS
    (414, 896, 3),   # XS Max, 11 Pro Max
    (414, 896, 2),   # XR, 11
    (375, 667, 2),   # SE 2/3
    (834, 1194, 2),  # iPad Pro 11"
    (1024, 1366, 2), # iPad Pro 12.9"
]

SPLASH.mkdir(parents=True, exist_ok=True)
links = []
for w, h, r in DEVICES:
    for orient, (pw, ph) in (("portrait", (w, h)), ("landscape", (h, w))):
        img = Image.new("RGB", (pw * r, ph * r), IyNK)
        art = logo.copy()
        # The loading screen's size, so the launch image hands over to it
        # without the logo jumping.
        side = round(min(160, 0.42 * min(pw, ph)) * r)
        art = art.resize((side, round(art.height * side / art.width)), Image.LANCZOS)
        img.paste(art, ((img.width - art.width) // 2, (img.height - art.height) // 2), art)
        name = f"splash-{pw}x{ph}@{r}x-{orient}.png"
        img.save(SPLASH / name)
        links.append(
            f'<link rel="apple-touch-startup-image" href="/splash/{name}" '
            f'media="(device-width: {w}px) and (device-height: {h}px) and '
            f'(-webkit-device-pixel-ratio: {r}) and (orientation: {orient})" />'
        )

print(f"  splash           {len(links)} images")
(ROOT / "tools" / "cache" / "pwa-links.html").write_text("\n".join(links) + "\n")
print("  link tags        tools/cache/pwa-links.html (paste into index.html <head>)")
