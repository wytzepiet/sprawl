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

/** Which tiles of a chunk hold some of one layer of the land, and each
 *  one's share of it (`TileShape`'s key). */
export interface LayerTiles {
  /** x and y of each, from the chunk's low corner. */
  at: Float32Array;
  shapes: string[];
}

export interface ChunkGeometry {
  /** Each of LAYERS, bottom up. */
  layers: LayerTiles[];
  /** The sea's and lakes' surface, apart, to be drawn as water. */
  water: MeshBuffers;
  /** How far each point of the chunk lies from land, if it has water: a
   *  byte each, 0 at the shore to 255 at SHORE_REACH or more, SHORE_DENSITY
   *  to a tile, rows up from its low corner. */
  shore: Uint8Array | null;
  cliffs: MeshBuffers;
}

/** The shore field's texels to a tile, and how far from land it reaches. */
export const SHORE_DENSITY = 12;
export const SHORE_REACH = 2;

/** Every ArrayBuffer in a result, for postMessage's transfer list. */
export function transferables(g: ChunkGeometry): ArrayBuffer[] {
  const arrays: (ArrayBufferView | undefined)[] = [g.water, g.cliffs].flatMap((m) => [m.positions, m.normals, m.indices, m.colors]);
  return [...arrays, ...g.layers.map((l) => l.at), g.shore ?? undefined].filter((a) => a !== undefined).map((a) => a.buffer as ArrayBuffer);
}

const ELEVATION: Record<TerrainType, number> = {
  Sea: -0.5,
  Water: -0.5,
  Beach: 0,
  Grass: 0,
  Forest: 0,
  Mountain: 2.0,
};

/**
 * The land in layers, bottom up, each a sheet of tiles lying on the one
 * below (`ground.ts`), at its height: the sand under all the land, the
 * grass on it under the wood and the rock, the wood floor, the rock on top.
 * Each tile of a layer holds its share of the grounds the layer is; where
 * its edge meets ground lying lower it rounds over onto it, but not where
 * it meets ground `level` with it, as the wood floor meets the grass.
 */
export const LAYERS: { grounds: TerrainType[]; level: TerrainType[]; z: number }[] = [
  { grounds: ["Beach", "Grass", "Forest", "Mountain"], level: [], z: 0 },
  { grounds: ["Grass", "Forest", "Mountain"], level: [], z: 0.002 },
  { grounds: ["Forest"], level: ["Grass", "Mountain"], z: 0.004 },
  { grounds: ["Mountain"], level: [], z: ELEVATION.Mountain },
];

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

/** A wall `height` tall standing on the line from a to b. */
const wall = (a: number[], b: number[], height: number): MeshGeometry => ({
  positions: [a[0], a[1], 0, b[0], b[1], 0, b[0], b[1], height, a[0], a[1], height],
  normals: UP4,
  indices: [0, 1, 2, 0, 2, 3],
});


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
function append(buf: TerrainBuffers, geo: MeshGeometry, ox: number, oy: number, oz: number, color: RGB): void {
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
      colors[c + 3] = 1;
    }
  }
  const indices = buf.indices;
  for (let i = 0, n = buf.indexCount; i < geo.indices.length; i++, n++) {
    indices[n] = base + geo.indices[i];
  }

  buf.vertices += vertexCount;
  buf.indexCount += geo.indices.length;
}

class ChunkSink {
  layers = LAYERS.map(() => ({ at: [] as number[], shapes: [] as string[] }));
  water = new TerrainBuffers(true);
  /** The land as drawn, for the water to know how far it lies from it. */
  land = new TerrainBuffers(false);
  /**
   * Cliffs only ever cast shadows. The camera looks straight down, so cliff
   * walls are edge-on and never rasterised — only the shadow pass reads them,
   * and that reads depth alone.
   */
  cliffs = new TerrainBuffers(false);

