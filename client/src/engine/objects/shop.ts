import type { RGB } from "../rgb";
import { awning, barn, bench, box, chimney, crate, door, halfRound, leanTo, model, pitched, plate, put, rod, topiary, window, type Cover, type Wall } from "./kit";

/**
 * A shop, whole, on its tile (`refresh/refs/shop-gpt.png`): the shop
 * itself on one side, two storeys, its gable end to the street; on the
 * other a little courtyard. Its tile x -0.5 to 0.5, y the same, the street
 * at +y; its ground on z = 0. The front strip, its last INSET (`pads.ts`),
 * is the pavement its goods stand on and, at lunch, its table; the
 * hedges round it and the courtyard's paving are the town grid's.
 *
 * - Its front: the shop window under a striped awning, scalloped, the
 *   produce in crates on a stall before it; the door arched, blue, on the
 *   right; a blue band between the floors, hooded over the door; up in
 *   the gable an arched window over a box of flowers, a small one either
 *   side; the sign hung out over the courtyard's way in.
 * - Over it a roof of blue tiles, deep at the front; a chimney, a vent.
 * - The courtyard: a bench, a clipped tree in a pot, and across its back
 *   a low store, its door to the yard.
 */

const WALL: RGB = [0.93, 0.89, 0.8];
const ROOF: Cover = { finish: "tiles", rgb: [0.33, 0.43, 0.7] };
const BAND: RGB = [0.27, 0.38, 0.66];
const WOOD: RGB = [0.55, 0.37, 0.24];
const DOOR: RGB = [0.27, 0.38, 0.64];
const STONE: RGB = [0.74, 0.7, 0.63];
const IRON: RGB = [0.18, 0.19, 0.21];
const STRIPES: RGB[] = [[0.3, 0.42, 0.72], [0.96, 0.95, 0.9]];
/** What the stall holds: oranges, lemons, greens. */
const PRODUCE: RGB[] = [[0.92, 0.5, 0.22], [0.95, 0.82, 0.3], [0.42, 0.66, 0.3]];

/** The shop's walls, from and to; its eaves and its ridge. */
const [X0, X1, Y0, Y1, EAVE, RIDGE] = [-0.1, 0.42, -0.3, 0.3, 0.36, 0.56];

