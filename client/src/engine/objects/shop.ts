import type { Manifold } from "manifold-3d";
import { mesh, Solid, solids } from "../solid";
import { shape, type Part } from "./sea";
import type { RGB } from "../rgb";
import { barnX, barnY, box, hull, placing, ribbed, sheet, WOOD, type V } from "./model";

/**
 * A shop, whole, on its tile, as `docs/style.md`'s board drew it: an L
 * round a little courtyard. Its tile x -0.5 to 0.5, y the same, the street
 * at +y; its ground on z = 0. The front strip, its last INSET (`pads.ts`),
 * is the pavement its crates stand on and its lunch table.
 *
 * - The shop: its gable end to the street, two storeys, the window and
 *   the door under a striped awning, slate blue tiles.
 * - Across the back the low wing, its dormer to the courtyard, its
 *   chimney.
 * - The courtyard: paved, a bench, a tree in a tub.
 */

const WALL: RGB = [0.91, 0.86, 0.77];
const ROOF: RGB = [0.36, 0.45, 0.63];
const COURSE: RGB = [0.3, 0.38, 0.55];
const TRIM: RGB = [0.97, 0.95, 0.9];
const PANE: RGB = [0.24, 0.29, 0.36];
const DOOR: RGB = [0.28, 0.36, 0.52];
const STRIPE: RGB = [0.36, 0.48, 0.72];
const PAVING: RGB = [0.78, 0.74, 0.68];
const BENCH: RGB = [0.55, 0.4, 0.28];
const BRICK: RGB = [0.62, 0.36, 0.27];
const LEAVES: RGB = [0.36, 0.55, 0.3];
const TUB: RGB = [0.54, 0.42, 0.32];

/** The shop and its wing: the shop's walls and roof, from and to. */
const [SX0, SX1, SY0, SY1, SE, SR] = [0.0, 0.4, -0.42, 0.32, 0.27, 0.44];
const [WX0, WY1, WE, WR] = [-0.4, -0.06, 0.17, 0.31];

