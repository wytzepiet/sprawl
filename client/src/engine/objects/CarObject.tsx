import { Color3, Path3D, Vector3 } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import { boxGeometry } from "./buildings";
import { simNow } from "../../network/clock";
import type { Look } from "./draftLook";
import type { GameObjectEntry } from "../../generated";

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
const LANE_OFFSET = 0.11;
const BEZIER_SAMPLES = 8;

/// Small deterministic hash so a car's colour and parking spot are facts
/// about the car, not rolls of the dice.
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

function offsetNodes(nodes: Vector3[], offset: number): Vector3[] {
  const result: Vector3[] = [];
  for (let i = 0; i < nodes.length; i++) {
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
  const car = entry.object.data as {
    owner: number;
    trip: {
      route_positions: [number, number][];
      progress: number;
      speed: number;
      acceleration: number;
      total_route_length: number;
      updated_at: number;
    } | null;
  };
  const color = PALETTE[Math.floor(hash(entry.id, 1) * PALETTE.length)];
  const bucket = `car${look.key}c${PALETTE.indexOf(color)}`;
  pool.ensureBucket(
    bucket, carGeo, look.tint(color), look.castShadow, true, undefined, look.alpha, look.lift,
  );

  // Parked: a still car beside the building it stopped at, in a spot that is
  // a fact about the car rather than a roll of the dice. The building's tile
  // is all the server says; the jitter keeps a full lot from stacking into
  // one shimmering car.
  if (!car.trip) {
    if (!entry.position) return () => {};
    const dx = hash(entry.id, 2) * 0.7 - 0.35;
    const dy = hash(entry.id, 3) * 0.7 - 0.35;
    const facing = Math.floor(hash(entry.id, 4) * 4) * (Math.PI / 2);
    const instanceId = pool.addInstance(
      bucket,
      [entry.position.x + dx, entry.position.y + dy, 0.095],
      [0, 0, facing],
    );
    return () => pool.removeInstance(bucket, instanceId);
  }

  const data = car.trip;
  const centerNodes = data.route_positions.map(
    ([x, y]) => new Vector3(x, y, 0),
  );
  const nodes = offsetNodes(centerNodes, LANE_OFFSET);
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

  function computePosition(): {
    pos: [number, number, number];
    rot: [number, number, number];
    tangent: Vector3;
  } | null {
    if (!path) return null;

    let dt = Math.max(0, (simNow() - data.updated_at) / 1000);
    if (data.acceleration < 0) {
      const tStop = -data.speed / data.acceleration;
      if (dt > tStop) dt = tStop;
    }
    const dist =
      data.progress + data.speed * dt + 0.5 * data.acceleration * dt * dt;
    const distances = path!.getDistances();
    const pathLength = distances[distances.length - 1];
    const normalized = Math.min(Math.max(0, dist / pathLength), 1);

    const p = path!.getPointAt(normalized);
    const tangent = path!.getTangentAt(normalized);
    return {
      pos: [p.x, p.y, 0.095],
      rot: [0, 0, Math.atan2(tangent.y, tangent.x) - Math.PI / 2],
      tangent,
    };
  }

  const initial = computePosition();

  const instanceId = pool.addInstance(
    bucket,
    initial?.pos ?? [0, 0, -10],
    initial?.rot ?? [0, 0, 0],
  );

  const observer = scene.onBeforeRenderObservable.add(() => {
    const result = computePosition();
    if (result) {
      pool.updateInstance(bucket, instanceId, result.pos, result.rot);
    }
  });

  return () => {
    scene.onBeforeRenderObservable.remove(observer);
    pool.removeInstance(bucket, instanceId);
  };
}
