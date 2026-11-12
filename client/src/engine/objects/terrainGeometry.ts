import type { TerrainType } from "../../generated";
import type { MeshGeometry } from "../geometry";
import type { Rgb } from "../rgb";
import { slateHeight } from "../slate";

// This module has no runtime imports, and must keep it that way: it is the
// unit of work handed to the terrain worker, where Babylon and the DOM do not
// exist. Colours arrive as plain floats, tiles as bytes.

/** Must match the server's CHUNK_SIZE / CHUNK_SKIRT. */
export const CHUNK_SIZE = 32;
export const CHUNK_SKIRT = 2;
export const CHUNK_STRIDE = CHUNK_SIZE + CHUNK_SKIRT * 2;

/** One mesh's vertex data. All transferable. */
export interface MeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Absent on geometry the camera never sees. */
  colors?: Float32Array;
}

export interface ChunkGeometry {
  /** The land's cliff, if it has one: the plane under its edge it is
   *  painted on, and its wall. */
  cliff: MeshBuffers;
  /** The mountains, terraced (`layPeaks`); their heights and where their
   *  layers break, half floats in pairs, for the shader to light them by. */
  peaks: MeshBuffers;
  peakHeights: Uint16Array | null;
}

/** The shore field's texels to a tile, and how far from land it reaches. */
export const SHORE_DENSITY = 12;
export const SHORE_REACH = 2;

/** Every ArrayBuffer in a result, for postMessage's transfer list. */
export function transferables(g: ChunkGeometry): ArrayBuffer[] {
  const arrays: (ArrayBufferView | undefined)[] = [g.cliff, g.peaks].flatMap((m) => [m.positions, m.normals, m.indices, m.colors]);
  return [...arrays, g.peakHeights ?? undefined].filter((a) => a !== undefined).map((a) => a.buffer as ArrayBuffer);
}

/** The land stands on a cliff this high over the water; a beach lies
 *  down it, this high, at the water's edge. */
export const WATER_Z = -0.7;
export const BEACH_Z = -0.66;

const ELEVATION: Record<Ground, number> = {
  Clay: 0,
  Sea: WATER_Z,
  Water: WATER_Z,
  Beach: 0,
  Grass: 0,
  Forest: 0,
  // Its rock rises out of the ground (`layPeaks`).
  Mountain: 0,
};

/** The ground the land's rock is under: all but the beaches and the water. */
export const LAND: Ground[] = ["Grass", "Forest", "Mountain", "Clay"];

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

/** How far from a tile's corner the wood's diagonal edge cuts across it, of
 *  a tile, measured along both sides. */
const CORNER_CUT = 0.5;

/** A tree at (x, y) of its tile, its size, turn, shade and height drawn
 *  from s; and s after. */
function grown(x: number, y: number, s: number): [TreeInfo, number] {
  let v: number;
  [s, v] = nextRand(s);
  const scale = 0.5 + v * 0.5;
  [s, v] = nextRand(s);
  const turn = v * Math.PI * 2;
  [s, v] = nextRand(s);
  const shade = v;
  [s, v] = nextRand(s);
  return [{ x, y, scale, turn, shade, tall: v }, s];
}

/** Trees stand where darts land, once, over a patch this many tiles a
 *  side that wraps round on itself: thrown one at a time, each a tree of
 *  its size, kept if it has room from every tree yet kept, so much of their
 *  two crowns' reach (`SPACING`), a big tree more and small ones filling in
 *  between, until so many in a row find none: the patch is full. Random,
 *  never crowded, never in rows; the map takes its trees from the patch
 *  tile by tile, each turned and shaded its own way, so where it repeats
 *  no two trees are alike. */
const PATCH = 16;
const MISSES = 2000;

const PATCHES = new Map<Kind, { x: number; y: number; scale: number }[][]>();
function patch(kind: Kind): { x: number; y: number; scale: number }[][] {
  let tiles = PATCHES.get(kind);
  if (tiles) return tiles;
  const reach = TREE_RADIUS * SPACING[kind].wide * SPACING[kind].room;
  // Kept trees bucketed by cells as wide as the most room two can keep.
  const cell = 2 * reach;
  const side = Math.floor(PATCH / cell);
  const buckets: { x: number; y: number; scale: number }[][] = Array.from({ length: side * side }, () => []);
  const wrap = (d: number) => d - PATCH * Math.round(d / PATCH);
  let s = seed(SPACING[kind].salt, 0);
  for (let misses = 0; misses < MISSES; ) {
    let x: number, y: number, v: number;
    [s, x] = nextRand(s);
    [s, y] = nextRand(s);
    [s, v] = nextRand(s);
    const t = { x: x * PATCH, y: y * PATCH, scale: 0.5 + v * 0.5 };
    const [cx, cy] = [Math.floor(t.x / (PATCH / side)), Math.floor(t.y / (PATCH / side))];
    let room = true;
    for (let dy = -1; dy <= 1 && room; dy++) {
      for (let dx = -1; dx <= 1 && room; dx++) {
        for (const o of buckets[((cy + dy + side) % side) * side + ((cx + dx + side) % side)]) {
          const [ox, oy, r] = [wrap(o.x - t.x), wrap(o.y - t.y), reach * (o.scale + t.scale)];
          if (ox * ox + oy * oy < r * r) {
            room = false;
            break;
          }
        }
      }
    }
    if (!room) {
      misses++;
      continue;
    }
    buckets[cy * side + cx].push(t);
    misses = 0;
  }
  tiles = Array.from({ length: PATCH * PATCH }, () => []);
  for (const t of buckets.flat()) tiles[Math.floor(t.y) * PATCH + Math.floor(t.x)].push({ x: t.x % 1, y: t.y % 1, scale: t.scale });
  PATCHES.set(kind, tiles);
  return tiles;
}

