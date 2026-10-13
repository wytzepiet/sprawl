import { eachEntity } from "../state/gameObjects";
import { deckZ } from "../engine/decks";
import { SIDE } from "../engine/town/surface";
import { LANE_OFFSET } from "../engine/objects/roadGeometry";
import type { RoadNode } from "../generated";

/**
 * The way the one-ways run, shown while the player builds: small chevrons
 * gliding along each, as its cars go (`car::bezier`'s curve through a
 * node of two arms), one stream a lane: down the middle of a one-way, one
 * in each lane of a road of two, one down each side of a divided road.
 * The road itself carries no arrows; this is there when the choices are
 * being made, and gone while the test runs.
 */

/** Chevrons this far apart along a lane, gliding at this many tiles a
 *  second; each this long and this wide, in tiles. */
const APART = 0.55;
const GLIDE = 0.6;
const SIZE: [number, number] = [0.07, 0.08];

type Node = { id: number; x: number; y: number; z: number; n: RoadNode };
type Project = (x: number, y: number, z: number) => { sx: number; sy: number };

export function drawFlow(g: CanvasRenderingContext2D, at: Project, seconds: number) {
  const nodes = new Map<number, Node>();
  eachEntity((e) => {
    if (e.object.kind === "RoadNode" && e.position) nodes.set(e.id, { id: e.id, x: e.position.x + 0.5, y: e.position.y + 0.5, z: deckZ(e.object.data.height ?? 0), n: e.object.data });
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
  g.strokeStyle = "rgba(255,255,255,0.85)";
  g.lineWidth = Math.max(1.5, px * 0.025);
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  for (const a of nodes.values()) {
    for (const id of a.n.outgoing) {
      const b = nodes.get(id);
      // One way: not driven back; a divided road's side is, as its other.
      if (!b || (b.n.outgoing.includes(a.id) && !a.n.incoming.includes(b.id))) continue;
      const lanes = a.n.incoming.includes(b.id) ? [SIDE] : a.n.wide.includes(b.id) ? [LANE_OFFSET, -LANE_OFFSET] : [0];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let d = (seconds * GLIDE) % APART; d < len; d += APART) {
        const s = d / len;
        const [p, q] = [point(a, b, s), point(a, b, Math.min(1, s + 0.02))];
        const [ux, uy] = [(q[0] - p[0]) / Math.hypot(q[0] - p[0], q[1] - p[1]), (q[1] - p[1]) / Math.hypot(q[0] - p[0], q[1] - p[1])];
        for (const lane of lanes) {
          const [cx, cy] = [p[0] - uy * lane, p[1] + ux * lane];
          const tip = at(cx + ux * SIZE[0] / 2, cy + uy * SIZE[0] / 2, p[2]);
          const l = at(cx - ux * SIZE[0] / 2 - uy * SIZE[1] / 2, cy - uy * SIZE[0] / 2 + ux * SIZE[1] / 2, p[2]);
          const r = at(cx - ux * SIZE[0] / 2 + uy * SIZE[1] / 2, cy - uy * SIZE[0] / 2 - ux * SIZE[1] / 2, p[2]);
          g.moveTo(l.sx, l.sy);
          g.lineTo(tip.sx, tip.sy);
          g.lineTo(r.sx, r.sy);
        }
      }
    }
  }
  g.stroke();
}
