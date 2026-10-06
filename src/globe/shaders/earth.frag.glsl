precision highp float;

uniform sampler2D uBase;    // NASA Blue Marble, topography + bathymetry
uniform sampler2D uAux;     // R topography, G land mask, B coast proximity
uniform sampler2D uLines;   // vector ink, in window space
uniform sampler2D uMask;    // crisp land mask, in window space
uniform sampler2D uBaseInk; // vector ink for the whole world, coarse tier
uniform sampler2D uDetail;  // streamed satellite tiles, in Web Mercator

uniform vec4 uWindow;       // uMin, vMin, uSpan, vSpan of the painted window
// Where the tile canvas sits, in *normalised Mercator* - not the uv above.
// Tiles are square in that projection, so they land as exact rectangles and
// the one conversion happens here, per pixel, instead of per tile on the CPU.
uniform vec4 uDetailWindow; // uMin, mMin, uSpan, mSpan
uniform float uDetailMix;   // 0 off, 1 imagery fully in charge of the land
// The tiles arrive already true-colour and contrasty, where Blue Marble is
// flat and dark; everything downstream is graded for the latter. These bring
// a tile back to the base's footing *before* that grade, so one set of land
// controls still governs the look and the two never read as two maps.
uniform float uDetailGamma;
uniform float uDetailShadowGamma; // the gamma at black, easing to uDetailGamma by mid-grey (land only)
uniform float uDetailSat;
uniform float uDetailGain;
uniform float uDetailLift;
uniform float uDetailSea;   // how far the imagery may modulate the styled sea
uniform float uDetailWater; // 1 when the imagery draws the water as well
uniform vec2 uAuxTexel;
uniform vec2 uAuxSize;
uniform float uHasWindow;

uniform vec3 uSun;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShelf;
uniform vec3 uSnow;
uniform vec3 uAtmo;
uniform vec3 uNight;        // what the unlit side is multiplied by

uniform float uLandGamma;
uniform float uLandSat;
uniform float uLandGain;
uniform float uLandLift;
uniform float uRelief;
uniform float uSunMix;      // overall strength of the day/night modelling
uniform float uAmbient;     // floor under the terminator: 0 dramatic, 1 flat
uniform float uTermWidth;   // half-width of the terminator, in cos(angle)
uniform float uTermGamma;   // >1 drags the shadow further up the lit side
uniform float uSpec;
uniform float uSpecPower;
uniform vec3 uSpecColor;
uniform vec3 uHillLight;    // the embossing light, in east/north/up
uniform float uShadeMin;
uniform float uShadeMax;
uniform float uFresnel;
uniform float uFresnelPow;
uniform float uRimBase;     // rim brightness away from the light
uniform float uLineMix;
uniform float uSnowAmt;

// Faceting. The reference is not satellite imagery: the continents read as a
// crystalline shell of flat cells, each catching the light on its own.
uniform float uFacet;       // 0 off, 1 full
uniform float uFacetScale;  // cells across the globe
uniform float uFacetTilt;   // how far a cell's normal may lean
uniform float uFacetFlat;   // how much of a cell takes one flat colour
uniform float uFacetEdge;   // width of the seam between cells
uniform float uFacetEdgeInk;// how dark that seam goes; negative draws it pale

// Surface extras, all neutral at their defaults.
uniform vec3 uLandTint;
uniform float uLandTintAmt;
uniform vec3 uEmissive;         // colour x intensity
uniform float uEmissiveNight;   // 1: only where the sun is not
uniform float uGrid;            // graticule opacity, 0 off
uniform vec3 uGridColor;
uniform float uGridSpacing;     // degrees
uniform float uGridWidth;       // pixels
uniform sampler2D uNightTex;    // city lights, equirectangular
uniform vec3 uNightLights;      // colour x intensity, 0 off
uniform float uNightDay;        // how much of them shows on the lit side too, 0..1

uniform float uDebug;   // 0 off; see globe.debug()

