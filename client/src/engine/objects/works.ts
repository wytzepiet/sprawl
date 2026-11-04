import type { RGB } from "../rgb";
import { Solid } from "../solid";
import { awning, barn, box, chimney, door, ground, heap, hull, lamp, model, pitched, plate, post, put, rod, window, PANE, type Cover, type Model, type V, type Wall } from "./kit";

/**
 * The works of the heavy chains, whole, each on its plot, made by hand
 * from the kit (no reference image yet: these are v1's, to be redone as
 * the sawmill was). The plot's middle on the origin, the street at +y,
 * the yard the front half (`lots.rs`), the lorries' and its pad's; what
 * stands is the back half's. Ground on z = 0.
 *
 * - The ore mine and the coal mine: a headframe over the shaft, its
 *   sheave wheel at the top, the winding house beside it, a heap of what
 *   it brings up. Rust and ore at one, black and coal at the other.
 * - The cement works: a long kiln lying on its piers, two silos, a shed.
 * - The steelworks: the blast furnace, its stoves, a hall, two stacks.
 * - The machine works: a long hall under saw teeth, its big door, a water
 *   tower.
 * - The oil well: a pumpjack on its pad, a tank.
 * - The refinery: two columns, tanks, the pipes between, a flare.
 * - The bakery: a brick bakehouse, its oven's chimney smoking, a striped
 *   awning over its window.
 */

const STEEL: RGB = [0.48, 0.5, 0.54];
const DARK: RGB = [0.25, 0.26, 0.28];
const BRICK: RGB = [0.66, 0.34, 0.26];
const CONCRETE: RGB = [0.76, 0.74, 0.7];
const DUST: RGB = [0.8, 0.76, 0.68];
const CREAM: RGB = [0.93, 0.89, 0.8];
const ZINC: Cover = { finish: "zinc", rgb: [0.66, 0.7, 0.76] };
const SLATE: Cover = { finish: "tiles", rgb: [0.36, 0.4, 0.5] };
const TILES: Cover = { finish: "tiles", rgb: [0.7, 0.36, 0.26] };
const RIBBED = (rgb: RGB): Cover => ({ finish: "ribs", rgb, ribs: 30 });

/** Four legs tapering from `foot` apart at the ground to `top` apart at
 *  `h`, braced. */
function tower(m: Model, x: number, y: number, foot: number, top: number, h: number, rgb: RGB) {
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => rod([x + sx * foot, y + sy * foot, 0], [x + sx * top, y + sy * top, h], 0.022));
  const at = (f: number, s: number) => foot + (top - foot) * f + 0 * s;
  const braces = [0.2, 0.55].flatMap((f) => [-1, 1].flatMap((s) => [
    rod([x - at(f, 0), y + s * at(f, 0), f * h], [x + at(f + 0.3, 0), y + s * at(f + 0.3, 0), (f + 0.3) * h], 0.012),
    rod([x + s * at(f, 0), y - at(f, 0), f * h], [x + s * at(f + 0.3, 0), y + at(f + 0.3, 0), (f + 0.3) * h], 0.012),
  ]));
  put(m, "matte", Solid.union([...legs, ...braces, box(x - top - 0.02, x + top + 0.02, y - top - 0.02, y + top + 0.02, h - 0.02, h)]), rgb);
}

/** A wheel standing on edge, across x, its middle at (x, y, z). */
const wheel = (x: number, y: number, z: number, r: number) =>
  Solid.cylinder(0.014, r, r, 20).subtract(Solid.cylinder(0.02, r * 0.8, r * 0.8, 20).translate([0, 0, -0.003])).rotate([90, 0, 0]).translate([x, y + 0.007, z]);

/** A pithead: the headframe over the shaft at the back, its wheel on top
 *  and the rope down to the winding house; the house, its roof; the
 *  heap of what comes up by the yard; the ground dust. */
