import type { RGB } from "../rgb";
import { Solid } from "../solid";
import { awning, barn, box, chimney, crate, door, dormer, fence, flowers, gate, ground, halfRound, heap, hull, lamp, leanTo, lying, model, on, pitched, plate, post, put, rod, sheet, shrub, tree, window, PANE, type Cover, type Model, type V, type Wall } from "./kit";

/**
 * The trades of the later chains, whole, each on its plot from its
 * reference (`refresh/refs2/`, where each is read in depth). A 2x2 works
 * stands on x -1 to 1, y -2 to 0, its front wall at y = 0; a 2x1 on y
 * -1.5 to -0.5, its front at -0.5; the street at +y, the loading bay cut
 * at x = 0.5. Ground on z = 0.
 *
 * - The bakery: a brick bakehouse, its oven's chimney, a striped
 *   awning over its window (made by hand, no reference yet; the fire
 *   station borrows it).
 * - The brickworks: a beehive kiln, its chimney, an open drying shed of
 *   green bricks, pallets of red ones, logs for the fire.
 * - The glassworks: a stone glass cone, the hall beside it glowing
 *   through its arched windows, crates of panes and bottles.
 * - The workshop: a timber workshop, its doors flung open on its bench,
 *   skylights in its roof, planks under its lean-to, furniture out front.
 * - The tailor: a half-timbered house under a striped awning, bolts of
 *   cloth before it, a scissors sign; the wool in at its wing.
 * - The sheep farm: sheep in a fenced paddock, their stone barn, the wool
 *   shed the lorry backs up to, bales under its lean-to.
 */

const BRICK: RGB = [0.66, 0.34, 0.26];
/** The kiln's and its chimney's brick, warmer than a house's. */
const KILN: RGB = [0.76, 0.41, 0.28];
const RED: RGB = [0.74, 0.36, 0.25];
const TERRACOTTA: Cover = { finish: "tiles", rgb: [0.74, 0.4, 0.27] };
const SLATE: Cover = { finish: "tiles", rgb: [0.42, 0.45, 0.5] };
const WOOD: RGB = [0.55, 0.38, 0.25];
const DARKWOOD: RGB = [0.36, 0.25, 0.18];
const IRON: RGB = [0.24, 0.24, 0.26];
const CREAM: RGB = [0.93, 0.89, 0.8];
const STONE: RGB = [0.72, 0.68, 0.62];
const BARK: RGB = [0.5, 0.35, 0.22];
const END: RGB = [0.88, 0.74, 0.52];
const SLATE_BLUE: Cover = { finish: "tiles", rgb: [0.36, 0.4, 0.5] };
const INSIDE: RGB = [0.2, 0.17, 0.15];
const BALE: RGB = [0.93, 0.9, 0.82];

/** A frustum standing at (x, y) from `z`, `h` high, `r0` round at its
 *  foot and `r1` at its top. */
const frustum = (x: number, y: number, z: number, h: number, r0: number, r1: number, sides = 24) => Solid.cylinder(h, r0, r1, sides).translate([x, y, z]);

/** A body turned round (x, y) through a profile of `[z, r]` from the
 *  ground up. */
const turned = (x: number, y: number, profile: [number, number][], sides = 28) =>
  Solid.union(profile.slice(1).map(([z, r], k) => frustum(x, y, profile[k][0], z - profile[k][0], profile[k][1], r, sides)));

/** Logs stacked lying along `along`, from (x, y) across, `n` in the
 *  bottom row, `l` long and `r` round: bark, their cut ends paler. */
function logs(m: Model, x: number, y: number, along: "x" | "y", n: number, l: number, r: number) {
  const bark: ReturnType<typeof box>[] = [], ends: ReturnType<typeof box>[] = [];
  for (let row = 0; row < n; row++)
    for (let k = 0; k < n - row; k++) {
      const a = (k + row / 2) * r * 2;
      const at: V = along === "y" ? [x + a, y, r + row * r * 1.72] : [x, y + a, r + row * r * 1.72];
      bark.push(lying(at, r, l, along, 10));
      ends.push(lying(at, r * 0.86, l + 0.006, along, 10));
    }
  put(m, "matte", Solid.union(bark), BARK);
  put(m, "matte", Solid.union(ends).subtract(Solid.union(bark)), END);
}

/** An arched opening in a wall, dark: its middle `at`, `w` across, its
 *  arch springing at `z`. */
const archway = (m: Model, wall: Wall, at: number, w: number, z: number, rgb: RGB = INSIDE) =>
  put(m, "matte", plate(wall, at - w / 2, at + w / 2, 0, z, -0.002, 0.004).add(halfRound(wall, at, z, w / 2, -0.002, 0.004)), rgb);

/** A barrel-vaulted porch out from a round wall toward +y: from `y0` out
 *  to `y1`, `w` across, its vault springing at `z`; its arch dark. */
function porch(m: Model, x: number, y0: number, y1: number, w: number, z: number, rgb: RGB) {
  put(m, "matte", box(x - w / 2, x + w / 2, y0, y1, 0, z).add(lying([x, (y0 + y1) / 2, z], w / 2, y1 - y0, "y", 16).subtract(box(x - 1, x + 1, y0 - 1, y1 + 1, -1, z - 0.001).subtract(box(x - w / 2, x + w / 2, y0, y1, 0, z)))), rgb);
  archway(m, { face: "+y", at: y1 }, x, w * 0.56, z - 0.01);
}

