import type { MeshGeometry } from "../Mesh";
import type { BuildingKind } from "../../generated";
import { isBuilt, type Tile, type Town } from "./grid";
import { distances } from "./edt";

/**
 * The buildings of a town, as one mesh, decided corner by corner.
 *
 * Every built tile is four quarters, and a quarter is shaped by the three
 * tiles that meet it at its corner (the dual grid, as Townscaper has it): the
 * two beside it and the one on the diagonal. Built beside it, it runs on
 * wall to wall; a road, it stops at the pavement; open ground, it leaves a
 * garden's depth. Built on both sides but open on the diagonal, the corner
 * is the inside of a courtyard. Road on both sides, the corner is cut on the
 * diagonal to face the junction, and cut deep, clear of the road, where the
 * two are one street running across the corner.
 *
 * Each quarter is a handful of lines, so its outline is the zero of a
 * function that is the largest of their signed distances. The outline is
 * traced from samples of it (marching squares), and the roof is the
 * distance in from the outline, climbing to a ridge wherever two sides are
 * equally far: a gable along a row, a hip at its end, a valley in an L, all
 * without a roof ever being told which way to run. Tiles of a different
 * height join wall to wall but keep their own roofs.
 */

/** Samples along a tile's edge. A tile is twelve metres, so one a metre. */
const RES = 12;

/**
 * How each kind meets the street and its neighbours: its form. Homes and
 * the shops of a high street are one family, joined wall to wall at the
 * pavement into rows and blocks, with gardens behind. Offices keep a
 * forecourt. Sheds stand apart behind a paved yard, and a big box behind its
 * car park. Kinds of one family join; of different ones, each keeps its
 * distance. Everything a form decides is here, so a new way of building is
 * a row of this table.
 */
interface Form {
  family: string;
  /** How far it keeps from any street's middle line: the road and its
   *  kerb, and whatever it keeps in front, pavement or yard. */
  clear: number;
  /** How far it stands back from open ground and from other families. */
  apart: number;
  /** The ground its tiles leave open, if not grass. */
  yard?: "paved";
  /** Its street corners are cut to the junction. */
  corners?: boolean;
  /** How deep it is built from the edge of its block, in tiles; deeper is
   *  the block's inside, a courtyard. */
  depth: number;
}
const STREET: Form = { family: "street", clear: 0.47, apart: 0.14, corners: true, depth: 1 };
const FORMS: Partial<Record<BuildingKind, Form>> = {
  Office: { family: "office", clear: 0.72, apart: 0.05, yard: "paved", depth: 2.5 },
  Workshop: { family: "industry", clear: 0.8, apart: 0.05, yard: "paved", depth: Infinity },
  Factory: { family: "industry", clear: 0.8, apart: 0.05, yard: "paved", depth: Infinity },
  Warehouse: { family: "industry", clear: 0.8, apart: 0.05, yard: "paved", depth: Infinity },
  Supermarket: { family: "box", clear: 1.0, apart: 0.05, yard: "paved", depth: Infinity },
  GasStation: { family: "box", clear: 0.9, apart: 0.05, yard: "paved", depth: Infinity },
};
export const formOf = (t: Tile): Form => FORMS[t.kind as BuildingKind] ?? STREET;

/** How far a building stands back from water. */
const QUAY = 0.02;
/** How far in from the corner a street corner is cut. */
const CHAMFER = 0.2;

/** The walls' height, and the roof that climbs from them `d` in. */
export const eaves = (t: Tile) => 0.1 + 0.12 * t.storeys;
function rise(t: Tile, d: number) {
  if (formOf(t).family !== "street") return Math.min(d * 0.25, 0.06);
  return t.storeys <= 3 ? Math.min(d * 0.75, 0.26) : Math.min(d * 0.5, 0.03);
}

/** Buildings that join: the houses and shops of a street, which run on
 *  into rows whoever built them, and otherwise the tiles of one building,
 *  one kind painted as one. A factory beside a depot is two buildings. */
const kin = (a: Tile, b: Tile) => {
  if (!isBuilt(a) || !isBuilt(b)) return false;
  const street = formOf(a).family === "street";
  return street ? formOf(b).family === "street" : a.kind === b.kind && a.id === b.id;
};

