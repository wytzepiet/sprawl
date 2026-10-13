import type { LevelState } from "../generated";

/**
 * What the level asks for, drawn over the map (as Freeways shows it): an
 * arrow for each want, from the gate its cars come in by to the one they
 * leave by, as wide as how many come a minute, in its gate's colour; bent
 * to its right, so the two ways between two gates pass each other; dashed
 * while no road joins them. Shown when a level opens, and on F.
 */

/** Each gate's colour, by its place among the gates. */
const COLOURS = ["#2F7DE1", "#E1782F", "#2FA36B", "#C2361F", "#8A4FD1", "#C9A227", "#1FA3A3", "#D14F8A"];
/** An arrow's width at the most wanted and at none, in tiles; how far it
 *  bends, of its length; and how much of each end is left to the gates. */
const [WIDEST, THINNEST] = [0.3, 0.06];
const BEND = 0.2;
const END = 0.08;
const STEPS = 24;

type Project = (x: number, y: number, z: number) => { sx: number; sy: number };

export function drawDemand(g: CanvasRenderingContext2D, at: Project, s: LevelState) {
  const gates = new Map(s.gates.map((gate, i) => [gate.label, { x: gate.x + 0.5, y: gate.y + 0.5, colour: COLOURS[i % COLOURS.length] }]));
  const most = Math.max(...s.wants.map((w) => w.per_min), 1);
  const [o, e] = [at(0, 0, 0), at(1, 0, 0)];
  const tile = Math.hypot(e.sx - o.sx, e.sy - o.sy);
  // The busiest under the rest, so the thin ones show on top.
  for (const w of [...s.wants].sort((a, b) => b.per_min - a.per_min)) {
    const [a, b] = [gates.get(w.from), gates.get(w.to)];
    if (!a || !b || w.per_min <= 0) continue;
    const [dx, dy] = [b.x - a.x, b.y - a.y];
    const len = Math.hypot(dx, dy) || 1;
    // Bent to the right of the way it goes (`(-dy, dx)` on the map).
    const c = [(a.x + b.x) / 2 - (dy / len) * len * BEND, (a.y + b.y) / 2 + (dx / len) * len * BEND];
    const point = (t: number) => {
      const [u, v, x] = [(1 - t) * (1 - t), 2 * t * (1 - t), t * t];
      return at(u * a.x + v * c[0] + x * b.x, u * a.y + v * c[1] + x * b.y, 0);
    };
    const pts = Array.from({ length: STEPS + 1 }, (_, k) => point(END + ((1 - 2 * END) * k) / STEPS));
    const width = tile * (THINNEST + (WIDEST - THINNEST) * (w.per_min / most));
    // The head: as wide again as the shaft, the shaft stopping short of it.
    const [tip, before] = [pts[STEPS], pts[STEPS - 2]];
    const l = Math.hypot(tip.sx - before.sx, tip.sy - before.sy) || 1;
    const [ux, uy] = [(tip.sx - before.sx) / l, (tip.sy - before.sy) / l];
    const head = Math.max(width * 2.2, 10);
    const base = { sx: tip.sx - ux * head, sy: tip.sy - uy * head };
    const shaft = [...pts.filter((p) => (p.sx - base.sx) * ux + (p.sy - base.sy) * uy < 0), base];
    const stroke = (colour: string, extra: number) => {
      g.strokeStyle = colour;
      g.lineWidth = width + extra;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.setLineDash(w.joined ? [] : [width * 1.6 + 4, width * 1.2 + 4]);
      g.beginPath();
      g.moveTo(shaft[0].sx, shaft[0].sy);
      for (const p of shaft.slice(1)) g.lineTo(p.sx, p.sy);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = colour;
      g.beginPath();
      g.moveTo(tip.sx + ux * extra, tip.sy + uy * extra);
      g.lineTo(base.sx - uy * (head * 0.6 + extra), base.sy + ux * (head * 0.6 + extra));
      g.lineTo(base.sx + uy * (head * 0.6 + extra), base.sy - ux * (head * 0.6 + extra));
      g.closePath();
      g.fill();
    };
    g.globalAlpha = 0.75;
    stroke("white", 4);
    g.globalAlpha = 0.85;
    stroke(a.colour, 0);
    g.globalAlpha = 1;
  }
}

/** A gate's colour, as its arrows have it. */
export const gateColour = (s: LevelState, label: string) => COLOURS[Math.max(0, s.gates.findIndex((g) => g.label === label)) % COLOURS.length];
