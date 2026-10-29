import type { Building, Lift, Pose } from "../../generated";
import { FORKS, ITEMS } from "./goods";
import { atPad, DROP, ends, packagesOf, PICK, placeIn, type Pad } from "./pads";

/**
 * How a forklift drives a lift (`Lift`, `pads.ts`): as a forklift does,
 * never through a lorry or a stack. To each package it drives up square to
 * it, forks first, takes it up, backs out, turns on the spot, drives
 * across to the other end, comes up square again and sets it down: on a
 * flatbed from its side, on a pad from the bay's open face, by way of the
 * aisle's end where the bay stands in one. Between runs it goes home.
 *
 * The server says when (one package an `every`); this says how. Each lift
 * is three parts, each played in its own share of the `every` so the
 * package leaves at `PICK` and lands at `DROP` as the counts say: in to
 * the package, and lift; across with it, and set it down; back out.
 */

type P = [number, number];

/** One end of a lift: where the package stands, which way its open face
 *  looks (out from it to where the forklift comes), how high it stands,
 *  whether it is in the pad's aisle, left by its mouth (`Pad::exits`), and
 *  how far from it the forklift's middle stops: its forks' reach, or more
 *  where a flatbed's edge stands between; and a point it is come to and
 *  left by, a ferry's lane's end. */
export interface End {
  at: P;
  face: number;
  z: number;
  inside: boolean;
  reach: number;
  via?: P;
}

/** What a forklift drives in: its home and whether that is in its pad's
 *  aisle, the aisle's mouths and the line down its middle, and each
 *  package's two ends, the `j`th of a lift. */
export interface Yard {
  id: number;
  home: Pose;
  homeInside: boolean;
  exits: P[];
  aisle: [P, P] | null;
  ends(l: Lift, j: number): { from: End; to: End } | null;
}

/** As it drives with nothing to keep to: tiles a second, radians a second
 *  turning on the spot, seconds to take a package up or set it down. */
const [SPEED, TURN, LIFT] = [1, 3, 0.25];
/** How long after its run a forklift may still be on its way home. */
export const REST_MS = 10_000;
/** How far it backs out from a package before it turns; how far before
 *  its middle its mast stands, which a flatbed's edge stops. */
const [CLEAR, MAST] = [0.12, 0.05];

/** Where a forklift stands to an end, `back` out from its package,
 *  facing it. */
const stand = (e: End, back: number): Pose => ({ at: [e.at[0] + Math.cos(e.face) * back, e.at[1] + Math.sin(e.face) * back], heading: e.face + Math.PI });
const touch = (e: End) => stand(e, e.reach);
/** Where it backs out to from an end before it turns: the aisle's middle,
 *  from a bay on it; else a little way. */
function clear(yard: Yard, e: End): Pose {
  const t = touch(e);
  if (!e.inside || !yard.aisle) return stand(e, e.reach + CLEAR);
  const [[ax, ay], [bx, by]] = yard.aisle;
  // Out along the face to the line through the aisle.
  const [fx, fy, nx, ny] = [Math.cos(e.face), Math.sin(e.face), -(by - ay), bx - ax];
  const k = ((ax - t.at[0]) * nx + (ay - t.at[1]) * ny) / (fx * nx + fy * ny || 1);
  return { at: [t.at[0] + fx * k, t.at[1] + fy * k], heading: t.heading };
}

/** A part of a drive: a turn on the spot, a straight run (forward, or
 *  back, facing where it came from), or a stand while the forks work. */
type Step = { turn: [number, number]; at: P } | { run: [P, P]; heading: number } | { stand: Pose };
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const cost = (s: Step) => ("turn" in s ? Math.abs(wrap(s.turn[1] - s.turn[0])) / TURN : "run" in s ? Math.hypot(s.run[1][0] - s.run[0][0], s.run[1][1] - s.run[0][1]) / SPEED : LIFT);

/** The steps from a pose through points, forward or backing. */
function drive(from: Pose, through: P[], back = false): { steps: Step[]; end: Pose } {
  const steps: Step[] = [];
  let { at, heading } = from;
  for (const to of through) {
    const [dx, dy] = [to[0] - at[0], to[1] - at[1]];
    if (Math.hypot(dx, dy) < 1e-4) continue;
    const want = Math.atan2(dy, dx) + (back ? Math.PI : 0);
    if (Math.abs(wrap(want - heading)) > 1e-3) steps.push({ turn: [heading, heading + wrap(want - heading)], at });
    heading = want;
    steps.push({ run: [at, to], heading });
    at = to;
  }
  return { steps, end: { at, heading } };
}

/** How far along a step from a stand to a stand `u` of its time is: the
 *  first sixth or so of it gathering speed, the last slowing. */
