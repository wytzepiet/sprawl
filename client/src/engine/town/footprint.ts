import ClipperLib from "clipper-lib";
import { isBuilt, type Tile, type Town } from "./grid";
import { CHAMFER, CORNERS, DIAGONAL, fills, formOf, frontOf, GABLE, kin, QUAY, STEP } from "./mass";

/**
 * The ground plans of a town's buildings, as exact polygons.
 *
 * Every tile a building stands on, or a row steps across, is four quarters,
 * and each quarter is its square cut by a few straight lines, decided by the
 * three tiles at its corner (the dual grid, as the terrain has it). Nothing
 * is sampled: a quarter is a convex polygon, a building the union of its
 * quarters, so its walls are straight and its corners sharp. Then, as
 * whole shapes: the streets are cut away, a band along every street's
 * middle line as wide as the building keeps clear, and a building only so
 * deep from the edge of its block is left, the rest a courtyard.
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
  /** Keyed by the tile the colour comes from: the plan split by it. */
  parts: { tile: Tile; head: boolean; polygons: Polygon[] }[];
}

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

/** A piece of a building's plan: a convex polygon, whose it is, and the
 *  tile it lies on. */
interface Piece {
  owner: Tile;
  /** Where the owner stands. */
  at: string;
  c: number;
  r: number;
  ring: Pt[];
}

/**
 * The pieces tile (c, r) gives: a built tile's four quarters, each its
 * square cut by the lines its corner draws; open ground's corners a row
 * steps across. In a quarter, u runs from the tile's middle out towards
 * the corner along x, and w along y.
 */
function pieces(town: Town, c: number, r: number): Piece[] {
  const me = town.tile(c, r);
  const [mx, my] = [c + 0.5, r + 0.5];
  const out: Piece[] = [];
  // A quarter's square, cut by lines α·u + β·w ≤ γ, or by any one of a
  // choice of lines (the inside corner of an L is two pieces).
  const quarter = (sx: number, sy: number, lines: Half[], either: Half[] = []) => {
    const world = ([a, b, g]: Half): Half => [a * sx, b * sy, g + a * sx * mx + b * sy * my];
    let box: Pt[] = [[mx, my], [mx + 0.5 * sx, my], [mx + 0.5 * sx, my + 0.5 * sy], [mx, my + 0.5 * sy]];
    for (const l of lines) box = cut(box, world(l));
    return either.length ? either.map((l) => cut(box, world(l))) : [box];
  };

  if (!isBuilt(me)) {
    // Ground a row steps across: a courtyard's corner within its quarter,
    // a row stepping on the diagonal the half of the tile on its side of
    // the line its back runs along.
    for (const [cx, cy] of CORNERS) {
      const [p, q, o] = [town.tile(c + cx, r), town.tile(c, r + cy), town.tile(c + cx, r + cy)];
      if (!fills(me, p, q)) continue;
      const face = 0.5 - formOf(p).apart + (kin(p, o) ? 0 : DIAGONAL);
      // toward = (x - mx)·cx + (y - my)·cy ≥ 1 - face
      const line: Half = [-cx, -cy, -(1 - face) - cx * mx - cy * my];
      let ring: Pt[] = kin(p, o)
        ? [[mx, my], [mx + 0.5 * cx, my], [mx + 0.5 * cx, my + 0.5 * cy], [mx, my + 0.5 * cy]]
        : [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]];
      ring = cut(ring, line);
      if (ring.length >= 3) out.push({ owner: p, at: `${c + cx},${r}`, c, r, ring });
    }
    return out;
  }

  const form = formOf(me);
  const face = 0.5 - form.apart;
  const gap = (t: Tile) => (t.kind === "road" ? 0 : t.kind === "water" ? QUAY : form.apart);
  for (const [sx, sy] of CORNERS) {
    const [a, b, d] = [town.tile(c + sx, r), town.tile(c, r + sy), town.tile(c + sx, r + sy)];
    const [ja, jb] = [kin(me, a), kin(me, b)];
    // Beside it, open ground a row stepping on the diagonal runs on
    // across: no wall on that side; the row's back bounds it instead.
    const onA = !ja && a.kind !== "road" && fills(a, me, town.tile(c + sx, r - sy)) && !kin(me, town.tile(c, r - sy));
    const onB = !jb && b.kind !== "road" && fills(b, me, town.tile(c - sx, r + sy)) && !kin(me, town.tile(c - sx, r));
    // Across a filled corner the face runs on the diagonal: a courtyard's,
    // where the fourth tile round the corner is built too, or a row's back.
    const across = (t: Tile) => face + (kin(me, t) ? 0 : DIAGONAL);
    const lines: Half[] = [];
    if (!ja) {
      if (fills(a, me, d)) lines.push([1, -1, across(b)]);
      else if (!onA) lines.push([1, 0, 0.5 - gap(a)]);
    }
    if (!jb) {
      if (fills(b, me, d)) lines.push([-1, 1, across(a)]);
      else if (!onB) lines.push([0, 1, 0.5 - gap(b)]);
    }
    if (onA || onB) lines.push([1, 1, face + DIAGONAL]);
    if (form.corners && a.kind === "road" && b.kind === "road" && !town.linked(c + sx, r, c, r + sy)) {
      lines.push([1, 1, 1 - CHAMFER]);
    }
    // The inside corner of an L.
    const either: Half[] = [];
    if (ja && jb && !kin(me, d) && !fills(d, a, b)) {
      const edge = 0.5 - gap(d);
      either.push([1, 0, edge], [0, 1, edge]);
    }
    for (const ring of quarter(sx, sy, lines, either)) if (ring.length >= 3) out.push({ owner: me, at: `${c},${r}`, c, r, ring });
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

/** The middle lines of the streets: between road tiles joined to each
 *  other, and a road tile joined to none as a point. */
function streets(town: Town): Pt[][] {
  const lines: Pt[][] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (town.tile(c, r).kind !== "road") continue;
      let joined = false;
      for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1]]) {
        if (!town.linked(c, r, c + dc, r + dr)) continue;
        joined = true;
        if (dc > 0 || (dc === 0 && dr > 0)) lines.push([[c + 0.5, r + 0.5], [c + dc + 0.5, r + dr + 0.5]]);
      }
      if (!joined) lines.push([[c + 0.5, r + 0.5], [c + 0.5 + 1e-4, r + 0.5]]);
    }
  }
  return lines;
}

