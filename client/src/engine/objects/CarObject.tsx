import { Color3, Vector3 } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import type { InstancePool } from "../InstancePool";
import { boxGeometry } from "./buildings";
import { simNow } from "../../network/clock";
import type { Look } from "./look";
import { drawnPath, type DrawnPath, type Fix } from "./drawnPath";
import type { Theme } from "../theme";
import type { Strip } from "./strip";
import { field, FIELD_Z, leaves } from "./BuildingObject";
import { CAB, CAR, ROAD_Z, TRAILER } from "./roadGeometry";
import { CAR_RIG, driveTrip, LORRY_RIG, type Drive, type Pose, type Pt, type Rig } from "./driver";
import { getEntity } from "../../state/gameObjects";
import type { Building, Car, GameObjectEntry } from "../../generated";
import { carPoses, parts } from "../../state/selection";

/// Everyone keeps their car for life, and its id never changes — so neither
/// does its colour.
const PALETTE = [
  new Color3(0.9, 0.25, 0.2),
  new Color3(0.85, 0.85, 0.88),
  new Color3(0.2, 0.22, 0.28),
  new Color3(0.25, 0.4, 0.75),
  new Color3(0.65, 0.65, 0.68),
  new Color3(0.55, 0.15, 0.15),
  new Color3(0.2, 0.5, 0.4),
  new Color3(0.8, 0.65, 0.25),
];
const carGeo = boxGeometry(CAR.w, CAR.l, CAR.h);
/** A van: a box a car and a bit long, tall, and always the same white. */
const vanGeo = boxGeometry(0.17, 0.37, 0.18);
const VAN = new Color3(0.92, 0.92, 0.9);
const TRACTOR = new Color3(0.36, 0.55, 0.16);
/** A lorry: a cab-over tractor, the vehicle the server moves, and a
 *  semi-trailer on its hitch (`driver.ts`), two boxes. */
const cabGeo = boxGeometry(CAB.w, CAB.l, CAB.h);
const trailerGeo = boxGeometry(TRAILER.w, TRAILER.l, TRAILER.h);
const CAB_COLOR = new Color3(0.28, 0.36, 0.58);
const TRAILER_COLOR = new Color3(0.9, 0.9, 0.88);

/** A box sits on the road: its centre is half its height up. */
const CAR_Z = ROAD_Z + CAR.h / 2;
const GROUND = ROAD_Z;
/** A ship: a long low hull, dark, afloat on the water, which lies half
 *  a unit under the land. */
const HULL = { w: 0.45, l: 1.6, h: 0.2 };
const shipGeo = boxGeometry(HULL.w, HULL.l, HULL.h);
const SHIP = new Color3(0.2, 0.24, 0.3);
const SHIP_Z = -0.5 + HULL.h / 2;

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
  scene: Scene,
  theme: Theme,
  look: Look,
): () => void {
  const car = entry.object.data as Car;
  if (car.role === "Truck") return mountLorry(entry.id, car, pool, scene, look);
  // A tractor is drawn as a van in the farm's green until it has a shape of its own.
  const van = car.role === "Van" || car.role === "Tractor";
  const ship = car.role === "Ship";
  const color = ship ? SHIP : car.role === "Tractor" ? TRACTOR : van ? VAN : PALETTE[Math.floor(hash(entry.id, 1) * PALETTE.length)];
  const bucket = ship ? `ship${look.key}` : car.role === "Tractor" ? `tractor${look.key}` : van ? `van${look.key}` : `car${look.key}c${PALETTE.indexOf(color)}`;
  pool.ensureBucket(bucket, ship ? shipGeo : van ? vanGeo : carGeo, look.tint(color), look.castShadow, true);
  const z = ship ? SHIP_Z : CAR_Z;

  if (!car.trip) driving.delete(entry.id);
  // Parked: in its spot, as the server placed it. No spot is a full lot,
  // and the car is out of sight until it moves.
  if (!car.trip && !car.run) {
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
    strip = field(pool, run!.drawn, land, FIELD_Z + 0.002, tone);
  }
  const observer = scene.onBeforeRenderObservable.add(() => {
    const result = f.now();
    pool.updateInstance(bucket, instanceId, result.pos, result.rot);
    carPoses.set(entry.id, [result.pos[0], result.pos[1]]);
    strip?.reach(result.dist);
  });
  return () => {
    scene.onBeforeRenderObservable.remove(observer);
    pool.removeInstance(bucket, instanceId);
    strip?.dispose();
    carPoses.delete(entry.id);
    parts.delete(entry.id);
  };
}

