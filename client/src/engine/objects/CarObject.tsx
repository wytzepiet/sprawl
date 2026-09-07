import { Color3, Path3D, Vector3 } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import { boxGeometry } from "./buildings";
import { simNow } from "../../network/clock";
import type { Look } from "./look";
import type { Car, GameObjectEntry } from "../../generated";

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
  if (car.role === "Truck") return mountLorry(car, pool, scene, look);
  const color = PALETTE[Math.floor(hash(entry.id, 1) * PALETTE.length)];
  const bucket = `car${look.key}c${PALETTE.indexOf(color)}`;
  pool.ensureBucket(bucket, carGeo, look.tint(color), look.castShadow, true);

  // Parked: in its spot, as the server placed it. No spot is a full lot,
  // and the car is out of sight until it moves.
  if (!car.trip) {
    if (!car.spot) return () => {};
    const { at, heading } = car.spot;
    const instanceId = pool.addInstance(bucket, [at[0], at[1], CAR_Z], [0, 0, heading - Math.PI / 2]);
    return () => pool.removeInstance(bucket, instanceId);
  }
  const move = follow(car);
  if (!move) return () => {};
  const initial = move();
  const instanceId = pool.addInstance(bucket, initial?.pos ?? [0, 0, -10], initial?.rot ?? [0, 0, 0]);
  const observer = scene.onBeforeRenderObservable.add(() => {
    const result = move();
    if (result) pool.updateInstance(bucket, instanceId, result.pos, result.rot);
  });
  return () => {
    scene.onBeforeRenderObservable.remove(observer);
    pool.removeInstance(bucket, instanceId);
  };
}

/** The two boxes of a lorry, parked or on the move. */
function mountLorry(car: Car, pool: InstancePool, scene: Scene, look: Look): () => void {
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
    return () => { pool.removeInstance(cab, a); pool.removeInstance(trailer, b); };
  }
  const move = follow(car);
  if (!move) return () => {};
  const first = move();
  const p0 = first ? place(first.pos[0], first.pos[1], first.rot[2] + Math.PI / 2, true) : null;
  const a = pool.addInstance(cab, p0?.cab.pos ?? [0, 0, -10], p0?.cab.rot ?? [0, 0, 0]);
  const b = pool.addInstance(trailer, p0?.trailer.pos ?? [0, 0, -10], p0?.trailer.rot ?? [0, 0, 0]);
  const observer = scene.onBeforeRenderObservable.add(() => {
    const r = move();
    if (!r) return;
    const p = place(r.pos[0], r.pos[1], r.rot[2] + Math.PI / 2, false);
    pool.updateInstance(cab, a, p.cab.pos, p.cab.rot);
    pool.updateInstance(trailer, b, p.trailer.pos, p.trailer.rot);
  });
  return () => {
    scene.onBeforeRenderObservable.remove(observer);
    pool.removeInstance(cab, a);
    pool.removeInstance(trailer, b);
  };
}

/** Where a car on a trip is at any moment, from the trip the server sent:
 *  its route rounded at the corners, and its own physics extrapolated. */
function follow(car: Car): (() => { pos: [number, number, number]; rot: [number, number, number] } | null) | null {
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

  const path = pathPoints.length >= 2 ? new Path3D(pathPoints) : null;

  function computePosition(): { pos: [number, number, number]; rot: [number, number, number] } | null {
    if (!path) return null;

    let dt = Math.max(0, (simNow() - data.updated_at) / 1000);
    if (data.acceleration < 0) {
      const tStop = -data.speed / data.acceleration;
      if (dt > tStop) dt = tStop;
    }
    const dist = data.progress + data.speed * dt + 0.5 * data.acceleration * dt * dt;
    const distances = path!.getDistances();
    const pathLength = distances[distances.length - 1];
    const normalized = Math.min(Math.max(0, dist / pathLength), 1);

    const p = path!.getPointAt(normalized);
    const tangent = path!.getTangentAt(normalized);
    return { pos: [p.x, p.y, CAR_Z], rot: [0, 0, Math.atan2(tangent.y, tangent.x) - Math.PI / 2] };
  }

  return path ? computePosition : null;
}
