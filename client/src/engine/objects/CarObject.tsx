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
import type { Fix } from "./drawnPath";
import type { Theme } from "../theme";
import type { Strip } from "./strip";
import { field, FIELD_Z, leaves } from "./BuildingObject";
import { CAR, ROAD_Z, VAN } from "./roadGeometry";
import { behind, boxShape, type BoxPart, DECK_Z, rigidShape, deckPose, FERRY_SHAPE, LORRY_SHAPE, shunting, TUG, TUG_SHAPE } from "./sea";
import type { Drive, Pose } from "./driver";
import { aboard, ahead, carried, colourOf, driveOf, LIVERY, PALETTE, running, straightBehind, travelled, VAN_BOX, vanParts, voyage } from "./motion";
import { getEntity } from "../../state/gameObjects";
import type { Building, Car, GameObjectEntry, Pose as Stand } from "../../generated";
import { carPoses, parts } from "../../state/selection";
import { HALF_LEVEL, heightAlong } from "../decks";
import { beam, unbeam } from "../lights";

const carGeo = carShape(CAR.w, CAR.l, CAR.h);
const vanGeo = boxGeometry(VAN.w, VAN.l, VAN.h);

/** A box sits on the road: its centre is half its height up. */
const CAR_Z = ROAD_Z + CAR.h / 2;
const GROUND = ROAD_Z;
/** How high a cab's headlight hangs, inside it, so it lights the road
 *  ahead and none of the cab (`lights.ts`). */
const CAB_LIGHT = 0.09;

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

/** A car's colour where a level gives it one (`setCarColour`): the
 *  interchange's cars in the colour of the gate they are bound for. */
let carColour: ((car: Car) => Rgb | null) | null = null;
export const setCarColour = (f: typeof carColour) => (carColour = f);

/** A car's bucket, its colour its own, or the level's for it, parked or
 *  not (`mountCar`). */
function carBucket(pool: InstancePool, id: number, parked: boolean, look: Look, car?: Car): string {
  const given = car && carColour?.(car);
  if (given) return paint(pool, `car_x${[given.r, given.g, given.b].map((v) => Math.round(v * 255)).join("_")}${parked ? "p" : ""}`, carGeo, given, look, CLEAR_COAT);
  const c = colourOf(id);
  return paint(pool, `car_c${c}${parked ? "p" : ""}`, carGeo, PALETTE[c], look, CLEAR_COAT);
}

/** A box (`sea.ts`) standing at a pose, its base at `z`, `k` of a box's
 *  length; moved, or taken away. A box is the world's: no building's look
 *  is on it. */
export function placeBox(pool: InstancePool, shape: BoxPart[], p: Stand, z: number) {
  const placed = (q: Stand): [[number, number, number], [number, number, number]] => [[q.at[0], q.at[1], z], [0, 0, q.heading - Math.PI / 2]];
  const parts = shape.map(({ key, geo, scale }) => {
    const k = paint(pool, key, geo, WHITE, SOLID);
    return { key: k, id: pool.addInstance(k, ...placed(p), scale) };
  });
  return {
    move: (q: Stand) => parts.forEach(({ key, id }) => pool.updateInstance(key, id, ...placed(q))),
    remove: () => parts.forEach(({ key, id }) => pool.removeInstance(key, id)),
    parts,
  };
}

