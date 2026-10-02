import { isBuilt, type Town } from "./grid";
import { DOCKS, PARKED, type Facts } from "./facts";
import { formOf } from "./mass";
import { buildRoadGeometry, CAB, CAR, HALF_W, TRAILER, type ArmInfo } from "../objects/roadGeometry";
import { defaultJoins, INSET, intersect, shrink, soften, subtract, unite, type Polygon } from "./footprint";

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
  /** The lines between the bays of yards: docks, car parks and a ferry
   *  port's queue lanes. */
  yardLines: Pt[][];
  /** Ferries at their berths: the middle of each, and which way its bow
   *  points, out to sea. */
  ships: { x: number; y: number; angle: number }[];
}

/** A ferry, long and broad, in tiles: bigger than true to the map, so it
 *  reads beside the yard it empties. */
export const FERRY = { l: 3.2, w: 0.85 };
/** The ramp from the quay to a ferry's stern. */
const RAMP = { l: 0.3, w: 0.55 };

/** A lorry bay's depth: a lorry and a little. */
const DOCK_DEPTH = TRAILER.l + CAB.l + 0.08;

/** A parking lane, from the road's edge (0.2) out, a car wide and a
 *  little room either side; then pavement to the rows' faces. */
const LANE: [number, number] = [HALF_W, HALF_W + 0.015 + CAR.w + 0.03];
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
  // A car does not stand where a tree does, nor its bay; nor across a
  // driveway's mouth.
  const drives = driveways(town);
  const mouthFree = (p: Pt[]) => {
    const [x, y] = [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length];
    return drives.mouths.every(([mx, my]) => Math.hypot(mx - x, my - y) > (BAY + DRIVE) / 2);
  };
  const parked = park(town);
  parked.lanes = parked.lanes.filter(mouthFree);
  parked.bays = parked.bays.filter(mouthFree);
  const clear = (x: number, y: number) => trees.every((t) => Math.hypot(t.x - x, t.y - y) > 0.3) && mouthFree([[x, y]]);
  const cars = [...parked.cars.filter((car) => clear(car.x, car.y)), ...drives.cars];
  const lorries = docks(town, facts), lots = carParks(town, facts);
  const service = facts.services;
  const port = ferries(town, facts);
  return {
    gardens, trees, cars: [...cars, ...lots.cars, ...port.cars], lanes: [...parked.lanes, ...drives.strips, ...service.map((s) => s.lane), ...port.ramps], bays: parked.bays,
    docks: [...lorries.docks, ...service.map((s) => ({ ...s.dock, lorry: true }))], yardLines: [...lorries.lines, ...lots.lines, ...port.lines],
    ships: port.ships,
  };
}

/** How round the asphalt's corners are, in and out. */
const ROUND = 0.05;

/**
 * The asphalt: the roads as the game lays them, each tile's arms to the
 * tiles it is joined to, and everything driven on that leads off them,
 * parking lanes, driveways, service lanes, ramps, as one surface, its
 * corners rounded in and out, so a bay or a drive reads as the road
 * carried on. Through roads keep their own colour, cut from it straight.
 */
export function asphalt(town: Town, lanes: Pt[][]): { street: Polygon[]; through: Polygon[] } {
  const tiles = (through: boolean) => {
    const tris: Polygon[] = [];
    for (let r = 0; r < town.h; r++) {
      for (let c = 0; c < town.w; c++) {
        if (town.tile(c, r).kind !== "road" || town.through(c, r) !== through) continue;
        const arms: ArmInfo[] = [];
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!(dc || dr) || !town.linked(c, r, c + dc, r + dr)) continue;
            const a = Math.atan2(-dr, -dc);
            arms.push({ angle: a < 0 ? a + 2 * Math.PI : a, flow: "twoway" });
          }
        }
        const geo = buildRoadGeometry(arms, HALF_W, 0);
        if (!geo) continue;
        // The geometry is the world's (x and y the other way); flat only.
        const p = geo.positions;
        const at = (i: number): Pt => [c + 0.5 - p[3 * i], r + 0.5 - p[3 * i + 1]];
        for (let i = 0; i < geo.indices.length; i += 3) tris.push([[at(geo.indices[i]), at(geo.indices[i + 1]), at(geo.indices[i + 2])]]);
      }
    }
    // Grown a hair and drawn back, so no seam is left between triangles.
    return shrink(shrink(tris, -1e-3), 1e-3);
  };
  const through = tiles(true);
  const all = soften(unite([...tiles(false), ...through, ...lanes.map((l): Polygon => [l])]), ROUND);
  return { street: subtract(all, through), through: intersect(through, all) };
}

/** A driveway's width: the margin a house leaves beside it, wall to the
 *  plot's edge, which a car fits with a little either side. */
const DRIVE = INSET;

/**
 * Driveways, where a house leaves room for one: a house with a street
 * running straight past its front, on a side where it is joined to nothing, gets a drive
 * down that side, from the road's edge to its back wall, and a car or two
 * on it, nose in. Open ground beside it is the side it takes (the end of a
 * row, a semi, a house alone); a house with a building beside it on both
 * sides, joined or not, has none, and parks at the kerb. Built beside, the
 * drive goes. So a suburb has driveways and a terrace parks in the street,
 * and nobody chose: as with everything else, the neighbours decide.
 */
