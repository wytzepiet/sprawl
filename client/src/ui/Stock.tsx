/** @jsxImportSource ~ui */
import { For, Show } from "solid-js";
import { dayAgo, market, quoteOf } from "../state/market";
import { goodPage, held, money, named, Order, percent, tint, Tile } from "./Market";
import { push } from "./pages";
import { setOpen } from "./sheet";

/**
 * The stock tab, as a trading app's portfolio: what the town holds of
 * each good across its depots, what that is worth at today's price and
 * how that moved since yesterday, and the orders waiting on a price. A
 * tap on a good opens its page in the market.
 */

/** Each good held, with its worth now and a day ago. */
const holdings = () =>
  market.goods
    .filter((q) => (held().get(q.good)?.level ?? 0) >= 1)
    .map((q) => {
      const s = held().get(q.good)!;
      return { good: q.good, ...s, worth: s.level * q.price, was: s.level * dayAgo(q) };
    });
const worth = () => holdings().reduce((a, h) => a + h.worth, 0);
const moved = () => {
  const was = holdings().reduce((a, h) => a + h.was, 0);
  return was > 0 ? worth() / was - 1 : 0;
};

/** The head: what everything held is worth, and how it moved today. */
export function StockHead() {
  return (
    <box dir="row" align="center" gap={10} pad={{ x: 16, top: 14, bottom: 12 }} onTap={() => setOpen(true)}>
      <Show when={holdings().length} fallback={<text size={14} weight={600} soft>Goods are kept in a depot</text>}>
        <box grow={1} gap={0}>
          <text serif size={22}>{money(worth())}</text>
          <text size={12} soft>held, at today's prices</text>
        </box>
        <text size={13} weight={600} ink={tint(moved())}>{percent(moved())} today</text>
      </Show>
    </box>
  );
}

/** Drawn up: each good held, and the orders waiting. */
export function StockBody() {
  return (
    <box pad={{ x: 12, bottom: 12 }} gap={6}>
      <For each={holdings()}>
        {(h) => {
          const q = () => quoteOf(h.good)!;
          const c = () => q().price / dayAgo(q()) - 1;
          return (
            <box dir="row" align="center" gap={10} pad={{ x: 10, y: 8 }} round={16} fill="ink/0.05" onTap={() => push(goodPage(h.good))}>
              <Tile good={h.good} />
              <box grow={1} gap={1}>
                <text size={14.5} weight={600}>{named(h.good)}</text>
                <text size={12} soft>
                  {Math.floor(h.level)} of {h.cap}
                  {h.incoming > 0 ? `, ${Math.round(h.incoming)} coming` : ""}
                </text>
              </box>
              <box align="end">
                <text serif size={16}>{money(h.worth)}</text>
                <text size={11.5} weight={600} ink={tint(c())}>{percent(c())}</text>
              </box>
            </box>
          );
        }}
      </For>
      <Show when={market.orders.length}>
        <box h={4} />
        <For each={market.orders}>{(o) => <Order o={o} named />}</For>
      </Show>
    </box>
  );
}
