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
 * trailer's on a lorry. A drive is in parts, one at each change of gear,
 * driven one after the other from where the last left the vehicle, so a
 * change of gear is a stop and a turn of the wheel, never a jump. Where
 * it stands, it is pinned instead: a kerb bay or a drive is tighter than
 * a driver steers, so the way out of it onto the route, and off the route
 * into it, is planned from pose to pose and driven exactly. Each
 * part is fitted to the stretch of the server's distance it covers, so
 * the vehicle is at each change of gear when the server has it there; it
 * starts from where it stood and ends where it will stand, eased onto it
 * over the last stretch. The whole drive is worked out once, step by step,
 * and kept by distance, so it is the same whenever it is looked at.
 */

import { drawnPath, measure } from "./drawnPath";
import { CAB, CAR, LANE_OFFSET, TRAILER } from "./roadGeometry";
import type { P } from "../geometry";
import type { Pose } from "../../generated";


/** A body as the drive works it out, flat, for the steps are many: where
 *  its middle stands and which way it points, radians. */
interface Body {
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
  at(s: number): { body: Pose; trailer?: Pose };
}

/** A stretch of a drive in one gear: the route its lead follows, and the
 *  distances along the whole, by the server's measure, it runs between. */
export interface Part {
  points: P[];
  backing: boolean;
  from: number;
  to: number;
}

/** How far ahead along the route the driver looks. */
const LOOK = 0.35;
/** Full lock: the tightest the lead axle turns, as a curvature (1/tiles). */
const LOCK = 1 / 0.3;
/** How fast the wheel turns: curvature gained per tile driven. */
const WHEEL = 8;
/** The farthest a lead axle is let stray from its way, and the least of
 *  its own driving its progress along the way keeps up with. */
const KEEP = 0.2;
const PACE = 0.93;
/** A step of the drive, in tiles. */
const STEP = 0.02;
/** How far before its end a drive is eased onto where it will stand. */
const SETTLE = 0.8;
/** How far along a route a way out of a stand may join it, or one into
 *  a stand leave it, and how much of full lock that way should keep to. */
const TRIES = [0.3, 0.5, 0.8, 1.2, 1.6];
const EASY = 0.7;
/** The tightest such a way may turn, of full lock, before the driver
 *  steers it instead and is eased onto where it stands. */
const HARDEST = 1.5;
/** How far a quintic may lean out at either end, of its chord. */
const LEANS = [0.6, 0.9, 1.2, 1.6, 2.1];

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const pointAt = (r: { at(s: number): P }, s: number) => {
  const [x, y] = r.at(s);
  return { x, y };
};
const along = (p: Body, d: number): Body => ({ x: p.x + Math.cos(p.heading) * d, y: p.y + Math.sin(p.heading) * d, heading: p.heading });
/** A pose moved `d` along its heading. */
export const ahead = (p: Pose, d: number): Pose => ({ at: [p.at[0] + Math.cos(p.heading) * d, p.at[1] + Math.sin(p.heading) * d], heading: p.heading });

/** A body standing at `body`, its trailer straight behind it. */
function straight(body: Body, rig: Rig): Body | undefined {
  return rig.trailer && { ...along(body, -(rig.axle + rig.trailer.middle)), heading: body.heading };
}

/** A quintic from one pose to another, leaving and arriving along their
 *  headings, leaning out so far at either end; `n` steps. */
function quintic(from: Body, to: Body, m0: number, m1: number, n: number): P[] {
  const [v0, v1] = [[Math.cos(from.heading) * m0, Math.sin(from.heading) * m0], [Math.cos(to.heading) * m1, Math.sin(to.heading) * m1]];
  return Array.from({ length: n + 1 }, (_, i): P => {
    const t = i / n, t3 = t * t * t, t4 = t3 * t, t5 = t4 * t;
    const [h0, h1, h4, h5] = [1 - 10 * t3 + 15 * t4 - 6 * t5, t - 6 * t3 + 8 * t4 - 3 * t5, -4 * t3 + 7 * t4 - 3 * t5, 10 * t3 - 15 * t4 + 6 * t5];
    return [h0 * from.x + h1 * v0[0] + h4 * v1[0] + h5 * to.x, h0 * from.y + h1 * v0[1] + h4 * v1[1] + h5 * to.y];
  });
}

