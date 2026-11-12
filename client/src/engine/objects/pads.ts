import { BLUEPRINTS, FACINGS, standing } from "../../blueprints";
import { INSET } from "../town/footprint";
import { ITEM } from "./goods";
import type { Building, Good, Lift, Pose } from "../../generated";

/**
 * Where goods stand at a building, and how many are seen there now
 * (docs/plan-goods.md §Pads and handling). A pad is bays of slots, each
 * slot a package, or a stack of them where a pad holds more than its
 * slots; the client lays them out from the building's own tiles, as the
 * town grid lays its dressing. What the server says stands there is
 * moved by what its forklifts are still lifting: the server changes its
 * counts as a run starts, the forklift carries them across one by one.
 *
 * - A building with a front keeps its goods along its front wall on the
 *   pavement, clear of its docks and its kerb bays; its forklift waits
 *   beside the docks, a few steps from a docked truck's flank.
 * - Anything else along the front wall, on the pavement; a site its
 *   materials there.
 */

/** A pad's bay: the slots of one good in the order they fill, each a
 *  pose, and how many high each takes before the next; which way its open
 *  face looks, where a forklift comes up to it; and whether that face is
 *  on the pad's aisle (`Pad::exits`). A bay fills from the back to its
 *  face, so the package a forklift takes or sets is always in front. */
export interface Bay {
  good: Good;
  slots: Pose[];
  stack: number;
  face: number;
  inside: boolean;
}

/** Docks side by side at a gate, and the kerb bays either side of them,
 *  a car's half width either side of each (`DOCK_PITCH`, `DOCK_CLEAR`,
 *  `SQUARE_PITCH` in `lots.rs`). */
const DOCK_PITCH = 0.3;
const DOCK_CLEAR = 0.4;
const SQUARE_PITCH = 0.27;
/** A kerb bay's middle keeps this far inside the walls (`WALL_INSET`). */
const BAY_INSET = 0.2;
const CAR_HALF = 0.075;

/** How far apart packages stand on a pad. */
const PITCH = ITEM + 0.02;

/** A building's frame: its middle, its front (out to its street), across
 *  it, and how wide and deep it stands. */
function frame(b: Building) {
  const { at, size: [bw, bh] } = standing(b);
  const [dx, dy] = FACINGS[b.facing % 4];
  const [w, d] = dx === 0 ? [bw, bh] : [bh, bw];
  /** `across` and `out` from (x, y), in the building's frame. */
  const pose = ([x, y]: [number, number], across: number, out: number): Pose => ({ at: [x - dy * across + dx * out, y + dx * across + dy * out], heading: Math.atan2(dy, dx) });
  return { at, w, d, pose, heading: Math.atan2(dy, dx) };
}

/** How many packages a stock is seen as: a maker's whole ones, the
 *  part-made one not yet a package; anything else's, a package opened
 *  still standing. */
export function packagesOf(b: Building, good: Good): number {
  const s = b.stocks[good];
  if (!s) return 0;
  const n = s.level;
  return Math.max(0, BLUEPRINTS[b.kind].makes ? Math.floor(n + 1e-9) : Math.ceil(n - 1e-9));
}
/** The most a stock is seen as. */
const most = (b: Building, good: Good) => Math.ceil(b.stocks[good]!.cap - 1e-9);

/** A building's pad: its bays, where its forklifts stand when they are
 *  not lifting and whether that is in its aisle, the aisle's mouths and
 *  the line down its middle, and whether it has docks, its forklifts out
 *  whether lifting or not. */
