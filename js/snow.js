// Snow Filter — the snow itself: a body-aware particle system.
//
// Particles live in flat typed arrays (a fixed pool, no per-flake objects) so
// the GC stays flat over long sessions (§5.2). Each frame we:
//   1. emit new flakes from the top edge,
//   2. integrate falling flakes (gravity + wind + sway),
//   3. collide them with the person mask so they settle on top-facing edges
//      into a glowing rim (§5.3),
//   4. let a passing hand fling nearby flakes away (§5.4),
//   5. render every flake as a soft additive dot so overlaps glow.
//
// Coordinates are the mirrored sim space (CSS px). The `mapping` passed in each
// frame carries the video-cover transform so we can sample the (un-mirrored)
// person mask and place (un-mirrored) hand palms without the mirror leaking out
// of main.js.

import { SNOW, COLLISION, SWIPE, RENDER } from "./config.js";

const rand = (a, b) => a + Math.random() * (b - a);

export class SnowSystem {
  constructor() {
    const N = SNOW.maxParticles;
    this.capacity = N;
    this.cap = N; // active soft cap; the perf governor may lower this
    this.px = new Float32Array(N);
    this.py = new Float32Array(N);
    this.vx = new Float32Array(N);
    this.vy = new Float32Array(N);
    this.gv = new Float32Array(N); // per-flake gravity (depth)
    this.size = new Float32Array(N);
    this.baseAlpha = new Float32Array(N);
    this.alpha = new Float32Array(N);
    this.phase = new Float32Array(N); // sway/shimmer phase
    this.life = new Float32Array(N);
    this.state = new Uint8Array(N); // 0 falling, 1 settled
    this.active = new Uint8Array(N);
    this.occluded = new Uint8Array(N); // 1 = in front of body → hidden (behind)
    this.free = new Int32Array(N);
    for (let i = 0; i < N; i++) this.free[i] = N - 1 - i;
    this.freeTop = N; // number of slots on the free stack
    this.count = 0;
    this.settled = 0;
    this._emitAcc = 0;
    this._prevPalms = [];
    this._lastBrush = 0;
    this._sprite = makeDotSprite();
  }

  setCap(n) {
    this.cap = Math.max(0, Math.min(this.capacity, n | 0));
  }

  reset() {
    this.active.fill(0);
    this.state.fill(0);
    for (let i = 0; i < this.capacity; i++) this.free[i] = this.capacity - 1 - i;
    this.freeTop = this.capacity;
    this.count = 0;
    this.settled = 0;
  }

  _spawn(mapping) {
    if (this.freeTop === 0) return;
    const i = this.free[--this.freeTop];
    const s = rand(SNOW.sizeMin, SNOW.sizeMax);
    const depth = (s - SNOW.sizeMin) / (SNOW.sizeMax - SNOW.sizeMin); // 0..1
    this.px[i] = rand(-40, mapping.cW + 40);
    this.py[i] = rand(-60, -10);
    this.vx[i] = rand(-8, 8);
    this.vy[i] = rand(10, 40) * (0.6 + depth);
    this.gv[i] = SNOW.gravity - SNOW.gravityVariance * (1 - depth);
    this.size[i] = s;
    this.baseAlpha[i] = rand(SNOW.alphaMin, SNOW.alphaMax) * (0.55 + 0.45 * depth);
    this.alpha[i] = this.baseAlpha[i];
    this.phase[i] = rand(0, Math.PI * 2);
    this.life[i] = SNOW.fallLifetime;
    this.state[i] = 0;
    this.active[i] = 1;
    this.count++;
  }

  _kill(i) {
    if (!this.active[i]) return;
    if (this.state[i] === 1) this.settled--;
    this.active[i] = 0;
    this.count--;
    this.free[this.freeTop++] = i;
  }

