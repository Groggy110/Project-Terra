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

### Filling the database

A fresh Supabase project has the schema but no rows, and an empty network is an
empty globe — no pins, and `0 open needs` in the panel. `supabase/seed.sql`
puts the same thirty-two ministries and sixty-five needs the `?demo` page uses
into the real tables:

```bash
node tools/build_seed.mjs     # regenerate from src/data/, if that changed
```

then paste `supabase/seed.sql` into **Supabase → SQL Editor → New query → Run**,
the same way the schema migration was applied.

It has to be the SQL editor (or the service-role key) rather than the app,
because `needs` deliberately has no insert policy — inserting is the one
operation the browser must not be able to do, since that is exactly how you
would skip the moderation pass. The seed is safe to re-run: everything it
writes is owned by one fixed demo user and is cleared before each insert.

## The sandbox

`sandbox.html` is a second page that boots the *same* app — same `App`, same
`Globe`, same stylesheets — and mounts a control layer over it. It exists so
the look can be settled and footage can be shot without editing the production
page: everything it does is additive and reversible, and `index.html` has no
idea it exists.

```bash
npm run dev:sandbox     # http://127.0.0.1:5173/sandbox.html
npm run build:sandbox   # emits dist/index.html *and* dist/sandbox.html
```

A plain `npm run build` is unchanged and ships no sandbox code at all; the
second entry point is opt-in through `TERRA_SANDBOX`. The sandbox defaults to
`?demo`, because a design sandbox with an empty globe is no use; `?live` opts
back into the backend.

### Design & styling — the left panel

The token list is not a list kept here. It is read out of `document.styleSheets`
at load, so every custom property `base.css` declares on `:root` and
`:root[data-theme="dark"]` turns up automatically and nothing can go stale.
Each one gets the control its value deserves — a swatch and an alpha slider for
a colour, a slider for a length, a field for a shadow or an easing.

Edits are written into one `<style>` element appended after the production
sheets, and **only what changed is emitted**, so *Copy CSS* gives you a diff to
paste into `base.css` rather than a dump of it. The dark scope lists the tokens
the dark block redeclares plus every light token it inherits; editing an
inherited one simply adds a dark override, which is what you would have typed
by hand. *Typography & layout* covers the handful of things that are not tokens
— the base size, the headline's type, the bar height — each one starting at its
live computed value. The whole state exports and imports as JSON.

### Capture mode — the right panel

Capture mode hides every interface element except the ones ticked, so the
globe, the headline and each piece of chrome can be recorded separately and
layered in After Effects. There is a flat-colour background for chroma keying,
and two switches that matter more than they look: the **atmosphere halo** and
the **cloud sheet** are both semi-transparent, and both leave a fringe of screen
colour around the limb when keyed. Off, the globe cuts out cleanly.

Animation is described by one config, and the sliders and the JSON editor are
two views of it — edit either.

- **Globe** — a starting camera, a constant rotation rate for a set time, then
  a deceleration to a stop under any easing you like. The slowdown easing
  describes how the *rate* falls away, not the angle: position is the integral
  of `rate × (1 − ease(u))`, precomputed into a table. So the default — 60°/s
  for 3s, easing to a stop over 1.8s under `cubicOut` — sweeps 207°, and
  swapping the curve changes where it lands as well as how it gets there:
  `linear` 234°, `quadOut` 216°, `expoOut` 196°.
- **Elements** — every other part of the page gets a fade track: delay,
  duration, easing, and opacity / offset / scale / blur at each end.
- **Timeline** — auto length, a countdown for the screen recorder to trim to,
  loop, and whether the sandbox UI gets out of the way while a take runs.

Everything is addressed by *time* rather than accumulated frame by frame, so
scrubbing to 2.4s lands exactly where playing to 2.4s does and a take recorded
at 30fps matches one at 120.

### Clean view

One button, fixed in the top-right above every sandbox panel: it hides every
control, slider and label and leaves the page exactly as a visitor would see
it. Click it again and they come back. It is separate from capture mode — this
one only declutters.

| | |
|---|---|
| `c` | clean view on / off |
| `k` | capture mode on / off |
| `space` | play / pause the take |
| `0` | back to the first frame |

