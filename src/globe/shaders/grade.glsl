// A final grade, shared by the surface and the cloud sheet (earth.js prepends
// it to both). Every control is neutral at its default, and uGrade gates the
// whole thing: with it off the colour is returned untouched, so a globe with
// no grade is bit-for-bit the globe without this file.
uniform float uGrade;       // 0 off, 1 on
uniform float uGradeMix;    // 0 ungraded, 1 fully graded
uniform float uGradeBrightness;  // added, -1..1
uniform float uGradeContrast;    // about mid grey, 1 neutral
uniform float uGradeSaturation;  // 1 neutral
uniform float uGradeVibrance;    // saturates the muted colours more than the vivid ones
uniform float uGradeHue;         // radians
uniform float uGradeTemperature; // -1 cool .. 1 warm
uniform float uGradeTint;        // -1 magenta .. 1 green
uniform vec3 uGradeLift;         // added to the shadows, colour x strength
uniform vec3 uGradeGamma;       // per-channel gamma offset, colour x strength
uniform vec3 uGradeGain;         // per-channel gain offset, colour x strength

vec3 terraGrade(vec3 c) {
  if (uGrade < 0.5) return c;
  vec3 o = c;
  const vec3 Y = vec3(0.2126, 0.7152, 0.0722);

  // Lift, gamma, gain — the three wheels.
  c = c * (1.0 + uGradeGain) + uGradeLift * (1.0 - c);
  c = pow(max(c, vec3(0.0)), 1.0 / max(1.0 + uGradeGamma, vec3(0.05)));

  // White balance.
  c *= vec3(1.0 + 0.2 * uGradeTemperature, 1.0 + 0.2 * uGradeTint, 1.0 - 0.2 * uGradeTemperature);

  c += uGradeBrightness;
  c = (c - 0.5) * uGradeContrast + 0.5;

  // Hue: a rotation about the grey axis.
  if (abs(uGradeHue) > 1e-4) {
    const vec3 k = vec3(0.57735);
    float cs = cos(uGradeHue);
    c = c * cs + cross(k, c) * sin(uGradeHue) + k * dot(k, c) * (1.0 - cs);
  }

  float l = dot(c, Y);
  float s = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  c = mix(vec3(l), c, uGradeSaturation * (1.0 + uGradeVibrance * (1.0 - clamp(s, 0.0, 1.0))));

  return mix(o, max(c, vec3(0.0)), uGradeMix);
}
