import { eachEntity, getEntity } from "./gameObjects";
import { now } from "./sea";
import type { Car } from "../generated";

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
