import { Color3, RawTexture } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import type { Theme } from "../theme";
import type { GameObjectEntry, TerrainType } from "../../generated";
import type { MeshGeometry } from "../Mesh";

const ELEVATION: Record<TerrainType, number> = {
  Water: -0.5,
  Water2: -0.5,
  Water3: -0.5,
  Beach: 0,
  Grass: 0,
  Forest: 0,
  Mountain: 2.0,
};

// Seeded PRNG (xorshift32)
function seed(x: number, y: number): number {
  let s = (x * 374761393 + y * 668265263 + 1013904223) | 0;
  s = ((s ^ (s >>> 13)) * 1274126177) | 0;
  return s;
}
function nextRand(s: number): [number, number] {
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return [s, (s >>> 0) / 4294967296];
}

const TREE_SEGMENTS = 12;

function buildCylinderGeo(radius: number, height: number): MeshGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  // Side wall
  for (let i = 0; i <= TREE_SEGMENTS; i++) {
    const a = (i / TREE_SEGMENTS) * Math.PI * 2;
    const cx = Math.cos(a), cy = Math.sin(a);
    // bottom
    positions.push(cx * radius, cy * radius, 0);
    normals.push(cx, cy, 0);
    // top
    positions.push(cx * radius, cy * radius, height);
    normals.push(cx, cy, 0);
  }
  for (let i = 0; i < TREE_SEGMENTS; i++) {
    const b = i * 2;
    indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }

  // Top cap
  const topCenter = positions.length / 3;
  positions.push(0, 0, height);
  normals.push(0, 0, 1);
  for (let i = 0; i <= TREE_SEGMENTS; i++) {
    const a = (i / TREE_SEGMENTS) * Math.PI * 2;
    positions.push(Math.cos(a) * radius, Math.sin(a) * radius, height);
    normals.push(0, 0, 1);
  }
  for (let i = 0; i < TREE_SEGMENTS; i++) {
    indices.push(topCenter, topCenter + i + 1, topCenter + i + 2);
  }

  return { positions, indices, normals };
}

const TREE_TRUNK = buildCylinderGeo(1, 1);
interface TreeInfo {
  x: number;
  y: number;
  scale: number;
}

const GRID = 2; // 2x2 jittered grid = 4 trees
const CELL = 1 / GRID;

function treesForTile(tx: number, ty: number): TreeInfo[] {
  let s = seed(tx, ty);
  const trees: TreeInfo[] = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let v: number;
      [s, v] = nextRand(s);
      const x = (gx + v) * CELL;
      [s, v] = nextRand(s);
      const y = (gy + v) * CELL;
      [s, v] = nextRand(s);
      const scale = 0.5 + v * 1;
      trees.push({ x, y, scale });
    }
  }
  return trees;
}

const TEX_SIZE = 32;
const BORDER = 1;

function createBorderTexture(scene: any): RawTexture {
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const i = (y * TEX_SIZE + x) * 4;
      const edge =
        x < BORDER ||
        x >= TEX_SIZE - BORDER ||
        y < BORDER ||
        y >= TEX_SIZE - BORDER;
      const v = edge ? 230 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return RawTexture.CreateRGBATexture(
    data,
    TEX_SIZE,
    TEX_SIZE,
    scene,
    false,
    false,
  );
}

const FULL_SQUARE: MeshGeometry = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
};

const S = 0.5;
const N = 6; // curve segments

const CORNER_DEFS = [
  {
    cv: [0, 0],
    p0h: [S, 0],
    p0f: [1, 0],
    p3h: [0, S],
    p3f: [0, 1],
    tanA: [-1, 0],
    tanB: [0, 1],
  }, // BL
  {
    cv: [1, 0],
    p0h: [1, S],
    p0f: [1, 1],
    p3h: [S, 0],
    p3f: [0, 0],
    tanA: [0, -1],
    tanB: [-1, 0],
  }, // BR
  {
    cv: [1, 1],
    p0h: [1 - S, 1],
    p0f: [0, 1],
    p3h: [1, 1 - S],
    p3f: [1, 0],
    tanA: [1, 0],
    tanB: [0, -1],
  }, // TR
  {
    cv: [0, 1],
    p0h: [0, 1 - S],
    p0f: [0, 0],
    p3h: [S, 1],
    p3f: [1, 1],
    tanA: [0, 1],
    tanB: [1, 0],
  }, // TL
];

