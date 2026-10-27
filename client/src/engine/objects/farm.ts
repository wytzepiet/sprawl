import type { RGB } from "../rgb";
import { Solid } from "../solid";
import { theme } from "../theme";
import { barn, bench, box, cask, chimney, cone, crate, door, drum, fence, flowers, gate, ground, hull, lamp, lying, model, pitched, post, put, rod, shrub, slope, tree, window, type Cover, type Model, type V, type Wall } from "./kit";

/**
 * A farm, whole (`refresh/refs/farm-gpt.png`): a farmyard over its plot,
 * three tiles square (x and y, -1.5 to 1.5), the street at +y; its ground
 * on z = 0. Its fields round it are the town grid's (`field.ts`), the
 * tractor out to them by the gate in the middle of the back
 * (`fields.rs`); its crates stand down the middle of the yard (`pads.ts`).
 *
 * - At the back on the left the barn, red, under a green gambrel roof:
 *   its double doors braced white, its hay loft's door over them, a
 *   weathervane; two red silos beside it, domed; square bales on the
 *   grass before them.
 * - At the back on the right the machine shed, open timber on posts, the
 *   red tractor's twin and a trailer in it.
 * - In the front corner the farmhouse, white, its gable to the street, a
 *   porch the width of it, green shutters, a dormer, a brick chimney; a
 *   row of clipped shrubs down its garden, flowers, white pickets.
 * - On the right a loading dock with crates of the harvest, a trough.
 * - Earth over the yard, the town's grass round its edges, a rail fence
 *   round the back, white pickets along the front, the gates swung open
 *   between white posts, lanterns, a bench, the town's trees.
 */

const RED: RGB = [0.68, 0.26, 0.22];
const WHITE: RGB = [0.94, 0.92, 0.86];
const GREEN: Cover = { finish: "matte", rgb: [0.34, 0.56, 0.36], ribs: 30, rib: [0.29, 0.49, 0.32] };
const SHUTTER: RGB = [0.27, 0.46, 0.31];
const TIMBER: RGB = [0.55, 0.4, 0.27];
const DARK: RGB = [0.4, 0.29, 0.2];
const BRICK: RGB = [0.62, 0.32, 0.25];
const STRAW: RGB = [0.92, 0.77, 0.4];
const EARTH: RGB = [0.72, 0.62, 0.48];
const DOME: RGB = [0.86, 0.87, 0.87];
const WATER: RGB = [0.42, 0.62, 0.74];
const TYRE: RGB = [0.2, 0.2, 0.21];
const TRACTOR: RGB = [0.78, 0.25, 0.2];
const TRAILER: RGB = [0.36, 0.56, 0.32];
const STONE: RGB = [0.74, 0.72, 0.68];
const LAWN = [theme.land.r, theme.land.g, theme.land.b] as RGB;
const APPLES: RGB = [0.8, 0.3, 0.25];
const ORANGES: RGB = [0.92, 0.55, 0.22];
const CABBAGE: RGB = [0.5, 0.7, 0.36];

/** The barn: red walls, its gambrel roof's two pitches each side, its
 *  ridge front to back. */