Nothing in `src/ui/` or `src/globe/` was changed to make any of this work. The
camera is driven by wrapping `GlobeControls.update` for the life of the
sandbox, and that wrapper is inert unless a take is running; element animation
is inline styles the player owns and clears; isolation is `data-` attributes
under a body class. `node tools/verify-sandbox.mjs` asserts all of that,
including that the production page comes up carrying none of it.

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

### The reference frame

The page opens on **Deep night**, and what it opens on is one specific picture:
a planet seen whole against black, Africa under the lamp, Europe and the near
East above it. Three things set it, and they are the three worth knowing:

- **The lamp is behind and above, not in front.** `THEMES.dark.sunView` has a
  *negative* z, so the sun sits past the top limb rather than over the
  viewer's shoulder. That is what throws the terminator up across the visible
  face — the southern third of the disc falls away into nothing — and what
  makes the top limb go white-hot where the light grazes the atmosphere. A
  front-lit globe cannot be made to look like this by dimming it; the
  terminator is in the wrong place.
- **The lamp is bolted to the viewer, not to the planet.** It is a view-space
  direction, rebuilt from the camera every frame, so turning the globe carries
  each continent up into the light and back down out of it. `verify-globe.mjs`
  exists to hold that line, and asserts it against the *declared* direction
  rather than against literals, so retuning the look cannot quietly break the
  claim.
- **The lens is 35.6°, and the camera never comes closer than HOME to show
  the whole disc.** The reference frames the globe at 0.72 of the window
  height; the alternative way to get there was to push HOME further out, but
  zoom is a fraction of the span between `DIST_NEAR` and `DIST_FAR`, so moving
  the far end would have rescaled every altitude in the app. Widening the lens
  leaves the zoom ladder where it is.

`WORK` — where the entrance settles — is therefore the whole disc rather than a
regional view. Cities are a zoom away, which is what the hint under the globe
has always said.

Soft light is still there under the theme button, and is still the same
imagery: nothing below is per-theme except the numbers in `THEMES`.

### Grading

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
  Only the densest part of the sheet is kept — a threshold pair plus a gamma,
  which is what turns a veil into separate cumulus with sky between them — and
  it thins further as you come in: a full sheet whites out the ground the pins
  are placed on. The sheet also *fades* with the light rather than only
  darkening with it, in proportion to how far the theme models day and night
  at all. Shading an opaque sheet leaves the night side pasted over with flat
  grey; the ground goes dark underneath and the cloud stays, which reads as
  smoke smeared across the terminator.
- **The crazing** over the continents is a 3D Voronoi evaluated on the surface
  normal, so its cells are the same size everywhere and there is no seam to
  tear at the antimeridian. `facet.edgeInk` is signed: the dark preset draws
  the seams *pale*, like the glaze on a dry lake bed, which is what the
  reference has; positive sinks them into shadow instead.

Geography is solved per pixel from the surface normal (`lon = atan2(-z, x)`),
so detail does not depend on how finely the sphere is tessellated, and the one
seam in the texture lookup falls in the middle of the Pacific.

### The drift

Left alone the camera walks east. The rate is set in *pixels of ground per
second* rather than degrees: a degree is worth twice as much screen at the
working view as it is at the whole globe, and a fixed angular rate that reads
as a slow turn from far off reads as a pan you cannot read over the top of once
you have come in. Converting through pixels-per-degree holds the apparent speed
steady — about 3.2°/s at the whole globe, half that once you have come in.

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

### Streamed imagery

Blue Marble is 5400 pixels round — fifteen to the degree. The working view
already shows twenty-two and a ministry opened at zoom 0.62 shows thirty-odd,
so from about a third of the way in every further step magnifies a texel
instead of revealing anything. `src/globe/imagery.js` fills that in: a quadtree
of satellite tiles for the ground actually on screen, composited into one
canvas and handed to the shader as a second base.

The canvas stays in **Web Mercator**. Tiles are square in that projection, so
each one lands as an exact `drawImage` rectangle and nothing is resampled;
the shader computes the one extra coordinate it needs per pixel:

```glsl
float merc = 0.5 - log(tan(PI * 0.25 + lat * 0.5)) / (2.0 * PI);
```

