import { createStore, reconcile } from "solid-js/store";
import type { Good, Prices, Quote } from "../generated";

/**
 * The market as the server last sent it (`market.rs`): each good's price,
 * its band, what the town pays and gets at its harbour, and the week of
 * hours behind it; and the orders waiting on a price. Sent on joining and
 * whenever it changes, an hour of the town's day at most.
 */
const [market, setMarket] = createStore<Prices>({ goods: [], orders: [], hour: 0 });
export { market };

export const hearMarket = (p: Prices) => setMarket(reconcile(p));

export const quoteOf = (good: Good): Quote | undefined => market.goods.find((q) => q.good === good);

/** The price a day ago, or as far back as is kept. */
export const dayAgo = (q: Quote) => q.history[Math.max(0, q.history.length - 25)] ?? q.price;

/** How far it moved since then, as a share. */
export const change = (q: Quote) => q.price / dayAgo(q) - 1;
