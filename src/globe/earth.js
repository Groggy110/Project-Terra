/**
 * The three drawn objects and the two grading presets they share.
 *
 * Colour management is switched off on purpose: every material here is custom
 * and the whole grade is authored in gamma space, where a tone curve behaves
 * the way a cartographer expects. Nothing is auto-converted, so the values in
 * THEMES below are literally the values the shader multiplies.
 */
import {
  Color,
  ColorManagement,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  Vector4,
} from "three";

import earthVert from "./shaders/earth.vert.glsl?raw";
import earthFrag from "./shaders/earth.frag.glsl?raw";
import cloudsFrag from "./shaders/clouds.frag.glsl?raw";
import haloVert from "./shaders/halo.vert.glsl?raw";
import haloFrag from "./shaders/halo.frag.glsl?raw";

ColorManagement.enabled = false;

export const THEMES = {
  /**
   * Light: the same lamp, overhead, with enough fill under it that nothing
   * goes black. A form sitting on watercolour paper cannot also have a globe
   * with a brooding shadow gathering at the bottom of it — so the terminator
   * is still there, still top-down, but it bottoms out at a dimmer version of
   * the surface rather than at night.
   */
  light: {
    ocean: { deep: "#2e5779", mid: "#3c6c93", shelf: "#5c90b6" },
    snow: "#f6f9fd",
    atmo: "#cfe2f4",
    land: { gamma: 0.56, sat: 1.22, gain: 1.0, lift: 0.015 },
    relief: 4.2,
    sunMix: 0.7,
    ambient: 0.52,
    termWidth: 0.62,
    termGamma: 1.15,
    night: "#96afc9",
    spec: 0.2,
    fresnel: 0.62,
    fresnelPow: 2.9,
    rimBase: 0.42,
    snowAmt: 0.88,
    facet: { amount: 0.85, scale: 26, tilt: 0.34, flat: 0.5, edge: 0.07, edgeInk: 0.2 },
    // Streamed tiles, brought back to Blue Marble's footing before the land
    // grade above runs over both.
    //
    // Blue Marble is a flat, dark, low-contrast plate and `land.gamma` of 0.56
    // exists to open it up. A true-colour tile arrives already opened up, and
    // running the same curve over it a second time is what turned Bangkok
    // milky — a city with no blacks in it, behind what looked like haze.
    //
    // So most of the curve comes back out — but not all of it, and less here
    // than in the night preset: net gamma 0.70 and a gain over one, because
    // this page is paper. Matched honestly to the imagery the light theme came
    // out *darker* than the dark one, which is the single thing a light theme
    // may not be; what it wants is the aerial as it would be printed, opened
    // up and a shade off full colour.
    detail: { gamma: 1.25, sat: 0.95, gain: 1.12, lift: 0.0, sea: 0.4 },
    clouds: { tint: "#ffffff", shadow: "#dceaf6", opacity: 0.27, sunMix: 0.45, lo: 0.43, hi: 0.96, gamma: 1.0, fade: 0 },
    halo: { inner: "#a8cdf0", outer: "#e8f1fa", strength: 0.7, spread: 0.1, topBias: 0.5, falloff: 1.0, bloom: 0.18, bloomSpread: 0.42 },
    // Straight up the screen. Not a world direction — see globe.js.
    sunView: [0, 0.97, 0.24],
    // The portrait. At the whole-globe view — the entrance, under the
    // headline — the planet is the picture rather than the map, and it can
    // afford to be graded like one: deeper, richer water, the haze pulled
    // back to a bright rim at the limb instead of a milky veil over the disc,
    // crisp white weather, a glint off the sea and a glow round the whole
    // silhouette. Blended in by zoom (globe.js), gone by WORK, so the working
    // map keeps the preset above untouched.
    hero: {
      ocean: { deep: "#133f6d", mid: "#1c5c97", shelf: "#3f93c8" },
      atmo: "#dcecfb",
      land: { sat: 1.42, gain: 1.07 },
      relief: 5.8,
      ambient: 0.6,
      spec: 0.36,
      fresnel: 0.78,
      fresnelPow: 4.4,
      rimBase: 0.72,
      // `real` swaps the synthetic sheet for the NASA photograph; realLo/Hi
      // are where its grey floor ends and where it is solid cloud.
      clouds: { opacity: 0.9, shadow: "#c9d8e8", real: 1, realLo: 0.19, realHi: 0.82 },
      halo: { inner: "#ffffff", outer: "#b6d6f4", strength: 1.3, spread: 0.07, topBias: 0.82, falloff: 0.7, bloom: 0.5, bloomSpread: 0.36 },
    },
  },

  /**
   * Dark: the reference frame — a planet photographed from orbit against
   * black, with the sun not overhead but *behind and above* it.
   *
   * That last part is what the whole preset turns on. A lamp in front of the
   * globe lights the disc you are looking at and leaves only a sliver of
   * night at the bottom; a lamp behind its top edge throws the terminator up
   * across the visible face, so the southern third falls away into nothing
   * and the top limb goes white-hot where the light grazes the atmosphere.
   * Hence the negative z in sunView, and hence a terminator that is wide
   * (it has most of the disc to cross) rather than the tight one a
   * front-lit globe wants.
   */
  dark: {
    ocean: { deep: "#072238", mid: "#16608f", shelf: "#3fabdc" },
    snow: "#e4eefa",
    atmo: "#3f93e6",
    land: { gamma: 0.5, sat: 1.62, gain: 1.14, lift: 0.005 },
    // Strong. The reference reads as embossed relief — dune fields and
    // ranges lit from the side — not as a photograph laid on a ball.
    relief: 7.6,
    sunMix: 1.0,
    // Not zero: a globe whose underside is literally black loses its
    // silhouette against a near-black sky, and the reference keeps a faint
    // blue reading of the terrain all the way round.
    ambient: 0.04,
    termWidth: 0.74,
    termGamma: 1.35,
    night: "#04101d",
    spec: 0.3,
    fresnel: 0.78,
    fresnelPow: 2.0,
    // Nearly nothing away from the light: the reference's lower limb is
    // black, with no outline drawn round the dark side of the disc.
    rimBase: 0.0,
    snowAmt: 0.22,
    // A whisper. The land in the reference is painted relief with a fine
    // crazing over the vegetation, not a mosaic of tiles — so the cells are
    // small, barely tilted, and keep the imagery's own colour instead of
    // flattening to one per cell.
    facet: { amount: 0.7, scale: 74, tilt: 0.08, flat: 0.06, edge: 0.055, edgeInk: -0.5 },
    // Same idea against a much harder grade: gamma 0.5, saturation 1.62 and a
    // gain over one would turn a satellite tile into a poster. Net: gamma
    // 0.95, saturation 1.26, gain 1.06 — the imagery as shot, with the
    // theme's colour laid over it rather than through it twice.
    detail: { gamma: 1.9, sat: 0.78, gain: 0.93, lift: 0.0, sea: 0.5 },
    clouds: { tint: "#ffffff", shadow: "#0a1524", opacity: 0.98, sunMix: 0.72, lo: 0.42, hi: 0.95, gamma: 2.2, fade: 1 },
    halo: { inner: "#eaf5ff", outer: "#4180c6", strength: 1.9, spread: 0.058, topBias: 0.006, falloff: 4.0, bloom: 1.0, bloomSpread: 1.4 },
    // Behind and above, a touch to the left — see the note above.
    sunView: [-0.16, 0.982, -0.1],
  },
};

