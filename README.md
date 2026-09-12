# Terra — Ministry Needs Network

A globe of what ministries need. Every pin is a ministry in the city where the
work happens; open one to read its needs, pick one up, and get in touch.

**All the data is fictional.** The organisations, people and needs are invented
for demonstration and every contact address is on `example.org`, which cannot
receive mail. Interests you express and needs you post are saved in your
browser's `localStorage` and nowhere else — there is no server.

## Running it

```bash
npm install
npm run assets      # bakes textures and vector binaries (needs network, ~2 min)
npm run dev         # http://127.0.0.1:5173
```

`npm run assets` is only needed once — it writes into `public/`, which the app
serves directly. `npm run build` produces `dist/` (about 14 MB, most of it
imagery and vector data).

## The entrance

The page loads onto its own paper: the watercolour is down from the first
frame, a mark turns on it, a bar fills, and the chrome, the globe and the
headline are all still held at nothing. There is no curtain to pull, because
there is nothing behind it yet. When the bar reaches the end it is allowed a
beat there — filling and vanishing on the same frame reads as the load being
cut short — and then the whole loading screen rises away, out the way it came
in, while the page comes up under it.

The world does not fly in. It **fades up** where it stands, already turning,
with the headline landing half a second behind it so the two read as one
arrival. The headline stands *in front of* the disc, at full ink, with a soft
wash of the paper colour behind it; the ground it needs is reserved out of the
label layer, so no pin is ever left half-hidden behind a letterform.

Then, once it has held its beat, the page **settles** — and this is the
entrance's only camera move. A flight in and then a flight down read as two
loading animations queued behind each other, and the first is the one doing no
work: you cannot see the globe well enough during it to be told anything.

The order of the settle matters. The words lift away, the find bar rides up
into the top bar and the panel comes in from the right; only once that is
underway does the camera go down. The chrome leads by about a third of a
second, so the move reads as *the bar goes up, and then we go in* rather than
as everything lurching at once. The camera arrives at Europe, Africa and the
near East: the densest part of the network, close enough to letter every pin in
it. It goes on turning there.

That descent runs with its arc suppressed. A long hop normally lifts away from
the surface and settles back, which reads well between two places at the same
height; on a descent it puts a small rise at the front, and a page that has
just finished arriving cannot afford anything that looks like a second move.

Only the timer brings the camera with it. Anything deliberate — a drag, a zoom,
the search field, a filter — skips straight to the settled chrome and leaves
the view where you put it: someone who has taken hold of the globe has said
where they want to be.

At the whole-globe view the pins are bare dots. Plates would cover the disc
they annotate and land on the headline; they letter themselves once you have
come in far enough to read them, and hovering a dot names it at any zoom.

## The globe

The surface is graded at runtime rather than pre-baked, so the same source
imagery serves both themes:

- **Land** is lifted through a gamma curve — December imagery puts temperate
  land near 0.17 luminance, well under the ocean, and a map wants it clearly
  above — then desaturated and gained.
- **Snow** is separated from bright desert by *chroma*, not luminance. Sand at
  0.49 luminance carries 0.31 chroma; an icecap at 0.71 carries 0.03.
- **The ocean** is recoloured from depth, using the source's own bathymetry
  shading as the depth channel: open water sits at 0.07–0.13 luminance and
  genuine shelf water above 0.20, which is where the ramps are keyed.
- **Hillshade** comes from a topography channel, differenced at whatever mip
  the sampler is actually reading so relief survives a whole-globe view instead
  of averaging itself flat.
- **Clouds** are synthesised, not photographed — see `tools/make_clouds.py`.
  Only the densest part of the sheet is kept, and it thins further as you come
  in: a full sheet whites out the ground the pins are placed on.

Geography is solved per pixel from the surface normal (`lon = atan2(-z, x)`),
so detail does not depend on how finely the sphere is tessellated, and the one
seam in the texture lookup falls in the middle of the Pacific.

### The drift

Left alone the camera walks east. The rate is set in *pixels of ground per
second* rather than degrees: a degree is worth twice as much screen at the
working view as it is at the whole globe, and a fixed angular rate that reads
as a slow turn from far off reads as a pan you cannot read over the top of once
you have come in. Converting through pixels-per-degree holds the apparent speed
steady — about 3.2°/s at the whole globe, half that down at the working view.

It stands down for anything deliberate and picks up again after 3.4 seconds of
quiet, fades out entirely as the view becomes local, holds still while a
ministry is selected, and never runs at all under `prefers-reduced-motion`.

Because the camera then moves on every frame, the vector painter cannot use
`idleFrames` to tell motion from rest: the coarse paint it takes during a drag
would become permanent. A drift is slow enough to paint at full resolution
instead, with a wider pad, which at the whole-globe view means no repaint at
all — the window there already wraps the world.

### Vectors

