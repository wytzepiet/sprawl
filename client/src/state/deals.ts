import { createMemo, createRoot, createSignal } from "solid-js";
import { now, sea, voyage } from "./sea";
import { missions } from "./missions";
import type { Good, Leg, Offer, Shipment } from "../generated";
import type { Mayor } from "../generated/Mayor";

export const GOOD_ORDER: Good[] = ["Timber", "Stone", "Crates", "Fuel"];

/** A box of a deal: one on its way, or a slot on the quay not yet
 *  loaded (no leg). */
export interface Box {
  trailer: number;
  leg: Leg | null;
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
  boxes: Box[];
  pin: number | null;
  /** The letter it fills, and boxes it still wants not yet booked. */
  letter: number | null;
  wanted: number;
  /** Coins it pays, or costs, all told. */
  coins: number;
  /** 0 to 1 along the way, all its boxes together; and when the next of
   *  them moves on, or the letter is due. */
  progress: number;
  eta: number | null;
  /** Finished: its last box in, or gone. */
  done: boolean;
}

const keyOf = (out: boolean, partner: Mayor | null, good: Good) => `${out ? "out" : "in"}:${partner ?? "world"}:${good}`;

/** How far along a box is, 0 to 1. */
function along(s: Shipment): number {
  if (s.outbound) return { Booked: 0, Yard: 0, Hauled: 0.3, Parked: 0.55, Aboard: 0.8 }[s.leg];
  if (s.leg === "Aboard") {
    const sailing = sea.sailings.find((x) => x.ferry === s.carrier);
    return sailing && !sailing.berthed ? 0.1 + 0.4 * voyage(sailing) : 0.5;
  }
  return { Booked: 0.05, Parked: 0.6, Hauled: 0.75, Yard: 0.9 }[s.leg];
}

/** The deals the town has going, as the sea has them now. */
function live(): Deal[] {
  now();
  const deals = new Map<string, Deal>();
  const deal = (out: boolean, partner: Mayor | null, good: Good, key = keyOf(out, partner, good)) => {
    let d = deals.get(key);
    if (!d) deals.set(key, (d = { key, good, partner, out, boxes: [], pin: null, letter: null, wanted: 0, coins: 0, progress: 0, eta: null, done: false }));
    return d;
  };
  const soonest = (d: Deal, t: number | null) => t !== null && (d.eta === null || t < d.eta) && (d.eta = t);
  const sum = new Map<string, number>();
  for (const s of sea.shipments) {
    // A box going out not yet loaded is the quay's slot, below.
    if (s.outbound && s.leg === "Booked") continue;
    const d = s.order === 0 ? deal(false, null, s.good, "gift") : deal(s.outbound, s.partner, s.good);
    d.boxes.push({ trailer: s.trailer, leg: s.leg });
    d.coins += (s.outbound ? 1 : -1) * s.price * s.units;
    sum.set(d.key, (sum.get(d.key) ?? 0) + along(s));
    const sailing = sea.sailings.find((x) => x.ferry === s.carrier) ?? sea.sailings[0];
    if (s.outbound) soonest(d, s.leg === "Aboard" || s.leg === "Parked" ? sailing?.departs ?? null : null);
    else soonest(d, s.leg === "Booked" ? sailing?.lands ?? s.eta : s.eta);
  }
  for (const x of sea.sailings) {
    for (const t of x.outgoing) {
      const d = deal(true, t.partner, t.good);
      d.boxes.push({ trailer: t.id, leg: null });
      d.coins += t.price * t.units;
    }
    for (const p of x.pins) deal(p.out, p.partner, p.good).pin = p.id;
  }
  for (const o of sea.offers) {
    if (o.letter === null || !o.boxes) continue;
    const d = deal(o.out, o.partner, o.good);
    d.letter = o.letter;
    d.wanted = o.boxes;
    if (!d.boxes.length) soonest(d, missions().find((m) => typeof m.key === "object" && m.key.Order === o.letter)?.due ?? null);
  }
  for (const d of deals.values()) d.progress = (sum.get(d.key) ?? 0) / Math.max(1, d.boxes.length + d.wanted);
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
    const ended = last.filter((d) => !keys.has(d.key) && d.boxes.some((b) => b.leg !== null));
    if (ended.length) {
      const done: Deal[] = ended.map((d) => ({ ...d, done: true, progress: 1, eta: null }));
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

/** The picker open, for deals coming in (false) or going out (true):
 *  from the stack's + or a mission's step. */
const [picking, setPicking] = createSignal<boolean | null>(null);
/** The stack spread out, every deal to see. */
const [spread, setSpread] = createSignal(false);
export { picking, setPicking, spread, setSpread };

/** The harbour the town trades through: the game picks the way, the
 *  mayor never names a port. */
export const home = () => sea.sailings[0]?.harbour ?? null;

/** The deal on offer for a box of a good from or for a partner. */
export const offerOf = (good: Good, partner: Mayor | null, out: boolean): Offer | undefined =>
  sea.offers.find((o) => o.good === good && o.partner === partner && o.out === out);

/** The cheapest deal for a box of a good coming in, if any: what a site's
 *  card books with one tap. */
export const cheapest = (good: Good): Offer | undefined => sea.offers.find((o) => o.good === good && !o.out);
