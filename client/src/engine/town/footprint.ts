import ClipperLib from "clipper-lib";
import { isBuilt, type Tile, type Town } from "./grid";
import { kin } from "./mass";

/**
 * The ground plans of a town's buildings:
 *
 * 1. A building is its tiles' squares, joined beside and at corners where
 *    no street runs between, and its outline walked as one shape.
 * 2. Every staircase on that outline, a run of unit-long sides turning one
 *    way then the other for two steps or more, is made one straight line
 *    at forty-five degrees, just outside their middles, as the terrain draws a
 *    shore. A diagonal row, a sheared block, a staircase of L's: the same
 *    rule, however long the run. Everything else stays square.
 * 3. The outline is drawn in by one width.
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

/** How far every side facing out is drawn in. */
const INSET = 0.2;

/** How far a straightened staircase's line is moved out from the middles
 *  of its steps' sides: a row one tile wide on the diagonal is then as
 *  thick as a straight one, half a tile either side of its middle. */
const OUT = 0.5 - 0.5 / Math.SQRT2;

/** Clipper works in integers: a tile is this many. */
const S = 1e5;

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

/** The four ways round a tile, clockwise on the map (y down), each with the
 *  tile edge it runs along: from its start corner, as an offset from the
 *  tile's own corner (c, r). */
const EDGES: { d: Pt; from: Pt; across: Pt }[] = [
  { d: [1, 0], from: [0, 0], across: [0, -1] }, // top, going right
  { d: [0, 1], from: [1, 0], across: [1, 0] }, // right, going down
  { d: [-1, 0], from: [1, 1], across: [0, 1] }, // bottom, going left
  { d: [0, -1], from: [0, 1], across: [-1, 0] }, // left, going up
];

/**
 * A building's outline as rings of tile corners, walked with the building
 * on the right. Where two of its tiles meet only at a corner the walk goes
 * on through, keeping them one shape, unless a street runs across there.
 */
function outline(tiles: Set<string>, cut: (x: number, y: number) => boolean): Pt[][] {
  const has = (c: number, r: number) => tiles.has(`${c},${r}`);
  // Every edge of the building's tiles with no tile of it across, by the
  // corner it starts from.
  const out = new Map<string, { to: Pt; d: Pt; used: boolean }[]>();
  for (const key of tiles) {
    const [c, r] = key.split(",").map(Number);
    for (const e of EDGES) {
      if (has(c + e.across[0], r + e.across[1])) continue;
      const from: Pt = [c + e.from[0], r + e.from[1]];
      const k = `${from[0]},${from[1]}`;
      (out.get(k) ?? out.set(k, []).get(k)!).push({ to: [from[0] + e.d[0], from[1] + e.d[1]], d: e.d, used: false });
    }
  }
  const rings: Pt[][] = [];
  for (const [start, edges] of out) {
    for (const first of edges) {
      if (first.used) continue;
      const ring: Pt[] = [start.split(",").map(Number) as Pt];
      let e = first;
      while (!e.used) {
        e.used = true;
        ring.push(e.to);
        const next = (out.get(`${e.to[0]},${e.to[1]}`) ?? []).filter((n) => !n.used);
        if (!next.length) break;
        // At a corner two tiles touch by, turn left to stay in the one
        // shape, or right where a street across keeps them apart.
        const turn = (n: { d: Pt }) => e.d[0] * n.d[1] - e.d[1] * n.d[0]; // < 0: left, y down
        next.sort((a, b) => turn(a) - turn(b));
        e = cut(...e.to) ? next[next.length - 1] : next[0];
      }
      ring.pop();
      rings.push(ring);
    }
  }
  return rings;
}

/**
 * A ring with every staircase made straight: a run of at least three
 * unit-long sides turning one way then the other (two steps or more)
 * becomes one line at forty-five degrees through their middles, as the
 * terrain turns a staircase of water tiles into a shore. Everything else
 * stays as it is: square.
 */