export const SHOP = model((m) => {
  put(m, "matte", barn("y", X0, X1, Y0, Y1, EAVE, RIDGE), WALL);
  put(m, "matte", box(X0 - 0.008, X1 + 0.008, Y0 - 0.008, Y1 + 0.008, 0, 0.03), STONE);
  pitched(m, "y", X0, X1, Y0, Y1 + 0.03, EAVE, RIDGE, ROOF, { over: 0.045 });
  const front: Wall = { face: "+y", at: Y1 };
  const mid = (X0 + X1) / 2;
  // The band between the floors, and its hood over the door.
  put(m, "matte", plate(front, X0 - 0.006, X1 + 0.006, 0.205, 0.225, -0.002, 0.014), BAND);
  const doorAt = X1 - 0.075;
  put(m, "matte", halfRound(front, doorAt, 0.205, 0.06, -0.002, 0.03, false, 12).subtract(plate(front, doorAt - 0.1, doorAt + 0.1, 0.1, 0.205, -0.01, 0.04)), BAND);
  door(m, front, doorAt, DOOR, { w: 0.08, h: 0.185, frame: WOOD, arch: true });
  // The shop window, its frame and sill, its awning; the stall before it.
  const [w0, w1] = [X0 + 0.03, doorAt - 0.06];
  put(m, "matte", plate(front, w0 - 0.012, w1 + 0.012, 0.035, 0.19, -0.004, 0.008).subtract(plate(front, w0, w1, 0.05, 0.18, -0.002, 0.012)), WOOD);
  put(m, "glass", plate(front, w0, w1, 0.05, 0.18, -0.004, 0.002), [0.24, 0.29, 0.36]);
  put(m, "matte", plate(front, (w0 + w1) / 2 - 0.004, (w0 + w1) / 2 + 0.004, 0.05, 0.18, -0.002, 0.006), WOOD);
  // The display behind the glass: shelves of the same produce.
  PRODUCE.forEach((fill, k) => put(m, "matte", plate(front, w0 + 0.01 + ((w1 - w0 - 0.02) * k) / 3, w0 + 0.01 + ((w1 - w0 - 0.02) * (k + 1)) / 3 - 0.006, 0.05, 0.085, -0.03, -0.006), fill));
  awning(m, front, w0 - 0.025, w1 + 0.025, 0.205, STRIPES, { depth: 0.1, drop: 0.045, stripes: 8, scallops: true });
  put(m, "matte", plate(front, w0 - 0.005, w1 + 0.005, 0, 0.025, 0, 0.07), WOOD);
  PRODUCE.forEach((fill, k) => crate(m, w0 + 0.04 + ((w1 - w0 - 0.08) * k) / 2, Y1 + 0.036, 0.025, 0.068, WOOD, fill));
  // Up in the gable: the arched window over its flowers, a small one either side.
  window(m, front, mid, 0.255, { w: 0.09, h: 0.055, frame: WOOD, arch: true, box: [0.45, 0.32, 0.22] });
  for (const s of [-1, 1]) window(m, front, mid + s * 0.165, 0.265, { w: 0.035, h: 0.06, frame: WOOD, bars: 0 });
  // Its side to the courtyard: a window down, one up; the back the same.
  const yard: Wall = { face: "-x", at: X0 };
  window(m, yard, 0.06, 0.06, { w: 0.07, h: 0.075, frame: WOOD });
  window(m, yard, -0.15, 0.25, { w: 0.06, h: 0.06, frame: WOOD });
  window(m, { face: "+x", at: X1 }, -0.1, 0.25, { w: 0.06, h: 0.06, frame: WOOD });
  window(m, { face: "+x", at: X1 }, 0.1, 0.06, { w: 0.06, h: 0.07, frame: WOOD });
  chimney(m, X1 - 0.09, -0.3, RIDGE + 0.06, WALL, { smoke: 0.09 });
  put(m, "matte", box(X0 + 0.08, X0 + 0.15, -0.26, -0.19, 0.4, 0.5), BAND);

  // The sign, hung from a bracket out over the courtyard's way in.
  const [sx, sz, sy] = [X0 - 0.12, 0.25, Y1 + 0.02];
  put(m, "matte", rod([X0, sy, sz + 0.09], [sx - 0.06, sy, sz + 0.09], 0.012).add(rod([X0, sy, sz + 0.035], [X0 - 0.06, sy, sz + 0.09], 0.008)), IRON);
  for (const x of [sx - 0.045, sx + 0.045]) put(m, "matte", rod([x, sy, sz + 0.09], [x, sy, sz + 0.07], 0.005), IRON);
  put(m, "matte", box(sx - 0.06, sx + 0.06, sy - 0.007, sy + 0.007, sz - 0.03, sz + 0.07), BAND);
  put(m, "matte", box(sx - 0.042, sx + 0.042, sy + 0.005, sy + 0.01, sz - 0.015, sz + 0.055), [0.9, 0.86, 0.72]);

  // The courtyard: the store across its back, its door to the yard; a
  // bench along the side, the tree in its pot in the corner.
  const [bx0, bx1, by0, by1] = [-0.46, X0, -0.44, -0.33];
  put(m, "matte", box(bx0, bx1, by0, by1, 0, 0.14), WALL);
  leanTo(m, { face: "+y", at: by0 }, bx0 - 0.02, bx1, 0.17, by1 - by0 + 0.03, 0.035, ROOF);
  door(m, { face: "+y", at: by1 }, -0.2, WOOD, { w: 0.07, h: 0.12, frame: WOOD });
  bench(m, -0.4, 0.02, "y", WOOD);
  topiary(m, -0.38, -0.2, 0.06);
});
