import type { MaterialPlugin } from "@babylonjs/lite";
import type { EngineContext } from "../Canvas";
import { rgb, WHITE, type Rgb } from "../rgb";
import type { MeshGeometry } from "../geometry";
import type { InstancePool } from "../InstancePool";
import { boxGeometry } from "./buildings";
import { carShape, ROUNDING } from "./carShape";
import { lacquer } from "../bevel";
import { simNow } from "../../network/clock";
import { SOLID, type Look } from "./look";
import { drawnPath, type DrawnPath, type Fix } from "./drawnPath";
import type { Theme } from "../theme";
import type { Strip } from "./strip";
import { field, FIELD_Z, leaves } from "./BuildingObject";
import { CAB, CAR, ROAD_Z } from "./roadGeometry";
import { behind, boxShape, DECK_Z, deckPose, FERRY_SHAPE, sailing, shunting, TUG, TUG_SHAPE } from "./sea";
import { CAR_RIG, driveTrip, LORRY_RIG, type Drive, type Pose, type Pt, type Rig } from "./driver";
import { getEntity } from "../../state/gameObjects";
import type { Building, Car, GameObjectEntry, Trailer } from "../../generated";
import type { Pose as Stand } from "../../generated/Pose";
import { carPoses, parts } from "../../state/selection";

/// Everyone keeps their car for life, and its id never changes — so neither
/// does its colour.
const PALETTE = [
  rgb(0.9, 0.25, 0.2),
  rgb(0.85, 0.85, 0.88),
  rgb(0.2, 0.22, 0.28),
  rgb(0.25, 0.4, 0.75),
  rgb(0.65, 0.65, 0.68),
  rgb(0.55, 0.15, 0.15),
  rgb(0.2, 0.5, 0.4),
  rgb(0.8, 0.65, 0.25),
];
const carGeo = carShape(CAR.w, CAR.l, CAR.h);
/** A van: a box a car and a bit long, tall, and always the same white. */
const vanGeo = boxGeometry(0.17, 0.37, 0.18);
const VAN = rgb(0.92, 0.92, 0.9);
const TRACTOR = rgb(0.36, 0.55, 0.16);
/** A lorry: a cab-over tractor, the vehicle the server moves, and the box
 *  on its hitch, if it has one (`driver.ts`, `sea.ts`). */
const cabGeo = boxGeometry(CAB.w, CAB.l, CAB.h);
const CAB_COLOR = rgb(0.28, 0.36, 0.58);
const FERRY_COLOR = rgb(0.96, 0.96, 0.95);

/** A box sits on the road: its centre is half its height up. */
const CAR_Z = ROAD_Z + CAR.h / 2;
const GROUND = ROAD_Z;

/** A vehicle's finish: its paint a clear coat, glossier than the town's
 *  lacquer, and its glass (the shape's darker vertices, `carShape.ts`) all
 *  but a mirror, the sky in it. */
const finish = (glazed: boolean): MaterialPlugin => ({
  name: glazed ? "ClearCoatGlazed" : "ClearCoat",
  priority: 900,
  getCustomCode: (stage) =>
    stage === "fragment"
      ? { CUSTOM_FRAGMENT_UPDATE_DIFFUSE: glazed ? `roughness = select(${PAINT_ROUGH.toFixed(3)}, ${GLASS_ROUGH.toFixed(3)}, input.vColor.r < 0.7);` : `roughness = ${PAINT_ROUGH.toFixed(3)};` }
      : null,
});
const [PAINT_ROUGH, GLASS_ROUGH] = [0.18, 0.06];
/** A car's, whose shape has its glass; a box's (a van, a lorry, a ferry), paint alone. */
const [CLEAR_COAT, PAINT_COAT] = [finish(true), finish(false)];

/** A bucket of a vehicle's shape in its colour as `look` has it, its
 *  material lacquered and its edges rounded tight (a lit bucket's is the
 *  town's, `InstancePool`); its key. */
