import { createSignal, For, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { neighbours } from "../state/missions";
import { sailingOf, sea, until, voyage } from "../state/sea";
import { setFollowing } from "../state/selection";
import { GoodIcon, GOODS } from "../blueprints";
import { Crest } from "./Missions";
import { coins } from "./kit";
import type { Good, Offer } from "../generated";
import type { Mayor } from "../generated/Mayor";

export const GOOD_ORDER: Good[] = ["Timber", "Stone", "Crates", "Fuel"];

/** A partner's crest; the world, the partner always there, has none. */
function Seal(props: { partner: Mayor | null; size: number }) {
  const n = () => props.partner && neighbours().find((n) => n.mayor === props.partner);
  return <Show when={n()}>{(n) => <Crest n={n()} size={props.size} />}</Show>;
}

const PinGlyph = (props: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={props.size ?? 11} height={props.size ?? 11} fill="currentColor"><path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z" /></svg>
);

/** A box on the deck or the quay: its good, who it is from or for, solid
 *  once it is real, a ghost while it is only booked, a pin if it comes
 *  every sailing. */
interface Tile {
  good: Good;
  partner: Mayor | null;
  ghost: boolean;
  pin: number | null;
}

function Box(props: { tile: Tile; onClick?: () => void }) {
  const c = () => GOODS[props.tile.good].color;
  return (
    <button
      class="press relative grid aspect-square place-items-center rounded-xl text-white"
      classList={{ "cursor-pointer": !!props.onClick, "cursor-default": !props.onClick }}
      style={props.tile.ghost ? { border: `2px dashed ${c()}`, color: c(), background: `${c()}18` } : { background: c(), "box-shadow": "0 2px 0 rgb(0 0 0 / 0.18)" }}
      onClick={() => props.onClick?.()}
    >
      <GoodIcon good={props.tile.good} width={22} height={22} />
      <span class="absolute -bottom-1 -right-1"><Seal partner={props.tile.partner} size={16} /></span>
      <Show when={props.tile.pin !== null}>
        <span class="absolute left-1 top-1" style={{ color: props.tile.ghost ? c() : "white" }}><PinGlyph size={10} /></span>
      </Show>
    </button>
  );
}

function Add(props: { open: boolean; onClick: () => void }) {
  return (
    <button
      class="press soft grid aspect-square place-items-center rounded-xl text-[22px] font-light cursor-pointer"
      style={{ border: "2px dashed rgb(var(--ink) / 0.2)", background: props.open ? "rgb(var(--ink) / 0.08)" : "transparent" }}
      onClick={props.onClick}
    >
      {props.open ? "×" : "+"}
    </button>
  );
}

/**
 * The harbour as a picture (docs/trade.md §The deck): the ferry on the
 * sea, coming in or at the ramp, its deck the boxes coming in; the quay
 * under it, the boxes going out; one number, the time to its next move.
 * A + opens the picker, goods and then partners, each a crest and a
 * price; a pinned box carries a pin, and a tap on it takes the pin off.
 */
export function Deck(props: { harbour: number }) {
  const { send, growth } = useGame();
  const sailing = () => sailingOf(props.harbour);
  const pins = () => sailing()?.pins ?? [];
  const pinOf = (good: Good, partner: Mayor | null, out: boolean) => pins().find((p) => p.good === good && p.partner === partner && p.out === out)?.id ?? null;
  const tile = (good: Good, partner: Mayor | null, out: boolean, ghost: boolean): Tile => ({ good, partner, ghost, pin: pinOf(good, partner, out) });
  const coming = (): Tile[] => {
    const real = sea.shipments.filter((s) => !s.outbound && s.good && (s.leg === "Booked" || s.leg === "Aboard")).map((s) => tile(s.good!, s.partner, false, s.leg === "Booked"));
    // A pin between boxes is still on the deck, as a ghost.
    const idle = pins().filter((p) => !p.out && !real.some((t) => t.pin === p.id)).map((p) => tile(p.good, p.partner, false, true));
    return [...real, ...idle];
  };
  const going = (): Tile[] => [
    ...sea.shipments.filter((s) => s.outbound && s.good && s.leg !== "Booked").map((s) => tile(s.good!, s.partner, true, false)),
    ...(sailing()?.outgoing ?? []).map((t) => tile(t.good, t.partner, true, true)),
  ];
  const owed = () => sea.shipments.filter((s) => !s.outbound && (s.leg === "Booked" || s.leg === "Aboard")).reduce((a, s) => a + s.price * s.units, 0);
  const box = (o: { good: Good; price: number }) => o.price * GOODS[o.good].box;
  const afford = (o: Offer) => o.out || growth().treasury - owed() >= box(o);

  const [picking, setPicking] = createSignal<boolean | null>(null);
  const [good, setGood] = createSignal<Good>("Timber");
  const [pinning, setPinning] = createSignal(false);
  const offers = () => sea.offers.filter((o) => o.good === good() && o.out === picking());
  const deal = (o: Offer) => send({ type: pinning() ? "Pin" : "Book", data: { harbour: props.harbour, good: o.good, partner: o.partner, out: o.out } });
  const unpin = (t: Tile) => t.pin !== null && send({ type: "Unpin", data: { harbour: props.harbour, pin: t.pin } });
  const toggle = (out: boolean) => setPicking(picking() === out ? null : out);

  const Picker = () => (
    <div class="mt-2 rounded-2xl p-2" style={{ background: "rgb(var(--ink) / 0.06)" }}>
      <div class="flex gap-1.5">
        <For each={GOOD_ORDER}>
          {(g) => (
            <button
              class="press grid h-9 flex-1 place-items-center rounded-xl cursor-pointer"
              style={{ background: good() === g ? GOODS[g].color : `${GOODS[g].color}2a`, color: good() === g ? "white" : GOODS[g].color }}
              onClick={() => setGood(g)}
            >
              <GoodIcon good={g} width={20} height={20} />
            </button>
          )}
        </For>
        <button
          class="press grid h-9 w-9 place-items-center rounded-xl cursor-pointer"
          style={{ background: pinning() ? "rgb(var(--ink) / 0.8)" : "transparent", color: pinning() ? "rgb(var(--glass))" : "rgb(var(--ink) / 0.5)" }}
          onClick={() => setPinning(!pinning())}
          title="Every sailing"
        >
          <PinGlyph size={15} />
        </button>
      </div>
      <div class="mt-2 flex flex-wrap gap-1.5">
        <For each={offers()}>
          {(o) => (
            <button
              class="press inline-flex h-9 items-center gap-1.5 rounded-full pl-1 pr-3 text-[15px] cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
              style={{ background: "rgb(var(--glass))", "box-shadow": "0 1px 3px rgb(0 0 0 / 0.15)" }}
              disabled={!afford(o)}
              onClick={() => deal(o)}
            >
              <Show when={o.partner} fallback={<span class="grid h-7 w-7 place-items-center rounded-full" style={{ background: "rgb(var(--ink) / 0.1)" }}><Globe /></span>}>
                <Seal partner={o.partner} size={28} />
              </Show>
              <span class="serif tabular-nums">{coins(o.out ? box(o) : -box(o))}</span>
              <Show when={o.boxes !== null}>
                <span class="soft inline-flex items-center gap-0.5 text-[12px]"><Letter />{o.boxes}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  );

  return (
    <Show when={sailing()}>
      {(s) => (
        <div class="px-3 pb-3 pt-1">
          {/* The sea, and the ferry on it: far off at sea, against the quay at the ramp. */}
          <div class="relative overflow-hidden rounded-2xl p-2 pb-3" style={{ background: "linear-gradient(180deg, #2B6CA344, #2B6CA322)" }}>
            <div class="mb-1 flex items-center justify-end gap-1.5">
              <button class="press soft cursor-pointer" onClick={() => setFollowing(s().ferry)} title="Follow the ferry"><Eye /></button>
              <span class="serif text-[24px] font-light tabular-nums leading-none">{until(s().berthed ? s().departs : s().arrives)}</span>
            </div>
            <div class="transition-transform duration-500 ease-out" style={{ transform: `translateY(${s().berthed ? 0 : -(1 - voyage(s())) * 10}px) scale(${s().berthed ? 1 : 0.94 + 0.06 * voyage(s())})`, opacity: s().berthed ? 1 : 0.75 + 0.25 * voyage(s()) }}>
              {/* The hull from above, bow up, its deck the boxes coming in. */}
              <div class="mx-auto w-[88%] p-2.5 pt-7" style={{ background: "rgb(var(--glass))", "clip-path": "polygon(50% 0, 100% 22px, 100% 100%, 0 100%, 0 22px)", "border-radius": "0 0 14px 14px", "box-shadow": "inset 0 0 0 2px rgb(var(--ink) / 0.12)" }}>
                <div class="grid grid-cols-4 gap-1.5">
                  <For each={coming()}>{(t) => <Box tile={t} onClick={t.pin !== null ? () => unpin(t) : undefined} />}</For>
                  <Add open={picking() === false} onClick={() => toggle(false)} />
                </div>
              </div>
            </div>
          </div>
          <Show when={picking() === false}><Picker /></Show>
          {/* The quay: what goes out waits here for the ferry. */}
          <div class="mt-2 rounded-2xl p-2" style={{ background: "repeating-linear-gradient(90deg, rgb(var(--ink) / 0.07) 0 22px, rgb(var(--ink) / 0.05) 22px 44px)" }}>
            <div class="grid grid-cols-5 gap-1.5">
              <For each={going()}>{(t) => <Box tile={t} onClick={t.pin !== null ? () => unpin(t) : undefined} />}</For>
              <Add open={picking() === true} onClick={() => toggle(true)} />
            </div>
          </div>
          <Show when={picking() === true}><Picker /></Show>
        </div>
      )}
    </Show>
  );
}

const Eye = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
);
const Globe = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></svg>
);
const Letter = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
);

/** The cheapest deal for a box of a good coming in, if any: what a site's
 *  card books with one tap. */
export const cheapest = (good: Good): Offer | undefined => sea.offers.find((o) => o.good === good && !o.out);
