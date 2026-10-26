import type { Manifold } from "manifold-3d";
import type { MeshGeometry } from "../geometry";
import { mesh, Solid, solids } from "../solid";
import { shape, type Part } from "./sea";
import type { RGB } from "../rgb";
import { barnY, box, f, FLECKS, GLASS, hull, loose, LUMPS, PITCH, placing, sheet, tiled, TILES, WOOD, ZINC, ZINC_COLOUR, type V } from "./model";

/**
 * A farm, whole: a farmyard over its plot, three tiles square (x and y,
 * -1.5 to 1.5), the street at +y; its ground on z = 0. Its fields round
 * it are the town grid's (`field.ts`), the tractor out to them by the
 * gate in the middle of the back (`fields.rs`).
 *
 * - At the back on the left the barn, red, its doors to the yard, a
 *   lean-to on its side, a cupola on its ridge; the silos behind it in
 *   the corner, round bales on the grass before them.
 * - At the back on the right the tractor's shed, open to the yard.
 * - In the front corner the farmhouse, white, in its garden: flower
 *   beds, a path to the street, a hedge, white pickets.
 * - On the right a loading dock with crates of the harvest, a trough.
 * - Gravel all over, grass round its edges, a rail fence round it with
 *   its gates swung open, a lamp and a sign at the way in, trees
 *   (`trees.ts`).
 */

const RED: RGB = [0.62, 0.28, 0.23];
const WHITE: RGB = [0.92, 0.89, 0.83];
const GREEN: RGB = [0.37, 0.5, 0.41];
const TIMBER: RGB = [0.55, 0.41, 0.29];
const PANE: RGB = [0.24, 0.29, 0.36];
const DOOR: RGB = [0.33, 0.45, 0.38];
const BRICK: RGB = [0.62, 0.34, 0.26];
const STRAW: RGB = [0.86, 0.72, 0.42];
const EARTH: RGB = [0.62, 0.56, 0.47];
const LEAVES: RGB = [0.36, 0.55, 0.3];
const WATER: RGB = [0.4, 0.58, 0.68];
const DOME: RGB = [0.62, 0.63, 0.65];
const STEEL: RGB = [0.6, 0.6, 0.6];
const TYRE: RGB = [0.2, 0.2, 0.21];
const GRASS: RGB = [0.45, 0.6, 0.35];
const STONE: RGB = [0.7, 0.68, 0.64];
const APPLES: RGB = [0.75, 0.3, 0.25];
const CABBAGE: RGB = [0.5, 0.68, 0.36];
/** Flowers: a few soft colours, never loud. */
const BLOOMS: RGB[] = [[0.9, 0.5, 0.52], [0.95, 0.85, 0.5], [0.92, 0.9, 0.88], [0.7, 0.55, 0.8]];

/** The farmyard's earth: even, its grain in the light. */
const EARTHEN = loose("FarmEarth", "false", `
N = normalize(N - vec3f((looseSlope(looseAt, ${f(FLECKS)}) + 0.6 * looseSlope(looseAt, ${f(LUMPS)})) * 1.1, 0.));
baseColor = baseColor * (0.95 + 0.1 * looseLump);`);

/** A silo `r` round at (x, y), `h` high: zinc, its waves running up it,
 *  smooth round, a whole number of them round so they meet. */
function silo(x: number, y: number, r: number, h: number): MeshGeometry {
  const sides = 28, waves = Math.round((2 * Math.PI * r) / PITCH);
  const g: MeshGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  for (let k = 0; k <= sides; k++) {
    const t = (2 * Math.PI * k) / sides;
    for (const z of [0, h]) g.positions.push(x + Math.cos(t) * r, y + Math.sin(t) * r, z), g.normals.push(Math.cos(t), Math.sin(t), 0), g.uvs!.push((k / sides) * waves, 0);
  }
  for (let k = 0; k < sides; k++) g.indices.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2);
  return g;
}