/**
 * How far outside tile (c, r)'s building the point (x, y) is, as the
 * largest of its quarter's lines; below zero, inside. Joined sides draw no
 * line, so a building's inside does not end at a tile's edge.
 *
 * The terrain's rule for shores holds for buildings too. Open ground with
 * buildings of one family on both sides of a corner has that corner filled
 * on the diagonal, and a building's face runs straight across it: a row
 * stepping along a diagonal street is a straight front and not a stair, and
 * the outer corner of each step is cut on the same line.
 */
export function outside(town: Town, c: number, r: number, x: number, y: number): number {
  const [sx, sy] = [x < c + 0.5 ? -1 : 1, y < r + 0.5 ? -1 : 1];
  const [u, w] = [Math.abs(x - c - 0.5), Math.abs(y - r - 0.5)];
  const [a, b, d] = [town.tile(c + sx, r), town.tile(c, r + sy), town.tile(c + sx, r + sy)];
  const me = town.tile(c, r);
  if (!isBuilt(me)) {
    if (!fills(me, a, b)) return 1;
    const form = formOf(a);
    return Math.max((1 - u - w - (0.5 - form.apart)) / Math.SQRT2, street(town, x, y, form.clear));
  }
  const form = formOf(me);
  const face = 0.5 - form.apart;
  const gap = (t: Tile) => (t.kind === "road" ? 0 : t.kind === "water" ? QUAY : form.apart);
  let f = -1;
  const [ja, jb] = [kin(me, a), kin(me, b)];
  if (!ja) f = Math.max(f, fills(a, me, d) ? (u - w - face) / Math.SQRT2 : u - 0.5 + gap(a));
  if (!jb) f = Math.max(f, fills(b, me, d) ? (w - u - face) / Math.SQRT2 : w - 0.5 + gap(b));
  if (ja && jb && !kin(me, d) && !fills(d, a, b)) {
    const edge = 0.5 - gap(d);
    f = Math.max(f, Math.min(u - edge, w - edge));
  }
  // The outer corner of a step, with the row going on beyond both its
  // sides: cut on the diagonal the row's face runs along.
  const steps = !kin(me, a) && !kin(me, b) && !kin(me, d) && kin(me, town.tile(c + sx, r - sy)) && kin(me, town.tile(c - sx, r + sy));
  if (steps) f = Math.max(f, (u + w - face) / Math.SQRT2);
  if (form.corners && a.kind === "road" && b.kind === "road" && !town.linked(c + sx, r, c, r + sy)) {
    f = Math.max(f, (CHAMFER - (1 - u - w)) / Math.SQRT2);
  }
  // A row of houses stands back behind a strip of front garden, and the
  // gabled ones step forward of it to the pavement.
  const at = frontOf(town, x, y);
  if (at && !(at.bay && Math.abs(at.along) <= GABLE)) f = Math.max(f, STEP - at.back);
  return Math.max(f, street(town, x, y, form.clear));
}

/** Is `t` ground a building may take a corner of, with buildings of one
 *  family, `p` and `q`, on both its sides there? Then the corner is
 *  theirs, filled on the diagonal: a row stepping across it runs straight
 *  on, and a courtyard's inside corner is cut at forty-five degrees, as the
 *  terrain rounds a shore's. */
const fills = (t: Tile, p: Tile, q: Tile) => (t.kind === "open" || t.kind === "paved") && kin(p, q);

/** A tile's building as the look draws it: its own, or, for ground a row
 *  steps across, that row's. */
function buildingOn(town: Town, c: number, r: number): Tile | null {
  const me = town.tile(c, r);
  if (isBuilt(me)) return me;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const [a, b] = [town.tile(c + sx, r), town.tile(c, r + sy)];
    if (fills(me, a, b)) return a;
  }
  return null;
}

/** How much nearer than `clear` the point is to the middle line of a
 *  street: the lines between joined road tiles, at any angle, and the
 *  middle of a road tile joined to none. */