/** A quintic's basis, its first and second derivatives, at a few points
 *  along it. */
const BASIS = Array.from({ length: 17 }, (_, i) => {
  const t = i / 16, t2 = t * t, t3 = t2 * t, t4 = t3 * t;
  return [
    [-30 * t2 + 60 * t3 - 30 * t4, 1 - 18 * t2 + 32 * t3 - 15 * t4, -12 * t2 + 28 * t3 - 15 * t4, 30 * t2 - 60 * t3 + 30 * t4],
    [-60 * t + 180 * t2 - 120 * t3, -36 * t + 96 * t2 - 60 * t3, -24 * t + 84 * t2 - 60 * t3, 60 * t - 180 * t2 + 120 * t3],
  ];
});

/** The tightest that quintic turns, as a curvature, from its
 *  derivatives; or as soon as it is tighter than `than`, that far. */
function sharpest(from: Body, to: Body, m0: number, m1: number, than = Infinity): number {
  const [ax, ay, bx, by] = [Math.cos(from.heading) * m0, Math.sin(from.heading) * m0, Math.cos(to.heading) * m1, Math.sin(to.heading) * m1];
  let worst = 0;
  for (const [[a, b, c, d], [e, f, g, h]] of BASIS) {
    const [dx, dy] = [from.x * a + ax * b + bx * c + to.x * d, from.y * a + ay * b + by * c + to.y * d];
    const [ex, ey] = [from.x * e + ax * f + bx * g + to.x * h, from.y * e + ay * f + by * g + to.y * h];
    const v = dx * dx + dy * dy;
    worst = Math.max(worst, Math.abs(dx * ey - dy * ex) / Math.max(v * Math.sqrt(v), 1e-12));
    if (worst > than) break;
  }
  return worst;
}

/**
 * The way a lead axle is driven from one pose to another, each its place
 * and the way it is moving: a quintic, leaving and arriving along those
 * ways, of the ways it could lean out at either end the one that turns
 * least tightly, and how tightly that is. Points a step apart.
 */
function joint(from: Body, to: Body): { way: P[]; sharpest: number } {
  const chord = Math.hypot(to.x - from.x, to.y - from.y);
  if (chord < 1e-6) return { way: [[from.x, from.y]], sharpest: 0 };
  let best = [1.2, 1.2], least = Infinity;
  for (const a of LEANS) {
    for (const b of LEANS) {
      const k = sharpest(from, to, a * chord, b * chord, least);
      if (k < least) (least = k), (best = [a, b]);
    }
  }
  return { way: quintic(from, to, best[0] * chord, best[1] * chord, Math.max(2, Math.ceil((chord * 1.6) / (STEP / 2)))), sharpest: least };
}

/**
 * The way a trailer's axle is backed from one pose to another, each its
 * place and the way it is moving, its cab's angle to it `bend`, and its
 * hitch `hitch` ahead of the axle: a quintic, leaving and arriving along
 * those ways and straight there. Of the ways it could lean out at either
 * end, the one the cab follows most gently and ends most nearly in line
 * on, as a driver swings wide to keep off a jackknife. Points a step
 * apart.
 */
export function reverse(from: Body, to: Body, hitch: number, bend = 0): P[] {
  const chord = Math.hypot(to.x - from.x, to.y - from.y);
  if (chord < 1e-6) return [[from.x, from.y]];
  /** How the cab follows: the fastest it turns, a radian a tile, and how
   *  far out of line with its trailer it ends, each weighed. */
  const roughness = (pts: P[]) => {
    let cab = from.heading + Math.PI + bend;
    let worst = 0;
    let at: P = [pts[0][0] - Math.cos(from.heading) * hitch, pts[0][1] - Math.sin(from.heading) * hitch];
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const way = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const next: P = [b[0] - Math.cos(way) * hitch, b[1] - Math.sin(way) * hitch];
      const moved = Math.hypot(next[0] - at[0], next[1] - at[1]);
      if (moved > 1e-9) {
        const h = Math.atan2(at[1] - next[1], at[0] - next[0]);
        worst = Math.max(worst, Math.abs(wrap(h - cab)) / Math.hypot(b[0] - a[0], b[1] - a[1]));
        cab = h;
      }
      at = next;
    }
    return worst + 20 * Math.abs(wrap(cab - (to.heading + Math.PI)));
  };
  let best = [1.2, 1.2], least = Infinity;
  for (const a of LEANS) {
    for (const b of LEANS) {
      const r = roughness(quintic(from, to, a * chord, b * chord, 60));
      if (r < least) (least = r), (best = [a, b]);
    }
  }
  return quintic(from, to, best[0] * chord, best[1] * chord, Math.max(2, Math.ceil((chord * 1.6) / (STEP / 2))));
}

