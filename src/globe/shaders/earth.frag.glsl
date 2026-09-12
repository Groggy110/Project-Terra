precision highp float;

uniform sampler2D uBase;    // NASA Blue Marble, topography + bathymetry
uniform sampler2D uAux;     // R topography, G land mask, B coast proximity
uniform sampler2D uLines;   // vector ink, in window space
uniform sampler2D uMask;    // crisp land mask, in window space
uniform sampler2D uBaseInk; // vector ink for the whole world, coarse tier

uniform vec4 uWindow;       // uMin, vMin, uSpan, vSpan of the painted window
uniform vec2 uAuxTexel;
uniform vec2 uAuxSize;
uniform float uHasWindow;

uniform vec3 uSun;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShelf;
uniform vec3 uSnow;
uniform vec3 uAtmo;

uniform float uLandGamma;
uniform float uLandSat;
uniform float uLandGain;
uniform float uLandLift;
uniform float uRelief;
uniform float uSunMix;
uniform float uSpec;
uniform float uFresnel;
uniform float uLineMix;
uniform float uSnowAmt;
uniform float uDebug;   // 0 off; see globe.debug()

varying vec3 vNormalW;
varying vec3 vWorld;

const float PI = 3.141592653589793;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// The uv seam runs down the antimeridian. Without this the mip selector sees a
// full-texture jump across that one column and picks the coarsest level,
// leaving a blurred stripe through the Pacific.
vec2 fixSeam(vec2 d) {
  d.x -= sign(d.x) * step(0.5, abs(d.x));
  return d;
}

float win1(float x, float edge) {
  return smoothstep(0.0, edge, x) * (1.0 - smoothstep(1.0 - edge, 1.0, x));
}

