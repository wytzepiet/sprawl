import type { P } from "../geometry";

const BEZIER_SAMPLES = 8;

/** A polyline measured: the point at any distance (straight on past either
 *  end) and the way it runs there, and the distance of the point on it
 *  nearest to a point, searched near a guess. */
export function measure(points: P[]) {
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const d = distances;
  const length = d[d.length - 1];
  const dir = (i: number): P => {
    const [a, b] = [points[i], points[i + 1]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
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
  const at = (s: number): P => {
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
  /** The distance along of the nearest point, from `back` behind a guess
   *  to `reach` ahead of it; past either end, on the straight run on. */
  const near = (p: P, guess: number, back: number, reach: number) => {
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
  /** The way the leg a distance along falls in runs, radians. */
  const heading = (s: number) => {
    const u = dir(index(s) - 1);
    return Math.atan2(u[1], u[0]);
  };
  return { points, distances, length, at, near, heading };
}

export type DrawnPath = ReturnType<typeof measure> & {
  /** The distance along the path where the car passes each node — through
   *  the middle of the curve at a corner. */
  atNode: number[];
  /** Where it passes node `k`, a fraction of the way on to the next
   *  between two: as far along as that. */
  passing(k: number): number;
};

/** A point `t` of the way along a quadratic Bézier curve. */
export function quadBezier(a: P, control: P, b: P, t: number): P {
  const mt = 1 - t;
  return [mt * mt * a[0] + 2 * mt * t * control[0] + t * t * b[0], mt * mt * a[1] + 2 * mt * t * control[1] + t * t * b[1]];
}

/**
 * Each node moved onto the right-hand lane. The lot nodes at either end of
 * a route — the spot pulled out of, the spot driven into — are where they
 * are, and the car slides onto the lane between them and the street.
 */
function offsetNodes(nodes: P[], offsets: number | number[], fromLot: number, toLot: number): P[] {
  const result: P[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (i < fromLot || i >= nodes.length - toLot) {
      result.push(nodes[i]);
      continue;
    }
    let dx = 0,
      dy = 0;
    if (i > 0) {
      dx += nodes[i][0] - nodes[i - 1][0];
      dy += nodes[i][1] - nodes[i - 1][1];
    }
    if (i < nodes.length - 1) {
      dx += nodes[i + 1][0] - nodes[i][0];
      dy += nodes[i + 1][1] - nodes[i][1];
    }
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) {
      result.push(nodes[i]);
      continue;
    }
    const offset = typeof offsets === "number" ? offsets : offsets[i];
    const rx = (-dy / len) * offset;
    const ry = (dx / len) * offset;
    result.push([nodes[i][0] + rx, nodes[i][1] + ry]);
  }
  return result;
}

/** The path a car is drawn on: the nodes, offset onto the lane, the
 *  corners rounded. */
export function drawnPath(centerNodes: P[], offset: number | number[], fromLot: number, toLot: number): DrawnPath | null {
  const nodes = offsetNodes(centerNodes, offset, fromLot, toLot);
  const points: P[] = [];
  const nodeIndex: number[] = [];

  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (segLen < 1e-9) {
      nodeIndex.push(points.length - 1);
      continue;
    }
    const dir = [(b[0] - a[0]) / segLen, (b[1] - a[1]) / segLen];

    if (i === 0) {
      points.push(a);
      nodeIndex.push(0);
    }

    if (i + 2 < nodes.length) {
      const r1 = segLen * 0.5;
      const beforeB: P = [b[0] - dir[0] * r1, b[1] - dir[1] * r1];
      points.push(beforeB);

      const c = nodes[i + 2];
      const nextLen = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const r2 = nextLen * 0.5;
      const k = r2 / Math.max(nextLen, 1e-9);
      const afterB: P = [b[0] + (c[0] - b[0]) * k, b[1] + (c[1] - b[1]) * k];

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
  const path = measure(points);
  const atNode = nodeIndex.map((i) => path.distances[Math.max(0, i)]);
  const passing = (k: number) => {
    const t = Math.min(Math.max(0, k), atNode.length - 1);
    const i = Math.min(Math.floor(t), atNode.length - 2);
    return atNode[i] + (atNode[i + 1] - atNode[i]) * (t - i);
  };
  return { ...path, atNode, passing };
}
