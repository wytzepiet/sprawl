import { isBuilt, type Town } from "./grid";
import { formOf, type Yard } from "./mass";
import { defaultJoins } from "./footprint";

/**
 * What a tile cannot see from its neighbours, worked out once over the
 * whole town before anything is drawn. Everything else about a tile's look
 * is a function of it, its neighbours and these facts.
 *
 * - **Heads**: the tiles of a shed that are its office, a couple of storeys
 *   taller (in `town`, the town as drawn).
 * - **Enclosed**: open ground closed in by buildings, a courtyard, which
 *   no street and no edge of the map reaches.
 * - **Yards**: a building whose kind keeps a yard (`mass.ts`) gives up as
 *   much of its ground as the yard must hold: tiles beside a street, in
 *   one run from its quiet end or its busy one, until there is room
 *   enough. The rest is building. A depot's yard holds lorries at docks
 *   on the wall across from its street, and its office stands at the busy
 *   end; a supermarket's holds cars in rows, its car park on the corner.
 */

/** Lorry bays along a dock: three to a tile of wall. */
export const DOCKS = 3;
/** Cars in a tile of car park: two rows of five, an aisle between. */
export const PARKED = 10;

export interface Facts {
  /** The town as drawn: the painted one with the heads raised. */
  town: Town;
  head(c: number, r: number): boolean;
  enclosed(c: number, r: number): boolean;
  /** What stands in a tile of yard, if it is one. */
  yard(c: number, r: number): Yard["fill"] | undefined;
  /** A yard tile's docks: the ways to the hall walls it faces, straight
   *  across from its street. */
  docks(c: number, r: number): [number, number][];
}

export function facts(painted: Town): Facts {
  const yard = yards(painted);
  const walls = docksOf(painted, (c, r) => yard.has(`${c},${r}`));
  // The yard is open ground, but the building keeps the joins it was
  // painted with, so the walls round its yard stand square.
  const open: Town = {
    ...painted,
    joins: painted.joins ?? defaultJoins(painted),
    tile: (c, r) => (yard.has(`${c},${r}`) ? { kind: "paved", storeys: 0 } : painted.tile(c, r)),
  };
  const { lifted, heads } = sheds(open);
  const closed = courtyards(open);
  return {
    town: lifted,
    head: (c, r) => heads.has(`${c},${r}`),
    enclosed: (c, r) => closed.has(`${c},${r}`),
    yard: (c, r) => yard.get(`${c},${r}`),
    docks: (c, r) => (yard.get(`${c},${r}`) === "docks" ? walls(c, r) : []),
  };
}

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Each building of a kind with a yard, as its joins hold it together. */
function buildings(town: Town): [number, number][][] {
  const joined = town.joins ?? defaultJoins(town);
  const seen = new Set<string>();
  const out: [number, number][][] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const kind = town.tile(c, r).kind;
      if (!formOf(town.tile(c, r)).yard || seen.has(`${c},${r}`)) continue;
      seen.add(`${c},${r}`);
      const cells: [number, number][] = [[c, r]];
      for (let i = 0; i < cells.length; i++) {
        const [a, b] = cells[i];
        for (const [dc, dr] of SIDES) {
          const [x, y] = [a + dc, b + dr];
          if (town.tile(x, y).kind === kind && !seen.has(`${x},${y}`) && (joined(a, b, x, y) || joined(x, y, a, b))) seen.add(`${x},${y}`), cells.push([x, y]);
        }
      }
      out.push(cells);
    }
  }
  return out;
}

/** A yard tile's docks: toward each tile of its building that is not yard
 *  and lies straight across from a street the yard tile is on. */
const docksOf = (town: Town, yard: (c: number, r: number) => boolean) => (c: number, r: number) =>
  SIDES.filter(([dc, dr]) => town.tile(c - dc, r - dr).kind === "road" && town.tile(c + dc, r + dr).kind === town.tile(c, r).kind && !yard(c + dc, r + dr)) as [number, number][];

/** How much street is round a tile, the nearer the more: a corner on a
 *  junction has most. */
function streetAround(town: Town, c: number, r: number) {
  let n = 0;
  for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) if (town.tile(c + dc, r + dr).kind === "road") n += 1 / (dc * dc + dr * dr);
  return n;
}

/** Each building's yard: street-side tiles in one run from its quiet or
 *  its busy end, until the yard holds what the building needs. */
function yards(town: Town): Map<string, Yard["fill"]> {
  const out = new Map<string, Yard["fill"]>();
  for (const cells of buildings(town)) {
    const { fill, end, per } = formOf(town.tile(...cells[0])).yard!;
    const yard = new Set<string>();
    const inYard = (c: number, r: number) => yard.has(`${c},${r}`);
    const walls = docksOf(town, inYard);
    const street = (c: number, r: number) => SIDES.some(([dc, dr]) => town.tile(c + dc, r + dr).kind === "road");
    const holds = (c: number, r: number) => (fill === "docks" ? DOCKS * walls(c, r).length : street(c, r) ? PARKED : 0);
    const held = () => [...yard].reduce((n, k) => n + holds(...(k.split(",").map(Number) as [number, number])), 0);
    const order = (a: [number, number], b: [number, number]) =>
      (end === "quiet" ? 1 : -1) * (streetAround(town, ...a) - streetAround(town, ...b)) || a[1] - b[1] || a[0] - b[0];
    while (held() < per * cells.length && yard.size + 1 < cells.length) {
      const next = cells
        .filter(([c, r]) => !inYard(c, r) && holds(c, r))
        .filter(([c, r]) => !yard.size || SIDES.some(([dc, dr]) => inYard(c + dc, r + dr)))
        .sort(order)[0];
      if (!next) break;
      yard.add(`${next[0]},${next[1]}`);
    }
    for (const k of yard) out.set(k, fill);
  }
  return out;
}

/** Open ground in regions (joined side by side) that touch neither a road
 *  nor the map's edge. */
function courtyards(town: Town): Set<string> {
  const open = (c: number, r: number) => ["open", "paved"].includes(town.tile(c, r).kind);
  const out = new Set<string>();
  const seen = new Set<string>();
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (!open(c, r) || seen.has(`${c},${r}`)) continue;
      const region: [number, number][] = [[c, r]];
      seen.add(`${c},${r}`);
      let reached = false;
      for (let i = 0; i < region.length; i++) {
        const [x, y] = region[i];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [nx, ny] = [x + dx, y + dy];
          if (nx < 0 || ny < 0 || nx >= town.w || ny >= town.h) reached = true;
          else if (town.tile(nx, ny).kind === "road") reached = true;
          else if (open(nx, ny) && !seen.has(`${nx},${ny}`)) seen.add(`${nx},${ny}`), region.push([nx, ny]);
        }
      }
      if (!reached) for (const [x, y] of region) out.add(`${x},${y}`);
    }
  }
  return out;
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
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
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

