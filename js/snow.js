// Snow Filter — the particle field: one body-aware engine, themed per season.
//
// Particles live in flat typed arrays (a fixed pool, no per-particle objects)
// so the GC stays flat over long sessions. Each frame we:
//   1. emit new particles from the top edge,
//   2. integrate falling particles (gravity + wind + sway + spin),
//   3. collide them with the person mask so they settle on top-facing edges
//      into a glowing rim, and hide particles passing in front of the body,
//   4. let the hands play: a fast swipe flings them away, a closed fist gathers
//      them into a held ball, an opening palm throws it,
//   5. render each one as its season sprite (snow dot, petal, leaf, …).
//
// The season only changes the LOOK (sprite/palette/blend) and physics numbers;
// the body-collision, occlusion and squeeze/throw mechanics are shared. Swap
// seasons with `setSeason(theme)` (see SEASONS in config.js).
//
// Particle `state`: 0 = falling, 1 = settled (rim), 2 = held in a ball.
//
// Coordinates are the mirrored sim space (CSS px). The `mapping` passed in each
// frame carries the video-cover transform so we can sample the (un-mirrored)
// person mask and place (un-mirrored) hands without the mirror leaking out of
// main.js.

import { SNOW, SEASONS, COLLISION, SWIPE, SNOWBALL, RENDER } from "./config.js";

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
    this.gv = new Float32Array(N); // per-particle gravity (depth)
    this.size = new Float32Array(N);
    this.baseAlpha = new Float32Array(N);
    this.alpha = new Float32Array(N);
    this.phase = new Float32Array(N); // sway/shimmer phase
    this.freq = new Float32Array(N); // per-particle flutter frequency (rad/s)
    this.rot = new Float32Array(N); // sprite rotation (rad)
    this.rotV = new Float32Array(N); // spin rate (rad/s)
    this.spriteIx = new Uint8Array(N); // which season sprite this one draws
    this.life = new Float32Array(N);
    this.state = new Uint8Array(N); // 0 falling, 1 settled, 2 held in a ball
    this.active = new Uint8Array(N);
    this.occluded = new Uint8Array(N); // 1 = in front of body → hidden (behind)
    this.ballOx = new Float32Array(N); // offset within the held ball
    this.ballOy = new Float32Array(N);
    this.owner = new Int8Array(N).fill(-1); // hand-slot index for held particles
    this.showT = new Float32Array(N); // ignore occlusion until this time (throws)
    this.free = new Int32Array(N);
    for (let i = 0; i < N; i++) this.free[i] = N - 1 - i;
    this.freeTop = N; // number of slots on the free stack
    this.count = 0;
    this.settled = 0;
    this._emitAcc = 0;
    // Up to two persistent hand slots: { cx, cy, vx, vy, size, open, holding,
    // missing }. Ball `owner` indexes into this array.
    this.hslots = [null, null];
    this.ballCount = new Int32Array(2); // particles held per slot
    this._anyHolding = false;
    this._lastHand = 0;
    this.setSeason(SEASONS[0]); // default: winter / snow
  }

  // Switch the visual + physics theme. Clears the field so seasons don't mix.
  setSeason(theme) {
    this.theme = theme;
    this.phys = theme.phys;
    this.blend = theme.blend;
    this.sprites = buildSprites(theme);
    this.reset();
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
    const p = this.phys;
    const i = this.free[--this.freeTop];
    const s = rand(p.sizeMin, p.sizeMax);
    const depth = (s - p.sizeMin) / Math.max(0.001, p.sizeMax - p.sizeMin); // 0..1
    this.px[i] = rand(-40, mapping.cW + 40);
    this.py[i] = rand(-60, -10);
    this.vx[i] = rand(-8, 8);
    this.vy[i] = rand(10, 40) * (0.6 + depth);
    this.gv[i] = p.gravity - p.gravityVar * (1 - depth);
    this.size[i] = s;
    this.baseAlpha[i] = rand(p.alphaMin, p.alphaMax) * (0.6 + 0.4 * depth);
    this.alpha[i] = this.baseAlpha[i];
    this.phase[i] = rand(0, Math.PI * 2);
    this.freq[i] = p.flutter ? rand(p.flutterFreqMin, p.flutterFreqMax) : 0;
    this.rot[i] = rand(0, Math.PI * 2);
    this.rotV[i] = p.rotate ? rand(-p.spin, p.spin) : 0;
    this.spriteIx[i] = (Math.random() * this.sprites.length) | 0;
    this.life[i] = p.life;
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

  // Advance the whole field by `dt` seconds at wall-clock `time`.
  // `detector` may be null / not-ready; collision just no-ops then.
  update(dt, time, mapping, detector, emitting) {
    const p = this.phys;
    if (emitting) {
      this._emitAcc += p.emit * dt;
      while (this._emitAcc >= 1 && this.count < this.cap) {
        this._spawn(mapping);
        this._emitAcc -= 1;
      }
      if (this._emitAcc > p.emit) this._emitAcc = 0; // guard tab-hide
    }

    this._anyHolding = this.hslots.some((s) => s && s.holding);
    const globalWind = p.wind * Math.sin(time * SNOW.windSpeed);
    const hasMask = !!(detector && detector.mask);
    const thr = COLLISION.personThreshold;
    const invDispW = 1 / mapping.dispW;
    const invDispH = 1 / mapping.dispH;
    const absorb2 = SNOWBALL.absorbRadius * SNOWBALL.absorbRadius;

    for (let i = 0; i < this.capacity; i++) {
      if (!this.active[i]) continue;

      if (this.state[i] === 2) {
        // ---- held in a ball: cling to the owner hand as a tight cluster
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
          this.life[i] = p.life;
        }
        continue;
      }

      // ---- falling: integrate motion
      if (p.flutter) {
        // Petals seesaw horizontally at their own frequency, with a coupled
        // vertical bob, so they tumble down instead of drifting straight.
        const ph = time * this.freq[i] + this.phase[i];
        const targetVx = globalWind + p.flutterAmp * Math.sin(ph);
        this.vx[i] += (targetVx - this.vx[i]) * Math.min(1, dt * 2.4);
        this.vy[i] += this.gv[i] * dt;
        this.px[i] += this.vx[i] * dt;
        this.py[i] += (this.vy[i] + p.bob * Math.cos(ph)) * dt;
        this.rot[i] += this.rotV[i] * dt;
      } else {
        const sway = p.sway * Math.sin(time * 1.3 + this.phase[i]);
        const targetVx = globalWind + sway;
        this.vx[i] += (targetVx - this.vx[i]) * Math.min(1, dt * 1.8);
        this.vy[i] += this.gv[i] * dt;
        this.px[i] += this.vx[i] * dt;
        this.py[i] += this.vy[i] * dt;
        if (this.rotV[i]) this.rot[i] += this.rotV[i] * dt;
      }
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

      // ---- a held ball soaks up falling particles that drift into it
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

        // Over the body = behind the person → hide it so nothing covers the
        // face; only the settled rim shows. A just-thrown ball is exempt
        // briefly so you see it leave the hand.
        this.occluded[i] =
          COLLISION.occludeInFront && here >= thr && time >= this.showT[i] ? 1 : 0;

        // Settle on a top-facing edge (head/shoulders) → the glowing rim.
        // Accumulation piles heavier lower down (shoulders/body) than the head.
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
              this.rotV[i] = 0; // stop spinning once it's come to rest
              this.life[i] =
                COLLISION.settledLifetime * (1 + COLLISION.shoulderLifeBoost * lower) +
                rand(0, 2);
              this.settled++;
              this.occluded[i] = 0; // this one is now the rim → show it
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

    const cur = hands.map((h) => ({
      x: mapping.offsetX + mapping.dispW * (1 - h.x),
      y: mapping.offsetY + mapping.dispH * h.y,
      size: Math.max(SNOWBALL.gatherRadiusMin, h.size * mapping.dispW),
      open: h.open,
    }));

    const slots = this.hslots;
    const usedCur = new Array(cur.length).fill(false);
    const matchMax = (Math.max(mapping.cW, mapping.cH) * 0.5) ** 2;

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
      const r = Math.max(SNOWBALL.gatherRadiusMin, hand.size * SNOWBALL.gatherRadiusScale);
      if (this._gather(s, slot.cx, slot.cy, r) > 0) slot.holding = true;
    } else if (slot.holding && hand.open >= SNOWBALL.openThreshold) {
      this._throw(s, slot.vx, slot.vy, time, false);
      slot.holding = false;
    }

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

  _release(i) {
    if (this.owner[i] >= 0) this.ballCount[this.owner[i]]--;
    this.state[i] = 0;
    this.owner[i] = -1;
    this.vx[i] = rand(-20, 20);
    this.vy[i] = rand(20, 60);
    this.life[i] = this.phys.life;
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
      if (this.phys.rotate) this.rotV[i] = rand(-this.phys.spin, this.phys.spin) * 2;
      this.life[i] = this.phys.life;
      this.showT[i] = time + SNOWBALL.throwGrace; // visible crossing the body
    }
    this.ballCount[s] = 0;
  }

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
      this.life[i] = this.phys.life;
    }
  }

  // Draw every visible particle as its season sprite. Rotating themes (petals,
  // leaves) get a per-particle transform; the rest take the cheap fast path.
  render(ctx) {
    const sprites = this.sprites;
    const rotate = this.phys.rotate;
    const ds = this.phys.drawScale;
    ctx.save();
    ctx.globalCompositeOperation = this.blend;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.active[i] || this.occluded[i]) continue;
      const spr = sprites[this.spriteIx[i]];
      const d = this.size[i] * ds;
      ctx.globalAlpha = this.alpha[i];
      if (rotate) {
        ctx.translate(this.px[i], this.py[i]);
        ctx.rotate(this.rot[i]);
        ctx.drawImage(spr, -d * 0.5, -d * 0.5, d, d);
        ctx.rotate(-this.rot[i]);
        ctx.translate(-this.px[i], -this.py[i]);
      } else {
        ctx.drawImage(spr, this.px[i] - d * 0.5, this.py[i] - d * 0.5, d, d);
      }
    }
    ctx.restore();
  }
}

