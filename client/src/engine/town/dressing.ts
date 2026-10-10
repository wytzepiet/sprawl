import { isBuilt, townOf, type Tile, type Town } from "./grid";
import { DOCKS, PARKED, type Facts } from "./facts";
import { formOf } from "./mass";
import { buildRoadGeometry, CAB, CAR, HALF_W, TRAILER, type ArmInfo } from "../objects/roadGeometry";
import { footprints, INSET, intersect, shrink, soften, subtract, unite, type Polygon } from "./footprint";

/**
 * The free ground, dressed: what stands on a tile that is no building's,
 * decided like everything else by the tile, its neighbours and the facts.
 *
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
  /** The lines between the bays of yards: docks and car parks. */
  yardLines: Pt[][];
}

/** A lorry bay's depth: a lorry and a little. */
const DOCK_DEPTH = TRAILER.l + CAB.l + 0.08;

/** How far a parked car's middle is from its street's middle line: beside
 *  the road, wholly off it, with a little room. Nothing marks where it
 *  stands: the car is enough. */
const KERB = HALF_W + 0.03 + CAR.w / 2;
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
      for (const side of [-1, 1]) {
        const [x, y] = ew ? [c, r + side] : [c + side, r];
        const t = town.tile(x, y);
        if (t.kind !== "open" && !(isBuilt(t) && formOf(t).family === "street")) continue;
        // Between two plots, where no drive comes out.
        const [tx, ty] = ew ? [c, r + 0.5 + side * 0.55] : [c + 0.5 + side * 0.55, r];
        trees.push({ x: tx, y: ty, scale: 0.5, shade: Math.floor(3 * hash(mc, mr, side + 7)) });
      }
    }
  }
  // A car does not stand where a tree does, nor its bay; nor across a
  // driveway's mouth.
  const drives = driveways(town);
  // Nor a tree on a drive.
  const onDrive = (t: Tree) => drives.strips.some((q) => {
    const [xs, ys] = [q.map((p) => p[0]), q.map((p) => p[1])];
    return t.x > Math.min(...xs) - 0.1 && t.x < Math.max(...xs) + 0.1 && t.y > Math.min(...ys) - 0.1 && t.y < Math.max(...ys) + 0.1;
  });
  trees.splice(0, trees.length, ...trees.filter((t) => !onDrive(t)));
  const clear = (x: number, y: number) =>
    trees.every((t) => Math.hypot(t.x - x, t.y - y) > 0.2 * t.scale + CAR.w / 2) && drives.mouths.every(([mx, my]) => Math.hypot(mx - x, my - y) > (BAY + DRIVE) / 2);
  const cars = [...park(town, facts).filter((car) => clear(car.x, car.y)), ...drives.cars];
  const lorries = docks(town, facts), lots = carParks(town, facts);
  const service = facts.services;
  return {
    trees, cars: [...cars, ...lots.cars],
    docks: [...lorries.docks, ...service.map((s) => ({ ...s.dock, lorry: true }))], yardLines: [...lorries.lines, ...lots.lines],
  };
}

/**
 * The pavement: every road, building and yard makes paved ground, shaped
 * by the buildings' own rule (the terrain's corners, a diagonal as far out
 * as a straight edge) at full size, then its corners rounded as the
 * terrain's are. A street's pavement is its sidewalk. A diagonal street is
 * as wide as a straight one.
 */
export function pavement(town: Town): Polygon[] {
  // Paving drawn as a stand-in building: every road, paved tile and
  // building's plot, a house's too.
  const PAVING: Tile = { kind: "House", storeys: 1 };
  const paved = townOf(
    Array.from({ length: town.h }, (_, r) => Array.from({ length: town.w }, (_, c) => {
      const t = town.tile(c, r);
      return t.kind === "road" || t.kind === "paved" || isBuilt(t) ? PAVING : t;
    })),
    () => false,
  );
  return soften(footprints(paved, () => false, 0).flatMap((m) => m.polygons), 0.3);
}

/** How round the asphalt's corners are, in and out. */
const ROUND = 0.05;

