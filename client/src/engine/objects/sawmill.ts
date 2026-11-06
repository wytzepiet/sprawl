import { BARK_ALONG } from "../bark";
import type { MeshGeometry } from "../geometry";
import type { RGB } from "../rgb";
import { Solid } from "../solid";
import { add, barn, box, chimney, gablet, ground, heap, hull, model, pitched, plate, post, put, rod, scale, tree, window, PANE, type Cover, type Model, type V, type Wall } from "./kit";

/**
 * A sawmill, whole (`refresh/refs/sawmill-gpt.png`), on its plot (x -1
 * to 1, its front wall at y = 0, the street at +y, its loading bay cut at
 * x = 0.5); its ground on z = 0.
 *
 * - Painted timber, green, its corners and gables picked out in cream,
 *   under roofs of brown boards.
 * - At the back, the long hall: its ridge along the street, three small
 *   gables along its back, a window in each; its big door to the front,
 *   braced, a lamp over it and a dormer above, where the logs go in.
 * - On the right, the wing, in two: its tall back, its lower front, its
 *   gable to the street, the loading bay coming in to it; the brick
 *   chimney behind, smoking through the shift.
 * - Before the hall, on wood chips: the water tower, the conveyor up into
 *   the hall with logs on it, sawdust heaped, a stack of sawn planks;
 *   logs racked between posts.
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
export function rack(m: Model, x: number, y: number, along: "x" | "y", l: number, n: number, layers: number, r = 0.034) {
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

export const SAWMILL = model((m) => {
  ground(m, "dust", [[-0.99, 0.99, -1.98, -0.02]], SAWDUST, { z: 0.016, round: 0.12 });

  // The hall, at the back: its long front slope, its short back one, and
  // the three gables along its back, a window in each.
  const [hx0, hx1, hy0, hy1, he, hr, ridgeAt] = [-0.92, 0.24, -1.86, -1.0, 0.22, 0.44, -1.62];
  put(m, "matte", barn("x", hx0, hx1, hy0, hy1, he, hr, ridgeAt), WALL);
  pitched(m, "x", hx0, hx1, hy0, hy1, he, hr, ROOF, { over: 0.05, ridgeAt });
  trimmed(m, "x", hx0, hx1, hy0, hy1, he, hr, ["-"]);
  const gw = (hx1 - hx0) / 3;
  for (let k = 0; k < 3; k++) {
    const [gx0, gx1] = [hx0 + k * gw + 0.02, hx0 + (k + 1) * gw - 0.02];
    put(m, "matte", barn("y", gx0, gx1, hy0, ridgeAt, he, hr), WALL);
    pitched(m, "y", gx0, gx1, hy0, ridgeAt, he, hr + 0.004, ROOF, { over: 0.03 });
    trimmed(m, "y", gx0, gx1, hy0, ridgeAt, he, hr, ["-"]);
    window(m, { face: "-y", at: hy0 }, (gx0 + gx1) / 2, 0.24, { w: 0.07, h: 0.05, frame: TRIM });
  }
  // Its front to the yard: the big door the conveyor runs in by, a lamp
  // over it, a dormer above; a window beside.
  const front: Wall = { face: "+y", at: hy1 };
  const cx = -0.3;
  barnDoor(m, front, cx, 0.22, 0.16);
  put(m, "glass", plate(front, cx - 0.015, cx + 0.015, 0.19, 0.21, 0, 0.025), [0.95, 0.85, 0.6]);
  window(m, front, -0.72, 0.07, { w: 0.08, h: 0.07, frame: TRIM });
  const dz = 0.3;
  put(m, "matte", plate({ face: "+y", at: hy1 - 0.12 }, cx - 0.06, cx + 0.06, dz - 0.06, dz + 0.04, -0.14, 0.04), WALL);
  gablet(m, { face: "+y", at: hy1 - 0.08 }, cx, dz + 0.04, 0.12, 0.05, 0.05, ROOF, WALL);
  window(m, { face: "+y", at: hy1 - 0.08 }, cx, dz - 0.03, { w: 0.06, h: 0.045, frame: TRIM });

  // The wing down the right, in two: its tall back, and its lower front,
  // its gable to the street, where the loading bay comes in to it.
  const [wx0, wx1] = [0.3, 0.9];
  put(m, "matte", barn("y", wx0, wx1, -1.78, -0.9, 0.26, 0.52), WALL);
  pitched(m, "y", wx0, wx1, -1.78, -0.9, 0.26, 0.52, ROOF, { over: 0.05 });
  trimmed(m, "y", wx0, wx1, -1.78, -0.9, 0.26, 0.52, ["+"]);
  window(m, { face: "+y", at: -0.9 }, (wx0 + wx1) / 2, 0.32, { w: 0.08, h: 0.05, arch: true, frame: TRIM });
  const [fy0, fy1] = [-0.94, -0.24];
  put(m, "matte", barn("y", wx0 + 0.02, wx1 - 0.02, fy0, fy1, 0.22, 0.44), WALL);
  pitched(m, "y", wx0 + 0.02, wx1 - 0.02, fy0, fy1, 0.22, 0.44, ROOF, { over: 0.05 });
  trimmed(m, "y", wx0 + 0.02, wx1 - 0.02, fy0, fy1, 0.22, 0.44, ["+"]);
  window(m, { face: "+y", at: fy1 }, (wx0 + wx1) / 2, 0.29, { w: 0.08, h: 0.04, frame: TRIM });
  for (const y of [-0.7, -0.45]) window(m, { face: "-x", at: wx0 + 0.02 }, y, 0.08, { w: 0.08, h: 0.06, frame: TRIM });
  // Its chimney, brick, behind the wing, smoking.
  chimney(m, 0.62, -1.86, 0.72, BRICK, { w: 0.12, smoke: 0.15 });

  // The water tower at the yard's corner, on four braced legs.
  const [tx, ty, legs, tr, th] = [-0.8, -0.66, 0.26, 0.14, 0.2];
  put(m, "matte", Solid.union([
    ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => hull([[tx + sx * 0.12, ty + sy * 0.12, 0], [tx + sx * 0.14, ty + sy * 0.14, 0], [tx + sx * 0.09, ty + sy * 0.09, legs], [tx + sx * 0.11, ty + sy * 0.11, legs]])),
    box(tx - 0.12, tx + 0.12, ty - 0.12, ty + 0.12, legs - 0.02, legs),
    ...[-1, 1].flatMap((s) => [rod([tx - 0.12, ty + s * 0.125, 0.03], [tx + 0.1, ty + s * 0.105, legs - 0.03], 0.016), rod([tx + s * 0.125, ty - 0.12, 0.03], [tx + s * 0.105, ty + 0.1, legs - 0.03], 0.016)]),
  ]), TIMBER);
  put(m, "matte", Solid.cylinder(th, tr, tr, 18).translate([tx, ty, legs]), WALL);
  put(m, "matte", Solid.union([0.04, 0.1, 0.16].map((h) => post(tx, ty, legs + h, 0.012, tr + 0.006, 18))), HOOP);
  put(m, "matte", Solid.cylinder(0.09, tr + 0.025, 0.015, 18).translate([tx, ty, legs + th]), ROOF.rgb);

  // The conveyor, from the yard up into the hall's door, logs on it.
  const [cw, c0, c1, z0, z1] = [0.09, -0.04, -1.0, 0.03, 0.15];
  const ramp = (zLo: number, zHi: number, half: number) =>
    hull([[cx - half, c0, zLo], [cx + half, c0, zLo], [cx - half, c0, zHi], [cx + half, c0, zHi], [cx - half, c1, zLo + z1 - z0], [cx + half, c1, zLo + z1 - z0], [cx - half, c1, zHi + z1 - z0], [cx + half, c1, zHi + z1 - z0]]);
  const rise = (y: number) => z0 + ((z1 - z0) * (c0 - y)) / (c0 - c1);
  put(m, "matte", ramp(z0, z0 + 0.03, cw / 2).subtract(ramp(z0 + 0.016, z0 + 0.05, cw / 2 - 0.01))
    .add(Solid.union([-0.2, -0.6].flatMap((y) => [-1, 1].map((s) => box(cx + s * (cw / 2 - 0.006) - 0.006, cx + s * (cw / 2 - 0.006) + 0.006, y - 0.006, y + 0.006, 0, rise(y)))))), STEEL);
  put(m, "matte", ramp(z0, z0 + 0.017, cw / 2 - 0.01), BELT);
  for (const y of [-0.3, -0.7]) log(m, [cx, y, rise(y) + 0.04], 0.022, 0.2, "y");
  // Sawdust heaped about its foot, on the chips.
  [[-0.52, -0.84, 0.1, 0.04], [-0.06, -0.8, 0.09, 0.03]].forEach(([x, y, r, h], k) => heap(m, "chips", x, y, r, h, 0.016, k + 1, CHIPS));

  // A stack of sawn planks on battens, and logs racked between posts.
  for (let layer = 0; layer < 4; layer++) {
    put(m, "matte", Solid.union([-0.1, 0, 0.1].map((d) => box(-0.66 + d - 0.012, -0.66 + d + 0.012, -0.36, -0.06, 0.012 + layer * 0.03, 0.02 + layer * 0.03))), TIMBER);
    put(m, "matte", Solid.union(Array.from({ length: 6 }, (_, k) => box(-0.8 + k * 0.047, -0.76 + k * 0.047, -0.37, -0.05, 0.02 + layer * 0.03, 0.042 + layer * 0.03))), PLANK);
  }
  rack(m, 0.08, -0.52, "y", 0.5, 2, 3);
});

/**
 * A woodcutter's, whole, on the back row of its plot (x -1 to 1, the
 * street at +y, its loading bay cut at x = 0.5): a log cabin under a green
 * roof, a chimney smoking; behind the bay logs racked high, and a stump
 * with the axe in it; trees behind.
 */
