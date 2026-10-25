import { boxGeometry as box } from "./buildings";
import { barrel, prism, shape, type Part, type Shape } from "./sea";
import type { RGB } from "../rgb";
import type { MeshGeometry, P } from "../geometry";
import type { Good } from "../../generated";
import { mesh, Solid } from "../solid";

/**
 * The goods, as they stand on a pad, a flatbed or a deck: one package
 * each, the unit the game trades and carries (docs/plan-goods.md), every
 * one of a good the same height and look, so a pad is counted at a glance
 * and a good known by its shape before its colour. A bundle of timber,
 * three logs by three, strapped; a crate of food, open, its produce
 * showing; a pallet of stone, two layers of blocks; a pallet of fuel,
 * four drums. Each a square ITEM across, its middle on the origin, its
 * base on z = 0; its colours its own, its bucket white.
 */
export const ITEM = 0.084;
const H = ITEM / 2;

const BARK: RGB = [0.6, 0.42, 0.26];
const END: RGB = [0.89, 0.76, 0.56];
const STRAP: RGB = [0.23, 0.23, 0.23];
const WOOD: RGB = [0.79, 0.6, 0.36];
const SLAT: RGB = [0.65, 0.48, 0.26];
const PRODUCE: RGB = [0.42, 0.62, 0.3];
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

/** Each good's package, and how high it stands: a stack of them is as
 *  high as so many. */
export const ITEMS: Record<Good, { key: string; geo: Shape; h: number }> = {
  Timber: { key: "item_Timber", geo: timber(), h: ITEM },
  Crates: { key: "item_Crates", geo: crate(), h: 0.058 },
  Stone: { key: "item_Stone", geo: stone(), h: BOARD + 2 * (ITEM / 2 - 0.003) + 0.001 },
  Fuel: { key: "item_Fuel", geo: drums(), h: BOARD + 0.055 },
};

/** A good's package to place: in a bucket of its own where it stands
 *  still, one where it moves (`bodyOf` in `CarObject.tsx`). */
export const itemOf = (g: Good, moving: boolean) => ({ key: ITEMS[g].key + (moving ? "" : "p"), geo: ITEMS[g].geo });

/** A depot's office hut: where its hands clock in, its gable end to the
 *  street (+y), eaves deep, a door too big for it and a window beside, a
 *  chimney at the back. Its base on z = 0. */
export const HUT = (() => {
  const [w, d, h, rise, eave] = [0.38, 0.3, 0.16, 0.13, 0.04];
  const WALL: RGB = [0.6, 0.48, 0.37], ROOF: RGB = [0.42, 0.33, 0.25], CREAM: RGB = [0.93, 0.9, 0.83], GLASS: RGB = [0.26, 0.29, 0.33];
  // The roof: two slopes from the eaves up to the ridge along y.
  const [x0, x1, y0, y1] = [-w / 2 - eave, w / 2 + eave, -d / 2 - eave, d / 2 + eave];
  const slope = (s: number): MeshGeometry => {
    const n = [s * rise, 0, w / 2 + eave].map((v, _, a) => v / Math.hypot(...a));
    const xe = s > 0 ? x1 : x0;
    return { positions: [xe, y0, 0, 0, y0, rise, 0, y1, rise, xe, y1, 0], normals: [...n, ...n, ...n, ...n], indices: s > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3] };
  };
  // Its gable ends, the triangles under the ridge.
  const end = (s: number): MeshGeometry => {
    const y = s * d / 2;
    return { positions: [-w / 2, y, 0, w / 2, y, 0, 0, y, rise * (w / 2) / (w / 2 + eave)], normals: [0, s, 0, 0, s, 0, 0, s, 0], indices: s > 0 ? [0, 2, 1] : [0, 1, 2] };
  };
  return {
    key: "hut",
    geo: shape([
      [box(w, d, h), [0, 0, h / 2], WALL],
      [end(1), [0, 0, h], WALL],
      [end(-1), [0, 0, h], WALL],
      [slope(1), [0, 0, h], ROOF],
      [slope(-1), [0, 0, h], ROOF],
      [box(0.045, 0.045, 0.11), [w / 4, -d / 4, h + rise * 0.6], WALL],
      // The door, oversized, and the window beside it, in cream frames.
      [box(0.1, 0.006, 0.14), [-w / 4, d / 2 + 0.002, 0.07], CREAM],
      [box(0.076, 0.008, 0.124), [-w / 4, d / 2 + 0.004, 0.062], ROOF],
      [box(0.13, 0.006, 0.08), [w / 5, d / 2 + 0.002, 0.09], CREAM],
      [box(0.106, 0.008, 0.056), [w / 5, d / 2 + 0.004, 0.09], GLASS],
    ]),
  };
})();