/** A tile's trees of a kind: where the patch has them, turned, shaded and
 *  grown to their height by the tile's own numbers. */
function treesForTile(tx: number, ty: number, kind: Kind): TreeInfo[] {
  const mod = (n: number) => ((n % PATCH) + PATCH) % PATCH;
  let s = seed(tx, ty) ^ SPACING[kind].salt;
  return patch(kind)[mod(ty) * PATCH + mod(tx)].map(({ x, y, scale }) => {
    let tree: TreeInfo;
    [tree, s] = grown(x, y, s);
    return { ...tree, scale };
  });
}

const FULL_SQUARE: MeshGeometry = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  indices: [0, 2, 1, 0, 3, 2],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
};

/** The cliff the land stands on: its lip painted on a plane round the
 *  land's edge, between its rock and its grass, as a mountain layer's is
 *  (`peaks.ts`), and its wall from the lip down into the water, its foot
 *  this far out. */
export const CLIFF_RUN = 0.32;
/** The land stands out past its tiles this far, on its cliff, on the
 *  whole: its edge there, wandering either way along the slate; its tiles'
 *  grass whole to their edge, room for what is built on them. */
export const CLIFF_OUT = 0.3;
/** And its edge wanders along the slate, as a mountain step's does, this
 *  far either way at most, in tiles: drawn into the cliff's field
 *  (`cliff.ts`), which all read the edge by. */
export const CLIFF_WANDER = 0.2;
/** How far either side of the land's edge its cliff's field reaches, in
 *  tiles, and where its plane lies: over the land's rock, under its grass. */
export const CLIFF_REACH = 2;
export const CLIFF_Z = 0.0012;
/** How far a wall's foot stands out for its height: the land's cliff's
 *  and a mountain layer's alike. */
export const LEAN = CLIFF_RUN / (CLIFF_Z - WATER_Z);
/** How far in behind the cliff's wall its lip is laid on the wall's mesh. */
const TUCK = 0.05;
/** The ledge at the cliff's foot: this high, just over the beach; reaching
 *  in under the wall this far, in tiles, from its lip, and out past its
 *  foot this far at most, where the slate does not break it. */
export const LEDGE_Z = BEACH_Z + 0.01;
const LEDGE_UNDER = 0.2;
export const LEDGE = 0.22;

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

export type TypeAt = (x: number, y: number) => Ground | undefined;

export interface TerrainSampler {
  typeAt: TypeAt;
}

/** Wire encoding, in the server's Ground::to_byte order. */
/** The ground as the client draws it: the land's types, and clay where a
 *  deposit lies under the grass (`TerrainChunk.deposits`), dug by a clay pit. */
export type Ground = TerrainType | "Clay";
export const TYPE_BY_BYTE: Ground[] = ["Water", "Beach", "Grass", "Forest", "Mountain", "Sea", "Clay"];

/** A chunk's tiles, skirt and all, by where they are on the map. */
export function createSampler(tiles: Uint8Array, stride: number, originX: number, originY: number): TerrainSampler {
  return {
    typeAt: (x, y) => {
      const [ix, iy] = [x - originX, y - originY];
      return ix < 0 || iy < 0 || ix >= stride || iy >= stride ? undefined : TYPE_BY_BYTE[tiles[iy * stride + ix]];
    },
  };
}

/**
 * Copy a unit-space geometry into a chunk buffer, translated to (ox, oy, oz).
 * Colour goes into the vertex buffer so a whole chunk shares one material.
 */
function append(buf: TerrainBuffers, geo: MeshGeometry, ox: number, oy: number, oz: number, color: Rgb): void {
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
  /** The land's cliff: the plane under its edge its lip is painted on, and its wall. */
  cliffPlane = new TerrainBuffers(false);

  reset(): void {
    this.cliffPlane.reset();
  }
}

const isWater = (type: Ground) => type === "Sea" || type === "Water";

/** A tile's eight neighbours. */
const AROUND = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const;

const NO_COLOUR: Rgb = { r: 0, g: 0, b: 0 };

const WATER = new TerrainBuffers(true);

/** The water of a chunk's tiles, skirt and all: a square under every tile
 *  with water at or beside it, the land's own outline drawn over it
 *  (`LAYERS`), each kind in its colour. Made where the tiles arrive, in no
 *  worker: it is what a pan over the sea shows first. */
export function waterOf(tiles: Uint8Array, colours: Record<"Sea" | "Water", Rgb>): MeshBuffers {
  WATER.reset();
  const at = (x: number, y: number) => TYPE_BY_BYTE[tiles[(y + CHUNK_SKIRT) * CHUNK_STRIDE + x + CHUNK_SKIRT]];
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      if (!at(x, y)) continue;
      let water: "Sea" | "Water" | null = null;
      for (const [dx, dy] of [[0, 0], ...AROUND]) {
        const type = at(x + dx, y + dy);
        if (type && isWater(type) && water !== "Sea") water = type as "Sea" | "Water";
      }
      if (water) append(WATER, FULL_SQUARE, x, y, ELEVATION[water], colours[water]);
    }
  }
  return WATER.take();
}

