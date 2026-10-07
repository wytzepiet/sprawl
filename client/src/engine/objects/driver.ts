/**
 * How a vehicle sits on its route as it drives it: steered, not pinned.
 *
 * The server says how far along its route a vehicle is; this says where
 * its bodies stand when it is there. One axle leads, steering along the
 * route as a driver does, toward a point a little ahead, never tighter
 * than full lock and turning the wheel no faster than a hand can. Every
 * body points the way its own axle moves, as real wheels make it: so the
 * nose swings out of a bend, a trailer cuts in behind its cab, and a cab
 * follows the trailer it is backing.
 *
 * Forward the lead is the cab's rear axle; backing, the rearmost axle, the
 * trailer's on a lorry. The whole drive is worked out once, step by step,
 * and kept by the distance along the route of the point the server moves,
 * so it is the same whenever it is looked at, and always where the server
 * has the vehicle.
 */

import { Vector3 } from "@babylonjs/core";
import { drawnPath } from "./drawnPath";
import { CAB, CAR, LANE_OFFSET, TRAILER } from "./roadGeometry";

export type Pt = [number, number];

/** A body: where its middle stands and which way it points, radians. */
export interface Pose {
  x: number;
  y: number;
  heading: number;
}

/** A vehicle's shape as it steers: how far its rear axle stands behind
 *  the point the server moves (its middle), and a trailer's hitch, on the
 *  cab's rear axle, and its axle, so far behind the hitch, with its
 *  middle so far behind the hitch. */
export interface Rig {
  axle: number;
  trailer?: { axle: number; middle: number };
}

export interface Drive {
  /** The distance along the route the table runs to. */
  length: number;
  /** How far along it each node of the route is passed. */
  nodes: number[];
  at(s: number): { body: Pose; trailer?: Pose };
}

/** How far ahead along the route the driver looks. */
const LOOK = 0.35;
/** Full lock: the tightest the lead axle turns, as a curvature (1/tiles). */
const LOCK = 1 / 0.3;
/** How fast the wheel turns: curvature gained per tile driven. */
const WHEEL = 8;
/** How far the lead may stray from its route before it is put back on
 *  it: where a route turns tighter than a car can. */
const STRAY = 0.1;
/** A step of the drive, in tiles. */
const STEP = 0.02;

/** A polyline measured: each point's distance along it, the point at any
 *  distance (straight on past either end), and the distance of the point
 *  on it nearest to a point, searched near a guess. */
