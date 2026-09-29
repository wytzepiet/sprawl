import ClipperLib from "clipper-lib";
import { isBuilt, type Tile, type Town } from "./grid";
import { kin } from "./mass";

/**
 * The ground plans of a town's buildings, drawn as roads are: a building
 * is its tiles and the joins between them (`Town.joins`, as the brush
 * stroke ran), and its plan is a thick line through them, one width:
 *
 * - each tile a square of that width round its middle (unless it is only
 *   joined on the diagonal, where the bands make its ends);
 * - each join a band of that width from one middle to the next, beside or
 *   on the diagonal, so a diagonal row is as thick as a straight one;
 * - where four tiles round a corner are all joined beside each other, the
 *   square between their middles, so a block is solid.
 *
 * Tiles not joined are apart: detached houses, a gap between two sheds. A
 * town with no strokes (a fixture, a real place) is joined by kind:
 * beside each other, and on the diagonal unless the block is solid there
 * or a street runs between.
 */

export type Pt = [number, number];
/** A polygon: its outline, anticlockwise, then its holes, clockwise. */
export type Polygon = Pt[][];

/** A building's ground plan at one height, and the part of it each colour
 *  has. */
export interface Mass {
  tile: Tile;
  storeys: number;
  polygons: Polygon[];
  parts: { tile: Tile; head: boolean; polygons: Polygon[] }[];
}

/** How far every side facing out stands in from the tile's edge: the
 *  thick line is 1 - 2 * INSET wide. */
const INSET = 0.2;

/** Clipper works in integers: a tile is this many. */
const S = 1e5;
/** A gap too thin to be meant: a centimetre. */
const HAIR = 1e-3;

/** a·x + b·y ≤ c */
export type Half = [number, number, number];

/** A convex polygon cut down to one side of a line. */
function cut(poly: Pt[], [a, b, c]: Half): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const [p, q] = [poly[i], poly[(i + 1) % poly.length]];
    const [fp, fq] = [a * p[0] + b * p[1] - c, a * q[0] + b * q[1] - c];
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

type Paths = ClipperLib.IntPoint[][];
const paths = (rings: Pt[][]): Paths => rings.map((ring) => ring.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) })));
const NZ = ClipperLib.PolyFillType.pftNonZero;
function op(type: ClipperLib.ClipType, a: Paths, b: Paths = []): Paths {
  const c = new ClipperLib.Clipper();
  // No two rings touching at a point: the skeleton wants every ring whole.
  c.StrictlySimple = true;
  c.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const out: Paths = [];
  c.Execute(type, out, NZ, NZ);
  return out;
}
const union = (a: Paths, b: Paths = []) => op(ClipperLib.ClipType.ctUnion, a, b);
const minus = (a: Paths, b: Paths) => op(ClipperLib.ClipType.ctDifference, a, b);
const and = (a: Paths, b: Paths) => op(ClipperLib.ClipType.ctIntersection, a, b);
/** Grown by `by` tiles, or shrunk: lines into bands, polygons all round,
 *  corners kept sharp and ends square, so every wall runs one of eight
 *  ways, square or at forty-five degrees. */
function grow(ps: Paths, by: number, lines = false): Paths {
  const o = new ClipperLib.ClipperOffset(4, 0.001 * S);
  o.AddPaths(ps, ClipperLib.JoinType.jtMiter, lines ? ClipperLib.EndType.etOpenSquare : ClipperLib.EndType.etClosedPolygon);
  const out: Paths = [];
  o.Execute(out, by * S);
  return out;
}

/** Twice the signed area: positive anticlockwise, with y up. */
export const area = (ring: Pt[]) => ring.reduce((s, [x, y], i) => {
  const [nx, ny] = ring[(i + 1) % ring.length];
  return s + x * ny - nx * y;
}, 0);

