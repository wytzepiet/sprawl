import type { MeshGeometry, P } from "../geometry";
import { quadBezier } from "./drawnPath";

/**
 * Road surface geometry: pure maths over a set of arm angles, with no Babylon
 * and no game state. Split out from the mounting code so it can be tested —
 * a node's outline is fiddly enough that a wrong triangle is invisible until
 * back-face culling eats it.
 */

export type Flow = "twoway" | "out" | "in";
/** An arm of a node's road: the way it goes, how it is driven, and, if
 *  not the node's, how wide it is either side of its middle. */
export type ArmInfo = { angle: number; flow: Flow; hw?: number };

/** A road is its asphalt alone, two lanes: the pavement beside it is its
 *  kerb. */
export const ROAD_WIDTH = 0.44;
export const HALF_W = ROAD_WIDTH / 2;
/** A car, across, along and up: in its lane, a little room either side
 *  and between it and the car it passes. */
export const CAR = { w: 0.15, l: 0.29, h: 0.125 };
/** A van: a box a car and a bit long, and tall. */
export const VAN = { w: 0.17, l: 0.37, h: 0.18 };
/** A lorry: a cab-over tractor and a semi-trailer, two boxes. */
export const CAB = { w: 0.17, l: 0.17, h: 0.21 };
export const TRAILER = { w: 0.17, l: 0.46, h: 0.22, axle: 0.37, overhang: 0.025 };
/** A lane's middle, from the road's: where the server drives it, not
 *  widened with the drawn road. */
export const LANE_OFFSET = 0.1;
const CURVE_SEGMENTS = 8;
// A road stands clear of the ground, so the pen sees the step up to it and
// outlines it: 0.03 over the grass, and still 0.02 over a terrain patch
// laid on the grass. Lots, their markings and cars sit relative to it.
export const ROAD_Z = 0.03;

// --- Geometry helpers ---

function fanGeometry(boundary: P[], z: number): MeshGeometry {
  const n = boundary.length;
  const positions: number[] = [0, 0, z];
  const normals: number[] = [0, 0, 1];
  const indices: number[] = [];

  for (const [x, y] of boundary) {
    positions.push(x, y, z);
    normals.push(0, 0, 1);
  }
  // A fan only winds one way if the boundary is star-shaped about its centre,
  // and a road outline is not always: on the outside of a turn it can pass back
  // inside the node. Those triangles used to render anyway, because the
  // material was two-sided — under back-face culling they simply vanish, which
  // is what put holes in corners. Emit each one whichever way round faces the
  // camera, rather than reshaping the outline to suit the triangulator.
  for (let i = 0; i < n; i++) {
    const b = ((i + 1) % n) + 1;
    const d = i + 1;
    const bx = positions[b * 3];
    const by = positions[b * 3 + 1];
    const dx = positions[d * 3];
    const dy = positions[d * 3 + 1];
    // Front-facing toward +Z is a negative cross product here, matching the
    // (0,2,1) order the rest of the project emits.
    if (bx * dy - by * dx > 0) indices.push(0, d, b);
    else indices.push(0, b, d);
  }

  return { positions, indices, normals };
}

function arcPoints(startAngle: number, endAngle: number, hw: number): P[] {
  let span = endAngle - startAngle;
  if (span <= 0) span += 2 * Math.PI;
  const numSegs = Math.max(
    2,
    Math.round((span / (Math.PI / 2)) * CURVE_SEGMENTS),
  );
  const pts: P[] = [];
  for (let j = 0; j <= numSegs; j++) {
    const angle = startAngle + span * (j / numSegs);
    pts.push([hw * Math.cos(angle), hw * Math.sin(angle)]);
  }
  return pts;
}

function edgePoints(a: number, hw: number): { right: P; left: P } {
  const armLen = 0.5 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
  const ex = armLen * Math.cos(a);
  const ey = armLen * Math.sin(a);
  const px = -Math.sin(a);
  const py = Math.cos(a);
  return {
    left: [ex + hw * px, ey + hw * py],
    right: [ex - hw * px, ey - hw * py],
  };
}

/** Where one arm's left edge meets the next arm's right edge, each its
 *  own half-width out from its middle. */
