import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { neighbours } from "../state/missions";
import { sea, until } from "../state/sea";
import { deals, GOOD_ORDER, home, offerOf, picking, setPicking, setSpread, spread, type Deal } from "../state/deals";
import { GoodIcon, GOODS } from "../blueprints";
import { Crest } from "./Missions";
import { track } from "./Shipments";
import { coins } from "./kit";
import { Stack } from "./stack";
import type { Good, Offer } from "../generated";
import type { Mayor } from "../generated/Mayor";

const PICKER = "picker";
/** The page's height not the stack's: above it, the coins and the +;
 *  below it, the minimap. */
const ROOM_BELOW = 156 + 48 + 248;
type Item = Deal | { key: typeof PICKER };

/**
 * The town's trade as a stack of cards in the corner (docs/trade.md §The
 * deck), a card a deal: who with, what, how many boxes, a ring of how far
 * along they are and the time to their next move. Folded, the newest on
 * top and the rest peeking under it; a tap spreads them out, a tap on one
 * opens it to its boxes, each followed with a tap, and what can be done
 * with it: a box more, a pin to book it every sailing, a letter's boxes
 * accepted. A deal done shows its coins and slides away. The + opens a
 * card of new deals: a good, then who from or for, at their price.
 */
export default function Deals() {
  // Down to the minimap's top, and no further.
  const [room, setRoom] = createSignal(window.innerHeight - ROOM_BELOW);
  const fit = () => setRoom(window.innerHeight - ROOM_BELOW);
  window.addEventListener("resize", fit);
  onCleanup(() => window.removeEventListener("resize", fit));
  const items = (): Item[] => (picking() === null ? deals() : [{ key: PICKER }, ...deals()]);
  const [focus, setFocus] = createSignal<string | null>(null);
  /** Folded, a tap spreads the stack; spread, it opens the card tapped. */
  const tap = (key: string) => {
    if (!spread() && deals().length > 1 && picking() === null) return setSpread(true);
    setFocus(focus() === key ? null : key);
  };
  createEffect(() => deals().length < 2 && setSpread(false));
  return (
    <Show when={home() !== null}>
      <div class="pointer-events-none fixed right-6 top-[156px] z-30 w-[300px] select-none">
        <div class="mb-2 flex justify-end gap-1.5">
          <Show when={spread()}>
            <button data-glass="deals-bar" class="ink press pointer-events-auto grid h-10 w-10 place-items-center rounded-full cursor-pointer" onClick={() => (setSpread(false), setFocus(null))} title="Fold">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6" /></svg>
            </button>
          </Show>
          <button data-glass="deals-bar" class="ink press pointer-events-auto grid h-10 w-10 place-items-center rounded-full text-[24px] font-light leading-none cursor-pointer" onClick={() => setPicking(picking() === null ? false : null)} title="A new deal">
            <span class="transition-transform duration-300" style={{ transform: picking() === null ? "none" : "rotate(45deg)" }}>+</span>
          </button>
        </div>
        <Stack each={items()} key={(i) => i.key} open={spread()} room={room()} glass="deal" class="ink pointer-events-auto rounded-[20px]">
          {(item) => (
            <Show when={item().key !== PICKER} fallback={<Picker onDeal={(key) => (setPicking(null), setFocus(key))} />}>
              <Card deal={item() as Deal} open={focus() === item().key} onTap={() => tap(item().key)} />
            </Show>
          )}
        </Stack>
      </div>
    </Show>
  );
}

/** A partner's crest, or the world's globe; an envelope on it for a letter's deal. */
function Who(props: { partner: Mayor | null; size: number; letter?: boolean }) {
  const n = () => props.partner && neighbours().find((n) => n.mayor === props.partner);
  return (
    <span class="relative shrink-0">
      <Show when={n()} fallback={<span class="grid place-items-center rounded-full" style={{ width: `${props.size}px`, height: `${props.size}px`, background: "rgb(var(--ink) / 0.1)" }}><Globe size={props.size * 0.6} /></span>}>
        {(n) => <Crest n={n()} size={props.size} />}
      </Show>
      <Show when={props.letter}>
        <span class="absolute -bottom-1 -right-1.5 grid h-[17px] w-[17px] place-items-center rounded-full text-white" style={{ background: "#B7791F" }}><Letter size={11} /></span>
      </Show>
    </span>
  );
}

