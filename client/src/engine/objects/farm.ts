import type { Manifold } from "manifold-3d";
import type { MeshGeometry } from "../geometry";
import { mesh, Solid, solids } from "../solid";
import { shape, type Part } from "./sea";
import type { RGB } from "../rgb";
import { box, golf, hull, PITCH, placing, sheet, tiled, TILES, WOOD, ZINC, ZINC_COLOUR, type V } from "./model";

/**
 * A farm, whole: its barn, its silos and its shed, one model on the back
 * of its plot, three tiles across (x, -1.5 to 1.5) and four deep (y), the
 * street at +y; its ground on z = 0. Its yard, the front half, is the
 * lorries' and the tractor's (`lots.rs`), its crates on their pad by the
 * lane (`pads.ts`); its fields round it the town grid's (`field.ts`).
 *
 * - The barn in the middle, its gable end to the yard: a gambrel roof,
 *   its big door at the end of the lane, the loft's door over it, a beam
 *   out to hoist the hay up.
 * - On one side two silos, zinc, domed, a ladder up the taller.
 * - On the other the shed, open to the yard, a zinc lean-to on posts,
 *   round bales stacked under it and out in front.
 */

const WALL: RGB = [0.6, 0.31, 0.25];
const TRIM: RGB = [0.95, 0.92, 0.86];
const ROOF: RGB = [0.46, 0.43, 0.42];
const DOME: RGB = [0.62, 0.63, 0.65];
const DOOR: RGB = [0.5, 0.25, 0.2];
const DARK: RGB = [0.2, 0.18, 0.17];
const STRAW: RGB = [0.86, 0.72, 0.42];
const POST: RGB = [0.48, 0.36, 0.26];
const BASE: RGB = [0.7, 0.68, 0.64];

