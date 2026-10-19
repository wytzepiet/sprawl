import { createMemo, For, Show } from "solid-js";
import { buildingAt, getEntity } from "../state/gameObjects";
import { clockAt, now, sailingOf, until, voyage } from "../state/sea";
import { setFollowing } from "../state/selection";
import { GOODS } from "../blueprints";
import { Deck } from "./Deck";
import { GoodDot, Section, type Link } from "./kit";
import type { Building, Good, Sailing } from "../generated";

/** A depot as a harbour's or a site's card lists it (`card.rs`). */
export interface DepotLine {
  depot: Link;
  tiles: number;
  joined: boolean;
  stocks: Partial<Record<Good, number>>;
}

/** A building of the client's, read again four times a second. */
export const building = (id: number) =>
  createMemo(() => {
    now();
    const e = getEntity(id);
    return e?.object.kind === "Building" ? (e.object.data as Building) : null;
  });

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
        <span class="text-[15px] font-semibold">{s().berthed ? "At the ramp" : away() ? "Beyond the edge" : "At sea"}</span>
        <span class="serif text-[22px] font-light tabular-nums"><span class="soft font-sans text-xs">{s().berthed ? "sails in " : "in "}</span>{s().berthed ? until(s().departs) : until(s().arrives)}</span>
      </div>
      <div class="soft text-xs">{s().berthed ? `sails ${clockAt(s().departs)}, back ${clockAt(s().lands)}` : `in at ${clockAt(s().arrives)}, sails ${clockAt(s().departs)}`}</div>
      {/* The voyage: the sea from the edge to the ramp, the ferry on it. */}
      <div class="relative mt-2.5 mb-1 h-3">
        <div class="absolute inset-x-0 top-[5px] h-[2px] rounded-full" style={{ background: "repeating-linear-gradient(to right, rgb(var(--ink) / 0.25) 0 4px, transparent 4px 8px)" }} />
        <div class="absolute left-0 top-[5px] h-[2px] rounded-full" style={{ width: `${voyage(s()) * 100}%`, background: s().berthed ? "#57A773" : "#2B6CA3" }} />
        <div
          class="absolute top-0 h-3 w-5 -translate-x-1/2 rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
          style={{ left: `${voyage(s()) * 100}%`, background: s().berthed ? "#57A773" : "#2B6CA3", transition: "left 0.25s linear" }}
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
 * The harbour's card: the ferry's timetable, its deck, and what stands in
 * the trailer park.
 */
export function HarbourPanel(props: { id: number }) {
  const b = building(props.id);
  const sailing = () => sailingOf(props.id);
  /** The park's boxes, by good. */
  const park = () => {
    const by = new Map<Good, { boxes: number; units: number; out: number }>();
    for (const slot of b()?.park ?? []) {
      const t = slot.trailer;
      if (!t) continue;
      const e = by.get(t.good) ?? { boxes: 0, units: 0, out: 0 };
      e.boxes++;
      e.units += t.units;
      if (t.outbound) e.out++;
      by.set(t.good, e);
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
      <Deck harbour={props.id} />
      <Section title={`Trailer park · ${park().reduce((a, [, e]) => a + e.boxes, 0)} of ${docks()}`}>
        <Show when={park().length > 0} fallback={<div class="soft text-[13px]">Empty. Boxes off the ferry stand here till a lorry fetches them.</div>}>
          <div class="flex flex-wrap gap-1.5">
            <For each={park()}>
              {([good, e]) => (
                <span class="inline-flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2.5 text-[13px]" style={{ background: "rgb(var(--ink) / 0.07)" }}>
                  <GoodDot good={good} />
                  <b class="tabular-nums">{e.boxes}×</b>
                  <span class="soft">{`${Math.round(e.units)} ${GOODS[good].label}`}{e.out ? ", going out" : ""}</span>
                </span>
              )}
            </For>
          </div>
        </Show>
      </Section>
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

/** The harbour a lorry is standing at, if any. */
export const atHarbour = (car: { x: number; y: number } | null) => {
  if (!car) return false;
  const b = buildingAt(car.x, car.y);
  return b?.object.kind === "Building" && (b.object.data as Building).kind === "Harbour";
};

