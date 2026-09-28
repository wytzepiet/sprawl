import { isBuilt, type Town } from "./grid";
import type { Facts } from "./facts";
import { formOf } from "./mass";

/**
 * The free ground, dressed: what stands on a tile that is no building's,
 * decided like everything else by the tile, its neighbours and the facts.
 *
 * - A courtyard (`enclosed`) is a garden: lawn, and a tree or two. Paved
 *   ground closed in stays paved: a square.
 * - A street running straight has a tree on its verge every third tile,
 *   on each side that fronts homes, shops or open ground; a through road,
 *   a junction, a bend, a diagonal and an industrial street stay bare.
 *
 * Which tiles get a tree, and where on them, comes from the tile's place
 * alone, so the same town is always dressed the same.
 */
export interface Tree {
  x: number;
  y: number;
  /** Its size, as a share of a forest tree's. */
  scale: number;
  /** Which of the theme's crowns, 0 dark to 2 light. */
  shade: number;
}

export interface Dressing {
  /** Tiles laid to lawn. */
  gardens: [number, number][];
  trees: Tree[];
}

/** A number in [0, 1) that is the same for the same tile and salt. */
function hash(c: number, r: number, salt: number) {
  let s = (c * 374761393 + r * 668265263 + salt * 1013904223) | 0;
  s = Math.imul(s ^ (s >>> 13), 1274126177);
  return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
}

export function dress(town: Town, facts: Facts): Dressing {
  const gardens: [number, number][] = [];
  const trees: Tree[] = [];
  const road = (c: number, r: number) => town.tile(c, r).kind === "road";
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (facts.enclosed(c, r) && town.tile(c, r).kind === "open") {
        gardens.push([c, r]);
        // One tree on most tiles of a garden, somewhere off the middle.
        if (hash(c, r, 1) < 0.6) {
          trees.push({ x: c + 0.25 + 0.5 * hash(c, r, 2), y: r + 0.25 + 0.5 * hash(c, r, 3), scale: 0.7 + 0.3 * hash(c, r, 4), shade: Math.floor(3 * hash(c, r, 5)) });
        }
        continue;
      }
      if (!road(c, r) || town.through(c, r)) continue;
      // A straight street: joined along one axis only, both ways or at an end.
      const [ew, ns] = [town.linked(c, r, c - 1, r) || town.linked(c, r, c + 1, r), town.linked(c, r, c, r - 1) || town.linked(c, r, c, r + 1)];
      const diagonal = [[1, 1], [1, -1], [-1, 1], [-1, -1]].some(([dc, dr]) => town.linked(c, r, c + dc, r + dr));
      if (ew === ns || diagonal) continue;
      if ((ew ? c : r) % 3 !== 1) continue;
      for (const side of [-1, 1]) {
        const [x, y] = ew ? [c, r + side] : [c + side, r];
        const t = town.tile(x, y);
        if (t.kind !== "open" && !(isBuilt(t) && formOf(t).family === "street")) continue;
        const [ox, oy] = ew ? [0, side * 0.38] : [side * 0.38, 0];
        trees.push({ x: c + 0.5 + ox, y: r + 0.5 + oy, scale: 0.6, shade: Math.floor(3 * hash(c, r, side + 7)) });
      }
    }
  }
  return { gardens, trees };
}
