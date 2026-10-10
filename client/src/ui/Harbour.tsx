import { createMemo, createSignal, For, Show } from "solid-js";
import { buildingAt, getEntity, useGame } from "../state/gameObjects";
import { clockAt, landsAt, now, plural, room, sailingOf, sea, turn, until, voyage } from "../state/sea";
import { setFollowing } from "../state/selection";
import { boxCost, GOODS } from "../blueprints";
import { Btn, coins, GoodDot, Section, Stepper, type Link } from "./kit";
import type { Building, Good, Rule, Sailing } from "../generated";

/** A depot as a harbour's or a site's card lists it (`card.rs`). */
export interface DepotLine {
  depot: Link;
  tiles: number;
  joined: boolean;
  /** Its lorry fetches without being sent. */
  standing: boolean;
  rules: Partial<Record<Good, Rule>>;
  stocks: Partial<Record<Good, number>>;
}

/** A building of the client's, read again four times a second. */
export const building = (id: number) =>
  createMemo(() => {
    now();
    const e = getEntity(id);
    return e?.object.kind === "Building" ? (e.object.data as Building) : null;
  });

export const ORDER: Good[] = ["Timber", "Stone", "Crates", "Fuel"];

/** What the town owes for boxes booked and at sea, paid as each lands. */
const owed = () => sea.shipments.filter((s) => !s.outbound && s.order !== 0 && (s.leg === "Booked" || s.leg === "Aboard") && s.good).reduce((a, s) => a + (s.units * GOODS[s.good!].price * 1.1), 0);

/** The ferry's timetable: where it is, when it moves, and a line of its voyage. */
export function Timetable(props: { sailing: Sailing }) {
  const s = () => props.sailing;
  const away = () => {
    const e = getEntity(s().ferry);
    return !s().berthed && !e?.position;
  };
  return (
    <div>
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-[15px] font-semibold">{s().berthed ? "At the ramp" : away() ? "Beyond the horizon" : "At sea"}</span>
        <span class="serif text-[22px] font-light tabular-nums"><span class="soft font-sans text-xs">{s().berthed ? "sails in " : "in "}</span>{s().berthed ? until(s().departs) : until(s().arrives)}</span>
      </div>
      <div class="soft text-xs">{s().berthed ? `sails ${clockAt(s().departs)}, back ${clockAt(s().departs + turn())}` : `in at ${clockAt(s().arrives)}, sails ${clockAt(s().departs)}`}</div>
      {/* The voyage: the sea from the horizon to the ramp, the ferry on it. */}
      <div class="relative mt-2.5 mb-1 h-3">
        <div class="absolute inset-x-0 top-[5px] h-[2px] rounded-full" style={{ background: "repeating-linear-gradient(to right, rgb(var(--ink) / 0.25) 0 4px, transparent 4px 8px)" }} />
        <div class="absolute left-0 top-[5px] h-[2px] rounded-full" style={{ width: `${voyage(s(), turn()) * 100}%`, background: s().berthed ? "#57A773" : "#2B6CA3" }} />
        <div
          class="absolute top-0 h-3 w-5 -translate-x-1/2 rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
          style={{ left: `${voyage(s(), turn()) * 100}%`, background: s().berthed ? "#57A773" : "#2B6CA3", transition: "left 0.25s linear" }}
        />
        <span class="soft absolute -bottom-3.5 left-0 text-[9px] uppercase tracking-wider">{s().berthed ? "in" : "sea"}</span>
        <span class="soft absolute -bottom-3.5 right-0 text-[9px] uppercase tracking-wider">{s().berthed ? "sails" : "ramp"}</span>
      </div>
      <div class="mt-4 flex flex-wrap gap-x-3 gap-y-0.5 text-[13px]">
        <span>
          <b class="tabular-nums">{s().boxes}</b> <span class="soft">{away() ? (s().boxes === 1 ? "box aboard" : "boxes aboard") : `of ${s().deck} on deck`}</span>
        </span>
        <Show when={s().settlers > 0}>
          <span>
            <b class="tabular-nums">{s().settlers}</b> <span class="soft">{s().settlers === 1 ? "settler" : "settlers"}</span>
          </span>
        </Show>
        <Show when={s().booked > 0}>
          <span>
            <b class="tabular-nums">{s().booked}</b> <span class="soft">booked</span>
          </span>
        </Show>
        <Show when={s().waiting > 0}>
          <span>
            <b class="tabular-nums">{s().waiting}</b> <span class="soft">{s().waiting === 1 ? "household waits" : "households wait"} over the sea</span>
          </span>
        </Show>
      </div>
    </div>
  );
}

