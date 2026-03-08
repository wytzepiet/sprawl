import { createSignal } from "solid-js";

const modes = ["select", "road", "demolish"] as const;
export type BuildMode = (typeof modes)[number];

const [buildMode, setBuildMode] = createSignal<BuildMode>("select");
const [roadOneWay, setRoadOneWay] = createSignal(false);
export { buildMode, setBuildMode, roadOneWay, setRoadOneWay };

// Building placement
const [placingBuilding, setPlacingBuilding] = createSignal<string | null>(null);
export { placingBuilding, setPlacingBuilding };