function pithead(m: Model, frame: RGB, house: RGB, roof: Cover, spoil: RGB) {
  ground(m, "dust", [[-0.96, 0.96, -1.96, -0.04]], DUST, { z: 0.018, round: 0.03 });
  const [fx, fy] = [-0.42, -1.3];
  put(m, "matte", box(fx - 0.2, fx + 0.2, fy - 0.2, fy + 0.2, 0, 0.04), CONCRETE);
  tower(m, fx, fy, 0.17, 0.07, 0.72, frame);
  put(m, "matte", wheel(fx, fy, 0.78, 0.09), frame);
  put(m, "matte", post(fx, fy, 0.72, 0.03, 0.015, 8), DARK);
  // The rope, from the wheel down to the winding house's drum.
  put(m, "matte", rod([fx + 0.08, fy, 0.8], [0.32, -1.3, 0.24], 0.006), DARK);
  // The winding house, brick, its roof, its windows, a door to the yard.
  const [x0, x1, y0, y1] = [0.16, 0.84, -1.62, -0.98];
  put(m, "matte", barn("y", x0, x1, y0, y1, 0.24, 0.38), house);
  pitched(m, "y", x0, x1, y0, y1, 0.24, 0.38, roof, { over: 0.03 });
  const front: Wall = { face: "+y", at: y1 };
  door(m, front, 0.5, DARK, { w: 0.09, h: 0.15 });
  for (const s of [-1, 1]) window(m, front, 0.5 + s * 0.2, 0.12, { w: 0.08, h: 0.08 });
  for (const y of [-1.45, -1.15]) window(m, { face: "-x", at: x0 }, y, 0.12, { w: 0.08, h: 0.08 });
  chimney(m, 0.74, -1.5, 0.52, BRICK, { w: 0.07, smoke: 0.08 });
  // What comes up, heaped by the yard, a skip on rails to it.
  heap(m, "gravel", -0.55, -0.45, 0.32, 0.18, 0.018, 3, spoil);
  put(m, "matte", Solid.union([-0.04, 0.04].map((d) => box(-0.43 + d - 0.006, -0.43 + d + 0.006, -1.08, -0.62, 0.018, 0.026))), STEEL);
  put(m, "matte", box(-0.48, -0.38, -0.95, -0.85, 0.026, 0.08).subtract(box(-0.47, -0.39, -0.94, -0.86, 0.04, 0.09)), frame);
  lamp(m, 0.92, -0.9, [0.6, -0.9]);
}

export const MINE = model((m) => pithead(m, [0.56, 0.24, 0.16], BRICK, SLATE, [0.6, 0.33, 0.22]));
export const COLLIERY = model((m) => pithead(m, [0.2, 0.22, 0.26], [0.42, 0.4, 0.4], RIBBED([0.62, 0.3, 0.22]), [0.16, 0.16, 0.18]));

/** A silo, `r` round and `h` high, a cone over it. */
function silo(m: Model, x: number, y: number, r: number, h: number, rgb: RGB) {
  put(m, "matte", Solid.cylinder(h, r, r, 20).translate([x, y, 0]), rgb);
  put(m, "matte", Solid.cylinder(0.06, r + 0.01, 0.02, 20).translate([x, y, h]), STEEL);
  put(m, "matte", Solid.union([0.25, 0.5, 0.75].map((f) => post(x, y, h * f, 0.01, r + 0.005, 20))), [rgb[0] * 0.85, rgb[1] * 0.85, rgb[2] * 0.85]);
}

