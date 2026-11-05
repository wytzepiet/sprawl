import type { RGB } from "../rgb";
import { Solid } from "../solid";
import { theme } from "../theme";
import { box, cone, drum, fence, gate, ground, hull, lamp, lying, model, pitched, post, put, rod, shrub, slope, tree, window, PANE, type Cover, type Model, type V, type Wall } from "./kit";

/**
 * A farm, whole, on the back row of its plot (x -1.5 to 1.5, the street
 * at +y, its yard before it as the shop's): its ground on z = 0. Its
 * fields round it are the town grid's (`field.ts`), the tractor out to
 * them by the gate in the middle of the back (`fields.rs`).
 *
 * - On the left the barn, red, under a green gambrel roof: its double
 *   doors braced white, its hay loft's door over them, a weathervane; two
 *   red silos beside it, domed; square bales before the shed.
 * - On the right the machine shed, open timber on posts, the red
 *   tractor's twin and a trailer in it.
 * - Earth over it, the town's grass in its corners, a rail fence round
 *   the back, its gates swung open.
 */

const RED: RGB = [0.68, 0.26, 0.22];
const WHITE: RGB = [0.94, 0.92, 0.86];
const GREEN: Cover = { finish: "ribs", rgb: [0.34, 0.56, 0.36], ribs: 30 };
const TIMBER: RGB = [0.55, 0.4, 0.27];
const DARK: RGB = [0.4, 0.29, 0.2];
const STRAW: RGB = [0.92, 0.77, 0.4];
const EARTH: RGB = [0.72, 0.62, 0.48];
const DOME: RGB = [0.86, 0.87, 0.87];
const TYRE: RGB = [0.2, 0.2, 0.21];
const TRACTOR: RGB = [0.78, 0.25, 0.2];
const TRAILER: RGB = [0.36, 0.56, 0.32];
const LAWN = [theme.land.r, theme.land.g, theme.land.b] as RGB;

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
  put(m, "matte", box(x - 0.04, x + 0.04, y - 0.066, y + 0.004, 0.11, 0.16), PANE);
  put(m, "matte", box(x - 0.05, x + 0.05, y - 0.075, y + 0.008, 0.165, 0.178), TRACTOR);
  put(m, "matte", Solid.union([
    lying([x - 0.055, y - 0.04, 0.055], 0.055, 0.03, "x"), lying([x + 0.055, y - 0.04, 0.055], 0.055, 0.03, "x"),
    lying([x - 0.05, y + 0.07, 0.032], 0.032, 0.022, "x"), lying([x + 0.05, y + 0.07, 0.032], 0.032, 0.022, "x"),
  ]), TYRE);
  put(m, "matte", post(x + 0.025, y + 0.06, 0.09, 0.05, 0.006, 6), TYRE);
}

export const FARM = model((m) => {
  ground(m, "earth", [[-1.49, 1.49, -1.49, -0.5]], EARTH, { z: 0.015 });
  ground(m, "lawn", [[-1.49, -1.0, -1.49, -0.5], [0.32, 0.6, -1.49, -0.8], [1.22, 1.49, -1.49, -0.5]], LAWN, { z: 0.025, round: 0.08 });

  // The barn on the left, the silos beside it.
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
  put(m, "matte", Solid.union([bale(0.0, -0.66, 0.025), bale(0.0, -0.59, 0.025), bale(0.1, -0.66, 0.025), bale(0.1, -0.59, 0.025), bale(0.05, -0.625, 0.08)]), STRAW);
  for (const x of [-0.7, -0.62, -0.42, -0.34]) shrub(m, x, -0.57, 0.028);

  // The machine shed on the right: posts and beams, its back boarded, a
  // green roof; the tractor and its trailer in it.
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
  tree(m, 1.36, -0.9, 0.7);
  lamp(m, 0.42, -0.76, [0.48, -0.76]);
  cone(m, 0.4, -1.1, 0.06, 0.24);

  // The rail fence round the back, open at its middle for the tractor,
  // its gates swung open.
  fence(m, [[1.47, -0.52], [1.47, -1.47], [0.3, -1.47]], TIMBER);
  gate(m, 0.3, -1.47, 0.14, -70, TIMBER);
  fence(m, [[-0.3, -1.47], [-1.47, -1.47], [-1.47, -0.52]], TIMBER);
  gate(m, -0.3, -1.47, 0.14, -110, TIMBER);
});
