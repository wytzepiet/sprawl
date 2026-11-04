import { createSignal } from "solid-js";
import type { BuildingKind, Research } from "../generated";

/** What the town may build, and what its labs are learning, as the last
 *  update had it (docs/core.md §Unlocks). The server keeps the ladder. */
const same = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
const [research, setResearch] = createSignal<Research>({ open: [], next: [], at: null, done: 0, of: 0, cost: 0, roads: false }, { equals: same });
export { research };

export const hearResearch = (r: Research | undefined) => r && setResearch(r);

/** Where a kind stands: open to build, the labs' to learn next, or later. */
export const lockOf = (kind: BuildingKind): "open" | "next" | "later" =>
  research().open.includes(kind) ? "open" : research().next.includes(kind) ? "next" : "later";
