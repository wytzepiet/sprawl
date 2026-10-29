import { boxGeometry as box } from "./buildings";
import { prism, shape, type Part, type Shape } from "./sea";
import type { RGB } from "../rgb";
import type { P } from "../geometry";
import type { Good } from "../../generated";

/**
 * The goods, as they stand on a pad, a flatbed or a deck: one package
 * each, the unit the game trades and carries (docs/plan-goods.md), every
 * one of a good the same height and look, so a pad is counted at a glance
 * and a good known by its shape before its colour. A bundle of timber,
 * its ends pale, strapped; a crate of bread, open, its loaves showing; a
 * pallet of stone; a pallet of fuel, four drums; a big bag of grain;
 * cement in paper sacks; ore heaped in a skip and coal in a tray; steel
 * beams, strapped; a machine in a closed crate; crude in a caged tank. Each a square ITEM across, its middle on the origin, its
 * base on z = 0; its colours its own, its bucket white.
 */
export const ITEM = 0.084;

const BARK: RGB = [0.6, 0.42, 0.26];
const END: RGB = [0.89, 0.76, 0.56];
const STRAP: RGB = [0.23, 0.23, 0.23];
const WOOD: RGB = [0.79, 0.6, 0.36];
const PRODUCE: RGB = [0.8, 0.54, 0.27];
const PALLET: RGB = [0.7, 0.54, 0.35];
const BLOCK: RGB = [0.84, 0.82, 0.76];
const DRUM: RGB = [0.8, 0.31, 0.23];
const BAG: RGB = [0.92, 0.84, 0.6];
const SACK: RGB = [0.78, 0.79, 0.78];
const SKIP: RGB = [0.27, 0.42, 0.62];
const ORE: RGB = [0.62, 0.3, 0.18];
const TRAY: RGB = [0.86, 0.68, 0.2];
const COAL: RGB = [0.16, 0.16, 0.18];
const STEEL: RGB = [0.47, 0.55, 0.64];
const CASE: RGB = [0.72, 0.58, 0.4];
const BATTEN: RGB = [0.5, 0.38, 0.24];
const TANK: RGB = [0.2, 0.17, 0.2];
const CAGE: RGB = [0.75, 0.76, 0.78];

/** A block `w` across, `l` deep and `h` high, its base on z = 0: its top
 *  and four sides, 12 triangles. A package is a few pixels on screen, so
 *  each is a block or two in its colours, its shape what tells it: what
 *  the eye cannot pick out at that size is not drawn. */
const block = (w: number, l: number, h: number) => prism([[w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2], [-w / 2, -l / 2]], h);
/** A round thing standing, `r` across and `h` high: a hexagon, upright. */
const upright = (r: number, h: number) => prism(Array.from({ length: 6 }, (_, k): P => [r * Math.cos((k + 0.5) * Math.PI / 3), r * Math.sin((k + 0.5) * Math.PI / 3)]), h);
const BOARD = 0.01;
const pallet: Part = [block(ITEM, ITEM, BOARD), [0, 0, 0], PALLET];

