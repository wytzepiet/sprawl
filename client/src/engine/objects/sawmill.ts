import type { EngineContext, MaterialPlugin } from "@babylonjs/lite";
import type { Manifold, Vec3 } from "manifold-3d";
import { BARK_ALONG, BARK_LONG, BARK_ROUND } from "../bark";
import barkRecipe from "../bark.ts?raw";
import { bakedTexture } from "../bakeCache";
import type { MeshGeometry } from "../geometry";
import { grain } from "../ground";
import { mesh, Solid, solids } from "../solid";
import { shape, type Part, type Shape } from "./sea";
import type { RGB } from "../rgb";

/**
 * A sawmill, whole: the hall, its wing, its yard and all that stands in
 * it, one model on its plot, as `docs/style.md`'s board drew it. Its plot
 * two tiles across (x, -1 to 1) and four deep (y), the street at +y, the
 * woods behind at -y; its ground on z = 0.
 *
 * - At the back, the long hall: a pitched roof, its ridge along the
 *   street, four small gables along its back, clad in planks; a zinc
 *   lean-to on its left, and a zinc canopy along its front where the
 *   logs go in.
 * - Down the right, the wing: a barn, its gable end and its big door to
 *   the yard, a zinc lean-to down its side, the brick chimney behind.
 * - The yard's left half is wood chips: the water tower on its legs at
 *   the back, the conveyor up into the hall, sawdust heaped round its
 *   foot, three stacks of logs; a fence along the side.
 * - Its right half the lorries': the lane up to the wing's door, the
 *   bundles on their pad beside it (`pads.ts`), and across it the one
 *   dock (`Blueprint::docks`).
 *
 * Five finishes, a bucket each: its timber and brick matte; the zinc
 * golfplaat, corrugated metal, its waves in the light alone; the logs'
 * bark, baked (`bark.ts`); the sawdust and the chips under it, lumpy,
 * frayed at their edges as the grass is (`ground.ts`).
 */

const ROOF: RGB = [0.5, 0.35, 0.25];
const RIB: RGB = [0.42, 0.29, 0.21];
const WALL: RGB = [0.52, 0.34, 0.22];
const TRIM: RGB = [0.42, 0.27, 0.18];
const ZINC: RGB = [0.72, 0.74, 0.77];
const DOOR: RGB = [0.2, 0.24, 0.32];
const BRICK: RGB = [0.62, 0.3, 0.22];
const CHIPS: RGB = [0.58, 0.42, 0.29];
const SAWDUST: RGB = [0.84, 0.65, 0.42];
const BARK: RGB = [0.56, 0.39, 0.24];
const END: RGB = [0.89, 0.76, 0.56];
const STEEL: RGB = [0.46, 0.48, 0.52];
const BELT: RGB = [0.27, 0.27, 0.28];
const TANK: RGB = [0.58, 0.42, 0.28];
const HOOP: RGB = [0.32, 0.33, 0.36];

type V = Vec3;
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];

/** A box from corner to corner. */
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
  Solid.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0]);
/** The solid round some points. */
const hull = (points: V[]) => Solid.hull(points);
/** A sheet `t` thick on the parallelogram from `o` along `u` and `v`. */
const sheet = (o: V, u: V, v: V, t: number) => {
  const up: V = [0, 0, t];
  return hull([o, add(o, u), add(o, v), add(add(o, u), v)].flatMap((p) => [p, add(p, up)]));
};
/** A roof's sheet with ribs down it, `n` of them along `u`. */
const ribbed = (o: V, u: V, v: V, t: number, n: number, rib = 0.012): [Manifold, Manifold] => {
  const ribs = Array.from({ length: n }, (_, k) => {
    const at = add(o, scale(u, (k + 0.5) / n));
    const half = scale(u, rib / 2 / Math.hypot(...u));
    return sheet(add(add(at, scale(half, -1)), [0, 0, t]), scale(half, 2), v, 0.008);
  });
  return [sheet(o, u, v, t), Solid.union(ribs)];
};
/** A body whose ridge runs along x at y = `ridgeY`, walls to `eave`,
 *  gable ends to `ridge`. */
