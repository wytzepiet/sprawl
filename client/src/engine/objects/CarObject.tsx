import { onCleanup } from "solid-js";
import { Color3, Path3D, Vector3, type Mesh } from "@babylonjs/core";
import MeshComponent from "../Mesh";
import { useEngine } from "../Canvas";
import type { KindEntry } from "../GameObject";
import { useGame } from "../../state/gameObjects";
import { boxGeometry } from "./buildings";
import { getClockOffset } from "../../network/connection";

const CAR_COLOR = new Color3(0.9, 0.25, 0.2);
const carGeo = boxGeometry(0.25, 0.45, 0.2);
const LANE_OFFSET = 0.15;
const CORNER_RADIUS = 0.3; // must match server
const BEZIER_SAMPLES = 8;

function quadBezier(a: Vector3, b: Vector3, c: Vector3, t: number): Vector3 {
  const mt = 1 - t;
  return new Vector3(
    mt * mt * a.x + 2 * mt * t * b.x + t * t * c.x,
    mt * mt * a.y + 2 * mt * t * b.y + t * t * c.y,
    0,
  );
}

/** Offset each node to the right of the travel direction. */
function offsetNodes(nodes: Vector3[], offset: number): Vector3[] {
  const result: Vector3[] = [];
  for (let i = 0; i < nodes.length; i++) {
    // Compute travel direction at this node
    let dx = 0, dy = 0;
    if (i > 0) {
      const prev = nodes[i - 1];
      dx += nodes[i].x - prev.x;
      dy += nodes[i].y - prev.y;
    }
    if (i < nodes.length - 1) {
      const next = nodes[i + 1];
      dx += next.x - nodes[i].x;
      dy += next.y - nodes[i].y;
    }
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) {
      result.push(nodes[i].clone());
      continue;
    }
    // Right perpendicular: (dy, -dx) normalized
    const rx = dy / len * offset;
    const ry = -dx / len * offset;
    result.push(new Vector3(nodes[i].x + rx, nodes[i].y + ry, 0));
  }
  return result;
}

export default function CarObject(props: { entry: KindEntry<"Car"> }) {
  const { scene } = useEngine();
  const { objects } = useGame();

  let meshRef: Mesh | null = null;

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
      if (!p) return false;
      centerNodes.push(p);
    }
    if (centerNodes.length < 2) return false;

    // Offset nodes to the right of travel direction
    const nodes = offsetNodes(centerNodes, LANE_OFFSET);

    const pathPoints: Vector3[] = [];

    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      const segLen = Vector3.Distance(a, b);
      if (segLen < 1e-9) continue;
      const dir = b.subtract(a).scaleInPlace(1 / segLen);

      const start = i > 0
        ? a.add(dir.scale(Math.min(CORNER_RADIUS, segLen * 0.5)))
        : a.clone();

      if (i === 0) {
        pathPoints.push(start);
      }

      if (i + 2 < nodes.length) {
        const r1 = Math.min(CORNER_RADIUS, segLen * 0.5);
        const beforeB = b.subtract(dir.scale(r1));
        pathPoints.push(beforeB);

        const c = nodes[i + 2];
        const nextLen = Vector3.Distance(b, c);
        const r2 = Math.min(CORNER_RADIUS, nextLen * 0.5);
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

  function carPosition(car: KindEntry<"Car">["object"]["data"]): { normalized: number } | null {
    if (!buildPath(car.route)) return null;

    const offset = getClockOffset();
    const dt = Math.max(0, (Date.now() - (car.updated_at + offset)) / 1000);
    const dist = car.progress + car.speed * dt + 0.5 * car.acceleration * dt * dt;
    const normalized = Math.min(Math.max(0, dist / car.total_route_length), 1);

    return { normalized };
  }

  function computePosition(): { pos: [number, number, number]; rot: [number, number, number] } | null {
    const result = carPosition(props.entry.object.data);
    if (!result) return null;

    const p = cachedPath!.getPointAt(result.normalized);
    const tangent = cachedPath!.getTangentAt(result.normalized);
    return {
      pos: [p.x, p.y, 0.3],
      rot: [0, 0, Math.atan2(tangent.y, tangent.x) - Math.PI / 2],
    };
  }

  const initial = computePosition();

  const observer = scene.onBeforeRenderObservable.add(() => {
    if (!meshRef) return;

    const car = props.entry.object.data;
    const result = carPosition(car);
    if (!result) return;

    const p = cachedPath!.getPointAt(result.normalized);
    const tangent = cachedPath!.getTangentAt(result.normalized);

    meshRef.position.x = p.x;
    meshRef.position.y = p.y;
    meshRef.position.z = 0.3;
    meshRef.rotation.z = Math.atan2(tangent.y, tangent.x) - Math.PI / 2;
  });

  onCleanup(() => {
    scene.onBeforeRenderObservable.remove(observer);
  });

  return (
    <MeshComponent
      name={`car_${props.entry.id}`}
      geometry={carGeo}
      position={initial?.pos ?? [0, 0, -10]}
      rotation={initial?.rot ?? [0, 0, 0]}
      color={CAR_COLOR}
      castShadow
      meshRef={(m) => { meshRef = m; }}
    />
  );
}
