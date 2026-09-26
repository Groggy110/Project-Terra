precision highp float;

// The last thing drawn: a vignette and a film grain over the whole canvas,
// sky included. Both are alpha-blended layers rather than a render-to-texture
// pass, so the canvas stays transparent and the CSS ground behind it keeps
// showing through — composed here as grain over vignette, one layer.
uniform vec2 uResolution;
uniform float uVignette;    // strength, 0 off
uniform float uVigRadius;   // where the darkening is halfway, in half-heights
uniform float uVigSoft;     // width of the falloff
uniform vec3 uVigColor;
uniform float uGrain;       // amount, 0 off
uniform float uGrainSize;   // pixels per grain
uniform float uTime;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

void main() {
  vec2 d = gl_FragCoord.xy / uResolution - 0.5;
  d.x *= uResolution.x / uResolution.y;
  float r = length(d) * 2.0;
  float aV = uVignette * smoothstep(uVigRadius - uVigSoft, uVigRadius + uVigSoft, r);

  float n = hash(floor(gl_FragCoord.xy / max(uGrainSize, 1.0)) + floor(uTime * 24.0) * 17.0) - 0.5;
  float aG = uGrain * abs(n) * 2.0;
  vec3 cG = n > 0.0 ? vec3(1.0) : vec3(0.0);

  float a = aG + aV * (1.0 - aG);
  if (a < 0.002) discard;
  vec3 col = (cG * aG + uVigColor * aV * (1.0 - aG)) / a;
  gl_FragColor = vec4(col, a);
}
