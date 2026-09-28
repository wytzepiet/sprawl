import type { Tile, Town } from "./grid";
import { plan, unite, type Mass, type Polygon, type Pt } from "./footprint";

/**
 * The plans of a town's buildings on a fine grid: each tile split into
 * N × N cells, a cell a building's or nobody's, and the outline the
 * simplest marching squares there is, each crossing at an edge's middle.
 * On such a grid an outline can only run straight or at forty-five
 * degrees, and a diagonal is a clean line wherever the cells step one by
 * one, so nothing needs cutting exactly.
 *
 * The cells start as the pieces of `plan` (whole squares, a row stepping
 * on the diagonal a band). Then every cell too near a street's middle
 * line is nobody's, and every cell nearer than a margin to anything that
 * is not its own building, open ground or another building, is too.
 */

/** Cells along a tile's edge. */
const N = 8;
/** How far a building's cells reach towards a street's middle line: a
 *  straight street's is the tile's own edge; the margin comes after. */
const CLEAR = 0;
/** How far a building keeps from anything but its own, in cells: a square
 *  step then a diamond step, an octagon, so a straight side and a diagonal
 *  one both move in two cells and stay clean lines. */
const MARGIN = [[[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]], [[1, 0], [0, 1], [-1, 0], [0, -1]]];

export function rasterFootprints(town: Town, head: (c: number, r: number) => boolean): Mass[] {
  const { pieces, building } = plan(town);
  const [W, H] = [town.w * N, town.h * N];
  const owner = new Int32Array(W * H).fill(-1);
  const from = new Int32Array(W * H).fill(-1);
  const centre = (i: number, j: number): Pt => [(i + 0.5) / N, (j + 0.5) / N];

  // The pieces, painted cell by cell.
  pieces.forEach((p, k) => {
    const id = building.get(`${p.at[0]},${p.at[1]}`)!;
    const xs = p.ring.map((q) => q[0]), ys = p.ring.map((q) => q[1]);
    for (let j = Math.floor(Math.min(...ys) * N); j < Math.ceil(Math.max(...ys) * N); j++) {
      for (let i = Math.floor(Math.min(...xs) * N); i < Math.ceil(Math.max(...xs) * N); i++) {
        if (i < 0 || j < 0 || i >= W || j >= H || !inConvex(centre(i, j), p.ring)) continue;
        owner[j * W + i] = id;
        from[j * W + i] = k;
      }
    }
  });

  // Clear of the streets: of every line between joined road tiles, and a
  // road tile's middle.
  if (CLEAR > 0) {
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        if (owner[j * W + i] < 0) continue;
        const [x, y] = centre(i, j);
        if (nearStreet(town, x, y)) owner[j * W + i] = -1;
      }
    }
  }

  // Drawn in from everything else: a cell stays only if its neighbours are
  // its own building, twice over.
  for (const step of MARGIN) {
    const was = owner.slice();
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const id = was[j * W + i];
        if (id < 0) continue;
        for (const [di, dj] of step) {
          const [x, y] = [i + di, j + dj];
          if (x < 0 || y < 0 || x >= W || y >= H || was[y * W + x] !== id) {
            owner[j * W + i] = -1;
            break;
          }
        }
      }
    }
  }
  const ids = new Map<number, number[]>();
  for (let k = 0; k < W * H; k++) if (owner[k] >= 0) (ids.get(owner[k]) ?? ids.set(owner[k], []).get(owner[k])!).push(k);

  // Each building: a mass for each height, its parts by colour.
  const masses: Mass[] = [];
  for (const [, cells] of ids) {
    const mine = cells;
    const tileOf = (k: number): [number, number] => pieces[from[k]].at;
    const tile = (k: number): Tile => town.tile(...tileOf(k));
    const byStoreys = new Map<number, number[]>();
    for (const k of mine) (byStoreys.get(tile(k).storeys) ?? byStoreys.set(tile(k).storeys, []).get(tile(k).storeys)!).push(k);
    for (const [storeys, ks] of byStoreys) {
      const byColour = new Map<string, { tile: Tile; head: boolean; ks: number[] }>();
      for (const k of ks) {
        const h = head(...tileOf(k));
        const key = `${tile(k).kind}:${h}`;
        (byColour.get(key) ?? byColour.set(key, { tile: tile(k), head: h, ks: [] }).get(key)!).ks.push(k);
      }
      const polygons = outline(ks, W, H);
      if (!polygons.length) continue;
      masses.push({
        tile: tile(ks[0]),
        storeys,
        polygons,
        parts: [...byColour.values()].map((e) => ({ tile: e.tile, head: e.head, polygons: byColour.size === 1 ? polygons : outline(e.ks, W, H) })),
      });
    }
  }
  return masses;
}

