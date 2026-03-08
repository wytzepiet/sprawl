import { createSignal } from "solid-js";
import type { BuildingType } from "../generated";

const modes = ["select", "road", "demolish"] as const;
export type BuildMode = (typeof modes)[number];

const [buildMode, setBuildMode] = createSignal<BuildMode>("select");
const [roadOneWay, setRoadOneWay] = createSignal(false);
export { buildMode, setBuildMode, roadOneWay, setRoadOneWay };

// Building placement
const [placingBuilding, setPlacingBuilding] = createSignal<BuildingType | null>(null);
export { placingBuilding, setPlacingBuilding };
