import type { BuildingKind } from "../../generated";
import type { Town } from "./grid";

/**
 * Buildings are painted, a tile at a time, as roads are drawn. What is
 * painted is rarely a building on its own: one tile is not a depot. So a
 * stroke is completed, as it is painted, to the smallest working building
 * that holds it, and the player sees that as a ghost and paints on to
 * shape it. Painting sideways turns the ghost to follow; painting past it
 * makes the building bigger.
 *
 * What a kind needs is its program: the smallest rectangle it works in, so
 * many tiles along its street and so many deep, with its front on a street,
 * and how far from a street any of its tiles may lie. A house is one tile
 * and must front the street; a depot is three by two and may reach back.
 */
export type Cell = [number, number];

export interface Program {
  /** The smallest working building: tiles along its street, and deep. */
  w: number;
  d: number;
  /** How far from a street a tile of it may lie, in steps: one is the
   *  frontage alone. */
  reach: number;
}

const HOME: Program = { w: 1, d: 1, reach: 1 };
export const PROGRAMS: Partial<Record<BuildingKind, Program>> = {
  House: HOME, Shop: HOME, Restaurant: HOME, Bar: HOME, Office: HOME,
  Apartment: { w: 2, d: 1, reach: 2 },
  Workshop: { w: 2, d: 1, reach: 3 },
  Factory: { w: 2, d: 2, reach: 6 },
  Warehouse: { w: 3, d: 2, reach: 6 },
  Supermarket: { w: 3, d: 2, reach: 4 },
  GasStation: { w: 2, d: 1, reach: 1 },
};

const key = ([c, r]: Cell) => `${c},${r}`;
const SIDES: Cell[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Ground a building may be painted on. */
const free = (town: Town, c: number, r: number) => ["open", "paved"].includes(town.tile(c, r).kind);

/** A street within `k` steps. */
function near(town: Town, c: number, r: number, k: number) {
  for (let dr = -k; dr <= k; dr++) {
    for (let dc = -k + Math.abs(dr); dc <= k - Math.abs(dr); dc++) {
      if (town.tile(c + dc, r + dr).kind === "road") return true;
    }
  }
  return false;
}

/** Can this tile be part of a building of this program at all? */
export const paintable = (town: Town, p: Program, c: number, r: number) => free(town, c, r) && near(town, c, r, p.reach);

function connected(cells: Cell[]) {
  const all = new Set(cells.map(key));
  const seen = new Set([key(cells[0])]);
  const queue = [cells[0]];
  while (queue.length) {
    const [c, r] = queue.pop()!;
    for (const [dc, dr] of SIDES) {
      const k = key([c + dc, r + dr]);
      if (all.has(k) && !seen.has(k)) seen.add(k), queue.push([c + dc, r + dr]);
    }
  }
  return seen.size === all.size;
}

/**
 * The smallest working building holding what was painted: the stroke and a
 * rectangle of the program's size, fronting a street along its long side,
 * on tiles it may stand on, joined to the stroke. Of those, the one that
 * adds the fewest tiles, and then covers most of the stroke, so the ghost
 * turns to follow the way the stroke runs. Null if there is none.
 */
export function complete(town: Town, p: Program, stroke: Cell[]): Cell[] | null {
  if (!stroke.length) return null;
  const painted = new Set(stroke.map(key));
  const [c0, c1] = [Math.min(...stroke.map(([c]) => c)), Math.max(...stroke.map(([c]) => c))];
  const [r0, r1] = [Math.min(...stroke.map(([, r]) => r)), Math.max(...stroke.map(([, r]) => r))];
  let best: { cells: Cell[]; added: number; covered: number } | null = null;
  const shapes: Cell[] = p.w === p.d ? [[p.w, p.d]] : [[p.w, p.d], [p.d, p.w]];
  for (const [w, h] of shapes) {
    for (let y = r0 - h; y <= r1 + 1; y++) {
      for (let x = c0 - w; x <= c1 + 1; x++) {
        const rect: Cell[] = [];
        for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) rect.push([c, r]);
        if (!rect.every(([c, r]) => painted.has(key([c, r])) || paintable(town, p, c, r))) continue;
        if (!fronts(town, x, y, w, h, w >= h)) continue;
        const cells = [...stroke, ...rect.filter((t) => !painted.has(key(t)))];
        if (!connected(cells)) continue;
        const added = cells.length - stroke.length;
        const covered = rect.length - added;
        if (!best || added < best.added || (added === best.added && covered > best.covered)) best = { cells, added, covered };
      }
    }
  }
  return best?.cells ?? null;
}

/** Does the rectangle have a whole long side on a street? A square, any
 *  side. */
function fronts(town: Town, x: number, y: number, w: number, h: number, wide: boolean) {
  const road = (c: number, r: number) => town.tile(c, r).kind === "road";
  const along = (cells: Cell[]) => cells.every(([c, r]) => road(c, r));
  const row = (r: number) => Array.from({ length: w }, (_, i): Cell => [x + i, r]);
  const col = (c: number) => Array.from({ length: h }, (_, i): Cell => [c, y + i]);
  const rows = along(row(y - 1)) || along(row(y + h));
  const cols = along(col(x - 1)) || along(col(x + w));
  return w === h ? rows || cols : wide ? rows : cols;
}

/**
 * The building of this kind a painted tile touches, if any, and only that
 * one: painting beside a depot grows that depot rather than starting
 * another, so a bump out of its back is as good as a bump out of its side.
 */
export function touching(town: Town, kind: string, [c, r]: Cell): Cell[] {
  const start = [[c, r] as Cell, ...SIDES.map(([dc, dr]): Cell => [c + dc, r + dr])].find(([x, y]) => town.tile(x, y).kind === kind);
  if (!start) return [];
  const { id } = town.tile(...start);
  const seen = new Set([key(start)]);
  const out: Cell[] = [start];
  for (let i = 0; i < out.length; i++) {
    for (const [dc, dr] of SIDES) {
      const n: Cell = [out[i][0] + dc, out[i][1] + dr];
      if (town.tile(...n).kind === kind && town.tile(...n).id === id && !seen.has(key(n))) seen.add(key(n)), out.push(n);
    }
  }
  return out;
}