/** A good, which way it goes: a chip of its colour, an arrow in or out. */
function Chip(props: { good: Good; out: boolean }) {
  return (
    <span class="relative grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-white" style={{ background: GOODS[props.good].color }}>
      <GoodIcon good={props.good} width={19} height={19} />
      <span class="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full" style={{ background: "rgb(var(--glass))", color: "rgb(var(--ink))" }}>
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" style={{ transform: props.out ? "rotate(180deg)" : "none" }}><path d="M12 5v14M6 13l6 6 6-6" /></svg>
      </span>
    </span>
  );
}

/** How far along a deal is, round a ring in its good's colour; a tick once done. */
function Ring(props: { progress: number; color: string; done: boolean }) {
  const C = 2 * Math.PI * 11;
  return (
    <svg viewBox="0 0 28 28" width="28" height="28" class="shrink-0 -rotate-90">
      <circle cx="14" cy="14" r="11" fill="none" stroke="rgb(var(--ink) / 0.12)" stroke-width="3.5" />
      <circle cx="14" cy="14" r="11" fill="none" stroke={props.done ? "#57A773" : props.color} stroke-width="3.5" stroke-linecap="round" stroke-dasharray={`${C * Math.max(0.02, props.progress)} ${C}`} style={{ transition: "stroke-dasharray 0.6s ease" }} />
      <Show when={props.done}>
        <path class="tick" d="M9 14.5l3.5 3.5 6.5-7" fill="none" stroke="#57A773" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="rotate(90 14 14)" />
      </Show>
    </svg>
  );
}

