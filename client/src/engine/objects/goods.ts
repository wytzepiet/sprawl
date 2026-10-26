import { boxGeometry as box } from "./buildings";
import { barrel, prism, shape, type Part, type Shape } from "./sea";
import type { RGB } from "../rgb";
import type { P } from "../geometry";
import type { Good } from "../../generated";

/**
 * The goods, as they stand on a pad, a flatbed or a deck: one package
 * each, the unit the game trades and carries (docs/plan-goods.md), every
 * one of a good the same height and look, so a pad is counted at a glance
 * and a good known by its shape before its colour. A bundle of timber,
 * three logs by three, strapped; a crate of bread, open, its loaves
 * showing; a big bag of grain, open at the top; a pallet of stone, two
 * layers of blocks; a pallet of fuel, four drums. Each a square ITEM across, its middle on the origin, its
 * base on z = 0; its colours its own, its bucket white.
 */
export const ITEM = 0.084;
const H = ITEM / 2;

const BARK: RGB = [0.6, 0.42, 0.26];
const END: RGB = [0.89, 0.76, 0.56];
const STRAP: RGB = [0.23, 0.23, 0.23];
const WOOD: RGB = [0.79, 0.6, 0.36];
const SLAT: RGB = [0.65, 0.48, 0.26];
const CRUMB: RGB = [0.86, 0.68, 0.42];
const CRUST: RGB = [0.74, 0.45, 0.22];
const SACK: RGB = [0.9, 0.88, 0.8];
const LOOP: RGB = [0.36, 0.42, 0.52];
const GRAIN: RGB = [0.87, 0.71, 0.36];
const PALLET: RGB = [0.7, 0.54, 0.35];
const BLOCK: RGB = [0.84, 0.82, 0.76];
const DRUM: RGB = [0.8, 0.31, 0.23];
const LID: RGB = [0.62, 0.24, 0.18];

/** A round thing standing, `r` across and `h` high: an octagon, upright. */
const upright = (r: number, h: number) => prism(Array.from({ length: 8 }, (_, k): P => [r * Math.cos((k + 0.5) * Math.PI / 4), r * Math.sin((k + 0.5) * Math.PI / 4)]), h);
const BOARD = 0.01;
const pallet: Part = [box(ITEM, ITEM, BOARD), [0, 0, BOARD / 2], PALLET];

/** Nine logs, three by three, lying along y, their ends pale, and two
 *  straps round them. */
function timber(): Shape {
  const r = ITEM / 6;
  const R = r / Math.cos(Math.PI / 8);
  const logs: Part[] = [];
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) {
      const at: [number, number, number] = [(col - 1) * 2 * r, 0, r + row * 2 * r];
      logs.push([barrel(R, ITEM - 0.004), at, BARK]);
      for (const s of [-1, 1]) logs.push([barrel(R * 0.82, 0.003), [at[0], s * (ITEM / 2 - 0.0035), at[2]], END]);
    }
  const straps = [-1, 1].map((s): Part => [box(ITEM + 0.002, 0.006, 6 * r + 0.002), [0, s * ITEM / 4, 3 * r], STRAP]);
  return shape([...logs, ...straps]);
}

/** An open crate: four walls of boards, a dark band round its top, and
 *  three loaves lying in it, crust up. */
function crate(): Shape {
  const h = 0.058, wall = 0.007;
  const inner = ITEM - 2 * wall;
  return shape([
    [box(ITEM, ITEM, BOARD), [0, 0, BOARD / 2], SLAT],
    ...[-1, 1].flatMap((s): Part[] => [
      [box(ITEM, wall, h), [0, s * (H - wall / 2), h / 2], WOOD],
      [box(wall, inner, h), [s * (H - wall / 2), 0, h / 2], WOOD],
      [box(ITEM + 0.001, wall + 0.001, 0.008), [0, s * (H - wall / 2), h - 0.012], SLAT],
      [box(wall + 0.001, inner, 0.008), [s * (H - wall / 2), 0, h - 0.012], SLAT],
    ]),
    [box(inner, inner, h - 0.016), [0, 0, (h - 0.016) / 2], CRUMB],
    ...[-1, 0, 1].flatMap((a): Part[] => [
      [box(inner / 3.4, inner * 0.84, 0.01), [a * inner / 3.2, 0, h - 0.013], CRUST],
      [box(inner / 4.6, inner * 0.76, 0.005), [a * inner / 3.2, 0, h - 0.006], CRUST],
    ]),
  ]);
}

