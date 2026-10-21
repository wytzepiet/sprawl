import { createSignal } from "solid-js";
import type { BuildingKind, Tool } from "../generated";
import type { Placing } from "../generated";

/** What the mayor's hand holds: a kind of road or the demolisher; `null`
 *  is the bare hand, which selects. A drag with a tool lays it a step at
 *  a time (`Brush`). */
const [tool, setToolSignal] = createSignal<Tool | null>(null);
export { tool };

/** A building in hand, dragged from the build menu: its kind, and the way
 *  the hand has turned it; `null`, it turns itself to the street. Let go
 *  on the map, it is placed whole (`Brush`). */
export interface Held {
  kind: BuildingKind;
  facing: number | null;
}
const [held, setHeld] = createSignal<Held | null>(null);
export { held };

/** Take up a tool, putting down any building. */
export const setTool = (t: Tool | null) => (setHeld(null), setToolSignal(t));
/** Take up a building, putting down any tool: turned this way, or left
 *  to turn itself. */
export const hold = (kind: BuildingKind | null, facing: number | null = null) => (setToolSignal(null), setHeld(kind ? { kind, facing } : null));
/** The building in hand turned a quarter, the way it faces then its own
 *  from now on. */
export const turn = (by: number) => {
  const h = held();
  if (h) setHeld({ ...h, facing: ((((h.facing ?? aim()?.facing ?? 2) + by) % 4) + 4) % 4 });
};
/** Whether anything is in hand: the camera and the picker leave the
 *  pointer to it. */
export const inHand = () => tool() !== null || held() !== null;

/** Where the building in hand would be placed if let go now, which way
 *  it would face, and why it may not, if it may not, as the game says
 *  (`World::placing`). The brush sets it; the town draws it, and the hand's label
 *  says it. */
const [aim, setAim] = createSignal<Placing | null>(null);
export { aim, setAim };

/** A building let go, from then until the server's word on it comes
 *  back, the building or a refusal: the trees under it make way at once,
 *  as they do under one in hand. */
const [placed, setPlaced] = createSignal<Placing | null>(null);
export { placed, setPlaced };

/** Whether the road the hand lays has priority (`Build.road`): whoever
 *  joins or crosses it gives way. Drawn along a road, it gives it that, or
 *  takes it. */
const [priority, setPriority] = createSignal(false);
export { priority, setPriority };
