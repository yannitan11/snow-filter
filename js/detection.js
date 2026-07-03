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
    this.hands = null;
    this.segReady = false;
    this.handsReady = false;
    // Latest person mask, copied out of MediaPipe's transient buffer.
    this.mask = null; // { data: Float32Array, w, h }
    // Latest palm centres in video-normalized coords: [{ x, y }].
    this.palms = [];
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
          this.hands = await HandLandmarker.createFromOptions(resolver, {
            baseOptions: { modelAssetPath: MP.handModel, delegate: "GPU" },
            runningMode: "VIDEO",
            numHands: MP.numHands,
          });
          this.handsReady = true;
        } catch (e) {
          console.warn("[snow] HandLandmarker unavailable; no brush-away.", e);
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
        const res = this.hands.detectForVideo(video, ts);
        this.palms = (res.landmarks || []).map((lm) => {
          let x = 0,
            y = 0;
          for (const i of PALM_LANDMARKS) {
            x += lm[i].x;
            y += lm[i].y;
          }
          return { x: x / PALM_LANDMARKS.length, y: y / PALM_LANDMARKS.length };
        });
      } catch (e) {
        // Transient decode hiccup — keep last known palms.
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