export function paint(pool: InstancePool, name: string, geo: MeshGeometry, colour: Rgb, look: Look, coat = PAINT_COAT): string {
  const key = name + look.key;
  pool.ensureBucket(key, geo, look.tint(colour), look.castShadow, true, undefined, [coat]);
  const bucket = pool.finish(key)!;
  bucket.bevel.width = ROUNDING;
  lacquer(bucket.material, "car");
  return key;
}

/** A car's bucket, its colour its own, parked or not (`mountCar`). */
function carBucket(pool: InstancePool, id: number, parked: boolean, look: Look): string {
  const c = Math.floor(hash(id, 1) * PALETTE.length);
  return paint(pool, `car_c${c}${parked ? "p" : ""}`, carGeo, PALETTE[c], look, CLEAR_COAT);
}

/** A box (`sea.ts`) standing at a pose, its base at `z`; moved, or taken
 *  away. A box is the world's: no building's look is on it. */
export function placeBox(pool: InstancePool, t: Trailer, p: Stand, z: number) {
  const placed = (q: Stand): [[number, number, number], [number, number, number]] => [[q.at[0], q.at[1], z], [0, 0, q.heading - Math.PI / 2]];
  const parts = boxShape(t).map(({ key, geo, scale }) => {
    const k = paint(pool, key, geo, WHITE, SOLID);
    return { key: k, id: pool.addInstance(k, ...placed(p), scale) };
  });
  return {
    move: (q: Stand) => parts.forEach(({ key, id }) => pool.updateInstance(key, id, ...placed(q))),
    remove: () => parts.forEach(({ key, id }) => pool.removeInstance(key, id)),
    parts,
  };
}

