/**
 * How a vehicle sits on its route as it drives it: pinned to it.
 *
 * The server says how far along its route a vehicle is; this says where
 * its body stands when it is there. Its middle is on the drawn way,
 * always, and it points from the point `reach` behind it on the way to
 * the point `reach` ahead, as if both its axles kept to it (nearer, close
 * to either end of a part, so it leaves and arrives the way its way runs). Nothing is
 * steered, so nothing overshoots, loops or slides off: where the way
 * goes, the vehicle goes.
 *
 * A drive is in parts, one at each change of gear and one for each curve
 * between the street and a place to stand (`Manoeuvre`, drawn as the
 * server measures it); backing, the vehicle points against the way it
 * moves. Each part is fitted to the stretch of the server's distance it
 * covers, so the vehicle is at each change of gear when the server has it
 * there.
 */

import { drawnPath, measure } from "./drawnPath";
import { CAR, LANE_OFFSET, TRUCK } from "./roadGeometry";
import type { P } from "../geometry";
import type { Manoeuvre, Pose } from "../../generated";

/** A vehicle's shape as it is pinned: half the distance between its
 *  axles. */
export interface Rig {
  reach: number;
}

export interface Drive {
  /** The distance along the route the drive runs to. */
  length: number;
  at(s: number): { body: Pose };
}

/** A pose moved `d` along its heading. */
export const ahead = (p: Pose, d: number): Pose => ({ at: [p.at[0] + Math.cos(p.heading) * d, p.at[1] + Math.sin(p.heading) * d], heading: p.heading });

/** How many pieces a manoeuvre's curve is drawn in (`Manoeuvre::STEPS`). */
const STEPS = 24;

/** A manoeuvre's curve, as the server measures it (`Manoeuvre::points`):
 *  a cubic Bézier from pose to pose, leaving and arriving the way the
 *  vehicle moves, each arm two fifths of the chord. */
export function curve(m: Manoeuvre): P[] {
  const [a, b] = [m.from.at, m.to.at];
  const arm = 0.4 * Math.hypot(b[0] - a[0], b[1] - a[1]);
  const way = (h: number) => (m.back ? h + Math.PI : h);
  const [h0, h1] = [way(m.from.heading), way(m.to.heading)];
  const c0: P = [a[0] + Math.cos(h0) * arm, a[1] + Math.sin(h0) * arm];
  const c1: P = [b[0] - Math.cos(h1) * arm, b[1] - Math.sin(h1) * arm];
  return Array.from({ length: STEPS + 1 }, (_, i): P => {
    const t = i / STEPS, u = 1 - t;
    const [w0, w1, w2, w3] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [w0 * a[0] + w1 * c0[0] + w2 * c1[0] + w3 * b[0], w0 * a[1] + w1 * c0[1] + w2 * c1[1] + w3 * b[1]];
  });
}

/** A stretch of a drive in one gear: its way, and the distances along the
 *  whole, by the server's measure, it runs between. */
export interface Part {
  points: P[];
  backing: boolean;
  from: number;
  to: number;
}

/** A drive in parts, one after the other, the vehicle pinned to each. */
export function drive(parts: Part[], rig: Rig): Drive {
  const ways = parts.map((p) => ({ ...p, way: measure(p.points) }));
  const length = ways.length ? ways[ways.length - 1].to : 0;
  return {
    length,
    at(s) {
      const p = ways.find((w) => s <= w.to) ?? ways[ways.length - 1];
      const u = p.to > p.from ? ((Math.max(p.from, Math.min(p.to, s)) - p.from) / (p.to - p.from)) * p.way.length : 0;
      // Drawn in from either end, so at a change of gear, or where a
      // curve takes over, it points just the way its way runs.
      const r = Math.max(0.005, Math.min(rig.reach, u, p.way.length - u));
      const [a, b] = [p.way.at(u - r), p.way.at(u + r)];
      const heading = Math.atan2(b[1] - a[1], b[0] - a[0]) + (p.backing ? Math.PI : 0);
      return { body: { at: p.way.at(u), heading } };
    },
  };
}

