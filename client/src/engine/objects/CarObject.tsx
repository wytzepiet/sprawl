import { Color3, Path3D, Vector3 } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import { boxGeometry } from "./buildings";
import { simNow } from "../../network/clock";
import type { Look } from "./look";
import type { Car, GameObjectEntry } from "../../generated";
import { carPoses, parts } from "../../state/selection";

/// Everyone keeps their car for life, and its id never changes — so neither
/// does its colour.
const PALETTE = [
  new Color3(0.9, 0.25, 0.2),
  new Color3(0.85, 0.85, 0.88),
  new Color3(0.2, 0.22, 0.28),
  new Color3(0.25, 0.4, 0.75),
  new Color3(0.65, 0.65, 0.68),
  new Color3(0.55, 0.15, 0.15),
  new Color3(0.2, 0.5, 0.4),
  new Color3(0.8, 0.65, 0.25),
];
const carGeo = boxGeometry(0.18, 0.35, 0.15);
/** A van: a box a car and a bit long, tall, and always the same white. */
const vanGeo = boxGeometry(0.2, 0.45, 0.22);
const VAN = new Color3(0.92, 0.92, 0.9);
/** A lorry: a cab-over tractor and a semi-trailer, two boxes. The tractor
 *  is the vehicle the server moves; the trailer hangs off a hitch near
 *  the tractor's tail and follows it, its heading the line from its own
 *  axle to the hitch, the axle always one trailer length behind. Forward
 *  that is stable and swings through a corner the way a trailer does. */
const CAB = { w: 0.2, l: 0.2, h: 0.25 };
const TRAILER = { w: 0.2, l: 0.55, h: 0.27, axle: 0.45, overhang: 0.03 };
const cabGeo = boxGeometry(CAB.w, CAB.l, CAB.h);
const trailerGeo = boxGeometry(TRAILER.w, TRAILER.l, TRAILER.h);
/** How far behind the tractor's centre the hitch sits. */
const HITCH = 0.06;
const CAB_COLOR = new Color3(0.28, 0.36, 0.58);
const TRAILER_COLOR = new Color3(0.9, 0.9, 0.88);
const LANE_OFFSET = 0.11;
const BEZIER_SAMPLES = 8;

const CAR_Z = 0.095;
/** A box sits on the ground: its centre is half its height up. */
const GROUND = CAR_Z - 0.15 / 2;

