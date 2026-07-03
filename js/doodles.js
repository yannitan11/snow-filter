// Snow Filter — hand-drawn winter doodle overlay.
//
// A decorative SVG layer of white winter doodles (snowflakes, sparkles, stars,
// swirls, dots, bursts) that frames the sides and top of the frame around the
// person, gently twinkling and floating. It's purely cosmetic — no camera or
// physics — and toggled on/off by the pull-cord style switch (see main.js).
//
// Each doodle is its own absolutely-positioned <svg> (viewBox 0 0 100 100) so
// it never distorts; layout below is curated to sit around the edges and avoid
// the centre where the person usually is.

const SVGNS = "http://www.w3.org/2000/svg";
const el = (name, attrs) => {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

// concave star / sparkle path (points spikes)
function starPath(cx, cy, points, outer, inner) {
  let d = "";
  const n = points * 2;
  for (let i = 0; i < n; i++) {
    const r = i % 2 ? inner : outer;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    d += (i ? "L" : "M") + (cx + Math.cos(a) * r).toFixed(1) + " " + (cy + Math.sin(a) * r).toFixed(1);
  }
  return d + "Z";
}

// Each shape returns an array of SVG child elements (stroke inherits from the
// parent <svg>; filled bits set their own fill).
const SHAPES = {
  snowflake(color) {
    const out = [];
    const cx = 50, cy = 50, len = 34;
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      const tx = cx + Math.cos(a) * len, ty = cy + Math.sin(a) * len;
      out.push(el("line", { x1: cx, y1: cy, x2: tx, y2: ty }));
      const bx = cx + Math.cos(a) * len * 0.62, by = cy + Math.sin(a) * len * 0.62;
      for (const s of [-1, 1]) {
        const ba = a + s * 0.5;
        out.push(el("line", { x1: bx, y1: by, x2: bx + Math.cos(ba) * 11, y2: by + Math.sin(ba) * 11 }));
      }
    }
    return out;
  },
  sparkle(color) {
    return [el("path", { d: starPath(50, 50, 4, 44, 8), fill: color, stroke: "none" })];
  },
  star(color) {
    return [el("path", { d: starPath(50, 50, 5, 40, 17) })];
  },
  swirl(color) {
    let d = "";
    const cx = 50, cy = 52, steps = 44, turns = 2.15;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = t * turns * 2 * Math.PI;
      const r = 5 + t * 40;
      d += (i ? "L" : "M") + (cx + Math.cos(a) * r).toFixed(1) + " " + (cy + Math.sin(a) * r).toFixed(1) + " ";
    }
    return [el("path", { d })];
  },
  dots(color) {
    return [
      el("circle", { cx: 34, cy: 40, r: 7, fill: color, stroke: "none" }),
      el("circle", { cx: 62, cy: 50, r: 5, fill: color, stroke: "none" }),
      el("circle", { cx: 44, cy: 66, r: 6, fill: color, stroke: "none" }),
    ];
  },
  burst(color) {
    const out = [];
    const cx = 50, cy = 50;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      out.push(el("line", {
        x1: cx + Math.cos(a) * 16, y1: cy + Math.sin(a) * 16,
        x2: cx + Math.cos(a) * 32, y2: cy + Math.sin(a) * 32,
      }));
    }
    out.push(el("path", { d: starPath(cx, cy, 5, 15, 6), fill: color, stroke: "none" }));
    return out;
  },
};

const ANIMS = ["tw", "fl", "pp"];

// Curated layout: {type, x%, y%, size(vmin), rot°, color?}. Framed to the sides
// and top, avoiding the centre band (~38–62% x) where the person stands.
const LAYOUT = [
  // left column
  { type: "snowflake", x: 8, y: 22, size: 9 },
  { type: "sparkle", x: 15, y: 38, size: 6, color: "#bfe0ff" },
  { type: "swirl", x: 7, y: 55, size: 12, rot: -10 },
  { type: "dots", x: 17, y: 70, size: 7 },
  { type: "star", x: 9, y: 85, size: 6, color: "#bfe0ff" },
  { type: "snowflake", x: 20, y: 90, size: 6 },
  // right column
  { type: "snowflake", x: 91, y: 20, size: 8 },
  { type: "burst", x: 84, y: 33, size: 9 },
  { type: "sparkle", x: 93, y: 48, size: 7 },
  { type: "swirl", x: 90, y: 64, size: 11, rot: 12 },
  { type: "dots", x: 82, y: 78, size: 7, color: "#bfe0ff" },
  { type: "star", x: 92, y: 88, size: 6 },
  // top band
  { type: "sparkle", x: 32, y: 9, size: 6 },
  { type: "snowflake", x: 50, y: 6, size: 7 },
  { type: "star", x: 67, y: 10, size: 6, color: "#bfe0ff" },
  { type: "sparkle", x: 40, y: 18, size: 5, color: "#bfe0ff" },
  { type: "burst", x: 74, y: 20, size: 8 },
  { type: "dots", x: 28, y: 16, size: 6 },
];

export class Doodles {
  constructor() {
    this.el = document.getElementById("doodles");
    this._built = false;
  }

  _build() {
    if (this._built || !this.el) return;
    this._built = true;
    LAYOUT.forEach((it, i) => {
      const color = it.color || "#ffffff";
      const svg = el("svg", {
        viewBox: "0 0 100 100",
        fill: "none",
        stroke: color,
        "stroke-width": 4.5,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      });
      (SHAPES[it.type] || SHAPES.sparkle)(color).forEach((p) => svg.appendChild(p));

      const d = document.createElement("div");
      d.className = "doodle " + ANIMS[i % ANIMS.length];
      d.style.left = it.x + "%";
      d.style.top = it.y + "%";
      d.style.width = it.size + "vmin";
      d.style.height = it.size + "vmin";
      d.style.setProperty("--r", (it.rot || 0) + "deg");
      d.style.animationDelay = ((i * 0.37) % 3).toFixed(2) + "s";
      d.appendChild(svg);
      this.el.appendChild(d);
    });
  }

  setVisible(v) {
    if (v) this._build();
    if (this.el) this.el.classList.toggle("show", v);
  }
}