function measure(points: Pt[]) {
  const d = [0];
  for (let i = 1; i < points.length; i++) d.push(d[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const length = d[d.length - 1];
  const dir = (i: number): Pt => {
    const [a, b] = [points[i], points[i + 1]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const at = (s: number): Pt => {
    if (s <= 0) {
      const u = dir(0);
      return [points[0][0] + u[0] * s, points[0][1] + u[1] * s];
    }
    if (s >= length) {
      const u = dir(points.length - 2);
      const e = points[points.length - 1];
      return [e[0] + u[0] * (s - length), e[1] + u[1] * (s - length)];
    }
    const i = index(s);
    const t = (s - d[i - 1]) / (d[i] - d[i - 1] || 1);
    return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
  };
  /** The first point at or past a distance along. */
  const index = (s: number) => {
    let lo = 1, hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (d[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /** The distance along of the nearest point, from `back` behind where it
   *  was last to `reach` ahead of it; past either end, on the straight run
   *  on. */
  const near = (p: Pt, guess: number, back: number, reach: number) => {
    const [from, to] = [guess - back, guess + reach];
    let best = guess, bd = Infinity;
    const consider = (s: number, dd: number) => {
      if (dd < bd) (bd = dd), (best = s);
    };
    for (const [a, u] of [[0, dir(0)], [length, dir(points.length - 2)]] as const) {
      const e = a === 0 ? points[0] : points[points.length - 1];
      const t = (p[0] - e[0]) * u[0] + (p[1] - e[1]) * u[1];
      if (a === 0 ? t < 0 : t > 0) consider(a + t, Math.hypot(p[0] - e[0] - u[0] * t, p[1] - e[1] - u[1] * t));
    }
    for (let i = Math.max(1, index(from)); i < points.length && d[i - 1] <= to; i++) {
      const [a, b] = [points[i - 1], points[i]];
      const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
      const l2 = ex * ex + ey * ey || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / l2));
      consider(d[i - 1] + t * (d[i] - d[i - 1]), Math.hypot(p[0] - a[0] - ex * t, p[1] - a[1] - ey * t));
    }
    return Math.max(from, Math.min(to, best));
  };
  return { length, d, at, near, heading: (i: number) => Math.atan2(dir(i)[1], dir(i)[0]) };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * The drive along a route in parts, each driven forward or backing, one
 * after the other: each starts as the one before left the vehicle.
 */
export function drive(parts: { points: Pt[]; backing: boolean }[], rig: Rig, nodes: number[] = []): Drive {
  const table: { s: number; body: Pose; trailer?: Pose }[] = [];

  // The state: the cab's rear axle and heading, the trailer's axle; at the
  // start, standing on the route pointing along it, or away from it if it
  // starts backing.
  const [p0, p1] = [parts[0].points[0], parts[0].points[1]];
  const h0 = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) + (parts[0].backing ? Math.PI : 0);
  let cab: Pose = { x: p0[0] - Math.cos(h0) * rig.axle, y: p0[1] - Math.sin(h0) * rig.axle, heading: h0 };
  let trailer: Pose | undefined = rig.trailer && {
    x: cab.x - Math.cos(h0) * rig.trailer.axle,
    y: cab.y - Math.sin(h0) * rig.trailer.axle,
    heading: h0,
  };
  const record = (s: number) => {
    const body = { x: cab.x + Math.cos(cab.heading) * rig.axle, y: cab.y + Math.sin(cab.heading) * rig.axle, heading: cab.heading };
    const t = trailer && rig.trailer && {
      x: cab.x - Math.cos(trailer.heading) * rig.trailer.middle,
      y: cab.y - Math.sin(trailer.heading) * rig.trailer.middle,
      heading: trailer.heading,
    };
    if (!table.length || s > table[table.length - 1].s) table.push({ s, body, trailer: t });
  };

  /** Steer `lead` along `route` until the server's point is `end` along
   *  it, the lead ahead of that point by `ahead` (behind it if negative),
   *  moving `sign` (1 forward, -1 backing) along its own heading; `follow`
   *  moves the other bodies after it. */
  const steer = (route: Pt[], offset: number, end: number, getLead: () => Pose, setLead: (p: Pose) => void, sign: number, ahead: number, follow: () => void) => {
    const path = measure(route);
    let s = path.near([getLead().x, getLead().y], ahead, 1, 1);
    let k = 0;
    for (let n = 0; n < (end + 2) / STEP && s - ahead < end; n++) {
      const lead = getLead();
      const travel = sign > 0 ? lead.heading : lead.heading + Math.PI;
      const [px, py] = path.at(s);
      if (Math.hypot(px - lead.x, py - lead.y) > STRAY) {
        // Strayed, where the route turns tighter than a car can (a lot's
        // aisle, a driveway): put back on it, pointing along it, a step on.
        const [qx, qy] = path.at(s + STEP);
        const along = Math.atan2(qy - py, qx - px);
        setLead({ x: qx, y: qy, heading: sign > 0 ? along : along - Math.PI });
        k = 0;
        follow();
        s += STEP;
        record(offset + s - ahead);
        continue;
      }
      const [tx, ty] = path.at(s + LOOK);
      const dist = Math.hypot(tx - lead.x, ty - lead.y);
      const alpha = wrap(Math.atan2(ty - lead.y, tx - lead.x) - travel);
      const want = Math.max(-LOCK, Math.min(LOCK, (2 * Math.sin(alpha)) / Math.max(dist, 1e-6)));
      k += Math.max(-WHEEL * STEP, Math.min(WHEEL * STEP, want - k));
      const heading = travel + k * STEP;
      setLead({ x: lead.x + Math.cos(heading) * STEP, y: lead.y + Math.sin(heading) * STEP, heading: sign > 0 ? heading : heading - Math.PI });
      follow();
      // Never back, and no further on than the lead has driven, or a
      // little more round the inside of a bend: never running ahead of it.
      s = path.near([getLead().x, getLead().y], s, 0, 2 * STEP);
      record(offset + s - ahead);
    }
  };

  let offset = 0;
  for (const { points, backing } of parts) {
    const end = measure(points).length;
    if (!backing) {
      // Forward: the cab's rear axle leads, the trailer trails its hitch.
      steer(points, offset, end, () => cab, (p) => (cab = p), 1, -rig.axle, () => {
        if (!trailer || !rig.trailer) return;
        const dx = cab.x - trailer.x, dy = cab.y - trailer.y, l = Math.hypot(dx, dy) || 1;
        trailer = { x: cab.x - (dx / l) * rig.trailer.axle, y: cab.y - (dy / l) * rig.trailer.axle, heading: Math.atan2(dy, dx) };
      });
    } else if (trailer && rig.trailer) {
      // Backing a lorry: the trailer's axle leads, as far beyond the
      // server's point as it stands behind the cab's middle. The hitch
      // rides the trailer's nose; the cab points the way its rear axle, on
      // the hitch, is moving: backwards.
      const tr = rig.trailer;
      let hitch: Pt = [cab.x, cab.y];
      steer(points, offset, end, () => trailer!, (p) => (trailer = p), -1, tr.axle + rig.axle, () => {
        const t = trailer!;
        const next: Pt = [t.x + Math.cos(t.heading) * tr.axle, t.y + Math.sin(t.heading) * tr.axle];
        const mx = hitch[0] - next[0], my = hitch[1] - next[1];
        cab = Math.hypot(mx, my) > 1e-9 ? { x: next[0], y: next[1], heading: Math.atan2(my, mx) } : { ...cab, x: next[0], y: next[1] };
        hitch = next;
      });
    } else {
      // Backing a car: its rear axle leads.
      steer(points, offset, end, () => cab, (p) => (cab = p), -1, rig.axle, () => {});
    }
    offset += end;
  }

  const length = table.length ? table[table.length - 1].s : 0;
  return {
    length,
    nodes,
    at(s) {
      if (!table.length) return { body: { x: p0[0], y: p0[1], heading: h0 } };
      let lo = 0, hi = table.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (table[mid].s < s) lo = mid + 1;
        else hi = mid;
      }
      const b = table[lo], a = table[Math.max(0, lo - 1)];
      const t = b.s > a.s ? Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s))) : 1;
      const mix = (p: Pose, q: Pose): Pose => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, heading: p.heading + wrap(q.heading - p.heading) * t });
      return { body: mix(a.body, b.body), trailer: a.trailer && b.trailer ? mix(a.trailer, b.trailer) : undefined };
    },
  };
}

