import { drawnPath } from "./drawnPath";
import { ahead, CAR_RIG, driveTrip, LORRY_RIG, type Drive, type Rig } from "./driver";
import { CAB_BLOCK, deckPose, sailing } from "./sea";
import { rgb } from "../rgb";
import { CAB, LANE_OFFSET, VAN } from "./roadGeometry";
import { spot } from "../tiles";
import type { Car, Good, Pose, RoadNode, Run, Sail, Trip } from "../../generated";
import { GOODS } from "../../blueprints";
import { getObjectsAt } from "../../state/gameObjects";

/**
 * Where a vehicle stands at a moment and what it carries, from the
 * server's state and its clock: read one way for both views, so the 3D
 * one (`CarObject.tsx`) and the flat one (`flat/`) cannot disagree.
 */

/** Everyone keeps their car for life, and its id never changes — so neither
 *  does its colour. */
export const PALETTE = [
  rgb(0.9, 0.25, 0.2),
  rgb(0.85, 0.85, 0.88),
  rgb(0.2, 0.22, 0.28),
  rgb(0.25, 0.4, 0.75),
  rgb(0.65, 0.65, 0.68),
  rgb(0.55, 0.15, 0.15),
  rgb(0.2, 0.5, 0.4),
  rgb(0.8, 0.65, 0.25),
];
/** What the working vehicles are painted: a tractor the farm's green, a
 *  lorry's cab (a van's too), the ferry's hull. */
