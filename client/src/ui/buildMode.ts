import { createSignal } from "solid-js";
import type { BuildingKind } from "../generated";

const modes = ["select", "road", "demolish"] as const;
export type BuildMode = (typeof modes)[number];

const [buildMode, setBuildMode] = createSignal<BuildMode>("select");
const [roadOneWay, setRoadOneWay] = createSignal(false);
export { buildMode, setBuildMode, roadOneWay, setRoadOneWay };

// Building placement
const [placingBuilding, setPlacingBuilding] = createSignal<BuildingKind | null>(null);
export { placingBuilding, setPlacingBuilding };
