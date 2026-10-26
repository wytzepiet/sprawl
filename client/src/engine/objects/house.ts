import type { Manifold } from "manifold-3d";
import { mesh, solids } from "../solid";
import { shape, type Part } from "./sea";
import type { RGB } from "../rgb";
import { barnX, barnY, box, GLASS, hull, placing, sheet, tiled, TILES, WOOD } from "./model";

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
const TILE: RGB = [0.72, 0.37, 0.26];
const TRIM: RGB = [0.95, 0.92, 0.86];
const PANE: RGB = [0.24, 0.29, 0.36];
const SHED: RGB = [0.5, 0.38, 0.27];
const SHED_ROOF: RGB = [0.32, 0.3, 0.29];
const DOORS: RGB[] = [[0.3, 0.45, 0.36], [0.33, 0.42, 0.58], [0.6, 0.3, 0.26]];

type Build = { wood: Part[]; tiles: Part[]; glass: Part[] };
const put = (b: Build, solid: Manifold, rgb: RGB) => b.wood.push([mesh(solid), [0, 0, 0], rgb]);
const roof = (b: Build, solid: Manifold) => b.tiles.push([tiled(solid), [0, 0, 0], TILE]);

/** A pitched roof's two slopes, `t` thick, over a body from `x0` to `x1`
 *  and `y0` to `y1`, its ridge along x or y, `over` past its walls. */
function gable(b: Build, along: "x" | "y", x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number, over = 0.04) {
  const t = 0.018;
  if (along === "y") {
    const [mid, half] = [(x0 + x1) / 2, (x1 - x0) / 2];
    const drop = ((ridge - eave) * (half + over)) / half;
    for (const s of [-1, 1]) roof(b, sheet([mid, y0 - over, ridge], [0, y1 - y0 + 2 * over, 0], [s * (half + over), 0, -drop], t));
  } else {
    const [mid, half] = [(y0 + y1) / 2, (y1 - y0) / 2];
    const drop = ((ridge - eave) * (half + over)) / half;
    for (const s of [-1, 1]) roof(b, sheet([x0 - over, mid, ridge], [x1 - x0 + 2 * over, 0, 0], [0, s * (half + over), -drop], t));
  }
}
/** A hipped roof over a body, `over` past its walls: four slopes up to a
 *  ridge along its longer side, as deep in as the shorter is half. */
function hipped(b: Build, x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number, over = 0.04) {
  const [a0, a1, b0, b1] = [x0 - over, x1 + over, y0 - over, y1 + over];
  const drop = over * ((ridge - eave) / (Math.min(x1 - x0, y1 - y0) / 2));
  const run = Math.min(a1 - a0, b1 - b0) / 2;
  const [rx0, rx1, ry0, ry1] = a1 - a0 >= b1 - b0 ? [a0 + run, a1 - run, (b0 + b1) / 2, (b0 + b1) / 2] : [(a0 + a1) / 2, (a0 + a1) / 2, b0 + run, b1 - run];
  const z = eave - drop;
  roof(b, hull([[a0, b0, z], [a1, b0, z], [a0, b1, z], [a1, b1, z], [a0, b0, z + 0.018], [a1, b0, z + 0.018], [a0, b1, z + 0.018], [a1, b1, z + 0.018], [rx0, ry0, ridge], [rx1, ry1, ridge]]));
}
/** A window on a wall facing +y or -y (at `y`) or +x or -x (at `x`): its
 *  frame, its pane, its middle at `at` along the wall, its sill at `z`. */
function window(b: Build, facing: "+y" | "-y" | "+x" | "-x", wall: number, at: number, z: number, w = 0.06, h = 0.065) {
  const s = facing[0] === "+" ? 1 : -1, f = 0.01;
  /** From inside the wall out to `out` past it. */
  const thick = (out: number): [number, number] => [Math.min(wall - s * 0.004, wall + s * out), Math.max(wall - s * 0.004, wall + s * out)];
  const [a, c] = [thick(0.006), thick(0.01)];
  const [frame, pane] = facing[1] === "y"
    ? [box(at - w / 2 - f, at + w / 2 + f, ...a, z - f, z + h + f), box(at - w / 2, at + w / 2, ...c, z, z + h)]
    : [box(...a, at - w / 2 - f, at + w / 2 + f, z - f, z + h + f), box(...c, at - w / 2, at + w / 2, z, z + h)];
  put(b, frame, TRIM), b.glass.push([mesh(pane), [0, 0, 0], PANE]);
}
/** A door on the front, `at` across, `w` wide. */
const door = (b: Build, y: number, at: number, rgb: RGB, w = 0.07) => (put(b, box(at - w / 2 - 0.01, at + w / 2 + 0.01, y - 0.004, y + 0.006, 0, 0.16), TRIM), put(b, box(at - w / 2, at + w / 2, y - 0.004, y + 0.01, 0, 0.15), rgb));
/** A chimney stack from the ground, `w` square, to `top`. */
const chimney = (b: Build, x: number, y: number, top: number, w = 0.06) => put(b, box(x - w / 2, x + w / 2, y - w / 2, y + w / 2, 0, top).add(box(x - w / 2 - 0.008, x + w / 2 + 0.008, y - w / 2 - 0.008, y + w / 2 + 0.008, top - 0.025, top)), BRICK);
/** The garden shed at the back, its roof a lean-to. */
function shed(b: Build, x: number) {
  put(b, box(x - 0.08, x + 0.08, -0.45, -0.33, 0, 0.1), SHED);
  put(b, sheet([x - 0.1, -0.31, 0.1], [0.2, 0, 0], [0, -0.16, 0.025], 0.012), SHED_ROOF);
  put(b, box(x - 0.025, x + 0.025, -0.33, -0.326, 0, 0.08), SHED_ROOF);
}