const barnX = (x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number, ridgeY = (y0 + y1) / 2) =>
  hull([x0, x1].flatMap((x): V[] => [[x, y0, 0], [x, y1, 0], [x, y0, eave], [x, y1, eave], [x, ridgeY, ridge]]));
const barnY = (x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number) =>
  hull([y0, y1].flatMap((y): V[] => [[x0, y, 0], [x1, y, 0], [x0, y, eave], [x1, y, eave], [(x0 + x1) / 2, y, ridge]]));
/** Round a log: this many sides, smooth, its bark's map once round. */
const SIDES = 12;
let logs = 0;
/** A log `r` round and `l` long, its middle at `at`, lying along x or y:
 *  its bark, closed at its ends, and its ends' pale wood. */
const log = (at: V, r: number, l: number, along: "x" | "y"): { bark: MeshGeometry; ends: MeshGeometry } => {
  // Along, and the two ways round it, right-handed.
  const [a, s, z]: V[] = along === "x" ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : [[0, 1, 0], [-1, 0, 0], [0, 0, 1]];
  const round = (k: number): V => add(scale(s, Math.cos((2 * Math.PI * k) / SIDES)), scale(z, Math.sin((2 * Math.PI * k) / SIDES)));
  const from = (logs++ * 0.37) % 1;
  const bark: MeshGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  for (let k = 0; k <= SIDES; k++)
    for (const e of [-1, 1]) {
      bark.positions.push(...add(add(at, scale(a, (e * l) / 2)), scale(round(k), r)));
      bark.normals.push(...round(k));
      bark.uvs!.push(k / SIDES, from + ((e + 1) * l) / 2 / BARK_ALONG);
    }
  for (let k = 0; k < SIDES; k++) bark.indices.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2);
  const ends: MeshGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  const cap = (into: MeshGeometry, e: number, rr: number, out: number) => {
    const base = into.positions.length / 3;
    const mid = add(at, scale(a, e * (l / 2 + out)));
    for (const p of [mid, ...Array.from({ length: SIDES }, (_, k) => add(mid, scale(round(k), rr)))]) into.positions.push(...p), into.normals.push(...scale(a, e)), into.uvs!.push(0, 0);
    for (let k = 0; k < SIDES; k++) {
      const [p, q] = [base + 1 + k, base + 1 + ((k + 1) % SIDES)];
      into.indices.push(...(e > 0 ? [base, q, p] : [base, p, q]));
    }
  };
  for (const e of [-1, 1]) cap(bark, e, r, 0), cap(ends, e, r * 0.84, 0.002);
  return { bark, ends };
};
/** A stack of logs, layers of them each one fewer, along x or y, its
 *  middle at (x, y), `n` across at the bottom. */
const stack = (x: number, y: number, along: "x" | "y", l: number, n: number, r = 0.035) => {
  const out: ReturnType<typeof log>[] = [];
  for (let layer = 0; layer < n - 1; layer++)
    for (let k = 0; k < n - layer; k++) {
      const off = (k - (n - layer - 1) / 2) * 2 * r;
      const z = r + layer * r * 1.73;
      out.push(log(along === "x" ? [x, y + off, z] : [x + off, y, z], r, l, along));
    }
  return out;
};

/** Corrugated sheet's waves, a wave this far across. */
const PITCH = 0.05;
/** A zinc sheet `t` thick on the parallelogram from `o` along `u` and
 *  `v`, its waves running down `v`: mapped by how many waves across `u`. */
const golf = (o: V, u: V, v: V, t: number) => {
  const across = Math.hypot(...u);
  return mesh(sheet(o, u, v, t), (p) => [((p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1] + (p[2] - o[2]) * u[2]) / across / PITCH, 0]);
};

/** A heap of sawdust at (x, y), its foot `r` out and its top `h` up, on
 *  ground `z` up: lobed, lumpy, a thin spill of it round its foot out to
 *  `SPILL` of its reach, mapped by how far out it is, its edge at 1. */