const RAMP = 0.15;
function eased(u: number): number {
  const top = 1 / (1 - RAMP);
  if (u < RAMP) return (top * u * u) / (2 * RAMP);
  if (u > 1 - RAMP) return 1 - (top * (1 - u) * (1 - u)) / (2 * RAMP);
  return top * (u - RAMP / 2);
}

/** Where `t` of the way through its steps puts it, each step its share of
 *  the time as it would take; and which step it is on, how far through. */
function along(steps: Step[], t: number): { pose: Pose; step: number; u: number } | null {
  const total = steps.reduce((s, x) => s + cost(x), 0);
  if (!steps.length || total <= 0) return null;
  let left = Math.min(1, Math.max(0, t)) * total;
  for (const [i, s] of steps.entries()) {
    const c = cost(s);
    if (left > c && i < steps.length - 1) {
      left -= c;
      continue;
    }
    const u = c > 0 ? Math.min(1, left / c) : 1;
    const k = eased(u);
    if ("turn" in s) return { pose: { at: s.at, heading: s.turn[0] + (s.turn[1] - s.turn[0]) * k }, step: i, u };
    if ("run" in s) return { pose: { at: [s.run[0][0] + (s.run[1][0] - s.run[0][0]) * k, s.run[0][1] + (s.run[1][1] - s.run[0][1]) * k], heading: s.heading }, step: i, u };
    return { pose: s.stand, step: i, u };
  }
  return null;
}

/** Of some points, the one nearest another. */
const nearest = (ps: P[], to: P): P => ps.reduce((best, p) => (Math.hypot(p[0] - to[0], p[1] - to[1]) < Math.hypot(best[0] - to[0], best[1] - to[1]) ? p : best));

/** The points between two places, by the aisle's mouth nearer the one
 *  outside it where one is in and one is out. */
function between(yard: Yard, a: { at: P; inside: boolean }, b: { at: P; inside: boolean }): P[] {
  if (a.inside === b.inside || !yard.exits.length) return [];
  return [nearest(yard.exits, a.inside ? b.at : a.at)];
}

/** A lift's `j`th package as three drives from `from`: in to it, across
 *  with it, back out; or none if its vehicle is not there to be seen. */
function trip(yard: Yard, l: Lift, j: number, from: Pose, inside: boolean, left?: P) {
  const e = yard.ends(l, j);
  if (!e) return null;
  const { from: a, to: b } = e;
  const by = (e: End | undefined) => (e?.via ? [e.via] : []);
  const fetch = drive(from, [...(left ? [left] : []), ...between(yard, { at: from.at, inside }, a), ...by(a), clear(yard, a).at, touch(a).at]);
  const out = drive(fetch.end, [clear(yard, a).at], true);
  const carry = drive(out.end, [...by(a), ...between(yard, a, b), ...by(b), clear(yard, b).at, touch(b).at]);
  const back = drive(carry.end, [clear(yard, b).at], true);
  // The carry starts and ends standing: the package taken onto the forks,
  // and set off them.
  return { a, b, fetch: fetch.steps, carry: [{ stand: fetch.end }, ...out.steps, ...carry.steps, { stand: carry.end }], back: back.steps, end: back.end, inside: b.inside, via: b.via };
}

/** Where a forklift is after its last run, `t` ms after it ended: on its
 *  way home at its own pace, then there. */
function resting(yard: Yard, lifts: Lift[], t: number): Pose {
  const last = lifts.filter((l) => ends(l) <= t).sort((p, q) => ends(q) - ends(p))[0];
  if (!last) return yard.home;
  const done = chain(yard, lifts, last, last.n - 1);
  if (!done) return yard.home;
  const home = drive(done.end, [...(done.via ? [done.via] : []), ...between(yard, { at: done.end.at, inside: done.inside }, { at: yard.home.at, inside: yard.homeInside }), yard.home.at]);
  const steps = [...home.steps, { turn: [home.end.heading, home.end.heading + wrap(yard.home.heading - home.end.heading)] as [number, number], at: yard.home.at }];
  const total = steps.reduce((s, x) => s + cost(x), 0) * 1000;
  return total > 0 && t - ends(last) < total ? along(steps, (t - ends(last)) / total)!.pose : yard.home;
}

/** Each trip as it was first worked out, by building, forklift, run and
 *  package: what a trip starts from is where the last left it, and that
 *  vehicle may since have gone. Kept until a minute after its run. */
const trips = new Map<string, { trip: NonNullable<ReturnType<typeof trip>>; until: number }>();

/** A lift's `j`th trip, from where the last left it: the one before, or
 *  where it rested when the run began. */