/// Small deterministic hash so a car's colour is a fact about the car, not
/// a roll of the dice.
function hash(id: number, salt: number): number {
  let h = (id ^ (salt * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function quadBezier(
  a: Vector3,
  control: Vector3,
  b: Vector3,
  t: number,
): Vector3 {
  const mt = 1 - t;
  return new Vector3(
    mt * mt * a.x + 2 * mt * t * control.x + t * t * b.x,
    mt * mt * a.y + 2 * mt * t * control.y + t * t * b.y,
    0,
  );
}

/**
 * Each node moved onto the right-hand lane. The lot nodes at either end of
 * a route — the spot pulled out of, the spot driven into — are where they
 * are, and the car slides onto the lane between them and the street.
 */
function offsetNodes(nodes: Vector3[], offset: number, fromLot: number, toLot: number): Vector3[] {
  const result: Vector3[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (i < fromLot || i >= nodes.length - toLot) {
      result.push(nodes[i].clone());
      continue;
    }
    let dx = 0,
      dy = 0;
    if (i > 0) {
      dx += nodes[i].x - nodes[i - 1].x;
      dy += nodes[i].y - nodes[i - 1].y;
    }
    if (i < nodes.length - 1) {
      dx += nodes[i + 1].x - nodes[i].x;
      dy += nodes[i + 1].y - nodes[i].y;
    }
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) {
      result.push(nodes[i].clone());
      continue;
    }
    const rx = (-dy / len) * offset;
    const ry = (dx / len) * offset;
    result.push(new Vector3(nodes[i].x + rx, nodes[i].y + ry, 0));
  }
  return result;
}

export function mountCar(
  entry: GameObjectEntry,
  pool: InstancePool,
  scene: Scene,
  look: Look,
): () => void {
  const car = entry.object.data as Car;
  if (car.role === "Truck") return mountLorry(entry.id, car, pool, scene, look);
  const van = car.role === "Van";
  const color = van ? VAN : PALETTE[Math.floor(hash(entry.id, 1) * PALETTE.length)];
  const bucket = van ? `van${look.key}` : `car${look.key}c${PALETTE.indexOf(color)}`;
  pool.ensureBucket(bucket, van ? vanGeo : carGeo, look.tint(color), look.castShadow, true);

  // Parked: in its spot, as the server placed it. No spot is a full lot,
  // and the car is out of sight until it moves.
  if (!car.trip) {
    if (!car.spot) return () => {};
    const { at, heading } = car.spot;
    const instanceId = pool.addInstance(bucket, [at[0], at[1], van ? GROUND + 0.11 : CAR_Z], [0, 0, heading - Math.PI / 2]);
    carPoses.set(entry.id, [at[0], at[1]]);
    parts.set(entry.id, [{ key: bucket, id: instanceId }]);
    return () => {
      pool.removeInstance(bucket, instanceId);
      carPoses.delete(entry.id);
      parts.delete(entry.id);
    };
  }
  const f = follow(car);
  if (!f) return () => {};
  const initial = f.now();
  const instanceId = pool.addInstance(bucket, initial.pos, initial.rot);
  parts.set(entry.id, [{ key: bucket, id: instanceId }]);
  const observer = scene.onBeforeRenderObservable.add(() => {
    const result = f.now();
    pool.updateInstance(bucket, instanceId, result.pos, result.rot);
    carPoses.set(entry.id, [result.pos[0], result.pos[1]]);
  });
  return () => {
    scene.onBeforeRenderObservable.remove(observer);
    pool.removeInstance(bucket, instanceId);
    carPoses.delete(entry.id);
    parts.delete(entry.id);
  };
}

/** The two boxes of a lorry, parked or on the move. */
function mountLorry(id: number, car: Car, pool: InstancePool, scene: Scene, look: Look): () => void {
  const cab = `lorry_cab${look.key}`;
  const trailer = `lorry_trailer${look.key}`;
  pool.ensureBucket(cab, cabGeo, look.tint(CAB_COLOR), look.castShadow, true);
  pool.ensureBucket(trailer, trailerGeo, look.tint(TRAILER_COLOR), look.castShadow, true);
  const cabZ = GROUND + CAB.h / 2;
  const trailerZ = GROUND + TRAILER.h / 2;
  // The trailer's axle, kept between frames: where it was is what decides
  // where it goes.
  let axle: [number, number] | null = null;
  const place = (x: number, y: number, heading: number, straight: boolean) => {
    const fx = Math.cos(heading), fy = Math.sin(heading);
    const hitch: [number, number] = [x - fx * HITCH, y - fy * HITCH];
    if (straight || !axle) axle = [hitch[0] - fx * TRAILER.axle, hitch[1] - fy * TRAILER.axle];
    let ux = hitch[0] - axle[0], uy = hitch[1] - axle[1];
    const len = Math.hypot(ux, uy) || 1;
    ux /= len; uy /= len;
    axle = [hitch[0] - ux * TRAILER.axle, hitch[1] - uy * TRAILER.axle];
    const back = TRAILER.l / 2 - TRAILER.overhang;
    return {
      cab: { pos: [x, y, cabZ] as [number, number, number], rot: [0, 0, heading - Math.PI / 2] as [number, number, number] },
      trailer: { pos: [hitch[0] - ux * back, hitch[1] - uy * back, trailerZ] as [number, number, number], rot: [0, 0, Math.atan2(uy, ux) - Math.PI / 2] as [number, number, number] },
    };
  };
  if (!car.trip) {
    if (!car.spot) return () => {};
    const { at, heading } = car.spot;
    const p = place(at[0], at[1], heading, true);
    const a = pool.addInstance(cab, p.cab.pos, p.cab.rot);
    const b = pool.addInstance(trailer, p.trailer.pos, p.trailer.rot);
    carPoses.set(id, [at[0], at[1]]);
    parts.set(id, [{ key: cab, id: a }, { key: trailer, id: b }]);
    return () => { pool.removeInstance(cab, a); pool.removeInstance(trailer, b); carPoses.delete(id); parts.delete(id); };
  }
  const f = follow(car);
  if (!f) return () => {};
  const from = reverseFrom(car, f);
  // Backing in is the pull-out played backwards: the tractor driven forward
  // from the dock out to the stop point, the trailer following on the
  // hitch, every pose kept by distance along the path. The first part of
  // the reverse blends from the trailer as it arrived, straight behind,
  // into the table: the driver swinging the nose out to line up.
  const table: { dist: number; ux: number; uy: number }[] = [];
  if (from !== null) {
    let ax = Number.NaN, ay = Number.NaN;
    for (let d = f.length; d >= from; d -= 0.02) {
      const fix = f.at(d);
      const heading = fix.rot[2] + Math.PI / 2 + Math.PI;
      const fx = Math.cos(heading), fy = Math.sin(heading);
      const hx = fix.pos[0] - fx * HITCH, hy = fix.pos[1] - fy * HITCH;
      if (Number.isNaN(ax)) { ax = hx - fx * TRAILER.axle; ay = hy - fy * TRAILER.axle; }
      let ux: number = hx - ax, uy: number = hy - ay;
      const len = Math.hypot(ux, uy) || 1;
      ux /= len; uy /= len;
      ax = hx - ux * TRAILER.axle; ay = hy - uy * TRAILER.axle;
      table.push({ dist: d, ux, uy });
    }
    table.reverse();
  }
  const first = f.now();
  const p0 = place(first.pos[0], first.pos[1], first.rot[2] + Math.PI / 2, true);
  const a = pool.addInstance(cab, p0.cab.pos, p0.cab.rot);
  const b = pool.addInstance(trailer, p0.trailer.pos, p0.trailer.rot);
  parts.set(id, [{ key: cab, id: a }, { key: trailer, id: b }]);
  let arrived: [number, number] | null = null;
  const observer = scene.onBeforeRenderObservable.add(() => {
    const r = f.now();
    carPoses.set(id, [r.pos[0], r.pos[1]]);
    if (from !== null && r.dist >= from && table.length) {
      const heading = r.rot[2] + Math.PI / 2 + Math.PI;
      const fx = Math.cos(heading), fy = Math.sin(heading);
      const hx = r.pos[0] - fx * HITCH, hy = r.pos[1] - fy * HITCH;
      let lo = 0, hi = table.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (table[mid].dist < r.dist) lo = mid + 1; else hi = mid; }
      let ux: number = table[lo].ux, uy: number = table[lo].uy;
      const t = Math.min(1, (r.dist - from) / (0.2 * Math.max(1e-6, f.length - from)));
      if (arrived) {
        ux = arrived[0] * (1 - t) + ux * t;
        uy = arrived[1] * (1 - t) + uy * t;
        const n = Math.hypot(ux, uy) || 1;
        ux /= n; uy /= n;
      }
      const back = TRAILER.l / 2 - TRAILER.overhang;
      pool.updateInstance(cab, a, [r.pos[0], r.pos[1], cabZ], [0, 0, heading - Math.PI / 2]);
      pool.updateInstance(trailer, b, [hx - ux * back, hy - uy * back, trailerZ], [0, 0, Math.atan2(uy, ux) - Math.PI / 2]);
      return;
    }
    const p = place(r.pos[0], r.pos[1], r.rot[2] + Math.PI / 2, false);
    arrived = [Math.cos(p.trailer.rot[2] + Math.PI / 2), Math.sin(p.trailer.rot[2] + Math.PI / 2)];
    pool.updateInstance(cab, a, p.cab.pos, p.cab.rot);
    pool.updateInstance(trailer, b, p.trailer.pos, p.trailer.rot);
  });
  return () => {
    scene.onBeforeRenderObservable.remove(observer);
    pool.removeInstance(cab, a);
    pool.removeInstance(trailer, b);
    carPoses.delete(id);
    parts.delete(id);
  };
}

/** Where a car on a trip is at any moment, from the trip the server sent:
 *  its route rounded at the corners, and its own physics extrapolated. */
type Fix = { pos: [number, number, number]; rot: [number, number, number]; dist: number };

/** A car's drawn path for its trip: the route rounded at the corners, and
 *  where the car is on it now from its own physics, or at any distance. */
interface Follower {
  now(): Fix;
  at(dist: number): Fix;
  length: number;
}

function follow(car: Car): Follower | null {
  const data = car.trip!;
  const centerNodes = data.route_positions.map(
    ([x, y]) => new Vector3(x, y, 0),
  );
  const nodes = offsetNodes(centerNodes, LANE_OFFSET, data.from_lot, data.to_lot);
  const pathPoints: Vector3[] = [];

  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const segLen = Vector3.Distance(a, b);
    if (segLen < 1e-9) continue;
    const dir = b.subtract(a).scaleInPlace(1 / segLen);

    const start = i > 0 ? a.add(dir.scale(segLen * 0.5)) : a.clone();

    if (i === 0) {
      pathPoints.push(start);
    }

    if (i + 2 < nodes.length) {
      const r1 = segLen * 0.5;
      const beforeB = b.subtract(dir.scale(r1));
      pathPoints.push(beforeB);

      const c = nodes[i + 2];
      const nextLen = Vector3.Distance(b, c);
      const r2 = nextLen * 0.5;
      const nextDir = c.subtract(b).scaleInPlace(1 / Math.max(nextLen, 1e-9));
      const afterB = b.add(nextDir.scale(r2));

      for (let s = 1; s <= BEZIER_SAMPLES; s++) {
        pathPoints.push(quadBezier(beforeB, b, afterB, s / BEZIER_SAMPLES));
      }
    } else {
      pathPoints.push(b);
    }
  }

  if (pathPoints.length < 2) return null;
  const path = new Path3D(pathPoints);
  const distances = path.getDistances();
  const length = distances[distances.length - 1];

  const at = (dist: number): Fix => {
    const normalized = Math.min(Math.max(0, dist / length), 1);
    const p = path.getPointAt(normalized);
    const tangent = path.getTangentAt(normalized);
    return { pos: [p.x, p.y, CAR_Z], rot: [0, 0, Math.atan2(tangent.y, tangent.x) - Math.PI / 2], dist: normalized * length };
  };
  const now = (): Fix => {
    let dt = Math.max(0, (simNow() - data.updated_at) / 1000);
    if (data.acceleration < 0) {
      const tStop = -data.speed / data.acceleration;
      if (dt > tStop) dt = tStop;
    }
    return at(data.progress + data.speed * dt + 0.5 * data.acceleration * dt * dt);
  };
  return { now, at, length };
}

/** Where a trip's reverse tail begins, as a distance along its drawn path:
 *  the last `reverse` edges, measured straight, taken off the end. */
function reverseFrom(car: Car, f: Follower): number | null {
  const data = car.trip!;
  if (!data.reverse) return null;
  const pts = data.route_positions;
  let tail = 0;
  for (let i = pts.length - data.reverse; i < pts.length; i++) tail += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return Math.max(0, f.length - tail);
}
