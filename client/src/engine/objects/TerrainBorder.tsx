import { createMemo, Show, For } from "solid-js";
import { Color3 } from "@babylonjs/core";
import Mesh, { type MeshGeometry } from "../Mesh";
import type { KindEntry } from "../GameObject";
import { useTheme } from "../theme";
import { useGame } from "../../state/gameObjects";
import type { GameObjectEntry, TerrainType } from "../../generated";
import { terrainColor } from "./TerrainTile";

const OVERLAY_Z = 0.03;
const LINE_HALF_W = 0.03;
const OVERLAY_COLOR = new Color3(1, 0.2, 0.2);
const CURVE_SEGMENTS = 8;

const FULL_SQUARE: MeshGeometry = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
};

// --- Arm computation (spatial neighbor check) ---

type Pair = { type_a: string; type_b: string };

function borderPair(e: GameObjectEntry): Pair | null {
  if (e.object.kind !== "TerrainBorder") return null;
  return { type_a: e.object.data.type_a, type_b: e.object.data.type_b };
}

function samePair(a: Pair, b: Pair): boolean {
  return a.type_a === b.type_a && a.type_b === b.type_b;
}

const ALL_DIRS: [number, number][] = [
  [0, 1], [1, 1], [1, 0], [1, -1],
  [0, -1], [-1, -1], [-1, 0], [-1, 1],
];

function computeArms(
  x: number,
  y: number,
  myPair: Pair,
  getObjectsAt: (x: number, y: number) => GameObjectEntry[],
): number[] {
  const isBorder = (cx: number, cy: number): Pair | null => {
    for (const e of getObjectsAt(cx, cy)) {
      const p = borderPair(e);
      if (p) return p;
    }
    return null;
  };

  let samePairCount = 0;
  for (const [dx, dy] of ALL_DIRS) {
    const p = isBorder(x + dx, y + dy);
    if (p && samePair(p, myPair)) samePairCount++;
  }
  const isDeadEnd = samePairCount <= 1;

  const angles: number[] = [];
  for (const [dx, dy] of ALL_DIRS) {
    const p = isBorder(x + dx, y + dy);
    if (!p) continue;

    const isDiag = dx !== 0 && dy !== 0;

    if (samePair(p, myPair)) {
      if (isDiag) {
        const s1 = isBorder(x + dx, y);
        const s2 = isBorder(x, y + dy);
        if ((s1 && samePair(s1, myPair)) || (s2 && samePair(s2, myPair))) continue;
      }
      angles.push(Math.atan2(dy, dx));
    } else if (isDeadEnd) {
      let nSame = 0;
      for (const [ndx, ndy] of ALL_DIRS) {
        const np = isBorder(x + dx + ndx, y + dy + ndy);
        if (np && samePair(np, p)) nSame++;
      }
      if (nSame > 1) continue;

      if (isDiag) {
        const s1 = isBorder(x + dx, y);
        const s2 = isBorder(x, y + dy);
        const isDeadOther = (bp: Pair | null) => bp && !samePair(bp, myPair);
        if (isDeadOther(s1) || isDeadOther(s2)) continue;
      }
      angles.push(Math.atan2(dy, dx));
    }
  }
  return angles;
}

// --- Geometry helpers ---

function armEdgePoint(angle: number): [number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const len = 0.5 / Math.max(Math.abs(cos), Math.abs(sin));
  return [len * cos, len * sin];
}

function quadBezier(p0: [number, number], ctrl: [number, number], p1: [number, number], t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * ctrl[0] + t * t * p1[0],
    u * u * p0[1] + 2 * u * t * ctrl[1] + t * t * p1[1],
  ];
}

function fanTriangulate(polygon: [number, number][]): MeshGeometry {
  if (polygon.length < 3) return { positions: [], indices: [], normals: [] };
  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  for (const [x, y] of polygon) {
    positions.push(x, y, 0);
    normals.push(0, 0, 1);
  }
  for (let i = 1; i < polygon.length - 1; i++) {
    indices.push(0, i, i + 1);
  }
  return { positions, indices, normals };
}

// --- Perimeter utilities for splitting the unit square ---

const CORNERS: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** Map a point on the unit square boundary to a parameter in [0, 4) going clockwise from (0,0) */
function perimeterParam(x: number, y: number): number {
  if (y < 0.01) return x;               // bottom: 0→1
  if (x > 0.99) return 1 + y;           // right:  1→2
  if (y > 0.99) return 2 + (1 - x);     // top:    2→3
  return 3 + (1 - y);                   // left:   3→4
}

