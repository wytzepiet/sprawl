import { createSignal } from "solid-js";
import { getEntity } from "./gameObjects";
import { plot } from "../blueprints";
import type { Building } from "../generated";

/** The thing whose card is open, if any. */
const [selected, setSelected] = createSignal<number | null>(null);
/**
 * What the camera keeps in view: the selected thing, or where a resident is
 * standing or riding. A pan lets go of it; picking something takes hold again.
 */
const [following, setFollowing] = createSignal<number | null>(null);
/** What the pointer is over, when it is over something. */
const [hovered, setHovered] = createSignal<number | null>(null);
/**
 * What on the map stands for the selection: the thing itself, or, for a
 * resident, who has no body of their own, the car or building they are in.
 * The card sets it once it knows.
 */
const [subject, setSubject] = createSignal<number | null>(null);
export { selected, following, setFollowing, hovered, setHovered, subject, setSubject };

export function select(id: number | null) {
  setSelected(id);
  setSubject(id);
  setFollowing(id);
}

/** Where every car is drawn this frame, by id — the cars' own record, so a
 *  click on the map can find the one under it without asking the scene. */
export const carPoses = new Map<number, [number, number]>();

/** One thin instance in the pool: the bucket it is in and its id there. */
export interface Part {
  key: string;
  id: number;
}
/**
 * What each thing is drawn as: the instances that are its body, a car's
 * box or a building's solid, not its lot. Registered as they are mounted,
 * so the highlight can trace the very mesh on screen.
 */
export const parts = new Map<number, Part[]>();

/**
 * Where a thing on the map is this frame, if the client can see it: a car
 * where it is drawn, a building over its roof rather than its lot. A
 * resident has no place of their own; ask about where they are instead.
 */
export function positionOf(id: number): [number, number] | null {
  const car = carPoses.get(id);
  if (car) return car;
  const e = getEntity(id);
  if (e?.object.kind === "Building" && e.position) {
    const b = e.object.data as Building;
    const [[bx, by], [bw, bh]] = plot(b.kind, b.facing).building;
    return [e.position.x + bx + bw / 2, e.position.y + by + bh / 2];
  }
  return null;
}

/** The car nearest a ground point, if one is within `radius` tiles. */
export function carNear(wx: number, wy: number, radius: number): number | null {
  let best: number | null = null;
  let bestD = radius * radius;
  for (const [id, [x, y]] of carPoses) {
    const d = (x - wx) * (x - wx) + (y - wy) * (y - wy);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}