  // Advance the whole system by `dt` seconds at wall-clock `time`.
  // `detector` may be null / not-ready; collision just no-ops then.
  update(dt, time, mapping, detector, emitting) {
    if (emitting) {
      this._emitAcc += SNOW.emitPerSecond * dt;
      while (this._emitAcc >= 1 && this.count < this.cap) {
        this._spawn(mapping);
        this._emitAcc -= 1;
      }
      if (this._emitAcc > SNOW.emitPerSecond) this._emitAcc = 0; // guard tab-hide
    }

    const globalWind = SNOW.windAmplitude * Math.sin(time * SNOW.windSpeed);
    const hasMask = !!(detector && detector.mask);
    const thr = COLLISION.personThreshold;
    const invDispW = 1 / mapping.dispW;
    const invDispH = 1 / mapping.dispH;

    for (let i = 0; i < this.capacity; i++) {
      if (!this.active[i]) continue;

      if (this.state[i] === 1) {
        // ---- settled: hold position, shimmer, slough off, or get dislodged
        this.occluded[i] = 0; // the rim always shows
        this.life[i] -= dt;
        const shimmer =
          1 - COLLISION.shimmer * (0.5 + 0.5 * Math.sin(time * 6 + this.phase[i]));
        this.alpha[i] = this.baseAlpha[i] * shimmer;

        let dislodge = this.life[i] <= 0;
        if (!dislodge && hasMask) {
          const nx = 1 - (this.px[i] - mapping.offsetX) * invDispW;
          const ny = (this.py[i] - mapping.offsetY) * invDispH;
          if (detector.personProbAt(nx, ny) < thr) dislodge = true; // body moved
        }
        if (dislodge) {
          this.state[i] = 0;
          this.settled--;
          this.vy[i] = rand(20, 60);
          this.vx[i] = rand(-12, 12);
          this.life[i] = SNOW.fallLifetime;
        }
        continue;
      }

      // ---- falling: integrate motion
      const sway = SNOW.swayAmplitude * Math.sin(time * 1.3 + this.phase[i]);
      const targetVx = globalWind + sway;
      this.vx[i] += (targetVx - this.vx[i]) * Math.min(1, dt * 1.8);
      this.vy[i] += this.gv[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.life[i] -= dt;

      // off-screen / expired → recycle
      if (
        this.py[i] > mapping.cH + 40 ||
        this.px[i] < -70 ||
        this.px[i] > mapping.cW + 70 ||
        this.life[i] <= 0
      ) {
        this._kill(i);
        continue;
      }

      // ---- body collision + occlusion (one mask sample)
      if (hasMask) {
        const nx = 1 - (this.px[i] - mapping.offsetX) * invDispW;
        const ny = (this.py[i] - mapping.offsetY) * invDispH;
        let here = 0;
        if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)
          here = detector.personProbAt(nx, ny);

        // Snow over the body is behind the person — hide it so flakes never
        // cover the face/body; only the settled rim shows on the person.
        this.occluded[i] = COLLISION.occludeInFront && here >= thr ? 1 : 0;

        // Settle on a top-facing edge (head/shoulders) → the glowing rim. Snow
        // piles heavier lower down: shoulder/body edges stick more readily and
        // linger longer than the head rim.
        if (here >= thr && this.vy[i] > 0 && this.settled < COLLISION.maxSettled) {
          const nyAbove = (this.py[i] - COLLISION.edgeProbe - mapping.offsetY) * invDispH;
          if (detector.personProbAt(nx, nyAbove) < thr) {
            // 0 at/above shoulderY (head), ramping to 1 toward the bottom.
            const lower = Math.min(
              1,
              Math.max(0, (ny - COLLISION.shoulderY) / (1 - COLLISION.shoulderY))
            );
            const chance = Math.min(
              1,
              COLLISION.settleChance * (1 + COLLISION.shoulderSettleBoost * lower)
            );
            if (Math.random() < chance) {
              this.state[i] = 1;
              this.vx[i] = 0;
              this.vy[i] = 0;
              this.life[i] =
                COLLISION.settledLifetime * (1 + COLLISION.shoulderLifeBoost * lower) +
                rand(0, 2);
              this.settled++;
              this.occluded[i] = 0; // this flake is now the rim → show it
            }
          }
        }
      } else {
        this.occluded[i] = 0;
      }
    }
  }

  // A passing hand flings nearby flakes off to the sides (§5.4). Called on
  // detection ticks with the latest palm centres (video-normalized coords).
  brush(mapping, palms, time) {
    const dt = time - this._lastBrush;
    this._lastBrush = time;
    if (!palms.length || dt <= 0 || dt > 0.25) {
      // stale/first sample: record positions, don't fling on a huge dt
      this._prevPalms = palms.map((p) => ({
        x: mapping.offsetX + mapping.dispW * (1 - p.x),
        y: mapping.offsetY + mapping.dispH * p.y,
      }));
      return;
    }

    const cur = palms.map((p) => ({
      x: mapping.offsetX + mapping.dispW * (1 - p.x),
      y: mapping.offsetY + mapping.dispH * p.y,
    }));

    for (const h of cur) {
      // match to nearest previous palm to estimate velocity
      let best = null,
        bestD = Infinity;
      for (const p of this._prevPalms) {
        const d = (p.x - h.x) ** 2 + (p.y - h.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      let hvx = 0,
        hvy = 0;
      if (best && bestD < SWIPE.radius * SWIPE.radius * 9) {
        hvx = (h.x - best.x) / dt;
        hvy = (h.y - best.y) / dt;
      }
      const speed = Math.hypot(hvx, hvy);
      if (speed < SWIPE.minSpeed) continue;

      const r2 = SWIPE.radius * SWIPE.radius;
      for (let i = 0; i < this.capacity; i++) {
        if (!this.active[i]) continue;
        const dx = this.px[i] - h.x;
        const dy = this.py[i] - h.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const d = Math.sqrt(d2) || 0.001;
        const falloff = 1 - d / SWIPE.radius; // stronger near the palm
        const ox = (dx / d) * SWIPE.outwardPush;
        const oy = (dy / d) * SWIPE.outwardPush;
        let ix = (hvx * SWIPE.velocityScale + ox) * falloff;
        let iy = (hvy * SWIPE.velocityScale + oy) * falloff;
        const im = Math.hypot(ix, iy);
        if (im > SWIPE.maxImpulse) {
          ix *= SWIPE.maxImpulse / im;
          iy *= SWIPE.maxImpulse / im;
        }
        if (this.state[i] === 1) this.settled--;
        this.state[i] = 0;
        this.vx[i] += ix;
        this.vy[i] += iy;
        this.life[i] = SNOW.fallLifetime;
      }
    }
    this._prevPalms = cur;
  }

  // Draw every flake as a soft additive dot so overlaps glow (§5.2).
  render(ctx) {
    const sprite = this._sprite;
    const ss = sprite.width;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < this.capacity; i++) {
      if (!this.active[i] || this.occluded[i]) continue;
      const draw = this.size[i] * 5; // sprite has a soft falloff → glow halo
      ctx.globalAlpha = this.alpha[i];
      ctx.drawImage(
        sprite,
        0,
        0,
        ss,
        ss,
        this.px[i] - draw * 0.5,
        this.py[i] - draw * 0.5,
        draw,
        draw
      );
    }
    ctx.restore();
  }
}

// A soft white dot: bright core fading to transparent, drawn once and reused.
function makeDotSprite() {
  const s = RENDER.spriteSize;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.85)");
  grd.addColorStop(0.55, "rgba(235,245,255,0.35)");
  grd.addColorStop(1, "rgba(220,235,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return c;
}