function prepare(texture, { mips = true } = {}) {
  // The shader derives uv from latitude, so v = 0 is the north pole and must
  // land on the image's first row. three's flipY default puts v = 0 at the
  // last row instead - the convention geometry UVs want - which would sample
  // the mirrored hemisphere: Europe would read the Southern Ocean.
  texture.flipY = false;
  texture.magFilter = LinearFilter;
  texture.minFilter = mips ? LinearMipmapLinearFilter : LinearFilter;
  texture.generateMipmaps = mips;
  texture.anisotropy = 8;
  return texture;
}

export function createEarth({ base, aux, lines, mask, baseInk, window, detail, detailWindow }) {
  prepare(base);
  prepare(aux);

  const uniforms = {
    uBase: { value: base },
    uAux: { value: aux },
    uLines: { value: lines },
    uMask: { value: mask },
    uBaseInk: { value: baseInk },
    uDetail: { value: detail ?? null },
    uWindow: { value: window ?? new Vector4(0, 0, 1, 1) },
    uDetailWindow: { value: detailWindow ?? new Vector4(0, 0, 1, 1) },
    uDetailMix: { value: 0 },
    uDetailGamma: { value: 1.5 },
    uDetailSat: { value: 0.8 },
    uDetailGain: { value: 1 },
    uDetailLift: { value: 0 },
    uDetailSea: { value: 0.4 },
    uDetailWater: { value: 0 },
    uAuxTexel: { value: new Vector2(1 / 4096, 1 / 2048) },
    uAuxSize: { value: new Vector2(4096, 2048) },
    uHasWindow: { value: 0 },
    uSun: { value: new Vector3(0.4, 0.5, 0.76) },
    uDeep: { value: new Color() },
    uMid: { value: new Color() },
    uShelf: { value: new Color() },
    uSnow: { value: new Color() },
    uAtmo: { value: new Color() },
    uLandGamma: { value: 0.8 },
    uLandSat: { value: 0.88 },
    uLandGain: { value: 1.07 },
    uLandLift: { value: 0.03 },
    uRelief: { value: 4 },
    uSunMix: { value: 0.34 },
    uSpec: { value: 0.26 },
    uFresnel: { value: 0.56 },
    uLineMix: { value: 1 },
    uSnowAmt: { value: 0.86 },
    uNight: { value: new Color("#22405f") },
    uAmbient: { value: 0.06 },
    uTermWidth: { value: 0.6 },
    uTermGamma: { value: 1.5 },
    uFresnelPow: { value: 2.6 },
    uRimBase: { value: 0.3 },
    uFacet: { value: 1 },
    uFacetScale: { value: 26 },
    uFacetTilt: { value: 0.4 },
    uFacetFlat: { value: 0.6 },
    uFacetEdge: { value: 0.075 },
    uFacetEdgeInk: { value: 0.3 },
    uDebug: { value: 0 },
  };

  if (aux?.image) {
    const w = aux.image.width || 4096;
    const h = aux.image.height || 2048;
    uniforms.uAuxTexel.value.set(1 / w, 1 / h);
    uniforms.uAuxSize.value.set(w, h);
  }

  const material = new ShaderMaterial({
    uniforms,
    vertexShader: earthVert,
    fragmentShader: earthFrag,
  });

  // The surface detail comes from the per-pixel uv, not from tessellation, so
  // this is only ever about shape. 128 segments held the silhouette to well
  // under a pixel at the old close stop; at ninety kilometres up a quad spans
  // three hundred kilometres of ground and sags two below the true sphere,
  // which is a visible error against a camera that close. 256 costs 65k
  // triangles — nothing — and puts it back under a quarter of that.
  const mesh = new Mesh(new SphereGeometry(1, 256, 128), material);
  mesh.name = "earth";
  mesh.renderOrder = 0;
  return { mesh, material, uniforms };
}

