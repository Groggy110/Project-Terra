precision highp float;

uniform sampler2D uClouds;
uniform vec3 uSun;
uniform vec3 uTint;
uniform vec3 uShadow;
uniform float uOpacity;
uniform float uDrift;
uniform float uSunMix;

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
  a = smoothstep(0.43, 0.96, a);
  if (a < 0.004) discard;

  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSun);
  float wrapped = clamp(dot(n, L) * 0.5 + 0.5, 0.0, 1.0);
  float ndv = clamp(dot(n, V), 0.0, 1.0);

  // Tops catch the light, flanks fall into the shadow tint, and the sheet
  // thickens toward the limb where the line of sight cuts through more of it.
  vec3 col = mix(uShadow, uTint, mix(1.0, wrapped, uSunMix));
  float limb = 1.0 + 0.55 * pow(1.0 - ndv, 2.2);

  gl_FragColor = vec4(col, clamp(a * uOpacity * limb, 0.0, 1.0));
}
