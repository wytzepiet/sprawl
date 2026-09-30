import type { BuildingKind } from "../../generated";
import { isBuilt, type Tile } from "./grid";

/**
 * What the look knows of each kind of building: its family, which kinds
 * join into one building, how tall its walls stand and how its roof
 * climbs. The facts a tile cannot see from its neighbours are
 * `facts.ts`'s, the shapes `footprint.ts`'s, the mesh `roof.ts`'s.
 */

/** What a building gives up of its own ground to a yard (`facts.ts`):
 *  what stands in it, lorries at docks or cars in rows; which end of the
 *  building it takes, the quiet one or the busy one; and how many it must
 *  hold for each tile of the building. */
export interface Yard {
  fill: "docks" | "cars";
  end: "quiet" | "busy";
  per: number;
}

/** Homes and the shops of a high street are one family; offices, sheds
 *  and big boxes each another. */
interface Form {
  family: string;
  yard?: Yard;
}
const STREET: Form = { family: "street" };
const FORMS: Partial<Record<BuildingKind, Form>> = {
  Office: { family: "office" },
  Workshop: { family: "industry" },
  Factory: { family: "industry" },
  // A depot's lorries come and go at its back, out of sight of the junction.
  Warehouse: { family: "industry", yard: { fill: "docks", end: "quiet", per: 0.5 } },
  // A supermarket's car park is its shop window, on the busy corner.
  Supermarket: { family: "box", yard: { fill: "cars", end: "busy", per: 3 } },
  GasStation: { family: "box" },
};
export const formOf = (t: Tile): Form => FORMS[t.kind as BuildingKind] ?? STREET;

/** The walls' height. */
export const eaves = (t: Tile) => 0.1 + 0.12 * t.storeys;
/** How steeply a kind's roof climbs from its walls, and how high before
 *  it runs flat: a house's pitched, no higher than a one-tile row's ridge
 *  (0.3 in from its walls), so anything deeper is flat on top at that
 *  height; a block of flats' nearly flat behind a low rim; a shed's or a
 *  big box's flat, as a depot's is seen from above. */
export function slope(t: Tile) {
  if (formOf(t).family !== "street") return { pitch: 1, height: 0 };
  return t.storeys <= 3 ? { pitch: 0.75, height: 0.225 } : { pitch: 0.5, height: 0.03 };
}

/** An office tower is capped, the way a model town's towers are: a flat
 *  roof with a second, smaller slab on it. Everything else is roofed by
 *  its slope. */
export const capped = (t: Tile) => t.kind === "Office";

/** Buildings that may join, where no stroke says: tiles of one kind, as
 *  the terrain's types are. */
export const kin = (a: Tile, b: Tile) => isBuilt(a) && isBuilt(b) && a.kind === b.kind;

export type RGB = [number, number, number];