/** A pallet at (x, y) of red bricks, `s` across, `h` high, in four
 *  stacks a gap apart. */
function pallet(m: Model, x: number, y: number, s: number, h: number, rgb: RGB = RED) {
  put(m, "matte", box(x - s / 2, x + s / 2, y - s / 2, y + s / 2, 0, 0.018), WOOD);
  const q = s / 2 - 0.004;
  put(m, "matte", Solid.union([[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([i, j]) => box(x + (i < 0 ? -q : 0.003), x + (i < 0 ? -0.003 : q), y + (j < 0 ? -q : 0.003), y + (j < 0 ? -0.003 : q), 0.018, 0.018 + h))), rgb);
}

/** A small store at the gate, its front at the street, the loading bay
 *  cut into it (`notched`): where a lorry backs up to be loaded. */
function bayShed(m: Model, y0: number, wall: RGB, cover: Cover, trim?: RGB) {
  put(m, "matte", barn("y", 0.27, 0.73, y0, 0, 0.2, 0.31), wall);
  if (trim) put(m, "matte", Solid.union([0.27, 0.73].flatMap((x) => [box(x - 0.012, x + 0.012, -0.012, 0.004, 0, 0.2), rod([x + (x < 0.5 ? -0.02 : 0.02), 0.012, 0.19], [0.5, 0.012, 0.32], 0.018)])), trim);
  pitched(m, "y", 0.27, 0.73, y0, 0, 0.2, 0.31, cover, { over: 0.025 });
  window(m, { face: "+x", at: 0.73 }, y0 + 0.2, 0.08, { w: 0.08, h: 0.06 });
}

// --- The brickworks ----------------------------------------------------------

export const BRICKWORKS = model((m) => {
  ground(m, "earth", [[-0.97, 0.97, -1.97, -0.28]], [0.68, 0.56, 0.44], { z: 0.015, round: 0.06 });

  // The drying shed, open all round on its posts, its tiles over racks
  // of green bricks drying.
  const [sx0, sx1, sy0, sy1, eave, ridge] = [-0.94, -0.3, -1.9, -0.82, 0.17, 0.31];
  const ys = Array.from({ length: 6 }, (_, k) => sy0 + 0.03 + ((sy1 - sy0 - 0.06) * k) / 5);
  put(m, "matte", Solid.union([
    ...ys.flatMap((y) => [box(sx0 + 0.01, sx0 + 0.035, y - 0.012, y + 0.012, 0, eave), box(sx1 - 0.035, sx1 - 0.01, y - 0.012, y + 0.012, 0, eave)]),
    box(sx0 + 0.005, sx0 + 0.04, sy0 + 0.01, sy1 - 0.01, eave - 0.025, eave), box(sx1 - 0.04, sx1 - 0.005, sy0 + 0.01, sy1 - 0.01, eave - 0.025, eave),
    ...ys.map((y) => box(sx0 + 0.01, sx1 - 0.01, y - 0.01, y + 0.01, eave - 0.02, eave - 0.002)),
  ]), WOOD);
  pitched(m, "y", sx0, sx1, sy0, sy1, eave, ridge, TERRACOTTA, { over: 0.035 });
  const rack = (x: number, y0: number, y1: number) => {
    put(m, "matte", Solid.union([0.035, 0.09].map((z) => box(x - 0.07, x + 0.07, y0, y1, z - 0.008, z)).concat([y0, y1].flatMap((y) => [-1, 1].map((s) => box(x + s * 0.065 - 0.006, x + s * 0.065 + 0.006, y - 0.006, y + 0.006, 0, 0.09))))), DARKWOOD);
    put(m, "matte", Solid.union([0.035, 0.09].flatMap((z) => Array.from({ length: Math.floor((y1 - y0 - 0.02) / 0.064) }, (_, k) => box(x - 0.06, x + 0.06, y0 + 0.02 + k * 0.064, y0 + 0.06 + k * 0.064, z, z + 0.028)))), [0.5, 0.56, 0.4]);
  };
  for (const x of [-0.79, -0.46]) rack(x, sy0 + 0.06, sy1 - 0.06);
  // More drying in the open before it.
  for (const x of [-0.79, -0.53]) rack(x, -0.74, -0.4);

  // The kiln: a beehive of brick on its plinth, an iron band round its
  // belly, its neck; its firing door arched to the yard.
  const [kx, ky] = [0.22, -1.32];
  put(m, "matte", post(kx, ky, 0, 0.045, 0.34, 28), STONE);
  put(m, "matte", turned(kx, ky, [[0.04, 0.27], [0.24, 0.28], [0.38, 0.26], [0.52, 0.21], [0.64, 0.14], [0.7, 0.1], [0.8, 0.1]]), KILN);
  put(m, "matte", post(kx, ky, 0.8, 0.03, 0.12, 20).subtract(post(kx, ky, 0.805, 0.04, 0.075, 16)), KILN);
  put(m, "matte", post(kx, ky, 0.22, 0.028, 0.288, 28), IRON);
  porch(m, kx, ky + 0.2, ky + 0.36, 0.17, 0.13, KILN);
  // Its chimney behind, tall and round, the flue low between them.
  const [cx, cy] = [0.66, -1.72];
  put(m, "matte", box(cx - 0.11, cx + 0.11, cy - 0.11, cy + 0.11, 0, 0.14), BRICK);
  put(m, "matte", frustum(cx, cy, 0.14, 0.92, 0.085, 0.065, 18).add(post(cx, cy, 0.99, 0.04, 0.08, 18)).subtract(post(cx, cy, 1.0, 0.05, 0.045, 14)), KILN);
  put(m, "matte", post(cx, cy, 0.98, 0.012, 0.072, 18), IRON);
  put(m, "matte", box(kx + 0.2, cx, cy - 0.04, cy + 0.04, 0, 0.1).add(box(kx + 0.12, kx + 0.26, cy - 0.04, ky - 0.24, 0, 0.1)), BRICK);

  // The logs for the fire, the clay come in, the bricks gone out.
  logs(m, 0.66, -1.14, "y", 4, 0.3, 0.034);
  heap(m, "gravel", 0.86, -0.8, 0.09, 0.07, 0.015, 2, [0.6, 0.57, 0.53]);
  bayShed(m, -0.6, BRICK, TERRACOTTA);
  for (const [x, y] of [[-0.12, -0.72], [0.06, -0.72], [-0.12, -0.53], [0.06, -0.53], [-0.12, -0.34]]) pallet(m, x, y, 0.15, 0.1);
  lamp(m, -0.97, -0.15, [-0.8, -0.15]);
});

// --- The glassworks ------------------------------------------------------------

const TEAL: RGB = [0.27, 0.55, 0.57];
const GLOW: RGB = [0.95, 0.6, 0.28];
const PANES: RGB = [0.62, 0.8, 0.8];
const SAND: RGB = [0.88, 0.8, 0.6];
const LIMESTONE: RGB = [0.92, 0.85, 0.7];

export const GLASSWORKS = model((m) => {
  // The cone: stone, on its round base, its courses picked out, an
  // arched door to the yard.
  const [cx, cy] = [-0.52, -1.34];
  put(m, "matte", post(cx, cy, 0, 0.17, 0.38, 32).add(frustum(cx, cy, 0.17, 0.7, 0.34, 0.1, 32)).add(post(cx, cy, 0.86, 0.04, 0.115, 20)).subtract(post(cx, cy, 0.87, 0.05, 0.075, 16)), LIMESTONE);
  put(m, "matte", Solid.union([post(cx, cy, 0.16, 0.025, 0.39, 32), frustum(cx, cy, 0.42, 0.02, 0.255, 0.25, 32).add(frustum(cx, cy, 0.64, 0.02, 0.175, 0.17, 32))]), STONE);
  porch(m, cx, cy + 0.3, cy + 0.44, 0.2, 0.14, LIMESTONE);
  put(m, "matte", plate({ face: "+y", at: cy + 0.44 }, cx - 0.056, cx + 0.056, 0, 0.13, 0, 0.006), TEAL);

  // The hall: stone walls under a slate roof, its arched windows glowing,
  // teal picked out round them; a lantern along its ridge for the heat.
  const [x0, x1, y0, y1, eave, ridge] = [-0.1, 0.92, -1.86, -1.0, 0.3, 0.46];
  put(m, "matte", barn("x", x0, x1, y0, y1, eave, ridge), LIMESTONE);
  put(m, "matte", box(x0 - 0.008, x1 + 0.008, y0 - 0.008, y1 + 0.008, 0, 0.03), STONE);
  pitched(m, "x", x0, x1, y0, y1, eave, ridge, SLATE, { over: 0.03 });
  const front: Wall = { face: "+y", at: y1 };
  for (const x of [0.05, 0.22, 0.6, 0.77]) {
    put(m, "matte", plate(front, x - 0.075, x + 0.075, 0.04, 0.2, 0, 0.008).add(halfRound(front, x, 0.2, 0.075, 0, 0.008)).subtract(plate(front, x - 0.058, x + 0.058, 0.05, 0.2, -0.01, 0.02).add(halfRound(front, x, 0.2, 0.058, -0.01, 0.02))), TEAL);
    put(m, "glass", plate(front, x - 0.058, x + 0.058, 0.05, 0.2, -0.004, 0.003).add(halfRound(front, x, 0.2, 0.058, -0.004, 0.003)), GLOW);
    put(m, "matte", Solid.union([plate(front, x - 0.003, x + 0.003, 0.05, 0.258, -0.002, 0.006), plate(front, x - 0.058, x + 0.058, 0.13, 0.136, -0.002, 0.006)]), TEAL);
  }
  door(m, front, 0.41, TEAL, { w: 0.12, h: 0.22, frame: TEAL, arch: true });
  put(m, "matte", Solid.union([x0, x1].map((x) => box(x - 0.012, x + 0.012, y1 - 0.012, y1 + 0.012, 0, eave))).add(plate(front, x0, x1, eave - 0.022, eave, 0, 0.01)), TEAL);
  put(m, "matte", barn("x", 0.12, 0.7, -1.49, -1.37, ridge + 0.07, ridge + 0.12).add(box(0.12, 0.7, -1.49, -1.37, ridge - 0.02, ridge + 0.02)), TEAL);
  put(m, "glass", box(0.15, 0.67, -1.495, -1.365, ridge + 0.022, ridge + 0.068), GLOW);
  pitched(m, "x", 0.12, 0.7, -1.49, -1.37, ridge + 0.07, ridge + 0.12, SLATE, { over: 0.02 });
  chimney(m, 0.82, -1.62, 0.62, [0.62, 0.36, 0.28], { w: 0.08 });

  // The yard: crates of panes and of bottles, the sand come in, logs.
  for (const [x, y] of [[-0.86, -0.62], [-0.7, -0.62], [-0.86, -0.44]]) {
    put(m, "matte", box(x - 0.065, x + 0.065, y - 0.05, y + 0.05, 0, 0.05).subtract(box(x - 0.055, x + 0.055, y - 0.04, y + 0.04, 0.012, 0.1)), WOOD);
    put(m, "matte", Solid.union([-0.03, -0.01, 0.01, 0.03].map((d) => box(x - 0.05, x + 0.05, y + d - 0.003, y + d + 0.003, 0.012, 0.11))), PANES);
  }
  for (const [x, y] of [[-0.68, -0.44], [-0.54, -0.6]]) crate(m, x, y, 0, 0.1, WOOD, [0.36, 0.58, 0.46]);
  heap(m, "gravel", 0.1, -0.72, 0.12, 0.08, 0, 3, SAND);
  bayShed(m, -0.62, LIMESTONE, SLATE, TEAL);
  logs(m, 0.78, -0.6, "y", 3, 0.32, 0.034);
  lamp(m, -0.97, -0.2, [-0.8, -0.2]);
});

// --- The workshop --------------------------------------------------------------

const BOARDS: RGB = [0.6, 0.55, 0.64];
const TRIM: RGB = [0.92, 0.87, 0.74];
const SHINGLE: Cover = { finish: "ribs", rgb: [0.44, 0.4, 0.5], ribs: 30 };
const LEAN: Cover = { finish: "ribs", rgb: [0.52, 0.55, 0.6], ribs: 34 };
const PLANK: RGB = [0.86, 0.7, 0.48];
const FURNITURE: RGB = [0.6, 0.4, 0.25];

/** A stack of planks lying along y at (x, y), `l` long, `n` layers. */
function planks(m: Model, x: number, y: number, l: number, n: number) {
  put(m, "matte", Solid.union(Array.from({ length: n }, (_, k) => [-1, 0, 1].map((i) => box(x + i * 0.034 - 0.015, x + i * 0.034 + 0.015, y - l / 2, y + l / 2, 0.012 + k * 0.022, 0.03 + k * 0.022))).flat()), PLANK);
  put(m, "matte", Solid.union([-0.4, 0, 0.4].map((f) => box(x - 0.055, x + 0.055, y + f * l - 0.01, y + f * l + 0.01, 0, 0.012))), DARKWOOD);
}

export const WORKSHOP = model((m) => {
  // The workshop, gable to the street, boarded and painted, its corners
  // and barge boards cream.
  const [x0, x1, y0, y1, eave, ridge] = [-0.8, 0.14, -1.9, -0.74, 0.3, 0.56];
  const mid = (x0 + x1) / 2;
  put(m, "matte", barn("y", x0, x1, y0, y1, eave, ridge), BOARDS);
  pitched(m, "y", x0, x1, y0, y1, eave, ridge, SHINGLE, { over: 0.035 });
  const front: Wall = { face: "+y", at: y1 };
  put(m, "matte", Solid.union([
    ...[x0, x1].map((x) => box(x - 0.012, x + 0.012, y1 - 0.012, y1 + 0.012, 0, eave)),
    ...[x0, x1].map((x) => box(x - 0.012, x + 0.012, y0 - 0.012, y0 + 0.012, 0, eave)),
    rod([x0 - 0.035, y1 + 0.03, eave - 0.02], [mid, y1 + 0.03, ridge + 0.012], 0.024), rod([x1 + 0.035, y1 + 0.03, eave - 0.02], [mid, y1 + 0.03, ridge + 0.012], 0.024),
  ]), TRIM);
  // Its doors flung open, braced, on the bench inside.
  const [d0, d1, dh] = [mid - 0.13, mid + 0.13, 0.23];
  put(m, "matte", plate(front, d0, d1, 0, dh, -0.006, 0.002), INSIDE);
  put(m, "matte", plate(front, d0 - 0.014, d1 + 0.014, dh, dh + 0.014, 0, 0.01).add(plate(front, d0 - 0.014, d0, 0, dh, 0, 0.01)).add(plate(front, d1, d1 + 0.014, 0, dh, 0, 0.01)), TRIM);
  // Each leaf hung at its jamb, swung out 50 degrees.
  const L = 0.13;
  const leaf = Solid.union([box(0, L, -0.005, 0.005, 0.004, dh - 0.006)]);
  const brace = Solid.union([
    box(0, L, -0.009, 0.009, 0.004, 0.018), box(0, L, -0.009, 0.009, dh - 0.02, dh - 0.006),
    box(0, 0.014, -0.009, 0.009, 0.004, dh - 0.006), box(L - 0.014, L, -0.009, 0.009, 0.004, dh - 0.006),
    rod([0.01, 0, 0.015], [L - 0.01, 0, dh - 0.015], 0.012), rod([L - 0.01, 0, 0.015], [0.01, 0, dh - 0.015], 0.012),
  ]);
  for (const [x, a] of [[d0, 130], [d1, 50]] as const) {
    put(m, "matte", leaf.rotate([0, 0, a]).translate([x, y1 + 0.008, 0]), BOARDS);
    put(m, "matte", brace.rotate([0, 0, a]).translate([x, y1 + 0.008, 0]), TRIM);
  }
  // The louvre in its gable, a window along each side.
  put(m, "matte", plate(front, mid - 0.045, mid + 0.045, 0.37, 0.43, 0, 0.01), TRIM);
  put(m, "matte", Solid.union([0.385, 0.4, 0.415].map((z) => plate(front, mid - 0.035, mid + 0.035, z, z + 0.008, 0.008, 0.016))), BOARDS);
  for (const y of [-1.6, -1.15]) {
    window(m, { face: "-x", at: x0 }, y, 0.12, { w: 0.12, h: 0.08, frame: TRIM, bars: 1 });
    window(m, { face: "+x", at: x1 }, y, 0.12, { w: 0.12, h: 0.08, frame: TRIM, bars: 1 });
  }
  // Long skylights in the roof, either side of its ridge.
  const run = (x1 - x0) / 2, rise = ridge - eave;
  for (const s of [-1, 1]) {
    const [f0, f1] = [0.28, 0.48];
    const o: V = [mid + s * run * f0, -1.6, ridge - rise * f0 + 0.02];
    const v: V = [s * run * (f1 - f0), 0, -rise * (f1 - f0)];
    put(m, "matte", sheet(o, [0, 0.55, 0], v, 0.012), TRIM);
    put(m, "glass", sheet([o[0] + s * 0.012, o[1] + 0.02, o[2] + 0.006], [0, 0.51, 0], [v[0] - s * 0.024, 0, v[2] + 0.013], 0.012), [0.4, 0.5, 0.58]);
  }
  chimney(m, x0 + 0.17, -1.62, 0.66, BRICK, { w: 0.08 });
  // The lean-to on its side, on posts, planks stacked under it.
  leanTo(m, { face: "+x", at: x1 }, y0, y1 - 0.12, 0.27, 0.42, 0.09, LEAN);
  put(m, "matte", Solid.union([-1.86, -1.42, -0.9].map((y) => box(x1 + 0.38, x1 + 0.4, y - 0.01, y + 0.01, 0, 0.19))), WOOD);
  for (const x of [0.28, 0.44]) planks(m, x, -1.38, 0.8, 4);
  planks(m, 0.5, -0.92, 0.36, 3);
  // Out front: what it made, waiting, and the sawhorse.
  const chair = (x: number, y: number) => put(m, "matte", Solid.union([box(x - 0.025, x + 0.025, y - 0.025, y + 0.025, 0.045, 0.053), box(x - 0.025, x + 0.025, y - 0.025, y - 0.017, 0.053, 0.11), ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([i, j]) => box(x + i * 0.02 - 0.004, x + i * 0.02 + 0.004, y + j * 0.02 - 0.004, y + j * 0.02 + 0.004, 0, 0.045))]), FURNITURE);
  chair(-0.72, -0.5);
  chair(-0.12, -0.58);
  put(m, "matte", Solid.union([box(-0.65, -0.47, -0.58, -0.44, 0.07, 0.08), ...[[-0.64, -0.57], [-0.48, -0.57], [-0.64, -0.45], [-0.48, -0.45]].map(([x, y]) => box(x - 0.005, x + 0.005, y - 0.005, y + 0.005, 0, 0.07))]), FURNITURE);
  put(m, "matte", box(0.0, 0.12, -0.6, -0.53, 0, 0.19), FURNITURE);
  put(m, "matte", Solid.union([plate({ face: "+y", at: -0.53 }, 0.058, 0.062, 0.01, 0.18, 0, 0.003), plate({ face: "+y", at: -0.53 }, 0.005, 0.115, 0.17, 0.176, 0, 0.003)]), DARKWOOD);
  put(m, "matte", Solid.union([box(-0.42, -0.24, -0.31, -0.29, 0.08, 0.1), ...[-0.4, -0.26].flatMap((x) => [-1, 1].map((s) => rod([x, -0.3, 0.09], [x, -0.3 + s * 0.04, 0], 0.012)))]), WOOD);
  bayShed(m, -0.62, BOARDS, LEAN);
  tree(m, 0.78, -1.62, 0.5);
  lamp(m, -0.97, -0.2, [-0.8, -0.2]);
});

