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
  light: {
    ocean: { deep: "#2e5779", mid: "#3c6c93", shelf: "#5c90b6" },
    snow: "#f6f9fd",
    atmo: "#d2e2f1",
    // A gamma lift, but a gentler one than the surface wants on its own:
    // December imagery puts temperate land near 0.17 luminance, well under
    // the ocean, and the map wants it above without going chalky.
    land: { gamma: 0.56, sat: 1.22, gain: 1.0, lift: 0.015 },
    relief: 4.2,
    sunMix: 0.22,
    spec: 0.2,
    fresnel: 0.5,
    snowAmt: 0.88,
    clouds: { tint: "#ffffff", shadow: "#dceaf6", opacity: 0.27, sunMix: 0.4 },
    halo: { inner: "#c3d9ee", outer: "#eef4f9", strength: 0.55, spread: 0.28 },
    sunView: [-0.3, 0.42, 0.86],
  },
  dark: {
    ocean: { deep: "#0d1f33", mid: "#14304a", shelf: "#22506f" },
    snow: "#c6d6e8",
    atmo: "#14304f",
    land: { gamma: 0.62, sat: 1.1, gain: 0.6, lift: 0.02 },
    relief: 5.0,
    sunMix: 0.78,
    spec: 0.5,
    fresnel: 0.6,
    snowAmt: 0.8,
    clouds: { tint: "#e6eefa", shadow: "#3a5878", opacity: 0.42, sunMix: 0.8 },
    halo: { inner: "#2c62a0", outer: "#0a111c", strength: 0.9, spread: 0.42 },
    sunView: [-0.64, 0.34, 0.69],
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

export function createEarth({ base, aux, lines, mask, baseInk, window }) {
  prepare(base);
  prepare(aux);

  const uniforms = {
    uBase: { value: base },
    uAux: { value: aux },
    uLines: { value: lines },
    uMask: { value: mask },
    uBaseInk: { value: baseInk },
    uWindow: { value: window ?? new Vector4(0, 0, 1, 1) },
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

  // 128 segments keeps the silhouette smooth to well under a pixel; the
  // surface detail comes from the per-pixel uv, not from tessellation.
  const mesh = new Mesh(new SphereGeometry(1, 128, 64), material);
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
  u.uSnowAmt.value = t.snowAmt;

  const c = clouds.uniforms;
  c.uTint.value.set(t.clouds.tint);
  c.uShadow.value.set(t.clouds.shadow);
  c.uSunMix.value = t.clouds.sunMix;

  const h = halo.uniforms;
  h.uInner.value.set(t.halo.inner);
  h.uOuter.value.set(t.halo.outer);
  h.uStrength.value = t.halo.strength;
  h.uSpread.value = t.halo.spread;

  return t;
}

