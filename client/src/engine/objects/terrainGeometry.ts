import type { TerrainType } from "../../generated";
import type { MeshGeometry } from "../Mesh";
import { fillTriangles } from "../raster";

// This module has no runtime imports, and must keep it that way: it is the
// unit of work handed to the terrain worker, where Babylon and the DOM do not
// exist. Colours arrive as plain floats, tiles as bytes.

/** Must match the server's CHUNK_SIZE / CHUNK_SKIRT. */
export const CHUNK_SIZE = 32;
export const CHUNK_SKIRT = 2;
export const CHUNK_STRIDE = CHUNK_SIZE + CHUNK_SKIRT * 2;

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export type TerrainPalette = Record<TerrainType, RGB>;

/** One mesh's vertex data. All transferable. */
export interface MeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Absent on geometry the camera never sees. */
  colors?: Float32Array;
}

export interface ChunkGeometry {
  ground: MeshBuffers;
  /** The sea's and lakes' surface, apart, to be drawn as water. */
  water: MeshBuffers;
  /** How far each point of the chunk lies from land, if it has water: a
   *  byte each, 0 at the shore to 255 at SHORE_REACH or more, SHORE_DENSITY
   *  to a tile, rows up from its low corner. */
  shore: Uint8Array | null;
  /** Which way and how far the ground's facing turns as it rounds over its
   *  edge onto lower ground (`bevelField`): two bytes each, about 128, at
   *  SHORE_DENSITY to a tile, rows up from the chunk's low corner. Null
   *  where no edge comes near. */
  bevel: Uint8Array | null;
  cliffs: MeshBuffers;
}

/** The shore field's texels to a tile, and how far from land it reaches. */
export const SHORE_DENSITY = 12;
export const SHORE_REACH = 2;

/** Every ArrayBuffer in a result, for postMessage's transfer list. */
export function transferables(g: ChunkGeometry): ArrayBuffer[] {
  const arrays: (ArrayBufferView | undefined)[] = [g.ground, g.water, g.cliffs].flatMap((m) => [m.positions, m.normals, m.indices, m.colors]);
  return [...arrays, g.shore ?? undefined, g.bevel ?? undefined].filter((a) => a !== undefined).map((a) => a.buffer as ArrayBuffer);
}

/** How shiny each ground is, of the ground's most (`ShinePlugin`): sand
 *  and rock keep a little, as the rest of the toy; grass is matte, its
 *  grain (`ground.ts`) its texture. Water is drawn as water (`water.ts`)
 *  and gleams as it does there. */
const SHINE: Record<TerrainType, number> = {
  Sea: 1,
  Water: 1,
  Beach: 0.12,
  Grass: 0,
  Forest: 0,
  Mountain: 0.15,
};

/** Which ground lies on which, for the bevel each rounds over its edge
 *  with (`bevelField`): rock on grass and wood, they on sand, sand on the
 *  water, which is drawn apart and lies under all. */
const LAYER: Record<TerrainType, number> = {
  Sea: 0,
  Water: 0,
  Beach: 1,
  Grass: 2,
  Forest: 2,
  Mountain: 3,
};

const ELEVATION: Record<TerrainType, number> = {
  Sea: -0.5,
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

/** The tallest crown's top, in tiles at full size; the shortest is 45% of it.
 *  A tree is drawn in `trees.ts`. */
const CROWN_HEIGHT = 0.45;
/** A crown's radius in tiles at full size; smaller trees are down to half. */
const TREE_RADIUS = 0.35;
interface TreeInfo {
  x: number;
  y: number;
  scale: number;
  /** Which way its lobes face, in radians. */
  turn: number;
  /** Which crown colour, 0 to 1: see CROWN_SHARES. */
  shade: number;
  /** How tall, 0 to 1, from the shortest crown to the tallest. */
  tall: number;
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
    [s, v] = nextRand(s);
    const turn = v * Math.PI * 2;
    [s, v] = nextRand(s);
    const shade = v;
    [s, v] = nextRand(s);
    trees.push({ x, y, scale, turn, shade, tall: v });
  }
  return trees;
}

