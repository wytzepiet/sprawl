import { isBuilt, type Town } from "./grid";
import type { Facts } from "./facts";
import { formOf } from "./mass";

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

/** A parked car: where its middle is, which way it points (radians from
 *  +x, y down), and which of a handful of colours. */
export interface Car {
  x: number;
  y: number;
  angle: number;
  colour: number;
}

export interface Dressing {
  /** Tiles laid to lawn. */
  gardens: [number, number][];
  trees: Tree[];
  cars: Car[];
}

/** How far a parked car's middle is from its street's middle line: past
 *  the road's edge and kerb, half a car's width more. */
const KERB = 0.27;
/** Parking bays along a street: their spacing, a car and a bit. */
const BAY = 0.42;
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
        const [ox, oy] = ew ? [0, side * 0.38] : [side * 0.38, 0];
        trees.push({ x: c + 0.5 + ox, y: r + 0.5 + oy, scale: 0.6, shade: Math.floor(3 * hash(c, r, side + 7)) });
      }
    }
  }
  // A car does not stand where a tree does.
  const cars = park(town).filter((car) => trees.every((t) => Math.hypot(t.x - car.x, t.y - car.y) > 0.3));
  return { gardens, trees, cars };
}

const EIGHT = [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1]];

/** Cars parked along the kerbs of streets before homes and shops. */
function park(town: Town): Car[] {
  const cars: Car[] = [];
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
            const h = hash(Math.round(x * 100), Math.round(y * 100), 11);
            if (h < 0.35) continue;
            cars.push({ x, y, angle: Math.atan2(uy, ux), colour: Math.floor(hash(Math.round(x * 100), Math.round(y * 100), 13) * 8) });
          }
        }
      }
    }
  }
  return cars;
}