const isLandTop = (t: Ground) => LAND.includes(t);

/** The cliff's wall under the land's lip, laid on its plane's mesh: from
 *  the lip down into the water, its foot `CLIFF_RUN` out, facing out to
 *  sea; traced along the chunk's cliff as the GPU drew it and it was read
 *  back (`cliff.ts`), a byte a texel, the chunk and `CLIFF_REACH` round
 *  it: how far out from the lip each point lies, as the shader reads it,
 *  so the wall stands where the lip is cut. */
function layCliffWall(sink: ChunkSink, bytes: Uint8Array): void {
  const d = SHORE_DENSITY;
  const side = (CHUNK_SIZE + 2 * CLIFF_REACH) * d;
  // A texel's middle, from the chunk's corner.
  const place = (i: number, j: number): Point => [(i + 0.5) / d - CLIFF_REACH, (j + 0.5) / d - CLIFF_REACH];
  const decoded = new Float32Array(bytes.length);
  for (let k = 0; k < bytes.length; k++) decoded[k] = (bytes[k] / 255 - 0.5) * 2 * CLIFF_REACH;
  const far = (i: number, j: number) => decoded[j * side + i];
  const seaward = downhill((i, j) => -far(i, j), side, ([x, y]) => [(x + CLIFF_REACH) * d - 0.5, (y + CLIFF_REACH) * d - 0.5], () => CLIFF_RUN);
  const walls = new Builder();
  const m = CLIFF_REACH * d;
  // Rows wholly inland: nothing crosses them.
  const rows = highest(decoded, side);
  // And behind its top a strip of the lip, just under the plane and lit as
  // it is, uncut (the shader takes it for the wall's top), so where
  // the plane's cut, read from the field by the sampler, falls short of the
  // wall, the lip runs on to it: the plane need not overhang the wall, nor
  // shade it.
  const back = (p: Point): Point => {
    const [x, y] = seaward(p);
    return [p[0] - (x / CLIFF_RUN) * TUCK, p[1] - (y / CLIFF_RUN) * TUCK];
  };
  // And at its foot a ledge, from under the wall out past it, lit as the
  // wall is and cut where the slate breaks it (`peaks.ts`), so the cliff
  // meets the beach or the sea on a broken line, not where the wall goes
  // under.
  const ledge = (p: Point, t: number): Point => {
    const [x, y] = seaward(p);
    return [p[0] + x * t, p[1] + y * t];
  };
  const [under, past] = [LEDGE_UNDER / CLIFF_RUN, 1 + LEDGE / CLIFF_RUN];
  contour(
    far,
    place,
    [m, m, m + CHUNK_SIZE * d, m + CHUNK_SIZE * d],
    0,
    (p, q) => (
      walls.wall(q, p, WATER_Z, CLIFF_Z, [seaward(q), seaward(p)]),
      walls.polygon([p, q, back(q), back(p)], CLIFF_Z / 4),
      walls.polygon([ledge(p, under), ledge(q, under), ledge(q, past), ledge(p, past)], LEDGE_Z)
    ),
    undefined,
    Infinity,
    rows,
  );
  append(sink.cliffPlane, walls, 0, 0, 0, NO_COLOUR);
}

/** Whether a chunk's tiles, skirt and all, have the land's edge among
 *  them: a cliff to draw (`cliff.ts`). */
export function cliffed(tiles: Uint8Array): boolean {
  const top = (k: number) => isLandTop(TYPE_BY_BYTE[tiles[k]]);
  return tiles.some((_, k) => top(k) !== top(0));
}

/** The plane the land's cliff is painted on: a square under every tile
 *  within a tile of the land's edge. */
function layCliffPlane(sink: ChunkSink, sampler: TerrainSampler, originX: number, originY: number): void {
  for (let y = originY; y < originY + CHUNK_SIZE; y++) {
    for (let x = originX; x < originX + CHUNK_SIZE; x++) {
      const t = sampler.typeAt(x, y);
      if (!t) continue;
      const mine = isLandTop(t);
      if (!AROUND.some(([dx, dy]) => { const n = sampler.typeAt(x + dx, y + dy); return !!n && isLandTop(n) !== mine; })) continue;
      append(sink.cliffPlane, FULL_SQUARE, x - originX, y - originY, CLIFF_Z, NO_COLOUR);
    }
  }
}

/**
 * The mountains, a ground of their own: a surface on the ground at the
 * rock's edge, under the grass there, which stops at it as at the sand,
 * its fray showing the rock's foot; rising over the range as the server
 * eroded it (`mountains.rs`), which sends its heights with the chunk, in
 * terraces: each layer a flat top where the rock reaches it, on a wall
 * standing on the layer below. The edge is where the rock's height, the
 * slate's added (`slateHeight`), crosses where the layer begins, so it
 * breaks along the slate's plates, a plate standing proud jutting out and a
 * missing one biting in; on a steep range as far as on a gentle one. The
 * heights go on as a texture, for the shader to light the rock by
 * (`peaks.ts`). Unlike the rest of a chunk, laid where it is on the map,
 * not from the chunk's corner, for the shader to find the chunk and its
 * heights by.
 */
