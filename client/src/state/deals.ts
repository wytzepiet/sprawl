import { createMemo, createRoot, createSignal } from "solid-js";
import { now, sea } from "./sea";
import type { Good, Shipment, Mayor } from "../generated";
import { GOODS } from "../blueprints";

/** The steps a package takes, in from the world and out to it: what a
 *  deal's bar is cut into. */
const IN_STEPS = ["booked on the next ferry", "at sea", "on the quay", "on a lorry to the depot", "unloading at the depot"];
const OUT_STEPS = ["waiting for a lorry to load it", "on a lorry to the harbour", "on the quay for the ferry", "on the ferry"];
export const stepsOf = (out: boolean) => (out ? OUT_STEPS : IN_STEPS).length;

/** A package of a deal, where it is: its step along the way, that step
 *  in words, and when it moves on, if the game knows. A slot going out
 *  not yet loaded is a package at its first step. */
export interface Piece {
  package: number;
  step: number;
  words: string;
  eta: number | null;
  /** On the map, for the camera to follow. */
  seen: boolean;
}

/**
 * A deal (docs/trade.md §The deck): every package of one good from or for one
 * partner, the market or a mayor, wherever they are on the way. The deals stack shows
 * them, newest on top, and a deal whose last package is in, or gone, shows
 * its coins and goes.
 */
export interface Deal {
  key: string;
  good: Good;
  partner: Mayor | null;
  out: boolean;
  /** Furthest along first. */
  pieces: Piece[];
  /** Coins it pays, or costs, all told. */
  coins: number;
  /** Finished: its last package in, or gone. */
  done: boolean;
}

const keyOf = (out: boolean, partner: Mayor | null, good: Good) => `${out ? "out" : "in"}:${partner ?? "world"}:${good}`;

/** Where a package is on its way, and when it moves on. */
export function pieceOf(s: Shipment): Piece {
  const sailing = sea.sailings.find((x) => x.ferry === s.carrier) ?? sea.sailings[0];
  const at = (step: number, eta: number | null, words = (s.outbound ? OUT_STEPS : IN_STEPS)[step]): Piece => ({ package: s.package, step, words, eta, seen: step > 0 });
  if (s.outbound) {
    switch (s.leg) {
      case "Booked":
      case "Yard":
        return at(0, null);
      case "Hauled":
        return at(1, s.eta);
      case "Quay":
        return at(2, sailing?.departs ?? null);
      case "Aboard":
        return at(3, sailing?.departs ?? null);
    }
  }
  switch (s.leg) {
    case "Booked":
      return at(0, sailing?.lands ?? s.eta);
    case "Aboard":
      return s.eta ? at(1, s.eta) : at(1, null, "coming off the ferry");
    case "Quay":
      return at(2, null);
    case "Hauled":
      return at(3, s.eta);
    case "Yard":
      return at(4, null);
  }
}

/** The deals the town has going, as the sea has them now. */
function live(): Deal[] {
  now();
  const deals = new Map<string, Deal>();
  const deal = (out: boolean, partner: Mayor | null, good: Good, key = keyOf(out, partner, good)) => {
    let d = deals.get(key);
    if (!d) deals.set(key, (d = { key, good, partner, out, pieces: [], coins: 0, done: false }));
    return d;
  };
  for (const s of sea.shipments) {
    // A package going out not yet loaded is the harbour's slot, below.
    if (s.outbound && s.leg === "Booked") continue;
    const d = s.order === 0 ? deal(false, null, s.good, "gift") : deal(s.outbound, s.partner, s.good);
    d.pieces.push(pieceOf(s));
    d.coins += (s.outbound ? 1 : -1) * s.price * GOODS[s.good].per;
  }
  for (const x of sea.sailings) {
    for (const t of x.outgoing) {
      const d = deal(true, t.partner, t.good);
      d.pieces.push({ package: t.id, step: 0, words: OUT_STEPS[0], eta: null, seen: false });
      d.coins += t.price * GOODS[t.good].per;
    }
  }
  for (const d of deals.values()) d.pieces.sort((a, b) => b.step - a.step || (a.eta ?? Infinity) - (b.eta ?? Infinity));
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
    // Gone with packages still on it: its last is in, or sailed.
    const ended = last.filter((d) => !keys.has(d.key) && d.pieces.some((b) => b.seen));
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