// ------------------------------------------------------- sprite factory

// Build the sprite set for a season. Each particle picks one at random, so more
// entries of a colour/shape = more of it. Petals get whole blossoms mixed in.
function buildSprites(theme) {
  const S = RENDER.spriteSize;
  const out = [];
  if (theme.shape === "dot") {
    for (const c of theme.palette) out.push(dotSprite(S, c));
  } else if (theme.shape === "petal") {
    // Mostly loose petals; whole blossoms stay an occasional accent.
    for (const c of theme.palette) {
      out.push(petalSprite(S, c));
      out.push(petalSprite(S, c));
      out.push(petalSprite(S, c));
    }
    for (const c of theme.blossom || []) out.push(blossomSprite(S, c));
  } else if (theme.shape === "leaf") {
    for (const c of theme.palette) out.push(leafSprite(S, c));
  }
  return out.length ? out : [dotSprite(S, "#ffffff")];
}

function makeCanvas(S) {
  const c = document.createElement("canvas");
  c.width = c.height = S;
  return c;
}

function hexRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
const lighten = (rgb, f) => rgb.map((v) => Math.round(v + (255 - v) * f));

// Soft glowing dot: bright core fading to transparent (snow, summer light).
function dotSprite(S, color) {
  const c = makeCanvas(S);
  const g = c.getContext("2d");
  const rgb = hexRgb(color);
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, rgba(lighten(rgb, 0.6), 1));
  grd.addColorStop(0.25, rgba(rgb, 0.85));
  grd.addColorStop(0.55, rgba(rgb, 0.32));
  grd.addColorStop(1, rgba(rgb, 0));
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  return c;
}

