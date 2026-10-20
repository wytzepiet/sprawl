import { drawnPath, type DrawnPath, type Fix } from "./drawnPath";
import { CAR_RIG, driveTrip, LORRY_RIG, straight, type Drive, type Pose, type Rig } from "./driver";
import { behind, CAB_BLOCK, deckPose, sailing, shunting } from "./sea";
import { rgb } from "../rgb";
import { CAB, LANE_OFFSET, TRAILER, VAN } from "./roadGeometry";
import { spot } from "../tiles";
import type { Car, GridCoord, RoadNode, Trailer, Trip } from "../../generated";
import { getObjectsAt } from "../../state/gameObjects";
import type { Pose as Stand } from "../../generated/Pose";

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

/** The rig a vehicle steers as: a lorry's cab and the box on its hitch, a
 *  bobtail cab, or a car. */
export const rigOf = (car: Car): Rig => (car.role !== "Truck" ? CAR_RIG : car.hitched ? LORRY_RIG : { axle: LORRY_RIG.axle });

/** Each vehicle's drive, kept while its trip's route and lanes are the
 *  same; a change of lanes, driven across from the lanes it left. */
const drives = new Map<number, { key: string; lanes: number[]; drive: Drive | null }>();
export function driveOf(id: number, car: Car): Drive | null {
  const t = car.trip;
  if (!t) return void drives.delete(id), null;
  const rig = rigOf(car);
  const key = JSON.stringify([t.route_positions, t.from_lot, t.to_lot, t.backing, t.cusps, t.leaves, t.stands, rig, t.lanes, t.shift?.along]);
  const me = drives.get(id);
  if (me?.key === key) return me.drive;
  const lanes = lanesOf(t.route_positions, t.route_heights ?? [], t.lanes ?? []);
  const sh = t.shift;
  const was = me && sh && sh.from !== sh.to && me.lanes.length === lanes.length ? { lanes: me.lanes, along: sh.along, over: sh.over } : undefined;
  const drive = driveTrip(t, rig, lanes, was);
  drives.set(id, { key, lanes, drive });
  return drive;
}

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

/** A parked lorry's box, straight behind its cab. */
export const straightBehind = (p: Pose): Pose => straight(p, LORRY_RIG)!;

/** A tractor on its run over the land (a ferry's is `sailing`): the
 *  planned tiles, centre to centre with no lane, on the same rounded path
 *  as a trip so it corners like anything else — but by the server's
 *  clock, not by its own physics: on the run's `k`th tile `k` paces after
 *  it started, wherever the corners put that on the path, so it is where
 *  the server has it when the job is done there. */
export function running(car: Car): { drawn: DrawnPath; at(now: number, z: number): Fix } | null {
  const run = car.run!;
  const drawn = drawnPath(run.path.map(({ x, y }) => ({ x: x + 0.5, y: y + 0.5 })), 0, 0, 0);
  if (!drawn) return null;
  const { atNode } = drawn;
  return {
    drawn,
    at(now, z) {
      const tile = Math.min(Math.max(0, (now - run.started) / run.pace), run.path.length - 1);
      const k = Math.min(Math.floor(tile), atNode.length - 2);
      return drawn.at(atNode[k] + (atNode[k + 1] - atNode[k]) * (tile - k), z);
    },
  };
}

/** A ferry's leg, by the server's clock; none while it is moored or away. */
export const voyage = (car: Car): ((now: number) => Stand) | null => (car.sail ? sailing(car.sail) : null);

/** What stands on a ferry's deck, each in its slot `k` and so far along
 *  it, `d`: the boxes, and the settlers' cars in the free slots from the
 *  sea end, two to a slot, so the first to roll off is at the land end. */
export function aboard(car: Car): { k: number; d: number; box?: Trailer; settler?: number }[] {
  const slots = car.deck.length ? car.deck : Array<null>(15).fill(null);
  const free = [...slots.keys()].filter((k) => !slots[k]).reverse();
  return [
    ...slots.flatMap((box, k) => (box ? [{ k, d: 0, box }] : [])),
    ...[...car.passengers].reverse().flatMap((settler, j) => (free[j >> 1] === undefined ? [] : [{ k: free[j >> 1], d: j & 1 ? 0.15 : -0.15, settler }])),
  ];
}

/** A pose moved `d` along its heading. */
export const ahead = (p: Stand, d: number): Stand => ({ at: [p.at[0] + Math.cos(p.heading) * d, p.at[1] + Math.sin(p.heading) * d], heading: p.heading });

/** What a box behind a cab holds: a good, and how much. */
export type Load = Pick<Trailer, "good" | "units">;

/** The box behind a vehicle's cab: a lorry's on its hitch, the world's; a
 *  van's its load on a call. None for a bobtail, or anything else. */
export function carried(car: Car): Load | null {
  if (car.role === "Truck") return car.hitched;
  if (car.role === "Van") return car.load && { good: car.load[0], units: car.load[1] };
  return null;
}

/** A van is a small rigid lorry, VAN long: a lorry's tractor at the front,
 *  and on its chassis from behind the cab its body (`rigidShape` in
 *  `sea.ts`), the rest of the length: a flatbed for a builder's load, a
 *  box for a shop's; `VAN_BOX` of a box's length, so it holds that share
 *  of one. */
export const VAN_BOX = (VAN.l - CAB_BLOCK) / TRAILER.l;
export const vanParts = (middle: Stand): { body: Stand; box: Stand } => ({ body: ahead(middle, (VAN.l - CAB.l) / 2), box: ahead(middle, -CAB_BLOCK / 2) });

const stand = (p: Pose): Stand => ({ at: [p.x, p.y], heading: p.heading });

/** A vehicle at a moment: its body; the box on its hitch; on a ferry's
 *  deck, what stands there. */
export interface Moment {
  body: Stand;
  box?: Stand;
  deck?: { at: Stand; box?: Trailer; settler?: number }[];
}

/** Where a vehicle is at `now`, exactly where the server's physics has it
 *  (the 3D view eases a change of pedal in over half a second; this does
 *  not); none if it is out of sight. */
export function moment(id: number, car: Car, now: number): Moment | null {
  switch (car.role) {
    case "Ferry": {
      const sail = voyage(car);
      if (!sail && !car.spot) return null;
      const body = sail ? sail(now) : car.spot!;
      return { body, deck: aboard(car).map(({ k, d, box, settler }) => ({ at: ahead(deckPose(body, k), d), box, settler })) };
    }
    case "Tug": {
      const p = car.shunt && car.spot ? shunting(car.shunt, car.spot, !!car.hitched)(now) : car.spot && { tug: car.spot, box: behind(car.spot) };
      return p ? { body: p.tug, box: car.hitched ? p.box : undefined } : null;
    }
  }
  if (car.run) {
    const fix = running(car)?.at(now, 0);
    return fix ? { body: { at: [fix.pos[0], fix.pos[1]], heading: fix.rot[2] + Math.PI / 2 } } : null;
  }
  const drive = driveOf(id, car);
  const lorry = car.role === "Truck";
  if (drive) {
    const p = drive.at(Math.min(travelled(car.trip!, now)[0], drive.length));
    return { body: stand(p.body), box: lorry && car.hitched ? stand(p.trailer ?? straightBehind(p.body)) : undefined };
  }
  if (!car.spot) return null;
  const body = car.spot;
  return { body, box: lorry && car.hitched ? stand(straightBehind({ x: body.at[0], y: body.at[1], heading: body.heading })) : undefined };
}