export const CEMENT = model((m) => {
  ground(m, "dust", [[-0.96, 0.96, -1.96, -0.04]], [0.84, 0.83, 0.8], { z: 0.018, round: 0.03 });
  // The kiln: a long drum, sloping a little, on three concrete piers.
  const kiln = (r: number) => hull([[-0.85, -1.72, 0.2], [0.7, -1.72, 0.14]].flatMap(([x, y, z]) => Array.from({ length: 16 }, (_, k): V => [x, y + Math.cos((k / 16) * 2 * Math.PI) * r, z + r + Math.sin((k / 16) * 2 * Math.PI) * r])));
  put(m, "matte", kiln(0.09), [0.62, 0.42, 0.3]);
  for (const x of [-0.7, -0.15, 0.4]) put(m, "matte", box(x - 0.04, x + 0.04, -1.8, -1.64, 0, 0.2), CONCRETE);
  // Its stack at the hot end, smoking.
  chimney(m, -0.86, -1.42, 0.82, CONCRETE, { w: 0.09, smoke: 0.14 });
  // Two silos and a shed under them.
  silo(m, 0.25, -1.08, 0.17, 0.62, [0.86, 0.85, 0.82]);
  silo(m, 0.68, -1.08, 0.17, 0.62, [0.86, 0.85, 0.82]);
  put(m, "matte", barn("x", -0.7, -0.08, -1.32, -0.6, 0.2, 0.3), [0.72, 0.74, 0.76]);
  pitched(m, "x", -0.7, -0.08, -1.32, -0.6, 0.2, 0.3, ZINC, { over: 0.025 });
  door(m, { face: "+y", at: -0.6 }, -0.39, DARK, { w: 0.16, h: 0.16 });
  window(m, { face: "+y", at: -0.6 }, -0.6, 0.12, { w: 0.07, h: 0.05 });
  put(m, "matte", rod([0.25, -0.9, 0.5], [0.0, -0.75, 0.28], 0.03).add(rod([0.68, -0.9, 0.5], [0.25, -0.9, 0.5], 0.03)), STEEL);
  lamp(m, 0.9, -0.5, [0.6, -0.5]);
});

/** A hall along x under saw teeth, each a slope up from the back to a
 *  glazed face to the front, `teeth` of them. */
function sawtoothHall(m: Model, x0: number, x1: number, y0: number, y1: number, eave: number, rise: number, teeth: number, wall: RGB, roof: RGB) {
  put(m, "matte", box(x0, x1, y0, y1, 0, eave), wall);
  const span = (y1 - y0) / teeth;
  for (let k = 0; k < teeth; k++) {
    const [a, b] = [y0 + k * span, y0 + (k + 1) * span];
    put(m, "matte", hull([[x0, a, eave], [x1, a, eave], [x0, b - 0.02, eave + rise], [x1, b - 0.02, eave + rise], [x0, b, eave], [x1, b, eave], [x0, b, eave + rise], [x1, b, eave + rise]].map(([x, y, z]): V => [x, y, z]).filter((_, i) => i !== 6 && i !== 7)), roof);
    put(m, "glass", box(x0 + 0.02, x1 - 0.02, b - 0.012, b - 0.004, eave + 0.01, eave + rise - 0.015), PANE);
  }
}

