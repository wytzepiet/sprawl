import { createSignal, For, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { neighbours } from "../state/missions";
import { clockAt, landsAt, sailingOf, sea } from "../state/sea";
import { GOODS } from "../blueprints";
import { Crest } from "./Missions";
import { Btn, coins, GoodDot, Section } from "./kit";
import type { Good, Offer, Pin } from "../generated";
import type { Mayor } from "../generated/Mayor";

export const GOOD_ORDER: Good[] = ["Timber", "Stone", "Crates", "Fuel"];

/** A partner's name: a mayor of their town, or the world. */
const named = (p: Mayor | null) => {
  const n = p && neighbours().find((n) => n.mayor === p);
  return n ? `${n.name} of ${n.town}` : "The world";
};

/** A partner's crest; the world's is a plain disc. */
function Seal(props: { partner: Mayor | null; size: number }) {
  const n = () => props.partner && neighbours().find((n) => n.mayor === props.partner);
  return (
    <Show when={n()} fallback={<span class="grid shrink-0 place-items-center rounded-full text-[10px] font-bold text-white" style={{ width: `${props.size}px`, height: `${props.size}px`, background: "#6E7781" }}>W</span>}>
      {(n) => <Crest n={n()} size={props.size} />}
    </Show>
  );
}

const PinGlyph = () => (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z" /></svg>
);

/** A slot of the deck, filled: its good, its partner, its price a box. */
interface Slot {
  good: Good;
  partner: Mayor | null;
  price: number;
  out: boolean;
  where: string;
}

/**
 * The ferry's deck, the one place the town trades over the sea
 * (docs/trade.md §The deck): slots coming in on the next sailing and slots
 * going out, each a deal with a partner; an empty slot opens the picker,
 * a good and who from or for, cheapest in or dearest out first; a pin
 * books the same slot again every sailing.
 */
export function Deck(props: { harbour: number }) {
  const { send, growth } = useGame();
  const sailing = () => sailingOf(props.harbour);
  const pins = () => sailing()?.pins ?? [];
  const pinned = (s: { good: Good; partner: Mayor | null; out: boolean }) => pins().find((p) => p.good === s.good && p.partner === s.partner && p.out === s.out);
  const box = (s: { good: Good; price: number }) => s.price * GOODS[s.good].box;
  const coming = (): Slot[] =>
    sea.shipments
      .filter((s) => !s.outbound && s.good && (s.leg === "Booked" || s.leg === "Aboard"))
      .map((s) => ({ good: s.good!, partner: s.partner, price: s.price, out: false, where: s.leg === "Booked" ? "booked" : "at sea" }));
  const going = (): Slot[] => [
    ...(sailing()?.outgoing ?? []).map((t) => ({ good: t.good, partner: t.partner, price: t.price, out: true, where: "waits for a lorry" })),
    ...sea.shipments
      .filter((s) => s.outbound && s.good && s.leg !== "Booked")
      .map((s) => ({ good: s.good!, partner: s.partner, price: s.price, out: true, where: s.leg === "Aboard" ? "aboard" : s.leg === "Parked" ? "on the quay" : "on a lorry" })),
  ];
  /** What the town owes for boxes booked and at sea, paid as each lands. */
  const owed = () => sea.shipments.filter((s) => !s.outbound && (s.leg === "Booked" || s.leg === "Aboard")).reduce((a, s) => a + s.price * s.units, 0);
  const [picking, setPicking] = createSignal<boolean | null>(null);
  const [good, setGood] = createSignal<Good>("Timber");
  const offers = () => sea.offers.filter((o) => o.good === good() && o.out === picking());
  const afford = (o: Offer) => o.out || growth().treasury - owed() >= box(o);
  const deal = (o: Offer, pin: boolean) => {
    send({ type: pin ? "Pin" : "Book", data: { harbour: props.harbour, good: o.good, partner: o.partner, out: o.out } });
    setPicking(null);
  };
  const Row = (p: { title: string; slots: Slot[]; out: boolean }) => (
    <div class="mb-2.5">
      <div class="soft mb-1 text-[11px] font-semibold uppercase tracking-wider">{p.title}</div>
      <div class="grid grid-cols-3 gap-1.5">
        <For each={p.slots}>
          {(s) => (
            <div class="relative flex flex-col items-center gap-0.5 rounded-2xl py-1.5 text-[11px]" style={{ background: `${GOODS[s.good].color}22`, "box-shadow": `inset 0 0 0 1.5px ${GOODS[s.good].color}66` }} title={`${GOODS[s.good].label}, ${s.out ? "for" : "from"} ${named(s.partner)}, ${s.where}`}>
              <span class="flex items-center -space-x-1.5">
                <GoodDot good={s.good} size={24} />
                <Seal partner={s.partner} size={18} />
              </span>
              <span class="serif tabular-nums text-[13px]">{s.price ? coins(s.out ? box(s) : -box(s)) : "gift"}</span>
              <span class="soft">{s.where}</span>
              <Show when={pinned(s)}>
                <span class="soft absolute right-1.5 top-1"><PinGlyph /></span>
              </Show>
            </div>
          )}
        </For>
        <button
          class="press soft flex min-h-[64px] flex-col items-center justify-center rounded-2xl text-[20px] cursor-pointer"
          style={{ border: "1.5px dashed rgb(var(--ink) / 0.22)", background: picking() === p.out ? "rgb(var(--ink) / 0.06)" : "transparent" }}
          onClick={() => setPicking(picking() === p.out ? null : p.out)}
          title={p.out ? "Book a box going out" : "Book a box coming in"}
        >
          +
        </button>
      </div>
    </div>
  );
  return (
    <Section title="The deck" aside={<Show when={sailing()}>{(s) => <span class="soft text-[11px]">lands {clockAt(landsAt(s()))}</span>}</Show>}>
      <Show when={sailing()} fallback={<div class="soft text-[13px]">No ferry calls here yet.</div>}>
        <Row title="Coming in" slots={coming()} out={false} />
        <Row title="Going out" slots={going()} out={true} />
        <Show when={picking() !== null}>
          <div class="mt-1 rounded-2xl p-2" style={{ background: "rgb(var(--ink) / 0.05)" }}>
            <div class="mb-2 flex gap-1.5">
              <For each={GOOD_ORDER}>
                {(g) => (
                  <button
                    class="press flex flex-1 flex-col items-center gap-0.5 rounded-2xl py-1 text-[11px] font-semibold cursor-pointer"
                    style={{ background: good() === g ? `${GOODS[g].color}33` : "transparent", "box-shadow": good() === g ? `inset 0 0 0 2px ${GOODS[g].color}` : "none" }}
                    onClick={() => setGood(g)}
                  >
                    <GoodDot good={g} size={22} />
                    {GOODS[g].label}
                  </button>
                )}
              </For>
            </div>
            <div class="soft mb-1 text-[11px]">{GOODS[good()].label} {picking() ? "out, for…" : "in, from…"}</div>
            <For each={offers()} fallback={<div class="soft text-[12px]">Nobody deals in it yet.</div>}>
              {(o) => (
                <div class="flex items-center gap-2 py-1">
                  <Seal partner={o.partner} size={24} />
                  <div class="min-w-0 flex-1 leading-tight">
                    <div class="truncate text-[13px] font-semibold">{named(o.partner)}</div>
                    <div class="soft text-[11px]">{o.boxes !== null ? `their letter wants ${o.boxes} more` : `a box of ${GOODS[o.good].box}`}</div>
                  </div>
                  <span class="serif tabular-nums text-[15px]">{coins(o.out ? box(o) : -box(o))}</span>
                  <Btn onClick={() => deal(o, false)} disabled={!afford(o)} title={afford(o) ? undefined : "The treasury cannot pay for it"}>Book</Btn>
                  <Btn onClick={() => deal(o, true)} disabled={!afford(o) || pins().length >= (sailing()?.deck ?? 0)} title="Book it again every sailing">
                    <PinGlyph />
                  </Btn>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={pins().length > 0}>
          <div class="soft mb-1 mt-2 text-[11px] font-semibold uppercase tracking-wider">Pinned, every sailing</div>
          <div class="flex flex-wrap gap-1.5">
            <For each={pins()}>{(p) => <PinChip pin={p} unpin={() => send({ type: "Unpin", data: { harbour: props.harbour, pin: p.id } })} />}</For>
          </div>
        </Show>
      </Show>
    </Section>
  );
}

function PinChip(props: { pin: Pin; unpin: () => void }) {
  return (
    <span class="inline-flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-1 text-[12px]" style={{ background: "rgb(var(--ink) / 0.07)" }}>
      <GoodDot good={props.pin.good} size={18} />
      <span>{GOODS[props.pin.good].label} {props.pin.out ? "for" : "from"} {named(props.pin.partner)}</span>
      <button class="soft press px-1 text-[14px] leading-none cursor-pointer" onClick={props.unpin} title="Unpin">×</button>
    </span>
  );
}

/** The cheapest deal for a box of a good coming in, if any: what a site's
 *  card books with one tap. */
export const cheapest = (good: Good): Offer | undefined => sea.offers.find((o) => o.good === good && !o.out);