function street(town: Town, x: number, y: number, clear: number): number {
  const [c0, r0] = [Math.floor(x), Math.floor(y)];
  let near = Infinity;
  for (let r = r0 - 1; r <= r0 + 1; r++) {
    for (let c = c0 - 1; c <= c0 + 1; c++) {
      if (town.tile(c, r).kind !== "road") continue;
      const [px, py] = [c + 0.5, r + 0.5];
      near = Math.min(near, Math.hypot(x - px, y - py));
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!town.linked(c, r, c + dc, r + dr)) continue;
          // Along the line from this middle to the next, as far as it goes.
          const t = Math.max(0, Math.min(1, ((x - px) * dc + (y - py) * dr) / (dc * dc + dr * dr)));
          near = Math.min(near, Math.hypot(x - px - t * dc, y - py - t * dr));
        }
      }
    }
  }
  return clear - near;
}

/**
 * What a row of houses wears on its roof, as a height the roof is raised
 * to: in a row along a street, every fourth house steps forward under a
 * gable of its own, its ridge running to the street and its point on the
 * front, and the others each have a dormer on the front slope. Where the
 * main roof is higher it wins, so the gable's ridge dies into it and its
 * valleys fall out. Minus infinity where there is nothing.
 */
function dressing(town: Town, x: number, y: number): number {
  const at = frontOf(town, x, y);
  if (!at) return -Infinity;
  const { me, along, back, bay } = at;
  if (bay) return Math.abs(along) <= GABLE && back <= 0.6 ? eaves(me) + 0.26 * (1 - Math.abs(along) / GABLE) : -Infinity;
  return Math.abs(along) <= 0.12 && back >= 0.22 && back <= 0.36 ? eaves(me) + 0.18 : -Infinity;
}

/** For a point on a house in a row along a street: how far along the row
 *  from the house's middle, how far back from its front, and whether it is
 *  one that steps forward under a gable, every fourth. */
function frontOf(town: Town, x: number, y: number) {
  const [c, r] = [Math.floor(x), Math.floor(y)];
  const me = town.tile(c, r);
  if (me.kind !== "House") return null;
  const front = ([[0, 1], [0, -1], [1, 0], [-1, 0]] as const).find(([dc, dr]) => town.tile(c + dc, r + dr).kind === "road");
  if (!front) return null;
  const [fx, fy] = front;
  const along = fx ? y - r - 0.5 : x - c - 0.5;
  const back = 0.5 - ((x - c - 0.5) * fx + (y - r - 0.5) * fy);
  const inRow = kin(me, town.tile(c + fy, r + fx)) && kin(me, town.tile(c - fy, r - fx));
  return { me, along, back, bay: inRow && (fx ? r : c) % 4 === 1 };
}
/** How far a row of houses stands back behind its front gardens, and so
 *  how far a gabled house steps forward of it. */
const STEP = 0.12;
/** Half a front gable's width: nearly a house's, its point as high as the
 *  main ridge. */
const GABLE = 0.42;

/**
 * A shed as a business park has it: an office at its street end, a couple
 * of storeys over the hall and lighter, and rooflights across the hall's
 * roof, running the short way. Both are the building's, found from its
 * tiles: its long way is the way it is longer, and its head is the end,
 * right across, with the tile that has most street round it, the corner on
 * a junction if it has one. A workshop of a tile or three is a hall alone.
 */