/** The barn: across, deep, its walls, its roofs' knee and its ridge. */
const [BX0, BX1, BY0, BY1] = [-0.55, 0.55, -1.9, -0.12];
const [EAVE, KNEE, RIDGE, IN] = [0.22, 0.4, 0.52, 0.16];

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
  const wood: Part[] = [], zinc: Part[] = [], tiles: Part[] = [];
  const put = (solid: Manifold, rgb: RGB) => wood.push([mesh(solid), [0, 0, 0], rgb]);
  const zinced = (geo: MeshGeometry) => zinc.push([geo, [0, 0, 0], ZINC_COLOUR]);

  // The barn: its walls up its gambrel ends, a plinth round its foot.
  const mid = (BX0 + BX1) / 2;
  put(hull([BY0, BY1].flatMap((y): V[] => [[BX0, y, 0], [BX1, y, 0], [BX0, y, EAVE], [BX1, y, EAVE], [BX0 + IN, y, KNEE], [BX1 - IN, y, KNEE], [mid, y, RIDGE]])), WALL);
  put(box(BX0 - 0.01, BX1 + 0.01, BY0 - 0.01, BY1 + 0.01, 0, 0.03), BASE);
  // Its roof, each side two slopes, past its ends and its walls.
  const [o, t] = [0.04, 0.018];
  const slope = (a: [number, number], b: [number, number]) => {
    const [dx, dz] = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(dx, dz);
    const [ax, az] = [a[0] - (dx / l) * o * (a[1] < KNEE ? 1 : 0), a[1] - (dz / l) * o * (a[1] < KNEE ? 1 : 0)];
    tiles.push([tiled(sheet([ax, BY0 - o, az], [0, BY1 - BY0 + 2 * o, 0], [b[0] - ax, 0, b[1] - az], t)), [0, 0, 0], ROOF]);
  };
  for (const s of [-1, 1]) {
    const x = (d: number) => mid + s * d;
    slope([x((BX1 - BX0) / 2), EAVE], [x((BX1 - BX0) / 2 - IN), KNEE]);
    slope([x((BX1 - BX0) / 2 - IN), KNEE], [mid, RIDGE]);
  }
  // Its big door at the lane's end, braced; the loft's door over it, the
  // hoist's beam out over that.
  const front = BY1 + 0.004;
  const door = (x0: number, x1: number, z0: number, z1: number) => {
    put(box(x0 - 0.015, x1 + 0.015, BY1 - 0.002, front + 0.006, z0, z1 + 0.015), TRIM);
    put(box(x0, x1, BY1, front + 0.01, z0, z1), DOOR);
    const w = 0.008;
    for (const [a, b] of [[[x0, z0], [x1, z1]], [[x0, z1], [x1, z0]]] as [number, number][][])
      put(hull([a, b].flatMap(([x, z]): V[] => [[x - w, front + 0.01, z - w], [x + w, front + 0.01, z - w], [x - w, front + 0.016, z + w], [x + w, front + 0.016, z + w]])).intersect(box(x0, x1, front, front + 0.02, z0, z1)), TRIM);
    put(box((x0 + x1) / 2 - 0.004, (x0 + x1) / 2 + 0.004, front + 0.01, front + 0.016, z0, z1), TRIM);
  };
  door(mid - 0.17, mid + 0.17, 0, 0.21);
  door(mid - 0.07, mid + 0.07, 0.27, 0.38);
  put(box(mid - 0.012, mid + 0.012, BY1, BY1 + 0.12, RIDGE - 0.06, RIDGE - 0.035), POST);
  // A window either side down its walls.
  for (const s of [-1, 1]) for (const y of [-1.5, -0.95, -0.45]) {
    const x = s > 0 ? BX1 : BX0;
    put(box(x - 0.006, x + 0.006, y - 0.05, y + 0.05, 0.08, 0.16), TRIM);
    put(box(x - 0.009, x + 0.009, y - 0.038, y + 0.038, 0.09, 0.15), DARK);
  }

  // The silos, on the +x side, the taller behind, their domes and their rings.
  for (const [x, y, r, h] of [[0.98, -1.5, 0.22, 0.78], [1.0, -0.88, 0.18, 0.6]]) {
    zinced(silo(x, y, r, h));
    put(Solid.sphere(r + 0.012, 24).scale([1, 1, 0.55]).translate([x, y, h]), DOME);
    put(Solid.cylinder(0.03, r + 0.012, r + 0.012, 24).translate([x, y, 0]), BASE);
    put(Solid.cylinder(0.012, r + 0.01, r + 0.01, 24).translate([x, y, h - 0.012]), TRIM);
  }
  // A ladder up the taller, to its yard side.
  put(Solid.union([
    ...[-1, 1].map((s) => box(0.98 + s * 0.03 - 0.005, 0.98 + s * 0.03 + 0.005, -1.28, -1.27, 0, 0.84)),
    ...Array.from({ length: 10 }, (_, k) => box(0.95, 1.01, -1.28, -1.272, 0.06 + k * 0.08, 0.066 + k * 0.08)),
  ]), TRIM);

  // The shed on the -x side, open to the yard: posts, its back wall, a
  // zinc lean-to; round bales under it, a stack of them out in front,
  // one by the barn.
  const [sx0, sx1, sy0, sy1, sh] = [-1.42, -0.72, -1.85, -0.95, 0.2];
  put(box(sx0, sx1, sy0, sy0 + 0.03, 0, sh + 0.05), POST);
  put(box(sx0, sx0 + 0.03, sy0, sy1, 0, sh), POST);
  for (const x of [sx0 + 0.015, (sx0 + sx1) / 2, sx1 - 0.015]) put(box(x - 0.015, x + 0.015, sy1 - 0.03, sy1, 0, sh), POST);
  for (const y of [(sy0 + sy1) / 2]) put(box(sx1 - 0.03, sx1, y - 0.015, y + 0.015, 0, sh + 0.02), POST);
  zinced(golf([sx0 - 0.04, sy0 - 0.03, sh + 0.07], [0, sy1 - sy0 + 0.1, 0], [sx1 - sx0 + 0.08, 0, -0.04], 0.01));
  const bale = (x: number, y: number, z: number, along: "x" | "y") => {
    const b = Solid.cylinder(0.09, 0.055, 0.055, 16).translate([0, 0, -0.045]);
    return (along === "x" ? b.rotate([0, 90, 0]) : b.rotate([90, 0, 0])).translate([x, y, z + 0.055]);
  };
  put(Solid.union([
    ...[-1.6, -1.45, -1.3, -1.15].map((y) => bale(-1.27, y, 0, "x")),
    ...[-1.53, -1.38].map((y) => bale(-1.27, y, 0.1, "x")),
    ...[-0.78, -0.63, -0.48].map((y) => bale(-1.2, y, 0, "x")),
    ...[-0.705, -0.555].map((y) => bale(-1.2, y, 0.1, "x")),
    bale(-1.2, -0.63, 0.2, "x"),
    bale(-0.95, -0.7, 0, "y"),
    bale(-0.65, -0.05, 0, "x"),
  ]), STRAW);

  return { wood: { shape: shape(wood), coat: WOOD }, zinc: { shape: shape(zinc), coat: ZINC }, tiles: { shape: shape(tiles), coat: TILES } };
});

/** The farm, or its mirror, its silos the other side. */
export const farm = placing("farm", FARM);
