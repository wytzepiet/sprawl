import { createSignal } from "solid-js";
import { buildingAt, eachEntity, getEntity } from "./gameObjects";
import { now } from "./sea";
import { packagesOf, padOf, placeIn } from "../engine/objects/pads";
import { BLUEPRINTS } from "../blueprints";
import type { Car, Good } from "../generated";

/** The mayor's own lorry, the harbour's: what the hand drives until a
 *  depot's lorry takes over (`haul::mayors`). Read again with the sea. */
export function mayorsLorry(): { id: number; car: Car } | null {
  now();
  let found: { id: number; car: Car } | null = null;
  eachEntity((e) => {
    if (found || e.object.kind !== "Car" || e.object.data.role !== "Truck") return;
    const owner = getEntity(e.object.data.owner);
    if (owner?.object.kind === "Building" && owner.object.data.kind === "Harbour") found = { id: e.id, car: e.object.data };
  });
  return found;
}

/** The first standing building of a kind: where the guide's steps send
 *  the lorry from. */
export function standing(kind: string): number | null {
  let found: number | null = null;
  eachEntity((e) => {
    if (found === null && e.object.kind === "Building" && e.object.data.kind === kind && !e.object.data.site) found = e.id;
  });
  return found;
}

/** What the hand has picked up for your lorry: a good, from the pad it
 *  was tapped on (or the lorry itself, for what is aboard), and where on
 *  the map that was. The next tap on a building sends it there. */
export interface Carrying {
  from: number;
  good: Good;
  at: [number, number];
}
const [carrying, setCarrying] = createSignal<Carrying | null>(null);
export { carrying, setCarrying };

/** How near a package a tap must land, in tiles: a finger's width at a
 *  town's zoom, half the way to the next good's bay. */
const REACH = 0.25;

/** The package under a point, on the pad of a building round it that
 *  your lorry can load from: the quay, a maker's yard, a depot's. */
export function packageAt(x: number, y: number): Carrying | null {
  let best: (Carrying & { d: number }) | null = null;
  const seen = new Set<number>();
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const e = buildingAt(Math.floor(x) + dx, Math.floor(y) + dy);
      if (!e || seen.has(e.id) || e.object.kind !== "Building") continue;
      seen.add(e.id);
      const b = e.object.data;
      const kind = BLUEPRINTS[b.kind];
      if (b.site || !(kind.quay || kind.makes || b.kind === "Depot")) continue;
      for (const bay of padOf(b).bays) {
        const n = packagesOf(b, bay.good);
        for (let i = 0; i < n; i += bay.stack) {
          const at = placeIn(bay, i)[0].at;
          const d = Math.hypot(at[0] - x, at[1] - y);
          if (d < REACH && (!best || d < best.d)) best = { from: e.id, good: bay.good, at: [at[0], at[1]], d };
        }
      }
    }
  return best && { from: best.from, good: best.good, at: best.at };
}
