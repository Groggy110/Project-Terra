#!/usr/bin/env python3
"""Builds everything "Add to Home Screen" needs on iOS.

  public/icon-*.png              home screen icons, opaque
  public/icon-maskable-512.png   Android's circular crop
  public/splash/*.png            iOS launch images, one per device size

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
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public"
SPLASH = PUB / "splash"

# --paper in the dark theme. The launch image has to agree with the first
# painted frame or the handover flickers.
IyNK = (0, 2, 6)

mark = Image.open(PUB / "logo-mark@512.png").convert("RGBA")
lockup = Image.open(PUB / "logo.png").convert("RGBA")


def icon(size: int, inset: float, out: Path, bg=(255, 255, 255)):
    canvas = Image.new("RGB", (size, size), bg)
    pad = int(size * inset)
    art = mark.copy()
    art.thumbnail((size - pad * 2, size - pad * 2), Image.LANCZOS)
    canvas.paste(art, ((size - art.width) // 2, (size - art.height) // 2), art)
    canvas.save(out)


for s in (180, 192, 256, 512, 1024):
    icon(s, 0.10, PUB / f"icon-{s}.png")
icon(512, 0.20, PUB / "icon-maskable-512.png")
print(f"  icons            {len([1 for _ in range(6)])} written")

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
        art = mark.copy()
        # A sixth of the short edge: the same weight the loading screen gives it.
        side = int(min(pw, ph) * r / 6)
        art.thumbnail((side, side), Image.LANCZOS)
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
