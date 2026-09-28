import type { BuildingKind } from "../../generated";
import { isBuilt, type Tile, type Town } from "./grid";

/**
 * What the look knows of each kind of building: its family, which kinds
 * join into one building, how tall its walls stand and how its roof
 * climbs, and a shed's office head. The shapes are `footprint.ts`'s, the
 * mesh `roof.ts`'s.
 */

/** Homes and the shops of a high street are one family; offices, sheds
 *  and big boxes each another, and leave their yards paved. */
interface Form {
  family: string;
  yard?: "paved";
}
const STREET: Form = { family: "street" };
const FORMS: Partial<Record<BuildingKind, Form>> = {
  Office: { family: "office", yard: "paved" },
  Workshop: { family: "industry", yard: "paved" },
  Factory: { family: "industry", yard: "paved" },
  Warehouse: { family: "industry", yard: "paved" },
  Supermarket: { family: "box", yard: "paved" },
  GasStation: { family: "box", yard: "paved" },
};
export const formOf = (t: Tile): Form => FORMS[t.kind as BuildingKind] ?? STREET;

/** The walls' height. */
export const eaves = (t: Tile) => 0.1 + 0.12 * t.storeys;
/** How steeply a kind's roof climbs from its walls, and how high before
 *  it runs flat: a house's pitched, no higher than a one-tile row's ridge
 *  (0.3 in from its walls), so anything deeper is flat on top at that
 *  height; a block of flats' and a shed's nearly flat behind a low rim. */
export function slope(t: Tile) {
  if (formOf(t).family !== "street") return { pitch: 0.25, height: 0.06 };
  return t.storeys <= 3 ? { pitch: 0.75, height: 0.225 } : { pitch: 0.5, height: 0.03 };
}

/** Buildings that join: tiles of one kind, as the terrain's types, and for
 *  a kind that is not a street's (sheds, offices, boxes) of one building,
 *  painted as one. Houses run on into rows whoever built them. */
export const kin = (a: Tile, b: Tile) => {
  if (!isBuilt(a) || !isBuilt(b) || a.kind !== b.kind) return false;
  return formOf(a).family === "street" || a.id === b.id;
};

/**
 * A shed as a business park has it: an office at its street end, a couple
 * of storeys over the hall and lighter. It is found from the building's
 * tiles: its long way is the way it is longer, and its head is the end,
 * right across, with the tile that has most street round it, the corner on
 * a junction if it has one. A workshop of a tile or three is a hall alone.
 */
export function sheds(town: Town) {
  const key = (c: number, r: number) => `${c},${r}`;
  const heads = new Set<string>();
  const seen = new Set<string>();
  /** How much street is round a tile, the nearer the more: behind its
   *  yard, a shed's corner on the junction has most. */
  const street = (c: number, r: number) => {
    let n = 0;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) if (town.tile(c + dc, r + dr).kind === "road") n += 1 / (dc * dc + dr * dr);
    return n;
  };
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const me = town.tile(c, r);
      if (formOf(me).family !== "industry" || seen.has(key(c, r))) continue;
      seen.add(key(c, r));
      const cells = [[c, r]];
      for (let i = 0; i < cells.length; i++) {
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [x, y] = [cells[i][0] + dc, cells[i][1] + dr];
          if (kin(me, town.tile(x, y)) && !seen.has(key(x, y))) seen.add(key(x, y)), cells.push([x, y]);
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
  return { town: lifted, head: (c: number, r: number) => heads.has(key(c, r)) };
}

export type RGB = [number, number, number];