  reset(): void {
    for (const layer of this.layers) [layer.at.length, layer.shapes.length] = [0, 0];
    this.water.reset();
    this.land.reset();
    this.cliffs.reset();
  }
}

const isWater = (type: TerrainType) => type === "Sea" || type === "Water";

/** A tile's rounded corners, each its ground and its curve's variant. */
interface Curved {
  index: number;
  type: TerrainType;
  variant: number;
}
function curvedCorners(x: number, y: number, sampler: TerrainSampler): (Curved | null)[] {
  const types = sampler.cornersOf(x, y);
  const mask = cornerMask(x, y, types, sampler);
  return types.map((type, index) => {
    if (!type) return null;
    let variant = (mask >> (index * 2)) & 3;
    if (!(variant & 1) && !types[(index + 1) % 4]) variant |= 4;
    if (!(variant & 2) && !types[(index + 3) % 4]) variant |= 8;
    return { index, type, variant };
  });
}

/** The tile less every rounded corner of it: what its own ground covers. */
function cutBase(corners: ({ index: number; variant: number } | null)[]): MeshGeometry {
  const cut = corners.filter((c) => c !== null);
  if (!cut.length) return FULL_SQUARE;
  const key = cut.map((c) => `${c.index}v${c.variant}`).join("_");
  let geo = baseGeoCache.get(key);
  if (!geo) baseGeoCache.set(key, (geo = buildCutoutBaseGeo(cut)));
  return geo;
}

/** The ground along either half of a tile's edge `i`, from its start: a
 *  corner's where its curve reaches along the edge, else the tile's own.
 *  A corner's curve meets its first edge (A) at the edge's start corner,
 *  its second (B) at the end's, halfway along or, extended, all the way. */
function edgeGround(type: TerrainType, corners: (Curved | null)[], i: number): [TerrainType, TerrainType] {
  const [start, end] = [corners[i], corners[(i + 1) % 4]];
  const whole = (c: Curved | null, extended: number, continues: number) => !!c && !!(c.variant & extended) && !(c.variant & continues);
  return [start?.type ?? (whole(end, 8, 2) ? end!.type : type), end?.type ?? (whole(start, 4, 1) ? start!.type : type)];
}

/** A ground, to a layer: of it, level with it, or lying lower. */
export type Lies = "+" | "=" | "-";

/**
 * A tile's share of one layer of the land: how its own ground lies to the
 * layer, and each rounded corner's curve and how its ground lies; and,
 * along each half of each edge (`edgeGround`) where the tile's share
 * reaches it, how the ground across lies, so the edge there is a seam, an
 * edge, or an edge rounded over. And, for each edge the share reaches,
 * the curves of the two corners of the tile across it on that edge where
 * one is the layer's edge (`Near`), which start on the edge and pull away
 * from it, so the share rounds over onto the ground beyond them where they
 * come near, as the tile across does. Its key is what the shape is baked
 * under, once (`ground.ts`).
 */
export interface TileShape {
  base: Lies;
  corners: ({ variant: number; lies: Lies } | null)[];
  across: Lies[];
  near: (Near | null)[];
}

/** A corner's curve of the tile across an edge: its variant, how the
 *  ground beyond it lies, and whether the corner is the layer's side of it. */
export interface Near {
  variant: number;
  lies: Lies;
  inside: boolean;
}

export const shapeKey = (s: TileShape) =>
  s.base +
  s.corners.map((c) => (c ? c.variant.toString(16) + c.lies : "..")).join("") +
  s.across.join("") +
  s.near.map((c) => (c ? c.variant.toString(16) + c.lies + (c.inside ? "+" : "o") : "...")).join("");