// A single sakura petal: narrow at the stem (top), widening to a rounded lobe
// with the characteristic little notch at the outer tip (bottom), plus a soft
// sheen and glow.
function petalSprite(S, color) {
  const c = makeCanvas(S);
  const g = c.getContext("2d");
  const rgb = hexRgb(color);
  g.translate(S / 2, S / 2);
  const h = S * 0.42, // half-length (stem at -h, tip at +h)
    w = S * 0.23; // half-width at the widest point
  g.shadowColor = rgba(rgb, 0.45);
  g.shadowBlur = S * 0.07;
  // Sheen runs down the length of the petal.
  const grd = g.createLinearGradient(0, -h, 0, h);
  grd.addColorStop(0, rgba(lighten(rgb, 0.5), 1));
  grd.addColorStop(0.5, rgba(lighten(rgb, 0.18), 1));
  grd.addColorStop(1, rgba(rgb, 1));
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(0, -h); // stem point
  g.bezierCurveTo(w, -h * 0.35, w * 0.95, h * 0.65, w * 0.28, h * 0.98); // right edge → tip
  g.quadraticCurveTo(0, h * 0.74, -w * 0.28, h * 0.98); // notch dip at the tip
  g.bezierCurveTo(-w * 0.95, h * 0.65, -w, -h * 0.35, 0, -h); // left edge → stem
  g.closePath();
  g.fill();
  return c;
}

