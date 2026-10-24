import type { MaterialPlugin } from "@babylonjs/lite";
import type { EngineContext } from "../Canvas";
import { WHITE, type Rgb } from "../rgb";
import type { MeshGeometry } from "../geometry";
import type { InstancePool } from "../InstancePool";
import { boxGeometry } from "./buildings";
import { carShape, ROUNDING } from "./carShape";
import { lacquer } from "../bevel";
import { simNow } from "../../network/clock";
import { running as runs } from "./field";
import { CAR, ROAD_Z, VAN } from "./roadGeometry";
import { DECK_Z, FERRY_SHAPE, LORRY_BED, LORRY_SHAPE, vanBed } from "./sea";
import type { Drive } from "./driver";
import { colourOf, driveOf, forgetDrive, LIVERY, moment, PALETTE, travelled, VAN_BED } from "./motion";
import type { Car, GameObjectEntry, Pose } from "../../generated";
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

/** A bucket of a vehicle's shape in its colour, its material lacquered
 *  and its edges rounded tight (a lit bucket's is the town's,
 *  `InstancePool`); its key. */
export function paint(pool: InstancePool, key: string, geo: MeshGeometry, colour: Rgb, coat = PAINT_COAT): string {
  pool.ensureBucket(key, geo, colour, true, true, undefined, [coat]);
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
function carBucket(pool: InstancePool, id: number, parked: boolean, car?: Car): string {
  const given = car && carColour?.(car);
  if (given) return paint(pool, `car_x${[given.r, given.g, given.b].map((v) => Math.round(v * 255)).join("_")}${parked ? "p" : ""}`, carGeo, given, CLEAR_COAT);
  const c = colourOf(id);
  return paint(pool, `car_c${c}${parked ? "p" : ""}`, carGeo, PALETTE[c], CLEAR_COAT);
}

/** Where an instance stands: its pose, its base (or middle) `z` up, its
 *  front along its heading. */
const instance = (p: Pose, z: number): [[number, number, number], [number, number, number]] => [[p.at[0], p.at[1], z], [0, 0, p.heading - Math.PI / 2]];

/** Buckets' instances standing together at a pose, `z` up; moved, lifted
 *  so far above that, or taken away. */
function place(pool: InstancePool, keys: { key: string; scale?: [number, number, number] }[], p: Pose, z: number) {
  const parts = keys.map(({ key, scale }) => ({ key, id: pool.addInstance(key, ...instance(p, z), scale) }));
  return {
    move: (q: Pose, lift = 0) => parts.forEach(({ key, id }) => pool.updateInstance(key, id, ...instance(q, z + lift))),
    remove: () => parts.forEach(({ key, id }) => pool.removeInstance(key, id)),
    parts,
  };
}

/** A shape with colours of its own (`sea.ts`, `goods.ts`) standing at a
 *  pose, its base at `z`. It is the world's: no building's look is on it. */
export const placeShape = (pool: InstancePool, { key, geo }: { key: string; geo: MeshGeometry }, p: Pose, z: number) => place(pool, [{ key: paint(pool, key, geo, WHITE) }], p, z);

/** How a vehicle is drawn: its body's bucket, how high its middle stands
 *  (a cab's base, a ferry's waterline), and how high its headlight hangs
 *  above that, if it shines one. Standing still, in buckets of their own:
 *  a bucket where one moves is drawn into the shadow map every frame, and
 *  one where all stand still is not. */
function bodyOf(pool: InstancePool, id: number, car: Car, parked: boolean): { key: string; z: number; light?: number } {
  const p = parked ? "p" : "";
  switch (car.role) {
    case "Ferry":
      return { key: paint(pool, "ferry" + p, FERRY_SHAPE, LIVERY.ferry), z: DECK_Z };
    case "Truck":
    case "Van":
      return { key: paint(pool, "lorry_cab" + p, LORRY_SHAPE, LIVERY.cab), z: GROUND, light: CAB_LIGHT };
    case "Tractor":
      // A box in the farm's green until it has a shape of its own.
      return { key: paint(pool, "tractor" + p, vanGeo, LIVERY.tractor), z: CAR_Z, light: 0 };
    default:
      return { key: carBucket(pool, id, parked, car), z: CAR_Z, light: 0 };
  }
}

/** A vehicle, where `moment` has it: its body; the flatbed behind a
 *  lorry's or a van's cab; on a ferry's deck the settlers' cars, all
 *  moving with it. Parked, where the server placed it; out of sight
 *  where it has no place. On the move, by the server's clock, a trip's
 *  distance eased (`follow`) and lifted over decks and slopes. */
export function mountCar(entry: GameObjectEntry, pool: InstancePool, ctx: EngineContext): () => void {
  const id = entry.id;
  const car = entry.object.data as Car;
  const trip = follow(id, car);
  const now = () => {
    const t = simNow();
    const along = trip?.(t);
    return { m: moment(id, car, t, along?.dist), lift: along?.lift ?? 0 };
  };
  const first = now();
  if (!first.m) return () => {};
  const moving = !!(car.trip || car.run || car.sail);
  const look = bodyOf(pool, id, car, !moving);
  const body = place(pool, [{ key: look.key }], first.m.body, look.z + first.lift);
  const bed = first.m.bed ? placeShape(pool, car.role === "Van" ? vanBed(VAN_BED) : LORRY_BED, first.m.bed, GROUND + first.lift) : null;
  const deck = (first.m.deck ?? []).flatMap(({ at, settler }) => (settler === undefined ? [] : [place(pool, [{ key: carBucket(pool, settler, false) }], at, DECK_Z + CAR.h / 2)]));
  carPoses.set(id, first.m.body.at);
  parts.set(id, [...body.parts, ...(bed?.parts ?? [])]);
  // On a run the farm's field turns behind the tractor to what the job
  // leaves (`field.ts`).
  if (car.run) runs.set(car.owner, car.run);
  const stop = moving ? ctx.beforeRender(() => {
    const { m, lift } = now();
    if (!m) return;
    body.move(m.body, lift);
    if (bed && m.bed) bed.move(m.bed, lift);
    m.deck?.filter((d) => d.settler !== undefined).forEach((d, k) => deck[k].move(d.at));
    carPoses.set(id, m.body.at);
    if (look.light !== undefined) beam(id, m.body.at[0], m.body.at[1], look.z + lift + look.light, m.body.heading);
  }) : () => {};
  return () => {
    stop();
    unbeam(id);
    for (const it of [body, bed, ...deck]) it?.remove();
    if (car.run && runs.get(car.owner) === car.run) runs.delete(car.owner);
    carPoses.delete(id);
    parts.delete(id);
  };
}

/** Each car on a trip: where it is drawn along its drive, kept across the
 *  server's updates, which are just when its pedal changes. */
const easing = new Map<number, { drive: Drive; x: number; v: number; then: number }>();
/** A car gone, not mounted again: what was kept for it across updates. */
export const forgetCar = (id: number) => (easing.delete(id), forgetDrive(id));

/** A trip on the roads, driven as `driver.ts` steers it, at the distance
 *  the trip's physics puts it, eased: the drawn distance chases it as a
 *  spring does, fed the server's own speed, so on a steady road it is
 *  exactly there and a change of pedal comes on over half a second, not
 *  in an instant. In sim time, so it eases the same at any speed of the
 *  clock. */
function follow(id: number, car: Car): ((now: number) => { dist: number; lift: number }) | null {
  const drive = driveOf(id, car);
  if (!drive) return void easing.delete(id), null;
  const t = car.trip!;
  const up = liftOf(t);
  let me = easing.get(id);
  if (me?.drive !== drive) easing.set(id, (me = { drive, x: Number.NaN, v: 0, then: simNow() }));
  const state = me;
  return (now) => {
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
    return { dist: state.x, lift: up(state.x) };
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
