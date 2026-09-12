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

void main() {
  vec2 p = gl_FragCoord.xy;
  p.y = uResolution.y - p.y;
  float d = length(p - uCentre) / max(uRadius, 1.0);

  float outer = 1.0 - smoothstep(1.0, 1.0 + uSpread, d);
  float gate = smoothstep(0.985, 1.005, d);          // nothing over the globe
  float a = pow(outer, 2.3) * gate * uStrength;
  if (a < 0.002) discard;

  vec3 col = mix(uOuter, uInner, pow(outer, 1.6));
  gl_FragColor = vec4(col, a);
}
