import { createSignal } from "solid-js";
import type { Mission } from "../generated";

/**
 * The town's open missions, and those just finished, as the last update had
 * them (docs/missions.md). The server reads every step; the client only
 * shows them.
 */
const [missions, setMissions] = createSignal<Mission[]>([], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
export { missions };

export function hearMissions(m: Mission[] | undefined) {
  setMissions(m ?? []);
}
