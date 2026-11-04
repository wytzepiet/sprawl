import { createSignal } from "solid-js";
import { dayLengthMs, simNow } from "../network/clock";
import type { Town } from "../generated";

/**
 * The town as its mayor sees it, as the last update had it: its people,
 * the road it has left, what is in hand, the pick on the table, the day.
 */
const NONE: Town = { people: 0, roads: 0, hand: [], tools: [], toward: 0, step: 10, left: 0, offer: [], day: 0, streak: 0, status: 0, dawn: null, start: null, bounds: null };
const [town, setTown] = createSignal<Town>(NONE);
export { town, setTown };

/** How many of a kind are in hand. */
export const inHand = (kind: string) => town().hand.find(([k]) => k === kind)?.[1] ?? 0;

/** Sim time four times a second: what every countdown reads. */
const [now, setNow] = createSignal(simNow());
setInterval(() => setNow(simNow()), 250);
export { now };

/** A line of news, for a few seconds. */
export interface News {
  key: number;
  text: string;
  sub: string;
  /** What a tap on it goes to. */
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

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A game minute, in sim milliseconds. */
const minute = () => dayLengthMs() / 1440;

/** A moment of the game's day, as the clock reads it: "14:20". */
export function clockAt(t: number): string {
  const m = Math.floor(((t % dayLengthMs()) + dayLengthMs()) % dayLengthMs() / minute());
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