function cubicBezier(
  p0: number[],
  c1: number[],
  c2: number[],
  p3: number[],
  t: number,
): [number, number] {
  const u = 1 - t;
  return [
    u * u * u * p0[0] +
      3 * u * u * t * c1[0] +
      3 * u * t * t * c2[0] +
      t * t * t * p3[0],
    u * u * u * p0[1] +
      3 * u * u * t * c1[1] +
      3 * u * t * t * c2[1] +
      t * t * t * p3[1],
  ];
}

// Returns curve points from p0 (edge A) to p3 (edge B) for a corner overlay.
// Straight line (2 points) when both edges continue; bezier (N+1 points) otherwise.
function getCornerCurvePoints(
  defIdx: number,
  variant: number,
): [number, number][] {
  const def = CORNER_DEFS[defIdx];
  const aContinues = !!(variant & 1);
  const bContinues = !!(variant & 2);
  const aExtends = !!(variant & 4) && !aContinues;
  const bExtends = !!(variant & 8) && !bContinues;

  const p0 = aExtends ? def.p0f : def.p0h;
  const p3 = bExtends ? def.p3f : def.p3h;

  if (aContinues && bContinues) {
    return [p0 as [number, number], p3 as [number, number]];
  }

  const armA = Math.hypot(p0[0] - def.cv[0], p0[1] - def.cv[1]);
  const armB = Math.hypot(p3[0] - def.cv[0], p3[1] - def.cv[1]);
  const kA = armA * 0.55;
  const kB = armB * 0.55;

  const dx = def.p3h[0] - def.p0h[0];
  const dy = def.p3h[1] - def.p0h[1];
  const len = Math.hypot(dx, dy);
  const diagX = dx / len;
  const diagY = dy / len;

  const c1 = aContinues
    ? [p0[0] + kA * diagX, p0[1] + kA * diagY]
    : [p0[0] + kA * def.tanA[0], p0[1] + kA * def.tanA[1]];
  const c2 = bContinues
    ? [p3[0] - kB * diagX, p3[1] - kB * diagY]
    : [p3[0] - kB * def.tanB[0], p3[1] - kB * def.tanB[1]];

  const points: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    points.push(cubicBezier(p0, c1, c2, p3, i / N));
  }
  return points;
}

function buildCornerGeo(defIdx: number, variant: number): MeshGeometry {
  const def = CORNER_DEFS[defIdx];
  const pts = getCornerCurvePoints(defIdx, variant);

  const positions: number[] = [def.cv[0], def.cv[1], 0];
  const normals: number[] = [0, 0, 1];
  const uvs: number[] = [def.cv[0], def.cv[1]];
  const indices: number[] = [];

  for (const [px, py] of pts) {
    positions.push(px, py, 0);
    normals.push(0, 0, 1);
    uvs.push(px, py);
  }

  for (let i = 0; i < pts.length - 1; i++) {
    indices.push(0, i + 1, i + 2);
  }

  return { positions, indices, normals, uvs };
}

// Precompute: CORNER_GEOS[cornerIndex][variant] — 16 variants per corner
const CORNER_GEOS: MeshGeometry[][] = CORNER_DEFS.map((_, i) => {
  const geos: MeshGeometry[] = [];
  for (let v = 0; v < 16; v++) geos.push(buildCornerGeo(i, v));
  return geos;
});

// Base mesh with corners cut out where elevation differs.
// Fan-triangulated from center (0.5, 0.5).
function buildCutoutBaseGeo(
  cutouts: { index: number; variant: number }[],
): MeshGeometry {
  const cutoutMap = new Map(cutouts.map((c) => [c.index, c.variant]));
  const cornerVerts: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  // Walk boundary CCW: BL → BR → TR → TL
  const boundary: [number, number][] = [];
  for (let ci = 0; ci < 4; ci++) {
    if (cutoutMap.has(ci)) {
      const pts = getCornerCurvePoints(ci, cutoutMap.get(ci)!);
      // Reverse: boundary CCW traverses from edge B (p3) to edge A (p0)
      for (let i = pts.length - 1; i >= 0; i--) {
        boundary.push(pts[i]);
      }
    } else {
      boundary.push(cornerVerts[ci]);
    }
  }

  const positions: number[] = [0.5, 0.5, 0];
  const normals: number[] = [0, 0, 1];
  const uvs: number[] = [0.5, 0.5];
  const indices: number[] = [];

  for (const [bx, by] of boundary) {
    positions.push(bx, by, 0);
    normals.push(0, 0, 1);
    uvs.push(bx, by);
  }

  const n = boundary.length;
  for (let i = 0; i < n; i++) {
    indices.push(0, i + 1, ((i + 1) % n) + 1);
  }

  return { positions, indices, normals, uvs };
}