/** Collect corners whose perimeter param falls between `from` and `to` (going forward), sorted by distance from `from` */
function collectCorners(from: number, to: number): [number, number][] {
  const range = ((to - from) % 4 + 4) % 4;
  if (range === 0) return [];
  const result: { corner: [number, number]; dist: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const d = ((i - from) % 4 + 4) % 4;
    if (d > 0 && d < range) {
      result.push({ corner: CORNERS[i], dist: d });
    }
  }
  result.sort((a, b) => a.dist - b.dist);
  return result.map((r) => r.corner);
}

// --- type_a_dirs bitmask: bit 0=S, 1=E, 2=N, 3=W ---
const DIR_VECTORS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
// Perimeter params for boundary midpoints of each cardinal direction
const TYPE_A_BOUNDARY_PARAMS = [0.5, 1.5, 2.5, 3.5]; // S, E, N, W
// Angles for each cardinal direction
const TYPE_A_ANGLES = [-Math.PI / 2, 0, Math.PI / 2, Math.PI]; // S, E, N, W

/** Check if perimeter param p falls in the open range (from, to) going forward */
function paramInRange(p: number, from: number, to: number): boolean {
  const range = ((to - from) % 4 + 4) % 4;
  if (range < 0.01) return false;
  const d = ((p - from) % 4 + 4) % 4;
  return d > 0.01 && d < range - 0.01;
}

