// Car park sketches (`bun sketches/car-park.ts sketches/car-park.svg [big]`): herringbone lots in situations, at the game's scale.
// A tile is 60 px; a car 0.29 x 0.15; a one-way aisle 0.22; a car turns no
// tighter than 0.45. Bays are placed by test, not by hand: a car stands
// where it is wholly on its lot, clear of every aisle, and clear of others.
const T = 60;
const TURN = 0.45;
const AISLE = 0.22;
const CAR = { l: 0.29, w: 0.15 };
const ANGLE = Math.PI / 3; // bays at 60° to the aisle
const STALL_W = 0.2; // across the car
const PITCH = STALL_W / Math.sin(ANGLE);
const COLOURS = ["#E64033", "#333847", "#D9D9E0", "#4066BF", "#338066", "#A6A6AD", "#8C2626", "#D4A93C"];

type P = [number, number];
type Seg = { kind: "line"; a: P; b: P; h: number } | { kind: "arc"; a: P; b: P; c: P; r: number; dir: number; sweep: number };

class Turtle {
  segs: Seg[] = [];
  constructor(public x: number, public y: number, public h: number) {}
  go(l: number) {
    const a: P = [this.x, this.y];
    this.x += Math.cos(this.h) * l; this.y += Math.sin(this.h) * l;
    this.segs.push({ kind: "line", a, b: [this.x, this.y], h: this.h });
    return this;
  }
  /** dir +1 right, -1 left; deg the angle turned. */
  turn(r: number, dir: number, deg = 90) {
    const a: P = [this.x, this.y];
    const pr = [Math.cos(this.h + Math.PI / 2), Math.sin(this.h + Math.PI / 2)];
    const c: P = [this.x + pr[0] * r * dir, this.y + pr[1] * r * dir];
    const t = (dir * deg * Math.PI) / 180;
    const [vx, vy] = [this.x - c[0], this.y - c[1]];
    this.x = c[0] + vx * Math.cos(t) - vy * Math.sin(t);
    this.y = c[1] + vx * Math.sin(t) + vy * Math.cos(t);
    this.h += t;
    this.segs.push({ kind: "arc", a, b: [this.x, this.y], c, r, dir, sweep: deg });
    return this;
  }
}

const EAST = 0, NORTH = -Math.PI / 2;

type Panel = {
  key: string; title: string; note: string[];
  lot: P[]; shop: P[];
  main?: [number, number]; // x range of the main street (row 2)
  side?: boolean; // a side street down column 0
  paths: Turtle[];
  ring?: { x0: number; x1: number };
  W?: number; H?: number;
};

function samples(segs: Seg[]): P[] {
  const out: P[] = [];
  for (const s of segs) {
    if (s.kind === "line") {
      const n = Math.max(2, Math.ceil(Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) / 0.01));
      for (let i = 0; i <= n; i++) out.push([s.a[0] + ((s.b[0] - s.a[0]) * i) / n, s.a[1] + ((s.b[1] - s.a[1]) * i) / n]);
    } else {
      const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]);
      const span = (s.dir * s.sweep * Math.PI) / 180;
      const n = Math.ceil(Math.abs(span) * s.r / 0.01) + 2;
      for (let i = 0; i <= n; i++) {
        const t = a0 + (span * i) / n;
        out.push([s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]);
      }
    }
  }
  return out;
}

function carPoly(x: number, y: number, h: number, l = CAR.l, w = CAR.w): P[] {
  const [ux, uy] = [Math.cos(h), Math.sin(h)], [vx, vy] = [-uy, ux];
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [x + ux * a * l / 2 + vx * b * w / 2, y + uy * a * l / 2 + vy * b * w / 2]);
}

function overlap(p: P[], q: P[]) {
  for (const poly of [p, q]) {
    for (let i = 0; i < 4; i++) {
      const [a, b] = [poly[i], poly[(i + 1) % 4]];
      const n = [-(b[1] - a[1]), b[0] - a[0]];
      const proj = (s: P[]) => s.map((v) => v[0] * n[0] + v[1] * n[1]);
      const [pa, pb] = [proj(p), proj(q)];
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
    }
  }
  return true;
}