const COTTAGE = (doorColour: RGB) => solids(() => {
  const b: Build = { wood: [], tiles: [], glass: [] };
  // The main body, its gable end to the street.
  const [x0, x1, y0, y1, eave, ridge] = [-0.04, 0.32, -0.28, 0.3, 0.2, 0.42];
  put(b, barnY(x0, x1, y0, y1, eave, ridge), BRICK);
  gable(b, "y", x0, x1, y0, y1, eave, ridge);
  // The wing across beside it, lower.
  const [wx0, wy0, wy1, we, wr] = [-0.34, -0.28, 0.08, 0.15, 0.32];
  put(b, barnX(wx0, x0 + 0.02, wy0, wy1, we, wr), BRICK);
  gable(b, "x", wx0, x0, wy0, wy1, we, wr);
  chimney(b, wx0 - 0.005, -0.1, wr + 0.1);
  // The front: windows up and down, the door on the wing under its porch.
  for (const z of [0.04, 0.19]) window(b, "+y", y1, (x0 + x1) / 2, z, z > 0.1 ? 0.07 : 0.1);
  window(b, "+y", wy1, -0.26, 0.04);
  door(b, wy1, -0.13, doorColour);
  put(b, sheet([-0.2, wy1, 0.19], [0.14, 0, 0], [0, 0.09, -0.035], 0.012), TILE);
  for (const x of [-0.195, -0.065]) put(b, box(x - 0.006, x + 0.006, wy1 + 0.075, wy1 + 0.087, 0, 0.16), TRIM);
  for (const y of [-0.15, 0.12]) window(b, "+x", x1, y, 0.06);
  shed(b, -0.24);
  return { wood: { shape: shape(b.wood), coat: WOOD }, tiles: { shape: shape(b.tiles), coat: TILES }, glass: { shape: shape(b.glass), coat: GLASS } };
});

const VILLA = (doorColour: RGB) => solids(() => {
  const b: Build = { wood: [], tiles: [], glass: [] };
  const [x0, x1, y0, y1, eave, ridge] = [-0.33, 0.33, -0.3, 0.28, 0.24, 0.44];
  put(b, box(x0, x1, y0, y1, 0, eave), BRICK);
  hipped(b, x0, x1, y0, y1, eave, ridge);
  chimney(b, 0.06, -0.06, ridge + 0.07);
  // Two dormers to the street, a window in each.
  for (const x of [-0.17, 0.17]) {
    const [dy0, dy1, dz] = [0.08, y1 + 0.01, eave + 0.05];
    put(b, box(x - 0.055, x + 0.055, dy0, dy1, eave - 0.02, dz + 0.04), BRICK);
    roof(b, hull([[x - 0.07, dy0, dz + 0.03], [x + 0.07, dy0, dz + 0.03], [x - 0.07, dy1 + 0.02, dz + 0.03], [x + 0.07, dy1 + 0.02, dz + 0.03], [x, dy0, dz + 0.09], [x, dy1 + 0.02, dz + 0.09]]));
    window(b, "+y", dy1, x, dz - 0.01, 0.05, 0.05);
  }
  for (const x of [-0.2, 0.2]) window(b, "+y", y1, x, 0.05);
  window(b, "+y", y1, 0, 0.14, 0.05, 0.05);
  door(b, y1, 0, doorColour);
  for (const s of [-1, 1]) for (const y of [-0.15, 0.1]) window(b, s > 0 ? "+x" : "-x", s * x1, y, 0.05);
  shed(b, 0.24);
  return { wood: { shape: shape(b.wood), coat: WOOD }, tiles: { shape: shape(b.tiles), coat: TILES }, glass: { shape: shape(b.glass), coat: GLASS } };
});

const FARMHOUSE = (doorColour: RGB) => solids(() => {
  const b: Build = { wood: [], tiles: [], glass: [] };
  const [x0, x1, y0, y1, eave, ridge] = [-0.36, 0.36, -0.22, 0.2, 0.17, 0.4];
  put(b, barnX(x0, x1, y0, y1, eave, ridge), BRICK);
  gable(b, "x", x0, x1, y0, y1, eave, ridge);
  // A gable over the door, out from the front.
  const [gx0, gx1, gy1] = [-0.11, 0.11, y1 + 0.06];
  put(b, barnY(gx0, gx1, 0, gy1, eave, ridge - 0.04), BRICK);
  gable(b, "y", gx0, gx1, 0, gy1, eave, ridge - 0.04, 0.03);
  door(b, gy1, 0, doorColour);
  window(b, "+y", gy1, 0, 0.2, 0.05, 0.05);
  for (const x of [-0.26, -0.18, 0.18, 0.26]) window(b, "+y", y1, x, 0.05, 0.05);
  for (const s of [-1, 1]) chimney(b, s * (x1 - 0.06), 0, ridge + 0.06);
  shed(b, -0.22);
  return { wood: { shape: shape(b.wood), coat: WOOD }, tiles: { shape: shape(b.tiles), coat: TILES }, glass: { shape: shape(b.glass), coat: GLASS } };
});

/** Every kind of house in every door, each and its mirror. */
const HOUSES = [COTTAGE, VILLA, FARMHOUSE].flatMap((make, k) => DOORS.map((d, j) => placing(`house${k}${j}`, make(d))));

/** The house on a tile, by its id: which kind, which door, as if at
 *  random, so a street of them is mixed. */
export const house = (id: number) => HOUSES[(Math.imul(id, 0x9e3779b1) >>> 7) % HOUSES.length];