/** The outline of a set of cells, by marching squares over their
 *  middles, every crossing halfway: whole squares where all four corners
 *  are in, a corner cut at forty-five degrees where they step. */
function outline(cells: number[], W: number, H: number): Polygon[] {
  const inside = new Set(cells);
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < W && j < H && inside.has(j * W + i);
  const pt = (i: number, j: number): Pt => [(i + 0.5) / N, (j + 0.5) / N];
  const rings: Pt[][] = [];
  const seen = new Set<number>();
  for (const k of cells) {
    const [i0, j0] = [k % W, Math.floor(k / W)];
    // The four squares of the dual grid that have this cell as a corner.
    for (const [di, dj] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const [i, j] = [i0 + di, j0 + dj];
      const key = (j + 1) * (W + 2) + i + 1;
      if (seen.has(key)) continue;
      seen.add(key);
      // Corners clockwise from the top left, and between them the edges'
      // middles.
      const corners: [number, number][] = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      const ins = corners.map(([a, b]) => at(a, b));
      const count = ins.filter(Boolean).length;
      if (!count) continue;
      const mid = (a: number, b: number): Pt => {
        const [p, q] = [pt(...corners[a]), pt(...corners[b])];
        return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      };
      const ring: Pt[] = [];
      for (let c = 0; c < 4; c++) {
        const n = (c + 1) % 4;
        if (ins[c]) ring.push(pt(...corners[c]));
        if (ins[c] !== ins[n]) ring.push(mid(c, n));
      }
      rings.push(ring);
    }
  }
  return unite(rings.map((r) => [r]));
}

const EIGHT = [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1]];

/** Is the point nearer than CLEAR to a street's middle line? */
function nearStreet(town: Town, x: number, y: number): boolean {
  const [c0, r0] = [Math.floor(x), Math.floor(y)];
  for (let r = r0 - 1; r <= r0 + 1; r++) {
    for (let c = c0 - 1; c <= c0 + 1; c++) {
      if (town.tile(c, r).kind !== "road") continue;
      const [px, py] = [c + 0.5, r + 0.5];
      let joined = false;
      for (const [dc, dr] of EIGHT) {
        if (!town.linked(c, r, c + dc, r + dr)) continue;
        joined = true;
        const t = Math.max(0, Math.min(1, ((x - px) * dc + (y - py) * dr) / (dc * dc + dr * dr)));
        // Square, not round, past a line's end: the outline stays straight.
        const [ex, ey] = [x - px - t * dc, y - py - t * dr];
        if ((t > 0 && t < 1 ? Math.hypot(ex, ey) : Math.max(Math.abs(ex), Math.abs(ey))) < CLEAR) return true;
      }
      if (!joined && Math.max(Math.abs(x - px), Math.abs(y - py)) < CLEAR) return true;
    }
  }
  return false;
}

function inConvex([x, y]: Pt, ring: Pt[]) {
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const [p, q] = [ring[i], ring[(i + 1) % ring.length]];
    const cross = (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    if (Math.abs(cross) < 1e-12) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}
