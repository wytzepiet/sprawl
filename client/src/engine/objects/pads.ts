import { BLUEPRINTS, FACINGS, GOODS, standing, yardOf } from "../../blueprints";
import { INSET } from "../town/footprint";
import { ITEM } from "./goods";
import type { Building, Good, Lift, Pose } from "../../generated";

/**
 * Where goods stand at a building, and how many are seen there now
 * (docs/plan-goods.md §Pads and handling). A pad is bays of slots, each
 * slot a package, or a stack of them where a yard holds more than its
 * slots; the client lays them out from the building's own tiles, as the
 * town grid lays its dressing. What the server says stands there is
 * moved by what its forklifts are still lifting: the server changes its
 * counts as a run starts, the forklift carries them across one by one.
 *
 * - A depot is an open yard, no roof: a bay of each good on the ground
 *   where a hall would stand, its lorry's docks in its lot.
 * - A maker's pad runs down the side of its yard's lane the docks are
 *   not on: a farm's crates stacked four high.
 * - A shop, a supermarket and a gas station keep theirs along the front
 *   wall, on the pavement; a site its materials there.
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

/** The goods, the heaviest first: what stands at the back of a yard. */
const HEAVY: Good[] = ["Steel", "Ore", "Coal", "Stone", "Cement", "Timber", "Machinery", "Crude", "Fuel", "Grain", "Bread"];

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

/** A bay of packages `wide` along its face and `deep` back from it, its
 *  middle at `at`, its face looking `face`, each package turned `heading`:
 *  in rows from the back. */
function bay(good: Good, at: [number, number], face: number, wide: number, deep: number, heading: number, inside: boolean, stack: number): Bay {
  const [fx, fy, wx, wy] = [Math.cos(face), Math.sin(face), -Math.sin(face), Math.cos(face)];
  const slots: Pose[] = [];
  for (let r = 0; r < deep; r++)
    for (let c = 0; c < wide; c++) {
      const [d, w] = [(r - (deep - 1) / 2) * PITCH, (c - (wide - 1) / 2) * PITCH];
      slots.push({ at: [at[0] + fx * d + wx * w, at[1] + fy * d + wy * w], heading });
    }
  return { good, slots, stack, face, inside };
}

/** How many packages a stock is seen as: a maker's whole ones, the
 *  part-made one not yet a package; anything else's, a package opened
 *  still standing. */
export function packagesOf(b: Building, good: Good): number {
  if (BLUEPRINTS[b.kind].quay) return b.pad.filter((p) => p.good === good).length;
  const s = (b.site ?? b.stocks)[good];
  if (!s) return 0;
  const n = s.level / GOODS[good].per;
  return Math.max(0, BLUEPRINTS[b.kind].makes ? Math.floor(n + 1e-9) : Math.ceil(n - 1e-9));
}
/** The most a stock is seen as. */
const most = (b: Building, good: Good) => Math.ceil((b.site ?? b.stocks)[good]!.cap / GOODS[good].per - 1e-9);

/** A building's pad: its bays, where its forklifts stand when they are
 *  not lifting and whether that is in its aisle, the aisle's mouths and
 *  the line down its middle, and whether it is on a yard's asphalt or the pavement. A harbour's is its
 *  quay's, beside its lane on the side its docks are not (`Berth::park`). */
