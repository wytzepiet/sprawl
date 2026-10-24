import { isBuilt, type Town } from "./grid";
import type { Facts } from "./facts";
import { formOf } from "./mass";
import { HALF_W } from "../objects/roadGeometry";
import { INSET } from "./footprint";
import { baysAt, drive, SIDEWALK } from "./surface";
import type { P } from "../geometry";

/**
 * The free ground, dressed: what stands on a tile that is no building's,
 * decided like everything else by the tile, its neighbours and the facts.
 *
 * - A street running straight has a tree on its verge every third tile,
 *   on each side that fronts homes, shops or open ground and has no bays;
 *   a through road, a junction, a bend, a diagonal and an industrial
 *   street stay bare.
 *
 * - Cars stand where the game parks them: on a house's drive, and in the
 *   bays at the kerb before anything else that parks there (`baysAt`),
 *   with a gap here and there.
 *
 * - Street lamps stand where the road's edge runs (`lamps`).
 *
 * Which tiles get a tree or a car, and where, comes from the place alone,
 * so the same town is always dressed the same.
 */
export interface Tree {
  x: number;
  y: number;
  /** Its size, as a share of a forest tree's. */
  scale: number;
  /** Which of the theme's crowns, 0 dark to 2 light. */
  shade: number;
}

/** A lorry bay at a yard's dock: where a docked box's tail is, the way
 *  out of it to the lane (radians from +x, y down), and whether a lorry
 *  stands in it. */
export interface Dock {
  x: number;
  y: number;
  angle: number;
  lorry: boolean;
}

/** A parked car: where its middle is, which way it points (radians from
 *  +x, y down), and which of a handful of colours. */
export interface Car {
  x: number;
  y: number;
  angle: number;
  colour: number;
}

/** A street lamp: its foot on the pavement, and its head, out over the
 *  kerb on its arm. */
export interface Lamp {
  x: number;
  y: number;
  hx: number;
  hy: number;
}

export interface Dressing {
  trees: Tree[];
  lamps: Lamp[];
  cars: Car[];
  docks: Dock[];
  /** The lines between the bays of yards, painted on their asphalt. */
  yardLines: P[][];
}

/** A yard's park as the server lays it (`lots::park`): rows of docks in
 *  from the yard's back up the lane, a docked cab out from the lane's
 *  middle, a side of the yard too narrow for a box without docks, and
 *  how far out a docked box's tail is: the cab, the coupling and the box. */
const DOCK_ROWS = [0.55, 0.85, 1.15, 1.45];
const DOCK_OUT = 0.9;
const DOCK_REACH = 1.4;
const TAIL = DOCK_OUT + 0.49;

/** A number in [0, 1) that is the same for the same tile and salt. */
function hash(c: number, r: number, salt: number) {
  let s = (c * 374761393 + r * 668265263 + salt * 1013904223) | 0;
  s = Math.imul(s ^ (s >>> 13), 1274126177);
  return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
}