function sheds(town: Town) {
  const key = (c: number, r: number) => `${c},${r}`;
  const heads = new Set<string>();
  const across = new Map<string, boolean>();
  const seen = new Set<string>();
  /** How much street is round a tile, the nearer the more: behind its
   *  yard, a shed's corner on the junction has most. */
  const street = (c: number, r: number) => {
    let n = 0;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) if (town.tile(c + dc, r + dr).kind === "road") n += 1 / (dc * dc + dr * dr);
    return n;
  };
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const me = town.tile(c, r);
      if (formOf(me).family !== "industry" || seen.has(key(c, r))) continue;
      seen.add(key(c, r));
      const cells = [[c, r]];
      for (let i = 0; i < cells.length; i++) {
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [x, y] = [cells[i][0] + dc, cells[i][1] + dr];
          if (kin(me, town.tile(x, y)) && !seen.has(key(x, y))) seen.add(key(x, y)), cells.push([x, y]);
        }
      }
      if (cells.length < 4) continue;
      const span = (k: number) => Math.max(...cells.map((p) => p[k])) - Math.min(...cells.map((p) => p[k]));
      const long = span(1) > span(0) ? 1 : 0;
      for (const [x, y] of cells) across.set(key(x, y), !!long);
      const ends = [Math.min(...cells.map((p) => p[long])), Math.max(...cells.map((p) => p[long]))];
      const head = cells.filter((p) => ends.includes(p[long])).reduce((a, b) => (street(b[0], b[1]) > street(a[0], a[1]) ? b : a));
      if (street(head[0], head[1])) for (const p of cells) if (p[long] === head[long]) heads.add(key(p[0], p[1]));
    }
  }
  const lifted: Town = { ...town, tile: (c, r) => (heads.has(key(c, r)) ? { ...town.tile(c, r), storeys: town.tile(c, r).storeys + 2 } : town.tile(c, r)) };
  /** How high a rooflight stands over the hall's roof `d` in from its edge:
   *  a sawtooth, a strip every tile, clear of the walls. */
  const rooflight = (x: number, y: number, d: number) => {
    const k = key(Math.floor(x), Math.floor(y));
    const run = across.get(k);
    if (run === undefined || heads.has(k) || d < 0.2) return 0;
    const p = (((run ? y : x) % 1) + 1) % 1;
    return Math.abs(p - 0.5) < 0.15 ? 0.25 * (p - 0.35) : 0;
  };
  return { town: lifted, head: (c: number, r: number) => heads.has(key(c, r)), rooflight };
}

type RGB = [number, number, number];

/**
 * The mesh of every building in the town, or of the tiles in `only`, in
 * world coordinates: the map is
 * drawn with +x to the screen's left and +y up, so the tile (c, r) lies at
 * x from -c - 1 to -c, y from -r - 1 to -r.
 */
