// Extra lights and depth fog, shared by the surface and the cloud sheet
// (earth.js prepends it to both). Every term is gated on its own strength, so
// at the defaults — all zero — nothing here changes a pixel.
uniform vec3 uAmbientLight;   // colour x intensity
uniform float uHemiOn;
uniform vec3 uHemiSky;        // colour x intensity
uniform vec3 uHemiGround;
uniform vec3 uFillLight;      // colour x intensity
uniform vec3 uFillDir;        // world space, rebuilt each frame like uSun
uniform vec3 uRimLight;       // colour x intensity
uniform vec3 uRimDir;
uniform float uRimPower;

uniform float uFog;           // 0 off, else the amount
uniform float uFogMode;       // 0 linear, 1 exp2
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogDensity;

/** Light added over the authored sun, to be multiplied by the albedo. */
vec3 terraLights(vec3 n, vec3 V) {
  vec3 l = uAmbientLight;
  if (uHemiOn > 0.5) l += mix(uHemiGround, uHemiSky, n.y * 0.5 + 0.5);
  l += uFillLight * max(dot(n, normalize(uFillDir)), 0.0);
  float rim = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), uRimPower);
  l += uRimLight * rim * max(dot(n, normalize(uRimDir)) * 0.5 + 0.5, 0.0);
  return l;
}

vec3 terraFog(vec3 col, vec3 world) {
  if (uFog < 0.001) return col;
  float d = length(cameraPosition - world);
  float f = uFogMode < 0.5
    ? smoothstep(uFogNear, uFogFar, d)
    : 1.0 - exp(-uFogDensity * uFogDensity * d * d);
  return mix(col, uFogColor, clamp(f, 0.0, 1.0) * uFog);
}