const SPILL = 1.45;
const RINGS = [0.2, 0.4, 0.58, 0.72, 0.84, 0.93, 1, 1.12, 1.28, SPILL];
const heap = (x: number, y: number, r: number, h: number, z: number, seed: number): MeshGeometry => {
  const segs = 28;
  const [p1, p2, p3] = [seed * 1.7, seed * 2.9, seed * 4.3];
  const reach = (t: number) => r * (1 + 0.16 * Math.sin(2 * t + p1) + 0.09 * Math.sin(3 * t + p2) + 0.05 * Math.sin(5 * t + p3));
  const rise = (f: number, t: number) => (f < 1 ? h * (1 - f * f) ** 1.4 * (1 + 0.18 * Math.sin(4 * t + p2) * f) : 0) + 0.0015;
  const out: MeshGeometry = { positions: [x, y, z + rise(0, 0)], normals: [], uvs: [0, 0], indices: [] };
  for (const f of RINGS)
    for (let k = 0; k < segs; k++) {
      const t = (2 * Math.PI * k) / segs;
      out.positions.push(x + Math.cos(t) * reach(t) * f, y + Math.sin(t) * reach(t) * f, z + rise(f, t));
      out.uvs!.push(f, 0);
    }
  const at = (ring: number, k: number) => 1 + ring * segs + (k % segs);
  for (let k = 0; k < segs; k++) {
    out.indices.push(0, at(0, k + 1), at(0, k));
    for (let ring = 0; ring + 1 < RINGS.length; ring++) out.indices.push(at(ring, k), at(ring, k + 1), at(ring + 1, k + 1), at(ring, k), at(ring + 1, k + 1), at(ring + 1, k));
  }
  return smooth(out);
};

/** A mesh's facing at each vertex, the faces' round it, by their size. */
function smooth(g: MeshGeometry): MeshGeometry {
  const n = new Array<number>(g.positions.length).fill(0);
  const p = (i: number): V => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
  for (let t = 0; t < g.indices.length; t += 3) {
    const [a, b, c] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
    const [u, w] = [add(p(b), scale(p(a), -1)), add(p(c), scale(p(a), -1))];
    // Wound clockwise from outside: c - a across b - a faces out.
    const f: V = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
    for (const i of [a, b, c]) for (let j = 0; j < 3; j++) n[i * 3 + j] += f[j];
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= len, n[i + 1] /= len, n[i + 2] /= len;
  }
  return { ...g, normals: n };
}

/** The chips' two halves of the yard, either side of the lorries' dock,
 *  x and y from and to; mapped by where they are, so the coat knows how
 *  far in from their edge (`loose`). */
const CHIP_YARDS = [[-0.97, 0.15, -1.0, 0.32], [-0.97, 0.15, 0.8, 1.92]];