varying vec3 vNormalW;
varying vec3 vWorld;

const float PI = 3.141592653589793;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// The uv seam runs down the antimeridian. Without this the mip selector sees a
// full-texture jump across that one column and picks the coarsest level,
// leaving a blurred stripe through the Pacific.
vec2 fixSeam(vec2 d) {
  d.x -= sign(d.x) * step(0.5, abs(d.x));
  return d;
}

float win1(float x, float edge) {
  return smoothstep(0.0, edge, x) * (1.0 - smoothstep(1.0 - edge, 1.0, x));
}

vec2 dirToUv(vec3 d) {
  return vec2(atan(-d.z, d.x) / (2.0 * PI) + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI);
}

/**
 * Three random numbers from a point, with no transcendental in it.
 *
 * The obvious version of this is `fract(sin(dot(p, k)) * 43758.5)`, and it was
 * that. The cells() below calls this twenty-seven times per pixel, so that
 * spelling costs eighty-one sines on every fragment of a full-screen sphere —
 * which a desktop GPU absorbs and a phone's does not, because transcendentals
 * run on a narrower unit there. This is the standard multiply-and-fold hash
 * instead: same uniform distribution, same character of noise, no special
 * function. The feature points land in different places, so the facets are a
 * different arrangement of the same thing, at a fraction of the cost.
 */
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

/**
 * Cellular noise in three dimensions, evaluated on the surface normal.
 *
 * Three dimensions rather than two on purpose: a Voronoi built in uv space
 * would crowd its cells to nothing at the poles and tear along the
 * antimeridian, which are the two places a globe is most obviously a globe.
 * On the normal the cells are the same size everywhere and there is no seam
 * to tear.
 *
 * Returns the winning feature point, and the gap to the runner-up — which is
 * near zero exactly on a cell boundary, and is what draws the seams.
 */
void cells(vec3 p, out vec3 feature, out float edge) {
  vec3 ip = floor(p);
  vec3 fp = p - ip;
  float d1 = 9.0;
  float d2 = 9.0;
  feature = p;

  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 o = hash33(ip + g);
        vec3 r = g + o - fp;
        float d = dot(r, r);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          feature = ip + g + o;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
  }
  edge = sqrt(d2) - sqrt(d1);
}