/** A sawmill's log deck: the trees as they come in from the woods, long
 *  and unstrapped, piled four, three and two on two bearers, lying along
 *  y, their ends pale. Its base on z = 0. */
export const LOG_PILE = (() => {
  const [r, l] = [0.022, 0.36];
  const R = r / Math.cos(Math.PI / 8);
  const parts: Part[] = [-1, 1].map((s): Part => [box(9 * r, 0.02, 0.012), [0, s * l * 0.32, 0.006], SLAT]);
  for (let row = 0; row < 3; row++)
    for (let k = 0; k < 4 - row; k++) {
      const at: [number, number, number] = [(k - (3 - row) / 2) * 2 * r, 0, 0.012 + r + row * r * 1.73];
      parts.push([barrel(R, l), at, BARK]);
      for (const s of [-1, 1]) parts.push([barrel(R * 0.82, 0.003), [at[0], s * (l / 2 + 0.001), at[2]], END]);
    }
  return { key: "log_pile", geo: shape(parts) };
})();

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

/** A sawmill's yard, shaped as solids are (`solid.ts`): a box, a
 *  cylinder, a hull round points, one cut out of another. */
const TIMBER: RGB = [0.55, 0.4, 0.27];
const PLANK: RGB = [0.86, 0.72, 0.52];
const STEELWORK: RGB = [0.5, 0.52, 0.55];
const ZINC: RGB = [0.72, 0.74, 0.76];
const BELT: RGB = [0.27, 0.27, 0.28];
const cube = (x: number, y: number, z: number, at: [number, number, number]) => Solid.cube([x, y, z], true).translate([at[0], at[1], at[2] + z / 2]);

/** Its water tower: a timber tank on four splayed legs, braced, under a
 *  low cone. Its base on z = 0. */
export const WATER_TOWER = (() => {
  const [legs, r, tank, cap] = [0.3, 0.1, 0.15, 0.06];
  const leg = (sx: number, sy: number) => Solid.hull([[sx * 0.1, sy * 0.1, 0], [sx * 0.1 + 0.014 * sx, sy * 0.1 + 0.014 * sy, 0], [sx * 0.07, sy * 0.07, legs], [sx * 0.07 + 0.014 * sx, sy * 0.07 + 0.014 * sy, legs]]);
  const frame = Solid.union([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => leg(sx, sy)))
    .add(cube(0.19, 0.012, 0.012, [0, 0.085, legs * 0.45])).add(cube(0.19, 0.012, 0.012, [0, -0.085, legs * 0.45]))
    .add(cube(0.012, 0.19, 0.012, [0.085, 0, legs * 0.45])).add(cube(0.012, 0.19, 0.012, [-0.085, 0, legs * 0.45]));
  const body = Solid.cylinder(tank, r, r, 12).translate([0, 0, legs]);
  const hoops = Solid.union([0.03, 0.12].map((h) => Solid.cylinder(0.008, r + 0.004, r + 0.004, 12).translate([0, 0, legs + h])));
  const roof = Solid.cylinder(cap, r + 0.015, 0.012, 12).translate([0, 0, legs + tank]);
  return { key: "water_tower", geo: shape([[mesh(frame), [0, 0, 0], STEELWORK], [mesh(body), [0, 0, 0], TIMBER], [mesh(hoops), [0, 0, 0], STEELWORK], [mesh(roof), [0, 0, 0], SLAT]]) };
})();