/**
 * A drive in parts, each driven forward or backing, one after the other:
 * each starts as the one before left the vehicle, the first from where it
 * `leaves` (else standing on its route, pointing along it, or away from it
 * if it starts backing), and the last eased onto where it `stands`, if it
 * is given.
 */
export function drive(parts: Part[], rig: Rig, leaves?: Pose | null, stands?: Pose | null): Drive {
  const table: { s: number; body: Body; trailer?: Body }[] = [];
  const flat = (p: Pose | null | undefined): Body | undefined => p ? { x: p.at[0], y: p.at[1], heading: p.heading } : undefined;
  const [start, end] = [flat(leaves), flat(stands)];

  // The state: the cab's rear axle and heading, the trailer's axle.
  const [p0, p1] = [parts[0].points[0], parts[0].points[1]];
  const h0 = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) + (parts[0].backing ? Math.PI : 0);
  const first = start ?? { x: p0[0], y: p0[1], heading: h0 };
  let cab: Body = along(first, -rig.axle);
  let trailer: Body | undefined = rig.trailer && { ...along(cab, -rig.trailer.axle), heading: cab.heading };
  const pose = () => ({
    body: along(cab, rig.axle),
    trailer: trailer && rig.trailer && { x: cab.x - Math.cos(trailer.heading) * rig.trailer.middle, y: cab.y - Math.sin(trailer.heading) * rig.trailer.middle, heading: trailer.heading },
  });

  /** The trailer, if there is one, drawn after its hitch. */
  const tow = () => {
    if (!trailer || !rig.trailer) return;
    const dx = cab.x - trailer.x, dy = cab.y - trailer.y, l = Math.hypot(dx, dy) || 1;
    trailer = { x: cab.x - (dx / l) * rig.trailer.axle, y: cab.y - (dy / l) * rig.trailer.axle, heading: Math.atan2(dy, dx) };
  };
  type Steps = { u: number; body: Body; trailer?: Body }[];

  /** Steer the cab's rear axle along `route` until its nearest point on
   *  the route is `ahead` past the route's end (short of it if negative),
   *  moving `sign` (1 forward, -1 backing) along its own heading, the
   *  trailer after it. Each pose onto `out`, with how far it has gone. */
  const steer = (route: P[], sign: number, ahead: number, out: Steps) => {
    const path = measure(route);
    const target = path.length + ahead;
    let s = path.near([cab.x, cab.y], ahead, 1, 1);
    const s0 = s;
    // A lead that starts off its way (out of a change of gear, round a
    // corner) is let start there, and brought within `KEEP` as it goes.
    const [qx, qy] = path.at(s);
    let keep = Math.max(KEEP, Math.hypot(cab.x - qx, cab.y - qy));
    /** The curvature the driver wants: toward a point a little ahead. */
    const wants = () => {
      const lead = cab;
      const travel = sign > 0 ? lead.heading : lead.heading + Math.PI;
      const [tx, ty] = path.at(Math.min(s + LOOK, target + LOOK));
      const dist = Math.hypot(tx - lead.x, ty - lead.y);
      const alpha = wrap(Math.atan2(ty - lead.y, tx - lead.x) - travel);
      return { lead, travel, want: Math.max(-LOCK, Math.min(LOCK, (2 * Math.sin(alpha)) / Math.max(dist, 1e-6))) };
    };
    // Standing, the wheel is turned where it is wanted before it moves
    // off; coming off a planned way, moving, it is straight.
    let [k, u] = [out.length > 1 ? 0 : wants().want, out[out.length - 1].u];
    const u0 = u;
    for (let n = 0; n < (path.length + 2) / STEP * 3 && s < target; n++) {
      const { lead, travel, want } = wants();
      k += Math.max(-WHEEL * STEP, Math.min(WHEEL * STEP, want - k));
      // The last step only as far as the end.
      const step = Math.min(STEP, Math.max(target - s, 1e-4));
      const heading = travel + k * step;
      let [x, y] = [lead.x + Math.cos(heading) * step, lead.y + Math.sin(heading) * step];
      u += step;
      // Never back, and no further on than the lead has driven, or a
      // little more round the inside of a bend; and never falling behind
      // it, all but as far as it has driven (`PACE`): a lead that missed a
      // corner is not left to find it again.
      s = Math.max(path.near([x, y], s, 0, 2 * step), Math.min(target, s0 + PACE * (u - u0) - KEEP));
      // Kept within `KEEP` of the way: what would take it further is taken
      // back a little each step, so a driver who overshoots comes back to
      // it, never off round a circle of their own.
      const [px, py] = path.at(s);
      const off = Math.hypot(x - px, y - py);
      keep = Math.max(KEEP, Math.min(keep, off) - step / 2);
      if (off > keep) [x, y] = [px + ((x - px) * keep) / off, py + ((y - py) * keep) / off];
      cab = { x, y, heading: sign > 0 ? heading : heading - Math.PI };
      tow();
      out.push({ u, ...pose() });
    }
    return out;
  };

  /** The lead's place and the way it is moving. */
  const going = (sign: number): Body => ({ ...cab, heading: sign > 0 ? cab.heading : cab.heading + Math.PI });
  /** The lead driven along a way exactly, pointing the way it moves, so
   *  never sideways: the poses, `u` on from the last of `out`. */
  const pinned = (way: P[], sign: number, out: Steps) => {
    for (let i = 1; i < way.length; i++) {
      const [a, b] = [way[i - 1], way[i]];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < 1e-9) continue;
      const travel = Math.atan2(b[1] - a[1], b[0] - a[0]);
      cab = { x: b[0], y: b[1], heading: sign > 0 ? travel : travel + Math.PI };
      tow();
      out.push({ u: out[out.length - 1].u + l, ...pose() });
    }
    return out;
  };
  /** Of the ways onto (or off) a route, a few tiles on (or before its
   *  end), the one driven best: as easy as `EASY` of full lock and,
   *  of those, soonest on the lane. */
  const best = (tries: number[], plan: (d: number) => { way: P[]; sharpest: number }) => {
    let pick: { d: number; way: P[] } | undefined, least = Infinity;
    for (const d of tries) {
      const j = plan(d);
      if (j.sharpest > HARDEST * LOCK) continue;
      const score = Math.max(0, j.sharpest - EASY * LOCK) + 0.1 * d;
      if (score < least) (least = score), (pick = { d, way: j.way });
    }
    return pick;
  };

  for (const [k, { points, backing, from, to }] of parts.entries()) {
    let driven;
    const sign = backing ? -1 : 1;
    const next = parts[k + 1];
    // Where it will stand, its lead axle moving into it.
    const goal: Body | undefined = !next && end ? { ...along(end, -rig.axle), heading: end.heading + (backing ? Math.PI : 0) } : undefined;
    /** Backing a car: from pose to pose, to where it will stand or,
     *  backed to a change of gear, pointing the way the next part goes or
     *  as near it as the room allows, toward the way the route backs. */
    const backed = () => {
      if (goal || !next) return goal && joint(going(-1), goal);
      const e = points[points.length - 1];
      const [h, own] = [measure(next.points).heading(0.3), measure(points).heading(Infinity) + Math.PI];
      const at = (f: number) => {
        const n = h + wrap(own - h) * f;
        return { x: e[0] - Math.cos(n) * rig.axle, y: e[1] - Math.sin(n) * rig.axle, heading: n + Math.PI };
      };
      const ways = [0, 0.25, 0.5, 0.75, 1].map((f) => joint(going(-1), at(f)));
      return ways.find((w) => w.sharpest <= EASY * LOCK) ?? ways[ways.length - 1];
    };
    let back;
    if (backing && trailer && rig.trailer) {
      // Backing a lorry: the trailer's axle leads, on a way planned from
      // where it stands to where it must end (`reverse`). The hitch rides
      // the trailer's nose; the cab points the way its rear axle, on the
      // hitch, is moving: backwards.
      const tr = rig.trailer;
      const route = measure(points);
      const aim = !next && end
        ? { ...along(end, -(rig.axle + tr.axle)), heading: end.heading + Math.PI }
        : { ...along({ x: points[points.length - 1][0], y: points[points.length - 1][1], heading: route.heading(route.length) }, tr.axle + rig.axle) };
      let hitch: P = [cab.x, cab.y];
      const out = [{ u: 0, ...pose() }];
      const way = reverse({ ...trailer, heading: trailer.heading + Math.PI }, aim, tr.axle, wrap(cab.heading - trailer.heading));
      for (let i = 1; i < way.length; i++) {
        const [a, b] = [way[i - 1], way[i]];
        trailer = { x: b[0], y: b[1], heading: Math.atan2(a[1] - b[1], a[0] - b[0]) };
        const next: P = [b[0] + Math.cos(trailer.heading) * tr.axle, b[1] + Math.sin(trailer.heading) * tr.axle];
        const mx = hitch[0] - next[0], my = hitch[1] - next[1];
        cab = Math.hypot(mx, my) > 1e-9 ? { x: next[0], y: next[1], heading: Math.atan2(my, mx) } : { ...cab, x: next[0], y: next[1] };
        hitch = next;
        out.push({ u: out[out.length - 1].u + Math.hypot(b[0] - a[0], b[1] - a[1]), ...pose() });
      }
      driven = out;
    } else if (backing && (back = backed()) && back.sharpest <= HARDEST * LOCK) {
      // Backing a car out of where it stood or into where it will: a way
      // planned from pose to pose, driven exactly.
      driven = pinned(back.way, -1, [{ u: 0, ...pose() }]);
    } else {
      // The rear axle leads, steered along the route; the trailer trails
      // its hitch. Out of where it stood, onto the route by a way planned
      // from that pose, and off it again into where it will stand, each
      // driven exactly: a kerb or a drive is tighter than a driver steers.
      const out: Steps = [{ u: 0, ...pose() }];
      let route = measure(points);
      const off = (r: typeof route, d: number) => {
        const i = r.distances.findIndex((x) => x > d);
        return measure([r.at(d), ...(i < 0 ? [] : r.points.slice(i))]);
      };
      if (k === 0 && start) {
        const onto = best(TRIES.filter((d) => d < route.length), (d) => joint(going(sign), { ...pointAt(route, d), heading: route.heading(d) }));
        if (onto) pinned(onto.way, sign, out), (route = off(route, onto.d));
      }
      const before = goal && best(TRIES.filter((d) => d < route.length), (d) => joint({ ...pointAt(route, route.length - d), heading: route.heading(route.length - d) }, goal));
      const cut = before ? route.length - before.d : route.length;
      const i = route.distances.findIndex((x) => x >= cut);
      steer([...route.points.slice(0, Math.max(1, i)), route.at(cut)], sign, before ? 0 : -sign * rig.axle, out);
      // From where the steering left it: if that is no easier than lock
      // allows, steered the rest of the way instead, and eased on.
      const last = goal && joint(going(sign), goal);
      if (before && last && last.sharpest <= HARDEST * LOCK) pinned(last.way, sign, out);
      else if (before) steer(route.points, sign, -sign * rig.axle, out);
      driven = out;
    }
    // Fitted to the stretch of the server's distance it covers.
    const whole = driven[driven.length - 1].u || 1;
    for (const { u, body, trailer } of driven) {
      const s = from + (u / whole) * (to - from);
      if (!table.length || s > table[table.length - 1].s) table.push({ s, body, trailer });
    }
  }

  // Eased onto where it will stand: what is left between where the drive
  // ends and that, taken out a little at a time over the last stretch.
  const final = table[table.length - 1];
  if (end && final) {
    const t = straight(end, rig);
    const off = (a: Body, b: Body) => ({ x: b.x - a.x, y: b.y - a.y, heading: wrap(b.heading - a.heading) });
    const [db, dt] = [off(final.body, end), final.trailer && t && off(final.trailer, t)];
    const from = Math.max(parts[parts.length - 1].from, final.s - SETTLE);
    const nudge = (p: Body, d: Body, w: number): Body => ({ x: p.x + d.x * w, y: p.y + d.y * w, heading: p.heading + d.heading * w });
    for (const e of table) {
      if (e.s <= from) continue;
      const x = (e.s - from) / (final.s - from || 1);
      const w = x * x * (3 - 2 * x);
      e.body = nudge(e.body, db, w);
      if (e.trailer && dt) e.trailer = nudge(e.trailer, dt, w);
    }
  }

  const length = final ? final.s : 0;
  return {
    length,
    at(s) {
      if (!table.length) return { body: { at: [first.x, first.y], heading: first.heading } };
      let lo = 0, hi = table.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (table[mid].s < s) lo = mid + 1;
        else hi = mid;
      }
      const b = table[lo], a = table[Math.max(0, lo - 1)];
      const t = b.s > a.s ? Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s))) : 1;
      const mix = (p: Body, q: Body): Pose => ({ at: [p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t], heading: p.heading + wrap(q.heading - p.heading) * t });
      return { body: mix(a.body, b.body), trailer: a.trailer && b.trailer ? mix(a.trailer, b.trailer) : undefined };
    },
  };
}