export function mountCar(
  entry: GameObjectEntry,
  pool: InstancePool,
  ctx: EngineContext,
  theme: Theme,
  look: Look,
): () => void {
  const car = entry.object.data as Car;
  if (car.role === "Truck" || car.role === "Van") return mountLorry(entry.id, car, pool, ctx, look);
  if (car.role === "Ferry") return mountFerry(entry.id, car, pool, ctx);
  if (car.role === "Tug") return mountTug(entry.id, car, pool, ctx);
  // A tractor is a box in the farm's green until it has a shape of its own.
  const van = car.role === "Tractor";
  // Parked cars in buckets of their own: a bucket where one car moves is
  // drawn into the shadow map every frame, and one that stands still is not.
  const parked = !car.trip && !car.run;
  const bucket = van ? paint(pool, "tractor" + (parked ? "p" : ""), vanGeo, LIVERY.tractor, look) : carBucket(pool, entry.id, parked, look, car);
  const z = CAR_Z;

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
  const run = car.run ? running(car) : null;
  const trip = car.run ? null : follow(entry.id, car);
  const f = run ? { now: () => run.at(simNow(), z) } : trip && {
    now: (): Fix => {
      const { body, lift } = trip.now();
      return { pos: [body.x, body.y, z + lift], rot: [0, 0, body.heading - Math.PI / 2], dist: 0 };
    },
  };
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
    beam(entry.id, result.pos[0], result.pos[1], result.pos[2], result.rot[2] + Math.PI / 2);
    strip?.reach(result.dist);
  });
  return () => {
    stop();
    unbeam(entry.id);
    pool.removeInstance(bucket, instanceId);
    strip?.dispose();
    carPoses.delete(entry.id);
    parts.delete(entry.id);
  };
}

/** A lorry, parked or on the move: the cab, and the box on its hitch if
 *  it has one, as `driver.ts` steers them; a bobtail cab alone, without.
 *  A van the same, rigid, its body short (`vanParts`): a flatbed with a
 *  builder's load on it, or a shop's in a closed box (`rigidShape`). */