// Edge cliff wall along a straight tile edge.
// Edges: 0=bottom, 1=right, 2=top, 3=left.
const EDGE_ENDPOINTS: [[number, number], [number, number]][] = [
  [
    [0, 0],
    [1, 0],
  ], // bottom
  [
    [1, 0],
    [1, 1],
  ], // right
  [
    [1, 1],
    [0, 1],
  ], // top
  [
    [0, 1],
    [0, 0],
  ], // left
];
const EDGE_NORMALS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

function buildEdgeCliffGeo(edgeIdx: number, height: number): MeshGeometry {
  const [[x0, y0], [x1, y1]] = EDGE_ENDPOINTS[edgeIdx];
  const [nx, ny] = EDGE_NORMALS[edgeIdx];
  return {
    positions: [x0, y0, 0, x1, y1, 0, x1, y1, height, x0, y0, height],
    normals: [nx, ny, 0, nx, ny, 0, nx, ny, 0, nx, ny, 0],
    indices: [0, 2, 1, 0, 3, 2],
  };
}

// Vertical quad strip along the bezier curve between two elevation levels.
// Geometry in local space: Z from 0 to height. Position at lowerZ.
function buildCliffGeo(
  defIdx: number,
  variant: number,
  height: number,
): MeshGeometry {
  const def = CORNER_DEFS[defIdx];
  const pts = getCornerCurvePoints(defIdx, variant);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];

    // Normal perpendicular to curve tangent, pointing away from corner vertex
    const tx = x1 - x0;
    const ty = y1 - y0;
    const mx = (x0 + x1) / 2 - def.cv[0];
    const my = (y0 + y1) / 2 - def.cv[1];
    let nx = -ty,
      ny = tx;
    if (nx * mx + ny * my < 0) {
      nx = ty;
      ny = -tx;
    }
    const len = Math.hypot(nx, ny);
    nx /= len;
    ny /= len;

    const base = positions.length / 3;
    positions.push(x0, y0, 0, x1, y1, 0, x1, y1, height, x0, y0, height);
    normals.push(nx, ny, 0, nx, ny, 0, nx, ny, 0, nx, ny, 0);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  return { positions, indices, normals };
}

export function terrainColor(type: TerrainType, theme: Theme): Color3 {
  switch (type) {
    case "Water":
      return theme.water;
    case "Water2":
      return theme.water2;
    case "Water3":
      return theme.water3;
    case "Beach":
      return theme.beach;
    case "Grass":
      return new Color3(theme.land.r, theme.land.g, theme.land.b);
    case "Forest":
      return theme.forest;
    case "Mountain":
      return theme.mountain;
  }
}

let borderTex: RawTexture | undefined;