export function massMesh(painted: Town, colour: (k: BuildingKind) => RGB, only?: Set<string>): MeshGeometry & { colors: number[] } {
  const { town, head, rooflight } = sheds(painted);
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], indices: number[] = [];
  type V = [number, number, number];
  /** One triangle in the fixture's frame, turned into the world's and wound
   *  to face along `n`, Babylon's front being the side the vertex order
   *  runs against. */
  const tri = (p: V, q: V, s: V, n: V, rgb: RGB) => {
    const world = (v: V): V => [-v[0], -v[1], v[2]];
    let [a, b, e] = [world(p), world(q), world(s)];
    const wn = world(n);
    const g = [(b[1] - a[1]) * (e[2] - a[2]) - (b[2] - a[2]) * (e[1] - a[1]), (b[2] - a[2]) * (e[0] - a[0]) - (b[0] - a[0]) * (e[2] - a[2]), (b[0] - a[0]) * (e[1] - a[1]) - (b[1] - a[1]) * (e[0] - a[0])];
    if (g[0] * wn[0] + g[1] * wn[1] + g[2] * wn[2] > 0) [b, e] = [e, b];
    const base = positions.length / 3;
    for (const v of [a, b, e]) {
      positions.push(...v);
      normals.push(...wn);
      colors.push(...rgb, 1);
    }
    indices.push(base, base + 1, base + 2);
  };
  const facing = (p: V, q: V, s: V): V => {
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
    let n: V = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    n = n.map((x) => x / len) as V;
    return n[2] < 0 ? (n.map((x) => -x) as V) : n;
  };
  const wall = (p: [number, number], q: [number, number], z0p: number, z0q: number, zp: number, zq: number, away: [number, number], rgb: RGB) => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    let n: V = [(q[1] - p[1]) / len, -(q[0] - p[0]) / len, 0];
    if (n[0] * away[0] + n[1] * away[1] < 0) n = [-n[0], -n[1], 0];
    tri([p[0], p[1], z0p], [q[0], q[1], z0q], [q[0], q[1], zq], n, rgb);
    tri([p[0], p[1], z0p], [q[0], q[1], zq], [p[0], p[1], zp], n, rgb);
  };

  // Which roof stands over each sample, a metre square's middle: a family
  // and a height, one roof; open ground none. A roof climbs with the
  // distance to the nearest sample of anything else, measured over the
  // whole town at once, so tiles of one roof agree where they meet and a
  // row stepping on the diagonal has one ridge.
  const roofs = new Map<string, number>();
  const roofOf = (t: Tile) => roofs.get(`${formOf(t).family}:${t.storeys}`) ?? roofs.set(`${formOf(t).family}:${t.storeys}`, roofs.size).get(`${formOf(t).family}:${t.storeys}`)!;
  // First every sample's building, then how deep into its block each lies:
  // a building is only so deep from the edge of its block, and deeper is the
  // block's inside, open, a courtyard. So a block of houses is a ring round
  // a garden however it was painted, and a shed is as deep as it likes.
  const [W, H] = [town.w * RES, town.h * RES];
  const built = new Uint8Array(W * H);
  const owner: (Tile | null)[] = new Array(W * H).fill(null);
  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const me = buildingOn(town, c, r);
      if (!me) continue;
      for (let j = 0; j < RES; j++) {
        for (let i = 0; i < RES; i++) {
          const k = (r * RES + j) * W + c * RES + i;
          // The block is its tiles: depth is from their edge, so a
          // courtyard's side is straight whatever the fronts do.
          built[k] = 1;
          if (outside(town, c, r, c + (i + 0.5) / RES, r + (j + 0.5) / RES) < 0) owner[k] = me;
        }
      }
    }
  }
  const deep = distances(built, W, H);
  /** How far into its block the point is, in tiles, from the samples round it. */
  const into = (x: number, y: number) => {
    const [gx, gy] = [x * RES - 0.5, y * RES - 0.5];
    const [i, j] = [Math.floor(gx), Math.floor(gy)];
    const [fx, fy] = [gx - i, gy - j];
    const at = (a: number, b: number) => deep[Math.min(H - 1, Math.max(0, b)) * W + Math.min(W - 1, Math.max(0, a))];
    const top = at(i, j) * (1 - fx) + at(i + 1, j) * fx;
    const bottom = at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx;
    return (top * (1 - fy) + bottom * fy - 0.5) / RES;
  };
  const under = new Int32Array(W * H).fill(-1);
  for (let k = 0; k < W * H; k++) {
    const t = owner[k];
    if (t && (deep[k] - 0.5) / RES <= formOf(t).depth) under[k] = roofOf(t);
  }
  const REACH = Math.ceil(0.4 * RES);
  /** How far in from the edge of its roof the point is, as far as a roof
   *  climbs. */
  const inward = (x: number, y: number, id: number) => {
    const [gi, gj] = [Math.floor(x * RES), Math.floor(y * RES)];
    let near = REACH / RES;
    for (let j = gj - REACH; j <= gj + REACH; j++) {
      for (let i = gi - REACH; i <= gi + REACH; i++) {
        const other = i < 0 || j < 0 || i >= W || j >= H || under[j * W + i] !== id;
        if (other) near = Math.min(near, Math.hypot(x - (i + 0.5) / RES, y - (j + 0.5) / RES) - 0.5 / RES);
      }
    }
    return Math.max(0, near);
  };
  const height = (t: Tile, x: number, y: number) => {
    const d = inward(x, y, roofOf(t));
    return Math.max(eaves(t) + rise(t, d) + rooflight(x, y, d), dressing(town, x, y));
  };

  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const me = buildingOn(town, c, r);
      if (!me || (only && !only.has(`${c},${r}`))) continue;
      const rgb = colour(me.kind as BuildingKind).map((v) => (head(c, r) ? v + (1 - v) * 0.45 : v)) as RGB;
      const top = eaves(me);
      // The tile's samples: how far outside, and how high the roof over it.
      const roof = (x: number, y: number) => height(me, x, y);
      const f: number[] = [], h: number[] = [];
      for (let j = 0; j <= RES; j++) {
        for (let i = 0; i <= RES; i++) {
          const [x, y] = [c + i / RES, r + j / RES];
          f.push(Math.max(outside(town, c, r, x, y), into(x, y) - formOf(me).depth));
          h.push(roof(x, y));
        }
      }
      const at = (i: number, j: number) => j * (RES + 1) + i;

      for (let j = 0; j < RES; j++) {
        for (let i = 0; i < RES; i++) {
          // The cell cut down to the building: its corners inside, and where
          // an edge crosses the outline, the eave.
          const corners: [number, number][] = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
          const poly: { p: V; eave: boolean }[] = [];
          corners.forEach(([ci, cj], k) => {
            const [ni, nj] = corners[(k + 1) % 4];
            const [f0, f1] = [f[at(ci, cj)], f[at(ni, nj)]];
            if (f0 < 0) poly.push({ p: [c + ci / RES, r + cj / RES, h[at(ci, cj)]], eave: false });
            if (f0 < 0 !== f1 < 0) {
              const t = f0 / (f0 - f1);
              const [x, y] = [c + (ci + (ni - ci) * t) / RES, r + (cj + (nj - cj) * t) / RES];
              // The wall stands to the eaves, or up a gable to its point.
              poly.push({ p: [x, y, Math.max(top, dressing(town, x, y))], eave: true });
            }
          });
          if (poly.length < 3) continue;
          // A whole cell is split along whichever diagonal its roof creases
          // on, the one whose middle is the roof's middle: split across a
          // hip instead, the ink sees every cell's fold.
          if (poly.length === 4 && !poly.some((v) => v.eave)) {
            const mid = roof(c + (i + 0.5) / RES, r + (j + 0.5) / RES);
            if (Math.abs((poly[1].p[2] + poly[3].p[2]) / 2 - mid) < Math.abs((poly[0].p[2] + poly[2].p[2]) / 2 - mid)) poly.push(poly.shift()!);
          }
          for (let k = 1; k + 1 < poly.length; k++) {
            const [p, q, s] = [poly[0].p, poly[k].p, poly[k + 1].p];
            tri(p, q, s, facing(p, q, s), rgb);
          }
          // Two eaves in a row round the cut cell are a stretch of outline:
          // a wall down from it, facing away from the cell's inside.
          const mid = poly.reduce(([x, y], { p }) => [x + p[0] / poly.length, y + p[1] / poly.length], [0, 0]);
          for (let k = 0; k < poly.length; k++) {
            const [p, q] = [poly[k], poly[(k + 1) % poly.length]];
            if (!p.eave || !q.eave) continue;
            const m = [(p.p[0] + q.p[0]) / 2, (p.p[1] + q.p[1]) / 2];
            wall([p.p[0], p.p[1]], [q.p[0], q.p[1]], 0, 0, p.p[2], q.p[2], [m[0] - mid[0], m[1] - mid[1]], rgb);
          }
        }
      }

      // Where a lower roof meets this one at the tile's edge, the step
      // between them, built from this, the taller side.
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const them = buildingOn(town, c + dc, r + dr);
        if (!them) continue;
        const edge = (k: number): [number, number] =>
          dc ? [c + (dc > 0 ? 1 : 0), r + k / RES] : [c + k / RES, r + (dr > 0 ? 1 : 0)];
        const theirs = (x: number, y: number) => height(them, x, y);
        const mine = (k: number) => (dc ? h[at(dc > 0 ? RES : 0, k)] : h[at(k, dr > 0 ? RES : 0)]);
        const inside = (k: number) => (dc ? f[at(dc > 0 ? RES : 0, k)] : f[at(k, dr > 0 ? RES : 0)]) < 0;
        const theirsInside = (k: number) => Math.max(outside(town, c + dc, r + dr, ...edge(k)), into(...edge(k)) - formOf(them).depth) < 0;
        for (let k = 0; k < RES; k++) {
          if (!inside(k) || !inside(k + 1) || !theirsInside(k) || !theirsInside(k + 1)) continue;
          const [p, q] = [edge(k), edge(k + 1)];
          const [tp, tq] = [theirs(...p), theirs(...q)];
          if (mine(k) <= tp + 1e-4 && mine(k + 1) <= tq + 1e-4) continue;
          wall(p, q, tp, tq, mine(k), mine(k + 1), [dc, dr], rgb);
        }
      }
    }
  }
  return { positions, normals, colors, indices };
}
