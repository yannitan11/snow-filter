// Snow Filter — UI layer: the landing/warm-up/error/live screens and the
// on-camera controls. Pure DOM wiring; it holds no simulation state. main.js
// hands it callbacks and calls the show*/set* methods to drive it.

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

    this._wire();
  }

  _wire() {
    this.startBtn.addEventListener("click", () => this.h.onStart());
    this.retryBtn.addEventListener("click", () => this.h.onStart());
    this.snowToggle.addEventListener("click", () => this.h.onToggleSnow());
    this.resetBtn.addEventListener("click", () => {
      this.h.onReset();
      this.resetBtn.classList.remove("pulse");
      // reflow so the animation can retrigger
      void this.resetBtn.offsetWidth;
      this.resetBtn.classList.add("pulse");
    });
    this.helpBtn.addEventListener("click", () => this.help.classList.add("open"));
    this.helpClose.addEventListener("click", () =>
      this.help.classList.remove("open")
    );
    this.flipBtn.addEventListener("click", () => this.h.onFlip());

    // Keyboard: space toggles snow, R resets, ? opens help.
    window.addEventListener("keydown", (e) => {
      if (this.landing.classList.contains("show")) return;
      if (e.key === " ") {
        e.preventDefault();
        this.h.onToggleSnow();
      } else if (e.key === "r" || e.key === "R") {
        this.h.onReset();
      } else if (e.key === "?") {
        this.help.classList.toggle("open");
      }
    });
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
      ? "Snow ON"
      : "Snow OFF";
  }

  setFlipVisible(visible) {
    this.flipBtn.hidden = !visible;
  }
}
