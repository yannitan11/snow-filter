// Snow Filter — the snow itself: a body-aware particle system.
//
// Particles live in flat typed arrays (a fixed pool, no per-flake objects) so
// the GC stays flat over long sessions (§5.2). Each frame we:
//   1. emit new flakes from the top edge,
//   2. integrate falling flakes (gravity + wind + sway),
//   3. collide them with the person mask so they settle on top-facing edges
//      into a glowing rim, and hide flakes passing in front of the body,
//   4. let the hands play: a fast swipe flings snow away, a closed fist
//      gathers snow into a held snowball, an opening palm throws it,
//   5. render every flake as a soft additive dot so overlaps glow.
//
// Particle `state`: 0 = falling, 1 = settled (rim), 2 = held in a snowball.
//
// Coordinates are the mirrored sim space (CSS px). The `mapping` passed in each
// frame carries the video-cover transform so we can sample the (un-mirrored)
// person mask and place (un-mirrored) hands without the mirror leaking out of
// main.js.

import { SNOW, COLLISION, SWIPE, SNOWBALL, RENDER } from "./config.js";

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
    this.state = new Uint8Array(N); // 0 falling, 1 settled, 2 held in a ball
    this.active = new Uint8Array(N);
    this.occluded = new Uint8Array(N); // 1 = in front of body → hidden (behind)
    this.ballOx = new Float32Array(N); // offset within the held ball
    this.ballOy = new Float32Array(N);
    this.owner = new Int8Array(N).fill(-1); // hand-slot index for held flakes
    this.showT = new Float32Array(N); // ignore occlusion until this time (throws)
    this.free = new Int32Array(N);
    for (let i = 0; i < N; i++) this.free[i] = N - 1 - i;
    this.freeTop = N; // number of slots on the free stack
    this.count = 0;
    this.settled = 0;
    this._emitAcc = 0;
    // Up to two persistent hand slots: { cx, cy, vx, vy, size, open, holding,
    // missing }. Snowball `owner` indexes into this array.
    this.hslots = [null, null];
    this.ballCount = new Int32Array(2); // flakes held per slot
    this._anyHolding = false;
    this._lastHand = 0;
    this._sprite = makeDotSprite();
  }

  setCap(n) {
    this.cap = Math.max(0, Math.min(this.capacity, n | 0));
  }

  reset() {
    this.active.fill(0);
    this.state.fill(0);
    this.owner.fill(-1);
    this.showT.fill(0);
    for (let i = 0; i < this.capacity; i++) this.free[i] = this.capacity - 1 - i;
    this.freeTop = this.capacity;
    this.count = 0;
    this.settled = 0;
    this.hslots = [null, null];
    this.ballCount.fill(0);
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
    this.owner[i] = -1;
    this.showT[i] = 0;
    this.active[i] = 1;
    this.count++;
  }

  _kill(i) {
    if (!this.active[i]) return;
    if (this.state[i] === 1) this.settled--;
    else if (this.state[i] === 2 && this.owner[i] >= 0) this.ballCount[this.owner[i]]--;
    this.state[i] = 0;
    this.owner[i] = -1;
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

    this._anyHolding = this.hslots.some((s) => s && s.holding);
    const globalWind = SNOW.windAmplitude * Math.sin(time * SNOW.windSpeed);
    const hasMask = !!(detector && detector.mask);
    const thr = COLLISION.personThreshold;
    const invDispW = 1 / mapping.dispW;
    const invDispH = 1 / mapping.dispH;
    const absorb2 = SNOWBALL.absorbRadius * SNOWBALL.absorbRadius;

    for (let i = 0; i < this.capacity; i++) {
      if (!this.active[i]) continue;

      if (this.state[i] === 2) {
        // ---- held in a snowball: cling to the owner hand as a tight cluster
        const slot = this.owner[i] >= 0 ? this.hslots[this.owner[i]] : null;
        if (!slot || !slot.holding) {
          this._release(i); // owner gone → let it fall
          continue;
        }
        const jx = Math.sin(time * 22 + this.phase[i]) * 1.3;
        const jy = Math.cos(time * 19 + this.phase[i]) * 1.3;
        this.px[i] = slot.cx + this.ballOx[i] + jx;
        this.py[i] = slot.cy + this.ballOy[i] + jy;
        this.occluded[i] = 0;
        this.alpha[i] = Math.min(1, this.baseAlpha[i] * 1.25 + 0.2);
        continue;
      }

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

      // ---- a held snowball soaks up falling snow that drifts into it
      if (this._anyHolding) {
        let absorbed = false;
        for (let s = 0; s < this.hslots.length; s++) {
          const slot = this.hslots[s];
          if (!slot || !slot.holding || this.ballCount[s] >= SNOWBALL.maxParticles)
            continue;
          const dx = this.px[i] - slot.cx;
          const dy = this.py[i] - slot.cy;
          if (dx * dx + dy * dy < absorb2) {
            this._attach(i, s);
            absorbed = true;
            break;
          }
        }
        if (absorbed) continue;
      }

      // ---- body collision + occlusion (one mask sample)
      if (hasMask) {
        const nx = 1 - (this.px[i] - mapping.offsetX) * invDispW;
        const ny = (this.py[i] - mapping.offsetY) * invDispH;
        let here = 0;
        if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)
          here = detector.personProbAt(nx, ny);

        // Snow over the body is behind the person — hide it so flakes never
        // cover the face/body; only the settled rim shows on the person. A
        // just-thrown ball is exempt briefly so you see it leave the hand.
        this.occluded[i] =
          COLLISION.occludeInFront && here >= thr && time >= this.showT[i] ? 1 : 0;

        // Settle on a top-facing edge (head/shoulders) → the glowing rim. Snow
        // piles heavier lower down: shoulder/body edges stick more readily and
        // linger longer than the head rim.
        if (here >= thr && this.vy[i] > 0 && this.settled < COLLISION.maxSettled) {
          const nyAbove = (this.py[i] - COLLISION.edgeProbe - mapping.offsetY) * invDispH;
          if (detector.personProbAt(nx, nyAbove) < thr) {
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

  // Per-detection-tick hand handling: swipe brush, squeeze-to-gather, and
  // open-to-throw. `hands` are video-normalized { x, y, size, open }.
  hands(mapping, hands, time) {
    const dt = time - this._lastHand;
    this._lastHand = time;
    const vDt = dt > 0 && dt <= 0.25 ? dt : 0; // 0 → don't trust velocity

    // Detected hands → sim space, carrying gesture metrics.
    const cur = hands.map((h) => ({
      x: mapping.offsetX + mapping.dispW * (1 - h.x),
      y: mapping.offsetY + mapping.dispH * h.y,
      size: Math.max(SNOWBALL.gatherRadiusMin, h.size * mapping.dispW),
      open: h.open,
    }));

    const slots = this.hslots;
    const usedCur = new Array(cur.length).fill(false);
    const matchMax = (Math.max(mapping.cW, mapping.cH) * 0.5) ** 2;

    // Update existing slots with their nearest current hand.
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s];
      if (!slot) continue;
      let best = -1,
        bestD = Infinity;
      for (let c = 0; c < cur.length; c++) {
        if (usedCur[c]) continue;
        const d = (cur[c].x - slot.cx) ** 2 + (cur[c].y - slot.cy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best >= 0 && bestD < matchMax) {
        usedCur[best] = true;
        this._updateSlot(s, cur[best], vDt, time);
      } else {
        this._missSlot(s, dt, time);
      }
    }

    // Adopt any unmatched hand into a free slot (max two).
    for (let c = 0; c < cur.length; c++) {
      if (usedCur[c]) continue;
      const free = slots[0] ? (slots[1] ? -1 : 1) : 0;
      if (free < 0) break;
      slots[free] = {
        cx: cur[c].x,
        cy: cur[c].y,
        vx: 0,
        vy: 0,
        size: cur[c].size,
        open: cur[c].open,
        holding: false,
        missing: 0,
      };
    }
  }

  _updateSlot(s, hand, dt, time) {
    const slot = this.hslots[s];
    if (dt > 0) {
      const nvx = (hand.x - slot.cx) / dt;
      const nvy = (hand.y - slot.cy) / dt;
      slot.vx += (nvx - slot.vx) * SNOWBALL.velSmoothing;
      slot.vy += (nvy - slot.vy) * SNOWBALL.velSmoothing;
    }
    slot.cx = hand.x;
    slot.cy = hand.y;
    slot.size = hand.size;
    slot.open = hand.open;
    slot.missing = 0;

    if (!slot.holding && hand.open <= SNOWBALL.closeThreshold) {
      // squeeze → gather nearby snow into a ball
      const r = Math.max(SNOWBALL.gatherRadiusMin, hand.size * SNOWBALL.gatherRadiusScale);
      if (this._gather(s, slot.cx, slot.cy, r) > 0) slot.holding = true;
    } else if (slot.holding && hand.open >= SNOWBALL.openThreshold) {
      // open palm → throw
      this._throw(s, slot.vx, slot.vy, time, false);
      slot.holding = false;
    }

    // swipe brush for a moving, open (non-holding) hand
    if (!slot.holding && dt > 0) {
      if (Math.hypot(slot.vx, slot.vy) >= SWIPE.minSpeed)
        this._brush(slot.cx, slot.cy, slot.vx, slot.vy);
    }
  }

  _missSlot(s, dt, time) {
    const slot = this.hslots[s];
    if (!slot) return;
    slot.missing += dt > 0 ? dt : 0.016;
    slot.vx *= 0.5;
    slot.vy *= 0.5;
    if (slot.holding && slot.missing > SNOWBALL.dropAfter) {
      this._throw(s, 0, 0, time, true); // gentle drop
      slot.holding = false;
    }
    if (slot.missing > SNOWBALL.removeAfter) this.hslots[s] = null;
  }

  // Pull nearby loose/settled flakes into a new ball for slot `s`.
  _gather(s, cx, cy, radius) {
    const r2 = radius * radius;
    let n = this.ballCount[s];
    for (let i = 0; i < this.capacity && n < SNOWBALL.maxParticles; i++) {
      if (!this.active[i] || this.state[i] === 2) continue;
      const dx = this.px[i] - cx;
      const dy = this.py[i] - cy;
      if (dx * dx + dy * dy > r2) continue;
      this._attach(i, s);
      n++;
    }
    return n;
  }

  // Move flake `i` into slot `s`'s ball, packed tightly around the palm.
  _attach(i, s) {
    if (this.state[i] === 1) this.settled--;
    this.state[i] = 2;
    this.owner[i] = s;
    this.ballCount[s]++;
    const a = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * SNOWBALL.coreRadius;
    this.ballOx[i] = Math.cos(a) * rr;
    this.ballOy[i] = Math.sin(a) * rr;
    this.alpha[i] = Math.min(1, this.baseAlpha[i] * 1.25 + 0.2);
    this.occluded[i] = 0;
  }

  // Release one held flake back to falling (owner vanished).
  _release(i) {
    if (this.owner[i] >= 0) this.ballCount[this.owner[i]]--;
    this.state[i] = 0;
    this.owner[i] = -1;
    this.vx[i] = rand(-20, 20);
    this.vy[i] = rand(20, 60);
    this.life[i] = SNOW.fallLifetime;
  }

  // Launch slot `s`'s ball. Fast release → thrown along hand motion with an
  // upward arc and a burst of spread; slow/gentle → a soft toss or a drop.
  _throw(s, hvx, hvy, time, gentle) {
    let speed = Math.hypot(hvx, hvy);
    let dirx = 0,
      diry = -1;
    if (!gentle) {
      if (speed < SNOWBALL.minThrowSpeed) {
        if (speed > 15) {
          dirx = hvx / speed;
          diry = hvy / speed;
        }
        speed = SNOWBALL.defaultThrow;
      } else {
        dirx = hvx / speed;
        diry = hvy / speed;
        speed = Math.min(speed * SNOWBALL.throwScale, SNOWBALL.throwCap);
      }
    }
    for (let i = 0; i < this.capacity; i++) {
      if (this.state[i] !== 2 || this.owner[i] !== s) continue;
      this.state[i] = 0;
      this.owner[i] = -1;
      if (gentle) {
        this.vx[i] = rand(-30, 30);
        this.vy[i] = rand(20, 80);
      } else {
        const sp = SNOWBALL.throwSpread;
        this.vx[i] = dirx * speed + rand(-sp, sp);
        this.vy[i] = diry * speed - SNOWBALL.throwLift + rand(-sp, sp);
      }
      this.life[i] = SNOW.fallLifetime;
      this.showT[i] = time + SNOWBALL.throwGrace; // visible crossing the body
    }
    this.ballCount[s] = 0;
  }

  // Fling loose flakes near a fast-moving open hand off to the sides.
  _brush(cx, cy, hvx, hvy) {
    const r2 = SWIPE.radius * SWIPE.radius;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.active[i] || this.state[i] === 2) continue;
      const dx = this.px[i] - cx;
      const dy = this.py[i] - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || 0.001;
      const falloff = 1 - d / SWIPE.radius;
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

  // Draw every visible flake as a soft additive dot so overlaps glow (§5.2).
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