/**
 * The harbour's card: the ferry's timetable, what stands in the trailer
 * park, and the order: a good, how many boxes, which depot, what it costs
 * and when it lands.
 */
export function HarbourPanel(props: { id: number; depots: DepotLine[] }) {
  const b = building(props.id);
  const sailing = () => sailingOf(props.id);
  /** The park's boxes, by good, and its empties. */
  const park = () => {
    const by = new Map<Good | null, { boxes: number; units: number; out: number }>();
    for (const slot of b()?.park ?? []) {
      const t = slot.trailer;
      if (!t) continue;
      const g = t.units > 0 ? t.good : null;
      const e = by.get(g) ?? { boxes: 0, units: 0, out: 0 };
      e.boxes++;
      e.units += t.units;
      if (t.outbound) e.out++;
      by.set(g, e);
    }
    return [...by.entries()];
  };
  const docks = () => b()?.park.length ?? 0;
  return (
    <>
      <Show when={sailing()} fallback={<Section title="The ferry"><div class="soft">No berth: the harbour's back is not on the sea.</div></Section>}>
        {(s) => (
          <Section title="The ferry" aside={<FollowBtn id={s().ferry} fallback={props.id} />}>
            <Timetable sailing={s()} />
          </Section>
        )}
      </Show>
      <Section title={`Trailer park · ${park().reduce((a, [, e]) => a + e.boxes, 0)} of ${docks()}`}>
        <Show when={park().length > 0} fallback={<div class="soft text-[13px]">Empty. Boxes off the ferry stand here till a lorry fetches them.</div>}>
          <div class="flex flex-wrap gap-1.5">
            <For each={park()}>
              {([good, e]) => (
                <span class="inline-flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2.5 text-[13px]" style={{ background: "rgb(var(--ink) / 0.07)" }}>
                  <Show when={good} fallback={<span class="grid h-[22px] w-[22px] place-items-center rounded-full text-[11px]" style={{ border: "1.5px dashed rgb(var(--ink) / 0.4)" }}>∅</span>}>
                    {(g) => <GoodDot good={g()} />}
                  </Show>
                  <b class="tabular-nums">{e.boxes}×</b>
                  <span class="soft">{good ? `${Math.round(e.units)} ${GOODS[good].label}` : "empty"}{e.out ? ", going out" : ""}</span>
                </span>
              )}
            </For>
          </div>
        </Show>
      </Section>
      <Order depots={props.depots} sailing={sailing()} />
    </>
  );
}

/** The eye: the camera to it, and after it as it goes. */
export function FollowBtn(props: { id: number; fallback?: number }) {
  return (
    <button
      class="press soft -my-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold cursor-pointer"
      style={{ border: "1.5px solid rgb(var(--ink) / 0.15)" }}
      onClick={() => setFollowing(getEntity(props.id)?.position || !props.fallback ? props.id : props.fallback)}
      title="Follow it"
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
      follow
    </button>
  );
}

/**
 * An order from the world: a good, a number of boxes, a depot, its price
 * and when it lands. Sent as `Order`; the boxes are on the shipments list
 * with the next update. The world takes no order the treasury cannot pay
 * for when it lands, so neither does the button.
 */
export function Order(props: { depots: DepotLine[]; sailing: Sailing | undefined; depot?: number; good?: Good; title?: string }) {
  const { send, growth } = useGame();
  const [good, setGood] = createSignal<Good>(props.good ?? "Timber");
  const [boxes, setBoxes] = createSignal(1);
  const [chosen, setChosen] = createSignal<number | null>(null);
  const depot = () => props.depot ?? chosen() ?? props.depots[0]?.depot.id ?? null;
  const cost = () => boxes() * boxCost(good());
  const can = () => Math.max(0, Math.floor((growth().treasury - owed()) / boxCost(good())));
  const [sent, setSent] = createSignal(0);
  const order = () => {
    const d = depot();
    if (d === null) return;
    send({ type: "Order", data: { depot: d, good: good(), boxes: boxes() } });
    setSent((n) => n + 1);
    setTimeout(() => setSent((n) => n - 1), 1600);
  };
  return (
    <Section title={props.title ?? "Order from the world"}>
      <Show when={depot() !== null} fallback={<div class="soft text-[13px]">Build a depot to order into: its lorry fetches what lands.</div>}>
        <div class="mb-2 flex gap-1.5">
          <For each={ORDER}>
            {(g) => (
              <button
                class="press flex flex-1 flex-col items-center gap-0.5 rounded-2xl py-1.5 text-[12px] font-semibold cursor-pointer"
                style={{ background: good() === g ? `${GOODS[g].color}33` : "rgb(var(--ink) / 0.05)", "box-shadow": good() === g ? `inset 0 0 0 2px ${GOODS[g].color}` : "none" }}
                onClick={() => setGood(g)}
              >
                <GoodDot good={g} size={26} />
                {GOODS[g].label}
                <span class="soft text-[10px] font-medium">{GOODS[g].box} a box</span>
              </button>
            )}
          </For>
        </div>
        <div class="flex items-center justify-between gap-2 py-1">
          <Stepper value={boxes()} set={setBoxes} min={1} max={15} />
          <span class="soft text-[13px]">
            {plural(boxes(), "box", "boxes")} · {boxes() * GOODS[good()].box} {GOODS[good()].label}
          </span>
        </div>
        <Show when={!props.depot && props.depots.length > 1}>
          <div class="flex items-center justify-between gap-2 py-1 text-[13px]">
            <span class="soft">to</span>
            <select
              class="rounded-full bg-transparent px-2 py-0.5 text-[13px] font-semibold cursor-pointer"
              style={{ border: "1.5px solid rgb(var(--ink) / 0.18)", color: "inherit" }}
              onChange={(e) => setChosen(Number(e.currentTarget.value))}
            >
              <For each={props.depots}>{(d, i) => <option value={d.depot.id} selected={d.depot.id === depot()}>Depot #{d.depot.id}{i() === 0 ? " (nearest)" : ""}, {d.tiles} tiles</option>}</For>
            </select>
          </div>
        </Show>
        <div class="mt-1 flex items-center justify-between gap-2">
          <div class="leading-tight">
            <div class="serif text-[20px] tabular-nums" classList={{ "text-red-500": boxes() > can() }}>{coins(-cost())}</div>
            <div class="soft text-[11px]">{props.sailing ? `lands ${clockAt(landsAt(props.sailing))}, in ${until(landsAt(props.sailing))}` : "no ferry yet"}</div>
          </div>
          <Btn big color={GOODS[good()].color} onClick={order} disabled={boxes() > can() || !props.sailing} title={boxes() > can() ? `The treasury pays for ${can()} now` : undefined}>
            <span class={sent() ? "pop" : ""}>{sent() ? "Booked ✓" : "Order"}</span>
          </Btn>
        </div>
        <Show when={boxes() > can()}>
          <div class="mt-1 text-[11px] text-red-500">The treasury pays for {plural(can(), "box", "boxes")} now.</div>
        </Show>
        <Show when={boxes() <= can() && room(depot(), good()) < boxes() * GOODS[good()].box}>
          <div class="soft mt-1 text-[11px]">The depot has room for {Math.max(0, Math.floor(room(depot(), good())))} {GOODS[good()].label}: the rest waits in the park.</div>
        </Show>
      </Show>
    </Section>
  );
}

/** The harbour a lorry is standing at, if any. */
export const atHarbour = (car: { x: number; y: number } | null) => {
  if (!car) return false;
  const b = buildingAt(car.x, car.y);
  return b?.object.kind === "Building" && (b.object.data as Building).kind === "Harbour";
};

