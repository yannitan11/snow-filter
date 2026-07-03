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
  maxSettled: 1400,
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
