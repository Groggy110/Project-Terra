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

