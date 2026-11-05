import type { RGB } from "../rgb";
import { barn, box, cask, chimney, crate, door, model, pitched, plate, post, put, window, type Cover, type Wall } from "./kit";

/**
 * A fishery, whole, on the back row of its plot (x -1.5 to 1.5, the street
 * at +y, its yard in front as the shop's): a boathouse of grey-blue boards
 * along the back under a rust-red roof, its big door to the yard; at one end a
 * smokehouse, its chimney smoking; at the other nets drying on poles; fish
 * in crates and casks along its front.
 */

const BOARDS: RGB = [0.62, 0.74, 0.8];
const TRIM: RGB = [0.94, 0.92, 0.86];
const ROOF: Cover = { finish: "ribs", rgb: [0.62, 0.36, 0.3], ribs: 18 };
const SMOKE_WALL: RGB = [0.86, 0.82, 0.74];
const SMOKE_ROOF: Cover = { finish: "tiles", rgb: [0.4, 0.3, 0.27] };
const WOOD: RGB = [0.5, 0.36, 0.25];
const NET: RGB = [0.36, 0.5, 0.48];
const FLOAT: RGB = [0.95, 0.62, 0.3];
const FISH: RGB = [0.75, 0.8, 0.84];
const DOOR: RGB = [0.3, 0.42, 0.5];

const [X0, X1, Y0, Y1, EAVE, RIDGE] = [-1.3, 0.55, -1.44, -0.66, 0.3, 0.52];

export const FISHERY = model((m) => {
  // The boathouse, its boards in courses, a white sill along its foot.
  put(m, "matte", barn("x", X0, X1, Y0, Y1, EAVE, RIDGE), BOARDS);
  for (let z = 0.06; z < EAVE; z += 0.06) put(m, "matte", box(X0 - 0.004, X1 + 0.004, Y0 - 0.004, Y1 + 0.004, z, z + 0.006), [0.54, 0.65, 0.71]);
  put(m, "matte", box(X0 - 0.01, X1 + 0.01, Y0 - 0.01, Y1 + 0.01, 0, 0.025), TRIM);
  pitched(m, "x", X0, X1, Y0, Y1, EAVE, RIDGE, ROOF, { over: 0.04 });
  const front: Wall = { face: "+y", at: Y1 };
  door(m, front, -0.38, DOOR, { w: 0.34, h: 0.24, frame: TRIM, step: false });
  for (const at of [-1.05, 0.25]) window(m, front, at, 0.13, { w: 0.09, h: 0.07, frame: TRIM, bars: 1 });
  window(m, { face: "-x", at: X0 }, (Y0 + Y1) / 2, 0.32, { w: 0.07, h: 0.07, frame: TRIM });
  // The name board over the door.
  put(m, "matte", plate(front, -0.62, -0.14, 0.26, 0.3, -0.002, 0.016), TRIM);

  // The smokehouse at the street end, brick-red, its chimney smoking.
  const [S0, S1, SY0, SY1] = [0.7, 1.32, -1.36, -0.86];
  put(m, "matte", barn("y", S0, S1, SY0, SY1, 0.22, 0.36), SMOKE_WALL);
  pitched(m, "y", S0, S1, SY0, SY1, 0.22, 0.36, SMOKE_ROOF, { over: 0.03 });
  door(m, { face: "+y", at: SY1 }, (S0 + S1) / 2, WOOD, { w: 0.08, h: 0.15, frame: TRIM });
  chimney(m, S1 - 0.12, SY0 + 0.12, 0.44, SMOKE_WALL, { w: 0.08, smoke: 0.12 });

  // Nets drying between poles, in front of the boathouse's end.
  for (const x of [-1.38, -1.02]) put(m, "matte", post(x, -0.5, 0, 0.26, 0.012, 6), WOOD);
  put(m, "matte", box(-1.38, -1.02, -0.505, -0.495, 0.08, 0.25), NET);
  for (const x of [-1.32, -1.2, -1.08]) put(m, "matte", box(x - 0.012, x + 0.012, -0.51, -0.49, 0.22, 0.24), FLOAT);

  // The catch: crates of fish and casks by the door.
  for (const [x, y] of [[0.04, -0.56], [0.14, -0.56], [0.09, -0.56]] as const) crate(m, x - 0.04, y, 0, 0.07, WOOD, FISH);
  crate(m, 0.1, -0.56, 0.05, 0.07, WOOD, FISH);
  for (const x of [0.32, 0.42]) cask(m, x, -0.57, 0.035, 0.09, WOOD);
});
