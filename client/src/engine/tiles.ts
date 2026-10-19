import type { GridCoord } from "../generated";

/** Which side of its tile a road stands (`decks::Side`): the step across
 *  it that it is moved by; `MIDDLE`, not moved. */
export type Side = [number, number];
export const MIDDLE: Side = [0, 0];

/** How far from its tile's middle a road on a side stands, in tiles
 *  (`decks::SIDE_OFFSET`). */
export const SIDE_OFFSET = 0.17;

/** The highest a road stands, in half-levels (`decks::TOP`). */
export const TOP = 6;

/** Where a road on a side of a tile stands (`World::node_pos`). */
export const spot = (t: GridCoord, [sx, sy]: Side = MIDDLE): [number, number] => {
  const by = sx || sy ? SIDE_OFFSET / Math.hypot(sx, sy) : 0;
  return [t.x + 0.5 + sx * by, t.y + 0.5 + sy * by];
};

/** The steps out of a tile, as the hand numbers them (`draw::STEPS`):
 *  east, and on round toward +y. */
export const STEPS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** The step a way points, as its index in `STEPS`. */
export function snap(dx: number, dy: number): number {
  return ((Math.round((Math.atan2(dy, dx) * 4) / Math.PI) % 8) + 8) % 8;
}
