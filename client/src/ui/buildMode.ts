import { createSignal } from "solid-js";
import type { BuildingKind, Category } from "../generated";

/**
 * The game has two states: watching the city, and changing it.
 *
 * There is no "select" tool any more — that was only ever the absence of one,
 * which is what view mode is.
 */
const [appMode, setAppMode] = createSignal<"view" | "build">("view");
export { appMode, setAppMode };

const tools = ["road", "zone", "demolish"] as const;
export type Tool = (typeof tools)[number];

const [tool, setTool] = createSignal<Tool>("zone");
export { tool, setTool };

/** The tool actually in effect, so drawers need not check the mode as well. */
export const activeTool = () => (appMode() === "build" ? tool() : null);

const [roadOneWay, setRoadOneWay] = createSignal(false);
export { roadOneWay, setRoadOneWay };

/** What the build brush lays down. Only read by the zone tool. */
const [paintCategory, setPaintCategory] = createSignal<Category>("Residential");
export { paintCategory, setPaintCategory };

// Building placement
const [placingBuilding, setPlacingBuilding] = createSignal<BuildingKind | null>(null);
export { placingBuilding, setPlacingBuilding };