/** A big bag on a pallet: woven sack, a lifting loop at each corner, and
 *  its grain showing at the open top. */
function bag(): Shape {
  const h = 0.056, w = ITEM - 0.008;
  return shape([
    pallet,
    [box(w, w, h), [0, 0, BOARD + h / 2], SACK],
    [box(w - 0.012, w - 0.012, 0.004), [0, 0, BOARD + h], GRAIN],
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]): Part => [box(0.008, 0.008, 0.014), [x * (w / 2 - 0.006), y * (w / 2 - 0.006), BOARD + h + 0.005], LOOP]),
  ]);
}

/** A pallet of cut stone: two layers of four blocks. */
function stone(): Shape {
  const b = ITEM / 2 - 0.003;
  const blocks: Part[] = [];
  for (let layer = 0; layer < 2; layer++)
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) blocks.push([box(b, b, b), [x * (b / 2 + 0.0015), y * (b / 2 + 0.0015), BOARD + b / 2 + layer * (b + 0.001)], BLOCK]);
  return shape([pallet, ...blocks]);
}

/** A pallet of fuel: four drums, a lid on each a shade darker. */
function drums(): Shape {
  const r = ITEM / 4 - 0.002, h = 0.052;
  return shape([pallet, ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].flatMap(([x, y]): Part[] => [
    [upright(r, h), [x * ITEM / 4, y * ITEM / 4, BOARD], DRUM],
    [upright(r * 0.9, 0.003), [x * ITEM / 4, y * ITEM / 4, BOARD + h], LID],
  ])]);
}

/** Each good's package, and how high it stands: a stack of them is as
 *  high as so many. */
export const ITEMS: Record<Good, { key: string; geo: Shape; h: number }> = {
  Timber: { key: "item_Timber", geo: timber(), h: ITEM },
  Bread: { key: "item_Bread", geo: crate(), h: 0.058 },
  Grain: { key: "item_Grain", geo: bag(), h: BOARD + 0.056 },
  Stone: { key: "item_Stone", geo: stone(), h: BOARD + 2 * (ITEM / 2 - 0.003) + 0.001 },
  Fuel: { key: "item_Fuel", geo: drums(), h: BOARD + 0.055 },
};

/** A good's package to place: in a bucket of its own where it stands
 *  still, one where it moves (`bodyOf` in `CarObject.tsx`). */
export const itemOf = (g: Good, moving: boolean) => ({ key: ITEMS[g].key + (moving ? "" : "p"), geo: ITEMS[g].geo });

/** A forklift: a yellow body, its counterweight at the back, a seat
 *  under a dark guard, the mast at its front and the forks before it,
 *  `FORKS` ahead of its middle. Ahead +y, its base on z = 0. */
const YELLOW: RGB = [0.94, 0.76, 0.23];
const MAST: RGB = [0.24, 0.25, 0.27];
export const FORKS = 0.1;
export const FORKLIFT = {
  key: "forklift",
  geo: shape([
    [box(0.07, 0.1, 0.045), [0, -0.005, 0.0275], YELLOW],
    [box(0.072, 0.03, 0.02), [0, -0.045, 0.06], YELLOW],
    [box(0.062, 0.05, 0.004), [0, -0.005, 0.105], MAST],
    ...[-1, 1].map((s): Part => [box(0.005, 0.005, 0.055), [s * 0.028, 0.015, 0.075], MAST]),
    ...[-1, 1].map((s): Part => [box(0.006, 0.008, 0.11), [s * 0.022, 0.05, 0.055], MAST]),
    ...[-1, 1].map((s): Part => [box(0.008, 0.07, 0.004), [s * 0.02, 0.09, 0.006], MAST]),
    ...[-1, 1].flatMap((s): Part[] => [-1, 1].map((t): Part => [box(0.012, 0.026, 0.026), [s * 0.036, t * 0.032, 0.013], [0.12, 0.12, 0.13]])),
  ]),
};