export interface Pad {
  bays: Bay[];
  homes: Pose[];
  homeInside: boolean;
  exits: [number, number][];
  aisle: [[number, number], [number, number]] | null;
  yard: boolean;
}
export function padOf(b: Building): Pad {
  const f = frame(b);
  const kind = BLUEPRINTS[b.kind];
  const forklifts = (at: (k: number) => Pose) => Array.from({ length: kind.forklifts }, (_, k) => at(k));
  const front = { face: f.heading, inside: false };
  if (b.site) {
    // Along the front of the slab, each material after the last.
    const goods = Object.keys(b.site) as Good[];
    let a = -f.w / 2 + 0.15;
    const bays = goods.map((good) => {
      const n = most(b, good);
      const slots = Array.from({ length: n }, (_, k) => f.pose(f.at, a + k * PITCH, f.d / 2 - 0.13));
      a += n * PITCH + 0.04;
      return { good, slots, stack: 1, ...front };
    });
    return { bays, homes: forklifts(() => f.pose(f.at, 0, f.d / 2 + 0.05)), homeInside: false, exits: [], aisle: null, yard: false };
  }
  if (kind.quay) {
    // Out from the ramp, a bay of each good that lands, in two rows
    // along the lane, each two along and four deep and four high, facing
    // the lane: the near row on it, the far across an aisle behind it,
    // reached by the aisle's ends; its forklifts between them and the lane.
    const back = -f.d / 2;
    const [near, far] = [-0.42, -0.42 - 0.42 - 0.45];
    const out = (k: number) => back + 0.36 + Math.floor(k / 2) * 0.26;
    const bays = HEAVY.map((good, k) => bay(good, f.pose(f.at, k % 2 ? far : near, out(k)).at, f.heading + Math.PI / 2, 2, 4, f.heading, k % 2 === 1, 4));
    const aisle = (near + far) / 2;
    const exits = [out(0) - 0.3, out(HEAVY.length - 1) + 0.3].map((o) => f.pose(f.at, aisle, o).at);
    return { bays, homes: forklifts((k) => f.pose(f.at, -0.2, back + 0.4 + k * 0.3)), homeInside: false, exits, aisle: [exits[0], exits[1]], yard: true };
  }
  const goods = Object.keys(b.stocks) as Good[];
  if (b.kind === "Depot" && b.door) {
    // A bay of each good on the open ground, in two rows facing each
    // other across an aisle that runs out to its yard, the heavy goods at
    // the back; its forklifts at the aisle's back, and out by its mouth.
    const kept = HEAVY.filter((g) => goods.includes(g));
    const row = Math.ceil(kept.length / 2);
    const [vx, vy] = [b.door.street.x - b.door.tile.x, b.door.street.y - b.door.tile.y];
    const { at, size } = standing(b);
    const long = vx ? size[0] : size[1];
    const pitch = Math.min(0.36, (long - 0.4) / row);
    const wide = pitch >= 3 * PITCH ? 3 : 2;
    const along = (a: number, s: number): [number, number] => [at[0] + vx * a - vy * s, at[1] + vy * a + vx * s];
    const bays = kept.map((good, k) => {
      const [side, c] = [k < row ? -1 : 1, k % row];
      const middle = along((c - (row - 1) / 2) * pitch, side * (0.225 + 1.5 * PITCH));
      const one = bay(good, middle, Math.atan2(-vx * side, vy * side), wide, 3, f.heading, true, 1);
      return { ...one, stack: Math.ceil(most(b, good) / one.slots.length) };
    });
    const heading = Math.atan2(vy, vx);
    const homes = forklifts((k) => ({ at: along(-long / 2 + 0.2 + k * 0.15, 0), heading }));
    return { bays, homes, homeInside: true, exits: [along(long / 2 + 0.2, 0)], aisle: [along(-long / 2, 0), along(long / 2, 0)], yard: true };
  }
  if (kind.makes && b.door) {
    // Down the lane's free side, from the yard's back to its gate, two
    // deep, facing the lane: the far one of each pair first.
    const good = kind.makes;
    const lot = yardOf(b.tiles, b.kind, b.facing) ?? [];
    const [fx, fy] = [b.door.street.x - b.door.tile.x, b.door.street.y - b.door.tile.y];
    const [px, py] = [-fy, fx];
    const has = (x: number, y: number) => lot.some((t) => t.x === x && t.y === y);
    const side = has(b.door.tile.x + px, b.door.tile.y + py) ? -1 : 1;
    let deep = 1;
    while (has(b.door.tile.x - fx * deep, b.door.tile.y - fy * deep)) deep++;
    const back: [number, number] = [b.door.tile.x + 0.5 - fx * (deep - 0.5), b.door.tile.y + 0.5 - fy * (deep - 0.5)];
    const slots: Pose[] = [];
    for (let s = 0.12; s < deep - 0.3; s += PITCH)
      for (const o of [0.22 + PITCH, 0.22]) slots.push({ at: [back[0] + fx * s + px * side * o, back[1] + fy * s + py * side * o], heading: Math.atan2(fy, fx) });
    const home = (k: number): Pose => ({ at: [back[0] + fx * (0.1 + k * 0.12), back[1] + fy * (0.1 + k * 0.12)], heading: Math.atan2(fy, fx) });
    const bay = { good, slots, stack: Math.max(1, Math.ceil(most(b, good) / slots.length)), face: Math.atan2(-py * side, -px * side), inside: false };
    return { bays: [bay], homes: forklifts(home), homeInside: false, exits: [], aisle: null, yard: true };
  }
  // Along the front wall, on the pavement.
  let a = -f.w / 2 + 0.12;
  const bays = goods.map((good) => {
    const n = most(b, good);
    const fit = Math.max(1, Math.floor((f.w - 0.2) / PITCH / goods.length));
    const slots = Array.from({ length: Math.min(n, fit) }, (_, k) => f.pose(f.at, a + k * PITCH, f.d / 2 - INSET / 2));
    a += slots.length * PITCH + 0.04;
    return { good, slots, stack: Math.ceil(n / slots.length), ...front };
  });
  return { bays, homes: forklifts(() => f.pose(f.at, 0, f.d / 2 + 0.05)), homeInside: false, exits: [], aisle: null, yard: false };
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
