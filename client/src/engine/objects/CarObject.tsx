import {
  Color3,
  Path3D,
  SpotLight,
  Vector3,
} from "@babylonjs/core";
import type { Scene, ClusteredLightContainer } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import { boxGeometry } from "./buildings";
import { getClockOffset } from "../../network/connection";
import type { GameObjectEntry } from "../../generated";

const CAR_COLOR = new Color3(0.9, 0.25, 0.2);
const carGeo = boxGeometry(0.18, 0.35, 0.15);
const LANE_OFFSET = 0.11;
const BEZIER_SAMPLES = 8;

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
  headlights: { container: ClusteredLightContainer; headlightIntensity: () => number },
): () => void {
  const data = entry.object.data as {
    route_positions: [number, number][];
    progress: number;
    speed: number;
    acceleration: number;
    total_route_length: number;
    updated_at: number;
  };

  const centerNodes = data.route_positions.map(([x, y]) => new Vector3(x, y, 0));
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

  function computePosition(): { pos: [number, number, number]; rot: [number, number, number]; tangent: Vector3 } | null {
    if (!path) return null;

    const offset = getClockOffset();
    let dt = Math.max(0, (Date.now() - (data.updated_at + offset)) / 1000);
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
    return {
      pos: [p.x, p.y, 0.095],
      rot: [0, 0, Math.atan2(tangent.y, tangent.x) - Math.PI / 2],
      tangent,
    };
  }

  const initial = computePosition();

  pool.ensureBucket("car", carGeo, CAR_COLOR, true, true);
  const instanceId = pool.addInstance("car",
    initial?.pos ?? [0, 0, -10],
    initial?.rot ?? [0, 0, 0],
    undefined,
    true, // dynamic — cars move every frame
  );

  // Headlight
  const spot = new SpotLight(
    `headlight_${entry.id}`,
    Vector3.Zero(),
    Vector3.Forward(),
    (160 * Math.PI) / 180,
    2,
    scene,
    true,
  );
  spot.range = 3;
  spot.diffuse = new Color3(1, 0.95, 0.8);
  spot.specular = Color3.Black();
  spot.intensity = 0;
  headlights.container.addLight(spot);

  const observer = scene.onBeforeRenderObservable.add(() => {
    const result = computePosition();
    if (result) {
      pool.updateInstance("car", instanceId, result.pos, result.rot);
      const t = result.tangent;
      spot.position.set(result.pos[0] + t.x * 0.18, result.pos[1] + t.y * 0.18, result.pos[2] + 0.1);
      spot.direction.set(t.x, t.y, -0.1);
      spot.intensity = headlights.headlightIntensity() * 1.5;
    }
  });

  return () => {
    scene.onBeforeRenderObservable.remove(observer);
    headlights.container.removeLight(spot);
    spot.dispose();
    pool.removeInstance("car", instanceId);
  };
}