/**
 * How far along a drive in runs a vehicle is, a time into it: each run
 * from a stand to a stand, gathering way at an even `push` up to its
 * `top` and losing it the same way, and `cusp` seconds standing between
 * runs. Its whole time, `secs`.
 */
export function paced(runs: { length: number; top: number }[], push: number, cusp: number) {
  const time = ({ length: l, top }: { length: number; top: number }) => (l < (top * top) / push ? 2 * Math.sqrt(l / push) : l / top + top / push);
  const along = ({ length: l, top }: { length: number; top: number }, t: number) => {
    const whole = time({ length: l, top });
    const v = Math.min(top, Math.sqrt(l * push));
    const ramp = v / push;
    if (t < ramp) return 0.5 * push * t * t;
    if (t > whole - ramp) return l - 0.5 * push * (whole - t) ** 2;
    return 0.5 * v * ramp + v * (t - ramp);
  };
  const secs = runs.reduce((a, r) => a + time(r), 0) + cusp * Math.max(0, runs.length - 1);
  return {
    secs,
    at(t: number) {
      let s = 0;
      for (const r of runs) {
        const w = time(r);
        if (t <= w) return s + along(r, Math.max(0, t));
        t -= w + cusp;
        s += r.length;
        if (t < 0) return s;
      }
      return s;
    },
  };
}

