import { isBuilt, type Town } from "./grid";
import { DOCKS, PARKED, type Facts } from "./facts";
import { formOf } from "./mass";
import { CAB, CAR, HALF_W, TRAILER } from "../objects/roadGeometry";
import { INSET } from "./footprint";

/**
 * The free ground, dressed: what stands on a tile that is no building's,
 * decided like everything else by the tile, its neighbours and the facts.
 *
 * - A courtyard (`enclosed`) is a garden: lawn, and a tree or two. Paved
 *   ground closed in stays paved: a square.
 * - A street running straight has a tree on its verge every third tile,
 *   on each side that fronts homes, shops or open ground; a through road,
 *   a junction, a bend, a diagonal and an industrial street stay bare.
 *
 * - A street before homes and shops is parked along both kerbs
 *   (fileparkeren), straight or diagonal, clear of junctions, bends and
 *   ends, with a gap here and there. Through roads and streets before
 *   anything else stay clear.
 *
 * - Where cars park, the kerb is a parking lane, its bays marked. (The
 *   pavement round it is ground: roads and buildings make paved terrain.)
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
  /** Tiles laid to lawn. */
  gardens: [number, number][];
  trees: Tree[];
  cars: Car[];
  /** Parking lanes, and the lines between their bays. */
  lanes: Pt[][];
  bays: Pt[][];
  docks: Dock[];
  /** The lines between the bays of yards: docks and car parks. */
  yardLines: Pt[][];
}

/** A lorry bay's depth: a lorry and a little. */
const DOCK_DEPTH = TRAILER.l + CAB.l + 0.08;

/** A parking lane, from just past the road's edge (0.2) out, a car wide
 *  and a little room either side; then pavement to the rows' faces. */
const LANE: [number, number] = [HALF_W + 0.015, HALF_W + 0.015 + CAR.w + 0.03];
/** How far a parked car's middle is from its street's middle line: the
 *  lane's middle, wholly off the road. */
const KERB = (LANE[0] + LANE[1]) / 2;
/** Parking bays along a street: their spacing, a car and a bit. */
const BAY = CAR.l + 0.07;
/** How far from a junction, bend or end the kerb stays clear. */
const CORNER = 0.7;

/** A number in [0, 1) that is the same for the same tile and salt. */
function hash(c: number, r: number, salt: number) {
  let s = (c * 374761393 + r * 668265263 + salt * 1013904223) | 0;
  s = Math.imul(s ^ (s >>> 13), 1274126177);
  return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
}

export function dress(town: Town, facts: Facts): Dressing {
  const gardens: [number, number][] = [];
  const trees: Tree[] = [];
  const road = (c: number, r: number) => town.tile(c, r).kind === "road";
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (facts.enclosed(c, r) && town.tile(c, r).kind === "open") {
        gardens.push([c, r]);
        // One tree on most tiles of a garden, somewhere off the middle.
        if (hash(c, r, 1) < 0.6) {
          trees.push({ x: c + 0.25 + 0.5 * hash(c, r, 2), y: r + 0.25 + 0.5 * hash(c, r, 3), scale: 0.7 + 0.3 * hash(c, r, 4), shade: Math.floor(3 * hash(c, r, 5)) });
        }
        continue;
      }
      if (!road(c, r) || town.through(c, r)) continue;
      // A straight street: joined along one axis only, both ways or at an end.
      const [ew, ns] = [town.linked(c, r, c - 1, r) || town.linked(c, r, c + 1, r), town.linked(c, r, c, r - 1) || town.linked(c, r, c, r + 1)];
      const diagonal = [[1, 1], [1, -1], [-1, 1], [-1, -1]].some(([dc, dr]) => town.linked(c, r, c + dc, r + dr));
      if (ew === ns || diagonal) continue;
      if ((ew ? c : r) % 3 !== 1) continue;
      for (const side of [-1, 1]) {
        const [x, y] = ew ? [c, r + side] : [c + side, r];
        const t = town.tile(x, y);
        if (t.kind !== "open" && !(isBuilt(t) && formOf(t).family === "street")) continue;
        const [ox, oy] = ew ? [0, side * 0.55] : [side * 0.55, 0];
        trees.push({ x: c + 0.5 + ox, y: r + 0.5 + oy, scale: 0.5, shade: Math.floor(3 * hash(c, r, side + 7)) });
      }
    }
  }
  // A car does not stand where a tree does, nor its bay.
  const parked = park(town);
  const clear = (x: number, y: number) => trees.every((t) => Math.hypot(t.x - x, t.y - y) > 0.3);
  const cars = parked.cars.filter((car) => clear(car.x, car.y));
  const lorries = docks(town, facts), lots = carParks(town, facts);
  const service = facts.services;
  return {
    gardens, trees, cars: [...cars, ...lots.cars], lanes: [...parked.lanes, ...service.map((s) => s.lane)], bays: parked.bays,
    docks: [...lorries.docks, ...service.map((s) => ({ ...s.dock, lorry: true }))], yardLines: [...lorries.lines, ...lots.lines],
  };
}