const FULL_SQUARE: MeshGeometry = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  indices: [0, 2, 1, 0, 3, 2],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
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
  const indices: number[] = [];

  for (const [px, py] of pts) {
    positions.push(px, py, 0);
    normals.push(0, 0, 1);
  }

  for (let i = 0; i < pts.length - 1; i++) {
    indices.push(0, i + 2, i + 1);
  }

  return { positions, indices, normals };
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
  const indices: number[] = [];

  for (const [bx, by] of boundary) {
    positions.push(bx, by, 0);
    normals.push(0, 0, 1);
  }

  const n = boundary.length;
  for (let i = 0; i < n; i++) {
    indices.push(0, ((i + 1) % n) + 1, i + 1);
  }

  return { positions, indices, normals };
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
// Cliff walls are unlit and edge-on to the camera, so their normals only
// steer the shadow pass's normal bias, which slides every
// caster along its normal. Walls on the same ridge used to face opposite ways
// depending on which tile drew them, and the bias pushed neighbours apart:
// one ridge, cast as panels in and out of line. Up, for all of them.
const UP4 = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];

function buildEdgeCliffGeo(edgeIdx: number, height: number): MeshGeometry {
  const [[x0, y0], [x1, y1]] = EDGE_ENDPOINTS[edgeIdx];
  return {
    positions: [x0, y0, 0, x1, y1, 0, x1, y1, height, x0, y0, height],
    normals: UP4,
    indices: [0, 1, 2, 0, 2, 3],
  };
}

// Vertical quad strip along the bezier curve between two elevation levels.
// Geometry in local space: Z from 0 to height. Position at lowerZ.
function buildCliffGeo(
  defIdx: number,
  variant: number,
  height: number,
): MeshGeometry {
  const pts = getCornerCurvePoints(defIdx, variant);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const base = positions.length / 3;
    positions.push(x0, y0, 0, x1, y1, 0, x1, y1, height, x0, y0, height);
    normals.push(...UP4);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  return { positions, indices, normals };
}

/**
 * Cliff walls are the terrain colour darkened. Reused scratch: `append` reads
 * the floats out immediately and never retains the object.
 */
const SHADED: RGB = { r: 0, g: 0, b: 0 };
function shade(c: RGB, f: number): RGB {
  SHADED.r = c.r * f;
  SHADED.g = c.g * f;
  SHADED.b = c.b * f;
  return SHADED;
}

const EDGE_DIRS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

// --- Chunk buffers -------------------------------------------------------

/**
 * Vertex data written straight into typed arrays. The arrays are scratch,
 * reused across rebuilds and grown by doubling, so a steady-state rebuild
 * allocates nothing until the caller copies out the exact-sized slice Babylon
 * keeps. Writing `number[]` here instead would cost a boxed push per float
 * and a second full pass inside Babylon to convert.
 */
export class TerrainBuffers {
  positions = new Float32Array(0);
  normals = new Float32Array(0);
  indices = new Uint32Array(0);
  /** Absent on geometry the camera never sees. */
  colors: Float32Array<ArrayBuffer> | null;
  /** Each vertex's ground's LAYER; the worker's alone, never uploaded. */
  layers = new Uint8Array(0);

  vertices = 0;
  indexCount = 0;

  constructor(shaded: boolean) {
    this.colors = shaded ? new Float32Array(0) : null;
  }

  reset(): void {
    this.vertices = 0;
    this.indexCount = 0;
  }

  /** Exact-sized copies. Copies, not views — the scratch is reused. */
  take(): MeshBuffers {
    const v = this.vertices;
    return {
      positions: this.positions.slice(0, v * 3),
      normals: this.normals.slice(0, v * 3),
      indices: this.indices.slice(0, this.indexCount),
      colors: this.colors?.slice(0, v * 4),
    };
  }

  /** Grow to fit `verts` more vertices and `indices` more indices. */
  reserve(verts: number, indices: number): void {
    if (this.vertices + verts > this.positions.length / 3) {
      const n = Math.max(1024, (this.vertices + verts) * 2);
      this.positions = grow(this.positions, n * 3);
      this.normals = grow(this.normals, n * 3);
      if (this.colors) this.colors = grow(this.colors, n * 4);
      const layers = new Uint8Array(n);
      layers.set(this.layers);
      this.layers = layers;
    }
    if (this.indexCount + indices > this.indices.length) {
      const next = new Uint32Array(Math.max(2048, (this.indexCount + indices) * 2));
      next.set(this.indices);
      this.indices = next;
    }
  }
}

function grow(src: Float32Array, length: number): Float32Array<ArrayBuffer> {
  const next = new Float32Array(length);
  next.set(src);
  return next;
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
  Sea: 0,
};

/** Does `a` take a corner from `b`? Every pair has one answer, ties
 *  settled by name, so two kinds never both claim a corner. */
