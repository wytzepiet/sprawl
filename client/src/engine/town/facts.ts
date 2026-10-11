import { isBuilt, windowOf, type Town } from "./grid";
import { formOf, type Yard } from "./mass";
import { defaultJoins } from "./footprint";

/**
 * What a tile cannot see from its neighbours, worked out once over the
 * whole town before anything is drawn. Everything else about a tile's look
 * is a function of it, its neighbours and these facts.
 *
 * - **Heads**: the tiles of a shed that are its office, a couple of storeys
 *   taller (in `town`, the town as drawn).
 * - **Yards**: the tiles the server lays a building's lot in
 *   (`Tile.yard`, `World::yard_of`), paved: the rows on its street side,
 *   its whole width, so the rest of it is a rectangle. A depot's yard
 *   holds lorries at docks against the building's wall behind it.
 * - **Harbours**: all yard, a trailer park, its slots the game's own
 *   (`Building.park`), painted on by the town (`TownLayer`).
 */

/** Lorry bays along a dock: three to a tile of wall. */
export const DOCKS = 3;

export interface Facts {
  /** The town as drawn: the painted one with the heads raised. */
  town: Town;
  head(c: number, r: number): boolean;
  /** What stands in a tile of yard, if it is one. */
  yard(c: number, r: number): Yard["fill"] | undefined;
  /** A yard tile's docks: the ways to its building's walls beside it. */
  docks(c: number, r: number): [number, number][];
}

export function facts(painted: Town): Facts {
  const yard = (c: number, r: number) => {
    const t = painted.tile(c, r);
    const y = formOf(t).yard;
    return y && (t.yard || y.fill === "park") ? y.fill : undefined;
  };
  // The yard is open ground, but the building keeps its joins, so the
  // walls round its yard stand square.
  const open: Town = {
    ...painted,
    joins: painted.joins ?? defaultJoins(painted),
    tile: (c, r) => (yard(c, r) ? { kind: "paved", storeys: 0 } : painted.tile(c, r)),
  };
  const { lifted, heads } = sheds(open);
  return {
    town: lifted,
    head: (c, r) => heads.has(`${c},${r}`),
    yard,
    docks: (c, r) => (yard(c, r) === "docks" ? SIDES.filter(([dc, dr]) => !yard(c + dc, r + dr) && sameBuilding(painted, c, r, c + dc, r + dr)) : []),
  };
}

const SIDES: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const sameBuilding = (town: Town, c0: number, r0: number, c1: number, r1: number) => {
  const [a, b] = [town.tile(c0, r0), town.tile(c1, r1)];
  return isBuilt(b) && a.kind === b.kind && a.id === b.id;
};

/** How much street is round a tile, the nearer the more: a corner on a
 *  junction has most. */
function streetAround(town: Town, c: number, r: number) {
  let n = 0;
  for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) if (town.tile(c + dc, r + dr).kind === "road") n += 1 / (dc * dc + dr * dr);
  return n;
}

/**
 * A shed as a business park has it: an office at its street end, a couple
 * of storeys over the hall and lighter. It is found from the building's
 * tiles: its long way is the way it is longer, and its head is the end,
 * right across, with the tile that has most street round it, the corner on
 * a junction if it has one. A workshop of a tile or three is a hall alone.
 */
function sheds(town: Town) {
  const key = (c: number, r: number) => `${c},${r}`;
  const heads = new Set<string>();
  const seen = new Set<string>();
  const street = (c: number, r: number) => streetAround(town, c, r);
  const joined = town.joins ?? defaultJoins(town);
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (formOf(town.tile(c, r)).family !== "industry" || seen.has(key(c, r))) continue;
      seen.add(key(c, r));
      const cells = [[c, r]];
      for (let i = 0; i < cells.length; i++) {
        for (const [dc, dr] of SIDES) {
          const [[a, b], [x, y]] = [cells[i], [cells[i][0] + dc, cells[i][1] + dr]];
          if (isBuilt(town.tile(x, y)) && (joined(a, b, x, y) || joined(x, y, a, b)) && !seen.has(key(x, y))) seen.add(key(x, y)), cells.push([x, y]);
        }
      }
      if (cells.length < 4) continue;
      const span = (k: number) => Math.max(...cells.map((p) => p[k])) - Math.min(...cells.map((p) => p[k]));
      const long = span(1) > span(0) ? 1 : 0;
      const ends = [Math.min(...cells.map((p) => p[long])), Math.max(...cells.map((p) => p[long]))];
      const head = cells.filter((p) => ends.includes(p[long])).reduce((a, b) => (street(b[0], b[1]) > street(a[0], a[1]) ? b : a));
      if (street(head[0], head[1])) for (const p of cells) if (p[long] === head[long]) heads.add(key(p[0], p[1]));
    }
  }
  const lifted: Town = { ...town, tile: (c, r) => (heads.has(key(c, r)) ? { ...town.tile(c, r), storeys: town.tile(c, r).storeys + 2 } : town.tile(c, r)) };
  return { lifted, heads };
}

/** A town's facts seen through a window from column x0, row y0, as
 *  `windowOf` sees the town: worked out over the whole town, not the
 *  window, so a building cut by the frame keeps its head. */
export function windowFacts(known: Facts, x0: number, y0: number, w: number, h: number): Facts {
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < w && r < h;
  return {
    town: windowOf(known.town, x0, y0, w, h),
    head: (c, r) => inside(c, r) && known.head(c + x0, r + y0),
    yard: (c, r) => (inside(c, r) ? known.yard(c + x0, r + y0) : undefined),
    docks: (c, r) => (inside(c, r) ? known.docks(c + x0, r + y0) : []),
  };
}