function bays(panel: Panel) {
  const all = panel.paths.flatMap((t) => samples(t.segs));
  const inside = (x: number, y: number) => {
    // inside the union of lot tiles, 0.03 in from any edge that is not shared
    const cell = panel.lot.find(([c, r]) => x >= c && x < c + 1 && y >= r && y < r + 1);
    if (!cell) return false;
    const [c, r] = cell;
    const has = (dc: number, dr: number) => panel.lot.some(([a, b]) => a === c + dc && b === r + dr);
    const m = 0.03;
    if (x - c < m && !has(-1, 0)) return false;
    if (c + 1 - x < m && !has(1, 0)) return false;
    if (y - r < m && !has(0, -1)) return false;
    if (r + 1 - y < m && !has(0, 1)) return false;
    // the inner corner of an L
    if (x - c < m && y - r < m && !has(-1, -1)) return has(-1, 0) && has(0, -1) ? false : true;
    return true;
  };
  const cars: { poly: P[]; x: number; y: number; h: number; stall: P[][] }[] = [];
  const clearOfAisle = (poly: P[]) => {
    const pts: P[] = [...poly];
    for (let i = 0; i < 4; i++) {
      const [a, b] = [poly[i], poly[(i + 1) % 4]];
      for (let k = 1; k < 4; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / 4, a[1] + ((b[1] - a[1]) * k) / 4]);
    }
    return pts.every((p) => all.every((s) => Math.hypot(s[0] - p[0], s[1] - p[1]) > AISLE / 2 + 0.01));
  };
  const reach = (CAR.l / 2) * Math.sin(ANGLE) + (CAR.w / 2) * Math.cos(ANGLE);
  for (const t of panel.paths) {
    for (const s of t.segs) {
      // Bays line the aisles that run along the street, the whole width of
      // the lot; a lane that only leads to them has none.
      if (s.kind !== "line" || Math.abs(Math.sin(s.h)) > 0.5) continue;
      const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      const [ux, uy] = [Math.cos(s.h), Math.sin(s.h)];
      for (const side of [-1, 1]) {
        const [px, py] = [-uy * side, ux * side]; // toward the side (side 1 = right)
        const off = AISLE / 2 + 0.015 + reach;
        for (let d = -1; d <= L + 1; d += 0.01) {
          const h = s.h + side * ANGLE;
          // the car's middle: off the centreline by `off`, so its nearest corner meets the aisle edge
          const x = s.a[0] + ux * d + px * off, y = s.a[1] + uy * d + py * off;
          const poly = carPoly(x, y, h);
          if (!poly.every(([a, b]) => inside(a, b))) continue;
          if (!clearOfAisle(poly)) continue;
          // its stall, 0.2 across, must not overlap another's
          const stall = carPoly(x, y, h, CAR.l + 0.03, STALL_W - 0.002);
          if (cars.some((c) => overlap(c.stall[0], stall))) continue;
          cars.push({ poly, x, y, h, stall: [stall] });
          d += PITCH - 0.01;
        }
      }
    }
  }
  return cars;
}

function f(n: number) { return +(n * T).toFixed(1); }

function pathD(segs: Seg[]) {
  let d = `M${f(segs[0].a[0])} ${f(segs[0].a[1])}`;
  for (const s of segs) {
    if (s.kind === "line") d += `L${f(s.b[0])} ${f(s.b[1])}`;
    else {
      d += `A${f(s.r)} ${f(s.r)} 0 0 ${s.dir > 0 ? 1 : 0} ${f(s.b[0])} ${f(s.b[1])}`;
    }
  }
  return d;
}

function hash(a: number, b: number, salt: number) {
  let s = (a * 374761393 + b * 668265263 + salt * 1013904223) | 0;
  s = Math.imul(s ^ (s >>> 13), 1274126177);
  return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
}