function inside([x, y]: Pt, ring: Pt[]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Clipper's rings as polygons: each outline with the holes inside it,
 *  outlines anticlockwise and holes clockwise, no point twice and no
 *  point on a straight run. */
function polygons(ps: Paths): Polygon[] {
  const rings: Pt[][] = [];
  // Points closer than a centimetre are one: slivers from rounding make
  // the skeleton's work explode.
  for (const p of ClipperLib.Clipper.CleanPolygons(ps, 0.001 * S)) {
    const ring: Pt[] = [];
    for (const q of p) ring.push([q.X / S, q.Y / S]);
    const clean = tidy(ring);
    // A scrap too small to be a building (a hundredth of a tile) is none.
    if (clean.length >= 3 && Math.abs(area(clean)) > 0.02) rings.push(clean);
  }
  // Outlines and holes wind opposite ways; the biggest ring is an outline.
  const sign = Math.sign(rings.reduce((big, r) => (Math.abs(area(r)) > Math.abs(big) ? area(r) : big), 0));
  const outer = rings.filter((r) => area(r) * sign > 0).map((r) => (sign > 0 ? r : r.reverse()));
  const holes = rings.filter((r) => area(r) * sign < 0).map((r) => (sign > 0 ? r : r.reverse()));
  const out: Polygon[] = outer.map((r) => [r]);
  for (const h of holes) {
    const home = out.filter(([o]) => inside(h[0], o)).sort((a, b) => area(a[0]) - area(b[0]))[0];
    home?.push(h);
  }
  return out;
}

function tidy(ring: Pt[]): Pt[] {
  let out = ring.filter((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
  });
  for (let changed = true; changed && out.length > 3; ) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const [p, q, s] = [out[(i + out.length - 1) % out.length], out[i], out[(i + 1) % out.length]];
      const cross = (q[0] - p[0]) * (s[1] - q[1]) - (q[1] - p[1]) * (s[0] - q[0]);
      if (Math.abs(cross) < 1e-7) {
        out = out.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Tiles of one kind joined as the look would, with no strokes to say:
 *  beside each other, and on the diagonal unless the block is solid there
 *  (both tiles beside the pair are the kind too) or a street runs between. */
export function defaultJoins(town: Town) {
  return (c: number, r: number, x: number, y: number) => {
    const a = town.tile(c, r);
    if (!kin(a, town.tile(x, y))) return false;
    if (x === c || y === r) return true;
    if (town.linked(x, r, c, y)) return false;
    return !(kin(a, town.tile(x, r)) && kin(a, town.tile(c, y)));
  };
}

const EIGHT: Pt[] = [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1]];

/** The pieces a town's buildings are made of, each with the tile whose
 *  building, height and colour it is, and which building each tile is. */
function plan(town: Town, width: number) {
  const joined = town.joins ?? defaultJoins(town);
  const join = (c: number, r: number, x: number, y: number) =>
    isBuilt(town.tile(c, r)) && isBuilt(town.tile(x, y)) && (joined(c, r, x, y) || joined(x, y, c, r));
  const h = width / 2;

  // Which building each tile is: joined to it, through any chain of joins.
  const building = new Map<string, number>();
  let count = 0;
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (!isBuilt(town.tile(c, r)) || building.has(`${c},${r}`)) continue;
      const id = count++;
      const queue: Pt[] = [[c, r]];
      building.set(`${c},${r}`, id);
      while (queue.length) {
        const [x, y] = queue.pop()!;
        for (const [dx, dy] of EIGHT) {
          const k = `${x + dx},${y + dy}`;
          if (!building.has(k) && join(x, y, x + dx, y + dy)) building.set(k, id), queue.push([x + dx, y + dy]);
        }
      }
    }
  }

  const linksOf = (c: number, r: number) => EIGHT.filter(([dx, dy]) => join(c, r, c + dx, r + dy));
  /** Does the tile have its own square: joined beside, or not at all? */
  const square = (c: number, r: number) => {
    const links = linksOf(c, r);
    return !links.length || links.some(([dx, dy]) => !dx || !dy);
  };
  const pieces: { at: Pt; ring: Pt[] }[] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (!isBuilt(town.tile(c, r))) continue;
      const [mx, my] = [c + 0.5, r + 0.5];
      const links = linksOf(c, r);
      // The tile's own square, unless its only joins are diagonal.
      if (square(c, r)) {
        pieces.push({ at: [c, r], ring: [[mx - h, my - h], [mx + h, my - h], [mx + h, my + h], [mx - h, my + h]] });
      }
      // Each join once, as a band on to the next tile's middle, wound as
      // the squares are; past a middle with no square, a half-width more,
      // for the band's own end.
      for (const [dx, dy] of links) {
        if (dx < 0 || (dx === 0 && dy < 0)) continue;
        const len = Math.hypot(dx, dy);
        const [ux, uy] = [dx / len, dy / len];
        const [nx, ny] = [-uy * h, ux * h];
        const [ea, eb] = [square(c, r) ? 0 : h, square(c + dx, r + dy) ? 0 : h];
        const [ax, ay] = [mx - ux * ea, my - uy * ea];
        const [bx, by] = [mx + dx + ux * eb, my + dy + uy * eb];
        pieces.push({ at: [c, r], ring: [[ax - nx, ay - ny], [bx - nx, by - ny], [bx + nx, by + ny], [ax + nx, ay + ny]] });
      }
      // A solid block: this tile and the three past its bottom right corner,
      // all joined beside each other.
      if (join(c, r, c + 1, r) && join(c + 1, r, c + 1, r + 1) && join(c + 1, r + 1, c, r + 1) && join(c, r + 1, c, r)) {
        pieces.push({ at: [c, r], ring: [[mx, my], [mx + 1, my], [mx + 1, my + 1], [mx, my + 1]] });
      }
    }
  }
  return { pieces, building };
}