/** A car's rear axle stands a third of its length behind its middle. */
export const CAR_RIG: Rig = { axle: CAR.l / 3 };
/** A lorry: the cab's rear axle, and the hitch on it, a little behind the
 *  cab's middle; the trailer's axle and middle behind the hitch. */
export const LORRY_RIG: Rig = { axle: CAB.l / 3, trailer: { axle: TRAILER.axle, middle: TRAILER.l / 2 - TRAILER.overhang } };

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
  leaves?: Pose | null;
  stands?: Pose | null;
}

/** The tightest a drivable way turns: a little wider than full lock, so
 *  the driver can hold it. */
const WIDEST_LOCK = 0.35;

/**
 * A way as a vehicle can drive it: a route's corners are rounded only as
 * far as the stretches either side allow, and a lot's are a few hand
 * widths long (a yard's lane meets its door at the door), so a hairpin
 * there is tighter than any lock. Driven as drawn, the driver overshoots,
 * finds the way behind it and comes round in a loop. Points a short step
 * apart, eased toward their neighbours' middle where the way turns
 * tighter than `WIDEST_LOCK` until it nowhere does, its ends and the way
 * it leaves and arrives kept.
 */
export function drivable(points: P[]): P[] {
  const bend = (p: P[], i: number) => {
    const [a, b, c] = [p[i - 1], p[i], p[i + 1]];
    const turn = Math.abs(wrap(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0])));
    return turn < 1e-9 ? Infinity : Math.hypot(c[0] - a[0], c[1] - a[1]) / 2 / turn;
  };
  if (points.every((_, i) => i === 0 || i === points.length - 1 || bend(points, i) >= WIDEST_LOCK)) return points;
  const gap = 0.04;
  const out: P[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let k = 1; k <= Math.ceil(l / gap); k++) {
      const t = Math.min(1, (k * gap) / l);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  if (out.length < 5) return points;
  const radius = (i: number) => bend(out, i);
  // Only round the tight places, and what is near them, again and again.
  let near = new Set<number>();
  for (let i = 1; i < out.length - 1; i++) if (radius(i) < WIDEST_LOCK) near.add(i);
  for (let round = 0; round < 400 && near.size; round++) {
    const next = new Set<number>();
    for (const i of near) {
      for (let j = Math.max(2, i - 1); j <= Math.min(out.length - 3, i + 1); j++) {
        const [a, c] = [out[j - 1], out[j + 1]];
        out[j] = [out[j][0] + 0.5 * ((a[0] + c[0]) / 2 - out[j][0]), out[j][1] + 0.5 * ((a[1] + c[1]) / 2 - out[j][1])];
      }
    }
    for (const i of near) {
      for (let j = Math.max(1, i - 2); j <= Math.min(out.length - 2, i + 2); j++) if (radius(j) < WIDEST_LOCK) next.add(j);
    }
    near = next;
  }
  return out;
}

