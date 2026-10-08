/** A point on the map. */
export type P = { x: number; y: number };

const BEZIER_SAMPLES = 8;

/** A point on a drawn path: where, which way, how far along. */
export type Fix = { pos: [number, number, number]; rot: [number, number, number]; dist: number };

/** A run of points, and where along it any distance falls: a point and
 *  the way it runs there, each point's way the sum of its two legs, read
 *  from the point before. */
export class Polyline {
  readonly distances: number[] = [0];
  private ways: P[] = [];

  constructor(readonly points: P[]) {
    for (let i = 1; i < points.length; i++) this.distances.push(this.distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    for (let i = 0; i < points.length; i++) {
      const [a, b] = [points[Math.max(0, i - 1)], points[Math.min(points.length - 1, i + 1)]];
      const [x, y] = [b.x - a.x, b.y - a.y];
      const l = Math.hypot(x, y) || 1;
      this.ways.push({ x: x / l, y: y / l });
    }
  }

  get length(): number {
    return this.distances[this.distances.length - 1];
  }

  /** The leg a share of the way along falls in, and how far into it. */
  private find(share: number): [number, number] {
    const d = Math.min(Math.max(0, share), 1) * this.length;
    let i = 0;
    while (i < this.distances.length - 2 && this.distances[i + 1] < d) i++;
    const leg = this.distances[i + 1] - this.distances[i];
    return [i, leg > 0 ? (d - this.distances[i]) / leg : 0];
  }

  pointAt(share: number): P {
    const [i, t] = this.find(share);
    const [a, b] = [this.points[i], this.points[Math.min(i + 1, this.points.length - 1)]];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  wayAt(share: number): P {
    return this.ways[this.find(share)[0]];
  }
}

export interface DrawnPath {
  points: P[];
  path: Polyline;
  /** The distance along the path of each point. */
  distances: number[];
  /** The distance along the path where the car passes each node — through
   *  the middle of the curve at a corner. */
  atNode: number[];
  length: number;
  at(dist: number, z: number): Fix;
}

function quadBezier(a: P, control: P, b: P, t: number): P {
  const mt = 1 - t;
  return { x: mt * mt * a.x + 2 * mt * t * control.x + t * t * b.x, y: mt * mt * a.y + 2 * mt * t * control.y + t * t * b.y };
}

/**
 * Each node moved onto the right-hand lane. The lot nodes at either end of
 * a route — the spot pulled out of, the spot driven into — are where they
 * are, and the car slides onto the lane between them and the street.
 */
function offsetNodes(nodes: P[], offset: number, fromLot: number, toLot: number): P[] {
  const result: P[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (i < fromLot || i >= nodes.length - toLot) {
      result.push({ ...nodes[i] });
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
      result.push({ ...nodes[i] });
      continue;
    }
    const rx = (-dy / len) * offset;
    const ry = (dx / len) * offset;
    result.push({ x: nodes[i].x + rx, y: nodes[i].y + ry });
  }
  return result;
}

/** The path a car is drawn on: the nodes, offset onto the lane, the
 *  corners rounded. */
export function drawnPath(centerNodes: P[], offset: number, fromLot: number, toLot: number): DrawnPath | null {
  const nodes = offsetNodes(centerNodes, offset, fromLot, toLot);
  const points: P[] = [];
  const nodeIndex: number[] = [];

  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-9) {
      nodeIndex.push(points.length - 1);
      continue;
    }
    const dir = { x: (b.x - a.x) / segLen, y: (b.y - a.y) / segLen };

    if (i === 0) {
      points.push({ ...a });
      nodeIndex.push(0);
    }

    if (i + 2 < nodes.length) {
      const r1 = segLen * 0.5;
      const beforeB = { x: b.x - dir.x * r1, y: b.y - dir.y * r1 };
      points.push(beforeB);

      const c = nodes[i + 2];
      const nextLen = Math.hypot(c.x - b.x, c.y - b.y);
      const r2 = nextLen * 0.5;
      const k = r2 / Math.max(nextLen, 1e-9);
      const afterB = { x: b.x + (c.x - b.x) * k, y: b.y + (c.y - b.y) * k };

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
  const path = new Polyline(points);
  const { distances, length } = path;
  const atNode = nodeIndex.map((i) => distances[Math.max(0, i)]);

  const at = (dist: number, z: number): Fix => {
    const normalized = Math.min(Math.max(0, dist / length), 1);
    const p = path.pointAt(normalized);
    const tangent = path.wayAt(normalized);
    return { pos: [p.x, p.y, z], rot: [0, 0, Math.atan2(tangent.y, tangent.x) - Math.PI / 2], dist: normalized * length };
  };
  return { points, path, distances, atNode, length, at };
}