/** As the server sends them (`mountains.rs`): points to a tile's side, a
 *  tile's height, and how far past the chunk they reach, in tiles. */
export const PEAK_SAMPLES = 8;
const PEAK_UNIT = 1024;
export const PEAK_APRON = 1;
export const PEAK_SIDE = (CHUNK_SIZE + PEAK_APRON * 2) * PEAK_SAMPLES + 1;
/** Over the sand, under the grass (`LAYERS`); and how far out under the
 *  grass beside it the rock's foot reaches, of a tile, the sand having the
 *  rest, so the grass's fray shows whichever is nearer. */
export const FOOT_Z = 0.001;
const FOOT = 0.5;
/** The rock is laid in layers this many tiles high, the first standing
 *  where the heights reach this far above the ground, so its foot follows
 *  them round, not the grid they are on, and the rock lies level round it
 *  first, its ground a layer like the rest, its first wall standing on it
 *  and not on the grass. */
export const LAYER = 0.9;
export const EDGE = 0.3;
/** The rock's heights eased up over this many tiles from a line up to
 *  this far in from its edge, wandering with the slate, so its first wall
 *  breaks as the walls above do, not along the grid; the two together
 *  within the skirt a chunk has of its neighbours' tiles. Through that line
 *  and out under the grass they rise this steeply, in tiles a tile, so the
 *  ground rolls up into the first wall as a layer's top rolls into the
 *  wall above it (`peaks.ts`). */
const FOOT_EASE = 0.5;
const FOOT_JAG = 0.3;
const FOOT_RISE = 2.5;
/** Where layer `k` begins, of the rock's height: the ground is layer 0. */
export const begins = (k: number) => EDGE + (k - 1) * LAYER;
/** How far, in tiles, a layer's edge wanders with the slate, the slate's
 *  height added scaled by how steep the rock is, the steepness counted at
 *  most this, never more than this far either way; fading out over this
 *  much height at the foot, so the rock keeps to its own ground. */
export const WANDER = 0.4;
export const STEEPEST = 4;
export const WANDERS = 0.4;
export const JAG_FOOT = 0.25;

type Point = [number, number];

/**
 * Where a field on a grid of points reaches `level`, cell by cell (marching
 * squares), over the cells from (i0, j0) to before (i1, j1). `edge(p, q)`
 * for each stretch of the level's line, the field higher on its left; and,
 * given `fill`, the ground at or over the level, a convex polygon at a time
 * (a run of whole cells along a row as one), but for cells wholly at or
 * over `hidden`. Given each row's highest, rows wholly under it are passed
 * over.
 */
function contour(
  at: (i: number, j: number) => number,
  place: (i: number, j: number) => Point,
  [i0, j0, i1, j1]: [number, number, number, number],
  level: number,
  edge: (p: Point, q: Point) => void,
  fill?: (polygon: Point[]) => void,
  hidden = Infinity,
  rows?: Float32Array,
) {
  for (let j = j0; j < j1; j++) {
    if (rows && Math.max(rows[j], rows[j + 1]) < level) continue;
    let run = -1;
    const flush = (i: number) => {
      if (run >= 0 && fill) fill([place(run, j), place(i, j), place(i, j + 1), place(run, j + 1)]);
      run = -1;
    };
    for (let i = i0; i < i1; i++) {
      // Round the cell, as x and y run: its corners' heights, and the
      // corners, if the level crosses it.
      const [h0, h1, h2, h3] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const lo = Math.min(h0, h1, h2, h3);
      if (lo >= level) {
        if (lo >= hidden) flush(i);
        else if (run < 0) run = i;
        continue;
      }
      flush(i);
      if (Math.max(h0, h1, h2, h3) < level) continue;
      const h = [h0, h1, h2, h3];
      const c: Point[] = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      const over = h.map((v) => v >= level);
      const n = over.filter(Boolean).length;
      // Where the level crosses the side from corner a to b: worked out
      // from the side's lower corner, so the cell beside finds the same.
      const cross = (a: number, b: number): Point => {
        if (a === 3 || (a === 2 && b === 3)) [a, b] = [b, a];
        const t = (level - h[a]) / (h[b] - h[a]);
        const [p, q] = [place(...c[a]), place(...c[b])];
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      };
      const next = (k: number) => (k + 1) % 4;
      const prev = (k: number) => (k + 3) % 4;
      // A saddle whose middle is under the level: its two high corners apart.
      if (n === 2 && over[0] === over[2] && (h[0] + h[1] + h[2] + h[3]) / 4 < level) {
        for (let k = 0; k < 4; k++) {
          if (!over[k]) continue;
          const [out, back] = [cross(k, next(k)), cross(prev(k), k)];
          edge(out, back);
          fill?.([place(...c[k]), out, back]);
        }
        continue;
      }
      // Otherwise round the cell, the high corners and the crossings
      // between: one polygon; each crossing out followed by one back in.
      const polygon: Point[] = [];
      for (let k = 0; k < 4; k++) {
        if (over[k]) polygon.push(place(...c[k]));
        if (over[k] !== over[next(k)]) polygon.push(cross(k, next(k)));
      }
      for (let k = 0; k < 4; k++) {
        if (!over[k] || over[next(k)]) continue;
        // Out across side k; back in across the first side after it.
        let m = next(k);
        while (!over[next(m)]) m = next(m);
        edge(cross(k, next(k)), cross(m, next(m)));
      }
      fill?.(polygon);
    }
    flush(i1);
  }
}