function render(panel: Panel, ox: number, oy: number) {
  const W = panel.W ?? 6, H = panel.H ?? 3, Y = H - 1;
  let g = `<g transform="translate(${ox} ${oy})">`;
  g += `<text class="label" x="0" y="-48">${panel.key} · ${panel.title}</text>`;
  panel.note.forEach((n, i) => (g += `<text class="note" x="0" y="${-28 + i * 15}">${n}</text>`));
  g += `<rect class="land" width="${W * T}" height="${H * T}"/>`;
  // paved: lot and shop tiles, and the pavement out to the streets
  for (const [c, r] of [...panel.lot, ...panel.shop]) {
    let [x0, y0, x1, y1] = [c, r, c + 1, r + 1];
    if (r === Y - 1 && panel.main && c + 1 > panel.main[0] && c < panel.main[1]) y1 = Y + 0.3;
    if (c === 1 && panel.side) x0 = 0.7;
    g += `<rect class="paved" x="${f(x0)}" y="${f(y0)}" width="${f(x1 - x0)}" height="${f(y1 - y0)}"/>`;
  }
  if (panel.main) g += `<rect class="road" x="${f(panel.main[0])}" y="${f(Y + 0.3)}" width="${f(panel.main[1] - panel.main[0])}" height="${f(0.4)}" rx="${panel.main[1] < W ? 12 : 0}"/>`;
  if (panel.side) g += `<rect class="road" x="${f(0.3)}" y="0" width="${f(0.4)}" height="${f(Y + 0.7)}"/>`;
  g += `<path class="grid" d="${Array.from({ length: W - 1 }, (_, i) => i + 1).map((x) => `M${x * T} 0V${H * T}`).join("")}${Array.from({ length: H - 1 }, (_, i) => i + 1).map((y) => `M0 ${y * T}H${W * T}`).join("")}"/>`;
  for (const [c, r] of panel.shop) {
    const has = (dc: number, dr: number) => panel.shop.some(([a, b]) => a === c + dc && b === r + dr);
    const [x0, y0, x1, y1] = [c + (has(-1, 0) ? 0 : 0.06), r + (has(0, -1) ? 0 : 0.06), c + 1 - (has(1, 0) ? 0 : 0.06), r + 1 - (has(0, 1) ? 0 : 0.06)];
    g += `<rect class="shop" x="${f(x0)}" y="${f(y0)}" width="${f(x1 - x0)}" height="${f(y1 - y0)}"/>`;
  }
  let count = 0;
  if (panel.ring) {
    // The ring as lots.rs lays it: lane centre 0.2 in, island one car deep, spots 0.2 apart, 0.3 from the ends.
    const { x0, x1 } = panel.ring;
    const [l, t, rr, b] = [x0 + 0.2, 1.2, x1 - 0.2, 1.8];
    g += `<path class="aisle" d="M${f(l)} ${f(t)}H${f(rr)}V${f(b)}H${f(l)}Z"/>`;
    g += `<path class="aisle" d="M${f(x0 + 1.5)} ${f(1.8)}V${f(2.45)}"/>`;
    for (const [cx, cy] of [[l, t], [rr, t], [rr, b], [l, b]]) g += `<circle class="tight" cx="${f(cx)}" cy="${f(cy)}" r="7"/>`;
    const n = Math.floor((x1 - x0 - 0.6) / 0.2 + 1e-9);
    for (let i = 0; i < n; i++) {
      const x = x0 + 0.3 + 0.1 + i * 0.2;
      g += `<path class="bay" d="M${f(x - 0.1)} ${f(1.31)}V${f(1.69)}M${f(x + 0.1)} ${f(1.31)}V${f(1.69)}"/>`;
      if (hash(i, 0, 3) > 0.25) g += `<use href="#car" fill="${COLOURS[Math.floor(hash(i, 1, 5) * 8)]}" transform="translate(${f(x)} ${f(1.5)}) rotate(90)"/>`;
      count++;
    }
  }
  for (const p of panel.paths) {
    g += `<path class="aisle" d="${pathD(p.segs)}"/>`;
  }
  const cars = bays(panel);
  for (const c of cars) {
    const [a, b, cc, d] = c.stall[0];
    g += `<path class="bay" d="M${f(a[0])} ${f(a[1])}L${f(d[0])} ${f(d[1])}M${f(b[0])} ${f(b[1])}L${f(cc[0])} ${f(cc[1])}"/>`;
    if (hash(Math.round(c.x * 100), Math.round(c.y * 100), 19) > 0.25)
      g += `<use href="#car" fill="${COLOURS[Math.floor(hash(Math.round(c.x * 100), Math.round(c.y * 100), 23) * 8)]}" transform="translate(${f(c.x)} ${f(c.y)}) rotate(${((c.h * 180) / Math.PI).toFixed(1)})"/>`;
  }
  count += cars.length;
  for (const p of panel.paths) {
    g += `<path class="flow" d="${pathD(p.segs)}"/>`;
    for (const s of p.segs) if (s.kind === "arc" && s.r < TURN - 1e-9) g += `<path class="tight-line" d="${pathD([s])}"/>`;
  }
  const lotW = panel.lot.length;
  g += `<text class="count" x="${W * T}" y="${H * T + 20}" text-anchor="end">${count} cars on ${lotW} tile${lotW > 1 ? "s" : ""}</text>`;
  g += `</g>`;
  return { g, count };
}

