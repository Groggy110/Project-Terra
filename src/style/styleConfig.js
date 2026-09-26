/**
 * Every visual number the globe and the ground behind it are drawn with.
 *
 * This is the single source of truth: the renderer, the shaders, the camera,
 * the vector ink, the pins and the CSS sky all read from STYLE rather than
 * carrying their own copies. applyStyle() (./applyStyle.js) pushes a changed
 * STYLE into the running page without a reload.
 *
 * Two kinds of group:
 *
 *   shared      renderer, camera, motion, lighting, globe, grade, post,
 *               markers, labels — one value whatever the theme
 *   per theme   themes.dark / themes.light — the palette, the lamp and the
 *               sky, which are the whole difference between the two looks
 *
 * The grade is authored in gamma space with colour management off (see
 * earth.js), so every colour here is literally the value a shader multiplies.
 *
 * Bump `version` when a key is renamed or its meaning changes, so an exported
 * settings file from an older shape can be recognised.
 */

export const STYLE_VERSION = 1;

export const STYLE = {
  version: STYLE_VERSION,

  renderer: {
    /** None | Linear | Reinhard | Cineon | ACESFilmic | AgX | Neutral */
    toneMapping: "None",
    /** Only acts when tone mapping is on, as in three. */
    exposure: 1,
    /**
     * "Linear" writes the shader's colour as is — right, because the grade is
     * authored in gamma space and nothing is decoded on the way in. "sRGB"
     * encodes it a second time, and is there to compare against.
     */
    outputColorSpace: "Linear",
    /** Device pixel ratio ceiling. Past 2 costs fill rate nobody can see. */
    maxPixelRatio: 2,
  },

  camera: {
    // 35.6°, not 32. The reference frames the disc at 0.72 of the window's
    // height, and this is the honest way to get there: the alternative was to
    // push HOME further out, but zoom is measured as a fraction of the span
    // between minDist and maxDist, so moving the far end rescales every
    // altitude in the app. Widening the lens leaves the zoom ladder where it
    // is and only changes how much of the world each rung shows.
    fov: 35.6,
    near: 0.005,
    far: 60,
    /**
     * The close stop, and it is a *height*, not a distance: 1.014 frames about
     * ninety kilometres — a city and the country it sits in, which is as close
     * as a globe has any business going. See controls.js.
     */
    minDist: 1.014,
    /** The whole-globe view, and the far end of the zoom ladder. */
    maxDist: 4.45,
    latLimit: 87,
    /** Roll of the view about its own axis, in degrees. Drag is compensated. */
    roll: 0,
    /** Where the page opens (at maxDist) and where Reset flies back to. */
    home: { lat: 14, lon: -52 },
    /** Where the entrance settles: Europe, Africa and the near East. */
    work: { lat: 17, lon: 20, dist: 3.4 },
    settleMs: 1700,
  },

  motion: {
    autoRotate: true,
    /** 1 turns the world eastward (the camera travels east), -1 westward. */
    direction: 1,
    /** Drift rate in pixels of ground per second, so it reads the same at every zoom. */
    spinPx: 18,
    /** Cap, in degrees a second — what spinPx asks for at the whole globe. */
    spinMax: 3.2,
    /** Quiet seconds after a deliberate move before the drift picks up again. */
    spinResume: 3.4,
    /** Zoom band over which the drift fades out. */
    spinFadeStart: 0.44,
    spinFadeEnd: 0.72,
    /** Time constants of the rotation and zoom smoothing, in seconds. */
    rotateDamping: 0.075,
    zoomDamping: 0.085,
    /** Multiplier on drag: 1 keeps the ground under the cursor. */
    rotateSpeed: 1,
    /** Distance exponent per unit of wheel delta. */
    zoomSpeed: 0.002,
    /** Fraction of throw velocity left after one second. */
    throwDecay: 0.0022,
  },

  lighting: {
    /**
     * The lamp is a view-space direction rebuilt from the camera every frame,
     * so turning the globe carries each continent up into the light. Off pins
     * it to the world instead, at the same angles as seen from HOME.
     */
    followCamera: true,
    specPower: 46,
    specColor: "#fffbf2",
    /** The embossing light: north-west, about forty degrees up. */
    hillshade: { azimuth: 315, elevation: 41.4729, min: 0.42, max: 1.44 },
    // Extra lights over the authored sun. All at intensity 0, where the
    // shader skips them. Angles are view space, like the sun's.
    ambient: { color: "#ffffff", intensity: 0 },
    hemisphere: { sky: "#bcd8ff", ground: "#3b2c1c", intensity: 0 },
    fill: { color: "#9cc4ff", intensity: 0, azimuth: 120, elevation: -10 },
    rim: { color: "#bfe0ff", intensity: 0, azimuth: 180, elevation: 30, power: 3 },
  },

  /** Depth fog over the globe and the clouds, by distance from the camera in earth radii. */
  fog: { enabled: false, mode: "linear", color: "#0a1a2e", near: 2.6, far: 5.5, density: 0.3, amount: 1 },

  globe: {
    /** Sphere tessellation (width segments; height is half). Shape only. */
    segments: 256,
    /** The day imagery. Swapping it loads a new texture. */
    baseTexture: "/textures/blue-marble.jpg",
    /** Latitude/longitude grid drawn on the surface. */
    graticule: { enabled: false, color: "#ffffff", opacity: 0.4, spacing: 15, width: 1.2 },
    /** City lights on the night side, painted from places.json by population. */
    nightLights: { enabled: false, color: "#ffc978", intensity: 1.2, size: 1.5 },
    clouds: {
      enabled: true,
      /** Shell height above the ground, in earth radii. */
      altitude: 0.0055,
      segments: 128,
      /** Turns of the sheet per second. */
      drift: 0.00042,
      /** Zoom band over which the sheet goes out. */
      fadeStart: 0.12,
      fadeEnd: 0.72,
    },
    /** Zoom band over which the facets retire. */
    facetFadeStart: 0.46,
    facetFadeEnd: 0.82,
    /** Zoom band over which the terminator flattens to daylight, and by how much. */
    sunFlattenStart: 0.34,
    sunFlattenEnd: 0.78,
    sunFlatten: 0.78,
  },

  /**
   * A final grade over the globe surface and clouds. Off by default, and when
   * off the shaders skip it entirely, so it costs nothing and changes nothing.
   */
  grade: {
    enabled: false,
    mix: 1,
    brightness: 0,
    contrast: 1,
    saturation: 1,
    vibrance: 0,
    hue: 0,
    temperature: 0,
    tint: 0,
    lift: { color: "#ffffff", strength: 0 },
    gamma: { color: "#ffffff", strength: 0 },
    gain: { color: "#ffffff", strength: 0 },
  },

  /** Screen-space passes drawn over everything on the canvas. Off by default. */
  post: {
    // Bloom, chromatic aberration and a non-default anti-aliasing mode route
    // the frame through a render target; with all three at rest it is drawn
    // straight to the canvas as it always was.
    bloom: { enabled: false, strength: 0.6, radius: 1, threshold: 0.6 },
    chromatic: { enabled: false, amount: 0.0025 },
    /** msaa (the context's own) | fxaa | none */
    aa: "msaa",
    vignette: { enabled: false, strength: 0.5, radius: 0.75, softness: 0.45, color: "#000000" },
    grain: { enabled: false, amount: 0.06, size: 1.5, animated: true },
  },

  markers: {
    size: 8,
    rim: 1.5,
    activeRim: 2,
    hoverScale: 1.25,
    activeScale: 1.4,
    /** Soft glow round each dot, in px. 0 is the minimal look. */
    glow: 0,
    /** Opacity of a pin the active filters exclude. */
    dimOpacity: 0.28,
    opacity: 1,
    /** circle | square | diamond */
    shape: "circle",
    /** Ripple from each dot: off | urgent | all. */
    pulse: { mode: "off", speed: 1.8, size: 2.6 },
    hoverColorOn: false,
    activeColorOn: false,
  },

  labels: {
    /** CSS font-family; "" keeps the page's own sans. */
    font: "",
    chipSize: 14.5,
    placeSize: 12.5,
    countrySize: 14,
    /** Zoom at which city names start to arrive. */
    cityZoom: 0.28,
    /** Zoom at which country plates may appear, and how many at once. */
    countryZoom: 0.12,
    countryMax: 3,
    /** Screen area (px²) each lettered pin needs; smaller letters more of them. */
    pinDensity: 58000,
  },

  themes: {
    /**
     * Dark: the reference frame — a planet photographed from orbit against
     * black, with the sun not overhead but *behind and above* it.
     *
     * That last part is what the whole preset turns on. A lamp in front of the
     * globe lights the disc you are looking at and leaves only a sliver of
     * night at the bottom; a lamp behind its top edge throws the terminator up
     * across the visible face, so the southern third falls away into nothing
     * and the top limb goes white-hot where the light grazes the atmosphere.
     * Hence an azimuth behind the globe, and hence a terminator that is wide
     * (it has most of the disc to cross) rather than the tight one a
     * front-lit globe wants.
     */
    dark: {
      background: {
        /** solid | linear | radial | transparent */
        mode: "solid",
        /**
         * The page colour (--paper) the chrome, the hero scrim and the sign-in
         * veil all mix from. The reference's sky is *black* — the corners of
         * the frame measure #000000 to #00030a — so that the rim light is
         * unarguably the brightest thing on the page.
         */
        page: "#000206",
        solid: "#000206",
        linear: { top: "#04101e", bottom: "#000206", angle: 180 },
        radial: { center: "#0a1a2e", mid: "#030b16", edge: "#000206", midStop: 45, width: 70, height: 80, x: 50, y: 48 },
        /** stars | dots | none */
        pattern: "stars",
        // Tiled rather than stretched: the sheet is built to wrap
        // (tools/make_stars.py), so the field stays the same density on a
        // laptop and on a wall.
        stars: { source: "texture", count: 1400, radius: 0.7, color: "#ffffff", seed: 7, opacity: 0.85, size: 1024, drift: 0, twinkle: 0, twinkleSpeed: 4 },
        dots: { color: "#96b9e6", alpha: 0.13, size: 1, spacing: 24, opacity: 0.8, fadeInner: 32, fadeOuter: 78 },
        // Grain is a property of paper, and over a night sky it is only noise.
        grain: { enabled: false, opacity: 0.035, size: 420 },
      },
      light: {
        // Behind and above, a touch to the left — see the note above. Degrees
        // in view space: azimuth 0 is toward the viewer, 90 is screen right.
        sunAzimuth: -122.0054,
        sunElevation: 79.1238,
        sunMix: 1.0,
        // Not zero: a globe whose underside is literally black loses its
        // silhouette against a near-black sky.
        ambient: 0.04,
        termWidth: 0.74,
        termGamma: 1.35,
        night: "#04101d",
        spec: 0.3,
      },
      surface: {
        ocean: { deep: "#072238", mid: "#16608f", shelf: "#3fabdc" },
        land: { gamma: 0.5, sat: 1.62, gain: 1.14, lift: 0.005 },
        // Strong. The reference reads as embossed relief — dune fields and
        // ranges lit from the side — not as a photograph laid on a ball.
        relief: 7.6,
        snow: "#e4eefa",
        snowAmt: 0.22,
        // A whisper. The land in the reference is painted relief with a fine
        // crazing over the vegetation, not a mosaic of tiles.
        facet: { amount: 0.7, scale: 74, tilt: 0.08, flat: 0.06, edge: 0.055, edgeInk: -0.5 },
        // Streamed tiles, brought back to Blue Marble's footing before the land
        // grade runs over both. Net: gamma 1.0, saturation 1.05, gain 1.0 —
        // the imagery as published.
        detail: { gamma: 2.0, sat: 0.65, gain: 0.88, lift: 0.0, sea: 0.5 },
        landTint: "#ffffff",
        landTintAmt: 0,
        emissive: "#3f93e6",
        emissiveIntensity: 0,
        emissiveNightOnly: true,
      },
      atmosphere: {
        enabled: true,
        color: "#3f93e6",
        fresnel: 0.78,
        fresnelPow: 2.0,
        // Nearly nothing away from the light: the reference's lower limb is
        // black, with no outline drawn round the dark side of the disc.
        rimBase: 0.0,
        halo: { inner: "#eaf5ff", outer: "#4180c6", strength: 1.9, spread: 0.058, topBias: 0.006, falloff: 4.0, bloom: 1.0, bloomSpread: 1.4, rimPower: 3.2, spillPower: 1.7 },
      },
      clouds: {
        tint: "#ffffff", shadow: "#0a1524", opacity: 0.98, sunMix: 0.72, lo: 0.42, hi: 0.95, gamma: 2.2, fade: 1,
        real: 0, realOpacity: 0.98, realLo: 0.2, realHi: 0.9,
      },
      // Against the night sky the coast is drawn as shallow water rather than
      // as an outline: a band of lit turquoise where the shelf comes up.
      lines: {
        coast: { color: "#6cc4e2", width: 1.05, alpha: 0.3 },
        borders: { color: "#bad6f2", width: 0.85, alpha: 0.2 },
        rivers: { color: "#568cc0", width: 0.8, alpha: 0.5 },
        lakeEdge: { color: "#6cc4e2", width: 0.8, alpha: 0.24 },
      },
      markers: {
        urgent: "#e2685a",
        normal: "#ea9288",
        rimColor: "#ffffff",
        rimAlpha: 0.9,
        shadowColor: "#000000",
        shadowAlpha: 0.55,
        shadowBlur: 4,
        activeRimColor: "#ffffff",
        activeShadowColor: "#102a4a",
        activeShadowAlpha: 0.4,
        glowColor: "#e2685a",
        hoverColor: "#ff8a7a",
        activeColor: "#ffffff",
        pulseColor: "#e2685a",
      },
      labels: {
        chipBg: "#121b29",
        chipBgAlpha: 0.88,
        chipHoverBg: "#121b29",
        chipColor: "#eaf1fa",
        placeColor: "#f4f7fb",
        placeHalo: "#08101c",
        placeHaloAlpha: 0.72,
        countryBg: "#121b29",
        countryBgAlpha: 0.88,
        countryColor: "#eaf1fa",
      },
    },

    /**
     * Light: the same lamp, overhead, with enough fill under it that nothing
     * goes black. A form sitting on paper cannot also have a globe with a
     * brooding shadow gathering at the bottom of it.
     */
    light: {
      background: {
        mode: "radial",
        page: "#f4f8fc",
        solid: "#f4f8fc",
        linear: { top: "#fbfcfe", bottom: "#e7edf4", angle: 180 },
        // Off-white, a touch brighter behind the globe and cooling toward the
        // edges — the daylight counterpart of the night sky.
        radial: { center: "#fbfcfe", mid: "#f3f6fa", edge: "#e7edf4", midStop: 45, width: 70, height: 80, x: 50, y: 48 },
        pattern: "dots",
        stars: { source: "texture", count: 1400, radius: 0.7, color: "#ffffff", seed: 7, opacity: 0.85, size: 1024, drift: 0, twinkle: 0, twinkleSpeed: 4 },
        // A faint dot grid that fades out before it reaches the disc.
        dots: { color: "#142640", alpha: 0.13, size: 1, spacing: 24, opacity: 0.8, fadeInner: 32, fadeOuter: 78 },
        grain: { enabled: true, opacity: 0.035, size: 420 },
      },
      light: {
        // Straight up the screen, tipped a little toward the viewer.
        sunAzimuth: 0,
        sunElevation: 76.1028,
        sunMix: 0.7,
        ambient: 0.56,
        termWidth: 0.62,
        termGamma: 1.15,
        night: "#96afc9",
        spec: 0.26,
      },
      surface: {
        ocean: { deep: "#224c76", mid: "#2c6597", shelf: "#4b92c0" },
        land: { gamma: 0.56, sat: 1.3, gain: 1.03, lift: 0.015 },
        relief: 4.9,
        snow: "#f6f9fd",
        snowAmt: 0.88,
        facet: { amount: 0.85, scale: 26, tilt: 0.34, flat: 0.5, edge: 0.07, edgeInk: 0.2 },
        // Nearly all of the land curve comes back out — a shade less than in
        // the night preset, because this page is paper.
        detail: { gamma: 1.6, sat: 0.81, gain: 1.01, lift: 0.0, sea: 0.4 },
        landTint: "#ffffff",
        landTintAmt: 0,
        emissive: "#96afc9",
        emissiveIntensity: 0,
        emissiveNightOnly: true,
      },
      atmosphere: {
        enabled: true,
        color: "#d6e7f8",
        // The haze held to a bright rim at the limb rather than a veil over
        // the disc.
        fresnel: 0.68,
        fresnelPow: 3.6,
        rimBase: 0.58,
        halo: { inner: "#e6f2fc", outer: "#c6def5", strength: 1.0, spread: 0.08, topBias: 0.7, falloff: 0.8, bloom: 0.3, bloomSpread: 0.38, rimPower: 3.2, spillPower: 1.7 },
      },
      // `real` swaps the synthetic sheet for NASA's Blue Marble cloud composite
      // once it has streamed in — a real day's weather, at `realOpacity`.
      // realLo/Hi are where its grey floor ends and where it is solid cloud.
      clouds: {
        tint: "#ffffff", shadow: "#d0deec", opacity: 0.27, sunMix: 0.45, lo: 0.43, hi: 0.96, gamma: 1.0, fade: 0,
        real: 1, realOpacity: 0.72, realLo: 0.22, realHi: 0.88,
      },
      lines: {
        coast: { color: "#ffffff", width: 1.05, alpha: 0.82 },
        borders: { color: "#384e68", width: 0.85, alpha: 0.4 },
        rivers: { color: "#6c9ec9", width: 0.8, alpha: 0.6 },
        lakeEdge: { color: "#ffffff", width: 0.8, alpha: 0.6 },
      },
      markers: {
        urgent: "#c0362b",
        normal: "#d26e66",
        rimColor: "#ffffff",
        rimAlpha: 0.95,
        shadowColor: "#102a4a",
        shadowAlpha: 0.3,
        shadowBlur: 3,
        activeRimColor: "#ffffff",
        activeShadowColor: "#102a4a",
        activeShadowAlpha: 0.4,
        glowColor: "#c0362b",
        hoverColor: "#e04a3d",
        activeColor: "#8f1f17",
        pulseColor: "#c0362b",
      },
      labels: {
        chipBg: "#ffffff",
        chipBgAlpha: 0.95,
        chipHoverBg: "#ffffff",
        chipColor: "#0e1726",
        placeColor: "#f4f7fb",
        placeHalo: "#08101c",
        placeHaloAlpha: 0.72,
        countryBg: "#ffffff",
        countryBgAlpha: 0.91,
        countryColor: "#0e1726",
      },
    },
  },
};

/** The look as shipped, frozen at load, for anything that needs to compare or reset. */
export const STYLE_DEFAULTS = structuredClone(STYLE);
