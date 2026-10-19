import { createMemo, createSignal, For, Index, Show } from "solid-js";
import { getEntity, useGame } from "../state/gameObjects";
import { load, now, sea, until } from "../state/sea";
import { GOODS } from "../blueprints";
import { atHarbour, building, FollowBtn } from "./Harbour";
import { GOOD_ORDER } from "../state/deals";
import { Btn, coins, GoodDot, Section } from "./kit";
import type { Car, Good } from "../generated";

/** What another lorry costs from the world, and how many a depot may buy (`haul.rs`). */
const LORRY_PRICE = 40;
const MORE_LORRIES = 3;

/**
 * A depot's card: its lorries and what each is doing, another bought;
 * and each good's stock, what is on its way drawn faint beyond it. The
 * lorries go about their work of their own accord: what comes in and
 * goes out is booked on the ferry's deck, at the harbour.
 */
export function DepotPanel(props: { id: number; lorries: number[] }) {
  const { send, growth } = useGame();
  const b = building(props.id);
  const cars = createMemo(() => {
    now();
    return props.lorries.map((id) => {
      const e = getEntity(id);
      return { id, car: e?.object.kind === "Car" ? (e.object.data as Car) : null, at: e?.position ?? null };
    });
  });
  const [bought, setBought] = createSignal(false);
  const buy = () => {
    send({ type: "BuyLorry", data: { depot: props.id } });
    setBought(true);
    setTimeout(() => setBought(false), 1800);
  };

  return (
    <Show when={b()} fallback={<Section title="Depot"><div class="soft">Out of sight.</div></Section>}>
      {(d) => (
        <>
          <Section title={props.lorries.length > 1 ? `Lorries · ${props.lorries.length}` : "The lorry"}>
            <Index each={cars()}>
              {(l) => (
                <div class="flex items-baseline justify-between gap-2 py-0.5">
                  <span class="text-[14.5px] font-semibold first-letter:uppercase">{doing(props.id, l().car, l().at).words}</span>
                  <span class="flex shrink-0 items-baseline gap-2">
                    <Show when={doing(props.id, l().car, l().at).eta}>{(eta) => <span class="serif text-[18px] font-light tabular-nums">{until(eta())}</span>}</Show>
                    <FollowBtn id={l().id} />
                  </span>
                </div>
              )}
            </Index>
            <div class="mt-2.5 flex justify-end">
              <Btn onClick={buy} disabled={d().lorries >= MORE_LORRIES || growth().treasury < LORRY_PRICE} title={d().lorries >= MORE_LORRIES ? "The yard holds no more" : `Another lorry from the world, ${LORRY_PRICE} coins`}>
                <span class={bought() ? "pop" : ""}>{bought() ? "Bought ✓" : "+ lorry"}</span> <span class="soft font-normal">{coins(-LORRY_PRICE)}</span>
              </Btn>
            </div>
          </Section>
          <Section title="Stock">
            <For each={GOOD_ORDER.filter((g) => d().stocks[g])}>
              {(g) => <Shelf depot={props.id} good={g} level={d().stocks[g]!.level} cap={d().stocks[g]!.cap} />}
            </For>
          </Section>
        </>
      )}
    </Show>
  );
}

/** A depot's lorry in words, and when it is due. */
function doing(depot: number, car: Car | null, at: { x: number; y: number } | null): { words: string; eta: number | null } {
  if (!car) return { words: "out of sight", eta: null };
  const box = car.hitched;
  if (car.trip) {
    const home = car.trip.destination === depot;
    const words = home ? (box ? `bringing ${load(box)} home` : "coming home") : box ? `taking ${load(box)} to the harbour` : "on its way to the harbour";
    return { words, eta: car.trip.eta };
  }
  if (atHarbour(at)) return { words: "at the harbour, hitching up", eta: null };
  if (box && !box.outbound) return { words: `unloading ${load(box)}`, eta: null };
  return { words: box ? `in the yard with ${load(box)}` : "in the yard", eta: null };
}

/** A good's shelf: how full, and what is on its way drawn faint beyond it. */
function Shelf(props: { depot: number; good: Good; level: number; cap: number }) {
  const incoming = () => sea.shipments.filter((s) => (s.to === props.depot || s.to === null) && s.good === props.good && !s.outbound).reduce((a, s) => a + s.units, 0);
  const pct = (v: number) => `${Math.max(0, Math.min(1, v / props.cap)) * 100}%`;
  return (
    <div class="py-1.5">
      <div class="flex items-center gap-2">
        <GoodDot good={props.good} size={20} />
        <span class="font-semibold capitalize">{GOODS[props.good].label}</span>
        <span class="serif tabular-nums">{Math.floor(props.level)}<span class="soft text-xs"> / {props.cap}</span></span>
        <Show when={incoming() > 0}>
          <span class="soft text-[11px]">+{Math.round(incoming())} coming</span>
        </Show>
      </div>
      <div class="relative mt-2 mb-1 h-3.5 rounded-full" style={{ background: "rgb(var(--ink) / 0.09)" }}>
        <div class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out" style={{ width: pct(props.level), background: GOODS[props.good].color }} />
        <div
          class="absolute inset-y-0 rounded-r-full transition-[width,left] duration-500 ease-out"
          style={{ left: pct(props.level), width: `calc(${pct(props.level + incoming())} - ${pct(props.level)})`, background: `repeating-linear-gradient(135deg, ${GOODS[props.good].color}88 0 3px, transparent 3px 6px)` }}
        />
      </div>
    </div>
  );
}