const P = (lot: P[], shop: P[], rest: Partial<Panel> & Pick<Panel, "key" | "title" | "note" | "paths">): Panel => ({ lot, shop, ...rest });
const row = (y: number, ...xs: number[]) => xs.map((x) => [x, y] as P);

const panels: Panel[] = [
  P(row(1, 1, 2), [...row(1, 3, 4), ...row(0, 3, 4)], {
    key: "0", title: "Today: the ring", note: ["A lane all round, one car deep in the middle.", "Every corner turns at 0.2 (red): no car can drive it."],
    main: [0, 6], paths: [], ring: { x0: 1, x1: 3 },
  }),
  P(row(1, 1, 2), [...row(1, 3, 4), ...row(0, 3, 4)], {
    key: "A", title: "Straight street, two tiles", note: ["In at one end, out at the other, one way.", "The two turns at 0.45 eat the ends of the front row."],
    main: [0, 6], paths: [new Turtle(1.15, 2.45, NORTH).go(0.5).turn(TURN, 1).go(0.8).turn(TURN, 1).go(0.5)],
  }),
  P(row(1, 1, 2, 3), [...row(1, 4, 5), ...row(0, 4, 5)], {
    key: "B", title: "Straight street, three tiles", note: ["The same, a tile longer: each tile more adds", "about eight, against the ring's five."],
    main: [0, 6], paths: [new Turtle(1.15, 2.45, NORTH).go(0.5).turn(TURN, 1).go(1.8).turn(TURN, 1).go(0.5)],
  }),
  P(row(1, 1, 2), [...row(1, 3, 4), ...row(0, 3, 4)], {
    key: "C", title: "On the corner", note: ["In off the side street straight down the aisle,", "out onto the high street: one turn, not two."],
    main: [0, 6], side: true, paths: [new Turtle(0.6, 1.5, EAST).go(1.8).turn(TURN, 1).go(0.5)],
  }),
  P([[1, 0], [1, 1], [2, 1]], [...row(0, 2, 3, 4), ...row(1, 3, 4)], {
    key: "D", title: "Round the corner", note: ["An L: in off the side street, round, out onto", "the high street. Three turns leave little room."],
    main: [0, 6], side: true, paths: [new Turtle(0.6, 0.5, EAST).go(0.45).turn(TURN, 1).go(0.1).turn(TURN, -1).go(0.45).turn(TURN, 1).go(0.5)],
  }),
  P(row(1, 1), [...row(1, 2, 3), ...row(0, 2, 3)], {
    key: "E", title: "One tile", note: ["In and out of one tile is a U-turn at 0.35 (red),", "and nothing fits beside it."],
    main: [0, 6], paths: [new Turtle(1.15, 2.45, NORTH).go(0.6).turn(0.35, 1, 180).go(0.6)],
  }),
  P(row(1, 1, 2), [...row(1, 3, 4), ...row(0, 3, 4)], {
    key: "F", title: "The street stops short", note: ["One tile on the street: a loop back out the", "same tile, turning at 0.3 (red)."],
    main: [0, 2.05], paths: [new Turtle(1.15, 2.45, NORTH).go(0.9).turn(0.3, 1).go(1.0).turn(0.3, 1, 180).go(0.4).turn(0.3, -1).go(0.3)],
  }),
];


const aisles = (x0: number, x1: number, ys: number[], street: number) =>
  ys.map((y) => new Turtle(x0 + 0.15, street - 0.05, NORTH).go(street - 0.05 - (y + TURN)).turn(TURN, 1).go(x1 - 0.15 - TURN - (x0 + 0.15 + TURN)).turn(TURN, 1).go(street - 0.05 - (y + TURN)));
