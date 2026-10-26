import type { Manifold } from "manifold-3d";
import { mesh, Solid, solids } from "../solid";
import { shape, type Part } from "./sea";
import type { RGB } from "../rgb";
import { barnX, barnY, box, GLASS, hull, placing, ribbed, sheet, WOOD, type V } from "./model";

/**
 * A bakery, whole, on its plot, as its reference drew it
 * (`/mnt/project-files/bakery/gemini-1.png`): two tiles across (x, -1 to
 * 1) and three deep (y), the street at +y, its gate on +x; its ground on
 * z = 0. The building is the back row, its yard the two in front
 * (`lots.rs`), the lane up the gate's side and the one dock across it,
 * nearest the building, on the other.
 *
 * - The shop: its gable end to the yard, two storeys, the shop window
 *   and the door, a gold sign with a loaf over them; slate blue tiles.
 * - Behind it to the dock's side the bakehouse, low, its dormer, and the
 *   oven's brick chimney.
 * - Over the dock the garage, its open door to the lane: the lorry backs
 *   in and is loaded out of sight.
 */

const WALL: RGB = [0.91, 0.86, 0.77];
const ROOF: RGB = [0.36, 0.45, 0.63];
const COURSE: RGB = [0.3, 0.38, 0.55];
const TRIM: RGB = [0.97, 0.95, 0.9];
const PANE: RGB = [0.24, 0.29, 0.36];
const DOOR: RGB = [0.5, 0.36, 0.24];
const BRICK: RGB = [0.62, 0.36, 0.27];
const GOLD: RGB = [0.86, 0.66, 0.3];
const CRUST: RGB = [0.74, 0.45, 0.22];
const DARK: RGB = [0.2, 0.19, 0.18];

/** The shop: its walls and roof, from and to. */
const [SX0, SX1, SY0, SY1, SE, SR] = [0.02, 0.9, -1.42, -0.56, 0.27, 0.48];
/** The bakehouse behind, its ridge across. */
const [BX0, BY0, BY1, BE, BR] = [-0.94, -1.42, -0.9, 0.2, 0.36];
/** The garage over the dock: its walls, its door's sides, how high. */
const [GX0, GX1, GY0, GY1, GE, GR] = [-0.97, -0.16, -0.9, 0.36, 0.22, 0.4];
const [DY0, DY1, DH] = [-0.17, 0.27, 0.2];

/** The oven's chimney, where it stands and how high its top: the
 *  smoke's, as `roof.ts` has it. */
const CHIMNEY: V = [-0.66, -1.2, 0.66];

