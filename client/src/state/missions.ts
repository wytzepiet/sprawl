import { createSignal } from "solid-js";
import type { Mission, Neighbour } from "../generated";

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

/** A mission's key as a name: an order's is its number. */
const keyOf = (m: Mission) => (typeof m.key === "object" ? `order ${m.key.Order}` : m.key);

/** The missions the feed shows: the opening while it runs, else the
 *  town's own, open and just finished. A mayor's letter is a deal. */
export const shownMissions = () => {
  const opening = missions().find((m) => m.key === "Opening" && m.finished === null);
  return opening ? [opening] : missions().filter((m) => m.from === null);
};
export const missionKey = (m: Mission) => `mission:${keyOf(m)}`;
