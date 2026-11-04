import { createSignal } from "solid-js";
import type { Neighbour } from "../generated";

/** The mayors of the towns beyond the edge, as the last update had them:
 *  who a package comes from or goes to. */
const same = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
const [neighbours, setNeighbours] = createSignal<Neighbour[]>([], { equals: same });
export { neighbours };

export const hearNeighbours = (n: Neighbour[] | undefined) => setNeighbours(n ?? []);
