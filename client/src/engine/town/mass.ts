import type { BuildingKind } from "../../generated";
import { isBuilt, type Tile } from "./grid";

/**
 * What the look knows of each kind of building: its family, which kinds
 * join into one building, how tall its walls stand and how its roof
 * climbs. The facts a tile cannot see from its neighbours are
 * `facts.ts`'s, the shapes `footprint.ts`'s, the mesh `roof.ts`'s.
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

export type RGB = [number, number, number];
