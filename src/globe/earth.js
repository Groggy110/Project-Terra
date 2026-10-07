/**
 * The drawn objects, and the one function that grades them from STYLE.
 *
 * Colour management is switched off on purpose: every material here is custom
 * and the whole grade is authored in gamma space, where a tone curve behaves
 * the way a cartographer expects. Nothing is auto-converted, so the colours in
 * src/style/styleConfig.js are literally the values the shader multiplies.
 */
import {
  Color,
  ColorManagement,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  PlaneGeometry,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  Matrix3,
  Matrix4,
  Vector2,
  Vector3,
  Vector4,
} from "three";

import earthVert from "./shaders/earth.vert.glsl?raw";
import earthFrag from "./shaders/earth.frag.glsl?raw";
import cloudsFrag from "./shaders/clouds.frag.glsl?raw";
import haloVert from "./shaders/halo.vert.glsl?raw";
import haloFrag from "./shaders/halo.frag.glsl?raw";
import gradeGlsl from "./shaders/grade.glsl?raw";
import effectsGlsl from "./shaders/effects.glsl?raw";
import postFrag from "./shaders/post.frag.glsl?raw";
import { DEG } from "./geo.js";

ColorManagement.enabled = false;

export function prepare(texture, { mips = true } = {}) {
  // The shader derives uv from latitude, so v = 0 is the north pole and must
  // land on the image's first row. three's flipY default puts v = 0 at the
  // last row instead - the convention geometry UVs want - which would sample
  // the mirrored hemisphere: Europe would read the Southern Ocean.
  texture.flipY = false;
  texture.magFilter = LinearFilter;
  texture.minFilter = mips ? LinearMipmapLinearFilter : LinearFilter;
  texture.generateMipmaps = mips;
  texture.anisotropy = texture.userData?.anisotropy ?? 8;
  return texture;
}

/**
 * The final grade's uniforms, shared by reference between the surface and the
 * cloud sheet, so one write grades both.
 */
function createGradeUniforms() {
  return {
    uGrade: { value: 0 },
    uGradeMix: { value: 1 },
    uGradeBrightness: { value: 0 },
    uGradeContrast: { value: 1 },
    uGradeSaturation: { value: 1 },
    uGradeVibrance: { value: 0 },
    uGradeHue: { value: 0 },
    uGradeTemperature: { value: 0 },
    uGradeTint: { value: 0 },
    uGradeLift: { value: new Vector3() },
    uGradeGamma: { value: new Vector3() },
    uGradeGain: { value: new Vector3() },
  };
}

/** Extra lights and fog, shared by reference between the surface and the clouds. */
function createEffectUniforms() {
  return {
    uAmbientLight: { value: new Vector3() },
    uHemiOn: { value: 0 },
    uHemiSky: { value: new Vector3() },
    uHemiGround: { value: new Vector3() },
    uFillLight: { value: new Vector3() },
    uFillDir: { value: new Vector3(0, 0, 1) },
    uRimLight: { value: new Vector3() },
    uRimDir: { value: new Vector3(0, 0, -1) },
    uRimPower: { value: 3 },
    uFog: { value: 0 },
    uFogMode: { value: 0 },
    uFogColor: { value: new Color() },
    uFogNear: { value: 2.6 },
    uFogFar: { value: 5.5 },
    uFogDensity: { value: 0.3 },
  };
}

/** One black texel, so the night-lights sampler is never unbound. */
const BLACK = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
BLACK.needsUpdate = true;

export function createEarth(
  { base, aux, lines, mask, baseInk, window, detail, detailWindow },
  { segments = 256, grade = createGradeUniforms(), effects = createEffectUniforms() } = {},
) {
  prepare(base);
  prepare(aux);

  const uniforms = {
    ...grade,
    ...effects,
    uLandTint: { value: new Color(1, 1, 1) },
    uLandTintAmt: { value: 0 },
    uEmissive: { value: new Vector3() },
    uEmissiveNight: { value: 1 },
    uGrid: { value: 0 },
    uGridColor: { value: new Color(1, 1, 1) },
    uGridSpacing: { value: 15 },
    uGridWidth: { value: 1 },
    uNightTex: { value: BLACK },
    uNightLights: { value: new Vector3() },
    uBase: { value: base },
    uAux: { value: aux },
    uLines: { value: lines },
    uMask: { value: mask },
    uBaseInk: { value: baseInk },
    uDetail: { value: detail ?? null },
    uWindow: { value: window ?? new Vector4(0, 0, 1, 1) },
    uDetailWindow: { value: detailWindow ?? new Vector4(0, 0, 1, 1) },
    uDetailMix: { value: 0 },
    uPrec: { value: 0 },
    uViewport: { value: new Vector2(1, 1) },
    uInvProj: { value: new Matrix4() },
    uCamRot: { value: new Matrix3() },
    uRef: { value: new Vector3(1, 0, 0) },
    uRel: { value: new Vector3() },
    uRelC: { value: 0 },
    uRefMerc: { value: new Vector4() },
    uDetailGamma: { value: 1.5 },
    uDetailShadowGamma: { value: 1.5 },
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
    uSpecPower: { value: 46 },
    uSpecColor: { value: new Color() },
    uHillLight: { value: new Vector3(-0.6, 0.6, 0.75) },
    uShadeMin: { value: 0.42 },
    uShadeMax: { value: 1.44 },
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
    fragmentShader: gradeGlsl + effectsGlsl + earthFrag,
  });

  // The surface detail comes from the per-pixel uv, not from tessellation, so
  // this is only ever about shape. 128 segments held the silhouette to well
  // under a pixel at the old close stop; at ninety kilometres up a quad spans
  // three hundred kilometres of ground and sags two below the true sphere,
  // which is a visible error against a camera that close. 256 costs 65k
  // triangles — nothing — and puts it back under a quarter of that.
  const mesh = new Mesh(sphere(1, segments), material);
  mesh.name = "earth";
  mesh.renderOrder = 0;
  return { mesh, material, uniforms, grade, effects, segments };
}

