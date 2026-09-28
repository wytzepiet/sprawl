import ClipperLib from "clipper-lib";
import { isBuilt, type Tile, type Town } from "./grid";
import { kin } from "./mass";

/**
 * The ground plans of a town's buildings, three rules, each decided by a
 * tile's neighbours alone:
 *
 * - A building's tile is its whole square.
 * - A side facing a road is cut back, a pavement's width.
 * - A row stepping on the diagonal is a straight band, as the terrain
 *   draws a shore: each step's outer corner is cut, from the middle of
 *   one edge to the middle of the other, and a corner of ground or road
 *   with the building on both its sides (between two steps, or an L's
 *   inside) is filled the same way. A street across a corner parts it.
 *
 * Anything else stays square: a lone house, a row's end.
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

/** How far a side along a straight street is cut back. */
const PAVEMENT = 0.2;
/** Where a corner a street runs across on the diagonal is cut, measured
 *  along the diagonal from the tile's middle: as far from the street's
 *  middle line as a side from a straight street's. */
const DIAGONAL = 1 - (0.5 + PAVEMENT) * Math.SQRT2;

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
    if (clean.length >= 3 && Math.abs(area(clean)) > 1e-6) rings.push(clean);
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

/** Every building's plan, a mass for each of its heights. */
export function footprints(town: Town, head: (c: number, r: number) => boolean): Mass[] {
  /** Are the tiles at (c, r) and (x, y) one building? */
  const one = (c: number, r: number, x: number, y: number) =>
    isBuilt(town.tile(c, r)) && isBuilt(town.tile(x, y)) && kin(town.tile(c, r), town.tile(x, y));
  /** Is there a street across the corner of (c, r) towards (sx, sy),
   *  from the tile beside it on one side to the other? */
  const across = (c: number, r: number, sx: number, sy: number) => town.linked(c + sx, r, c, r + sy);
  /** Is the corner of (c, r) towards (sx, sy) a step's outer corner: the
   *  building on neither side there nor across (a street between counts
   *  as apart), and going on along the diagonal past both sides? */
  const step = (c: number, r: number, sx: number, sy: number) =>
    !one(c, r, c + sx, r) && !one(c, r, c, r + sy) && (!one(c, r, c + sx, r + sy) || across(c, r, sx, sy)) &&
    one(c, r, c + sx, r - sy) && one(c, r, c - sx, r + sy);
  /** Is the corner of ground (c, r) towards (sx, sy) filled: one building
   *  on both its sides there (an L's inside, or between two steps), and no
   *  street running across the corner? */
  const fill = (c: number, r: number, sx: number, sy: number) =>
    !isBuilt(town.tile(c, r)) && one(c + sx, r, c, r + sy) && !town.linked(c, r, c + sx, r + sy) && !across(c, r, sx, sy);
  /** Tiles on the diagonal of each other, joined through a filled corner. */
  const bridged = (c: number, r: number, dx: number, dy: number) =>
    fill(c + dx, r, -dx, dy) || fill(c, r + dy, dx, -dy);

  // Which building each built tile is part of: joined beside, or on the
  // diagonal.
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
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const k = `${x + dx},${y + dy}`;
            const joined = one(x, y, x + dx, y + dy) && (!dx || !dy || one(x, y, x + dx, y) || one(x, y, x, y + dy) || bridged(x, y, dx, dy));
            if (!building.has(k) && joined) building.set(k, id), queue.push([x + dx, y + dy]);
          }
        }
      }
    }
  }

  // Every piece, with the tile whose building, height and colour it is.
  const pieces: { at: Pt; ring: Pt[] }[] = [];
  const CORNERS: Pt[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const [mx, my] = [c + 0.5, r + 0.5];
      if (isBuilt(town.tile(c, r))) {
        let ring: Pt[] = [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]];
        // A corner a street runs across on the diagonal, cut back as far
        // from it as a side from a straight street; a step's outer corner,
        // from edge middle to edge middle.
        for (const [sx, sy] of CORNERS) {
          if (across(c, r, sx, sy)) ring = cut(ring, [sx, sy, sx * mx + sy * my + DIAGONAL]);
          else if (step(c, r, sx, sy)) ring = cut(ring, [sx, sy, sx * mx + sy * my + 0.5]);
        }
        // A side along which a street runs straight, cut back.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [x, y] = [c + dx, r + dy];
          if (!town.linked(x, y, x + dy, y + dx) && !town.linked(x, y, x - dy, y - dx)) continue;
          ring = cut(ring, [dx, dy, dx * mx + dy * my + 0.5 - PAVEMENT]);
        }
        pieces.push({ at: [c, r], ring });
      } else {
        // The corner between two steps of a row.
        for (const [sx, sy] of CORNERS) {
          if (!fill(c, r, sx, sy)) continue;
          let ring: Pt[] = [[mx + sx / 2, my + sy / 2], [mx + sx / 2, my], [mx, my + sy / 2]];
          // On a street running on the diagonal through this tile, as far
          // back from it as the corners cut beside.
          if (town.linked(c, r, c + sx, r - sy) || town.linked(c, r, c - sx, r + sy)) {
            ring = cut(ring, [-sx, -sy, -(sx * mx + sy * my) - (1 - DIAGONAL)]);
          }
          if (ring.length >= 3) pieces.push({ at: [c + sx, r], ring });
        }
      }
    }
  }

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
    for (const storeys of new Set(ps.map((p) => tileOf(p).storeys))) {
      const mine = ps.filter((p) => tileOf(p).storeys === storeys);
      const shape = whole(mine.map((p) => p.ring));
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

/** Regions, as sets of polygons: together, apart, in common. */
export const unite = (a: Polygon[]) => polygons(union(paths(a.flat())));
export const subtract = (a: Polygon[], b: Polygon[]) => polygons(minus(paths(a.flat()), paths(b.flat())));
export const intersect = (a: Polygon[], b: Polygon[]) => polygons(and(paths(a.flat()), paths(b.flat())));