/** Every building's plan, a mass for each of its heights. */
export function footprints(town: Town, head: (c: number, r: number) => boolean, inset = INSET): Mass[] {
  const { pieces, building } = plan(town, 1 - 2 * inset);
  const byBuilding = new Map<number, typeof pieces>();
  for (const p of pieces) {
    const id = building.get(`${p.at[0]},${p.at[1]}`)!;
    (byBuilding.get(id) ?? byBuilding.set(id, []).get(id)!).push(p);
  }
  const tileOf = (p: { at: Pt }) => town.tile(...p.at);
  // Pieces meet edge to edge: joined a hair wide and drawn back, so no
  // hairline is left between them.
  const whole = (rings: Pt[][]) => grow(grow(union(paths(rings)), HAIR), -HAIR);
  const masses: Mass[] = [];
  for (const ps of byBuilding.values()) {
    const plan = whole(ps.map((p) => p.ring));
    for (const storeys of new Set(ps.map((p) => tileOf(p).storeys))) {
      const mine = ps.filter((p) => tileOf(p).storeys === storeys);
      const shape = and(whole(mine.map((p) => p.ring)), plan);
      const byColour = new Map<string, { tile: Tile; head: boolean; rings: Pt[][] }>();
      for (const p of mine) {
        const h = head(...p.at);
        const key = `${tileOf(p).kind}:${h}`;
        (byColour.get(key) ?? byColour.set(key, { tile: tileOf(p), head: h, rings: [] }).get(key)!).rings.push(p.ring);
      }
      masses.push({
        tile: tileOf(mine[0]),
        storeys,
        polygons: polygons(shape),
        parts: [...byColour.values()].map((e) => ({ tile: e.tile, head: e.head, polygons: polygons(and(whole(e.rings), shape)) })),
      });
    }
  }
  return masses;
}

/** The convex polygon the half-planes bound, within a box. */
export function convex(halves: Half[], [x0, y0, x1, y1]: [number, number, number, number]): Pt[] {
  let ring: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (const h of halves) ring = cut(ring, h);
  return ring;
}

/** A region with every corner rounded to radius `r`, outside and in, as
 *  the terrain rounds its shores; straight sides stay where they are. */
export function soften(region: Polygon[], r: number): Polygon[] {
  const round = (ps: Paths, by: number) => {
    const o = new ClipperLib.ClipperOffset(2, 0.002 * S);
    o.AddPaths(ps, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const out: Paths = [];
    o.Execute(out, by * S);
    return out;
  };
  const ps = paths(region.flat());
  return polygons(round(round(round(round(ps, -r), r), r), -r));
}

/** Regions, as sets of polygons: together, apart, in common. */
export const unite = (a: Polygon[]) => polygons(union(paths(a.flat())));
export const subtract = (a: Polygon[], b: Polygon[]) => polygons(minus(paths(a.flat()), paths(b.flat())));
export const intersect = (a: Polygon[], b: Polygon[]) => polygons(and(paths(a.flat()), paths(b.flat())));