const rect = (c0: number, c1: number, r0: number, r1: number) => { const o: P[] = []; for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) o.push([c, r]); return o; };
const big: Panel[] = [
  P(rect(1, 4, 1, 2), rect(5, 6, 1, 2), {
    key: "G", title: "Two deep: branch and gather", note: ["One way in, up a feeder that branches into an aisle a", "row; the aisles gather into one way out. Bays line the aisles only."],
    W: 8, H: 4, main: [0, 8], paths: aisles(1, 5, [1.5, 2.5], 3.5),
  }),
  P(rect(1, 4, 1, 2), rect(5, 6, 1, 2), {
    key: "H", title: "Two deep on the corner", note: ["Each aisle its own way in off the side street, no", "feeder; they gather into one way out."],
    W: 8, H: 4, main: [0, 8], side: true, paths: [1.5, 2.5].map((y) => new Turtle(0.6, y, EAST).go(3.8).turn(TURN, 1).go(3.45 - y - TURN)),
  }),
  P(rect(1, 5, 0, 2), rect(6, 7, 0, 2), {
    key: "I", title: "Three deep, five wide", note: ["Three aisles off one feeder. The bigger the lot, the less", "of it the turns at the ends take."],
    W: 8, H: 4, main: [0, 8], paths: aisles(1, 6, [0.5, 1.5, 2.5], 3.5),
  }),
];
const sheet = process.argv[3] === "big" ? big : panels;
const COLS = process.argv[3] === "big" ? 2 : 4, GX = 70, GY = 120, MX = 40, MY = 110;
const PW = Math.max(...sheet.map((p) => (p.W ?? 6) * T)), PH = Math.max(...sheet.map((p) => (p.H ?? 3) * T));
let body = "";
const counts: Record<string, string> = {};
const slots = sheet.length + 1, rows = Math.ceil(slots / COLS);
sheet.forEach((p, i) => {
    body += render(p, MX + (i % COLS) * (PW + GX), MY + Math.floor(i / COLS) * (PH + GY)).g;
  const count = render(p, 0, 0).count;
  counts[p.key] = `${count} cars, ${(count / p.lot.length).toFixed(1)} a tile`;
});
const W = MX * 2 + COLS * PW + (COLS - 1) * GX, H = MY + rows * PH + (rows - 1) * GY + 40;
const lx = MX + (sheet.length % COLS) * (PW + GX), ly = MY + Math.floor(sheet.length / COLS) * (PH + GY);
body += `<g transform="translate(${lx} ${ly - 48})">
  <text class="label" x="0" y="0">Key</text>
  <path class="flow" d="M0 30H60"/><text class="note" x="72" y="34">the way cars drive, one way</text>
  <path class="tight-line" d="M0 60H60"/><text class="note" x="72" y="64">a turn tighter than a car turns (0.45)</text>
  <text class="note" x="0" y="100">A tile is 60 px (12 m). A car 0.29 × 0.15, an aisle 0.22,</text>
  <text class="note" x="0" y="118">bays at 60° and 0.2 across. Bays are placed by test:</text>
  <text class="note" x="0" y="136">wholly on the lot, clear of every aisle and of each other.</text>
</g>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif">
  <!--
    The car park, herringbone, in the situations a lot meets: a one-way
    aisle with bays at 60 degrees both sides, against the ring it would
    replace. Generated, not drawn: the bays are placed by test at the
    game's scale, so the counts are what fits.
  -->
  <defs>
    <style>
      .land { fill: #C6DBAB }
      .paved { fill: #E8ECDF }
      .road { fill: #F8F6F0 }
      .shop { fill: #6EC1E4 }
      .aisle { fill: none; stroke: #F8F6F0; stroke-width: ${f(AISLE)}; stroke-linejoin: round }
      .flow { fill: none; stroke: #9aa0a8; stroke-width: 1.2; stroke-dasharray: 5 4; marker-end: url(#arrow) }
      .tight-line { fill: none; stroke: #E64033; stroke-width: 2.4 }
      .tight { fill: none; stroke: #E64033; stroke-width: 2 }
      .bay { fill: none; stroke: #B8B2A0; stroke-width: 1 }
      .label { font-size: 15px; fill: #2b2f36; font-weight: 600 }
      .note { font-size: 12px; fill: #555b66 }
      .count { font-size: 13px; fill: #2b2f36; font-weight: 600 }
      .grid { stroke: #000; stroke-opacity: 0.06; stroke-width: 1 }
    </style>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#9aa0a8"/></marker>
    <rect id="car" x="${-f(CAR.l / 2)}" y="${-f(CAR.w / 2)}" width="${f(CAR.l)}" height="${f(CAR.w)}" rx="1.5"/>
  </defs>
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  ${body}
</svg>
`;
await Bun.write(process.argv[2], svg);
console.log(counts);