export interface Pad {
  bays: Bay[];
  homes: Pose[];
  homeInside: boolean;
  exits: [number, number][];
  aisle: [[number, number], [number, number]] | null;
  docked: boolean;
}
export function padOf(b: Building): Pad {
  const f = frame(b);
  const kind = BLUEPRINTS[b.kind];
  const forklifts = (at: (k: number) => Pose) => Array.from({ length: kind.forklifts }, (_, k) => at(k));
  const front = { face: f.heading, inside: false };
  const goods = Object.keys(b.stocks) as Good[];
  if (b.door && kind.docks > 0) {
    // Along the front wall on the pavement, either side of the docks at
    // its gate and clear of its kerb bays (`lots::dock_bays`): a bay of
    // each good, the forklifts beside the docks.
    const [gx, gy] = [b.door.tile.x + 0.5 - f.at[0], b.door.tile.y + 0.5 - f.at[1]];
    const [dx, dy] = FACINGS[b.facing % 4];
    const g = -dy * gx + dx * gy;
    const half = (kind.docks * DOCK_PITCH) / 2 + 0.06;
    const d0 = ((kind.docks - 1) * DOCK_PITCH) / 2 + DOCK_CLEAR;
    const cars = Array.from({ length: 8 * Math.ceil(f.w) }, (_, k) => g + (k % 2 ? -1 : 1) * (d0 + Math.floor(k / 2) * SQUARE_PITCH))
      .filter((u) => Math.abs(u) <= f.w / 2 - BAY_INSET)
      .slice(0, kind.bays);
    const out = f.d / 2 + ITEM / 2 + 0.02;
    const free: number[] = [];
    for (let a = -f.w / 2 + 0.12; a <= f.w / 2 - 0.12; a += PITCH) if (Math.abs(a - g) > half + 0.08 && cars.every((c) => Math.abs(a - c) > CAR_HALF + ITEM / 2 + 0.01)) free.push(a);
    const kept = goods.filter((good) => most(b, good) > 0);
    // A shop keeps more goods as the town makes more: the places along
    // the wall, in as many rows out from it as give each good one.
    const along = free.length ? free : [g > 0 ? -f.w / 2 + 0.12 : f.w / 2 - 0.12];
    const rows = Math.ceil(kept.length / along.length);
    const places = Array.from({ length: rows }, (_, r) => along.map((a) => f.pose(f.at, a, out + r * PITCH))).flat();
    const each = Math.floor(places.length / Math.max(1, kept.length));
    const bays = kept.map((good, k) => {
      const slots = places.slice(k * each, (k + 1) * each);
      return { good, slots, stack: Math.ceil(most(b, good) / Math.max(1, slots.length)), ...front };
    });
    return { bays, homes: forklifts((k) => f.pose(f.at, g + (k % 2 ? -1 : 1) * (half + 0.06), out)), homeInside: false, exits: [], aisle: null, docked: true };
  }
  // Along the front wall, on the pavement: a bay of each good it keeps.
  let a = -f.w / 2 + 0.12;
  const bays = goods.filter((good) => most(b, good) > 0).map((good) => {
    const n = most(b, good);
    const fit = Math.max(1, Math.floor((f.w - 0.2) / PITCH / goods.length));
    const slots = Array.from({ length: Math.min(n, fit) }, (_, k) => f.pose(f.at, a + k * PITCH, f.d / 2 - INSET / 2));
    a += slots.length * PITCH + 0.04;
    return { good, slots, stack: Math.ceil(n / slots.length), ...front };
  });
  return { bays, homes: forklifts(() => f.pose(f.at, 0, f.d / 2 + 0.05)), homeInside: false, exits: [], aisle: null, docked: false };
}

/** Where the `i`th package of a bay stands: its slot, and how many it
 *  stands on. */
export const placeIn = (bay: Bay, i: number): [Pose, number] => [bay.slots[Math.max(0, Math.min(bay.slots.length - 1, Math.floor(i / bay.stack)))], Math.max(0, i) % bay.stack];

/** How far a forklift's run is at `now`: how many packages have left
 *  where they stood (`off`), how many have been set down where they go
 *  (`on`), and, while one is in its forks, how far it is carried, from 0
 *  to 1. A lift is one `every`: to the package and up, carried across and
 *  set down, and back out (`forklift.ts`). */
export function progress(l: Lift, now: number): { off: number; on: number; carry: number | null } {
  const e = (now - l.start) / l.every;
  if (e <= 0) return { off: 0, on: 0, carry: null };
  if (e >= l.n) return { off: l.n, on: l.n, carry: null };
  const k = Math.floor(e), t = e - k;
  const carrying = t >= PICK && t < DROP;
  return { off: k + (t >= PICK ? 1 : 0), on: k + (t >= DROP ? 1 : 0), carry: carrying ? (t - PICK) / (DROP - PICK) : null };
}
/** A lift's moments: the package taken up, set down. Getting to it and
 *  carrying it across take about as long; backing out after, a little. */
export const [PICK, DROP] = [0.45, 0.9];
export const ends = (l: Lift) => l.start + l.n * l.every;

/** What a run leaves to be seen at either end: at the pad, of the
 *  server's count, and on the vehicle, of its. */
export const atPad = (l: Lift, now: number) => {
  const p = progress(l, now);
  return l.onto ? l.n - p.off : -(l.n - p.on);
};
export const onVehicle = (l: Lift, now: number) => {
  const p = progress(l, now);
  return l.onto ? -(l.n - p.on) : l.n - p.off;
};

/** Every forklift run going on, by the vehicle it works: a building's
 *  lifts, as it was last mounted, so the vehicle can draw what it still
 *  has aboard. */
const runs = new Map<number, Map<number, Lift[]>>();
export function setLifts(building: number, lifts: Lift[]) {
  for (const [car, at] of runs) if (at.delete(building) && !at.size) runs.delete(car);
  for (const l of lifts) {
    const at = runs.get(l.car) ?? runs.set(l.car, new Map()).get(l.car)!;
    at.set(building, [...(at.get(building) ?? []), l]);
  }
}
export const liftsOf = (car: number): Lift[] => [...(runs.get(car)?.values() ?? [])].flat();