// --- The tailor ---------------------------------------------------------------

const PLASTER: RGB = [0.94, 0.9, 0.8];
const BEAM: RGB = [0.42, 0.28, 0.19];
const BOARDROOF: Cover = { finish: "ribs", rgb: [0.56, 0.36, 0.24], ribs: 32 };
const RASPBERRY: RGB = [0.78, 0.3, 0.42];
/** Bolts of cloth: rose, teal, mustard, lilac, never loud. */
const CLOTH: RGB[] = [[0.82, 0.48, 0.55], [0.36, 0.6, 0.62], [0.88, 0.72, 0.36], [0.62, 0.52, 0.74]];

/** Half timbering on a wall from `a0` to `a1`: a sill beam, a beam at
 *  each floor, posts at `posts`, braces in each bay between `z0` and
 *  `z1`. */
function timbers(m: Model, wall: Wall, a0: number, a1: number, floors: number[], posts: number[], braces: [number, number, number, number][]) {
  put(m, "matte", Solid.union([
    ...floors.map((z) => plate(wall, a0 - 0.006, a1 + 0.006, z - 0.012, z + 0.006, 0, 0.008)),
    ...posts.map((a) => plate(wall, a - 0.008, a + 0.008, floors[0], floors[floors.length - 1], 0, 0.008)),
    ...braces.map(([p, q, z0, z1]) => hull([on(wall, p, z0, 0), on(wall, p, z0, 0.008), on(wall, q, z1, 0), on(wall, q, z1, 0.008)].flatMap(([x, y, z]): V[] => [[x - 0.007, y, z - 0.007], [x + 0.007, y, z + 0.007], [x, y - 0.007, z], [x, y + 0.007, z]]))),
  ]), BEAM);
}
export const TAILOR = model((m) => {
  // The house: two storeys, its eaves to the street, half-timbered.
  const [x0, x1, y0, y1, eave, ridge] = [-0.82, 0.1, -1.4, -0.6, 0.46, 0.7];
  put(m, "matte", barn("x", x0, x1, y0, y1, eave, ridge), PLASTER);
  put(m, "matte", box(x0 - 0.008, x1 + 0.008, y0 - 0.008, y1 + 0.008, 0, 0.03), STONE);
  pitched(m, "x", x0, x1, y0, y1, eave, ridge, BOARDROOF, { over: 0.035 });
  const front: Wall = { face: "+y", at: y1 };
  timbers(m, front, x0, x1, [0.03, 0.24, eave], [x0 + 0.01, -0.67, -0.04, x1 - 0.01], [[x0 + 0.01, -0.73, 0.24, 0.45], [x1 - 0.01, 0.02, 0.24, 0.45]]);
  timbers(m, { face: "-x", at: x0 }, y0, y1, [0.03, 0.24, eave], [y0 + 0.01, -1.0, y1 - 0.01], [[y0 + 0.01, -1.1, 0.24, 0.45], [y1 - 0.01, -0.9, 0.24, 0.45]]);
  // Down: the door, the shop window, its awning; the cloth before it.
  door(m, front, -0.74, [0.36, 0.42, 0.5], { w: 0.075, h: 0.16, frame: BEAM });
  const [w0, w1] = [-0.6, -0.1];
  put(m, "matte", plate(front, w0 - 0.012, w1 + 0.012, 0.035, 0.18, -0.004, 0.008).subtract(plate(front, w0, w1, 0.05, 0.17, -0.01, 0.02)), BEAM);
  put(m, "glass", plate(front, w0, w1, 0.05, 0.17, -0.004, 0.002), [0.3, 0.33, 0.38]);
  put(m, "matte", Solid.union([1, 2].map((k) => plate(front, w0 + ((w1 - w0) * k) / 3 - 0.004, w0 + ((w1 - w0) * k) / 3 + 0.004, 0.05, 0.17, -0.002, 0.006))), BEAM);
  awning(m, front, w0 - 0.03, w1 + 0.03, 0.2, [RASPBERRY, [0.97, 0.94, 0.9]], { depth: 0.06, drop: 0.035, stripes: 9, scallops: true });
  put(m, "matte", Solid.union([box(-0.5, -0.2, y1 + 0.015, y1 + 0.075, 0.06, 0.07), ...[-0.48, -0.22].map((x) => box(x - 0.006, x + 0.006, y1 + 0.02, y1 + 0.07, 0, 0.06))]), WOOD);
  CLOTH.forEach((rgb, k) => put(m, "matte", lying([-0.455 + (k % 2) * 0.07 + (k > 1 ? 0.15 : 0), y1 + 0.045, 0.092], 0.022, 0.065, "x", 12), rgb));
  // Up: two windows, the dormer in the roof.
  for (const x of [-0.56, -0.22]) window(m, front, x, 0.3, { w: 0.07, h: 0.08, frame: BEAM, bars: 1, box: [0.5, 0.34, 0.24] });
  dormer(m, { face: "+y", at: -0.78 }, -0.38, 0.58, PLASTER, BOARDROOF, { w: 0.06, h: 0.06, back: 0.12, frame: BEAM });
  chimney(m, -0.66, -1.12, 0.84, BRICK, { w: 0.07 });
  // The sign hung out from its corner: a board, the scissors on it.
  const [sx, sy] = [x0 - 0.08, y1 + 0.03];
  put(m, "matte", Solid.union([rod([x0, sy, 0.34], [sx - 0.05, sy, 0.34], 0.01), rod([x0, sy, 0.27], [x0 - 0.06, sy, 0.34], 0.007), ...[-0.035, 0.035].map((d) => box(sx + d - 0.002, sx + d + 0.002, sy - 0.002, sy + 0.002, 0.3, 0.34))]), IRON);
  put(m, "matte", box(sx - 0.05, sx + 0.05, sy - 0.006, sy + 0.006, 0.21, 0.3), BEAM);
  const face = sy + 0.009;
  put(m, "matte", Solid.union([
    rod([sx - 0.012, face, 0.235], [sx + 0.04, face, 0.28], 0.007), rod([sx - 0.012, face, 0.275], [sx + 0.04, face, 0.23], 0.007),
    ...[0.232, 0.278].map((z) => post(0, 0, -0.003, 0.006, 0.013, 10).subtract(post(0, 0, -0.01, 0.02, 0.006, 8)).rotate([90, 0, 0]).translate([sx - 0.025, face, z])),
  ]), [0.84, 0.85, 0.87]);
  // The wing the wool comes in at, its loading bay its door; bales by it.
  const [wx0, wx1, wy0, wy1] = [0.22, 0.84, -1.38, -0.72];
  put(m, "matte", barn("y", wx0, wx1, wy0, wy1, 0.24, 0.36), PLASTER);
  put(m, "matte", box(wx0 - 0.008, wx1 + 0.008, wy0 - 0.008, wy1 + 0.008, 0, 0.03), STONE);
  pitched(m, "y", wx0, wx1, wy0, wy1, 0.24, 0.36, BOARDROOF, { over: 0.03 });
  timbers(m, { face: "+y", at: wy1 }, wx0, wx1, [0.03, 0.24], [wx0 + 0.01, wx1 - 0.01], []);
  window(m, { face: "+x", at: wx1 }, -1.05, 0.11, { w: 0.08, h: 0.07, frame: BEAM });
  const bale = (x: number, y: number, z: number) => box(x - 0.04, x + 0.04, y - 0.03, y + 0.03, z, z + 0.05);
  put(m, "matte", Solid.union([bale(0.16, -0.66, 0), bale(0.16, -0.66, 0.05), bale(0.9, -0.95, 0)]), BALE);
  put(m, "matte", Solid.union([[0.16, -0.66, 0], [0.16, -0.66, 0.05], [0.9, -0.95, 0]].map(([x, y, z]) => box(x - 0.042, x + 0.042, y - 0.004, y + 0.004, z, z + 0.051))), [0.6, 0.48, 0.32]);
  // A tub of flowers at the house's corner, a shrub at the back.
  put(m, "matte", post(-0.92, -0.58, 0, 0.05, 0.05, 12), WOOD);
  flowers(m, -0.92, -0.58, 3, 0.045);
  shrub(m, -0.92, -1.3, 0.06);
  lamp(m, 0.98, -0.62, [0.9, -0.62]);
});

