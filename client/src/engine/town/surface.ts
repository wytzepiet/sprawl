import type { BuildingKind, GridCoord } from "../../generated";
import { BLUEPRINTS, FACINGS, kerbed, sideOf } from "../../blueprints";
import { isBuilt, townOf, type Tile, type Town } from "./grid";
import { isYard } from "./mass";
import { buildRoadGeometry, CAR, HALF_W, type ArmInfo } from "../objects/roadGeometry";
import { area, defaultJoins, footprints, INSET, shrink, soften, type Polygon, type Pt } from "./footprint";

/**
 * The town's ground is two surfaces. Pavement is the base: every road,
 * building and yard stands on paved ground. Asphalt is cut into it
 * wherever a vehicle goes, a kerb's step down: the roads, a house's
 * drive, a yard's gate and the yard itself, the trailer park and apron
 * of a harbour, and the bays at the kerb where the game parks. A vehicle
 * never stands on pavement.
 *
 * Which ground is asphalt is one rule, a tile at a time, from the tile
 * and its neighbours, as everything the look draws is (`surfaceAt`): a
 * tile's asphalt is its arms (a road's links, and the drives between a
 * street and the doors that open onto it) and its rectangles (a yard's
 * tile, a row of bays), as one outline, its corners rounded in and out.
 * Where a piece runs on into the next tile's, it is carried over the
 * seam, so the tiles' outlines meet as one; everywhere else its edge is
 * a kerb. The pavement is cut to it (`kerbLines.ts`), the road tiles are
 * drawn from it (`roads.ts`), so a road flows into a yard as one shape.
 */

/** An arm of a tile's asphalt: the way it goes, and whether it is
 *  carried on over the seam into the next tile's. */
export type Way = [number, number, boolean];

/** A rectangle of a tile's asphalt in the tile's own frame (0 to 1, its
 *  middle at a half), x0, y0, x1, y1; and the sides of it that run on
 *  into the next tile's, a bit each: x0, y0, x1, y1. */
export type Rect = [number, number, number, number, number];

export interface Surface {
  /** A through road's, drawn in its own colour over the streets. */
  through: boolean;
  ways: Way[];
  rects: Rect[];
}

/** How round the asphalt's corners are, in and out. */
const ROUND = 0.05;
/** How far a piece is carried on past the seam into the next tile's: a
 *  little more than the rounding, so the rounding leaves the run across
 *  it straight. */
const RUN = 0.1;
/** How far a yard reaches under its building's wall: past it, so its
 *  asphalt meets the wall, where the docks are. */
const UNDER = INSET + 0.02;
/** The strip of pavement left round a yard, a kerb and a little. */
const EDGE = 0.1;

const SIDES: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const EIGHT: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1]];

/** Which way a tile's drive goes to its street, if it has one: a house's
 *  door, or the gate of a yard, its door tile (`Town.door`, the
 *  server's). Any other building's door is a door, not a drive: its cars
 *  are at the kerb. */
export function drive(town: Town, c: number, r: number): [number, number] | undefined {
  const t = town.tile(c, r);
  return t.kind === "House" || isYard(t) ? town.door?.(c, r) : undefined;
}

/** A street tile the street runs straight through along (ux, uy): its
 *  two links that way and back, and no other (`runs_straight`). */
function straight(town: Town, c: number, r: number, ux: number, uy: number) {
  if (town.tile(c, r).kind !== "road" || town.through(c, r)) return false;
  const links = EIGHT.filter(([dc, dr]) => town.linked(c, r, c + dc, r + dr));
  return links.length === 2 && town.linked(c, r, c + ux, r + uy) && town.linked(c, r, c - ux, r - uy);
}

/** Kerb bays as the server lays them (`lots.rs`): along the kerb, a car's
 *  middle this far from its street's middle line and this far apart; nose
 *  in, this far out, its tail at the road's edge, and this far apart;
 *  within the building's walls. A bay's asphalt reaches past its car by
 *  `ROOM` all round, so a car stands wholly on it. */
const KERB = 0.305;
const ALONG_PITCH = 0.36;
const SQUARE = 0.37;
const SQUARE_PITCH = 0.2;
const ROOM = 0.02;

/** How many bays a side `len` tiles long holds, within its walls
 *  (`bays_along`). */
const baysAlong = (len: number, square: boolean) => Math.max(0, Math.floor((len - 2 * INSET) / (square ? SQUARE_PITCH : ALONG_PITCH) + 1e-9));

/** A car's bay at the kerb: where its middle is, which way it faces
 *  (radians from +x, y down), and the street tile it is before, the way
 *  to the building (`side`), and how far along that tile from its middle. */
export interface Bay {
  x: number;
  y: number;
  angle: number;
  square: boolean;
  road: [number, number];
  side: [number, number];
  a: number;
}

