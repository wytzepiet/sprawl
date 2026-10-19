import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { projector } from "../engine/view";
import { getEntity } from "../state/gameObjects";
import { now, sea, tripOf } from "../state/sea";
import { following, positionOf, setFollowing } from "../state/selection";
import { GoodDot } from "./kit";
import type { Good, Shipment } from "../generated";

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
 * way is drawn where it is (`BoxPins`) and on the harbour's deck.
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

/**
 * Boxes on the map: over whatever carries them, the ferry, the tug, a
 * lorry, the harbour's park, a chip of each good aboard and how many. A
 * tap follows the first.
 */
export function BoxPins() {
  const { scene, canvas, afterRender } = useEngine();
  /** Carriers and what they carry, by good. */
  const shown = (s: Shipment) => s.carrier !== null && !!s.good && s.units > 0 && s.leg !== "Booked";
  const carried = createMemo(() => [...new Set(sea.shipments.filter(shown).map((s) => s.carrier!))].sort((a, b) => a - b), undefined, { equals: (a, b) => a.join() === b.join() });
  const goodsOn = (carrier: number) => {
    const l: { good: Good; boxes: number; trailer: number }[] = [];
    for (const s of sea.shipments) {
      if (s.carrier !== carrier || !shown(s)) continue;
      const g = l.find((x) => x.good === s.good);
      if (g) g.boxes++;
      else l.push({ good: s.good!, boxes: 1, trailer: s.trailer });
    }
    return l;
  };
  const els = new Map<number, HTMLElement>();
  const place = () => {
    if (!scene.camera) return;
    const project = projector(scene, canvas);
    for (const [id, el] of els) {
      const at = positionOf(id);
      const e = getEntity(id);
      if (!at || !e) {
        el.style.opacity = "0";
        continue;
      }
      // Over a building's roof, or a vehicle's.
      const { sx, sy } = project.at(at[0], at[1], e.object.kind === "Building" ? 0.6 : 0.3);
      el.style.opacity = "1";
      el.style.transform = `translate(${sx}px, ${sy}px)`;
    }
  };
  onCleanup(afterRender(place));
  return (
    <div class="fixed inset-0 z-[5] pointer-events-none select-none">
      <For each={carried()}>
        {(id) => (
          <div ref={(el) => { els.set(id, el); onCleanup(() => els.delete(id)); }} class="absolute left-0 top-0 transition-opacity duration-300" style={{ opacity: 0 }}>
            <div class="flex -translate-x-1/2 -translate-y-[130%] gap-0.5 rounded-full p-0.5 shadow-[0_1px_4px_rgba(0,0,0,0.3)] pointer-events-auto cursor-pointer" style={{ background: "rgb(var(--glass) / 0.85)" }} onClick={() => goodsOn(id)[0] && track(goodsOn(id)[0].trailer)}>
              <For each={goodsOn(id)}>
                {(g) => (
                  <span class="flex items-center">
                    <GoodDot good={g.good} size={16} />
                    <Show when={g.boxes > 1}>
                      <span class="ink px-0.5 text-[10px] font-bold tabular-nums">{g.boxes}</span>
                    </Show>
                  </span>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