const SHOP = solids(() => {
  const wood: Part[] = [];
  const put = (solid: Manifold, rgb: RGB) => wood.push([mesh(solid), [0, 0, 0], rgb]);
  /** A pitched roof's slope: from its ridge `top`, down `down` to past its
   *  eave, along `along`; tiled in courses. */
  const slope = (top: V, along: V, down: V) => {
    const [s, r] = ribbed(top, down, along, 0.014, 7, 0.008);
    put(s, ROOF), put(r, COURSE);
  };
  const o = 0.04;

  // The shop, its ridge to the street.
  put(barnY(SX0, SX1, SY0, SY1, SE, SR), WALL);
  for (const s of [-1, 1]) slope([(SX0 + SX1) / 2, SY0 - o, SR], [0, SY1 - SY0 + 2 * o, 0], [s * ((SX1 - SX0) / 2 + o), 0, -(SR - SE) * (1 + o / ((SX1 - SX0) / 2))]);
  put(box((SX0 + SX1) / 2 - 0.012, (SX0 + SX1) / 2 + 0.012, SY0 - o, SY1 + o, SR - 0.004, SR + 0.02), COURSE);
  // Its front: the shop window and the door, the awning over them, two
  // windows above.
  const front = SY1 + 0.004;
  put(box(SX0 + 0.04, SX0 + 0.25, SY1 - 0.002, front + 0.004, 0.025, 0.15), TRIM);
  put(box(SX0 + 0.05, SX0 + 0.24, SY1, front + 0.008, 0.035, 0.14), PANE);
  put(box(SX0 + 0.28, SX0 + 0.36, SY1 - 0.002, front + 0.006, 0, 0.16), DOOR);
  for (const x of [SX0 + 0.1, SX0 + 0.3]) {
    put(box(x - 0.045, x + 0.045, SY1 - 0.002, front + 0.004, 0.185, 0.25), TRIM);
    put(box(x - 0.035, x + 0.035, SY1, front + 0.008, 0.195, 0.24), PANE);
  }
  const stripes = 7;
  for (let k = 0; k < stripes; k++) {
    const [x0, x1] = [SX0 + 0.03 + (k * 0.34) / stripes, SX0 + 0.03 + ((k + 1) * 0.34) / stripes];
    put(sheet([x0, front, 0.175], [x1 - x0, 0, 0], [0, 0.1, -0.045], 0.008), k % 2 ? TRIM : STRIPE);
  }
  // Its side to the courtyard: a window a storey.
  for (const [y, z] of [[0.05, 0.05], [0.05, 0.18], [-0.2, 0.18]]) {
    put(box(SX0 - 0.004, SX0 + 0.002, y - 0.045, y + 0.045, z, z + 0.07), TRIM);
    put(box(SX0 - 0.008, SX0, y - 0.035, y + 0.035, z + 0.01, z + 0.06), PANE);
  }

  // The wing across the back, low, its ridge across, its dormer and its
  // door to the courtyard, its chimney.
  put(barnX(WX0, SX0 + 0.02, SY0, WY1, WE, WR), WALL);
  for (const s of [-1, 1]) slope([WX0 - o, (SY0 + WY1) / 2, WR], [SX0 - WX0 + o, 0, 0], [0, s * ((WY1 - SY0) / 2 + o), -(WR - WE) * (1 + o / ((WY1 - SY0) / 2))]);
  const [dx, dw] = [-0.22, 0.07];
  put(hull([[dx - dw, -0.2, WE + 0.03], [dx + dw, -0.2, WE + 0.03], [dx - dw, WY1 + 0.02, WE + 0.03], [dx + dw, WY1 + 0.02, WE + 0.03], [dx - dw, -0.2, WE + 0.11], [dx + dw, -0.2, WE + 0.11], [dx - dw, WY1 + 0.02, WE + 0.11], [dx + dw, WY1 + 0.02, WE + 0.11]]), WALL);
  for (const s of [-1, 1]) put(sheet([dx, -0.2, WE + 0.15], [0, WY1 + 0.04 + 0.2, 0], [s * (dw + 0.02), 0, -0.05], 0.012), ROOF);
  put(box(dx - 0.035, dx + 0.035, WY1 + 0.02, WY1 + 0.028, WE + 0.04, WE + 0.1), PANE);
  put(box(-0.1, -0.03, WY1 - 0.002, WY1 + 0.006, 0, 0.13), DOOR);
  put(box(-0.36, -0.3, -0.34, -0.28, 0.2, WR + 0.1).add(box(-0.37, -0.29, -0.35, -0.27, WR + 0.08, WR + 0.11)), BRICK);

  // The courtyard: paved, a bench along the shop's side, a tree in a tub.
  put(box(WX0, SX0, WY1, SY1, 0, 0.01), PAVING);
  put(Solid.union([
    box(SX0 - 0.13, SX0 - 0.03, 0.12, 0.27, 0.035, 0.045),
    box(SX0 - 0.04, SX0 - 0.025, 0.12, 0.27, 0.045, 0.08),
    ...[0.13, 0.26].map((y) => box(SX0 - 0.12, SX0 - 0.03, y - 0.006, y + 0.006, 0, 0.035)),
  ]), BENCH);
  put(Solid.cylinder(0.05, 0.05, 0.042, 12).translate([-0.3, 0.16, 0]), TUB);
  put(Solid.cylinder(0.08, 0.008, 0.008, 6).translate([-0.3, 0.16, 0.05]), BENCH);
  put(Solid.sphere(0.085, 16).scale([1, 1, 0.85]).translate([-0.3, 0.16, 0.2]).add(Solid.sphere(0.06, 12).translate([-0.25, 0.2, 0.25])), LEAVES);

  return { wood: { shape: shape(wood), coat: WOOD } };
});

/** A shop, or its mirror, its courtyard on the other side. */
export const shop = placing("shop", SHOP);
