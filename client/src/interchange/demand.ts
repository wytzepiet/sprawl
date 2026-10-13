import type { LevelState } from "../generated";
import { rgb, type Rgb } from "../engine/rgb";

/**
 * Where a gate's cars want to go, drawn over the map while its sign is held
 * (`Signs`): from the gate to each it sends cars to, a faint curve in the
 * colour of the gate they are bound for, as their cars are (`carColour`),
 * and dots streaming along it, as many a second as cars come a minute; bent
 * to its right, so two gates' ways to each other pass; dashed while no road
 * joins them.
 */

/** Each gate's colour, by its place among the gates. */
const COLOURS = ["#2F7DE1", "#E8762C", "#2FA36B", "#D6453A", "#8A4FD1", "#C9A227", "#1FA3A3", "#D14F8A"];
/** How far a curve bends, of its length; how much of each end is left to
 *  the gates; and its width, in tiles. */
const BEND = 0.2;
const END = 0.06;
const WIDTH = 0.05;
/** The dots: how fast they go, in tiles a second; how many go a second for
 *  each car a minute; how big, in tiles. */
const SPEED = 2.5;
const PER_CAR = 0.12;
const DOT = 0.075;
const STEPS = 32;

type Project = (x: number, y: number, z: number) => { sx: number; sy: number };

/** A gate's colour, by its label. */
export const gateColour = (s: LevelState, label: string) => COLOURS[Math.max(0, s.gates.findIndex((g) => g.label === label)) % COLOURS.length];

/** The same, as the car paint takes it. */
export const gateRgb = (s: LevelState, label: string): Rgb => {
  const hex = gateColour(s, label);
  return rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
};

export function drawDemand(g: CanvasRenderingContext2D, at: Project, s: LevelState, from: string, seconds: number) {
  const gates = new Map(s.gates.map((gate) => [gate.label, { x: gate.x + 0.5, y: gate.y + 0.5 }]));
  const [o, e] = [at(0, 0, 0), at(1, 0, 0)];
  const tile = Math.hypot(e.sx - o.sx, e.sy - o.sy);
  const a = gates.get(from);
  if (!a) return;
  for (const w of s.wants.filter((w) => w.from === from && w.per_min > 0)) {
    const b = gates.get(w.to);
    if (!b) continue;
    const colour = gateColour(s, w.to);
    const [dx, dy] = [b.x - a.x, b.y - a.y];
    // Bent to the right of the way it goes (`(-dy, dx)` on the map).
    const c = [(a.x + b.x) / 2 - dy * BEND, (a.y + b.y) / 2 + dx * BEND];
    const point = (t: number) => {
      const [u, v, x] = [(1 - t) * (1 - t), 2 * t * (1 - t), t * t];
      return at(u * a.x + v * c[0] + x * b.x, u * a.y + v * c[1] + x * b.y, 0);
    };
    const pts = Array.from({ length: STEPS + 1 }, (_, k) => point(END + ((1 - 2 * END) * k) / STEPS));
    // How far along each point is, on the screen, for the dots.
    const along = [0];
    for (let k = 1; k <= STEPS; k++) along.push(along[k - 1] + Math.hypot(pts[k].sx - pts[k - 1].sx, pts[k].sy - pts[k - 1].sy));
    const length = along[STEPS];
    const where = (d: number) => {
      const k = Math.max(1, along.findIndex((l) => l >= d));
      const f = (d - along[k - 1]) / (along[k] - along[k - 1] || 1);
      return { sx: pts[k - 1].sx + (pts[k].sx - pts[k - 1].sx) * f, sy: pts[k - 1].sy + (pts[k].sy - pts[k - 1].sy) * f };
    };
    // The way: faint, under a pale edge; its head.
    g.lineCap = "round";
    g.lineJoin = "round";
    g.setLineDash(w.joined ? [] : [tile * 0.18, tile * 0.14]);
    for (const [style, extra, alpha] of [["white", 3, 0.5], [colour, 0, 0.55]] as const) {
      g.globalAlpha = alpha;
      g.strokeStyle = style;
      g.lineWidth = tile * WIDTH + extra;
      g.beginPath();
      g.moveTo(pts[0].sx, pts[0].sy);
      for (const p of pts.slice(1)) g.lineTo(p.sx, p.sy);
      g.stroke();
    }
    g.setLineDash([]);
    const [tip, before] = [pts[STEPS], where(length - tile * 0.3)];
    const l = Math.hypot(tip.sx - before.sx, tip.sy - before.sy) || 1;
    const [ux, uy] = [(tip.sx - before.sx) / l, (tip.sy - before.sy) / l];
    const head = tile * 0.32;
    g.globalAlpha = 0.85;
    g.fillStyle = colour;
    g.beginPath();
    g.moveTo(tip.sx, tip.sy);
    g.lineTo(tip.sx - ux * head - uy * head * 0.55, tip.sy - uy * head + ux * head * 0.55);
    g.lineTo(tip.sx - ux * head + uy * head * 0.55, tip.sy - uy * head - ux * head * 0.55);
    g.closePath();
    g.fill();
    // The dots, as many a second as cars come a minute, at a steady speed.
    const apart = (SPEED * tile) / (w.per_min * PER_CAR);
    const offset = (seconds * SPEED * tile) % apart;
    g.globalAlpha = 1;
    for (let d = offset; d < length - head; d += apart) {
      const p = where(d);
      // Faded in at the start and out before the head.
      g.globalAlpha = Math.min(1, d / (tile * 0.6), (length - head - d) / (tile * 0.6));
      g.fillStyle = "white";
      g.beginPath();
      g.arc(p.sx, p.sy, tile * DOT + 1.5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = colour;
      g.beginPath();
      g.arc(p.sx, p.sy, tile * DOT, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }
}
