import { createSignal } from "solid-js";
import type { Mission } from "../generated";
import type { Neighbour } from "../generated/Neighbour";

/**
 * The town's open missions, and those just finished, as the last update had
 * them (docs/missions.md); and the mayors of the towns beyond the edge who
 * write some of them. The server reads every step; the client only shows
 * them.
 */
const same = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
const [missions, setMissions] = createSignal<Mission[]>([], { equals: same });
const [neighbours, setNeighbours] = createSignal<Neighbour[]>([], { equals: same });
export { missions, neighbours };

export function hearMissions(m: Mission[] | undefined, n: Neighbour[] | undefined) {
  setMissions(m ?? []);
  setNeighbours(n ?? []);
}

/** The town a box is marked for, by its order: the mayor who wrote it. */
export function markedFor(list: Mission[], all: Neighbour[], order: number): Neighbour | undefined {
  const m = list.find((m) => typeof m.key === "object" && m.key.Order === order);
  return m?.from ? all.find((n) => n.mayor === m.from) : undefined;
}
