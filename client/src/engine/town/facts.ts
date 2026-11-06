import { windowOf, type Town } from "./grid";
import { defaultJoins } from "./footprint";

/**
 * What a tile cannot see from its neighbours, worked out once over the
 * whole town before anything is drawn. Everything else about a tile's look
 * is a function of it, its neighbours and these facts: for now, which
 * buildings join (`defaultJoins`).
 */

export interface Facts {
  /** The town as drawn. */
  town: Town;
}

export function facts(painted: Town): Facts {
  return { town: { ...painted, joins: painted.joins ?? defaultJoins(painted) } };
}

/** A town's facts seen through a window from column x0, row y0, as
 *  `windowOf` sees the town: worked out over the whole town, not the
 *  window, so a building cut by the frame keeps its joins. */
export function windowFacts(known: Facts, x0: number, y0: number, w: number, h: number): Facts {
  return { town: windowOf(known.town, x0, y0, w, h) };
}
