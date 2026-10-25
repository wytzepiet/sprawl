import { batch, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { dayLengthMs, simNow } from "../network/clock";
import { getEntity } from "./gameObjects";
import { packages } from "../blueprints";
import type { Car, Good, Package, Sailing, Sea } from "../generated";

/**
 * The sea as the last update had it: every box with an order, where it is,
 * and every harbour's timetable. The whole world's, not just what is in
 * view, so the shipments list, the cards and the missions all read it.
 * Reconciled by key, so a line that stays on the list stays the same line.
 */
const [sea, setSea] = createStore<Sea>({ shipments: [], sailings: [], lanes: [], letters: [] });
export { sea };

/** Sim time four times a second: what every countdown reads. */
const [now, setNow] = createSignal(simNow());
setInterval(() => setNow(simNow()), 250);
export { now };

/** A line of news: the ferry in, the ferry gone; or, from the server,
 *  coins the town spent of its own accord. */
export interface News {
  key: number;
  text: string;
  sub: string;
  /** What a tap on it goes to. */
  at: number;
  coins: boolean;
}
const [news, setNews] = createSignal<News[]>([]);
export { news };
let newsKey = 0;
/** How long a line of news stays up, wall time. */
const NEWS_MS = 7000;
export function tell(text: string, sub: string, at: number, coins = false) {
  const n = { key: newsKey++, text, sub, at, coins };
  setNews((l) => [...l, n]);
  setTimeout(() => setNews((l) => l.filter((x) => x !== n)), NEWS_MS);
}

let heard = false;
/** An update's sea: kept, and what changed at a ramp told. */
export function hearSea(s: Sea) {
  const before = new Map(sea.sailings.map((x) => [x.harbour, { berthed: x.berthed, out: outbound(x.ferry) }]));
  batch(() => {
    setSea("shipments", reconcile(s.shipments, { key: "trailer" }));
    setSea("sailings", reconcile(s.sailings, { key: "harbour" }));
    setSea("lanes", reconcile(s.lanes ?? []));
    setSea("letters", reconcile(s.letters ?? []));
  });
  if (!heard) return void (heard = true);
  for (const x of s.sailings) {
    const was = before.get(x.harbour);
    if (!was || was.berthed === x.berthed) continue;
    if (x.berthed) {
      const what = [x.packages && plural(x.packages, "pallet", "pallets"), x.settlers && plural(x.settlers, "settler", "settlers")].filter(Boolean);
      tell(what.length ? `The ferry is in: ${what.join(", ")}` : "The ferry is in, empty", `at the ramp till ${clockAt(x.departs)}`, x.harbour);
    } else {
      tell(was.out ? `The ferry sails with ${plural(was.out, "pallet", "pallets")} out` : "The ferry has sailed", `back ${clockAt(x.arrives)}`, x.ferry);
    }
  }
}

/** Packages going out aboard a ferry now. */
const outbound = (ferry: number) => sea.shipments.filter((s) => s.outbound && s.leg === "Aboard" && s.carrier === ferry).length;

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A game minute, in sim milliseconds. */
const minute = () => dayLengthMs() / 1440;

/** A moment of the game's day, as the clock reads it: "14:20". */
export function clockAt(t: number): string {
  const m = Math.floor(((t % dayLengthMs()) + dayLengthMs()) % dayLengthMs() / minute());
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Game time from now until then, hours and minutes: "0:42". */
export function until(t: number): string {
  const m = Math.max(0, Math.ceil((t - now()) / minute()));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** How far through its leg of the timetable a ferry is, 0 to 1: the
 *  round from casting off to berthing while it is away, the stay while
 *  it is at the ramp. */
export function voyage(s: Sailing): number {
  const [from, to] = s.berthed ? [s.arrives, s.departs] : [s.arrives - s.turn, s.arrives];
  return Math.max(0, Math.min(1, (now() - from) / Math.max(1, to - from)));
}

/** A car's trip, if it is on one and the client has it. */
export const tripOf = (id: number | null) => {
  const o = id === null ? undefined : getEntity(id)?.object;
  return o?.kind === "Car" ? (o.data as Car).trip : null;
};

/** A load in words: "3 bundles of timber, 2 crates of food". */
export const load = (cargo: Package[]) => {
  const n = new Map<Good, number>();
  for (const p of cargo) n.set(p.good, (n.get(p.good) ?? 0) + 1);
  return [...n].map(([g, k]) => packages(g, k)).join(", ");
};