export const STEELWORKS = model((m) => {
  ground(m, "dust", [[-1.46, 1.46, -1.96, -0.04]], [0.62, 0.6, 0.58], { z: 0.018, round: 0.03 });
  // The blast furnace: a tapering stack on a base, a ring round its belly, its top hat and downcomer.
  const [bx, by] = [-0.85, -1.3];
  put(m, "matte", box(bx - 0.26, bx + 0.26, by - 0.26, by + 0.26, 0, 0.12), CONCRETE);
  put(m, "matte", Solid.cylinder(0.3, 0.2, 0.22, 20).translate([bx, by, 0.12]).add(Solid.cylinder(0.42, 0.22, 0.12, 20).translate([bx, by, 0.42])), [0.36, 0.34, 0.33]);
  put(m, "matte", post(bx, by, 0.4, 0.04, 0.235, 20), [0.6, 0.3, 0.2]);
  put(m, "matte", Solid.cylinder(0.12, 0.08, 0.05, 16).translate([bx, by, 0.84]), DARK);
  put(m, "matte", rod([bx + 0.05, by, 0.92], [bx + 0.45, by - 0.25, 0.7], 0.05).add(rod([bx + 0.45, by - 0.25, 0.7], [bx + 0.45, by - 0.25, 0.1], 0.05)), DARK);
  // Its stoves: three round towers behind, domed.
  for (const k of [0, 1, 2]) {
    const [x, y] = [bx + 0.45 + k * 0.24, by - 0.45];
    put(m, "matte", Solid.cylinder(0.58, 0.1, 0.1, 18).translate([x, y, 0]).add(Solid.sphere(0.1, 18).translate([x, y, 0.58])), [0.7, 0.68, 0.66]);
  }
  // The casting hall, long, its ribbed roof, a glow in its door.
  const [x0, x1, y0, y1] = [-0.2, 1.4, -1.25, -0.25];
  put(m, "matte", barn("x", x0, x1, y0, y1, 0.32, 0.5), [0.5, 0.36, 0.3]);
  pitched(m, "x", x0, x1, y0, y1, 0.32, 0.5, RIBBED([0.38, 0.4, 0.44]), { over: 0.03 });
  const front: Wall = { face: "+y", at: y1 };
  put(m, "glass", plate(front, 0.25, 0.55, 0, 0.22, -0.005, 0.002), [1.0, 0.55, 0.2]);
  put(m, "matte", plate(front, 0.23, 0.57, 0.22, 0.24, 0, 0.012), DARK);
  for (const x of [0.75, 0.95, 1.15]) window(m, front, x, 0.18, { w: 0.1, h: 0.08 });
  // Two stacks, tall, smoking.
  for (const [x, y] of [[1.05, -1.6], [1.3, -1.6]]) {
    put(m, "matte", Solid.cylinder(1.05, 0.06, 0.045, 14).translate([x, y, 0]), BRICK);
    put(m, "matte", Solid.union([0.9, 0.98].map((z) => post(x, y, z, 0.03, 0.055, 14))), [0.92, 0.9, 0.86]);
    m.props.push({ kind: "smoke", at: [x, y, 1.05], size: 0.18, high: 0 });
  }
  lamp(m, -1.4, -0.3, [-1.1, -0.3]);
});

export const MACHINE = model((m) => {
  ground(m, "paving", [[-1.46, 1.46, -1.96, -0.04]], [0.72, 0.71, 0.68], { z: 0.018, round: 0.03 });
  sawtoothHall(m, -1.35, 0.95, -1.85, -0.3, 0.3, 0.16, 4, [0.36, 0.5, 0.66], [0.6, 0.62, 0.66]);
  const front: Wall = { face: "+y", at: -0.3 };
  // The big door, its frame; the office windows along the rest.
  put(m, "matte", plate(front, -0.25, 0.35, 0, 0.26, -0.004, 0.003), [0.86, 0.6, 0.2]);
  put(m, "matte", Solid.union([0.05, 0.11, 0.17, 0.23].map((z) => plate(front, -0.24, 0.34, z, z + 0.008, 0, 0.006))), [0.7, 0.48, 0.14]);
  for (const x of [-1.15, -0.9, -0.6, 0.55, 0.8]) window(m, front, x, 0.15, { w: 0.14, h: 0.08, bars: 2 });
  put(m, "matte", plate(front, -1.35, 0.95, 0.26, 0.3, 0, 0.01), [0.95, 0.94, 0.9]);
  // The water tower on its legs, the gate's side.
  const [tx, ty] = [1.2, -1.45];
  tower(m, tx, ty, 0.14, 0.11, 0.5, STEEL);
  put(m, "matte", Solid.cylinder(0.2, 0.15, 0.15, 18).translate([tx, ty, 0.5]).add(Solid.cylinder(0.08, 0.16, 0.02, 18).translate([tx, ty, 0.7])), [0.36, 0.5, 0.66]);
  // A crate or two of machines by the door.
  for (const [x, y] of [[0.55, -0.15], [0.7, -0.15]]) put(m, "matte", box(x - 0.06, x + 0.06, y - 0.06, y + 0.06, 0.018, 0.12), [0.72, 0.58, 0.4]);
  lamp(m, -1.4, -0.2, [-1.1, -0.2]);
});