const wins = (a: TerrainType, b: TerrainType) =>
  CORNER_PRIORITY[a] > CORNER_PRIORITY[b] || (CORNER_PRIORITY[a] === CORNER_PRIORITY[b] && a > b);

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
    const diag = typeAt(x + d1[0] + d2[0], y + d1[1] + d2[1]);
    // A saddle, my own kind across the diagonal: only one kind can run
    // through the corner. Both rounding it laid their curves over each
    // other's and crossed their cliffs; the kind that wins a corner runs
    // through, and the other keeps its corners square.
    if (t1 === t2) return diag === mine && !wins(t1, mine) ? null : t1;

    // Types differ: only round the corner if the diagonal agrees with one.
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

/** Wire encoding, in the server's TerrainType::to_byte order. */
export const TYPE_BY_BYTE: TerrainType[] = ["Water", "Beach", "Grass", "Forest", "Mountain", "Sea"];

const NO_CORNERS: (TerrainType | null)[] = [null, null, null, null];

/**
 * Every tile reads its own corners and, for the mask, its neighbours' — so
 * each tile's corners are wanted several times over. Memoise them for the
 * duration of one chunk rebuild, indexed by the same flat grid the tiles
 * arrive in. Tiles outside the grid have no corners and need no slot.
 */
export function createSampler(
  tiles: Uint8Array,
  stride: number,
  originX: number,
  originY: number,
): TerrainSampler {
  const cache = new Array<(TerrainType | null)[] | undefined>(stride * stride);

  const typeAt: TypeAt = (x, y) => {
    const ix = x - originX;
    const iy = y - originY;
    if (ix < 0 || iy < 0 || ix >= stride || iy >= stride) return undefined;
    return TYPE_BY_BYTE[tiles[iy * stride + ix]];
  };

  return {
    typeAt,
    cornersOf(x, y) {
      const ix = x - originX;
      const iy = y - originY;
      if (ix < 0 || iy < 0 || ix >= stride || iy >= stride) return NO_CORNERS;
      const i = iy * stride + ix;
      let corners = cache[i];
      if (corners === undefined) {
        corners = cornersAt(x, y, typeAt);
        cache[i] = corners;
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
 */
function append(
  buf: TerrainBuffers,
  geo: MeshGeometry,
  ox: number,
  oy: number,
  oz: number,
  color: RGB,
  shine = 1,
  layer = 0,
): void {
  const p = geo.positions;
  const vertexCount = p.length / 3;
  buf.reserve(vertexCount, geo.indices.length);

  const base = buf.vertices;
  const positions = buf.positions;
  const normals = buf.normals;
  let v3 = base * 3;
  for (let i = 0; i < p.length; i += 3, v3 += 3) {
    positions[v3] = p[i] + ox;
    positions[v3 + 1] = p[i + 1] + oy;
    positions[v3 + 2] = p[i + 2] + oz;
    normals[v3] = geo.normals[i];
    normals[v3 + 1] = geo.normals[i + 1];
    normals[v3 + 2] = geo.normals[i + 2];
  }

  if (buf.colors) {
    const colors = buf.colors;
    for (let i = 0, c = base * 4; i < vertexCount; i++, c += 4) {
      colors[c] = color.r;
      colors[c + 1] = color.g;
      colors[c + 2] = color.b;
      colors[c + 3] = shine;
    }
  }
  buf.layers.fill(layer, base, base + vertexCount);
  const indices = buf.indices;
  for (let i = 0, n = buf.indexCount; i < geo.indices.length; i++, n++) {
    indices[n] = base + geo.indices[i];
  }

  buf.vertices += vertexCount;
  buf.indexCount += geo.indices.length;
}

class ChunkSink {
  ground = new TerrainBuffers(true);
  water = new TerrainBuffers(true);
  /**
   * Cliffs only ever cast shadows. The camera looks straight down, so cliff
   * walls are edge-on and never rasterised — only the shadow pass reads them,
   * and that reads depth alone.
   */
  cliffs = new TerrainBuffers(false);

  reset(): void {
    this.ground.reset();
    this.water.reset();
    this.cliffs.reset();
  }
}

/** Where a piece of ground of this type goes: the water's surface apart. */
const sheet = (sink: ChunkSink, type: TerrainType) => (type === "Sea" || type === "Water" ? sink.water : sink.ground);

/**
 * Append one tile's geometry into a chunk. Coordinates are emitted relative to
 * (originX, originY) so the chunk mesh can sit at its own origin.
 */
function appendTile(
  sink: ChunkSink,
  x: number,
  y: number,
  originX: number,
  originY: number,
  tt: TerrainType,
  palette: TerrainPalette,
  sampler: TerrainSampler,
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
  append(sheet(sink, tt), baseGeo, lx, ly, be, palette[tt], SHINE[tt], LAYER[tt]);

  // Same-elevation corner overlays
  for (const c of corners) {
    if (!c.sameElev) continue;
    append(
      sheet(sink, c.type),
      CORNER_GEOS[c.index][c.variant],
      lx,
      ly,
      be + 0.01,
      palette[c.type],
      SHINE[c.type],
      LAYER[c.type],
    );
  }

  // Differing-elevation corners: overlay at its own height plus a cliff wall
  for (const c of diff) {
    const upperZ = Math.max(be, c.cornerElev);
    const lowerZ = Math.min(be, c.cornerElev);
    const higherType = c.cornerElev > be ? c.type : tt;

    append(
      sheet(sink, c.type),
      CORNER_GEOS[c.index][c.variant],
      lx,
      ly,
      c.cornerElev,
      palette[c.type],
      SHINE[c.type],
      LAYER[c.type],
    );
    append(
      sink.cliffs,
      buildCliffGeo(c.index, c.variant, upperZ - lowerZ),
      lx,
      ly,
      lowerZ,
      shade(palette[higherType], 0.7),
    );
  }

  // Cardinal edge cliffs, where no corner already covers that edge — on
  // either side of it. A neighbour that rounds a corner onto this edge has
  // drawn the shore itself; a straight wall here would stand buried under
  // that corner, and still cast its shadow past the real one.
  const diffSet = new Set(diff.map((c) => c.index));
  for (let i = 0; i < 4; i++) {
    if (diffSet.has(i) || diffSet.has((i + 1) % 4)) continue;
    const [dx, dy] = EDGE_DIRS[i];
    const neighbor = sampler.typeAt(x + dx, y + dy);
    if (neighbor === undefined) continue;
    const neighborElev = ELEVATION[neighbor];
    if (neighborElev >= be) continue;
    const across = sampler.cornersOf(x + dx, y + dy);
    if (across[(i + 2) % 4] || across[(i + 3) % 4]) continue;
    append(
      sink.cliffs,
      buildEdgeCliffGeo(i, be - neighborElev),
      lx,
      ly,
      neighborElev,
      shade(palette[tt], 0.7),
    );
  }

}

/**
 * How far each point of a chunk lies from land, as `ChunkGeometry.shore`
 * holds it. Land is the chunk's own ground, as drawn, and round it every
 * tile within reach that is not water, whole; the distance spreads out
 * from it in two sweeps across the grid, each cell taking its neighbours'
 * plus the step to them.
 */
function shoreField(land: TerrainBuffers, sampler: TerrainSampler, originX: number, originY: number): Uint8Array {
  const [d, reach] = [SHORE_DENSITY, SHORE_REACH];
  const side = (CHUNK_SIZE + 2 * reach) * d;
  const isLand = fillTriangles(land.positions, land.indices.subarray(0, land.indexCount), -reach, -reach, d, side, side, new Uint8Array(side * side));
  for (let ty = -reach; ty < CHUNK_SIZE + reach; ty++) {
    for (let tx = -reach; tx < CHUNK_SIZE + reach; tx++) {
      if (tx >= 0 && ty >= 0 && tx < CHUNK_SIZE && ty < CHUNK_SIZE) continue;
      const t = sampler.typeAt(originX + tx, originY + ty);
      if (!t || t === "Sea" || t === "Water") continue;
      for (let j = 0; j < d; j++) isLand.fill(1, ((ty + reach) * d + j) * side + (tx + reach) * d, ((ty + reach) * d + j) * side + (tx + reach + 1) * d);
    }
  }
  const far = new Float32Array(side * side);
  for (let k = 0; k < far.length; k++) far[k] = isLand[k] ? 0 : Infinity;
  const step = (k: number, i: number, j: number, di: number, dj: number, cost: number) => {
    const [ni, nj] = [i + di, j + dj];
    if (ni >= 0 && nj >= 0 && ni < side && nj < side) far[k] = Math.min(far[k], far[nj * side + ni] + cost);
  };
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const k = j * side + i;
      step(k, i, j, -1, 0, 1), step(k, i, j, 0, -1, 1), step(k, i, j, -1, -1, Math.SQRT2), step(k, i, j, 1, -1, Math.SQRT2);
    }
  }
  for (let j = side - 1; j >= 0; j--) {
    for (let i = side - 1; i >= 0; i--) {
      const k = j * side + i;
      step(k, i, j, 1, 0, 1), step(k, i, j, 0, 1, 1), step(k, i, j, 1, 1, Math.SQRT2), step(k, i, j, -1, 1, Math.SQRT2);
    }
  }
  const inner = CHUNK_SIZE * d;
  const out = new Uint8Array(inner * inner);
  for (let j = 0; j < inner; j++) {
    for (let i = 0; i < inner; i++) out[j * inner + i] = Math.min(255, Math.round((far[(j + reach * d) * side + i + reach * d] / (reach * d)) * 255));
  }
  return out;
}

/** How far in from its edge ground rounds over it, in tiles. */
const BEVEL = 0.15;
/** The bevel's cells to each of its texels, each way: the finer the grid
 *  the ground is filled into, the less its edges step. */
const FINE = 2;

/**
 * The ground's bevel, as `ChunkGeometry.bevel` holds it. The chunk's ground
 * and a ring of tiles round it are filled into a grid in the order they are
 * drawn, so each cell holds the LAYER of the ground seen there; each texel
 * then finds the nearest cell lying lower, within BEVEL, and turns to face
 * it, the more the nearer. Whatever is drawn is bevelled where it is drawn:
 * cutouts, corners and saddles need no rules of their own.
 */
function bevelField(chunk: TerrainBuffers, ring: TerrainBuffers): Uint8Array | null {
  const d = SHORE_DENSITY;
  const fd = d * FINE;
  // Laid half a cell over, so every texel's middle is a cell's middle:
  // texel k is cell fd + FINE * k + FINE / 2.
  const side = (CHUNK_SIZE + 2) * fd;
  const seen = new Uint8Array(side * side);
  for (const buf of [ring, chunk]) {
    const indices = buf.indices.subarray(0, buf.indexCount);
    // Runs of one layer at a time, in order: later ground lies on earlier.
    for (let t = 0; t < indices.length; ) {
      const layer = buf.layers[indices[t]];
      let end = t + 3;
      while (end < indices.length && buf.layers[indices[end]] === layer) end += 3;
      fillTriangles(buf.positions, indices.subarray(t, end), -1 - 0.5 / fd, -1 - 0.5 / fd, fd, side, side, seen, layer);
      t = end;
    }
  }
  // In cells, to the line between two cells, not to the lower one's middle.
  const reach = BEVEL * fd;
  const r = Math.ceil(reach + 0.5);
  const inner = CHUNK_SIZE * d;
  const cell = (k: number) => fd + FINE * k + FINE / 2;
  const near = new Float32Array(inner * inner).fill(reach);
  const out = new Float32Array(inner * inner * 2);
  let any = false;
  // From each cell with higher ground beside it, out to every higher texel
  // within reach: the nearest lower cell to any cell has such a neighbour.
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const low = seen[j * side + i];
      let edge = false;
      for (let dj = -1; dj <= 1 && !edge; dj++) {
        for (let di = -1; di <= 1 && !edge; di++) {
          const [ni, nj] = [i + di, j + dj];
          edge = ni >= 0 && nj >= 0 && ni < side && nj < side && seen[nj * side + ni] > low;
        }
      }
      if (!edge) continue;
      const k0 = (c: number) => Math.max(0, Math.ceil((c - r - fd - FINE / 2) / FINE));
      const k1 = (c: number) => Math.min(inner - 1, Math.floor((c + r - fd - FINE / 2) / FINE));
      for (let kj = k0(j); kj <= k1(j); kj++) {
        for (let ki = k0(i); ki <= k1(i); ki++) {
          const [qi, qj] = [cell(ki), cell(kj)];
          if (seen[qj * side + qi] <= low) continue;
          const [ox, oy] = [i - qi, j - qj];
          const length = Math.hypot(ox, oy);
          const far = length - 0.5;
          const k = kj * inner + ki;
          if (far >= near[k]) continue;
          near[k] = far;
          out[k * 2] = ox / length;
          out[k * 2 + 1] = oy / length;
          any = true;
        }
      }
    }
  }
  if (!any) return null;
  const bytes = new Uint8Array(inner * inner * 2);
  for (let k = 0; k < inner * inner; k++) {
    const turn = 1 - near[k] / reach;
    bytes[k * 2] = Math.round(127.5 + 127.5 * out[k * 2] * turn);
    bytes[k * 2 + 1] = Math.round(127.5 + 127.5 * out[k * 2 + 1] * turn);
  }
  return bytes;
}