// --- The sheep farm ------------------------------------------------------------

const WOOL: RGB = [0.94, 0.92, 0.86];
const FACE: RGB = [0.24, 0.21, 0.2];
const FIELDSTONE: RGB = [0.68, 0.63, 0.55];
const RAIL: RGB = [0.55, 0.4, 0.27];

/** A sheep at (x, y), facing `a` degrees from +x: a fleece, its dark
 *  head and legs. */
function sheep(m: Model, x: number, y: number, a: number) {
  const place = (s: ReturnType<typeof box>) => s.scale([1.3, 1.3, 1.3]).rotate([0, 0, a]).translate([x, y, 0]);
  put(m, "matte", place(Solid.union([Solid.sphere(0.034, 10).scale([1.45, 1, 0.85]).translate([0, 0, 0.055]), Solid.sphere(0.026, 8).translate([-0.018, 0.008, 0.074]), Solid.sphere(0.024, 8).translate([0.02, -0.006, 0.072])])), WOOL);
  put(m, "matte", place(Solid.union([Solid.sphere(0.015, 8).scale([1.4, 1, 1]).translate([0.055, 0, 0.07]), ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([i, j]) => box(i * 0.025 - 0.004, i * 0.025 + 0.004, j * 0.014 - 0.004, j * 0.014 + 0.004, 0, 0.035))])), FACE);
}