const EDGE_DIRS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export function mountTerrain(
  entry: GameObjectEntry,
  pool: InstancePool,
  theme: Theme,
  getObjectsAt: (x: number, y: number) => GameObjectEntry[],
  scene: any,
): () => void {
  if (!borderTex) borderTex = createBorderTexture(scene);

  const d = entry.object.data as { terrain_type: TerrainType; corners: (TerrainType | null)[]; corner_mask: number };
  const p = entry.position!;
  const tt = d.terrain_type;
  const be = ELEVATION[tt];

  const instances: { key: string; id: number }[] = [];

  function add(key: string, geo: MeshGeometry, pos: [number, number, number], color: Color3, opts?: { cast?: boolean; recv?: boolean; tex?: any; scale?: [number, number, number] }) {
    pool.ensureBucket(key, geo, color, opts?.cast ?? false, opts?.recv ?? false, opts?.tex);
    instances.push({ key, id: pool.addInstance(key, pos, undefined, opts?.scale) });
  }

  // Corners
  const corners = d.corners
    .map((c, i) => {
      if (!c) return null;
      let variant = (d.corner_mask >> (i * 2)) & 3;
      if (!(variant & 1) && !d.corners[(i + 1) % 4]) variant |= 4;
      if (!(variant & 2) && !d.corners[(i + 3) % 4]) variant |= 8;
      const cornerElev = ELEVATION[c];
      return { index: i, type: c, variant, sameElev: cornerElev === be, cornerElev };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const diff = corners.filter((c) => !c.sameElev);

  // Base
  const baseGeo = diff.length === 0 ? FULL_SQUARE : buildCutoutBaseGeo(diff);
  const baseKey = diff.length === 0
    ? `terrain_${tt}`
    : `terrain_${tt}_c${diff.map((c) => `${c.index}v${c.variant}`).join("_")}`;
  add(baseKey, baseGeo, [p.x, p.y, be], terrainColor(tt, theme), { recv: true, tex: be === 0 ? borderTex : undefined });

  // Same-elevation corners
  for (const c of corners.filter((c) => c.sameElev)) {
    const buildable = ELEVATION[c.type] === 0;
    add(
      `corner_${c.index}_${c.type}_${c.variant}${buildable ? "_b" : ""}`,
      CORNER_GEOS[c.index][c.variant],
      [p.x, p.y, be + 0.01],
      terrainColor(c.type, theme),
      { recv: true, tex: buildable ? borderTex : undefined },
    );
  }

  // Diff-elevation corners (overlay + cliff)
  for (const c of diff) {
    const upperZ = Math.max(be, c.cornerElev);
    const lowerZ = Math.min(be, c.cornerElev);
    const height = upperZ - lowerZ;
    const higherType = c.cornerElev > be ? c.type : tt;

    add(
      `corner_${c.index}_${c.type}_${c.variant}${c.cornerElev === 0 ? "_b" : ""}`,
      CORNER_GEOS[c.index][c.variant],
      [p.x, p.y, c.cornerElev],
      terrainColor(c.type, theme),
      { recv: true, tex: c.cornerElev === 0 ? borderTex : undefined },
    );
    add(
      `cliff_${c.index}_${c.variant}_${height}_${higherType}`,
      buildCliffGeo(c.index, c.variant, height),
      [p.x, p.y, lowerZ],
      terrainColor(higherType, theme).scale(0.7),
      { cast: true },
    );
  }

  // Edge cliffs
  const diffSet = new Set(diff.map((c) => c.index));
  for (let i = 0; i < 4; i++) {
    if (diffSet.has(i) || diffSet.has((i + 1) % 4)) continue;
    const [dx, dy] = EDGE_DIRS[i];
    const neighbors = getObjectsAt(p.x + dx, p.y + dy);
    const terrain = neighbors.find((n) => n.object.kind === "Terrain");
    if (!terrain) continue;
    const neighborElev = ELEVATION[(terrain.object.data as { terrain_type: TerrainType }).terrain_type];
    if (neighborElev >= be) continue;
    const height = be - neighborElev;
    add(
      `edge_cliff_${i}_${height}_${tt}`,
      buildEdgeCliffGeo(i, height),
      [p.x, p.y, be - height],
      terrainColor(tt, theme).scale(0.7),
      { cast: true },
    );
  }

  // Trees
  if (tt === "Forest") {
    const hasRoad = getObjectsAt(p.x, p.y).some((o) => o.object.kind === "RoadNode");
    if (!hasRoad) {
      const treeColor = terrainColor("Forest", theme);
      pool.ensureBucket("tree_trunk", TREE_TRUNK, treeColor, true, true);
      for (const tree of treesForTile(p.x, p.y)) {
        const s = tree.scale;
        instances.push({
          key: "tree_trunk",
          id: pool.addInstance("tree_trunk", [p.x + tree.x, p.y + tree.y, 0], undefined, [s * 0.35, s * 0.35, s]),
        });
      }
    }
  }

  return () => {
    for (const { key, id } of instances) pool.removeInstance(key, id);
  };
}
