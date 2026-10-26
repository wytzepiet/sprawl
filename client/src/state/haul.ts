import { buildingAt, eachEntity, getEntity } from "./gameObjects";
import { now } from "./sea";
import { goodsId } from "./selection";
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

/** How near a package a tap must land, in tiles: a finger's width at a
 *  town's zoom, half the way to the next good's bay. */
const REACH = 0.25;

/** The pile of goods under a point, on the pad of a building round it
 *  that your lorry can load from: the quay, a maker's yard, a depot's;
 *  as its id (`goodsId`). */
export function packageAt(x: number, y: number): number | null {
  let best: { id: number; d: number } | null = null;
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
          if (d < REACH && (!best || d < best.d)) best = { id: goodsId(e.id, bay.good), d };
        }
      }
    }
  return best?.id ?? null;
}

/** Whether a building takes a good from your lorry, as the server has it
 *  (`haul::takes`): a site short of it, the harbour, a depot with room. */
export function takes(id: number, good: Good): boolean {
  const e = getEntity(id);
  if (e?.object.kind !== "Building") return false;
  const b = e.object.data;
  if (b.site) return !!b.site[good] && b.site[good]!.level < b.site[good]!.cap;
  if (b.kind === "Harbour") return true;
  return b.kind === "Depot" && !!b.stocks[good] && b.stocks[good]!.level < b.stocks[good]!.cap;
}

/** Everywhere a pile could go, the nearest first. */
export function destinations(from: number, good: Good): number[] {
  now();
  const at = getEntity(from)?.position;
  const out: [number, number][] = [];
  eachEntity((e) => {
    if (e.id !== from && e.position && takes(e.id, good)) out.push([e.id, at ? Math.hypot(e.position.x - at.x, e.position.y - at.y) : 0]);
  });
  return out.sort((a, b) => a[1] - b[1]).map(([id]) => id);
}
