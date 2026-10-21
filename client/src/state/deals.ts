import { createMemo, createRoot, createSignal } from "solid-js";
import { now, sea } from "./sea";
import { missions } from "./missions";
import type { Good, Offer, Shipment, Mayor } from "../generated";

export const GOOD_ORDER: Good[] = ["Timber", "Stone", "Crates", "Fuel"];

/** The steps a box takes, in from the world and out to it: what a
 *  deal's bar is cut into. */
const IN_STEPS = ["booked on the next ferry", "at sea", "in the trailer park", "on a lorry to the depot", "unloading at the depot"];
const OUT_STEPS = ["waiting for a lorry to load it", "on a lorry to the harbour", "on the quay for the ferry", "on the ferry"];
export const stepsOf = (out: boolean) => (out ? OUT_STEPS : IN_STEPS).length;

/** A box of a deal, where it is: its step along the way, that step in
 *  words, and when it moves on, if the game knows. A slot going out not
 *  yet loaded is a box at its first step. */
export interface Box {
  trailer: number;
  step: number;
  words: string;
  eta: number | null;
  /** On the map, for the camera to follow. */
  seen: boolean;
}

/**
 * A deal (docs/trade.md §The deck): every box of one good from or for one
 * partner, wherever they are on the way; the pin that books it every
 * sailing; and the letter it fills, with the boxes it still wants. The
 * one thing the mayor trades in: the deals stack shows them, newest on
 * top, and a deal whose last box is in, or gone, shows its coins and
 * goes.
 */
export interface Deal {
  key: string;
  good: Good;
  partner: Mayor | null;
  out: boolean;
  /** Furthest along first. */
  boxes: Box[];
  pin: number | null;
  /** The letter it fills, the boxes it still wants not yet booked, and
   *  when it is due. */
  letter: number | null;
  wanted: number;
  due: number | null;
  /** Coins it pays, or costs, all told. */
  coins: number;
  /** Finished: its last box in, or gone. */
  done: boolean;
}

const keyOf = (out: boolean, partner: Mayor | null, good: Good) => `${out ? "out" : "in"}:${partner ?? "world"}:${good}`;

/** Where a box is on its way, and when it moves on. */
function boxOf(s: Shipment): Box {
  const sailing = sea.sailings.find((x) => x.ferry === s.carrier) ?? sea.sailings[0];
  const box = (step: number, eta: number | null, words = (s.outbound ? OUT_STEPS : IN_STEPS)[step]): Box => ({ trailer: s.trailer, step, words, eta, seen: step > 0 });
  if (s.outbound) {
    switch (s.leg) {
      case "Booked":
      case "Yard":
        return box(0, null);
      case "Hauled":
        return box(1, s.eta);
      case "Parked":
        return box(2, sailing?.departs ?? null);
      case "Aboard":
        return box(3, sailing?.departs ?? null);
    }
  }
  switch (s.leg) {
    case "Booked":
      return box(0, sailing?.lands ?? s.eta);
    case "Aboard":
      return s.eta ? box(1, s.eta) : box(1, null, "coming off the ferry");
    case "Parked":
      return box(2, null);
    case "Hauled":
      return box(3, s.eta);
    case "Yard":
      return box(4, null);
  }
}

/** The deals the town has going, as the sea has them now. */
function live(): Deal[] {
  now();
  const deals = new Map<string, Deal>();
  const deal = (out: boolean, partner: Mayor | null, good: Good, key = keyOf(out, partner, good)) => {
    let d = deals.get(key);
    if (!d) deals.set(key, (d = { key, good, partner, out, boxes: [], pin: null, letter: null, wanted: 0, due: null, coins: 0, done: false }));
    return d;
  };
  for (const s of sea.shipments) {
    // A box going out not yet loaded is the quay's slot, below.
    if (s.outbound && s.leg === "Booked") continue;
    const d = s.order === 0 ? deal(false, null, s.good, "gift") : deal(s.outbound, s.partner, s.good);
    d.boxes.push(boxOf(s));
    d.coins += (s.outbound ? 1 : -1) * s.price * s.units;
  }
  for (const x of sea.sailings) {
    for (const t of x.outgoing) {
      const d = deal(true, t.partner, t.good);
      d.boxes.push({ trailer: t.id, step: 0, words: OUT_STEPS[0], eta: null, seen: false });
      d.coins += t.price * t.units;
    }
    for (const p of x.pins) deal(p.out, p.partner, p.good).pin = p.id;
  }
  for (const o of sea.offers) {
    if (o.letter === null || !o.boxes) continue;
    const d = deal(o.out, o.partner, o.good);
    d.letter = o.letter;
    d.wanted = o.boxes;
    d.due = missions().find((m) => typeof m.key === "object" && m.key.Order === o.letter)?.due ?? null;
  }
  for (const d of deals.values()) d.boxes.sort((a, b) => b.step - a.step || (a.eta ?? Infinity) - (b.eta ?? Infinity));
  return [...deals.values()];
}

/** How long a finished deal stays up, showing its coins. */
const DONE_MS = 2600;

export const { deals } = createRoot(() => {
  /** When each deal was first seen: newest on top. */
  const born = new Map<string, number>();
  let n = 0;
  const [finished, setFinished] = createSignal<Deal[]>([]);
  let last: Deal[] = [];
  const current = createMemo(() => {
    const l = live();
    const keys = new Set(l.map((d) => d.key));
    // Gone with boxes still on it: its last box is in, or sailed.
    const ended = last.filter((d) => !keys.has(d.key) && d.boxes.some((b) => b.seen));
    if (ended.length) {
      const done: Deal[] = ended.map((d) => ({ ...d, done: true }));
      setFinished((f) => [...f.filter((x) => !keys.has(x.key)), ...done]);
      setTimeout(() => setFinished((f) => f.filter((x) => !done.includes(x))), DONE_MS);
    }
    last = l;
    for (const d of l) if (!born.has(d.key)) born.set(d.key, n++);
    return l;
  });
  const deals = createMemo(() => {
    const l = current();
    const all = [...l, ...finished().filter((f) => !l.some((d) => d.key === f.key))];
    return all.sort((a, b) => (born.get(b.key) ?? 0) - (born.get(a.key) ?? 0));
  });
  return { deals };
});

/** The stack spread out, every deal to see. */
const [spread, setSpread] = createSignal(false);
export { spread, setSpread };

/** The harbour the town trades through: the game picks the way, the
 *  mayor never names a port. */
export const home = () => sea.sailings[0]?.harbour ?? null;

/** The deal on offer for a box of a good from or for a partner. */
export const offerOf = (good: Good, partner: Mayor | null, out: boolean): Offer | undefined =>
  sea.offers.find((o) => o.good === good && o.partner === partner && o.out === out);

/** The cheapest deal for a box of a good coming in, if any: what a site's
 *  card books with one tap. */
export const cheapest = (good: Good): Offer | undefined => sea.offers.find((o) => o.good === good && !o.out);
