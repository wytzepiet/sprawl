import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { GOODS } from "../blueprints";
import type { Good, Prices, Quote, Stock } from "../generated";

/**
 * The market as the server last sent it (`market.rs`): each good's price,
 * its band, what the town pays and gets at its harbour, and the week of
 * hours behind it; and the orders waiting on a price. Sent on joining and
 * whenever it changes, an hour of the town's day at most.
 */
const [market, setMarket] = createStore<Prices>({ goods: [], orders: [], hour: 0 });

/** Every standing depot's shelves added up, as the server counts them,
 *  wherever the camera is: none, no depot yet. */
export const [stocks, hearStocks] = createSignal<Partial<Record<Good, Stock>>>({});
export { market };

export const hearMarket = (p: Prices) => setMarket(reconcile(p));

export const quoteOf = (good: Good): Quote | undefined => market.goods.find((q) => q.good === good);

/** The price a day ago, or as far back as is kept. */
export const dayAgo = (q: Quote) => q.history[Math.max(0, q.history.length - 25)] ?? q.price;

/** How far it moved since then, as a share. */
export const change = (q: Quote) => q.price / dayAgo(q) - 1;

/** What so many boxes come to, bought or sold now, in coins: each moves
 *  the price a step and is paid at the price it moved to, never past the
 *  band (`market::trade`). */
export const total = (q: Quote, boxes: number, out: boolean) => {
  let sum = 0;
  for (let k = 1; k <= boxes; k++) sum += Math.min(q.ceiling, Math.max(q.floor, q.price + (out ? -k : k) * q.step));
  return sum * GOODS[q.good].box;
};