export function dress(town: Town, facts: Facts): Dressing {
  const trees: Tree[] = [];
  const at = (c: number, r: number) => (town.at ? town.at(c, r) : [c, r]);
  const road = (c: number, r: number) => town.tile(c, r).kind === "road";
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (!road(c, r) || town.through(c, r)) continue;
      // A straight street: joined along one axis only, both ways or at an end.
      const [ew, ns] = [town.linked(c, r, c - 1, r) || town.linked(c, r, c + 1, r), town.linked(c, r, c, r - 1) || town.linked(c, r, c, r + 1)];
      const diagonal = [[1, 1], [1, -1], [-1, 1], [-1, -1]].some(([dc, dr]) => town.linked(c, r, c + dc, r + dr));
      if (ew === ns || diagonal) continue;
      const [mc, mr] = at(c, r);
      if (((((ew ? mc : mr) % 3) + 3) % 3) !== 1) continue;
      const bays = baysAt(town, c, r);
      for (const side of [-1, 1]) {
        const [sx, sy] = ew ? [0, side] : [side, 0];
        const t = town.tile(c + sx, r + sy);
        if (t.kind !== "open" && !(isBuilt(t) && formOf(t).family === "street")) continue;
        if (bays.some((b) => b.side[0] === sx && b.side[1] === sy)) continue;
        // Between two plots, where no drive comes out.
        const [tx, ty] = ew ? [c, r + 0.5 + side * 0.55] : [c + 0.5 + side * 0.55, r];
        trees.push({ x: tx, y: ty, scale: 0.5, shade: Math.floor(3 * hash(mc, mr, side + 7)) });
      }
    }
  }
  const drives = driveways(town);
  // No tree on a drive.
  const onDrive = (t: Tree) => drives.strips.some((q) => {
    const [xs, ys] = [q.map((p) => p[0]), q.map((p) => p[1])];
    return t.x > Math.min(...xs) - 0.1 && t.x < Math.max(...xs) + 0.1 && t.y > Math.min(...ys) - 0.1 && t.y < Math.max(...ys) + 0.1;
  });
  const lorries = docks(town, facts);
  return {
    trees: trees.filter((t) => !onDrive(t)),
    lamps: lamps(town).filter((l) => !onDrive({ x: l.x, y: l.y, scale: 0, shade: 0 })),
    cars: [...park(town), ...drives.cars],
    docks: lorries.docks, yardLines: lorries.lines,
  };
}

/** How far out from a road's middle a lamp stands: on the pavement, just
 *  past the kerb; how far its arm reaches back over the road. */
const LAMP_OUT = HALF_W + 0.07;
/** And from a diagonal street's, whose asphalt is wider across. */
const DIAGONAL_OUT = 0.42;
const ARM = 0.1;
/** A lamp to every this many tiles along each side of a straight street,
 *  the two sides staggered by half of it. */
const LAMP_EVERY = 4;
const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * Street lamps, by marching squares over the road. Each square of four
 * tiles' middles is one of sixteen cases of road and not; the road's edge
 * runs through it as the case says, and the case says where a lamp goes:
 *
 * - three of road, a street turning a corner or a junction's: a lamp on the
 *   corner of the pavement, its arm out over the crossing;
 * - two side by side, the edge running straight: a lamp every
 *   `LAMP_EVERY` tiles, the far side's halfway between, and none beside a
 *   junction's mouth, where the corner's lamp stands;
 * - two across the diagonal, a diagonal street: a lamp each side by turns;
 * - one, the outside of a bend or a dead end, none or four, none.
 *
 * Only roads with a pavement are lit: in town, and out of it a junction.
 * By where the square is on the map, so the town is lit the same however
 * it is framed.
 */
