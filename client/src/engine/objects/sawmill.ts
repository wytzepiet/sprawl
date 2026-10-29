import { BARK_ALONG } from "../bark";
import type { MeshGeometry } from "../geometry";
import type { RGB } from "../rgb";
import { Solid } from "../solid";
import { add, barn, box, chimney, fence, gablet, golf, ground, heap, hull, lamp, model, pitched, plate, post, put, rod, scale, window, type Cover, type Model, type V, type Wall } from "./kit";

/**
 * A sawmill, whole (`refresh/refs/sawmill-gpt.png`): the hall, its wing,
 * its yard and all that stands in it, one model on its plot. Its plot two
 * tiles across (x, -1 to 1) and four deep (y), the street at +y, the woods
 * behind at -y; its ground on z = 0.
 *
 * - Painted timber, green, its corners and gables picked out in cream,
 *   under roofs of brown boards.
 * - At the back, the long hall: its ridge along the street, four small
 *   gables along its back, a window in each; its big door to the yard,
 *   braced, a lamp over it and a dormer above, where the logs go in.
 * - Down the right, the wing, in two: its tall back, its lower front, its
 *   gable to the lane and the barn door the bundles come out of
 *   (`BARN_DOOR`), a lamp over it; a zinc lean-to down its side; the brick
 *   chimney behind, smoking through the shift.
 * - The yard's left half is wood chips: the water tower at the back, the
 *   conveyor up into the hall with logs on it, sawdust heaped, a stack of
 *   sawn planks, logs racked between posts; a fence along the side.
 * - Its right half the lorries': the lane up to the wing's door, the
 *   bundles on their pad beside it (`pads.ts`), and across it the one
 *   dock (`Blueprint::docks`).
 */

const WALL: RGB = [0.33, 0.52, 0.42];
const TRIM: RGB = [0.93, 0.88, 0.76];
const ROOF: Cover = { finish: "ribs", rgb: [0.62, 0.37, 0.25], ribs: 34 };
const DOOR: RGB = [0.6, 0.45, 0.3];
const BRICK: RGB = [0.66, 0.32, 0.24];
const CHIPS: RGB = [0.86, 0.66, 0.4];
const SAWDUST: RGB = [0.74, 0.56, 0.36];
const BARKED: RGB = [0.56, 0.39, 0.24];
const END: RGB = [0.89, 0.76, 0.56];
const PLANK: RGB = [0.86, 0.7, 0.48];
const STEEL: RGB = [0.46, 0.48, 0.52];
const BELT: RGB = [0.27, 0.27, 0.28];
const TIMBER: RGB = [0.52, 0.37, 0.25];
const HOOP: RGB = [0.32, 0.33, 0.36];
const ZINC: RGB = [0.66, 0.7, 0.76];

/** Round a log: this many sides, smooth, its bark's map once round. */
const SIDES = 12;
let logs = 0;
/** A log `r` round and `l` long, its middle at `at`, lying along x or y:
 *  its bark, closed at its ends, and its ends' pale wood. */
function log(m: Model, at: V, r: number, l: number, along: "x" | "y") {
  // Along, and the two ways round it, right-handed.
  const [a, s, z]: V[] = along === "x" ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : [[0, 1, 0], [-1, 0, 0], [0, 0, 1]];
  const round = (k: number): V => add(scale(s, Math.cos((2 * Math.PI * k) / SIDES)), scale(z, Math.sin((2 * Math.PI * k) / SIDES)));
  const from = (logs++ * 0.37) % 1;
  const bark: MeshGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  for (let k = 0; k <= SIDES; k++)
    for (const e of [-1, 1]) {
      bark.positions.push(...add(add(at, scale(a, (e * l) / 2)), scale(round(k), r)));
      bark.normals.push(...round(k));
      bark.uvs!.push(k / SIDES, from + ((e + 1) * l) / 2 / BARK_ALONG);
    }
  for (let k = 0; k < SIDES; k++) bark.indices.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2);
  const ends: MeshGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  const cap = (into: MeshGeometry, e: number, rr: number, out: number) => {
    const base = into.positions.length / 3;
    const mid = add(at, scale(a, e * (l / 2 + out)));
    for (const p of [mid, ...Array.from({ length: SIDES }, (_, k) => add(mid, scale(round(k), rr)))]) into.positions.push(...p), into.normals.push(...scale(a, e)), into.uvs!.push(0, 0);
    for (let k = 0; k < SIDES; k++) {
      const [p, q] = [base + 1 + k, base + 1 + ((k + 1) % SIDES)];
      into.indices.push(...(e > 0 ? [base, q, p] : [base, p, q]));
    }
  };
  for (const e of [-1, 1]) cap(bark, e, r, 0), cap(ends, e, r * 0.84, 0.002);
  put(m, "bark", bark, BARKED);
  put(m, "matte", ends, END);
}
/** Logs racked between posts, layers of them along x or y, its middle at
 *  (x, y), `n` across and `layers` high. */