export const SHEEP_FARM = model((m) => {
  // The paddock: grass, its rail fence round, the gate by the yard; the
  // sheep in it, their trough.
  const [px0, px1, py0, py1] = [-0.97, 0.16, -1.47, -0.53];
  ground(m, "lawn", [[px0, px1, py0, py1]], [0.42, 0.6, 0.32], { z: 0.012, round: 0.04 });
  fence(m, [[px1, py1 + 0.01], [px1, py0], [px0, py0], [px0, py1], [-0.22, py1]], RAIL);
  fence(m, [[0.0, py1], [px1, py1]], RAIL);
  gate(m, -0.22, py1, 0.2, 20, RAIL);
  [[-0.82, -0.68, 20], [-0.66, -0.8, 160], [-0.5, -0.66, 80], [-0.3, -0.88, 200], [-0.12, -0.7, 300], [0.02, -0.92, 110], [-0.42, -1.0, 30]].forEach(([x, y, a]) => sheep(m, x, y, a));
  put(m, "matte", box(-0.82, -0.62, -1.06, -1.0, 0.012, 0.05).subtract(box(-0.81, -0.63, -1.05, -1.01, 0.03, 0.06)), WOOD);
  put(m, "glass", box(-0.81, -0.63, -1.05, -1.01, 0.03, 0.044), [0.42, 0.56, 0.66]);
  // Their barn at the back of it: fieldstone, open to the paddock on
  // timber posts, its slate roof; bales in its shade.
  const [bx0, bx1, by0, by1] = [-0.94, -0.14, -1.44, -1.14];
  put(m, "matte", Solid.union([box(bx0, bx1, by0, by0 + 0.05, 0, 0.18), barn("x", bx0, bx0 + 0.05, by0, by1, 0.18, 0.3), barn("x", bx1 - 0.05, bx1, by0, by1, 0.18, 0.3)]), FIELDSTONE);
  put(m, "matte", Solid.union([-0.66, -0.42].map((x) => box(x - 0.014, x + 0.014, by1 - 0.028, by1, 0, 0.18)).concat([box(bx0, bx1, by1 - 0.028, by1, 0.16, 0.185)])), WOOD);
  pitched(m, "x", bx0, bx1, by0, by1, 0.18, 0.3, SLATE, { over: 0.035 });
  const bale = (x: number, y: number, z: number) => box(x - 0.04, x + 0.04, y - 0.03, y + 0.03, z, z + 0.05);
  put(m, "matte", Solid.union([bale(-0.82, -1.33, 0), bale(-0.73, -1.33, 0), bale(-0.78, -1.33, 0.05), bale(-0.46, -1.09, 0), bale(-0.37, -1.09, 0), bale(-0.415, -1.09, 0.05)]), BALE);
  // The wool shed, its door the loading bay: fieldstone, slate, gable to
  // the street; its lean-to of bales on the far side.
  const [sx0, sx1, sy0, sy1] = [0.27, 0.78, -1.3, -0.72];
  put(m, "matte", barn("y", sx0, sx1, sy0, sy1, 0.22, 0.36), FIELDSTONE);
  pitched(m, "y", sx0, sx1, sy0, sy1, 0.22, 0.36, SLATE, { over: 0.03 });
  put(m, "matte", Solid.union([sx0 - 0.03, sx1 + 0.03].map((x) => rod([x, sy1 + 0.035, 0.205], [(sx0 + sx1) / 2, sy1 + 0.035, 0.37], 0.02))), WOOD);
  put(m, "matte", Solid.union([sx0, sx1].map((x) => box(x - 0.012, x + 0.012, sy1 - 0.012, sy1 + 0.008, 0, 0.22))), STONE);
  window(m, { face: "-x", at: sx0 }, -1.0, 0.1, { w: 0.07, h: 0.06, frame: CREAM });
  leanTo(m, { face: "+x", at: sx1 }, sy0, sy1 - 0.04, 0.2, 0.18, 0.05, SLATE);
  put(m, "matte", Solid.union([-1.26, -0.8].map((y) => box(0.94, 0.958, y - 0.009, y + 0.009, 0, 0.15))), WOOD);
  put(m, "matte", Solid.union([bale(0.86, -1.2, 0), bale(0.86, -1.12, 0), bale(0.86, -1.04, 0), bale(0.86, -0.96, 0), bale(0.86, -1.16, 0.05), bale(0.86, -1.08, 0.05), bale(0.86, -0.92, 0.05)]), BALE);
  put(m, "matte", Solid.union([[-1.2, 0], [-1.12, 0], [-1.04, 0], [-0.96, 0], [-1.16, 0.05], [-1.08, 0.05], [-0.92, 0.05]].map(([y, z]) => box(0.856, 0.864, y - 0.031, y + 0.031, z, z + 0.051))), [0.6, 0.48, 0.32]);
  tree(m, 0.9, -1.42, 0.5);
  shrub(m, 0.22, -1.42, 0.05);
  lamp(m, 0.97, -0.6, [0.88, -0.6]);
});

