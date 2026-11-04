import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { Good, Prices, Quote, Stock } from "../generated";

/**
 * The market as the server last sent it (`market.rs`): each good's price,
 * its band and the week of hours behind it; each good's last day, made,
 * used and traded; and the deals kept. Sent on joining and whenever it
 * changes, an hour of the town's day at most.
 */
const [market, setMarket] = createStore<Prices>({ goods: [], flows: [], deals: [], hour: 0 });

/** Every standing depot's shelves added up, as the server counts them,
 *  wherever the camera is: none, no depot yet. */
export const [stocks, hearStocks] = createSignal<Partial<Record<Good, Stock>>>({});
export { market };

export const hearMarket = (p: Prices) => setMarket(reconcile(p));

/** What the town made, used and traded of a good the last day. */
export const flowOf = (good: Good) => market.flows.find((f) => f.good === good);

export const quoteOf = (good: Good): Quote | undefined => market.goods.find((q) => q.good === good);

/** The price a day ago, or as far back as is kept. */
export const dayAgo = (q: Quote) => q.history[Math.max(0, q.history.length - 25)] ?? q.price;

/** How far it moved since then, as a share. */
export const change = (q: Quote) => q.price / dayAgo(q) - 1;