/** The two boxes of a lorry, parked or on the move: the cab, and the
 *  trailer on its hitch, as `driver.ts` steers them. */
function mountLorry(id: number, car: Car, pool: InstancePool, scene: Scene, look: Look): () => void {
  const cab = `lorry_cab${look.key}`;
  const trailer = `lorry_trailer${look.key}`;
  pool.ensureBucket(cab, cabGeo, look.tint(CAB_COLOR), look.castShadow, true);
  pool.ensureBucket(trailer, trailerGeo, look.tint(TRAILER_COLOR), look.castShadow, true);
  const cabZ = GROUND + CAB.h / 2;
  const trailerZ = GROUND + TRAILER.h / 2;
  const placed = (p: Pose, z: number) => ({ pos: [p.x, p.y, z] as [number, number, number], rot: [0, 0, p.heading - Math.PI / 2] as [number, number, number] });
  /** Parked, the trailer straight behind the cab. */
  const straight = (at: [number, number], heading: number): { body: Pose; trailer: Pose } => {
    const back = LORRY_RIG.axle + LORRY_RIG.trailer!.middle;
    return { body: { x: at[0], y: at[1], heading }, trailer: { x: at[0] - Math.cos(heading) * back, y: at[1] - Math.sin(heading) * back, heading } };
  };
  if (!car.trip) driving.delete(id);
  const drive = car.trip ? follow(id, car, LORRY_RIG) : null;
  if (!drive && !car.spot) return () => {};
  const pose = () => {
    const p = drive ? drive.now() : straight(car.spot!.at, car.spot!.heading);
    return { body: p.body, trailer: p.trailer ?? straight([p.body.x, p.body.y], p.body.heading).trailer };
  };
  const first = pose();
  const a = pool.addInstance(cab, placed(first.body, cabZ).pos, placed(first.body, cabZ).rot);
  const b = pool.addInstance(trailer, placed(first.trailer, trailerZ).pos, placed(first.trailer, trailerZ).rot);
  carPoses.set(id, [first.body.x, first.body.y]);
  parts.set(id, [{ key: cab, id: a }, { key: trailer, id: b }]);
  const observer = drive && scene.onBeforeRenderObservable.add(() => {
    const p = pose();
    carPoses.set(id, [p.body.x, p.body.y]);
    const [c, t] = [placed(p.body, cabZ), placed(p.trailer, trailerZ)];
    pool.updateInstance(cab, a, c.pos, c.rot);
    pool.updateInstance(trailer, b, t.pos, t.rot);
  });
  return () => {
    if (observer) scene.onBeforeRenderObservable.remove(observer);
    pool.removeInstance(cab, a);
    pool.removeInstance(trailer, b);
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
  const route = JSON.stringify([t.route_positions, t.from_lot, t.to_lot, t.reverse]);
  let me = driving.get(id);
  if (me?.route !== route) {
    const drive = driveTrip(t.route_positions as Pt[], t.from_lot, t.to_lot, t.reverse, rig);
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

/** A tractor on its run over the land, or a ship on its voyage: the
 *  planned tiles, centre to
 *  centre with no lane, on the same rounded path as a trip so it corners
 *  like anything else — but by the server's clock, not by its own
 *  physics: on the run's `k`th tile `k` paces after it started, wherever
 *  the corners put that on the path, so it is where the server has it
 *  when the job is done there. */
function followRun(car: Car, z: number): Follower | null {
  const run = car.run!;
  const drawn = drawnPath(run.path.map(({ x, y }) => new Vector3(x + 0.5, y + 0.5, 0)), 0, 0, 0);
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