// --- The bakery ---------------------------------------------------------------

export const BAKERY = model((m) => {
  // The bakehouse: brick, a tiled roof, gable to the street; its oven's
  // chimney at the back smoking; the shop window under a striped awning.
  const [x0, x1, y0, y1, eave, ridge] = [-0.92, 0.14, -1.42, -0.58, 0.3, 0.5];
  put(m, "matte", barn("x", x0, x1, y0, y1, eave, ridge), BRICK);
  put(m, "matte", box(x0 - 0.008, x1 + 0.008, y0 - 0.008, y1 + 0.008, 0, 0.03), [0.74, 0.7, 0.63]);
  pitched(m, "x", x0, x1, y0, y1, eave, ridge, TERRACOTTA, { over: 0.03 });
  const front: Wall = { face: "+y", at: y1 };
  door(m, front, -0.02, [0.3, 0.45, 0.36], { w: 0.08, h: 0.18, arch: true });
  put(m, "glass", plate(front, -0.8, -0.14, 0.05, 0.19, -0.004, 0.002), PANE);
  put(m, "matte", plate(front, -0.82, -0.12, 0.035, 0.05, -0.004, 0.012), CREAM);
  // Loaves behind the glass.
  for (let k = 0; k < 5; k++) put(m, "matte", plate(front, -0.77 + k * 0.125, -0.68 + k * 0.125, 0.06, 0.09, -0.04, -0.008), [0.82, 0.55, 0.28]);
  awning(m, front, -0.85, -0.09, 0.24, [[0.82, 0.5, 0.22], [0.97, 0.95, 0.9]], { depth: 0.12, drop: 0.05, stripes: 7, scallops: true });
  for (const x of [-0.6, -0.2]) window(m, front, x, 0.36, { w: 0.08, h: 0.07, box: [0.42, 0.3, 0.22] });
  chimney(m, -0.7, -1.25, 0.7, BRICK, { w: 0.1 });
  // The flour store at the gate's side, the loading bay to it.
  put(m, "matte", barn("y", 0.22, 0.9, -1.4, -0.75, 0.22, 0.34), CREAM);
  pitched(m, "y", 0.22, 0.9, -1.4, -0.75, 0.22, 0.34, SLATE_BLUE, { over: 0.02 });
  lamp(m, 0.95, -0.55, [0.85, -0.55]);
});
