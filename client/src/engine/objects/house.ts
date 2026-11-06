import type { RGB } from "../rgb";
import { barn, box, chimney, cone, door, dormer, flowers, gablet, ground, model, pitched, plate, post, put, shrub, window, type Built, type Cover, type Model, type Wall } from "./kit";
import { theme } from "../theme";

/**
 * A house, whole, on its tile, one of a few (`refresh/refs/houses-gpt.png`).
 * Its tile x -0.5 to 0.5, y the same, the street at +y; its ground on
 * z = 0. The hedges round its garden are the town grid's, and so is its
 * drive, down the middle of its front from the front wall to the street,
 * its cars on it: the garden either side of it.
 *
 * Every one cream under a big terracotta roof, on a grey plinth; white
 * windows with flower boxes; its door under a little gable; a chimney;
 * a lawn round it, shrubs and flowers, a shed at the back.
 *
 * - The cottage: its ridge along the street, a cross gable out over the
 *   door in the middle.
 * - The dormer house: taller, two dormers to the street, a porch.
 * - The corner house: an L, its wing's gable end to the street on the
 *   left, a cross gable over the door on the right.
 */

const WALL: RGB = [0.92, 0.87, 0.76];
const PLINTH: RGB = [0.6, 0.57, 0.54];
const ROOF: Cover = { finish: "tiles", rgb: [0.82, 0.43, 0.26] };
const BOXES: RGB = [0.36, 0.42, 0.3];
const SHED: RGB = [0.5, 0.37, 0.26];
const SHED_ROOF: Cover = { finish: "ribs", rgb: [0.36, 0.29, 0.25], ribs: 40 };
const POSTS: RGB = [0.95, 0.92, 0.86];
const DOORS: RGB[] = [[0.68, 0.26, 0.22], [0.27, 0.46, 0.33], [0.3, 0.45, 0.66]];
const LAWN = [theme.land.r, theme.land.g, theme.land.b] as RGB;
/** How far either side of the middle the drive runs to the street. */
const DRIVE = 0.22;

/** A body under its roof: a barn's walls on a plinth, and its roof. */
function body(m: Model, along: "x" | "y", x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number, over = 0.05) {
  put(m, "matte", barn(along, x0, x1, y0, y1, eave, ridge), WALL);
  put(m, "matte", box(x0 - 0.008, x1 + 0.008, y0 - 0.008, y1 + 0.008, 0, 0.028), PLINTH);
  pitched(m, along, x0, x1, y0, y1, eave, ridge, ROOF, { over });
}
/** A window on the ground floor, its flower box under it. */
const lower = (m: Model, wall: Wall, at: number) => window(m, wall, at, 0.055, { w: 0.075, h: 0.075, box: BOXES });

/** The garden: lawn round the house, but for the drive; a row of round
 *  shrubs along the front wall, more shrubs and flowers before it, either
 *  side of the drive, from `front`. */
function garden(m: Model, front: number) {
  ground(m, "lawn", [[-0.48, -DRIVE, front - 0.04, 0.48], [DRIVE, 0.48, front - 0.04, 0.48], [-0.48, 0.48, -0.48, front]], LAWN, { round: 0.02 });
  for (const s of [-1, 1]) {
    for (const x of [0.3, 0.36]) shrub(m, s * x, front + 0.025, 0.026, undefined, Math.round(x * 50) + s);
    shrub(m, s * 0.27, front + 0.09, 0.04, undefined, s + 2);
    shrub(m, s * 0.42, front + 0.06, 0.035, undefined, s + 4);
    flowers(m, s * 0.36, front + 0.22, 4, 0.055);
    cone(m, s * (DRIVE + 0.035), front + 0.03, 0.022, 0.09);
  }
}
/** The shed at the back: timber, gabled, its door to the house. */
function shed(m: Model, x: number) {
  const [y0, y1] = [-0.46, -0.33];
  put(m, "matte", barn("x", x - 0.085, x + 0.085, y0, y1, 0.09, 0.15), SHED);
  pitched(m, "x", x - 0.085, x + 0.085, y0, y1, 0.09, 0.15, SHED_ROOF, { over: 0.02 });
  put(m, "matte", plate({ face: "+y", at: y1 }, x - 0.025, x + 0.025, 0, 0.075, 0, 0.006), [0.36, 0.27, 0.2]);
}

