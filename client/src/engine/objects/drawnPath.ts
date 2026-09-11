import { Path3D, Vector3 } from "@babylonjs/core";

const BEZIER_SAMPLES = 8;

/** A point on a drawn path: where, which way, how far along. */
export type Fix = { pos: [number, number, number]; rot: [number, number, number]; dist: number };

export interface DrawnPath {
  points: Vector3[];
  path: Path3D;
  /** The distance along the path of each point. */
  distances: number[];
  /** The distance along the path where the car passes each node — through
   *  the middle of the curve at a corner. */
  atNode: number[];
  length: number;
  at(dist: number, z: number): Fix;
}

function quadBezier(a: Vector3, control: Vector3, b: Vector3, t: number): Vector3 {
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

/** The path a car is drawn on: the nodes, offset onto the lane, the
 *  corners rounded. What a car drives and what a tractor's marks follow. */
export function drawnPath(centerNodes: Vector3[], offset: number, fromLot: number, toLot: number): DrawnPath | null {
  const nodes = offsetNodes(centerNodes, offset, fromLot, toLot);
  const points: Vector3[] = [];
  const nodeIndex: number[] = [];

  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const segLen = Vector3.Distance(a, b);
    if (segLen < 1e-9) {
      nodeIndex.push(points.length - 1);
      continue;
    }
    const dir = b.subtract(a).scaleInPlace(1 / segLen);

    if (i === 0) {
      points.push(a.clone());
      nodeIndex.push(0);
    }

    if (i + 2 < nodes.length) {
      const r1 = segLen * 0.5;
      const beforeB = b.subtract(dir.scale(r1));
      points.push(beforeB);

      const c = nodes[i + 2];
      const nextLen = Vector3.Distance(b, c);
      const r2 = nextLen * 0.5;
      const nextDir = c.subtract(b).scaleInPlace(1 / Math.max(nextLen, 1e-9));
      const afterB = b.add(nextDir.scale(r2));

      for (let s = 1; s <= BEZIER_SAMPLES; s++) {
        points.push(quadBezier(beforeB, b, afterB, s / BEZIER_SAMPLES));
        if (s * 2 === BEZIER_SAMPLES) nodeIndex.push(points.length - 1);
      }
    } else {
      points.push(b);
      nodeIndex.push(points.length - 1);
    }
  }

  if (points.length < 2) return null;
  const path = new Path3D(points);
  const distances = path.getDistances();
  const length = distances[distances.length - 1];
  const atNode = nodeIndex.map((i) => distances[Math.max(0, i)]);

  const at = (dist: number, z: number): Fix => {
    const normalized = Math.min(Math.max(0, dist / length), 1);
    const p = path.getPointAt(normalized);
    const tangent = path.getTangentAt(normalized);
    return { pos: [p.x, p.y, z], rot: [0, 0, Math.atan2(tangent.y, tangent.x) - Math.PI / 2], dist: normalized * length };
  };
  return { points, path, distances, atNode, length, at };
}