/** A bundle of timber: logs' bark, their pale ends either side, a strap. */
const timber = (): Shape => shape([
  [block(ITEM - 0.004, ITEM - 0.006, ITEM), [0, 0, 0], BARK],
  ...[-1, 1].map((s): Part => [block(ITEM - 0.008, 0.003, ITEM - 0.004), [0, s * (ITEM / 2 - 0.0015), 0.002], END]),
  [block(ITEM, 0.006, ITEM + 0.001), [0, 0, 0], STRAP],
]);
/** An open crate of bread: its walls, the loaves showing over them. */
const crate = (): Shape => shape([
  [block(ITEM, ITEM, 0.05), [0, 0, 0], WOOD],
  [block(ITEM - 0.012, ITEM - 0.012, 0.058), [0, 0, 0], PRODUCE],
]);
/** A pallet of cut stone, two layers of blocks as one. */
const stone = (): Shape => shape([pallet, [block(ITEM - 0.004, ITEM - 0.004, ITEM - 0.006), [0, 0, BOARD], BLOCK]]);
/** A pallet of fuel: four drums. */
const drums = (): Shape => shape([pallet, ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]): Part => [upright(ITEM / 4 - 0.002, 0.052), [x * ITEM / 4, y * ITEM / 4, BOARD], DRUM])]);
/** A big bag of grain on a pallet. */
const bigBag = (): Shape => shape([pallet, [block(ITEM - 0.008, ITEM - 0.008, 0.06), [0, 0, BOARD], BAG]]);
/** A pallet of cement: three layers of paper sacks, each across the one below. */
const sacks = (): Shape => shape([pallet, ...[0, 1, 2].map((layer): Part => [layer % 2 ? block(ITEM - 0.004, ITEM - 0.01, 0.016) : block(ITEM - 0.01, ITEM - 0.004, 0.016), [0, 0, BOARD + layer * 0.017], SACK])]);
/** Lumps heaped in a bin: the bin `h` high, the heap rising out of it. */
const heaped = (wall: RGB, lump: RGB, h: number): Shape => shape([
  [block(ITEM, ITEM, h), [0, 0, 0], wall],
  [block(ITEM - 0.01, ITEM - 0.01, h + 0.006), [0, 0, 0], lump],
  [block((ITEM - 0.01) * 0.6, (ITEM - 0.01) * 0.6, h + 0.016), [0.003, -0.002, 0], lump],
]);
/** Steel beams in two layers on bearers, a strap round each end. */
const beams = (): Shape => shape([
  [block(ITEM - 0.008, ITEM, 0.046), [0, 0, 0.008], STEEL],
  ...[-1, 1].map((s): Part => [block(ITEM - 0.004, 0.006, 0.055), [0, s * ITEM / 3, 0], STRAP]),
]);
/** A machine in a closed crate, a batten across its lid. */
const crated = (): Shape => shape([
  [block(ITEM - 0.004, ITEM - 0.004, 0.07), [0, 0, 0], CASE],
  [block(ITEM - 0.004, 0.008, 0.072), [0, 0, 0], BATTEN],
]);
/** Crude in a caged tank on a pallet, its cap on top. */
const tank = (): Shape => shape([pallet, [block(ITEM - 0.006, ITEM - 0.006, 0.056), [0, 0, BOARD], CAGE], [block(ITEM - 0.012, ITEM - 0.012, 0.058), [0, 0, BOARD], TANK], [upright(0.008, 0.064), [0, 0, BOARD], CAGE]]);

/** Each good's package, and how high it stands: a stack of them is as
 *  high as so many. */
export const ITEMS: Record<Good, { key: string; geo: Shape; h: number }> = {
  Timber: { key: "item_Timber", geo: timber(), h: ITEM },
  Bread: { key: "item_Bread", geo: crate(), h: 0.058 },
  Stone: { key: "item_Stone", geo: stone(), h: BOARD + 2 * (ITEM / 2 - 0.003) + 0.001 },
  Fuel: { key: "item_Fuel", geo: drums(), h: BOARD + 0.055 },
  Grain: { key: "item_Grain", geo: bigBag(), h: BOARD + 0.06 },
  Cement: { key: "item_Cement", geo: sacks(), h: BOARD + 3 * 0.017 },
  Ore: { key: "item_Ore", geo: heaped(SKIP, ORE, 0.05), h: 0.05 },
  Coal: { key: "item_Coal", geo: heaped(TRAY, COAL, 0.03), h: 0.03 },
  Steel: { key: "item_Steel", geo: beams(), h: 0.008 + 2 * 0.023 },
  Machinery: { key: "item_Machinery", geo: crated(), h: 0.07 },
  Crude: { key: "item_Crude", geo: tank(), h: BOARD + 0.06 },
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
