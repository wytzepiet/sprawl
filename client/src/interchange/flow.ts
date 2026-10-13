import { eachEntity } from "../state/gameObjects";
import { deckZ } from "../engine/decks";
import { spot } from "../engine/may";
import { LANE_OFFSET } from "../engine/objects/roadGeometry";
import type { RoadNode } from "../generated";

/**
 * The way the one-ways run, shown while the player builds: faint streaks
 * of light gliding along each, as its cars go (`car::bezier`'s curve through a
 * node of two arms), one stream a lane: down the middle of a one-way, one
 * in each lane of a road of two; a road on a side of its tiles is its
 * own one-way, its nodes moved over.
 * The road itself carries no arrows; this is there when the choices are
 * being made, and gone while the test runs.
 */

/** Streaks this far apart along a lane, gliding at this many tiles a
 *  second (a tile apart, so a streak runs on from one link to the next);
 *  each this long and this wide, in tiles, fading from nothing at
 *  its tail to this at its head, drawn round a bend in this many steps. */
const APART = 1;
const GLIDE = 0.7;
const TRAIL = 0.45;
const WIDTH = 0.03;
const ALPHA = 0.32;
const STEPS = 8;

type Node = { id: number; x: number; y: number; z: number; n: RoadNode };
type Project = (x: number, y: number, z: number) => { sx: number; sy: number };

export function drawFlow(g: CanvasRenderingContext2D, at: Project, seconds: number) {
  const nodes = new Map<number, Node>();
  eachEntity((e) => {
    if (e.object.kind !== "RoadNode" || !e.position) return;
    const [x, y] = spot(e.position, e.object.data.side);
    nodes.set(e.id, { id: e.id, x, y, z: deckZ(e.object.data.height ?? 0), n: e.object.data });
  });
  const near = (a: Node) => [...new Set([...a.n.outgoing, ...a.n.incoming])].filter((o) => nodes.has(o)).map((o) => nodes.get(o)!);
  const mid = (a: Node, b: Node): [number, number, number] => [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2];
  const bezier = (p: number[], c: Node, q: number[], t: number) => [0, 1, 2].map((i) => (1 - t) * (1 - t) * p[i] + 2 * t * (1 - t) * [c.x, c.y, c.z][i] + t * t * q[i]);
  /** A point a share `s` along the link from a to b, on the curve a car
   *  drives: each half on its end's curve where that end has two arms. */
  const point = (a: Node, b: Node, s: number): number[] => {
    if (s >= 0.5) {
      const next = near(b).filter((o) => o.id !== a.id);
      if (next.length === 1) return bezier(mid(a, b), b, mid(b, next[0]), s - 0.5);
    } else {
      const prev = near(a).filter((o) => o.id !== b.id);
      if (prev.length === 1) return bezier(mid(prev[0], a), a, mid(a, b), s + 0.5);
    }
    return [a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s, a.z + (b.z - a.z) * s];
  };
  // How many pixels a tile is, for the chevrons' size.
  const [o, e] = [at(0, 0, 0), at(1, 0, 0)];
  const px = Math.hypot(e.sx - o.sx, e.sy - o.sy);
  g.lineWidth = Math.max(1, px * WIDTH);
  g.lineCap = "round";
  for (const a of nodes.values()) {
    for (const id of a.n.outgoing) {
      const b = nodes.get(id);
      // One way: not driven back.
      if (!b || b.n.outgoing.includes(a.id)) continue;
      const lanes = a.n.wide.includes(b.id) ? [LANE_OFFSET, -LANE_OFFSET] : [0];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      // A point on a lane, a distance along the link, on the screen.
      const on = (d: number, lane: number) => {
        const s = Math.max(0, Math.min(1, d / len));
        const [p, q] = [point(a, b, Math.max(0, s - 0.01)), point(a, b, Math.min(1, s + 0.01))];
        const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
        const c = point(a, b, s);
        return at(c[0] - ((q[1] - p[1]) / l) * lane, c[1] + ((q[0] - p[0]) / l) * lane, c[2]);
      };
      for (let head = (seconds * GLIDE) % APART; head < len + TRAIL; head += APART) {
        // Its tail and head, as much of it as is on this link.
        const [d0, d1] = [Math.max(0, head - TRAIL), Math.min(len, head)];
        if (d1 <= d0) continue;
        for (const lane of lanes) {
          const pts = Array.from({ length: STEPS + 1 }, (_, k) => on(d0 + ((d1 - d0) * k) / STEPS, lane));
          // Its share of the fade, so a streak over a node is one.
          const bright = (d: number) => (ALPHA * (d - head + TRAIL)) / TRAIL;
          const [tail, tip] = [pts[0], pts[STEPS]];
          const fade = g.createLinearGradient(tail.sx, tail.sy, tip.sx, tip.sy);
          fade.addColorStop(0, `rgba(255,255,255,${bright(d0).toFixed(3)})`);
          fade.addColorStop(1, `rgba(255,255,255,${bright(d1).toFixed(3)})`);
          g.strokeStyle = fade;
          g.beginPath();
          g.moveTo(pts[0].sx, pts[0].sy);
          for (const q of pts.slice(1)) g.lineTo(q.sx, q.sy);
          g.stroke();
        }
      }
    }
  }
}
