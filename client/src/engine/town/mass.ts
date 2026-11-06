import type { BuildingKind } from "../../generated";
import { isBuilt, type Tile } from "./grid";

/**
 * What the look knows of each kind of building: its family, which kinds
 * join their neighbours, how tall its walls stand and how its roof
 * climbs. The facts a tile cannot see from its neighbours are
 * `facts.ts`'s, the shapes `footprint.ts`'s, the mesh `roof.ts`'s.
 */

/** Homes and the shops of a high street are one family; offices, sheds
 *  and big boxes each another. */
interface Form {
  family: string;
}
const STREET: Form = { family: "street" };
const INDUSTRY: Form = { family: "industry" };
// A farm is a farmyard, a model of its own (`objects/farm.ts`), its fence
// its own: no hedge round it.
const FARM: Form = { family: "farm" };
const FORMS: Partial<Record<BuildingKind, Form>> = {
  Fishery: INDUSTRY,
  Woodcutter: INDUSTRY,
  Sawmill: INDUSTRY,
  ClayPit: INDUSTRY,
  SandPit: INDUSTRY,
  Brickworks: INDUSTRY,
  Glassworks: INDUSTRY,
  Workshop: INDUSTRY,
  Farm: FARM,
  SheepFarm: FARM,
};
/** Kinds drawn whole from the kit (`objects/BuildingObject.tsx`): the
 *  town grid lays their ground and raises no walls of its own,
 *  and no sign lies on them, the model saying what it is. */
export const WHOLE: ReadonlySet<string> = new Set<BuildingKind>(["Shop", "House", "Fishery", "Woodcutter", "Sawmill", "Farm", "Bakery", "ClayPit", "Brickworks", "Workshop", "SandPit", "Glassworks", "SheepFarm", "Tailor"]);
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
const SAWTOOTH = new Set<BuildingKind>(["Workshop", "Glassworks"]);
export const TOOTH = 0.14, SPAN = 0.55;

/** A flat roof that carries plant, as a real one does (`roof.ts`): none yet. */
export const planted = (_t: Tile) => false;
/** A flat roof's parapet: how thick its wall, and how high above the roof. */
export const PARAPET_W = 0.045, PARAPET_H = 0.05;


/** Buildings that may join, where no stroke says: tiles of one kind, as
 *  the terrain's types are. A home, a big box and anything with a yard stand
 *  alone: placed whole, each is one building, never joined to the one
 *  beside it, so its tiles join only each other. */
export const kin = (a: Tile, b: Tile) =>
  isBuilt(a) && isBuilt(b) && a.kind === b.kind && (!alone(a) || a.id === b.id);
/** A kind placed whole, one building: it joins only itself, and never on
 *  the diagonal. */
export const alone = (t: Tile) => ALONE.has(t.kind as BuildingKind);
const ALONE = new Set<BuildingKind>(["House", "Shop", "Fishery", "Woodcutter", "Sawmill", "Farm", "Bakery", "ClayPit", "Brickworks", "Workshop", "SandPit", "Glassworks", "SheepFarm", "Tailor"]);