function chain(yard: Yard, lifts: Lift[], l: Lift, j: number): ReturnType<typeof trip> {
  const key = `${yard.id}:${l.k}:${l.start}:${j}`;
  const kept = trips.get(key);
  if (kept) return kept.trip;
  const before = j > 0 ? chain(yard, lifts, l, j - 1) : null;
  if (j > 0 && !before) return null;
  const made = trip(yard, l, j, before ? before.end : resting(yard, lifts, l.start), before ? before.inside : yard.homeInside, before?.via);
  if (!made) return null;
  if (trips.size > 2000) for (const [k, v] of trips) if (v.until < l.start - 60_000) trips.delete(k);
  trips.set(key, { trip: made, until: ends(l) });
  return made;
}

/** Where a building's forklift is at `now`, by its runs, and the package
 *  in its forks if it has one, with how high it is held. */
export function forkliftAt(yard: Yard, lifts: Lift[], now: number): { truck: Pose; load: { at: Pose; z: number } | null } {
  const l = lifts.find((l) => l.start <= now && ends(l) > now);
  if (!l) return { truck: resting(yard, lifts, now), load: null };
  const e = (now - l.start) / l.every;
  const j = Math.floor(e), t = e - j;
  const made = chain(yard, lifts, l, j);
  if (!made) return { truck: yard.home, load: null };
  if (t < PICK) return { truck: along(made.fetch, t / PICK)?.pose ?? made.end, load: null };
  if (t >= DROP) return { truck: along(made.back, (t - DROP) / (1 - DROP))?.pose ?? made.end, load: null };
  const k = (t - PICK) / (DROP - PICK);
  const { pose: truck, step, u } = along(made.carry, k)!;
  // On the forks; slid on at the start from where it stood, and off at the
  // end to where it goes, where the forklift stops short of it.
  const forks: P = [truck.at[0] + Math.cos(truck.heading) * FORKS, truck.at[1] + Math.sin(truck.heading) * FORKS];
  const mix = (p: P, q: P, s: number): P => [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s];
  const at = step === 0 ? mix(made.a.at, forks, u) : step === made.carry.length - 1 ? mix(forks, made.b.at, u) : forks;
  return { truck, load: { at: { at, heading: truck.heading }, z: made.a.z + (made.b.z - made.a.z) * k } };
}

/** A building's forklifts, each its yard and its runs: `runs` its lifts,
 *  and a mill's own from its barn `door` (`car` -1). Its pad's packages
 *  stand on `base`; `slotOf` is where a run's package stands on its
 *  vehicle (`liftSlot`). */
export function yardsOf(id: number, data: Building, pad: Pad, base: number, runs: Lift[], slotOf: (l: Lift, j: number) => { at: Pose; z: number; edge: number; face?: number; via?: P } | null, door?: Pose): { yard: Yard; mine: Lift[] }[] {
  /** A run's `j`th package's two ends: where it stands on the pad, the
   *  next free place or the last taken as the pad is seen when it is
   *  taken up or set down there, its bay's face toward the forklift; and
   *  its place on the vehicle, which a forklift comes to from the side the
   *  pad is on, square to it. */
  const endsOf = (l: Lift, j: number): { from: End; to: End } | null => {
    const bay = pad.bays.find((b) => b.good === l.good);
    if (!bay) return null;
    const when = l.start + (j + (l.onto ? PICK : DROP)) * l.every - 1;
    const seen = packagesOf(data, l.good) + runs.filter((m) => m.good === l.good).reduce((n, m) => n + atPad(m, when), 0);
    const [slot, up] = placeIn(bay, l.onto ? seen - 1 : seen);
    const onPad: End = { at: slot.at, face: bay.face, z: base + up * ITEMS[l.good].h, inside: bay.inside, reach: FORKS };
    const there = l.car === -1 ? (door ? { at: door, z: base, edge: 0 } : null) : slotOf(l, j);
    if (!there) return null;
    // The side it comes from: the pad's, or its aisle mouth's.
    const [x, y] = there.at.at;
    const [rx, ry] = bay.inside && pad.exits.length ? nearest(pad.exits, [x, y]) : slot.at;
    const side = there.at.heading + Math.PI / 2;
    const toward = Math.cos(side) * (rx - x) + Math.sin(side) * (ry - y) >= 0;
    const face = l.car === -1 ? there.at.heading : (there.face ?? (toward ? side : side + Math.PI));
    const onCar: End = { at: [x, y], face, z: there.z, inside: false, reach: Math.max(FORKS, there.edge + MAST), via: there.via };
    return l.onto ? { from: onPad, to: onCar } : { from: onCar, to: onPad };
  };
  return pad.homes.map((home, k) => ({ yard: { id, home, homeInside: pad.homeInside, exits: pad.exits, aisle: pad.aisle, ends: endsOf }, mine: runs.filter((l) => l.k === k) }));
}
