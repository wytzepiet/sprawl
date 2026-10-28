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
 *  pose, and how many high each takes before the next. */
export interface Bay {
  good: Good;
  slots: Pose[];
  stack: number;
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
  return { at, w, d, pose };
}

/** Packages in rows across, from the back: `cols` across and `rows` out,
 *  their middle `across` and `out` from the building's middle. */
function grid(f: ReturnType<typeof frame>, across: number, out: number, cols: number, rows: number): Pose[] {
  const slots: Pose[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) slots.push(f.pose(f.at, across + (c - (cols - 1) / 2) * PITCH, out + (r - (rows - 1) / 2) * PITCH));
  return slots;
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
 *  not lifting, and whether it is on a yard's asphalt or the pavement.
 *  A harbour's is its quay's, beside its lane on the side its docks are
 *  not (`Berth::park`). */
export interface Pad {
  bays: Bay[];
  homes: Pose[];
  yard: boolean;
}
export function padOf(b: Building): Pad {
  const f = frame(b);
  const kind = BLUEPRINTS[b.kind];
  const forklifts = (at: (k: number) => Pose) => Array.from({ length: kind.forklifts }, (_, k) => at(k));
  if (b.site) {
    // Along the front of the slab, each material after the last.
    const goods = Object.keys(b.site) as Good[];
    let a = -f.w / 2 + 0.15;
    const bays = goods.map((good) => {
      const n = most(b, good);
      const slots = Array.from({ length: n }, (_, k) => f.pose(f.at, a + k * PITCH, f.d / 2 - 0.13));
      a += n * PITCH + 0.04;
      return { good, slots, stack: 1 };
    });
    return { bays, homes: forklifts(() => f.pose(f.at, 0, f.d / 2 + 0.05)), yard: false };
  }
  if (kind.quay) {
    // Out from the ramp, a bay of each good the market trades, two
    // across and five out, each four by two and four high; its forklifts
    // between them and the lane.
    const back = -f.d / 2;
    const bays = HEAVY.filter((g) => g !== "Bread").map((good, k) => ({ good, slots: grid(f, -0.42 - (k % 2) * 0.46, back + 0.36 + Math.floor(k / 2) * 0.26, 4, 2), stack: 4 }));
    return { bays, homes: forklifts((k) => f.pose(f.at, -0.2, back + 0.4 + k * 0.4)), yard: true };
  }
  const goods = Object.keys(b.stocks) as Good[];
  if (b.kind === "Depot") {
    // A bay of each good on the open ground, three by three, four
    // across and three deep, the heavy goods at the back.
    const bays = HEAVY.filter((g) => goods.includes(g)).map((good, k) => {
      const slots = grid(f, ((k % 4) - 1.5) * 0.36, (Math.floor(k / 4) - 1) * 0.36, 3, 3);
      return { good, slots, stack: Math.ceil(most(b, good) / slots.length) };
    });
    return { bays, homes: forklifts((k) => f.pose(f.at, (k - (kind.forklifts - 1) / 2) * 0.12, 0.7)), yard: true };
  }
  if (kind.makes && b.door) {
    // Down the lane's free side, from the yard's back to its gate.
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
      for (const o of [0.22, 0.22 + PITCH]) slots.push({ at: [back[0] + fx * s + px * side * o, back[1] + fy * s + py * side * o], heading: Math.atan2(fy, fx) });
    const home = (k: number): Pose => ({ at: [back[0] + fx * (0.1 + k * 0.12), back[1] + fy * (0.1 + k * 0.12)], heading: Math.atan2(fy, fx) });
    return { bays: [{ good, slots, stack: Math.max(1, Math.ceil(most(b, good) / slots.length)) }], homes: forklifts(home), yard: true };
  }
  // Along the front wall, on the pavement.
  let a = -f.w / 2 + 0.12;
  const bays = goods.map((good) => {
    const n = most(b, good);
    const fit = Math.max(1, Math.floor((f.w - 0.2) / PITCH / goods.length));
    const slots = Array.from({ length: Math.min(n, fit) }, (_, k) => f.pose(f.at, a + k * PITCH, f.d / 2 - INSET / 2));
    a += slots.length * PITCH + 0.04;
    return { good, slots, stack: Math.ceil(n / slots.length) };
  });
  return { bays, homes: forklifts(() => f.pose(f.at, 0, f.d / 2 + 0.05)), yard: false };
}

/** Where the `i`th package of a bay stands: its slot, and how many it
 *  stands on. */
export const placeIn = (bay: Bay, i: number): [Pose, number] => [bay.slots[Math.min(bay.slots.length - 1, Math.floor(i / bay.stack))], i % bay.stack];

/** How far a forklift's run is at `now`: how many packages have left
 *  where they stood (`off`), how many have been set down where they go
 *  (`on`), and, while one is in its forks, how far it is carried, from 0
 *  to 1. A lift is one `every`: in to the package, carried across, set
 *  down, and back for the next. */
export function progress(l: Lift, now: number): { off: number; on: number; carry: number | null } {
  const e = (now - l.start) / l.every;
  if (e <= 0) return { off: 0, on: 0, carry: null };
  if (e >= l.n) return { off: l.n, on: l.n, carry: null };
  const k = Math.floor(e), t = e - k;
  const carrying = t >= PICK && t < DROP;
  return { off: k + (t >= PICK ? 1 : 0), on: k + (t >= DROP ? 1 : 0), carry: carrying ? (t - PICK) / (DROP - PICK) : null };
}
/** A lift's moments: the package taken up, set down. */
export const [PICK, DROP] = [0.2, 0.65];
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
