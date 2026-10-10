import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { useEngine } from "../engine/Canvas";
import { projector } from "../engine/view";
import { getEntity } from "../state/gameObjects";
import { legWords, LEGS, load, now, plural, sea, tripOf, until } from "../state/sea";
import { following, positionOf, setFollowing } from "../state/selection";
import { GOODS } from "../blueprints";
import { GoodDot } from "./kit";
import type { Good, Shipment } from "../generated";

/** The starter pack's order: the world's gift (`sea.rs` GIFT). */
const GIFT = 0;

/** The box the camera is after, wherever it is: on the ferry, the tug, the lorry. */
const [tracked, setTracked] = createSignal<number | null>(null);
export { tracked };
/** What the camera was last set to follow for it, to tell a pan from a hand-over. */
let leading: number | null = null;
/** A lorry sent for a box in the park, which the camera rides with until it has it. */
let fetching: number | null = null;

/** Where the camera should be for a box: its carrier, if that is on the
 *  map; else its harbour, the ferry being beyond the horizon. */
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
 * Everything on its way, a compact pane of glass under the purse: grouped
 * by order, each box with what is in it, where it is going and where it
 * is now, in words, and when it moves on. A tap follows the box. The
 * starter pack says so. Folds away to its heading.
 */
export default function Shipments() {
  // The camera after the box tracked, handed from carrier to carrier.
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
  const [open, setOpen] = createSignal(true);
  /** Orders, the gift first, then oldest first: by number alone, so a line stays put. */
  const orders = createMemo(() => [...new Set(sea.shipments.map((s) => s.order))].sort((a, b) => a - b), undefined, { equals: (a, b) => a.join() === b.join() });
  const count = () => sea.shipments.length;
  return (
    <Show when={count() > 0}>
      <div data-glass="ships" class="ink fixed top-[128px] right-6 z-30 w-[300px] max-h-[calc(100vh-17rem)] overflow-y-auto rounded-[22px] text-sm select-none">
        <button class="flex w-full items-center gap-2 px-4 py-2.5 text-left cursor-pointer" onClick={() => setOpen((o) => !o)}>
          <span class="soft text-[10px] font-bold uppercase tracking-widest opacity-80">On its way</span>
          <span class="rounded-full px-1.5 text-[11px] font-bold tabular-nums text-white" style={{ background: "#2B6CA3" }}>{count()}</span>
          <span class="flex-1" />
          <svg class="soft transition-transform duration-300" style={{ transform: `rotate(${open() ? 180 : 0}deg)` }} viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <Show when={open()}>
          <div class="pb-2">
            <For each={orders()}>{(order) => <OrderLines order={order} />}</For>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function OrderLines(props: { order: number }) {
  const boxes = () => sea.shipments.filter((s) => s.order === props.order);
  const first = () => boxes()[0];
  /** Boxes alike and together, one line: three of timber in the park. */
  const alike = createMemo(() => [...new Set(boxes().map(alikeKey))], undefined, { equals: (a, b) => a.join() === b.join() });
  const goods = () => [...new Set(boxes().map((s) => s.good).filter((g): g is Good => g !== null))];
  const to = () => {
    const s = first();
    if (!s) return "";
    if (s.outbound) return "to the world";
    return s.to === null ? "for the town" : `to the depot #${s.to}`;
  };
  const title = () => {
    if (props.order === GIFT) return "The starter pack";
    const units = boxes().reduce((a, s) => a + s.units, 0);
    const g = goods();
    return g.length === 1 ? `${Math.round(units)} ${GOODS[g[0]].label}` : plural(boxes().length, "box", "boxes");
  };
  return (
    <div class="px-3 pt-1.5">
      <div class="flex items-baseline gap-1.5 px-1">
        <span class="text-[13px] font-semibold">{title()}</span>
        <span class="soft text-[11px]">{props.order === GIFT ? "the world's gift · " : first()?.outbound ? "sold · " : ""}{to()}</span>
      </div>
      <For each={alike()}>{(key) => <BoxLine boxes={() => boxes().filter((s) => alikeKey(s) === key)} />}</For>
    </div>
  );
}

const alikeKey = (s: Shipment) => `${s.good}|${s.units}|${s.leg}|${s.carrier}|${s.outbound}`;

function BoxLine(props: { boxes: () => Shipment[] }) {
  const first = () => props.boxes()[0];
  const n = () => props.boxes().length;
  const w = () => legWords(first());
  const step = () => LEGS.indexOf(first().leg);
  const on = () => props.boxes().some((s) => s.trailer === tracked());
  return (
    <Show when={first()}>
    <button
      class="flex w-full items-center gap-2 rounded-2xl px-1.5 py-1 text-left transition-colors duration-200 cursor-pointer hover:bg-[rgb(var(--ink)/0.06)]"
      style={on() ? { background: "rgb(var(--ink) / 0.09)", "box-shadow": "inset 0 0 0 1.5px #2B6CA3" } : {}}
      onClick={() => (on() ? setTracked(null) : track(first().trailer))}
      title="Follow it"
    >
      <Show when={first().good && first().units > 0} fallback={<span class="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full text-[11px]" style={{ border: "1.5px dashed rgb(var(--ink) / 0.4)" }}>∅</span>}>
        <GoodDot good={first().good!} />
      </Show>
      <div class="min-w-0 flex-1 leading-tight">
        <div class="text-[12.5px]">
          <Show when={n() > 1}><b class="tabular-nums">{n()} × </b></Show><b class="tabular-nums">{load(first())}</b> <span class="soft">{w().words}</span>
        </div>
        {/* The legs, in from the world: booked, at sea, parked, hauled, home. */}
        <Show when={!first().outbound}>
          <div class="mt-1 flex gap-[3px]">
            <For each={LEGS}>
              {(_, i) => <span class="h-1 flex-1 rounded-full transition-colors duration-500" style={{ background: i() <= step() ? (first().good ? GOODS[first().good!].color : "#888") : "rgb(var(--ink) / 0.1)" }} />}
            </For>
          </div>
        </Show>
      </div>
      <Show when={w().eta}>{(eta) => <span class="serif shrink-0 text-[15px] tabular-nums">{until(eta())}</span>}</Show>
      <Show when={on()}>
        <svg class="shrink-0" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#2B6CA3" stroke-width="2.6" stroke-linecap="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
      </Show>
    </button>
    </Show>
  );
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
