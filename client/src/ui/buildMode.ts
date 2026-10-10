import { createSignal } from "solid-js";
import type { Tool } from "../generated";
import type { Placing } from "../engine/may";

/** What the mayor's hand holds: a kind of road, a kind of building, or
 *  the demolisher; `null` is the bare hand, which selects. A drag with
 *  anything in hand lays it a step at a time (`Brush`). */
const [tool, setTool] = createSignal<Tool | null>(null);
export { tool, setTool };

/** The tools that lay road. */
export const ROADS = ["Street", "OneWay", "Road"] as const;
export const isRoad = (t: Tool | null) => (ROADS as readonly unknown[]).includes(t);

/** A harbour in hand over the map: where a tap would place it, which way
 *  it would face, and why it may not, if it may not (`may.ts` `placing`).
 *  The brush sets it; the ghosts draw it. */
const [aim, setAim] = createSignal<Placing | null>(null);
export { aim, setAim };