/** A car's axles stand three tenths of its length either side of its
 *  middle; a box truck's, a third. */
export const CAR_RIG: Rig = { reach: CAR.l * 0.3 };
export const LORRY_RIG: Rig = { reach: TRUCK.l / 3 };

/** What of a trip the drive is made from (`Trip`, or a recording of one). */
export interface Driven {
  route_positions: P[];
  from_lot: number;
  to_lot: number;
  backing: [number, number][];
  /** The server's distance at each change of gear, and in all; without
   *  them, the drawn route's own. */
  cusps?: number[];
  total_route_length?: number;
  manoeuvres?: Manoeuvre[];
}

/** A change of lanes under way: the lane offsets it left, and where along
 *  the way it steers across, over how far (`Trip.shift`). */
export interface Swerve {
  lanes: number[];
  along: number;
  over: number;
}

/** A trip as the server sends it, driven, each node of it offset onto
 *  its lane by `lanes` (or the two-way's): in parts at each change of
 *  gear (`backing`, stretches of edges `[a, b)` driven backwards) and at
 *  each manoeuvre, each street part drawn as a street route is, its lot
 *  nodes where they are, each manoeuvre its curve. */
export function driveTrip(t: Driven, rig: Rig, lanes?: number[], was?: Swerve): Drive | null {
  const { route_positions: route, from_lot: fromLot, to_lot: toLot, backing } = t;
  const n = route.length;
  const manoeuvres = t.manoeuvres ?? [];
  const cuts = [...new Set([0, ...backing.flat(), ...manoeuvres.flatMap((m) => [m.edge, m.edge + 1]), n - 1])].filter((k) => k >= 0 && k < n).sort((a, b) => a - b);
  const drawn: { points: P[]; backing: boolean }[] = [];
  for (let c = 1; c < cuts.length; c++) {
    const [i, j] = [cuts[c - 1], cuts[c]];
    const backed = backing.some(([a, b]) => a <= i && i < b);
    const m = manoeuvres.find((m) => m.edge === i);
    if (m && j === i + 1) {
      drawn.push({ points: curve(m), backing: backed });
      continue;
    }
    const nodes = route.slice(i, j + 1);
    const fl = Math.max(fromLot - i, i > 0 ? 1 : 0), tl = Math.max(j + 1 - (n - toLot), j < n - 1 ? 1 : 0);
    const path = (offsets?: number[]) => drawnPath(nodes, offsets ? offsets.slice(i, j + 1) : LANE_OFFSET, Math.min(fl, nodes.length), Math.min(tl, nodes.length));
    const d = path(lanes);
    if (!d) continue;
    let points = d.points;
    // Across from the lane it left: the path bends over from that lane's
    // to this one's.
    const left = was && path(was.lanes);
    if (left && left.points.length === points.length) {
      let s = drawn.reduce((s, p) => s + measure(p.points).length, 0);
      points = points.map((p, k) => {
        if (k > 0) s += Math.hypot(p[0] - points[k - 1][0], p[1] - points[k - 1][1]);
        const u = Math.max(0, Math.min(1, (s - was.along) / was.over));
        const e = u * u * (3 - 2 * u);
        const o = left.points[k];
        return [o[0] + (p[0] - o[0]) * e, o[1] + (p[1] - o[1]) * e];
      });
    }
    drawn.push({ points, backing: backed });
  }
  if (!drawn.length) return null;
  // Where each part starts and ends, by the server's distance; or by its
  // own length, where the server's are not to be had.
  const own = drawn.map((p) => measure(p.points).length);
  const server = t.cusps && t.total_route_length !== undefined && t.cusps.length === drawn.length - 1 ? [0, ...t.cusps, t.total_route_length] : null;
  const bounds = server ?? own.reduce((b, l) => [...b, b[b.length - 1] + l], [0]);
  return drive(drawn.map((p, k) => ({ ...p, from: bounds[k], to: bounds[k + 1] })), rig);
}
