import type { Manifold } from "manifold-3d";
import type { MeshGeometry } from "../geometry";
import { mesh, Solid, solids } from "../solid";
import { shape, type Part } from "./sea";
import type { RGB } from "../rgb";
import { barnY, box, f, FLECKS, GLASS, hull, loose, LUMPS, PITCH, placing, sheet, tiled, TILES, WOOD, ZINC, ZINC_COLOUR, type V } from "./model";

/**
 * A farm, whole: a farmyard over its plot, three tiles across (x, -1.5 to
 * 1.5) and four deep (y), the street at +y; its ground on z = 0. Down the
 * middle of its front half the lane from the gate, its crates on their
 * pad beside it (`pads.ts`), and by the barn its two docks, the lorry's
 * and the tractor's (`lots.rs`); its fields round it the town grid's
 * (`field.ts`), the tractor out to them through the gaps in its fence.
 *
 * - At the back on the left the barn, red, its doors to the yard, a
 *   cupola on its ridge; the silos behind it in the corner.
 * - At the back on the right the machine shed, open to the yard, a bay a
 *   machine: the combine, the tractor's, the trailer and the plough.
 * - In the front corner the farmhouse, white, its garden fenced to the
 *   street.
 * - Packed earth all over, a rail fence round it, trees in its corners
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
const EARTH: RGB = [0.56, 0.5, 0.42];
const LEAVES: RGB = [0.36, 0.55, 0.3];
const WATER: RGB = [0.4, 0.58, 0.68];
const DOME: RGB = [0.62, 0.63, 0.65];
const COMBINE: RGB = [0.42, 0.6, 0.36];
const STEEL: RGB = [0.6, 0.6, 0.6];
const TYRE: RGB = [0.2, 0.2, 0.21];

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

  // Packed earth all over, the asphalt under it.
  earth.push([mesh(box(-1.49, 1.49, -1.98, 1.98, 0, 0.02), () => [0, 0]), [0, 0, 0], EARTH]);

  // The barn, at the back on the left: red, its doors to the yard, two
  // windows beside them and the loft's over them, its cupola.
  const [bx0, bx1, by0, by1, be, br] = [-1.08, -0.18, -1.88, -0.78, 0.26, 0.5];
  const bmid = (bx0 + bx1) / 2;
  gabled(bx0, bx1, by0, by1, be, br, RED, 0.05);
  const front = by1 + 0.004;
  for (const s of [-1, 1]) {
    const [x0, x1] = s < 0 ? [bmid - 0.16, bmid] : [bmid, bmid + 0.16];
    put(box(x0, x1, by1 - 0.002, front + 0.008, 0, 0.2), RED);
    put(Solid.union([
      box(x0, x1, front + 0.006, front + 0.014, 0.19, 0.205), box(x0, x1, front + 0.006, front + 0.014, 0, 0.012),
      box(x0, x0 + 0.014, front + 0.006, front + 0.014, 0, 0.2), box(x1 - 0.014, x1, front + 0.006, front + 0.014, 0, 0.2),
      ...[[x0, 0, x1, 0.2], [x0, 0.2, x1, 0]].map(([a, za, b, zb]) => hull([[a, front + 0.008, za], [b, front + 0.008, zb]].flatMap(([x, y, z]): V[] => [[x, y, z - 0.009], [x, y, z + 0.009], [x, y + 0.006, z - 0.009], [x, y + 0.006, z + 0.009]])).intersect(box(x0, x1, front, front + 0.02, 0, 0.2))),
    ]), WHITE);
  }
  for (const x of [bmid - 0.32, bmid + 0.32]) window(by1, x, 0.1, 0.06, 0.06);
  window(by1, bmid, 0.31, 0.06, 0.07);
  const cy = -1.62;
  put(box(bmid - 0.06, bmid + 0.06, cy - 0.06, cy + 0.06, br - 0.02, br + 0.08), WHITE);
  roof(hull([[bmid - 0.085, cy - 0.085, br + 0.08], [bmid + 0.085, cy - 0.085, br + 0.08], [bmid - 0.085, cy + 0.085, br + 0.08], [bmid + 0.085, cy + 0.085, br + 0.08], [bmid, cy - 0.085, br + 0.15], [bmid, cy + 0.085, br + 0.15]]));
  // The silos in the corner behind it, domed, a ladder up the taller.
  for (const [x, y, r, h] of [[-1.3, -1.66, 0.17, 0.68], [-1.32, -1.2, 0.13, 0.54]]) {
    zinc.push([silo(x, y, r, h), [0, 0, 0], ZINC_COLOUR]);
    put(Solid.cylinder(0.11, r + 0.015, 0.02, 24).translate([x, y, h]), DOME);
    put(Solid.cylinder(0.03, r + 0.012, r + 0.012, 24).translate([x, y, 0]), WHITE);
  }
  put(Solid.union([
    ...[-1, 1].map((s) => box(-1.13, -1.12, -1.66 + s * 0.03 - 0.005, -1.66 + s * 0.03 + 0.005, 0, 0.74)),
    ...Array.from({ length: 8 }, (_, k) => box(-1.13, -1.122, -1.69, -1.63, 0.06 + k * 0.08, 0.066 + k * 0.08)),
  ]), WHITE);
  // Round bales stacked beside its doors, a trough before them.
  put(Solid.union([
    ...[-0.62, -0.48].flatMap((y) => [bale(-0.06, y, 0), bale(0.04, y, 0)]),
    bale(-0.01, -0.55, 0.095),
  ]), STRAW);
  put(box(-1.0, -0.82, -0.6, -0.52, 0, 0.05).subtract(box(-0.99, -0.83, -0.59, -0.53, 0.02, 0.06)), TIMBER);
  put(box(-0.99, -0.83, -0.59, -0.53, 0, 0.04), WATER);

  // The machine shed, at the back on the right: a back wall, its ends,
  // posts between its bays, a roof sloping back; open to the yard.
  const [mx0, mx1, my0, my1, mz] = [0.18, 1.45, -1.9, -1.45, 0.26];
  const bays = [mx0, 0.82, 1.13, mx1];
  put(box(mx0, mx1, my0, my0 + 0.03, 0, mz - 0.03), TIMBER);
  for (const x of bays) put(box(x - 0.016, x + 0.016, my0, my1, 0, mz).subtract(x === mx0 || x === mx1 ? box(x - 0.03, x + 0.03, my0 + 0.03, my1 - 0.03, 0, mz - 0.03) : box(x - 0.03, x + 0.03, my0 + 0.05, my1 - 0.03, 0, mz - 0.02)), TIMBER);
  roof(sheet([mx0 - 0.05, my1 + 0.08, mz + 0.03], [mx1 - mx0 + 0.1, 0, 0], [0, my0 - my1 - 0.12, -0.06], 0.018));
  // The combine in its bay, its nose out in the yard: its body, its cab,
  // its header across the front, its wheels.
  const cx = (bays[0] + bays[1]) / 2;
  put(Solid.union([
    box(cx - 0.11, cx + 0.11, -1.72, -1.36, 0.06, 0.2),
    box(cx - 0.08, cx + 0.04, -1.36, -1.3, 0.06, 0.16),
  ]), COMBINE);
  put(box(cx - 0.1, cx + 0.0, -1.42, -1.3, 0.16, 0.25), PANE);
  put(box(cx - 0.105, cx + 0.005, -1.425, -1.295, 0.25, 0.265), COMBINE);
  put(Solid.union([box(cx - 0.28, cx + 0.28, -1.26, -1.18, 0.02, 0.07), box(cx - 0.29, cx + 0.29, -1.27, -1.25, 0.02, 0.1)]), STEEL);
  put(Solid.union([wheel(cx - 0.11, -1.42, 0.065), wheel(cx + 0.11, -1.42, 0.065), wheel(cx - 0.1, -1.66, 0.045), wheel(cx + 0.1, -1.66, 0.045)]), TYRE);
  // The trailer and, before it, the plough, in the end bay.
  const tx = (bays[2] + bays[3]) / 2;
  put(box(tx - 0.1, tx + 0.1, -1.6, -1.28, 0.05, 0.13).subtract(box(tx - 0.09, tx + 0.09, -1.59, -1.29, 0.07, 0.14)), RED);
  put(box(tx - 0.01, tx + 0.01, -1.28, -1.2, 0.05, 0.065), STEEL);
  put(Solid.union([wheel(tx - 0.1, -1.44, 0.04, 0.025), wheel(tx + 0.1, -1.44, 0.04, 0.025)]), TYRE);
  put(Solid.union([
    box(tx - 0.11, tx + 0.11, -1.14, -1.11, 0.05, 0.07),
    box(tx - 0.01, tx + 0.01, -1.14, -1.0, 0.05, 0.065),
    ...[-0.08, -0.03, 0.02, 0.07].map((o) => hull([[tx + o, -1.12, 0.05], [tx + o + 0.02, -1.12, 0.05], [tx + o + 0.03, -1.09, 0.005], [tx + o + 0.05, -1.09, 0.005]])),
  ]), RED);

  // The farmhouse in the front corner, white, its gable to the street: a
  // porch on posts over its door, a dormer, a chimney; its garden in
  // front, fenced, the plot's corner.
  const [hx0, hx1, hy0, hy1, he, hr] = [-1.42, -0.82, 0.95, 1.55, 0.26, 0.44];
  gabled(hx0, hx1, hy0, hy1, he, hr, WHITE);
  const hmid = (hx0 + hx1) / 2;
  put(box(hmid - 0.05, hmid + 0.05, hy1 - 0.002, hy1 + 0.008, 0, 0.14), DOOR);
  for (const x of [hmid - 0.18, hmid + 0.18]) window(hy1, x, 0.05), window(hy1, x, 0.17, 0.06, 0.055);
  put(box(hmid - 0.13, hmid + 0.13, hy1, hy1 + 0.1, 0, 0.02), TIMBER);
  for (const x of [hmid - 0.12, hmid + 0.12]) put(box(x - 0.008, x + 0.008, hy1 + 0.085, hy1 + 0.1, 0.02, 0.15), WHITE);
  roof(sheet([hmid - 0.15, hy1, 0.165], [0.3, 0, 0], [0, 0.12, -0.03], 0.014));
  const [dy, dz] = [1.2, he + 0.04];
  put(box(hx1 - 0.16, hx1 - 0.05, dy - 0.06, dy + 0.06, he - 0.02, dz + 0.06), WHITE);
  roof(hull([[hx1 - 0.03, dy - 0.075, dz + 0.06], [hx1 - 0.03, dy + 0.075, dz + 0.06], [hx1 - 0.2, dy - 0.075, dz + 0.1], [hx1 - 0.2, dy + 0.075, dz + 0.1], [hx1 - 0.03, dy, dz + 0.11], [hx1 - 0.2, dy, dz + 0.14]]));
  put(box(hx1 - 0.05, hx1 - 0.045, dy - 0.035, dy + 0.035, dz, dz + 0.05), PANE);
  put(box(hx0 + 0.07, hx0 + 0.14, 1.0, 1.07, 0, hr + 0.08).add(box(hx0 + 0.062, hx0 + 0.148, 0.992, 1.078, hr + 0.06, hr + 0.08)), BRICK);
  fence(-1.47, 1.95, hmid - 0.06, 1.95, true);
  fence(hmid + 0.06, 1.95, -0.72, 1.95, true);
  fence(-0.72, 1.95, -0.72, 0.9, true);
  fence(-0.72, 0.9, -1.47, 0.9, true);
  put(Solid.union([[-1.38, 1.78, 0.05], [-0.82, 1.72, 0.045], [-1.0, 1.82, 0.035], [-0.8, 1.0, 0.04]].map(([x, y, r]) => Solid.sphere(r, 12).scale([1, 1, 0.8]).translate([x, y, r * 0.7]))), LEAVES);

  // The rail fence round the rest, open at the gate and, either side of
  // the yard, where the tractor goes out to the fields.
  fence(-1.47, -1.95, -0.1, -1.95);
  fence(-1.47, -1.95, -1.47, 0.05);
  fence(-1.47, 0.9, -1.47, 1.95, true);
  fence(mx1 + 0.02, -1.95, mx1 + 0.02, 0.05);
  fence(1.47, 0.95, 1.47, 1.95);
  fence(0.45, 1.95, 1.47, 1.95);
  fence(-0.72, 1.95, -0.45, 1.95);

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
/** Its trees, `[x, y, scale]`: in the corners and by the fence's gaps. */
export const FARM_TREES: [number, number, number][] = [[1.25, 1.65, 0.95], [1.3, 1.15, 0.75], [0.0, -1.75, 0.8], [1.28, -0.85, 0.7], [-1.28, -0.6, 0.75], [-0.55, 1.72, 0.6]];
