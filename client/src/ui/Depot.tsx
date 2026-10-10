import { createMemo, createSignal, For, Index, Show } from "solid-js";
import { getEntity, useGame } from "../state/gameObjects";
import { load, now, plural, sailingOf, sea, until } from "../state/sea";
import { boxSale, GOODS } from "../blueprints";
import { atHarbour, building, FollowBtn, ORDER, Order, type DepotLine } from "./Harbour";
import { Btn, coins, GoodDot, Section } from "./kit";
import { track } from "./Shipments";
import type { Car, Good, Rule } from "../generated";

/** The rule's lines, in their colours: keep above, fill to, sell over. */
const LINES = [
  { key: "keep", label: "keep above", color: "#E0A030" },
  { key: "fill", label: "fill to", color: "#57A773" },
  { key: "sell", label: "sell over", color: "#3B78B8" },
] as const;
type Line = (typeof LINES)[number]["key"];

/** What another lorry costs from the world, and how many a depot may buy (`haul.rs`). */
const LORRY_PRICE = 40;
const MORE_LORRIES = 3;

/**
 * A depot's card: its lorries, what each is doing and the tap that sends
 * one, another bought; standing orders; each good's stock with the top-up
 * rule drawn on the bar, its lines dragged or stepped; a box sold; and an
 * order.
 */
export function DepotPanel(props: { id: number; lorries: number[]; depots: DepotLine[] }) {
  const { send, growth } = useGame();
  const b = building(props.id);
  /** Boxes in a park waiting for this depot's lorries: its own, and the town's. */
  const parked = () => sea.shipments.filter((s) => s.leg === "Parked" && !s.outbound && (s.to === props.id || s.to === null));
  const waiting = () => parked().length;
  const harbour = () => sea.sailings[0]?.harbour ?? null;
  const cars = createMemo(() => {
    now();
    return props.lorries.map((id) => {
      const e = getEntity(id);
      return { id, car: e?.object.kind === "Car" ? (e.object.data as Car) : null, at: e?.position ?? null };
    });
  });
  const idle = () => cars().find((l) => l.car && !l.car.trip) ?? null;
  const [sent, setSent] = createSignal(false);
  const tap = () => {
    send({ type: "Send", data: { depot: props.id } });
    // The camera rides along, to the park and home with the first box.
    if (parked()[0]) track(parked()[0].trailer, idle()?.id ?? null);
    setSent(true);
    setTimeout(() => setSent(false), 1800);
  };
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
            <div class="mt-2.5 flex items-center gap-2">
              <Btn big color="#A0714A" onClick={tap} disabled={!idle()} class="flex-1">
                <span class={sent() ? "pop" : ""}>
                  {sent() ? "On its way ✓" : waiting() > 0 ? `Fetch ${plural(waiting(), "box", "boxes")}` : "Send to the harbour"}
                </span>
              </Btn>
              <Btn onClick={buy} disabled={d().lorries >= MORE_LORRIES || growth().treasury < LORRY_PRICE} title={d().lorries >= MORE_LORRIES ? "The yard holds no more" : `Another lorry from the world, ${LORRY_PRICE} coins`}>
                <span class={bought() ? "pop" : ""}>{bought() ? "Bought ✓" : "+ lorry"}</span> <span class="soft font-normal">{coins(-LORRY_PRICE)}</span>
              </Btn>
            </div>
            <label class="mt-2.5 flex cursor-pointer items-center gap-2.5 text-[13px]">
              <span
                class="relative inline-block h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-300"
                style={{ background: d().standing ? "#57A773" : "rgb(var(--ink) / 0.18)" }}
                onClick={() => send({ type: "Standing", data: { depot: props.id, on: !d().standing } })}
              >
                <span class="absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-[left] duration-300 ease-out" style={{ left: d().standing ? "19px" : "3px" }} />
              </span>
              <span onClick={() => send({ type: "Standing", data: { depot: props.id, on: !d().standing } })}>
                <b>Standing orders</b>
                <span class="soft"> {d().standing ? "· fetches what lands, takes out what sells" : "· goes when you tap it"}</span>
              </span>
            </label>
          </Section>
          <Section title="Stock">
            <For each={ORDER.filter((g) => d().stocks[g])}>
              {(g) => <Shelf depot={props.id} good={g} level={d().stocks[g]!.level} cap={d().stocks[g]!.cap} rule={d().rules[g] ?? null} selling={d().selling.filter((x) => x === g).length} />}
            </For>
          </Section>
          <Order depots={props.depots} depot={props.id} sailing={harbour() === null ? undefined : sailingOf(harbour()!)} title="Order in" />
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
    const what = !box ? "" : box.units > 0 && box.good ? load(box) : "an empty";
    const words = home ? (box && box.units > 0 ? `bringing ${what} home` : box ? "coming home with an empty" : "coming home") : box ? `taking ${what} to the harbour` : "on its way to the harbour";
    return { words, eta: car.trip.eta };
  }
  if (atHarbour(at)) return { words: "at the harbour, hitching up", eta: null };
  if (box && box.units > 0 && !box.outbound) return { words: `unloading ${load(box)}`, eta: null };
  return { words: box && box.units > 0 ? `in the yard with ${load(box)}` : box ? "in the yard, an empty on the hitch" : "in the yard", eta: null };
}