const SAWMILL = solids(() => {
  const wood: Part[] = [], zinc: Part[] = [], bark: Part[] = [], dust: Part[] = [], chips: Part[] = [];
  const put = (solid: Manifold, rgb: RGB) => wood.push([mesh(solid), [0, 0, 0], rgb]);
  const roof = ([s, r]: [Manifold, Manifold], a: RGB, b: RGB) => (put(s, a), put(r, b));
  const zinced = (geo: MeshGeometry) => zinc.push([geo, [0, 0, 0], ZINC]);
  const logged = (l: ReturnType<typeof log>) => (bark.push([l.bark, [0, 0, 0], BARK]), wood.push([l.ends, [0, 0, 0], END]));

  // The ground: wood chips over the yard's left half, out to the lorries' lane.
  // Thick enough to show over the hall's paving, which stands a little higher.
  chips.push([mesh(Solid.union(CHIP_YARDS.map(([x0, x1, y0, y1]) => box(x0, x1, y0, y1, 0, 0.016))), (p) => [p[0], p[1]]), [0, 0, 0], CHIPS]);

  // The hall, at the back.
  const [hx0, hx1, hy0, hy1, he, hr, hRidgeY] = [-0.78, 0.5, -1.86, -1.0, 0.2, 0.42, -1.62];
  put(barnX(hx0, hx1, hy0, hy1, he, hr, hRidgeY), WALL);
  const o = 0.05;
  /** Down a roof from its ridge, `run` out to its wall and `out` past it. */
  const down = (run: number, out: number, rise: number, along: "x" | "y"): V => {
    const d = run + Math.sign(run) * out, z = -(rise * Math.abs(d)) / Math.abs(run);
    return along === "x" ? [d, 0, z] : [0, d, z];
  };
  // Its front slope, long, from the ridge down past the front wall; its
  // back slope, short, and the four gables along it.
  roof(ribbed([hx0 - o, hRidgeY, hr], [hx1 - hx0 + 2 * o, 0, 0], down(hy1 - hRidgeY, o, hr - he, "y"), 0.014, 26), ROOF, RIB);
  roof(ribbed([hx0 - o, hRidgeY, hr], [hx1 - hx0 + 2 * o, 0, 0], down(hy0 - hRidgeY, o, hr - he, "y"), 0.014, 26), ROOF, RIB);
  const gw = (hx1 - hx0) / 4;
  for (let k = 0; k < 4; k++) {
    const [gx0, gx1] = [hx0 + k * gw + 0.02, hx0 + (k + 1) * gw - 0.02];
    const mid = (gx0 + gx1) / 2;
    put(barnY(gx0, gx1, hy0, hRidgeY, he, hr), WALL);
    for (const s of [-1, 1]) roof(ribbed([mid, hy0 - o, hr + 0.004], [0, hRidgeY - hy0 + o, 0], down(s * (gx1 - gx0) / 2, 0.03, hr - he, "x"), 0.012, 6), ROOF, RIB);
  }
  // A zinc lean-to down its left side, and a zinc canopy along its front.
  zinced(golf([hx0 - 0.005, hy0 + 0.08, 0.17], [0, -0.8 - hy0, 0], [-0.21, 0, -0.07], 0.01));
  put(box(-0.98, hx0, hy0 + 0.1, -0.75, 0, 0.1), TRIM);
  zinced(golf([hx0 + 0.07, hy1 - 0.005, 0.19], [0.82, 0, 0], [0, 0.3, -0.05], 0.01));
  for (const x of [hx0 + 0.1, hx0 + 0.47, hx0 + 0.86]) put(box(x - 0.012, x + 0.012, hy1 + 0.27, hy1 + 0.294, 0, 0.145), TRIM);
  put(box(-0.26, -0.02, hy1 - 0.002, hy1 + 0.004, 0, 0.15), DOOR);

  // The wing, down the right: a barn, its gable to the yard.
  const [wx0, wx1, wy0, wy1, we, wr] = [0.22, 0.76, -1.78, -0.02, 0.24, 0.5];
  put(barnY(wx0, wx1, wy0, wy1, we, wr), WALL);
  for (const s of [-1, 1]) roof(ribbed([(wx0 + wx1) / 2, wy0 - 0.05, wr], [0, wy1 - wy0 + 0.1, 0], down(s * (wx1 - wx0) / 2, 0.06, wr - we, "x"), 0.016, 22), ROOF, RIB);
  put(box(0.38, 0.6, wy1 - 0.004, wy1 + 0.006, 0, 0.19), DOOR);
  put(box(0.36, 0.62, wy1 - 0.004, wy1 + 0.012, 0.19, 0.21), TRIM);
  zinced(golf([wx1 + 0.005, -1.25, 0.18], [0, 1.4, 0], [0.22, 0, -0.07], 0.01));
  for (const y of [-1.15, -0.5, 0.1]) put(box(0.95, 0.975, y - 0.012, y + 0.012, 0, 0.11), TRIM);
  // Its chimney, brick, behind the wing.
  put(box(0.78, 0.9, -1.62, -1.5, 0, 0.72).add(box(0.765, 0.915, -1.635, -1.485, 0.68, 0.72)), BRICK);

  // The water tower at the yard's back, on four braced legs.
  const [tx, ty, legs, tr, th] = [-0.8, -0.62, 0.26, 0.15, 0.2];
  const frame = Solid.union([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) =>
    hull([[tx + sx * 0.13, ty + sy * 0.13, 0], [tx + sx * 0.15, ty + sy * 0.15, 0], [tx + sx * 0.1, ty + sy * 0.1, legs], [tx + sx * 0.12, ty + sy * 0.12, legs]])))
    .add(box(tx - 0.13, tx + 0.13, ty - 0.13, ty + 0.13, legs - 0.02, legs));
  const braces = Solid.union([-1, 1].flatMap((s) => [
    hull([[tx - 0.13, ty + s * 0.135, 0.02], [tx - 0.13, ty + s * 0.135, 0.04], [tx + 0.11, ty + s * 0.115, legs - 0.04], [tx + 0.11, ty + s * 0.115, legs - 0.02]]),
    hull([[tx + s * 0.135, ty - 0.13, 0.02], [tx + s * 0.135, ty - 0.13, 0.04], [tx + s * 0.115, ty + 0.11, legs - 0.04], [tx + s * 0.115, ty + 0.11, legs - 0.02]]),
  ]));
  put(frame.add(braces), TRIM);
  put(Solid.cylinder(th, tr, tr, 16).translate([tx, ty, legs]), TANK);
  put(Solid.union([0.04, 0.1, 0.16].map((h) => Solid.cylinder(0.012, tr + 0.006, tr + 0.006, 16).translate([tx, ty, legs + h]))), HOOP);
  put(Solid.cylinder(0.08, tr + 0.02, 0.015, 16).translate([tx, ty, legs + th]), ROOF);

  // The conveyor, from the yard up under the canopy into the hall.
  const [cx, cw, c0, c1, z0, z1] = [-0.14, 0.09, 0.28, -1.0, 0.03, 0.17];
  const slope = (zLo: number, zHi: number, half: number) =>
    hull([[cx - half, c0, zLo], [cx + half, c0, zLo], [cx - half, c0, zHi], [cx + half, c0, zHi], [cx - half, c1, zLo + z1 - z0], [cx + half, c1, zLo + z1 - z0], [cx - half, c1, zHi + z1 - z0], [cx + half, c1, zHi + z1 - z0]]);
  const rise = (y: number) => z0 + ((z1 - z0) * (c0 - y)) / (c0 - c1);
  put(slope(z0, z0 + 0.03, cw / 2).subtract(slope(z0 + 0.016, z0 + 0.05, cw / 2 - 0.01))
    .add(Solid.union([0.2, -0.2, -0.6].flatMap((y) => [-1, 1].map((s) => box(cx + s * (cw / 2 - 0.006) - 0.006, cx + s * (cw / 2 - 0.006) + 0.006, y - 0.006, y + 0.006, 0, rise(y)))))), STEEL);
  put(slope(z0, z0 + 0.017, cw / 2 - 0.01), BELT);
  for (const y of [0.15, -0.2, -0.55]) logged(log([cx, y, rise(y) + 0.036], 0.02, cw - 0.025, "x"));
  // Sawdust heaped about its foot and by the canopy, on the chips.
  [[-0.34, -0.55, 0.15, 0.035], [0.05, -0.62, 0.12, 0.03], [-0.02, 1.05, 0.14, 0.035], [-0.3, 1.32, 0.09, 0.024]].forEach(([x, y, r, h], k) =>
    dust.push([heap(x, y, r, h, 0.016, k + 1), [0, 0, 0], SAWDUST]));

  // Three stacks of logs on the chips.
  for (const l of [...stack(-0.47, 0.18, "x", 0.42, 5), ...stack(-0.8, 1.2, "y", 0.5, 4), ...stack(-0.68, 1.6, "x", 0.44, 4)]) logged(l);
  // A fence along the side.
  put(Solid.union([
    box(-0.99, -0.975, -0.72, 1.9, 0.065, 0.08),
    box(-0.99, -0.975, -0.72, 1.9, 0.025, 0.04),
    ...Array.from({ length: 11 }, (_, k) => box(-0.995, -0.97, -0.72 + k * 0.26, -0.7 + k * 0.26, 0, 0.1)),
  ]), TRIM);

  return { wood: shape(wood), zinc: shape(zinc), bark: shape(bark), dust: shape(dust), chips: shape(chips) };
});

