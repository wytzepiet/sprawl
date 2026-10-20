/** @jsxImportSource ~ui */
import { createSignal, For, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { sea } from "../state/sea";
import { GOOD_ORDER, home } from "../state/deals";
import { GOODS } from "../blueprints";
import { coins, Press } from "./kit";
import { nameOf, Who } from "./Feed";
import { selling, setOpen, setSelling } from "./sheet";
import type { Good, Offer } from "../generated";

/** The good whose deals are shown. */
const [good, setGood] = createSignal<Good>("Timber");

/** The trade tab's head: which way, and a good; a tap draws up who
 *  deals in it. With no harbour, there is no one to trade with. */
export function TradeHead() {
  const Way = (p: { out: boolean }) => (
    <Press h={32} pad={{ x: 14 }} round={16} justify="center" fill={selling() === p.out ? "ink/0.85" : undefined} onTap={() => (setSelling(p.out), setOpen(true))}>
      <text size={14} weight={600} ink={selling() === p.out ? "glass" : "ink/0.6"}>{p.out ? "Sell" : "Buy"}</text>
    </Press>
  );
  return (
    <Show
      when={home() !== null}
      fallback={
        <box pad={{ x: 16, top: 14, bottom: 14 }}>
          <text size={14} weight={600} soft>Trade opens with a harbour</text>
        </box>
      }
    >
      <box dir="row" align="center" gap={6} pad={{ x: 12, top: 14, bottom: 12 }}>
        <box dir="row" pad={2} round={18} fill="ink/0.07"><Way out={false} /><Way out /></box>
        <box grow={1} />
        <For each={GOOD_ORDER}>
          {(g) => (
            <Press w={36} h={36} round={10} align="center" justify="center" fill={good() === g ? GOODS[g].color : `${GOODS[g].color}2a`} onTap={() => (setGood(g), setOpen(true))}>
              <icon d={GOODS[g].glyph} size={20} ink={good() === g ? "white" : GOODS[g].color} />
            </Press>
          )}
        </For>
      </box>
    </Show>
  );
}

/** Who deals in the good that way, each at their price a box; a tap books
 *  one, and the deal is in the feed. */
export function TradeBody() {
  const { send, growth } = useGame();
  const offers = () => sea.offers.filter((o) => o.good === good() && o.out === selling());
  const owed = () => sea.shipments.filter((s) => !s.outbound && (s.leg === "Booked" || s.leg === "Aboard")).reduce((a, s) => a + s.price * s.units, 0);
  const box = (o: Offer) => o.price * GOODS[o.good].box;
  const afford = (o: Offer) => o.out || growth().treasury - owed() >= box(o);
  const deal = (o: Offer) => {
    const h = home();
    if (h !== null) send({ type: "Book", data: { harbour: h, good: o.good, partner: o.partner, out: o.out } });
  };
  return (
    <box dir="row" wrap gap={6} minH={36} pad={{ x: 12, bottom: 14 }}>
      <For each={offers()} fallback={<text size={13.5} soft>No one {selling() ? "buys" : "sells"} {GOODS[good()].label} right now</text>}>
        {(o) => (
          <Press dir="row" align="center" gap={6} h={36} pad={{ right: 12, left: 4 }} round={18} fill="glass" shadow opacity={afford(o) ? 1 : 0.35} onTap={() => afford(o) && deal(o)}>
            <Who partner={o.partner} size={28} letter={o.letter !== null} />
            <text size={14} weight={600}>{o.partner ? nameOf(o.partner) : "World"}</text>
            <text serif size={15}>{coins(o.out ? box(o) : -box(o))}</text>
          </Press>
        )}
      </For>
    </box>
  );
}
