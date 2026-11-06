import type { RGB } from "../rgb";
import { Solid } from "../solid";
import { theme } from "../theme";
import { box, cone, drum, fence, gate, ground, hull, lamp, model, post, put, rod, shrub, slope, tree, window, type Cover, type Model, type V, type Wall } from "./kit";

/**
 * A farm, whole, on the back row of its plot (x -1 to 1, the street at
 * +y, its loading bay cut at x = 0.5): its ground on z = 0. Its fields
 * round it are the town grid's (`field.ts`), the tractor out to them
 * through the yard behind the bay and the gate in the back (`fields.rs`).
 *
 * - On the left the barn, red, under a green gambrel roof: its double
 *   doors braced white, its hay loft's door over them, a weathervane; two
 *   red silos beside it, domed; square bales by the bay.
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

export const FARM = model((m) => {
  ground(m, "earth", [[-0.99, 0.99, -1.49, -0.5]], EARTH, { z: 0.015 });
  ground(m, "lawn", [[-0.99, -0.9, -1.49, -0.5], [0.9, 0.99, -1.49, -0.5]], LAWN, { z: 0.025, round: 0.06 });

  // The barn on the left, the silos beside it.
  gambrel(m, -0.62, 0.0, -1.4, -0.62, 0.22, 0.42, 0.56);
  for (const [x, y, r, h] of [[-0.8, -1.24, 0.13, 0.62], [-0.82, -0.88, 0.1, 0.48]]) {
    put(m, "matte", drum(x, y, r, h, 0), RED);
    put(m, "matte", Solid.union([0.18, 0.36, 0.54].filter((z) => z < h).map((z) => post(x, y, z, 0.014, r + 0.004, 24))), WHITE);
    put(m, "matte", Solid.sphere(r + 0.01, 20).scale([1, 1, 0.55]).translate([x, y, h]).add(post(x, y, h - 0.01, 0.02, r + 0.01, 24)), DOME);
    put(m, "matte", post(x, y, h + r * 0.5, 0.03, 0.02, 8), DOME);
  }
  const bale = (x: number, y: number, z: number) => box(x - 0.045, x + 0.045, y - 0.032, y + 0.032, z, z + 0.055);
  put(m, "matte", Solid.union([bale(0.74, -0.66, 0.025), bale(0.74, -0.59, 0.025), bale(0.84, -0.66, 0.025), bale(0.84, -0.59, 0.025), bale(0.79, -0.625, 0.08)]), STRAW);
  for (const x of [-0.45, -0.37, -0.17, -0.09]) shrub(m, x, -0.57, 0.028);

  // The yard behind the loading bay is the tractor's way out to the
  // fields; a tree, a lamp and a cone at its sides.
  tree(m, 0.84, -1.2, 0.55);
  lamp(m, 0.12, -0.76, [0.18, -0.76]);
  cone(m, 0.84, -0.92, 0.06, 0.24);

  // The rail fence round the back, open behind the yard for the
  // tractor, its gates swung open.
  fence(m, [[0.97, -0.52], [0.97, -1.47], [0.85, -1.47]], TIMBER);
  gate(m, 0.85, -1.47, 0.14, -70, TIMBER);
  fence(m, [[0.15, -1.47], [-0.97, -1.47], [-0.97, -0.52]], TIMBER);
  gate(m, 0.15, -1.47, 0.14, -110, TIMBER);
});
