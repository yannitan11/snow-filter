# Snow Filter ❄️

A single-page web app that opens your camera and drops a **body-aware** snow
effect on the live video. Instead of falling straight through the frame, flakes
collide with your silhouette and settle into a glowing rim along your head,
shoulders and arms — and you can **wave a hand to brush the snow away**.

Built to the spec in the project PRD. Original build; the effect mirrors the
reference clips (`unknownrealityarchive.com`).

- **Local folder:** `Snow Filter/` — vanilla, no-build ES-module app
  (`index.html`, `styles.css`, `js/`). No backend, no account, nothing recorded
  or uploaded; everything runs client-side.

## How it works

- **Camera** starts only after you tap **Turn on camera** (front camera,
  mirrored selfie view). Denied/no-camera shows a helpful message, not a blank
  screen.
- **Snow** is a fixed-pool typed-array particle system rendered as soft
  additive dots so overlaps glow.
- **Body collision** uses MediaPipe **ImageSegmenter** (selfie segmentation):
  falling flakes that land on a top-facing edge of your silhouette settle into
  the glowing outline, slough off over time, and re-fall when you move.
- **Brush-away** uses MediaPipe **HandLandmarker**: a moving palm flings nearby
  flakes off to the sides — a fast swipe clears more than a slow one.
- Both models load from a CDN at runtime. If they fail to load, the snow still
  falls (it just won't collide or respond to your hand) rather than hanging.

## Controls

- **Snow ON/OFF** (right edge, or `space`) — pauses the snow; camera stays on.
- **Reset** (centre circle, or `R`) — clears all accumulated snow.
- **Help (?)** (top-right, or `?`) — quick explainer.
- **Switch camera (⟳)** (top-left, mobile) — front/rear.

## Architecture

| File | Responsibility |
| --- | --- |
| `js/main.js` | Bootstrap + the single render loop; owns the one mirrored sim space, canvas sizing, detection cadence, perf governor. |
| `js/camera.js` | `getUserMedia`, mirroring, front/rear switch, permission/lifecycle + typed error messages. |
| `js/detection.js` | MediaPipe segmentation + hand tracking, decoupled from the render loop; works in raw (un-mirrored) video coords. |
| `js/snow.js` | The particle pool: emission, physics, body collision, hand brush-away, additive rendering. |
| `js/ui.js` | Landing / warm-up / error / live screens and on-camera controls. |
| `js/config.js` | All the feel knobs — snow density, gravity/wind, collision, swipe, perf thresholds. |

The mirror is handled in exactly one place (`main.js`): the camera is drawn
flipped, and everything else (mask sampling, hand palms) is mapped in/out of the
mirrored space through a single `mapping` transform. Detection runs in raw video
coordinates, so landmark x is un-mirrored there and only flipped when it enters
the sim — which keeps the swipe direction feeling natural.

## Run locally

Camera APIs need a secure context, so serve over `http://localhost` (not
`file://`):

```bash
cd "Snow Filter"
python3 -m http.server 8000
# → http://localhost:8000
```

Or use the shared preview helper from the parent folder:

```bash
./preview.sh "Snow Filter" 8130   # config name: snow-filter, port 8130
```

## Requirements

- A webcam and a browser with `getUserMedia` (mobile Safari iOS 16+, Chrome/Edge
  desktop, Chrome Android).
- HTTPS (or `localhost`) — required for camera access.
- Network access on first load to fetch the MediaPipe models from the CDN.

## Tuning

Everything about the look lives in `js/config.js`: `SNOW` (density, gravity,
wind, sizes), `COLLISION` (person threshold, how much sticks, slough-off),
`SWIPE` (brush radius/strength), and `PERF` (the fps thresholds that shed
particles on slow devices).

## Not in v1

Video capture/recording, a distinct "FOCUS" mode, multi-person tracking (extra
people just get snow too; it won't crash), and native apps — all flagged as
post-v1 in the PRD.