export const WELL = model((m) => {
  ground(m, "earth", [[-0.96, 0.96, -1.96, -0.04]], [0.55, 0.47, 0.38], { z: 0.018, round: 0.05 });
  // The pad, the pumpjack on it: the samson post, the walking beam, the
  // horse's head over the well, the crank and its weight at the back.
  put(m, "matte", box(-0.6, 0.6, -1.5, -0.9, 0.018, 0.05), CONCRETE);
  const [h, x0, x1] = [0.42, -0.5, 0.45];
  put(m, "matte", Solid.union([-1, 1].flatMap((s) => [rod([-0.08, -1.2 + s * 0.1, 0.05], [0, -1.2, h], 0.03), rod([0.08, -1.2 + s * 0.1, 0.05], [0, -1.2, h], 0.03)])), [0.24, 0.3, 0.42]);
  put(m, "matte", box(x0, x1, -1.23, -1.17, h - 0.02, h + 0.04), [0.24, 0.3, 0.42]);
  put(m, "matte", hull([[x1, -1.24, h + 0.06], [x1, -1.16, h + 0.06], [x1 + 0.12, -1.24, h + 0.02], [x1 + 0.12, -1.16, h + 0.02], [x1 + 0.1, -1.24, h - 0.16], [x1 + 0.1, -1.16, h - 0.16]]), [0.85, 0.7, 0.22]);
  put(m, "matte", rod([x1 + 0.1, -1.2, h - 0.16], [x1 + 0.1, -1.2, 0.08], 0.008), DARK);
  put(m, "matte", box(x1 + 0.05, x1 + 0.15, -1.25, -1.15, 0.05, 0.1), STEEL);
  put(m, "matte", rod([x0 + 0.05, -1.2, h], [x0 + 0.05, -1.2, 0.2], 0.03), [0.24, 0.3, 0.42]);
  put(m, "matte", box(x0 - 0.06, x0 + 0.1, -1.3, -1.1, 0.1, 0.22), [0.85, 0.7, 0.22]);
  put(m, "matte", box(x0 - 0.04, x0 + 0.14, -1.28, -1.12, 0.05, 0.1), DARK);
  // The tank, the pipe to it.
  put(m, "matte", Solid.cylinder(0.24, 0.16, 0.16, 20).translate([0.55, -0.55, 0.018]).add(Solid.cylinder(0.04, 0.165, 0.02, 20).translate([0.55, -0.55, 0.258])), [0.86, 0.85, 0.8]);
  put(m, "matte", rod([0.55, -1.1, 0.06], [0.55, -0.7, 0.06], 0.02), DARK);
  lamp(m, -0.9, -0.5, [-0.6, -0.5]);
});