/** Where its forklift comes out of the wing's door, to the gate's side. */
export const BARN_DOOR: [number, number] = [0.49, 0.1];

/** How far zinc's waves turn the light, how dark their troughs, how rough
 *  the metal; how big the sawdust's lumps and its flecks, as the land's
 *  grain is read over them (`ground.ts`, 256 texels). */
const [ZINC_TILT, ZINC_TROUGH, ZINC_ROUGH] = [0.55, 0.12, 0.35];
const [DUST_LUMPS, DUST_FLECKS, CHIP_SPECKS] = [3.5, 1.6, 0.7];
/** How far in from its edge the chips fray. */
const CHIPS_FRAY = 0.05;

/** The sawmill's finishes, an engine's: matte timber and brick; zinc,
 *  metal, its waves across `PITCH` turning the light and shading their
 *  troughs, faded out where they are finer than the pixels; bark, its
 *  map's slopes turning the light and its furrows dark; sawdust and
 *  chips, `loose`.
 *  The slopes are turned along the surface by the map's own run over it,
 *  read off the pixels beside (a cotangent frame). */
const COATS = new WeakMap<EngineContext, Record<Finish, MaterialPlugin>>();
type Finish = keyof typeof SAWMILL;
const f = (x: number) => x.toFixed(4);
const frame = (p: string) => `let ${p}Dp1 = dpdx(input.worldPos);
let ${p}Dp2 = dpdy(input.worldPos);
let ${p}Du1 = dpdx(input.uv);
let ${p}Du2 = dpdy(input.uv);
let ${p}T = cross(${p}Dp2, N) * ${p}Du1.x + cross(N, ${p}Dp1) * ${p}Du2.x;
let ${p}B = cross(${p}Dp2, N) * ${p}Du1.y + cross(N, ${p}Dp1) * ${p}Du2.y;
let ${p}Inv = inverseSqrt(max(max(dot(${p}T, ${p}T), dot(${p}B, ${p}B)), 1e-14));`;
const coat = (name: string, code: string, textures: (engine: EngineContext) => Record<string, Parameters<NonNullable<MaterialPlugin["bindTextures"]>>[0][number]["texture"]> = () => ({})) =>
  (engine: EngineContext): MaterialPlugin => {
    const bound = Object.entries(textures(engine));
    return {
      name,
      priority: 900,
      ...(bound.length ? { getSamplers: () => bound.map(([t]) => ({ texture: t, sampler: `${t}Sampler` })), bindTextures: (out) => out.push(...bound.map(([, texture]) => ({ texture }))) } : {}),
      getCustomCode: (stage) => (stage === "fragment" ? { CUSTOM_FRAGMENT_UPDATE_DIFFUSE: code } : null),
    };
  };