// A little five-petal blossom with a warm centre (spring accent).
function blossomSprite(S, color) {
  const c = makeCanvas(S);
  const g = c.getContext("2d");
  const rgb = hexRgb(color);
  g.translate(S / 2, S / 2);
  const pr = S * 0.22; // petal reach
  const pw = S * 0.16; // petal width
  g.fillStyle = rgba(rgb, 1);
  g.shadowColor = rgba(rgb, 0.5);
  g.shadowBlur = S * 0.05;
  for (let k = 0; k < 5; k++) {
    g.save();
    g.rotate((k / 5) * Math.PI * 2);
    g.beginPath();
    g.ellipse(0, -pr, pw, pr * 0.9, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  g.shadowBlur = 0;
  g.fillStyle = "rgba(255,214,106,1)"; // pollen centre
  g.beginPath();
  g.arc(0, 0, S * 0.09, 0, Math.PI * 2);
  g.fill();
  return c;
}

// A pointed leaf with a darker midrib (summer/autumn).
function leafSprite(S, color) {
  const c = makeCanvas(S);
  const g = c.getContext("2d");
  const rgb = hexRgb(color);
  g.translate(S / 2, S / 2);
  const h = S * 0.44,
    w = S * 0.2;
  g.shadowColor = rgba(rgb, 0.45);
  g.shadowBlur = S * 0.05;
  const grd = g.createLinearGradient(0, -h, 0, h);
  grd.addColorStop(0, rgba(lighten(rgb, 0.25), 1));
  grd.addColorStop(1, rgba(rgb, 1));
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(0, -h);
  g.quadraticCurveTo(w, 0, 0, h);
  g.quadraticCurveTo(-w, 0, 0, -h);
  g.closePath();
  g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = rgba(lighten(rgb, -0.35 < 0 ? 0 : 0), 0.35);
  g.strokeStyle = `rgba(${Math.round(rgb[0] * 0.6)},${Math.round(rgb[1] * 0.6)},${Math.round(
    rgb[2] * 0.6
  )},0.5)`;
  g.lineWidth = Math.max(1, S * 0.02);
  g.beginPath();
  g.moveTo(0, -h * 0.85);
  g.lineTo(0, h * 0.85);
  g.stroke();
  return c;
}
