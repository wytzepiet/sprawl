import type { TerrainType } from "../../generated";
import {
  CHUNK_SIZE,
  CHUNK_SKIRT,
  CHUNK_STRIDE,
  CORNER_PRIORITY,
  ELEVATION,
  TYPE_BY_BYTE,
  wins,
  type ChunkGeometry,
  type MeshBuffers,
  type RGB,
  type TerrainPalette,
} from "./terrainGeometry";

/**
 * The terrain on the dual grid: drawn corner by corner, each corner a
 * pure function of the four tiles that meet there.
 *
 * Every tile is four quarters, one at each of its corners. A quarter is
 * its tile's, unless both quarters beside it round that corner belong to
 * other kinds that take it (the old terrain's rule, `roundedBy`): then its
 * tile is cut back to a quarter circle round the tile's middle, and the
 * rest of the quarter, the fillet, is the other kind's. Where two tiles of one kind meet across a corner and the other
 * two are another one kind (a saddle), the kind that wins runs through and
 * the other is cut back. That is the whole rule.
 *
 * Every outline meets a tile's edge at its middle, square to it: a
 * straight shore along the edge, or an arc round the tile's middle ending
 * there. So pieces drawn for neighbouring corners always meet, and nothing
 * is laid over anything else. A cliff is the wall along an outline, drawn
 * once, by the higher side.
 */

/** Segments in a quarter circle. */
const ARC = 6;

type Pt = [number, number];

class Buffer {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];
  uvs: number[] = [];
  colors: number[] = [];
  constructor(private shaded: boolean) {}
  /** A fan round `centre` through `ring`, at height z, in one colour; uv
   *  is the point's place in its tile. */
  fan(centre: Pt, ring: Pt[], z: number, rgb: RGB, tile: Pt, open = false) {
    const base = this.positions.length / 3;
    for (const p of [centre, ...ring]) {
      this.positions.push(p[0], p[1], z);
      this.normals.push(0, 0, 1);
      if (this.shaded) {
        this.uvs.push(p[0] - tile[0], p[1] - tile[1]);
        this.colors.push(rgb.r, rgb.g, rgb.b, 1);
      }
    }
    const n = ring.length;
    for (let i = 0; i < (open ? n - 1 : n); i++) this.indices.push(base, base + 1 + ((i + 1) % n), base + 1 + i);
  }
  /** A wall standing on a line of points, from z0 to z1. */
  wall(line: Pt[], z0: number, z1: number) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [p, q] = [line[i], line[i + 1]];
      const base = this.positions.length / 3;
      this.positions.push(p[0], p[1], z0, q[0], q[1], z0, q[0], q[1], z1, p[0], p[1], z1);
      // Edge-on to the camera; for the shadow pass only. Up, as the old
      // terrain's, so the normal bias moves every wall alike.
      for (let k = 0; k < 4; k++) this.normals.push(0, 0, 1);
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  take(): MeshBuffers {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      indices: new Uint32Array(this.indices),
      uvs: this.shaded ? new Float32Array(this.uvs) : undefined,
      colors: this.shaded ? new Float32Array(this.colors) : undefined,
    };
  }
}

/** The four corners of a tile, as offsets towards them, clockwise from the
 *  top left (y down). */
const CORNERS: Pt[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/**
 * What kind a tile's quarter towards corner (sx, sy) gives way to, if it
 * does: both tiles beside it round the corner are one other kind, and it
 * is not the winner of a saddle.
 */
function roundedBy(typeAt: (x: number, y: number) => TerrainType | undefined, x: number, y: number, sx: number, sy: number): TerrainType | null {
  const me = typeAt(x, y)!;
  const [a, b, d] = [typeAt(x + sx, y), typeAt(x, y + sy), typeAt(x + sx, y + sy)];
  if (a === undefined || b === undefined || a === me || b === me || ELEVATION[a] !== ELEVATION[b]) return null;
  // Two others of one kind: that kind, unless it is a saddle I win.
  if (a === b) return d === me && wins(me, a) ? null : a;
  // Two different others: only if the tile across agrees with one, and then
  // the one of them first in line.
  if (d !== a && d !== b) return null;
  return CORNER_PRIORITY[a] >= CORNER_PRIORITY[b] ? a : b;
}

export function buildChunkDual(tiles: Uint8Array, chunkX: number, chunkY: number, palette: TerrainPalette): ChunkGeometry | null {
  const originX = chunkX * CHUNK_SIZE;
  const originY = chunkY * CHUNK_SIZE;
  const typeAt = (x: number, y: number): TerrainType | undefined => {
    const [ix, iy] = [x - originX + CHUNK_SKIRT, y - originY + CHUNK_SKIRT];
    if (ix < 0 || iy < 0 || ix >= CHUNK_STRIDE || iy >= CHUNK_STRIDE) return undefined;
    return TYPE_BY_BYTE[tiles[iy * CHUNK_STRIDE + ix]];
  };
  const ground = new Buffer(true);
  const cliffs = new Buffer(false);

  let count = 0;
  for (let y = originY; y < originY + CHUNK_SIZE; y++) {
    for (let x = originX; x < originX + CHUNK_SIZE; x++) {
      const me = typeAt(x, y);
      if (!me) continue;
      count++;
      // In the chunk's frame; the tile's middle and its corner.
      const [lx, ly] = [x - originX, y - originY];
      const mid: Pt = [lx + 0.5, ly + 0.5];
      const tile: Pt = [lx, ly];
      const z = ELEVATION[me];
      for (const [sx, sy] of CORNERS) {
        const corner: Pt = [mid[0] + sx / 2, mid[1] + sy / 2];
        // The middles of the tile's two edges that meet at this corner.
        const ex: Pt = [corner[0], mid[1]];
        const ey: Pt = [mid[0], corner[1]];
        const other = roundedBy(typeAt, x, y, sx, sy);
        if (!other) {
          ground.fan(mid, [ex, corner, ey], z, palette[me], tile, true);
        } else {
          // A quarter circle round the tile's middle, from one edge's middle
          // to the other's; beyond it, towards the corner, the other kind.
          const arc: Pt[] = [];
          for (let i = 0; i <= ARC; i++) {
            const t = (i / ARC) * (Math.PI / 2);
            arc.push([mid[0] + (sx / 2) * Math.cos(t), mid[1] + (sy / 2) * Math.sin(t)]);
          }
          ground.fan(mid, arc, z, palette[me], tile, true);
          const oz = ELEVATION[other];
          ground.fan(corner, [...arc].reverse(), oz, palette[other], tile, true);
          if (oz !== z) cliffs.wall(arc, Math.min(z, oz), Math.max(z, oz));
        }
        // The straight shore along each of this quarter's two edges, where
        // the tile beside is lower and neither side rounds this corner away:
        // drawn by the higher tile.
        for (const [dx, dy, edge] of [[sx, 0, ex], [0, sy, ey]] as [number, number, Pt][]) {
          const them = typeAt(x + dx, y + dy);
          if (them === undefined || ELEVATION[them] >= z || other) continue;
          if (roundedBy(typeAt, x + dx, y + dy, -dx || sx, -dy || sy)) continue;
          cliffs.wall([edge, corner], ELEVATION[them], z);
        }
      }
    }
  }
  if (!count) return null;
  return { ground: ground.take(), cliffs: cliffs.take() };
}