void main() {
  vec3 n = normalize(vNormalW);

  // Geography solved per pixel from the normal, so detail does not depend on
  // how finely the sphere is tessellated.
  float lonRad = atan(-n.z, n.x);
  float latRad = asin(clamp(n.y, -1.0, 1.0));
  vec2 uv = vec2(lonRad / (2.0 * PI) + 0.5, 0.5 - latRad / PI);

  vec2 ddx = fixSeam(dFdx(uv));
  vec2 ddy = fixSeam(dFdy(uv));

  vec3 base = texture2DGradEXT(uBase, uv, ddx, ddy).rgb;
  vec3 aux = texture2DGradEXT(uAux, uv, ddx, ddy).rgb;

  float topo = aux.r;
  float mask = aux.g;
  float prox = aux.b;

  // ---- vector window ----------------------------------------------------
  float du = uv.x - uWindow.x;
  du -= floor(du);                       // wrap, so a window may straddle 180
  vec2 wuv = vec2(du / uWindow.z, (uv.y - uWindow.y) / uWindow.w);
  float inWin = uHasWindow * win1(wuv.x, 0.015) * win1(wuv.y, 0.015);

  // Coarse tier first, then the fine window over it where one exists. Outside
  // the window the land split falls back to the raster mask, which is the same
  // 4096-wide grid the topography comes from.
  //
  // The window canvases are sampled plainly rather than with explicit
  // gradients: they carry no seam (wuv is clamped inside the window) and they
  // have no mip chain, so there is nothing for a gradient to select.
  vec4 ink = texture2DGradEXT(uBaseInk, uv, ddx, ddy);
  if (inWin > 0.002) {
    vec2 c = clamp(wuv, 0.0, 1.0);
    mask = mix(mask, texture2D(uMask, c).r, inWin);
    ink = mix(ink, texture2D(uLines, c), inWin);
  }

  // ---- hillshade --------------------------------------------------------
  // Differences are taken at whatever texel the mip selector is actually
  // reading, so relief survives at a whole-globe view instead of averaging
  // itself flat.
  float mip = max(1.0, length(ddx * uAuxSize));
  vec2 e = uAuxTexel * mip;
  float hL = texture2DGradEXT(uAux, uv - vec2(e.x, 0.0), ddx, ddy).r;
  float hR = texture2DGradEXT(uAux, uv + vec2(e.x, 0.0), ddx, ddy).r;
  float hN = texture2DGradEXT(uAux, uv - vec2(0.0, e.y), ddx, ddy).r;
  float hS = texture2DGradEXT(uAux, uv + vec2(0.0, e.y), ddx, ddy).r;

  float cosLat = max(cos(latRad), 0.18);
  vec2 slope = vec2((hR - hL) / cosLat, -(hS - hN)) * uRelief;
  vec3 tN = normalize(vec3(-slope.x, -slope.y, 1.0));
  vec3 tL = normalize(vec3(-0.60, 0.60, 0.75));       // north-west, 40 degrees
  float shade = 1.0 + (dot(tN, tL) / tL.z - 1.0) * mask;
  shade = clamp(shade, 0.42, 1.44);

  float lum = dot(base, LUMA);
  float mx = max(max(base.r, base.g), base.b);
  float mn = min(min(base.r, base.g), base.b);
  float chroma = mx - mn;

  // ---- land -------------------------------------------------------------
  vec3 land = pow(max(base, vec3(0.0)), vec3(uLandGamma));
  land = mix(vec3(dot(land, LUMA)), land, uLandSat);
  land = land * uLandGain + uLandLift;
  land *= shade;

  // Snow reads as brightness with almost no colour in it, which is what
  // separates an icecap from a bright desert at the same luminance.
  float snow = smoothstep(0.33, 0.62, lum) * (1.0 - smoothstep(0.06, 0.17, chroma));
  snow = max(snow, smoothstep(0.58, 0.88, topo) * (1.0 - smoothstep(0.10, 0.24, chroma)));
  land = mix(land, uSnow * (0.93 + 0.07 * shade), clamp(snow, 0.0, 1.0) * uSnowAmt);

  // ---- ocean ------------------------------------------------------------
  // The source ocean is a bathymetry render: brighter means shallower, so its
  // own luminance is the depth channel.
  // Measured against the source: open ocean sits at 0.07-0.13 luminance and
  // genuine shelf water above 0.20, so those are the ramps.
  vec3 sea = mix(uDeep, uMid, smoothstep(0.02, 0.13, lum));
  sea = mix(sea, uShelf, smoothstep(0.17, 0.34, lum) * 0.5);
  sea = mix(sea, uShelf, smoothstep(0.62, 1.0, prox) * 0.16);
  sea *= 0.99 + 0.12 * (lum - 0.08);                   // ridges and trenches

  vec3 col = mix(sea, land, mask);
  col = mix(col, ink.rgb, ink.a * inWin * uLineMix);

  // ---- light ------------------------------------------------------------
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSun);
  float ndv = clamp(dot(n, V), 0.0, 1.0);
  float wrapped = clamp(dot(n, L) * 0.5 + 0.5, 0.0, 1.0);
  col *= mix(1.0, 0.60 + 0.55 * wrapped, uSunMix);

  vec3 H = normalize(L + V);
  float spec = pow(clamp(dot(n, H), 0.0, 1.0), 46.0) * (1.0 - mask) * uSpec;
  col += spec * vec3(1.0, 0.985, 0.95);

  // Aerial perspective: the limb washes into the atmosphere tint, which is
  // what lets the globe sit on pale paper without a cut-out edge.
  col = mix(col, uAtmo, clamp(pow(1.0 - ndv, 3.1) * uFresnel, 0.0, 0.94));

  if (uDebug > 0.5) {
    if (uDebug < 1.5) col = vec3(mask);
    else if (uDebug < 2.5) col = vec3(inWin);
    else if (uDebug < 3.5) col = vec3(ink.a);
    else if (uDebug < 4.5) col = land;
    else if (uDebug < 5.5) col = sea;
    else if (uDebug < 6.5) col = vec3(shade - 0.4);
    else if (uDebug < 7.5) col = vec3(topo);
    else if (uDebug < 8.5) col = vec3(lum, chroma, snow);
    else if (uDebug < 9.5) col = vec3(wuv, 0.0);            // window coords
    else if (uDebug < 10.5) col = vec3(texture2D(uMask, clamp(wuv, 0.0, 1.0)).r);
    else if (uDebug < 11.5) col = vec3(uv, 0.0);             // geographic uv
    else if (uDebug < 12.5) col = base;                      // raw imagery
    else col = vec3(aux.g);                                  // raw raster mask
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  // 8-bit dither, or the wide ocean gradients band visibly.
  float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor = vec4(col + (d - 0.5) / 255.0, 1.0);
}