function rack(m: Model, x: number, y: number, along: "x" | "y", l: number, n: number, layers: number, r = 0.034) {
  for (let layer = 0; layer < layers; layer++)
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 2 * r + (layer % 2 ? r * 0.3 : 0);
      log(m, along === "x" ? [x, y + off, r + layer * r * 1.8] : [x + off, y, r + layer * r * 1.8], r, l, along);
    }
  const [span, h] = [n * r + 0.015, layers * r * 1.8 + 0.03];
  for (const e of [-1, 1]) for (const s of [-1, 1]) {
    const [px, py] = along === "x" ? [x + e * (l / 2 - 0.05), y + s * span] : [x + s * span, y + e * (l / 2 - 0.05)];
    put(m, "matte", box(px - 0.012, px + 0.012, py - 0.012, py + 0.012, 0, h), TIMBER);
  }
}

/** A braced barn door on a wall, `at` along it, `w` across, `h` high:
 *  two leaves, framed and crossed in cream. */
function barnDoor(m: Model, wall: Wall, at: number, w: number, h: number) {
  put(m, "matte", plate(wall, at - w / 2, at + w / 2, 0, h, -0.002, 0.006), DOOR);
  const t = 0.014;
  const bars = [plate(wall, at - w / 2 - t, at + w / 2 + t, h, h + t, 0, 0.012), plate(wall, at - w / 2 - t, at - w / 2, 0, h, 0, 0.012), plate(wall, at + w / 2, at + w / 2 + t, 0, h, 0, 0.012), plate(wall, at - 0.004, at + 0.004, 0, h, 0, 0.012), plate(wall, at - w / 2, at + w / 2, h / 2 - 0.006, h / 2 + 0.006, 0, 0.012)];
  for (const s of [-1, 1]) {
    const [a0, a1] = [at, at + (s * w) / 2];
    const p = (along: number, up: number) => (wall.face[1] === "y" ? [along, wall.at + (wall.face[0] === "+" ? 0.009 : -0.009), up] : [wall.at + (wall.face[0] === "+" ? 0.009 : -0.009), along, up]) as V;
    bars.push(rod(p(a0, 0.01), p(a1, h / 2 - 0.01), 0.012), rod(p(a0, h / 2 + 0.01), p(a1, h - 0.01), 0.012));
  }
  put(m, "matte", Solid.union(bars), TRIM);
}
/** Cream boards up a body's corners and along its gable's edges. */
function trimmed(m: Model, along: "x" | "y", x0: number, x1: number, y0: number, y1: number, eave: number, ridge: number, ends: ("+" | "-")[]) {
  const pieces = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => box(x - 0.01, x + 0.01, y - 0.01, y + 0.01, 0, eave));
  for (const e of ends) {
    if (along === "y") {
      const y = (e === "+" ? y1 : y0) + (e === "+" ? 0.004 : -0.004), mid = (x0 + x1) / 2;
      pieces.push(rod([x0 - 0.04, y, eave - 0.03], [mid, y, ridge + 0.01], 0.02), rod([x1 + 0.04, y, eave - 0.03], [mid, y, ridge + 0.01], 0.02));
    } else {
      const x = (e === "+" ? x1 : x0) + (e === "+" ? 0.004 : -0.004), mid = (y0 + y1) / 2;
      pieces.push(rod([x, y0 - 0.04, eave - 0.03], [x, mid, ridge + 0.01], 0.02), rod([x, y1 + 0.04, eave - 0.03], [x, mid, ridge + 0.01], 0.02));
    }
  }
  put(m, "matte", Solid.union(pieces), TRIM);
}

/** The yard's chips, over its left half: from the hall out to the lane,
 *  bitten back where the dock's flatbed lies (`lots.rs`). */
const CHIP_YARD: [number, number, number, number][] = [[-0.97, 0.15, -1.0, 0.15], [-0.97, -0.45, 0.1, 1.0], [-0.97, 0.15, 0.95, 1.92]];

/** Where its forklift comes out of the wing's door, to the gate's side. */
export const BARN_DOOR: [number, number] = [0.49, 0.1];