export function parseShape(key: string): TileShape {
  const corners = [0, 1, 2, 3].map((i) => {
    const c = key.slice(1 + i * 2, 3 + i * 2);
    return c === ".." ? null : { variant: parseInt(c[0], 16), lies: c[1] as Lies };
  });
  const near = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
    const c = key.slice(17 + i * 3, 20 + i * 3);
    return c === "..." ? null : { variant: parseInt(c[0], 16), lies: c[1] as Lies, inside: c[2] === "+" };
  });
  return { base: key[0] as Lies, corners, across: [...key.slice(9, 17)] as Lies[], near };
}

/** A shape's ground, in the tile's own square. */
export function shapeGeometry(s: TileShape): MeshGeometry {
  const parts = [
    ...(s.base === "+" ? [cutBase(s.corners.map((c, index) => c && { index, variant: c.variant }))] : []),
    ...s.corners.flatMap((c, i) => (c?.lies === "+" ? [CORNER_GEOS[i][c.variant]] : [])),
  ];
  const out: MeshGeometry = { positions: [], normals: [], indices: [] };
  for (const part of parts) {
    const base = out.positions.length / 3;
    out.positions.push(...part.positions);
    out.normals.push(...part.normals);
    out.indices.push(...part.indices.map((i) => i + base));
  }
  return out;
}

/** The corners of the tile across edge `i` that lie on it, as `near`
 *  holds them, two to an edge. */
const NEAR_CORNERS = (i: number) => [(i + 2) % 4, (i + 3) % 4];

/** The curves near a shape across its edges (`Near`), in its own square,
 *  each line facing the layer's side of it. */
export function nearLines(s: TileShape): (OutlineLine & { lies: Lies })[] {
  return s.near.flatMap((c, n) => {
    if (!c) return [];
    const i = Math.floor(n / 2);
    const corner = NEAR_CORNERS(i)[n % 2];
    const [dx, dy] = EDGE_DIRS[i];
    const pts = getCornerCurvePoints(corner, c.variant).map(([px, py]) => [px + dx, py + dy]);
    const [vx, vy] = [CORNER_DEFS[corner].cv[0] + dx, CORNER_DEFS[corner].cv[1] + dy];
    return pts.slice(1).map((b, k) => {
      const a = pts[k];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const out = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
      // Towards the corner, if the corner is the layer's side.
      const towards = (vx - (a[0] + b[0]) / 2) * out[0] + (vy - (a[1] + b[1]) / 2) * out[1] > 0;
      return { a, b, inward: towards === c.inside ? out : [-out[0], -out[1]], lies: c.lies };
    });
  });
}

/** How the ground beyond a line along a shape's outline lies, the line
 *  from a to b and `inward` the way into the shape: across the tile's
 *  edge, if the line is on it, else the corner's or the tile's own that
 *  the line parts it from. */
export function beyond(s: TileShape, a: number[], b: number[], inward: number[]): Lies {
  const near = (v: number, w: number) => Math.abs(v - w) < 1e-4;
  const edge = [near(a[1], 0) && near(b[1], 0), near(a[0], 1) && near(b[0], 1), near(a[1], 1) && near(b[1], 1), near(a[0], 0) && near(b[0], 0)].indexOf(true);
  const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (edge >= 0) {
    const [[ax, ay], [bx, by]] = EDGE_ENDPOINTS[edge];
    return s.across[edge * 2 + ((mx - ax) * (bx - ax) + (my - ay) * (by - ay) < 0.5 ? 0 : 1)];
  }
  const [px, py] = [mx - inward[0] * 1e-3, my - inward[1] * 1e-3];
  for (const [i, c] of s.corners.entries()) {
    if (!c) continue;
    const { positions: p, indices } = CORNER_GEOS[i][c.variant];
    for (let t = 0; t < indices.length; t += 3) {
      const [u, v, w] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
      const side = (q: number, r: number) => (p[r] - p[q]) * (py - p[q + 1]) - (p[r + 1] - p[q + 1]) * (px - p[q]);
      const [d0, d1, d2] = [side(u, v), side(v, w), side(w, u)];
      if ((d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0)) return c.lies;
    }
  }
  return s.base;
}

