import type { Manifold, Vec3 } from "manifold-3d";
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
 */

const ROOF: RGB = [0.5, 0.35, 0.25];
const RIB: RGB = [0.42, 0.29, 0.21];
const WALL: RGB = [0.52, 0.34, 0.22];
const TRIM: RGB = [0.42, 0.27, 0.18];
const ZINC: RGB = [0.72, 0.74, 0.77];
const ZINC_RIB: RGB = [0.62, 0.64, 0.68];
const DOOR: RGB = [0.2, 0.24, 0.32];
const BRICK: RGB = [0.62, 0.3, 0.22];
const CHIPS: RGB = [0.7, 0.52, 0.36];
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
/** A log `r` round and `l` long, its middle at `at`, lying along x or y,
 *  its ends pale. */
const log = (at: V, r: number, l: number, along: "x" | "y"): Part[] => {
  const turn: V = along === "x" ? [0, 90, 0] : [90, 0, 0];
  const body = Solid.cylinder(l, r, r, 8, true).rotate(turn).translate(at);
  const ends = Solid.cylinder(l + 0.004, r * 0.8, r * 0.8, 8, true).rotate(turn).translate(at);
  return [[mesh(body), [0, 0, 0], BARK], [mesh(ends), [0, 0, 0], END]];
};
/** A stack of logs, layers of them each one fewer, along x or y, its
 *  middle at (x, y), `n` across at the bottom. */
const stack = (x: number, y: number, along: "x" | "y", l: number, n: number, r = 0.035): Part[] => {
  const out: Part[] = [];
  for (let layer = 0; layer < n - 1; layer++)
    for (let k = 0; k < n - layer; k++) {
      const off = (k - (n - layer - 1) / 2) * 2 * r;
      const z = r + layer * r * 1.73;
      out.push(...log(along === "x" ? [x, y + off, z] : [x + off, y, z], r, l, along));
    }
  return out;
};

const SAWMILL = solids(() => {
  const parts: Part[] = [];
  const put = (solid: Manifold, rgb: RGB) => parts.push([mesh(solid), [0, 0, 0], rgb]);
  const roof = ([s, r]: [Manifold, Manifold], a: RGB, b: RGB) => (put(s, a), put(r, b));

  // The ground: wood chips over the yard's left half, out to the lorries' lane.
  // Thick enough to show over the hall's paving, which stands a little higher.
  put(box(-0.97, 0.15, -1.0, 0.32, 0, 0.016).add(box(-0.97, 0.15, 0.8, 1.92, 0, 0.016)), CHIPS);

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
  roof(ribbed([hx0 - 0.005, hy0 + 0.08, 0.17], [0, -0.8 - hy0, 0], [-0.21, 0, -0.07], 0.01, 10), ZINC, ZINC_RIB);
  put(box(-0.98, hx0, hy0 + 0.1, -0.75, 0, 0.1), TRIM);
  roof(ribbed([hx0 + 0.07, hy1 - 0.005, 0.19], [0.82, 0, 0], [0, 0.3, -0.05], 0.01, 12), ZINC, ZINC_RIB);
  for (const x of [hx0 + 0.1, hx0 + 0.47, hx0 + 0.86]) put(box(x - 0.012, x + 0.012, hy1 + 0.27, hy1 + 0.294, 0, 0.145), TRIM);
  put(box(-0.26, -0.02, hy1 - 0.002, hy1 + 0.004, 0, 0.15), DOOR);

  // The wing, down the right: a barn, its gable to the yard.
  const [wx0, wx1, wy0, wy1, we, wr] = [0.22, 0.76, -1.78, -0.02, 0.24, 0.5];
  put(barnY(wx0, wx1, wy0, wy1, we, wr), WALL);
  for (const s of [-1, 1]) roof(ribbed([(wx0 + wx1) / 2, wy0 - 0.05, wr], [0, wy1 - wy0 + 0.1, 0], down(s * (wx1 - wx0) / 2, 0.06, wr - we, "x"), 0.016, 22), ROOF, RIB);
  put(box(0.38, 0.6, wy1 - 0.004, wy1 + 0.006, 0, 0.19), DOOR);
  put(box(0.36, 0.62, wy1 - 0.004, wy1 + 0.012, 0.19, 0.21), TRIM);
  roof(ribbed([wx1 + 0.005, -1.25, 0.18], [0, 1.4, 0], [0.22, 0, -0.07], 0.01, 14), ZINC, ZINC_RIB);
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
  for (const y of [0.15, -0.2, -0.55]) parts.push(...log([cx, y, rise(y) + 0.036], 0.02, cw - 0.025, "x"));
  // Sawdust heaped about its foot and by the canopy.
  for (const [x, y, r, h] of [[-0.34, -0.55, 0.16, 0.022], [0.05, -0.62, 0.13, 0.02], [-0.02, 1.05, 0.15, 0.022], [-0.3, 1.32, 0.1, 0.016]])
    put(Solid.cylinder(h, r, r * 0.4, 12).translate([x, y, 0.006]), SAWDUST);

  // Three stacks of logs on the chips.
  parts.push(...stack(-0.47, 0.18, "x", 0.42, 5));
  parts.push(...stack(-0.8, 1.2, "y", 0.5, 4));
  parts.push(...stack(-0.68, 1.6, "x", 0.44, 4));
  // A fence along the side.
  put(Solid.union([
    box(-0.99, -0.975, -0.72, 1.9, 0.065, 0.08),
    box(-0.99, -0.975, -0.72, 1.9, 0.025, 0.04),
    ...Array.from({ length: 11 }, (_, k) => box(-0.995, -0.97, -0.72 + k * 0.26, -0.7 + k * 0.26, 0, 0.1)),
  ]), TRIM);

  return shape(parts);
});

/** Where its forklift comes out of the wing's door, to the gate's side. */
export const BARN_DOOR: [number, number] = [0.49, 0.1];

/** The sawmill, and its mirror: the wing on the side of the gate, at the
 *  end of the lane its lorries come up; its one dock across from it. */
export const SAWMILLS = { right: { key: "sawmill", geo: SAWMILL }, left: { key: "sawmill_left", geo: mirror(SAWMILL) } };

/** A shape seen in a mirror across x = 0, wound round again. */
function mirror(s: Shape): Shape {
  const flip = (a: number[]) => a.map((v, i) => (i % 3 === 0 ? -v : v));
  return { ...s, positions: flip(s.positions), normals: flip(s.normals), indices: s.indices.map((_, i) => s.indices[i - (i % 3) + [0, 2, 1][i % 3]]) };
}