/**
 * A building's bays at the kerb, as the server lays them (`kerb_bays`):
 * as many as its long side holds, on the side its door opens onto first,
 * then on the sides with a street all along them, the fullest first, until
 * it has them; along each side evenly within its walls, each where the
 * street runs straight past: nose in, or along the kerb before flats.
 */
export function baysOf(town: Town, tiles: GridCoord[], kind: BuildingKind, door?: [number, number]): Bay[] {
  const square = kind !== "Apartment";
  const need = baysAlong(Math.max(...BLUEPRINTS[kind].size), square);
  const pitch = square ? SQUARE_PITCH : ALONG_PITCH;
  const street = (x: number, y: number) => town.tile(x, y).kind === "road" && !town.through(x, y);
  const sides = FACINGS.map(([dx, dy]) => {
    const run = sideOf(tiles, [dx, dy]);
    const [ux, uy] = [Math.abs(dy), Math.abs(dx)];
    const whole = run.every((t, i) => street(t.x + dx, t.y + dy) && (i === 0 || town.linked(run[i - 1].x + dx, run[i - 1].y + dy, t.x + dx, t.y + dy)));
    const n = baysAlong(run.length, square);
    const bays: Bay[] = [];
    for (let i = 0; i < n; i++) {
      const u = run.length / 2 + (i - (n - 1) / 2) * pitch;
      const k = Math.min(Math.floor(u), run.length - 1);
      const a = u - k - 0.5;
      const [c, r] = [run[k].x + dx, run[k].y + dy];
      if (!straight(town, c, r, ux, uy)) continue;
      if (!square) {
        const s = a >= 0 ? 1 : -1;
        if (!straight(town, c + s * ux, r + s * uy, ux, uy)) continue;
      }
      const out = square ? SQUARE : KERB;
      bays.push({
        x: c + 0.5 + ux * a - dx * out, y: r + 0.5 + uy * a - dy * out,
        angle: square ? Math.atan2(-dy, -dx) : Math.atan2(uy, ux),
        square, road: [c, r], side: [-dx, -dy], a,
      });
    }
    return { other: !door || door[0] !== dx || door[1] !== dy, broken: !whole, bays };
  });
  sides.sort((p, q) => +p.other - +q.other || +p.broken - +q.broken || q.bays.length - p.bays.length);
  const bays: Bay[] = [];
  for (const side of sides) {
    if (bays.length >= need) break;
    bays.push(...side.bays);
  }
  return bays;
}

/** The bays before a street tile: those of the buildings beside it that
 *  lie before it. Each building's worked out once a town. */
const known = new WeakMap<Town, Map<number, Bay[]>>();
export function baysAt(town: Town, c: number, r: number): Bay[] {
  const mine = known.get(town) ?? known.set(town, new Map()).get(town)!;
  const out: Bay[] = [];
  for (const [sx, sy] of SIDES) {
    const t = town.tile(c + sx, r + sy);
    if (!isBuilt(t) || !kerbed(t.kind as BuildingKind) || t.id === undefined) continue;
    let bays = mine.get(t.id);
    if (!bays) {
      // The building's tiles, and its door, wherever on it.
      const tiles: GridCoord[] = [{ x: c + sx, y: r + sy }];
      let door: [number, number] | undefined;
      for (let i = 0; i < tiles.length; i++) {
        door ??= town.door?.(tiles[i].x, tiles[i].y);
        for (const [dx, dy] of EIGHT) {
          const [x, y] = [tiles[i].x + dx, tiles[i].y + dy];
          const n = town.tile(x, y);
          if (n.id === t.id && n.kind === t.kind && !tiles.some((q) => q.x === x && q.y === y)) tiles.push({ x, y });
        }
      }
      bays = baysOf(town, tiles, t.kind as BuildingKind, door && (!door[0] || !door[1]) ? door : undefined);
      mine.set(t.id, bays);
    }
    out.push(...bays.filter((b) => b.road[0] === c && b.road[1] === r));
  }
  return out;
}

/** A street tile's bays on one side, as a rectangle from its middle out
 *  past the bays' far edge, along the tile as far as its bays go, run on
 *  into the next tile where the row goes on there. */
