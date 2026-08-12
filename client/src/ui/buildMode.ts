import { createSignal } from "solid-js";
import type { BuildingKind, Category } from "../generated";

const modes = ["select", "road", "zone", "demolish"] as const;
export type BuildMode = (typeof modes)[number];

const [buildMode, setBuildMode] = createSignal<BuildMode>("select");
const [roadOneWay, setRoadOneWay] = createSignal(false);
export { buildMode, setBuildMode, roadOneWay, setRoadOneWay };

/** What the build brush lays down. Only read by the zone tool. */
const [paintCategory, setPaintCategory] = createSignal<Category>("Residential");
export { paintCategory, setPaintCategory };

// Building placement
const [placingBuilding, setPlacingBuilding] = createSignal<BuildingKind | null>(null);
export { placingBuilding, setPlacingBuilding };