export const LIVERY = {
  tractor: rgb(0.36, 0.55, 0.16),
  cab: rgb(0.28, 0.36, 0.58),
  ferry: rgb(0.96, 0.96, 0.95),
};
/** A car's colour in the palette, a fact about the car, not a roll of the dice. */
export function colourOf(id: number): number {
  let h = (id ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return Math.floor((((h ^ (h >>> 16)) >>> 0) / 0xffffffff) * PALETTE.length);
}

/** The fastest a vehicle goes, in tiles a second: `car::CRUISE_SPEED`. */
const CRUISE = 1.5;

/** How far along its route a trip's physics has a vehicle at `now`, and
 *  how fast it goes there, as the server has it (`physics::catch_up`):
 *  braking stops at a standstill, pulling away at cruising speed. */
export function travelled(t: Trip, now: number): [number, number] {
  const dt = Math.max(0, (now - t.updated_at) / 1000);
  const a = t.acceleration;
  const until = a < 0 ? -t.speed / a : a > 0 ? Math.max(0, (CRUISE - t.speed) / a) : Infinity;
  const s = Math.min(dt, until);
  const [p, v] = [t.progress + t.speed * s + 0.5 * a * s * s, t.speed + a * s];
  return a > 0 && dt > until ? [p + CRUISE * (dt - until), CRUISE] : [p, v];
}

/** The rig a vehicle steers as: a lorry's cab and its flatbed, or a car. */
const rigOf = (car: Car): Rig => (car.role === "Truck" ? LORRY_RIG : CAR_RIG);

/** Each vehicle's drive, kept while its trip's route and lanes are the
 *  same; a change of lanes, driven across from the lanes it left. */
const drives = new Map<number, { car: Car; key: string; lanes: number[]; drive: Drive | null }>();
export function driveOf(id: number, car: Car): Drive | null {
  const t = car.trip;
  if (!t) return void drives.delete(id), null;
  const me = drives.get(id);
  if (me?.car === car) return me.drive;
  const rig = rigOf(car);
  const key = JSON.stringify([t.route_positions, t.from_lot, t.to_lot, t.backing, t.cusps, t.leaves, t.stands, rig, t.lanes, t.shift?.along]);
  if (me?.key === key) return (me.car = car), me.drive;
  const lanes = lanesOf(t.route_positions, t.route_heights ?? [], t.lanes ?? []);
  const sh = t.shift;
  const was = me && sh && sh.from !== sh.to && me.lanes.length === lanes.length ? { lanes: me.lanes, along: sh.along, over: sh.over } : undefined;
  const drive = driveTrip(t, rig, lanes, was);
  drives.set(id, { car, key, lanes, drive });
  return drive;
}
/** A vehicle gone: its drive with it. */
export const forgetDrive = (id: number) => void drives.delete(id);

/** Where a lane runs from the road's middle, by what kind of link it is
 *  on: a two-way's to the right of the middle, a one-way's down it. A
 *  road on a side of its tiles is a one-way, its nodes already moved over
 *  (`route_positions`, `World::node_pos`). */
const LANES = { t: LANE_OFFSET, o: 0 };

/** The lane at each node of a route: its links', the two either side of
 *  it met halfway. Read off the road nodes the client holds, where it holds
 *  them; else a two-way's. */
function lanesOf(route: [number, number][], heights: number[], lanes: number[]): number[] {
  const link = route.slice(1).map(([x, y], k) => {
    const [px, py] = route[k];
    const [a, b] = [roadAt(px, py, heights[k] ?? 0), roadAt(x, y, heights[k + 1] ?? 0)];
    if (!a || !b) return LANES.t;
    const [out, back] = [a.data.outgoing.includes(b.id), a.data.incoming.includes(b.id) || b.data.outgoing.includes(a.id)];
    // A road of two lanes, one way: the right lane or the left (`lanes_for`).
    if (out && a.data.wide.includes(b.id)) return lanes[k + 1] ? -LANE_OFFSET : LANE_OFFSET;
    return out && back ? LANES.t : LANES.o;
  });
  return route.map((_, k) => {
    const near = [link[k - 1], link[k]].filter((l) => l !== undefined);
    return near.length ? near.reduce((s, l) => s + l, 0) / near.length : LANES.t;
  });
}

/** The road node a route passes through here: of those on its tile at its
 *  height, the one standing nearest, where two share it side by side. */
function roadAt(x: number, y: number, height: number): { id: number; data: RoadNode } | undefined {
  const t = { x: Math.floor(x), y: Math.floor(y) };
  let best: { id: number; data: RoadNode } | undefined;
  let near = Infinity;
  for (const o of getObjectsAt(t.x, t.y)) {
    if (o.object.kind !== "RoadNode" || (o.object.data.height ?? 0) !== height) continue;
    const [sx, sy] = spot(t, o.object.data.side);
    const d = Math.hypot(sx - x, sy - y);
    if (d < near) [best, near] = [{ id: o.id, data: o.object.data }, d];
  }
  return best;
}

/** A parked lorry's flatbed, straight behind its cab. */
export const straightBehind = (p: Pose): Pose => ahead(p, -(LORRY_RIG.axle + LORRY_RIG.trailer!.middle));

/** A tractor on its run over the land (a ferry's is `sailing`): the
 *  planned tiles, centre to centre with no lane, on the same rounded path
 *  as a trip so it corners like anything else — but by the server's
 *  clock, not by its own physics: on the run's `k`th tile `k` paces after
 *  it started, wherever the corners put that on the path, so it is where
 *  the server has it when the job is done there. Kept for the run. */
const runs = new WeakMap<Run, ((now: number) => Pose) | null>();
function running(run: Run): ((now: number) => Pose) | null {
  if (runs.has(run)) return runs.get(run)!;
  const drawn = drawnPath(run.path.map(({ x, y }) => [x + 0.5, y + 0.5]), 0, 0, 0);
  const at = drawn && ((now: number): Pose => {
    const s = drawn.passing((now - run.started) / run.pace);
    return { at: drawn.at(s), heading: drawn.heading(s) };
  });
  runs.set(run, at);
  return at;
}

/** A ferry's leg, by the server's clock, kept for the leg. */
const sails = new WeakMap<Sail, (now: number) => Pose>();
const voyage = (s: Sail) => sails.get(s) ?? sails.set(s, sailing(s)).get(s)!;

/** What stands on a ferry's deck, each where it stands: the pallets in
 *  their bays, four to a bay, two by two, the land end's first; and the
 *  settlers' cars in the bays with none, from the sea end, two to a bay,
 *  so the first to roll off is at the land end (`seats`). */
const [PER_BAY, BAYS] = [4, 15];
function aboard(car: Car, ship: Pose): { at: Pose; good?: Good; settler?: number }[] {
  const empty = [...Array(BAYS).keys()].filter((k) => car.deck.slice(k * PER_BAY, (k + 1) * PER_BAY).every((p) => !p)).reverse();
  return [
    ...car.deck.flatMap((p, i) => {
      if (!p) return [];
      const bay = deckPose(ship, Math.floor(i / PER_BAY));
      const q = i % PER_BAY;
      return [{ at: aside(ahead(bay, q < 2 ? 0.08 : -0.08), q % 2 ? 0.055 : -0.055), good: p.good }];
    }),
    ...[...car.passengers].reverse().flatMap((settler, j) => (empty[j >> 1] === undefined ? [] : [{ at: ahead(deckPose(ship, empty[j >> 1]), j & 1 ? 0.15 : -0.15), settler }])),
  ];
}
/** So far to the left of a pose, facing the same way. */
const aside = (p: Pose, d: number): Pose => ({ at: [p.at[0] - Math.sin(p.heading) * d, p.at[1] + Math.cos(p.heading) * d], heading: p.heading });

/** What stands on a vehicle's flatbed, a good a package, from the front:
 *  a lorry's cargo, a van's load in whole packages. None for anything
 *  else. */
export function carried(car: Car): Good[] {
  if (car.role === "Truck") return car.cargo.map((p) => p.good);
  if (car.role === "Van" && car.load) return Array(Math.ceil(car.load[1] / GOODS[car.load[0]].per - 1e-9)).fill(car.load[0]);
  return [];
}

/** A package's footprint, square, in tiles: a pallet's, a crate's, a
 *  bundle's; five stand in a row on a lorry's flatbed, three on a van's
 *  (`LOAD`, `VAN_LOAD`). */
export const ITEM = 0.084;
/** Where the `k`th package from the front stands on a flatbed at `bed`,
 *  `l` long: in a row down its middle, from the headboard back. */
export const onBed = (bed: Pose, l: number, k: number): Pose => ahead(bed, l / 2 - 0.022 - (k + 0.5) * (ITEM + 0.004));

/** A van is a small rigid lorry, VAN long: a lorry's tractor at the front,
 *  and on its chassis from behind the cab a flatbed (`vanBed` in
 *  `sea.ts`), the rest of the length. */
export const VAN_BED = VAN.l - CAB_BLOCK;
const vanParts = (middle: Pose): Moment => ({ body: ahead(middle, (VAN.l - CAB.l) / 2), bed: ahead(middle, -CAB_BLOCK / 2) });

/** A vehicle at a moment: its body (a lorry's or a van's, its cab); the
 *  flatbed behind it; on a ferry's deck, what stands there. */
export interface Moment {
  body: Pose;
  bed?: Pose;
  deck?: { at: Pose; good?: Good; settler?: number }[];
}

/** Where a vehicle is at `now`: on a trip, `along` its route if that is
 *  given (the 3D view eases a change of pedal in over half a second),
 *  else exactly where the server's physics has it; none if it is out of
 *  sight. */
export function moment(id: number, car: Car, now: number, along?: number): Moment | null {
  if (car.role === "Ferry") {
    const body = car.sail ? voyage(car.sail)(now) : car.spot;
    return body && { body, deck: aboard(car, body) };
  }
  if (car.run) {
    const body = running(car.run)?.(now);
    return body ? { body } : null;
  }
  const drive = driveOf(id, car);
  const p = drive ? drive.at(Math.min(along ?? travelled(car.trip!, now)[0], drive.length)) : car.spot && { body: car.spot };
  if (!p) return null;
  if (car.role === "Van") return vanParts(p.body);
  return { body: p.body, bed: car.role === "Truck" ? p.trailer ?? straightBehind(p.body) : undefined };
}