Coast, borders, rivers, lakes and the land fill are geometry, never pixels. On
every settle the visible lat/lon window is rasterised into two canvases —
stroked ink, and the land/ocean split that replaces the low-resolution raster
mask. The shader addresses those canvases *geographically*, through a window
uniform, so a stale canvas stays pinned to the right ground while the camera
moves; only its sharpness lags.

There are two tiers. The fine window always paints at one texel per device
pixel and shrinks its **coverage**, never its resolution, to stay inside a
texel budget. Under it sits a coarse world canvas, which is what shows in the
foreshortened sliver near the limb where a degree of arc is worth almost no
pixels. That split is what keeps mid-zoom sharp: a single equirectangular
window over a whole visible hemisphere would need about 17 million texels.

1:50m carries the world; 1:10m is fetched once lines would show it.

## The paper

The ground is a baked watercolour wash, shown whole rather than cropped:
`background-size: 100% 100%`. Its composition is the point — clear through the
middle where the globe and the headline sit, pigment gathered at the edges and
corners — and `cover` on a wide window frames two or three of the largest pools
and nothing else, at which size a pool reads as a grey cloud rather than a wash.

`tools/make_ui_textures.py` bakes it. A pool of watercolour dries with pigment
pushed to its boundary, so each layer is a hard-edged pool plus a rim taken
from the gradient of its own coverage; the pool has to stay hard for that to
work, because blurring it first spreads the gradient into a halo and the result
is an airbrush blob. Four tiers at deliberately flat weights, because the page
scales the sheet down to fit and a texture carried by its largest features
alone arrives as three grey clouds. Granulation — the heavy fraction of the
pigment settling into the tooth of cold-press paper — is gated on the wash, so
the flecks land where the water went.

## Sources

| | |
|---|---|
| Imagery | NASA Blue Marble Next Generation, topography + bathymetry, 5400×2700 |
| Topography | GEBCO_08 revised elevation, via NASA Visible Earth |
| Vectors | Natural Earth 1:50m and 1:10m — coastline, boundaries, rivers, lakes, land |
| Places | Natural Earth populated places; country labels use its own cartographer-placed label points |
| Clouds, paper, grain, glow | synthesised in `tools/` |

## Controls

| | |
|---|---|
| drag | rotate |
| scroll / pinch | zoom |
| double-click | fly there |
| click a pin | open that ministry |
| `/` | focus search |
| `+` `-` | zoom |
| `r` | reset the view |
| `b` | needs board |
| `t` | switch theme |
| `Esc` | close whatever is open |

## Layout

```
tools/                 asset pipeline and test harnesses
  fetch_sources.sh       downloads upstream imagery and GeoJSON into tools/cache/
  make_earth_textures.py blue-marble.jpg + earth-aux.png (topo / mask / coast proximity)
  make_clouds.py         synthesised cloud sheet
  make_ui_textures.py    watercolour paper, grain, glow sprite
  build_vectors.py       GeoJSON -> compact TVEC / TPOL binaries
  noiselib.py            shared spectral-noise helpers
  shoot.mjs              screenshots a set of app states
  verify.mjs             drives the real UI and asserts behaviour
  debug-channels.mjs     renders each shader debug channel

src/globe/             renderer, camera, vectors, labels
  globe.js               scene, loop, repaint schedule
  earth.js               materials and the two grading presets
  vectors.js             binary loader + two-tier canvas painter
  labels.js              projected pins, city ticks, country plates
  controls.js            lat/lon/distance camera with inertia and fly-to
  geo.js                 spherical maths shared by all of the above
  shaders/               GLSL

src/data/              taxonomy, 32 ministries, 65 needs, query model
src/ui/                shell, panel, board, modals, filters, popovers
```

## Notes

- `window.terra` is a deliberate debug handle: `terra.globe.debug(1)` renders a
  single shader channel (mask, window, ink, land, sea, hillshade, topo, …),
  `terra.globe.painter.stats` reports the last vector repaint.
- Every pin asks for its city plate and falls back to a bare dot when one will
  not fit, so a crowded limb loses names rather than ministries. Placement is
  greedy, and the pass starts from whatever was lettered last frame, so a plate
  only leaves when something genuinely displaces it.
- The label layer projects against `camera.matrixWorldInverse`, which the
  renderer refreshes at draw time — after the labels have already used it. The
  camera therefore updates its own matrix at the end of `controls.update()`.
  One stale frame is invisible at a nudge and about ten degrees of longitude at
  the end of a throw, which slides every pin off its city and leaves it there.
- One known constraint, honest to the design: the imagery goes soft at city
  zoom, which is why the vectors carry the detail there.
- `node tools/verify.mjs` runs against the dev server or a `npm run preview`
  build (`TERRA_URL=http://127.0.0.1:4173/ node tools/verify.mjs`).
