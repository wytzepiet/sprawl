import { createSignal } from "solid-js";
import type { BuildingKind } from "../generated";

const modes = ["select", "road", "demolish"] as const;
export type BuildMode = (typeof modes)[number];

const [buildMode, setBuildMode] = createSignal<BuildMode>("select");
/** What the road tool draws: a street, a one-way street, or a road nothing fronts onto. */
export type RoadKind = "street" | "oneway" | "road";
const [roadKind, setRoadKind] = createSignal<RoadKind>("street");
export { buildMode, setBuildMode, roadKind, setRoadKind };

// Building placement
const [placingBuilding, setPlacingBuilding] = createSignal<BuildingKind | null>(null);
export { placingBuilding, setPlacingBuilding };
