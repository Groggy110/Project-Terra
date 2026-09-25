precision highp float;

uniform sampler2D uClouds;
// NASA's Blue Marble cloud composite: a real day's weather, storm spirals and
// all, used for the whole-globe portrait. Its own ramp, because it is a
// photograph with a grey floor rather than a synthesised 0..1 sheet.
uniform sampler2D uCloudsReal;
uniform float uRealMix;     // 0 synthetic sheet, 1 the photograph
uniform float uRealLo;
uniform float uRealHi;
uniform vec3 uSun;
uniform vec3 uTint;
uniform vec3 uShadow;
uniform float uOpacity;
uniform float uDrift;
uniform float uSunMix;
uniform float uAmbient;
uniform float uTermWidth;
uniform float uTermGamma;
uniform float uLo;          // where the sheet starts being cloud
uniform float uHi;          // where it is solid
uniform float uGamma;       // >1 collapses the thin edges, leaving discrete puffs
uniform float uFade;        // 1: the sheet goes out with the light as well as dark

varying vec3 vNormalW;
varying vec3 vWorld;

const float PI = 3.141592653589793;

vec2 fixSeam(vec2 d) {
  d.x -= sign(d.x) * step(0.5, abs(d.x));
  return d;
}

void main() {
  vec3 n = normalize(vNormalW);
  float lonRad = atan(-n.z, n.x);
  float latRad = asin(clamp(n.y, -1.0, 1.0));
  vec2 uv = vec2(lonRad / (2.0 * PI) + 0.5 + uDrift, 0.5 - latRad / PI);

  vec2 ddx = fixSeam(dFdx(uv));
  vec2 ddy = fixSeam(dFdy(uv));

  float a = texture2DGradEXT(uClouds, uv, ddx, ddy).r;
  // The threshold pair alone gives a sheet: everything between lo and hi
  // survives as thin cloud, and on a texture this soft that is most of the
  // globe, veiled. The gamma is what turns a sheet into weather — it keeps
  // the dense cores and takes the skirts to nothing, so what is left reads as
  // separate cumulus with sky between them rather than as haze.
  a = pow(smoothstep(uLo, uHi, a), uGamma);
  if (uRealMix > 0.002) {
    float r = texture2DGradEXT(uCloudsReal, uv, ddx, ddy).r;
    a = mix(a, smoothstep(uRealLo, uRealHi, r), uRealMix);
  }
  if (a < 0.004) discard;

  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSun);
  float ndv = clamp(dot(n, V), 0.0, 1.0);

  // The same authored terminator the surface uses, so cloud and ground cross
  // into shadow together rather than the sheet staying lit over a dark globe.
  float ndl = dot(n, L);
  float day = pow(smoothstep(-uTermWidth, uTermWidth, ndl), uTermGamma);
  float lit = uAmbient + (1.0 - uAmbient) * day;

  // Tops catch the light, flanks fall into the shadow tint, and the sheet
  // thickens toward the limb where the line of sight cuts through more of it.
  vec3 col = mix(uShadow, uTint, mix(1.0, lit, uSunMix));
  col *= mix(1.0, lit, uSunMix);
  float limb = 1.0 + 0.55 * pow(1.0 - ndv, 2.2);

  // Clouds go out with the light, not grey with it.
  //
  // Shading the sheet without also fading it leaves the night side pasted
  // over with flat mid-grey — the cloud is dark, but it is still *opaque*, so
  // it hides the ground underneath instead of disappearing into the same
  // shadow. On the terminator that reads as smoke smeared across the
  // continent, and the limb term makes it worst exactly where the sheet is
  // seen most edge-on. Taking the alpha down with the day term is what a
  // photograph does: on the unlit half there is nothing there to see.
  //
  // Per preset, because the two want opposite things and no shared weighting
  // served both: the dark sheet has to disappear completely, and the light
  // one must not move at all — that page has no night in it to hide a cloud
  // in, and fading the sheet there only put a soft edge across a globe whose
  // whole point is that it has none. uFade is 1 and 0 respectively.
  float vis = mix(1.0, mix(uAmbient, 1.0, day), uFade);

  gl_FragColor = vec4(col, clamp(a * uOpacity * limb * vis, 0.0, 1.0));
}
