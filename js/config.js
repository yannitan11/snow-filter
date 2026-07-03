// Snow Filter — tunable constants.
//
// All the "how does it feel" knobs live here so the effect is easy to dial in
// without touching the simulation code. Units: sim space is CSS pixels of the
// canvas (same space the user sees), time is in seconds, velocities in px/s.

// ------------------------------------------------------------- MediaPipe
export const MP = {
  version: "0.10.14",
  get base() {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${this.version}`;
  },
  // Selfie segmentation → person-vs-background confidence mask (§5.3 collision).
  segmentModel:
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
  // Hand keypoints → swipe-to-clear (§5.4).
  handModel:
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  numHands: 2,
};

// ----------------------------------------------------------------- Camera
export const CAMERA = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
};

// ------------------------------------------------------------------- Snow
export const SNOW = {
  // Hard cap on live particles. Auto-reduced on slow devices (see PERF).
  maxParticles: 3000,
  // New particles emitted per second across the top edge.
  emitPerSecond: 700,
  // Downward pull (px/s²) and its variance (smaller flakes fall slower).
  gravity: 220,
  gravityVariance: 90,
  // Sideways wind: a slow global sine plus per-particle sway.
  windAmplitude: 26, // px/s
  windSpeed: 0.18, // how fast the global wind oscillates
  swayAmplitude: 18, // px/s per-particle drift
  // Flake sizes (radius in px). Small variance gives a sense of depth.
  sizeMin: 1.2,
  sizeMax: 3.4,
  // Falling flake opacity.
  alphaMin: 0.5,
  alphaMax: 0.95,
  // A flake that never settles fades out over this many seconds once off-screen.
  fallLifetime: 14,
};

// ---------------------------------------------------------------- Seasons
// The app is one particle engine themed per season. Each season sets its own
// look (shape, palette, blend) and physics (fall/flutter/rotation/size); the
// shared mechanics — body-collision rim, occlusion, squeeze-into-a-ball, throw
// — carry across all of them. Pull the cord to cycle through in order.
//
// `phys`: gravity/gravityVar (px/s²), wind/sway (px/s horizontal), emit
// (particles/sec), sizeMin/Max (draw radius seed), life (falling lifetime s),
// alphaMin/Max, rotate (spin the sprite), spin (max rad/s), drawScale (sprite
// draw size = size × this). `shape`: how the sprite is drawn. `blend`:
// "lighter" glows (snow, light), "source-over" keeps true colours (petals,
// leaves). `blossom`: extra whole-flower colours mixed in (spring only).
export const SEASONS = [
  {
    id: "winter",
    name: "Winter",
    particle: "Snow",
    emoji: "❄️",
    accent: "#7fb8ff",
    tint: "#05070d",
    blend: "lighter",
    shape: "dot",
    palette: ["#ffffff", "#eaf3ff", "#dbe8ff"],
    phys: {
      gravity: SNOW.gravity,
      gravityVar: SNOW.gravityVariance,
      wind: SNOW.windAmplitude,
      sway: SNOW.swayAmplitude,
      emit: SNOW.emitPerSecond,
      sizeMin: SNOW.sizeMin,
      sizeMax: SNOW.sizeMax,
      alphaMin: SNOW.alphaMin,
      alphaMax: SNOW.alphaMax,
      life: SNOW.fallLifetime,
      rotate: false,
      spin: 0,
      drawScale: 5,
    },
  },
  {
    id: "spring",
    name: "Spring",
    particle: "Petals",
    emoji: "🌸",
    accent: "#ff9ec7",
    tint: "#120a12",
    blend: "source-over",
    shape: "petal",
    // Loose petals — soft blush + lavender filler between the flowers.
    palette: ["#ffdbe8", "#ffc2d8", "#ffb0cd", "#fff2f6", "#e9d5ff"],
    // Cute whole flowers in a cheerful spring mix (5-petal blooms + daisies),
    // each with a warm glowing centre.
    flowerColors: [
      "#ff9ec7", // pink
      "#ff85b3", // rose
      "#c8a2ff", // lavender
      "#9ec7ff", // periwinkle
      "#ffe07a", // buttercup
      "#ffb38a", // peach
      "#ff9e9e", // coral
      "#fff2f6", // white
    ],
    daisyColors: ["#fff2f6", "#ffc2d8", "#c8a2ff", "#9ec7ff"],
    centers: ["#ffd23f", "#fff0b8", "#ff9d3f"], // warm flower centres
    phys: {
      gravity: 74, // slower, more graceful than snow
      gravityVar: 40,
      wind: 34,
      sway: 0, // superseded by flutter below
      emit: 300,
      sizeMin: 7,
      sizeMax: 14,
      alphaMin: 0.82,
      alphaMax: 1.0,
      life: 18,
      rotate: true,
      spin: 1.7, // calmer tumble
      drawScale: 3,
      // Fluttering fall: each petal seesaws horizontally at its own frequency
      // with a coupled vertical bob, so it tumbles like a real petal instead
      // of drifting straight down.
      flutter: true,
      flutterAmp: 76, // px/s horizontal sway
      flutterFreqMin: 0.7,
      flutterFreqMax: 1.7,
      bob: 44, // px/s vertical speed-up/slow-down through the swing
    },
  },
  {
    id: "summer",
    name: "Summer",
    particle: "Light",
    emoji: "☀️",
    accent: "#ffd76a",
    tint: "#0d0a05",
    blend: "lighter",
    shape: "dot",
    palette: ["#fff2c2", "#ffe08a", "#ffd76a", "#eaffcf"],
    phys: {
      gravity: 46, // warm motes drift slowly
      gravityVar: 30,
      wind: 46,
      sway: 40,
      emit: 260,
      sizeMin: 2.2,
      sizeMax: 5.5,
      alphaMin: 0.5,
      alphaMax: 0.95,
      life: 18,
      rotate: false,
      spin: 0,
      drawScale: 6,
    },
  },
  {
    id: "autumn",
    name: "Autumn",
    particle: "Leaves",
    emoji: "🍂",
    accent: "#ff9d52",
    tint: "#100a06",
    blend: "source-over",
    shape: "leaf",
    palette: ["#e8792b", "#d24f2a", "#f2a83c", "#c0641f", "#b8862f"],
    phys: {
      gravity: 105,
      gravityVar: 55,
      wind: 52,
      sway: 66,
      emit: 260,
      sizeMin: 8,
      sizeMax: 15,
      alphaMin: 0.9,
      alphaMax: 1.0,
      life: 16,
      rotate: true,
      spin: 2.8,
      drawScale: 3,
    },
  },
];

// -------------------------------------------------------- Body collision
export const COLLISION = {
  // Person-probability threshold (0..1) for "this pixel is the body".
  personThreshold: 0.55,
  // How far above a flake (sim px) we probe to detect a top-facing edge. A
  // flake settles when it is ON the body but the point just above it is NOT —
  // i.e. it has just landed on a top-facing surface (head, shoulders, arms).
  edgeProbe: 10,
  // Only this fraction of eligible flakes actually stick, so we build a glowing
  // rim rather than a solid fill.
  settleChance: 0.75,
  // Cap on settled flakes so accumulation never gets infinitely heavy.
  maxSettled: 1700,
  // Snow piles heavier lower down (shoulders/body) than on the head. The
  // weighting ramps in below `shoulderY` (normalized, 0 = top of frame): edges
  // there stick more readily and the snow lingers longer before sloughing off.
  shoulderY: 0.45,
  shoulderSettleBoost: 1.4, // up to (1+this)× more likely to stick on shoulders
  shoulderLifeBoost: 1.6, // and lasts up to (1+this)× longer → it builds up
  // Hide falling flakes that pass IN FRONT of the body, so snow never covers
  // the face — it reads as snow falling behind you and settling on top. The
  // glowing rim (settled flakes on top-facing edges) still shows.
  occludeInFront: true,
  // A settled flake sloughs off after this long, regaining downward velocity.
  settledLifetime: 6,
  // Gentle shimmer applied to settled flakes so the rim glitters.
  shimmer: 0.18,
};

// --------------------------------------------------------- Hand brush-away
export const SWIPE = {
  // Flakes within this radius (sim px) of a moving hand get flung.
  radius: 110,
  // Hand speed (px/s) below this does nothing — resting hands don't clear snow.
  minSpeed: 90,
  // Impulse scaling: flung velocity ≈ hand velocity × this, plus outward push.
  velocityScale: 0.9,
  outwardPush: 320, // px/s away from the hand centre
  maxImpulse: 1600, // clamp so a fast swipe can't launch flakes absurdly far
};

// ------------------------------------------------- Snowball (squeeze/throw)
export const SNOWBALL = {
  // Closing your fist gathers snow within this radius of the palm into a ball.
  // Radius = hand size × scale, clamped to at least `gatherRadiusMin` (sim px).
  gatherRadiusScale: 1.6,
  gatherRadiusMin: 80,
  // While held, the ball keeps soaking up falling snow within this radius.
  absorbRadius: 40,
  // Packed radius of the held ball (sim px) — flakes cluster this tightly.
  coreRadius: 18,
  // Hard cap on flakes per ball (perf + a tidy, dense look).
  maxParticles: 340,
  // Openness (fraction of extended fingers, 0..1) gesture thresholds, with a
  // gap between them for hysteresis so the state doesn't flicker.
  closeThreshold: 0.3, // ≤ this → fist (squeeze / hold)
  openThreshold: 0.7, // ≥ this → open palm (throw)
  // Throw dynamics.
  throwScale: 1.7, // launch speed = hand speed × this
  throwCap: 2400, // clamp launch speed (px/s)
  throwLift: 200, // upward bias so the ball arcs (px/s)
  throwSpread: 150, // random scatter added so it bursts, not a laser
  minThrowSpeed: 130, // slower than this at release → a gentle default toss…
  defaultThrow: 560, // …at this speed, in the last motion direction (or up)
  // Hand lost while holding: after this long the ball just drops.
  dropAfter: 0.35, // seconds
  removeAfter: 0.8, // seconds missing before the hand slot is forgotten
  velSmoothing: 0.5, // hand-velocity smoothing (0..1, higher = snappier)
  // Held-ball flakes stay visible crossing the body for this long after throw.
  throwGrace: 0.7, // seconds
};

// ------------------------------------------------------------- Rendering
export const RENDER = {
  // Device-pixel-ratio cap — keeps the backing store cheap on retina phones.
  maxDpr: 1.5,
  // Soft-dot sprite resolution (px). Drawn once, reused for every flake.
  spriteSize: 64,
  // Slight video dim so bright snow reads against a light room.
  videoDim: 0.12,
};

// ------------------------------------------------------- Perf governor
export const PERF = {
  // If smoothed fps drops below this, shed particles / detection cadence.
  lowFps: 26,
  // If it climbs above this with headroom, allow the cap to recover.
  highFps: 52,
  // Lowest the particle cap is allowed to fall to.
  minParticles: 900,
};
