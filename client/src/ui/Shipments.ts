import { createEffect, createSignal, untrack } from "solid-js";
import { now, sea, tripOf } from "../state/sea";
import { following, positionOf, setFollowing } from "../state/selection";
import type { Shipment } from "../generated";

/** The package the camera is after, wherever it is: on the ferry, the quay, the lorry. */
const [tracked, setTracked] = createSignal<number | null>(null);
/** What the camera was last set to follow for it, to tell a pan from a hand-over. */
let leading: number | null = null;
/** A lorry sent for a package on the quay, which the camera rides with until it has it. */
let fetching: number | null = null;

/** Where the camera should be for a package: its carrier, if that is on the
 *  map; else its harbour, the ferry being beyond the edge. */
function carrierOf(s: Shipment): number | null {
  if (s.carrier !== null && positionOf(s.carrier)) return s.carrier;
  return sea.sailings.find((x) => x.ferry === s.carrier)?.harbour ?? s.carrier;
}

/** Follow a package: the camera flies to what carries it and keeps with
 *  it, from ferry to quay to lorry, until the mayor pans or it lands. */
export function track(id: number, lorry: number | null = null) {
  const s = sea.shipments.find((x) => x.package === id);
  if (!s) return;
  setTracked(id);
  fetching = lorry;
  leading = lorry ?? carrierOf(s);
  setFollowing(leading);
}


/**
 * The camera after the package tracked, handed from carrier to carrier:
 * from ferry to quay to lorry, until the mayor pans or it lands. What is on its
 * way is drawn where it is (`Cargo.tsx`).
 */
export default function Shipments() {
  createEffect(() => {
    const t = tracked();
    if (t === null) return;
    now();
    const s = sea.shipments.find((x) => x.package === t);
    // Landed: the camera stays on the lorry in its yard.
    if (!s || (s.leg === "Yard" && !tripOf(s.carrier))) return setTracked(null);
    // Panned, or something else picked: the mayor has it.
    if (untrack(following) !== leading) return setTracked(null);
    if (fetching !== null && s.leg === "Quay") return;
    fetching = null;
    const next = carrierOf(s);
    if (next !== leading) setFollowing((leading = next));
  });
  return null;
}