function curveControlPoint(
  aCurr: number,
  aNext: number,
  start: P,
  end: P,
  hwCurr: number,
  hwNext: number,
): P {
  const det = Math.sin(aNext - aCurr);
  if (Math.abs(det) < 1e-6) {
    return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  }
  // s·d1 + h1·n1 = u·d2 − h2·n2, d the arm's way and n its left.
  const [d1x, d1y, d2x, d2y] = [Math.cos(aCurr), Math.sin(aCurr), Math.cos(aNext), Math.sin(aNext)];
  const [rx, ry] = [-hwNext * -d2y - hwCurr * -d1y, -hwNext * d2x - hwCurr * d1x];
  const s = (rx * -d2y - ry * -d2x) / (d1x * -d2y - d1y * -d2x);
  return [s * d1x - hwCurr * d1y, s * d1y + hwCurr * d1x];
}

// --- Gap fill strategies ---

function smoothCurve(
  aCurr: number,
  aNext: number,
  currEdge: { left: P },
  nextEdge: { right: P },
  hwCurr: number,
  hwNext: number,
): P[] {
  let gap = aNext - aCurr;
  if (gap <= 0) gap += 2 * Math.PI;
  const cp = curveControlPoint(aCurr, aNext, currEdge.left, nextEdge.right, hwCurr, hwNext);
  const numSegs = Math.max(
    2,
    Math.round((gap / (Math.PI / 2)) * CURVE_SEGMENTS),
  );
  const pts: P[] = [];
  for (let j = 1; j < numSegs; j++) {
    pts.push(quadBezier(currEdge.left, cp, nextEdge.right, j / numSegs));
  }
  return pts;
}

function deadEndCap(aCurr: number, aNext: number, hw: number): P[] {
  return arcPoints(aCurr + Math.PI / 2, aNext - Math.PI / 2, hw);
}

function sharpCorner(
  aCurr: number,
  aNext: number,
  currLeft: P,
  nextRight: P,
): P[] {
  const d1 = [-Math.cos(aCurr), -Math.sin(aCurr)];
  const d2 = [-Math.cos(aNext), -Math.sin(aNext)];
  const det = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(det) < 1e-6) return [];
  const dx = nextRight[0] - currLeft[0];
  const dy = nextRight[1] - currLeft[1];
  const t = (dx * d2[1] - dy * d2[0]) / det;
  return [[currLeft[0] + t * d1[0], currLeft[1] + t * d1[1]]];
}

// --- Geometry builders ---

export function buildRoadGeometry(arms: ArmInfo[], hw: number, z: number): MeshGeometry | null {
  const boundary = roadBoundary(arms, hw);
  return boundary && fanGeometry(boundary, z);
}

/** The outline of a node's road surface at a half-width, or null with no arms. */
function roadBoundary(arms: ArmInfo[], hw: number): P[] | null {
  if (arms.length === 0) return null;

  const sorted = [...arms].sort((a, b) => a.angle - b.angle);
  const boundary: P[] = [];

  const half = (arm: ArmInfo) => arm.hw ?? hw;
  if (sorted.length === 1) {
    const a = sorted[0].angle;
    const edge = edgePoints(a, half(sorted[0]));
    boundary.push(edge.right, edge.left);
    boundary.push(...arcPoints(a + Math.PI / 2, a + (3 * Math.PI) / 2, half(sorted[0])));
  } else {
    for (let i = 0; i < sorted.length; i++) {
      const curr = sorted[i];
      const next = sorted[(i + 1) % sorted.length];
      const aCurr = curr.angle;
      const aNext = next.angle;
      const currEdge = edgePoints(aCurr, half(curr));
      const nextEdge = edgePoints(aNext, half(next));

      boundary.push(currEdge.right, currEdge.left);

      let gap = aNext - aCurr;
      if (gap <= 0) gap += 2 * Math.PI;

      const isContinuous =
        (curr.flow === "twoway" && next.flow === "twoway") ||
        (curr.flow !== "twoway" &&
          next.flow !== "twoway" &&
          curr.flow !== next.flow);
      const isDrivable =
        curr.flow === "twoway" ||
        next.flow === "twoway" ||
        curr.flow !== next.flow;

      if (gap > Math.PI && !isContinuous) {
        boundary.push(...deadEndCap(aCurr, aNext, (half(curr) + half(next)) / 2));
      } else if (isDrivable) {
        boundary.push(...smoothCurve(aCurr, aNext, currEdge, nextEdge, half(curr), half(next)));
      } else {
        boundary.push(
          ...sharpCorner(aCurr, aNext, currEdge.left, nextEdge.right),
        );
      }
    }
  }

  return boundary;
}

