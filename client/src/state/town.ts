import { createSignal } from "solid-js";
import { simNow } from "../network/clock";
import type { Town } from "../generated";

/** The town as the last update had it: what is in hand, who lives here,
 *  the pick on the table. */
const [town, setTown] = createSignal<Town>({ roads: 0, tokens: {}, people: 0, toward: 0, step: 1, left: 0, offer: [], start: null });
export { town, setTown };

/** Sim time four times a second: what every countdown reads. */
const [now, setNow] = createSignal(simNow());
setInterval(() => setNow(simNow()), 250);
export { now };

/** A line of news from the server; a tap goes to what it is about. */
export interface News {
  key: number;
  text: string;
  sub: string;
  at: number;
}
const [news, setNews] = createSignal<News[]>([]);
export { news };
let newsKey = 0;
/** How long a line of news stays up, wall time. */
const NEWS_MS = 7000;
export function tell(text: string, sub: string, at: number) {
  const n = { key: newsKey++, text, sub, at };
  setNews((l) => [...l, n]);
  setTimeout(() => setNews((l) => l.filter((x) => x !== n)), NEWS_MS);
}