function lamps(town: Town): Lamp[] {
  const out: Lamp[] = [];
  const at = (c: number, r: number) => (town.at ? town.at(c, r) : [c, r]);
  const road = (c: number, r: number) => town.tile(c, r).kind === "road";
  const lit = (c: number, r: number) => road(c, r) && (town.sidewalk?.(c, r) ?? SIDEWALK) > 0;
  /** A lamp at (x, y), its arm toward (dx, dy), a unit step. */
  const lamp = (x: number, y: number, dx: number, dy: number) => out.push({ x, y, hx: x + dx * ARM, hy: y + dy * ARM });
  for (let r = -1; r < town.h; r++) {
    for (let c = -1; c < town.w; c++) {
      const corners = [road(c, r), road(c + 1, r), road(c, r + 1), road(c + 1, r + 1)];
      const n = corners.filter(Boolean).length;
      if (n === 3) {
        // The corner tile across from the one that is not road: the
        // street turns there, both its arms joined to it.
        const gone = corners.indexOf(false);
        const [sx, sy] = [gone % 2 ? 1 : -1, gone > 1 ? 1 : -1];
        const [jc, jr] = [c + (gone % 2 ? 0 : 1), r + (gone > 1 ? 0 : 1)];
        if (!lit(jc, jr) || !town.linked(jc, jr, jc + sx, jr) || !town.linked(jc, jr, jc, jr + sy)) continue;
        lamp(jc + 0.5 + sx * LAMP_OUT, jr + 0.5 + sy * LAMP_OUT, -sx * Math.SQRT1_2, -sy * Math.SQRT1_2);
      } else if (n === 2 && corners[0] === corners[3]) {
        // A diagonal street, from the corner tile (c0, r0) on.
        const [c0, d] = corners[0] ? [c, 1] : [c + 1, -1];
        if (!lit(c0, r) || !town.linked(c0, r, c0 + d, r + 1)) continue;
        const side = mod(at(c0, r)[0], LAMP_EVERY);
        if (side !== 0 && side !== LAMP_EVERY / 2) continue;
        // Across the street from its middle, to one side or the other.
        const s = side ? -1 : 1;
        const [px, py] = [(s * Math.SQRT1_2), (-s * d * Math.SQRT1_2)];
        lamp(c0 + 0.5 + px * DIAGONAL_OUT, r + 0.5 + py * DIAGONAL_OUT, -px, -py);
      } else if (n === 2) {
        // A straight edge: the street along (ux, uy) from tile (c0, r0),
        // the pavement toward (nx, ny).
        const [c0, r0, ux, uy, nx, ny] =
          corners[0] && corners[1] ? [c, r, 1, 0, 0, 1]
          : corners[2] && corners[3] ? [c, r + 1, 1, 0, 0, -1]
          : corners[0] && corners[2] ? [c, r, 0, 1, 1, 0]
          : [c + 1, r, 0, 1, -1, 0];
        const along = (k: number) => [c0 + ux * k, r0 + uy * k];
        // Straight a tile either way too: not at a junction's mouth.
        const straight = [-1, 0, 1, 2].every((k) => {
          const [tc, tr] = along(k);
          return lit(tc, tr) && !road(tc + nx, tr + ny) && (k === 2 || town.linked(tc, tr, tc + ux, tr + uy));
        });
        if (!straight) continue;
        const [mc, mr] = at(c0, r0);
        if (mod((ux ? mc : mr) + ((nx || ny) > 0 ? 0 : LAMP_EVERY / 2), LAMP_EVERY)) continue;
        if ([0, 1].some((k) => baysAt(town, ...(along(k) as [number, number])).some((b) => b.side[0] === nx && b.side[1] === ny))) continue;
        // On the line between the two tiles, out on the pavement.
        lamp(c0 + 0.5 + ux * 0.5 + nx * LAMP_OUT, r0 + 0.5 + uy * 0.5 + ny * LAMP_OUT, -nx, -ny);
      }
    }
  }
  return out;
}

/** A driveway: as wide as two cars side by side with a little room, the
 *  cars' middles a little either side of the house's (`LANE` in the
 *  server's `lots.rs`), and how far out from the house's middle they stand
 *  (`SPOT_OUT`): wholly before its front wall, short of the road. */
const DRIVE = 0.42;
const DRIVE_LANE = 0.11;
const DRIVE_OUT = 0.47;

/**
 * Driveways: a house's drive runs from its door to its street, a road
 * like any other (`surface.ts` draws it as an arm of the street, curves
 * and all), and on it, as the game parks them, its household's two cars
 * side by side, nose to the house; one now and then, the other out. By
 * house and the way to its street, and the drive's ground, which no tree
 * stands on.
 */
function driveways(town: Town): { strips: P[][]; cars: Car[] } {
  const strips: P[][] = [], cars: Car[] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const toward = town.tile(c, r).kind === "House" ? drive(town, c, r) : undefined;
      if (!toward) continue;
      // To its street's middle, a tile away or on the diagonal, and the
      // way there (fx, fy).
      const len = Math.hypot(toward[0], toward[1]);
      const [fx, fy] = [toward[0] / len, toward[1] / len];
      const [x0, y0] = [c + 0.5, r + 0.5];
      // From the front wall out across the pavement to the road's edge.
      strips.push(strip(x0, y0, -fy, fx, -DRIVE / 2, DRIVE / 2, fx, fy, 0.5 - INSET, len - HALF_W + 0.02));
      const one = hash(c, r, 41) < 0.25;
      for (const side of [-1, 1]) {
        if (one && side === (hash(c, r, 42) < 0.5 ? -1 : 1)) continue;
        cars.push({ x: x0 + fx * DRIVE_OUT - fy * DRIVE_LANE * side, y: y0 + fy * DRIVE_OUT + fx * DRIVE_LANE * side, angle: Math.atan2(-fy, -fx), colour: Math.floor(hash(c, r, 43 + side) * 8) });
      }
    }
  }
  return { strips, cars };
}