/** The highest of each row of a square grid `side` across. */
function highest(grid: Float32Array, side: number): Float32Array {
  const rows = new Float32Array(side).fill(-Infinity);
  for (let j = 0; j < side; j++) for (let k = j * side; k < (j + 1) * side; k++) if (grid[k] > rows[j]) rows[j] = grid[k];
  return rows;
}

/** Down a field on a grid of points, at a point of the map (`grid` puts
 *  it on the grid), `run(steep)` long, steep in the field's units a grid
 *  step: its slope blended between the grid points round it, alike from
 *  either cell a point is shared by, so walls meeting there share a foot. */
function downhill(at: (i: number, j: number) => number, side: number, grid: (p: Point) => Point, run: (steep: number) => number) {
  const slope = (a: number, b: number): Point => [at(a + 1, b) - at(a - 1, b), at(a, b + 1) - at(a, b - 1)];
  return (p: Point): Point => {
    const [tx, ty] = grid(p);
    const [i, j] = [Math.max(1, Math.min(side - 3, Math.floor(tx))), Math.max(1, Math.min(side - 3, Math.floor(ty)))];
    const [u, v] = [tx - i, ty - j];
    const [g00, g10, g01, g11] = [slope(i, j), slope(i + 1, j), slope(i, j + 1), slope(i + 1, j + 1)];
    const g = [0, 1].map((n) => (g00[n] * (1 - u) + g10[n] * u) * (1 - v) + (g01[n] * (1 - u) + g11[n] * u) * v);
    const len = Math.hypot(g[0], g[1]) || 1;
    const r = run(len / 2);
    return [(-g[0] / len) * r, (-g[1] / len) * r];
  };
}

/** A mesh's buffers, as they are built: a convex polygon, or a wall. */
class Builder {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];
  polygon(points: Point[], z: number) {
    const base = this.positions.length / 3;
    for (const [x, y] of points) this.positions.push(x, y, z), this.normals.push(0, 0, 1);
    for (let k = 1; k + 1 < points.length; k++) this.indices.push(base, base + k, base + k + 1);
  }
  /** From p to q, facing to the right of that, from `lo` up to `hi`; its
   *  foot out from p and q along `out`. Facing at each end the way its foot
   *  goes, not the way its own face does, so the walls meeting at a point
   *  face alike there and, set back in the shadow map (`peaks.ts`), stay
   *  joined, with no slit at a bend for the low sun to shine through. */
  wall(p: Point, q: Point, lo: number, hi: number, out: [Point, Point]) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-6) return;
    // Where the ground is flat and the foot goes nowhere, its own face's.
    const facing = ([x, y]: Point) => (Math.hypot(x, y) > 1e-9 ? [x / Math.hypot(x, y), y / Math.hypot(x, y)] : [(q[1] - p[1]) / len, (p[0] - q[0]) / len]);
    const [[px, py], [qx, qy]] = out.map(facing);
    const base = this.positions.length / 3;
    this.positions.push(p[0] + out[0][0], p[1] + out[0][1], lo, q[0] + out[1][0], q[1] + out[1][1], lo, q[0], q[1], hi, p[0], p[1], hi);
    this.normals.push(px, py, 0, qx, qy, 0, qx, qy, 0, px, py, 0);
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  take(): MeshBuffers {
    return { positions: new Float32Array(this.positions), normals: new Float32Array(this.normals), indices: new Uint32Array(this.indices) };
  }
}

/** A number as a half float's bits, for a texture of them. */
const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
function half(v: number): number {
  F32[0] = v;
  const x = U32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 112;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | ((x & 0x7fffff) >>> 13);
}