const MAKE: Record<Finish, (engine: EngineContext) => MaterialPlugin> = {
  wood: coat("MillWood", "roughness = 0.8;"),
  zinc: coat("MillZinc", `${frame("zinc")}
let zincWave = 6.2832 * input.uv.x;
let zincFine = 1. - smoothstep(0.25, 0.5, fwidth(input.uv.x));
N = normalize(N + zincT * zincInv * sin(zincWave) * ${f(ZINC_TILT)} * zincFine);
baseColor = baseColor * (1. - ${f(ZINC_TROUGH)} * (0.5 - 0.5 * cos(zincWave)) * zincFine);
metallic = 1.;
roughness = ${f(ZINC_ROUGH)};`),
  bark: coat("MillBark", `${frame("bark")}
let barkMap = textureSample(millBark, millBarkSampler, input.uv);
let barkTilt = barkMap.rg * 2. - 1.;
N = normalize(N + (barkT * barkTilt.x + barkB * barkTilt.y) * barkInv);
baseColor = baseColor * barkMap.b;
roughness = 0.95;`, (engine) => ({ millBark: bark(engine) })),
  dust: loose("MillDust", `input.uv.x > 0.94 + ${f(SPILL - 0.94)} * looseLump * looseLump`, 0.86, 0.26),
  // How far in from the yard's edge, the nearer of its two halves'.
  chips: loose("MillChips", `max(${CHIP_YARDS.map(([x0, x1, y0, y1]) => `min(min(input.uv.x - ${f(x0)}, ${f(x1)} - input.uv.x), min(input.uv.y - ${f(y0)}, ${f(y1)} - input.uv.y))`).join(", ")}) < ${f(CHIPS_FRAY)} * looseLump * looseLump * 2.`, 0.72, 0.5),
};
/** Something loose on the ground, sawdust or chips: lumpy, mottled
 *  between `dark` and `dark` + `spread` by the land's grain, and gone
 *  where `gone` says, its edge frayed by the same grain. */
