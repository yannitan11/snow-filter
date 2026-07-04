// Snow Filter — bootstrap and the single render loop.
//
// This module owns the ONE mirrored sim space. Each frame it:
//   • sizes the canvas (dpr-aware),
//   • draws the mirrored, cover-fit camera frame,
//   • computes the video→sim mapping and runs detection at an adaptive cadence,
//   • advances + renders the snow,
//   • governs performance (sheds particles / detection when the fps sags).
//
// The camera starts only after an explicit tap (§4). Models load in the
// background — snow falls immediately and starts colliding once the segmenter
// is ready, so there's never a dead spinner.

import { CameraFeed, CAMERA_STATE, describeCameraError } from "./camera.js";
import { Detector } from "./detection.js";
import { SnowSystem } from "./snow.js";
import { Doodles } from "./doodles.js";
import { UI } from "./ui.js";
import { RENDER, PERF, SNOW, SEASONS, SEASONS_ENABLED, WINTER_STYLES } from "./config.js";

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d", { alpha: false });

const camera = new CameraFeed();
const detector = new Detector();
const snow = new SnowSystem();
const doodles = new Doodles();

let running = false;
let snowOn = true;
let rafId = 0;
let lastTime = 0;
let lastVideoTime = -1;

// --- season (winter/spring/summer/autumn), remembered across reloads
const SEASON_KEY = "seasonfilter.season";
let seasonIx = loadSeason();
let clearColor = SEASONS[seasonIx].tint;

// --- winter style: pull-cord cycles snow / snow+doodles / doodles
const STYLE_KEY = "snowfilter.wstyle";
let styleIx = loadStyle();
let snowActive = true; // does the current style include falling snow?
let doodlesActive = false; // does the current style show the doodle overlay?

// --- adaptive perf state
let detectEvery = 1; // run detection every N frames
let frameNo = 0;
let fpsEma = 60;
let lastGov = 0;

// --- current sim mapping (video-cover transform into mirrored CSS px)
const mapping = { cW: 0, cH: 0, dispW: 1, dispH: 1, offsetX: 0, offsetY: 0 };

const ui = new UI({
  onStart: start,
  onToggleSnow: toggleSnow,
  onReset: () => snow.reset(),
  onFlip: flipCamera,
  // In snow-only mode the cord switches style; otherwise it changes season.
  onSeason: SEASONS_ENABLED ? nextSeason : cycleStyle,
});

// ---------------------------------------------------------------- styles
function loadStyle() {
  // Default to "both" (index 1) so the doodles are visible out of the box.
  const n = parseInt(localStorage.getItem(STYLE_KEY) ?? "1", 10);
  return Number.isInteger(n) && n >= 0 && n < WINTER_STYLES.length ? n : 1;
}

function applyStyle({ announce = true } = {}) {
  const st = WINTER_STYLES[styleIx];
  snowActive = st.id !== "doodle"; // "doodle" style turns the snow off
  doodlesActive = st.id !== "snow"; // doodles show in "both" and "doodle"
  doodles.setVisible(doodlesActive);
  ui.setStyle(st, { announce });
  try {
    localStorage.setItem(STYLE_KEY, String(styleIx));
  } catch {}
}

function cycleStyle() {
  styleIx = (styleIx + 1) % WINTER_STYLES.length;
  applyStyle();
}

// ---------------------------------------------------------------- seasons
function loadSeason() {
  if (!SEASONS_ENABLED) return 0; // snow-only: locked to Winter
  const n = parseInt(localStorage.getItem(SEASON_KEY) ?? "0", 10);
  return Number.isInteger(n) && n >= 0 && n < SEASONS.length ? n : 0;
}

function applySeason({ announce = true } = {}) {
  const theme = SEASONS[seasonIx];
  snow.setSeason(theme); // swaps sprites/physics + clears the field
  ui.setSeason(theme, { announce });
  clearColor = theme.tint;
  document.documentElement.style.setProperty("--accent", theme.accent);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.tint);
  try {
    localStorage.setItem(SEASON_KEY, String(seasonIx));
  } catch {}
}

function nextSeason() {
  if (!SEASONS_ENABLED) return; // snow-only: switching disabled
  seasonIx = (seasonIx + 1) % SEASONS.length;
  applySeason();
}