function layPeaks(sampler: TerrainSampler, heights: Uint8Array, originX: number, originY: number): { mesh: MeshBuffers; heights: Uint16Array | null } {
  const rock = (x: number, y: number) => sampler.typeAt(x, y) === "Mountain";
  const out = new Builder();
  const place = (i: number, j: number): Point => [originX - PEAK_APRON + i / PEAK_SAMPLES, originY - PEAK_APRON + j / PEAK_SAMPLES];
  // The rock's height at a point of the heights' grid, in tiles; and where
  // its layers break, the slate's added.
  const raw = new Float32Array(heights.length / 2);
  for (let k = 0; k < raw.length; k++) raw[k] = (heights[2 * k] | (heights[2 * k + 1] << 8)) / PEAK_UNIT;
  // Eased in from a line in from the rock's edge, which is the tiles'
  // edge: there the heights jump, and the first wall would stand straight
  // down the grid. And on out past it, under the grass, below nothing.
  const reach = Math.ceil(FOOT_EASE + FOOT_JAG);
  const [tx0, ty0] = [originX - PEAK_APRON - reach, originY - PEAK_APRON - reach];
  const span = CHUNK_SIZE + 2 * (PEAK_APRON + reach) + 1;
  const open = Uint8Array.from({ length: span * span }, (_, k) => (rock(tx0 + (k % span), ty0 + Math.floor(k / span)) ? 0 : 1));
  for (let j = 0; j < PEAK_SIDE && raw.length; j++) {
    for (let i = 0; i < PEAK_SIDE; i++) {
      const [x, y] = place(i, j);
      const inside = !open[(Math.floor(y) - ty0) * span + Math.floor(x) - tx0];
      let d = reach;
      for (let ty = Math.floor(y) - reach; ty <= Math.floor(y) + reach; ty++) {
        for (let tx = Math.floor(x) - reach; tx <= Math.floor(x) + reach; tx++) {
          if (open[(ty - ty0) * span + tx - tx0] !== (inside ? 1 : 0)) continue;
          d = Math.min(d, Math.hypot(Math.max(tx - x, 0, x - tx - 1), Math.max(ty - y, 0, y - ty - 1)));
        }
      }
      const u = (inside ? d : -d) - FOOT_JAG * (0.15 + 0.85 * Math.min(1, Math.max(0, 0.5 + 1.5 * slateHeight(2 * x, 2 * y, true))));
      const t = Math.min(1, Math.max(0, u / FOOT_EASE));
      const e = t * t * (3 - 2 * t);
      const own = raw[j * PEAK_SIDE + i];
      raw[j * PEAK_SIDE + i] = u < 0 ? FOOT_RISE * u : own * e + Math.min(own, FOOT_RISE * u) * (1 - e);
    }
  }
  const h = (i: number, j: number) => raw[Math.min(PEAK_SIDE - 1, Math.max(0, j)) * PEAK_SIDE + Math.min(PEAK_SIDE - 1, Math.max(0, i))];
  const broken = new Float32Array(raw.length);
  let top = 0;
  for (let j = 0; j < PEAK_SIDE && raw.length; j++) {
    for (let i = 0; i < PEAK_SIDE; i++) {
      const own = raw[j * PEAK_SIDE + i];
      if (own <= 0) {
        broken[j * PEAK_SIDE + i] = own;
        continue;
      }
      const steep = Math.max(Math.hypot(h(i + 1, j) - h(i - 1, j), h(i, j + 1) - h(i, j - 1)) * (PEAK_SAMPLES / 2), 0.05);
      const s = own + Math.max(-WANDERS, Math.min(WANDERS, WANDER * Math.min(steep, STEEPEST) * slateHeight(...place(i, j), true) * 0.5 * Math.min(1, own / JAG_FOOT)));
      broken[j * PEAK_SIDE + i] = s;
      top = Math.max(top, s);
    }
  }
  // Each layer's top where the rock reaches it, but where the layer above
  // hides it whole; and its wall, from the layer below up to it.
  const cells: [number, number, number, number] = [PEAK_APRON * PEAK_SAMPLES, PEAK_APRON * PEAK_SAMPLES, (PEAK_APRON + CHUNK_SIZE) * PEAK_SAMPLES, (PEAK_APRON + CHUNK_SIZE) * PEAK_SAMPLES];
  const at = (i: number, j: number) => broken[j * PEAK_SIDE + i];
  const rows = highest(broken, PEAK_SIDE);
  // A wall leans back as the land's cliff does, its foot out down the
  // rock, never past half way to the next layer's edge: down the rock's own
  // heights, not the slate's, which would turn each foot its own way and
  // fold the wall over itself in teeth.
  const outward = downhill(h, PEAK_SIDE, ([x, y]) => [(x - originX + PEAK_APRON) * PEAK_SAMPLES, (y - originY + PEAK_APRON) * PEAK_SAMPLES], (steep) => Math.min(LEAN * LAYER, (0.5 * LAYER) / Math.max(steep * PEAK_SAMPLES, 1e-3)));
  for (let k = 1; begins(k) <= top; k++) {
    const [lo, hi] = [FOOT_Z + (k - 1) * LAYER, FOOT_Z + k * LAYER];
    contour(at, place, cells, begins(k), (p, q) => out.wall(p, q, lo, hi, [outward(p), outward(q)]), (polygon) => out.polygon(polygon, hi), begins(k + 1), rows);
  }
  // The rock's own ground, on its tiles; its foot under the grass beside
  // them: half a tile out along a side of rock, a quarter-tile triangle
  // into a corner it only touches across.
  for (let y = originY; y < originY + CHUNK_SIZE; y++) {
    for (let x = originX; x < originX + CHUNK_SIZE; x++) {
      if (rock(x, y)) {
        out.polygon([[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]], FOOT_Z);
        continue;
      }
      const t = sampler.typeAt(x, y);
      if (t !== "Grass" && t !== "Forest" && t !== "Clay") continue;
      const flat = (...points: Point[]) => out.polygon(points, FOOT_Z);
      if (rock(x - 1, y)) flat([x, y], [x + FOOT, y], [x + FOOT, y + 1], [x, y + 1]);
      if (rock(x + 1, y)) flat([x + 1 - FOOT, y], [x + 1, y], [x + 1, y + 1], [x + 1 - FOOT, y + 1]);
      if (rock(x, y - 1)) flat([x, y], [x + 1, y], [x + 1, y + FOOT], [x, y + FOOT]);
      if (rock(x, y + 1)) flat([x, y + 1 - FOOT], [x + 1, y + 1 - FOOT], [x + 1, y + 1], [x, y + 1]);
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        if (!rock(x + dx, y + dy) || rock(x + dx, y) || rock(x, y + dy)) continue;
        const [cx, cy] = [x + (dx > 0 ? 1 : 0), y + (dy > 0 ? 1 : 0)];
        flat([cx, cy], [cx - dx * FOOT, cy], [cx, cy - dy * FOOT]);
      }
    }
  }
  // And the heights, the rock's and where it breaks, for the shader to
  // light it by.
  const texels = raw.length ? new Uint16Array(PEAK_SIDE * PEAK_SIDE * 2) : null;
  if (texels) for (let k = 0; k < raw.length; k++) (texels[2 * k] = half(raw[k])), (texels[2 * k + 1] = half(broken[k]));
  return { mesh: out.take(), heights: texels };
}