export const REFINERY = model((m) => {
  ground(m, "paving", [[-1.46, 1.46, -1.96, -0.04]], [0.7, 0.69, 0.66], { z: 0.018, round: 0.03 });
  // Two columns, ringed with walkways, a ladder up each.
  for (const [x, y, r, h] of [[-1.0, -1.5, 0.11, 1.0], [-0.65, -1.55, 0.08, 0.8]]) {
    put(m, "matte", Solid.cylinder(h, r, r, 18).translate([x, y, 0]).add(Solid.sphere(r, 18).translate([x, y, h])), [0.88, 0.87, 0.84]);
    put(m, "matte", Solid.union([0.3, 0.55, 0.8].filter((f) => f * 1.0 < h).map((z) => post(x, y, z, 0.015, r + 0.04, 18).subtract(post(x, y, z - 0.01, 0.04, r + 0.01, 18)))), [0.85, 0.6, 0.2]);
  }
  // Tanks: three, round, pale, a dark band round their tops.
  for (const [x, y, r] of [[0.15, -1.45, 0.26], [0.85, -1.45, 0.26], [0.5, -0.75, 0.2]]) {
    put(m, "matte", Solid.cylinder(0.3, r, r, 24).translate([x, y, 0.018]).add(Solid.cylinder(0.05, r + 0.005, r * 0.3, 24).translate([x, y, 0.318])), [0.9, 0.89, 0.86]);
    put(m, "matte", post(x, y, 0.27, 0.03, r + 0.006, 24), [0.48, 0.32, 0.56]);
  }
  // The pipes between, on a rack.
  put(m, "matte", Solid.union([
    rod([-1.0, -1.3, 0.25], [0.85, -1.15, 0.25], 0.025),
    rod([-0.65, -1.4, 0.18], [0.5, -0.95, 0.18], 0.02),
    ...[-0.6, -0.1, 0.4].map((x) => box(x - 0.012, x + 0.012, -1.32, -1.28, 0, 0.25)),
  ]), STEEL);
  // The flare stack, a flame at its top in the night.
  put(m, "matte", Solid.cylinder(1.15, 0.025, 0.02, 10).translate([1.3, -1.8, 0]), [0.8, 0.3, 0.22]);
  put(m, "glass", Solid.sphere(0.035, 10).translate([1.3, -1.8, 1.18]), [1.0, 0.6, 0.2]);
  // The control house.
  put(m, "matte", barn("x", -1.35, -0.85, -1.05, -0.6, 0.16, 0.2), CREAM);
  pitched(m, "x", -1.35, -0.85, -1.05, -0.6, 0.16, 0.2, ZINC, { over: 0.02 });
  door(m, { face: "+y", at: -0.6 }, -1.2, DARK, { w: 0.06, h: 0.12 });
  window(m, { face: "+y", at: -0.6 }, -1.0, 0.08, { w: 0.1, h: 0.05 });
  lamp(m, 1.4, -0.3, [1.1, -0.3]);
});

export const BAKERY = model((m) => {
  // The bakehouse: brick, a tiled roof, gable to the street; its oven's
  // chimney at the back smoking; the shop window under a striped awning.
  const [x0, x1, y0, y1, eave, ridge] = [-0.9, 0.55, -1.42, -0.58, 0.3, 0.52];
  put(m, "matte", barn("x", x0, x1, y0, y1, eave, ridge), BRICK);
  put(m, "matte", box(x0 - 0.008, x1 + 0.008, y0 - 0.008, y1 + 0.008, 0, 0.03), [0.74, 0.7, 0.63]);
  pitched(m, "x", x0, x1, y0, y1, eave, ridge, TILES, { over: 0.03 });
  const front: Wall = { face: "+y", at: y1 };
  door(m, front, 0.35, [0.3, 0.45, 0.36], { w: 0.08, h: 0.18, arch: true });
  put(m, "glass", plate(front, -0.75, 0.15, 0.05, 0.19, -0.004, 0.002), PANE);
  put(m, "matte", plate(front, -0.77, 0.17, 0.035, 0.05, -0.004, 0.012), CREAM);
  // Loaves behind the glass.
  for (let k = 0; k < 6; k++) put(m, "matte", plate(front, -0.72 + k * 0.14, -0.62 + k * 0.14, 0.06, 0.09, -0.04, -0.008), [0.82, 0.55, 0.28]);
  awning(m, front, -0.8, 0.2, 0.24, [[0.82, 0.5, 0.22], [0.97, 0.95, 0.9]], { depth: 0.12, drop: 0.05, stripes: 9, scallops: true });
  for (const x of [-0.5, 0.1]) window(m, front, x, 0.36, { w: 0.08, h: 0.07, box: [0.42, 0.3, 0.22] });
  chimney(m, -0.7, -1.25, 0.72, BRICK, { w: 0.1, smoke: 0.12 });
  // The flour store at the gate's side, its door to the yard.
  put(m, "matte", barn("y", 0.6, 0.92, -1.4, -0.75, 0.2, 0.3), CREAM);
  pitched(m, "y", 0.6, 0.92, -1.4, -0.75, 0.2, 0.3, SLATE, { over: 0.02 });
  door(m, { face: "+y", at: -0.75 }, 0.76, [0.55, 0.38, 0.25], { w: 0.12, h: 0.15 });
  lamp(m, 0.95, -0.55, [0.7, -0.55]);
});
