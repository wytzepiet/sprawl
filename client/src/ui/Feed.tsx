import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { neighbours } from "../state/missions";
import { news, sea, until, type News } from "../state/sea";
import { setFollowing } from "../state/selection";
import { deals, GOOD_ORDER, home, offerOf, picking, setPicking, setSpread, spread, stepsOf, type Deal } from "../state/deals";
import { GoodIcon, GOODS } from "../blueprints";
import { Crest, MissionCard, missionKey, shownMissions } from "./Missions";
import { track } from "./Shipments";
import { coins, GoodDot, StepBar } from "./kit";
import { Stack } from "./stack";
import type { Good, Mission, Offer } from "../generated";
import type { Mayor } from "../generated/Mayor";

/** Room the feed leaves below it: the dock and the corners, and on a
 *  phone the corners under the dock. */
const BELOW = () => (window.innerWidth < 720 ? 172 : 112);

/** A card of the feed: a line of news, a mission, a deal, or the picker. */
type Note =
  | { key: string; kind: "news"; news: News }
  | { key: string; kind: "mission"; m: Mission }
  | { key: string; kind: "deal"; deal: Deal }
  | { key: string; kind: "picker" };

/**
 * Everything that happens to the town, as a phone's notifications, top
 * right, or across the top of a phone: the only thing at the top of the
 * screen. News (the ferry in, the ferry gone) drops in on top and goes
 * by itself; a mission is pinned while it is open, its step at hand to
 * do; a deal (docs/trade.md §The deck) stays while its boxes are on
 * their way, says what it is, where its furthest box is, on a bar of the
 * steps of its way, and when it moves on, and once done shows its coins
 * and slides away. The dock's ferry opens the picker on top: buy or
 * sell, a good, then who from or for, at their price.
 *
 * Folded, the newest is in front and two more peek out under it; a tap
 * spreads them out, a tap on one opens it: a mission's step, a deal's
 * boxes, each followed with a tap, a box more, a pin to book it every
 * sailing, a letter's boxes sent.
 */
export default function Feed() {
  const [room, setRoom] = createSignal(window.innerHeight - BELOW() - 16);
  const fit = () => setRoom(window.innerHeight - BELOW() - 16);
  window.addEventListener("resize", fit);
  onCleanup(() => window.removeEventListener("resize", fit));
  const notes = (): Note[] => [
    ...(picking() === null || home() === null ? [] : [{ key: "picker", kind: "picker" as const }]),
    ...[...news()].reverse().map((n) => ({ key: `news:${n.key}`, kind: "news" as const, news: n })),
    ...shownMissions().map((m) => ({ key: missionKey(m), kind: "mission" as const, m })),
    ...deals().map((d) => ({ key: `deal:${d.key}`, kind: "deal" as const, deal: d })),
  ];
  const [focus, setFocus] = createSignal<string | null>(null);
  /** Folded, a tap spreads the stack; spread, it opens the card tapped. */
  const tap = (key: string) => {
    if (!spread() && notes().length > 1 && picking() === null) return setSpread(true);
    setFocus(focus() === key ? null : key);
  };
  createEffect(() => notes().length < 2 && setSpread(false));
  return (
    <div class="pointer-events-none fixed left-3 right-3 top-3 z-30 select-none md:left-auto md:right-6 md:top-6 md:w-[340px]">
      <Stack each={notes()} key={(n) => n.key} open={spread()} room={room()} keep={focus()} glass="note" class="ink pointer-events-auto rounded-[20px]">
        {(n) => {
          const note = n();
          switch (note.kind) {
            case "picker":
              return <Picker onDeal={(key) => (setPicking(null), setFocus(`deal:${key}`))} />;
            case "news":
              return <NewsCard news={note.news} />;
            case "mission":
              return <MissionCard m={(n() as typeof note).m} open={focus() === note.key} onTap={() => tap(note.key)} />;
            case "deal":
              return <Card deal={(n() as typeof note).deal} open={focus() === note.key} onTap={() => tap(note.key)} />;
          }
        }}
      </Stack>
      <Show when={spread()}>
        <div class="mt-2 flex justify-center">
          <button data-glass="note-fold" class="ink press pointer-events-auto grid h-8 w-14 place-items-center rounded-full cursor-pointer" onClick={() => (setSpread(false), setFocus(null))} title="Fold">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6" /></svg>
          </button>
        </div>
      </Show>
    </div>
  );
}

/** A line of news: the ferry in, the ferry gone, coins spent; a tap goes there. */
function NewsCard(props: { news: News }) {
  return (
    <button class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left cursor-pointer" onClick={() => setFollowing(props.news.at)}>
      <span class="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] text-white" style={{ background: props.news.coins ? "#B7791F" : "#2B6CA3" }}>
        <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor">
          <path d={props.news.coins ? COINS : FERRY} />
        </svg>
      </span>
      <span class="min-w-0 flex-1 leading-tight">
        <span class="block truncate text-[14.5px] font-semibold">{props.news.text}</span>
        <span class="soft mt-0.5 block truncate text-[12.5px]">{props.news.sub}</span>
      </span>
    </button>
  );
}

export const FERRY = "M2 14h20l-2.5 5.5h-15zM6 9h9v4H6zM8 5.5h4V9H8z";
const COINS = "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 9.5c0 1.7 3.6 3 8 3s8-1.3 8-3V12c0 1.7-3.6 3-8 3s-8-1.3-8-3zM4 15.5c0 1.7 3.6 3 8 3s8-1.3 8-3V18c0 1.7-3.6 3-8 3s-8-1.3-8-3z";

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
        <div class="mt-2"><StepBar steps={stepsOf(d().out)} at={d().done ? Infinity : lead()?.step ?? -1} color={color()} /></div>
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