/** A car's rear axle stands a third of its length behind its middle. */
export const CAR_RIG: Rig = { axle: CAR.l / 3 };
/** A lorry: the cab's rear axle, and the hitch on it, a little behind the
 *  cab's middle; the trailer's axle and middle behind the hitch. */
export const LORRY_RIG: Rig = { axle: CAB.l / 3, trailer: { axle: TRAILER.axle, middle: TRAILER.l / 2 - TRAILER.overhang } };

/** A trip as the server sends it, driven: in parts at each change of
 *  gear (`backing`, stretches of edges `[a, b)` driven backwards), each
 *  part's route drawn as a street route is, its lot nodes where they are
 *  and so its ends where the gear changes. */
export function driveTrip(route: Pt[], fromLot: number, toLot: number, backing: [number, number][], rig: Rig): Drive | null {
  const n = route.length;
  const cuts = [...new Set([0, ...backing.flat(), n - 1])].filter((k) => k >= 0 && k < n).sort((a, b) => a - b);
  const parts: { points: Pt[]; backing: boolean }[] = [];
  // Where each node is passed along the parts laid end to end: the server's
  // progress is placed by them, a stretch at a time, since it measures the
  // route its own way.
  const at = new Array<number>(n).fill(0);
  let offset = 0;
  for (let c = 1; c < cuts.length; c++) {
    const [i, j] = [cuts[c - 1], cuts[c]];
    const nodes = route.slice(i, j + 1).map(([x, y]) => new Vector3(x, y, 0));
    const fl = Math.max(fromLot - i, i > 0 ? 1 : 0), tl = Math.max(j + 1 - (n - toLot), j < n - 1 ? 1 : 0);
    const drawn = drawnPath(nodes, LANE_OFFSET, Math.min(fl, nodes.length), Math.min(tl, nodes.length));
    if (!drawn) return null;
    drawn.atNode.forEach((d, k) => (at[i + k] = offset + d));
    parts.push({ points: drawn.points.map((p): Pt => [p.x, p.y]), backing: backing.some(([a, b]) => a <= i && i < b) });
    offset += drawn.length;
  }
  return parts.length ? drive(parts, rig, at) : null;
}
