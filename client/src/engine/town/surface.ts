import type { BuildingKind, GridCoord } from "../../generated";
import { BLUEPRINTS, FACINGS, kerbed, sideOf } from "../../blueprints";
import { isBuilt, townOf, type Flow, type RoadView, type Tile, type Town } from "./grid";
import { isYard } from "./mass";
import { buildRoadGeometry, CAR, HALF_W, type ArmInfo } from "../objects/roadGeometry";
import { area, defaultJoins, ease, footprints, INSET, intersect, shrink, soften, unite, type Polygon, type Pt } from "./footprint";

/**
 * The town's ground is two surfaces. Pavement is the base: every road,
 * building and yard stands on paved ground. Asphalt is cut into it
 * wherever a vehicle goes, a kerb's step down: the roads, a house's
 * drive, a yard's gate and the yard itself, the trailer park and apron
 * of a harbour, and the bays at the kerb where the game parks. A vehicle
 * never stands on pavement.
 *
 * Which ground is asphalt is one rule, a tile at a time, from the tile
 * and its neighbours, as everything the look draws is (`surfacesAt`): a
 * tile's asphalt is its arms (a road's links, and the drives between a
 * street and the doors that open onto it) and its rectangles (a yard's
 * tile, a row of bays), as one outline, its corners rounded in and out.
 * Where a piece runs on into the next tile's, it is carried over the
 * seam, so the tiles' outlines meet as one; everywhere else its edge is
 * a kerb. The pavement is cut to it (`kerbLines.ts`), the road tiles are
 * drawn from it (`roads.ts`), so a road flows into a yard as one shape.
 */

/** An arm of a tile's asphalt: the way it goes, whether it is carried on
 *  over the seam into the next tile's, which way it is driven (`Flow`, or
 *  `d` a drive, which is painted nothing), and how far the road it runs to
 *  stands moved from its tile's middle (`RoadView`). */
export type Way = [number, number, boolean, (Flow | "d")?, Pt?];

/** A rectangle of a tile's asphalt in the tile's own frame (0 to 1, its
 *  middle at a half), x0, y0, x1, y1; and the sides of it that run on
 *  into the next tile's, a bit each: x0, y0, x1, y1. */
export type Rect = [number, number, number, number, number];