function bayRect(town: Town, c: number, r: number, bays: Bay[]): Rect {
  const { side: [sx, sy], square } = bays[0];
  const [ux, uy] = [Math.abs(sy), Math.abs(sx)];
  const half = (square ? CAR.w : CAR.l) / 2 + ROOM;
  const on = (s: number) => baysAt(town, c + s * ux, r + s * uy).some((b) => b.side[0] === sx && b.side[1] === sy);
  const lo = on(-1) ? -0.5 - RUN : Math.min(...bays.map((b) => b.a)) - half;
  const hi = on(1) ? 0.5 + RUN : Math.max(...bays.map((b) => b.a)) + half;
  const out = (square ? SQUARE + CAR.l / 2 : KERB + CAR.w / 2) + ROOM;
  // Out: from the middle toward the side.
  const [a0, a1] = [Math.min(0, sx * out, sy * out), Math.max(0, sx * out, sy * out)];
  const [x0, x1, y0, y1] = ux ? [0.5 + lo, 0.5 + hi, 0.5 + a0, 0.5 + a1] : [0.5 + a0, 0.5 + a1, 0.5 + lo, 0.5 + hi];
  // Bits x0, y0, x1, y1: along x the bits 0 and 2, along y 1 and 3.
  const bits = ux ? (on(-1) ? 1 : 0) | (on(1) ? 4 : 0) : (on(-1) ? 2 : 0) | (on(1) ? 8 : 0);
  return [x0, y0, x1, y1, bits];
}

/** A tile's asphalt (`Surface`), or none. */
export function surfaceAt(town: Town, c: number, r: number): Surface | null {
  const t = town.tile(c, r);
  const ways: Way[] = [];
  const rects: Rect[] = [];
  // A drive, from its door back to the street, carried over to it.
  const gate = drive(town, c, r);
  if (gate) ways.push([gate[0], gate[1], true]);
  if (isYard(t)) rects.push(yardRect(town, c, r));
  if (t.kind !== "road") return ways.length || rects.length ? { through: false, ways, rects } : null;
  const through = town.through(c, r);
  for (const [dc, dr] of EIGHT) {
    if (town.linked(c, r, c + dc, r + dr)) ways.push([dc, dr, town.through(c + dc, r + dr) === through]);
    // And out to the doors that open onto it.
    const back = drive(town, c + dc, r + dr);
    if (back && back[0] === -dc && back[1] === -dr) ways.push([dc, dr, !through]);
  }
  const bays = baysAt(town, c, r);
  for (const [sx, sy] of SIDES) {
    const mine = bays.filter((b) => b.side[0] === sx && b.side[1] === sy);
    if (mine.length) rects.push(bayRect(town, c, r, mine));
  }
  return { through, ways, rects };
}

/** A yard's tile, all asphalt, as the server's lot is, its lorries' lane
 *  running to its very ends: run on into the yard's tiles beside it, under
 *  its building's wall where it meets the building, and everywhere else
 *  short of the tile's edge by a kerb's strip of pavement: so before its
 *  street the sidewalk runs on between it and the road, its gate across
 *  it, and where it meets open ground or water its corners stay on the
 *  pavement's rounded ones. */
function yardRect(town: Town, c: number, r: number): Rect {
  const t = town.tile(c, r);
  // x0, y0, x1, y1: how far each side is out past the tile's edge, and
  // whether it runs on.
  const reach = [[-1, 0], [0, -1], [1, 0], [0, 1]].map(([dc, dr]): [number, boolean] => {
    const n = town.tile(c + dc, r + dr);
    if (isBuilt(n) && n.kind === t.kind && n.id === t.id) return isYard(n) ? [RUN, true] : [UNDER, true];
    return [-EDGE, false];
  });
  const on = reach.reduce((m, [, run], i) => m | (run ? 1 << i : 0), 0);
  return [-reach[0][0], -reach[1][0], 1 + reach[2][0], 1 + reach[3][0], on];
}

/** The key a surface's shape is known by: the same parts, the same shape. */
export function keyOf({ ways, rects }: Surface): string {
  const w = ways.map(([dc, dr, on]) => `${dc}${dr}${on ? "+" : ""}`).sort();
  const q = rects.map((rect) => `[${rect.map((v) => +v.toFixed(3)).join(",")}]`).sort();
  return [...w, ...q].join(",");
}

/**
 * A tile's asphalt as one outline, its corners rounded in and out, in the
 * tile's own frame: the road's triangles for its arms, each arm carried
 * on over the seam where it runs on (from just short of it, where the
 * tile's own road already runs straight along the arm, so on a bend it
 * does not stand proud of the curve, to a little more than the rounding
 * past it); and its rectangles. The same parts are the same shape, so each
 * is worked out once; the tiles are drawn one over another, never united:
 * the union and the rounding are what cost, and done for a whole town at
 * once they cost seconds.
 */
