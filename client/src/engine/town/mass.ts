import type { BuildingKind } from "../../generated";
import { isBuilt, type Tile } from "./grid";

/**
 * What the look knows of each kind of building: its family, which kinds
 * join their neighbours, how tall its walls stand and how its roof
 * climbs. The facts a tile cannot see from its neighbours are
 * `facts.ts`'s, the shapes `footprint.ts`'s, the mesh `roof.ts`'s.
 */

/** What stands in a building's yard, the tiles the server lays its lot in
 *  (`Tile.yard`): lorries at docks against the building; a harbour's
 *  lane, docks and quay; or a depot's pad, its goods out in the open
 *  (`pads.ts`). */
export interface Yard {
  fill: "docks" | "park" | "pad";
}

/** Homes and the shops of a high street are one family; offices, sheds
 *  and big boxes each another. */
interface Form {
  family: string;
  yard?: Yard;
  /** What stands where its walls would: a kind with none, all yard. */
  open?: Yard["fill"];
}
const STREET: Form = { family: "street" };
const FORMS: Partial<Record<BuildingKind, Form>> = {
  Lab: { family: "office" },
  Factory: { family: "industry" },
  // A depot is an open yard, its goods on the ground in bays, no roof
  // over them; its lorries come and go at its docks in front.
  Depot: { family: "industry", yard: { fill: "docks" }, open: "pad" },
  // A sawmill's yard is its log and plank stacks, a lorry backed to them.
  Sawmill: { family: "industry", yard: { fill: "docks" } },
  // A quarry's yard is its heaps of broken stone, a lorry backed to them.
  Quarry: { family: "industry", yard: { fill: "docks" } },
  // A farm is a farmyard, a model of its own (`objects/farm.ts`), its
  // fence its own: no hedge round it.
  Farm: { family: "farm", yard: { fill: "docks" } },
  // A supermarket is a big box, its customers parked at the kerb.
  Supermarket: { family: "box" },
  GasStation: { family: "box" },
  // A harbour is open ground all through: the lane from its gate to the
  // ramp, the docks one side of it and the quay's pad the other. Its
  // terminal stands on the quay (`BuildingObject.tsx`).
  Harbour: { family: "port", yard: { fill: "park" }, open: "park" },
  Port: { family: "port", yard: { fill: "park" }, open: "park" },
  // The works: sheds, each its yard of docks where its lorry backs to
  // what it made.
  Bakery: { family: "street", yard: { fill: "docks" } },
  CementWorks: { family: "industry", yard: { fill: "docks" } },
  Mine: { family: "industry", yard: { fill: "docks" } },
  Colliery: { family: "industry", yard: { fill: "docks" } },
  Steelworks: { family: "industry", yard: { fill: "docks" } },
  OilWell: { family: "industry", yard: { fill: "docks" } },
  Refinery: { family: "industry", yard: { fill: "docks" } },
};
/** Kinds drawn whole from the kit (`objects/BuildingObject.tsx`): the
 *  town grid lays their ground and yard and raises no walls of its own,
 *  and no sign lies on them, the model saying what it is. */
export const WHOLE: ReadonlySet<string> = new Set<BuildingKind>(["Shop", "House", "Sawmill", "Quarry", "Farm", "Mine", "Colliery", "CementWorks", "Steelworks", "Factory", "OilWell", "Refinery", "Bakery"]);
export const formOf = (t: Tile): Form => FORMS[t.kind as BuildingKind] ?? STREET;
/** What stands in a tile of yard, if it is one: where the server lays a
 *  building's lot (`Tile.yard`), docks unless its kind says; or anywhere
 *  on a kind with no walls, as a harbour and a depot are. */
export const yardFill = (t: Tile): Yard["fill"] | undefined => (t.yard ? (formOf(t).yard?.fill ?? "docks") : formOf(t).open);
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
  return { pitch: 0.75, height: 0.225 };
}

/** A wall's windows and doors (`roof.ts`), in tiles: a window's width and
 *  height, how far apart they stand and how far in from the wall's ends,
 *  their frames' width; a door's width and height; a shed's big door. */
export const OPENING = { wide: 0.06, high: 0.065, pitch: 0.15, end: 0.06, frame: 0.012, door: 0.07, doorHigh: 0.15, shedDoor: 0.26, shedHigh: 0.17 } as const;


/** Whether a shed wears a sawtooth roof, as a mill's or a works' does:
 *  ridges across it, each a slope up from the back to a glazed face
 *  toward its door, TOOTH high and about SPAN deep (`roof.ts`). */
export const sawtooth = (t: Tile) => SAWTOOTH.has(t.kind as BuildingKind);
const SAWTOOTH = new Set<BuildingKind>(["Factory", "Steelworks"]);
export const TOOTH = 0.14, SPAN = 0.55;

/** A lab's flat roof carries its plant, as a real one does: a lift room
 *  at one end, AC units at the other, vents along a side (`roof.ts`). */
export const planted = (t: Tile) => t.kind === "Lab";
/** A flat roof's parapet: how thick its wall, and how high above the roof. */
export const PARAPET_W = 0.045, PARAPET_H = 0.05;

/** Where a sign lies on a building's roof: how high; how far in from the
 *  walls the flat it lies on begins; and that it is painted on, as roof
 *  markings are. */
export function seat(t: Tile): { z: number; inset: number; painted: boolean } {
  const { pitch, height } = slope(t);
  return { z: eaves(t) + height, inset: height / pitch, painted: true };
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
const ALONE = new Set<BuildingKind>(["House", "Apartment", "Supermarket", "Depot", "Sawmill", "Quarry", "Harbour", "Farm", "Bakery", "CementWorks", "Mine", "Colliery", "Steelworks", "OilWell", "Refinery", "Port"]);