export const WOODCUTTER = model((m) => {
  const [X0, X1, Y0, Y1, EAVE, RIDGE] = [-0.92, -0.08, -1.4, -0.72, 0.2, 0.4];
  // The back row trodden earth, the yard before it the town's paving.
  ground(m, "earth", [[-0.99, 0.99, -1.49, -0.5]], [0.55, 0.42, 0.3], { round: 0.04 });
  // The cabin's walls a pile of logs, their ends past the corners.
  for (let z = 0.024, k = 0; z < EAVE; z += 0.042, k++) {
    log(m, [(X0 + X1) / 2, Y1, z], 0.022, X1 - X0 + (k % 2 ? 0.06 : 0.02), "x");
    log(m, [(X0 + X1) / 2, Y0, z], 0.022, X1 - X0 + (k % 2 ? 0.06 : 0.02), "x");
    log(m, [X0, (Y0 + Y1) / 2, z + 0.021], 0.022, Y1 - Y0 + (k % 2 ? 0.02 : 0.06), "y");
    log(m, [X1, (Y0 + Y1) / 2, z + 0.021], 0.022, Y1 - Y0 + (k % 2 ? 0.02 : 0.06), "y");
  }
  put(m, "matte", barn("x", X0 + 0.01, X1 - 0.01, Y0 + 0.01, Y1 - 0.01, EAVE, RIDGE), BARKED);
  pitched(m, "x", X0, X1, Y0, Y1, EAVE, RIDGE, { finish: "ribs", rgb: WALL, ribs: 16 }, { over: 0.06 });
  const front: Wall = { face: "+y", at: Y1 + 0.02 };
  put(m, "matte", plate(front, -0.57, -0.43, 0, 0.16, 0, 0.006), DOOR);
  for (const at of [-0.76, -0.24]) {
    put(m, "matte", plate(front, at - 0.06, at + 0.06, 0.08, 0.16, 0, 0.006), TRIM);
    put(m, "glass", plate(front, at - 0.045, at + 0.045, 0.092, 0.148, 0, 0.009), PANE);
  }
  chimney(m, X0 + 0.15, Y0 + 0.16, RIDGE + 0.06, BRICK, { smoke: 0.1 });
  // The wood: two racks of logs, a stump with the axe in it, chips round it.
  rack(m, 0.5, -1.12, "x", 0.5, 4, 3);
  put(m, "matte", post(0.1, -0.62, 0, 0.06, 0.04, 10), BARKED);
  put(m, "matte", post(0.1, -0.62, 0.06, 0.002, 0.036, 10), END);
  put(m, "matte", rod([0.1, -0.62, 0.065], [0.16, -0.6, 0.13], 0.01), TIMBER);
  put(m, "matte", box(0.09, 0.12, -0.635, -0.605, 0.055, 0.075), STEEL);
  heap(m, "chips", 0.14, -0.62, 0.1, 0.012, 0, 3, CHIPS);
  for (const [x, y, s] of [[-0.94, -1.46, 0.6], [0.92, -1.42, 0.7]] as const) tree(m, x, y, s);
});
