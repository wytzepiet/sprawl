import type { RGB } from "../rgb";
import { barn, box, chimney, door, flowers, hipped, hull, model, pitched, put, shrub, window, type Built, type Cover, type Model } from "./kit";

/**
 * A house, whole, on its tile, one of a few, as `docs/style.md`'s board
 * drew them. Its tile x -0.5 to 0.5, y the same, the street at +y; its
 * ground on z = 0; the hedges round its garden are the town grid's.
 *
 * - The cottage: an L, its gable end to the street, a lower wing across
 *   beside it, the chimney up its side, a porch over the door.
 * - The villa: square, two storeys under a hipped roof, two dormers to
 *   the street, the chimney up through the middle.
 * - The farmhouse: long, its ridge along the street, a gable over the
 *   door in its middle.
 *
 * Each a garden shed at the back. Brick and tile, a door of its own.
 */

const BRICK: RGB = [0.66, 0.34, 0.25];
const TILE: Cover = { finish: "tiles", rgb: [0.72, 0.37, 0.26] };
const SHED: RGB = [0.5, 0.38, 0.27];
const SHED_ROOF: RGB = [0.32, 0.3, 0.29];
const DOORS: RGB[] = [[0.3, 0.45, 0.36], [0.33, 0.42, 0.58], [0.6, 0.3, 0.26]];

/** The garden shed at the back, its roof a lean-to. */
function shed(m: Model, x: number) {
  put(m, "matte", box(x - 0.08, x + 0.08, -0.45, -0.33, 0, 0.1), SHED);
  put(m, "matte", hull([[x - 0.1, -0.47, 0.1], [x + 0.1, -0.47, 0.1], [x - 0.1, -0.31, 0.125], [x + 0.1, -0.31, 0.125], [x - 0.1, -0.47, 0.112], [x + 0.1, -0.47, 0.112], [x - 0.1, -0.31, 0.137], [x + 0.1, -0.31, 0.137]]), SHED_ROOF);
  door(m, { face: "-x", at: x - 0.08 }, -0.39, SHED, { w: 0.05, h: 0.08, step: false });
}

const cottage = (doorColour: RGB) => model((m) => {
  // The main body, its gable end to the street.
  const [x0, x1, y0, y1, eave, ridge] = [-0.04, 0.32, -0.28, 0.3, 0.2, 0.42];
  put(m, "matte", barn("y", x0, x1, y0, y1, eave, ridge), BRICK);
  pitched(m, "y", x0, x1, y0, y1, eave, ridge, TILE);
  // The wing across beside it, lower.
  const [wx0, wy0, wy1, we, wr] = [-0.34, -0.28, 0.08, 0.15, 0.32];
  put(m, "matte", barn("x", wx0, x0 + 0.02, wy0, wy1, we, wr), BRICK);
  pitched(m, "x", wx0, x0, wy0, wy1, we, wr, TILE);
  chimney(m, wx0 - 0.005, -0.1, wr + 0.1, BRICK, { smoke: 0.1 });
  // The front: windows up and down, the door on the wing under its porch.
  const front = { face: "+y", at: y1 } as const;
  window(m, front, (x0 + x1) / 2, 0.04, { w: 0.1, box: [0.55, 0.4, 0.28] });
  window(m, front, (x0 + x1) / 2, 0.19, { w: 0.07 });
  window(m, { face: "+y", at: wy1 }, -0.26, 0.04);
  door(m, { face: "+y", at: wy1 }, -0.13, doorColour, { hood: TILE });
  for (const y of [-0.15, 0.12]) window(m, { face: "+x", at: x1 }, y, 0.06);
  flowers(m, -0.27, 0.2, 4, 0.05);
  shrub(m, 0.38, 0.38, 0.05);
  shed(m, -0.24);
});

const villa = (doorColour: RGB) => model((m) => {
  const [x0, x1, y0, y1, eave, ridge] = [-0.33, 0.33, -0.3, 0.28, 0.24, 0.44];
  put(m, "matte", box(x0, x1, y0, y1, 0, eave), BRICK);
  hipped(m, x0, x1, y0, y1, eave, ridge, TILE);
  chimney(m, 0.06, -0.06, ridge + 0.07, BRICK, { smoke: 0.1 });
  // Two dormers to the street, a window in each.
  for (const x of [-0.17, 0.17]) {
    const [dy0, dy1, dz] = [0.08, y1 + 0.01, eave + 0.05];
    put(m, "matte", box(x - 0.055, x + 0.055, dy0, dy1, eave - 0.02, dz + 0.04), BRICK);
    put(m, "tiles", hull([[x - 0.07, dy0, dz + 0.03], [x + 0.07, dy0, dz + 0.03], [x - 0.07, dy1 + 0.02, dz + 0.03], [x + 0.07, dy1 + 0.02, dz + 0.03], [x, dy0, dz + 0.09], [x, dy1 + 0.02, dz + 0.09]]), TILE.rgb);
    window(m, { face: "+y", at: dy1 }, x, dz - 0.01, { w: 0.05, h: 0.05 });
  }
  const front = { face: "+y", at: y1 } as const;
  for (const x of [-0.2, 0.2]) window(m, front, x, 0.05, { box: [0.55, 0.4, 0.28] });
  window(m, front, 0, 0.14, { w: 0.05, h: 0.05 });
  door(m, front, 0, doorColour);
  for (const s of [-1, 1]) for (const y of [-0.15, 0.1]) window(m, { face: s > 0 ? "+x" : "-x", at: s * x1 }, y, 0.05);
  shed(m, 0.24);
});

const farmhouse = (doorColour: RGB) => model((m) => {
  const [x0, x1, y0, y1, eave, ridge] = [-0.36, 0.36, -0.22, 0.2, 0.17, 0.4];
  put(m, "matte", barn("x", x0, x1, y0, y1, eave, ridge), BRICK);
  pitched(m, "x", x0, x1, y0, y1, eave, ridge, TILE);
  // A gable over the door, out from the front.
  const [gx0, gx1, gy1] = [-0.11, 0.11, y1 + 0.06];
  put(m, "matte", barn("y", gx0, gx1, 0, gy1, eave, ridge - 0.04), BRICK);
  pitched(m, "y", gx0, gx1, 0, gy1, eave, ridge - 0.04, TILE, { over: 0.03 });
  door(m, { face: "+y", at: gy1 }, 0, doorColour);
  window(m, { face: "+y", at: gy1 }, 0, 0.2, { w: 0.05, h: 0.05 });
  for (const x of [-0.26, -0.18, 0.18, 0.26]) window(m, { face: "+y", at: y1 }, x, 0.05, { w: 0.05 });
  for (const s of [-1, 1]) chimney(m, s * (x1 - 0.06), 0, ridge + 0.06, BRICK, { smoke: s > 0 ? 0.1 : 0 });
  shed(m, -0.22);
});

export const COTTAGE: Built = cottage(DOORS[0]);
export const VILLA: Built = villa(DOORS[1]);
export const FARMHOUSE: Built = farmhouse(DOORS[2]);
/** Every kind of house in every door. */
export const HOUSES: Built[] = [cottage, villa, farmhouse].flatMap((make, k) => DOORS.map((d, j) => (j === k ? [COTTAGE, VILLA, FARMHOUSE][k] : make(d))));