/** A car park: on each tile, an aisle along its street between two rows
 *  of bays, nose in, one backing onto the pavement and one onto the shop,
 *  most of them taken. */
function carParks(town: Town, facts: Facts): { cars: Car[]; lines: Pt[][] } {
  const cars: Car[] = [], lines: Pt[][] = [];
  const ROW = 0.35, ACROSS = PARKED / 2;
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (facts.yard(c, r) !== "cars") continue;
      const toStreet = [[0, -1], [0, 1], [-1, 0], [1, 0]].find(([dc, dr]) => town.tile(c + dc, r + dr).kind === "road");
      if (!toStreet) continue;
      // Toward the street (nx, ny), and along it (ux, uy).
      const [nx, ny] = toStreet;
      const [ux, uy] = [-ny, nx];
      const [x0, y0] = [c + 0.5, r + 0.5];
      for (const side of [1, -1]) {
        for (let k = 0; k <= ACROSS; k++) {
          const t = k / ACROSS - 0.5;
          lines.push(strip(x0, y0, ux, uy, t - 0.008, t + 0.008, nx * side, ny * side, 0.5 - ROW, 0.5));
          if (k === ACROSS) continue;
          const m = t + 0.5 / ACROSS;
          const [x, y] = [x0 + ux * m + nx * side * (0.5 - ROW / 2), y0 + uy * m + ny * side * (0.5 - ROW / 2)];
          const h = hash(Math.round(x * 100), Math.round(y * 100), 19);
          if (h < 0.25) continue;
          cars.push({ x, y, angle: Math.atan2(ny * side, nx * side), colour: Math.floor(hash(Math.round(x * 100), Math.round(y * 100), 23) * 8) });
        }
      }
    }
  }
  return { cars, lines };
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

const EIGHT = [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1]];

/** A strip along the line from (x0, y0) along (ux, uy) for `len`, on the
 *  side (nx, ny), from `a` to `b` out from the line. */
function strip(x0: number, y0: number, ux: number, uy: number, t0: number, t1: number, nx: number, ny: number, a: number, b: number): Pt[] {
  const at = (t: number, o: number): Pt => [x0 + ux * t + nx * o, y0 + uy * t + ny * o];
  return [at(t0, a), at(t1, a), at(t1, b), at(t0, b)];
}

/** Cars parked along the kerbs of streets before homes and shops, their
 *  lane and its bays. */
function park(town: Town): { cars: Car[]; lanes: Pt[][]; bays: Pt[][] } {
  const cars: Car[] = [], lanes: Pt[][] = [], bays: Pt[][] = [];
  const links = (c: number, r: number) => EIGHT.filter(([dc, dr]) => town.linked(c, r, c + dc, r + dr));
  /** A road tile the street runs straight through: two links, opposite. */
  const straight = (c: number, r: number) => {
    const l = links(c, r);
    return l.length === 2 && l[0][0] === -l[1][0] && l[0][1] === -l[1][1];
  };
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (town.tile(c, r).kind !== "road" || town.through(c, r)) continue;
      for (const [dc, dr] of links(c, r)) {
        // Each stretch between two road tiles once.
        if (dc < 0 || (dc === 0 && dr < 0)) continue;
        if (town.through(c + dc, r + dr)) continue;
        const len = Math.hypot(dc, dr);
        const [ux, uy] = [dc / len, dr / len];
        const [x0, y0] = [c + 0.5, r + 0.5];
        // Clear of a junction, bend or end at either end of the stretch.
        const clear0 = straight(c, r) ? 0 : CORNER;
        const clear1 = straight(c + dc, r + dr) ? 0 : CORNER;
        const n = Math.floor(len / BAY);
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) * (len / n);
          if (t < clear0 || t > len - clear1) continue;
          for (const side of [-1, 1]) {
            const [nx, ny] = [-uy * side, ux * side];
            const [x, y] = [x0 + ux * t + nx * KERB, y0 + uy * t + ny * KERB];
            // Only before homes and shops, and a gap now and then.
            const front = town.tile(Math.floor(x + nx * 0.4), Math.floor(y + ny * 0.4));
            if (!isBuilt(front) || formOf(front).family !== "street") continue;
            const [b0, b1] = [t - len / n / 2, t + len / n / 2];
            lanes.push(strip(x0, y0, ux, uy, b0, b1, nx, ny, LANE[0], LANE[1]));
            for (const e of [b0, b1]) bays.push(strip(x0, y0, ux, uy, e - 0.008, e + 0.008, nx, ny, LANE[0], LANE[1]));
            const h = hash(Math.round(x * 100), Math.round(y * 100), 11);
            if (h < 0.35) continue;
            cars.push({ x, y, angle: Math.atan2(uy, ux), colour: Math.floor(hash(Math.round(x * 100), Math.round(y * 100), 13) * 8) });
          }
        }
      }
    }
  }
  return { cars, lanes, bays };
}
