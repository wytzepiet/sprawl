import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { neighbours } from "../state/missions";
import { sea, until } from "../state/sea";
import { deals, GOOD_ORDER, home, offerOf, picking, setPicking, setSpread, spread, stepsOf, type Deal } from "../state/deals";
import { GoodIcon, GOODS } from "../blueprints";
import { Crest } from "./Missions";
import { track } from "./Shipments";
import { coins, GoodDot } from "./kit";
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
 * deck), a card a deal: what, from or for whom, where its furthest box
 * is, in words and on a bar of the steps of its way, and the time to its
 * next move. Folded, the newest on
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
        <Stack each={items()} key={(i) => i.key} open={spread()} room={room()} keep={focus()} glass="deal" class="ink pointer-events-auto rounded-[20px]">
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

/** Who a deal is with, in words: a mayor's name, or the world. */
const nameOf = (partner: Mayor | null) => (partner && neighbours().find((n) => n.mayor === partner)?.name) ?? "the world";

/** A deal's way, cut into its steps, filled to where its furthest box is. */
function Steps(props: { steps: number; at: number; color: string }) {
  return (
    <div class="flex gap-[3px]">
      <For each={Array.from({ length: props.steps })}>
        {(_, i) => <span class="h-1.5 flex-1 rounded-full transition-colors duration-500" style={{ background: i() <= props.at ? props.color : "rgb(var(--ink) / 0.1)" }} />}
      </For>
    </div>
  );
}

function Card(props: { deal: Deal; open: boolean; onTap: () => void }) {
  const { send } = useGame();
  const d = () => props.deal;
  const color = () => (d().done ? "#57A773" : GOODS[d().good].color);
  const lead = () => d().boxes[0];
  const count = () => d().boxes.length + d().wanted;
  const offer = () => offerOf(d().good, d().partner, d().out);
  const title = () => (d().key === "gift" ? "The starter pack" : `${GOODS[d().good].label[0].toUpperCase()}${GOODS[d().good].label.slice(1)} ${d().out ? "for" : "from"} ${nameOf(d().partner)}`);
  /** Where it is, in words: its furthest box, or what it waits for. */
  const status = () => {
    if (d().done) return d().out ? "sold, and paid for" : "in the depot";
    const l = lead();
    if (l) return l.words;
    if (d().wanted) return `wants ${d().wanted} ${d().wanted === 1 ? "box" : "boxes"}`;
    return "booked again as the ferry sails";
  };
  const when = () => (d().done ? null : lead()?.eta ?? (lead() ? null : d().due));
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
      <button class="block w-full px-3 pb-3 pt-2.5 text-left cursor-pointer" onClick={props.onTap}>
        <div class="flex items-center gap-2.5">
          <span class="relative grid h-9 w-9 shrink-0 place-items-center rounded-[11px] text-white" style={{ background: GOODS[d().good].color }}>
            <GoodIcon good={d().good} width={21} height={21} />
            <span class="absolute -bottom-1.5 -right-1.5"><Who partner={d().partner} size={20} letter={d().letter !== null} /></span>
          </span>
          <div class="min-w-0 flex-1 leading-tight">
            <div class="flex items-center gap-1.5 text-[14.5px] font-semibold">
              <span class="truncate">{title()}</span>
              <Show when={count() > 1}><span class="soft shrink-0 tabular-nums">×{count()}</span></Show>
              <Show when={d().pin !== null}><span class="soft shrink-0" title="Booked every sailing"><PinGlyph size={13} /></span></Show>
            </div>
            <div class="soft mt-0.5 truncate text-[12.5px]">{status()}</div>
          </div>
          <Show when={d().done} fallback={<Show when={when()}>{(t) => <span class="serif shrink-0 text-[17px] tabular-nums">{until(t())}</span>}</Show>}>
            <span class="pop serif shrink-0 text-[18px] font-semibold tabular-nums" style={{ color: d().coins >= 0 ? "#3F8F5C" : "rgb(var(--ink))" }}>{coins(d().coins)}</span>
          </Show>
        </div>
        <div class="mt-2"><Steps steps={stepsOf(d().out)} at={d().done ? Infinity : lead()?.step ?? -1} color={color()} /></div>
      </button>
      <Show when={props.open && !d().done}>
        <div class="appear px-3 pb-3">
          <For each={d().boxes}>
            {(b) => (
              <button
                class="flex w-full items-center gap-2 rounded-xl px-1 py-1 text-left text-[13px]"
                classList={{ "cursor-pointer hover:bg-[rgb(var(--ink)/0.06)]": b.seen, "cursor-default": !b.seen }}
                onClick={() => b.seen && track(b.trailer)}
              >
                <GoodDot good={d().good} size={20} />
                <span class="min-w-0 flex-1 truncate">{b.words}</span>
                <Show when={b.eta}>{(t) => <span class="serif tabular-nums">{until(t())}</span>}</Show>
                <Show when={b.seen}><span class="soft" title="Follow it"><Eye /></span></Show>
              </button>
            )}
          </For>
          <div class="mt-2 flex items-center gap-1.5">
            <Show when={d().boxes.length}>
              <span class="serif text-[17px] tabular-nums" style={{ color: d().coins >= 0 ? "#3F8F5C" : "rgb(var(--ink))" }}>{coins(d().coins)}</span>
            </Show>
            <span class="flex-1" />
            <Show when={d().wanted > 0 && offer()}>
              <button class="press inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold text-white cursor-pointer" style={{ background: "#B7791F" }} onClick={() => book(d().wanted)}>
                Send {d().wanted} <span class="serif font-normal tabular-nums">{coins(offer()!.price * GOODS[d().good].box * d().wanted)}</span>
              </button>
            </Show>
            <Show when={d().wanted === 0 && offer() && d().key !== "gift"}>
              <button class="press soft inline-flex h-9 items-center gap-1 rounded-full px-3 text-[14px] font-semibold cursor-pointer" style={{ border: "2px solid rgb(var(--ink) / 0.15)" }} onClick={() => book(1)}>
                + Box <span class="serif font-normal tabular-nums">{coins((d().out ? 1 : -1) * offer()!.price * GOODS[d().good].box)}</span>
              </button>
            </Show>
            <Show when={d().letter === null && offer() && d().key !== "gift"}>
              <button
                class="press inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[14px] font-semibold cursor-pointer"
                style={{ background: d().pin !== null ? "rgb(var(--ink) / 0.85)" : "transparent", color: d().pin !== null ? "rgb(var(--glass))" : "rgb(var(--ink) / 0.6)", border: d().pin !== null ? "2px solid transparent" : "2px solid rgb(var(--ink) / 0.15)" }}
                onClick={pin}
              >
                <PinGlyph size={14} /> Every sailing
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
      class="press h-8 rounded-full px-3.5 text-[14px] font-semibold cursor-pointer"
      style={{ background: out() === p.out ? "rgb(var(--ink) / 0.85)" : "transparent", color: out() === p.out ? "rgb(var(--glass))" : "rgb(var(--ink) / 0.6)" }}
      onClick={() => setPicking(p.out)}
    >
      {p.out ? "Sell" : "Buy"}
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
              <span class="text-[14px] font-semibold">{o.partner ? nameOf(o.partner) : "World"}</span>
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
const Eye = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
);
const Letter = (props: { size: number }) => (
  <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
);
