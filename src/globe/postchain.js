/**
 * The render-target path, for the effects that need the finished frame as a
 * texture: bloom, chromatic aberration, and an anti-aliasing mode other than
 * the context's own MSAA.
 *
 * While all three are at rest the globe draws straight to the canvas exactly
 * as it always has, and none of this allocates anything. When one is on, the
 * scene goes into a half-float target (multisampled for "msaa", plain for
 * "none" and "fxaa"), the bloom is a threshold and two blurred levels, and a
 * composite writes premultiplied colour and alpha to the canvas — so the CSS
 * sky behind the transparent canvas keeps showing through, and a glow off
 * the limb brightens it rather than painting over it.
 *
 * Tone mapping and the output colour space are applied once, in the
 * composite: three skips them for anything drawn into a render target.
 */
import {
  HalfFloatType,
  LinearSRGBColorSpace,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from "three";

import { STYLE } from "../style/styleConfig.js";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BRIGHT = /* glsl */ `
uniform sampler2D tSrc;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tSrc, vUv);
  float l = max(max(c.r, c.g), c.b);
  gl_FragColor = vec4(c.rgb * smoothstep(uThreshold, uThreshold + 0.25, l), 1.0);
}`;

const BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
  c += texture2D(tSrc, vUv + uStep * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv - uStep * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv + uStep * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(tSrc, vUv - uStep * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE = /* glsl */ `
uniform sampler2D tBase;
uniform sampler2D tBloomA;
uniform sampler2D tBloomB;
uniform float uBloom;
uniform float uCA;
uniform float uFxaa;
uniform vec2 uTexel;
varying vec2 vUv;

const vec3 L = vec3(0.299, 0.587, 0.114);

vec4 fxaa(vec2 uv) {
  vec2 px = uTexel;
  vec4 M = texture2D(tBase, uv);
  float lNW = dot(texture2D(tBase, uv + vec2(-1.0, -1.0) * px).rgb, L);
  float lNE = dot(texture2D(tBase, uv + vec2(1.0, -1.0) * px).rgb, L);
  float lSW = dot(texture2D(tBase, uv + vec2(-1.0, 1.0) * px).rgb, L);
  float lSE = dot(texture2D(tBase, uv + vec2(1.0, 1.0) * px).rgb, L);
  float lM = dot(M.rgb, L);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * px;
  vec4 A = 0.5 * (texture2D(tBase, uv + dir * (1.0 / 3.0 - 0.5)) + texture2D(tBase, uv + dir * (2.0 / 3.0 - 0.5)));
  vec4 B = A * 0.5 + 0.25 * (texture2D(tBase, uv - dir * 0.5) + texture2D(tBase, uv + dir * 0.5));
  float lB = dot(B.rgb, L);
  return (lB < lMin || lB > lMax) ? A : B;
}

void main() {
  vec4 base = uFxaa > 0.5 ? fxaa(vUv) : texture2D(tBase, vUv);
  if (uCA > 0.0) {
    vec2 off = (vUv - 0.5) * uCA;
    base.r = texture2D(tBase, vUv + off).r;
    base.b = texture2D(tBase, vUv - off).b;
  }
  vec3 bloom = uBloom > 0.0 ? (texture2D(tBloomA, vUv).rgb + texture2D(tBloomB, vUv).rgb) * uBloom : vec3(0.0);
  vec3 rgb = base.rgb + bloom;
  // Premultiplied out: the glow raises alpha as well, so it lights the sky.
  float a = base.a + max(max(bloom.r, bloom.g), bloom.b) * (1.0 - base.a);
  a = clamp(max(a, max(max(rgb.r, rgb.g), rgb.b)), 0.0, 1.0);
  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const pass = (fragmentShader, uniforms, toneMapped = false) =>
  new ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, blending: NoBlending, depthTest: false, depthWrite: false, toneMapped });

const target = (w, h, { samples = 0, depth = true } = {}) => {
  const t = new WebGLRenderTarget(w, h, { type: HalfFloatType, samples, depthBuffer: depth });
  t.texture.colorSpace = LinearSRGBColorSpace;
  return t;
};

export class PostChain {
  constructor(renderer) {
    this.renderer = renderer;
    this.size = new Vector2();
    this.scene = null;
  }

  /** Whether any effect needs the render-target path this frame. */
  get active() {
    const p = STYLE.post;
    return p.bloom.enabled || p.chromatic.enabled || p.aa !== "msaa";
  }

  #build() {
    this.quad = new Mesh(new PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(this.quad);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bright = pass(BRIGHT, { tSrc: { value: null }, uThreshold: { value: 0.6 } });
    this.blur = pass(BLUR, { tSrc: { value: null }, uStep: { value: new Vector2() } });
    this.composite = pass(
      COMPOSITE,
      {
        tBase: { value: null },
        tBloomA: { value: null },
        tBloomB: { value: null },
        uBloom: { value: 0 },
        uCA: { value: 0 },
        uFxaa: { value: 0 },
        uTexel: { value: new Vector2() },
      },
      true,
    );
    const flat = { depth: false };
    this.half = [target(1, 1, flat), target(1, 1, flat)];
    this.quarter = [target(1, 1, flat), target(1, 1, flat)];
  }

  #ensure(w, h) {
    if (!this.scene) this.#build();
    const samples = STYLE.post.aa === "msaa" ? 4 : 0;
    if (!this.rt || this.rt.samples !== samples) {
      this.rt?.dispose();
      this.rt = target(w, h, { samples });
    }
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    for (const t of this.half) if (t.width !== hw || t.height !== hh) t.setSize(hw, hh);
    const qw = Math.max(1, w >> 2);
    const qh = Math.max(1, h >> 2);
    for (const t of this.quarter) if (t.width !== qw || t.height !== qh) t.setSize(qw, qh);
  }

  #draw(material, out) {
    this.quad.material = material;
    this.renderer.setRenderTarget(out);
    this.renderer.render(this.scene, this.camera);
  }

  #blur(src, tmp, out, radius) {
    this.blur.uniforms.tSrc.value = src.texture;
    this.blur.uniforms.uStep.value.set(radius / tmp.width, 0);
    this.#draw(this.blur, tmp);
    this.blur.uniforms.tSrc.value = tmp.texture;
    this.blur.uniforms.uStep.value.set(0, radius / out.height);
    this.#draw(this.blur, out);
  }

  render(scene, camera) {
    const r = this.renderer;
    const { x: w, y: h } = r.getDrawingBufferSize(this.size);
    this.#ensure(w, h);
    const p = STYLE.post;

    r.setRenderTarget(this.rt);
    r.render(scene, camera);

    const c = this.composite.uniforms;
    c.uBloom.value = 0;
    if (p.bloom.enabled && p.bloom.strength > 0) {
      this.bright.uniforms.tSrc.value = this.rt.texture;
      this.bright.uniforms.uThreshold.value = p.bloom.threshold;
      this.#draw(this.bright, this.half[0]);
      this.#blur(this.half[0], this.half[1], this.half[0], p.bloom.radius);
      this.#blur(this.half[0], this.quarter[1], this.quarter[0], p.bloom.radius * 1.5);
      c.tBloomA.value = this.half[0].texture;
      c.tBloomB.value = this.quarter[0].texture;
      c.uBloom.value = p.bloom.strength;
    }
    c.tBase.value = this.rt.texture;
    c.uCA.value = p.chromatic.enabled ? p.chromatic.amount : 0;
    c.uFxaa.value = p.aa === "fxaa" ? 1 : 0;
    c.uTexel.value.set(1 / w, 1 / h);
    this.#draw(this.composite, null);
  }

  /** Frees the targets while no effect needs them. */
  release() {
    this.rt?.dispose();
    this.rt = null;
    for (const t of [...(this.half || []), ...(this.quarter || [])]) t.setSize(1, 1);
  }
}
