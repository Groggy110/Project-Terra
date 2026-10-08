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
 *               markers, labels
 *   themes.dark the palette, the lamp and the sky. There is one theme; the
 *               light one was removed, and the key stays so exported
 *               settings files keep their shape
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
    /**
     * How close the camera may actually come: about four hundred metres up,
     * street level, where the imagery's finest tiles are shown at about two
     * screen pixels each. Below minDist the zoom ladder reads 1 — every
     * threshold keyed to zoom() has finished by then — and the camera simply
     * keeps going down. The shader switches to a per-pixel ray against the
     * true sphere on the way (earth.frag.glsl, uPrec), since neither the mesh
     * nor a 32-bit float is fine enough this low.
     */
    closeDist: 1.00006,
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
    baseTexture: "/textures/blue-marble.webp",
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
    size: 7,
    rim: 1.5,
    activeRim: 2.5,
    hoverScale: 1.35,
    activeScale: 1.45,
    /** Soft glow round each dot, in px. 0 is the minimal look. */
    glow: 7,
    /** Opacity of a pin the active filters exclude. */
    dimOpacity: 0.28,
    opacity: 1,
    /** circle | square | diamond */
    shape: "circle",
    /** Ripple from each dot: off | urgent | all. Off: with hundreds of
     *  ministries a ripple on every urgent one reads as the map flickering. */
    pulse: { mode: "off", speed: 1.95, size: 3 },
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
        // shadowGamma is the same curve at black, on land: it keeps forest
        // from crushing to nothing (see the shader).
        detail: { gamma: 2.0, shadowGamma: 1.1, sat: 0.65, gain: 0.88, lift: 0.0, sea: 0.5 },
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
        // One red for every ministry: the map marks where help is needed,
        // not how soon — urgency is read in the need itself.
        urgent: "#ff3b30",
        normal: "#ff3b30",
        rimColor: "#ffffff",
        rimAlpha: 0.95,
        shadowColor: "#000000",
        shadowAlpha: 0.5,
        shadowBlur: 4,
        activeRimColor: "#ffffff",
        activeShadowColor: "#102a4a",
        activeShadowAlpha: 0.4,
        glowColor: "#c4281f",
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
  },
};

/** The look as shipped, frozen at load, for anything that needs to compare or reset. */
export const STYLE_DEFAULTS = structuredClone(STYLE);