/**
 * A good's shelf: how full, what is on its way drawn faint beyond it, and
 * the rule's lines on the bar, each dragged along it or stepped beneath.
 */
function Shelf(props: { depot: number; good: Good; level: number; cap: number; rule: Rule | null; selling: number }) {
  const { send } = useGame();
  const box = () => GOODS[props.good].box;
  /** A line moved by hand and not yet heard back. */
  const [draft, setDraft] = createSignal<Rule | null>(null);
  const rule = () => draft() ?? props.rule;
  const incoming = () => sea.shipments.filter((s) => s.to === props.depot && s.good === props.good && !s.outbound).reduce((a, s) => a + s.units, 0);
  const pct = (v: number) => `${Math.max(0, Math.min(1, v / props.cap)) * 100}%`;
  /** Snapped to a tenth of a box. */
  const snap = (v: number) => Math.max(0, Math.min(props.cap, Math.round(v / (box() / 10)) * (box() / 10)));
  /** A rule kept in order: keep under fill under sell. */
  const set = (r: Rule, line: Line, v: number | null): Rule => {
    const next = { ...r, [line]: v };
    if (line === "keep" && v !== null) next.fill = Math.max(next.fill, v);
    if (line === "fill" && v !== null) next.keep = Math.min(next.keep, v);
    if (next.sell !== null && line !== "sell") next.sell = Math.max(next.sell, next.fill);
    if (line === "sell" && v !== null) next.fill = Math.min(next.fill, v), next.keep = Math.min(next.keep, next.fill);
    return next;
  };
  const commit = (r: Rule) => {
    setDraft(r);
    send({ type: "SetRule", data: { depot: props.depot, good: props.good, rule: r } });
    setTimeout(() => setDraft(null), 1500);
  };
  let bar!: HTMLDivElement;
  const drag = (line: Line) => (e: PointerEvent) => {
    const r = rule();
    if (!r) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const at = (ev: PointerEvent) => {
      const box = bar.getBoundingClientRect();
      return snap(((ev.clientX - box.left) / box.width) * props.cap);
    };
    let last = r;
    const move = (ev: PointerEvent) => setDraft((last = set(rule()!, line, at(ev))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      commit(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const canSell = () => props.level >= (props.selling + 1) * box() * 0.5;
  return (
    <div class="py-1.5">
      <div class="flex items-center gap-2">
        <GoodDot good={props.good} size={20} />
        <span class="font-semibold capitalize">{GOODS[props.good].label}</span>
        <span class="serif tabular-nums">{Math.floor(props.level)}<span class="soft text-xs"> / {props.cap}</span></span>
        <Show when={incoming() > 0}>
          <span class="soft text-[11px]">+{Math.round(incoming())} coming</span>
        </Show>
        <span class="flex-1" />
        <Btn onClick={() => send({ type: "Sell", data: { depot: props.depot, good: props.good } })} disabled={!canSell()} title={`A box of ${box()} to the world, for ${coins(boxSale(props.good))} coins`}>
          {props.selling ? `selling ${props.selling}` : "sell a box"} <span class="soft font-normal">{coins(boxSale(props.good))}</span>
        </Btn>
      </div>
      {/* The bar: the stock, what is coming, and the rule's lines. */}
      <div ref={bar} class="relative mt-2 mb-1 h-3.5 rounded-full" style={{ background: "rgb(var(--ink) / 0.09)" }}>
        <div class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out" style={{ width: pct(props.level), background: GOODS[props.good].color }} />
        <div
          class="absolute inset-y-0 rounded-r-full transition-[width,left] duration-500 ease-out"
          style={{ left: pct(props.level), width: `calc(${pct(props.level + incoming())} - ${pct(props.level)})`, background: `repeating-linear-gradient(135deg, ${GOODS[props.good].color}88 0 3px, transparent 3px 6px)` }}
        />
        <Show when={rule()}>
          {(r) => (
            <For each={LINES.filter((l) => r()[l.key] !== null)}>
              {(l) => (
                <div class="absolute -top-1 -bottom-1 w-4 -translate-x-1/2 cursor-ew-resize touch-none" style={{ left: pct(r()[l.key]!) }} onPointerDown={drag(l.key)} title={`${l.label} ${Math.round(r()[l.key]!)}: drag`}>
                  <div class="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full" style={{ background: l.color, "box-shadow": "0 0 0 1.5px rgb(var(--glass))" }} />
                  <div class="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full" style={{ background: l.color, "box-shadow": "0 0 0 1.5px rgb(var(--glass))" }} />
                </div>
              )}
            </For>
          )}
        </Show>
      </div>
      <Show
        when={rule()}
        fallback={
          <button class="soft text-[11px] underline cursor-pointer" onClick={() => commit({ keep: box(), fill: 2 * box() > props.cap ? props.cap : 2 * box(), sell: null })}>
            no rule: keep some in stock
          </button>
        }
      >
        {(r) => (
          <div class="mt-1.5 grid grid-cols-3 gap-1">
            <For each={LINES}>
              {(l) => (
                <div class="flex flex-col items-center">
                  <span class="soft flex items-center gap-1 text-[10px] font-semibold">
                    <span class="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />
                    {l.label}
                  </span>
                  <span class="inline-flex items-center gap-0.5">
                    <MiniStep onClick={() => commit(set(r(), l.key, r()[l.key] === null ? null : snap(r()[l.key]! - box() / 2)))} disabled={r()[l.key] === null || r()[l.key]! <= 0}>−</MiniStep>
                    <span class="serif w-8 text-center tabular-nums">{r()[l.key] === null ? "off" : Math.round(r()[l.key]!)}</span>
                    <MiniStep onClick={() => commit(set(r(), l.key, r()[l.key] === null ? snap(Math.max(r().fill, props.cap - box())) : r()[l.key]! >= props.cap && l.key === "sell" ? null : snap(r()[l.key]! + box() / 2)))} disabled={l.key !== "sell" && r()[l.key]! >= props.cap}>
                      {l.key === "sell" && (r().sell === null ? false : r().sell! >= props.cap) ? "×" : "+"}
                    </MiniStep>
                  </span>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}

function MiniStep(props: { onClick: () => void; disabled?: boolean; children: string }) {
  return (
    <button class="press grid h-5 w-5 place-items-center rounded-full text-[13px] font-bold leading-none cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed" style={{ border: "1.5px solid rgb(var(--ink) / 0.16)" }} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  );
}
