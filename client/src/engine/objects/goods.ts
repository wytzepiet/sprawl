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
 * showing; a pallet of stone, two layers of blocks; a pallet of fuel,
 * four drums; a big bag of grain, its loops up; cement in paper sacks;
 * ore heaped in a skip and coal in a tray; steel beams, strapped; a
 * machine in a closed crate; crude in a caged tank. Each a square ITEM across, its middle on the origin, its
 * base on z = 0; its colours its own, its bucket white.
 */
export const ITEM = 0.084;
const H = ITEM / 2;

const BARK: RGB = [0.6, 0.42, 0.26];
const END: RGB = [0.89, 0.76, 0.56];
const STRAP: RGB = [0.23, 0.23, 0.23];
const WOOD: RGB = [0.79, 0.6, 0.36];
const SLAT: RGB = [0.65, 0.48, 0.26];
const PRODUCE: RGB = [0.8, 0.54, 0.27];
const PALLET: RGB = [0.7, 0.54, 0.35];
const BLOCK: RGB = [0.84, 0.82, 0.76];
const DRUM: RGB = [0.8, 0.31, 0.23];
const LID: RGB = [0.62, 0.24, 0.18];
const BAG: RGB = [0.92, 0.84, 0.6];
const LOOP: RGB = [0.62, 0.5, 0.28];
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
 *  its produce heaped a little in it. */
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
    [box(inner, inner, h - 0.012), [0, 0, (h - 0.012) / 2], PRODUCE],
    ...[[-1, -1], [1, 1], [-1, 1], [1, -1]].map(([a, b]): Part => [box(inner / 2.4, inner / 2.4, 0.008), [a * inner / 4.5, b * inner / 4.5, h - 0.008], PRODUCE]),
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

/** A big bag of grain on a pallet, a loop at each corner of its top. */
function bigBag(): Shape {
  const b = ITEM - 0.008, h = 0.06;
  return shape([pallet, [box(b, b, h), [0, 0, BOARD + h / 2], BAG],
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]): Part => [box(0.008, 0.008, 0.01), [x * (b / 2 - 0.006), y * (b / 2 - 0.006), BOARD + h + 0.005], LOOP])]);
}

/** A pallet of cement: three layers of two paper sacks, each layer
 *  lying across the one below. */
function sacks(): Shape {
  const t = 0.016, w = ITEM / 2 - 0.003;
  const bags: Part[] = [];
  for (let layer = 0; layer < 3; layer++)
    for (const s of [-1, 1]) bags.push([layer % 2 ? box(ITEM - 0.004, w, t) : box(w, ITEM - 0.004, t), [layer % 2 ? 0 : s * (w / 2 + 0.0015), layer % 2 ? s * (w / 2 + 0.0015) : 0, BOARD + t / 2 + layer * (t + 0.001)], SACK]);
  return shape([pallet, ...bags]);
}

/** Lumps heaped in a bin: its floor and four walls `h` high, and a heap
 *  rising out of it in three steps. */
function heaped(wall: RGB, lump: RGB, h: number): Shape {
  const w = 0.005, inner = ITEM - 2 * w;
  return shape([
    [box(ITEM, ITEM, w), [0, 0, w / 2], wall],
    ...[-1, 1].flatMap((s): Part[] => [[box(ITEM, w, h), [0, s * (H - w / 2), h / 2], wall], [box(w, inner, h), [s * (H - w / 2), 0, h / 2], wall]]),
    [box(inner, inner, h - 0.004), [0, 0, (h - 0.004) / 2], lump],
    [box(inner * 0.7, inner * 0.65, 0.012), [0.003, -0.002, h + 0.002], lump],
    [box(inner * 0.35, inner * 0.4, 0.01), [-0.004, 0.003, h + 0.012], lump],
  ]);
}

/** Steel beams: two layers of three I-beams along y, on bearers, a strap
 *  round each end. */
function beams(): Shape {
  const f = 0.024, web = 0.006, t = 0.004, h = 0.022;
  const parts: Part[] = [-1, 1].map((s): Part => [box(ITEM, 0.01, 0.008), [0, s * ITEM / 3, 0.004], BATTEN]);
  for (let layer = 0; layer < 2; layer++)
    for (const c of [-1, 0, 1]) {
      const z = 0.008 + layer * (h + 0.001), x = c * (f + 0.004);
      parts.push([box(f, ITEM, t), [x, 0, z + t / 2], STEEL], [box(web, ITEM, h - 2 * t), [x, 0, z + h / 2], STEEL], [box(f, ITEM, t), [x, 0, z + h - t / 2], STEEL]);
    }
  parts.push(...[-1, 1].map((s): Part => [box(3 * f + 0.012, 0.006, 2 * h + 0.004), [0, s * ITEM / 3, 0.008 + h + 0.001], STRAP]));
  return shape(parts);
}

/** A machine in a closed crate: a box of boards, battens round its
 *  edges and across its lid. */
function crated(): Shape {
  const h = 0.07, b = 0.008;
  return shape([
    [box(ITEM - 0.004, ITEM - 0.004, h), [0, 0, h / 2], CASE],
    ...[-1, 1].flatMap((s): Part[] => [
      [box(ITEM, b, b), [0, s * (H - b / 2), h - b / 2], BATTEN],
      [box(b, ITEM, b), [s * (H - b / 2), 0, h - b / 2], BATTEN],
      [box(ITEM, b, b), [0, s * (H - b / 2), b / 2], BATTEN],
      [box(b, ITEM, b), [s * (H - b / 2), 0, b / 2], BATTEN],
    ]),
    [box(ITEM - 0.004, b, 0.002), [0, 0, h + 0.001], BATTEN],
  ]);
}

/** Crude in a caged tank on a pallet: the tank, its cap, and the cage's
 *  bars round it. */
function tank(): Shape {
  const h = 0.06, t = ITEM - 0.012, bar = 0.004;
  return shape([pallet, [box(t, t, h - 0.004), [0, 0, BOARD + (h - 0.004) / 2], TANK], [upright(0.008, 0.006), [0, 0, BOARD + h - 0.004], CAGE],
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]): Part => [box(bar, bar, h), [x * (H - bar), y * (H - bar), BOARD + h / 2], CAGE]),
    ...[-1, 1].flatMap((s): Part[] => [[box(ITEM - 0.004, bar, bar), [0, s * (H - bar), BOARD + h], CAGE], [box(bar, ITEM - 0.004, bar), [s * (H - bar), 0, BOARD + h], CAGE]])]);
}

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