/** A unit-ish sphere at `segments` around and half that pole to pole. */
export function sphere(radius, segments) {
  const w = Math.max(8, Math.round(segments));
  return new SphereGeometry(radius, w, Math.max(4, Math.round(w / 2)));
}

export function createClouds(
  { clouds },
  { segments = 128, grade = createGradeUniforms(), effects = createEffectUniforms() } = {},
) {
  prepare(clouds);
  // The sheet drifts east (uDrift), so its u runs past 1 at the antimeridian.
  // Clamped, the texture's last column was smeared across that gap as a fan
  // of streaks along the parallels; it has to wrap.
  clouds.wrapS = RepeatWrapping;
  const uniforms = {
    ...grade,
    ...effects,
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
    fragmentShader: gradeGlsl + effectsGlsl + cloudsFrag,
    transparent: true,
    depthWrite: false,
  });
  // Built at radius 1 and lifted by scale, so the altitude can change without
  // a new geometry; the shader only reads the normal.
  const mesh = new Mesh(sphere(1, segments), material);
  mesh.name = "clouds";
  mesh.renderOrder = 1;
  return { mesh, material, uniforms, segments };
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
    uRimPow: { value: 3.2 },
    uSpillPow: { value: 1.7 },
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

/** Vignette and grain, drawn last over the whole canvas. Hidden while both are off. */
export function createPost() {
  const uniforms = {
    uResolution: { value: new Vector2(1, 1) },
    uVignette: { value: 0 },
    uVigRadius: { value: 0.75 },
    uVigSoft: { value: 0.45 },
    uVigColor: { value: new Color() },
    uGrain: { value: 0 },
    uGrainSize: { value: 1.5 },
    uTime: { value: 0 },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: haloVert,
    fragmentShader: postFrag,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new Mesh(new PlaneGeometry(2, 2), material);
  mesh.name = "post";
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.visible = false;
  return { mesh, material, uniforms };
}

/**
 * A direction from two angles, in degrees. View space for the sun (azimuth 0
 * toward the viewer, 90 to screen right); east/north/up for the hillshade
 * (azimuth clockwise from north), which is the same formula with the axes
 * named differently.
 */
export function angleVector(azimuth, elevation, out = new Vector3()) {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  return out.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
}

/** A colour scaled by an intensity, as the vec3 the shaders add. */
const scaled = (hex, k, out) => {
  const c = new Color(hex);
  return out.set(c.r * k, c.g * k, c.b * k);
};

const lgg = (w, out) => {
  const c = new Color(w.color);
  return out.set(c.r * w.strength, c.g * w.strength, c.b * w.strength);
};

/**
 * Pushes one theme of STYLE, plus the shared lighting and grade, into the
 * live uniforms. Called on every theme change and every restyle.
 */
export function applyTheme(t, shared, earth, clouds, halo) {
  const { light, surface: sf, atmosphere: at } = t;
  const u = earth.uniforms;
  u.uDeep.value.set(sf.ocean.deep);
  u.uMid.value.set(sf.ocean.mid);
  u.uShelf.value.set(sf.ocean.shelf);
  u.uSnow.value.set(sf.snow);
  u.uAtmo.value.set(at.color);
  u.uLandGamma.value = sf.land.gamma;
  u.uLandSat.value = sf.land.sat;
  u.uLandGain.value = sf.land.gain;
  u.uLandLift.value = sf.land.lift;
  u.uRelief.value = sf.relief;
  u.uSunMix.value = light.sunMix;
  u.uSpec.value = light.spec;
  u.uFresnel.value = at.enabled ? at.fresnel : 0;
  u.uFresnelPow.value = at.fresnelPow;
  u.uRimBase.value = at.rimBase;
  u.uSnowAmt.value = sf.snowAmt;
  u.uNight.value.set(light.night);
  u.uAmbient.value = light.ambient;
  u.uTermWidth.value = light.termWidth;
  u.uTermGamma.value = light.termGamma;
  u.uFacet.value = sf.facet.amount;
  u.uFacetScale.value = sf.facet.scale;
  u.uFacetTilt.value = sf.facet.tilt;
  u.uFacetFlat.value = sf.facet.flat;
  u.uFacetEdge.value = sf.facet.edge;
  u.uFacetEdgeInk.value = sf.facet.edgeInk;
  u.uDetailGamma.value = sf.detail.gamma;
  u.uDetailShadowGamma.value = sf.detail.shadowGamma ?? sf.detail.gamma;
  u.uDetailSat.value = sf.detail.sat;
  u.uDetailGain.value = sf.detail.gain;
  u.uDetailLift.value = sf.detail.lift;
  u.uDetailSea.value = sf.detail.sea;
  u.uLandTint.value.set(sf.landTint);
  u.uLandTintAmt.value = sf.landTintAmt;
  scaled(sf.emissive, sf.emissiveIntensity, u.uEmissive.value);
  u.uEmissiveNight.value = sf.emissiveNightOnly ? 1 : 0;

  const gs = shared.globe;
  u.uGrid.value = gs.graticule.enabled ? gs.graticule.opacity : 0;
  u.uGridColor.value.set(gs.graticule.color);
  u.uGridSpacing.value = Math.max(gs.graticule.spacing, 0.5);
  u.uGridWidth.value = gs.graticule.width;
  scaled(gs.nightLights.color, gs.nightLights.enabled ? gs.nightLights.intensity : 0, u.uNightLights.value);

  // Lights and fog (shared with the clouds by reference).
  const e = earth.effects;
  const L = shared.lighting;
  scaled(L.ambient.color, L.ambient.intensity, e.uAmbientLight.value);
  const hemi = L.hemisphere;
  e.uHemiOn.value = hemi.intensity > 0 ? 1 : 0;
  scaled(hemi.sky, hemi.intensity, e.uHemiSky.value);
  scaled(hemi.ground, hemi.intensity, e.uHemiGround.value);
  scaled(L.fill.color, L.fill.intensity, e.uFillLight.value);
  scaled(L.rim.color, L.rim.intensity, e.uRimLight.value);
  e.uRimPower.value = L.rim.power;
  const fog = shared.fog;
  e.uFog.value = fog.enabled ? fog.amount : 0;
  e.uFogMode.value = fog.mode === "exp2" ? 1 : 0;
  e.uFogColor.value.set(fog.color);
  e.uFogNear.value = fog.near;
  e.uFogFar.value = Math.max(fog.far, fog.near + 1e-3);
  e.uFogDensity.value = fog.density;

  const lt = shared.lighting;
  u.uSpecPower.value = lt.specPower;
  u.uSpecColor.value.set(lt.specColor);
  angleVector(lt.hillshade.azimuth, lt.hillshade.elevation, u.uHillLight.value);
  // angleVector returns x east, y up, z "north"; the shader wants east/north/up.
  const hl = u.uHillLight.value;
  hl.set(hl.x, hl.z, hl.y);
  u.uShadeMin.value = lt.hillshade.min;
  u.uShadeMax.value = lt.hillshade.max;

  const cl = t.clouds;
  const c = clouds.uniforms;
  c.uTint.value.set(cl.tint);
  c.uShadow.value.set(cl.shadow);
  c.uSunMix.value = cl.sunMix;
  c.uLo.value = cl.lo;
  c.uHi.value = cl.hi;
  c.uGamma.value = cl.gamma;
  c.uFade.value = cl.fade;
  c.uRealLo.value = cl.realLo;
  c.uRealHi.value = cl.realHi;
  c.uAmbient.value = light.ambient;
  c.uTermWidth.value = light.termWidth;
  c.uTermGamma.value = light.termGamma;

  const hs = at.halo;
  const h = halo.uniforms;
  h.uInner.value.set(hs.inner);
  h.uOuter.value.set(hs.outer);
  h.uStrength.value = hs.strength;
  h.uSpread.value = hs.spread;
  h.uTopBias.value = hs.topBias;
  h.uFalloff.value = hs.falloff;
  h.uBloom.value = hs.bloom;
  h.uBloomSpread.value = hs.bloomSpread;
  h.uRimPow.value = hs.rimPower;
  h.uSpillPow.value = hs.spillPower;

  const gr = shared.grade;
  const g = earth.grade;
  g.uGrade.value = gr.enabled ? 1 : 0;
  g.uGradeMix.value = gr.mix;
  g.uGradeBrightness.value = gr.brightness;
  g.uGradeContrast.value = gr.contrast;
  g.uGradeSaturation.value = gr.saturation;
  g.uGradeVibrance.value = gr.vibrance;
  g.uGradeHue.value = gr.hue * DEG;
  g.uGradeTemperature.value = gr.temperature;
  g.uGradeTint.value = gr.tint;
  lgg(gr.lift, g.uGradeLift.value);
  lgg(gr.gamma, g.uGradeGamma.value);
  lgg(gr.gain, g.uGradeGain.value);

  return t;
}


export { createGradeUniforms, createEffectUniforms, BLACK };
