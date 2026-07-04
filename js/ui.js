// Snow Filter — UI layer: the landing/warm-up/error/live screens, the on-camera
// controls, and the season pull-cord. Pure DOM wiring; it holds no simulation
// state. main.js hands it callbacks and calls the show*/set* methods.

export class UI {
  constructor(handlers) {
    this.h = handlers;
    this.root = document.getElementById("app");

    this.landing = document.getElementById("landing");
    this.warmup = document.getElementById("warmup");
    this.warmupText = document.getElementById("warmup-text");
    this.error = document.getElementById("error");
    this.errorText = document.getElementById("error-text");
    this.controls = document.getElementById("controls");
    this.help = document.getElementById("help");

    this.startBtn = document.getElementById("start-btn");
    this.retryBtn = document.getElementById("retry-btn");
    this.snowToggle = document.getElementById("snow-toggle");
    this.resetBtn = document.getElementById("reset-btn");
    this.helpBtn = document.getElementById("help-btn");
    this.helpClose = document.getElementById("help-close");
    this.flipBtn = document.getElementById("flip-btn");

    this.pull = document.getElementById("pull");
    this.pullKnob = document.getElementById("pull-knob");
    this.pullLabel = document.getElementById("pull-label");
    this.seasonName = document.getElementById("season-name");

    this._particle = "Snow"; // current season's particle name for the toggle
    this._wire();
    this._wirePull();
  }

  _wire() {
    this.startBtn.addEventListener("click", () => this.h.onStart());
    this.retryBtn.addEventListener("click", () => this.h.onStart());
    this.snowToggle.addEventListener("click", () => this.h.onToggleSnow());
    this.resetBtn.addEventListener("click", () => {
      this.h.onReset();
      this.resetBtn.classList.remove("pulse");
      void this.resetBtn.offsetWidth; // reflow so the animation can retrigger
      this.resetBtn.classList.add("pulse");
    });
    this.helpBtn.addEventListener("click", () => this.help.classList.add("open"));
    this.helpClose.addEventListener("click", () => this.help.classList.remove("open"));
    this.flipBtn.addEventListener("click", () => this.h.onFlip());

    // Keyboard: space toggles the effect, R resets, S switches season, ? help.
    window.addEventListener("keydown", (e) => {
      if (this.landing.classList.contains("show")) return;
      if (e.key === " ") {
        e.preventDefault();
        this.h.onToggleSnow();
      } else if (e.key === "r" || e.key === "R") {
        this.h.onReset();
      } else if (e.key === "s" || e.key === "S") {
        this.h.onSeason();
      } else if (e.key === "?") {
        this.help.classList.toggle("open");
      }
    });
  }

  // The season cord: drag the knob down (or just tap it) to switch season.
  _wirePull() {
    const knob = this.pullKnob;
    let dragging = false;
    let startY = 0;
    let moved = 0;
    let t0 = 0;

    const setPull = (px) => this.pull.style.setProperty("--pull", `${px}px`);

    const down = (e) => {
      dragging = true;
      startY = e.clientY;
      moved = 0;
      t0 = performance.now();
      this.pull.classList.add("pulling");
      knob.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    const move = (e) => {
      if (!dragging) return;
      const dy = Math.max(0, Math.min(130, e.clientY - startY));
      moved = Math.max(moved, dy);
      setPull(dy);
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      this.pull.classList.remove("pulling");
      setPull(0);
      const tap = moved < 6 && performance.now() - t0 < 300;
      if (moved > 60 || tap) {
        this._yank();
        this.h.onSeason();
      }
    };

    knob.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _yank() {
    this.pull.classList.remove("yank");
    void this.pull.offsetWidth;
    this.pull.classList.add("yank");
  }

  // Hand pinch-pull control (driven by main.js from the camera).
  setPull(px) {
    this.pull.style.setProperty("--pull", `${px}px`);
  }
  knobCenter() {
    const r = this.pullKnob.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  setCordGrabbing(on) {
    this.pull.classList.toggle("grabbing-hand", on);
  }
  yankCord() {
    this._yank();
  }

  _only(el) {
    for (const s of [this.landing, this.warmup, this.error])
      s.classList.toggle("show", s === el);
  }

  showLanding() {
    this._only(this.landing);
    this.controls.classList.remove("show");
  }

  showWarmup(text = "Warming up the camera…") {
    this._only(this.warmup);
    this.warmupText.textContent = text;
    this.controls.classList.remove("show");
  }

  setWarmupText(text) {
    this.warmupText.textContent = text;
  }

  showError(text) {
    this._only(this.error);
    this.errorText.textContent = text;
    this.controls.classList.remove("show");
  }

  showLive() {
    this._only(null);
    this.controls.classList.add("show");
  }

  setSnowOn(on) {
    this.snowToggle.classList.toggle("on", on);
    this.snowToggle.setAttribute("aria-pressed", String(on));
    this.snowToggle.querySelector(".toggle-label").textContent = on
      ? `${this._particle} ON`
      : `${this._particle} OFF`;
  }

  setFlipVisible(visible) {
    this.flipBtn.hidden = !visible;
  }

  // Snow-only mode: hide the season cord entirely.
  hidePullCord() {
    if (this.pull) this.pull.style.display = "none";
  }

  // Snow-only mode: the cord is a style switch (snow / snow+doodles / doodles).
  // The knob carries a text label (no emoji), like a real pull-cord toggle.
  setStyle(style, { announce = true } = {}) {
    if (this.pullLabel) this.pullLabel.textContent = style.label.toUpperCase();
    if (announce) {
      this.seasonName.textContent = style.label;
      this.seasonName.classList.remove("show");
      void this.seasonName.offsetWidth;
      this.seasonName.classList.add("show");
    }
  }

  // Reflect a season change: cord emoji, toggle label, and a brief name flash.
  setSeason(theme, { announce = true } = {}) {
    this._particle = theme.particle;
    this.snowToggle.querySelector(".toggle-label").textContent = this.snowToggle.classList.contains(
      "on"
    )
      ? `${theme.particle} ON`
      : `${theme.particle} OFF`;
    if (announce) {
      this.seasonName.textContent = theme.name;
      this.seasonName.classList.remove("show");
      void this.seasonName.offsetWidth;
      this.seasonName.classList.add("show");
    }
  }
}
