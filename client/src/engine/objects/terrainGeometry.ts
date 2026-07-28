import { Color3, RawTexture } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import type { Theme } from "../theme";
import type { TerrainType } from "../../generated";
import type { MeshGeometry } from "../Mesh";

const ELEVATION: Record<TerrainType, number> = {
  Water: -0.5,
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

export const TREE_TRUNK = buildCylinderGeo(1, 1);
interface TreeInfo {
  x: number;
  y: number;
  scale: number;
}

const CELLS: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
const CELL_W = 0.5;

function treesForTile(tx: number, ty: number): TreeInfo[] {
  let s = seed(tx, ty);
  const trees: TreeInfo[] = [];
  for (const [cx, cy] of CELLS) {
    let v: number, x: number, y: number;
    do {
      [s, v] = nextRand(s);
      x = cx * CELL_W + v * CELL_W;
      [s, v] = nextRand(s);
      y = cy * CELL_W + v * CELL_W;
    } while ((x - 0.5) ** 2 + (y - 0.5) ** 2 > 0.25);
    [s, v] = nextRand(s);
    const scale = 0.5 + v * 0.5;
    trees.push({ x, y, scale });
  }
  return trees;
}

const TEX_SIZE = 32;
const BORDER = 1;

export function createBorderTexture(scene: Scene): RawTexture {
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

const EDGE_DIRS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

// --- Chunk buffers -------------------------------------------------------

export interface TerrainBuffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}

export function emptyBuffers(): TerrainBuffers {
  return { positions: [], normals: [], uvs: [], colors: [], indices: [] };
}

// --- Corner derivation ---------------------------------------------------
//
// A tile's corner overlays are a pure function of the terrain types around it,
// so the server only sends types. `corners[i]` needs the 3x3 neighbourhood;
// `cornerMask` needs the neighbours' corners, so it reaches two tiles out.

export type TypeAt = (x: number, y: number) => TerrainType | undefined;

/** Which terrain type wins when two differing neighbours meet at a corner. */
const CORNER_PRIORITY: Record<TerrainType, number> = {
  Beach: 4,
  Grass: 3,
  Forest: 2,
  Mountain: 1,
  Water: 0,
};

/** For each corner [BL, BR, TR, TL], the two cardinal neighbours to check. */
const CORNER_NEIGHBORS: [[number, number], [number, number]][] = [
  [[-1, 0], [0, -1]], // BL: left + below
  [[1, 0], [0, -1]],  // BR: right + below
  [[1, 0], [0, 1]],   // TR: right + above
  [[-1, 0], [0, 1]],  // TL: left + above
];

// For each corner i, edge connectivity: (dx, dy, their corner index) for edge
// A and edge B. Same-slope pairs: BL <-> TR, BR <-> TL.
const EDGE_CHECKS: [[number, number, number], [number, number, number]][] = [
  [[0, -1, 2], [-1, 0, 2]], // BL
  [[1, 0, 3], [0, -1, 3]],  // BR
  [[0, 1, 0], [1, 0, 0]],   // TR
  [[-1, 0, 1], [0, 1, 1]],  // TL
];

/** Corner overlays for one tile, or nulls where the corner is square. */
function cornersAt(x: number, y: number, typeAt: TypeAt): (TerrainType | null)[] {
  const mine = typeAt(x, y);
  if (mine === undefined) return [null, null, null, null];

  return CORNER_NEIGHBORS.map(([d1, d2]) => {
    const t1 = typeAt(x + d1[0], y + d1[1]);
    const t2 = typeAt(x + d2[0], y + d2[1]);
    if (t1 === undefined || t2 === undefined) return null;
    if (t1 === mine || t2 === mine || ELEVATION[t1] !== ELEVATION[t2]) return null;
    if (t1 === t2) return t1;

    // Types differ: only round the corner if the diagonal agrees with one.
    const diag = typeAt(x + d1[0] + d2[0], y + d1[1] + d2[1]);
    if (diag !== t1 && diag !== t2) return null;
    return CORNER_PRIORITY[t1] >= CORNER_PRIORITY[t2] ? t1 : t2;
  });
}

/** 2 bits per corner: whether the curve continues into the neighbour on each edge. */
function cornerMask(
  x: number,
  y: number,
  corners: (TerrainType | null)[],
  sampler: TerrainSampler,
): number {
  let mask = 0;
  for (let i = 0; i < 4; i++) {
    if (!corners[i]) continue;
    const [a, b] = EDGE_CHECKS[i];
    if (sampler.cornersOf(x + a[0], y + a[1])[a[2]]) mask |= 1 << (i * 2);
    if (sampler.cornersOf(x + b[0], y + b[1])[b[2]]) mask |= 1 << (i * 2 + 1);
  }
  return mask;
}

export interface TerrainSampler {
  typeAt: TypeAt;
  cornersOf(x: number, y: number): (TerrainType | null)[];
}

/**
 * Every tile reads its own corners and, for the mask, its neighbours' — so
 * each tile's corners are wanted several times over. Memoise them for the
 * duration of one chunk rebuild.
 */
export function createSampler(typeAt: TypeAt): TerrainSampler {
  const cache = new Map<string, (TerrainType | null)[]>();
  return {
    typeAt,
    cornersOf(x, y) {
      const key = `${x},${y}`;
      let corners = cache.get(key);
      if (corners === undefined) {
        corners = cornersAt(x, y, typeAt);
        cache.set(key, corners);
      }
      return corners;
    },
  };
}

/** Cutout base geometries are shared across every tile with the same corner set. */
const baseGeoCache = new Map<string, MeshGeometry>();

/**
 * Copy a unit-space geometry into a chunk buffer, translated to (ox, oy, oz).
 * Colour goes into the vertex buffer so a whole chunk shares one material.
 * Unbordered geometry samples the texture interior, which is flat white.
 */
function append(
  buf: TerrainBuffers,
  geo: MeshGeometry,
  ox: number,
  oy: number,
  oz: number,
  color: Color3,
  bordered: boolean,
): void {
  const base = buf.positions.length / 3;
  const p = geo.positions;
  for (let i = 0; i < p.length; i += 3) {
    buf.positions.push(p[i] + ox, p[i + 1] + oy, p[i + 2] + oz);
  }
  for (let i = 0; i < geo.normals.length; i++) buf.normals.push(geo.normals[i]);

  const vertexCount = p.length / 3;
  for (let i = 0; i < vertexCount; i++) {
    buf.colors.push(color.r, color.g, color.b, 1);
  }
  if (bordered && geo.uvs) {
    for (let i = 0; i < geo.uvs.length; i++) buf.uvs.push(geo.uvs[i]);
  } else {
    for (let i = 0; i < vertexCount; i++) buf.uvs.push(0.5, 0.5);
  }
  for (let i = 0; i < geo.indices.length; i++) {
    buf.indices.push(base + geo.indices[i]);
  }
}

export interface ChunkSink {
  ground: TerrainBuffers;
  cliffs: TerrainBuffers;
  /** Flat 4x4 column-major matrices, 16 floats per tree. */
  trees: number[];
}

/**
 * Append one tile's geometry into a chunk. Coordinates are emitted relative to
 * (originX, originY) so the chunk mesh can sit at its own origin.
 */
export function appendTile(
  sink: ChunkSink,
  x: number,
  y: number,
  originX: number,
  originY: number,
  tt: TerrainType,
  theme: Theme,
  sampler: TerrainSampler,
  hasRoad: (x: number, y: number) => boolean,
): void {
  const lx = x - originX;
  const ly = y - originY;
  const be = ELEVATION[tt];

  const tileCorners = sampler.cornersOf(x, y);
  const mask = cornerMask(x, y, tileCorners, sampler);

  const corners = tileCorners
    .map((c, i) => {
      if (!c) return null;
      let variant = (mask >> (i * 2)) & 3;
      if (!(variant & 1) && !tileCorners[(i + 1) % 4]) variant |= 4;
      if (!(variant & 2) && !tileCorners[(i + 3) % 4]) variant |= 8;
      const cornerElev = ELEVATION[c];
      return { index: i, type: c, variant, sameElev: cornerElev === be, cornerElev };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const diff = corners.filter((c) => !c.sameElev);

  // Base
  let baseGeo: MeshGeometry;
  if (diff.length === 0) {
    baseGeo = FULL_SQUARE;
  } else {
    const key = diff.map((c) => `${c.index}v${c.variant}`).join("_");
    let cached = baseGeoCache.get(key);
    if (!cached) {
      cached = buildCutoutBaseGeo(diff);
      baseGeoCache.set(key, cached);
    }
    baseGeo = cached;
  }
  append(sink.ground, baseGeo, lx, ly, be, terrainColor(tt, theme), be === 0);

  // Same-elevation corner overlays
  for (const c of corners) {
    if (!c.sameElev) continue;
    append(
      sink.ground,
      CORNER_GEOS[c.index][c.variant],
      lx,
      ly,
      be + 0.01,
      terrainColor(c.type, theme),
      ELEVATION[c.type] === 0,
    );
  }

  // Differing-elevation corners: overlay at its own height plus a cliff wall
  for (const c of diff) {
    const upperZ = Math.max(be, c.cornerElev);
    const lowerZ = Math.min(be, c.cornerElev);
    const higherType = c.cornerElev > be ? c.type : tt;

    append(
      sink.ground,
      CORNER_GEOS[c.index][c.variant],
      lx,
      ly,
      c.cornerElev,
      terrainColor(c.type, theme),
      c.cornerElev === 0,
    );
    append(
      sink.cliffs,
      buildCliffGeo(c.index, c.variant, upperZ - lowerZ),
      lx,
      ly,
      lowerZ,
      terrainColor(higherType, theme).scale(0.7),
      false,
    );
  }

  // Cardinal edge cliffs, where no corner already covers that edge
  const diffSet = new Set(diff.map((c) => c.index));
  for (let i = 0; i < 4; i++) {
    if (diffSet.has(i) || diffSet.has((i + 1) % 4)) continue;
    const [dx, dy] = EDGE_DIRS[i];
    const neighbor = sampler.typeAt(x + dx, y + dy);
    if (neighbor === undefined) continue;
    const neighborElev = ELEVATION[neighbor];
    if (neighborElev >= be) continue;
    append(
      sink.cliffs,
      buildEdgeCliffGeo(i, be - neighborElev),
      lx,
      ly,
      neighborElev,
      terrainColor(tt, theme).scale(0.7),
      false,
    );
  }

  // Trees
  if (tt === "Forest" && !hasRoad(x, y)) {
    for (const tree of treesForTile(x, y)) {
      const s = tree.scale;
      // Column-major 4x4: scale on the diagonal, translation in the last row.
      sink.trees.push(
        s * 0.35, 0, 0, 0,
        0, s * 0.35, 0, 0,
        0, 0, s, 0,
        lx + tree.x, ly + tree.y, 0, 1,
      );
    }
  }
}