const BAKERY = solids(() => {
  const wood: Part[] = [], glass: Part[] = [];
  const put = (solid: Manifold, rgb: RGB) => (rgb === PANE ? glass : wood).push([mesh(solid), [0, 0, 0], rgb]);
  /** A pitched roof's slope: from its ridge `top`, down `down` to past its
   *  eave, along `along`; tiled in courses. */
  const slope = (top: V, along: V, down: V) => {
    const [s, r] = ribbed(top, down, along, 0.014, 9, 0.008);
    put(s, ROOF), put(r, COURSE);
  };
  const o = 0.04;
  /** A window on a wall facing ±y at `y`, its middle `x` and its sill `z`. */
  const windowY = (x: number, y: number, z: number, s: 1 | -1, w = 0.09, h = 0.075) => {
    put(box(x - w / 2 - 0.01, x + w / 2 + 0.01, y - 0.004, y + 0.006, z - 0.01, z + h + 0.01).translate([0, s > 0 ? 0 : -0.002, 0]), TRIM);
    put(box(x - w / 2, x + w / 2, y - 0.002, y + 0.01 * s, z, z + h), PANE);
  };

  // The shop, its gable to the yard.
  put(barnY(SX0, SX1, SY0, SY1, SE, SR), WALL);
  const half = (SX1 - SX0) / 2;
  for (const s of [-1, 1]) slope([(SX0 + SX1) / 2, SY0 - o, SR], [0, SY1 - SY0 + 2 * o, 0], [s * (half + o), 0, -(SR - SE) * (1 + o / half)]);
  put(box((SX0 + SX1) / 2 - 0.012, (SX0 + SX1) / 2 + 0.012, SY0 - o, SY1 + o, SR - 0.004, SR + 0.02), COURSE);
  // Its front: the shop window, wide, and the door; the sign over them,
  // a loaf on it; two windows above and one in the gable.
  const front = SY1 + 0.004;
  put(box(SX0 + 0.08, SX0 + 0.5, SY1 - 0.002, front + 0.004, 0.025, 0.16), TRIM);
  put(box(SX0 + 0.09, SX0 + 0.49, SY1, front + 0.008, 0.035, 0.15), PANE);
  for (const x of [SX0 + 0.22, SX0 + 0.36]) put(box(x - 0.006, x + 0.006, SY1, front + 0.01, 0.035, 0.15), TRIM);
  put(box(SX0 + 0.58, SX0 + 0.72, SY1 - 0.002, front + 0.006, 0, 0.17), DOOR);
  put(box(SX0 + 0.6, SX0 + 0.7, SY1, front + 0.008, 0.1, 0.155), PANE);
  put(box(SX0 + 0.14, SX0 + 0.62, SY1, front + 0.014, 0.18, 0.235), GOLD);
  put(Solid.sphere(0.05, 16).scale([1.5, 0.45, 0.6]).translate([SX0 + 0.38, front + 0.02, 0.21]), CRUST);
  for (const x of [SX0 + 0.2, SX0 + 0.68]) windowY(x, SY1, 0.27, 1, 0.08, 0.07);
  windowY((SX0 + SX1) / 2, SY1, 0.38, 1, 0.06, 0.05);
  // Its side to the street's way along: a window a storey.
  for (const [y, z] of [[-0.8, 0.06], [-0.8, 0.2], [-1.15, 0.2]]) {
    put(box(SX1 - 0.002, SX1 + 0.004, y - 0.045, y + 0.045, z, z + 0.07), TRIM);
    put(box(SX1, SX1 + 0.008, y - 0.035, y + 0.035, z + 0.01, z + 0.06), PANE);
  }

  // The bakehouse behind, low, its ridge across, a dormer to the yard.
  put(barnX(BX0, SX0 + 0.02, BY0, BY1, BE, BR), WALL);
  const bh = (BY1 - BY0) / 2;
  for (const s of [-1, 1]) slope([BX0 - o, (BY0 + BY1) / 2, BR], [SX0 - BX0 + o, 0, 0], [0, s * (bh + o), -(BR - BE) * (1 + o / bh)]);
  const [dx, dw] = [-0.45, 0.08];
  put(hull([[dx - dw, -1.16, BE + 0.02], [dx + dw, -1.16, BE + 0.02], [dx - dw, BY1 + 0.02, BE + 0.02], [dx + dw, BY1 + 0.02, BE + 0.02], [dx - dw, -1.16, BE + 0.1], [dx + dw, -1.16, BE + 0.1], [dx - dw, BY1 + 0.02, BE + 0.1], [dx + dw, BY1 + 0.02, BE + 0.1]]), WALL);
  for (const s of [-1, 1]) put(sheet([dx, -1.16, BE + 0.145], [0, BY1 + 0.04 + 1.16, 0], [s * (dw + 0.02), 0, -0.05], 0.012), ROOF);
  put(box(dx - 0.035, dx + 0.035, BY1 + 0.02, BY1 + 0.028, BE + 0.035, BE + 0.09), PANE);

  // The oven's chimney, brick, up past the shop's ridge, its cap.
  const [cx, cy, ct] = CHIMNEY;
  put(box(cx - 0.05, cx + 0.05, cy - 0.05, cy + 0.05, 0.2, ct).add(box(cx - 0.062, cx + 0.062, cy - 0.062, cy + 0.062, ct - 0.03, ct)), BRICK);
  put(box(cx - 0.03, cx + 0.03, cy - 0.03, cy + 0.03, ct - 0.02, ct + 0.002), DARK);

  // The garage over the dock, its ridge along the lorry, its gable's open
  // door to the lane, dark inside.
  const shell = barnX(GX0, GX1, GY0, GY1, GE, GR);
  const inside = barnX(GX0 + 0.03, GX1 + 0.1, GY0 + 0.03, GY1 - 0.03, GE - 0.01, GR - 0.03);
  const door = box(GX1 - 0.1, GX1 + 0.1, DY0, DY1, -0.01, DH);
  put(shell.subtract(inside.add(door)), WALL);
  put(box(GX0 + 0.03, GX1 - 0.01, GY0 + 0.03, GY1 - 0.03, 0, 0.004), DARK);
  const gh = (GY1 - GY0) / 2;
  for (const s of [-1, 1]) slope([GX0 - o, (GY0 + GY1) / 2, GR], [GX1 - GX0 + 2 * o, 0, 0], [0, s * (gh + o), -(GR - GE) * (1 + o / gh)]);
  put(box(GX1 - 0.004, GX1 + 0.01, DY0 - 0.025, DY0, 0, DH + 0.025).add(box(GX1 - 0.004, GX1 + 0.01, DY1, DY1 + 0.025, 0, DH + 0.025)).add(box(GX1 - 0.004, GX1 + 0.01, DY0 - 0.025, DY1 + 0.025, DH, DH + 0.025)), TRIM);
  // A window on its side to the street.
  put(box(-0.66, -0.5, GY1 - 0.002, GY1 + 0.004, 0.08, 0.16), TRIM);
  put(box(-0.65, -0.51, GY1, GY1 + 0.008, 0.09, 0.15), PANE);

  return { wood: { shape: shape(wood), coat: WOOD }, glass: { shape: shape(glass), coat: GLASS } };
});

/** A bakery, or its mirror, its gate on the other side. */
export const bakery = placing("bakery", BAKERY);