/**
 * The asphalt: the roads as the game lays them, each tile's arms to the
 * tiles it is joined to and to the houses whose drives it leads to, and
 * what else is driven on that leads off them, ramps, as one surface, its corners rounded in and out,
 * so a drive reads as the road carried on. Through roads keep their own
 * colour, cut from it straight.
 */
/** A road tile's asphalt, its corners rounded in and out, in the tile's
 *  own frame, for the ways its arms go: the road's triangles as one
 *  outline, and each arm to a road of its own kind carried on over the
 *  seam, so the rounding leaves the run across it straight (the next
 *  tile's own road covers what it carries on over). The same
 *  arms are the same shape, so each is worked out once; the tiles are
 *  drawn one over another, never united: the union and the rounding are
 *  what cost, and done for a whole town at once they cost seconds. */
const shapes = new Map<string, Polygon[]>();
export function roadShape(ways: [number, number, boolean][]): Polygon[] {
  const key = ways.map(([dc, dr, on]) => `${dc}${dr}${on ? "+" : ""}`).sort().join(",");
  const known = shapes.get(key);
  if (known) return known;
  const arms: ArmInfo[] = ways.map(([dc, dr]) => {
    const a = Math.atan2(-dr, -dc);
    return { angle: a < 0 ? a + 2 * Math.PI : a, flow: "twoway" };
  });
  const geo = buildRoadGeometry(arms, HALF_W, 0);
  const tris: Polygon[] = [];
  if (geo) {
    // The geometry is the world's (x and y the other way); flat only.
    const p = geo.positions;
    const at = (i: number): Pt => [0.5 - p[3 * i], 0.5 - p[3 * i + 1]];
    for (let i = 0; i < geo.indices.length; i += 3) tris.push([[at(geo.indices[i]), at(geo.indices[i + 1]), at(geo.indices[i + 2])]]);
  }
  for (const [dc, dr] of ways.filter(([, , on]) => on)) {
    const len = Math.hypot(dc, dr);
    const [ux, uy, nx, ny] = [dc / len, dr / len, -dr / len * HALF_W, dc / len * HALF_W];
    // Across the seam (half way to the next tile's middle): from just
    // short of it, where this tile's own road already runs straight along
    // the arm, so on a bend it does not stand proud of the curve; to a
    // little more than the rounding past it, and no further, where it
    // would stand proud of the next tile's own corners where that one turns.
    const [a, b] = [len / 2 - 0.05, len / 2 + 0.1];
    tris.push([[[0.5 + ux * a + nx, 0.5 + uy * a + ny], [0.5 + ux * b + nx, 0.5 + uy * b + ny], [0.5 + ux * b - nx, 0.5 + uy * b - ny], [0.5 + ux * a - nx, 0.5 + uy * a - ny]]]);
  }
  // Grown a hair and drawn back, so no seam is left between triangles.
  const out = soften(shrink(shrink(tris, -1e-3), 1e-3), ROUND);
  shapes.set(key, out);
  return out;
}

/** The four sides, in the order a house looks for its street. */
const SIDES: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];

/** Which way a house's drive goes to its street (fx, fy), if it has one:
 *  a side with a street running straight past it, beside the house along
 *  its front. */
export function front(town: Town, c: number, r: number): [number, number] | undefined {
  if (town.tile(c, r).kind !== "House") return undefined;
  // The game's door where it says, beside its street: one on a
  // diagonal is no drive drawn yet.
  if (town.door) {
    const d = town.door(c, r);
    return d && SIDES.find(([fx, fy]) => fx === d[0] && fy === d[1]);
  }
  return SIDES.find(([fx, fy]) => {
    const [x, y] = [c + fx, r + fy];
    return town.tile(x, y).kind === "road" && !town.through(x, y) && (town.linked(x, y, x - fy, y + fx) || town.linked(x, y, x + fy, y - fx));
  });
}

/** A tile's asphalt: whether it is a through road, and the ways its arms
 *  go, each carried on into a tile of its own kind or not (`roadShape`).
 *  A road's arms are its links and the drives to the houses whose front
 *  it is; a house's, its drive back to the street, which ends under it.
 *  None for a tile with no asphalt. A function of the tile and those
 *  round it, so a tile is drawn on its own. */