const FARM = solids(() => {
  const wood: Part[] = [], zinc: Part[] = [], tiles: Part[] = [], glass: Part[] = [], earth: Part[] = [];
  const put = (solid: Manifold, rgb: RGB) => (rgb === PANE ? glass : wood).push([mesh(solid), [0, 0, 0], rgb]);
  const roof = (solid: Manifold) => tiles.push([tiled(solid), [0, 0, 0], GREEN]);
  /** A body under a pitched roof, its ridge front to back: its walls,
   *  and its roof's two slopes, tiled, `over` past its walls. */
  const gabled = (x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number, wall: RGB, over = 0.04) => {
    put(barnY(x0, x1, y0, y1, eave, ridge), wall);
    const [mid, half] = [(x0 + x1) / 2, (x1 - x0) / 2];
    const drop = ((ridge - eave) * (half + over)) / half;
    for (const s of [-1, 1]) roof(sheet([mid, y0 - over, ridge], [0, y1 - y0 + 2 * over, 0], [s * (half + over), 0, -drop], 0.018));
  };
  /** A window on a wall facing +y, at `y`, its middle `x` across. */
  const window = (y: number, x: number, z: number, w = 0.06, h = 0.065) => {
    put(box(x - w / 2 - 0.01, x + w / 2 + 0.01, y - 0.004, y + 0.006, z - 0.01, z + h + 0.01), WHITE);
    put(box(x - w / 2, x + w / 2, y - 0.004, y + 0.01, z, z + h), PANE);
  };
  /** A fence from (x0, y0) to (x1, y1): rails on posts, or white pickets. */
  const fence = (x0: number, y0: number, x1: number, y1: number, pickets = false) => {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / (pickets ? 0.04 : 0.2)));
    const along = (k: number): [number, number] => [x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n];
    const rail = (z: number) => hull([[x0, y0, z], [x1, y1, z], [x0, y0, z + 0.012], [x1, y1, z + 0.012]].flatMap(([x, y, z]): V[] => [[x - 0.005, y - 0.005, z], [x + 0.005, y + 0.005, z]]));
    put(Solid.union([
      ...(pickets ? [0.03] : [0.03, 0.065]).map(rail),
      ...Array.from({ length: n + 1 }, (_, k) => along(k)).map(([x, y]) => box(x - 0.009, x + 0.009, y - 0.009, y + 0.009, 0, pickets ? 0.07 : 0.09)),
    ]), pickets ? WHITE : TIMBER);
  };
  const bale = (x: number, y: number, z: number) => Solid.cylinder(0.08, 0.05, 0.05, 16).translate([0, 0, -0.04]).rotate([0, 90, 0]).translate([x, y, z + 0.05]);
  const wheel = (x: number, y: number, r: number, w = 0.03) => Solid.cylinder(w, r, r, 14).translate([0, 0, -w / 2]).rotate([0, 90, 0]).translate([x, y, r]);

  /** A patch of grass over the gravel, its corners round. */
  const lawn = (x0: number, x1: number, y0: number, y1: number, r: number) =>
    earth.push([mesh(hull([[x0 + r, y0 + r], [x1 - r, y0 + r], [x0 + r, y1 - r], [x1 - r, y1 - r]].flatMap(([x, y]) => Array.from({ length: 8 }, (_, k): V[] => {
      const t = (k / 8) * 2 * Math.PI;
      return [[x + Math.cos(t) * r, y + Math.sin(t) * r, 0], [x + Math.cos(t) * r, y + Math.sin(t) * r, 0.03]];
    }).flat())), () => [0, 0]), [0, 0, 0], GRASS]);
  /** A gate's leaf `w` long hung at (x, y), swung `a` degrees from +x:
   *  its frame and its brace. */
  const leaf = (x: number, y: number, w: number, a: number) => put(Solid.union([
    box(0, w, -0.006, 0.006, 0.02, 0.032), box(0, w, -0.006, 0.006, 0.075, 0.087),
    box(0, 0.014, -0.006, 0.006, 0.02, 0.087), box(w - 0.014, w, -0.006, 0.006, 0.02, 0.087),
    hull([[0.01, 0, 0.028], [0.01, 0, 0.04], [w - 0.01, 0, 0.072], [w - 0.01, 0, 0.084]].flatMap(([x, , z]): V[] => [[x, -0.005, z], [x, 0.005, z]])),
  ]).rotate([0, 0, a]).translate([x, y, 0]), TIMBER);
  /** A bed of flowers round (x, y): small heads of a few colours. */
  const flowers = (x: number, y: number, n: number, spread: number) => {
    const heads = Array.from({ length: n * 4 }, (_, m) => {
      const t = m * 2.39996, d = spread * Math.sqrt((m + 0.5) / (n * 4));
      return [x + Math.cos(t) * d, y + Math.sin(t) * d * 0.8, 0.028 + 0.01 * ((m * 5) % 3)] as V;
    });
    for (const [k, rgb] of BLOOMS.entries()) put(Solid.union(heads.filter((_, m) => (m * 7 + 3) % BLOOMS.length === k).map((at) => Solid.sphere(0.012, 6).translate(at))), rgb);
  };
  /** A hedge from (x0, y0) to (x1, y1): leafy lumps along it. */
  const hedge = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0) / 0.06));
    put(Solid.union(Array.from({ length: n + 1 }, (_, k) => Solid.sphere(0.045 + 0.008 * (k % 2), 10).scale([1, 1, 0.9]).translate([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, 0.05]))), LEAVES);
  };
  /** A lamp on a post. */
  const lamp = (x: number, y: number) => {
    put(box(x - 0.008, x + 0.008, y - 0.008, y + 0.008, 0, 0.16), TYRE);
    put(box(x - 0.02, x + 0.02, y - 0.02, y + 0.02, 0.15, 0.18), PANE);
  };

  // Gravel all over, grass along its edges and in its corners.
  earth.push([mesh(box(-1.49, 1.49, -1.49, 1.49, 0, 0.02), () => [0, 0]), [0, 0, 0], EARTH]);
  lawn(-1.49, -1.02, -1.49, 0.05, 0.06);
  lawn(-1.3, -0.72, -0.62, -0.08, 0.14);
  lawn(-1.49, -0.45, 0.04, 1.49, 0.04);
  lawn(-0.46, -0.06, -0.6, -0.36, 0.08);
  lawn(0.38, 0.7, -1.49, -1.0, 0.12);
  lawn(1.14, 1.49, -0.62, 1.49, 0.1);
  lawn(0.62, 1.49, 1.0, 1.49, 0.12);

  // The barn, at the back on the left: red, its doors to the yard, a
  // window either side and the loft's over them, a lean-to on its side,
  // its cupola.
  const [bx0, bx1, by0, by1, be, br] = [-1.02, -0.26, -1.42, -0.62, 0.25, 0.5];
  const bmid = (bx0 + bx1) / 2;
  gabled(bx0, bx1, by0, by1, be, br, RED, 0.05);
  const front = by1 + 0.004;
  for (const s of [-1, 1]) {
    const [x0, x1] = s < 0 ? [bmid - 0.13, bmid] : [bmid, bmid + 0.13];
    put(box(x0, x1, by1 - 0.002, front + 0.008, 0, 0.17), RED);
    put(Solid.union([
      box(x0, x1, front + 0.006, front + 0.014, 0.16, 0.175), box(x0, x1, front + 0.006, front + 0.014, 0, 0.012),
      box(x0, x0 + 0.014, front + 0.006, front + 0.014, 0, 0.17), box(x1 - 0.014, x1, front + 0.006, front + 0.014, 0, 0.17),
      ...[[x0, 0, x1, 0.17], [x0, 0.17, x1, 0]].map(([a, za, b, zb]) => hull([[a, front + 0.008, za], [b, front + 0.008, zb]].flatMap(([x, y, z]): V[] => [[x, y, z - 0.009], [x, y, z + 0.009], [x, y + 0.006, z - 0.009], [x, y + 0.006, z + 0.009]])).intersect(box(x0, x1, front, front + 0.02, 0, 0.17))),
    ]), WHITE);
  }
  for (const x of [bmid - 0.25, bmid + 0.25]) window(by1, x, 0.09, 0.05, 0.05);
  const lz = 0.3;
  put(Solid.union([
    box(bmid - 0.06, bmid + 0.06, front, front + 0.01, lz, lz + 0.012), box(bmid - 0.06, bmid + 0.06, front, front + 0.01, lz + 0.1, lz + 0.112),
    box(bmid - 0.06, bmid - 0.048, front, front + 0.01, lz, lz + 0.112), box(bmid + 0.048, bmid + 0.06, front, front + 0.01, lz, lz + 0.112),
    ...[[-1, 1], [1, -1]].map(([a, b]) => hull([[bmid + a * 0.05, front + 0.005, lz + 0.01], [bmid + b * 0.05, front + 0.005, lz + 0.1]].flatMap(([x, y, z]): V[] => [[x, y - 0.005, z - 0.006], [x, y + 0.005, z + 0.006]]))),
  ]), WHITE);
  const cy = (by0 + by1) / 2 - 0.08;
  put(box(bmid - 0.05, bmid + 0.05, cy - 0.05, cy + 0.05, br - 0.02, br + 0.07), WHITE);
  roof(hull([[bmid - 0.07, cy - 0.07, br + 0.07], [bmid + 0.07, cy - 0.07, br + 0.07], [bmid - 0.07, cy + 0.07, br + 0.07], [bmid + 0.07, cy + 0.07, br + 0.07], [bmid, cy - 0.07, br + 0.13], [bmid, cy + 0.07, br + 0.13]]));
  put(box(bx1, bx1 + 0.12, -1.3, -0.74, 0, 0.17), RED);
  roof(sheet([bx1 - 0.01, -1.33, 0.2], [0, 0.62, 0], [0.15, 0, -0.06], 0.016));
  // A bit of white picket by its doors, the round bales stacked on the
  // grass beside it.
  fence(-0.42, -0.44, -0.08, -0.44, true);
  put(Solid.union([
    ...[-0.42, -0.3].flatMap((y) => [bale(-1.12, y, 0), bale(-1.02, y, 0)]),
    bale(-1.07, -0.36, 0.095),
  ]), STRAW);
  // The silos in the corner behind, domed, a ladder up the taller.
  for (const [x, y, r, h] of [[-1.3, -1.27, 0.15, 0.66], [-1.31, -0.88, 0.12, 0.5]]) {
    zinc.push([silo(x, y, r, h), [0, 0, 0], ZINC_COLOUR]);
    put(Solid.cylinder(0.09, r + 0.015, 0.02, 24).translate([x, y, h]), DOME);
    put(Solid.cylinder(0.03, r + 0.012, r + 0.012, 24).translate([x, y, 0]), WHITE);
  }
  put(Solid.union([
    ...[-1, 1].map((s) => box(-1.155, -1.145, -1.27 + s * 0.03 - 0.005, -1.27 + s * 0.03 + 0.005, 0, 0.72)),
    ...Array.from({ length: 8 }, (_, k) => box(-1.155, -1.147, -1.3, -1.24, 0.06 + k * 0.08, 0.066 + k * 0.08)),
  ]), WHITE);

  // The tractor's shed at the back on the right, a tree beside it: its
  // back and ends boarded, posts at its open front, a green roof.
  const [sx0, sx1, sy0, sy1, se, sr] = [0.64, 1.32, -1.42, -0.86, 0.2, 0.3];
  put(Solid.union([
    box(sx0, sx1, sy0, sy0 + 0.025, 0, se),
    box(sx0, sx0 + 0.025, sy0, sy1, 0, se), box(sx1 - 0.025, sx1, sy0, sy1, 0, se),
    box(sx0, sx0 + 0.03, sy1 - 0.03, sy1, 0, se), box(sx1 - 0.03, sx1, sy1 - 0.03, sy1, 0, se),
    box(sx0, sx1, sy1 - 0.03, sy1, se - 0.03, se),
  ]), TIMBER);
  for (const x of [sx0, sx1 - 0.025]) put(hull([[x, sy0, se], [x, sy1, se], [x, (sy0 + sy1) / 2, sr]].flatMap(([x, y, z]): V[] => [[x, y, z], [x + 0.025, y, z]])), TIMBER);
  for (const s of [-1, 1]) roof(sheet([sx0 - 0.04, (sy0 + sy1) / 2, sr], [sx1 - sx0 + 0.08, 0, 0], [0, s * ((sy1 - sy0) / 2 + 0.05), -(sr - se) * (1 + 0.05 / ((sy1 - sy0) / 2))], 0.018));
  put(box(1.12, 1.26, -1.3, -1.02, 0.05, 0.12).subtract(box(1.13, 1.25, -1.29, -1.03, 0.07, 0.13)), RED);
  put(box(1.18, 1.2, -1.02, -0.96, 0.05, 0.065), STEEL);
  put(Solid.union([wheel(1.12, -1.16, 0.04, 0.02), wheel(1.26, -1.16, 0.04, 0.02)]), TYRE);
  lamp(0.5, -0.92);

  // The farmhouse in the front corner, white, its gable to the street,
  // in its garden: a porch over its door and steps up to it, a dormer, a
  // chimney; a path to the street between its flower beds, a hedge down
  // its side, white pickets round.
  const [hx0, hx1, hy0, hy1, he, hr] = [-1.4, -0.82, 0.14, 0.94, 0.24, 0.42];
  gabled(hx0, hx1, hy0, hy1, he, hr, WHITE);
  const hmid = (hx0 + hx1) / 2;
  put(box(hmid - 0.045, hmid + 0.045, hy1 - 0.002, hy1 + 0.008, 0.03, 0.15), DOOR);
  for (const x of [hmid - 0.17, hmid + 0.17]) {
    window(hy1, x, 0.06, 0.06, 0.06), window(hy1, x, 0.17, 0.05, 0.05);
    put(box(x - 0.04, x + 0.04, hy1, hy1 + 0.02, 0.04, 0.055), TIMBER);
    flowers(x, hy1 + 0.012, 4, 0.03);
  }
  put(Solid.union([box(hmid - 0.08, hmid + 0.08, hy1, hy1 + 0.1, 0, 0.03), box(hmid - 0.06, hmid + 0.06, hy1 + 0.1, hy1 + 0.14, 0, 0.015)]), WHITE);
  for (const x of [hmid - 0.07, hmid + 0.07]) put(box(x - 0.008, x + 0.008, hy1 + 0.085, hy1 + 0.1, 0.03, 0.16), WHITE);
  roof(sheet([hmid - 0.1, hy1 - 0.01, 0.175], [0.2, 0, 0], [0, 0.12, -0.035], 0.014));
  const [dy, dz] = [(hy0 + hy1) / 2 + 0.05, he + 0.03];
  put(box(hx1 - 0.14, hx1 - 0.05, dy - 0.06, dy + 0.06, he - 0.02, dz + 0.06), WHITE);
  roof(hull([[hx1 - 0.03, dy - 0.075, dz + 0.06], [hx1 - 0.03, dy + 0.075, dz + 0.06], [hx1 - 0.18, dy - 0.075, dz + 0.09], [hx1 - 0.18, dy + 0.075, dz + 0.09], [hx1 - 0.03, dy, dz + 0.11], [hx1 - 0.18, dy, dz + 0.13]]));
  put(box(hx1 - 0.05, hx1 - 0.045, dy - 0.035, dy + 0.035, dz, dz + 0.05), PANE);
  put(box(hx0 + 0.06, hx0 + 0.13, hy0 + 0.05, hy0 + 0.12, 0, hr + 0.09).add(box(hx0 + 0.052, hx0 + 0.138, hy0 + 0.042, hy0 + 0.128, hr + 0.07, hr + 0.09)), BRICK);
  put(Solid.union(Array.from({ length: 4 }, (_, k) => box(hmid - 0.035, hmid + 0.035, 1.12 + k * 0.09, 1.17 + k * 0.09, 0, 0.04))), STONE);
  for (const [x, y] of [[hmid - 0.2, 1.18], [hmid + 0.2, 1.18], [hmid - 0.22, 1.36], [hmid + 0.22, 1.36]]) flowers(x, y, 7, 0.07);
  hedge(-0.56, 0.16, -0.56, 0.86);
  fence(-1.47, 1.47, hmid - 0.05, 1.47, true);
  fence(hmid + 0.05, 1.47, -0.45, 1.47, true);
  fence(-0.45, 0.06, -0.45, 0.94, true);
  fence(-0.7, 0.06, -0.45, 0.06, true);
  fence(-1.47, 0.06, -1.47, 1.47, true);

  // The loading dock on the right: a deck on posts, steps down, crates
  // of the harvest on it; a barrel and a trough beside it, flowers.
  const [kx0, kx1, ky0, ky1] = [0.72, 1.1, -0.32, 0.12];
  put(Solid.union([
    box(kx0, kx1, ky0, ky1, 0.05, 0.07),
    ...[kx0, kx1 - 0.02].flatMap((x) => [box(x, x + 0.02, ky0, ky0 + 0.02, 0, 0.05), box(x, x + 0.02, ky1 - 0.02, ky1, 0, 0.05)]),
    box(0.78, 0.94, ky1, ky1 + 0.05, 0, 0.035), box(0.78, 0.94, ky1 + 0.05, ky1 + 0.1, 0, 0.017),
  ]), TIMBER);
  for (const [x, y, z, crop] of [[0.82, -0.22, 0.07, 0], [0.94, -0.22, 0.07, 1], [0.82, -0.1, 0.07, 1], [0.94, -0.1, 0.07, 0], [0.88, -0.16, 0.14, 0]] as const) {
    put(box(x - 0.05, x + 0.05, y - 0.05, y + 0.05, z, z + 0.07).subtract(box(x - 0.042, x + 0.042, y - 0.042, y + 0.042, z + 0.02, z + 0.08)), TIMBER);
    put(Solid.union([0, 1, 2, 3].map((k) => Solid.sphere(0.024, 8).translate([x + (k % 2 ? 0.02 : -0.02), y + (k < 2 ? 0.02 : -0.02), z + 0.055]))), crop ? APPLES : CABBAGE);
  }
  put(Solid.cylinder(0.09, 0.035, 0.04, 16).translate([1.05, -0.42, 0]), TIMBER);
  put(box(1.17, 1.3, -0.56, -0.14, 0, 0.06).subtract(box(1.18, 1.29, -0.55, -0.15, 0.02, 0.07)), STEEL);
  put(box(1.18, 1.29, -0.55, -0.15, 0, 0.045), WATER);
  flowers(1.24, 0.02, 7, 0.06);

  // The way in from the street, its gates swung open, a lamp and the
  // farm's sign by it.
  lamp(0.7, 1.2);
  put(Solid.union([box(0.78, 0.795, 1.3, 1.315, 0, 0.13), box(0.965, 0.98, 1.3, 1.315, 0, 0.13)]), TIMBER);
  put(box(0.77, 0.99, 1.298, 1.318, 0.07, 0.15), WHITE);
  put(box(0.78, 0.98, 1.316, 1.322, 0.078, 0.142), DOOR);
  flowers(0.88, 1.38, 6, 0.06);

  // The rail fence round the rest, open at the street and at the back,
  // their gates swung open.
  fence(-0.45, 1.47, -0.3, 1.47);
  leaf(-0.3, 1.47, 0.14, -150);
  fence(0.3, 1.47, 1.47, 1.47);
  leaf(0.3, 1.47, 0.14, -30);
  fence(-1.47, -1.47, -0.3, -1.47);
  leaf(-0.3, -1.47, 0.14, -110);
  fence(0.3, -1.47, 1.47, -1.47);
  leaf(0.3, -1.47, 0.14, -70);
  fence(-1.47, -1.47, -1.47, 0.06);
  fence(1.47, -1.47, 1.47, 1.47);

  return {
    wood: { shape: shape(wood), coat: WOOD },
    zinc: { shape: shape(zinc), coat: ZINC },
    tiles: { shape: shape(tiles), coat: TILES },
    glass: { shape: shape(glass), coat: GLASS },
    earth: { shape: shape(earth), coat: EARTHEN, flat: true },
  };
});

/** The farm, or its mirror, its barn and its house the other side. */
export const farm = placing("farm", FARM);
/** Its trees, `[x, y, scale]`: by the street, the shed, the silos and the garden. */
export const FARM_TREES: [number, number, number][] = [[1.28, 1.02, 0.95], [1.25, 0.42, 0.7], [0.48, -1.24, 0.65], [-1.3, -0.6, 0.55], [-0.56, 1.16, 0.6]];