/** Scratch, reused across builds — see TerrainBuffers. */
const SINK = new ChunkSink();

/**
 * The cliffs and the mountains of one chunk. A pure function of the tiles:
 * no scene, no game state, no DOM. This is what the worker runs.
 *
 * `tiles` carries CHUNK_SKIRT tiles of margin on every side, so a chunk meshes
 * without consulting its neighbours and the shared skirt keeps seams consistent.
 * Returns null when the chunk holds no tiles at all.
 */
export function buildChunk(
  tiles: Uint8Array,
  heights: Uint8Array,
  chunkX: number,
  chunkY: number,
  cliff: Uint8Array | null,
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
      if (sampler.typeAt(x, y)) tileCount++;
    }
  }
  if (tileCount === 0) return null;
  if (cliff) layCliffPlane(SINK, sampler, originX, originY), layCliffWall(SINK, cliff);

  return {
    cliff: SINK.cliffPlane.take(),
    ...(({ mesh, heights: h }) => ({ peaks: mesh, peakHeights: h }))(layPeaks(sampler, heights, originX, originY)),
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
/** Conifers grow in stands: where a slow noise over the map, cells this
 *  many tiles across, passes this; its edge a line, wandering by a quicker
 *  noise, cells this many tiles across, this far, and broken into islands
 *  a tree or two across by a quicker one still, this much, so near it the
 *  kinds mix; each grows full up to it, so they meet mixed, not thinned
 *  out. A conifer is this much narrower than a broadleaf, and this much
 *  taller. */
const STAND = 9;
const STANDS = 0.58;
const STAND_WANDER = 1.5;
const STAND_EDGE = 0.16;
const STAND_SPECK = 0.45;
const STAND_MIX = 0.09;
const CONIFER_WIDE = 0.8;
const CONIFER_TALL = 1.6;
/** A broadleaf is drawn this much wider than the room it keeps, so its
 *  crown reaches into its neighbours' as a wood's do, and this much taller. */
const BROAD_WIDE = 1.3;
const BROAD_TALL = 1.35;
/** The smallest a conifer squeezed between broadleaves grows, of its size. */
const SQUEEZED = 0.4;
/** How many times a conifer is pushed off broadleaves before it shrinks. */
const PUSHES = 2;

type Kind = "broad" | "conifer";
/** The room each kind's trees keep, of their two crowns' reach: conifers
 *  closer, broadleaves sprawling. */
const SPACING: Record<Kind, { room: number; wide: number; salt: number }> = {
  broad: { room: 0.64, wide: 1, salt: 0x27d4eb2d },
  conifer: { room: 0.6, wide: CONIFER_WIDE, salt: 0x5bd1e995 },
};

/** A slow noise at a point of the map, cells this many tiles across, 0 to 1. */
function noiseAt(x: number, y: number, span: number, salt: number): number {
  const [gx, gy] = [x / span, y / span];
  const [ix, iy] = [Math.floor(gx), Math.floor(gy)];
  const ease = (t: number) => t * t * (3 - 2 * t);
  const [tx, ty] = [ease(gx - ix), ease(gy - iy)];
  const at = (cx: number, cy: number) => nextRand(seed(cx + 7919 + salt, cy - 104729))[1];
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  return mix(mix(at(ix, iy), at(ix + 1, iy), tx), mix(at(ix, iy + 1), at(ix + 1, iy + 1), tx), ty);
}

/** A chunk's trees, each where it stands and its colour: `built`, a
 *  tile for tile with `tiles`, which of them are built on. */
export function buildTrees(
  tiles: Uint8Array,
  built: Uint8Array,
  chunkX: number,
  chunkY: number,
  palette: { crowns: Rgb[]; conifers: Rgb[] },
): Record<Kind, { matrices: Float32Array; colors: Float32Array }> {
  const originX = chunkX * CHUNK_SIZE;
  const originY = chunkY * CHUNK_SIZE;
  const sets = { broad: { matrices: [] as number[], colors: [] as number[] }, conifer: { matrices: [] as number[], colors: [] as number[] } };
  const isBuilt = (x: number, y: number) => built[(y - originY + CHUNK_SKIRT) * CHUNK_STRIDE + x - originX + CHUNK_SKIRT] > 0;

  // Which kind a stand grows at a point of the map, by the side of its edge it is on.
  const kindAt = (wx: number, wy: number): Kind => {
    const edge = (noiseAt(wx, wy, STAND_WANDER, 31337) - 0.5) * 2 * STAND_EDGE + (noiseAt(wx, wy, STAND_SPECK, 7331) - 0.5) * 2 * STAND_MIX;
    return noiseAt(wx, wy, STAND, 0) + edge > STANDS ? "conifer" : "broad";
  };
  // Where the kinds meet, a conifer makes way for a broadleaf it would
  // stand in: the broadleaves a tile grows, kept for the tiles round it.
  const broadleaves = new Map<number, TreeInfo[]>();
  const broadAt = (tx: number, ty: number) => {
    const key = (tx - originX + 2) * 4096 + (ty - originY + 2);
    let trees = broadleaves.get(key);
    if (!trees) broadleaves.set(key, (trees = treesForTile(tx, ty, "broad").filter((t) => kindAt(tx + t.x, ty + t.y) === "broad")));
    return trees;
  };
  // Pushed off a broadleaf it stands in, out a little past where their
  // crowns keep their room; so many times, for one wedged between several;
  // still crowded, it grows smaller (`SQUEEZED`); and only then is it let go.
  const makeWay = (x: number, y: number, t: TreeInfo): TreeInfo | null => {
    const room = TREE_RADIUS * (SPACING.broad.room + SPACING.conifer.room) / 2;
    let { x: px, y: py, scale } = t;
    const crowding = () => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const b of broadAt(x + dx, y + dy)) {
            const [ox, oy, r] = [px - b.x - dx, py - b.y - dy, room * (b.scale + scale * CONIFER_WIDE)];
            if (ox * ox + oy * oy < r * r) return { ox, oy, r };
          }
        }
      }
      return null;
    };
    for (let pass = 0; pass < PUSHES + 2; pass++) {
      const c = crowding();
      if (!c) return { ...t, x: px, y: py, scale };
      if (pass < PUSHES) {
        const d = Math.hypot(c.ox, c.oy) || 1e-3;
        const by = c.r * 1.1 - d;
        [px, py] = [px + (c.ox / d) * by, py + (c.oy / d) * by];
      } else if (scale > SQUEEZED) scale = Math.max(SQUEEZED, scale * 0.8);
    }
    return crowding() ? null : { ...t, x: px, y: py, scale };
  };

  // A tile of wood, as its floor is drawn: not built on.
  const wood = (x: number, y: number) => TYPE_BY_BYTE[tiles[(y - originY + CHUNK_SKIRT) * CHUNK_STRIDE + x - originX + CHUNK_SKIRT]] === "Forest" && !isBuilt(x, y);
  for (let y = originY; y < originY + CHUNK_SIZE; y++) {
    for (let x = originX; x < originX + CHUNK_SIZE; x++) {
      const mine = wood(x, y);
      // The wood's edge cut across a tile's corners on the diagonal, as
      // marching squares cut it: a corner of a wood tile whose two sides
      // meet no wood has none; a corner of an open tile whose two sides
      // meet wood, and not across it too, where the wood parts as its floor
      // does, has some, if it may be.
      const corners = ([[0, 0], [1, 0], [0, 1], [1, 1]] as const).map(([cx, cy]) => {
        const [sx, sy] = [cx ? 1 : -1, cy ? 1 : -1];
        const [a, b] = [wood(x + sx, y), wood(x, y + sy)];
        return mine ? !a && !b : a && b && !wood(x + sx, y + sy) && TYPE_BY_BYTE[tiles[(y - originY + CHUNK_SKIRT) * CHUNK_STRIDE + x - originX + CHUNK_SKIRT]] !== "Mountain" && !isBuilt(x, y);
      });
      if (!mine && !corners.some((c) => c)) continue;
      const cornerOf = (px: number, py: number) => (px < 0.5 ? 0 : 1) + (py < 0.5 ? 0 : 2);
      const inCorner = (px: number, py: number) => {
        const k = cornerOf(px, py);
        const [cx, cy] = [k & 1, k >> 1];
        return Math.abs(px - cx) + Math.abs(py - cy) < CORNER_CUT;
      };

      for (const [kind, tree] of (["broad", "conifer"] as const).flatMap((k) => treesForTile(x, y, k).map((t) => [k, t] as const))) {
        const flipped = corners[cornerOf(tree.x, tree.y)] && inCorner(tree.x, tree.y);
        if (mine === flipped) continue;
        // Which side of a stand's edge: each kind's trees grow only on theirs.
        if (kindAt(x + tree.x, y + tree.y) !== kind) continue;
        const placed = kind === "conifer" ? makeWay(x, y, tree) : tree;
        if (!placed) continue;
        const { matrices, colors } = sets[kind];
        const w = placed.scale * TREE_RADIUS * (kind === "conifer" ? CONIFER_WIDE : BROAD_WIDE);
        const c = Math.cos(placed.turn) * w, s = Math.sin(placed.turn) * w;
        // Column-major 4x4: a turn and a scale, translation in the last row.
        matrices.push(
          c, s, 0, 0,
          -s, c, 0, 0,
          0, 0, CROWN_HEIGHT * (0.45 + 0.55 * placed.tall) * (kind === "conifer" ? CONIFER_TALL : BROAD_TALL), 0,
          x - originX + placed.x, y - originY + placed.y, 0, 1,
        );
        let pick = 0, t = placed.shade;
        while (pick < CROWN_SHARES.length - 1 && t >= CROWN_SHARES[pick]) t -= CROWN_SHARES[pick++];
        const crown = (kind === "conifer" ? palette.conifers : palette.crowns)[pick];
        colors.push(crown.r, crown.g, crown.b, 1);
      }
    }
  }
  const done = ({ matrices, colors }: { matrices: number[]; colors: number[] }) => ({ matrices: new Float32Array(matrices), colors: new Float32Array(colors) });
  return { broad: done(sets.broad), conifer: done(sets.conifer) };
}