The window uniform is in that same normalised Mercator space and behaves like
the vector window beside it: geographic, so a stale canvas stays over the right
ground while the camera moves. The canvas has an **alpha channel**, and that is
load-bearing — a slot with no tile in it yet is transparent, the shader
multiplies the blend by that alpha, and the painted globe shows through the
gap. Tiles therefore fill in in place rather than appearing all at once.

Zoom is picked so one texel lands on one device pixel. Mercator is conformal,
so one number settles it in both directions:

```
2^z = pxPerDeg · cos(lat) · 360 / tilePixels
```

Tiles are fetched for ground you are **looking at**, not ground you are
travelling through: while the camera's distance is changing, the window still
recomposites from whatever is cached but asks for nothing. A fly-in crosses six
or seven zoom levels in under two seconds, and fetching each one cost five
hundred requests to arrive somewhere that needs eighty. Panning still streams,
because the distance is not changing.

As the imagery takes over, the modelling that belongs to a planet retires — in
this order, each on its own zoom range: the faceted shell, the hillshade (built
from an 11 km-per-texel elevation raster), the inferred snow, the terminator,
the cloud sheet, most of the vector ink, and last the styled ocean, whose
Natural Earth coastline is about a kilometre out and visibly cuts across
sandbanks and jetties the tiles are drawing perfectly well.

`DIST_NEAR` moved with it, from 1.055 to 1.014 — from about a thousand
kilometres of framing to about ninety. In logs that is a 3% change, because
the distance barely moves even as the *height* above the surface falls
fourfold, so every threshold keyed off `zoom()` lands within 0.02 of where it
did.

### Configuring a tile source

Copy `.env.example` to `.env.local`. With nothing set, the globe uses **Esri
World Imagery**, which needs no key — so it works on a fresh clone — and is
fine for a demonstration. For anything with traffic, get a key:

```bash
VITE_TILES_PROVIDER=mapbox        # esri (default) · mapbox · maptiler
VITE_TILES_KEY=pk.ey...
```

or point it at any XYZ source you have the rights to:

```bash
VITE_TILES_URL=https://example.com/tiles/{z}/{x}/{y}.jpg?key={key}
VITE_TILES_KEY=...
VITE_TILES_SIZE=512
VITE_TILES_MAX_ZOOM=20
VITE_TILES_ATTRIBUTION=Imagery: Example
```

Set `VITE_TILES_PROVIDER=none` to turn the layer off; the globe then draws
exactly as it did before it existed. Whatever the source, it must send
`Access-Control-Allow-Origin` — tiles are composited into a canvas that is
uploaded to WebGL, and a tainted canvas cannot be.

Every provider requires attribution while its imagery is on screen, which the
credit above the zoom dial carries; it fades in and out with the imagery
itself.

**Not Google.** Google Maps Platform's Map Tiles API does serve 2D satellite
tiles, but its terms forbid using Google Maps content "with or near a
non-Google map" — and a hand-written WebGL globe is about as non-Google a map
as there is. The restriction is on the *content*, not the transport, so there
is no way to take the tiles and draw them here. The providers above all permit
third-party renderers with attribution.

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
| Base imagery | NASA Blue Marble Next Generation, topography + bathymetry, 5400×2700 |
| Detail imagery | Esri World Imagery by default (Esri · Maxar · Earthstar Geographics); Mapbox or MapTiler Satellite with a key |
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
  verify-sandbox.mjs     the same for the sandbox, and that production is clean
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

sandbox.html           the design and capture page (see "The sandbox")
src/sandbox/           mounts over the real app; nothing else imports it
  main.js                boots App, then Sandbox
  sandbox.js             panels, clean view, capture mode, persistence
  player.js              the transport: config + time -> a frame on screen
  anim.js                easings, a bezier solver, the deceleration integral
  config.js              what can be animated, and the shape of the config
  tokens.js              reads the live stylesheets; writes the override CSS
  widgets.js             the control vocabulary the panels are built from
  styles.css             sandbox chrome, every selector prefixed sbx-
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
  build (`TERRA_URL=http://127.0.0.1:4173/ node tools/verify.mjs`). It expects
  the demo set: `TERRA_URL=http://127.0.0.1:5173/?demo`.
- `node tools/verify-sandbox.mjs` does the same for `sandbox.html`, and ends by
  loading the production page to assert it carries no sandbox at all.