export const SAWMILL = model((m) => {
  ground(m, "dust", CHIP_YARD, SAWDUST, { z: 0.016, round: 0.12 });

  // The hall, at the back: its long front slope, its short back one, and
  // the four gables along its back, a window in each.
  const [hx0, hx1, hy0, hy1, he, hr, ridgeAt] = [-0.78, 0.5, -1.86, -1.0, 0.22, 0.44, -1.62];
  put(m, "matte", barn("x", hx0, hx1, hy0, hy1, he, hr, ridgeAt), WALL);
  pitched(m, "x", hx0, hx1, hy0, hy1, he, hr, ROOF, { over: 0.05, ridgeAt });
  trimmed(m, "x", hx0, hx1, hy0, hy1, he, hr, ["-"]);
  const gw = (hx1 - hx0) / 4;
  for (let k = 0; k < 4; k++) {
    const [gx0, gx1] = [hx0 + k * gw + 0.02, hx0 + (k + 1) * gw - 0.02];
    put(m, "matte", barn("y", gx0, gx1, hy0, ridgeAt, he, hr), WALL);
    pitched(m, "y", gx0, gx1, hy0, ridgeAt, he, hr + 0.004, ROOF, { over: 0.03 });
    trimmed(m, "y", gx0, gx1, hy0, ridgeAt, he, hr, ["-"]);
    window(m, { face: "-y", at: hy0 }, (gx0 + gx1) / 2, 0.24, { w: 0.07, h: 0.05, frame: TRIM });
  }
  // Its front to the yard: the big door the conveyor runs in by, a lamp
  // over it, a dormer above; a window beside.
  const front: Wall = { face: "+y", at: hy1 };
  barnDoor(m, front, -0.14, 0.22, 0.16);
  put(m, "glass", plate(front, -0.155, -0.125, 0.19, 0.21, 0, 0.025), [0.95, 0.85, 0.6]);
  window(m, front, -0.56, 0.07, { w: 0.08, h: 0.07, frame: TRIM });
  const dz = 0.3;
  put(m, "matte", plate({ face: "+y", at: hy1 - 0.12 }, -0.2, -0.08, dz - 0.06, dz + 0.04, -0.14, 0.04), WALL);
  gablet(m, { face: "+y", at: hy1 - 0.08 }, -0.14, dz + 0.04, 0.12, 0.05, 0.05, ROOF, WALL);
  window(m, { face: "+y", at: hy1 - 0.08 }, -0.14, dz - 0.03, { w: 0.06, h: 0.045, frame: TRIM });
  // A zinc lean-to down its left end.
  put(m, "zinc", golf([hx0 - 0.005, hy0 + 0.08, 0.17], [0, -0.8 - hy0, 0], [-0.2, 0, -0.07], 0.01), ZINC);
  put(m, "matte", box(-0.98, hx0, hy0 + 0.1, -0.75, 0, 0.1), TIMBER);

  // The wing down the right, in two: its tall back, its lower front with
  // its gable to the lane, the barn door in it, a lamp over it.
  const [wx0, wx1] = [0.22, 0.76];
  put(m, "matte", barn("y", wx0, wx1, -1.78, -0.9, 0.26, 0.52), WALL);
  pitched(m, "y", wx0, wx1, -1.78, -0.9, 0.26, 0.52, ROOF, { over: 0.05 });
  trimmed(m, "y", wx0, wx1, -1.78, -0.9, 0.26, 0.52, ["+"]);
  window(m, { face: "+y", at: -0.9 }, 0.49, 0.32, { w: 0.08, h: 0.05, arch: true, frame: TRIM });
  const [fy0, fy1] = [-0.94, -0.02];
  put(m, "matte", barn("y", wx0 + 0.02, wx1 - 0.02, fy0, fy1, 0.22, 0.44), WALL);
  pitched(m, "y", wx0 + 0.02, wx1 - 0.02, fy0, fy1, 0.22, 0.44, ROOF, { over: 0.05 });
  trimmed(m, "y", wx0 + 0.02, wx1 - 0.02, fy0, fy1, 0.22, 0.44, ["+"]);
  const gable: Wall = { face: "+y", at: fy1 };
  barnDoor(m, gable, 0.49, 0.22, 0.19);
  put(m, "glass", plate(gable, 0.475, 0.505, 0.225, 0.245, 0, 0.025), [0.95, 0.85, 0.6]);
  window(m, gable, 0.49, 0.29, { w: 0.08, h: 0.04, frame: TRIM });
  for (const y of [-0.7, -0.35]) window(m, { face: "-x", at: wx0 + 0.02 }, y, 0.08, { w: 0.08, h: 0.06, frame: TRIM });
  put(m, "zinc", golf([wx1 + 0.005, -1.25, 0.18], [0, 1.23, 0], [0.22, 0, -0.07], 0.01), ZINC);
  for (const y of [-1.15, -0.5]) put(m, "matte", box(0.95, 0.975, y - 0.012, y + 0.012, 0, 0.11), TIMBER);
  // Its chimney, brick, behind the wing, smoking.
  chimney(m, 0.84, -1.56, 0.72, BRICK, { w: 0.12, smoke: 0.15 });

  // The water tower at the yard's back, on four braced legs.
  const [tx, ty, legs, tr, th] = [-0.8, -0.62, 0.26, 0.15, 0.2];
  put(m, "matte", Solid.union([
    ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => hull([[tx + sx * 0.13, ty + sy * 0.13, 0], [tx + sx * 0.15, ty + sy * 0.15, 0], [tx + sx * 0.1, ty + sy * 0.1, legs], [tx + sx * 0.12, ty + sy * 0.12, legs]])),
    box(tx - 0.13, tx + 0.13, ty - 0.13, ty + 0.13, legs - 0.02, legs),
    ...[-1, 1].flatMap((s) => [rod([tx - 0.13, ty + s * 0.135, 0.03], [tx + 0.11, ty + s * 0.115, legs - 0.03], 0.016), rod([tx + s * 0.135, ty - 0.13, 0.03], [tx + s * 0.115, ty + 0.11, legs - 0.03], 0.016)]),
  ]), TIMBER);
  put(m, "matte", Solid.cylinder(th, tr, tr, 18).translate([tx, ty, legs]), WALL);
  put(m, "matte", Solid.union([0.04, 0.1, 0.16].map((h) => post(tx, ty, legs + h, 0.012, tr + 0.006, 18))), HOOP);
  put(m, "matte", Solid.cylinder(0.09, tr + 0.025, 0.015, 18).translate([tx, ty, legs + th]), ROOF.rgb);

  // The conveyor, from the yard up into the hall's door, logs on it.
  const [cx, cw, c0, c1, z0, z1] = [-0.14, 0.09, 0.28, -1.0, 0.03, 0.15];
  const ramp = (zLo: number, zHi: number, half: number) =>
    hull([[cx - half, c0, zLo], [cx + half, c0, zLo], [cx - half, c0, zHi], [cx + half, c0, zHi], [cx - half, c1, zLo + z1 - z0], [cx + half, c1, zLo + z1 - z0], [cx - half, c1, zHi + z1 - z0], [cx + half, c1, zHi + z1 - z0]]);
  const rise = (y: number) => z0 + ((z1 - z0) * (c0 - y)) / (c0 - c1);
  put(m, "matte", ramp(z0, z0 + 0.03, cw / 2).subtract(ramp(z0 + 0.016, z0 + 0.05, cw / 2 - 0.01))
    .add(Solid.union([0.2, -0.2, -0.6].flatMap((y) => [-1, 1].map((s) => box(cx + s * (cw / 2 - 0.006) - 0.006, cx + s * (cw / 2 - 0.006) + 0.006, y - 0.006, y + 0.006, 0, rise(y)))))), STEEL);
  put(m, "matte", ramp(z0, z0 + 0.017, cw / 2 - 0.01), BELT);
  for (const y of [0.15, -0.25, -0.65]) log(m, [cx, y, rise(y) + 0.04], 0.022, 0.2, "y");
  // Sawdust heaped about its foot, on the chips.
  [[-0.38, -0.7, 0.13, 0.04], [0.05, -0.72, 0.1, 0.03], [-0.5, 1.15, 0.15, 0.045], [-0.32, 1.5, 0.09, 0.03]].forEach(([x, y, r, h], k) => heap(m, "chips", x, y, r, h, 0.016, k + 1, CHIPS));

  // A stack of sawn planks on battens, and logs racked between posts.
  for (let layer = 0; layer < 4; layer++) {
    put(m, "matte", Solid.union([-0.1, 0, 0.1].map((d) => box(-0.6 + d - 0.012, -0.6 + d + 0.012, -0.05, 0.25, 0.012 + layer * 0.03, 0.02 + layer * 0.03))), TIMBER);
    put(m, "matte", Solid.union(Array.from({ length: 6 }, (_, k) => box(-0.74 + k * 0.047, -0.7 + k * 0.047, -0.06, 0.26, 0.02 + layer * 0.03, 0.042 + layer * 0.03))), PLANK);
  }
  rack(m, -0.8, 1.25, "y", 0.5, 3, 3);
  rack(m, -0.6, 1.72, "x", 0.44, 2, 3);
  // A fence along the side.
  fence(m, [[-0.985, -0.72], [-0.985, 1.92]], TIMBER);
  lamp(m, -0.95, 0.95, [-0.89, 0.95]);
});
