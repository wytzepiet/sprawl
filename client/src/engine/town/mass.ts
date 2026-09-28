import type { MeshGeometry } from "../Mesh";
import type { BuildingKind } from "../../generated";
import { isBuilt, type Tile, type Town } from "./grid";

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

/** How far a building stands back from each kind of neighbour. */
const SETBACK: Record<string, number> = { road: 0.03, water: 0.02, open: 0.14, wood: 0.14 };
/** How far in from the corner a street corner is cut, and a corner a
 *  street runs across: clear of the road and its kerb. */
const CHAMFER = 0.2;
const CROSSED = 0.42;

const INDUSTRY = new Set<string>(["Workshop", "Factory", "Warehouse", "Supermarket", "GasStation"]);

/** The walls' height, and the roof that climbs from them `d` in. */
export const eaves = (t: Tile) => 0.1 + 0.12 * t.storeys;
function rise(t: Tile, d: number) {
  if (INDUSTRY.has(t.kind)) return Math.min(d * 0.25, 0.06);
  return t.storeys <= 3 ? Math.min(d * 0.75, 0.26) : Math.min(d * 0.5, 0.03);
}

type Joins = (a: Tile, b: Tile) => boolean;
/** The outline joins any building; a roof only one as tall. */
const FOOT: Joins = (_, b) => isBuilt(b);
const ROOF: Joins = (a, b) => isBuilt(b) && b.storeys === a.storeys;

/**
 * How far outside tile (c, r)'s building the point (x, y) is, as the
 * largest of its quarter's lines; below zero, inside. Joined sides draw no
 * line, so a building's inside does not end at a tile's edge.
 */
export function outside(town: Town, c: number, r: number, x: number, y: number, joins: Joins = FOOT): number {
  const me = town.tile(c, r);
  const [sx, sy] = [x < c + 0.5 ? -1 : 1, y < r + 0.5 ? -1 : 1];
  const [u, w] = [Math.abs(x - c - 0.5), Math.abs(y - r - 0.5)];
  const [a, b, d] = [town.tile(c + sx, r), town.tile(c, r + sy), town.tile(c + sx, r + sy)];
  const gap = (t: Tile) => (isBuilt(t) ? 0 : SETBACK[t.kind]);
  let f = -1;
  const [ja, jb] = [joins(me, a), joins(me, b)];
  if (!ja) f = Math.max(f, u - 0.5 + gap(a));
  if (!jb) f = Math.max(f, w - 0.5 + gap(b));
  if (ja && jb && !joins(me, d)) {
    const edge = 0.5 - gap(d);
    f = Math.max(f, Math.min(u - edge, w - edge));
  }
  if (a.kind === "road" && b.kind === "road") {
    const cut = town.linked(c + sx, r, c, r + sy) ? CROSSED : CHAMFER;
    f = Math.max(f, (cut - (1 - u - w)) / Math.SQRT2);
  }
  return f;
}

type RGB = [number, number, number];

/**
 * The mesh of every building in the town, in world coordinates: the map is
 * drawn with +x to the screen's left and +y up, so the tile (c, r) lies at
 * x from -c - 1 to -c, y from -r - 1 to -r.
 */
export function massMesh(town: Town, colour: (k: BuildingKind) => RGB): MeshGeometry & { colors: number[] } {
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

  for (let r = 0; r < town.h; r++) {
    for (let c = 0; c < town.w; c++) {
      const me = town.tile(c, r);
      if (!isBuilt(me)) continue;
      const rgb = colour(me.kind as BuildingKind);
      const top = eaves(me);
      // The tile's samples: how far outside, and how high the roof over it.
      const roof = (x: number, y: number) => top + rise(me, Math.max(0, -outside(town, c, r, x, y, ROOF)));
      const f: number[] = [], h: number[] = [];
      for (let j = 0; j <= RES; j++) {
        for (let i = 0; i <= RES; i++) {
          const [x, y] = [c + i / RES, r + j / RES];
          f.push(outside(town, c, r, x, y));
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
              poly.push({ p: [c + (ci + (ni - ci) * t) / RES, r + (cj + (nj - cj) * t) / RES, top], eave: true });
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
            wall([p.p[0], p.p[1]], [q.p[0], q.p[1]], 0, 0, top, top, [m[0] - mid[0], m[1] - mid[1]], rgb);
          }
        }
      }

      // Where a lower roof meets this one at the tile's edge, the step
      // between them, built from this, the taller side.
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const them = town.tile(c + dc, r + dr);
        if (!isBuilt(them)) continue;
        const edge = (k: number): [number, number] =>
          dc ? [c + (dc > 0 ? 1 : 0), r + k / RES] : [c + k / RES, r + (dr > 0 ? 1 : 0)];
        const theirs = (x: number, y: number) =>
          eaves(them) + rise(them, Math.max(0, -outside(town, c + dc, r + dr, x, y, ROOF)));
        const mine = (k: number) => (dc ? h[at(dc > 0 ? RES : 0, k)] : h[at(k, dr > 0 ? RES : 0)]);
        const inside = (k: number) => (dc ? f[at(dc > 0 ? RES : 0, k)] : f[at(k, dr > 0 ? RES : 0)]) < 0;
        for (let k = 0; k < RES; k++) {
          if (!inside(k) || !inside(k + 1)) continue;
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
