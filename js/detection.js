// Snow Filter — MediaPipe detection, decoupled from the render loop.
//
// Two models run per detection tick, both in VIDEO mode on the GPU delegate:
//   • ImageSegmenter (selfie) → a person/background confidence mask, used by
//     the snow to collide with the body (§5.3).
//   • HandLandmarker → palm centres, used to brush snow away (§5.4).
//
// Everything here works in RAW (un-mirrored) video-normalized coordinates
// [0..1]. main.js owns the single mirrored sim space and maps into/out of it,
// so the mirror is handled in exactly one place (§6 "coordinate space").
//
// The class never throws from detection: if a model fails to load the matching
// feature is simply disabled and the snow degrades gracefully.

import { MP } from "./config.js";

const PALM_LANDMARKS = [0, 5, 9, 13, 17]; // wrist + finger MCPs → stable centre

export class Detector {
  constructor() {
    this.segmenter = null;
    this.handLm = null; // the HandLandmarker model
    this.segReady = false;
    this.handsReady = false;
    // Latest person mask, copied out of MediaPipe's transient buffer.
    this.mask = null; // { data: Float32Array, w, h }
    // Latest hands in video-normalized coords, with gesture metrics:
    //   { x, y (palm centre), size (hand span), open (0..1 finger openness) }
    this.hands = [];
    this._segBusy = false;
    this._lastTs = -1;
  }

  get anyReady() {
    return this.segReady || this.handsReady;
  }

  // Load both models. Resolves once (either/both ready, or both failed) so the
  // caller can start the experience regardless — snow works without models.
  async init() {
    let vision;
    try {
      vision = await import(/* @vite-ignore */ `${MP.base}/vision_bundle.mjs`);
    } catch (e) {
      console.warn("[snow] MediaPipe bundle failed to load; snow-only mode.", e);
      return;
    }
    const { ImageSegmenter, HandLandmarker, FilesetResolver } = vision;
    let resolver;
    try {
      resolver = await FilesetResolver.forVisionTasks(`${MP.base}/wasm`);
    } catch (e) {
      console.warn("[snow] MediaPipe wasm failed to load; snow-only mode.", e);
      return;
    }

    // Load in parallel; a failure in one must not sink the other.
    await Promise.all([
      (async () => {
        try {
          this.segmenter = await ImageSegmenter.createFromOptions(resolver, {
            baseOptions: { modelAssetPath: MP.segmentModel, delegate: "GPU" },
            runningMode: "VIDEO",
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          });
          this.segReady = true;
        } catch (e) {
          console.warn("[snow] Segmenter unavailable; no body collision.", e);
        }
      })(),
      (async () => {
        try {
          this.handLm = await HandLandmarker.createFromOptions(resolver, {
            baseOptions: { modelAssetPath: MP.handModel, delegate: "GPU" },
            runningMode: "VIDEO",
            numHands: MP.numHands,
          });
          this.handsReady = true;
        } catch (e) {
          console.warn("[snow] HandLandmarker unavailable; no hand gestures.", e);
        }
      })(),
    ]);
  }

  // Run both models for the given frame. `ts` must be strictly increasing.
  detect(video, ts) {
    if (ts <= this._lastTs) return; // VIDEO mode needs monotonic timestamps
    this._lastTs = ts;

    if (this.handsReady) {
      try {
        const res = this.handLm.detectForVideo(video, ts);
        this.hands = (res.landmarks || []).map(handMetrics);
      } catch (e) {
        // Transient decode hiccup — keep last known hands.
      }
    }

    if (this.segReady && !this._segBusy) {
      this._segBusy = true;
      try {
        this.segmenter.segmentForVideo(video, ts, (result) => {
          const masks = result.confidenceMasks;
          if (masks && masks.length) {
            // For selfie_segmenter the last confidence mask is the foreground
            // (person) probability. Copy it out before MediaPipe frees it.
            const m = masks[masks.length - 1];
            this.mask = {
              data: m.getAsFloat32Array().slice(),
              w: m.width,
              h: m.height,
            };
          }
          this._segBusy = false;
        });
      } catch (e) {
        this._segBusy = false;
      }
    }
  }

  // Person probability [0..1] at a raw (un-mirrored) video-normalized point.
  // Returns 0 when there's no mask yet (nothing to collide with).
  personProbAt(nx, ny) {
    const m = this.mask;
    if (!m) return 0;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return 0;
    const x = Math.min(m.w - 1, (nx * m.w) | 0);
    const y = Math.min(m.h - 1, (ny * m.h) | 0);
    return m.data[y * m.w + x];
  }
}

// [tip, pip] pairs for the four fingers (thumb excluded — unreliable for grip).
const FINGERS = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
];

// Reduce one hand's 21 landmarks to { x, y, size, open } in video-normalized
// coords. `open` is the fraction of fingers that are extended (a fingertip is
// "extended" when it's farther from the wrist than its PIP joint) → 0 = fist,
// 1 = open palm. `size` is the wrist→middle-MCP span, used to scale the ball.
function handMetrics(lm) {
  const wrist = lm[0];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  let cx = 0,
    cy = 0;
  for (const i of PALM_LANDMARKS) {
    cx += lm[i].x;
    cy += lm[i].y;
  }
  cx /= PALM_LANDMARKS.length;
  cy /= PALM_LANDMARKS.length;

  let extended = 0;
  for (const [tip, pip] of FINGERS) {
    if (dist(lm[tip], wrist) > dist(lm[pip], wrist)) extended++;
  }

  const size = dist(wrist, lm[9]) || 0.001; // wrist → middle-finger MCP
  const pinchDist = dist(lm[4], lm[8]) / size; // thumb tip ↔ index tip

  return {
    x: cx,
    y: cy,
    size,
    open: extended / FINGERS.length,
    // Pinch (thumb + index together) → used to grab the pull cord. `pinchX/Y`
    // is the point between the two fingertips (video-normalized coords).
    pinch: pinchDist < 0.55,
    pinchX: (lm[4].x + lm[8].x) / 2,
    pinchY: (lm[4].y + lm[8].y) / 2,
  };
}
