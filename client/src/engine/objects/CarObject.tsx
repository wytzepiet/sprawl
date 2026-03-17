import { onCleanup } from "solid-js";
import {
  Color3,
  Path3D,
  Vector3,
} from "@babylonjs/core";
import InstancedMesh, { type InstanceHandle } from "../InstancePool";
import { useEngine } from "../Canvas";
import type { KindEntry } from "../GameObject";
import { useGame } from "../../state/gameObjects";
import { boxGeometry } from "./buildings";
import { getClockOffset } from "../../network/connection";

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

/** Offset each node to the right of the travel direction. */
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

export default function CarObject(props: { entry: KindEntry<"Car"> }) {
  const { scene } = useEngine();
  const { objects } = useGame();

  let handle: InstanceHandle | null = null;

  function nodePos(nodeId: number): Vector3 | null {
    const entry = objects[String(nodeId)];
    if (!entry?.position) return null;
    return new Vector3(entry.position.x + 0.5, entry.position.y + 0.5, 0);
  }

  let cachedPath: Path3D | null = null;
  let cachedRouteKey = "";

  function buildPath(route: number[]): boolean {
    const key = route.join(",");
    if (key === cachedRouteKey && cachedPath) return true;

    const centerNodes: Vector3[] = [];
    for (const id of route) {
      const p = nodePos(id);
      if (!p) {
        console.warn(
          `[car] buildPath fail: node ${id} not found, route=${route.length} nodes`,
        );
        return false;
      }
      centerNodes.push(p);
    }
    if (centerNodes.length < 2) return false;

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

    cachedPath = new Path3D(pathPoints);
    cachedRouteKey = key;
    return true;
  }

  function carPosition(
    car: KindEntry<"Car">["object"]["data"],
  ): { normalized: number } | null {
    if (!buildPath(car.route)) return null;

    const offset = getClockOffset();
    let dt = Math.max(0, (Date.now() - (car.updated_at + offset)) / 1000);
    if (car.acceleration < 0) {
      const tStop = -car.speed / car.acceleration;
      if (dt > tStop) dt = tStop;
    }
    const dist =
      car.progress + car.speed * dt + 0.5 * car.acceleration * dt * dt;
    const distances = cachedPath!.getDistances();
    const pathLength = distances[distances.length - 1];
    const normalized = Math.min(Math.max(0, dist / pathLength), 1);

    return { normalized };
  }

  function computePosition(): {
    pos: [number, number, number];
    rot: [number, number, number];
  } | null {
    const result = carPosition(props.entry.object.data);
    if (!result) return null;

    const p = cachedPath!.getPointAt(result.normalized);
    const tangent = cachedPath!.getTangentAt(result.normalized);
    return {
      pos: [p.x, p.y, 0.095],
      rot: [0, 0, Math.atan2(tangent.y, tangent.x) - Math.PI / 2],
    };
  }

  const initial = computePosition();
  const car0 = props.entry.object.data;
  if (buildPath(car0.route)) {
    const clientLen = cachedPath!.getDistances().at(-1)!;
    const serverLen = car0.total_route_length;
    const diff = Math.abs(clientLen - serverLen) / serverLen;
    if (diff > 0.01) {
      console.warn(
        `[car ${props.entry.id}] PATH LENGTH MISMATCH: client=${clientLen.toFixed(3)} server=${serverLen.toFixed(3)} diff=${(diff * 100).toFixed(1)}%`,
      );
    }
  }

  const observer = scene.onBeforeRenderObservable.add(() => {
    if (!handle) return;
    const result = computePosition();
    if (result) handle.setMatrix(result.pos, result.rot);
  });

  onCleanup(() => {
    scene.onBeforeRenderObservable.remove(observer);
  });

  return (
    <InstancedMesh
      poolKey="car"
      geometry={carGeo}
      position={initial?.pos ?? [0, 0, -10]}
      rotation={initial?.rot ?? [0, 0, 0]}
      color={CAR_COLOR}
      castShadow
      ref={(h) => { handle = h; }}
    />
  );
}
