import type { Manifold } from "manifold-3d";
import type { MeshGeometry } from "../geometry";
import { mesh, Solid, solids } from "../solid";
import { shape, type Part } from "./sea";
import type { RGB } from "../rgb";
import { barnY, box, f, FLECKS, GLASS, hull, loose, LUMPS, PITCH, placing, sheet, tiled, TILES, WOOD, ZINC, ZINC_COLOUR, type V } from "./model";

/**
 * A farm, whole: a farmstead on the back of its plot, three tiles
 * across (x, -1.5 to 1.5) and four deep (y), the street at +y; its ground
 * on z = 0. Its yard, the front half, is the lorries' and the
 * tractor's (`lots.rs`), its crates on their pad by the lane (`pads.ts`);
 * its fields round it the town grid's (`field.ts`).
 *
 * - The barn in the middle, red, its gable end and its big doors at the
 *   end of the lane, a cupola on its ridge, a lean-to down its side.
 * - On its left the farmhouse, white, a porch to the yard, a dormer, its
 *   garden fenced in front; a tree and round bales behind.
 * - On its right two silos, a shed open to the yard, its bales stacked
 *   in front, and the machine shed; a rail fence along the front.
 * - Under it all, packed earth.
 */

const RED: RGB = [0.62, 0.28, 0.23];
const WHITE: RGB = [0.92, 0.89, 0.83];
const GREEN: RGB = [0.37, 0.5, 0.41];
const TIMBER: RGB = [0.55, 0.41, 0.29];
const PANE: RGB = [0.24, 0.29, 0.36];
const DOOR: RGB = [0.33, 0.45, 0.38];
const BRICK: RGB = [0.62, 0.34, 0.26];
const STRAW: RGB = [0.86, 0.72, 0.42];
const EARTH: RGB = [0.56, 0.5, 0.42];
const LEAVES: RGB = [0.36, 0.55, 0.3];
const WATER: RGB = [0.4, 0.58, 0.68];
const DOME: RGB = [0.62, 0.63, 0.65];

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
  /** A body under a pitched roof, its ridge front to back: its walls,
   *  and its roof's two slopes, tiled, `over` past its walls. */
  const gabled = (x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number, wall: RGB, over = 0.04) => {
    put(barnY(x0, x1, y0, y1, eave, ridge), wall);
    const [mid, half] = [(x0 + x1) / 2, (x1 - x0) / 2];
    const drop = ((ridge - eave) * (half + over)) / half;
    for (const s of [-1, 1]) tiles.push([tiled(sheet([mid, y0 - over, ridge], [0, y1 - y0 + 2 * over, 0], [s * (half + over), 0, -drop], 0.018)), [0, 0, 0], GREEN]);
  };
  /** A window on a wall facing the yard, at `y`, its middle `x` across. */
  const window = (y: number, x: number, z: number, w = 0.06, h = 0.065) => {
    put(box(x - w / 2 - 0.01, x + w / 2 + 0.01, y - 0.004, y + 0.006, z - 0.01, z + h + 0.01), WHITE);
    put(box(x - w / 2, x + w / 2, y - 0.004, y + 0.01, z, z + h), PANE);
  };
  /** A rail fence from (x0, y0) to (x1, y1), a post every so often. */
  const fence = (x0: number, y0: number, x1: number, y1: number, rgb: RGB, pickets = false) => {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / (pickets ? 0.04 : 0.2)));
    const along = (k: number): [number, number] => [x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n];
    const rail = (z: number) => hull([[x0, y0, z], [x1, y1, z], [x0, y0, z + 0.012], [x1, y1, z + 0.012]].flatMap(([x, y, z]): V[] => [[x - 0.005, y - 0.005, z], [x + 0.005, y + 0.005, z]]));
    put(Solid.union([
      ...(pickets ? [0.03] : [0.03, 0.065]).map(rail),
      ...Array.from({ length: n + 1 }, (_, k) => along(k)).map(([x, y]) => box(x - 0.009, x + 0.009, y - 0.009, y + 0.009, 0, pickets ? 0.07 : 0.09)),
    ]), rgb);
  };
  const bale = (x: number, y: number, z: number) => Solid.cylinder(0.08, 0.05, 0.05, 16).translate([0, 0, -0.04]).rotate([0, 90, 0]).translate([x, y, z + 0.05]);

  // The farmyard's earth, behind the asphalt.
  earth.push([mesh(box(-1.48, 1.48, -1.97, -0.02, 0, 0.014), () => [0, 0]), [0, 0, 0], EARTH]);

  // The barn: red, its doors to the lane, two windows beside them and the
  // loft's over them, its cupola on the ridge at the back.
  const [bx0, bx1, by0, by1, be, br] = [-0.46, 0.46, -1.85, -0.8, 0.26, 0.52];
  gabled(bx0, bx1, by0, by1, be, br, RED, 0.05);
  const front = by1 + 0.004;
  for (const s of [-1, 1]) {
    const [x0, x1] = s < 0 ? [-0.17, 0] : [0, 0.17];
    put(box(x0, x1, by1 - 0.002, front + 0.008, 0, 0.2), RED);
    put(Solid.union([
      box(x0, x1, front + 0.006, front + 0.014, 0.19, 0.205), box(x0, x1, front + 0.006, front + 0.014, 0, 0.012),
      box(x0, x0 + 0.014, front + 0.006, front + 0.014, 0, 0.2), box(x1 - 0.014, x1, front + 0.006, front + 0.014, 0, 0.2),
      ...[[x0, 0, x1, 0.2], [x0, 0.2, x1, 0]].map(([a, za, b, zb]) => hull([[a, front + 0.008, za], [b, front + 0.008, zb]].flatMap(([x, y, z]): V[] => [[x, y, z - 0.009], [x, y, z + 0.009], [x, y + 0.006, z - 0.009], [x, y + 0.006, z + 0.009]])).intersect(box(x0, x1, front, front + 0.02, 0, 0.2))),
    ]), WHITE);
  }
  for (const x of [-0.33, 0.33]) window(by1, x, 0.1, 0.07, 0.06);
  window(by1, 0, 0.32, 0.06, 0.07);
  const [cy, cz] = [-1.6, br - 0.02];
  put(box(-0.06, 0.06, cy - 0.06, cy + 0.06, cz, cz + 0.1), WHITE);
  tiles.push([tiled(hull([[-0.085, cy - 0.085, cz + 0.1], [0.085, cy - 0.085, cz + 0.1], [-0.085, cy + 0.085, cz + 0.1], [0.085, cy + 0.085, cz + 0.1], [0, cy - 0.085, cz + 0.17], [0, cy + 0.085, cz + 0.17]])), [0, 0, 0], GREEN]);
  // Its lean-to down its right side.
  put(box(bx1, 0.66, -1.72, -0.95, 0, 0.17), RED);
  tiles.push([tiled(sheet([bx1 - 0.02, -1.76, 0.24], [0, 0.85, 0], [0.24, 0, -0.08], 0.016)), [0, 0, 0], GREEN]);

  // The farmhouse on the left, white, its gable to the yard: a porch on
  // posts over its door, a dormer, a chimney; its garden fenced in front.
  const [hx0, hx1, hy0, hy1, he, hr] = [-1.4, -0.82, -1.35, -0.5, 0.28, 0.46];
  gabled(hx0, hx1, hy0, hy1, he, hr, WHITE);
  const hmid = (hx0 + hx1) / 2;
  put(box(hmid - 0.05, hmid + 0.05, hy1 - 0.002, hy1 + 0.008, 0, 0.14), DOOR);
  for (const x of [hmid - 0.18, hmid + 0.18]) window(hy1, x, 0.05), window(hy1, x, 0.18, 0.06, 0.06);
  window(hy1, hmid, 0.31, 0.05, 0.05);
  put(box(hmid - 0.13, hmid + 0.13, hy1, hy1 + 0.1, 0, 0.02), TIMBER);
  for (const x of [hmid - 0.12, hmid + 0.12]) put(box(x - 0.008, x + 0.008, hy1 + 0.085, hy1 + 0.1, 0.02, 0.15), WHITE);
  tiles.push([tiled(sheet([hmid - 0.15, hy1, 0.165], [0.3, 0, 0], [0, 0.12, -0.03], 0.014)), [0, 0, 0], GREEN]);
  const [dy, dz] = [-0.95, he + 0.05];
  put(box(hx0 + 0.05, hx0 + 0.16, dy - 0.06, dy + 0.06, he - 0.02, dz + 0.06), WHITE);
  tiles.push([tiled(hull([[hx0 + 0.03, dy - 0.075, dz + 0.06], [hx0 + 0.03, dy + 0.075, dz + 0.06], [hx0 + 0.2, dy - 0.075, dz + 0.1], [hx0 + 0.2, dy + 0.075, dz + 0.1], [hx0 + 0.03, dy, dz + 0.11], [hx0 + 0.2, dy, dz + 0.14]])), [0, 0, 0], GREEN]);
  put(box(hx0 + 0.045, hx0 + 0.05, dy - 0.035, dy + 0.035, dz, dz + 0.05), PANE);
  put(box(hx0 + 0.07, hx0 + 0.14, -1.28, -1.21, 0, hr + 0.08).add(box(hx0 + 0.062, hx0 + 0.148, -1.288, -1.202, hr + 0.06, hr + 0.08)), BRICK);
  fence(-1.45, -0.08, hmid - 0.06, -0.08, WHITE, true);
  fence(hmid + 0.06, -0.08, -0.72, -0.08, WHITE, true);
  fence(-0.72, -0.08, -0.72, hy1 + 0.05, WHITE, true);
  // Its garden: a bush or two; behind it a tree, and round bales.
  put(Solid.union([[-1.38, -0.22, 0.05], [-0.8, -0.3, 0.045], [-0.68, -0.6, 0.04]].map(([x, y, r]) => Solid.sphere(r, 12).scale([1, 1, 0.8]).translate([x, y, r * 0.7]))), LEAVES);
  put(Solid.cylinder(0.12, 0.018, 0.014, 8).translate([-1.27, -1.72, 0]), TIMBER);
  put(Solid.sphere(0.13, 16).scale([1, 1, 0.9]).translate([-1.27, -1.72, 0.22]).add(Solid.sphere(0.09, 12).translate([-1.18, -1.66, 0.3])), LEAVES);
  put(Solid.union([
    ...[-1.72, -1.58, -1.44].map((y) => bale(-0.68, y, 0)),
    ...[-1.65, -1.51].map((y) => bale(-0.68, y, 0.095)),
  ]), STRAW);
  // A trough by the barn.
  put(box(-0.42, -0.24, -0.62, -0.54, 0, 0.05).subtract(box(-0.41, -0.25, -0.61, -0.55, 0.02, 0.06)), TIMBER);
  put(box(-0.41, -0.25, -0.61, -0.55, 0, 0.04), WATER);

  // The silos at the back on the right, domed, a ladder up the taller.
  for (const [x, y, r, h] of [[0.98, -1.55, 0.2, 0.7], [1.3, -1.5, 0.15, 0.58]]) {
    zinc.push([silo(x, y, r, h), [0, 0, 0], ZINC_COLOUR]);
    put(Solid.cylinder(0.12, r + 0.015, 0.02, 24).translate([x, y, h]), DOME);
    put(Solid.cylinder(0.03, r + 0.012, r + 0.012, 24).translate([x, y, 0]), WHITE);
  }
  put(Solid.union([
    ...[-1, 1].map((s) => box(0.98 + s * 0.03 - 0.005, 0.98 + s * 0.03 + 0.005, -1.35, -1.34, 0, 0.76)),
    ...Array.from({ length: 9 }, (_, k) => box(0.95, 1.01, -1.35, -1.342, 0.06 + k * 0.08, 0.066 + k * 0.08)),
  ]), WHITE);

  // The bale shed, open to the yard, its bales stacked out in front.
  const [sx0, sx1, sy0, sy1] = [0.6, 1.0, -0.95, -0.7];
  put(box(sx0, sx1, sy0, sy0 + 0.03, 0, 0.17), TIMBER);
  for (const x of [sx0 + 0.015, sx1 - 0.015]) put(box(x - 0.012, x + 0.012, sy0, sy1, 0, 0.15).subtract(box(x - 0.02, x + 0.02, sy0 + 0.05, sy1 + 0.01, 0, 0.13)), TIMBER);
  gabled(sx0, sx1, sy0, sy1, 0.15, 0.25, TIMBER);
  put(Solid.union([0.7, 0.8, 0.9].flatMap((x) => [bale(x, -0.62, 0), bale(x, -0.48, 0), bale(x, -0.34, 0)]).concat([0.75, 0.85].flatMap((x) => [bale(x, -0.55, 0.095), bale(x, -0.41, 0.095)]))), STRAW);
  // The machine shed beside it, shut, its door to the yard.
  const [mx0, mx1, my0, my1] = [1.08, 1.45, -1.18, -0.45];
  gabled(mx0, mx1, my0, my1, 0.16, 0.28, TIMBER);
  put(box(mx0 + 0.07, mx1 - 0.07, my1 - 0.002, my1 + 0.008, 0, 0.13), RED);
  fence(0.62, -0.2, 1.45, -0.2, TIMBER);

  return {
    wood: { shape: shape(wood), coat: WOOD },
    zinc: { shape: shape(zinc), coat: ZINC },
    tiles: { shape: shape(tiles), coat: TILES },
    glass: { shape: shape(glass), coat: GLASS },
    earth: { shape: shape(earth), coat: EARTHEN, flat: true },
  };
});

/** The farm, or its mirror, its farmhouse the other side. */
export const farm = placing("farm", FARM);