const shapes = new Map<string, Polygon[]>();
export function shapeOf(surface: Surface): Polygon[] {
  const key = keyOf(surface);
  const known = shapes.get(key);
  if (known) return known;
  const { ways, rects } = surface;
  const arms: ArmInfo[] = ways.map(([dc, dr]) => {
    const a = Math.atan2(-dr, -dc);
    return { angle: a < 0 ? a + 2 * Math.PI : a, flow: "twoway" };
  });
  const geo = buildRoadGeometry(arms, HALF_W, 0);
  const parts: Polygon[] = [];
  if (geo) {
    // The geometry is the world's (x and y the other way); flat only.
    const p = geo.positions;
    const at = (i: number): Pt => [0.5 - p[3 * i], 0.5 - p[3 * i + 1]];
    for (let i = 0; i < geo.indices.length; i += 3) parts.push([[at(geo.indices[i]), at(geo.indices[i + 1]), at(geo.indices[i + 2])]]);
  }
  for (const [dc, dr] of ways.filter(([, , on]) => on)) {
    const len = Math.hypot(dc, dr);
    const [ux, uy, nx, ny] = [dc / len, dr / len, -dr / len * HALF_W, dc / len * HALF_W];
    const [a, b] = [len / 2 - 0.05, len / 2 + RUN];
    parts.push([[[0.5 + ux * a + nx, 0.5 + uy * a + ny], [0.5 + ux * b + nx, 0.5 + uy * b + ny], [0.5 + ux * b - nx, 0.5 + uy * b - ny], [0.5 + ux * a - nx, 0.5 + uy * a - ny]]]);
  }
  for (const [x0, y0, x1, y1] of rects) parts.push([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]);
  // All wound one way, so none is taken for a hole in another; grown a
  // hair and drawn back, so no seam is left between them.
  const wound = parts.map(([ring]) => [area(ring) < 0 ? [...ring].reverse() : ring]);
  const out = soften(shrink(shrink(wound, -1e-3), 1e-3), ROUND);
  shapes.set(key, out);
  return out;
}

/** An edge of a tile's asphalt, as drawn for its instance (x and y the
 *  other way, its middle at -0.5, -0.5), that is wholly past the seam
 *  where it runs on into the next tile: the end of the overlap, which the
 *  next tile covers, so no kerb. An edge that only reaches past it keeps
 *  its kerb, and the two tiles' kerbs meet over the seam; where a bend
 *  bulges out past its square, between its arms, it keeps its kerb too. */
export const runsOn = ({ ways, rects }: Surface) => (a: number[], b: number[]) => {
  const arm = ways.some(([dc, dr, on]) => {
    if (!on) return false;
    const len = Math.hypot(dc, dr);
    const along = (p: number[]) => ((p[0] + 0.5) * -dc + (p[1] + 0.5) * -dr) / len;
    return Math.min(along(a), along(b)) > len / 2 - 0.01;
  });
  // Past a rectangle's side that runs on: beyond the tile's edge there.
  const past = (p: number[], side: number) => {
    const [x, y] = [-p[0], -p[1]];
    return [x < 0.01, y < 0.01, x > 0.99, y > 0.99][side];
  };
  return arm || rects.some((rect) => [0, 1, 2, 3].some((side) => rect[4] & (1 << side) && past(a, side) && past(b, side)));
};

/** The asphalt of a whole town, a piece a tile, the through roads apart. */
export function asphalt(town: Town): { street: Polygon[]; through: Polygon[] } {
  const street: Polygon[] = [], through: Polygon[] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const at = surfaceAt(town, c, r);
      if (!at) continue;
      for (const poly of shapeOf(at)) (at.through ? through : street).push(poly.map((ring) => ring.map(([x, y]): Pt => [c + x, r + y])));
    }
  }
  return { street, through };
}

/**
 * The pavement: every road, building and yard makes paved ground, shaped
 * by the buildings' own rule (the terrain's corners, a diagonal as far out
 * as a straight edge) at full size, then its corners rounded as the
 * terrain's are. A street's pavement is its sidewalk. A diagonal street is
 * as wide as a straight one. Joined on the diagonal only from road to
 * road, so a diagonal street is paved along, and a building's corner by a
 * street stays square. The asphalt is cut into it.
 */
/** How round the pavement's corners are: a little, a kerb's corner, not
 *  a shore's (2026-10-11, the mayor: tighter reads better). */
const PAVEMENT_ROUND = 0.12;
export function pavement(town: Town): Polygon[] {
  const PAVING: Tile = { kind: "Shop", storeys: 1 };
  const tiles = Array.from({ length: town.h }, (_, r) => Array.from({ length: town.w }, (_, c) => {
    const t = town.tile(c, r);
    return t.kind === "road" || t.kind === "paved" || isBuilt(t) ? PAVING : t;
  }));
  const kin = defaultJoins(townOf(tiles, () => false));
  const road = (c: number, r: number) => town.tile(c, r).kind === "road";
  const paved = townOf(tiles, () => false, [], (c, r, x, y) => (x === c || y === r || road(c, r) === road(x, y)) && kin(c, r, x, y));
  return soften(footprints(paved, 0).flatMap((m) => m.polygons), PAVEMENT_ROUND);
}
