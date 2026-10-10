import { drawnPath, type DrawnPath, type Fix } from "./drawnPath";
import { CAR_RIG, driveTrip, LORRY_RIG, type Drive, type Pose, type Pt, type Rig } from "./driver";
import { behind, deckPose, sailing, shunting } from "./sea";
import { rgb } from "../rgb";
import type { Car, GridCoord, Trailer, Trip } from "../../generated";
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
/** What the working vehicles are painted: a van always the same white, a
 *  tractor the farm's green, a lorry's cab, the ferry's hull. */
export const LIVERY = {
  van: rgb(0.92, 0.92, 0.9),
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

/** How far along its route a trip's physics has a vehicle at `now`, and
 *  how fast it goes there. */
export function travelled(t: Trip, now: number): [number, number] {
  let dt = Math.max(0, (now - t.updated_at) / 1000);
  if (t.acceleration < 0) dt = Math.min(dt, -t.speed / t.acceleration);
  return [t.progress + t.speed * dt + 0.5 * t.acceleration * dt * dt, t.speed + t.acceleration * dt];
}

/** The rig a vehicle steers as: a lorry's cab and the box on its hitch, a
 *  bobtail cab, or a car. */
export const rigOf = (car: Car): Rig => (car.role !== "Truck" ? CAR_RIG : car.hitched ? LORRY_RIG : { axle: LORRY_RIG.axle });

/** Each vehicle's drive, kept while its trip's route is the same. */
const drives = new Map<number, { route: string; drive: Drive | null }>();
/** A vehicle's trip, driven as `driver.ts` steers it; none off a trip. */
export function driveOf(id: number, car: Car): Drive | null {
  const t = car.trip;
  if (!t) return void drives.delete(id), null;
  const rig = rigOf(car);
  const route = JSON.stringify([t.route_positions, t.from_lot, t.to_lot, t.backing, rig]);
  let me = drives.get(id);
  if (me?.route !== route) drives.set(id, (me = { route, drive: driveTrip(t.route_positions as Pt[], t.from_lot, t.to_lot, t.backing, rig) }));
  return me.drive;
}

/** A parked lorry's box, straight behind its cab. */
export function straightBehind(p: Pose): Pose {
  const back = LORRY_RIG.axle + LORRY_RIG.trailer!.middle;
  return { x: p.x - Math.cos(p.heading) * back, y: p.y - Math.sin(p.heading) * back, heading: p.heading };
}

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

/** A ferry's voyage, by the server's clock: in, if it ends nearer its
 *  harbour (`home`) than it begins. None while it is moored or away. */
export function voyage(car: Car, home: GridCoord | null | undefined): ((now: number) => Stand) | null {
  const path = car.run?.path;
  if (!path || path.length < 2) return null;
  const near = (t: GridCoord) => (home ? Math.hypot(t.x - home.x, t.y - home.y) : 0);
  return sailing(car, near(path[path.length - 1]) < near(path[0]));
}

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
 *  not); none if it is out of sight. `home` is a ferry's harbour. */
export function moment(id: number, car: Car, now: number, home?: GridCoord | null): Moment | null {
  switch (car.role) {
    case "Ferry": {
      const sail = voyage(car, home);
      if (!sail && !car.spot) return null;
      const body = sail ? sail(now) : car.spot!;
      return { body, deck: aboard(car).map(({ k, d, box, settler }) => ({ at: ahead(deckPose(body, k), d), box, settler })) };
    }
    case "Tug": {
      const p = car.shunt ? shunting(car.shunt)(now) : car.spot && { tug: car.spot, box: behind(car.spot) };
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
