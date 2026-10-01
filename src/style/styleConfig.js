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
    toneMapping: "Neutral",
    /** Only acts when tone mapping is on, as in three. */
    exposure: 1.81,
    /**
     * "Linear" writes the shader's colour as is — right, because the grade is
     * authored in gamma space and nothing is decoded on the way in. "sRGB"
     * encodes it a second time, and is there to compare against.
     */
    outputColorSpace: "Linear",
    /** Device pixel ratio ceiling. Past 2 costs fill rate nobody can see. */
    maxPixelRatio: 3,
  },

  camera: {
    // 35.6°, not 32. The reference frames the disc at 0.72 of the window's
    // height, and this is the honest way to get there: the alternative was to
    // push HOME further out, but zoom is measured as a fraction of the span
    // between minDist and maxDist, so moving the far end rescales every
    // altitude in the app. Widening the lens leaves the zoom ladder where it
    // is and only changes how much of the world each rung shows.
    fov: 36.7,
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
    specPower: 19,
    specColor: "#fffbf2",
    /** The embossing light: north-west, about forty degrees up. */
    hillshade: { azimuth: 7.5, elevation: 65.6, min: 0.86, max: 1.17 },
    // Extra lights over the authored sun. All at intensity 0, where the
    // shader skips them. Angles are view space, like the sun's.
    ambient: { color: "#ffffff", intensity: 0 },
    hemisphere: { sky: "#bcd8ff", ground: "#3b2c1c", intensity: 0 },
    fill: { color: "#757575", intensity: 0.84, azimuth: -157, elevation: 33.5 },
    rim: { color: "#bfe0ff", intensity: 0.97, azimuth: -93, elevation: 57, power: 4 },
  },

  /** Depth fog over the globe and the clouds, by distance from the camera in earth radii. */
  fog: { enabled: false, mode: "linear", color: "#0a1a2e", near: 2.6, far: 5.5, density: 0.3, amount: 1 },

  globe: {
    /** Sphere tessellation (width segments; height is half). Shape only. */
    segments: 392,
    /** The day imagery. Swapping it loads a new texture. */
    baseTexture: "/textures/blue-marble.jpg",
    /** Latitude/longitude grid drawn on the surface. */
    graticule: { enabled: false, color: "#ffffff", opacity: 0.09, spacing: 12.5, width: 1.25 },
    /** City lights on the night side, painted from places.json by population. */
    nightLights: { enabled: true, color: "#623c04", intensity: 2.2, size: 0.5 },
    clouds: {
      enabled: true,
      /** Shell height above the ground, in earth radii. */
      altitude: 0.0105,
      segments: 128,
      /** Turns of the sheet per second. */
      drift: 0.00223,
      /** Zoom band over which the sheet goes out. */
      fadeStart: 0.12,
      fadeEnd: 0.72,
    },
    /** Zoom band over which the facets retire. */
    facetFadeStart: 0,
    facetFadeEnd: 1,
    /** Zoom band over which the terminator flattens to daylight, and by how much. */
    sunFlattenStart: 0.07,
    sunFlattenEnd: 0.78,
    sunFlatten: 0.77,
  },

  /**
   * A final grade over the globe surface and clouds. Off by default, and when
   * off the shaders skip it entirely, so it costs nothing and changes nothing.
   */
  grade: {
    enabled: true,
    mix: 1,
    brightness: -0.04,
    contrast: 1.05,
    saturation: 0.98,
    vibrance: -0.02,
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
    // The working view carries no bloom, only aberration gathered at the
    // planet's edge. The landing screen has its own, softer-edged look over
    // these (style/landing.js) and eases into this one on the way out.
    bloom: { enabled: true, strength: 0, radius: 0.4, threshold: 0.35 },
    chromatic: { enabled: true, amount: 0.0039 },
    /** Local contrast over the planet's face (not the limb); see postchain.js. */
    sharpen: { enabled: true, amount: 0.22 },
    /** msaa (the context's own) | fxaa | none */
    aa: "msaa",
    vignette: { enabled: true, strength: 0.32, radius: 1.25, softness: 0.5, color: "#000000" },
    grain: { enabled: true, amount: 0.02, size: 1.4, animated: false },
  },

  markers: {
    size: 5.5,
    rim: 0.8,
    activeRim: 2,
    hoverScale: 1.7,
    activeScale: 1.4,
    /** Soft glow round each dot, in px. 0 is the minimal look. */
    glow: 0,
    /** Opacity of a pin the active filters exclude. */
    dimOpacity: 0.28,
    opacity: 1,
    /** circle | square | diamond */
    shape: "diamond",
    /** Ripple from each dot: off | urgent | all. */
    pulse: { mode: "urgent", speed: 1.95, size: 3 },
    hoverColorOn: false,
    activeColorOn: false,
  },

  labels: {
    /** CSS font-family; "" keeps the page's own sans. */
    font: "",
    chipSize: 11.5,
    placeSize: 8,
    countrySize: 14.5,
    /** Zoom at which city names start to arrive. */
    cityZoom: 0.4,
    /** Zoom at which country plates may appear, and how many at once. */
    countryZoom: 0.47,
    countryMax: 10,
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
        mode: "linear",
        /**
         * The page colour (--paper) the chrome, the hero scrim and the sign-in
         * veil all mix from. The reference's sky is *black* — the corners of
         * the frame measure #000000 to #00030a — so that the rim light is
         * unarguably the brightest thing on the page.
         */
        page: "#000206",
        solid: "#000206",
        linear: { top: "#001a38", bottom: "#000000", angle: 180 },
        radial: { center: "#0a1a2e", mid: "#030b16", edge: "#000206", midStop: 50, width: 30, height: 80, x: 50, y: 48 },
        /** stars | dots | none */
        pattern: "stars",
        // Tiled rather than stretched: the sheet is built to wrap
        // (tools/make_stars.py), so the field stays the same density on a
        // laptop and on a wall.
        stars: { source: "texture", count: 450, radius: 0.4, color: "#ffffff", seed: 1, opacity: 0.85, size: 1024, drift: 3, twinkle: 0, twinkleSpeed: 20 },
        dots: { color: "#96b9e6", alpha: 0.13, size: 1, spacing: 24, opacity: 0.8, fadeInner: 32, fadeOuter: 78 },
        // Grain is a property of paper, and over a night sky it is only noise.
        grain: { enabled: false, opacity: 0.035, size: 420 },
      },
      light: {
        // Behind and above, a touch to the left — see the note above. Degrees
        // in view space: azimuth 0 is toward the viewer, 90 is screen right.
        sunAzimuth: -34.8,
        sunElevation: 42.3,
        sunMix: 1.0,
        // Not zero: a globe whose underside is literally black loses its
        // silhouette against a near-black sky.
        ambient: 0,
        termWidth: 0.73,
        termGamma: 2.53,
        night: "#000205",
        spec: 0.25,
      },
      surface: {
        ocean: { deep: "#00192e", mid: "#002f4d", shelf: "#2d6766" },
        land: { gamma: 0.8, sat: 1.28, gain: 1.2, lift: -0.07 },
        // Strong. The reference reads as embossed relief — dune fields and
        // ranges lit from the side — not as a photograph laid on a ball.
        relief: 2.6,
        snow: "#878787",
        snowAmt: 0.76,
        // A whisper. The land in the reference is painted relief with a fine
        // crazing over the vegetation, not a mosaic of tiles — and with the 8K
        // imagery there is real detail under it, so the cells average little
        // of it away (flat) and their seams stay a hint (edge, edgeInk).
        facet: { amount: 0.55, scale: 39, tilt: 0.16, flat: 0.12, edge: 0.06, edgeInk: -0.18 },
        // Streamed tiles, brought back to Blue Marble's footing before the land
        // grade runs over both. Net: gamma 1.0, saturation 1.05, gain 1.0 —
        // the imagery as published.
        detail: { gamma: 2.0, sat: 0.65, gain: 0.88, lift: 0.0, sea: 0.5 },
        landTint: "#ffffff",
        landTintAmt: 0.25,
        emissive: "#517aa4",
        emissiveIntensity: 0,
        emissiveNightOnly: true,
      },
      atmosphere: {
        enabled: true,
        color: "#002b57",
        fresnel: 0.5,
        fresnelPow: 1.05,
        // Nearly nothing away from the light: the reference's lower limb is
        // black, with no outline drawn round the dark side of the disc.
        rimBase: 0,
        // A tight, nearly neutral rim all the way round with almost no spill,
        // so the limb reads as an edge against the black rather than a glow.
        halo: { inner: "#8c8c8c", outer: "#474747", strength: 0.93, spread: 0.161, topBias: 0, falloff: 7.7, bloom: 0.23, bloomSpread: 1.12, rimPower: 10, spillPower: 0.2 },
      },
      clouds: {
        tint: "#f0f0f0", shadow: "#000000", opacity: 0.31, sunMix: 1, lo: 0.6, hi: 1, gamma: 5, fade: 1,
        real: 1, realOpacity: 0.34, realLo: 0.32, realHi: 0.63,
      },
      // Against the night sky the coast is drawn as shallow water rather than
      // as an outline: a band of lit turquoise where the shelf comes up.
      lines: {
        coast: { color: "#6cc4e2", width: 1.05, alpha: 0.3 },
        borders: { color: "#000000", width: 1, alpha: 0.76 },
        rivers: { color: "#568cc0", width: 0.75, alpha: 0.5 },
        lakeEdge: { color: "#6cc4e2", width: 0.8, alpha: 0.24 },
      },
      markers: {
        urgent: "#ff1900",
        normal: "#ffae00",
        rimColor: "#ffffff",
        rimAlpha: 0.67,
        shadowColor: "#000000",
        shadowAlpha: 0.55,
        shadowBlur: 4,
        activeRimColor: "#ffffff",
        activeShadowColor: "#102a4a",
        activeShadowAlpha: 0.4,
        glowColor: "#e2685a",
        hoverColor: "#1f8104",
        activeColor: "#ffffff",
        pulseColor: "#ff1900",
      },
      labels: {
        chipBg: "#121b29",
        chipBgAlpha: 0.83,
        chipHoverBg: "#121b29",
        chipColor: "#eaf1fa",
        placeColor: "#f4f7fb",
        placeHalo: "#ffffff",
        placeHaloAlpha: 0,
        countryBg: "#f5f5f5",
        countryBgAlpha: 0,
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
        halo: { inner: "#e6f2fc", outer: "#c6def5", strength: 1, spread: 0.08, topBias: 0.7, falloff: 0.8, bloom: 0.3, bloomSpread: 0.38, rimPower: 3.2, spillPower: 1.7 },
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