/** A yard's docks, as the server lays its park (`lots::park`): a lane
 *  straight in from the gate, the door's tile, to the yard's back, and off
 *  it, on each side the yard reaches far enough, rows of docks, the lines
 *  between them painted, some with a lorry. */
function docks(town: Town, facts: Facts): { docks: Dock[]; lines: P[][] } {
  const out: Dock[] = [], lines: P[][] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      // A harbour's docks are on one side of its lane, the quay's pad on
      // the other (`Berth::park`).
      const fill = facts.yard(c, r);
      const way = fill === "docks" || fill === "park" ? town.door?.(c, r) : undefined;
      if (!way || (way[0] && way[1])) continue;
      // In toward the street (fx, fy), and across (px, py); the yard's
      // tiles of this building, counted in from the gate and across.
      const [fx, fy] = way, [px, py] = [-fy, fx];
      const id = town.tile(c, r).id;
      const ours = (k: number, j: number) => facts.yard(c + fx * k + px * j, r + fy * k + py * j) === fill && town.tile(c + fx * k + px * j, r + fy * k + py * j).id === id;
      const run = (k: number, j: number, n = 0): number => (ours(k * (n + 1), j * (n + 1)) ? run(k, j, n + 1) : n);
      const deep = run(-1, 0) + 1;
      // The back of the yard, behind the lane's middle: `at(s, side)` is
      // `s` in from it and `side` across.
      const [ox, oy] = [c + 0.5 - fx * (deep - 0.5), r + 0.5 - fy * (deep - 0.5)];
      const at = (s: number, side: number): P => [ox + fx * s + px * side, oy + fy * s + py * side];
      for (const side of (fill === "park" ? [1] : [1, -1]).filter((j) => run(0, j) + 0.5 >= DOCK_REACH)) {
        const [nx, ny] = [px * side, py * side];
        for (const s of [...DOCK_ROWS.map((s) => s - 0.15), DOCK_ROWS[DOCK_ROWS.length - 1] + 0.15]) lines.push(strip(ox, oy, fx, fy, s - 0.008, s + 0.008, nx, ny, 0.45, TAIL));
        for (const s of DOCK_ROWS) {
          const [x, y] = at(s, side * TAIL);
          out.push({ x, y, angle: Math.atan2(-ny, -nx), lorry: hash(Math.round(x * 100), Math.round(y * 100), 17) < 0.6 });
        }
      }
    }
  }
  return { docks: out, lines };
}

/** A strip along the line from (x0, y0) along (ux, uy) for `len`, on the
 *  side (nx, ny), from `a` to `b` out from the line. */
function strip(x0: number, y0: number, ux: number, uy: number, t0: number, t1: number, nx: number, ny: number, a: number, b: number): P[] {
  const at = (t: number, o: number): P => [x0 + ux * t + nx * o, y0 + uy * t + ny * o];
  return [at(t0, a), at(t1, a), at(t1, b), at(t0, b)];
}

/** Cars in the bays at the kerb, where the game parks them (`baysAt`):
 *  along the kerb before a block of flats, nose in before anything else;
 *  a bay empty now and then. */
function park(town: Town): Car[] {
  const cars: Car[] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      for (const { x, y, angle } of baysAt(town, c, r)) {
        const [hx, hy] = [Math.round(x * 100), Math.round(y * 100)];
        if (hash(hx, hy, 11) < 0.35) continue;
        cars.push({ x, y, angle, colour: Math.floor(hash(hx, hy, 13) * 8) });
      }
    }
  }
  return cars;
}