/** Scratch, reused across builds — see TerrainBuffers. */
const SINK = new ChunkSink();
/** The tiles round a chunk, drawn only to be bevelled against. */
const RING = new ChunkSink();

/**
 * Ground and cliff geometry for one chunk. A pure function of the tiles and
 * the palette: no scene, no game state, no DOM. This is what the worker runs.
 *
 * `tiles` carries CHUNK_SKIRT tiles of margin on every side, so a chunk meshes
 * without consulting its neighbours and the shared skirt keeps seams consistent.
 * Returns null when the chunk holds no tiles at all.
 */
export function buildChunk(
  tiles: Uint8Array,
  chunkX: number,
  chunkY: number,
  palette: TerrainPalette,
): ChunkGeometry | null {
  SINK.reset();
  const originX = chunkX * CHUNK_SIZE;
  const originY = chunkY * CHUNK_SIZE;
  const sampler = createSampler(
    tiles,
    CHUNK_STRIDE,
    originX - CHUNK_SKIRT,
    originY - CHUNK_SKIRT,
  );

  let tileCount = 0;
  for (let y = originY; y < originY + CHUNK_SIZE; y++) {
    for (let x = originX; x < originX + CHUNK_SIZE; x++) {
      const type = sampler.typeAt(x, y);
      if (!type) continue;
      tileCount++;
      appendTile(SINK, x, y, originX, originY, type, palette, sampler);
    }
  }
  if (tileCount === 0) return null;

  RING.reset();
  for (let y = originY - 1; y <= originY + CHUNK_SIZE; y++) {
    for (let x = originX - 1; x <= originX + CHUNK_SIZE; x++) {
      if (x >= originX && y >= originY && x < originX + CHUNK_SIZE && y < originY + CHUNK_SIZE) continue;
      const type = sampler.typeAt(x, y);
      if (type) appendTile(RING, x, y, originX, originY, type, palette, sampler);
    }
  }

  return {
    ground: SINK.ground.take(),
    water: SINK.water.take(),
    shore: SINK.water.vertices ? shoreField(SINK.ground, sampler, originX, originY) : null,
    bevel: bevelField(SINK.ground, RING.ground),
    cliffs: SINK.cliffs.take(),
  };
}