function gambrel(m: Model, x0: number, x1: number, y0: number, y1: number, eave: number, knee: number, ridge: number) {
  const [mid, half] = [(x0 + x1) / 2, (x1 - x0) / 2];
  const [kx, over] = [half * 0.62, 0.04];
  const profile = (y: number): V[] => [[x0, y, 0], [x1, y, 0], [x0, y, eave], [x1, y, eave], [mid - kx, y, knee], [mid + kx, y, knee], [mid, y, ridge]];
  put(m, "matte", hull([...profile(y0), ...profile(y1)]), RED);
  for (const s of [-1, 1]) {
    // Lower pitch from the knee out over the eave; upper from the ridge to the knee.
    const [kn, ev] = [mid + s * kx, mid + s * (half + over)];
    const drop = ((knee - eave) * (half + over - kx)) / (half - kx);
    slope(m, [kn, y0 - over, knee], [0, y1 - y0 + 2 * over, 0], [ev - kn, 0, -drop], GREEN);
    slope(m, [mid, y0 - over, ridge + 0.004], [0, y1 - y0 + 2 * over, 0], [kn - mid + s * 0.01, 0, knee - ridge - 0.004], GREEN);
  }
  // White boards up its corners and along its eaves at the front.
  const front: Wall = { face: "+y", at: y1 };
  put(m, "matte", Solid.union([
    box(x0 - 0.006, x0 + 0.014, y1 - 0.01, y1 + 0.006, 0, eave), box(x1 - 0.014, x1 + 0.006, y1 - 0.01, y1 + 0.006, 0, eave),
    rod([x0, y1 + 0.004, eave], [mid - kx, y1 + 0.004, knee], 0.016), rod([x1, y1 + 0.004, eave], [mid + kx, y1 + 0.004, knee], 0.016),
    rod([mid - kx, y1 + 0.004, knee], [mid, y1 + 0.004, ridge], 0.016), rod([mid + kx, y1 + 0.004, knee], [mid, y1 + 0.004, ridge], 0.016),
  ]), WHITE);
  // The doors, braced, and the loft's door over them, hay showing.
  for (const s of [-1, 1]) {
    const [a0, a1] = s < 0 ? [mid - 0.13, mid] : [mid, mid + 0.13];
    put(m, "matte", box(a0, a1, y1 - 0.002, y1 + 0.008, 0, 0.18), RED);
    put(m, "matte", Solid.union([
      box(a0, a1, y1 + 0.006, y1 + 0.014, 0.168, 0.182), box(a0, a1, y1 + 0.006, y1 + 0.014, 0, 0.014), box(a0, a1, y1 + 0.006, y1 + 0.014, 0.084, 0.096),
      box(a0, a0 + 0.014, y1 + 0.006, y1 + 0.014, 0, 0.18), box(a1 - 0.014, a1, y1 + 0.006, y1 + 0.014, 0, 0.18),
      rod([a0 + 0.01, y1 + 0.01, 0.012], [a1 - 0.01, y1 + 0.01, 0.086], 0.012), rod([a0 + 0.01, y1 + 0.01, 0.094], [a1 - 0.01, y1 + 0.01, 0.17], 0.012),
    ]), WHITE);
  }
  put(m, "matte", box(mid - 0.15, mid + 0.15, y1, y1 + 0.016, 0.185, 0.2), WHITE);
  put(m, "matte", box(mid - 0.055, mid + 0.055, y1 - 0.002, y1 + 0.012, 0.27, 0.38).subtract(box(mid - 0.042, mid + 0.042, y1 - 0.01, y1 + 0.02, 0.282, 0.368)), WHITE);
  put(m, "matte", box(mid - 0.042, mid + 0.042, y1 - 0.004, y1 + 0.004, 0.282, 0.368), STRAW);
  for (const s of [-1, 1]) window(m, front, mid + s * 0.25, 0.08, { w: 0.065, h: 0.055, frame: WHITE });
  // The weathervane on its ridge.
  const vy = y0 + 0.12;
  put(m, "matte", Solid.union([post(mid, vy, ridge, 0.1, 0.005, 6), box(mid - 0.035, mid + 0.035, vy - 0.003, vy + 0.003, ridge + 0.075, ridge + 0.08), box(mid - 0.003, mid + 0.003, vy - 0.035, vy + 0.035, ridge + 0.075, ridge + 0.08)]), DARK);
}

/** A tractor at (x, y) facing +y, the town's red, and its trailer behind
 *  it in green. */
function tractor(m: Model, x: number, y: number) {
  put(m, "matte", box(x - 0.045, x + 0.045, y - 0.05, y + 0.08, 0.04, 0.09).add(box(x - 0.045, x + 0.045, y - 0.07, y + 0.0, 0.09, 0.17)), TRACTOR);
  put(m, "glass", box(x - 0.04, x + 0.04, y - 0.066, y + 0.004, 0.11, 0.16), [0.24, 0.29, 0.36]);
  put(m, "matte", box(x - 0.05, x + 0.05, y - 0.075, y + 0.008, 0.165, 0.178), TRACTOR);
  put(m, "matte", Solid.union([
    lying([x - 0.055, y - 0.04, 0.055], 0.055, 0.03, "x"), lying([x + 0.055, y - 0.04, 0.055], 0.055, 0.03, "x"),
    lying([x - 0.05, y + 0.07, 0.032], 0.032, 0.022, "x"), lying([x + 0.05, y + 0.07, 0.032], 0.032, 0.022, "x"),
  ]), TYRE);
  put(m, "matte", post(x + 0.025, y + 0.06, 0.09, 0.05, 0.006, 6), TYRE);
}

