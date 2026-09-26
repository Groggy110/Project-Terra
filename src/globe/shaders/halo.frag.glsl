precision highp float;

// Drawn as a full-screen pass after the globe. The silhouette radius arrives
// in pixels from the same projection the label layer uses, so the halo sits
// exactly on the limb at any zoom without depth-fighting the sphere.
uniform vec2 uCentre;
uniform vec2 uResolution;
uniform float uRadius;
uniform vec3 uInner;
uniform vec3 uOuter;
uniform float uStrength;
uniform float uSpread;

// Where the light is, in screen space, y pointing down. Fed from the same
// view-space vector the surface shader is lit by, so the bloom and the lit
// hemisphere can never drift apart.
uniform vec2 uLightDir;
uniform float uTopBias;    // how much of the rim survives away from the light
uniform float uFalloff;    // how fast it dies away from the light: 1 gentle
uniform float uBloom;      // strength of the wide spill
uniform float uBloomSpread;// how far that spill reaches
uniform float uRimPow;     // how hard the rim is edged: higher is thinner
uniform float uSpillPow;   // and the spill

void main() {
  vec2 p = gl_FragCoord.xy;
  p.y = uResolution.y - p.y;
  vec2 rel = (p - uCentre) / max(uRadius, 1.0);
  float d = length(rel);

  // +1 where this pixel sits directly toward the light from the centre of the
  // globe, -1 on the far side of it.
  float toward = d > 0.0001 ? dot(rel / d, normalize(uLightDir)) : 0.0;

  // The angular falloff, and the one number that decides whether this reads
  // as a planet lit from one side or as a ball with a glow drawn round it.
  // A gentle curve keeps a bright rim all the way round the disc, which is
  // right for a globe lit from in front; the reference is lit from behind its
  // top edge, so the rim has to be gone — not dimmer, gone — by the time it
  // reaches the bottom. That is what a high exponent buys.
  float lit = pow(clamp(toward * 0.5 + 0.5, 0.0, 1.0), uFalloff);

  // Nothing over the globe. Placed just inside the limb rather than astride
  // it, so the rim is at full strength exactly where the silhouette is and
  // not half-faded across its brightest pixel.
  float gate = smoothstep(0.978, 0.998, d);

  // Two lobes, because one cannot be both things at once. A single wide
  // falloff wide enough to bloom off the top reads as fog around the whole
  // planet; one tight enough to be a rim has nothing left to spill. So: a
  // narrow bright rim that runs all the way round, and a broad soft spill
  // that only exists on the lit side.
  float rim = pow(1.0 - smoothstep(1.0, 1.0 + uSpread, d), uRimPow);
  float spill = pow(1.0 - smoothstep(1.0, 1.0 + uBloomSpread, d), uSpillPow);

  float a = gate * (rim * uStrength * mix(uTopBias, 1.0, lit) + spill * uBloom * lit * lit);
  if (a < 0.0025) discard;

  // Hot and near-white under the lamp, a saturated blue round the sides. The
  // rim keeps its colour rather than blowing out everywhere it is narrow:
  // without the `lit` term in here the flanks of the disc get the same white
  // core as the top, and the planet ends up ringed in silver.
  vec3 col = mix(uOuter, uInner, pow(rim, 0.8) * mix(0.12, 1.0, lit));
  col = mix(col, uInner, lit * lit * rim * 0.8);
  gl_FragColor = vec4(col, min(a, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
