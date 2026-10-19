import { createEffect, createSignal, untrack } from "solid-js";
import { now, sea, tripOf } from "../state/sea";
import { following, positionOf, setFollowing } from "../state/selection";
import type { Shipment } from "../generated";

/** The box the camera is after, wherever it is: on the ferry, the tug, the lorry. */
const [tracked, setTracked] = createSignal<number | null>(null);
export { tracked };
/** What the camera was last set to follow for it, to tell a pan from a hand-over. */
let leading: number | null = null;
/** A lorry sent for a box in the park, which the camera rides with until it has it. */
let fetching: number | null = null;

/** Where the camera should be for a box: its carrier, if that is on the
 *  map; else its harbour, the ferry being beyond the edge. */
function carrierOf(s: Shipment): number | null {
  if (s.carrier !== null && positionOf(s.carrier)) return s.carrier;
  return sea.sailings.find((x) => x.ferry === s.carrier)?.harbour ?? s.carrier;
}

/** Follow a box: the camera flies to what carries it and keeps with it,
 *  from ferry to tug to lorry, until the mayor pans or it lands. */
export function track(trailer: number, lorry: number | null = null) {
  const s = sea.shipments.find((x) => x.trailer === trailer);
  if (!s) return;
  setTracked(trailer);
  fetching = lorry;
  leading = lorry ?? carrierOf(s);
  setFollowing(leading);
}


/**
 * The camera after the box tracked, handed from carrier to carrier: from
 * ferry to tug to lorry, until the mayor pans or it lands. What is on its
 * way is drawn where it is (`gpu/Pins.tsx`).
 */
export default function Shipments() {
  createEffect(() => {
    const t = tracked();
    if (t === null) return;
    now();
    const s = sea.shipments.find((x) => x.trailer === t);
    // Landed: the camera stays on the lorry in its yard.
    if (!s || (s.leg === "Yard" && !tripOf(s.carrier))) return setTracked(null);
    // Panned, or something else picked: the mayor has it.
    if (untrack(following) !== leading) return setTracked(null);
    if (fetching !== null && s.leg === "Parked") return;
    fetching = null;
    const next = carrierOf(s);
    if (next !== leading) setFollowing((leading = next));
  });
  return null;
}
