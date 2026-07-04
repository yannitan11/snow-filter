// Snow Filter — the "wrap" doodle: a chalky white ribbon that coils around the
// person. It passes BEHIND the body on the back half of each loop and IN FRONT
// on the near half, using the segmentation mask to hide the back segments where
// the person is — which reads as the ribbon wrapping around them (like the
// reference). Drawn on the main canvas each frame; slowly rotates.

import { COLLISION } from "./config.js";

export class Swirl {
  constructor() {
    // Smoothed person band in sim space (CSS px).
    this.cx = 0;
    this.topY = 0;
    this.botY = 0;
    this.halfW = 0;
    this._init = false;
  }

  // Recompute the person's centre + vertical extent + width from the mask.
  // Cheap scan of the low-res mask; call on detection ticks.
  updateFromMask(mapping, detector) {
    const m = detector && detector.mask;
    if (!m) return;
    const thr = COLLISION.personThreshold;
    let minNx = 1,
      maxNx = 0,
      minNy = 1,
      maxNy = 0,
      sumNx = 0,
      n = 0;
    for (let y = 0; y < m.h; y++) {
      const row = y * m.w;
      for (let x = 0; x < m.w; x++) {
        if (m.data[row + x] >= thr) {
          const nx = x / m.w;
          const ny = y / m.h;
          if (nx < minNx) minNx = nx;
          if (nx > maxNx) maxNx = nx;
          if (ny < minNy) minNy = ny;
          if (ny > maxNy) maxNy = ny;
          sumNx += nx;
          n++;
        }
      }
    }
    if (n < 24) return; // no meaningful person this frame

    const cnx = sumNx / n;
    const cx = mapping.offsetX + mapping.dispW * (1 - cnx); // mirror x
    const topY = mapping.offsetY + mapping.dispH * minNy;
    const botY = mapping.offsetY + mapping.dispH * maxNy;
    const halfW = (mapping.dispW * (maxNx - minNx)) / 2;

    if (!this._init) {
      this.cx = cx;
      this.topY = topY;
      this.botY = botY;
      this.halfW = halfW;
      this._init = true;
    } else {
      const k = 0.18; // smoothing to avoid jitter
      this.cx += (cx - this.cx) * k;
      this.topY += (topY - this.topY) * k;
      this.botY += (botY - this.botY) * k;
      this.halfW += (halfW - this.halfW) * k;
    }
  }

  draw(ctx, mapping, detector, time) {
    // Person band (or a centred fallback before the mask is ready).
    let cx, topY, botY, halfW;
    if (this._init) {
      cx = this.cx;
      topY = this.topY;
      botY = this.botY;
      halfW = this.halfW;
    } else {
      cx = mapping.cW * 0.5;
      topY = mapping.cH * 0.16;
      botY = mapping.cH * 0.92;
      halfW = mapping.cW * 0.22;
    }

    const m = detector && detector.mask;
    const thr = COLLISION.personThreshold;
    const turns = 3.1; // how many times it coils
    const phase = time * 0.5; // slow rotation around the body
    const spanTop = topY - (botY - topY) * 0.06;
    const spanH = botY - spanTop;
    const R = Math.max(70, halfW * 1.18); // wrap radius (just outside the body)
    const invDispW = 1 / mapping.dispW;
    const invDispH = 1 / mapping.dispH;

    // Build the visible runs (breaks where a back segment is behind the body).
    const steps = 240;
    const runs = [];
    let cur = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const th = t * turns * Math.PI * 2;
      const wobble = Math.sin(th * 3 + phase) * 4; // slight hand-drawn imperfection
      const x = cx + Math.cos(th + phase) * R + wobble;
      const y = spanTop + t * spanH + Math.cos(th * 2) * 3;
      const depth = Math.sin(th + phase); // >0 near/front, <0 far/back

      let hidden = false;
      if (depth < 0 && m) {
        const nx = 1 - (x - mapping.offsetX) * invDispW;
        const ny = (y - mapping.offsetY) * invDispH;
        if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 && detector.personProbAt(nx, ny) >= thr)
          hidden = true; // behind the body → occluded
      }
      if (hidden) {
        if (cur && cur.length > 1) runs.push(cur);
        cur = null;
        continue;
      }
      if (!cur) cur = [];
      cur.push(x, y);
    }
    if (cur && cur.length > 1) runs.push(cur);

    const coreW = Math.max(5, mapping.cW * 0.0085);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const strokeRuns = (w, style, blur) => {
      ctx.lineWidth = w;
      ctx.strokeStyle = style;
      ctx.shadowBlur = blur;
      ctx.shadowColor = "rgba(190,225,255,0.7)";
      for (const run of runs) {
        ctx.beginPath();
        ctx.moveTo(run[0], run[1]);
        for (let j = 2; j < run.length; j += 2) ctx.lineTo(run[j], run[j + 1]);
        ctx.stroke();
      }
    };
    strokeRuns(coreW * 2.4, "rgba(205,230,255,0.22)", 0); // soft chalk halo
    strokeRuns(coreW, "rgba(255,255,255,0.95)", 6); // crisp core
    ctx.restore();
  }
}