function loose(name: string, gone: string, dark: number, spread: number) {
  return coat(name, `let looseAt = input.worldPos.xy;
let looseLump = 0.6 * textureSample(millGrain, millGrainSampler, looseAt / ${f(DUST_LUMPS)}).r + 0.4 * textureSample(millGrain, millGrainSampler, looseAt / ${f(DUST_FLECKS)}).r;
if (${gone}) { discard; }
let looseBump = vec2f(textureSample(millGrain, millGrainSampler, (looseAt + vec2f(0.004, 0.)) / ${f(DUST_FLECKS)}).r - textureSample(millGrain, millGrainSampler, (looseAt - vec2f(0.004, 0.)) / ${f(DUST_FLECKS)}).r,
  textureSample(millGrain, millGrainSampler, (looseAt + vec2f(0., 0.004)) / ${f(DUST_FLECKS)}).r - textureSample(millGrain, millGrainSampler, (looseAt - vec2f(0., 0.004)) / ${f(DUST_FLECKS)}).r);
N = normalize(N - vec3f(looseBump * 0.5, 0.));
baseColor = baseColor * (${f(dark)} + ${f(spread)} * textureSample(millGrain, millGrainSampler, looseAt / ${f(CHIP_SPECKS)}).r * looseLump * 2.);
roughness = 1.;`, (engine) => ({ millGrain: grain(engine) }));
}

/** The logs' bark (`bark.ts`), an engine's: smooth until the worker has
 *  baked it, or read back from the last bake (`bakeCache.ts`). */
const bark = (engine: EngineContext) =>
  bakedTexture(engine, "bark", barkRecipe, [BARK_ROUND, BARK_LONG, () => new Uint8Array(BARK_ROUND * BARK_LONG * 4).map((_, k) => (k % 4 === 2 ? 220 : k % 4 === 3 ? 255 : 128))], {
    format: "rgba8unorm",
    mipmaps: true,
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
  });

const LEFT = Object.fromEntries(Object.entries(SAWMILL).map(([k, s]) => [k, mirror(s)])) as typeof SAWMILL;

/** The sawmill, or its mirror, finish by finish, as an engine draws it:
 *  the wing on the side of the gate, at the end of the lane its lorries
 *  come up; its one dock across from it. */
export function sawmill(engine: EngineContext, side: 1 | -1) {
  const coats = COATS.get(engine) ?? COATS.set(engine, Object.fromEntries(Object.entries(MAKE).map(([k, make]) => [k, make(engine)])) as Record<Finish, MaterialPlugin>).get(engine)!;
  return (Object.keys(SAWMILL) as Finish[]).map((k) => ({ key: `sawmill_${k}${side > 0 ? "" : "_left"}`, geo: (side > 0 ? SAWMILL : LEFT)[k], coat: coats[k] }));
}

/** A shape seen in a mirror across x = 0, wound round again. */
function mirror(s: Shape): Shape {
  const flip = (a: number[]) => a.map((v, i) => (i % 3 === 0 ? -v : v));
  return { ...s, positions: flip(s.positions), normals: flip(s.normals), indices: s.indices.map((_, i) => s.indices[i - (i % 3) + [0, 2, 1][i % 3]]) };
}