/** A part's ends made drivable, where its lot nodes are; a street's
 *  corners are rounded wide enough already. */
function ends(points: P[]): P[] {
  const { distances: d, length: L } = measure(points);
  if (L <= 8) return drivable(points);
  const a = d.findIndex((x) => x >= 4), b = d.findIndex((x) => x >= L - 4);
  return [...drivable(points.slice(0, a + 1)), ...points.slice(a + 1, b), ...drivable(points.slice(b))];
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
 *  gear (`backing`, stretches of edges `[a, b)` driven backwards), each
 *  part's route drawn as a street route is, its lot nodes where they are
 *  and so its ends where the gear changes. */
export function driveTrip(t: Driven, rig: Rig, lanes?: number[], was?: Swerve): Drive | null {
  const { route_positions: route, from_lot: fromLot, to_lot: toLot, backing } = t;
  const n = route.length;
  const cuts = [...new Set([0, ...backing.flat(), n - 1])].filter((k) => k >= 0 && k < n).sort((a, b) => a - b);
  const drawn: { points: P[]; backing: boolean }[] = [];
  for (let c = 1; c < cuts.length; c++) {
    const [i, j] = [cuts[c - 1], cuts[c]];
    const nodes = route.slice(i, j + 1);
    const fl = Math.max(fromLot - i, i > 0 ? 1 : 0), tl = Math.max(j + 1 - (n - toLot), j < n - 1 ? 1 : 0);
    const path = (offsets?: number[]) => drawnPath(nodes, offsets ? offsets.slice(i, j + 1) : LANE_OFFSET, Math.min(fl, nodes.length), Math.min(tl, nodes.length));
    const d = path(lanes);
    if (!d) continue;
    let points = d.points;
    // Across from the lane it left: the path bends over from that lane's
    // to this one's, and the driver steers along it as round a bend.
    const left = was && path(was.lanes);
    if (left && left.points.length === points.length) {
      const before = drawn.reduce((s, p) => s + measure(p.points).length, 0);
      let s = before;
      points = points.map((p, k) => {
        if (k > 0) s += Math.hypot(p[0] - points[k - 1][0], p[1] - points[k - 1][1]);
        const u = Math.max(0, Math.min(1, (s - was.along) / was.over));
        const e = u * u * (3 - 2 * u);
        const o = left.points[k];
        return [o[0] + (p[0] - o[0]) * e, o[1] + (p[1] - o[1]) * e];
      });
    }
    drawn.push({ points: ends(points), backing: backing.some(([a, b]) => a <= i && i < b) });
  }
  if (!drawn.length) return null;
  // Where each part starts and ends, by the server's distance; or by its
  // own length, where the server's are not to be had.
  const own = drawn.map((p) => measure(p.points).length);
  const server = t.cusps && t.total_route_length !== undefined && t.cusps.length === drawn.length - 1 ? [0, ...t.cusps, t.total_route_length] : null;
  const bounds = server ?? own.reduce((b, l) => [...b, b[b.length - 1] + l], [0]);
  return drive(drawn.map((p, k) => ({ ...p, from: bounds[k], to: bounds[k + 1] })), rig, t.leaves, t.stands);
}