function Card(props: { deal: Deal; open: boolean; onTap: () => void }) {
  const { send } = useGame();
  const d = () => props.deal;
  const color = () => GOODS[d().good].color;
  const count = () => d().boxes.length + d().wanted;
  const offer = () => offerOf(d().good, d().partner, d().out);
  const book = (n: number) => {
    const h = home();
    if (h === null) return;
    for (let i = 0; i < n; i++) send({ type: "Book", data: { harbour: h, good: d().good, partner: d().partner, out: d().out } });
  };
  const pin = () => {
    const h = home();
    if (h === null) return;
    const p = d().pin;
    if (p !== null) send({ type: "Unpin", data: { harbour: h, pin: p } });
    else send({ type: "Pin", data: { harbour: h, good: d().good, partner: d().partner, out: d().out } });
  };
  return (
    <div>
      <button class="flex w-full items-center gap-3 px-3 py-2.5 text-left cursor-pointer" onClick={props.onTap}>
        <Who partner={d().partner} size={32} letter={d().letter !== null} />
        <Chip good={d().good} out={d().out} />
        <span class="serif text-[19px] tabular-nums">×{count()}</span>
        <Show when={d().pin !== null}><span class="soft"><PinGlyph size={14} /></span></Show>
        <span class="flex-1" />
        <Show
          when={d().done}
          fallback={
            <>
              <Show when={d().eta}>{(t) => <span class="serif soft text-[15px] tabular-nums">{until(t())}</span>}</Show>
              <Ring progress={d().progress} color={color()} done={false} />
            </>
          }
        >
          <span class="pop serif text-[19px] font-semibold tabular-nums" style={{ color: d().coins >= 0 ? "#3F8F5C" : "rgb(var(--ink))" }}>{coins(d().coins)}</span>
          <Ring progress={1} color={color()} done />
        </Show>
      </button>
      <Show when={props.open && !d().done}>
        <div class="appear px-3 pb-3">
          <div class="flex flex-wrap gap-1.5">
            <For each={d().boxes}>
              {(b) => {
                const real = () => b.leg !== null && b.leg !== "Booked";
                return (
                  <button
                    class="press grid h-8 w-8 place-items-center rounded-[9px] text-white"
                    classList={{ "cursor-pointer": real(), "cursor-default": !real() }}
                    style={real() ? { background: color(), "box-shadow": "0 2px 0 rgb(0 0 0 / 0.18)" } : { border: `2px dashed ${color()}`, color: color(), background: `${color()}18` }}
                    onClick={() => real() && track(b.trailer)}
                    title={real() ? "Follow it" : undefined}
                  >
                    <GoodIcon good={d().good} width={17} height={17} />
                  </button>
                );
              }}
            </For>
            <For each={Array.from({ length: d().wanted })}>
              {() => <span class="h-8 w-8 rounded-[9px]" style={{ border: "2px dashed rgb(var(--ink) / 0.22)" }} />}
            </For>
          </div>
          <div class="mt-2.5 flex items-center gap-1.5">
            <Show when={d().boxes.length}>
              <span class="serif text-[17px] tabular-nums" style={{ color: d().coins >= 0 ? "#3F8F5C" : "rgb(var(--ink))" }}>{coins(d().coins)}</span>
            </Show>
            <span class="flex-1" />
            <Show when={d().wanted > 0 && offer()}>
              <button class="press inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[15px] font-semibold text-white cursor-pointer" style={{ background: "#B7791F" }} onClick={() => book(d().wanted)} title="Send what the letter asks">
                <Letter size={15} /> {coins(offer()!.price * GOODS[d().good].box * d().wanted)}
              </button>
            </Show>
            <Show when={d().wanted === 0 && offer() && d().key !== "gift"}>
              <button class="press soft grid h-9 w-9 place-items-center rounded-full text-[20px] font-light cursor-pointer" style={{ border: "2px dashed rgb(var(--ink) / 0.2)" }} onClick={() => book(1)} title="A box more">+</button>
            </Show>
            <Show when={d().letter === null && offer() && d().key !== "gift"}>
              <button
                class="press grid h-9 w-9 place-items-center rounded-full cursor-pointer"
                style={{ background: d().pin !== null ? "rgb(var(--ink) / 0.85)" : "transparent", color: d().pin !== null ? "rgb(var(--glass))" : "rgb(var(--ink) / 0.5)", border: d().pin !== null ? "none" : "2px solid rgb(var(--ink) / 0.15)" }}
                onClick={pin}
                title={d().pin !== null ? "Stop booking it every sailing" : "Book it every sailing"}
              >
                <PinGlyph size={15} />
              </button>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

/** New deals: which way, a good, then who from or for, each at its price
 *  a box; a tap books one. */
function Picker(props: { onDeal: (key: string) => void }) {
  const { send, growth } = useGame();
  const out = () => picking() === true;
  const [good, setGood] = createSignal<Good>("Timber");
  const offers = () => sea.offers.filter((o) => o.good === good() && o.out === out());
  const owed = () => sea.shipments.filter((s) => !s.outbound && (s.leg === "Booked" || s.leg === "Aboard")).reduce((a, s) => a + s.price * s.units, 0);
  const box = (o: Offer) => o.price * GOODS[o.good].box;
  const afford = (o: Offer) => o.out || growth().treasury - owed() >= box(o);
  const deal = (o: Offer) => {
    const h = home();
    if (h === null) return;
    send({ type: "Book", data: { harbour: h, good: o.good, partner: o.partner, out: o.out } });
    props.onDeal(`${o.out ? "out" : "in"}:${o.partner ?? "world"}:${o.good}`);
  };
  const Way = (p: { out: boolean }) => (
    <button
      class="press grid h-9 w-9 place-items-center rounded-full cursor-pointer"
      style={{ background: out() === p.out ? "rgb(var(--ink) / 0.85)" : "transparent", color: out() === p.out ? "rgb(var(--glass))" : "rgb(var(--ink) / 0.5)" }}
      onClick={() => setPicking(p.out)}
      title={p.out ? "Sell" : "Buy"}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style={{ transform: p.out ? "rotate(180deg)" : "none" }}><path d="M12 5v14M6 13l6 6 6-6" /></svg>
    </button>
  );
  return (
    <div class="p-3">
      <div class="flex items-center gap-1.5">
        <span class="flex rounded-full p-0.5" style={{ background: "rgb(var(--ink) / 0.07)" }}><Way out={false} /><Way out /></span>
        <span class="flex-1" />
        <For each={GOOD_ORDER}>
          {(g) => (
            <button
              class="press grid h-9 w-9 place-items-center rounded-[10px] cursor-pointer"
              style={{ background: good() === g ? GOODS[g].color : `${GOODS[g].color}2a`, color: good() === g ? "white" : GOODS[g].color }}
              onClick={() => setGood(g)}
            >
              <GoodIcon good={g} width={20} height={20} />
            </button>
          )}
        </For>
      </div>
      <div class="mt-2.5 flex min-h-9 flex-wrap gap-1.5">
        <For each={offers()}>
          {(o) => (
            <button
              class="press inline-flex h-9 items-center gap-1.5 rounded-full pl-1 pr-3 text-[15px] cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
              style={{ background: "rgb(var(--glass))", "box-shadow": "0 1px 3px rgb(0 0 0 / 0.15)" }}
              disabled={!afford(o)}
              onClick={() => deal(o)}
            >
              <Who partner={o.partner} size={28} letter={o.letter !== null} />
              <span class="serif tabular-nums">{coins(o.out ? box(o) : -box(o))}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

const PinGlyph = (props: { size: number }) => (
  <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="currentColor"><path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z" /></svg>
);
const Globe = (props: { size: number }) => (
  <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></svg>
);
const Letter = (props: { size: number }) => (
  <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
);