/** A line of a shape's outline: from a to b, the way into the shape, and
 *  how the ground beyond it lies (`beyond`). Seams are not of it. */
export interface OutlineLine {
  a: number[];
  b: number[];
  inward: number[];
  lies: Lies;
}

/** A shape's outline: the lines only one of its triangles has, but not on
 *  a seam. Worked out once a shape. */
const OUTLINES = new Map<string, OutlineLine[]>();
export function outlineOf(key: string): OutlineLine[] {
  const known = OUTLINES.get(key);
  if (known) return known;
  const shape = parseShape(key);
  const { positions: p, indices } = shapeGeometry(shape);
  const spot = (i: number) => `${Math.round(p[i * 3] * 1e4)},${Math.round(p[i * 3 + 1] * 1e4)}`;
  const line = (i: number, j: number) => (spot(i) < spot(j) ? `${spot(i)}|${spot(j)}` : `${spot(j)}|${spot(i)}`);
  const count = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) for (let k = 0; k < 3; k++) count.set(line(indices[t + k], indices[t + ((k + 1) % 3)]), (count.get(line(indices[t + k], indices[t + ((k + 1) % 3)])) ?? 0) + 1);
  const out: OutlineLine[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => [p[indices[t + k] * 3], p[indices[t + k] * 3 + 1]]);
    const [cx, cy] = [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3];
    for (let k = 0; k < 3; k++) {
      if (count.get(line(indices[t + k], indices[t + ((k + 1) % 3)])) !== 1) continue;
      const [a, b] = [v[k], v[(k + 1) % 3]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let inward = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
      if ((cx - a[0]) * inward[0] + (cy - a[1]) * inward[1] < 0) inward = [-inward[0], -inward[1]];
      const lies = beyond(shape, a, b, inward);
      if (lies !== "+") out.push({ a, b, inward, lies });
    }
  }
  OUTLINES.set(key, out);
  return out;
}

/** A layer's map: each tile in the layer or not, as two kinds of ground
 *  the corner rules know, the one in it winning where they meet across a
 *  diagonal, so the layer joins there. */
const [IN, OUT] = [TYPE_BY_BYTE.indexOf("Beach"), TYPE_BY_BYTE.indexOf("Grass")];
const isIn = (type: TerrainType | null | undefined) => type === "Beach";

/** Where each layer stands a wall along its edge onto lower ground, down
 *  to what height: the land into the water, the rock onto the grass. */
const WALLS: [number, number][] = [
  [0, ELEVATION.Sea],
  [LAYERS.length - 1, 0],
];

/**
 * One tile's share of each layer of the land, top down, none of a layer
 * hidden whole under one above it. Each layer is rounded from its own map
 * alone, as the paving is: in it or not, whatever ground lies beyond; what
 * lies beyond decides only whether its edge there rounds over.
 */