void main() {
  vec3 n = normalize(vNormalW);

  // Geography solved per pixel from the normal, so detail does not depend on
  // how finely the sphere is tessellated.
  float lonRad = atan(-n.z, n.x);
  float latRad = asin(clamp(n.y, -1.0, 1.0));
  vec2 uv = vec2(lonRad / (2.0 * PI) + 0.5, 0.5 - latRad / PI);

  vec2 ddx = fixSeam(dFdx(uv));
  vec2 ddy = fixSeam(dFdy(uv));

  vec3 base = texture2DGradEXT(uBase, uv, ddx, ddy).rgb;
  vec3 aux = texture2DGradEXT(uAux, uv, ddx, ddy).rgb;

  float topo = aux.r;
  float mask = aux.g;
  float prox = aux.b;

  // ---- vector window ----------------------------------------------------
  float du = uv.x - uWindow.x;
  du -= floor(du);                       // wrap, so a window may straddle 180
  vec2 wuv = vec2(du / uWindow.z, (uv.y - uWindow.y) / uWindow.w);
  float inWin = uHasWindow * win1(wuv.x, 0.015) * win1(wuv.y, 0.015);

  // Coarse tier first, then the fine window over it where one exists. Outside
  // the window the land split falls back to the raster mask, which is the same
  // 4096-wide grid the topography comes from.
  vec4 ink = texture2DGradEXT(uBaseInk, uv, ddx, ddy);
  if (inWin > 0.002) {
    vec2 c = clamp(wuv, 0.0, 1.0);
    float fine = texture2D(uMask, c).r;
    // The fine mask is a 2D canvas, and a phone can take a canvas's pixels
    // away under memory pressure and hand it back blank — which reads as
    // "all water", and the continents go the colour of the sea. Where the
    // raster says solid land for a texel and a half all round, there is no
    // coastline for the fine mask to refine, so it is land whatever the
    // canvas says. Only land is guarded: forcing water would sink every
    // island smaller than the raster can see. A lake that small reads as
    // land here and shows as water in the imagery over it.
    vec2 o = uAuxTexel * 1.5;
    float solid = min(
      min(mask, texture2DGradEXT(uAux, uv + vec2(o.x, 0.0), ddx, ddy).g),
      min(
        min(texture2DGradEXT(uAux, uv - vec2(o.x, 0.0), ddx, ddy).g, texture2DGradEXT(uAux, uv + vec2(0.0, o.y), ddx, ddy).g),
        texture2DGradEXT(uAux, uv - vec2(0.0, o.y), ddx, ddy).g
      )
    );
    fine = max(fine, smoothstep(0.9, 0.99, solid));
    mask = mix(mask, fine, inWin);
    ink = mix(ink, texture2D(uLines, c), inWin);
  }

  // ---- streamed imagery -------------------------------------------------
  //
  // Mercator's y, from the same latitude the uv came from. The clamp is the
  // projection's own limit: past 85.05 degrees the log runs away, and there is
  // no tile there to sample anyway.
  float mLat = clamp(latRad, -1.4844, 1.4844);
  float merc = 0.5 - log(tan(0.7853981634 + mLat * 0.5)) / 6.2831853072;

  float dU = uv.x - uDetailWindow.x;
  dU -= floor(dU);                       // wrap, as above
  vec2 duv = vec2(dU / uDetailWindow.z, (merc - uDetailWindow.y) / uDetailWindow.w);
  float inDetail = uDetailMix * win1(duv.x, 0.02) * win1(duv.y, 0.02);

  // `raw` is the painted planet, and it stays the reference for everything
  // that is a *reading* of the world rather than a picture of it - the ocean
  // ramp, the icecaps. Those are theme, and a tile must not vote on them.
  vec3 raw = base;
  vec3 detail = vec3(0.0);
  if (inDetail > 0.002) {
    // The alpha is which tiles have actually landed. Multiplying the blend by
    // it is what lets a window fill in place: every tile that has arrived is
    // at full strength the moment it arrives, and the ground between them is
    // still the painted planet rather than a hole.
    vec4 tile = texture2D(uDetail, clamp(duv, 0.0, 1.0));
    inDetail *= tile.a;
    detail = mix(vec3(dot(tile.rgb, LUMA)), tile.rgb, uDetailSat);
    // The gamma that brings the tiles to Blue Marble's footing squares the
    // values, and the land grade after it takes a little more off the
    // bottom: together they put anything under a fifth of full brightness at
    // black. Bright ground - desert, rock, city - is untouched by that, but
    // rainforest photographs at a tenth to a fifth, so the Amazon, the Congo
    // and the Caribbean's green islands went out entirely once the tiles came
    // in. On land the brightness follows a gentler gamma in the shadows, back
    // to the full one by mid-grey, so only those regions change. The colour
    // is mostly the gentler curve's, with a quarter of the full curve's
    // scaled up to the new brightness: the first alone turns forest grey,
    // the second alone turns it a flat neon green.
    vec3 full = pow(max(detail, vec3(0.0)), vec3(uDetailGamma));
    float dL = max(dot(detail, LUMA), 0.0);
    float dG = mix(uDetailShadowGamma, uDetailGamma, smoothstep(0.0, 0.5, dL));
    vec3 soft = pow(max(detail, vec3(0.0)), vec3(dG));
    vec3 kept = full * (dot(soft, LUMA) / max(dot(full, LUMA), 1e-4));
    vec3 toe = min(mix(soft, kept, 0.25), vec3(1.0));
    detail = mix(full, toe, mask) * uDetailGain + uDetailLift;
    // Land, and - once you are close enough - water too. See uDetailWater at
    // the ocean mix below for why the styled sea has to let go at the end.
    base = mix(base, detail, inDetail * max(mask, uDetailWater));
  }

  // ---- hillshade --------------------------------------------------------
  float mip = max(1.0, length(ddx * uAuxSize));
  vec2 e = uAuxTexel * mip;
  float hL = texture2DGradEXT(uAux, uv - vec2(e.x, 0.0), ddx, ddy).r;
  float hR = texture2DGradEXT(uAux, uv + vec2(e.x, 0.0), ddx, ddy).r;
  float hN = texture2DGradEXT(uAux, uv - vec2(0.0, e.y), ddx, ddy).r;
  float hS = texture2DGradEXT(uAux, uv + vec2(0.0, e.y), ddx, ddy).r;

  float cosLat = max(cos(latRad), 0.18);
  // The slope is a height difference across `e`, so a finer raster, sampled
  // across fewer kilometres, would read as flatter. Scaled back to the step
  // the 4096-wide raster took at this zoom, the relief keeps the strength it
  // was tuned at and only gains detail.
  float mip4k = max(1.0, length(ddx * vec2(4096.0, 2048.0)));
  float stepScale = (mip4k / 4096.0) / (mip / uAuxSize.x);
  vec2 slope = vec2((hR - hL) / cosLat, -(hS - hN)) * uRelief * stepScale;
  vec3 tN = normalize(vec3(-slope.x, -slope.y, 1.0));
  vec3 tL = normalize(uHillLight);
  float shade = 1.0 + (dot(tN, tL) / tL.z - 1.0) * mask;
  shade = clamp(shade, uShadeMin, uShadeMax);
  // The relief is modelled from a 4096- or 8192-wide elevation raster -
  // eleven or five kilometres a texel. Over a city it is not detail, it is a slow stain
  // across ground whose own light and shadow the imagery already carries, so
  // it hands over as the tiles come in.
  shade = mix(shade, 1.0, inDetail * 0.8);

  float lum = dot(raw, LUMA);
  float mx = max(max(raw.r, raw.g), raw.b);
  float mn = min(min(raw.r, raw.g), raw.b);
  float chroma = mx - mn;

  // ---- faceting ---------------------------------------------------------
  // Land only. The reference keeps the ocean a smooth deep blue and puts the
  // whole crystalline treatment on the continents, which is also what keeps
  // the coastline legible: a faceted sea would fight the ink drawn over it.
  float facet = uFacet * mask * (1.0 - inDetail);
  vec3 sN = n;                     // the normal light is actually taken from
  float seam = 1.0;
  vec3 cellCol = base;

  if (facet > 0.002) {
    vec3 feature;
    float edge;
    cells(n * uFacetScale, feature, edge);

    // One flat colour per cell, read at a coarser mip so a cell takes the
    // region's colour rather than whatever pixel its centre happened to land
    // on. Mixed rather than replaced, so the continents keep their geography.
    vec2 cuv = dirToUv(normalize(feature));
    vec3 flat3 = texture2DGradEXT(uBase, cuv, ddx * 3.0, ddy * 3.0).rgb;
    cellCol = mix(base, flat3, uFacetFlat * facet);

    // Each cell leans its own way, by a fixed amount decided by its own hash,
    // so the shell catches the light in flat planes instead of a smooth
    // gradient. This is the whole effect.
    vec3 lean = hash33(feature + 7.31) - 0.5;
    lean -= n * dot(lean, n);      // tilt across the surface, never into it
    sN = normalize(n + lean * uFacetTilt * facet);

    seam = (1.0 - smoothstep(0.0, uFacetEdge, edge)) * facet;
  }

  base = cellCol;

  // ---- land -------------------------------------------------------------
  vec3 land = pow(max(base, vec3(0.0)), vec3(uLandGamma));
  land = mix(vec3(dot(land, LUMA)), land, uLandSat);
  land = land * uLandGain + uLandLift;
  land = mix(land, land * uLandTint * 1.6, uLandTintAmt);
  land *= shade;

  // Snow reads as brightness with almost no colour in it, which is what
  // separates an icecap from a bright desert at the same luminance.
  float snow = smoothstep(0.33, 0.62, lum) * (1.0 - smoothstep(0.06, 0.17, chroma));
  snow = max(snow, smoothstep(0.58, 0.88, topo) * (1.0 - smoothstep(0.10, 0.24, chroma)));
  // Snow is inferred - bright, and almost colourless. A white roof in a
  // 30cm tile is both, so the inference retires with the guesswork.
  land = mix(land, uSnow * (0.93 + 0.07 * shade), clamp(snow, 0.0, 1.0) * uSnowAmt * (1.0 - inDetail));

  // ---- ocean ------------------------------------------------------------
  vec3 sea = mix(uDeep, uMid, smoothstep(0.02, 0.13, lum));
  sea = mix(sea, uShelf, smoothstep(0.17, 0.34, lum) * 0.5);
  sea = mix(sea, uShelf, smoothstep(0.62, 1.0, prox) * 0.16);
  sea *= 0.99 + 0.12 * (lum - 0.08);                   // ridges and trenches
  // The water stays the theme's colour and takes only the imagery's
  // *brightness*: shoals, sandbars, a harbour mouth, a wake - read through the
  // same blue the whole ocean is drawn in, which is what keeps a city's
  // waterfront from turning into a grey photograph beside a painted sea.
  sea *= 1.0 + uDetailSea * inDetail * (dot(detail, LUMA) * 2.4 - 0.55);

  // The last thing the painted globe gives up.
  //
  // Natural Earth's coastline is good to about a kilometre, which is a
  // rounding error against a whole ocean and a visible lie against a 30cm
  // tile: at a city the styled sea runs a blue tongue up over sandbanks and
  // jetties the imagery is drawing perfectly well. The ocean ramp is a
  // reading of the *planet* - deep, shelf, the glow of shallow water - and
  // like the terminator and the facets it is a reading with nothing left to
  // say once the frame is a hundred kilometres across. So past a region the
  // mask opens and the imagery draws its own water.
  vec3 col = mix(sea, land, max(mask, uDetailWater));
  // The crazing over the continents. The reference draws it *pale* — a net of
  // light seams between the cells, like the glaze on a dry lake bed — which
  // is the opposite of an outline drawn round each one, so uFacetEdgeInk is
  // signed: positive sinks the seam into shadow, negative lifts it out.
  col = uFacetEdgeInk >= 0.0
    ? col * (1.0 - seam * uFacetEdgeInk)
    : mix(col, min(col * 1.55 + 0.055, vec3(1.0)), seam * -uFacetEdgeInk);
  col = mix(col, ink.rgb, ink.a * inWin * uLineMix);

  // ---- graticule ----------------------------------------------------------
  if (uGrid > 0.001) {
    vec2 deg = vec2(lonRad, latRad) * (57.29578 / uGridSpacing);
    vec2 w = max(fwidth(deg), vec2(1e-5));
    vec2 g = abs(fract(deg - 0.5) - 0.5) / w;
    float line = 1.0 - clamp(min(g.x, g.y) / max(uGridWidth, 0.1), 0.0, 1.0);
    // Past the antimeridian seam fwidth spikes; fade the grid there rather
    // than draw a smear.
    line *= step(w.x, 0.5);
    col = mix(col, uGridColor, line * uGrid);
  }
  vec3 albedo = col;

  // ---- light ------------------------------------------------------------
  //
  // uSun arrives in world space but is rebuilt every frame from a *view*
  // space direction (see globe.js), so "toward the light" is always toward
  // the top of the frame however the globe is turned. Spinning the world
  // therefore carries each continent up into the light and back down out of
  // it, which is the behaviour the reference is showing.
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSun);
  float ndv = clamp(dot(n, V), 0.0, 1.0);

  // The terminator is authored rather than physical: a wide soft band whose
  // falloff can be dragged well up the lit side, because a hard Lambert edge
  // reads as a CG sphere and the reference is a painted one.
  float ndl = dot(sN, L);
  float day = smoothstep(-uTermWidth, uTermWidth, ndl);
  day = pow(day, uTermGamma);
  float lit = mix(1.0, uAmbient + (1.0 - uAmbient) * day, uSunMix);
  col = mix(col * uNight, col, lit);
  col += albedo * terraLights(sN, V);
  col += uEmissive * mix(1.0, 1.0 - day, uEmissiveNight);
  if (dot(uNightLights, vec3(1.0)) > 0.001) {
    float city = texture2DGradEXT(uNightTex, uv, ddx, ddy).r;
    // On the dark side always; on the lit side as far as uNightDay asks — the
    // landing look keeps the cities burning on a sunlit planet, which is a
    // picture and not a model. Added as light that fades as the ground under
    // it brightens, so a lit city glows rather than whiting out the land.
    float when = mix(1.0 - day, 1.0, uNightDay);
    vec3 glow = uNightLights * city * when * mask * (1.0 - inDetail * 0.5);
    col += glow * (1.0 - clamp(col, 0.0, 1.0) * 0.35);
  }

  vec3 H = normalize(L + V);
  // Gated by the day term: a specular glint on the unlit half is the single
  // most obvious way to give away that the light is not where it looks.
  float spec = pow(clamp(dot(sN, H), 0.0, 1.0), uSpecPower) * (1.0 - mask) * uSpec * day;
  col += spec * uSpecColor;

  // Aerial perspective, weighted toward the light. The limb glows brightest
  // where it faces the lamp and falls away round the sides, which is what
  // makes the rim read as atmosphere catching the sun rather than as an
  // outline drawn round a disc.
  float rim = pow(1.0 - ndv, uFresnelPow);
  float rimLit = uRimBase + (1.0 - uRimBase) * smoothstep(-0.55, 0.9, ndl);
  col = mix(col, uAtmo, clamp(rim * uFresnel * rimLit, 0.0, 0.96));

  if (uDebug > 0.5) {
    if (uDebug < 1.5) col = vec3(mask);
    else if (uDebug < 2.5) col = vec3(inWin);
    else if (uDebug < 3.5) col = vec3(ink.a);
    else if (uDebug < 4.5) col = land;
    else if (uDebug < 5.5) col = sea;
    else if (uDebug < 6.5) col = vec3(shade - 0.4);
    else if (uDebug < 7.5) col = vec3(topo);
    else if (uDebug < 8.5) col = vec3(lum, chroma, snow);
    else if (uDebug < 9.5) col = vec3(wuv, 0.0);            // window coords
    else if (uDebug < 10.5) col = vec3(texture2D(uMask, clamp(wuv, 0.0, 1.0)).r);
    else if (uDebug < 11.5) col = vec3(uv, 0.0);             // geographic uv
    else if (uDebug < 12.5) col = base;                      // raw imagery
    else if (uDebug < 13.5) col = vec3(aux.g);               // raw raster mask
    else if (uDebug < 14.5) col = sN * 0.5 + 0.5;            // faceted normal
    else if (uDebug < 15.5) col = vec3(seam);                // cell seams (1 on a seam)
    else if (uDebug < 16.5) col = vec3(duv, 0.0);            // tile window coords
    else if (uDebug < 17.5) col = texture2D(uDetail, clamp(duv, 0.0, 1.0)).rgb;
    else col = vec3(day);                                    // day / night
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  // 8-bit dither, or the wide ocean gradients band visibly.
  float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor = vec4(terraGrade(terraFog(col, vWorld)) + (d - 0.5) / 255.0, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
