import { isBuilt, type Town } from "./grid";
import { DOCKS, type Facts } from "./facts";
import { formOf } from "./mass";
import { CAB, HALF_W, TRAILER } from "../objects/roadGeometry";
import { INSET } from "./footprint";
import { baysAt, drive } from "./surface";

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

/** A lorry bay at a depot's dock: where its middle meets the wall, the way
 *  out of it (radians from +x, y down), and whether a lorry stands in it,
 *  backed up to the door. */
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

type Pt = [number, number];

export interface Dressing {
  trees: Tree[];
  cars: Car[];
  docks: Dock[];
  /** The lines between the bays of yards, painted on their asphalt. */
  yardLines: Pt[][];
}

/** A lorry bay's depth: a lorry and a little. */
const DOCK_DEPTH = TRAILER.l + CAB.l + 0.08;

/** Where a car stands in a bay at the kerb, as the server has it
 *  (`lots.rs`): along the kerb, its middle this far from its street's
 *  middle line (`KERB`), two to a tile a quarter either side of the
 *  middle (`BAY_AT`); nose in, this far (`SQUARE`), four to a tile. */
const KERB = 0.305;
const BAY_AT = 0.25;
const SQUARE = 0.55;
const SQUARE_AT = [-0.3, -0.1, 0.1, 0.3];

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
    cars: [...park(town), ...drives.cars],
    docks: lorries.docks, yardLines: lorries.lines,
  };
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
function driveways(town: Town): { strips: Pt[][]; cars: Car[] } {
  const strips: Pt[][] = [], cars: Car[] = [];
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

/** A depot's docks: wherever its yard meets its hall, a row of lorry bays
 *  along the hall's wall, some with a lorry backed up to the door. */
function docks(town: Town, facts: Facts): { docks: Dock[]; lines: Pt[][] } {
  const out: Dock[] = [], lines: Pt[][] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      for (const [dc, dr] of facts.docks(c, r)) {
        // The wall, and along it (ux, uy); out of the bays is (-dc, -dr).
        const [wx, wy] = [c + 0.5 + dc * (0.5 + INSET), r + 0.5 + dr * (0.5 + INSET)];
        const [ux, uy] = [-dr, dc];
        for (let k = 0; k <= DOCKS; k++) {
          const t = k / DOCKS - 0.5;
          lines.push(strip(wx, wy, ux, uy, t - 0.008, t + 0.008, -dc, -dr, 0, DOCK_DEPTH));
          if (k === DOCKS) continue;
          const m = t + 0.5 / DOCKS;
          const [x, y] = [wx + ux * m, wy + uy * m];
          out.push({ x, y, angle: Math.atan2(-dr, -dc), lorry: hash(Math.round(x * 100), Math.round(y * 100), 17) < 0.6 });
        }
      }
    }
  }
  return { docks: out, lines };
}

/** A strip along the line from (x0, y0) along (ux, uy) for `len`, on the
 *  side (nx, ny), from `a` to `b` out from the line. */
function strip(x0: number, y0: number, ux: number, uy: number, t0: number, t1: number, nx: number, ny: number, a: number, b: number): Pt[] {
  const at = (t: number, o: number): Pt => [x0 + ux * t + nx * o, y0 + uy * t + ny * o];
  return [at(t0, a), at(t1, a), at(t1, b), at(t0, b)];
}

/** Cars in the bays at the kerb, where the game parks them (`baysAt`):
 *  along the kerb before a block of flats, nose in before anything else;
 *  a bay empty now and then. */
function park(town: Town): Car[] {
  const cars: Car[] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      for (const { side: [sx, sy], square, halves } of baysAt(town, c, r)) {
        const [ux, uy] = [Math.abs(sy), Math.abs(sx)];
        const out = square ? SQUARE : KERB;
        for (const a of square ? SQUARE_AT : halves.map((s) => s * BAY_AT)) {
          const [x, y] = [c + 0.5 + ux * a + sx * out, r + 0.5 + uy * a + sy * out];
          const [hx, hy] = [Math.round(x * 100), Math.round(y * 100)];
          if (hash(hx, hy, 11) < 0.35) continue;
          cars.push({ x, y, angle: square ? Math.atan2(sy, sx) : Math.atan2(uy, ux), colour: Math.floor(hash(hx, hy, 13) * 8) });
        }
      }
    }
  }
  return cars;
}