/// Small deterministic hash so a car's colour is a fact about the car, not
/// a roll of the dice.
function hash(id: number, salt: number): number {
  let h = (id ^ (salt * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

export function mountCar(
  entry: GameObjectEntry,
  pool: InstancePool,
  ctx: EngineContext,
  theme: Theme,
  look: Look,
): () => void {
  const car = entry.object.data as Car;
  if (car.role === "Truck") return mountLorry(entry.id, car, pool, ctx, look);
  if (car.role === "Ferry") return mountFerry(entry.id, car, pool, ctx);
  if (car.role === "Tug") return mountTug(entry.id, car, pool, ctx);
  // A tractor is drawn as a van in the farm's green until it has a shape of its own.
  const van = car.role === "Van" || car.role === "Tractor";
  // Parked cars in buckets of their own: a bucket where one car moves is
  // drawn into the shadow map every frame, and one that stands still is not.
  const parked = !car.trip && !car.run;
  const bucket = van ? paint(pool, (car.role === "Tractor" ? "tractor" : "van") + (parked ? "p" : ""), vanGeo, car.role === "Tractor" ? TRACTOR : VAN, look) : carBucket(pool, entry.id, parked, look);
  const z = CAR_Z;

  if (!car.trip) driving.delete(entry.id);
  // Parked: in its spot, as the server placed it. No spot is a full lot,
  // and the car is out of sight until it moves.
  if (parked) {
    if (!car.spot) return () => {};
    const { at, heading } = car.spot;
    const instanceId = pool.addInstance(bucket, [at[0], at[1], van ? GROUND + 0.11 : z], [0, 0, heading - Math.PI / 2]);
    carPoses.set(entry.id, [at[0], at[1]]);
    parts.set(entry.id, [{ key: bucket, id: instanceId }]);
    return () => {
      pool.removeInstance(bucket, instanceId);
      carPoses.delete(entry.id);
      parts.delete(entry.id);
    };
  }
  // On a run, its own path by the server's clock; on a trip, driven.
  const run = car.run ? followRun(car, z) : null;
  const trip = car.run ? null : follow(entry.id, car, CAR_RIG);
  const f = run ?? (trip && {
    now: (): Fix => {
      const { body } = trip.now();
      return { pos: [body.x, body.y, z], rot: [0, 0, body.heading - Math.PI / 2], dist: 0 };
    },
  });
  if (!f) return () => {};
  const initial = f.now();
  const instanceId = pool.addInstance(bucket, initial.pos, initial.rot);
  parts.set(entry.id, [{ key: bucket, id: instanceId }]);
  // On a run the ground turns behind the tractor to what the job leaves
  // — earth under the plough, stubble behind the harvest — over the
  // farm's land and nowhere else, laid over the field as it was.
  let strip: Strip | null = null;
  const tone = car.run && leaves(theme, car.run.job);
  if (tone) {
    const farm = getEntity(car.owner);
    const land = new Set(farm?.object.kind === "Building" ? (farm.object.data as Building).land.map((t) => `${t.at.x},${t.at.y}`) : []);
    strip = field(ctx, run!.drawn, land, FIELD_Z + 0.002, tone);
  }
  const stop = ctx.beforeRender(() => {
    const result = f.now();
    pool.updateInstance(bucket, instanceId, result.pos, result.rot);
    carPoses.set(entry.id, [result.pos[0], result.pos[1]]);
    strip?.reach(result.dist);
  });
  return () => {
    stop();
    pool.removeInstance(bucket, instanceId);
    strip?.dispose();
    carPoses.delete(entry.id);
    parts.delete(entry.id);
  };
}

/** A lorry, parked or on the move: the cab, and the box on its hitch if
 *  it has one, as `driver.ts` steers them; a bobtail cab alone, without. */
function mountLorry(id: number, car: Car, pool: InstancePool, ctx: EngineContext, look: Look): () => void {
  const cab = paint(pool, "lorry_cab", cabGeo, CAB_COLOR, look);
  const cabZ = GROUND + CAB.h / 2;
  const rig: Rig = car.hitched ? LORRY_RIG : { axle: LORRY_RIG.axle };
  const stand = (p: Pose): Stand => ({ at: [p.x, p.y], heading: p.heading });
  /** Parked, the box straight behind the cab. */
  const straight = (p: Pose): Pose => {
    const back = LORRY_RIG.axle + LORRY_RIG.trailer!.middle;
    return { x: p.x - Math.cos(p.heading) * back, y: p.y - Math.sin(p.heading) * back, heading: p.heading };
  };
  if (!car.trip) driving.delete(id);
  const drive = car.trip ? follow(id, car, rig) : null;
  if (!drive && !car.spot) return () => {};
  const pose = () => {
    const p = drive ? drive.now() : { body: { x: car.spot!.at[0], y: car.spot!.at[1], heading: car.spot!.heading }, trailer: undefined };
    return { body: p.body, trailer: p.trailer ?? straight(p.body) };
  };
  const first = pose();
  const a = pool.addInstance(cab, [first.body.x, first.body.y, cabZ], [0, 0, first.body.heading - Math.PI / 2]);
  const box = car.hitched && placeBox(pool, car.hitched, stand(first.trailer), GROUND);
  carPoses.set(id, [first.body.x, first.body.y]);
  parts.set(id, [{ key: cab, id: a }, ...(box ? box.parts : [])]);
  const stop = drive && ctx.beforeRender(() => {
    const p = pose();
    carPoses.set(id, [p.body.x, p.body.y]);
    pool.updateInstance(cab, a, [p.body.x, p.body.y, cabZ], [0, 0, p.body.heading - Math.PI / 2]);
    if (box) box.move(stand(p.trailer));
  });
  return () => {
    if (stop) stop();
    pool.removeInstance(cab, a);
    if (box) box.remove();
    carPoses.delete(id);
    parts.delete(id);
  };
}

/** The ferry (`sea.ts`): on its voyage by the server's clock, or moored
 *  at the berth; away beyond the sea, nowhere. On its deck the boxes in
 *  their slots and the settlers' cars, two to a free slot, the first off
 *  at the land end, gone as each rolls off; all moving with it. */
function mountFerry(id: number, car: Car, pool: InstancePool, ctx: EngineContext): () => void {
  const hull = paint(pool, "ferry", FERRY_SHAPE, FERRY_COLOR, SOLID);
  // In, if the voyage ends nearer its harbour than it begins.
  const home = getEntity(car.owner)?.position;
  const path = car.run?.path;
  const near = (t: { x: number; y: number }) => (home ? Math.hypot(t.x - home.x, t.y - home.y) : 0);
  const sail = path && path.length > 1 ? sailing(car, near(path[path.length - 1]) < near(path[0])) : null;
  if (!sail && !car.spot) return () => {};
  const pose = (): Stand => (sail ? sail(simNow()) : car.spot!);
  const p0 = pose();
  const h = pool.addInstance(hull, [p0.at[0], p0.at[1], DECK_Z], [0, 0, p0.heading - Math.PI / 2]);
  // What stands on the deck: each box in its slot, and the cars in the
  // free ones from the sea end, so the first to roll off is at the land
  // end and the rest stay put as it goes.
  const slots = car.deck.length ? car.deck : Array<null>(15).fill(null);
  const free = [...slots.keys()].filter((k) => !slots[k]).reverse();
  const along = (p: Stand, d: number): Stand => ({ at: [p.at[0] + Math.cos(p.heading) * d, p.at[1] + Math.sin(p.heading) * d], heading: p.heading });
  const settler = (who: number) => (p: Stand) => {
    const key = carBucket(pool, who, false, SOLID);
    const at = (q: Stand): [[number, number, number], [number, number, number]] => [[q.at[0], q.at[1], DECK_Z + CAR.h / 2], [0, 0, q.heading - Math.PI / 2]];
    const i = pool.addInstance(key, ...at(p));
    return { move: (q: Stand) => pool.updateInstance(key, i, ...at(q)), remove: () => pool.removeInstance(key, i) };
  };
  const aboard = [
    ...slots.flatMap((t, k) => (t ? [{ k, d: 0, put: (p: Stand) => placeBox(pool, t, p, DECK_Z) }] : [])),
    ...[...car.passengers].reverse().flatMap((who, j) => (free[j >> 1] === undefined ? [] : [{ k: free[j >> 1], d: j & 1 ? 0.15 : -0.15, put: settler(who) }])),
  ].map(({ k, d, put }) => ({ k, d, it: put(along(deckPose(p0, k), d)) }));
  carPoses.set(id, p0.at);
  parts.set(id, [{ key: hull, id: h }]);
  const stop = sail && ctx.beforeRender(() => {
    const p = pose();
    pool.updateInstance(hull, h, [p.at[0], p.at[1], DECK_Z], [0, 0, p.heading - Math.PI / 2]);
    for (const { k, d, it } of aboard) it.move(along(deckPose(p, k), d));
    carPoses.set(id, p.at);
  });
  return () => {
    if (stop) stop();
    pool.removeInstance(hull, h);
    for (const { it } of aboard) it.remove();
    carPoses.delete(id);
    parts.delete(id);
  };
}

/** The tug (`sea.ts`): on a move by the server's clock, or standing where
 *  its last one ended; the box on its hitch behind it. */
function mountTug(id: number, car: Car, pool: InstancePool, ctx: EngineContext): () => void {
  const key = paint(pool, "tug", TUG_SHAPE, TUG, SOLID);
  const move = car.shunt ? shunting(car.shunt) : null;
  if (!move && !car.spot) return () => {};
  const p0 = move ? move(simNow()) : { tug: car.spot!, box: behind(car.spot!) };
  const placed = (q: Stand): [[number, number, number], [number, number, number]] => [[q.at[0], q.at[1], GROUND], [0, 0, q.heading - Math.PI / 2]];
  const t = pool.addInstance(key, ...placed(p0.tug));
  const box = car.hitched && placeBox(pool, car.hitched, p0.box, GROUND);
  carPoses.set(id, p0.tug.at);
  parts.set(id, [{ key, id: t }, ...(box ? box.parts : [])]);
  const stop = move && ctx.beforeRender(() => {
    const p = move(simNow());
    pool.updateInstance(key, t, ...placed(p.tug));
    if (box) box.move(p.box);
    carPoses.set(id, p.tug.at);
  });
  return () => {
    if (stop) stop();
    pool.removeInstance(key, t);
    if (box) box.remove();
    carPoses.delete(id);
    parts.delete(id);
  };
}

/** A run's path, and where on it the vehicle is now. */
interface Follower {
  now(): Fix;
  drawn: DrawnPath;
}

/** Each car on a trip: its drive, kept while its route is the same, and
 *  where it is drawn along it, kept across the server's updates, which
 *  are just when its pedal changes. */
const driving = new Map<number, { route: string; drive: Drive; x: number; v: number; then: number }>();

/** A trip on the roads, driven as `driver.ts` steers it, at the distance
 *  the trip's physics puts it, eased: the drawn distance chases it as a
 *  spring does, fed the server's own speed, so on a steady road it is
 *  exactly there and a change of pedal comes on over half a second, not
 *  in an instant. In sim time, so it eases the same at any speed of the
 *  clock. */
function follow(id: number, car: Car, rig: Rig) {
  const t = car.trip!;
  const route = JSON.stringify([t.route_positions, t.from_lot, t.to_lot, t.backing]);
  let me = driving.get(id);
  if (me?.route !== route) {
    const drive = driveTrip(t.route_positions as Pt[], t.from_lot, t.to_lot, t.backing, rig);
    if (!drive) return null;
    me = { route, drive, x: Number.NaN, v: 0, then: simNow() };
    driving.set(id, me);
  }
  const state = me;
  const target = (now: number): [number, number] => {
    let dt = Math.max(0, (now - t.updated_at) / 1000);
    if (t.acceleration < 0) dt = Math.min(dt, -t.speed / t.acceleration);
    return [t.progress + t.speed * dt + 0.5 * t.acceleration * dt * dt, t.speed + t.acceleration * dt];
  };
  return {
    now() {
      const now = simNow();
      const [goal, speed] = target(now);
      let left = Math.max(0, (now - state.then) / 1000);
      state.then = now;
      // Small steps, so the spring stays steady; a long gap (a jump of the
      // clock, a tab left alone) or a car just seen is not eased at all.
      if (Number.isNaN(state.x) || left > EASE_STEP * 40) [state.x, state.v] = [goal, speed];
      for (; left > 0; left -= EASE_STEP) {
        const dt = Math.min(EASE_STEP, left);
        state.v = Math.max(0, state.v + (EASE * EASE * (goal - state.x) + 2 * EASE * (speed - state.v)) * dt);
        state.x += state.v * dt;
      }
      return state.drive.at(Math.min(state.x, state.drive.length));
    },
  };
}

/** How quickly the drawn distance closes on the physics', per second, and
 *  the step it is eased in. */
const EASE = 4;
const EASE_STEP = 0.05;

/** A tractor on its run over the land (a ferry's is `sea.ts`'s): the
 *  planned tiles, centre to
 *  centre with no lane, on the same rounded path as a trip so it corners
 *  like anything else — but by the server's clock, not by its own
 *  physics: on the run's `k`th tile `k` paces after it started, wherever
 *  the corners put that on the path, so it is where the server has it
 *  when the job is done there. */
function followRun(car: Car, z: number): Follower | null {
  const run = car.run!;
  const drawn = drawnPath(run.path.map(({ x, y }) => ({ x: x + 0.5, y: y + 0.5 })), 0, 0, 0);
  if (!drawn) return null;
  const { atNode } = drawn;
  const at = (dist: number) => drawn.at(dist, z);
  const now = (): Fix => {
    const tile = Math.min(Math.max(0, (simNow() - run.started) / run.pace), run.path.length - 1);
    const k = Math.min(Math.floor(tile), atNode.length - 2);
    return at(atNode[k] + (atNode[k + 1] - atNode[k]) * (tile - k));
  };
  return { now, drawn };
}