function layTile(sink: ChunkSink, x: number, y: number, lx: number, ly: number, real: TerrainSampler, maps: TerrainSampler[]): void {
  const at = (dx: number, dy: number) => real.typeAt(x + dx, y + dy);
  let hidden = false;
  for (let l = LAYERS.length - 1; l >= 0 && !hidden; l--) {
    const { grounds, level } = LAYERS[l];
    const map = maps[l];
    // How ground out of the layer lies to it.
    const outside = (type: TerrainType | undefined): Lies => (type && level.includes(type) ? "=" : "-");
    const curved = curvedCorners(x, y, map);
    const mine = [0, 1, 2, 3].map((i) => edgeGround(map.typeAt(x, y)!, curved, i));
    const theirs = EDGE_DIRS.map(([dx, dy], i) => {
      const type = map.typeAt(x + dx, y + dy);
      if (!type) return null;
      const corners = curvedCorners(x + dx, y + dy, map);
      const [a, b] = edgeGround(type, corners, (i + 2) % 4);
      // Its corners on the edge whose curves are the layer's edge.
      const near = NEAR_CORNERS(i).map((k): Near | null => {
        const c = corners[k];
        if (!c || isIn(c.type) === isIn(type)) return null;
        const [ox, oy] = isIn(c.type) ? [0, 0] : CORNER_NEIGHBORS[k][0];
        return { variant: c.variant, lies: outside(at(dx + ox, dy + oy)), inside: isIn(c.type) };
      });
      return { halves: [b, a], near, lies: outside(at(dx, dy)) };
    });
    const shape: TileShape = {
      base: grounds.includes(at(0, 0)!) ? "+" : outside(at(0, 0)),
      corners: curved.map((c, i) => c && { variant: c.variant, lies: isIn(c.type) ? "+" : outside(at(...CORNER_NEIGHBORS[i][0])) }),
      // Only where the tile's share reaches the edge: elsewhere it matters not.
      across: mine.flatMap((halves, i) => halves.map((type, h) => (isIn(type) && theirs[i] ? (isIn(theirs[i]!.halves[h]) ? "+" : theirs[i]!.lies) : "-"))),
      near: theirs.flatMap((t, i) => (t && mine[i].some(isIn) ? t.near : [null, null])),
    };
    if (shape.base !== "+" && !shape.corners.some((c) => c?.lies === "+")) continue;
    const key = shapeKey(shape);
    sink.layers[l].at.push(lx, ly);
    sink.layers[l].shapes.push(key);
    hidden = shape.base === "+" && shape.corners.every((c) => !c || c.lies === "+");
    for (const [w, foot] of WALLS) {
      if (w !== l) continue;
      for (const { a, b, lies } of outlineOf(key)) if (lies === "-") append(sink.cliffs, wall(a, b, LAYERS[l].z - foot), lx, ly, foot, NO_COLOUR);
    }
    // The land as drawn, for the water to know how far it lies from it.
    if (l === 0) append(sink.land, shapeGeometry(shape), lx, ly, 0, NO_COLOUR);
  }
}
const NO_COLOUR: RGB = { r: 0, g: 0, b: 0 };

/** The water: a square under every tile with water at or beside it, the
 *  land's own outline drawn over it (`LAYERS`), the sea's a shade deeper. */
function layWater(sink: ChunkSink, x: number, y: number, lx: number, ly: number, real: TerrainSampler, palette: TerrainPalette): void {
  let water: TerrainType | null = null;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const type = real.typeAt(x + dx, y + dy);
      if (type && isWater(type) && water !== "Sea") water = type;
    }
  }
  if (water) append(sink.water, FULL_SQUARE, lx, ly, ELEVATION[water], palette[water]);
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

/** Scratch, reused across builds — see TerrainBuffers. */
const SINK = new ChunkSink();

/**
 * The land's layers, the water and the cliffs of one chunk. A pure function of the tiles and
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

  const maps = LAYERS.map(({ grounds }) =>
    createSampler(
      tiles.map((b) => (grounds.includes(TYPE_BY_BYTE[b]) ? IN : OUT)),
      CHUNK_STRIDE,
      originX - CHUNK_SKIRT,
      originY - CHUNK_SKIRT,
    ),
  );

  let tileCount = 0;
  for (let y = originY; y < originY + CHUNK_SIZE; y++) {
    for (let x = originX; x < originX + CHUNK_SIZE; x++) {
      if (!sampler.typeAt(x, y)) continue;
      tileCount++;
      layTile(SINK, x, y, x - originX, y - originY, sampler, maps);
      layWater(SINK, x, y, x - originX, y - originY, sampler, palette);
    }
  }
  if (tileCount === 0) return null;

  return {
    layers: SINK.layers.map((l) => ({ at: Float32Array.from(l.at), shapes: [...l.shapes] })),
    water: SINK.water.take(),
    shore: SINK.water.vertices ? shoreField(SINK.land, sampler, originX, originY) : null,
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