function straighten(ring: Pt[]): Pt[] {
  // The ring as sides: where each starts, its way and its length.
  const n = ring.length;
  const dir = (i: number): Pt => {
    const [p, q] = [ring[i], ring[(i + 1) % n]];
    return [Math.sign(q[0] - p[0]), Math.sign(q[1] - p[1])];
  };
  const sides: { at: Pt; d: Pt; len: number }[] = [];
  let start = 0;
  // Begin at a turn, so no side is split across the ring's seam.
  while (start < n && dir(start)[0] === dir((start + n - 1) % n)[0] && dir(start)[1] === dir((start + n - 1) % n)[1]) start++;
  if (start === n) return ring;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const d = dir(i);
    const last = sides[sides.length - 1];
    if (last && last.d[0] === d[0] && last.d[1] === d[1]) last.len++;
    else sides.push({ at: ring[i], d, len: 1 });
  }
  const m = sides.length;
  const side = (i: number) => sides[((i % m) + m) % m];
  const unit = (i: number) => side(i).len === 1;
  // In a staircase, a side goes the way of the one two before it.
  const stair = (i: number) => unit(i) && unit(i - 1) && unit(i - 2) && side(i).d[0] === side(i - 2).d[0] && side(i).d[1] === side(i - 2).d[1];
  // Sides i and i+1 are one staircase if some two steps take in both.
  const linked = (i: number) => stair(i + 1) || stair(i + 2);
  const breakAt = [...Array(m).keys()].find((i) => !linked(i + m - 1));
  if (breakAt === undefined) return sides.map((sd) => mid(sd));
  const outRing: Pt[] = [];
  for (let k = 0; k < m; ) {
    const i = (breakAt + k) % m;
    let n = 1;
    while (k + n < m && linked(i + n - 1)) n++;
    if (n < 3) {
      for (let t = 0; t < n; t++) outRing.push(side(i + t).at);
    } else {
      // A staircase: one line just outside its sides' middles, meeting the
      // first and last sides' own lines.
      const [f, l] = [side(i), side(i + n - 1)];
      const [a, b] = [mid(f), mid(l)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const nrm: Pt = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
      const [p, q]: Pt[] = [[a[0] + nrm[0] * OUT, a[1] + nrm[1] * OUT], [b[0] + nrm[0] * OUT, b[1] + nrm[1] * OUT]];
      outRing.push(f.at, meet(p, q, f), meet(p, q, l));
    }
    k += n;
  }
  return outRing;
  /** Where the line through p and q crosses side s's own line. */
  function meet(p: Pt, q: Pt, s: { at: Pt; d: Pt }): Pt {
    const [ux, uy] = [q[0] - p[0], q[1] - p[1]];
    const den = s.d[0] * uy - s.d[1] * ux;
    const t = ((p[0] - s.at[0]) * uy - (p[1] - s.at[1]) * ux) / den;
    return [s.at[0] + s.d[0] * t, s.at[1] + s.d[1] * t];
  }
  function mid(s: { at: Pt; d: Pt; len: number }): Pt {
    return [s.at[0] + (s.d[0] * s.len) / 2, s.at[1] + (s.d[1] * s.len) / 2];
  }
}

/** Every building's plan, a mass for each of its heights. */
export function footprints(town: Town, head: (c: number, r: number) => boolean): Mass[] {
  /** Are the tiles at (c, r) and (x, y) one building? */
  const one = (c: number, r: number, x: number, y: number) =>
    isBuilt(town.tile(c, r)) && isBuilt(town.tile(x, y)) && kin(town.tile(c, r), town.tile(x, y));
  /** Does a street's line run through the corner point (x, y): across it,
   *  or ending at a road tile beside it and pointing at it? Then the tiles
   *  either side are apart. */
  const cut = (x: number, y: number) => {
    for (const [c, r] of [[x - 1, y - 1], [x, y - 1], [x, y], [x - 1, y]]) {
      if (town.tile(c, r).kind !== "road") continue;
      for (const [dc, dr] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (town.linked(c, r, c + dc, r + dr) && (x - c - 0.5) * dr === (y - r - 0.5) * dc) return true;
      }
    }
    return false;
  };

  // Which building each built tile is part of: joined beside, or on the
  // diagonal where no street runs between.
  const building = new Map<string, number>();
  const members: string[][] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (!isBuilt(town.tile(c, r)) || building.has(`${c},${r}`)) continue;
      const id = members.length;
      members.push([]);
      const queue: Pt[] = [[c, r]];
      building.set(`${c},${r}`, id);
      while (queue.length) {
        const [x, y] = queue.pop()!;
        members[id].push(`${x},${y}`);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const k = `${x + dx},${y + dy}`;
            const corner: Pt = [x + (dx > 0 ? 1 : 0), y + (dy > 0 ? 1 : 0)];
            const joined = one(x, y, x + dx, y + dy) && (!dx || !dy || !cut(...corner));
            if (!building.has(k) && joined) building.set(k, id), queue.push([x + dx, y + dy]);
          }
        }
      }
    }
  }

  const square = (k: string): Pt[] => {
    const [c, r] = k.split(",").map(Number);
    return [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]];
  };
  const tileAt = (k: string) => town.tile(...(k.split(",").map(Number) as Pt));
  const masses: Mass[] = [];
  for (const keys of members) {
    const rings = outline(new Set(keys), cut).map(straighten);
    // Drawn in by one width all round.
    const plan = grow(union(paths(rings)), -INSET);
    // Split by height and by colour: each tile's square, and ground the
    // straightening took in goes to the first.
    const groups = new Map<string, { tile: Tile; head: boolean; keys: string[] }>();
    for (const k of keys) {
      const [c, r] = k.split(",").map(Number);
      const g = `${tileAt(k).storeys}:${tileAt(k).kind}:${head(c, r)}`;
      (groups.get(g) ?? groups.set(g, { tile: tileAt(k), head: head(c, r), keys: [] }).get(g)!).keys.push(k);
    }
    const all = union(paths(keys.map(square)));
    const parts = [...groups.values()].map((g, i) => {
      const mine = union(paths(g.keys.map(square)));
      const region = i === 0 ? union(mine, minus(grow(all, 2), all)) : mine;
      return { ...g, shape: and(plan, region) };
    });
    for (const storeys of new Set(parts.map((p) => p.tile.storeys))) {
      const mine = parts.filter((p) => p.tile.storeys === storeys);
      const shape = union(mine.flatMap((p) => p.shape));
      masses.push({
        tile: mine[0].tile,
        storeys,
        polygons: polygons(shape),
        parts: mine.map((p) => ({ tile: p.tile, head: p.head, polygons: polygons(p.shape) })),
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