function driveways(town: Town): { strips: Pt[][]; cars: Car[]; mouths: Pt[] } {
  const strips: Pt[][] = [], cars: Car[] = [], mouths: Pt[] = [];
  const joined = town.joins ?? defaultJoins(town);
  const road = (c: number, r: number) => town.tile(c, r).kind === "road";
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (town.tile(c, r).kind !== "House") continue;
      // Toward its street (fx, fy): a side with a street running straight
      // past it, beside the house along its front.
      const front = [[0, 1], [0, -1], [1, 0], [-1, 0]].find(([fx, fy]) => {
        const [x, y] = [c + fx, r + fy];
        return road(x, y) && (town.linked(x, y, x - fy, y + fx) || town.linked(x, y, x + fy, y - fx));
      });
      if (!front) continue;
      const [fx, fy] = front;
      // A side the house is joined to nothing on, with open ground there.
      const side = [[-fy, fx], [fy, -fx]].find(([sx, sy]) => {
        const [x, y] = [c + sx, r + sy];
        const t = town.tile(x, y);
        return !isBuilt(t) && t.kind !== "road" && t.kind !== "water" && !joined(c, r, x, y);
      });
      if (!side) continue;
      const [sx, sy] = side;
      // Down the margin on that side: from the road's edge, across the
      // pavement, to the back wall.
      const [x0, y0] = [c + 0.5 + sx * (0.5 - DRIVE / 2), r + 0.5 + sy * (0.5 - DRIVE / 2)];
      strips.push(strip(x0, y0, sx, sy, -DRIVE / 2, DRIVE / 2, -fx, -fy, -(1 - HALF_W), 0.5 - INSET));
      mouths.push([x0 + fx * (1 - KERB), y0 + fy * (1 - KERB)]);
      // One car, or two nose to tail, nose to the house.
      const n = hash(c, r, 41) < 0.5 ? 1 : 2;
      for (let k = 0; k < n; k++) {
        const back = 0.15 - k * (CAR.l + 0.04);
        cars.push({ x: x0 - fx * back, y: y0 - fy * back, angle: Math.atan2(-fy, -fx), colour: Math.floor(hash(c, r, 43 + k) * 8) });
      }
    }
  }
  return { strips, cars, mouths };
}

/** A ferry port: its yard in queue lanes running down to the water, four
 *  to a tile, the cars waiting in them thinning out from the front of the
 *  queue to the back; down its side the exit road the cars come off by;
 *  a ramp at the quay end of the exit, and the ferry moored stern on to
 *  it. */
function ferries(town: Town, facts: Facts) {
  const cars: Car[] = [], lines: Pt[][] = [], ramps: Pt[][] = [], ships: Dressing["ships"] = [];
  if (!facts.ferries.length) return { cars, lines, ramps, ships };
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const fill = facts.yard(c, r);
      if (fill !== "ferry" && fill !== "exit") continue;
      const near = facts.ferries.reduce((a, b) => (Math.hypot(b.x - c, b.y - r) < Math.hypot(a.x - c, a.y - r) ? b : a));
      const [tx, ty] = near.to;
      const [ux, uy] = [-ty, tx];
      const [x0, y0] = [c + 0.5, r + 0.5];
      if (fill === "exit") {
        // The exit road: a lane from the ramp to the street, and now and
        // then a car just off the boat, driving away from the water.
        ramps.push(strip(x0, y0, tx, ty, -0.5, 0.5, ux, uy, -0.17, 0.17));
        if (hash(c, r, 37) < 0.5) cars.push({ x: x0, y: y0, angle: Math.atan2(-ty, -tx), colour: Math.floor(hash(c, r, 38) * 8) });
        continue;
      }
      for (const o of [-0.25, 0, 0.25]) lines.push(strip(x0, y0, tx, ty, -0.5, 0.5, ux, uy, o - 0.006, o + 0.006));
      for (const o of [-0.375, -0.125, 0.125, 0.375]) {
        for (const t of [-0.22, 0.22]) {
          const [x, y] = [x0 + tx * t + ux * o, y0 + ty * t + uy * o];
          // How far back in the queue: from the water's edge, in tiles.
          const back = (near.x - x) * tx + (near.y - y) * ty;
          if (hash(Math.round(x * 100), Math.round(y * 100), 29) > 0.95 - 0.22 * back) continue;
          cars.push({ x, y, angle: Math.atan2(ty, tx), colour: Math.floor(hash(Math.round(x * 100), Math.round(y * 100), 31) * 8) });
        }
      }
    }
  }
  for (const { to: [tx, ty], x, y } of facts.ferries) {
    ramps.push(strip(x, y, tx, ty, -0.05, RAMP.l, -ty, tx, -RAMP.w / 2, RAMP.w / 2));
    const m = RAMP.l + FERRY.l / 2;
    ships.push({ x: x + tx * m, y: y + ty * m, angle: Math.atan2(ty, tx) });
  }
  return { cars, lines, ramps, ships };
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
          // The whole bay clear of the junction, not just its middle.
          if (t - len / n / 2 < clear0 || t + len / n / 2 > len - clear1) continue;
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