export interface Surface {
  /** A through road's, drawn in its own colour over the streets. */
  through: boolean;
  /** A junction with traffic lights: a stop line across each way in. */
  light?: boolean;
  ways: Way[];
  rects: Rect[];
  /** How far the road stands moved from the tile's middle: one of two
   *  sharing it side by side. */
  shift?: Pt;
  /** How high it stands, in half-levels (`RoadNode::height`); and, a
   *  slope, the way to the arm it climbs to, and its run of slopes: which
   *  of them it is from the low end, how many, and the heights the run
   *  climbs from and to (`decks.ts`). */
  height?: number;
  climb?: Pt;
  run?: [number, number, number, number];
  /** The turns not drawn through it, from one arm's way to another's,
   *  `"dc,dr>dc,dr"`: no lane is laid for them. */
  banned?: string[];
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
const ALONG_PITCH = 0.42;
const SQUARE = 0.37;
const SQUARE_PITCH = 0.27;
const ROOM = 0.02;

/** How far in from a side's ends its bays keep (`WALL_INSET`). */
const BAY_INSET = 0.2;

/** How many bays a side `len` tiles long holds (`bays_along`). */
const baysAlong = (len: number, square: boolean) => Math.max(0, Math.floor((len - 2 * BAY_INSET) / (square ? SQUARE_PITCH : ALONG_PITCH) + 1e-9));

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

/** A tile's asphalt (`Surface`): a surface for each road on it, the
 *  middle's with the drives and bays; none, where it has none. */
export function surfacesAt(town: Town, c: number, r: number): Surface[] {
  const t = town.tile(c, r);
  const ways: Way[] = [];
  const rects: Rect[] = [];
  // A drive, from its door back to the street, carried over to it.
  const gate = drive(town, c, r);
  if (gate) ways.push([gate[0], gate[1], true, "d"]);
  if (isYard(t)) rects.push(yardRect(town, c, r));
  if (t.kind !== "road") return ways.length || rects.length ? [{ through: false, ways, rects }] : [];
  const views: RoadView[] = town.roadsOn?.(c, r) ?? [
    {
      shift: [0, 0],
      through: town.through(c, r),
      light: !!town.light?.(c, r),
      arms: EIGHT.filter(([dc, dr]) => town.linked(c, r, c + dc, r + dr)).map(([dc, dr]) => ({ dc, dr, flow: town.flow?.(c, r, c + dc, r + dr) ?? "t", shift: [0, 0], through: town.through(c + dc, r + dr) })),
    },
  ];
  return views.map(({ shift, through, light, arms, height = 0, climb, run, banned }) => {
    const own: Way[] = arms.map(({ dc, dr, flow, shift: there, through: on }) => [dc, dr, on === through, flow, there]);
    const turns = banned?.length ? { banned } : {};
    if (shift[0] || shift[1] || height) return { through, light, ways: own, rects: [], shift, height, climb, run, ...turns };
    // The middle's: out to the doors that open onto it, and its bays.
    for (const [dc, dr] of EIGHT) {
      const back = drive(town, c + dc, r + dr);
      if (back && back[0] === -dc && back[1] === -dr) own.push([dc, dr, !through, "d"]);
    }
    const bays = baysAt(town, c, r);
    for (const [sx, sy] of SIDES) {
      const mine = bays.filter((b) => b.side[0] === sx && b.side[1] === sy);
      if (mine.length) rects.push(bayRect(town, c, r, mine));
    }
    return { through, light, ways: own, rects, ...turns };
  });
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
export function keyOf({ through, ways, rects, light, shift, banned = [] }: Surface): string {
  const at = (p?: Pt) => (p && (p[0] || p[1]) ? `@${p.map((v) => +v.toFixed(3)).join(";")}` : "");
  const w = ways.map(([dc, dr, on, flow, there]) => `${dc}${dr}${on ? "+" : ""}${flow ?? ""}${at(there)}`).sort();
  const q = rects.map((rect) => `[${rect.map((v) => +v.toFixed(3)).join(",")}]`).sort();
  return [...w, ...q, ...[...banned].sort().map((b) => `!${b}`), light ? "L" : "", through ? "T" : "", at(shift)].join(",");
}

/** Where a surface's road stands in its tile: the middle, moved by its
 *  shift. */
const pointOf = ({ shift }: Surface): Pt => [0.5 + (shift?.[0] ?? 0), 0.5 + (shift?.[1] ?? 0)];

/** Where an arm's road crosses its seam: halfway between the road and the
 *  one it runs to, each where it stands; and the way it goes there. */
function seamOf(p: Pt, [dc, dr, , , there]: Way): { at: Pt; u: Pt; len: number } {
  const n: Pt = [0.5 + dc + (there?.[0] ?? 0), 0.5 + dr + (there?.[1] ?? 0)];
  const len = Math.hypot(n[0] - p[0], n[1] - p[1]) || 1;
  return { at: [(p[0] + n[0]) / 2, (p[1] + n[1]) / 2], u: [(n[0] - p[0]) / len, (n[1] - p[1]) / len], len };
}

/** How wide a road is either side of its middle, by how it is driven: a
 *  lane one way is thin; two of them side by side on a tile stand
 *  `SIDE_OFFSET` from its middle (`tiles.ts`), grass between them. */
const THIN = 0.13;
const halfOf = (flow?: Flow | "d") => (flow === "o" || flow === "i" ? THIN : HALF_W);

/** A road through a tile from one arm to another as a car drives it
 *  (`bezier.rs`): from the one seam to the other, a curve pulled toward
 *  where the road stands, `p`, run on past a seam where the road runs on.
 *  Sampled: each point, how wide the road is there either side, and how
 *  far along. `seams` are how far along each seam is. */
interface Path {
  pts: Pt[];
  half: number[];
  at: number[];
  seams: [number, number];
}
const CURVE = 16;
const smooth = (t: number) => t * t * (3 - 2 * t);
function pathOf(p: Pt, a: Way, b: Way, carried = true): Path {
  const [sa, sb] = [seamOf(p, a), seamOf(p, b)];
  const [ha, hb] = [halfOf(a[3]), halfOf(b[3])];
  const pts: Pt[] = [], half: number[] = [];
  const push = (q: Pt, h: number) => (pts.push(q), half.push(h));
  const [aOn, bOn] = [carried && a[2], carried && b[2]];
  if (aOn) push([sa.at[0] + sa.u[0] * RUN, sa.at[1] + sa.u[1] * RUN], ha);
  for (let k = 0; k <= CURVE; k++) {
    const t = k / CURVE;
    const [u, v, w] = [(1 - t) * (1 - t), 2 * t * (1 - t), t * t];
    push([u * sa.at[0] + v * p[0] + w * sb.at[0], u * sa.at[1] + v * p[1] + w * sb.at[1]], ha + (hb - ha) * smooth(t));
  }
  if (bOn) push([sb.at[0] + sb.u[0] * RUN, sb.at[1] + sb.u[1] * RUN], hb);
  const at = [0];
  for (let k = 1; k < pts.length; k++) at.push(at[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const first = aOn ? 1 : 0;
  return { pts, half, at, seams: [at[first], at[first + CURVE]] };
}

/** The way a path runs at point k, and its left (`(-uy, ux)`). */
function wayAt({ pts }: Path, k: number): [number, number] {
  const [p, q] = [pts[Math.max(0, k - 1)], pts[Math.min(pts.length - 1, k + 1)]];
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  return [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
}

/** Where a point is from a path: how far from it, to its left (negative
 *  to its right), how far along, and how wide the road is there. */
function near(path: Path, x: number, y: number): { side: number; along: number; half: number; d: number } {
  let best = { side: 0, along: 0, half: 0, d: Infinity };
  for (let k = 0; k + 1 < path.pts.length; k++) {
    const [a, b] = [path.pts[k], path.pts[k + 1]];
    const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
    const len2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / len2));
    const [px, py] = [a[0] + ex * t, a[1] + ey * t];
    const d = Math.hypot(x - px, y - py);
    if (d < best.d) {
      const len = Math.sqrt(len2);
      const side = ((x - a[0]) * -ey + (y - a[1]) * ex) / len;
      best = { side, along: path.at[k] + (path.at[k + 1] - path.at[k]) * t, half: path.half[k] + (path.half[k + 1] - path.half[k]) * t, d };
    }
  }
  return best;
}

/** A tile's arms as its asphalt is laid: one runs on over the seam into
 *  the next tile where that is the same kind of road, and every one of a
 *  priority road's does, drawn as it is over whatever meets it. */
const carried = ({ through, ways }: Surface): Way[] => ways.map(([dc, dr, on, flow, there]) => [dc, dr, on || (through && flow !== "d"), flow, there]);

/** The road arms of a tile, drives left out. */
const roadsOf = (ways: Way[]) => ways.filter(([, , , flow]) => flow !== "d");

/** The lanes of an arm a car comes in by (`into`) or goes out by, each
 *  as where it runs from its way's middle, to the right of the way it is
 *  driven (`bezier.rs`'s (-dy, dx)), and its half-width: a two-way's one
 *  each way, to the right; a one-way's one, down the middle, its whole
 *  road; a road of two's two. */
type Lane = [number, number];
const LANE = HALF_W / 2;
function lanesOf(flow: Flow | "d" | undefined, into: boolean): Lane[] {
  switch (flow ?? "t") {
    case "t":
      return [[LANE, LANE]];
    case "o":
      return into ? [] : [[0, THIN]];
    case "i":
      return into ? [[0, THIN]] : [];
    case "O":
      return into ? [] : [[LANE, LANE], [-LANE, LANE]];
    case "I":
      return into ? [[LANE, LANE], [-LANE, LANE]] : [];
    default:
      return [];
  }
}

/** A lane along a path, `lane(t)` (where it runs and how wide) a share t
 *  of the way. */
function strip(path: Path, lane: (t: number) => Lane): Polygon {
  const n = path.pts.length;
  const left: Pt[] = [], right: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const [ux, uy] = wayAt(path, k);
    const [x, y] = path.pts[k];
    const [o, h] = lane(n > 1 ? k / (n - 1) : 0);
    left.push([x - uy * (o - h), y + ux * (o - h)]);
    right.push([x - uy * (o + h), y + ux * (o + h)]);
  }
  const ring = [...left, ...right.reverse()];
  return [area(ring) < 0 ? ring.reverse() : ring];
}

/** The ways through a junction its cars may go, each from the arm it
 *  comes in by to the one it goes out by, and its path: every turn its
 *  lanes allow, but those not drawn (`Surface::banned`) and those sharper
 *  than a right angle, which no car makes (`pathfinding::may_turn`). */
function movesOf(surface: Surface, p: Pt, roads: Way[]): [Way, Way, Path][] {
  const banned = new Set(surface.banned);
  const sharp = (a: Way, b: Way) => a[0] * b[0] + a[1] * b[1] > 0;
  return roads.flatMap((a) => roads.flatMap((b): [Way, Way, Path][] =>
    a === b || sharp(a, b) || banned.has(`${a[0]},${a[1]}>${b[0]},${b[1]}`) || !lanesOf(a[3], true).length || !lanesOf(b[3], false).length ? [] : [[a, b, pathOf(p, a, b, false)]],
  ));
}

/** Each lane through a tile, from the lane it comes in by (`l`) to the one
 *  it goes out by (`m`), along its own curve (`laneOf`), its half-width
 *  going from the one's to the other's. */
function lanesThrough(surface: Surface, p: Pt, roads: Way[]): { a: Way; b: Way; l: Lane; m: Lane; i: number; j: number; path: Path }[] {
  return movesOf(surface, p, roads).flatMap(([a, b]) =>
    lanesOf(a[3], true).flatMap((l, i) => lanesOf(b[3], false).map((m, j) => ({ a, b, l, m, i, j, path: laneOf(p, a, l, b, m) }))),
  );
}

/** A lane's curve across a tile, as a car keeps to it: from where it
 *  crosses the one seam to where it crosses the other, each beside its
 *  road's middle by the lane's offset, pulled toward where the two lanes'
 *  ways meet; straight on, or nearly, straight. Its half-width goes from
 *  the one lane's to the other's. */
function laneOf(p: Pt, a: Way, l: Lane, b: Way, m: Lane): Path {
  const [sa, sb] = [seamOf(p, a), seamOf(p, b)];
  // Driven in by a, against its way out; out by b, along it.
  const [ia, ob]: Pt[] = [[-sa.u[0], -sa.u[1]], sb.u];
  const A: Pt = [sa.at[0] - ia[1] * l[0], sa.at[1] + ia[0] * l[0]];
  const B: Pt = [sb.at[0] - ob[1] * m[0], sb.at[1] + ob[0] * m[0]];
  const cross = ia[0] * ob[1] - ia[1] * ob[0];
  const s = Math.abs(cross) < 0.2 ? NaN : ((B[0] - A[0]) * ob[1] - (B[1] - A[1]) * ob[0]) / cross;
  const C: Pt = Number.isFinite(s) && s > 0 ? [A[0] + ia[0] * s, A[1] + ia[1] * s] : [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  const pts: Pt[] = [], half: number[] = [];
  for (let k = 0; k <= CURVE; k++) {
    const t = k / CURVE;
    const [u, v, w] = [(1 - t) * (1 - t), 2 * t * (1 - t), t * t];
    pts.push([u * A[0] + v * C[0] + w * B[0], u * A[1] + v * C[1] + w * B[1]]);
    half.push(l[1] + (m[1] - l[1]) * smooth(t));
  }
  const at = [0];
  for (let k = 1; k < pts.length; k++) at.push(at[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  return { pts, half, at, seams: [0, at[CURVE]] };
}

/** A tile's road from one arm to another with no other: its one path. */
const runOf = (p: Pt, roads: Way[]): Path | null => (roads.length === 2 ? pathOf(p, roads[0], roads[1]) : null);

/**
 * A tile's asphalt as one outline, its corners rounded in and out, in the
 * tile's own frame. A road that runs through, from one arm to another, is
 * a band along the curve a car drives (`pathOf`), as wide at each end as
 * the road it meets there is, and between them going from the one width
 * to the other. A junction is its
 * arms, each as wide as its road, with the curves turning between them
 * filled in; a dead end, its arm, rounded off. An arm is carried on over
 * the seam where it runs on, so the tiles' outlines meet as one; and the
 * rectangles. The same parts are the same shape, so each is worked out
 * once; the tiles are drawn one over another, never united: the union
 * and the rounding are what cost, and done for a whole town at once they
 * cost seconds.
 */
const shapes = new Map<string, Polygon[]>();
export function shapeOf(surface: Surface): Polygon[] {
  const key = keyOf(surface);
  const known = shapes.get(key);
  if (known) return known;
  const { ways, rects } = surface;
  const p = pointOf(surface);
  const roads = roadsOf(carried(surface));
  const run = runOf(p, roads);
  const parts: Polygon[] = [];
  // An arm from where the road stands out over its seam.
  const arm = (w: Way, from: number, past: number) => {
    const { u: [ux, uy], len } = seamOf(p, w);
    const hw = halfOf(w[3]);
    const [nx, ny] = [-uy * hw, ux * hw];
    const [a, b] = [from, len / 2 + past];
    const ring: Pt[] = [[p[0] + ux * a + nx, p[1] + uy * a + ny], [p[0] + ux * b + nx, p[1] + uy * b + ny], [p[0] + ux * b - nx, p[1] + uy * b - ny], [p[0] + ux * a - nx, p[1] + uy * a - ny]];
    parts.push([area(ring) < 0 ? ring.reverse() : ring]);
  };
  if (roads.length >= 2) {
    // Each lane a car drives through, from the way it comes in by to the
    // way it goes out by, along its curve; a lane nothing drives through,
    // its own way to where the road stands, and no further.
    const used = new Set<string>();
    for (const { a, b, i, j, path } of lanesThrough(surface, p, roads)) {
      used.add(`${roads.indexOf(a)}i${i}`).add(`${roads.indexOf(b)}o${j}`);
      parts.push(strip(path, (t) => [0, path.half[Math.round(t * (path.half.length - 1))]]));
    }
    for (const [k, w] of roads.entries()) {
      const { at } = seamOf(p, w);
      for (const into of [true, false]) {
        for (const [i, l] of lanesOf(w[3], into).entries()) {
          if (used.has(`${k}${into ? "i" : "o"}${i}`)) continue;
          const pts: Pt[] = into ? [at, p] : [p, at];
          parts.push(strip({ pts, half: [], at: [0, 1], seams: [0, 1] }, () => l));
        }
      }
    }
    for (const w of carried(surface).filter(([, , on]) => on)) arm(w, seamOf(p, w).len / 2 - 0.05, RUN);
    for (const d of ways.filter(([, , , flow]) => flow === "d")) arm(d, -HALF_W, d[2] ? RUN : 0);
  } else {
    const geoArms: ArmInfo[] = ways.map((w) => {
      const { u } = seamOf(p, w);
      const a = Math.atan2(-u[1], -u[0]);
      return { angle: a < 0 ? a + 2 * Math.PI : a, flow: "twoway", hw: halfOf(w[3]) };
    });
    const geo = buildRoadGeometry(geoArms, HALF_W, 0);
    if (geo) {
      // The geometry is the world's (x and y the other way); flat only.
      const g = geo.positions;
      const at = (i: number): Pt => [p[0] - g[3 * i], p[1] - g[3 * i + 1]];
      for (let i = 0; i < geo.indices.length; i += 3) parts.push([[at(geo.indices[i]), at(geo.indices[i + 1]), at(geo.indices[i + 2])]]);
    }
    for (const w of carried(surface).filter(([, , on]) => on)) arm(w, seamOf(p, w).len / 2 - 0.05, RUN);
  }
  for (const [x0, y0, x1, y1] of rects) parts.push([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]);
  // All wound one way, so none is taken for a hole in another; grown a
  // hair and drawn back, so no seam is left between them.
  const wound = parts.map(([ring]) => [area(ring) < 0 ? [...ring].reverse() : ring]);
  // Its outward corners rounded, not its inward ones: between two arms
  // the asphalt is where cars turn, a turning lane's curve, and where none
  // may, the corner is square, a kerb's, and plainly no way through.
  const out = ease(shrink(shrink(wound, -1e-3), 1e-3), ROUND);
  shapes.set(key, out);
  return out;
}

/** Road paint: its lines this wide; a dash and the gap after it this
 *  long, the dashes centred on the seams so they run on from tile to
 *  tile; a two-way's line stopped this far short of a junction's middle. */
const LINE = 0.028;
const DASH = 0.26;
const CLEAR = 0.32;
/** A priority road's edge lines: this far in from its edge, this wide;
 *  across a side road's mouth, in blocks this long. */
const EDGE_IN = 0.06;
const EDGE_LINE = 0.03;
const BLOCK = 0.07;

/** A dash's distance in, `s` along from a seam: dashes centred on seams. */
const dashed = (s: number, dash: number) => dash / 2 - Math.abs((((s + dash) % (2 * dash)) + 2 * dash) % (2 * dash) - dash);

/**
 * A tile's paint, as a distance in its own frame: how far inside a line
 * a point is, negative outside. Along a road that runs through, the
 * paint follows the curve its cars drive: a two-way's dashed middle, and
 * the line between a road of two's lanes; which way a one-way runs is
 * not painted (`interchange/flow.ts` shows it while building). At a junction, a two-way's middle is dashed
 * along each arm from short of the middle; at lights, a stop line across
 * each way in. A priority road has a solid line along each edge, carried
 * on through its junctions, in blocks across a side road's mouth; the
 * side road's way in, shark's teeth. Drives are painted nothing.
 */
export function paintOf(surface: Surface): (x: number, y: number) => number {
  const { through, ways, light } = surface;
  const p = pointOf(surface);
  const roads = roadsOf(ways);
  const marks: ((x: number, y: number) => number)[] = [];
  const junction = roads.length >= 3;
  const run = runOf(p, roads);
  if (run) {
    const [a, b] = roads;
    const mid = (run.seams[0] + run.seams[1]) / 2;
    const flowAt = (along: number) => (along < mid ? a[3] : b[3]);
    const fromSeam = (along: number) => (along < mid ? along - run.seams[0] : run.seams[1] - along);
    // A two-way's middle, and the line between a road of two's lanes.
    if ([a, b].some(([, , , f]) => ["t", "O", "I"].includes(f ?? "t"))) {
      marks.push((x, y) => {
        const n = near(run, x, y);
        if (!["t", "O", "I"].includes(flowAt(n.along) ?? "t")) return -1;
        return Math.min(LINE / 2 - Math.abs(n.side), dashed(fromSeam(n.along), DASH));
      });
    }
    // A priority road's edges, where it runs on as one.
    if (through && (a[2] || b[2])) {
      marks.push((x, y) => {
        const n = near(run, x, y);
        if (!(n.along < mid ? a[2] : b[2])) return -1;
        return EDGE_LINE / 2 - Math.abs(Math.abs(n.side) - (n.half - EDGE_IN));
      });
    }
  }
  // At lights, a stop line across each way in.
  if (light && junction) {
    for (const [dc, dr, , flow] of roads) {
      if (flow === "o") continue;
      const len = Math.hypot(dc, dr);
      const [ux, uy] = [dc / len, dr / len];
      const hw = halfOf(flow);
      const [lo, hi] = flow === "i" ? [-hw, hw] : [0, hw];
      marks.push((x, y) => {
        const [px, py] = [x - p[0], y - p[1]];
        const along = px * ux + py * uy - CLEAR;
        const across = px * uy - py * ux;
        return Math.min(along, STOP - along, (hi - lo) / 2 - 0.02 - Math.abs(across - (lo + hi) / 2));
      });
    }
  }
  if (through && junction) {
    // The priority road through the junction: its edges carried on, in
    // blocks on the side a road joins it from.
    const main = roads.filter(([, , on]) => on);
    if (main.length === 2) {
      const path = pathOf(p, main[0], main[1], false);
      const k = path.pts.length >> 1;
      const [ux, uy] = wayAt(path, k);
      const [cx, cy] = path.pts[k];
      const joined = [1, -1].map((s) => roads.some(([dc, dr, on]) => !on && ((p[0] + dc / 2 - cx) * -uy + (p[1] + dr / 2 - cy) * ux) * s > 0));
      marks.push((x, y) => {
        const n = near(path, x, y);
        const s = n.side >= 0 ? 0 : 1;
        const line = EDGE_LINE / 2 - Math.abs(Math.abs(n.side) - (n.half - EDGE_IN));
        return joined[s] ? Math.min(line, dashed(n.along, BLOCK)) : line;
      });
    }
    // Where a street meets a priority road, shark's teeth across the
    // street's way in: a row of triangles pointing at whoever must give way.
    if (!light) {
      for (const [dc, dr, on, flow] of roads) {
        if (on || flow === "o") continue;
        const len = Math.hypot(dc, dr);
        const [ux, uy] = [dc / len, dr / len];
        // Across the way in: the whole of a one-way, the right half of a
        // two-way as its traffic comes in (`bezier.rs`'s side, of -u).
        const hw = halfOf(flow);
        const [lo, hi] = flow === "i" ? [-hw, hw] : [0, hw];
        const n = Math.max(1, Math.floor((hi - lo) / TOOTH[0]));
        const base = (hi - lo) / n;
        for (let k = 0; k < n; k++) {
          const [t0, t1] = [lo + k * base + base * 0.12, lo + (k + 1) * base - base * 0.12];
          marks.push((x, y) => {
            const [px, py] = [x - p[0], y - p[1]];
            const along = px * ux + py * uy - CLEAR;
            const across = px * uy - py * ux;
            // Its base at CLEAR, its point out along the arm.
            const t = (across - t0) / (t1 - t0);
            const reach = TOOTH[1] * (1 - Math.abs(2 * t - 1));
            return Math.min(along, reach - along, (t1 - t0) / 2 - Math.abs(across - (t0 + t1) / 2));
          });
        }
      }
    }
  }
  // At a junction, a two-way's middle, and the line between a road of
  // two's lanes, along each arm from short of the middle.
  if (junction) {
    for (const [dc, dr, , flow] of roads) {
      if (!["t", "O", "I"].includes(flow ?? "t")) continue;
      const len = Math.hypot(dc, dr);
      const [ux, uy] = [dc / len, dr / len];
      marks.push((x, y) => {
        const [px, py] = [x - p[0], y - p[1]];
        const s = px * ux + py * uy;
        const across = Math.abs(px * uy - py * ux);
        return Math.min(LINE / 2 - across, dashed(len / 2 - s, DASH), s - CLEAR, len / 2 + RUN - s);
      });
    }
  }
  return (x, y) => marks.reduce((best, m) => Math.max(best, m(x, y)), -1);
}

/**
 * Where a tile's road is worn, from nothing to one: two tracks down each
 * lane, where its cars' wheels run, along the curve they drive
 * (`laneOf`). Through a junction, only the ways its cars may go are
 * worn, so its turns are seen without a line of paint.
 */
export function wearOf(surface: Surface): (x: number, y: number) => number {
  const p = pointOf(surface);
  const roads = roadsOf(surface.ways);
  const tracks: ((x: number, y: number) => number)[] = [];
  for (const { path } of roads.length >= 2 ? lanesThrough(surface, p, roads) : []) {
    tracks.push((x, y) => {
      const n = near(path, x, y);
      const d = Math.min(Math.abs(n.side - WHEELS), Math.abs(n.side + WHEELS));
      return Math.exp(-((d / TRACK) ** 2));
    });
  }
  return (x, y) => tracks.reduce((most, t) => Math.max(most, t(x, y)), 0);
}

/** A car's wheels, this far either side of its lane's middle; the track
 *  each wears, about this wide. */
const WHEELS = 0.045;
const TRACK = 0.05;

/** A stop line's width along its way. */
const STOP = 0.05;
/** A give-way tooth: its base across, and how far it reaches along. */
const TOOTH: [number, number] = [0.105, 0.13];


/** An edge of a tile's asphalt, as drawn for its instance (x and y the
 *  other way, its middle at -0.5, -0.5), that is wholly past the seam
 *  where it runs on into the next tile: the end of the overlap, which the
 *  next tile covers, so no kerb. An edge that only reaches past it keeps
 *  its kerb, and the two tiles' kerbs meet over the seam; where a bend
 *  bulges out past its square, between its arms, it keeps its kerb too. */
export const runsOn = (surface: Surface) => (a: number[], b: number[]) => {
  const { rects } = surface;
  const arm = carried(surface).some(([dc, dr, on]) => {
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
      for (const at of surfacesAt(town, c, r)) for (const poly of shapeOf(at)) (at.through ? through : street).push(poly.map((ring) => ring.map(([x, y]): Pt => [c + x, r + y])));
    }
  }
  return { street, through };
}

/** How round the pavement's corners are: a little, a kerb's corner, not
 *  a shore's (2026-10-11, the mayor: tighter reads better). */
const PAVEMENT_ROUND = 0.12;
/** Grass shut in by pavement smaller than this, in tiles, is paved: the
 *  scraps between diagonal streets side by side, not a block's middle. */
const SCRAP = 0.5;

/** A sidewalk's width, out from the asphalt's edge. */
export const SIDEWALK = 0.15;
/** A kerb's width out from the asphalt's edge, where nobody walks: round a
 *  junction out of town. */
export const VERGE_KERB = 0.05;

/**
 * The pavement: along every road its asphalt grown out by its sidewalk
 * (`Town.sidewalk`), whatever the road's shape: in town a sidewalk, out
 * of it a kerb round a junction, else nothing; and
 * every building and yard's ground: its tiles, square; by the water, the
 * buildings' own rule (the terrain's corners, a diagonal as far out as a
 * straight edge) at full size, so a quay keeps to the shore. Where a
 * building stands beside a road, the ground between them is paved too,
 * straight from its front to the kerb, so a shop is paved to its kerb and
 * a town centre shop to shop; elsewhere the sidewalk is a border, the grass
 * behind it. Its corners are rounded a little, and grass left shut in,
 * too small to be anything, is paved. The asphalt is cut into it.
 */
export function pavement(town: Town): Polygon[] {
  const PAVING: Tile = { kind: "Shop", storeys: 1 };
  const tiles = Array.from({ length: town.h }, (_, r) => Array.from({ length: town.w }, (_, c) => {
    const t = town.tile(c, r);
    return t.kind === "paved" || isBuilt(t) ? PAVING : t;
  }));
  const plain = townOf(tiles, () => false);
  const kin = defaultJoins(plain);
  const on = (c: number, r: number) => plain.tile(c, r) === PAVING;
  // A tile's ground a square; by the water, the buildings' own rule, the
  // terrain's corners, so a quay keeps to the shore the terrain draws.
  const wet = (c: number, r: number) => [-1, 0, 1].some((dr) => [-1, 0, 1].some((dc) => town.tile(c + dc, r + dr).kind === "water"));
  const squares: Polygon[] = [], shore: Polygon[] = [];
  for (let r = 0; r < town.h; r++) for (let c = 0; c < town.w; c++) if (on(c, r)) (wet(c, r) ? shore : squares).push([[[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]]]);
  const paved = townOf(tiles, () => false, [], (c, r, x, y) => (x === c || y === r || (!on(x, r) && !on(c, y))) && kin(c, r, x, y));
  const quay = shore.length ? intersect(footprints(paved, 0).flatMap((m) => m.polygons), unite(shore)) : [];
  const ground = unite([...squares, ...quay]);
  const width = (c: number, r: number) => (town.tile(c, r).kind === "road" ? (town.sidewalk?.(c, r) ?? SIDEWALK) : 0);
  const roads = new Map<number, Polygon[]>();
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const w = width(c, r);
      if (!w) continue;
      const by = roads.get(w) ?? roads.set(w, []).get(w)!;
      for (const at of surfacesAt(town, c, r)) for (const poly of shapeOf(at)) by.push(poly.map((ring) => ring.map(([x, y]): Pt => [c + x, r + y])));
    }
  }
  const border = unite([...roads].flatMap(([w, ps]) => shrink(unite(ps), -w)));
  // From a building's tile to the road beside it: the half of the road's
  // tile toward it, straight from its front to the road's middle, or of
  // one only on its corner, the quarter toward it. The asphalt is cut out.
  const street = (c: number, r: number) => width(c, r) > 0;
  const between: Polygon[] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (!on(c, r)) continue;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const [x, y] = [c + dc, r + dr];
        // On its corner only where the road does not run past its side.
        if (!street(x, y) || (dc && dr && (street(x, r) || street(c, y)))) continue;
        const [x0, x1] = dc > 0 ? [x, x + 0.5] : dc < 0 ? [x + 0.5, x + 1] : [x, x + 1];
        const [y0, y1] = dr > 0 ? [y, y + 0.5] : dr < 0 ? [y + 0.5, y + 1] : [y, y + 1];
        between.push([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]);
      }
    }
  }
  const whole = unite([...ground, ...border, ...between]).map(([outline, ...holes]) => [outline, ...holes.filter((h) => Math.abs(area(h)) / 2 >= SCRAP)]);
  return soften(whole, PAVEMENT_ROUND);
}