export const FARM = model((m) => {
  // Earth all over, the town's grass round its edges and in its corners.
  ground(m, "earth", [[-1.49, 1.49, -1.49, 1.49]], EARTH, { z: 0.015 });
  ground(m, "lawn", [
    [-1.49, -0.98, -1.49, 0.0], [-1.49, -0.55, -0.98, -0.05], [-0.42, -0.08, -0.6, -0.4],
    [-1.49, -0.36, 0.0, 1.49],
    [0.32, 0.6, -1.49, -0.8],
    [0.95, 1.49, -0.68, 1.49], [0.56, 1.49, 0.85, 1.49],
  ], LAWN, { z: 0.025, round: 0.08 });

  // The barn at the back on the left, the silos beside it, bales before them.
  gambrel(m, -0.95, -0.17, -1.4, -0.62, 0.22, 0.42, 0.56);
  for (const [x, y, r, h] of [[-1.24, -1.25, 0.14, 0.62], [-1.26, -0.86, 0.12, 0.5]]) {
    put(m, "matte", drum(x, y, r, h, 0), RED);
    put(m, "matte", Solid.union([0.18, 0.36, 0.54].filter((z) => z < h).map((z) => post(x, y, z, 0.014, r + 0.004, 24))), WHITE);
    put(m, "matte", Solid.sphere(r + 0.01, 20).scale([1, 1, 0.55]).translate([x, y, h]).add(post(x, y, h - 0.01, 0.02, r + 0.01, 24)), DOME);
    put(m, "matte", post(x, y, h + r * 0.5, 0.03, 0.02, 8), DOME);
  }
  put(m, "matte", Solid.union([
    ...[-1, 1].map((s) => box(-1.115, -1.105, -1.25 + s * 0.028 - 0.005, -1.25 + s * 0.028 + 0.005, 0, 0.64)),
    ...Array.from({ length: 8 }, (_, k) => box(-1.115, -1.108, -1.28, -1.22, 0.06 + k * 0.075, 0.066 + k * 0.075)),
  ]), WHITE);
  const bale = (x: number, y: number, z: number) => box(x - 0.045, x + 0.045, y - 0.032, y + 0.032, z, z + 0.055);
  put(m, "matte", Solid.union([bale(-0.82, -0.34, 0.025), bale(-0.82, -0.27, 0.025), bale(-0.72, -0.34, 0.025), bale(-0.72, -0.27, 0.025), bale(-0.77, -0.305, 0.08)]), STRAW);
  for (const x of [-0.7, -0.62, -0.42, -0.34]) shrub(m, x, -0.57, 0.028);
  fence(m, [[-0.36, -0.44], [-0.08, -0.44]], WHITE, "picket");
  tree(m, -1.08, -0.42, 0.6);

  // The machine shed at the back on the right: posts and beams, its back
  // boarded, a green roof; the tractor and its trailer in it.
  const [sx0, sx1, sy0, sy1, se, sr] = [0.56, 1.18, -1.4, -0.82, 0.21, 0.31];
  put(m, "matte", Solid.union([
    box(sx0, sx1, sy0, sy0 + 0.02, 0, se),
    ...[sx0, (sx0 + sx1) / 2, sx1 - 0.025].flatMap((x) => [box(x, x + 0.025, sy1 - 0.025, sy1, 0, se), box(x, x + 0.025, sy0, sy0 + 0.025, 0, se)]),
    box(sx0, sx1, sy1 - 0.025, sy1, se - 0.025, se),
    ...[sx0, sx1 - 0.025].map((x) => box(x, x + 0.025, sy0, sy1, se - 0.025, se)),
  ]), TIMBER);
  put(m, "matte", Solid.union([sx0, sx1 - 0.025].map((x) => rod([x + 0.012, sy1 - 0.012, se - 0.07], [x + 0.012 + (x < 0.8 ? 0.07 : -0.07), sy1 - 0.012, se - 0.01], 0.014))), TIMBER);
  pitched(m, "x", sx0, sx1, sy0, sy1, se, sr, GREEN, { over: 0.05 });
  tractor(m, 0.72, -1.12);
  put(m, "matte", box(0.92, 1.08, -1.32, -0.96, 0.04, 0.12).subtract(box(0.93, 1.07, -1.31, -0.97, 0.06, 0.13)), TRAILER);
  put(m, "matte", Solid.union([lying([0.915, -1.14, 0.04], 0.04, 0.02, "x"), lying([1.085, -1.14, 0.04], 0.04, 0.02, "x")]), TYRE);
  put(m, "matte", rod([1.0, -0.96, 0.06], [1.0, -0.9, 0.04], 0.012), TRAILER);
  tree(m, 0.42, -1.25, 0.55);
  shrub(m, 0.46, -0.95, 0.05);
  lamp(m, 0.42, -0.76, [0.48, -0.76]);

  // The farmhouse in the front corner, white, its gable to the street: a
  // porch the width of it on white posts, shuttered windows, a dormer, the
  // chimney; the shrubs down its garden, flowers, pickets round.
  const [hx0, hx1, hy0, hy1, he, hr] = [-1.38, -0.72, 0.1, 0.84, 0.24, 0.44];
  const hmid = (hx0 + hx1) / 2;
  put(m, "matte", barn("y", hx0, hx1, hy0, hy1, he, hr), WHITE);
  put(m, "matte", box(hx0 - 0.01, hx1 + 0.01, hy0 - 0.01, hy1 + 0.01, 0, 0.03), STONE);
  pitched(m, "y", hx0, hx1, hy0, hy1, he, hr, GREEN, { over: 0.045 });
  const front: Wall = { face: "+y", at: hy1 };
  door(m, front, hmid, SHUTTER, { w: 0.07, h: 0.15 });
  for (const s of [-1, 1]) {
    window(m, front, hmid + s * 0.18, 0.06, { w: 0.065, h: 0.065, shutters: SHUTTER, box: [0.45, 0.32, 0.22] });
    window(m, { face: s > 0 ? "+x" : "-x", at: s > 0 ? hx1 : hx0 }, 0.3, 0.06, { w: 0.065, h: 0.065, shutters: SHUTTER });
    window(m, { face: s > 0 ? "+x" : "-x", at: s > 0 ? hx1 : hx0 }, 0.62, 0.06, { w: 0.065, h: 0.065, shutters: SHUTTER });
  }
  window(m, front, hmid, 0.29, { w: 0.07, h: 0.06, shutters: SHUTTER, box: [0.45, 0.32, 0.22] });
  // The porch: its deck a step up, its roof on posts.
  put(m, "matte", box(hx0 - 0.02, hx1 + 0.02, hy1, hy1 + 0.13, 0, 0.03), TIMBER);
  put(m, "matte", box(hmid - 0.06, hmid + 0.06, hy1 + 0.13, hy1 + 0.17, 0, 0.015), STONE);
  for (const x of [hx0, hmid - 0.06, hmid + 0.06, hx1]) put(m, "matte", post(x + (x === hx0 ? 0.01 : x === hx1 ? -0.01 : 0), hy1 + 0.115, 0.03, 0.15, 0.011, 8), WHITE);
  put(m, "matte", box(hx0 - 0.03, hx1 + 0.03, hy1 + 0.1, hy1 + 0.13, 0.17, 0.19), WHITE);
  slope(m, [hx0 - 0.04, hy1, 0.235], [hx1 - hx0 + 0.08, 0, 0], [0, 0.16, -0.05], GREEN, 0.012);
  // A dormer in its right slope, the chimney up its left.
  const [dy, dz] = [(hy0 + hy1) / 2 - 0.05, he + 0.04];
  put(m, "matte", box(hx1 - 0.16, hx1 - 0.04, dy - 0.07, dy + 0.07, he - 0.02, dz + 0.07), WHITE);
  put(m, "matte", hull([[hx1 - 0.02, dy - 0.085, dz + 0.07], [hx1 - 0.02, dy + 0.085, dz + 0.07], [hx1 - 0.2, dy - 0.085, dz + 0.1], [hx1 - 0.2, dy + 0.085, dz + 0.1], [hx1 - 0.02, dy, dz + 0.12], [hx1 - 0.2, dy, dz + 0.14]]), GREEN.rgb);
  window(m, { face: "+x", at: hx1 - 0.04 }, dy, dz, { w: 0.06, h: 0.05 });
  chimney(m, hx0 + 0.09, hy0 + 0.12, hr + 0.1, BRICK, { smoke: 0.1 });
  // The garden: a row of clipped shrubs, beds of flowers, a stone path.
  for (let k = 0; k < 9; k++) shrub(m, -0.52, 0.12 + k * 0.085, 0.036, undefined, k);
  for (const [x, y, n] of [[-1.3, 1.25, 6], [-0.82, 1.25, 6], [-1.42, 0.95, 4], [-0.62, 1.05, 4], [-0.45, 1.3, 3]] as const) flowers(m, x, y, n, 0.06);
  put(m, "matte", Solid.union(Array.from({ length: 4 }, (_, k) => box(hmid - 0.035, hmid + 0.035, 1.06 + k * 0.1, 1.11 + k * 0.1, 0, 0.032))), STONE);
  fence(m, [[-0.42, 0.04], [-0.42, 1.47]], WHITE, "picket");
  fence(m, [[-1.47, 0.04], [-1.47, 1.47], [hmid - 0.06, 1.47]], WHITE, "picket");
  fence(m, [[hmid + 0.06, 1.47], [-0.47, 1.47]], WHITE, "picket");
  tree(m, -0.52, 1.18, 0.6);
  lamp(m, -0.56, 1.36, [-0.5, 1.36]);

  // The loading dock on the right: a deck on posts, steps down, crates
  // of the harvest; a barrel, the trough, flowers.
  const [kx0, kx1, ky0, ky1] = [0.6, 0.98, -0.36, 0.14];
  put(m, "matte", Solid.union([
    box(kx0, kx1, ky0, ky1, 0.05, 0.07),
    ...[kx0, kx1 - 0.02].flatMap((x) => [box(x, x + 0.02, ky0, ky0 + 0.02, 0, 0.05), box(x, x + 0.02, ky1 - 0.02, ky1, 0, 0.05)]),
    box(0.66, 0.82, ky1, ky1 + 0.05, 0, 0.035), box(0.66, 0.82, ky1 + 0.05, ky1 + 0.1, 0, 0.017),
  ]), TIMBER);
  for (const [x, y, z, fill] of [[0.7, -0.25, 0.07, APPLES], [0.82, -0.25, 0.07, ORANGES], [0.7, -0.12, 0.07, CABBAGE], [0.82, -0.12, 0.07, APPLES], [0.76, -0.185, 0.14, ORANGES], [0.92, -0.28, 0.07, CABBAGE]] as const) crate(m, x, y, z, 0.1, TIMBER, fill);
  cask(m, 0.92, 0.06, 0.035, 0.09, TIMBER);
  put(m, "matte", box(1.08, 1.22, -0.52, -0.1, 0.02, 0.08).subtract(box(1.095, 1.205, -0.505, -0.115, 0.04, 0.09)), TIMBER);
  put(m, "matte", box(1.095, 1.205, -0.505, -0.115, 0.02, 0.07), WATER);
  flowers(m, 1.15, 0.06, 5, 0.06);
  tree(m, 1.2, 0.32, 0.75);
  tree(m, 1.2, 0.98, 0.95);
  cone(m, 0.4, -1.1, 0.06, 0.24);

  // The way in from the street, its gates swung open between white posts,
  // a lantern either side; a bench on the grass.
  for (const s of [-1, 1]) put(m, "matte", box(s * 0.43 - 0.035, s * 0.43 + 0.035, 1.435, 1.505, 0, 0.16).add(box(s * 0.43 - 0.045, s * 0.43 + 0.045, 1.425, 1.515, 0.16, 0.18)), WHITE);
  gate(m, -0.39, 1.47, 0.2, -60, TIMBER);
  gate(m, 0.39, 1.47, 0.2, -120, TIMBER);
  lamp(m, 0.66, 1.0, [0.72, 1.0]);
  bench(m, 0.82, 1.15, "x", WHITE);
  for (const [x, y] of [[0.7, 1.35], [1.0, 1.36], [1.32, 1.3]]) flowers(m, x, y, 4, 0.05);
  fence(m, [[0.47, 1.47], [1.47, 1.47], [1.47, -0.3]], WHITE, "picket");

  // The rail fence round the back, open at its middle for the tractor,
  // its gates swung open.
  fence(m, [[1.47, -0.3], [1.47, -1.47], [0.3, -1.47]], TIMBER);
  gate(m, 0.3, -1.47, 0.14, -70, TIMBER);
  fence(m, [[-0.3, -1.47], [-1.47, -1.47], [-1.47, 0.04]], TIMBER);
  gate(m, -0.3, -1.47, 0.14, -110, TIMBER);
});