/**
 * Every building's plan, a mass for each of its heights. A building is
 * the tiles joined into one (houses into rows, a shed's tiles into the
 * shed), and the ground its rows step across.
 */
export function footprints(town: Town, head: (c: number, r: number) => boolean): Mass[] {
  // Which building each built tile is part of, by where it stands.
  const building = new Map<string, number>();
  const tiles: Tile[][] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      if (!isBuilt(town.tile(c, r)) || building.has(`${c},${r}`)) continue;
      const id = tiles.length;
      tiles.push([]);
      const queue: [number, number][] = [[c, r]];
      building.set(`${c},${r}`, id);
      while (queue.length) {
        const [x, y] = queue.pop()!;
        tiles[id].push(town.tile(x, y));
        // Beside it, and on the diagonal where a row steps across the
        // ground between.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const k = `${x + dx},${y + dy}`;
          const [me, them] = [town.tile(x, y), town.tile(x + dx, y + dy)];
          const joined = dx && dy ? fills(town.tile(x + dx, y), me, them) || fills(town.tile(x, y + dy), me, them) : true;
          if (!building.has(k) && joined && kin(me, them)) building.set(k, id), queue.push([x + dx, y + dy]);
        }
      }
    }
  }
  const all: Piece[][] = tiles.map(() => []);
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      for (const p of pieces(town, c, r)) all[building.get(p.at)!]?.push(p);
    }
  }

  // The streets each form keeps clear of, and the stretches of front where
  // a gabled house steps forward of its row's gardens.
  const net = streets(town);
  const bays: Pt[][] = [];
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const at = frontOf(town, c + 0.5, r + 0.5);
      if (!at?.bay) continue;
      bays.push(at.front[0]
        ? [[c, r + 0.5 - GABLE], [c + 1, r + 0.5 - GABLE], [c + 1, r + 0.5 + GABLE], [c, r + 0.5 + GABLE]]
        : [[c + 0.5 - GABLE, r], [c + 0.5 + GABLE, r], [c + 0.5 + GABLE, r + 1], [c + 0.5 - GABLE, r + 1]]);
    }
  }

  const masses: Mass[] = [];
  all.forEach((ps, id) => {
    if (!ps.length) return;
    const form = formOf(tiles[id][0]);
    // Only what is near it: the streets and bays within reach of its tiles.
    const xs = ps.map((p) => p.c), ys = ps.map((p) => p.r);
    const [x0, x1, y0, y1] = [Math.min(...xs) - 2, Math.max(...xs) + 3, Math.min(...ys) - 2, Math.max(...ys) + 3];
    const near = (ring: Pt[]) => ring.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
    const lines = paths(net.filter(near));
    const forward = paths(bays.filter(near));
    const street = form.family === "street" && forward.length
      ? union(minus(grow(lines, form.clear, true), forward), and(grow(lines, form.clear - STEP, true), forward))
      : grow(lines, form.clear, true);
    // Pieces meet edge to edge; grown by a hair, joined and drawn back in,
    // no hairline is left between them to split a building.
    const whole = (rings: Pt[][]) => grow(grow(union(paths(rings)), HAIR), -HAIR);
    let plan = minus(whole(ps.map((p) => p.ring)), street);
    // Only so deep from the edge of its block: deeper is a courtyard.
    if (Number.isFinite(form.depth)) plan = minus(plan, grow(plan, -form.depth));
    const heights = [...new Set(ps.map((p) => p.owner.storeys))];
    for (const storeys of heights) {
      const mine = ps.filter((p) => p.owner.storeys === storeys);
      const shape = and(whole(mine.map((p) => p.ring)), plan);
      // Split by colour: by kind, and a shed's head apart.
      const byColour = new Map<string, { tile: Tile; head: boolean; rings: Pt[][] }>();
      for (const p of mine) {
        const h = p.at === `${p.c},${p.r}` && head(p.c, p.r);
        const key = `${p.owner.kind}:${h}`;
        const entry = byColour.get(key) ?? byColour.set(key, { tile: p.owner, head: h, rings: [] }).get(key)!;
        entry.rings.push(p.ring);
      }
      masses.push({
        tile: mine[0].owner,
        storeys,
        polygons: polygons(shape),
        parts: [...byColour.values()].map((e) => ({ tile: e.tile, head: e.head, polygons: polygons(and(whole(e.rings), shape)) })),
      });
    }
  });
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