/** Its log conveyor: a belt from the yard up to the hall's wall, LONG
 *  along +y, rising RISE, on legs; side rails, the belt dark between. */
export const CONVEYOR = (() => {
  const [l, w, rise] = [0.5, 0.07, 0.2];
  const slab = (z0: number, z1: number, half: number) => Solid.hull([[-half, 0, z0], [half, 0, z0], [-half, l, z0 + rise], [half, l, z0 + rise], [-half, 0, z1], [half, 0, z1], [-half, l, z1 + rise], [half, l, z1 + rise]]);
  const rails = slab(0.03, 0.055, w / 2).subtract(slab(0.045, 0.08, w / 2 - 0.008));
  const belt = slab(0.03, 0.046, w / 2 - 0.008);
  const legs = Solid.union([0.15, 0.32, 0.47].flatMap((y) => [-1, 1].map((s) => cube(0.01, 0.01, 0.03 + (rise * y) / l, [s * (w / 2 - 0.005), y, 0]))));
  // Two logs riding up it, lying across.
  const logs = Solid.union([0.18, 0.36].map((y) => Solid.cylinder(w - 0.02, 0.016, 0.016, 8, true).rotate([0, 90, 0]).translate([0, y, 0.062 + (rise * y) / l])));
  return { key: "conveyor", geo: shape([[mesh(rails.add(legs)), [0, 0, 0], STEELWORK], [mesh(belt), [0, 0, 0], BELT], [mesh(logs), [0, 0, 0], BARK]]) };
})();

/** Its open plank shed: a ribbed zinc pent roof on posts, high at the
 *  back (-y) and low at the front, over the back of three stacks of sawn
 *  planks that run out from under it. Its base on z = 0. */
export const PLANK_SHED = (() => {
  const [wide, deep, roofed, back, front, t] = [0.6, 0.56, 0.36, 0.22, 0.16, 0.012];
  const y0 = -deep / 2, y1 = y0 + roofed;
  const height = (y: number) => back + ((front - back) * (y - y0)) / roofed;
  const posts = Solid.union([-1, 0, 1].flatMap((sx) => [y0 + 0.02, y1 - 0.02].map((y) => cube(0.02, 0.02, height(y), [sx * (wide / 2 - 0.02), y, 0]))));
  const e = 0.03;
  const sheet = (x0: number, x1: number, dz: number) => Solid.hull([[x0, y0 - e], [x1, y0 - e], [x0, y1 + e], [x1, y1 + e]].flatMap(([x, y]) => [0, t].map((z): [number, number, number] => [x, y, height(y) + z + dz])));
  const roof = sheet(-wide / 2 - e, wide / 2 + e, 0);
  const ribs = Solid.union(Array.from({ length: 7 }, (_, k) => { const x = -wide / 2 + (k + 0.5) * (wide / 7); return sheet(x - 0.008, x + 0.008, 0.008); }));
  const stacks = Solid.union([-1, 0, 1].flatMap((k) => [0, 1, 2, 3].map((layer) => cube(0.15, deep - 0.04, 0.022, [k * 0.19, 0, 0.012 + layer * 0.026]))));
  const spacers = Solid.union([-1, 0, 1].flatMap((k) => [0, 1, 2, 3].flatMap((layer) => [-1, 1].map((s) => cube(0.16, 0.014, 0.004, [k * 0.19, s * deep * 0.3, 0.008 + layer * 0.026])))));
  return { key: "plank_shed", geo: shape([[mesh(posts), [0, 0, 0], TIMBER], [mesh(roof.add(ribs)), [0, 0, 0], ZINC], [mesh(stacks), [0, 0, 0], PLANK], [mesh(spacers), [0, 0, 0], SLAT]]) };
})();
