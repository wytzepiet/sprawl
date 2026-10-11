import { windowOf, type Town } from "./grid";
import { formOf, yardFill, type Yard } from "./mass";
import { defaultJoins } from "./footprint";

/**
 * What a tile cannot see from its neighbours, worked out once over the
 * whole town before anything is drawn. Everything else about a tile's look
 * is a function of it, its neighbours and these facts.
 *
 * - **Yards**: the tiles the server lays a building's lot in
 *   (`Tile.yard`, `World::yard_of`), paved: the rows on its street side,
 *   its whole width, so the rest of it is a rectangle. A depot's yard
 *   holds lorries at docks either side of a lane in from its gate
 *   (`dressing.ts`).
 * - **Harbours**: all yard, a trailer park, its slots the game's own
 *   (`Building.park`), painted on by the town (`TownLayer`).
 */

export interface Facts {
  /** The town as drawn: the painted one with its yards open ground. */
  town: Town;
  /** What stands in a tile of yard, if it is one. */
  yard(c: number, r: number): Yard["fill"] | undefined;
}

export function facts(painted: Town): Facts {
  const yard = (c: number, r: number) => yardFill(painted.tile(c, r));
  // The yard is open ground, but the building keeps its joins, so the
  // walls round its yard stand square.
  const open: Town = {
    ...painted,
    joins: painted.joins ?? defaultJoins(painted),
    tile: (c, r) => (yard(c, r) ? { kind: "paved", storeys: 0 } : painted.tile(c, r)),
  };
  return {
    town: open,
    yard,
  };
}

/** A town's facts seen through a window from column x0, row y0, as
 *  `windowOf` sees the town: worked out over the whole town, not the
 *  window, so a building cut by the frame keeps its yard. */
export function windowFacts(known: Facts, x0: number, y0: number, w: number, h: number): Facts {
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < w && r < h;
  return {
    town: windowOf(known.town, x0, y0, w, h),
    yard: (c, r) => (inside(c, r) ? known.yard(c + x0, r + y0) : undefined),
  };
}
