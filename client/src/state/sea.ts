import { batch, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { dayLengthMs, simNow } from "../network/clock";
import { getEntity } from "./gameObjects";
import { GOODS } from "../blueprints";
import type { Building, Car, Good, Leg, Sailing, Sea, Shipment } from "../generated";

/**
 * The sea as the last update had it: every box with an order, where it is,
 * and every harbour's timetable. The whole world's, not just what is in
 * view, so the shipments list, the cards and the guide all read it.
 * Reconciled by key, so a line that stays on the list stays the same line.
 */
const [sea, setSea] = createStore<Sea>({ shipments: [], sailings: [] });
export { sea };

/** Sim time four times a second: what every countdown reads. */
const [now, setNow] = createSignal(simNow());
setInterval(() => setNow(simNow()), 250);
export { now };

/** A line of news: the ferry in, the ferry gone. */
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
function tell(text: string, sub: string, at: number) {
  const n = { key: newsKey++, text, sub, at };
  setNews((l) => [...l, n]);
  setTimeout(() => setNews((l) => l.filter((x) => x !== n)), NEWS_MS);
}

/** Has a ferry come in with settlers yet: the opening's last beat. */
const [settled, setSettled] = createSignal(false);
export { settled };

let heard = false;
/** An update's sea: kept, and what changed at a ramp told. */
export function hearSea(s: Sea) {
  const before = new Map(sea.sailings.map((x) => [x.harbour, { berthed: x.berthed, out: outbound(x.ferry) }]));
  batch(() => {
    setSea("shipments", reconcile(s.shipments, { key: "trailer" }));
    setSea("sailings", reconcile(s.sailings, { key: "harbour" }));
  });
  if (s.sailings.some((x) => x.berthed && x.settlers > 0)) setSettled(true);
  if (!heard) return void (heard = true);
  for (const x of s.sailings) {
    const was = before.get(x.harbour);
    if (!was || was.berthed === x.berthed) continue;
    if (x.berthed) {
      const what = [x.boxes && plural(x.boxes, "box", "boxes"), x.settlers && plural(x.settlers, "settler", "settlers")].filter(Boolean);
      tell(what.length ? `The ferry is in: ${what.join(", ")}` : "The ferry is in, empty", `at the ramp till ${clockAt(x.departs)}`, x.harbour);
    } else {
      tell(was.out ? `The ferry sails with ${plural(was.out, "box", "boxes")} out` : "The ferry has sailed", `back ${clockAt(x.arrives)}`, x.ferry);
    }
  }
}

/** Boxes going out aboard a ferry now. */
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

/** A harbour's timetable. */
export const sailingOf = (harbour: number): Sailing | undefined => sea.sailings.find((s) => s.harbour === harbour);

/** How far through its leg of the timetable a ferry is, 0 to 1: the voyage
 *  in while it is away, the stay while it is at the ramp. */
export function voyage(s: Sailing, turn: number): number {
  const [from, to] = s.berthed ? [s.arrives, s.departs] : [s.arrives - turn, s.arrives];
  return Math.max(0, Math.min(1, (now() - from) / Math.max(1, to - from)));
}
/** At the ramp (`sea.rs` DWELL): five ninety-sixths of a day. */
const dwell = () => (dayLengthMs() * 5) / 96;

/**
 * When a box booked now would berth: on the ferry's next sailing from the
 * world, the one it has not yet left on. At the ramp, the one after this
 * stay; sailing in, the one after it berths; sailing out or away, the next.
 */
export function landsAt(s: Sailing): number {
  if (s.berthed) return s.departs + turn();
  const e = getEntity(s.ferry);
  const run = e?.object.kind === "Car" ? (e.object.data as Car).run : null;
  const inbound = run && run.path.length > 1 && towardHarbour(run.path, s.harbour);
  return inbound ? s.arrives + dwell() + turn() : s.arrives;
}
const towardHarbour = (path: { x: number; y: number }[], harbour: number) => {
  const h = getEntity(harbour)?.position;
  if (!h) return false;
  const d = (p: { x: number; y: number }) => Math.abs(p.x - h.x) + Math.abs(p.y - h.y);
  return d(path[path.length - 1]) < d(path[0]);
};

/** From casting off to berthing again (`sea.rs` TURN): five forty-eighths of a day. */
export const turn = () => (dayLengthMs() * 5) / 48;

/** A car's trip, if it is on one and the client has it. */
export const tripOf = (id: number | null) => {
  const o = id === null ? undefined : getEntity(id)?.object;
  return o?.kind === "Car" ? (o.data as Car).trip : null;
};

const roleOf = (id: number | null) => {
  const o = id === null ? undefined : getEntity(id)?.object;
  return o?.kind === "Car" ? (o.data as Car).role : null;
};

/** Room on a depot's shelf for a good, as far as the client sees it. */
export function room(depot: number | null, good: Good): number {
  const o = depot === null ? undefined : getEntity(depot)?.object;
  const s = o?.kind === "Building" ? (o.data as Building).stocks[good] : undefined;
  return s ? s.cap - s.level : Infinity;
}

/** The legs a box goes through, in order, in from the world. */
export const LEGS: Leg[] = ["Booked", "Aboard", "Parked", "Hauled", "Yard"];

/**
 * Where a box is, in words, and when it moves on: "booked for the 14:20
 * ferry", "at sea, lands 14:20", "in the trailer park", "on the lorry,
 * 0:12", "unloading".
 */
export function legWords(s: Shipment): { words: string; eta: number | null } {
  const sailing = sea.sailings.find((x) => x.ferry === s.carrier);
  switch (s.leg) {
    case "Booked": {
      // When the ferry next leaves the world, read off where it is now.
      const eta = sailing ? landsAt(sailing) : s.eta;
      return { words: eta ? `booked on the ${clockAt(eta)} ferry` : "booked on the next ferry", eta };
    }
    case "Aboard":
      if (s.outbound) return { words: sailing ? `on the deck, sails ${clockAt(sailing.departs)}` : "on the deck", eta: sailing?.departs ?? null };
      return s.eta ? { words: `at sea, lands ${clockAt(s.eta)}`, eta: s.eta } : { words: "at the ramp, coming off", eta: null };
    case "Parked":
      if (s.outbound) return { words: "on the quay for the ferry", eta: null };
      return { words: s.good && room(s.to, s.good) < s.units ? "in the trailer park, till the depot has room" : "in the trailer park", eta: null };
    case "Hauled":
      if (roleOf(s.carrier) === "Tug" || (s.eta === null && roleOf(s.carrier) !== "Truck")) return { words: s.outbound ? "the tug is taking it aboard" : "the tug is bringing it off", eta: null };
      return { words: s.outbound ? "on the lorry to the harbour" : "on the lorry", eta: s.eta };
    case "Yard": {
      // Its lorry's, bound for home or there.
      const trip = tripOf(s.carrier);
      return trip ? { words: "on the lorry, coming home", eta: trip.eta } : { words: "unloading at the depot", eta: null };
    }
  }
}

/** A box's load in words: "20 timber", "an empty". */
export const load = (s: { good: Shipment["good"]; units: number }) => (s.good && s.units > 0 ? `${Math.round(s.units)} ${GOODS[s.good].label}` : "an empty");