/** Check if angle a falls in the arc from a1 to a2 (going counterclockwise) */
function angleInArc(a: number, a1: number, a2: number): boolean {
  const span = ((a2 - a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const d = ((a - a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return d > 0.01 && d < span - 0.01;
}

// --- Split the unit square along a bezier curve into two terrain-colored halves ---

function buildTerrainHalves(
  armAngles: number[],
  type_a_dirs: number,
): { a: MeshGeometry; b: MeshGeometry } {
  const edges = armAngles.map(armEdgePoint);

  const curve: [number, number][] = [];
  for (let i = 0; i <= CURVE_SEGMENTS; i++) {
    const [cx, cy] = quadBezier(edges[0], [0, 0], edges[1], i / CURVE_SEGMENTS);
    curve.push([cx + 0.5, cy + 0.5]);
  }

  const startP = perimeterParam(curve[0][0], curve[0][1]);
  const endP = perimeterParam(curve[curve.length - 1][0], curve[curve.length - 1][1]);

  const cornersA = collectCorners(endP, startP);
  const cornersB = collectCorners(startP, endP);

  const polyA = [...curve, ...cornersA];
  const polyB = [...[...curve].reverse(), ...cornersB];

  // For each type_a cardinal direction, check if its boundary midpoint falls
  // in polyA's perimeter range (endP→startP) or polyB's (startP→endP).
  // This is geometrically exact — no centroid approximation.
  let polyAVotes = 0;
  for (let i = 0; i < 4; i++) {
    if (!(type_a_dirs & (1 << i))) continue;
    const bp = TYPE_A_BOUNDARY_PARAMS[i];
    if (paramInRange(bp, endP, startP)) polyAVotes++;
    else if (paramInRange(bp, startP, endP)) polyAVotes--;
    // If bp is on a curve endpoint (within epsilon), skip — it's ambiguous
  }

  // Fallback for ambiguous cases: use chord normal + corner test
  if (polyAVotes === 0) {
    const nx = -(edges[1][1] - edges[0][1]);
    const ny = edges[1][0] - edges[0][0];
    // Use a corner point (never on the curve) to determine polyA's side
    const corner = cornersA.length > 0 ? cornersA[0] : cornersB.length > 0 ? cornersB[0] : null;
    if (corner) {
      const polyASide = (corner[0] - 0.5) * nx + (corner[1] - 0.5) * ny;
      const flip = cornersA.length === 0; // corner is from B, flip sign
      const polyASign = flip ? -polyASide : polyASide;
      // Pick best type_a direction (largest |dot| with chord normal)
      let bestDot = 0;
      for (let i = 0; i < 4; i++) {
        if (!(type_a_dirs & (1 << i))) continue;
        const [dx, dy] = DIR_VECTORS[i];
        const d = dx * nx + dy * ny;
        if (Math.abs(d) > Math.abs(bestDot)) bestDot = d;
      }
      polyAVotes = (polyASign > 0) === (bestDot > 0) ? 1 : -1;
    }
  }

  return polyAVotes >= 0
    ? { a: fanTriangulate(polyA), b: fanTriangulate(polyB) }
    : { a: fanTriangulate(polyB), b: fanTriangulate(polyA) };
}

// --- Build sector meshes for 3+ connections ---

function buildSectors(
  armAngles: number[],
  type_a: TerrainType,
  type_b: TerrainType,
  type_a_dirs: number,
  theme: ReturnType<typeof useTheme>,
): { geo: MeshGeometry; color: Color3 }[] {
  const sorted = [...armAngles].sort((a, b) => a - b);
  const result: { geo: MeshGeometry; color: Color3 }[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const a1 = sorted[i];
    const a2 = sorted[(i + 1) % sorted.length];

    const e1 = armEdgePoint(a1);
    const e2 = armEdgePoint(a2);
    const e1s: [number, number] = [e1[0] + 0.5, e1[1] + 0.5];
    const e2s: [number, number] = [e2[0] + 0.5, e2[1] + 0.5];

    const p1 = perimeterParam(e1s[0], e1s[1]);
    const p2 = perimeterParam(e2s[0], e2s[1]);
    const corners = collectCorners(p1, p2);

    const polygon: [number, number][] = [[0.5, 0.5], e1s, ...corners, e2s];

    // Check if any type_a direction's angle falls within this sector's arc
    let isTypeA = false;
    for (let j = 0; j < 4; j++) {
      if (!(type_a_dirs & (1 << j))) continue;
      if (angleInArc(TYPE_A_ANGLES[j], a1, a2)) { isTypeA = true; break; }
    }
    const sectorType = isTypeA ? type_a : type_b;

    result.push({ geo: fanTriangulate(polygon), color: terrainColor(sectorType, theme) });
  }
  return result;
}

// --- Red overlay (bezier strip or straight lines) ---

function buildStrip(points: [number, number][]): MeshGeometry {
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const px = (-dy / len) * LINE_HALF_W;
    const py = (dx / len) * LINE_HALF_W;
    left.push([points[i][0] + px, points[i][1] + py]);
    right.push([points[i][0] - px, points[i][1] - py]);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i < points.length; i++) {
    positions.push(left[i][0], left[i][1], OVERLAY_Z);
    positions.push(right[i][0], right[i][1], OVERLAY_Z);
    normals.push(0, 0, 1, 0, 0, 1);
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  return { positions, indices, normals };
}

function buildOverlay(armAngles: number[]): MeshGeometry {
  const edges = armAngles.map(armEdgePoint);

  if (edges.length === 2) {
    const points: [number, number][] = [];
    for (let i = 0; i <= CURVE_SEGMENTS; i++) {
      points.push(quadBezier(edges[0], [0, 0], edges[1], i / CURVE_SEGMENTS));
    }
    return buildStrip(points);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  for (const [ex, ey] of edges) {
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len < 1e-6) continue;
    const px = (-ey / len) * LINE_HALF_W;
    const py = (ex / len) * LINE_HALF_W;
    const off = positions.length / 3;
    positions.push(
      -px, -py, OVERLAY_Z,
       px,  py, OVERLAY_Z,
      ex + px, ey + py, OVERLAY_Z,
      ex - px, ey - py, OVERLAY_Z,
    );
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    indices.push(off, off + 1, off + 2, off, off + 2, off + 3);
  }
  return { positions, indices, normals };
}

// --- Component ---

export default function TerrainBorder(props: { entry: KindEntry<"TerrainBorder"> }) {
  const theme = useTheme();
  const { getObjectsAt } = useGame();
  const pos = props.entry.position!;
  const { type_a, type_b, type_a_dirs } = props.entry.object.data;
  const myPair: Pair = { type_a, type_b };

  const armAngles = createMemo(() => computeArms(pos.x, pos.y, myPair, getObjectsAt));

  const terrainMeshes = createMemo((): { geo: MeshGeometry; color: Color3 }[] => {
    const angles = armAngles();

    if (angles.length === 2) {
      const { a, b } = buildTerrainHalves(angles, type_a_dirs);
      return [
        { geo: a, color: terrainColor(type_a, theme) },
        { geo: b, color: terrainColor(type_b, theme) },
      ];
    }

    if (angles.length >= 3) {
      return buildSectors(angles, type_a, type_b, type_a_dirs, theme);
    }

    // 0-1 connections: full square as type_a
    return [{ geo: FULL_SQUARE, color: terrainColor(type_a, theme) }];
  });

  const overlay = createMemo(() => {
    const angles = armAngles();
    if (angles.length === 0) return null;
    return buildOverlay(angles);
  });

  return (
    <>
      <For each={terrainMeshes()}>
        {(mesh, i) => (
          <Mesh
            name={`terrain_border_${props.entry.id}_${i()}`}
            geometry={mesh().geo}
            position={[pos.x, pos.y, 0]}
            color={mesh().color}
            receiveShadow
          />
        )}
      </For>
      <Show when={overlay()}>
        {(geo) => (
          <Mesh
            name={`border_overlay_${props.entry.id}`}
            geometry={geo()}
            position={[pos.x + 0.5, pos.y + 0.5, 0]}
            color={OVERLAY_COLOR}
          />
        )}
      </Show>
    </>
  );
}