const cottage = (colour: RGB) => model((m) => {
  const [y0, y1] = [-0.24, 0.12];
  body(m, "x", -0.37, 0.37, y0, y1, 0.17, 0.42);
  // The cross gable over the door, in the middle.
  const gy = 0.21;
  body(m, "y", -0.12, 0.12, 0, gy, 0.17, 0.37, 0.035);
  const front: Wall = { face: "+y", at: gy };
  door(m, front, 0, colour, { w: 0.075 });
  gablet(m, front, 0, 0.175, 0.11, 0.055, 0.045, ROOF, WALL);
  window(m, front, 0, 0.235, { w: 0.035, h: 0.035, bars: 0 });
  for (const s of [-1, 1]) {
    lower(m, { face: "+y", at: y1 }, s * 0.25);
    window(m, { face: s > 0 ? "+x" : "-x", at: s * 0.37 }, -0.06, 0.055);
    window(m, { face: "-y", at: y0 }, s * 0.18, 0.055);
  }
  chimney(m, -0.24, -0.09, 0.53, WALL, { smoke: 0.1 });
  garden(m, y1);
  shed(m, -0.26);
});

const dormers = (colour: RGB) => model((m) => {
  const [y0, y1, eave, ridge, ridgeAt] = [-0.24, 0.14, 0.2, 0.5, -0.05];
  body(m, "x", -0.36, 0.36, y0, y1, eave, ridge);
  // Two dormers in the front slope, where the roof stands this high.
  const roofAt = (y: number) => ridge - ((y - ridgeAt) * (ridge - eave)) / (y1 - ridgeAt);
  for (const s of [-1, 1]) dormer(m, { face: "+y", at: 0.1 }, s * 0.17, roofAt(0.1) + 0.012, WALL, ROOF, { w: 0.055, h: 0.06, back: 0.13, box: BOXES });
  // The porch: a gable on two posts over the door.
  const front: Wall = { face: "+y", at: y1 };
  door(m, front, 0, colour, { w: 0.075 });
  gablet(m, front, 0, 0.185, 0.15, 0.085, 0.055, ROOF, WALL);
  for (const s of [-1, 1]) put(m, "matte", post(s * 0.068, y1 + 0.075, 0, 0.185, 0.009, 8), POSTS);
  for (const s of [-1, 1]) {
    lower(m, front, s * 0.22);
    window(m, { face: s > 0 ? "+x" : "-x", at: s * 0.36 }, -0.05, 0.055);
    window(m, { face: s > 0 ? "+x" : "-x", at: s * 0.36 }, -0.05, 0.27, { w: 0.05, h: 0.05 });
  }
  chimney(m, -0.22, -0.13, 0.6, WALL, { smoke: 0.1 });
  garden(m, y1);
  shed(m, -0.24);
});

const corner = (colour: RGB) => model((m) => {
  // The wing on the left, its gable end to the street.
  const [wx0, wx1, wy0, wy1] = [-0.37, -0.1, -0.32, 0.18];
  body(m, "y", wx0, wx1, wy0, wy1, 0.18, 0.45);
  // The main body across, on the right, and its cross gable over the door.
  const [y0, y1] = [-0.22, 0.08];
  body(m, "x", -0.12, 0.37, y0, y1, 0.17, 0.4);
  const gy = 0.17;
  body(m, "y", 0.01, 0.23, -0.02, gy, 0.17, 0.36, 0.035);
  const front: Wall = { face: "+y", at: gy };
  door(m, front, 0.12, colour, { w: 0.075 });
  gablet(m, front, 0.12, 0.175, 0.11, 0.055, 0.045, ROOF, WALL);
  window(m, front, 0.12, 0.235, { w: 0.035, h: 0.035, bars: 0 });
  // The wing's front: a window down, one up in its gable.
  const end: Wall = { face: "+y", at: wy1 };
  lower(m, end, (wx0 + wx1) / 2);
  window(m, end, (wx0 + wx1) / 2, 0.26, { w: 0.05, h: 0.05 });
  lower(m, { face: "+y", at: y1 }, 0.31);
  window(m, { face: "-x", at: wx0 }, -0.05, 0.055);
  window(m, { face: "-x", at: wx0 }, -0.22, 0.055);
  window(m, { face: "+x", at: 0.37 }, -0.07, 0.055);
  chimney(m, 0.27, -0.12, 0.5, WALL, { smoke: 0.1 });
  garden(m, Math.min(wy1, gy) - 0.02);
  shed(m, 0.25);
});

/** Every kind of house in every door. */
export const HOUSES: Built[] = [cottage, dormers, corner].flatMap((make) => DOORS.map((d) => make(d)));
export const [COTTAGE, DORMERS, CORNER] = [HOUSES[0], HOUSES[4], HOUSES[8]];
