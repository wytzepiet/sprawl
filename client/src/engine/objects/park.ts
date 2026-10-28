import type { RGB } from "../rgb";
import { theme } from "../theme";
import { bench, flowers, ground, hedge, lamp, model, tree } from "./kit";

/**
 * A park, whole, on its plot: two tiles square (x and y, -1 to 1), the
 * street at +y, its ground on z = 0. Its front strip, the last INSET
 * (`footprint.ts`), is the town's pavement, where its visitors park at
 * the kerb; the rest is the park's own.
 *
 * - The town's grass all over, a low hedge round its back and sides.
 * - A gravel path in a loop round an island of lawn, a straight one in
 *   to it from the street.
 * - On the island a bed of flowers and a big tree; trees in three of the
 *   corners outside the loop.
 * - Two benches by the loop, looking in; a lamp where the path comes in,
 *   another at the back.
 */

const LAWN = [theme.land.r, theme.land.g, theme.land.b] as RGB;
const GRAVEL: RGB = [0.8, 0.76, 0.67];
const WOOD: RGB = [0.55, 0.37, 0.24];

/** The front of its own ground, the pavement before it; the loop's
 *  outside and how wide the path. */
const FRONT = 0.83;
const [LX0, LX1, LY0, LY1, PATH] = [-0.62, 0.62, -0.6, 0.48, 0.13];

export const PARK = model((m) => {
  ground(m, "lawn", [[-0.99, 0.99, -0.99, FRONT]], LAWN, { z: 0.015 });
  // The loop: gravel over the lawn, the island's lawn over the gravel.
  ground(m, "dust", [[LX0, LX1, LY0, LY1]], GRAVEL, { z: 0.02, round: 0.3 });
  ground(m, "dust", [[-PATH / 2, PATH / 2, LY1 - 0.05, FRONT + 0.02]], GRAVEL, { z: 0.02 });
  ground(m, "lawn", [[LX0 + PATH, LX1 - PATH, LY0 + PATH, LY1 - PATH]], LAWN, { z: 0.025, round: 0.3 - PATH });
  hedge(m, [[-0.95, FRONT - 0.04], [-0.95, -0.95], [0.95, -0.95], [0.95, FRONT - 0.04]], { h: 0.07, t: 0.07 });

  // The island: its flowers, its big tree.
  flowers(m, -0.18, -0.04, 6, 0.12);
  tree(m, 0.16, -0.12, 0.6);
  // Round the loop: three trees in the corners, the fourth corner open
  // to the street.
  tree(m, -0.8, -0.78, 0.6);
  tree(m, 0.8, -0.76, 0.7);
  tree(m, 0.8, 0.62, 0.55);
  // The benches, on the grass by the path, looking in.
  bench(m, -0.15, LY0 - 0.06, "x", WOOD);
  bench(m, LX0 - 0.06, 0.05, "y", WOOD);
  lamp(m, PATH / 2 + 0.06, LY1 + 0.08, [PATH / 2, LY1 + 0.08]);
  lamp(m, 0.3, LY0 - 0.06, [0.3, LY0]);
});