function mountLorry(id: number, car: Car, pool: InstancePool, ctx: EngineContext, look: Look): () => void {
  const cab = paint(pool, "lorry_cab", LORRY_SHAPE, LIVERY.cab, look);
  const stand = (p: Pose): Stand => ({ at: [p.x, p.y], heading: p.heading });
  const drive = follow(id, car);
  if (!drive && !car.spot) return () => {};
  const van = car.role === "Van";
  const pose = (): { body: Stand; box: Stand } => {
    const p = drive ? drive.now() : { body: { x: car.spot!.at[0], y: car.spot!.at[1], heading: car.spot!.heading }, trailer: undefined };
    return van ? vanParts(stand(p.body)) : { body: stand(p.body), box: stand(p.trailer ?? straightBehind(p.body)) };
  };
  const placed = (q: Stand): [[number, number, number], [number, number, number]] => [[q.at[0], q.at[1], GROUND], [0, 0, q.heading - Math.PI / 2]];
  const first = pose();
  const a = pool.addInstance(cab, ...placed(first.body));
  const load = carried(car);
  const box = load && placeBox(pool, van ? rigidShape(load, VAN_BOX) : boxShape(load), first.box, GROUND);
  carPoses.set(id, first.body.at);
  parts.set(id, [{ key: cab, id: a }, ...(box ? box.parts : [])]);
  const stop = drive && ctx.beforeRender(() => {
    const p = pose();
    carPoses.set(id, p.body.at);
    beam(id, p.body.at[0], p.body.at[1], GROUND + CAB_LIGHT, p.body.heading);
    pool.updateInstance(cab, a, ...placed(p.body));
    if (box) box.move(p.box);
  });
  return () => {
    if (stop) stop();
    unbeam(id);
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
  const hull = paint(pool, "ferry", FERRY_SHAPE, LIVERY.ferry, SOLID);
  const sail = voyage(car);
  if (!sail && !car.spot) return () => {};
  const pose = (): Stand => (sail ? sail(simNow()) : car.spot!);
  const p0 = pose();
  const h = pool.addInstance(hull, [p0.at[0], p0.at[1], DECK_Z], [0, 0, p0.heading - Math.PI / 2]);
  const settler = (who: number) => (p: Stand) => {
    const key = carBucket(pool, who, false, SOLID);
    const at = (q: Stand): [[number, number, number], [number, number, number]] => [[q.at[0], q.at[1], DECK_Z + CAR.h / 2], [0, 0, q.heading - Math.PI / 2]];
    const i = pool.addInstance(key, ...at(p));
    return { move: (q: Stand) => pool.updateInstance(key, i, ...at(q)), remove: () => pool.removeInstance(key, i) };
  };
  const on = aboard(car).map(({ k, d, box, settler: who }) => ({ k, d, it: (box ? (p: Stand) => placeBox(pool, boxShape(box), p, DECK_Z) : settler(who!))(ahead(deckPose(p0, k), d)) }));
  carPoses.set(id, p0.at);
  parts.set(id, [{ key: hull, id: h }]);
  const stop = sail && ctx.beforeRender(() => {
    const p = pose();
    pool.updateInstance(hull, h, [p.at[0], p.at[1], DECK_Z], [0, 0, p.heading - Math.PI / 2]);
    for (const { k, d, it } of on) it.move(ahead(deckPose(p, k), d));
    carPoses.set(id, p.at);
  });
  return () => {
    if (stop) stop();
    pool.removeInstance(hull, h);
    for (const { it } of on) it.remove();
    carPoses.delete(id);
    parts.delete(id);
  };
}

/** The tug (`sea.ts`): on a move by the server's clock, or standing where
 *  its last one ended; the box on its hitch behind it. */
function mountTug(id: number, car: Car, pool: InstancePool, ctx: EngineContext): () => void {
  const key = paint(pool, "tug", TUG_SHAPE, TUG, SOLID);
  const move = car.shunt && car.spot ? shunting(car.shunt, car.spot, !!car.hitched) : null;
  if (!move && !car.spot) return () => {};
  const p0 = move ? move(simNow()) : { tug: car.spot!, box: behind(car.spot!) };
  const placed = (q: Stand): [[number, number, number], [number, number, number]] => [[q.at[0], q.at[1], GROUND], [0, 0, q.heading - Math.PI / 2]];
  const t = pool.addInstance(key, ...placed(p0.tug));
  const box = car.hitched && placeBox(pool, boxShape(car.hitched), p0.box, GROUND);
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

/** Each car on a trip: where it is drawn along its drive, kept across the
 *  server's updates, which are just when its pedal changes. */
const easing = new Map<number, { drive: Drive; x: number; v: number; then: number }>();

/** A trip on the roads, driven as `driver.ts` steers it, at the distance
 *  the trip's physics puts it, eased: the drawn distance chases it as a
 *  spring does, fed the server's own speed, so on a steady road it is
 *  exactly there and a change of pedal comes on over half a second, not
 *  in an instant. In sim time, so it eases the same at any speed of the
 *  clock. */
function follow(id: number, car: Car) {
  const drive = driveOf(id, car);
  if (!drive) return void easing.delete(id), null;
  const t = car.trip!;
  const up = liftOf(t);
  let me = easing.get(id);
  if (me?.drive !== drive) easing.set(id, (me = { drive, x: Number.NaN, v: 0, then: simNow() }));
  const state = me;
  return {
    now() {
      const now = simNow();
      const [goal, speed] = travelled(t, now);
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
      return { ...drive.at(Math.min(state.x, drive.length)), lift: up(state.x) };
    },
  };
}

/** How high a trip's car is lifted, by how far along it is: over a deck,
 *  up a slope (`decks.ts`). The route's own nodes, centre to centre, put
 *  each node's height where it is along the way. */
function liftOf(t: Car["trip"] & {}): (dist: number) => number {
  const heights = t.route_heights ?? [];
  if (!heights.some((h) => h > 0)) return () => 0;
  const at = [0];
  for (let k = 1; k < t.route_positions.length; k++) {
    const [[x0, y0], [x1, y1]] = [t.route_positions[k - 1], t.route_positions[k]];
    at.push(at[k - 1] + Math.hypot(x1 - x0, y1 - y0));
  }
  const scale = at[at.length - 1] / Math.max(1e-9, t.total_route_length);
  return (dist) => {
    const d = dist * scale;
    let k = 0;
    while (k < at.length - 2 && at[k + 1] < d) k++;
    const f = Math.max(0, Math.min(1, (d - at[k]) / Math.max(1e-9, at[k + 1] - at[k])));
    return heightAlong(heights, k + f) * HALF_LEVEL;
  };
}

/** How quickly the drawn distance closes on the physics', per second, and
 *  the step it is eased in. */
const EASE = 4;
const EASE_STEP = 0.05;