// ---------------------------------------------------------------- canvas
function resize() {
  const dpr = Math.min(RENDER.maxDpr, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
  mapping.cW = w;
  mapping.cH = h;
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- start
async function start() {
  ui.showWarmup("Warming up the camera…");
  try {
    await camera.start("user");
  } catch (err) {
    ui.showError(describeCameraError(err));
    return;
  }
  ui.setSnowOn(snowOn);
  ui.showLive();
  maybeShowFlip();

  // Models load in the background — don't block the experience on them.
  detector.init();

  if (!running) {
    running = true;
    lastTime = performance.now();
    rafId = requestAnimationFrame(loop);
  }
}

async function flipCamera() {
  const ok = await camera.flip();
  if (!ok) return;
  lastVideoTime = -1;
  snow.reset();
}

async function maybeShowFlip() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    ui.setFlipVisible(cams.length > 1 || coarse);
  } catch {
    ui.setFlipVisible(false);
  }
}

function toggleSnow() {
  snowOn = !snowOn;
  ui.setSnowOn(snowOn);
}

// ------------------------------------------------------------------ loop
function loop() {
  rafId = requestAnimationFrame(loop);
  const now = performance.now();
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt <= 0) return;
  if (dt > 0.05) dt = 0.05; // clamp after tab-hide / long frames
  const time = now / 1000;

  const video = camera.video;
  const ready = camera.state === CAMERA_STATE.live && video.videoWidth > 0;

  // ---- draw the mirrored, cover-fit camera frame + compute mapping
  ctx.fillStyle = clearColor;
  ctx.fillRect(0, 0, mapping.cW, mapping.cH);

  if (ready) {
    const vW = video.videoWidth;
    const vH = video.videoHeight;
    const scale = Math.max(mapping.cW / vW, mapping.cH / vH);
    mapping.dispW = vW * scale;
    mapping.dispH = vH * scale;
    mapping.offsetX = (mapping.cW - mapping.dispW) / 2;
    mapping.offsetY = (mapping.cH - mapping.dispH) / 2;

    ctx.save();
    if (camera.mirrored) {
      ctx.translate(mapping.cW, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, mapping.offsetX, mapping.offsetY, mapping.dispW, mapping.dispH);
    ctx.restore();

    // Slight dim so bright snow reads against a light room.
    if (RENDER.videoDim > 0) {
      ctx.fillStyle = `rgba(4,7,14,${RENDER.videoDim})`;
      ctx.fillRect(0, 0, mapping.cW, mapping.cH);
    }

    // ---- detection at an adaptive cadence, on fresh frames only
    frameNo++;
    if (video.currentTime !== lastVideoTime && frameNo % detectEvery === 0) {
      lastVideoTime = video.currentTime;
      detector.detect(video, now);
      if (detector.handsReady) snow.hands(mapping, detector.hands, time);
    }

    // ---- snow: update + render (OFF or doodle-only style = hidden, camera stays)
    if (snowOn && snowActive) {
      snow.update(dt, time, mapping, detector, true);
      snow.render(ctx);
    }
  }

  governPerformance(dt, now);
}

// Shed particles / detection cadence when the frame rate sags; recover when
// there's headroom. Keeps the effect smooth instead of stuttering (§7).
function governPerformance(dt, now) {
  const fps = 1 / dt;
  fpsEma = fpsEma * 0.9 + fps * 0.1;
  if (now - lastGov < 1000) return;
  lastGov = now;

  if (fpsEma < PERF.lowFps) {
    snow.setCap(Math.max(PERF.minParticles, Math.round(snow.cap * 0.85)));
    detectEvery = 2;
  } else if (fpsEma > PERF.highFps) {
    snow.setCap(Math.min(SNOW.maxParticles, Math.round(snow.cap * 1.08) + 20));
    detectEvery = 1;
  }
}

// -------------------------------------------------------- lifecycle
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  } else if (running) {
    lastTime = performance.now();
    if (!rafId) rafId = requestAnimationFrame(loop);
  }
});

applySeason({ announce: false }); // set the remembered season without a flash
applyStyle({ announce: false }); // apply the remembered snow/doodle style (shows cord)
ui.showLanding();