export function createClouds({ clouds }) {
  prepare(clouds);
  const uniforms = {
    uClouds: { value: clouds },
    uCloudsReal: { value: clouds },
    uRealMix: { value: 0 },
    uRealLo: { value: 0.2 },
    uRealHi: { value: 0.9 },
    uSun: { value: new Vector3(0.4, 0.5, 0.76) },
    uTint: { value: new Color() },
    uShadow: { value: new Color() },
    uOpacity: { value: 0.6 },
    uDrift: { value: 0 },
    uSunMix: { value: 0.55 },
    uAmbient: { value: 0.06 },
    uTermWidth: { value: 0.6 },
    uTermGamma: { value: 1.5 },
    // Where the cloud texture becomes cloud. A narrow pair gives the crisp,
    // well-defined cumulus the dark reference shows; a wide one gives the
    // soft haze the light theme wants.
    uLo: { value: 0.43 },
    uHi: { value: 0.96 },
    uGamma: { value: 1.0 },
    uFade: { value: 0.0 },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: earthVert,
    fragmentShader: cloudsFrag,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new Mesh(new SphereGeometry(1.0055, 128, 64), material);
  mesh.name = "clouds";
  mesh.renderOrder = 1;
  return { mesh, material, uniforms };
}

export function createHalo() {
  const uniforms = {
    uCentre: { value: new Vector2() },
    uResolution: { value: new Vector2() },
    uRadius: { value: 100 },
    uInner: { value: new Color() },
    uOuter: { value: new Color() },
    uStrength: { value: 0.6 },
    uSpread: { value: 0.3 },
    uLightDir: { value: new Vector2(0, -1) },
    uTopBias: { value: 0.3 },
    uFalloff: { value: 1.0 },
    uBloom: { value: 0.4 },
    uBloomSpread: { value: 0.55 },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: haloVert,
    fragmentShader: haloFrag,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(new PlaneGeometry(2, 2), material);
  mesh.name = "halo";
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return { mesh, material, uniforms };
}

const colours = new Map();
const colour = (hex) => {
  let c = colours.get(hex);
  if (!c) colours.set(hex, (c = new Color(hex)));
  return c;
};
const mixNum = (a, b, w) => (b === undefined ? a : a + (b - a) * w);
const mixCol = (target, a, b, w) => (b === undefined ? target.copy(colour(a)) : target.lerpColors(colour(a), colour(b), w));

/**
 * Blends a preset toward its `hero` grade by `w` (1 at the whole-globe view,
 * 0 once the camera is working). Called every frame; a preset without a hero
 * block is left exactly as applyTheme set it.
 *
 * Cloud opacity, sunMix and the facets are not touched here: the frame loop
 * already drives those by zoom, and takes the hero cloud opacity from
 * heroCloudOpacity() instead.
 */
export function applyHero(t, w, earth, clouds, halo) {
  const h = t.hero;
  if (!h) return;
  const u = earth.uniforms;
  mixCol(u.uDeep.value, t.ocean.deep, h.ocean?.deep, w);
  mixCol(u.uMid.value, t.ocean.mid, h.ocean?.mid, w);
  mixCol(u.uShelf.value, t.ocean.shelf, h.ocean?.shelf, w);
  mixCol(u.uAtmo.value, t.atmo, h.atmo, w);
  u.uLandSat.value = mixNum(t.land.sat, h.land?.sat, w);
  u.uLandGain.value = mixNum(t.land.gain, h.land?.gain, w);
  u.uRelief.value = mixNum(t.relief, h.relief, w);
  u.uAmbient.value = mixNum(t.ambient, h.ambient, w);
  u.uSpec.value = mixNum(t.spec, h.spec, w);
  u.uFresnel.value = mixNum(t.fresnel, h.fresnel, w);
  u.uFresnelPow.value = mixNum(t.fresnelPow, h.fresnelPow, w);
  u.uRimBase.value = mixNum(t.rimBase, h.rimBase, w);

  const c = clouds.uniforms;
  const hc = h.clouds || {};
  mixCol(c.uShadow.value, t.clouds.shadow, hc.shadow, w);
  c.uLo.value = mixNum(t.clouds.lo ?? 0.43, hc.lo, w);
  c.uHi.value = mixNum(t.clouds.hi ?? 0.96, hc.hi, w);
  c.uGamma.value = mixNum(t.clouds.gamma ?? 1.0, hc.gamma, w);
  c.uAmbient.value = u.uAmbient.value;
  // Only once the photograph has actually arrived (globe.js flips
  // realReady); until then the synthetic sheet stands in.
  c.uRealMix.value = (hc.real ?? 0) * w * (clouds.realReady ?? 0);
  c.uRealLo.value = hc.realLo ?? 0.2;
  c.uRealHi.value = hc.realHi ?? 0.9;

  const g = halo.uniforms;
  const hh = h.halo || {};
  mixCol(g.uInner.value, t.halo.inner, hh.inner, w);
  mixCol(g.uOuter.value, t.halo.outer, hh.outer, w);
  g.uStrength.value = mixNum(t.halo.strength, hh.strength, w);
  g.uSpread.value = mixNum(t.halo.spread, hh.spread, w);
  g.uTopBias.value = mixNum(t.halo.topBias, hh.topBias, w);
  g.uFalloff.value = mixNum(t.halo.falloff ?? 1.0, hh.falloff, w);
  g.uBloom.value = mixNum(t.halo.bloom, hh.bloom, w);
  g.uBloomSpread.value = mixNum(t.halo.bloomSpread, hh.bloomSpread, w);
}

/** The cloud sheet's base opacity at hero weight `w`. */
export function heroCloudOpacity(t, w) {
  return mixNum(t.clouds.opacity, t.hero?.clouds?.opacity, w);
}

/** Pushes a preset into the live uniforms; called on every theme change. */
export function applyTheme(name, earth, clouds, halo) {
  const t = THEMES[name] || THEMES.light;
  const u = earth.uniforms;
  u.uDeep.value.set(t.ocean.deep);
  u.uMid.value.set(t.ocean.mid);
  u.uShelf.value.set(t.ocean.shelf);
  u.uSnow.value.set(t.snow);
  u.uAtmo.value.set(t.atmo);
  u.uLandGamma.value = t.land.gamma;
  u.uLandSat.value = t.land.sat;
  u.uLandGain.value = t.land.gain;
  u.uLandLift.value = t.land.lift;
  u.uRelief.value = t.relief;
  u.uSunMix.value = t.sunMix;
  u.uSpec.value = t.spec;
  u.uFresnel.value = t.fresnel;
  u.uFresnelPow.value = t.fresnelPow;
  u.uRimBase.value = t.rimBase;
  u.uSnowAmt.value = t.snowAmt;
  u.uNight.value.set(t.night);
  u.uAmbient.value = t.ambient;
  u.uTermWidth.value = t.termWidth;
  u.uTermGamma.value = t.termGamma;
  u.uFacet.value = t.facet.amount;
  u.uFacetScale.value = t.facet.scale;
  u.uFacetTilt.value = t.facet.tilt;
  u.uFacetFlat.value = t.facet.flat;
  u.uFacetEdge.value = t.facet.edge;
  u.uFacetEdgeInk.value = t.facet.edgeInk;
  const d = t.detail || {};
  u.uDetailGamma.value = d.gamma ?? 1.5;
  u.uDetailSat.value = d.sat ?? 0.8;
  u.uDetailGain.value = d.gain ?? 1;
  u.uDetailLift.value = d.lift ?? 0;
  u.uDetailSea.value = d.sea ?? 0.4;

  const c = clouds.uniforms;
  c.uTint.value.set(t.clouds.tint);
  c.uShadow.value.set(t.clouds.shadow);
  c.uSunMix.value = t.clouds.sunMix;
  c.uLo.value = t.clouds.lo ?? 0.43;
  c.uHi.value = t.clouds.hi ?? 0.96;
  c.uGamma.value = t.clouds.gamma ?? 1.0;
  c.uFade.value = t.clouds.fade ?? 0.0;
  c.uRealMix.value = 0;
  c.uAmbient.value = t.ambient;
  c.uTermWidth.value = t.termWidth;
  c.uTermGamma.value = t.termGamma;

  const h = halo.uniforms;
  h.uInner.value.set(t.halo.inner);
  h.uOuter.value.set(t.halo.outer);
  h.uStrength.value = t.halo.strength;
  h.uSpread.value = t.halo.spread;
  h.uTopBias.value = t.halo.topBias;
  h.uFalloff.value = t.halo.falloff ?? 1.0;
  h.uBloom.value = t.halo.bloom;
  h.uBloomSpread.value = t.halo.bloomSpread;

  return t;
}

