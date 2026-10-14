import type { BuildingKind } from "../../generated";
import { isBuilt, type Tile } from "./grid";

/**
 * What the look knows of each kind of building: its family, which kinds
 * join their neighbours, how tall its walls stand and how its roof
 * climbs. The facts a tile cannot see from its neighbours are
 * `facts.ts`'s, the shapes `footprint.ts`'s, the mesh `roof.ts`'s.
 */

/** What stands in a building's yard, the tiles the server lays its lot in
 *  (`Tile.yard`): lorries at docks against the building, or boxes in a
 *  trailer park. */
export interface Yard {
  fill: "docks" | "park";
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
  Factory: { family: "industry" },
  // A depot's lorries come and go at its back, out of sight of the junction.
  Depot: { family: "industry", yard: { fill: "docks" } },
  // A sawmill's yard is its log and plank stacks, a lorry backed to them.
  Sawmill: { family: "industry", yard: { fill: "docks" } },
  // A quarry's yard is its heaps of broken stone, a lorry backed to them.
  Quarry: { family: "industry", yard: { fill: "docks" } },
  // A supermarket is a big box, its customers parked at the kerb.
  Supermarket: { family: "box" },
  GasStation: { family: "box" },
  // A harbour is open ground all through: its trailer park on the street
  // side, the apron the tug crosses to the ramp on the water side. Its
  // terminal stands on the quay (`BuildingObject.tsx`).
  Harbour: { family: "port", yard: { fill: "park" } },
};
export const formOf = (t: Tile): Form => FORMS[t.kind as BuildingKind] ?? STREET;
/** What stands in a tile of yard, if it is one: where the server lays a
 *  building's lot (`Tile.yard`), or anywhere on a kind that is all yard,
 *  as a harbour is. Docks, unless its kind says. */
export const yardFill = (t: Tile): Yard["fill"] | undefined => {
  const y = formOf(t).yard;
  return t.yard ? (y?.fill ?? "docks") : y?.fill === "park" ? "park" : undefined;
};
export const isYard = (t: Tile) => yardFill(t) !== undefined;

/** The walls' height. */
export const eaves = (t: Tile) => 0.1 + 0.12 * t.storeys;
/** How steeply a kind's roof climbs from its walls, and how high before
 *  it runs flat: a house's pitched, no higher than a one-tile row's ridge
 *  (0.3 in from its walls), so anything deeper is flat on top at that
 *  height; a block of flats' nearly flat behind a low rim; a shed's or a
 *  big box's flat, as a depot's is seen from above. */
export function slope(t: Tile) {
  if (formOf(t).family !== "street") return { pitch: 1, height: 0 };
  if (t.storeys > 3) return { pitch: 0.5, height: 0.03 };
  // A place on the street, a shop or a pub, wears a mansard: a short
  // slope at its eaves and flat on top, where its sign lies.
  return mansard(t) ? { pitch: 0.75, height: 0.06 } : { pitch: 0.75, height: 0.225 };
}
/** Whether a building wears a mansard: a place on the high street. At
 *  its slope's top a flat band BAND wide runs round, and inside it the
 *  flat sits RECESS down, as a mansard hides its roof, an AC unit in a
 *  corner (`roof.ts`). */
export const mansard = (t: Tile) => formOf(t).family === "street" && t.storeys <= 3 && SIGNED.has(t.kind as BuildingKind);
const SIGNED = new Set<BuildingKind>(["Shop"]);
export const RECESS = 0.03, BAND = 0.035;

/** An office tower's flat roof carries its plant, as a real one does: a
 *  lift room at one end, AC units at the other, vents along a side
 *  (`roof.ts`). */
export const planted = (t: Tile) => t.kind === "Office";
/** A flat roof's parapet: how thick its wall, and how high above the roof. */
export const PARAPET_W = 0.045, PARAPET_H = 0.05;

/** Where a sign lies on a building's roof: how high; how far in from the
 *  walls the flat it lies on begins (a mansard's slope); and that it is
 *  painted on, as roof markings are. */
export function seat(t: Tile): { z: number; inset: number; painted: boolean } {
  const { pitch, height } = slope(t);
  return mansard(t) ? { z: eaves(t) + height - RECESS, inset: height / pitch + BAND, painted: true } : { z: eaves(t) + height, inset: height / pitch, painted: true };
}

/** Buildings that may join, where no stroke says: tiles of one kind, as
 *  the terrain's types are. A home, a big box and anything with a yard stand
 *  alone: placed whole, each is one building, never joined to the one
 *  beside it, so its tiles join only each other. */
export const kin = (a: Tile, b: Tile) =>
  isBuilt(a) && isBuilt(b) && a.kind === b.kind && (!alone(a) || a.id === b.id);
/** A kind placed whole, one building: it joins only itself, and never on
 *  the diagonal. */
export const alone = (t: Tile) => ALONE.has(t.kind as BuildingKind);
const ALONE = new Set<BuildingKind>(["House", "Apartment", "Supermarket", "Depot", "Sawmill", "Quarry", "Harbour", "Farm"]);

export type RGB = [number, number, number];
