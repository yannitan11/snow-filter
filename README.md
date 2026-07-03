# Season Filter ❄️🌸☀️🍂

A single-page web app that opens your camera and drops a **body-aware** falling
**season** on the live video. Instead of falling straight through the frame,
particles collide with your silhouette and settle into a glowing rim along your
head, shoulders and arms — you can **wave to brush them away**, **squeeze a
handful into a ball and throw it**, and **pull the cord to change season**.

Started as a snow filter (built to the project PRD; the effect mirrors the
reference clips at `unknownrealityarchive.com`), then extended into all four
seasons. Repo/folder stay `snow-filter`.

- **Local folder:** `Snow Filter/` — vanilla, no-build ES-module app
  (`index.html`, `styles.css`, `js/`). No backend, no account, nothing recorded
  or uploaded; everything runs client-side. Your season is remembered in
  `localStorage`.

## Seasons

Pull the cord (or tap it, or press `s`) to cycle through:

| | Season | Particles |
| --- | --- | --- |
| ❄️ | Winter | glowing snow (additive) |
| 🌸 | Spring | cherry-blossom petals + occasional whole blossoms |
| ☀️ | Summer | warm, slow-drifting light motes |
| 🍂 | Autumn | tumbling leaves |

Each season is just a theme (shape, palette, blend, physics) over one engine —
the body-collision rim, in-front occlusion, and squeeze/throw mechanics are
shared. Add or tune a season by editing the `SEASONS` array in `js/config.js`.

## How it works

- **Camera** starts only after you tap **Turn on camera** (front camera,
  mirrored selfie view). Denied/no-camera shows a helpful message, not a blank
  screen.
- **Particles** are one fixed-pool typed-array system, drawn with per-season
  sprites (soft dots, petals, blossoms, leaves) and blend mode.
- **Body collision** uses MediaPipe **ImageSegmenter** (selfie segmentation):
  particles that land on a top-facing edge of your silhouette settle into the
  glowing outline (heavier on the shoulders), slough off over time, and re-fall
  when you move. Particles passing in front of your body are hidden, so nothing
  ever covers your face.
- **Hands** use MediaPipe **HandLandmarker**: a moving palm flings particles
  off to the sides; a **closed fist** near the particles gathers them into a
  ball that follows your hand and keeps absorbing; an **open palm** throws the
  ball along your hand's motion with an upward arc.
- All models load from a CDN at runtime. If they fail to load, particles still
  fall (they just won't collide or respond to your hand) rather than hanging.

## Controls

- **Pull cord** (top, drag/tap, or `s`) — change season.
- **ON/OFF** (right edge, or `space`) — pauses the effect; camera stays on.
- **Reset** (centre circle, or `R`) — clears everything on screen.
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