/**
 * Tree instance matrices for one chunk, 16 floats each. Trees yield to roads,
 * and roads are live game state — so unlike buildChunk this stays on the main
 * thread. It is cheap: placement is a pure seeded function of the tile coords.
 */
/**
 * How often each crown colour comes up, dark to light, as counted in the
 * town plan the colours were sampled from: most crowns dark, fewest light.
 */
const CROWN_SHARES = [0.44, 0.37, 0.19];

export function buildTrees(
  tiles: Uint8Array,
  chunkX: number,
  chunkY: number,
  isBuilt: (x: number, y: number) => boolean,
  crowns: RGB[],
): { matrices: Float32Array; colors: Float32Array } {
  const originX = chunkX * CHUNK_SIZE;
  const originY = chunkY * CHUNK_SIZE;
  const matrices: number[] = [];
  const colors: number[] = [];

  for (let y = originY; y < originY + CHUNK_SIZE; y++) {
    for (let x = originX; x < originX + CHUNK_SIZE; x++) {
      const ix = x - originX + CHUNK_SKIRT;
      const iy = y - originY + CHUNK_SKIRT;
      if (TYPE_BY_BYTE[tiles[iy * CHUNK_STRIDE + ix]] !== "Forest") continue;
      if (isBuilt(x, y)) continue;

      for (const tree of treesForTile(x, y)) {
        const w = tree.scale * TREE_RADIUS;
        const c = Math.cos(tree.turn) * w, s = Math.sin(tree.turn) * w;
        // Column-major 4x4: a turn and a scale, translation in the last row.
        matrices.push(
          c, s, 0, 0,
          -s, c, 0, 0,
          0, 0, CROWN_HEIGHT * (0.45 + 0.55 * tree.tall), 0,
          x - originX + tree.x, y - originY + tree.y, 0, 1,
        );
        let pick = 0, t = tree.shade;
        while (pick < CROWN_SHARES.length - 1 && t >= CROWN_SHARES[pick]) t -= CROWN_SHARES[pick++];
        const crown = crowns[pick];
        colors.push(crown.r, crown.g, crown.b, 1);
      }
    }
  }
  return { matrices: new Float32Array(matrices), colors: new Float32Array(colors) };
}