export function waysAt(town: Town, c: number, r: number): { through: boolean; ways: [number, number, boolean][] } | null {
  const toward = front(town, c, r);
  if (toward) return { through: false, ways: [[toward[0], toward[1], true]] };
  if (town.tile(c, r).kind !== "road") return null;
  const through = town.through(c, r);
  const ways: [number, number, boolean][] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if ((dc || dr) && town.linked(c, r, c + dc, r + dr)) ways.push([dc, dr, town.through(c + dc, r + dr) === through]);
    }
  }
  for (const [dc, dr] of SIDES) {
    const back = front(town, c + dc, r + dr);
    if (back && back[0] === -dc && back[1] === -dr) ways.push([dc, dr, !through]);
  }
  return { through, ways };
}

/** The asphalt of a whole town, a piece a tile, the through roads apart. */
export function asphalt(town: Town): { street: Polygon[]; through: Polygon[] } {
  const street: Polygon[] = [], through: Polygon[] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const at = waysAt(town, c, r);
      if (!at) continue;
      for (const poly of roadShape(at.ways)) (at.through ? through : street).push(poly.map((ring) => ring.map(([x, y]): Pt => [c + x, r + y])));
    }
  }
  return { street, through };
}

/** A driveway: as wide as two cars side by side with a little room, the
 *  cars' middles a little either side of the house's (`LANE` in the
 *  server's `lots.rs`), and how far out from the house's middle they stand
 *  (`SPOT_OUT`): wholly before its front wall, short of the road. */
const DRIVE = 0.42;
const DRIVE_LANE = 0.11;
const DRIVE_OUT = 0.47;

/**
 * Driveways: a house with a street running straight past its front has a
 * drive straight in from the road to its front wall, a road like any
 * other (`asphalt` draws it as an arm of the street, curves and all), and
 * on it, as the game parks them, its household's two cars side by side,
 * nose to the house; one now and then, the other out. By house and the
 * way to its street, and the drive's ground, which no tree stands on.
 */
function driveways(town: Town): { strips: Pt[][]; cars: Car[]; mouths: Pt[]; arms: [number, number, number, number][] } {
  const strips: Pt[][] = [], cars: Car[] = [], mouths: Pt[] = [], arms: [number, number, number, number][] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const toward = front(town, c, r);
      if (!toward) continue;
      const [fx, fy] = toward;
      const [x0, y0] = [c + 0.5, r + 0.5];
      arms.push([c, r, fx, fy]);
      // From the front wall out across the pavement to the road's edge.
      strips.push(strip(x0, y0, -fy, fx, -DRIVE / 2, DRIVE / 2, fx, fy, 0.5 - INSET, 1 - HALF_W + 0.02));
      mouths.push([x0 + fx * (1 - KERB), y0 + fy * (1 - KERB)]);
      const one = hash(c, r, 41) < 0.25;
      for (const side of [-1, 1]) {
        if (one && side === (hash(c, r, 42) < 0.5 ? -1 : 1)) continue;
        cars.push({ x: x0 + fx * DRIVE_OUT - fy * DRIVE_LANE * side, y: y0 + fy * DRIVE_OUT + fx * DRIVE_LANE * side, angle: Math.atan2(-fy, -fx), colour: Math.floor(hash(c, r, 43 + side) * 8) });
      }
    }
  }
  return { strips, cars, mouths, arms };
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

/** Cars parked along the kerbs of streets before homes and shops. */
function park(town: Town, facts: Facts): Car[] {
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
          // The whole bay clear of the junction, not just its middle.
          if (t - len / n / 2 < clear0 || t + len / n / 2 > len - clear1) continue;
          for (const side of [-1, 1]) {
            const [nx, ny] = [-uy * side, ux * side];
            const [x, y] = [x0 + ux * t + nx * KERB, y0 + uy * t + ny * KERB];
            // Only before homes, shops and a supermarket's own front (not
            // its car park's), and a gap now and then.
            const [fc, fr] = [Math.floor(x + nx * 0.4), Math.floor(y + ny * 0.4)];
            const front = town.tile(fc, fr);
            if (!isBuilt(front) || facts.yard(fc, fr) || (formOf(front).family !== "street" && front.kind !== "Supermarket")) continue;
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
